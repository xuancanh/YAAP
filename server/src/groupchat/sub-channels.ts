/**
 * Sub-channels (docs/group-chat.md §9): a temporary child channel for a
 * meeting or a discussion, so the parent channel keeps a single link card
 * instead of the whole conversation.
 *
 * A sub-channel is an ordinary `channels` row with `channelKind = 'sub'`
 * and a `parentChannelId` — so every channel rule holds inside it (posting,
 * mentions and wakes, unprompted replies, the chain cap, threads, files,
 * tasks, the daily budget counted with its parent's) — plus a lifecycle:
 *
 *  - **start** (a person's "Start a discussion", an agent's
 *    `channel_start_discussion`, a meeting, the runtime moving an agent
 *    ping-pong): members default to the parent's (or a chosen subset of
 *    them), visibility follows the parent (private parent → private sub),
 *    the folder is `<parent folder>/sub/<slug>/`, and the parent gets ONE
 *    system message — the link card — that is updated in place;
 *  - **activity** refreshes `lastActivityAt` (the auto-close clock) and the
 *    card (throttled), and counts for the sub-channel's followers (every
 *    member follows it);
 *  - **close** (its starter, a channel owner or the workspace owner; the
 *    meeting's end; `discussion.autoCloseHours` of silence) makes it
 *    read-only, writes the outcome onto the card and tells the followers
 *    once; **reopen** (people only) opens it again.
 *
 * Sub-channels nest one level: a sub-channel has no sub-channels of its own.
 * Constructed by GroupChatService (it is part of the channel layer, not a
 * module of its own), so every setup that has the group chat has them.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import { channelMembers, channelMessages, channels, organizations } from '../database/schema';
import { nowIso } from '../common/ids.util';
import { currentViewer } from '../accounts/account-context';
import type { Channel, ChannelMessage, GroupChatService } from './groupchat.service';
import type { WorkspaceEventBus } from './workspace-events';
import type { Follower, FollowTarget } from '../follows/follows.service';
import { slugify } from './mentions';
import { discussionTunable } from './discussion-tunables';
import { channelPath } from '../files/layout';

export type SubPurpose = 'meeting' | 'discussion' | 'project';
export const SUB_PURPOSES: readonly string[] = ['meeting', 'discussion', 'project'];
/** The attachment kind of the parent's link card (`path` = `subchannel/<id>`). */
export const LINK_CARD_KIND = 'subchannel';
/** At most one in-place card refresh per sub-channel this often for ordinary activity. */
export const CARD_REFRESH_MS = 60_000;
const TITLE_CAP = 100;
const OUTCOME_CAP = 600;

export interface StartSubInput {
  title: string;
  purpose?: string;
  /** Who is in it: default the parent's members; a subset otherwise (the
   *  starter is always in it). Agents outside the parent are refused unless
   *  `system` (a meeting's attendees). */
  members?: Array<{ kind: 'agent' | 'human'; id: string }>;
  /** Why it exists, posted as its opening line. */
  reason?: string;
  /** human:<id> | agent:<id> | system. */
  createdBy: string;
  meetingId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  /** The parent message it started from (a thread moved here). */
  originMessageId?: string | null;
  /** A preferred slug (`meeting-standup-2026-11-04`); de-duplicated. */
  slug?: string;
  /** Skip the open-per-channel cap and the agent's daily cap (meetings). */
  system?: boolean;
  /** No opening line (a meeting's agenda opens it). */
  quiet?: boolean;
}

export interface SubSummary {
  id: string; slug: string; name: string; purpose: string; status: string; kind: string;
  memberCount: number; createdAt: string; closedAt: string | null; lastActivityAt: string | null;
  outcome: string; meetingId: string | null; linkMessageId: string | null; createdBy: string;
}

export class SubChannels {
  /** Test seam: the clock. */
  now: () => Date = () => new Date();
  private readonly lastCard = new Map<string, number>();

