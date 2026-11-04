/**
 * TopBarService — the top bar's three reads and its one write (docs/home.md
 * "Top bar"):
 *
 *  - `status(ws)`: the company at a glance — run state, Needs you, spend
 *    against the envelope, agents working and failing, the turns running
 *    now and the next meeting. One request instead of five.
 *  - `workspaceRows()`: the switcher's rows — each own workspace's company
 *    state, Needs-you count and unread notifications.
 *  - `notifications(ws)`: the bell — what waits on you (Home's Needs-you
 *    cards) merged with the inbox events addressed to you (messages from
 *    agents, mentions, followed changes, failed runs, budget stops).
 *  - `markRead(ws, ids | all)`.
 *
 * Read state: an inbox event keeps its own (`agent_events.readAt`, the same
 * mark the agent inbox and the Inbox's Messages set). A card has none — it
 * waits until it is decided — so the bell keeps, per person, the ids of the
 * cards they have seen and the time of their last "mark all read", in one
 * `home.notifications:<ws>:<actor>` app_settings row (hidden from
 * GET /api/settings with the other `home.*` rows). Reading a card quiets the
 * count; it stays listed while it waits.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentEvents, agents as agentsTable, appSettings, channels } from '../database/schema';
import { actorId, currentViewer } from '../accounts/account-context';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { liveTurns, type LiveTurnRegistry } from '../chats/live-turns';
import { HomeService } from './home.service';
import type { HomeNeed } from './home.types';
import type { NotificationKind, NotificationsPage, TopNotification, WorkspaceGlanceRow, WorkspaceStatus } from './topbar.types';

const DAY_MS = 24 * 3_600_000;
/** A card whose default applies within this is "expiring soon" (and urgent). */
export const EXPIRING_MS = 6 * 3_600_000;
/** How far back the bell reads inbox events. */
export const NOTIFICATION_DAYS = 14;
export const NOTIFICATION_LIMIT = 80;
/** Card ids the read row remembers (the newest). */
const READ_IDS_CAP = 500;

/** Inbox event kinds the bell lists, and as what. Routine runs (`loop_run`),
 *  a queued action (listed as its card) and an action's outcome are not news;
 *  any other kind (an org notice, an info event) is `activity`. */
const EVENT_KIND: Record<string, NotificationKind | null> = {
  agent_message: 'message', mention: 'mention', follow: 'follow',
  loop_error: 'run_failed', action_failed: 'run_failed', budget_stop: 'budget_stop',
  loop_run: null, action_pending: null, action_done: null, action_dismissed: null,
};

const kindOfEvent = (kind: string): NotificationKind | null => (kind in EVENT_KIND ? EVENT_KIND[kind] : 'activity');

const NEED_KIND: Record<HomeNeed['kind'], NotificationKind> = {
  approval: 'decision', escalation: 'escalation', held_action: 'key', plan: 'plan', incident: 'incident', signal: 'signal', queued_action: 'queued_action',
};

