/**
 * GroupChatService — channels, members, messages, threads, reads, files and
 * the task linkage (docs/group-chat.md §1, §3, §4; execution-plan item 15).
 *
 * The data model is Slack's, scoped to a workspace: `#general` exists in
 * every workspace (created with the workspace, backfilled by migration 0029),
 * other channels are made by people, and both humans and agents are members.
 * This service is the persistence and policy layer; who *speaks* after a post
 * (mentions, unprompted replies, chains, budgets) is ChannelRuntimeService,
 * which registers itself through `onPosted`.
 *
 * Rules enforced here:
 *  - an agent posts only where it is a member (`channel_post` refused
 *    otherwise); a human posting in a public channel joins it; a private
 *    channel is invisible to non-members (404, not 403);
 *  - no agent may add itself to a channel: membership changes only through
 *    the HTTP routes, never a tool (§6);
 *  - a mention of a human is a notification, never authority: the event it
 *    creates is addressed to that person and delivered through their own
 *    paired channels with a deep link, under quiet hours;
 *  - a task made from a message records `channelId`/`messageId` on the task,
 *    and a status change posts a system line back into the thread.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents, channelMembers, channelMessages, channelReads, channels, workspaces } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { actorId, currentAccountId, currentViewer } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { StorageService } from '../storage/storage.service';
import { workspaceFileKey, relativePath } from '../storage/storage.keys';
import { deliveryFor } from '../workspaces/quiet-hours';
import { SharedService } from '../shared/shared.service';
import { TriggerBus, type TaskStatusEvent } from '../chats/trigger-bus';
import { OrgService } from '../org/org.service';
import { OrgTasksService } from '../org/org-tasks.service';
import { WorkspaceEventBus } from './workspace-events';
import { parseMentions, slugify, type Mention, type MentionableMember } from './mentions';

export type Channel = typeof channels.$inferSelect;
export type ChannelMember = typeof channelMembers.$inferSelect;
export type ChannelMessage = typeof channelMessages.$inferSelect;

export const GENERAL_SLUG = 'general';
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TEXT_CAP = 16_000;
const PAGE_LIMIT = 50;
const NOTIFY_MODES = ['all', 'mentions', 'none'] as const;

export interface Attachment { path: string; kind: string }

/** A member row with its display name, for mention parsing and the UI. */
export interface NamedMember extends ChannelMember { name: string; aliases: string[] }

export interface PostInput {
  text: string;
  threadRootId?: string | null;
  attachments?: Attachment[];
  authorKind: 'agent' | 'human' | 'system';
  authorId?: string;
  runId?: string | null;
  unprompted?: boolean;
}

export type PostedListener = (message: ChannelMessage, channel: Channel) => void;

