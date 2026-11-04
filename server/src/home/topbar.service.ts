/**
 * TopBarService — the top bar's reads (docs/home.md "Top bar"):
 *
 *  - `status(ws)`: the company at a glance — run state, Needs you, spend
 *    against the envelope, agents working and failing, the turns running
 *    now and the next meeting. One request instead of five.
 *  - `workspaceRows()`: the switcher's rows — each own workspace's company
 *    state, Needs-you count and unread notifications.
 *  - `notifications(ws)` / `markRead(ws, …)`: the bell, which is the owner's
 *    feed (FeedService) — the same items and the same counts as the Inbox.
 *
 * Needs you here is the feed's: Home's cards plus the tasks, follows,
 * connection approvals and plugin reviews that wait on you, so the bar, the
 * switcher, the Inbox's badge and the bell never disagree.
 */
import { Injectable } from '@nestjs/common';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { liveTurns, type LiveTurnRegistry } from '../chats/live-turns';
import { HomeService } from './home.service';
import { FeedService } from './feed.service';
import type { FeedPage } from './feed.types';
import type { WorkspaceGlanceRow, WorkspaceStatus } from './topbar.types';

export { EXPIRING_MS, expiresSoon, isUrgent } from './feed.service';
export { hashOf } from './feed-registry';

const DAY_MS = 24 * 3_600_000;
/** Items the bell asks for (the counts cover everything). */
export const NOTIFICATION_LIMIT = 200;

@Injectable()
export class TopBarService {
  /** The live-turn registry (the process-wide one; tests pass their own). */
  registry: LiveTurnRegistry = liveTurns;

  constructor(
    private readonly home: HomeService,
    private readonly workspaces: WorkspacesService,
    private readonly feed: FeedService,
  ) {}

  // ---- status ----

  async status(workspaceId: string, now = new Date()): Promise<WorkspaceStatus> {
    const g = await this.home.glance(workspaceId, { now });
    const counts = (await this.feed.feed(workspaceId, { now, glance: g, limit: 1 })).counts;
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
      needsYou: counts.needsYou, urgent: counts.urgent, unread: counts.unread,
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
        const counts = (await this.feed.feed(w.id, { now, glance: g, limit: 1 })).counts;
        const archived = g.company ? false : await this.home.hasArchivedCompany(w.id).catch(() => false);
        return { workspaceId: w.id, company: g.company, needsYou: counts.needsYou, unread: counts.unread, archived };
      } catch {
        return { workspaceId: w.id, company: null, needsYou: 0, unread: 0, archived: false };
      }
    }));
  }

  // ---- the bell: the feed ----

  notifications(workspaceId: string, opts: { now?: Date; limit?: number } = {}): Promise<FeedPage> {
    return this.feed.feed(workspaceId, { now: opts.now, limit: opts.limit ?? NOTIFICATION_LIMIT });
  }

  markRead(workspaceId: string, body: { ids?: unknown; all?: unknown; section?: unknown }, now = new Date()): Promise<{ ok: true; marked: number }> {
    return this.feed.markRead(workspaceId, body, now);
  }
}
