/**
 * Provider stream timeout (NFR reliability): a stalled-but-open provider
 * connection must not hang a turn — and the chat busy lock — forever.
 * Configurable via PROVIDER_TIMEOUT_MS; defaults to 5 minutes per streaming
 * round, generous enough for long thinking pauses and tool-heavy rounds.
 */

export function providerTimeoutMs(): number {
  return Number(process.env.PROVIDER_TIMEOUT_MS) || 300_000;
}

/** Combine the caller's abort signal (if any) with the stream timeout. */
export function streamSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(providerTimeoutMs());
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
