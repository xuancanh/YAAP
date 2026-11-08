/**
 * The work graph's pure parts (docs/work-tracking.md): task sources, the
 * checklist steps a task carries, the project's fields (lanes, statuses,
 * health, milestones, brief), progress and the throughput forecast. No Nest
 * and no database, so the migration's backfill, the services and the tests
 * share one definition.
 */

// ---- task source ----

/** Where a task came from; the board shows it as a badge. `process`: a step
 *  of a process run materialised it (docs/processes.md). */
export const TASK_SOURCES = ['plan', 'meeting', 'retro', 'incident', 'escalation', 'agent', 'ceo', 'chat', 'process'] as const;
export type TaskSource = typeof TASK_SOURCES[number];

export function isTaskSource(v: unknown): v is TaskSource {
  return typeof v === 'string' && (TASK_SOURCES as readonly string[]).includes(v);
}

/** The default source when the creator names none: an `Escalation:` child is
 *  an escalation; a person's task is the CEO's (or the chat's, when it came
 *  from a channel message); the chief's is planning; an approval's (a
 *  strategy card) is planning; anything else an agent noticed. */
export function deriveSource(t: { createdBy?: string | null; title?: string | null; parentTaskId?: string | null; channelId?: string | null }): TaskSource {
  const by = t.createdBy ?? '';
  if (t.parentTaskId && (t.title ?? '').startsWith('Escalation:')) return 'escalation';
  if (by === 'user' || by.startsWith('human:')) return t.channelId ? 'chat' : 'ceo';
  if (by === 'chief' || by === 'approval') return 'plan';
  if (t.channelId && by.startsWith('agent:')) return 'chat';
  return 'agent';
}

// ---- checklist steps ----

export interface TaskStep { id: string; text: string; done: boolean; doneAt?: string | null; dropped?: boolean; from?: string }

export function parseSteps(raw: string | null | undefined): TaskStep[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object').map((x, i) => ({
      id: String(x.id ?? `s${i + 1}`), text: String(x.text ?? '').slice(0, 300), done: Boolean(x.done),
      ...(x.doneAt ? { doneAt: String(x.doneAt) } : {}), ...(x.dropped ? { dropped: true } : {}), ...(x.from ? { from: String(x.from) } : {}),
    }));
  } catch { return []; }
}

export const STEPS_CAP = 40;

/** The next step id (s1, s2, …): never reused within a task. */
export function nextStepId(steps: TaskStep[]): string {
  const n = steps.reduce((m, s) => Math.max(m, Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0)), 0);
  return `s${n + 1}`;
}

// ---- projects ----

export const PROJECT_LANES = ['now', 'next', 'later'] as const;
export type ProjectLane = typeof PROJECT_LANES[number];
export const PROJECT_STATUSES = ['proposed', 'shaped', 'active', 'paused', 'done', 'cancelled'] as const;
export type ProjectStatus = typeof PROJECT_STATUSES[number];
export const PROJECT_HEALTH = ['on_track', 'at_risk', 'off_track'] as const;
export type ProjectHealth = typeof PROJECT_HEALTH[number];
export const PROJECT_KINDS = ['project', 'unsorted', 'operating'] as const;
export type ProjectKind = typeof PROJECT_KINDS[number];

export const SYSTEM_PROJECT_TITLES: Record<Exclude<ProjectKind, 'project'>, string> = {
  unsorted: 'Unsorted',
  operating: 'Operating improvements',
};

export interface ProjectBrief { problem: string; hypothesis: string; done_when: string; mvp: string }

export function parseProjectBrief(raw: string | Record<string, unknown> | null | undefined): ProjectBrief {
  let v: Record<string, unknown> = {};
  if (typeof raw === 'string') { try { v = JSON.parse(raw || '{}') as Record<string, unknown>; } catch { v = {}; } } else if (raw && typeof raw === 'object') v = raw;
  const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string).slice(0, 2_000) : '');
  return { problem: s('problem'), hypothesis: s('hypothesis'), done_when: s('done_when') || s('doneWhen'), mvp: s('mvp') };
}

export interface Milestone { id: string; name: string; date: string | null; done: boolean; doneAt?: string | null }

export function parseMilestones(raw: string | null | undefined): Milestone[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object').map((x, i) => ({
      id: String(x.id ?? `m${i + 1}`), name: String(x.name ?? '').slice(0, 120), date: x.date ? String(x.date) : null, done: Boolean(x.done), ...(x.doneAt ? { doneAt: String(x.doneAt) } : {}),
    }));
  } catch { return []; }
}

export function parseIdList(raw: string | null | undefined): string[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []; } catch { return []; }
}

/** A date as YYYY-MM-DD (dates on projects are calendar days), or null; throws on garbage. */
export function normalizeDay(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const ms = Date.parse(String(v));
  if (!Number.isFinite(ms)) throw new Error(`"${String(v).slice(0, 40)}" is not a date`);
  return new Date(ms).toISOString().slice(0, 10);
}

