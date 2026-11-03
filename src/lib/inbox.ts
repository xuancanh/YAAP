/** The Inbox and the Company menu (docs/company-vision.md §8 "The CEO's
 *  seat"): everything waiting on the CEO in one list, and the company panes
 *  grouped in the Company rail. Pure — the views and the store use these. */
import type { AgentMessage, FollowRow, HistoryItem, HistoryOutcome, OrgApproval, OrgHealth, OrgPlan, OrgTask } from './api';
import type { OrgPane } from '../store';

// ---- Inbox ----

export type InboxFilter = 'all' | 'messages' | 'approvals' | 'keys' | 'escalations' | 'plans' | 'mytasks' | 'incidents' | 'following';
export const INBOX_FILTERS: Array<{ id: InboxFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'messages', label: 'Messages' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'keys', label: 'Keys' },
  { id: 'escalations', label: 'Escalations' },
  // "Plans" are veto-window change batches (org_plans): named Pending changes in the UI so "plan" means the roadmap (docs/work-tracking.md).
  { id: 'plans', label: 'Pending changes' },
  { id: 'mytasks', label: 'My tasks' },
  { id: 'incidents', label: 'Incidents' },
  { id: 'following', label: 'Following' },
];

export interface InboxItem {
  key: string; kind: Exclude<InboxFilter, 'all'>; title: string; detail: string; at: string; refId: string;
  /** Following (docs/follows.md): the followed thread or task, its unseen count and why it needs me. */
  follow?: { targetKind: FollowRow['targetKind']; targetId: string; link: string; unseen: number; attention: string; closed: boolean };
  /** Messages (docs/agent-messages.md): who sent it, how urgent, read or not, and the direct chat it opens. */
  message?: { agentName: string; emoji: string; colors: string; urgency: AgentMessage['urgency']; read: boolean; sessionId: string; eventId: string | null; refs: string[] };
}

export interface InboxSource {
  approvals: OrgApproval[];
  plans: OrgPlan[];
  tasks: { assigned: OrgTask[]; reviewing: OrgTask[] } | null;
  incidents: OrgHealth['openIncidents'];
  /** Held or staged actions waiting for the owner's key (one row for all). */
  heldActions: number;
  /** What I follow (`GET …/follows/mine`): the ones with something new are listed. */
  follows?: FollowRow[];
  /** Messages from agents (`GET …/inbox/messages`): the unread ones wait on me. */
  messages?: AgentMessage[];
}