  constructor(
    private readonly db: DrizzleDb,
    private readonly chat: GroupChatService,
    private readonly events: WorkspaceEventBus,
  ) {}

  isSub(c: Pick<Channel, 'channelKind' | 'parentChannelId'>): boolean {
    return c.channelKind === 'sub' && Boolean(c.parentChannelId);
  }

  /** The workspace's tunables row (its organization), or null. */
  private async orgRow(workspaceId: string): Promise<{ tunables: string | null } | null> {
    return (await this.db.select({ tunables: organizations.tunables }).from(organizations)
      .where(and(eq(organizations.workspaceId, workspaceId), sql`${organizations.status} <> 'archived'`)).limit(1).catch(() => [])).at(0) ?? null;
  }

  async tunable(workspaceId: string, key: Parameters<typeof discussionTunable>[1]): Promise<number> {
    return discussionTunable(await this.orgRow(workspaceId), key);
  }

  // ---- start ----

  async start(parentId: string, input: StartSubInput): Promise<Channel> {
    const parent = await this.chat.get(parentId);
    if (parent.archivedAt) throw new BadRequestException(`#${parent.slug} is archived`);
    if (this.isSub(parent)) throw new BadRequestException('a discussion cannot hold discussions of its own — start one in its parent channel');
    const title = (input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_CAP);
    if (!title) throw new BadRequestException('a discussion needs a title');
    const purpose = input.purpose && SUB_PURPOSES.includes(input.purpose) ? input.purpose : 'discussion';
    const ws = parent.workspaceId;
    if (!input.system) {
      const open = await this.subsOf(parent.id, { status: 'open' });
      const cap = await this.tunable(ws, 'discussion.openPerChannel');
      if (open.length >= cap) throw new BadRequestException(`#${parent.slug} already has ${open.length} open discussions (discussion.openPerChannel is ${cap}) — close one first`);
      if (input.createdBy.startsWith('agent:')) {
        const daily = await this.tunable(ws, 'discussion.agentDailyCap');
        const dayStart = new Date(this.now()); dayStart.setUTCHours(0, 0, 0, 0);
        const mine = (await this.db.select({ id: channels.id }).from(channels).where(and(eq(channels.workspaceId, ws), eq(channels.createdBy, input.createdBy), eq(channels.channelKind, 'sub'), gte(channels.createdAt, dayStart.toISOString())))).length;
        if (mine >= daily) throw new BadRequestException(daily === 0 ? 'agents in this workspace do not start discussions (discussion.agentDailyCap is 0) — keep it in the thread' : `you started ${mine} discussion(s) today (discussion.agentDailyCap is ${daily}) — keep it in the thread`);
      }
    }
    // Members: the parent's, or the chosen subset; the starter is always in.
    const parentMembers = await this.db.select().from(channelMembers).where(eq(channelMembers.channelId, parent.id));
    const inParent = (kind: string, id: string) => parentMembers.find((m) => m.memberKind === kind && m.memberId === id);
    const wanted = input.members?.length ? input.members : parentMembers.map((m) => ({ kind: m.memberKind as 'agent' | 'human', id: m.memberId }));
    const picked: Array<{ kind: 'agent' | 'human'; id: string }> = [];
    for (const w of wanted) {
      if (w.kind !== 'agent' && w.kind !== 'human') continue;
      if (!input.system && w.kind === 'agent' && !inParent('agent', w.id)) throw new BadRequestException(`every agent in a discussion must be a member of #${parent.slug}`);
      if (!picked.some((p) => p.kind === w.kind && p.id === w.id)) picked.push(w);
    }
    const starter = starterOf(input.createdBy);
    if (starter && !picked.some((p) => p.kind === starter.kind && p.id === starter.id)) picked.unshift(starter);
    if (parent.kind === 'private') {
      // A private parent's discussion is private too, and only its members may be in it.
      for (const p of picked) if (!inParent(p.kind, p.id) && !input.system) throw new BadRequestException(`#${parent.slug} is private: only its members join its discussions`);
    }
    // The slug: preferred or `discuss-<title>`, unique in the workspace.
    const base = (input.slug && /^[a-z0-9][a-z0-9-]{0,40}$/.test(input.slug) ? input.slug : `${purpose === 'meeting' ? 'meeting' : 'discuss'}-${slugify(title).slice(0, 32) || 'thread'}`).replace(/-+$/, '');
    let slug = base;
    for (let n = 2; await this.chat.bySlug(ws, slug).then(() => true, () => false); n++) slug = `${base}-${n}`.slice(0, 48);
    const at = nowIso();
    const sub = await this.chat.ensureChannel(ws, slug, title, {
      topic: (input.reason ?? '').slice(0, 500), kind: parent.kind === 'private' ? 'private' : 'public', createdBy: input.createdBy,
      folder: channelPath.sub(this.chat.folderOf(parent), slug),
      sub: {
        parentChannelId: parent.id, channelKind: 'sub', purpose, status: 'open', lastActivityAt: at,
        meetingId: input.meetingId ?? null, taskId: input.taskId ?? null, projectId: input.projectId ?? null, originMessageId: input.originMessageId ?? null,
      },
    });
    for (const p of picked) {
      const pm = inParent(p.kind, p.id);
      const isStarter = starter && starter.kind === p.kind && starter.id === p.id;
      await this.chat.addMember(sub.id, { kind: p.kind, id: p.id, role: isStarter && p.kind === 'human' ? 'owner' : 'member', notify: pm?.notify, unprompted: pm?.unprompted === 1 }, { system: true }).catch(() => undefined);
    }
    // The link card: ONE system message in the parent, updated in place.
    const card = await this.chat.post(parent.id, { text: await this.cardText(sub), authorKind: 'system', attachments: [{ path: `${LINK_CARD_KIND}/${sub.id}`, kind: LINK_CARD_KIND }] });
    await this.db.update(channels).set({ linkMessageId: card.id }).where(eq(channels.id, sub.id));
    this.lastCard.set(sub.id, Date.now());
    if (input.originMessageId) {
      const origin = await this.chat.message(input.originMessageId).catch(() => null);
      if (origin && origin.channelId === parent.id) await this.chat.postSystem(parent.id, `Continued in the discussion "${title}" (#${slug})`, origin.threadRootId ?? origin.id).catch(() => undefined);
    }
    if (!input.quiet) {
      const by = await this.actorName(ws, input.createdBy);
      await this.chat.postSystem(sub.id, `${by} started this discussion from #${parent.slug}${input.reason ? `: ${input.reason.replace(/\s+/g, ' ').slice(0, 400)}` : '.'}`).catch(() => undefined);
    }
    // Every participant follows it (docs/follows.md): its close reaches them once.
    if (this.chat.follows) {
      const target = this.target({ ...sub, workspaceId: ws });
      for (const p of picked) await this.chat.follows.autoFollow(target, followerOf(p), starter && starter.kind === p.kind && starter.id === p.id ? 'started' : 'participant').catch(() => undefined);
    }
    this.events.emit({ type: 'channel_update', workspaceId: ws, channelId: parent.id });
    this.events.emit({ type: 'channel_update', workspaceId: ws, channelId: sub.id });
    return this.chat.get(sub.id);
  }

