/**
 * The feed's registry (docs/owners-seat.md "Inbox and notifications"): every
 * notification type with its section and label, the per-workspace switches
 * for the informational ones, and the pure rules that turn a source record —
 * an agent inbox event, an org audit row, a plugin audit row — into a feed
 * entry (or into nothing: an agent's own working notes, a routine run, or a
 * record whose card Needs you already lists).
 *
 * Switches are tunables (`notify.<type>`, 0 = off; `notify.groupAfter`), on
 * the shared registry of org-tunables.ts, so they live per workspace with the
 * company's other settings and `PUT …/org/tunables` changes them. They sit in
 * the owner's area (`seat`): an agent can only propose changing them.
 * Workspaces without a company read the defaults. Needs you and mentions
 * cannot be turned off.
 */
import { registerTunables, tunable, type TunableDef } from '../org/org-tunables';
import type { HomeNeed } from './home.types';
import type { FeedActor, FeedContext, FeedSection, FeedTarget, FeedType } from './feed.types';

export interface FeedTypeDef {
  section: FeedSection;
  label: string;
  description: string;
  /** Updates only: on unless the workspace turns it off. */
  defaultOn?: boolean;
}

export const FEED_TYPES: Record<FeedType, FeedTypeDef> = {
  decision: { section: 'needs', label: 'Decision', description: 'A decision card waiting on you.' },
  escalation: { section: 'needs', label: 'Escalation', description: 'A task escalated to you.' },
  key: { section: 'needs', label: 'Needs your key', description: 'A held or staged outward action.' },
  pending_change: { section: 'needs', label: 'Pending change', description: 'An autonomous plan inside its veto window.' },
  incident: { section: 'needs', label: 'Incident', description: 'An open incident.' },
  signal: { section: 'needs', label: 'Signal', description: 'An assurance signal addressed to you.' },
  queued_action: { section: 'needs', label: 'Queued action', description: 'A background action an agent queued for approval.' },
  connection_approval: { section: 'needs', label: 'Approval', description: 'A turn asks to use your connection.' },
  task_assigned: { section: 'needs', label: 'Your task', description: 'A company task assigned to you.' },
  task_review: { section: 'needs', label: 'Review', description: 'A task waiting for your review.' },
  blocked_on_you: { section: 'needs', label: 'Blocked on you', description: 'A task waiting on you.' },
  follow_attention: { section: 'needs', label: 'Following', description: 'Something you follow needs you.' },
  plugin_review: { section: 'needs', label: 'Plugin review', description: 'A plugin update that widens its access.' },
  message: { section: 'mentions', label: 'Message', description: 'An agent wrote to you directly.' },
  mention: { section: 'mentions', label: 'Mention', description: 'Someone mentioned you.' },
  follow: { section: 'updates', label: 'Following', description: 'News on threads, tasks and discussions you follow.', defaultOn: true },
  channel_activity: { section: 'updates', label: 'Channel', description: 'New messages in channels you set to notify on everything.', defaultOn: true },
  run_failed: { section: 'updates', label: 'Run failed', description: 'A run, loop, task run or check that failed.', defaultOn: true },
  budget: { section: 'updates', label: 'Budget', description: 'An envelope nearing or at its cap, and runs it refused.', defaultOn: true },
  meeting: { section: 'updates', label: 'Meeting', description: 'Meetings about to start, started and ended (with their minutes).', defaultOn: true },
  brief: { section: 'updates', label: 'Brief', description: 'The chief of staff\'s daily brief.', defaultOn: true },
  audit: { section: 'updates', label: 'Audit', description: 'Assurance audits and the auditor\'s spot checks.', defaultOn: true },
  experiment: { section: 'updates', label: 'Experiment', description: 'Experiments started, extended and decided.', defaultOn: true },
  trust: { section: 'updates', label: 'Trust', description: 'An agent\'s trust level went up or down.', defaultOn: true },
  decided_without_you: { section: 'updates', label: 'Decided without you', description: 'Cards decided by the default, a delegate or the chief, and cards that expired.', defaultOn: true },
  hire: { section: 'updates', label: 'Hire', description: 'An agent hired by a head or the chief.', defaultOn: true },
  project_team: { section: 'updates', label: 'Project team', description: 'Project seats proposed (waiting on a head) and filled.', defaultOn: true },
  program: { section: 'updates', label: 'Program', description: 'Goals and projects handed to a Program Manager, its resource requests to the heads and their answers, and disputes that climbed.', defaultOn: true },
  project: { section: 'updates', label: 'Project', description: 'A project that used up its appetite or finished.', defaultOn: true },
  blocked: { section: 'updates', label: 'Blocked', description: 'Blocked tasks handed to someone to chase.', defaultOn: true },
  goal_at_risk: { section: 'updates', label: 'Goal at risk', description: 'A goal that went at risk.', defaultOn: true },
  plugin: { section: 'updates', label: 'Plugin', description: 'Plugins recalled by their publisher or updated.', defaultOn: true },
  company: { section: 'updates', label: 'Company', description: 'The company archived.', defaultOn: true },
  agent_note: { section: 'updates', label: 'Agent note', description: 'What an agent did that you hear about after (trust level 1), lessons to review, a model switched.', defaultOn: true },
};

