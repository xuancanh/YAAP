/**
 * The owner's feed on screen (docs/owners-seat.md "Inbox and notifications"):
 * the Inbox and the bell render the same rows from the same page
 * (`GET …/feed`), so their counts agree. Pure — labels, tones, the Inbox's
 * tabs and chips, where a row opens and the local recount after a read mark.
 *
 * What each number counts:
 *  - the Inbox's nav badge: open items in **Needs you** (read or not) — they
 *    stay until resolved;
 *  - the bell: **unread rows** in every section (Needs you, Mentions, Updates).
 */
import type { FeedAction, FeedItem, FeedPage, FeedSection, FeedType, HomeNeed } from './api';
import { actionLabel as needActionLabel, needTarget, type HomeTarget } from './home';
import type { InboxFilter } from './inbox';

export const FEED_LABEL: Record<FeedType, string> = {
  decision: 'Decision', escalation: 'Escalation', key: 'Needs your key', pending_change: 'Pending change', incident: 'Incident', signal: 'Signal',
  queued_action: 'Queued action', connection_approval: 'Approval', task_assigned: 'Your task', task_review: 'Review', blocked_on_you: 'Blocked on you',
  follow_attention: 'Following', plugin_review: 'Plugin review', message: 'Message', mention: 'Mention', follow: 'Following', channel_activity: 'Channel',
  run_failed: 'Run failed', budget: 'Budget', meeting: 'Meeting', brief: 'Brief', audit: 'Audit', experiment: 'Experiment', trust: 'Trust',
  decided_without_you: 'Decided without you', hire: 'Hire', project_team: 'Project team', program: 'Program', project: 'Project', blocked: 'Blocked',
  goal_at_risk: 'Goal at risk', plugin: 'Plugin', company: 'Company', agent_note: 'Agent note',
};

export const SECTION_LABEL: Record<FeedSection, string> = { needs: 'Needs you', mentions: 'Mentions', updates: 'Updates' };

/** The Inbox's tabs: the feed's three sections, then History. */
export type InboxTab = FeedSection | 'history';
export const INBOX_TABS: Array<{ id: InboxTab; label: string; hint: string }> = [
  { id: 'needs', label: 'Needs you', hint: 'Waits on you until it is resolved' },
  { id: 'mentions', label: 'Mentions', hint: 'Messages and @mentions addressed to you' },
  { id: 'updates', label: 'Updates', hint: 'News on what you follow and run' },
  { id: 'history', label: 'Done', hint: 'What waited on you and how it ended' },
];

/** Needs you's chips: the list, or one kind's full queue (the full card). */
export const NEEDS_CHIPS: Array<{ id: InboxFilter; label: string; types: FeedType[]; pane?: 'approvals' | 'plans' | 'mytasks' }> = [
  { id: 'needs', label: 'All', types: [] },
  { id: 'approvals', label: 'Decisions', types: ['decision'], pane: 'approvals' },
  { id: 'escalations', label: 'Escalations', types: ['escalation'], pane: 'approvals' },
  { id: 'keys', label: 'Keys', types: ['key', 'queued_action', 'connection_approval'], pane: 'approvals' },
  { id: 'plans', label: 'Pending changes', types: ['pending_change'], pane: 'plans' },
  { id: 'mytasks', label: 'My tasks', types: ['task_assigned', 'task_review', 'blocked_on_you'], pane: 'mytasks' },
  { id: 'incidents', label: 'Incidents', types: ['incident', 'signal'] },
];

/** Where a stored Inbox filter (a deep link, Home, a dashboard) lands. */
export function inboxView(f: InboxFilter): { tab: InboxTab; chip: InboxFilter } {
  switch (f) {
    case 'messages': case 'mentions': return { tab: 'mentions', chip: 'mentions' };
    case 'following': return { tab: 'updates', chip: 'following' };
    case 'updates': return { tab: 'updates', chip: 'updates' };
    case 'history': return { tab: 'history', chip: 'history' };
    case 'all': case 'needs': return { tab: 'needs', chip: 'needs' };
    default: return { tab: 'needs', chip: f };
  }
}

/** The filter a tab click sets. */
export const tabFilter = (t: InboxTab): InboxFilter => (t === 'needs' ? 'needs' : t);

export function itemsOf(page: FeedPage | null, section: FeedSection, chip?: InboxFilter): FeedItem[] {
  const items = (page?.items ?? []).filter((i) => i.section === section);
  const def = NEEDS_CHIPS.find((c) => c.id === chip);
  return section === 'needs' && def && def.types.length ? items.filter((i) => def.types.includes(i.type)) : items;
}

/** The mark's tone: red for what fails or is critical, amber for what waits or expires, the accent for what is addressed to you. */
export function feedTone(i: Pick<FeedItem, 'type' | 'severity' | 'expiresSoon' | 'section'>): 'red' | 'amber' | 'accent' | 'faint' {
  if (i.severity === 'critical' || i.type === 'incident' || i.type === 'run_failed' || (i.severity === 'high' && i.section === 'updates')) return 'red';
  if (i.section === 'needs' || i.expiresSoon) return 'amber';
  if (i.section === 'mentions') return 'accent';
  return 'faint';
}
export const TONE_VAR = { red: 'var(--red)', amber: 'var(--amber)', accent: 'var(--accent)', faint: 'var(--text-faint)' } as const;

