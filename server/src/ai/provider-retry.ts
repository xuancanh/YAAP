/**
 * Provider request retry (NFR reliability): a transient 429 / 5xx / network
 * drop must not fail a whole multi-round turn. Retries only while the request
 * is still being established — once the adapter starts yielding stream events
 * it never retries, since that would duplicate transcript text. Backoff
 * sleeps respect the turn's abort signal so a stopped turn exits promptly
 * instead of lingering in a sleep.
 */
import { Logger } from '@nestjs/common';

const logger = new Logger('AiProviderRetry');

const MAX_RETRIES = 2;
const BASE_DELAYS_MS = [1_000, 3_000];

/** 429 and 5xx are transient; other 4xx are permanent. */
const retryableStatus = (status: number) => status === 429 || status >= 500;

/** Abort/timeout failures come from our own signal; never retry those. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Sleep that rejects with the abort reason when the signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function backoff(attempt: number, signal: AbortSignal, why: string): Promise<void> {
  const wait = BASE_DELAYS_MS[attempt] + Math.floor(Math.random() * 500);
  logger.warn(`provider request failed (${why}); retrying in ${wait}ms (attempt ${attempt + 2})`);
  await sleep(wait, signal);
}

/** Fetch with up to MAX_RETRIES retries on 429/5xx/network errors, with
 *  exponential backoff + jitter. On exhaustion the last response or error is
 *  returned/thrown as-is so callers keep their usual error text. */
export async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch (err) {
      if (attempt >= MAX_RETRIES || isAbort(err) || signal.aborted) throw err;
      await backoff(attempt, signal, err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!retryableStatus(res.status) || attempt >= MAX_RETRIES) return res;
    await backoff(attempt, signal, `http ${res.status}`);
  }
}