export const UPDATE_TYPES = (Object.keys(FEED_TYPES) as FeedType[]).filter((t) => FEED_TYPES[t].section === 'updates');
export const notifyKey = (t: FeedType): string => `notify.${t}`;

export const FEED_TUNABLES: Record<string, TunableDef> = {
  'notify.groupAfter': { default: 2, min: 2, max: 50, area: 'seat', description: 'Updates about one thing (a task, a meeting, a channel, an agent\'s failed runs) that collapse into one Inbox row ("3 updates on ENG-12").' },
  ...Object.fromEntries(UPDATE_TYPES.map((t) => [notifyKey(t), {
    default: FEED_TYPES[t].defaultOn === false ? 0 : 1, min: 0, max: 1, area: 'seat' as const,
    description: `Inbox and bell: ${FEED_TYPES[t].description} 1 = on, 0 = off.`,
  }])),
};
registerTunables(FEED_TUNABLES);

/** Whether an update type is on in this workspace (Needs you and mentions always are). */
export function typeOn(org: { tunables?: string | null } | null | undefined, t: FeedType): boolean {
  return FEED_TYPES[t].section !== 'updates' || tunable(org, notifyKey(t)) >= 1;
}

export const NEED_TYPE: Record<HomeNeed['kind'], FeedType> = {
  approval: 'decision', escalation: 'escalation', held_action: 'key', plan: 'pending_change', incident: 'incident', signal: 'signal', queued_action: 'queued_action',
};

// ---- classification ----

/** Names the rules need, resolved by the service in one batch. */
export interface FeedLookup {
  agent(id: string | null | undefined): FeedActor | null;
  /** An agent by display name (old events carry only the name). */
  agentNamed(name: string): FeedActor | null;
  task(id: string | null | undefined): { key: string | null; title: string; projectId: string | null } | null;
  project(id: string | null | undefined): { key: string | null; title: string } | null;
  meeting(id: string | null | undefined): { title: string } | null;
  channel(id: string | null | undefined): { slug: string } | null;
  /** The channel a thread's root message is in. */
  threadChannel(rootId: string | null | undefined): string | null;
  plugin(id: string | null | undefined): { name: string } | null;
  chiefId: string | null;
}

/** A classified source record, before read state and grouping. */
export interface Classified {
  type: FeedType;
  title: string;
  body: string;
  severity: 'critical' | 'high' | 'normal' | 'low';
  actor: FeedActor | null;
  context: FeedContext;
  target: FeedTarget;
  /** Updates that share a key collapse into one row. */
  groupKey: string | null;
  /** A label for the grouped row ("ENG-12", "Weekly sync", "#launch"). */
  groupLabel: string;
  /** The follow it reports (opening it marks the follow seen). */
  follow?: { targetKind: string; targetId: string };
}

const SYSTEM: FeedActor = { kind: 'system', id: null, name: 'System' };
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const words = (s: string) => s.replace(/_/g, ' ');

/** The in-app part of an SPA link (events carry absolute URLs), or '': the
 *  path (`/<company>/channels/…`, docs/routes.md), or an older `#/…` link
 *  as it was (the SPA redirects those). */
