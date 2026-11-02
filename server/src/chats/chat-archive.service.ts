/**
 * ChatArchiveService — auto-archive of finished-task chats
 * (docs/chat-archiving.md).
 *
 * A chat can be linked to the task it works on (`chat_sessions.taskKind` +
 * `taskId`): the per-task org session (`Org · <org> · <task>`) is linked when
 * the runtime creates it, a chat a turn was promoted from is linked to that
 * kanban task, and an agent links one of its chats with the tool. Every
 * linked chat carries `autoArchiveDays`: null follows the workspace tunable
 * `chat.autoArchiveDays`, 0 is off, n is days. A task chat starts with its
 * agent's default (`agents.chatAutoArchiveDays`).
 *
 * The sweep (hourly, on the loops minute tick) archives a linked chat when
 * its task has been done / cancelled / abandoned for at least that many days
 * and the chat itself has been quiet as long — never a pinned chat, one with
 * a turn running, one with a pending approval (live, queued in the inbox, or
 * a held / staged action) or one with an unread inbox event from the last
 * `chat.autoArchiveUnreadHours`. Each archived batch leaves one (read) inbox
 * event per agent naming the chats, so the rail's shrinking is explainable;
 * the chats restore from the Archived group as any archived chat does, and a
 * restore counts as activity (the quiet window starts again).
 *
 * The agent's tool `set_chat_auto_archive` changes the setting on its own
 * chats only — classed `read` and free like its other self-organisation
 * tools (actions/action-classes.ts).
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, like, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { actionLog, agentEvents, agentTasks, agents, chatSessions, orgTasks, organizations } from '../database/schema';
import { nowIso } from '../common/ids.util';
import { ChatsRepository, type ChatSession } from './chats.repository';
import { TurnLoopService, type ToolProviderHook } from './turn-loop.service';
import { AgentsService } from '../agents/agents.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { chatArchiveTunable } from './chat-archive-tunables';

/** Task statuses that count as finished, per kind. */
const FINISHED: Record<'org' | 'agent', readonly string[]> = {
  org: ['done', 'cancelled'],
  agent: ['done', 'abandoned'],
};
const MAX_DAYS = 365;
/** Linked chats one sweep looks at (oldest activity first). */
const SWEEP_BATCH = 500;

export type ArchiveSkip = 'pinned' | 'off' | 'recent' | 'task_open' | 'task_recent' | 'running' | 'approval' | 'unread';

export const CHAT_ARCHIVE_TOOLS: AiToolSpec[] = [
  {
    name: 'set_chat_auto_archive',
    description: 'Set when one of your task chats archives itself: `days` after its task is done, cancelled or abandoned (and the chat has gone quiet), or null to turn auto-archive off for it ("default" follows the workspace default). Defaults to the current chat; only your own chats. Pass taskId to link the chat to one of your kanban tasks (or an org task assigned to you) when it is not linked yet. Archived chats stay restorable.',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'The chat to change; omit for the current chat.' },
        days: { type: 'number', description: 'Days after the task is finished (1–365); null or 0 = off. The string "default" follows the workspace default.' },
        taskId: { type: 'string', description: 'Optional: link the chat to this task (the short id from list_tasks or the org board).' },
      },
      required: ['days'],
    },
  },
];
const TOOL_NAMES = new Set(CHAT_ARCHIVE_TOOLS.map((t) => t.name));

/** What a chat's setting means in words. */
export function describeAutoArchive(days: number | null, workspaceDays: number): string {
  if (days === null) return workspaceDays > 0 ? `the workspace default (${workspaceDays} day${workspaceDays === 1 ? '' : 's'} after its task is finished)` : 'off (the workspace default)';
  if (days <= 0) return 'off';
  return `${days} day${days === 1 ? '' : 's'} after its task is finished`;
}

@Injectable()
export class ChatArchiveService implements ToolProviderHook, OnModuleInit {
  private readonly logger = new Logger(ChatArchiveService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly repo: ChatsRepository,
    /** Optional so the sweep can be tested without a turn loop. */
    @Optional() private readonly turns?: TurnLoopService,
    /** Optional: without it the sweep leaves no inbox event. */
    @Optional() private readonly agentsSvc?: AgentsService,
  ) {}

