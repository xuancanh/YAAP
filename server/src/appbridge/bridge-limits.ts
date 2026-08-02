/**
 * Per-app call-rate limits and read provenance for the mini-app bridge
 * (docs/miniapp-roadmap.md §8 step 1).
 *
 * docs/miniapp-capabilities.md §2 claimed for months that "everything is
 * quota'd and rate-limited per app" while only agent.ask was. Sizes were
 * capped; frequency was not, so an app in a loop could hammer object storage
 * and fill the kanban. These are the missing frequency caps.
 *
 * A sliding window, not a token bucket: apps are bursty by nature (a
 * dashboard opens and reads twelve files at once), and a window forgives the
 * burst while still stopping a sustained loop. State is in-memory and
 * per-process — a restart refills the tank, which errs forgiving, the same
 * tradeoff agent.ask's daily budget already makes.
 */

/** Op classes and their ceilings, per app per minute. Reads are generous
 *  (opening a dashboard is a burst of them); anything that mutates or costs
 *  money is not. */
export const RATE_LIMITS: Record<string, number> = {
  read: 150,
  write: 40,
  llm: 30,
};

/** Which class each bridge op is billed to. */
export const OP_CLASS: Record<string, keyof typeof RATE_LIMITS> = {
  'storage.get': 'read',
  'storage.set': 'write',
  'files.list': 'read',
  'files.read': 'read',
  'files.write': 'write',
  'files.propose': 'write',
  'tasks.list': 'read',
  'tasks.add': 'write',
  'tasks.move': 'write',
  'data.query': 'read',
  'data.put': 'write',
  'data.delete': 'write',
  'connections.read': 'read',
  'connections.propose': 'write',
  'llm.complete': 'llm',
  'compute.run': 'llm',
  'compute.status': 'read',
  'connections.list': 'read',
};

const WINDOW_MS = 60_000;

/** Sliding-window counter over (app, class). Injectable clock so tests can
 *  advance time instead of sleeping. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Record one call; returns false when the app is over its ceiling. */
  allow(appId: string, op: string): boolean {
    const cls = OP_CLASS[op];
    if (!cls) return true; // unclassified ops (ui.*) are free
    const limit = RATE_LIMITS[cls];
    const key = `${appId}:${cls}`;
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((ts) => t - ts < WINDOW_MS);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** Calls left in the current window, for surfacing budget to apps. */
  remaining(appId: string, cls: keyof typeof RATE_LIMITS): number {
    const t = this.now();
    const recent = (this.hits.get(`${appId}:${cls}`) ?? []).filter((ts) => t - ts < WINDOW_MS);
    return Math.max(0, RATE_LIMITS[cls] - recent.length);
  }
}

/**
 * Read provenance. docs/miniapp-capabilities.md §6 promised the event feed
 * would show bridge reads; as shipped only writes logged, so a granted
 * files.read could walk the whole agent folder invisibly — and files.read is
 * the grant users hand out most casually.
 *
 * One event per read would drown the feed (a dashboard reads twelve files on
 * open), so reads are tallied and logged on a curve: the first read, then
 * every 25th. That surfaces "this app is reading your folder" immediately and
 * "this app is still reading your folder" for a runaway, without turning the
 * feed into a log file.
 */
const LOG_EVERY = 25;

export class ReadTally {
  private counts = new Map<string, number>();

  /** Count a read; returns a summary line when this one deserves an event. */
  record(appId: string, appName: string, what: string): string | null {
    const n = (this.counts.get(appId) ?? 0) + 1;
    this.counts.set(appId, n);
    if (n !== 1 && n % LOG_EVERY !== 0) return null;
    return n === 1
      ? `App "${appName}" read ${what}`
      : `App "${appName}" read ${what} (${n} reads so far)`;
  }
}
