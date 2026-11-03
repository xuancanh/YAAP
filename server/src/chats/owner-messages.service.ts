/**
 * OwnerMessagesService — agents message the owner directly
 * (docs/agent-messages.md).
 *
 * The tool `message_owner { text, urgency?, refs? }` posts the agent's
 * message into its direct chat with the owner (ChatsService.ownerChatFor:
 * one owner-private chat per agent, tagged `owner-dm`, always kind `chat`
 * — never a loop, heartbeat, org run or task session; session-kind.ts holds
 * the one classification rule). The message is an assistant
 * row marked `toolName: message_owner`, so it renders as the agent's, never
 * as the owner's, through the same React-element markdown as every answer
 * (no raw HTML). The owner's reply in that chat is an ordinary turn.
 *
 * Every message is also an `agent_message` inbox event: Home's "Messages
 * from your team", the Inbox's Messages filter and its badge read it, and
 * Telegram / web push deliver it under the workspace's quiet hours —
 * `fyi` is inbox-only, `normal` follows the quiet-hours policy, `urgent`
 * goes out inside the window only when the policy is `allow-urgent`.
 *
 * Guardrails: a per-agent daily cap (`seat.agentMessagesPerDay`), the same
 * text is not sent twice within `seat.agentMessageDedupeHours`, and an
 * agent cannot message from the DM itself (it is already talking to the
 * owner there). Both keys sit under `seat.*`, so an agent can only propose
 * changing them (docs/boundary.md). The tool only talks to the owner: it
 * is free internal work (actions/action-classes.ts).
 */
import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentEvents, agents, chatMessages, chatSessions, organizations, workspaces } from '../database/schema';
import { nowIso } from '../common/ids.util';
import { ChatsRepository, type ChatSession } from './chats.repository';
import { TurnLoopService, type ToolProviderHook } from './turn-loop.service';
import { AgentsService } from '../agents/agents.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { deliveryFor } from '../workspaces/quiet-hours';
import { registerTunables, tunable, type TunableDef } from '../org/org-tunables';
import { ChatsService } from './chats.service';
import { OWNER_DM_TAG } from './session-kind';

export const MESSAGE_OWNER_TOOL = 'message_owner';
export const AGENT_MESSAGE_KIND = 'agent_message';
export type MessageUrgency = 'fyi' | 'normal' | 'urgent';
export const MESSAGE_URGENCIES: readonly MessageUrgency[] = ['fyi', 'normal', 'urgent'];
const MAX_TEXT = 4_000;
const MAX_REFS = 10;
const DAY_MS = 24 * 3_600_000;

export const AGENT_MESSAGE_TUNABLES: Record<string, TunableDef> = {
  'seat.agentMessagesPerDay': { default: 10, min: 0, max: 100, area: 'seat', description: 'Messages one agent may send the owner with message_owner in any 24 hours; 0 turns direct messages off.' },
  'seat.agentMessageDedupeHours': { default: 24, min: 0, max: 168, area: 'seat', description: 'Hours within which an agent may not send the owner the same message text again; 0 = no dedupe.' },
};
registerTunables(AGENT_MESSAGE_TUNABLES);

export const MESSAGE_OWNER_SPECS: AiToolSpec[] = [{
  name: MESSAGE_OWNER_TOOL,
  description: 'Message the owner (the CEO) directly: the text lands in your direct chat with them, notifies them (Inbox, Home, and their phone unless quiet hours hold it) and they can reply there. Use it for something they should know or decide that does not fit a task, an escalation or your report — not for routine progress. Keep it short and self-contained; say what you need from them. Limited per day; the same text is not sent twice.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The message, plain language (markdown allowed). Up to 4000 characters.' },
      urgency: { type: 'string', enum: [...MESSAGE_URGENCIES], description: '"fyi" (Inbox only, no push), "normal" (default; pushed outside quiet hours) or "urgent" (pushed at once; inside quiet hours only if the workspace allows urgent interruptions).' },
      refs: { type: 'array', items: { type: 'string' }, description: 'Optional: task keys (e.g. OPS-12) or file paths the message is about.' },
    },
    required: ['text'],
  },
}];

