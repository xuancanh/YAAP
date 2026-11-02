/**
 * The follow tools (docs/follows.md): `follow`, `unfollow` and
 * `list_follows`, offered to every durable agent's session — in a private
 * chat, a channel wake, an org run or a heartbeat alike — through
 * `TurnLoopService.addToolProvider`. They change only the agent's own
 * follow rows, so they are classed `read` (actions/action-classes.ts) and
 * run without approval. Ids resolve inside the session's workspace only.
 */
import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { ChatSession } from '../chats/chats.repository';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { FollowsService, labelOf, type FollowTargetKind } from './follows.service';

const KIND_ID = {
  kind: { type: 'string', enum: ['thread', 'task'], description: 'thread: a channel thread (any message id in it, as channel_read shows it); task: an org task or a kanban task, by its key (ENG-12) as the board shows it.' },
  id: { type: 'string', description: 'The message id, or the task key (e.g. ENG-12; an id prefix still works).' },
};

export const FOLLOW_TOOLS: AiToolSpec[] = [
  {
    name: 'follow',
    description: 'Follow a channel thread or a task so its changes reach you: new replies and updates appear in your heartbeat under "Following", and you are woken when it needs you (blocked, review requested, reopened, a comment naming you). You already follow what you started, commented on, own, were assigned, review or were mentioned in; use this for anything else you need to track.',
    inputSchema: { type: 'object', properties: KIND_ID, required: ['kind', 'id'] },
  },
  {
    name: 'unfollow',
    description: 'Stop following a thread or task (including one you follow automatically). It stays unfollowed: replying or being assigned later does not re-follow it; follow again to undo.',
    inputSchema: { type: 'object', properties: KIND_ID, required: ['kind', 'id'] },
  },
  {
    name: 'list_follows',
    description: 'List the threads and tasks you follow, why, and what is new on each since you last looked.',
    inputSchema: { type: 'object', properties: {} },
  },
];
const NAMES = new Set(FOLLOW_TOOLS.map((t) => t.name));

@Injectable()
export class FollowsTools implements ToolProviderHook, OnModuleInit {
  constructor(
    private readonly follows: FollowsService,
    @Optional() private readonly turns?: TurnLoopService,
  ) {}

  onModuleInit(): void { this.turns?.addToolProvider(this); }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> { return session.agentId ? FOLLOW_TOOLS : []; }

  owns(name: string): boolean { return NAMES.has(name); }

  isReadOnly(name: string): boolean { return NAMES.has(name); }

  async contextFor(): Promise<string | null> { return null; }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    const agentId = session.agentId;
    if (!agentId) throw new Error(`${name} is only available to durable agents`);
    const me = { kind: 'agent' as const, id: agentId };
    if (name === 'list_follows') {
      const rows = await this.follows.list(me, session.workspaceId);
      if (rows.length === 0) return 'You follow nothing yet.';
      return rows.slice(0, 50).map((r) => {
        const label = labelOf(r.targetKind as FollowTargetKind, r.targetId, r.title);
        const fresh = r.unseenCount > 0 ? ` — ${r.unseenCount} new, last from ${r.lastActorName || 'someone'}: ${r.lastActivity}` : ' — nothing new';
        return `${label} (${r.reason})${fresh}${r.attention ? ` [needs you: ${r.attention}]` : ''}${r.closedAt ? ' (closed)' : ''}`;
      }).join('\n');
    }
    const target = await this.follows.resolve(session.workspaceId, String(input.kind ?? ''), String(input.id ?? ''), agentId);
    const label = labelOf(target.kind, target.id, target.title ?? '');
    if (name === 'follow') {
      await this.follows.follow(target, me);
      return `Following ${label}. Its changes appear in your heartbeat under "Following".`;
    }
    await this.follows.unfollow(target, me);
    return `Unfollowed ${label}. It stays unfollowed until you follow it again.`;
  }
}
