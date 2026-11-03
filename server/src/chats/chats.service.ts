/**
 * ChatsService — chat session lifecycle (§1) and per-session operations that
 * are not the turn loop: rename/pin/tags/archive, drafts, permission mode,
 * /clear, and markdown export (FR-6.7).
 */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { currentViewer } from '../accounts/account-context';
import { ChatsRepository, ChatSession } from './chats.repository';
import { nowIso } from '../common/ids.util';
import { AgentsService } from '../agents/agents.service';
import { SkillsService } from '../skills/skills.service';
import { RegistryService } from '../registry/registry.service';
import { taskRef } from '../common/task-keys';
import { OWNER_DM_TAG } from './session-kind';

@Injectable()
export class ChatsService {
  constructor(
    private readonly repo: ChatsRepository,
    private readonly agents: AgentsService,
    /** Optional so test constructors without skills keep working. */
    @Optional() private readonly skills?: SkillsService,
    /** Optional for the same reason: ratings roll up to registry items. */
    @Optional() private readonly registry?: RegistryService,
  ) {}

  list(workspaceId: string, archived = false) {
    return this.repo.listSessions(workspaceId, { archived });
  }

  /** The Home rail in one call (docs/chat-archiving.md "The rail"): per agent
   *  (key '' = the workspace's agent-less chats) the chat count, the first
   *  `limits[key] ?? perAgent` chats (pinned first, newest next) with the
   *  cursor of the next page, the chats waiting on an approval, and — for
   *  the agent's own runs, which are not chat rows (docs/work-log.md) — how
   *  many work sessions it has and which of them wait on an approval; plus
   *  the archived chat count. With `q`, only matching chats count and show,
   *  so a search reaches into collapsed groups. */
  async rail(workspaceId: string, opts: { perAgent?: number; limits?: Record<string, number>; q?: string } = {}) {
    const perAgent = Math.max(1, Math.min(100, Math.floor(opts.perAgent ?? 5)));
    const q = (opts.q ?? '').trim();
    const counts = await this.repo.railCounts(workspaceId, { q });
    const approvals = await this.repo.approvalSessions(workspaceId);
    const groups = await Promise.all([...counts.entries()].map(async ([key, c]) => {
      const agentId = key || null;
      const limit = Math.max(1, Math.min(500, Math.floor(opts.limits?.[key] ?? perAgent)));
      const page = c.chats > 0 ? await this.repo.pageSessions(workspaceId, { agentId, kind: 'chat', q, limit }) : { items: [], nextCursor: null };
      const a = approvals.get(key);
      return { agentId, total: c.chats, items: page.items, nextCursor: page.nextCursor, approvalIds: a?.chat ?? [], work: { total: c.work, approvalIds: a?.work ?? [] } };
    }));
    let archivedTotal = 0;
    for (const c of (await this.repo.railCounts(workspaceId, { archived: true, q })).values()) archivedTotal += c.chats;
    return { groups, archivedTotal };
  }

  /** One page of the rail: an agent's chats ('none' = agent-less) or the
   *  archived ones. Chats only — the agents' runs page through the Work log. */
  page(workspaceId: string, opts: { agentId?: string | null; archived?: boolean; q?: string; limit?: number; cursor?: string | null }) {
    return this.repo.pageSessions(workspaceId, { ...opts, kind: 'chat' });
  }

  /**
   * The agent's owner DM: the one conversation its messages to the owner
   * land in (`message_owner`, docs/work-log.md). A `chat` session tagged
   * `owner-dm`, the owner's own (initiatedBy ''), created on first use.
   * Always a chat — never a work session — so what an agent says to its
   * owner shows in the rail, not the Work log.
   */
  async ownerChatFor(agentId: string): Promise<ChatSession> {
    const agent = await this.agents.get(agentId);
    const workspaceId = (agent as { workspaceId?: string }).workspaceId ?? '';
    if (!workspaceId) throw new BadRequestException(`${agent.name} belongs to no workspace`);
    const found = await this.repo.findTaggedChat(workspaceId, agentId, OWNER_DM_TAG);
    if (found) return found;
    const pinnedType = (agent as { agentTypeId?: string | null }).agentTypeId ?? null;
    return this.repo.createSession({
      workspaceId, agentId, name: agent.name, kind: 'chat', permissionMode: 'ask',
      initiatedBy: '', shared: 0, tags: JSON.stringify([OWNER_DM_TAG]),
      ...(pinnedType ? { agentTypeId: pinnedType, model: agent.model || '' } : {}),
    });
  }

