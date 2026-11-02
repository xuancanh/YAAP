/**
 * The CEO's seat, pure helpers (docs/company-vision.md §2, §3, §5, §8;
 * execution plan items 18–21): how a key result's pace and risk are shown,
 * how a cron reads in words, how the pulse series becomes a sparkline, how
 * minutes JSON and tunables are grouped. No fetches, no React — the
 * web-tests pin these.
 */
import type { Minutes, OrgIntentNode, OrgSignal, OrgTunable, Pace, SignalSeverity, TunableArea } from './api';

// ---- pace and risk (§2.4) ----

export interface PaceBadge { label: string; color: string; title: string }

/** The pace badge: measured progress against the linear expectation. */
export function paceBadge(pace: Pace, expected: number | null, measured: number | null): PaceBadge {
  const pct = (v: number | null) => (v === null ? '?' : `${Math.round(v * 100)}%`);
  if (pace === 'onPace') return { label: 'on pace', color: 'var(--green)', title: `${pct(measured)} done where ${pct(expected)} was expected` };
  if (pace === 'behind') return { label: 'behind', color: 'var(--amber)', title: `${pct(measured)} done where ${pct(expected)} was expected` };
  return { label: 'unknown', color: 'var(--text-faint)', title: measured === null ? 'never checked in' : 'no target or due date' };
}

/** Measured progress and the owner's confidence side by side: the two can
 *  disagree, and the gap is what the CEO should look at (§2.3). */
export function confidenceGap(measured: number | null, confidence: number | null): { gap: number | null; note: string } {
  if (measured === null || confidence === null) return { gap: null, note: measured === null ? 'no measurement yet' : 'no confidence yet' };
  const gap = confidence - measured;
  if (Math.abs(gap) < 0.15) return { gap, note: 'measurement and confidence agree' };
  return { gap, note: gap > 0 ? `the owner is ${Math.round(gap * 100)} points more confident than the numbers` : `the numbers run ${Math.round(-gap * 100)} points ahead of the owner's confidence` };
}

/** "3 of 4 key results on pace · 1 at risk" for an objective row. */
export function summarizeChildren(children: OrgIntentNode[]): string {
  const krs = children.filter((c) => c.kind === 'key_result' && c.status === 'active');
  if (krs.length === 0) return children.length ? `${children.length} child goal(s)` : '';
  const on = krs.filter((k) => k.pace === 'onPace').length;
  const risk = krs.filter((k) => k.atRisk === 1).length;
  return `${on} of ${krs.length} key result${krs.length === 1 ? '' : 's'} on pace${risk ? ` · ${risk} at risk` : ''}`;
}

/** Days until a due date (negative when past), null without one. */
export function daysUntil(dueAt: string | null | undefined, now = new Date()): number | null {
  if (!dueAt) return null;
  const t = Date.parse(dueAt);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - now.getTime()) / 86_400_000);
}

export function dueLabel(dueAt: string | null | undefined, now = new Date()): string {
  const d = daysUntil(dueAt, now);
  if (d === null) return 'no due date';
  if (d < 0) return `${-d}d overdue`;
  if (d === 0) return 'due today';
  return `due in ${d}d`;
}

