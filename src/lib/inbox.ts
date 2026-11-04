/** The Inbox (docs/owners-seat.md "Inbox and notifications"): the owner's
 *  feed in full — Needs you, Mentions, Updates — and History. The rows and
 *  their counts come from the feed (./feed.ts); this module keeps the Inbox's
 *  filters, the Following list and History. The company sections and where
 *  each pane lives are in ./company-nav.ts. Pure — the views and the store
 *  use these. */
import type { FollowRow, HistoryItem, HistoryOutcome } from './api';

// ---- Inbox ----

/** Where the Inbox is: a tab ('needs' | 'mentions' | 'updates' | 'history';
 *  'all' is Needs you), or one kind's full queue or list — the values deep
 *  links, Home and the company dashboards set (src/lib/feed.ts inboxView). */
export type InboxFilter =
  | 'all' | 'needs' | 'mentions' | 'updates' | 'history'
  | 'messages' | 'approvals' | 'keys' | 'escalations' | 'plans' | 'mytasks' | 'incidents' | 'following';
/** Every Inbox place, for addresses like `/<company>/inbox/mentions` (docs/routes.md). */
export const INBOX_FILTER_IDS: readonly InboxFilter[] = ['all', 'needs', 'mentions', 'updates', 'history', 'messages', 'approvals', 'keys', 'escalations', 'plans', 'mytasks', 'incidents', 'following'];

/** History's kinds (what used to wait on you). */
export type HistoryFilter = 'all' | 'approvals' | 'keys' | 'escalations' | 'plans' | 'mytasks' | 'incidents' | 'following';
export const HISTORY_FILTERS: Array<{ id: HistoryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'keys', label: 'Keys' },
  { id: 'escalations', label: 'Escalations' },
  // "Plans" are veto-window change batches (org_plans): named Pending changes in the UI so "plan" means the roadmap (docs/work-tracking.md).
  { id: 'plans', label: 'Pending changes' },
  { id: 'mytasks', label: 'My tasks' },
  { id: 'incidents', label: 'Incidents' },
  { id: 'following', label: 'Following' },
];

/** A followed thread or task (docs/follows.md) as a row of the Following list. */
export interface InboxItem {
  key: string; kind: 'following'; title: string; detail: string; at: string; refId: string;
  /** The followed thread or task, its unseen count and why it needs me. */
  follow: { targetKind: FollowRow['targetKind']; targetId: string; link: string; unseen: number; attention: string; closed: boolean };
}

const TARGET_WORD: Record<FollowRow['targetKind'], string> = { thread: 'thread', org_task: 'task', agent_task: 'task', channel: 'discussion' };

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

// ---- the Inbox's History ----

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
  | { to: 'inbox'; filter: HistoryFilter }
  | { to: 'pane'; pane: 'plans' | 'incidents'; focus: { kind: 'plan' | 'incident'; id: string } }
  /** An in-app link: a path (`/<company>/…`) or an older hash; opened with routes.ts `navigate`. */
  | { to: 'hash'; hash: string };

export function historyTarget(i: HistoryItem): HistoryTarget | null {
  const l = i.link;
  switch (l.type) {
    case 'task': return { to: 'task', taskId: l.id };
    case 'action': return l.sessionId ? { to: 'chat', sessionId: l.sessionId } : { to: 'inbox', filter: 'keys' };
    case 'approval': return { to: 'inbox', filter: i.kind === 'escalations' ? 'escalations' : 'approvals' };
    case 'plan': return { to: 'pane', pane: 'plans', focus: { kind: 'plan', id: l.id } };
    case 'incident': return { to: 'pane', pane: 'incidents', focus: { kind: 'incident', id: l.id } };
    default: return l.href ? { to: 'hash', hash: l.href } : null;
  }
}