  // ---- activity ----

  /** A non-system post landed in a sub-channel: the auto-close clock, the
   *  followers (unless the post computes no wake set: a meeting turn), the
   *  card at most once a minute. */
  async onPosted(sub: Channel, m: ChannelMessage, opts: { follow: boolean; mentioned: Array<{ kind: string; id: string }> }): Promise<void> {
    await this.db.update(channels).set({ lastActivityAt: m.createdAt }).where(eq(channels.id, sub.id));
    if (opts.follow && this.chat.follows && (m.authorKind === 'agent' || m.authorKind === 'human')) {
      const target = this.target(sub);
      const who: Follower = { kind: m.authorKind === 'agent' ? 'agent' : 'user', id: m.authorId };
      await this.chat.follows.autoFollow(target, who, 'commented').catch(() => undefined);
      await this.chat.follows.recordActivity(target, {
        actor: who, summary: m.text,
        alreadyWoken: opts.mentioned.filter((x) => x.kind === 'agent').map((x) => x.id),
        alreadyNotified: opts.mentioned.filter((x) => x.kind === 'human').map((x) => x.id),
      }).catch(() => undefined);
    }
    const last = this.lastCard.get(sub.id) ?? 0;
    if (Date.now() - last >= CARD_REFRESH_MS) await this.refreshCard(sub.id).catch(() => undefined);
  }

