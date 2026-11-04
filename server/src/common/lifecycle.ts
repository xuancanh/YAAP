/**
 * Process lifecycle — restarts and interruptions (docs/architecture.md
 * "Restarts and recovery").
 *
 * A restart (SIGTERM / SIGINT from `node --watch`, a deploy, Ctrl-C) is not
 * an agent error. When one begins the process *drains*: the schedulers stop
 * starting runs, the turn loop refuses new turns, in-flight turns get a short
 * grace period (SHUTDOWN_GRACE_MS) to finish what they are doing, and the
 * ones still running are aborted with the `shutdown` reason so every catch
 * site can tell that abort from the owner's Stop or a provider timeout. Such
 * a turn is recorded `interrupted`; the next boot recovers it
 * (chats/restart-recovery.service.ts).
 *
 * Module-level state: there is one process, and every service — including
 * ones constructed directly in tests — must see the same flag.
 */

/** Why a turn was aborted on purpose. */
export type AbortCause = 'shutdown' | 'stop';

/** The abort reason a draining process passes to AbortController.abort():
 *  an Error (fetch rejects with the signal's reason) that names its cause. */
export class InterruptedError extends Error {
  readonly abortCause: AbortCause;
  constructor(cause: AbortCause = 'shutdown') {
    super(cause === 'shutdown' ? 'Interrupted by a server restart' : 'Stopped');
    this.name = 'AbortError';
    this.abortCause = cause;
  }
}

/** The note an interrupted turn records in its `error` column. */
export const INTERRUPTED_NOTE = 'Interrupted by a server restart';

let draining = false;
const listeners = new Set<() => void>();

/** Whether the process is shutting down (new runs are refused). */
export function isDraining(): boolean { return draining; }

/** Begin draining (idempotent). Listeners run once, synchronously. */
export function beginDrain(): void {
  if (draining) return;
  draining = true;
  for (const fn of [...listeners]) { try { fn(); } catch { /* a listener never blocks shutdown */ } }
}

/** Be told when draining begins (schedulers pause themselves). */
export function onDrain(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test seam: back to a running process. */
export function resetLifecycle(): void { draining = false; }

/** How long in-flight turns may keep going once draining begins before they
 *  are aborted (ms). SHUTDOWN_GRACE_MS, default 3 s, bounded 0–60 s. */
export function shutdownGraceMs(): number {
  const raw = Number(process.env.SHUTDOWN_GRACE_MS);
  if (!Number.isFinite(raw) || process.env.SHUTDOWN_GRACE_MS === undefined || process.env.SHUTDOWN_GRACE_MS === '') return 3_000;
  return Math.max(0, Math.min(60_000, raw));
}

/** Which purposeful abort ended a signal, if any: `shutdown` for a draining
 *  process, `stop` for the owner's Stop (or any other abort we started). A
 *  signal that is not aborted is null; so is a provider timeout, which aborts
 *  a different signal. */
export function abortCauseOf(signal: AbortSignal | undefined): AbortCause | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason as unknown;
  if (reason instanceof InterruptedError) return reason.abortCause;
  return 'stop';
}

/** An error that is an abort (ours, a timeout's, or a fetch's). */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR' || (typeof e.message === 'string' && /operation was aborted/i.test(e.message));
}

/**
 * A transient transport failure worth one more try: a connection reset or
 * refused mid-request, a socket that hung up, a stream terminated early, a
 * provider that said it is overloaded or rate-limited, or a 5xx in a stream
 * error event. Never an abort, a timeout or a 4xx.
 */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || isAbortError(err)) return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (e.name === 'TimeoutError') return false;
  const code = typeof e.code === 'string' ? e.code : typeof (e.cause as { code?: unknown } | undefined)?.code === 'string' ? (e.cause as { code: string }).code : '';
  if (/^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_SOCKET|UND_ERR_CLOSED|ECONNABORTED)$/.test(code)) return true;
  const m = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return /econnreset|socket hang up|terminated|fetch failed|network error|other side closed|premature close|overloaded|rate.?limit|\b(429|500|502|503|504|529)\b|internal server error|bad gateway|service unavailable/.test(m);
}
