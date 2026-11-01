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
    }
    return this.repo.createSession(input);
  }

  async update(id: string, patch: Partial<Pick<ChatSession, 'name' | 'draft' | 'permissionMode' | 'thinkingEffort' | 'model' | 'agentTypeId' | 'tokenCeiling' | 'cwd'>> & { pinned?: boolean; tags?: string[] }) {
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
    const handoff = { task: `[${task.id.slice(0, 8)}] ${task.title}`.slice(0, 140), taskId: task.id, at: nowIso() };
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