export function hashOf(link: unknown): string {
  if (typeof link !== 'string') return '';
  const i = link.indexOf('#/');
  if (i >= 0) return link.slice(i);
  let path = link.trim();
  if (/^https?:\/\//i.test(path)) {
    try { const u = new URL(path); path = `${u.pathname}${u.search}`; } catch { return ''; }
  }
  return path.startsWith('/') && !path.startsWith('//') && path.length > 1 ? path : '';
}

/** The task's context and its label ("ENG-12" or the title). */
function taskBits(look: FeedLookup, taskId: string | null | undefined): { context: FeedContext; label: string } {
  if (!taskId) return { context: {}, label: '' };
  const t = look.task(taskId);
  const p = t?.projectId ? look.project(t.projectId) : null;
  return {
    context: { taskId, taskKey: t?.key ?? null, taskTitle: t?.title ?? '', ...(t?.projectId ? { projectId: t.projectId, projectKey: p?.key ?? null, projectTitle: p?.title ?? '' } : {}) },
    label: t ? t.key || t.title : 'a task',
  };
}

function projectBits(look: FeedLookup, projectId: string | null | undefined, key?: string): { context: FeedContext; label: string } {
  if (!projectId) return { context: {}, label: key || 'a project' };
  const p = look.project(projectId);
  return { context: { projectId, projectKey: p?.key ?? key ?? null, projectTitle: p?.title ?? '' }, label: p?.key || key || p?.title || 'a project' };
}

function meetingBits(look: FeedLookup, meetingId: string | null | undefined): { context: FeedContext; label: string } {
  if (!meetingId) return { context: {}, label: 'a meeting' };
  const m = look.meeting(meetingId);
  return { context: { meetingId, meetingTitle: m?.title ?? '' }, label: m?.title || 'a meeting' };
}

/** The person or agent named in an old event's text ("Ada", "Ada Lovelace"). */
function actorNamed(look: FeedLookup, name: string): FeedActor | null {
  const n = name.trim();
  if (!n || n === 'system') return n === 'system' ? SYSTEM : null;
  return look.agentNamed(n) ?? { kind: 'person', id: null, name: n };
}

/** An actor string from the audit log: user, system, chief, check, agent:<id>. */
function auditActor(look: FeedLookup, actor: string): FeedActor {
  if (actor === 'user') return { kind: 'person', id: null, name: 'You' };
  if (actor.startsWith('agent:')) return look.agent(actor.slice(6)) ?? { kind: 'agent', id: actor.slice(6), name: 'An agent' };
  if (actor === 'chief') return look.agent(look.chiefId) ?? { kind: 'agent', id: look.chiefId, name: 'Chief of staff' };
  if (actor.startsWith('human:')) return { kind: 'person', id: actor.slice(6), name: 'A person' };
  return SYSTEM;
}

export interface EventRow { id: string; agentId: string; kind: string; title: string; body: string; payload: string; sessionId: string | null; createdAt: string; readAt: string | null }

/**
 * One agent inbox event → a feed entry, or null. An explicit `payload.feed`
 * names an update type (how an emitter opts an `info` note in); the rest is
 * by kind. Left out: routine runs (`loop_run`, `org_run`), the agents' own
 * working notes (untagged `info`, the `blocked`/`decision`/`escalation`
 * events addressed to an agent's heartbeat), and the events whose card or
 * task Needs you already lists (`decision`, `escalation`, `action_key`,
 * `action_pending`, `org_plan`, `org_incident`, `org_signal`, `org_task`,
 * `org_review`). `approval_request` is listed by the service (it is a need).
 */
