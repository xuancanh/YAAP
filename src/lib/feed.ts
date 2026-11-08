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

// ---- the Inbox's list and reading pane ----

/** Urgent: critical, or its default applies within 6 hours (the server's `expiresSoon`). */
export const isUrgent = (i: Pick<FeedItem, 'severity' | 'expiresSoon'>): boolean => i.severity === 'critical' || i.expiresSoon;

export interface InboxGroup { id: string; label: string; items: FeedItem[] }

/** The Inbox list's groups. Needs you: what is urgent first (soonest
 *  deadline first), then the rest in the server's rank. Mentions and
 *  Updates: Today, Yesterday, Earlier, newest first. One group carries no
 *  heading of its own (`label` ''): a heading over everything says nothing. */
export function inboxGroups(items: FeedItem[], section: FeedSection, now: Date): InboxGroup[] {
  let groups: InboxGroup[];
  if (section === 'needs') {
    const urgent = items.filter(isUrgent).sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'));
    groups = [{ id: 'urgent', label: 'Urgent', items: urgent }, { id: 'waiting', label: 'Waiting on you', items: items.filter((i) => !isUrgent(i)) }];
  } else {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const t = today.toISOString(); const y = yesterday.toISOString();
    groups = [
      { id: 'today', label: 'Today', items: items.filter((i) => i.at >= t) },
      { id: 'yesterday', label: 'Yesterday', items: items.filter((i) => i.at < t && i.at >= y) },
      { id: 'earlier', label: 'Earlier', items: items.filter((i) => i.at < y) },
    ];
  }
  const shown = groups.filter((g) => g.items.length > 0);
  return shown.length === 1 && shown[0].id !== 'urgent' ? [{ ...shown[0], label: '' }] : shown;
}

/** Needs you's chips worth showing: All, and each kind that has items (or is the one picked). */
export function visibleChips(page: FeedPage | null, chip: InboxFilter): Array<(typeof NEEDS_CHIPS)[number] & { n: number }> {
  return NEEDS_CHIPS
    .map((c) => ({ ...c, n: c.types.length ? itemsOf(page, 'needs', c.id).length : page?.counts.needsYou ?? 0 }))
    .filter((c) => c.id === 'needs' || c.n > 0 || c.id === chip);
}

/** What is being asked of you, in plain words ('' for news). */
export function askOf(i: FeedItem): string {
  const who = i.actor && i.actor.kind !== 'system' ? i.actor.name : '';
  switch (i.type) {
    case 'decision':
      if (i.need?.subkind === 'hire') return `${who || 'Someone'} needs your yes before the hire goes ahead.`;
      return `${who ? `${who} needs your decision` : 'This needs your decision'}: approve it or reject it.`;
    case 'escalation': return `${who || 'The team'} can't go on without you. Answer the question to unblock the task, or cancel the task.`;
    case 'key': return 'An outward action is held for your key. Give it to let the action go ahead, or deny it.';
    case 'pending_change': return 'This change applies on its own unless you veto it.';
    case 'incident': return 'Something broke. Look into it in Operations; it stays here until it is resolved.';
    case 'signal': return 'Assurance flagged this for you. Acknowledge it once you have seen it, or act on it.';
    case 'queued_action': return `${who || 'An agent'} queued this to run in the background and waits for your approval.`;
    case 'connection_approval': return `${who || 'An agent'} wants to use your connection for one call. The turn waits a few minutes for you.`;
    case 'task_assigned': return 'This task is yours to do.';
    case 'task_review': return 'Review the work, then accept it or ask for changes.';
    case 'blocked_on_you': return 'The task cannot move until you answer.';
    case 'follow_attention': return 'Something you follow needs you.';
    case 'plugin_review': return 'The update asks for more access than the version you run. Review it in Foundry.';
    default: return '';
  }
}

/** "Thu 14:00" (today: "14:00"; another week: "Nov 12, 14:00"). */
export function whenLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = Math.abs(d.getTime() - now.getTime()) / 86_400_000;
  if (d.toDateString() === now.toDateString()) return time;
  return days < 6 ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}` : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** "in 40 min", "in 3 h", "in 2 days", "2 h ago". */
export function relLabel(iso: string, now: Date): string {
  const min = Math.round((Date.parse(iso) - now.getTime()) / 60_000);
  const abs = Math.abs(min);
  const span = abs < 60 ? `${abs} min`
    : abs < 180 && abs % 60 >= 5 ? `${Math.floor(abs / 60)} h ${abs % 60} min`
      : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} days`;
  return min >= 0 ? `in ${span}` : `${span} ago`;
}

/** The quiet deadline badge on a row: "3 h left", "40 min left", "Overdue" ('' without one or far off). */
export function deadlineBadge(i: Pick<FeedItem, 'deadline' | 'expiresSoon'>, now: Date): string {
  if (!i.deadline) return '';
  const min = Math.round((Date.parse(i.deadline) - now.getTime()) / 60_000);
  if (min <= 0) return 'Overdue';
  if (!i.expiresSoon && min > 24 * 60) return '';
  return min < 60 ? `${min} min left` : `${Math.round(min / 60)} h left`;
}

/** The deadline and what happens if you do nothing, in one sentence ('' without a deadline). */
export function defaultLine(i: FeedItem, now: Date): string {
  if (!i.deadline) return i.type === 'pending_change' ? 'It applies on its own unless you veto it.' : '';
  const by = `${whenLabel(i.deadline, now)} (${relLabel(i.deadline, now)})`;
  const past = Date.parse(i.deadline) <= now.getTime();
  if (i.type === 'connection_approval') return past ? 'It timed out and was denied.' : `If you don't answer by ${by}, it is denied.`;
  const d = i.need?.defaultAction;
  const outcome = d === 'approve' ? 'approved' : d === 'deny' ? 'denied' : d === 'apply' ? 'applied' : '';
  if (past) return outcome ? `Its deadline passed; it is ${outcome} by default.` : 'Its deadline has passed.';
  return outcome ? `If you do nothing by ${by}, it is ${outcome}.` : `Decide by ${by}.`;
}