/** Whether a key result's check-in is due: never checked in, or older than its cadence. */
export function checkInDue(g: Pick<OrgIntentNode, 'lastCheckInAt' | 'checkInCadenceDays' | 'createdAt'>, now = new Date()): boolean {
  const last = Date.parse(g.lastCheckInAt ?? g.createdAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last > g.checkInCadenceDays * 86_400_000;
}

/** Walk the intent tree depth-first. */
export function flattenIntent(nodes: OrgIntentNode[]): OrgIntentNode[] {
  return nodes.flatMap((n) => [n, ...flattenIntent(n.children)]);
}

/** At-risk goals per unit id (null unit = the company) — the rail badges. */
export function atRiskByUnit(nodes: OrgIntentNode[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of flattenIntent(nodes)) if (g.atRisk === 1 && g.status === 'active') { const k = g.unitId ?? ''; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

export const KIND_LABEL: Record<string, string> = { vision: 'Vision', objective: 'Objective', key_result: 'Key result', task: 'Task' };

// ---- cron in words (§3) ----

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dowWords(field: string): string | null {
  if (field === '*') return 'every day';
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) { for (let d = Number(range[1]); d <= Number(range[2]); d++) days.add(d % 7); continue; }
    if (/^\d$/.test(part)) { days.add(Number(part) % 7); continue; }
    return null;
  }
  const list = [...days].sort();
  if (list.join(',') === '1,2,3,4,5') return 'weekdays';
  if (list.join(',') === '0,6') return 'weekends';
  if (list.length === 1) return `${DOW[list[0]]}s`;
  return list.map((d) => SHORT[d]).join(', ');
}

/** A five-field cron as a person reads it: "weekdays at 09:30", "Mondays at
 *  09:00", "every 2 hours", "the 1st of every month at 08:00"; the raw
 *  expression when it is too odd to put in words. */
export function humanCron(expr: string): string {
  const f = (expr ?? '').trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = f;
  const time = /^\d+$/.test(min) && /^\d+$/.test(hour) ? `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` : null;
  if (mon !== '*') return expr;
  if (dom === '*' && time) {
    const days = dowWords(dow);
    return days ? `${days} at ${time}` : expr;
  }
  if (dow === '*' && /^\d+$/.test(dom) && time) {
    const n = Number(dom);
    const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
    return `the ${n}${suffix} of every month at ${time}`;
  }
  if (dom === '*' && dow === '*') {
    const everyH = /^\*\/(\d+)$/.exec(hour);
    if (min === '0' && everyH) return `every ${everyH[1]} hours`;
    if (min === '0' && hour === '*') return 'every hour';
    const everyM = /^\*\/(\d+)$/.exec(min);
    if (everyM && hour === '*') return `every ${everyM[1]} minutes`;
  }
  return expr;
}

/** Cadences whose cron fires on `day` (local time), for "today's ritual". */
export function firesOn(expr: string, day = new Date()): boolean {
  const f = (expr ?? '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [, , dom, mon, dow] = f;
  const match = (field: string, value: number) => field === '*' || field.split(',').some((part) => {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    return /^\d+$/.test(part) && Number(part) === value;
  });
  return match(dom, day.getDate()) && match(mon, day.getMonth() + 1) && (match(dow, day.getDay()) || (dow.includes('7') && day.getDay() === 0));
}

export const MEETING_KIND_TITLES: Record<string, string> = {
  planning: 'Planning', standup: 'Standup', weekly_review: 'Weekly review', retro: 'Retro', board: 'Board meeting', adhoc: 'Meeting',
};

// ---- minutes (§3) ----

export function parseMinutes(raw: string | null | undefined): Minutes {
  const empty: Minutes = { summary: '', decisions: [], actions: [], risks: [], questions: [] };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as Partial<Minutes>;
    return { ...empty, ...v, decisions: v.decisions ?? [], actions: v.actions ?? [], risks: v.risks ?? [], questions: v.questions ?? [] };
  } catch { return empty; }
}

/** The meeting id a `minutes` attachment names (`meetings/<id>`), or null. */
export function minutesMeetingId(attachments: Array<{ path?: string; kind?: string }>): string | null {
  const a = attachments.find((x) => x.kind === 'minutes' && typeof x.path === 'string');
  const m = a ? /^meetings\/([\w-]+)$/.exec(a.path!) : null;
  return m ? m[1] : null;
}

// ---- the pulse (§5) ----

/** An SVG path for a 0–100 series on a w×h box; null points break the line. */
export function sparkPath(series: Array<number | null>, w = 100, h = 28): string {
  const n = series.length;
  if (n === 0) return '';
  const step = n > 1 ? w / (n - 1) : 0;
  let d = '';
  let pen = false;
  series.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) { pen = false; return; }
    const x = (i * step).toFixed(2);
    const y = (h - 1 - (Math.min(100, Math.max(0, v)) / 100) * (h - 2)).toFixed(2);
    d += `${pen ? 'L' : 'M'}${x},${y}`;
    pen = true;
  });
  return d;
}

export function scoreColor(score: number | null): string {
  if (score === null) return 'var(--text-faint)';
  return score >= 75 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
}

export const SEVERITY_ORDER: SignalSeverity[] = ['critical', 'warn', 'info'];
export const SEVERITY_COLOR: Record<SignalSeverity, string> = { critical: 'var(--red)', warn: 'var(--amber)', info: 'var(--blue)' };

/** Open signals grouped by severity, critical first; resolved ones dropped. */
export function groupSignals(signals: OrgSignal[]): Array<{ severity: SignalSeverity; rows: OrgSignal[] }> {
  return SEVERITY_ORDER.map((severity) => ({ severity, rows: signals.filter((s) => s.severity === severity && s.status !== 'resolved') })).filter((g) => g.rows.length > 0);
}