  // ---- the link card ----

  /** The card's text: what a reader (or an agent reading the parent) sees. */
  async cardText(sub: Channel): Promise<string> {
    const icon = sub.purpose === 'meeting' ? '📅 Meeting' : sub.purpose === 'project' ? '📌 Project discussion' : '🗣 Discussion';
    const members = await this.db.select({ kind: channelMembers.memberKind, id: channelMembers.memberId }).from(channelMembers).where(eq(channelMembers.channelId, sub.id));
    const count = `${members.length} member${members.length === 1 ? '' : 's'}`;
    if (sub.status === 'closed') {
      const outcome = sub.outcome ? ` — ${sub.outcome.replace(/\s+/g, ' ').slice(0, 300)}` : '';
      return `${icon}: ${sub.name} · ${count} · ${sub.purpose === 'meeting' ? 'ended' : 'closed'}${outcome} · #${sub.slug}`;
    }
    const posts = Number((await this.db.select({ n: sql<number>`count(*)` }).from(channelMessages).where(and(eq(channelMessages.channelId, sub.id), sql`${channelMessages.authorKind} <> 'system'`)))[0]?.n ?? 0);
    return `${icon}: ${sub.name} · ${count} · live${posts ? ` · ${posts} message${posts === 1 ? '' : 's'}` : ''} · #${sub.slug}`;
  }

  /** Rewrite the parent's link card in place and tell the parent's viewers. */
  async refreshCard(subId: string): Promise<void> {
    const sub = await this.chat.get(subId);
    if (!sub.linkMessageId || !sub.parentChannelId) return;
    const msg = await this.chat.message(sub.linkMessageId).catch(() => null);
    if (!msg) return;
    const text = await this.cardText(sub);
    this.lastCard.set(sub.id, Date.now());
    const editedAt = nowIso();
    if (text !== msg.text) await this.db.update(channelMessages).set({ text, editedAt }).where(eq(channelMessages.id, msg.id));
    this.events.emit({ type: 'channel_message', workspaceId: sub.workspaceId, channelId: sub.parentChannelId, message: { ...msg, text, editedAt: text !== msg.text ? editedAt : msg.editedAt } });
    this.events.emit({ type: 'channel_update', workspaceId: sub.workspaceId, channelId: sub.parentChannelId });
  }

  // ---- close / reopen ----

  /** Who may close it: its starter (a person or the agent), a channel owner
   *  of it or of the parent, the workspace owner; `system` for the meeting's
   *  end and the idle sweep. */
  async close(subId: string, input: { by: string; outcome?: string; minutesPath?: string | null; system?: boolean }): Promise<Channel> {
    const sub = await this.chat.get(subId);
    if (!this.isSub(sub)) throw new BadRequestException(`#${sub.slug} is a channel, not a discussion — archive it instead`);
    if (sub.status === 'closed') return sub;
    if (!input.system) await this.assertMayClose(sub, input.by);
    const outcome = [(input.outcome ?? '').replace(/\s+/g, ' ').trim(), input.minutesPath ? `Minutes: /${input.minutesPath.replace(/^\/+/, '')}` : ''].filter(Boolean).join(' · ').slice(0, OUTCOME_CAP);
    const by = await this.actorName(sub.workspaceId, input.by);
    await this.chat.postSystem(sub.id, `${input.by === 'system' ? 'Closed' : `Closed by ${by}`}${outcome ? `: ${outcome}` : '.'} This ${sub.purpose === 'meeting' ? 'meeting' : 'discussion'} is now read-only${sub.purpose === 'meeting' ? '' : '; reopen it to continue'}.`).catch(() => undefined);
    await this.db.update(channels).set({ status: 'closed', closedAt: nowIso(), closedBy: input.by, outcome }).where(eq(channels.id, sub.id));
    await this.refreshCard(sub.id).catch(() => undefined);
    if (this.chat.follows) await this.chat.follows.recordActivity(this.target(sub), { actor: actorFollower(input.by), actorName: by, summary: `closed${outcome ? `: ${outcome}` : ''}`, closed: true }).catch(() => undefined);
    this.events.emit({ type: 'channel_update', workspaceId: sub.workspaceId, channelId: sub.id });
    return this.chat.get(sub.id);
  }