/** The context chips: the task key, the project, the channel, the meeting. */
export function contextChips(i: Pick<FeedItem, 'context' | 'title'>): string[] {
  const c = i.context;
  const out: string[] = [];
  if (c.taskKey && !i.title.includes(c.taskKey)) out.push(c.taskKey);
  if (c.projectKey && !i.title.includes(c.projectKey)) out.push(c.projectKey);
  if (c.channelSlug && !i.title.includes(`#${c.channelSlug}`)) out.push(`#${c.channelSlug}`);
  if (c.meetingTitle && !i.title.includes(c.meetingTitle)) out.push(c.meetingTitle);
  return out;
}

export function feedActionLabel(i: FeedItem, a: FeedAction): string {
  if (a === 'allow') return 'Allow';
  if (a === 'deny') return 'Deny';
  return i.need ? needActionLabel(i.need, a) : a === 'approve' ? 'Approve' : a === 'reject' ? 'Reject' : a === 'dismiss' ? 'Dismiss' : a === 'ack' ? 'Acknowledge' : a === 'veto' ? 'Veto' : 'Apply now';
}

/** Where a row opens — each maps to a store action, never a URL built here. */
export type FeedOpen =
  | HomeTarget
  | { to: 'channel'; slug: string; messageId: string | null }
  | { to: 'plugin'; pluginId: string }
  | { to: 'hash'; hash: string }
  | { to: 'queue'; filter: InboxFilter }
  | { to: 'history' };

export function feedOpen(i: FeedItem): FeedOpen {
  const t = i.target;
  switch (t.kind) {
    case 'need': {
      const n = t.need as HomeNeed;
      const home = needTarget(n);
      // A card decided in the Inbox: its full queue (the whole card, with notes).
      if (!home || home.to === 'inbox') return { to: 'queue', filter: n.kind === 'escalation' ? 'escalations' : n.kind === 'held_action' || n.kind === 'queued_action' ? 'keys' : 'approvals' };
      return home;
    }
    case 'task': return { to: 'task', taskId: t.taskId };
    case 'chat': return { to: 'chat', sessionId: t.sessionId };
    case 'channel': return { to: 'channel', slug: t.slug, messageId: t.messageId };
    case 'meeting': return { to: 'pane', pane: 'meetings', focus: { kind: 'meeting', id: t.meetingId } };
    case 'agent': return { to: 'agent', agentId: t.agentId };
    case 'project': return { to: 'pane', pane: 'roadmap', focus: { kind: 'project', id: t.projectId } };
    case 'pane': return { to: 'pane', pane: t.pane as never, ...(t.focus ? { focus: t.focus as never } : {}) };
    case 'plugin': return { to: 'plugin', pluginId: t.pluginId };
    case 'follow': return t.link ? { to: 'hash', hash: t.link } : { to: 'inbox' };
    case 'link': return { to: 'hash', hash: t.hash };
    default: return i.type === 'decided_without_you' ? { to: 'history' } : { to: 'inbox' };
  }
}

/** The page after some rows were read here (before the server answers): the same counts the server would give. */
export function markLocal(page: FeedPage, ids: string[] | 'all' | FeedSection): FeedPage {
  const hit = (i: FeedItem) => ids === 'all' || (typeof ids === 'string' ? i.section === ids : i.ids.some((x) => ids.includes(x)) || ids.includes(i.id));
  return recount({ ...page, items: page.items.map((i) => (hit(i) ? { ...i, read: true } : i)) });
}

/** Drop rows (a decided card) and recount. */
export function dropLocal(page: FeedPage, ids: string[]): FeedPage {
  const items = page.items.filter((i) => !ids.includes(i.id));
  const gone = page.items.filter((i) => ids.includes(i.id) && i.section === 'needs').length;
  return recount({ ...page, items, counts: { ...page.counts, needsYou: Math.max(0, page.counts.needsYou - gone) } });
}

/** Unread counts from the rows a page carries (it carries them all unless the caller asked for fewer). */
export function recount(page: FeedPage): FeedPage {
  const sections: FeedPage['counts']['sections'] = { needs: { total: 0, unread: 0 }, mentions: { total: 0, unread: 0 }, updates: { total: 0, unread: 0 } };
  for (const i of page.items) { sections[i.section].total++; if (!i.read) sections[i.section].unread++; }
  const unread = sections.needs.unread + sections.mentions.unread + sections.updates.unread;
  return { ...page, unread, counts: { ...page.counts, sections, unread } };
}

/** "99+" past 99. */
export const countLabel = (n: number): string => (n > 99 ? '99+' : String(n));

/** What the two numbers mean, for titles and screen readers. */
export const needsYouLabel = (n: number): string => `${n} need${n === 1 ? 's' : ''} you`;
export const unreadLabel = (n: number): string => `${n} unread`;

/** The bell's day groups: Needs you first (the server's rank), then today and earlier, newest first. */
export function bellGroups(items: FeedItem[], now: Date): Array<{ id: 'needs' | 'today' | 'earlier'; label: string; items: FeedItem[] }> {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const cut = midnight.toISOString();
  const rest = items.filter((i) => i.section !== 'needs');
  return [
    { id: 'needs' as const, label: 'Needs you', items: items.filter((i) => i.section === 'needs') },
    { id: 'today' as const, label: 'Today', items: rest.filter((i) => i.at >= cut) },
    { id: 'earlier' as const, label: 'Earlier', items: rest.filter((i) => i.at < cut) },
  ].filter((g) => g.items.length > 0);
}