/** Done ÷ total over the tasks that count (cancelled tasks do not). */
export function progressOf(tasks: Array<{ status: string }>): { done: number; total: number; pct: number } {
  const counted = tasks.filter((t) => t.status !== 'cancelled');
  const done = counted.filter((t) => t.status === 'done').length;
  return { done, total: counted.length, pct: counted.length ? Math.round((done / counted.length) * 100) : 0 };
}

/**
 * A hill position from the tasks when the lead placed none (Shape Up's hill
 * chart, inferred): uphill (0–0.5) while work is mostly still unknown —
 * nothing started or much blocked — downhill (0.5–1) as tasks finish. A
 * derived dot is labelled as such; the lead's placement wins.
 */
export function inferredHill(tasks: Array<{ status: string }>): number | null {
  const counted = tasks.filter((t) => t.status !== 'cancelled');
  if (counted.length === 0) return null;
  const done = counted.filter((t) => t.status === 'done').length / counted.length;
  const started = counted.filter((t) => ['claimed', 'in_progress', 'in_review', 'done'].includes(t.status)).length / counted.length;
  const blocked = counted.filter((t) => t.status === 'blocked').length / counted.length;
  if (done === 0) return Math.round(Math.max(0.05, Math.min(0.45, started * 0.45 - blocked * 0.2)) * 100) / 100;
  return Math.round(Math.min(1, 0.5 + done * 0.5) * 100) / 100;
}

// ---- forecast ----

export interface Forecast {
  /** `range` when there is history enough; otherwise `insufficient` and why. */
  state: 'range' | 'insufficient' | 'done';
  remaining: number;
  /** Throughput samples (done per week) the simulation drew from. */
  samples: number;
  /** 50th and 85th percentile completion dates (YYYY-MM-DD). */
  p50: string | null;
  p85: string | null;
  note: string;
}

/** A small deterministic PRNG so a forecast is stable for the same history. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296; };
}

/**
 * When will the remaining tasks be done? A Monte Carlo over weekly
 * throughput (done events per week, from `task_transitions` → `doneAt`):
 * draw a past week at random until the remaining count is used up, 1 000
 * times, and read the 50th and 85th percentile. Fewer than `minSamples`
 * done events (a tunable) is "not enough history" — never a confident range.
 * Assumes comparably sized tasks; the page says so.
 */
export function forecastFrom(doneAts: string[], remaining: number, now: Date, opts: { minSamples: number; weeks?: number; runs?: number }): Forecast {
  if (remaining <= 0) return { state: 'done', remaining: 0, samples: doneAts.length, p50: null, p85: null, note: 'Nothing left to do.' };
  const weeks = Math.max(2, opts.weeks ?? 8);
  const horizon = now.getTime() - weeks * 7 * 86_400_000;
  const recent = doneAts.map((d) => Date.parse(d)).filter((ms) => Number.isFinite(ms) && ms >= horizon && ms <= now.getTime());
  if (recent.length < opts.minSamples) {
    return { state: 'insufficient', remaining, samples: recent.length, p50: null, p85: null, note: `Not enough history: ${recent.length} task(s) done in the last ${weeks} weeks, ${opts.minSamples} needed for a forecast.` };
  }
  const perWeek = new Array<number>(weeks).fill(0);
  for (const ms of recent) perWeek[Math.min(weeks - 1, Math.floor((now.getTime() - ms) / (7 * 86_400_000)))]++;
  if (perWeek.every((n) => n === 0)) return { state: 'insufficient', remaining, samples: recent.length, p50: null, p85: null, note: 'Not enough history.' };
  const rand = mulberry32(recent.length * 7919 + remaining * 104_729 + weeks);
  const runs = opts.runs ?? 1_000;
  const results: number[] = [];
  for (let r = 0; r < runs; r++) {
    let left = remaining; let w = 0;
    while (left > 0 && w < 520) { left -= perWeek[Math.floor(rand() * weeks)]; w++; }
    results.push(w);
  }
  results.sort((a, b) => a - b);
  const at = (q: number) => new Date(now.getTime() + results[Math.min(results.length - 1, Math.floor(q * results.length))] * 7 * 86_400_000).toISOString().slice(0, 10);
  return { state: 'range', remaining, samples: recent.length, p50: at(0.5), p85: at(0.85), note: `From ${recent.length} task(s) done in the last ${weeks} weeks; assumes tasks of comparable size.` };
}

/** Token set of a title for the kanban-mirror match (words of 3+ letters, minus filler). */
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'next', 'task', 'get', 'run', 'make', 'all', 'our', 'its', 'are', 'was', 'per', 'via', 'out', 'new']);
export function titleTokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
}

/** Jaccard similarity of two titles' token sets. */
export function titleSimilarity(a: string, b: string): number {
  const x = titleTokens(a); const y = titleTokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0; for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

/** The mirror threshold: a kanban item this similar to one of the agent's org tasks is a step of it. */
export const MIRROR_SIMILARITY = 0.4;