  /** People reopen a closed discussion (agents do not). */
  async reopen(subId: string, by: string): Promise<Channel> {
    const sub = await this.chat.get(subId);
    if (!this.isSub(sub)) throw new BadRequestException(`#${sub.slug} is not a discussion`);
    if (sub.status !== 'closed') return sub;
    if (!by.startsWith('human:')) throw new ForbiddenException('only a person reopens a discussion');
    const parent = await this.chat.get(sub.parentChannelId!);
    if (parent.archivedAt) throw new BadRequestException(`#${parent.slug} is archived`);
    await this.db.update(channels).set({ status: 'open', closedAt: null, closedBy: null, lastActivityAt: nowIso() }).where(eq(channels.id, sub.id));
    const name = await this.actorName(sub.workspaceId, by);
    await this.chat.postSystem(sub.id, `Reopened by ${name}.`).catch(() => undefined);
    await this.refreshCard(sub.id).catch(() => undefined);
    if (this.chat.follows) await this.chat.follows.recordActivity(this.target(sub), { actor: actorFollower(by), actorName: name, summary: 'reopened', closed: false }).catch(() => undefined);
    this.events.emit({ type: 'channel_update', workspaceId: sub.workspaceId, channelId: sub.id });
    return this.chat.get(sub.id);
  }

  private async assertMayClose(sub: Channel, by: string): Promise<void> {
    if (by === sub.createdBy) return;
    if (by.startsWith('agent:')) throw new ForbiddenException('only the agent that started a discussion closes it (or a person)');
    const viewer = currentViewer();
    if (!viewer || viewer.role === 'owner') return;
    const id = by.replace(/^human:/, '');
    for (const cid of [sub.id, sub.parentChannelId!]) {
      const m = await this.chat.member(cid, 'human', id);
      if (m?.role === 'owner') return;
    }
    throw new ForbiddenException('only the person who started it, a channel owner or the workspace owner closes a discussion');
  }

  /** The idle sweep: an open discussion silent for `discussion.autoCloseHours`
   *  closes itself (meetings close when they end; one that never ended is
   *  swept like any other). Returns the slugs it closed. */
  async sweep(now: Date = this.now()): Promise<string[]> {
    const open = await this.db.select().from(channels).where(and(eq(channels.channelKind, 'sub'), eq(channels.status, 'open')));
    const closed: string[] = [];
    const hoursByWs = new Map<string, number>();
    for (const sub of open) {
      if (sub.archivedAt) continue;
      if (!hoursByWs.has(sub.workspaceId)) hoursByWs.set(sub.workspaceId, await this.tunable(sub.workspaceId, 'discussion.autoCloseHours'));
      const hours = hoursByWs.get(sub.workspaceId)!;
      if (hours <= 0) continue;
      const last = sub.lastActivityAt ?? sub.createdAt;
      if (now.getTime() - new Date(last).getTime() < hours * 3_600_000) continue;
      await this.close(sub.id, { by: 'system', outcome: `closed after ${hours} h without a message`, system: true }).catch(() => undefined);
      closed.push(sub.slug);
    }
    return closed;
  }

