/**
 * The roadmap's pure parts (docs/work-tracking.md "Views"): the timeline's
 * time scale (a date → a horizontal position), each project's bar span with
 * its fallbacks, the grouping of rows by goal (objective → key result) or by
 * unit, the lane order, and the small vocabularies the cards share (health
 * colour and word, source badge, the structured blocker in words). No React,
 * no store, so web-tests check the math directly.
 */
import type { BlockedOn, ProjectSummary, RoadmapData, TaskSource } from './api';

const DAY = 86_400_000;

export type Zoom = 'month' | 'quarter';

/** The visible window and its columns: a month view shows ~3 months in
 *  weeks, a quarter view ~a year in months. Starts at the earliest of today
 *  − a little and the first bar, so nothing current is cut off. */
export interface TimeScale {
  start: number; end: number; zoom: Zoom;
  columns: Array<{ at: number; label: string }>;
}

export const dayMs = (iso: string): number => Date.parse(iso.length <= 10 ? `${iso}T00:00:00.000Z` : iso);

export function buildScale(today: string, spans: Array<{ start: number; end: number } | null>, zoom: Zoom): TimeScale {
  const t = dayMs(today);
  const live = spans.filter((s): s is { start: number; end: number } => s !== null);
  const before = zoom === 'month' ? 14 * DAY : 45 * DAY;
  const after = zoom === 'month' ? 75 * DAY : 320 * DAY;
  let start = Math.min(t - before, ...live.map((s) => s.start));
  let end = Math.max(t + after, ...live.map((s) => s.end + 7 * DAY));
  // Cap the window so a stray date years out does not squash everything.
  const maxSpan = zoom === 'month' ? 180 * DAY : 730 * DAY;
  if (end - start > maxSpan) { start = Math.max(start, t - maxSpan / 3); end = start + maxSpan; }
  const columns: TimeScale['columns'] = [];
  const d = new Date(start);
  if (zoom === 'month') {
    // Weeks, Monday-aligned.
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    while (d.getTime() <= end) {
      columns.push({ at: d.getTime(), label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) });
      d.setUTCDate(d.getUTCDate() + 7);
    }
  } else {
    d.setUTCHours(0, 0, 0, 0); d.setUTCDate(1);
    while (d.getTime() <= end) {
      columns.push({ at: d.getTime(), label: d.toLocaleDateString(undefined, { month: 'short', ...(d.getUTCMonth() === 0 ? { year: 'numeric' } : {}), timeZone: 'UTC' }) });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }
  return { start, end, zoom, columns };
}

/** A time as a fraction (0–1) of the window, clamped. */
export function xOf(scale: TimeScale, ms: number): number {
  if (scale.end <= scale.start) return 0;
  return Math.max(0, Math.min(1, (ms - scale.start) / (scale.end - scale.start)));
}

/** A project's bar: start → target. Fallbacks: no start → its creation day
 *  (when the target is set); no target → start + appetite days; neither →
 *  unscheduled (null). `estimated` marks a bar drawn from a fallback. */
export function spanOf(p: Pick<ProjectSummary, 'startDate' | 'targetDate' | 'appetite'> & { createdAt?: string }): { start: number; end: number; estimated: boolean } | null {
  const start = p.startDate ? dayMs(p.startDate) : null;
  const target = p.targetDate ? dayMs(p.targetDate) : null;
  if (start !== null && target !== null) return { start, end: Math.max(start + DAY, target), estimated: false };
  if (start !== null && p.appetite.days > 0) return { start, end: start + p.appetite.days * DAY, estimated: true };
  if (target !== null) {
    const from = p.createdAt ? dayMs(p.createdAt) : target - 30 * DAY;
    return { start: Math.min(from, target - DAY), end: target, estimated: true };
  }
  return null;
}

/** One group of rows on the timeline. */
export interface RoadmapGroup { id: string; title: string; subtitle?: string; depth: number; projects: ProjectSummary[] }
export type GroupBy = 'goal' | 'unit';

/**
 * Rows grouped by goal — each objective, then its key results with the
 * projects that move them (a project moving two KRs appears under the first)
 * — or by unit. Projects with no key result land in "No key result", with
 * no unit in "No unit". Empty groups are dropped.
 */