const usd = (n: number) => `$${n >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;

/** The card's facts worth a line in the reading pane, labelled. */
export function feedFacts(i: FeedItem): Array<{ label: string; value: string }> {
  const f = i.need?.facts;
  if (!f) return [];
  const s = (k: string) => (typeof f[k] === 'string' ? f[k] as string : typeof f[k] === 'number' ? String(f[k]) : '');
  const n = (k: string) => (typeof f[k] === 'number' ? f[k] as number : 0);
  const l = (k: string) => (Array.isArray(f[k]) ? (f[k] as string[]) : []);
  const out: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: string) => { if (value) out.push({ label, value }); };
  switch (i.need?.subkind) {
    case 'hire':
      add('Role', s('title'));
      add('Name', s('name') !== s('title') ? s('name') : '');
      add('Reports to', s('reportsTo'));
      add('Budget', n('monthlyBudgetUsd') ? `${usd(n('monthlyBudgetUsd'))} a month` : '');
      add('Pack', s('packName'));
      add('Model', [s('provider'), s('model')].filter(Boolean).join(' · ') || s('modelTier'));
      add('Access', l('scopes').join(', '));
      add('Skills', l('skills').join(', '));
      break;
    case 'budget_raise':
      add('Budget', s('scope') || 'company');
      add('New cap', n('monthlyUsd') ? `${usd(n('monthlyUsd'))} a month` : '');
      add('It buys', s('buys'));
      add('Affects', l('affectedObjectives').join(', '));
      break;
    case 'scope_widen':
      add('Member', s('agentName'));
      add('Adds', l('widened').join(', '));
      break;
    case 'project_now': case 'project_appetite': case 'project_kill': case 'project_allocation':
      add('Project', [s('projectKey'), s('title')].filter(Boolean).join(' '));
      add('Member', s('agentName'));
      add('Appetite', [n('appetiteDays') ? `${n('appetiteDays')} days` : '', n('appetiteUsd') ? usd(n('appetiteUsd')) : ''].filter(Boolean).join(' / '));
      add('Asked', [n('extendDays') ? `${n('extendDays')} more days` : '', n('extendUsd') ? `${usd(n('extendUsd'))} more` : ''].filter(Boolean).join(' and '));
      break;
    case 'tune':
      add('Setting', s('key'));
      add('Change', `${s('from') ? `${s('from')} → ` : ''}${s('value')}`);
      break;
    case 'alignment':
      add('Item', [s('label'), s('title')].filter(Boolean).join(': '));
      add('Class', s('classLabel'));
      add('Why', s('why'));
      add('Options', l('options').join(' · '));
      add('Trade-offs', s('tradeoffs'));
      add('Measures', s('measures'));
      add('Cost', s('cost'));
      add('Unlocks', s('unlocks'));
      add('With it', l('bundleTitles').join(', '));
      add('Owner\'s reasoning', s('classifiedReasoning'));
      add('Latest reply', s('lastReply'));
      break;
    case 'two_key':
      add('Tool', s('tool'));
      add('Class', s('class').replace(/_/g, ' '));
      break;
  }
  return out;
}

/** The longer text worth reading in the pane: a hire's charter ('' when none). */
export function feedLongText(i: FeedItem): { label: string; text: string } | null {
  const f = i.need?.facts;
  const charter = typeof f?.charter === 'string' ? f.charter : '';
  if (i.need?.subkind === 'hire' && charter) return { label: 'What they would do', text: charter };
  if (i.need?.subkind === 'alignment' && typeof f?.what === 'string' && f.what) return { label: 'What to align on', text: f.what };
  return null;
}

/** The button that opens a row where it lives ("Open task", "Open #launch"…). */
export function openLabel(i: FeedItem): string {
  const t = feedOpen(i);
  switch (t.to) {
    case 'task': return i.context.taskKey ? `Open ${i.context.taskKey}` : 'Open task';
    case 'chat': return i.type === 'message' ? 'Reply in chat' : 'Open chat';
    case 'channel': return `Open #${t.slug}`;
    case 'agent': return i.actor?.kind === 'agent' && i.actor.id === t.agentId ? `Open ${i.actor.name}` : 'Open agent';
    case 'pane': return t.pane === 'meetings' ? 'Open meeting' : t.pane === 'roadmap' ? 'Open project' : 'Open page';
    case 'plugin': return 'Open in Foundry';
    case 'queue': return 'Open the full card';
    case 'history': return 'Open in Done';
    case 'file': return 'Open file';
    case 'hash': return 'Open';
    default: return '';
  }
}

/** The keyboard's a / r on an open item: its yes and its no ('' when it has none). */
export function yesNo(i: FeedItem): { yes: FeedAction | ''; no: FeedAction | '' } {
  const has = (a: FeedAction) => i.actions.includes(a);
  return {
    yes: has('approve') ? 'approve' : has('allow') ? 'allow' : '',
    no: has('reject') ? 'reject' : has('deny') ? 'deny' : '',
  };
}

/** The Inbox tab a row lives on (for a link from the bell). */
export const tabOf = (i: Pick<FeedItem, 'section'>): InboxFilter => (i.section === 'needs' ? 'needs' : i.section);
