/**
 * Announcer — the one-line seam between organization mode and the group
 * chat (docs/group-chat.md §1 `#company`, §5). Every executed structural
 * action and every mode change is announced in the workspace's `#company`
 * channel. The channel service lives in `server/src/groupchat/` (execution
 * plan item 15); this module only knows the `Announcer` shape, so it compiles
 * and tests without it. Wired: GroupChatModule imports OrgModule (for the
 * board), so a provider here would be a module cycle; instead OrgModule
 * exports this wrapper and `GroupChatService` calls `bind()` at construction
 * with `ensureChannel(workspaceId, 'company', 'company') → postSystem(text)`
 * (server/src/groupchat/groupchat.service.ts). A test may still pass an
 * implementation to the constructor.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export interface Announcer {
  /** Post a system one-liner to the workspace's `#company` channel, creating it if needed. */
  announce(workspaceId: string, text: string): Promise<void>;
}

/**
 * The channel operations units need (docs/group-chat.md §7): a unit's
 * `#<slug>` channel is created, renamed, archived and kept in step with the
 * org chart through this seam, so OrgUnitsService never imports the group
 * chat. Every method is optional on the bound implementation; unbound, units
 * exist without channels. `ensureUnitChannel` de-duplicates the slug against
 * the workspace's channels and returns the slug it actually used.
 */
export interface UnitChannels {
  companyChannel(workspaceId: string): Promise<{ id: string; slug: string }>;
  ensureUnitChannel(workspaceId: string, slug: string, name: string, opts: { topic?: string; agentIds: string[]; humanIds: string[] }): Promise<{ id: string; slug: string }>;
  channelMembers(channelId: string): Promise<Array<{ kind: 'agent' | 'human'; id: string }>>;
  addChannelMember(channelId: string, kind: 'agent' | 'human', id: string): Promise<void>;
  removeChannelMember(channelId: string, kind: 'agent' | 'human', id: string): Promise<void>;
  updateChannel(channelId: string, patch: { name?: string; topic?: string; archived?: boolean }): Promise<void>;
  postSystem(channelId: string, text: string): Promise<void>;
  /** Delete a channel with its messages, members and read marks (a
   *  permanent company delete that chose "delete channels"). Never #general
   *  or #company. Optional: an implementation without it keeps channels. */
  deleteChannel?(channelId: string): Promise<void>;
}

/**
 * What meetings need from a channel (docs/group-chat.md §8, docs/company-
 * vision.md §3): a meeting runs in a sub-channel of a unit channel (a
 * thread in it when sub-channels are not bound), so the runtime
 * posts the agenda, the turns and the minutes through this seam and reads
 * the thread back between rounds (human messages are injected, "stop" ends
 * it). `wake: false` posts without computing a wake set — meeting turns must
 * not start channel wakes of their own.
 */
export interface MeetingChannels {
  channelInfo(channelId: string): Promise<{ id: string; slug: string; workspaceId: string; archivedAt: string | null }>;
  /** `human`: a person's answer posted from the room (docs/meetings.md "During"). */
  postAs(channelId: string, input: { authorKind: 'agent' | 'system' | 'human'; authorId?: string; text: string; threadRootId?: string | null; attachments?: Array<{ path: string; kind: string }>; runId?: string | null; wake?: boolean }): Promise<{ id: string; createdAt: string }>;
  thread(channelId: string, rootId: string): Promise<Array<{ id: string; authorKind: string; authorId: string; text: string; createdAt: string }>>;
  /** Meetings run in a sub-channel of the channel they were called in
   *  (docs/group-chat.md §9): open it (the parent gets one link card), read
   *  its whole stream, close it when the meeting ends. Optional: unbound, a
   *  meeting is a thread as before. */
  openSub?(parentChannelId: string, input: { title: string; slug?: string; members: Array<{ kind: 'agent' | 'human'; id: string }>; meetingId: string; createdBy?: string }): Promise<{ id: string; slug: string; linkMessageId: string | null }>;
  closeSub?(channelId: string, input: { outcome: string; minutesPath?: string | null }): Promise<void>;
  stream?(channelId: string): Promise<Array<{ id: string; authorKind: string; authorId: string; text: string; createdAt: string }>>;
  /** Live events for the room (optional): the speaker's typing and streamed
   *  reply on the channel stream events (`replyRootId` = the meeting thread),
   *  and `meeting_update` when the room changes. */
  live?(ev: MeetingLiveEvent): void;
}

export type MeetingLiveEvent =
  | { type: 'channel_typing'; workspaceId: string; channelId: string; threadRootId: string | null; replyRootId?: string; agentId: string; liveId: string; on: boolean }
  | { type: 'channel_stream'; workspaceId: string; channelId: string; threadRootId: string | null; replyRootId?: string; agentId: string; liveId: string; delta: string; done?: boolean }
  | { type: 'meeting_update'; workspaceId: string; channelId: string; meetingId: string; threadRootId: string | null; status: string };

export const ORG_ANNOUNCER = Symbol('ORG_ANNOUNCER');

/** Null-safe wrapper: without a bound Announcer, announcements are dropped
 *  (the audit row and the chief's inbox event still exist). Never throws. */
@Injectable()
export class OrgAnnouncer implements Announcer {
  private readonly logger = new Logger(OrgAnnouncer.name);
  constructor(@Optional() @Inject(ORG_ANNOUNCER) private impl?: Announcer & Partial<UnitChannels> & Partial<MeetingChannels>) {}

  get bound(): boolean { return Boolean(this.impl); }

  /** Late binding by the group-chat module (see the header). */
  bind(impl: Announcer & Partial<UnitChannels> & Partial<MeetingChannels>): void { this.impl = impl; }

  /** The unit-channel operations, when the bound implementation offers them. */
  get channels(): UnitChannels | null {
    const i = this.impl;
    return i && i.ensureUnitChannel && i.companyChannel && i.channelMembers && i.addChannelMember && i.removeChannelMember && i.updateChannel && i.postSystem ? (i as UnitChannels) : null;
  }

  /** The meeting operations (docs/group-chat.md §8), when bound. */
  get meetings(): (MeetingChannels & Pick<UnitChannels, 'channelMembers'>) | null {
    const i = this.impl;
    return i && i.channelInfo && i.postAs && i.thread && i.channelMembers ? (i as MeetingChannels & UnitChannels) : null;
  }

  async announce(workspaceId: string, text: string): Promise<void> {
    if (!this.impl) return;
    try { await this.impl.announce(workspaceId, text.slice(0, 2_000)); } catch (err) {
      this.logger.warn(`announce failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