/** `kind` of a signal in words: `stale_task` → "stale task". */
export function signalKindLabel(kind: string): string { return kind.replace(/_/g, ' '); }

export interface SloTile { key: 'cycleTimeHours' | 'firstReviewAcceptancePct' | 'decisionLatencyHours'; label: string; value: number | null; target: number; unit: string; met: boolean | null }

/** The three SLO tiles vs their targets (acceptance is "higher is better"). */
export function sloTiles(today: { cycleTimeHours: number | null; firstReviewAcceptancePct: number | null; decisionLatencyHours: number | null }, targets: { cycleTimeHours: number; firstReviewAcceptancePct: number; decisionLatencyHours: number }): SloTile[] {
  const met = (v: number | null, t: number, higher: boolean) => (v === null ? null : higher ? v >= t : v <= t);
  return [
    { key: 'cycleTimeHours', label: 'Cycle time', value: today.cycleTimeHours, target: targets.cycleTimeHours, unit: 'h', met: met(today.cycleTimeHours, targets.cycleTimeHours, false) },
    { key: 'firstReviewAcceptancePct', label: 'First-review acceptance', value: today.firstReviewAcceptancePct, target: targets.firstReviewAcceptancePct, unit: '%', met: met(today.firstReviewAcceptancePct, targets.firstReviewAcceptancePct, true) },
    { key: 'decisionLatencyHours', label: 'Decision latency', value: today.decisionLatencyHours, target: targets.decisionLatencyHours, unit: 'h', met: met(today.decisionLatencyHours, targets.decisionLatencyHours, false) },
  ];
}

// ---- tunables (§1b) ----

export const AREA_LABEL: Record<TunableArea, string> = { intent: 'Intent', planning: 'Planning', rituals: 'Rituals', assurance: 'Assurance', heartbeat: 'Heartbeat', brief: 'Brief', chat: 'Chats' };
const AREA_ORDER: TunableArea[] = ['intent', 'planning', 'rituals', 'assurance', 'heartbeat', 'brief', 'chat'];

/** Tunables grouped by area in a fixed order, keys sorted within. */
export function groupTunables(list: OrgTunable[]): Array<{ area: TunableArea; rows: OrgTunable[] }> {
  return AREA_ORDER.map((area) => ({ area, rows: list.filter((t) => t.area === area).sort((a, b) => a.key.localeCompare(b.key)) })).filter((g) => g.rows.length > 0);
}

/** Client-side mirror of the bound check: a number inside [min, max]. */
export function tunableError(t: Pick<OrgTunable, 'min' | 'max' | 'key'>, raw: string): string | null {
  const v = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(v)) return `${t.key} needs a number`;
  if (v < t.min || v > t.max) return `must stay within ${t.min}–${t.max}`;
  return null;
}

/** The `slo.*` keys write through PATCH …/org/slo as named targets. */
export const SLO_TARGET_OF: Record<string, 'cycleTimeHours' | 'firstReviewAcceptancePct' | 'decisionLatencyHours'> = {
  'slo.cycleTimeHours': 'cycleTimeHours', 'slo.firstReviewAcceptancePct': 'firstReviewAcceptancePct', 'slo.decisionLatencyHours': 'decisionLatencyHours',
};

/** "decided by" in words: `agent:<id>` → the agent's name, `user` → You. */
export function decidedByLabel(decidedBy: string, agentName: (id: string) => string | undefined, humanName: (id: string) => string): string {
  if (decidedBy === 'user' || decidedBy === 'ceo') return 'You (CEO)';
  if (decidedBy === 'chief') return 'the chief of staff';
  if (decidedBy === 'system') return 'the company';
  const agent = /^agent:(.+)$/.exec(decidedBy);
  if (agent) return agentName(agent[1]) ?? `agent ${agent[1].slice(0, 8)}`;
  const human = /^human:(.+)$/.exec(decidedBy);
  if (human) return humanName(human[1]);
  return agentName(decidedBy) ?? humanName(decidedBy);
}

/** Where a decision came from: meeting / approval / autonomous (the chief alone) / cadence. */
export function decisionSource(d: { meetingId: string | null; approvalId: string | null; refType: string }): 'meeting' | 'approval' | 'cadence' | 'autonomous' {
  if (d.meetingId) return 'meeting';
  if (d.approvalId) return 'approval';
  if (d.refType === 'cadence') return 'cadence';
  return 'autonomous';
}