export function groupProjects(data: Pick<RoadmapData, 'projects' | 'goals' | 'units'>, by: GroupBy): RoadmapGroup[] {
  const projects = data.projects.slice().sort((a, b) => laneRank(a.lane) - laneRank(b.lane) || a.rank - b.rank || a.title.localeCompare(b.title));
  if (by === 'unit') {
    const groups = data.units.map((u): RoadmapGroup => ({ id: u.id, title: u.name, depth: 0, projects: projects.filter((p) => p.unitId === u.id) }));
    const none = projects.filter((p) => !p.unitId || !data.units.some((u) => u.id === p.unitId));
    if (none.length) groups.push({ id: 'none', title: 'No unit', depth: 0, projects: none });
    return groups.filter((g) => g.projects.length > 0);
  }
  const placed = new Set<string>();
  const goalOf = (p: ProjectSummary) => p.goalIds[0] ?? null;
  const out: RoadmapGroup[] = [];
  const byId = new Map(data.goals.map((g) => [g.id, g]));
  const objectives = data.goals.filter((g) => g.kind === 'objective');
  const krsOf = (id: string) => data.goals.filter((g) => g.kind === 'key_result' && g.parentGoalId === id);
  for (const o of objectives) {
    const direct = projects.filter((p) => goalOf(p) === o.id && !placed.has(p.id));
    const krGroups = krsOf(o.id).map((k): RoadmapGroup => {
      const ps = projects.filter((p) => goalOf(p) === k.id && !placed.has(p.id));
      ps.forEach((p) => placed.add(p.id));
      return { id: k.id, title: k.title, subtitle: 'Key result', depth: 1, projects: ps };
    }).filter((g) => g.projects.length > 0);
    direct.forEach((p) => placed.add(p.id));
    if (direct.length || krGroups.length) out.push({ id: o.id, title: o.title, subtitle: 'Objective', depth: 0, projects: direct }, ...krGroups);
  }
  // Key results with no objective above them, and any other goal kind.
  const loose = new Map<string, ProjectSummary[]>();
  for (const p of projects) {
    if (placed.has(p.id)) continue;
    const g = goalOf(p);
    if (g && byId.has(g)) { loose.set(g, [...(loose.get(g) ?? []), p]); placed.add(p.id); }
  }
  for (const [g, ps] of loose) out.push({ id: g, title: byId.get(g)!.title, subtitle: byId.get(g)!.kind === 'key_result' ? 'Key result' : 'Goal', depth: 0, projects: ps });
  const none = projects.filter((p) => !placed.has(p.id));
  if (none.length) out.push({ id: 'none', title: 'No key result', depth: 0, projects: none });
  return out;
}

export const LANES = ['now', 'next', 'later'] as const;
export type Lane = typeof LANES[number];
export const LANE_WORD: Record<Lane, string> = { now: 'Now', next: 'Next', later: 'Later' };
export function laneRank(l: string): number { const i = (LANES as readonly string[]).indexOf(l); return i < 0 ? 9 : i; }

/** The board's columns, each ordered by rank. Done and cancelled projects stay off it. */
export function laneColumns(projects: ProjectSummary[]): Record<Lane, ProjectSummary[]> {
  const live = projects.filter((p) => p.status !== 'done' && p.status !== 'cancelled');
  const col = (l: Lane) => live.filter((p) => (laneRank(p.lane) > 2 ? 'later' : p.lane) === l).sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
  return { now: col('now'), next: col('next'), later: col('later') };
}

// ---- shared vocabulary ----

export const HEALTH_COLOR: Record<string, string> = { on_track: 'var(--green)', at_risk: 'var(--amber)', off_track: 'var(--red)', '': 'var(--text-faint)' };
export const HEALTH_WORD: Record<string, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', '': 'No update yet' };
export const healthColor = (h: string | null | undefined): string => HEALTH_COLOR[h ?? ''] ?? HEALTH_COLOR[''];
export const healthWord = (h: string | null | undefined): string => HEALTH_WORD[h ?? ''] ?? (h ?? '').replace(/_/g, ' ');

/** The share of the appetite used: the larger of money and time; null when none is set. */
export function appetiteUsed(a: ProjectSummary['appetite']): number | null {
  const shares = [a.usdShare, a.daysShare].filter((x): x is number => typeof x === 'number');
  return shares.length ? Math.max(...shares) : null;
}

export function appetiteLine(a: ProjectSummary['appetite']): string {
  const parts: string[] = [];
  if (a.usd > 0) parts.push(`$${a.spentUsd.toFixed(2)} of $${a.usd.toFixed(0)}`);
  if (a.days > 0) parts.push(`${a.daysUsed ?? 0} of ${a.days} days`);
  return parts.length ? parts.join(', ') : 'No appetite set';
}