@Injectable()
export class GroupChatService {
  private readonly postedListeners: PostedListener[] = [];

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly workspaces: WorkspacesService,
    private readonly agents: AgentsService,
    private readonly storage: StorageService,
    private readonly events: WorkspaceEventBus,
    @Optional() private readonly config?: ConfigService,
    /** Optional: without it the workspace has one human (the owner). */
    @Optional() private readonly shared?: SharedService,
    /** Optional: task status lines need the bus both task services emit on. */
    @Optional() bus?: TriggerBus,
    /** Optional: organisation mode routes "make task" to the shared board. */
    @Optional() private readonly org?: OrgService,
    @Optional() private readonly orgTasks?: OrgTasksService,
  ) {
    this.workspaces.onCreated(async (ws) => { await this.ensureGeneral(ws.id); });
    bus?.onTaskStatus((ev) => { void this.onTaskStatus(ev).catch(() => undefined); });
  }

  /** The runtime subscribes here; listeners run after the row is written. */
  onPosted(listener: PostedListener): () => void {
    this.postedListeners.push(listener);
    return () => { const i = this.postedListeners.indexOf(listener); if (i >= 0) this.postedListeners.splice(i, 1); };
  }

  // ---- channels ----

  /** `#general`: everyone in the workspace, people and agents. */
  ensureGeneral(workspaceId: string): Promise<Channel> {
    return this.ensureChannel(workspaceId, GENERAL_SLUG, 'general', { topic: 'Everyone in this workspace — people and agents.', allAgents: true, allHumans: true });
  }

  /**
   * Idempotent create-or-get by slug. The contract other domains use (the
   * organisation layer creates `#company` with it): `allAgents` adds every
   * agent in the account, `allHumans` the owner and every workspace member.
   */
  async ensureChannel(workspaceId: string, slug: string, name: string, opts: {
    topic?: string; kind?: 'public' | 'private'; createdBy?: string; allAgents?: boolean; allHumans?: boolean;
    agentIds?: string[]; humanIds?: string[]; unprompted?: boolean;
  } = {}): Promise<Channel> {
    const existing = await this.bySlug(workspaceId, slug).catch(() => null);
    if (existing) return existing;
    if (!SLUG_RE.test(slug)) throw new BadRequestException('slug must be lowercase letters, digits and dashes');
    const row: Channel = {
      accountId: currentAccountId(), id: newId(), workspaceId, slug, name: (name || slug).trim().slice(0, 80),
      topic: (opts.topic ?? '').slice(0, 500), kind: opts.kind ?? 'public', createdBy: opts.createdBy ?? 'system',
      folder: `channels/${slug}`, dailyTokenBudget: 0, archivedAt: null, createdAt: nowIso(),
    };
    await this.db.insert(channels).values(row);
    const agentIds = new Set(opts.agentIds ?? []);
    if (opts.allAgents) for (const a of await this.agents.list()) agentIds.add(a.id);
    for (const id of agentIds) await this.addMember(row.id, { kind: 'agent', id, unprompted: opts.unprompted ?? false }, { system: true }).catch(() => undefined);
    const humans = new Set(opts.humanIds ?? []);
    if (opts.allHumans) {
      humans.add(currentAccountId());
      if (this.shared) for (const m of await this.shared.members(workspaceId).catch(() => [])) humans.add(m.memberAccountId);
    }
    for (const id of humans) await this.addMember(row.id, { kind: 'human', id, role: id === currentAccountId() ? 'owner' : 'member' }, { system: true }).catch(() => undefined);
    this.events.emit({ type: 'channel_update', workspaceId, channelId: row.id });
    return row;
  }

  /** Channels the current actor may see: public ones plus private ones they
   *  belong to. Archived ones only when asked. */
  async list(workspaceId: string, opts: { archived?: boolean } = {}): Promise<Array<Channel & { unread: number; memberCount: number }>> {
    await this.ensureGeneral(workspaceId).catch(() => undefined);
    const rows = (await this.db.select().from(channels).where(eq(channels.workspaceId, workspaceId)))
      .filter((c) => (opts.archived ? c.archivedAt !== null : c.archivedAt === null));
    const me = actorId();
    const members = rows.length ? await this.db.select().from(channelMembers).where(inArray(channelMembers.channelId, rows.map((c) => c.id))) : [];
    const visible = rows.filter((c) => c.kind !== 'private' || members.some((m) => m.channelId === c.id && m.memberKind === 'human' && m.memberId === me));
    const unread = await this.unreadCounts(visible.map((c) => c.id));
    return visible
      .sort((a, b) => (a.slug === GENERAL_SLUG ? -1 : b.slug === GENERAL_SLUG ? 1 : a.name.localeCompare(b.name)))
      .map((c) => ({ ...c, unread: unread[c.id] ?? 0, memberCount: members.filter((m) => m.channelId === c.id).length }));
  }

  async get(channelId: string): Promise<Channel> {
    const c = (await this.db.select().from(channels).where(eq(channels.id, channelId)).limit(1)).at(0);
    if (!c) throw new NotFoundException(`channel ${channelId}`);
    return c;
  }

  async bySlug(workspaceId: string, slug: string): Promise<Channel> {
    const c = (await this.db.select().from(channels).where(and(eq(channels.workspaceId, workspaceId), eq(channels.slug, slug))).limit(1)).at(0);
    if (!c) throw new NotFoundException(`channel #${slug}`);
    return c;
  }

  /** A channel as the current human actor may open it: private → members only. */
  async open(workspaceId: string, slug: string): Promise<Channel> {
    const c = await this.bySlug(workspaceId, slug);
    if (c.kind === 'private' && !(await this.isMember(c.id, 'human', actorId()))) throw new NotFoundException(`channel #${slug}`);
    return c;
  }

  /** A person creates a channel; they own it, the workspace owner is added,
   *  and the named agents/humans join. */
  async create(workspaceId: string, input: { name: string; slug?: string; topic?: string; kind?: 'public' | 'private'; agentIds?: string[]; humanIds?: string[] }): Promise<Channel> {
    await this.workspaces.get(workspaceId);
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('channel name is required');
    const slug = (input.slug ? input.slug.trim().toLowerCase() : slugify(name));
    if (!SLUG_RE.test(slug)) throw new BadRequestException('slug must be lowercase letters, digits and dashes (max 48)');
    if (await this.bySlug(workspaceId, slug).catch(() => null)) throw new BadRequestException(`#${slug} already exists`);
    const me = actorId();
    const c = await this.ensureChannel(workspaceId, slug, name, {
      topic: input.topic, kind: input.kind ?? 'public', createdBy: `human:${me}`,
      agentIds: input.agentIds ?? [], humanIds: [me, currentAccountId(), ...(input.humanIds ?? [])],
    });
    // The creator owns it (ensureChannel gave the owner role to the account holder).
    await this.db.update(channelMembers).set({ role: 'owner' }).where(and(eq(channelMembers.channelId, c.id), eq(channelMembers.memberKind, 'human'), eq(channelMembers.memberId, me)));
    return c;
  }

  async update(channelId: string, patch: { name?: string; topic?: string; kind?: 'public' | 'private'; dailyTokenBudget?: number }): Promise<Channel> {
    const c = await this.get(channelId);
    await this.assertMayManage(c);
    const set: Partial<Channel> = {};
    if (patch.name !== undefined) { const n = patch.name.trim().slice(0, 80); if (!n) throw new BadRequestException('name cannot be empty'); set.name = n; }
    if (patch.topic !== undefined) set.topic = patch.topic.slice(0, 500);
    if (patch.kind !== undefined) { if (patch.kind !== 'public' && patch.kind !== 'private') throw new BadRequestException('kind must be public or private'); set.kind = patch.kind; }
    if (patch.dailyTokenBudget !== undefined) {
      if (!Number.isInteger(patch.dailyTokenBudget) || patch.dailyTokenBudget < 0) throw new BadRequestException('dailyTokenBudget must be a non-negative integer');
      set.dailyTokenBudget = patch.dailyTokenBudget;
    }
    if (Object.keys(set).length > 0) await this.db.update(channels).set(set).where(eq(channels.id, channelId));
    this.events.emit({ type: 'channel_update', workspaceId: c.workspaceId, channelId });
    return this.get(channelId);
  }

  async archive(channelId: string, archived = true): Promise<Channel> {
    const c = await this.get(channelId);
    await this.assertMayManage(c);
    if (c.slug === GENERAL_SLUG && archived) throw new BadRequestException('#general cannot be archived');
    await this.db.update(channels).set({ archivedAt: archived ? nowIso() : null }).where(eq(channels.id, channelId));
    this.events.emit({ type: 'channel_update', workspaceId: c.workspaceId, channelId });
    return this.get(channelId);
  }

  /** Channel owners and the workspace owner change settings and membership;
   *  other members may post, read and make tasks. */
  private async assertMayManage(c: Channel): Promise<void> {
    const viewer = currentViewer();
    if (!viewer || viewer.role === 'owner') return;
    const m = await this.member(c.id, 'human', viewer.memberAccountId);
    if (!m || m.role !== 'owner') throw new ForbiddenException('only a channel owner or the workspace owner can change this channel');
  }

  // ---- members ----

  async members(channelId: string): Promise<NamedMember[]> {
    const rows = await this.db.select().from(channelMembers).where(eq(channelMembers.channelId, channelId));
    const agentRows = await this.agents.list();
    const names = this.shared ? await this.shared.displayNames((await this.get(channelId)).workspaceId).catch(() => new Map<string, string>()) : new Map<string, string>();
    const owner = currentAccountId();
    return rows.map((m) => {
      if (m.memberKind === 'agent') {
        const a = agentRows.find((x) => x.id === m.memberId);
        return { ...m, name: a?.name ?? 'agent', aliases: [] };
      }
      const name = names.get(m.memberId) ?? (m.memberId === owner ? 'Owner' : m.memberId.slice(0, 8));
      return { ...m, name, aliases: [] };
    });
  }

  async member(channelId: string, kind: 'agent' | 'human', id: string): Promise<ChannelMember | null> {
    return (await this.db.select().from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.memberKind, kind), eq(channelMembers.memberId, id))).limit(1)).at(0) ?? null;
  }

  async isMember(channelId: string, kind: 'agent' | 'human', id: string): Promise<boolean> {
    return (await this.member(channelId, kind, id)) !== null;
  }

  /** Add a member. Only humans add members (the HTTP route); `system` is
   *  the create path. There is deliberately no tool for this. */
  async addMember(channelId: string, input: { kind: 'agent' | 'human'; id: string; role?: 'owner' | 'member'; notify?: string; unprompted?: boolean }, opts: { system?: boolean } = {}): Promise<ChannelMember> {
    const c = await this.get(channelId);
    if (!opts.system) await this.assertMayManage(c);
    if (input.kind !== 'agent' && input.kind !== 'human') throw new BadRequestException('kind must be agent or human');
    if (!input.id) throw new BadRequestException('member id is required');
    if (input.kind === 'agent') await this.agents.get(input.id); // 404 for an unknown agent
    const existing = await this.member(channelId, input.kind, input.id);
    if (existing) return existing;
    const row: ChannelMember = {
      accountId: currentAccountId(), id: newId(), channelId, memberKind: input.kind, memberId: input.id,
      role: input.role === 'owner' ? 'owner' : 'member',
      notify: input.notify && (NOTIFY_MODES as readonly string[]).includes(input.notify) ? input.notify : 'mentions',
      unprompted: input.kind === 'agent' && input.unprompted ? 1 : 0, joinedAt: nowIso(),
    };
    await this.db.insert(channelMembers).values(row);
    if (!opts.system) this.events.emit({ type: 'channel_update', workspaceId: c.workspaceId, channelId });
    return row;
  }

  async updateMember(channelId: string, kind: 'agent' | 'human', id: string, patch: { role?: 'owner' | 'member'; notify?: string; unprompted?: boolean }): Promise<ChannelMember> {
    const c = await this.get(channelId);
    // A person may change their own notify mode; everything else is management.
    const ownNotifyOnly = kind === 'human' && id === actorId() && patch.role === undefined && patch.unprompted === undefined;
    if (!ownNotifyOnly) await this.assertMayManage(c);
    const m = await this.member(channelId, kind, id);
    if (!m) throw new NotFoundException('member');
    const set: Partial<ChannelMember> = {};
    if (patch.role !== undefined) set.role = patch.role === 'owner' ? 'owner' : 'member';
    if (patch.notify !== undefined) { if (!(NOTIFY_MODES as readonly string[]).includes(patch.notify)) throw new BadRequestException('notify must be all, mentions or none'); set.notify = patch.notify; }
    if (patch.unprompted !== undefined) set.unprompted = kind === 'agent' && patch.unprompted ? 1 : 0;
    if (Object.keys(set).length > 0) await this.db.update(channelMembers).set(set).where(eq(channelMembers.id, m.id));
    this.events.emit({ type: 'channel_update', workspaceId: c.workspaceId, channelId });
    return { ...m, ...set };
  }

  async removeMember(channelId: string, kind: 'agent' | 'human', id: string): Promise<{ ok: true }> {
    const c = await this.get(channelId);
    if (!(kind === 'human' && id === actorId())) await this.assertMayManage(c); // leaving is always allowed
    if (c.slug === GENERAL_SLUG && kind === 'human') throw new BadRequestException('everyone belongs to #general');
    await this.db.delete(channelMembers).where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.memberKind, kind), eq(channelMembers.memberId, id)));
    this.events.emit({ type: 'channel_update', workspaceId: c.workspaceId, channelId });
    return { ok: true };
  }

  /** Members as mention targets (humans carry their email local part). */
  async mentionables(channelId: string): Promise<MentionableMember[]> {
    const rows = await this.members(channelId);
    const emails = new Map<string, string>();
    if (this.shared) {
      const ws = await this.get(channelId);
      for (const m of await this.shared.members(ws.workspaceId).catch(() => [])) if (m.email) emails.set(m.memberAccountId, m.email.split('@')[0]);
    }
    return rows.map((m) => ({
      kind: m.memberKind as 'agent' | 'human', id: m.memberId, name: m.name,
      aliases: m.memberKind === 'human' && emails.get(m.memberId) ? [emails.get(m.memberId)!] : [],
    }));
  }

  // ---- messages ----

  /** Top-level messages (newest page, oldest first) with reply counts, or a
   *  thread (its root followed by every reply). */
  async messages(channelId: string, opts: { thread?: string | null; before?: string; limit?: number } = {}): Promise<{ messages: ChannelMessage[]; replies: Record<string, { count: number; lastAt: string }>; hasMore: boolean }> {
    const limit = Math.min(200, Math.max(1, opts.limit ?? PAGE_LIMIT));
    if (opts.thread) {
      const root = (await this.db.select().from(channelMessages).where(and(eq(channelMessages.id, opts.thread), eq(channelMessages.channelId, channelId))).limit(1)).at(0);
      if (!root) throw new NotFoundException(`message ${opts.thread}`);
      const replies = await this.db.select().from(channelMessages).where(eq(channelMessages.threadRootId, root.id));
      return { messages: [root, ...replies.sort(byTime)], replies: {}, hasMore: false };
    }
    const conds = [eq(channelMessages.channelId, channelId), isNull(channelMessages.threadRootId)];
    if (opts.before) {
      const anchor = (await this.db.select().from(channelMessages).where(eq(channelMessages.id, opts.before)).limit(1)).at(0);
      if (anchor) conds.push(sql`${channelMessages.createdAt} < ${anchor.createdAt}`);
    }
    const page = await this.db.select().from(channelMessages).where(and(...conds)).orderBy(desc(channelMessages.createdAt)).limit(limit + 1);
    const hasMore = page.length > limit;
    const rows = page.slice(0, limit).sort(byTime);
    const replies: Record<string, { count: number; lastAt: string }> = {};
    if (rows.length > 0) {
      const agg = await this.db.select({ root: channelMessages.threadRootId, count: sql<number>`count(*)`, lastAt: sql<string>`max(${channelMessages.createdAt})` })
        .from(channelMessages).where(inArray(channelMessages.threadRootId, rows.map((r) => r.id))).groupBy(channelMessages.threadRootId);
      for (const a of agg) if (a.root) replies[a.root] = { count: Number(a.count), lastAt: a.lastAt };
    }
    return { messages: rows, replies, hasMore };
  }

  async message(messageId: string): Promise<ChannelMessage> {
    const m = (await this.db.select().from(channelMessages).where(eq(channelMessages.id, messageId)).limit(1)).at(0);
    if (!m) throw new NotFoundException(`message ${messageId}`);
    return m;
  }

  /** The most recent messages of a channel or thread, oldest first, for an
   *  agent's context window. */
  async recent(channelId: string, limit: number, thread?: string | null): Promise<ChannelMessage[]> {
    if (thread) return (await this.messages(channelId, { thread })).messages.slice(-limit);
    const rows = await this.db.select().from(channelMessages).where(eq(channelMessages.channelId, channelId)).orderBy(desc(channelMessages.createdAt)).limit(limit);
    return rows.sort(byTime);
  }

  /**
   * Post a message. Humans post as `actorId()` and join a public channel on
   * first post; an agent must already be a member; `system` lines carry no
   * author. Mentions are resolved against members; mentioned humans are
   * notified; `onPosted` listeners (the runtime) run after the write.
   */
  async post(channelId: string, input: PostInput): Promise<ChannelMessage> {
    const c = await this.get(channelId);
    if (c.archivedAt) throw new BadRequestException(`#${c.slug} is archived`);
    const text = (input.text ?? '').trim().slice(0, TEXT_CAP);
    const attachments = (input.attachments ?? []).slice(0, 8).map((a) => ({ path: String(a.path ?? ''), kind: String(a.kind ?? 'text') })).filter((a) => a.path);
    if (!text && attachments.length === 0) throw new BadRequestException('message text is required');
    let authorId = input.authorId ?? '';
    if (input.authorKind === 'human') {
      authorId = authorId || actorId();
      if (c.kind === 'private') { if (!(await this.isMember(c.id, 'human', authorId))) throw new NotFoundException(`channel #${c.slug}`); }
      else if (!(await this.isMember(c.id, 'human', authorId))) await this.addMember(c.id, { kind: 'human', id: authorId }, { system: true });
    } else if (input.authorKind === 'agent') {
      if (!authorId) throw new BadRequestException('agent author id is required');
      if (!(await this.isMember(c.id, 'agent', authorId))) throw new ForbiddenException(`agent is not a member of #${c.slug}`);
    } else if (input.authorKind !== 'system') {
      throw new BadRequestException('authorKind must be agent, human or system');
    }
    let threadRootId: string | null = input.threadRootId ?? null;
    if (threadRootId) {
      const root = await this.message(threadRootId);
      if (root.channelId !== c.id) throw new BadRequestException('thread root belongs to another channel');
      threadRootId = root.threadRootId ?? root.id; // replies to a reply stay in the root's thread
    }
    const mentions: Mention[] = input.authorKind === 'system' ? [] : parseMentions(text, await this.mentionables(c.id));
    const row: ChannelMessage = {
      accountId: currentAccountId(), id: newId(), channelId: c.id, threadRootId, authorKind: input.authorKind, authorId,
      text, attachments: JSON.stringify(attachments), mentions: JSON.stringify(mentions), taskId: null,
      runId: input.runId ?? null, unprompted: input.unprompted ? 1 : 0, editedAt: null, createdAt: nowIso(),
    };
    await this.db.insert(channelMessages).values(row);
    // The author has read their own message.
    if (input.authorKind === 'human') await this.markRead(c.id, row.id, authorId).catch(() => undefined);
    this.events.emit({ type: 'channel_message', workspaceId: c.workspaceId, channelId: c.id, message: row });
    if (input.authorKind !== 'system') await this.notifyHumans(c, row, mentions).catch(() => undefined);
    for (const l of this.postedListeners) { try { l(row, c); } catch { /* listeners isolate their failures */ } }
    return row;
  }

  /** A system line (task status, pauses, announcements). Also the contract the
   *  organisation layer uses to announce into `#company`. */
  postSystem(channelId: string, text: string, threadRootId?: string | null): Promise<ChannelMessage> {
    return this.post(channelId, { text, threadRootId: threadRootId ?? null, authorKind: 'system' });
  }

  /** A paired Telegram/email member (or the owner) posting `#slug text`. */
  async postFromPairedChannel(workspaceId: string, slug: string, text: string): Promise<ChannelMessage> {
    const c = await this.open(workspaceId, slug);
    return this.post(c.id, { text, authorKind: 'human' });
  }

  // ---- reads ----

  async markRead(channelId: string, messageId?: string, who: string = actorId()): Promise<{ ok: true }> {
    const c = await this.get(channelId);
    const at = messageId ? (await this.message(messageId)).createdAt : nowIso();
    const existing = (await this.db.select().from(channelReads).where(and(eq(channelReads.channelId, c.id), eq(channelReads.memberAccountId, who))).limit(1)).at(0);
    if (existing) {
      if (existing.lastReadAt < at) await this.db.update(channelReads).set({ lastReadMessageId: messageId ?? '', lastReadAt: at }).where(eq(channelReads.id, existing.id));
    } else {
      await this.db.insert(channelReads).values({ accountId: currentAccountId(), id: newId(), channelId: c.id, memberAccountId: who, lastReadMessageId: messageId ?? '', lastReadAt: at });
    }
    return { ok: true };
  }

  /** Unread message counts per channel for the current actor: messages newer
   *  than their read cursor, not their own, system lines excluded. */
  async unreadCounts(channelIds: string[], who: string = actorId()): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    if (channelIds.length === 0) return out;
    const reads = await this.db.select().from(channelReads).where(and(inArray(channelReads.channelId, channelIds), eq(channelReads.memberAccountId, who)));
    for (const id of channelIds) {
      const since = reads.find((r) => r.channelId === id)?.lastReadAt ?? '';
      const conds = [eq(channelMessages.channelId, id), sql`${channelMessages.authorKind} <> 'system'`, sql`NOT (${channelMessages.authorKind} = 'human' AND ${channelMessages.authorId} = ${who})`];
      if (since) conds.push(gt(channelMessages.createdAt, since));
      const n = await this.db.select({ count: sql<number>`count(*)` }).from(channelMessages).where(and(...conds));
      out[id] = Number(n[0]?.count ?? 0);
    }
    return out;
  }

  // ---- files ----

  folderOf(c: Channel): string {
    return (c.folder || `channels/${c.slug}`).replace(/^\/+|\/+$/g, '');
  }

  async files(channelId: string): Promise<Array<{ path: string; name: string; size: number; lastModified?: string }>> {
    const c = await this.get(channelId);
    const prefix = `${workspaceFileKey(c.workspaceId, this.folderOf(c))}/`;
    return (await this.storage.list(prefix)).map((o) => {
      const path = relativePath(c.workspaceId, o.key);
      return { path, name: path.slice(this.folderOf(c).length + 1), size: o.size, lastModified: o.lastModified };
    });
  }

  // ---- tasks (docs/group-chat.md §3) ----

  /** The active organisation of a workspace, when organisation mode is on. */
  async orgFor(workspaceId: string): Promise<{ id: string; status: string } | null> {
    if (!this.org || !this.orgTasks) return null;
    const list = await this.org.list(workspaceId).catch(() => []);
    return list.find((o) => o.status === 'active') ?? list[0] ?? null;
  }

  /**
   * Make a task from a message: the organisation board when the workspace
   * runs an organisation, else the assignee agent's kanban. Links both ways
   * and posts a system line into the message's thread.
   */
  async makeTask(channelId: string, messageId: string, input: { title?: string; assigneeAgentId?: string | null; by: { kind: 'human' | 'agent'; id: string } }): Promise<{ kind: 'org' | 'agent'; task: { id: string; title: string; status: string }; message: ChannelMessage }> {
    const c = await this.get(channelId);
    const m = await this.message(messageId);
    if (m.channelId !== c.id) throw new NotFoundException(`message ${messageId}`);
    if (input.by.kind === 'agent' && !(await this.isMember(c.id, 'agent', input.by.id))) throw new ForbiddenException(`agent is not a member of #${c.slug}`);
    const title = (input.title?.trim() || m.text.replace(/\s+/g, ' ').trim()).slice(0, 200);
    if (!title) throw new BadRequestException('task title is required');
    const members = await this.members(c.id);
    const agentMembers = members.filter((x) => x.memberKind === 'agent');
    let assignee = input.assigneeAgentId ?? null;
    if (assignee && !agentMembers.some((x) => x.memberId === assignee)) {
      // An assignee named by its name is accepted too.
      const byName = agentMembers.find((x) => x.name.toLowerCase() === String(assignee).toLowerCase());
      if (!byName) throw new BadRequestException('assignee must be an agent member of this channel');
      assignee = byName.memberId;
    }
    const thread = m.threadRootId ?? m.id;
    const note = `From #${c.slug}: "${m.text.replace(/\s+/g, ' ').slice(0, 500)}"`;
    const org = await this.orgFor(c.workspaceId);
    let task: { id: string; title: string; status: string };
    let kind: 'org' | 'agent';
    if (org && this.orgTasks) {
      kind = 'org';
      const orgMember = assignee ? await this.org!.member(org.id, assignee).catch(() => null) : null;
      const t = await this.orgTasks.create(org.id, {
        title, brief: { outcome: title, context: note },
        assigneeAgentId: orgMember && orgMember.status === 'active' ? assignee : null,
        createdBy: input.by.kind === 'agent' ? `agent:${input.by.id}` : 'user',
        channelId: c.id, messageId: m.id,
      });
      task = { id: t.id, title: t.title, status: t.status };
    } else {
      kind = 'agent';
      if (!assignee) assignee = m.authorKind === 'agent' ? m.authorId : (agentMembers[0]?.memberId ?? null);
      if (!assignee) throw new BadRequestException('this channel has no agent to assign the task to');
      const t = await this.agents.addTask(assignee, { title, note, origin: input.by.kind === 'agent' ? 'agent' : 'user', channelId: c.id, messageId: m.id });
      task = { id: t.id, title: t.title, status: t.status };
    }
    await this.db.update(channelMessages).set({ taskId: task.id }).where(eq(channelMessages.id, m.id));
    const updated = { ...m, taskId: task.id };
    this.events.emit({ type: 'channel_message', workspaceId: c.workspaceId, channelId: c.id, message: updated });
    const who = assignee ? ` for ${agentMembers.find((x) => x.memberId === assignee)?.name ?? 'an agent'}` : '';
    await this.postSystem(c.id, `Task [${task.id.slice(0, 8)}] "${task.title}" created${who} on the ${kind === 'org' ? 'company board' : 'kanban'} · ${task.status}`, thread);
    this.events.emit({ type: 'task_update', workspaceId: c.workspaceId, channelId: c.id, taskId: task.id, status: task.status, messageId: m.id, title: task.title });
    return { kind, task, message: updated };
  }

  /** A linked task changed status: say so in the originating thread. */
  private async onTaskStatus(ev: TaskStatusEvent): Promise<void> {
    const c = await this.get(ev.channelId).catch(() => null);
    if (!c || c.archivedAt) return;
    const origin = ev.messageId ? await this.message(ev.messageId).catch(() => null) : null;
    const thread = origin ? (origin.threadRootId ?? origin.id) : null;
    await this.postSystem(c.id, `Task [${ev.taskId.slice(0, 8)}] "${ev.title}" → ${ev.status.replace(/_/g, ' ')}`, thread);
    this.events.emit({ type: 'task_update', workspaceId: c.workspaceId, channelId: c.id, taskId: ev.taskId, status: ev.status, messageId: ev.messageId, title: ev.title });
  }

  // ---- notifications (docs/group-chat.md §4) ----

  /** Mentioned humans (and `notify = all` members) get an inbox event
   *  addressed to them, delivered through their paired Telegram/email/push
   *  with the deep link, under the workspace's quiet hours. */
  private async notifyHumans(c: Channel, m: ChannelMessage, mentions: Mention[]): Promise<void> {
    const members = await this.members(c.id);
    const humans = members.filter((x) => x.memberKind === 'human' && x.notify !== 'none');
    const mentioned = new Set(mentions.filter((x) => x.kind === 'human').map((x) => x.id));
    const targets = humans.filter((h) => (mentioned.has(h.memberId) || h.notify === 'all') && !(m.authorKind === 'human' && m.authorId === h.memberId));
    if (targets.length === 0) return;
    const ws = (await this.db.select().from(workspaces).where(eq(workspaces.id, c.workspaceId)).limit(1)).at(0) ?? null;
    const author = m.authorKind === 'agent'
      ? ((await this.db.select({ name: agents.name }).from(agents).where(eq(agents.id, m.authorId)).limit(1)).at(0)?.name ?? 'agent')
      : (members.find((x) => x.memberKind === 'human' && x.memberId === m.authorId)?.name ?? 'someone');
    const base = (this.config?.get<string>('publicAppUrl') ?? 'http://localhost:5175').replace(/\/+$/, '');
    const link = `${base}/#/ws/${c.workspaceId}/channel/${c.slug}/${m.id}`;
    const owner = currentAccountId();
    for (const h of targets) {
      const isMention = mentioned.has(h.memberId);
      await this.agents.addEvent(`channel:${c.id}`, {
        kind: 'mention',
        title: `#${c.slug} · ${author}${isMention ? ' mentioned you' : ''}`,
        body: m.text.replace(/\s+/g, ' ').slice(0, 400),
        payload: JSON.stringify({ link, from: `#${c.slug}`, channelId: c.id, messageId: m.id, mention: isMention }),
        origin: 'user',
        channel: true,
        // The owner's events are the account's own ('' addressee); a member's
        // are addressed to them and travel through their pairings.
        forMemberAccountId: h.memberId === owner ? '' : h.memberId,
        ...deliveryFor(ws, 'mention'),
      }).catch(() => undefined);
    }
  }
}

function byTime(a: ChannelMessage, b: ChannelMessage): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id);
}
