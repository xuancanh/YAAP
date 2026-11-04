/**
 * Riding out server restarts and provider hiccups in the live chat stream
 * (docs/architecture.md "Restarts and recovery"). Pure, so the store's
 * behaviour is testable without a server.
 */

/** The live rows a chat shows while a turn streams (a subset of LiveItem). */
export interface StreamRow { kind: string; status?: string }

/**
 * The server re-asks a provider round that failed on a transient error (a
 * `retry` event): drop what that round streamed so far — its thinking and
 * answer text, and any tool card still `running` (tools only run after a
 * round's stream completes, so a running card belongs to the failed round).
 * Stops at the person's message or a settled tool card.
 */
export function dropFailedRound<T extends StreamRow>(items: T[]): T[] {
  let end = items.length;
  while (end > 0) {
    const it = items[end - 1];
    if (it.kind === 'user') break;
    if (it.kind === 'tool' && it.status !== 'running') break;
    end--;
  }
  return end === items.length ? items : items.slice(0, end);
}

/**
 * Whether a failed turn stream means the connection to the server went
 * away (a restart, the dev proxy refusing while the API boots, a dropped
 * network) rather than an answer from the server: then the reply was
 * interrupted, not failed, and the transcript is re-read once the server is
 * back.
 */
export function isConnectionLost(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  if (err instanceof TypeError) return true; // fetch: "Failed to fetch", "Load failed", "network error", "terminated"
  return /^(500|502|503|504)\b\s*$|^50[234]\b|network|terminated|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(err.message);
}

/** Workspace event stream reconnect delay: quick at first (a restart is
 *  back in seconds), capped low enough that a screen never sits stale. */
export function reconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt), 5_000);
}
