/**
 * Home (docs/home.md): the pure parts of the owner's mission control — the
 * one-sentence state of the company, time and money wording, what a card's
 * default means in words, and where a reference opens. Kept free of React
 * and the store so web-tests can pin the copy.
 */
import type { HomeActivityKind, HomeData, HomeNeed, HomeNeedAction, HomeRef } from './api';
import type { OrgFocus, OrgPane } from '../store';

export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n !== 0 && Math.abs(n) < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Overnight", "Since yesterday", "In the last 3 hours", "Since Monday". */
export function sinceLabel(since: string, now = new Date(), firstVisit = false): string {
  const s = new Date(since);
  const hours = (now.getTime() - s.getTime()) / 3_600_000;
  if (firstVisit) return 'In the last day';
  if (hours < 1) return 'In the last hour';
  // Last seen in the evening, back in the morning: the night shift.
  if (hours <= 16 && (s.getHours() >= 17 || s.getHours() < 5) && now.getHours() >= 5 && now.getHours() < 12 && s.getDate() !== now.getDate()) return 'Overnight';
  if (hours < 20) return `In the last ${plural(Math.round(hours), 'hour')}`;
  if (hours < 48) return 'Since yesterday';
  return `Since ${s.toLocaleDateString(undefined, { weekday: 'long' })}`;
}

/** The headline: what happened, what needs the owner, what it cost. Three short sentences. */
export function headline(d: HomeData, now = new Date()): string[] {
  const who = d.company ? 'your team' : 'your agents';
  const when = sinceLabel(d.since, now, d.firstVisit);
  const done = d.headline.tasksDone;
  const first = done > 0 ? `${when} ${who} closed ${plural(done, 'task')}.` : `${when} ${who} closed no tasks.`;
  const n = d.headline.needsYou;
  const second = n === 0 ? 'Nothing needs you.' : n === 1 ? 'One thing needs you.' : `${n} things need you.`;
  const parts = [first, second];
  if (d.headline.todayUsd !== null) {
    const cap = d.headline.monthCapUsd;
    parts.push(cap ? `${usd(d.headline.todayUsd)} spent today, ${usd(d.headline.monthUsd)} of ${usd(cap)} this month.` : `${usd(d.headline.todayUsd)} spent today.`);
  }
  return parts;
}