  onModuleInit(): void { this.turns?.addToolProvider(this); }

  // ---- defaults ----

  /** The workspace's organization row (its tunables), or null. */
  private async orgOf(workspaceId: string): Promise<{ tunables: string } | null> {
    const rows = await this.db.select({ tunables: organizations.tunables, status: organizations.status }).from(organizations).where(eq(organizations.workspaceId, workspaceId));
    return rows.find((r) => r.status !== 'archived') ?? null;
  }

  /** The workspace's `chat.autoArchiveDays` (0 = off). */
  async workspaceDays(workspaceId: string): Promise<number> {
    return Math.round(chatArchiveTunable(await this.orgOf(workspaceId), 'chat.autoArchiveDays'));
  }

  /** The fields a new task chat of this agent starts with: its link and the
   *  agent's default (null = follow the workspace). */
  async taskChatFields(agentId: string, taskKind: 'org' | 'agent', taskId: string): Promise<Pick<ChatSession, 'taskKind' | 'taskId' | 'autoArchiveDays'>> {
    const row = (await this.db.select({ d: agents.chatAutoArchiveDays }).from(agents).where(eq(agents.id, agentId)).limit(1)).at(0);
    return { taskKind, taskId, autoArchiveDays: row?.d ?? null };
  }

  /** Link an existing chat to a task when it has none (a promoted turn, an
   *  org session made before migration 0051). Never re-links. */
  async linkIfUnlinked(sessionId: string, taskKind: 'org' | 'agent', taskId: string): Promise<boolean> {
    const s = await this.repo.getSession(sessionId);
    if (!s || s.taskId || !s.agentId) return false;
    const fields = await this.taskChatFields(s.agentId, taskKind, taskId);
    await this.db.update(chatSessions).set({ taskKind: fields.taskKind, taskId: fields.taskId, autoArchiveDays: s.autoArchiveDays ?? fields.autoArchiveDays }).where(eq(chatSessions.id, sessionId));
    return true;
  }