export function forecastLine(f: ProjectSummary['forecast']): string {
  if (f.state === 'done') return 'Nothing left to do';
  if (f.state === 'range' && f.p50 && f.p85) return `Likely ${f.p50}, 85% by ${f.p85}`;
  return f.note || 'Not enough history to forecast';
}

export function updateWord(u: ProjectSummary['update']): string {
  if (u.state === 'missing') return 'Update missing';
  if (u.state === 'due') return 'Update due';
  if (u.state === 'fresh') return u.dueAt ? `Next update ${u.dueAt.slice(0, 10)}` : 'Up to date';
  return '';
}

export const SOURCE_WORD: Record<TaskSource, string> = { plan: 'plan', meeting: 'meeting', retro: 'retro', incident: 'incident', escalation: 'escalation', agent: 'agent', ceo: 'from you', chat: 'chat', process: 'process', proposal: 'proposal', service: 'service' };
/** Quiet badges; the work about work (retro, meeting) and the CEO's own are told apart by tone. */
export const SOURCE_TONE: Record<TaskSource, { bg: string; fg: string }> = {
  plan: { bg: 'var(--panel-2)', fg: 'var(--text-dim)' },
  meeting: { bg: 'color-mix(in srgb, var(--blue) 14%, transparent)', fg: 'var(--blue)' },
  retro: { bg: 'color-mix(in srgb, var(--amber) 16%, transparent)', fg: 'var(--amber)' },
  incident: { bg: 'color-mix(in srgb, var(--red) 14%, transparent)', fg: 'var(--red)' },
  escalation: { bg: 'color-mix(in srgb, var(--red) 10%, transparent)', fg: 'var(--red)' },
  agent: { bg: 'var(--panel-2)', fg: 'var(--text-faint)' },
  ceo: { bg: 'color-mix(in srgb, var(--accent) 16%, transparent)', fg: 'var(--accent-hi)' },
  chat: { bg: 'var(--panel-2)', fg: 'var(--text-dim)' },
  process: { bg: 'color-mix(in srgb, var(--green) 12%, transparent)', fg: 'var(--green)' },
  proposal: { bg: 'color-mix(in srgb, var(--green) 12%, transparent)', fg: 'var(--green)' },
  service: { bg: 'var(--panel-2)', fg: 'var(--text-dim)' },
};

/** The stored blocker (JSON) as an object, or null. */
export function parseBlockedOn(raw: string | null | undefined): BlockedOn | null {
  if (!raw) return null;
  try { const v = JSON.parse(raw) as BlockedOn; return v && typeof v.kind === 'string' ? v : null; } catch { return null; }
}

/** The blocker in words: "Waits on the CEO: pick a sponsor". */
export function blockedText(b: BlockedOn | null, nameOf: (id: string) => string = (id) => id.slice(0, 8)): string {
  if (!b) return '';
  const head = {
    task: `Waits on task ${b.ref ? nameOf(b.ref) : ''}`.trim(),
    person: `Waits on ${b.ref ? nameOf(b.ref) : 'a person'}`,
    agent: `Waits on ${b.ref ? nameOf(b.ref) : 'a member'}`,
    manager: `Waits on the manager${b.ref ? ` (${nameOf(b.ref)})` : ''}`,
    ceo: 'Waits on you',
    external: 'Waits on someone outside the company',
    decision: 'Waits on a decision',
  }[b.kind] ?? 'Blocked';
  return b.reason ? `${head}: ${b.reason}` : head;
}

/** Checklist steps (JSON) as done / total, dropped ones not counted. */
export function stepsCount(raw: string | null | undefined): { done: number; total: number } {
  try {
    const v = JSON.parse(raw || '[]') as Array<{ done?: boolean; dropped?: boolean }>;
    const live = Array.isArray(v) ? v.filter((s) => !s.dropped) : [];
    return { done: live.filter((s) => s.done).length, total: live.length };
  } catch { return { done: 0, total: 0 }; }
}

/** A point on the hill (0–1) for the SVG: x along, y on a sine hump. */
export function hillPoint(hill: number, width: number, height: number): { x: number; y: number } {
  const h = Math.max(0, Math.min(1, hill));
  return { x: h * width, y: height - Math.sin(h * Math.PI) * (height - 6) - 3 };
}