/** "in 40 min", "in 3 h", "Tue 14:00", "2 h ago". */
export function when(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const t = new Date(iso);
  const diff = t.getTime() - now.getTime();
  const mins = Math.round(Math.abs(diff) / 60_000);
  if (diff >= 0) {
    if (mins < 1) return 'now';
    if (mins < 60) return `in ${mins} min`;
    if (mins < 12 * 60) return `in ${Math.round(mins / 60)} h`;
    return t.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  const days = Math.round(mins / 1440);
  return days < 7 ? `${days} d ago` : t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** What happens if the owner says nothing, in words; '' when nothing happens on its own. */
export function defaultSentence(n: HomeNeed, now = new Date()): string {
  if (!n.deadline || !n.defaultAction) return '';
  const at = when(n.deadline, now);
  if (n.defaultAction === 'apply') return `Applies on its own ${at} unless you veto it.`;
  const verb = n.defaultAction === 'approve' ? 'approved' : 'denied';
  return new Date(n.deadline).getTime() <= now.getTime() ? `Past its deadline: it will be ${verb} on the next tick.` : `If you don't answer, it will be ${verb} ${at.startsWith('in ') ? at : `at ${at}`}.`;
}

/** The proposer's case in one line: "Chief recommends approve. 70% sure. Reversible." */
export function recommendationLine(n: HomeNeed): string {
  const bits: string[] = [];
  if (n.recommendedAction) bits.push(`${n.requestedBy || 'The proposer'} recommends ${n.recommendedAction}.`);
  if (n.confidence !== null) bits.push(`${Math.round(n.confidence * 100)}% sure.`);
  if (n.reversibility) bits.push(n.reversibility === 'irreversible' ? 'Cannot be undone.' : n.reversibility === 'costly' ? 'Costly to undo.' : 'Reversible.');
  return bits.join(' ');
}

export const NEED_KIND_LABEL: Record<HomeNeed['kind'], string> = {
  approval: 'Decision', escalation: 'Escalation', held_action: 'Needs your key', plan: 'Plan to veto',
  incident: 'Incident', signal: 'Signal', queued_action: 'Queued action',
};

export function actionLabel(n: HomeNeed, a: HomeNeedAction): string {
  switch (a) {
    case 'approve': return n.kind === 'held_action' ? 'Give key' : 'Approve';
    case 'reject': return n.kind === 'held_action' ? 'Deny' : 'Reject';
    case 'veto': return 'Veto';
    case 'apply_now': return 'Apply now';
    case 'ack': return 'Acknowledge';
    case 'dismiss': return 'Dismiss';
  }
}

/** What the owner did, for the toast. */
export function actionDone(a: HomeNeedAction): string {
  return { approve: 'Approved', reject: 'Rejected', veto: 'Vetoed', apply_now: 'Applied', ack: 'Acknowledged', dismiss: 'Dismissed' }[a];
}

/** Where a reference opens: an org pane (with the row to focus), an agent, a file. */
export type HomeTarget =
  | { to: 'pane'; pane: OrgPane; focus?: OrgFocus }
  | { to: 'agent'; agentId: string }
  | { to: 'file'; path: string }
  | { to: 'chat'; sessionId: string }
  | { to: 'inbox' };

export function targetOf(ref: HomeRef | null | undefined): HomeTarget | null {
  if (!ref) return null;
  switch (ref.type) {
    case 'task': return { to: 'pane', pane: 'board', focus: { kind: 'task', id: ref.id } };
    case 'goal': return { to: 'pane', pane: 'vision', focus: { kind: 'goal', id: ref.id } };
    case 'meeting': return { to: 'pane', pane: 'meetings', focus: { kind: 'meeting', id: ref.id } };
    case 'decision': return { to: 'pane', pane: 'decisions', focus: { kind: 'decision', id: ref.id } };
    case 'plan': return { to: 'pane', pane: 'plans', focus: { kind: 'plan', id: ref.id } };
    case 'incident': return { to: 'pane', pane: 'incidents', focus: { kind: 'incident', id: ref.id } };
    case 'approval': return { to: 'pane', pane: 'approvals' };
    case 'action': return { to: 'pane', pane: 'approvals', focus: { kind: 'action', id: ref.id } };
    case 'agent': return { to: 'agent', agentId: ref.id };
    case 'file': return { to: 'file', path: ref.id };
    default: return null;
  }
}

/** Where a Needs-you card opens for the full context. */
export function needTarget(n: HomeNeed): HomeTarget | null {
  if (n.ref.incidentId) return targetOf({ type: 'incident', id: n.ref.incidentId });
  if (n.ref.planId) return targetOf({ type: 'plan', id: n.ref.planId });
  if (n.kind === 'queued_action' && n.ref.agentId) return { to: 'agent', agentId: n.ref.agentId };
  if (n.kind === 'held_action' && !n.ref.approvalId && n.ref.sessionId) return { to: 'chat', sessionId: n.ref.sessionId };
  if (n.ref.approvalId || n.ref.actionId) return { to: 'inbox' };
  if (n.ref.signalId) return { to: 'pane', pane: 'pulse' };
  return null;
}

export const ACTIVITY_FILTERS: Array<{ id: 'all' | HomeActivityKind; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'task', label: 'Tasks' }, { id: 'decision', label: 'Decisions' }, { id: 'hire', label: 'People' },
  { id: 'meeting', label: 'Meetings' }, { id: 'incident', label: 'Incidents' }, { id: 'file', label: 'Files' }, { id: 'agent', label: 'Agents' },
];

/** The file's name and its folder, for compact lists. */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/** Day heading for Coming up: "Today", "Tomorrow", "Thursday 6 Nov". */
export function dayHeading(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(d) - start(now)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}