  // ---- the tool ----

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> { return session.agentId ? CHAT_ARCHIVE_TOOLS : []; }
  owns(name: string): boolean { return TOOL_NAMES.has(name); }
  isReadOnly(name: string): boolean { return TOOL_NAMES.has(name); }
  async contextFor(): Promise<string | null> { return null; }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (name !== 'set_chat_auto_archive') throw new Error(`unknown tool: ${name}`);
    return this.setFor(session, input);
  }

  /** set_chat_auto_archive: the calling agent's own chats only. */
  async setFor(session: Pick<ChatSession, 'id' | 'agentId' | 'workspaceId'>, input: Record<string, unknown>): Promise<string> {
    const agentId = session.agentId;
    if (!agentId) throw new Error('set_chat_auto_archive is only available to durable agents');
    const chatId = typeof input.chatId === 'string' && input.chatId.trim() ? input.chatId.trim() : session.id;
    const target = await this.resolveChat(session.workspaceId, chatId);
    if (!target || target.agentId !== agentId) throw new Error(`chat ${chatId} is not one of your chats — you can only set auto-archive on your own chats`);
    const raw = input.days;
    let days: number | null;
    if (raw === null || raw === undefined || raw === 'off') days = 0;
    else if (raw === 'default') days = null;
    else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error('days must be a whole number of days (1–365), null for off, or "default"');
      days = Math.min(MAX_DAYS, Math.round(n));
    }
    const set: Partial<ChatSession> = { autoArchiveDays: days };
    let linked = '';
    if (typeof input.taskId === 'string' && input.taskId.trim()) {
      const task = await this.resolveTask(agentId, session.workspaceId, input.taskId.trim());
      if (!task) throw new Error(`no task of yours matches "${input.taskId}" — use the short id from list_tasks or the org board`);
      if (target.taskId && target.taskId !== task.id) throw new Error(`this chat already works on task [${target.taskId.slice(0, 8)}]`);
      set.taskKind = task.kind; set.taskId = task.id;
      linked = ` Linked to task [${task.id.slice(0, 8)}] "${task.title}".`;
    }
    // Not through updateSession: changing the setting is not chat activity.
    await this.db.update(chatSessions).set(set).where(eq(chatSessions.id, target.id));
    const wsDays = await this.workspaceDays(session.workspaceId);
    const label = target.name || target.autoTitle || 'this chat';
    const unlinked = !(set.taskId ?? target.taskId) ? ' It is not linked to a task yet, so nothing archives it until it is (pass taskId).' : '';
    return `Auto-archive for "${label}": ${describeAutoArchive(days, wsDays)}.${linked}${unlinked}`;
  }

  private async resolveChat(workspaceId: string, idOrPrefix: string): Promise<ChatSession | null> {
    const exact = await this.repo.getSession(idOrPrefix);
    if (exact) return exact.workspaceId === workspaceId ? exact : null;
    if (idOrPrefix.length < 6) return null;
    const rows = await this.db.select().from(chatSessions).where(and(eq(chatSessions.workspaceId, workspaceId), like(chatSessions.id, `${idOrPrefix.replace(/[\\%_]/g, '')}%`))).limit(2);
    return rows.length === 1 ? rows[0] : null;
  }

  private async resolveTask(agentId: string, workspaceId: string, idOrPrefix: string): Promise<{ kind: 'org' | 'agent'; id: string; title: string } | null> {
    const pat = `${idOrPrefix.replace(/[\\%_]/g, '')}%`;
    const kanban = await this.db.select({ id: agentTasks.id, title: agentTasks.title }).from(agentTasks).where(and(eq(agentTasks.agentId, agentId), like(agentTasks.id, pat))).limit(2);
    if (kanban.length === 1) return { kind: 'agent', ...kanban[0] };
    const org = await this.db.select({ id: orgTasks.id, title: orgTasks.title }).from(orgTasks)
      .innerJoin(organizations, eq(organizations.id, orgTasks.orgId))
      .where(and(eq(organizations.workspaceId, workspaceId), eq(orgTasks.assigneeAgentId, agentId), like(orgTasks.id, pat))).limit(2);
    if (org.length === 1) return { kind: 'org', ...org[0] };
    return null;
  }

  // ---- the sweep ----

  /** Archive every linked chat whose task is finished and whose window has
   *  passed, for the current account. Returns what it archived and why the
   *  rest stayed (tests, logs). */
  async sweep(now: Date = new Date()): Promise<{ archived: Array<{ id: string; name: string; agentId: string | null }>; skipped: Partial<Record<ArchiveSkip, number>> }> {
    const skipped: Partial<Record<ArchiveSkip, number>> = {};
    const skip = (r: ArchiveSkip) => { skipped[r] = (skipped[r] ?? 0) + 1; };
    // A day is the shortest window, so nothing touched in the last day is a candidate.
    const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
    const rows = await this.db.select().from(chatSessions).where(and(
      isNull(chatSessions.archivedAt), isNotNull(chatSessions.taskId),
      or(isNull(chatSessions.autoArchiveDays), sql`${chatSessions.autoArchiveDays} > 0`),
      lt(chatSessions.updatedAt, dayAgo),
    )).orderBy(chatSessions.updatedAt).limit(SWEEP_BATCH);
    const archived: Array<{ id: string; name: string; agentId: string | null }> = [];
    if (rows.length === 0) return { archived, skipped };

    const orgCache = new Map<string, { tunables: string } | null>();
    const orgFor = async (ws: string) => {
      if (!orgCache.has(ws)) orgCache.set(ws, await this.orgOf(ws));
      return orgCache.get(ws) ?? null;
    };
    const ids = rows.map((r) => r.id);
    const orgIds = rows.filter((r) => r.taskKind === 'org').map((r) => r.taskId!);
    const agentIds = rows.filter((r) => r.taskKind === 'agent').map((r) => r.taskId!);
    const orgTaskRows = orgIds.length ? await this.db.select({ id: orgTasks.id, status: orgTasks.status, updatedAt: orgTasks.updatedAt }).from(orgTasks).where(inArray(orgTasks.id, orgIds)) : [];
    const agentTaskRows = agentIds.length ? await this.db.select({ id: agentTasks.id, status: agentTasks.status, updatedAt: agentTasks.updatedAt }).from(agentTasks).where(inArray(agentTasks.id, agentIds)) : [];
    const taskOf = new Map<string, { status: string; updatedAt: string }>([...orgTaskRows, ...agentTaskRows].map((t) => [t.id, t]));
    // Approvals waiting in the inbox or the action log, and unread events.
    const waiting = new Set<string>();
    for (const e of await this.db.select({ sessionId: agentEvents.sessionId }).from(agentEvents)
      .where(and(inArray(agentEvents.sessionId, ids), inArray(agentEvents.kind, ['action_pending', 'approval_request'])))) if (e.sessionId) waiting.add(e.sessionId);
    for (const a of await this.db.select({ sessionId: actionLog.sessionId }).from(actionLog)
      .where(and(inArray(actionLog.sessionId, ids), inArray(actionLog.status, ['held', 'staged'])))) waiting.add(a.sessionId);
    const unread = await this.db.select({ sessionId: agentEvents.sessionId, createdAt: agentEvents.createdAt }).from(agentEvents)
      .where(and(inArray(agentEvents.sessionId, ids), isNull(agentEvents.readAt)));

    for (const s of rows) {
      if (s.pinned === 1) { skip('pinned'); continue; }
      const org = await orgFor(s.workspaceId);
      const days = s.autoArchiveDays ?? Math.round(chatArchiveTunable(org, 'chat.autoArchiveDays'));
      if (days <= 0) { skip('off'); continue; }
      const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
      if (s.updatedAt > cutoff) { skip('recent'); continue; }
      const task = taskOf.get(s.taskId!);
      // A task deleted from the board counts as finished; the quiet chat is the window.
      if (task) {
        if (!FINISHED[s.taskKind === 'org' ? 'org' : 'agent'].includes(task.status)) { skip('task_open'); continue; }
        if (task.updatedAt > cutoff) { skip('task_recent'); continue; }
      }
      if (this.turns?.isBusy(s.id)) { skip('running'); continue; }
      if (this.turns?.hasPendingApproval(s.id) || waiting.has(s.id)) { skip('approval'); continue; }
      const unreadSince = new Date(now.getTime() - chatArchiveTunable(org, 'chat.autoArchiveUnreadHours') * 3_600_000).toISOString();
      if (unread.some((e) => e.sessionId === s.id && e.createdAt >= unreadSince)) { skip('unread'); continue; }
      // Guarded: a turn that started in between keeps the chat.
      const res = await this.db.update(chatSessions).set({ archivedAt: now.toISOString(), updatedAt: nowIso() })
        .where(and(eq(chatSessions.id, s.id), isNull(chatSessions.archivedAt), eq(chatSessions.updatedAt, s.updatedAt), eq(chatSessions.pinned, 0)))
        .returning({ id: chatSessions.id });
      if (res.length === 0) { skip('recent'); continue; }
      archived.push({ id: s.id, name: s.name || s.autoTitle || 'Chat', agentId: s.agentId });
    }
    await this.announce(archived);
    return { archived, skipped };
  }

  /** One read inbox event per agent naming the chats the sweep archived. */
  private async announce(archived: Array<{ id: string; name: string; agentId: string | null }>): Promise<void> {
    if (!this.agentsSvc || archived.length === 0) return;
    const byAgent = new Map<string, string[]>();
    for (const a of archived) if (a.agentId) byAgent.set(a.agentId, [...(byAgent.get(a.agentId) ?? []), a.name]);
    for (const [agentId, names] of byAgent) {
      try {
        const ev = await this.agentsSvc.addEvent(agentId, {
          kind: 'info',
          title: `Archived ${names.length} finished-task chat${names.length === 1 ? '' : 's'}`,
          body: `${names.slice(0, 10).map((n) => `“${n}”`).join(', ')}${names.length > 10 ? ` and ${names.length - 10} more` : ''} — their tasks were finished and the chats had gone quiet. Restore any from the Archived group; auto-archive is set per chat in its header.`,
          silent: true,
          origin: 'system',
        });
        // Housekeeping, not news: in the inbox's history, never a badge.
        await this.agentsSvc.patchEvent(ev.id, { readAt: nowIso() });
      } catch (err) {
        this.logger.warn(`auto-archive event for ${agentId} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.logger.log(`auto-archived ${archived.length} finished-task chat(s)`);
  }
}