export interface AgentMessageItem {
  /** The chat message id. */
  id: string;
  /** The inbox event that announced it (null when it was pruned). */
  eventId: string | null;
  agentId: string; agentName: string; emoji: string; colors: string;
  text: string; urgency: MessageUrgency; refs: string[];
  sessionId: string; createdAt: string; read: boolean;
}

interface MessageMeta { urgency: MessageUrgency; refs: string[]; messageId?: string }

function metaOf(payload: string | null | undefined): Partial<MessageMeta> {
  try { return (JSON.parse(payload || '{}') as Partial<MessageMeta>) ?? {}; } catch { return {}; }
}

const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const hashOf = (s: string) => createHash('sha256').update(normalize(s)).digest('hex');

/** The stored message: the text, then a refs line. The text is data. */
export function composeMessage(text: string, refs: string[]): string {
  return refs.length ? `${text}\n\nRefs: ${refs.join(', ')}` : text;
}

@Injectable()
export class OwnerMessagesService implements ToolProviderHook, OnModuleInit {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly repo: ChatsRepository,
    private readonly agentsSvc: AgentsService,
    /** The owner DM is ChatsService.ownerChatFor: one rule for which chat it is (docs/work-log.md). */
    private readonly chats: ChatsService,
    @Optional() private readonly turns?: TurnLoopService,
  ) {}

  onModuleInit(): void { this.turns?.addToolProvider(this); }

  // ---- the tool hook ----

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> { return session.agentId ? MESSAGE_OWNER_SPECS : []; }
  owns(name: string): boolean { return name === MESSAGE_OWNER_TOOL; }
  isReadOnly(): boolean { return false; }
  async contextFor(): Promise<string | null> { return null; }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (name !== MESSAGE_OWNER_TOOL) throw new Error(`unknown tool: ${name}`);
    const r = await this.send(session, input);
    return r.summary;
  }

  // ---- reads shared by the tool, Home and the Inbox ----

  /** The workspace's organization row (its tunables), or null. */
  private async orgOf(workspaceId: string): Promise<{ tunables: string } | null> {
    const rows = await this.db.select({ tunables: organizations.tunables, status: organizations.status }).from(organizations).where(eq(organizations.workspaceId, workspaceId));
    return rows.find((r) => r.status !== 'archived') ?? null;
  }

  /** Sessions of a workspace without the viewer filter (the DM is the owner's whoever is acting). */
  /** This agent's message_owner rows since `since` (the cap and dedupe count these, not inbox events, which are pruned). */
  private async sentSince(agentId: string, since: string): Promise<Array<{ content: string; createdAt: string }>> {
    return this.db.select({ content: chatMessages.content, createdAt: chatMessages.createdAt }).from(chatMessages)
      .innerJoin(chatSessions, eq(chatSessions.id, chatMessages.sessionId))
      .where(and(eq(chatSessions.agentId, agentId), eq(chatMessages.toolName, MESSAGE_OWNER_TOOL), gte(chatMessages.createdAt, since)));
  }

  // ---- send ----

  async send(session: Pick<ChatSession, 'id' | 'agentId' | 'workspaceId' | 'tags'>, input: Record<string, unknown>, now: Date = new Date()): Promise<{ sessionId: string; messageId: string; eventId: string; delivery: 'now' | 'queued' | 'inbox'; summary: string }> {
    const agentId = session.agentId;
    if (!agentId) throw new Error('message_owner is only available to durable agents');
    const agent = await this.agentsSvc.get(agentId);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) throw new Error('text is required: the message to the owner');
    if (text.length > MAX_TEXT) throw new Error(`text is ${text.length} characters; keep a message to the owner under ${MAX_TEXT} (put the detail in a file and pass its path in refs)`);
    const urgencyRaw = typeof input.urgency === 'string' && input.urgency ? input.urgency.trim().toLowerCase() : 'normal';
    if (!(MESSAGE_URGENCIES as readonly string[]).includes(urgencyRaw)) throw new Error(`urgency must be one of ${MESSAGE_URGENCIES.join(', ')}`);
    const urgency = urgencyRaw as MessageUrgency;
    const refs = (Array.isArray(input.refs) ? input.refs : typeof input.refs === 'string' ? [input.refs] : [])
      .map((x) => String(x).trim().replace(/\s+/g, ' ').slice(0, 200)).filter(Boolean).slice(0, MAX_REFS);

    const workspaceId = agent.workspaceId || session.workspaceId;
    const dm = await this.repo.findTaggedChat(workspaceId, agentId, OWNER_DM_TAG);
    if (dm && dm.id === session.id) throw new Error('you are already in your direct chat with the owner — answer here instead of calling message_owner');

    const org = await this.orgOf(workspaceId);
    const cap = Math.round(tunable(org, 'seat.agentMessagesPerDay'));
    const dedupeHours = tunable(org, 'seat.agentMessageDedupeHours');
    const window = Math.max(DAY_MS, dedupeHours * 3_600_000);
    const recent = await this.sentSince(agentId, new Date(now.getTime() - window).toISOString());
    if (cap <= 0) throw new Error('refused: direct messages to the owner are turned off in this workspace (seat.agentMessagesPerDay is 0) — use your report or an escalation');
    const lastDay = recent.filter((m) => m.createdAt >= new Date(now.getTime() - DAY_MS).toISOString());
    if (lastDay.length >= cap) throw new Error(`refused: you have sent the owner ${lastDay.length} message${lastDay.length === 1 ? '' : 's'} in the last 24 hours, the limit is ${cap} (seat.agentMessagesPerDay) — put it in your next report or an escalation, or wait`);
    if (dedupeHours > 0) {
      const h = hashOf(composeMessage(text, refs));
      const dupe = recent.find((m) => m.createdAt >= new Date(now.getTime() - dedupeHours * 3_600_000).toISOString() && hashOf(m.content) === h);
      if (dupe) throw new Error(`not sent: you sent the owner this same message at ${dupe.createdAt.slice(0, 16).replace('T', ' ')} UTC — it is already in their Inbox; send something new or wait for their reply`);
    }

    // The DM: one human-facing chat per agent, created on first use.
    const chat = dm ?? (await this.chats.ownerChatFor(agentId));
    // An agent-initiated turn: no user message (nothing the owner said), one
    // assistant row the transcript renders as the agent's.
    const turn = await this.repo.createTurn(chat.id, { text: '' });
    const msg = await this.repo.appendMessage({ sessionId: chat.id, turnId: turn.id, role: 'assistant', content: composeMessage(text, refs), toolName: MESSAGE_OWNER_TOOL, authorAccountId: '' });
    await this.repo.updateTurn(turn.id, { status: 'done' });
    await this.repo.updateSession(chat.id, {}); // the rail sorts it to the top

    const ws = (await this.db.select({ quietHours: workspaces.quietHours }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)).at(0) ?? null;
    const delivery = urgency === 'fyi' ? { deliverAfter: null, silent: true } : deliveryFor(ws, urgency === 'urgent' ? 'agent_message_urgent' : AGENT_MESSAGE_KIND, now);
    const firstLine = text.split('\n').find((l) => l.trim())?.trim() ?? text;
    const ev = await this.agentsSvc.addEvent(agentId, {
      kind: AGENT_MESSAGE_KIND, title: `${urgency === 'urgent' ? 'Urgent: ' : ''}${firstLine}`.slice(0, 200), body: text.slice(0, 1_000), sessionId: chat.id,
      payload: JSON.stringify({ urgency, refs, messageId: msg.id }), origin: 'agent', channel: urgency !== 'fyi', ...delivery,
    });
    const when: 'now' | 'queued' | 'inbox' = delivery.silent ? 'inbox' : delivery.deliverAfter ? 'queued' : 'now';
    const how = when === 'inbox' ? 'It is in their Inbox (fyi: no push).'
      : when === 'queued' ? `Their quiet hours are on: it is in their Inbox now and reaches their phone at ${delivery.deliverAfter!.slice(11, 16)} UTC.`
        : 'It is in their Inbox and on its way to their phone.';
    return { sessionId: chat.id, messageId: msg.id, eventId: ev.id, delivery: when, summary: `Sent to the owner in your direct chat (${urgency}). ${how} Their reply comes back in that chat.` };
  }

  // ---- Home and the Inbox ----

  /** Messages agents of this workspace sent the owner, newest first, unread first; and the unread count. */
  async list(workspaceId: string, opts: { days?: number; limit?: number; now?: Date } = {}): Promise<{ items: AgentMessageItem[]; unread: number }> {
    const now = opts.now ?? new Date();
    const since = new Date(now.getTime() - (opts.days ?? 14) * DAY_MS).toISOString();
    const team = await this.db.select({ id: agents.id, name: agents.name, emoji: agents.emoji, colors: agents.colors }).from(agents).where(eq(agents.workspaceId, workspaceId));
    if (team.length === 0) return { items: [], unread: 0 };
    const byId = new Map(team.map((a) => [a.id, a]));
    const rows = await this.db.select({ id: chatMessages.id, content: chatMessages.content, createdAt: chatMessages.createdAt, sessionId: chatMessages.sessionId, agentId: chatSessions.agentId })
      .from(chatMessages).innerJoin(chatSessions, eq(chatSessions.id, chatMessages.sessionId))
      .where(and(eq(chatSessions.workspaceId, workspaceId), eq(chatMessages.toolName, MESSAGE_OWNER_TOOL), gte(chatMessages.createdAt, since)))
      .orderBy(desc(chatMessages.createdAt)).limit(Math.min(200, opts.limit ?? 50));
    const events = await this.db.select().from(agentEvents)
      .where(and(inArray(agentEvents.agentId, team.map((a) => a.id)), eq(agentEvents.kind, AGENT_MESSAGE_KIND)));
    const byMessage = new Map<string, typeof events[number]>();
    for (const e of events) { const m = metaOf(e.payload).messageId; if (m) byMessage.set(m, e); }
    const items: AgentMessageItem[] = rows.filter((r) => r.agentId && byId.has(r.agentId)).map((r) => {
      const a = byId.get(r.agentId!)!;
      const e = byMessage.get(r.id) ?? null;
      const meta = metaOf(e?.payload);
      const refsLine = r.content.match(/\n\nRefs: (.*)$/);
      return {
        id: r.id, eventId: e?.id ?? null, agentId: a.id, agentName: a.name, emoji: a.emoji, colors: a.colors,
        text: refsLine ? r.content.slice(0, refsLine.index) : r.content,
        urgency: (MESSAGE_URGENCIES as readonly string[]).includes(String(meta.urgency)) ? meta.urgency as MessageUrgency : 'normal',
        refs: Array.isArray(meta.refs) ? meta.refs.map(String) : refsLine ? refsLine[1].split(', ') : [],
        sessionId: r.sessionId, createdAt: r.createdAt, read: !e || e.readAt !== null,
      };
    });
    items.sort((x, y) => Number(x.read) - Number(y.read) || (x.createdAt < y.createdAt ? 1 : -1));
    const unread = events.filter((e) => e.readAt === null).length;
    return { items, unread };
  }

  /** Mark a message read: every unread message of the same DM (opening the chat reads them all). */
  async markRead(workspaceId: string, ref: { eventId?: string; sessionId?: string }): Promise<{ ok: true; marked: number }> {
    const team = (await this.db.select({ id: agents.id }).from(agents).where(eq(agents.workspaceId, workspaceId))).map((a) => a.id);
    if (team.length === 0) return { ok: true, marked: 0 };
    let sessionId = ref.sessionId ?? null;
    if (!sessionId && ref.eventId) {
      const e = (await this.db.select().from(agentEvents).where(eq(agentEvents.id, ref.eventId)).limit(1)).at(0);
      if (!e || !team.includes(e.agentId)) return { ok: true, marked: 0 };
      sessionId = e.sessionId;
    }
    if (!sessionId) return { ok: true, marked: 0 };
    const unread = await this.db.select({ id: agentEvents.id }).from(agentEvents)
      .where(and(inArray(agentEvents.agentId, team), eq(agentEvents.kind, AGENT_MESSAGE_KIND), eq(agentEvents.sessionId, sessionId), isNull(agentEvents.readAt)));
    if (unread.length) await this.db.update(agentEvents).set({ readAt: nowIso() }).where(inArray(agentEvents.id, unread.map((u) => u.id)));
    return { ok: true, marked: unread.length };
  }
}
