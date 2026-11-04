/**
 * FeedService — the owner's feed (docs/owners-seat.md "Inbox and
 * notifications"): the one list the Inbox and the top bar's bell read, so
 * what they show and what they count agree by construction.
 *
 * Three sections:
 *  - **Needs you** (actionable; it stays until resolved): Home's Needs-you
 *    cards (decisions, escalations, keys, pending changes, incidents,
 *    signals, queued actions — HomeService.glance, one ranking), a turn
 *    waiting for your connection (`approval_request`, minutes not days), the
 *    tasks assigned to you, waiting for your review or blocked on you, what
 *    you follow that needs you, and plugin updates waiting for your review.
 *  - **Mentions**: what agents sent you (message_owner) and @mentions of you
 *    in channels, threads and tasks.
 *  - **Updates** (informational): followed news, failed runs, budgets,
 *    meetings, briefs, audits, experiments, trust, what was decided without
 *    you, hires, project seats, breakers, chased blockers, goals at risk,
 *    plugin recalls and updates, the company archived, agents' notes to you —
 *    read from the agent inbox events, the org audit log and the plugin audit
 *    log by the rules in feed-registry.ts. Each type can be turned off per
 *    workspace (`notify.<type>` tunables); updates about one thing collapse
 *    into one row (`notify.groupAfter`).
 *
 * Who gets what: the owner gets the company-wide updates and the account's
 * own events; a member of a shared workspace gets what is addressed to them
 * (their mentions, their tasks, what they follow — the follow service's
 * auto-follow decides that), never the owner's.
 *
 * Read state: an event keeps its own (`agent_events.readAt`, the same mark
 * the agent inbox, Messages and Telegram read); everything else is read
 * through the per-person `home.notifications:<ws>:<actor>` app_settings row
 * (ids seen and the last "mark all read"). Reading quiets the count; a need
 * stays listed until the record that owns it is resolved.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentEvents, agents as agentsTable, appSettings, channelMessages, channels, follows, orgAudit, orgMeetings, orgProjects, orgTasks, organizations, pluginAudit, pluginInstalls, plugins } from '../database/schema';
import { actorId, currentViewer } from '../accounts/account-context';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { APPROVAL_TTL_MS as TURN_APPROVAL_TTL_MS } from '../chats/turn-loop.service';
import { parseBlockedOn } from '../org/blocked-on';
import { taskLabel } from '../common/task-keys';
import { tunable } from '../org/org-tunables';
import { HomeService } from './home.service';
import type { HomeNeed } from './home.types';
import {
  FEED_AUDIT_ACTIONS, FEED_PLUGIN_ACTIONS, FEED_TYPES, NEED_TYPE, UPDATE_TYPES, classifyAudit, classifyEvent, classifyPluginAudit, hashOf, notifyKey, typeOn,
  type Classified, type FeedLookup,
} from './feed-registry';
import type { FeedActor, FeedContext, FeedItem, FeedPage, FeedSection, FeedTarget, FeedTypeInfo } from './feed.types';

const DAY_MS = 24 * 3_600_000;
/** A card whose default applies within this is "expiring soon" (and urgent). */
export const EXPIRING_MS = 6 * 3_600_000;
/** How far back the feed reads events and audit rows. */
export const FEED_DAYS = 14;
/** Items a page carries by default (the counts cover everything). */
export const FEED_LIMIT = 200;
/** Ids the read row remembers (the newest). */
const READ_IDS_CAP = 1_000;
const OPEN_TASK = new Set(['backlog', 'waiting', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked']);
const SEVERITY_RANK: Record<FeedItem['severity'], number> = { critical: 0, high: 1, normal: 2, low: 3 };

const safe = <T,>(raw: string | null | undefined, fallback: T): T => { try { return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };

/** Whether a deadline falls within 6 hours (and has not passed). */
export function expiresSoon(deadline: string | null, now: Date): boolean {
  if (!deadline) return false;
  const left = Date.parse(deadline) - now.getTime();
  return left > 0 && left < EXPIRING_MS;
}

/** Urgent: critical, or its default applies within 6 hours. */
export function isUrgent(n: { severity: string; deadline: string | null }, now: Date): boolean {
  return n.severity === 'critical' || expiresSoon(n.deadline, now);
}

interface ReadRow { ids: string[]; allAt: string | null }

/** What `glance` already knows, so the top bar does not ask twice. */
export interface FeedGlance { needs: HomeNeed[]; company: { name: string } | null }

@Injectable()
export class FeedService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly home: HomeService,
    private readonly workspaces: WorkspacesService,
  ) {}

  // ---- read marks ----

  private readKey(workspaceId: string): string { return `home.notifications:${workspaceId}:${actorId()}`; }

  private async readRow(workspaceId: string): Promise<ReadRow> {
    const row = (await this.db.select().from(appSettings).where(eq(appSettings.key, this.readKey(workspaceId))).limit(1)).at(0);
    const v = safe<Partial<ReadRow>>(row?.value, {});
    return { ids: Array.isArray(v.ids) ? v.ids.filter((x) => typeof x === 'string') : [], allAt: typeof v.allAt === 'string' ? v.allAt : null };
  }

  private async writeRow(workspaceId: string, r: ReadRow): Promise<void> {
    const key = this.readKey(workspaceId);
    const value = JSON.stringify({ ids: r.ids.slice(-READ_IDS_CAP), allAt: r.allAt });
    const has = (await this.db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, key)).limit(1)).length > 0;
    if (has) await this.db.update(appSettings).set({ value }).where(eq(appSettings.key, key));
    else await this.db.insert(appSettings).values({ key, value });
  }

  private async orgOf(workspaceId: string) {
    return (await this.db.select().from(organizations).where(eq(organizations.workspaceId, workspaceId)).limit(1)).at(0) ?? null;
  }

  // ---- the feed ----

  async feed(workspaceId: string, opts: { now?: Date; glance?: FeedGlance; limit?: number } = {}): Promise<FeedPage> {
    const now = opts.now ?? new Date();
    const g: FeedGlance = opts.glance ?? await this.home.glance(workspaceId, { now, parts: [] });
    const company = g.company?.name ?? '';
    const viewer = currentViewer();
    const owner = !viewer || viewer.role === 'owner';
    const me = actorId();
    const org = g.company ? await this.orgOf(workspaceId) : null;
    const since = new Date(now.getTime() - FEED_DAYS * DAY_MS).toISOString();
    const read = await this.readRow(workspaceId);
    const seen = new Set(read.ids);
    const readMark = (id: string, at: string) => seen.has(id) || Boolean(read.allAt && at <= read.allAt);

    // ---- the sources ----
    const team = await this.db.select({ id: agentsTable.id, name: agentsTable.name, emoji: agentsTable.emoji, colors: agentsTable.colors }).from(agentsTable).where(eq(agentsTable.workspaceId, workspaceId));
    const chans = await this.db.select({ id: channels.id, slug: channels.slug }).from(channels).where(eq(channels.workspaceId, workspaceId));
    const addressees = [...team.map((a) => a.id), ...chans.map((c) => `channel:${c.id}`), `follow:${workspaceId}`, ...(org ? [`task:${org.id}`, `org:${org.id}`] : [])];
    const events = (await this.db.select().from(agentEvents)
      .where(and(inArray(agentEvents.agentId, addressees), gte(agentEvents.createdAt, since), or(eq(agentEvents.forMemberAccountId, ''), eq(agentEvents.forMemberAccountId, me)))))
      // The account's own events ('' addressee) are the owner's; a member sees what is addressed to them.
      .filter((r) => (r.forMemberAccountId === '' ? owner : true));
    const audits = org && owner
      ? await this.db.select().from(orgAudit).where(and(eq(orgAudit.orgId, org.id), gte(orgAudit.createdAt, since), inArray(orgAudit.action, [...FEED_AUDIT_ACTIONS]))).orderBy(desc(orgAudit.createdAt)).limit(400)
      : [];
    const pluginRows = owner
      ? await this.db.select().from(pluginAudit).where(and(eq(pluginAudit.workspaceId, workspaceId), gte(pluginAudit.createdAt, since), inArray(pluginAudit.action, [...FEED_PLUGIN_ACTIONS]))).orderBy(desc(pluginAudit.createdAt)).limit(100)
      : [];
    const pending = owner
      ? await this.db.select().from(pluginInstalls).where(and(eq(pluginInstalls.workspaceId, workspaceId), isNotNull(pluginInstalls.pendingVersionId)))
      : [];
    const mine = org
      ? (await this.db.select().from(orgTasks).where(and(eq(orgTasks.orgId, org.id), or(eq(orgTasks.assigneeHumanId, me), eq(orgTasks.reviewerHumanId, me), eq(orgTasks.status, 'blocked')))))
      : [];
    const attention = await this.db.select().from(follows)
      .where(and(eq(follows.workspaceId, workspaceId), eq(follows.followerKind, 'user'), eq(follows.followerId, me), isNull(follows.mutedAt), isNotNull(follows.attentionAt)));

    // ---- one batch of names ----
    const taskIds = new Set<string>(mine.map((t) => t.id));
    const meetingIds = new Set<string>();
    const projectIds = new Set<string>();
    const threadIds = new Set<string>();
    const pluginIds = new Set<string>([...pluginRows.map((r) => r.refId), ...pending.map((p) => p.pluginId)]);
    for (const n of g.needs) if (n.ref.taskId) taskIds.add(n.ref.taskId);
    for (const e of events) {
      const p = safe<Record<string, unknown>>(e.payload, {});
      if (typeof p.taskId === 'string') taskIds.add(p.taskId);
      if (typeof p.meetingId === 'string') meetingIds.add(p.meetingId);
      if (e.kind === 'follow' && typeof p.targetId === 'string') {
        if (p.targetKind === 'org_task') taskIds.add(p.targetId);
        if (p.targetKind === 'thread') threadIds.add(p.targetId);
      }
    }
    for (const r of audits) {
      const p = safe<Record<string, unknown>>(r.payload, {});
      if (r.refType === 'task') taskIds.add(r.refId);
      if (r.refType === 'meeting') meetingIds.add(r.refId);
      if (r.refType === 'project') projectIds.add(r.refId);
      if (typeof p.taskId === 'string') taskIds.add(p.taskId);
    }
    for (const f of attention) {
      if (f.targetKind === 'org_task') taskIds.add(f.targetId);
      if (f.targetKind === 'thread') threadIds.add(f.targetId);
    }
    const taskRows = taskIds.size ? await this.db.select({ id: orgTasks.id, key: orgTasks.key, title: orgTasks.title, projectId: orgTasks.projectId }).from(orgTasks).where(inArray(orgTasks.id, [...taskIds])) : [];
    for (const t of taskRows) if (t.projectId) projectIds.add(t.projectId);
    const projectRows = projectIds.size ? await this.db.select({ id: orgProjects.id, key: orgProjects.key, title: orgProjects.title }).from(orgProjects).where(inArray(orgProjects.id, [...projectIds])) : [];
    const meetingRows = meetingIds.size ? await this.db.select({ id: orgMeetings.id, title: orgMeetings.title }).from(orgMeetings).where(inArray(orgMeetings.id, [...meetingIds])) : [];
    const threadRows = threadIds.size ? await this.db.select({ id: channelMessages.id, channelId: channelMessages.channelId }).from(channelMessages).where(inArray(channelMessages.id, [...threadIds])) : [];
    const pluginNames = pluginIds.size ? await this.db.select({ id: plugins.id, pluginId: plugins.pluginId, name: plugins.name }).from(plugins).where(or(inArray(plugins.id, [...pluginIds]), inArray(plugins.pluginId, [...pluginIds]))) : [];

    const agentById = new Map(team.map((a) => [a.id, a]));
    const actorOf = (a: { id: string; name: string; emoji: string; colors: string } | undefined): FeedActor | null => (a ? { kind: 'agent', id: a.id, name: a.name, emoji: a.emoji, colors: a.colors } : null);
    const byName = new Map(team.map((a) => [a.name.toLowerCase(), a]));
    const tasks = new Map(taskRows.map((t) => [t.id, t]));
    const projects = new Map(projectRows.map((p) => [p.id, p]));
    const meetings = new Map(meetingRows.map((m) => [m.id, m]));
    const chanById = new Map(chans.map((c) => [c.id, c]));
    const threadChan = new Map(threadRows.map((m) => [m.id, m.channelId]));
    const pluginById = new Map<string, { name: string }>();
    for (const p of pluginNames) { pluginById.set(p.id, { name: p.name }); pluginById.set(p.pluginId, { name: p.name }); }
    const look: FeedLookup = {
      agent: (id) => (id ? actorOf(agentById.get(id)) : null),
      agentNamed: (name) => actorOf(byName.get(name.toLowerCase())),
      task: (id) => { const t = id ? tasks.get(id) : undefined; return t ? { key: t.key, title: t.title, projectId: t.projectId } : null; },
      project: (id) => { const p = id ? projects.get(id) : undefined; return p ? { key: p.key, title: p.title } : null; },
      meeting: (id) => { const m = id ? meetings.get(id) : undefined; return m ? { title: m.title } : null; },
      channel: (id) => { const c = id ? chanById.get(id) : undefined; return c ? { slug: c.slug } : null; },
      threadChannel: (id) => (id ? threadChan.get(id) ?? null : null),
      plugin: (id) => (id ? pluginById.get(id) ?? null : null),
      chiefId: org?.chiefOfStaffAgentId ?? null,
    };
    const taskContext = (taskId: string | null | undefined): FeedContext => {
      const t = taskId ? tasks.get(taskId) : undefined;
      if (!t) return {};
      const p = t.projectId ? projects.get(t.projectId) : undefined;
      return { taskId: t.id, taskKey: t.key, taskTitle: t.title, ...(t.projectId ? { projectId: t.projectId, projectKey: p?.key ?? null, projectTitle: p?.title ?? '' } : {}) };
    };
    const blank = (over: Partial<FeedItem> & Pick<FeedItem, 'id' | 'type' | 'title' | 'at' | 'target'>): FeedItem => ({
      section: FEED_TYPES[over.type].section, body: '', severity: 'normal', read: false, actionable: FEED_TYPES[over.type].section === 'needs',
      deadline: null, expiresSoon: false, actor: null, company, context: {}, actions: [], count: 1, ids: [over.id], ...over,
    });

    // ---- needs you ----
    const needs: FeedItem[] = [];
    for (const n of g.needs) {
      const id = `need:${n.id}`;
      const actor = (n.ref.agentId ? look.agent(n.ref.agentId) : null) ?? (n.requestedBy ? look.agentNamed(n.requestedBy) ?? { kind: n.requestedBy === 'Assurance' || n.requestedBy === 'System' ? 'system' : 'person', id: null, name: n.requestedBy } : null);
      needs.push(blank({
        id, type: NEED_TYPE[n.kind], title: n.title, body: n.detail, at: n.createdAt, severity: n.severity, read: readMark(id, n.createdAt),
        deadline: n.deadline, expiresSoon: expiresSoon(n.deadline, now), actor, context: { ...taskContext(n.ref.taskId), ...(n.ref.agentId ? { agentId: n.ref.agentId } : {}) },
        target: { kind: 'need', need: { kind: n.kind, ref: n.ref } }, actions: n.actions, need: n,
        ...(n.ref.eventId ? { ref: { agentId: n.ref.agentId, eventId: n.ref.eventId, sessionId: n.ref.sessionId } } : {}),
      }));
    }
    // A turn waiting on your connection: it times out in minutes.
    for (const e of events) {
      if (e.kind !== 'approval_request' || now.getTime() - Date.parse(e.createdAt) > TURN_APPROVAL_TTL_MS) continue;
      const deadline = new Date(Date.parse(e.createdAt) + TURN_APPROVAL_TTL_MS).toISOString();
      needs.push(blank({
        id: `event:${e.id}`, type: 'connection_approval', title: e.title, body: e.body, at: e.createdAt, severity: 'high', read: Boolean(e.readAt),
        deadline, expiresSoon: true, actor: look.agent(e.agentId), context: { agentId: e.agentId },
        target: e.sessionId ? { kind: 'chat', sessionId: e.sessionId } : { kind: 'agent', agentId: e.agentId }, actions: ['allow', 'deny'],
        ref: { agentId: e.agentId, eventId: e.id, sessionId: e.sessionId ?? undefined },
      }));
    }
    // Your tasks: assigned, to review, blocked on you.
    for (const t of mine) {
      const at = t.updatedAt ?? t.createdAt;
      const ctx = taskContext(t.id);
      const by = t.assigneeAgentId ? look.agent(t.assigneeAgentId) : null;
      const b = t.status === 'blocked' ? parseBlockedOn(t.blockedOn) : null;
      if (b?.kind === 'person' && b.ref === me) {
        const id = `task:${t.id}:blocked:${b.since}`;
        needs.push(blank({ id, type: 'blocked_on_you', title: `${taskLabel(t)} is waiting on you`, body: b.reason, at: b.since || at, severity: 'high', read: readMark(id, b.since || at), actor: by, context: ctx, target: { kind: 'task', taskId: t.id } }));
        continue;
      }
      if (t.reviewerHumanId === me && t.status === 'in_review') {
        const id = `task:${t.id}:review`;
        needs.push(blank({ id, type: 'task_review', title: `Review ${taskLabel(t)}`, body: by ? `${by.name} finished it and asks for your review.` : 'Waiting for your review.', at, read: readMark(id, at), actor: by, context: ctx, target: { kind: 'task', taskId: t.id } }));
        continue;
      }
      if (t.assigneeHumanId === me && OPEN_TASK.has(t.status)) {
        const id = `task:${t.id}:assigned`;
        needs.push(blank({ id, type: 'task_assigned', title: taskLabel(t), body: `Assigned to you · ${t.status.replace(/_/g, ' ')}`, at, read: readMark(id, t.createdAt), context: ctx, target: { kind: 'task', taskId: t.id } }));
      }
    }
    // What you follow that needs you.
    const attended = new Set<string>();
    for (const f of attention) {
      attended.add(`${f.targetKind}:${f.targetId}`);
      const id = `attention:${f.targetKind}:${f.targetId}:${f.attentionAt}`;
      let target: FeedTarget = { kind: 'follow', targetKind: f.targetKind, targetId: f.targetId, link: hashOf(f.link) };
      let context: FeedContext = {};
      if (f.targetKind === 'org_task') { target = { kind: 'task', taskId: f.targetId }; context = taskContext(f.targetId); }
      else if (f.targetKind === 'channel' && chanById.get(f.targetId)) { const ch = chanById.get(f.targetId)!; target = { kind: 'channel', channelId: ch.id, slug: ch.slug, messageId: null }; context = { channelId: ch.id, channelSlug: ch.slug }; }
      else if (f.targetKind === 'thread' && threadChan.get(f.targetId) && chanById.get(threadChan.get(f.targetId)!)) {
        const ch = chanById.get(threadChan.get(f.targetId)!)!;
        target = { kind: 'channel', channelId: ch.id, slug: ch.slug, messageId: f.targetId }; context = { channelId: ch.id, channelSlug: ch.slug };
      }
      needs.push(blank({
        id, type: 'follow_attention', title: `${f.title || 'Something you follow'}: ${f.attention || 'needs you'}`, body: f.lastActivity ? `${f.lastActorName ? `${f.lastActorName}: ` : ''}${f.lastActivity}` : '',
        at: f.attentionAt!, read: readMark(id, f.attentionAt!), actor: f.lastActorName ? look.agentNamed(f.lastActorName) ?? { kind: 'person', id: null, name: f.lastActorName } : null,
        context, target, ref: { follow: { targetKind: f.targetKind, targetId: f.targetId } },
      }));
    }
    // Plugin updates that widen their access wait for your review (Foundry).
    for (const p of pending) {
      const note = safe<{ version?: string; diff?: Array<{ path?: string; detail?: string; widening?: boolean }>; failures?: unknown[] }>(p.pendingNote, {});
      const widening = (note.diff ?? []).filter((d) => d.widening).map((d) => `${d.path}: ${d.detail}`);
      const id = `pending:${p.id}:${p.pendingVersionId}`;
      const name = look.plugin(p.pluginId)?.name ?? p.pluginId;
      needs.push(blank({
        id, type: 'plugin_review', title: `${name}${note.version ? ` ${note.version}` : ''} waits for your review`, at: p.updatedAt, read: readMark(id, p.updatedAt),
        body: widening.length ? `It asks for more: ${widening.slice(0, 3).join('; ')}` : (note.failures ?? []).length ? 'Its conformance checks failed.' : '', severity: 'normal',
        actor: { kind: 'system', id: null, name: 'Foundry' }, target: { kind: 'plugin', pluginId: p.pluginId },
      }));
    }

    // ---- mentions and updates ----
    const groupAfter = tunable(org, 'notify.groupAfter');
    const loose: Array<{ c: Classified; id: string; at: string; read: boolean }> = [];
    const minutesFor = new Set<string>();
    for (const e of events) {
      if (e.kind === 'approval_request') continue;
      const c = classifyEvent(e, look);
      if (!c || !typeOn(org, c.type)) continue;
      if (c.type === 'follow' && c.groupKey && attended.has(c.groupKey.replace(/^task:/, 'org_task:'))) continue; // listed under Needs you
      if (c.type === 'meeting' && c.context.meetingId && /ended/.test(c.title)) minutesFor.add(c.context.meetingId);
      loose.push({ c, id: `event:${e.id}`, at: e.createdAt, read: Boolean(e.readAt) || Boolean(read.allAt && e.createdAt <= read.allAt) });
    }
    for (const r of audits) {
      if (r.action === 'meeting_end' && minutesFor.has(r.refId)) continue; // the minutes say it, with more
      const c = classifyAudit(r, look);
      if (!c || !typeOn(org, c.type)) continue;
      const id = `audit:${r.id}`;
      loose.push({ c, id, at: r.createdAt, read: readMark(id, r.createdAt) });
    }
    for (const r of pluginRows) {
      const c = classifyPluginAudit(r, look);
      if (!c || !typeOn(org, c.type)) continue;
      const id = `plugin:${r.id}`;
      loose.push({ c, id, at: r.createdAt, read: readMark(id, r.createdAt) });
    }
    const toItem = (x: typeof loose[number]): FeedItem => blank({
      id: x.id, type: x.c.type, title: x.c.title, body: x.c.body, at: x.at, severity: x.c.severity, read: x.read,
      actor: x.c.actor, context: x.c.context, target: x.c.target,
      ...(x.c.follow ? { ref: { follow: x.c.follow } } : x.id.startsWith('event:') && x.c.target.kind === 'chat' ? { ref: { sessionId: x.c.target.sessionId } } : {}),
    });
    // Updates about one thing collapse into one row.
    const groups = new Map<string, typeof loose>();
    const rest: FeedItem[] = [];
    for (const x of loose) {
      if (FEED_TYPES[x.c.type].section === 'updates' && x.c.groupKey) {
        const list = groups.get(x.c.groupKey) ?? [];
        list.push(x);
        groups.set(x.c.groupKey, list);
      } else rest.push(toItem(x));
    }
    for (const [key, list] of groups) {
      if (list.length < groupAfter) { rest.push(...list.map(toItem)); continue; }
      list.sort((a, b) => b.at.localeCompare(a.at));
      const top = toItem(list[0]);
      const sev = list.reduce((s, x) => (SEVERITY_RANK[x.c.severity] < SEVERITY_RANK[s] ? x.c.severity : s), top.severity);
      const actors = new Set(list.map((x) => x.c.actor?.name).filter(Boolean));
      rest.push({
        ...top, id: `group:${key}`, title: `${list.length} updates on ${list[0].c.groupLabel || 'one thing'}`,
        body: `Latest: ${top.title}${actors.size > 1 ? ` · from ${[...actors].slice(0, 3).join(', ')}${actors.size > 3 ? ' and others' : ''}` : ''}`,
        severity: sev, read: list.every((x) => x.read), count: list.length, ids: list.map((x) => x.id),
      });
    }

    // ---- order and count ----
    needs.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || b.at.localeCompare(a.at));
    rest.sort((a, b) => b.at.localeCompare(a.at));
    const all = [...needs, ...rest];
    const sections: FeedPage['counts']['sections'] = { needs: { total: 0, unread: 0 }, mentions: { total: 0, unread: 0 }, updates: { total: 0, unread: 0 } };
    for (const i of all) { sections[i.section].total++; if (!i.read) sections[i.section].unread++; }
    const unread = sections.needs.unread + sections.mentions.unread + sections.updates.unread;
    return {
      workspaceId, generatedAt: now.toISOString(), company,
      items: all.slice(0, Math.max(1, opts.limit ?? FEED_LIMIT)),
      counts: { needsYou: needs.length, urgent: needs.filter((n) => isUrgent(n, now)).length, unread, sections },
      unread,
    };
  }

  /** Mark rows read: some (`ids`, a row's `ids`, or `group:` ids), a section, or everything up to now (`all`). */
  async markRead(workspaceId: string, body: { ids?: unknown; all?: unknown; section?: unknown }, now = new Date()): Promise<{ ok: true; marked: number }> {
    await this.workspaces.get(workspaceId);
    const page = await this.feed(workspaceId, { now, limit: 10_000 });
    const listed = new Map<string, FeedItem>();
    for (const i of page.items) for (const id of i.ids) listed.set(id, i);
    const byGroup = new Map(page.items.filter((i) => i.id.startsWith('group:')).map((i) => [i.id, i.ids]));
    let wanted: string[];
    const read = await this.readRow(workspaceId);
    const section = typeof body.section === 'string' && ['needs', 'mentions', 'updates'].includes(body.section) ? body.section as FeedSection : null;
    if (body.all === true) {
      wanted = [...listed.keys()];
      read.allAt = now.toISOString();
    } else if (section) {
      wanted = page.items.filter((i) => i.section === section).flatMap((i) => i.ids);
    } else {
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x): x is string => typeof x === 'string').slice(0, 500);
      wanted = ids.flatMap((x) => byGroup.get(x) ?? [x]);
    }
    // Only what the feed lists can be marked; what is already read stays as it is.
    const fresh = [...new Set(wanted)].filter((id) => listed.has(id) && !(listed.get(id)!.ids.length === 1 && listed.get(id)!.read));
    const asked = fresh.filter((x) => x.startsWith('event:')).map((x) => x.slice(6));
    const eventIds = asked.length ? (await this.db.select({ id: agentEvents.id }).from(agentEvents).where(and(inArray(agentEvents.id, asked), isNull(agentEvents.readAt)))).map((r) => r.id) : [];
    const otherIds = fresh.filter((x) => !x.startsWith('event:') && !read.ids.includes(x));
    if (eventIds.length) await this.db.update(agentEvents).set({ readAt: now.toISOString() }).where(and(inArray(agentEvents.id, eventIds), isNull(agentEvents.readAt)));
    read.ids.push(...otherIds);
    if (body.all === true || otherIds.length) await this.writeRow(workspaceId, read);
    return { ok: true, marked: eventIds.length + otherIds.length };
  }

  /** The update types this workspace can turn off, with their state. */
  async types(workspaceId: string): Promise<FeedTypeInfo[]> {
    await this.workspaces.get(workspaceId);
    const org = await this.orgOf(workspaceId);
    return UPDATE_TYPES.map((t) => ({
      type: t, label: FEED_TYPES[t].label, description: FEED_TYPES[t].description, key: notifyKey(t),
      on: typeOn(org, t), default: FEED_TYPES[t].defaultOn !== false,
    }));
  }
}