  /** A member of a shared workspace may open shared sessions and their own;
   *  a private session of someone else is a 404 to them, not a 403 — its
   *  existence is theirs to disclose. */
  async get(id: string): Promise<ChatSession> {
    const s = await this.repo.getSession(id);
    if (!s || !this.repo.canView(s)) throw new NotFoundException(`chat ${id}`);
    return s;
  }

  /** Share a session with every member, or make it private again. Only its
   *  creator or the owner may flip it. */
  async setShared(id: string, shared: boolean): Promise<ChatSession> {
    const s = await this.get(id);
    const viewer = currentViewer();
    if (viewer && viewer.role !== 'owner' && s.initiatedBy !== viewer.memberAccountId) throw new ForbiddenException('only the session creator or the owner can share it');
    await this.repo.updateSession(id, { shared: shared ? 1 : 0 });
    return this.get(id);
  }

  async create(input: { workspaceId: string; name?: string; cwd?: string; agentId?: string; agentTypeId?: string; model?: string; tokenCeiling?: number }) {
    if (input.agentId) {
      // Agents belong to one workspace (execution-plan item 26): a chat in
      // workspace A never runs an agent of workspace B.
      const agent = await this.agents.get(input.agentId);
      const owner = (agent as { workspaceId?: string }).workspaceId;
      if (owner && owner !== input.workspaceId) throw new BadRequestException(`${agent.name} belongs to another workspace; move it first or pick an agent of this workspace`);
      const pinnedType = (agent as { agentTypeId?: string | null }).agentTypeId;
      if (pinnedType && !input.agentTypeId) return this.repo.createSession({ ...input, kind: 'chat', agentTypeId: pinnedType, model: input.model || agent.model || '' });
    }
    return this.repo.createSession({ ...input, kind: 'chat' });
  }