export function classifyEvent(e: EventRow, look: FeedLookup): Classified | null {
  let p: Record<string, unknown> = {};
  try { const v = JSON.parse(e.payload || '{}') as unknown; if (v && typeof v === 'object') p = v as Record<string, unknown>; } catch { /* a plain-text payload */ }
  const agent = look.agent(e.agentId);
  const hash = hashOf(p.link);
  const fallback: FeedTarget = e.sessionId ? { kind: 'chat', sessionId: e.sessionId } : hash ? { kind: 'link', hash } : agent?.id ? { kind: 'agent', agentId: agent.id } : { kind: 'inbox' };
  const base = (type: FeedType, over: Partial<Classified> = {}): Classified => ({
    type, title: e.title, body: e.body, severity: 'normal', actor: agent, context: agent?.id ? { agentId: agent.id } : {}, target: fallback, groupKey: null, groupLabel: '', ...over,
  });
  const tagged = str(p.feed) as FeedType;
  if (tagged && FEED_TYPES[tagged] && FEED_TYPES[tagged].section === 'updates') {
    const t = taskBits(look, str(p.taskId));
    return base(tagged, { severity: 'low', context: { ...(agent?.id ? { agentId: agent.id } : {}), ...t.context }, ...(str(p.taskId) ? { target: { kind: 'task', taskId: str(p.taskId) } } : {}) });
  }
  switch (e.kind) {
    case 'agent_message': {
      const urgency = str(p.urgency);
      return base('message', {
        title: e.title.replace(/^Urgent: /, ''), severity: urgency === 'urgent' ? 'high' : urgency === 'fyi' ? 'low' : 'normal',
        target: e.sessionId ? { kind: 'chat', sessionId: e.sessionId } : fallback,
      });
    }
    case 'mention': {
      const taskId = str(p.taskId);
      const channelId = str(p.channelId);
      const authorId = str(p.authorId);
      const nameInTitle = (e.title.split(' · ')[1] ?? '').replace(/ mentioned you.*$/, '');
      const actor = authorId && str(p.authorKind) === 'agent' ? look.agent(authorId) ?? actorNamed(look, nameInTitle) : actorNamed(look, nameInTitle);
      if (taskId) {
        const t = taskBits(look, taskId);
        return base('mention', { title: `${actor?.name ?? 'Someone'} mentioned you on ${t.label}`, actor, context: t.context, target: { kind: 'task', taskId } });
      }
      const ch = look.channel(channelId);
      const slug = ch?.slug ?? str(p.from).replace(/^#/, '');
      const target: FeedTarget = channelId && slug ? { kind: 'channel', channelId, slug, messageId: str(p.messageId) || null } : fallback;
      const context: FeedContext = channelId ? { channelId, channelSlug: slug } : {};
      if (p.mention === true) return base('mention', { title: `${actor?.name ?? 'Someone'} mentioned you in #${slug}`, actor, context, target });
      return base('channel_activity', { title: `${actor?.name ?? 'Someone'} posted in #${slug}`, actor, context, target, severity: 'low', groupKey: channelId ? `channel:${channelId}` : null, groupLabel: `#${slug}` });
    }
    case 'follow': {
      const targetKind = str(p.targetKind);
      const targetId = str(p.targetId);
      const label = e.title.replace(/^Following · /, '');
      const who = e.body.match(/^([^:]{1,80}): /)?.[1] ?? '';
      const actor = actorNamed(look, who);
      let target: FeedTarget = targetKind && targetId ? { kind: 'follow', targetKind, targetId, link: hash } : fallback;
      let context: FeedContext = {};
      if (targetKind === 'org_task' && targetId) { target = { kind: 'task', taskId: targetId }; context = taskBits(look, targetId).context; }
      if (targetKind === 'channel' && targetId) {
        const ch = look.channel(targetId);
        if (ch) { target = { kind: 'channel', channelId: targetId, slug: ch.slug, messageId: null }; context = { channelId: targetId, channelSlug: ch.slug }; }
      }
      if (targetKind === 'thread' && targetId) {
        const chId = look.threadChannel(targetId);
        const ch = chId ? look.channel(chId) : null;
        if (chId && ch) { target = { kind: 'channel', channelId: chId, slug: ch.slug, messageId: targetId }; context = { channelId: chId, channelSlug: ch.slug }; }
      }
      const groupLabel = context.taskKey || label;
      return base('follow', {
        title: `${who ? `${who} updated` : 'News on'} ${groupLabel}`, body: e.body.replace(/^[^:]{1,80}: /, ''), severity: 'low', actor, context, target,
        ...(targetKind && targetId ? { follow: { targetKind, targetId } } : {}),
        groupKey: targetKind && targetId ? `${targetKind === 'org_task' ? 'task' : targetKind}:${targetId}` : null, groupLabel,
      });
    }
    case 'loop_error': case 'action_failed':
      return base('run_failed', { severity: 'high', groupKey: agent?.id ? `agent:${agent.id}:run_failed` : null, groupLabel: agent ? `${agent.name}'s runs` : 'runs' });
    case 'budget_stop': case 'budget_warn':
      return base('budget', { severity: e.kind === 'budget_stop' ? 'high' : 'normal', actor: SYSTEM, target: str(p.taskId) ? { kind: 'task', taskId: str(p.taskId) } : { kind: 'pane', pane: 'spend', focus: null }, ...(str(p.taskId) ? { context: taskBits(look, str(p.taskId)).context } : {}) });
    case 'meeting': {
      const m = meetingBits(look, str(p.meetingId));
      const minutes = Boolean(str(p.minutesPath) || str(p.hash));
      const tally = e.title.match(/\(([^()]*)\)$/)?.[1] ?? '';
      return base('meeting', {
        title: minutes ? `${m.label === 'a meeting' ? e.title.replace(/^Minutes: /, '').replace(/ \([^()]*\)$/, '') : m.label} ended${tally ? `: ${tally}` : ''}` : e.title.replace(/ · Join$/, ''),
        severity: str(p.action) === 'join' ? 'normal' : 'low', actor: minutes ? agent : SYSTEM, context: m.context,
        target: str(p.meetingId) ? { kind: 'meeting', meetingId: str(p.meetingId) } : fallback,
        groupKey: str(p.meetingId) ? `meeting:${str(p.meetingId)}` : null, groupLabel: m.label,
      });
    }
    case 'brief':
      return base('brief', { title: e.title.replace(/^Daily brief( \(board copy\))? — /, 'Daily brief: '), severity: 'low', target: { kind: 'pane', pane: 'brief', focus: null } });
    case 'org_audit': case 'org_spotcheck':
      return base('audit', { severity: p.breach === true ? 'high' : 'low', target: { kind: 'pane', pane: 'audit', focus: null } });
    case 'org_experiment':
      return base('experiment', { severity: 'low' });
    case 'trust_change':
      return base('trust', { severity: 'low', target: agent?.id ? { kind: 'agent', agentId: agent.id } : fallback });
    default:
      return null;
  }
}

export interface AuditRow { id: string; actor: string; action: string; refType: string; refId: string; payload: string; createdAt: string }

/** The audit actions the feed reads (company-wide updates the owner hears). */
export const FEED_AUDIT_ACTIONS = [
  'meeting_start', 'meeting_end', 'member_add', 'project_member_propose', 'project_member_add', 'project_breaker', 'project_done',
  'org_archive', 'approval_default', 'delegated_decision', 'approval_expired', 'run_end', 'checks_failed', 'blocked_owner_assigned', 'goal_at_risk',
  'program_assign', 'resource_request', 'resource_decide', 'resource_escalate',
] as const;

/** One org audit row → a feed entry, or null (what you did yourself is not news). */
export function classifyAudit(r: AuditRow, look: FeedLookup): Classified | null {
  let p: Record<string, unknown> = {};
  try { const v = JSON.parse(r.payload || '{}') as unknown; if (v && typeof v === 'object') p = v as Record<string, unknown>; } catch { /* keep {} */ }
  const actor = auditActor(look, r.actor);
  const mk = (type: FeedType, title: string, over: Partial<Classified> = {}): Classified => ({
    type, title, body: '', severity: 'low', actor, context: {}, target: { kind: 'inbox' }, groupKey: null, groupLabel: '', ...over,
  });
  switch (r.action) {
    case 'meeting_start': case 'meeting_end': {
      const m = meetingBits(look, r.refId);
      const ended = r.action === 'meeting_end';
      const bits = ended ? [num(p.decisions) ? plural(num(p.decisions), 'decision') : '', num(p.actions) ? plural(num(p.actions), 'action') : ''].filter(Boolean).join(', ') : '';
      return mk('meeting', ended ? `${m.label} ended${bits ? `: ${bits}` : ''}` : `${m.label} started`, {
        actor: SYSTEM, context: m.context, target: { kind: 'meeting', meetingId: r.refId }, groupKey: `meeting:${r.refId}`, groupLabel: m.label,
        body: ended ? '' : num(p.attendees) ? `${plural(num(p.attendees), 'attendee')}${num(p.openItems) ? `, ${plural(num(p.openItems), 'open item')} from last time` : ''}.` : '',
      });
    }
    case 'member_add': {
      if (r.actor === 'user') return null;
      const hired = look.agent(r.refId);
      return mk('hire', `${actor.name} hired ${hired?.name ?? 'an agent'}${str(p.title) ? ` as ${str(p.title)}` : ''}`, { context: { agentId: r.refId }, target: { kind: 'agent', agentId: r.refId } });
    }
    case 'project_member_propose': case 'project_member_add': {
      if (r.actor === 'user') return null;
      const pr = projectBits(look, r.refId, str(p.key));
      const who = look.agent(str(p.agentId))?.name ?? 'an agent';
      const role = str(p.role) ? ` as ${str(p.role)}` : '';
      const title = r.action === 'project_member_propose' ? `${actor.name} proposed ${who} for ${pr.label}${role} — waiting on their head` : `${who} joined ${pr.label}${role}`;
      return mk('project_team', title, { context: pr.context, target: { kind: 'project', projectId: r.refId }, groupKey: `project:${r.refId}`, groupLabel: pr.label, severity: r.action === 'project_member_propose' ? 'normal' : 'low' });
    }
    case 'program_assign': {
      if (r.actor === 'user') return null;
      const who = look.agent(str(p.agentId))?.name ?? 'an agent';
      const what = r.refType === 'project' ? projectBits(look, r.refId, str(p.key)) : { context: {}, label: `the ${words(str(p.kind) || 'goal')} "${str(p.title)}"` };
      return mk('program', `${who} now owns ${what.label}${str(p.role) ? ` as ${str(p.role)}` : ''}`, {
        actor: r.actor === 'system' ? SYSTEM : actor, context: what.context,
        target: r.refType === 'project' ? { kind: 'project', projectId: r.refId } : { kind: 'pane', pane: 'goals', focus: { kind: 'goal', id: r.refId } },
        groupKey: `program:${r.refId}`, groupLabel: what.label,
      });
    }
    case 'resource_request': case 'resource_decide': case 'resource_escalate': {
      if (r.actor === 'user') return null;
      const pr = projectBits(look, r.refId, str(p.key));
      const head = look.agent(str(p.headAgentId))?.name ?? 'a head';
      const who = look.agent(str(p.agentId))?.name;
      const role = str(p.role) || 'a member';
      const decision = str(p.decision);
      const title = r.action === 'resource_request'
        ? `${actor.name} asked ${head} for ${role} at ${num(p.allocation)}% on ${pr.label}`
        : r.action === 'resource_escalate'
          ? `${pr.label}'s request for ${role} went up the chain${p.auto ? ' (unanswered)' : ''}`
          : decision === 'declined' ? `${actor.name} declined ${pr.label}'s request for ${role}${p.upheld ? ' (upheld)' : ''}`
            : decision === 'hiring' ? `${actor.name} will hire to fill ${pr.label}'s request for ${role}`
              : decision === 'granted' ? `${pr.label}'s request for ${role} was granted on escalation`
                : `${who ?? 'A member'} lent to ${pr.label} as ${role} at ${num(p.allocation)}%${decision === 'adjusted' ? ` (asked ${num(p.asked)}%)` : ''}`;
      return mk('program', title, {
        body: str(p.note).slice(0, 300) || str(p.headAnswer).slice(0, 300), actor: r.actor === 'system' ? SYSTEM : actor,
        severity: r.action === 'resource_escalate' || decision === 'declined' ? 'normal' : 'low',
        context: pr.context, target: { kind: 'project', projectId: r.refId }, groupKey: `project:${r.refId}`, groupLabel: pr.label,
      });
    }
    case 'project_breaker': case 'project_done': {
      const pr = projectBits(look, r.refId, str(p.key));
      return mk('project', r.action === 'project_breaker' ? `${pr.label} used up its appetite — its tasks stopped taking claims` : `${pr.label} is done`, {
        actor: r.action === 'project_breaker' ? SYSTEM : actor, severity: r.action === 'project_breaker' ? 'high' : 'low',
        body: r.action === 'project_breaker' ? `$${num(p.spentUsd).toFixed(2)} of $${num(p.appetiteUsd).toFixed(2)}; ${num(p.daysUsed)} of ${num(p.appetiteDays)} day(s). Extend it or cut scope.` : '',
        context: pr.context, target: { kind: 'project', projectId: r.refId }, groupKey: `project:${r.refId}`, groupLabel: pr.label,
      });
    }
    case 'org_archive':
      return r.actor === 'user' ? null : mk('company', 'The company was archived', { body: `${num(p.channelsArchived)} channel(s) closed. Restore it in Settings › Company.`, severity: 'high', target: { kind: 'inbox' } });
    case 'approval_default':
      return mk('decided_without_you', `${str(p.decision) === 'approve' ? 'Approved' : 'Denied'} by default at your deadline: a ${words(str(p.kind) || 'decision')}`, { actor: SYSTEM, severity: 'normal', target: { kind: 'inbox' } });
    case 'delegated_decision':
      return mk('decided_without_you', `Your delegate ${words(str(p.decision) || 'decided')} a ${words(str(p.kind) || 'decision')}`, { body: str(p.delegate) ? `Delegate: ${str(p.delegate)}` : '', target: { kind: 'inbox' } });
    case 'approval_expired':
      return mk('decided_without_you', `A ${words(str(p.kind) || 'decision')} expired unanswered`, { actor: SYSTEM, severity: 'normal', target: { kind: 'inbox' } });
    case 'run_end': case 'checks_failed': {
      const status = str(p.status);
      if (r.action === 'run_end' && status !== 'failed' && status !== 'loop') return null;
      const taskId = r.action === 'run_end' ? str(p.taskId) : r.refId;
      const t = taskBits(look, taskId);
      const title = r.action === 'checks_failed' ? `Checks failed on ${t.label}` : status === 'loop' ? `${actor.name} stopped on ${t.label}: the same tool call repeated` : `${actor.name}'s run on ${t.label} failed`;
      return mk('run_failed', title, {
        body: r.action === 'checks_failed' ? str(p.detail).slice(0, 300) : '', severity: 'high', actor: r.action === 'checks_failed' ? SYSTEM : actor,
        context: t.context, target: taskId ? { kind: 'task', taskId } : { kind: 'inbox' }, groupKey: taskId ? `task:${taskId}` : null, groupLabel: t.label,
      });
    }
    case 'blocked_owner_assigned': {
      const t = taskBits(look, r.refId);
      const lead = look.agent(str(p.agentId));
      return mk('blocked', `${t.label} is blocked — ${lead?.name ?? 'its lead'} was asked to unblock it`, { actor: lead ?? SYSTEM, context: t.context, target: { kind: 'task', taskId: r.refId }, groupKey: `task:${r.refId}`, groupLabel: t.label });
    }
    case 'goal_at_risk': {
      const reasons = Array.isArray(p.reasons) ? p.reasons.map(String) : [];
      return mk('goal_at_risk', `A ${str(p.kind) === 'objective' ? 'goal' : 'key result'} went at risk`, { body: reasons.join('; ').slice(0, 300), actor: SYSTEM, severity: 'normal', target: { kind: 'pane', pane: 'goals', focus: { kind: 'goal', id: r.refId } } });
    }
    default:
      return null;
  }
}

export const FEED_PLUGIN_ACTIONS = ['plugin_version_recalled', 'plugin_updated'] as const;

/** One plugin audit row (Foundry) → a feed entry, or null. */
export function classifyPluginAudit(r: AuditRow, look: FeedLookup): Classified | null {
  let p: Record<string, unknown> = {};
  try { const v = JSON.parse(r.payload || '{}') as unknown; if (v && typeof v === 'object') p = v as Record<string, unknown>; } catch { /* keep {} */ }
  const name = look.plugin(r.refId)?.name ?? r.refId;
  const base = { body: '', actor: SYSTEM, context: {}, target: { kind: 'plugin', pluginId: r.refId } as FeedTarget, groupKey: `plugin:${r.refId}`, groupLabel: name };
  if (r.action === 'plugin_version_recalled') return { ...base, type: 'plugin', title: `${name} ${str(p.version)} was recalled by its publisher`.replace(/\s+/g, ' '), body: str(p.reason).slice(0, 300), severity: 'high' };
  if (r.action === 'plugin_updated') {
    if (r.actor === 'user') return null;
    return { ...base, type: 'plugin', title: `${name} updated to ${str(p.to)}`, severity: 'low' };
  }
  return null;
}
