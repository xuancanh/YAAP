/** Operations › Improvements, the pure half (docs/improvements.md): words,
 *  tones and groupings for improvement proposals and the Work sources
 *  panel. The component (src/components/OrgImprovementsView.tsx) and the
 *  tests share these. */
import type { ChangeClass, ImprovementCategory, ImprovementStatus, OrgImprovement, WorkSources } from './api';
import type { Tone } from './direction';

export const STATUS_WORD: Record<ImprovementStatus, string> = {
  proposed: 'Awaiting a decision', accepted: 'Accepted', applied: 'Being verified', verified: 'Verified', reverted: 'Reverted', rejected: 'Rejected', expired: 'Expired',
};
export const STATUS_TONE: Record<ImprovementStatus, Tone> = {
  proposed: 'warn', accepted: 'info', applied: 'info', verified: 'ok', reverted: 'bad', rejected: 'muted', expired: 'muted',
};
export const CATEGORY_WORD: Record<ImprovementCategory, string> = { investigate: 'Investigate', mitigate: 'Mitigate', repair: 'Repair', detect: 'Detect', prevent: 'Prevent' };
export const CLASS_WORD: Record<ChangeClass, string> = { standard: 'Standard change', normal: 'Normal change', emergency: 'Emergency change' };
export const CLASS_HINT: Record<ChangeClass, string> = {
  standard: 'Pre-authorised: the owner\'s own reversible change that leaves the controls alone; applied at once and verified later.',
  normal: 'Approved by the target\'s owner (the proposer\'s manager, or you for charters, tunables and loosened controls).',
  emergency: 'Applied during an open incident; the owner reviews it afterwards and a rejection reverts it.',
};
/** Where work comes from, as the Work sources panel names it. */
export const ORIGIN_WORD: Record<string, string> = {
  plan: 'Plans and goals', process: 'Process steps', service: 'Service requests', incident: 'Incidents', escalation: 'Escalations', human: 'You and people',
  proposal: 'Accepted proposals', chief: 'Chief of staff', retro: 'Retros', meeting: 'Meetings', agent: 'Agent initiative',
};

export type ImprovementFilter = 'decide' | 'flight' | 'done' | 'closed';
export const FILTERS: Array<{ id: ImprovementFilter; label: string }> = [
  { id: 'decide', label: 'Needs a decision' }, { id: 'flight', label: 'In flight' }, { id: 'done', label: 'Verified' }, { id: 'closed', label: 'Closed' },
];

/** The filter a proposal lists under. An emergency change still under review needs a decision. */
export function filterOf(p: Pick<OrgImprovement, 'status' | 'reviewPending'>): ImprovementFilter {
  if (p.status === 'proposed' || (p.status === 'applied' && p.reviewPending)) return 'decide';
  if (p.status === 'accepted' || p.status === 'applied') return 'flight';
  if (p.status === 'verified') return 'done';
  return 'closed';
}

export function countByFilter(rows: Array<Pick<OrgImprovement, 'status' | 'reviewPending'>>): Record<ImprovementFilter, number> {
  const out: Record<ImprovementFilter, number> = { decide: 0, flight: 0, done: 0, closed: 0 };
  for (const r of rows) out[filterOf(r)] += 1;
  return out;
}

export const pct = (x: number | null | undefined): string => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

/** The Work sources bars: every origin with tasks, largest first, flagged when self-started. */
export function sourceBars(w: WorkSources): Array<{ origin: string; label: string; n: number; share: number; self: boolean }> {
  const total = Math.max(1, w.total);
  return Object.entries(w.byOrigin).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .map(([origin, n]) => ({ origin, label: ORIGIN_WORD[origin] ?? origin, n, share: n / total, self: w.selfOrigins.includes(origin) }));
}

/** Where a proposal came from, as "raised by X in a retro". */
export const ORIGIN_PHRASE: Record<string, string> = {
  retro: 'in a retro', postmortem: 'in a postmortem', process_review: 'in a process review', discovery: 'from process discovery', incident: 'during an incident',
  verification: 'after a failed check', meeting: 'in a meeting', agent: '', ceo: '',
};

/** The Work sources panel's split: directed vs self-started work, each origin's tasks as
 *  rows on one scale (the largest origin fills the track), labelled with the count and
 *  its share of all new work so the bars never stand alone. */
export function sourceSplit(w: WorkSources): {
  total: number; directed: number; self: number;
  groups: Array<{ id: 'directed' | 'self'; label: string; n: number; rows: Array<{ origin: string; label: string; n: number; share: number; scale: number }> }>;
} {
  const bars = sourceBars(w);
  const max = Math.max(1, ...bars.map((b) => b.n));
  const rows = (self: boolean) => bars.filter((b) => b.self === self).map((b) => ({ origin: b.origin, label: b.label, n: b.n, share: b.share, scale: b.n / max }));
  const sum = (r: Array<{ n: number }>) => r.reduce((a, b) => a + b.n, 0);
  const directedRows = rows(false);
  const selfRows = rows(true);
  const groups: ReturnType<typeof sourceSplit>['groups'] = [
    { id: 'directed', label: 'Directed', n: sum(directedRows), rows: directedRows },
    { id: 'self', label: 'Self-started', n: sum(selfRows), rows: selfRows },
  ];
  return { total: w.total, directed: sum(directedRows), self: sum(selfRows), groups: groups.filter((g) => g.rows.length > 0) };
}

/** A unit's open self-started work against its cap: the tone its bar takes. */
export function capTone(open: number, cap: number): Tone {
  if (cap <= 0) return 'muted';
  if (open >= cap) return 'bad';
  return open >= cap - 1 ? 'warn' : 'ok';
}

/** One line on what the verification found. */
export function verificationWords(p: Pick<OrgImprovement, 'verification' | 'status' | 'verifyAt' | 'expectedText'>): string {
  if (p.verification) return `${p.verification.outcome === 'pass' ? 'Met' : p.verification.outcome === 'fail' ? 'Missed' : 'Not measurable'} — ${p.verification.detail}`;
  if (p.status === 'applied' && p.verifyAt) return `Checked on ${p.verifyAt.slice(0, 10)} against ${p.expectedText}`;
  return `Expected: ${p.expectedText}`;
}

/** Who a holder string is ('ceo', 'agent:<id>', 'user', 'improvement:IM-3'). */
export function holderWord(holder: string, names: Map<string, { name: string }>): string {
  if (holder === 'ceo' || holder === 'user') return 'you';
  if (holder.startsWith('agent:')) return names.get(holder.slice(6))?.name ?? 'an agent';
  if (holder.startsWith('human:')) return 'a person';
  if (holder === 'system') return 'the system';
  return holder;
}