  async update(id: string, patch: Partial<Pick<ChatSession, 'name' | 'draft' | 'permissionMode' | 'thinkingEffort' | 'model' | 'agentTypeId' | 'tokenCeiling' | 'cwd' | 'autoArchiveDays'>> & { pinned?: boolean; tags?: string[] }) {
    await this.get(id);
    const set: Record<string, unknown> = { ...patch };
    if (patch.pinned !== undefined) set.pinned = patch.pinned ? 1 : 0;
    if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags);
    await this.repo.updateSession(id, set);
    return this.get(id);
  }

  async archive(id: string) {
    await this.get(id);
    await this.repo.updateSession(id, { archivedAt: new Date().toISOString() });
    return this.get(id);
  }

  async restore(id: string) {
    await this.get(id);
    await this.repo.updateSession(id, { archivedAt: null });
    return this.get(id);
  }

  async remove(id: string) {
    await this.get(id);
    await this.repo.deleteSession(id);
    return { ok: true };
  }

  async transcript(id: string) {
    await this.get(id);
    return {
      messages: await this.repo.listMessages(id),
      turns: await this.repo.listTurns(id),
    };
  }

  /** /clear — wipe transcript and private context (FR-2.4). */
  async clear(id: string) {
    await this.get(id);
    await this.repo.clearMessages(id);
    const cur = await this.repo.getSession(id);
    await this.repo.updateSession(id, { compactSummary: '', compactCutoff: null, tokensAtCompact: cur ? cur.tokensIn + cur.tokensOut : 0 });
    return { ok: true };
  }

  /** /export — the conversation as markdown (FR-6.7). */
  async exportMarkdown(id: string): Promise<string> {
    const s = await this.get(id);
    const title = s.name || s.autoTitle || 'Conversation';
    const lines = [`# ${title}`, ''];
    for (const m of await this.repo.listMessages(id)) {
      if (m.role === 'thinking') continue;
      const who = m.role === 'user' ? 'User' : m.role === 'tool' ? `Tool (${m.toolName ?? '?'})` : 'Assistant';
      lines.push(`## ${who}`, '', m.content, '');
    }
    return lines.join('\n');
  }

  /** Fork a new session from this one, optionally branching at a turn; the
   *  original stays intact (FR-6.3). The fork row and transcript copy commit
   *  together (see repo.forkSession). */
  async fork(id: string, turnId?: string) {
    const src = await this.get(id);
    let upTo: number | null = null;
    if (turnId) {
      const turn = await this.repo.getTurn(turnId);
      if (!turn || turn.sessionId !== id) throw new NotFoundException(`turn ${turnId}`);
      upTo = turn.seq;
    }
    const forked = await this.repo.forkSession(src, upTo);
    return this.get(forked.id);
  }

  /** Edit & resend / retry: drop this turn and everything after it (FR-6.1/6.2).
   *  Returns the removed turn's input so the client can restore it. */
  async truncateFrom(id: string, turnId: string) {
    await this.get(id);
    const turn = await this.repo.getTurn(turnId);
    if (!turn || turn.sessionId !== id) throw new NotFoundException(`turn ${turnId}`);
    await this.repo.truncateFromTurn(id, turn.seq);
    return { ok: true, input: turn.input };
  }

  /** Promote a turn onto the owning agent's kanban board (FR-6.4). */
  async promoteTurn(id: string, turnId: string) {
    const session = await this.get(id);
    const turn = await this.repo.getTurn(turnId);
    if (!turn || turn.sessionId !== id) throw new NotFoundException(`turn ${turnId}`);
    if (!session.agentId) throw new BadRequestException('only chats owned by a durable agent can promote turns to its board');
    const task = await this.agents.addTask(session.agentId, {
      title: turn.input.replace(/\s+/g, ' ').slice(0, 120),
      note: `Promoted from the chat "${session.name || session.autoTitle || 'untitled'}".`,
      origin: 'promote',
      sessionId: id,
    });
    // A chat with no task yet becomes this task's chat (docs/chat-archiving.md):
    // it can auto-archive once the task is finished and the chat is quiet.
    if (!session.taskId) {
      const agent = await this.agents.get(session.agentId).catch(() => null);
      const days = (agent as { chatAutoArchiveDays?: number | null } | null)?.chatAutoArchiveDays ?? null;
      await this.repo.updateSession(id, { taskKind: 'agent', taskId: task.id, autoArchiveDays: session.autoArchiveDays ?? days });
    }
    const handoff = { task: `${taskRef(task)} ${task.title}`.slice(0, 140), taskId: task.id, at: nowIso() };
    await this.repo.updateTurn(turnId, { taskHandoff: JSON.stringify(handoff) });
    return handoff;
  }

  async rateTurn(sessionId: string, turnId: string, rating: 'up' | 'down', note?: string) {
    const session = await this.get(sessionId);
    const turn = await this.repo.getTurn(turnId);
    if (!turn || turn.sessionId !== sessionId) throw new NotFoundException(`turn ${turnId}`);
    await this.repo.updateTurn(turnId, { rating, ratingNote: note ?? null });
    // The rating also lands on every skill the turn loaded (execution-plan
    // item 10): outcome row + aggregate counters, and the agent learns which
    // skill was involved so it can propose a revision (revise_skill).
    let skillsUsed: Array<{ id: string; name: string }> = [];
    const ids = parseIds(turn.skillsUsed);
    if (ids.length > 0 && this.skills) {
      const rows = await this.skills.recordOutcome(ids, turnId, rating, note).catch(() => []);
      skillsUsed = rows.map((s) => ({ id: s.id, name: s.name }));
    }
    // …and to the registry items the agent or those skills were installed
    // from (execution-plan item 12): the market's ratings are the feedback
    // we already collect, never a separate star widget.
    if (this.registry) {
      await this.registry.recordTurnRating({ agentId: session.agentId ?? null, skillIds: ids, turnId, rating, note }).catch(() => {});
    }
    // For durable agents the rating is recorded and surfaced on the next
    // reply (FR-6.5).
    if (session.agentId) {
      await this.agents.addFeedback(session.agentId, { rating, note, turnId, ...(skillsUsed.length ? { skills: skillsUsed } : {}) }).catch(() => {});
    }
    return { ok: true, skills: skillsUsed };
  }
}

function parseIds(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