const safe = <T,>(raw: string | null | undefined, fallback: T): T => { try { return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };

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

/** Whether a card's default applies within 6 hours (and has not yet). */
export function expiresSoon(deadline: string | null, now: Date): boolean {
  if (!deadline) return false;
  const left = Date.parse(deadline) - now.getTime();
  return left > 0 && left < EXPIRING_MS;
}

/** Whether a card is urgent: critical, or its default applies within 6 hours. */
export function isUrgent(n: Pick<HomeNeed, 'severity' | 'deadline'>, now: Date): boolean {
  return n.severity === 'critical' || expiresSoon(n.deadline, now);
}

interface ReadRow { ids: string[]; allAt: string | null }

@Injectable()
export class TopBarService {
  /** The live-turn registry (the process-wide one; tests pass their own). */
  registry: LiveTurnRegistry = liveTurns;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly home: HomeService,
    private readonly workspaces: WorkspacesService,
  ) {}

  // ---- status ----

  async status(workspaceId: string, now = new Date()): Promise<WorkspaceStatus> {
    const g = await this.home.glance(workspaceId, { now });
    const failing = g.team.filter((a) => a.state === 'error');
    const working = g.team.filter((a) => a.state === 'working');
    const live = this.registry.inWorkspace(workspaceId).map((t) => ({
      sessionId: t.sessionId, agentId: t.agentId, agentName: t.agentId ? g.agentNames.get(t.agentId) ?? 'Agent' : 'Workspace',
      origin: t.origin, sessionName: t.sessionName, startedAt: t.startedAt, toolLabel: t.toolLabel,
    }));
    const day = new Date(now.getTime() + DAY_MS).toISOString();
    const meeting = g.upcoming.find((u) => (u.kind === 'meeting' || u.kind === 'ritual') && u.at <= day) ?? null;
    const faces = [...failing.map((a) => ({ a, state: 'error' as const })), ...working.map((a) => ({ a, state: 'working' as const }))].slice(0, 5);
    return {
      workspaceId, generatedAt: g.generatedAt, company: g.company,
      needsYou: g.needs.length, urgent: g.needs.filter((n) => isUrgent(n, now)).length,
      spend: g.spend && g.company ? { todayUsd: g.spend.todayUsd, monthUsd: g.spend.monthUsd, monthCapUsd: g.spend.monthCapUsd, projectedUsd: g.spend.projectedUsd, forecastState: g.spend.forecastState } : null,
      agents: {
        total: g.team.length, working: working.length, failing: failing.length,
        faces: faces.map(({ a, state }) => ({ id: a.id, name: a.name, emoji: a.emoji, colors: a.colors, state })),
      },
      live,
      nextMeeting: meeting ? {
        id: meeting.id, title: meeting.units?.length ? `${meeting.title} · ${meeting.units.join(', ')}` : meeting.title, at: meeting.at,
        meetingId: meeting.ref?.type === 'meeting' ? meeting.ref.id : null,
      } : null,
      partial: g.partial,
    };
  }

  // ---- the switcher ----

  async workspaceRows(now = new Date()): Promise<WorkspaceGlanceRow[]> {
    const list = await this.workspaces.list();
    return Promise.all(list.map(async (w): Promise<WorkspaceGlanceRow> => {
      try {
        const g = await this.home.glance(w.id, { now, parts: [] });
        const unread = (await this.notifications(w.id, { now, needs: g.needs })).unread;
        return { workspaceId: w.id, company: g.company, needsYou: g.needs.length, unread };
      } catch {
        return { workspaceId: w.id, company: null, needsYou: 0, unread: 0 };
      }
    }));
  }

  // ---- the bell ----

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

  /** The inbox event addressees of a workspace: its agents, its channels, its follows. */
  private async addressees(workspaceId: string): Promise<{ ids: string[]; names: Map<string, string>; agentIds: Set<string> }> {
    const team = await this.db.select({ id: agentsTable.id, name: agentsTable.name }).from(agentsTable).where(eq(agentsTable.workspaceId, workspaceId));
    const chans = await this.db.select({ id: channels.id, slug: channels.slug }).from(channels).where(eq(channels.workspaceId, workspaceId));
    const names = new Map<string, string>([...team.map((a) => [a.id, a.name] as const), ...chans.map((c) => [`channel:${c.id}`, `#${c.slug}`] as const)]);
    return { ids: [...team.map((a) => a.id), ...chans.map((c) => `channel:${c.id}`), `follow:${workspaceId}`], names, agentIds: new Set(team.map((a) => a.id)) };
  }

  /** The inbox events of the last two weeks addressed to the caller. */
  private async events(workspaceId: string, now: Date) {
    const who = await this.addressees(workspaceId);
    const since = new Date(now.getTime() - NOTIFICATION_DAYS * DAY_MS).toISOString();
    const me = actorId();
    const viewer = currentViewer();
    const owner = !viewer || viewer.role === 'owner';
    const rows = await this.db.select().from(agentEvents)
      .where(and(inArray(agentEvents.agentId, who.ids), gte(agentEvents.createdAt, since), or(eq(agentEvents.forMemberAccountId, ''), eq(agentEvents.forMemberAccountId, me))));
    // The account's own events ('' addressee) are the owner's; a member sees what is addressed to them.
    return { rows: rows.filter((r) => (r.forMemberAccountId === '' ? owner : true)), who };
  }

  async notifications(workspaceId: string, opts: { now?: Date; needs?: HomeNeed[]; limit?: number } = {}): Promise<NotificationsPage> {
    const now = opts.now ?? new Date();
    const needs = opts.needs ?? (await this.home.glance(workspaceId, { now, parts: [] })).needs;
    const read = await this.readRow(workspaceId);
    const seen = new Set(read.ids);
    const readBefore = (at: string) => Boolean(read.allAt && at <= read.allAt);
    const waiting: TopNotification[] = needs.map((n) => {
      const id = `need:${n.id}`;
      return {
        id, kind: NEED_KIND[n.kind], title: n.title, body: n.detail, at: n.createdAt, severity: n.severity,
        read: seen.has(id) || readBefore(n.createdAt), waiting: true, deadline: n.deadline, expiresSoon: expiresSoon(n.deadline, now),
        from: n.requestedBy, agentId: n.ref.agentId ?? null, target: { to: 'need', need: { kind: n.kind, ref: n.ref } },
      };
    });
    const news: TopNotification[] = [];
    const { rows, who } = await this.events(workspaceId, now);
    for (const e of rows) {
      const kind = kindOfEvent(e.kind);
      if (!kind) continue;
      const p = safe<{ link?: string; from?: string; urgency?: string; mention?: boolean }>(e.payload, {});
      const hash = hashOf(p.link);
      const agentId = who.agentIds.has(e.agentId) ? e.agentId : null;
      const severity: TopNotification['severity'] = kind === 'run_failed' || kind === 'budget_stop' ? 'high'
        : kind === 'message' ? (p.urgency === 'urgent' ? 'high' : p.urgency === 'fyi' ? 'low' : 'normal')
          : kind === 'mention' && p.mention ? 'normal' : 'low';
      news.push({
        id: `event:${e.id}`, kind, title: e.title, body: e.body, at: e.createdAt, severity,
        read: Boolean(e.readAt) || readBefore(e.createdAt), waiting: false, deadline: null, expiresSoon: false,
        from: p.from || who.names.get(e.agentId) || (e.agentId.startsWith('follow:') ? 'Following' : 'System'), agentId,
        target: kind === 'message' && e.sessionId ? { to: 'chat', sessionId: e.sessionId }
          : hash ? { to: 'hash', hash }
            : e.sessionId ? { to: 'chat', sessionId: e.sessionId }
              : agentId ? { to: 'agent', agentId } : { to: 'inbox' },
      });
    }
    // Waiting cards first (Home's Needs you, already ranked), then the news, newest first.
    news.sort((a, b) => b.at.localeCompare(a.at));
    const all = [...waiting, ...news];
    return { generatedAt: now.toISOString(), items: all.slice(0, opts.limit ?? NOTIFICATION_LIMIT), unread: all.filter((i) => !i.read).length };
  }

  /** Mark some notifications read (`ids`), or everything up to now (`all`). */
  async markRead(workspaceId: string, body: { ids?: unknown; all?: unknown }, now = new Date()): Promise<{ ok: true; marked: number }> {
    await this.workspaces.get(workspaceId);
    const read = await this.readRow(workspaceId);
    const { rows } = await this.events(workspaceId, now);
    // Only what the bell lists: a routine run or a queued action keeps its own mark.
    const unreadEvents = new Set(rows.filter((r) => !r.readAt && kindOfEvent(r.kind)).map((r) => r.id));
    let eventIds: string[];
    let needIds: string[] = [];
    if (body.all === true) {
      eventIds = [...unreadEvents];
      read.allAt = now.toISOString();
    } else {
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x): x is string => typeof x === 'string').slice(0, 200);
      eventIds = ids.filter((x) => x.startsWith('event:')).map((x) => x.slice(6)).filter((x) => unreadEvents.has(x));
      needIds = [...new Set(ids.filter((x) => x.startsWith('need:') && !read.ids.includes(x)))];
      read.ids.push(...needIds);
    }
    if (eventIds.length) await this.db.update(agentEvents).set({ readAt: now.toISOString() }).where(and(inArray(agentEvents.id, eventIds), isNull(agentEvents.readAt)));
    if (body.all === true || needIds.length) await this.writeRow(workspaceId, read);
    return { ok: true, marked: eventIds.length + needIds.length };
  }
}