const OPEN_TASK = new Set(['backlog', 'waiting', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked']);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function payloadOf(a: OrgApproval): Record<string, unknown> {
  try { const v = JSON.parse(a.payload) as unknown; return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; }
}

/** One list, newest first: pending cards (escalations apart; two-key cards
 *  ride on the keys row), the keys row, plans awaiting veto, my open tasks
 *  and reviews, incidents nobody has contained yet. */
export function buildInbox(src: InboxSource): InboxItem[] {
  const out: InboxItem[] = [];
  for (const a of src.approvals) {
    // A card a manager still holds is on its way up, not yours yet (docs/owners-seat.md §7).
    if (a.status !== 'pending' || a.kind === 'two_key' || a.forYou === false) continue;
    const p = payloadOf(a);
    const name = str(p.title) || str(p.name) || str(p.summary) || a.recommendation;
    // The route it climbed: "Writer → Head of Content → Chief → you".
    const via = a.chainLine && a.chainLine.includes('→') ? a.chainLine : '';
    const withVia = (d: string) => [d, via].filter(Boolean).join(' · ');
    if (a.kind === 'escalation') out.push({ key: `a:${a.id}`, kind: 'escalations', title: `Escalation: ${str(p.taskKey) ? `${str(p.taskKey)} ` : ''}${str(p.title) || 'a task'}`, detail: withVia(str(p.reason)), at: a.createdAt, refId: a.id });
    else out.push({ key: `a:${a.id}`, kind: 'approvals', title: `${a.kind.replace(/_/g, ' ')}${name ? `: ${name}` : ''}`, detail: withVia(a.recommendation && a.recommendation !== name ? a.recommendation : ''), at: a.createdAt, refId: a.id });
  }
  if (src.heldActions > 0) out.push({ key: 'keys', kind: 'keys', title: `${src.heldActions} action${src.heldActions === 1 ? '' : 's'} waiting for your key`, detail: 'Held or staged outward actions — the exact call runs only with your key.', at: '', refId: '' });
  for (const p of src.plans) if (p.status === 'pending') out.push({ key: `p:${p.id}`, kind: 'plans', title: `Plan: ${p.summary || p.trigger}`, detail: p.applyAt ? `applies at ${p.applyAt.slice(0, 16).replace('T', ' ')} unless vetoed` : '', at: p.createdAt, refId: p.id });
  for (const t of src.tasks?.assigned ?? []) if (OPEN_TASK.has(t.status)) out.push({ key: `t:${t.id}`, kind: 'mytasks', title: `${t.key ? `${t.key} ` : ''}${t.title}`, detail: `assigned to you · ${t.status.replace('_', ' ')}`, at: t.updatedAt ?? t.createdAt, refId: t.id });
  for (const t of src.tasks?.reviewing ?? []) if (OPEN_TASK.has(t.status)) out.push({ key: `r:${t.id}`, kind: 'mytasks', title: `Review: ${t.key ? `${t.key} ` : ''}${t.title}`, detail: 'waiting for your review', at: t.updatedAt ?? t.createdAt, refId: t.id });
  for (const i of src.incidents) if (i.status === 'open') out.push({ key: `i:${i.id}`, kind: 'incidents', title: i.title, detail: `${i.severity} · ${i.kind.replace(/_/g, ' ')}`, at: i.openedAt, refId: i.id });
  for (const f of src.follows ?? []) {
    if (f.mutedAt || (f.unseenCount <= 0 && !f.attentionAt)) continue;
    out.push(followItem(f));
  }
  for (const m of src.messages ?? []) if (!m.read) out.push(messageItem(m));
  // The keys row (no time) leads; the rest newest first.
  return out.sort((a, b) => (a.at === b.at ? 0 : !a.at ? -1 : !b.at ? 1 : a.at < b.at ? 1 : -1));
}

export function filterInbox(items: InboxItem[], f: InboxFilter): InboxItem[] {
  return f === 'all' ? items : items.filter((i) => i.kind === f);
}

/** One agent's message to the owner as an Inbox row: the sender, the first line, the rest as detail. The text is data (rendered as text). */
export function messageItem(m: AgentMessage): InboxItem {
  const lines = m.text.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  return {
    key: `m:${m.id}`, kind: 'messages', title: `${m.agentName}: ${first.length > 160 ? `${first.slice(0, 159)}…` : first}`,
    detail: lines.slice(1).join(' ').slice(0, 240), at: m.createdAt, refId: m.id,
    message: { agentName: m.agentName, emoji: m.emoji, colors: m.colors, urgency: m.urgency, read: m.read, sessionId: m.sessionId, eventId: m.eventId, refs: m.refs },
  };
}

/** The Messages filter: every recent message, unread first, newest first. */
export function messagesList(messages: AgentMessage[]): InboxItem[] {
  return messages.map(messageItem).sort((a, b) => Number(a.message!.read) - Number(b.message!.read) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

const TARGET_WORD: Record<FollowRow['targetKind'], string> = { thread: 'thread', org_task: 'task', agent_task: 'task' };

/** One followed thread or task as an Inbox row: its title, the latest change and who made it. */
export function followItem(f: FollowRow): InboxItem {
  const what = f.lastActivity ? `${f.lastActorName ? `${f.lastActorName}: ` : ''}${f.lastActivity}` : 'Nothing new since you looked';
  return {
    key: `f:${f.targetKind}:${f.targetId}`, kind: 'following', title: f.title || `A followed ${TARGET_WORD[f.targetKind]}`, detail: what,
    at: f.lastActivityAt ?? f.createdAt, refId: f.targetId,
    follow: { targetKind: f.targetKind, targetId: f.targetId, link: f.link, unseen: f.unseenCount, attention: f.attentionAt ? f.attention || 'needs you' : '', closed: Boolean(f.closedAt) },
  };
}

/** The Following filter: every live follow, the ones needing me first, then the ones with news, newest first. */
export function followingList(follows: FollowRow[]): InboxItem[] {
  const rank = (i: InboxItem) => (i.follow?.attention ? 0 : (i.follow?.unseen ?? 0) > 0 ? 1 : 2);
  return follows.filter((f) => !f.mutedAt).map(followItem).sort((a, b) => rank(a) - rank(b) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** What the header counts as waiting on me: everything but followed news that does not need me. */
export function waitingCount(items: InboxItem[]): number {
  return items.filter((i) => i.kind !== 'following' || Boolean(i.follow?.attention)).length;
}

/** The Inbox nav badge: everything waiting on the CEO. Followed threads and
 *  tasks count only when their latest change needs me, not for every reply. */
export function inboxBadge(c: { pendingApprovals: number; heldActions: number; pendingPlans: number; openIncidents: number; myTasks: number; followAttention?: number; unreadMessages?: number }): number {
  return c.pendingApprovals + c.heldActions + c.pendingPlans + c.openIncidents + c.myTasks + (c.followAttention ?? 0) + (c.unreadMessages ?? 0);
}

// ---- the Company menu ----

export type CompanyGroupId = 'teams' | 'direction' | 'operations' | 'people' | 'oversight';
export interface CompanyEntry { pane: OrgPane; label: string; /** Panes merged into this entry as tabs. */ tabs?: OrgPane[] }
/** The rail's groups below Teams (the unit groups). Approvals and My tasks
 *  live in the Inbox; Brief is a tab of Pulse, Capital of Spend, Replay of Audit. */
export const COMPANY_GROUPS: Array<{ id: CompanyGroupId; label: string; entries: CompanyEntry[] }> = [
  { id: 'teams', label: 'Teams', entries: [] },
  { id: 'direction', label: 'Direction', entries: [{ pane: 'roadmap', label: 'Roadmap' }, { pane: 'vision', label: 'Vision' }, { pane: 'goals', label: 'Goals' }, { pane: 'plans', label: 'Pending changes' }, { pane: 'decisions', label: 'Decisions' }] },
  { id: 'operations', label: 'Operations', entries: [{ pane: 'pulse', label: 'Pulse', tabs: ['pulse', 'brief'] }, { pane: 'meetings', label: 'Meetings' }, { pane: 'incidents', label: 'Incidents' }] },
  { id: 'people', label: 'People & money', entries: [{ pane: 'chart', label: 'Org chart' }, { pane: 'spend', label: 'Spend', tabs: ['spend', 'capital'] }] },
  { id: 'oversight', label: 'Oversight', entries: [{ pane: 'audit', label: 'Audit', tabs: ['audit', 'replay'] }] },
];

/** The pane pairs shown as tabs of one entry, by pane. */
export function tabsOf(pane: OrgPane): OrgPane[] | null {
  for (const g of COMPANY_GROUPS) for (const e of g.entries) if (e.tabs?.includes(pane)) return e.tabs;
  return null;
}

/** Where a pane lives now: the Inbox for approvals and my tasks, the Company
 *  section for the rest (merged panes open on their tab). */
export function paneHome(pane: OrgPane): { section: 'inbox'; filter: InboxFilter } | { section: 'workspace'; pane: OrgPane } {
  if (pane === 'approvals') return { section: 'inbox', filter: 'approvals' };
  if (pane === 'mytasks') return { section: 'inbox', filter: 'mytasks' };
  return { section: 'workspace', pane };
}

// ---- the Inbox's History ----

/** Waiting (what is on me now) or History (what was, and how it ended). */
export type InboxMode = 'waiting' | 'history';

/** The History's date windows, in days (0 = all time). */
export const HISTORY_RANGES: Array<{ days: number; label: string }> = [
  { days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 0, label: 'All time' },
];

/** The start of a window `days` back from `now`, or undefined for all time. */
export function historyFrom(days: number, now: Date = new Date()): string | undefined {
  return days > 0 ? new Date(now.getTime() - days * 86_400_000).toISOString() : undefined;
}

export const OUTCOME_LABEL: Record<HistoryOutcome, string> = {
  approved: 'approved', rejected: 'rejected', revision_requested: 'sent back', expired: 'expired',
  released: 'released', failed: 'released · failed', denied: 'denied', refused: 'refused',
  applied: 'applied', vetoed: 'vetoed', contained: 'contained', resolved: 'resolved',
  done: 'done', cancelled: 'cancelled', seen: 'seen',
};

/** The outcome's colour: a yes green, a no red, the rest neutral. */
export function outcomeColor(o: HistoryOutcome): string {
  if (o === 'approved' || o === 'released' || o === 'applied' || o === 'resolved' || o === 'done') return 'var(--green)';
  if (o === 'rejected' || o === 'denied' || o === 'vetoed' || o === 'failed' || o === 'refused') return 'var(--red)';
  if (o === 'contained') return 'var(--amber)';
  return 'var(--text-faint)';
}

/** "by you", "by the default at your deadline", "by your delegate Fin", "by Penny (agent)". */
export function historyBy(i: Pick<HistoryItem, 'by' | 'outcome'>): string {
  switch (i.by.kind) {
    case 'you': return 'by you';
    case 'default': return `by ${i.by.name}`;
    case 'delegate': return `by your delegate ${i.by.name === 'You' ? '(you)' : i.by.name}`;
    case 'agent': return `by ${i.by.name} (agent)`;
    case 'system': return i.outcome === 'expired' && i.by.name.startsWith('nobody') ? 'nobody answered' : `by ${i.by.name}`;
    default: return `by ${i.by.name}`;
  }
}

/** Where a History row opens: the task, the conversation a key ran in, the
 *  Inbox pane holding the cards, the plan or incident, or a followed thread. */
export type HistoryTarget =
  | { to: 'task'; taskId: string }
  | { to: 'chat'; sessionId: string }
  | { to: 'inbox'; filter: InboxFilter }
  | { to: 'pane'; pane: 'plans' | 'incidents'; focus: { kind: 'plan' | 'incident'; id: string } }
  | { to: 'hash'; hash: string };

export function historyTarget(i: HistoryItem): HistoryTarget | null {
  const l = i.link;
  switch (l.type) {
    case 'task': return { to: 'task', taskId: l.id };
    case 'action': return l.sessionId ? { to: 'chat', sessionId: l.sessionId } : { to: 'inbox', filter: 'keys' };
    case 'approval': return { to: 'inbox', filter: i.kind === 'escalations' ? 'escalations' : 'approvals' };
    case 'plan': return { to: 'pane', pane: 'plans', focus: { kind: 'plan', id: l.id } };
    case 'incident': return { to: 'pane', pane: 'incidents', focus: { kind: 'incident', id: l.id } };
    default: return l.href ? { to: 'hash', hash: l.href.replace(/^[^#]*/, '') } : null;
  }
}