  /** The parent was archived: its open discussions close with it. */
  async closeAllOf(parentId: string): Promise<void> {
    for (const s of await this.subsOf(parentId, { status: 'open' })) await this.close(s.id, { by: 'system', outcome: 'the channel was archived', system: true }).catch(() => undefined);
  }

  // ---- reading ----

  async subsOf(parentId: string, opts: { status?: 'open' | 'closed' | 'all'; limit?: number } = {}): Promise<SubSummary[]> {
    const conds = [eq(channels.parentChannelId, parentId), eq(channels.channelKind, 'sub')];
    if (opts.status && opts.status !== 'all') conds.push(eq(channels.status, opts.status));
    const rows = await this.db.select().from(channels).where(and(...conds)).orderBy(desc(channels.createdAt)).limit(Math.min(200, opts.limit ?? 200));
    const counts = rows.length ? await this.db.select({ id: channelMembers.channelId, n: sql<number>`count(*)` }).from(channelMembers).where(inArray(channelMembers.channelId, rows.map((r) => r.id))).groupBy(channelMembers.channelId) : [];
    return rows.map((r) => ({
      id: r.id, slug: r.slug, name: r.name, purpose: r.purpose, status: r.status, kind: r.kind, memberCount: Number(counts.find((c) => c.id === r.id)?.n ?? 0),
      createdAt: r.createdAt, closedAt: r.closedAt, lastActivityAt: r.lastActivityAt, outcome: r.outcome, meetingId: r.meetingId, linkMessageId: r.linkMessageId, createdBy: r.createdBy,
    }));
  }

  /** Closed sub-channels per parent (the rail's "Past discussions (N)"). */
  async closedCounts(parentIds: string[]): Promise<Record<string, number>> {
    if (parentIds.length === 0) return {};
    const rows = await this.db.select({ id: channels.parentChannelId, n: sql<number>`count(*)` }).from(channels)
      .where(and(inArray(channels.parentChannelId, parentIds), eq(channels.channelKind, 'sub'), eq(channels.status, 'closed'))).groupBy(channels.parentChannelId);
    return Object.fromEntries(rows.filter((r) => r.id).map((r) => [r.id!, Number(r.n)]));
  }

  /** The open discussion a parent thread already moved into, if any. */
  async movedFrom(originMessageId: string): Promise<Channel | null> {
    return (await this.db.select().from(channels).where(and(eq(channels.originMessageId, originMessageId), eq(channels.channelKind, 'sub'), eq(channels.status, 'open'))).limit(1)).at(0) ?? null;
  }

  target(sub: Pick<Channel, 'id' | 'workspaceId' | 'slug' | 'name'>): FollowTarget {
    return { kind: 'channel', id: sub.id, workspaceId: sub.workspaceId, title: `#${sub.slug}: ${sub.name}`.slice(0, 200), link: `#/ws/${sub.workspaceId}/channel/${sub.slug}` };
  }

  private async actorName(workspaceId: string, by: string): Promise<string> {
    if (by === 'system') return 'the runtime';
    if (by.startsWith('agent:')) return (await this.chat.agentName(by.slice(6)).catch(() => null)) ?? 'an agent';
    const id = by.replace(/^human:/, '');
    return this.chat.personName(workspaceId, id);
  }
}

function starterOf(createdBy: string): { kind: 'agent' | 'human'; id: string } | null {
  if (createdBy.startsWith('agent:')) return { kind: 'agent', id: createdBy.slice(6) };
  if (createdBy.startsWith('human:')) return { kind: 'human', id: createdBy.slice(6) };
  return null;
}

function followerOf(p: { kind: 'agent' | 'human'; id: string }): Follower {
  return { kind: p.kind === 'agent' ? 'agent' : 'user', id: p.id };
}

function actorFollower(by: string): Follower | null {
  const s = starterOf(by);
  return s ? followerOf(s) : null;
}
