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
}

export const ORG_ANNOUNCER = Symbol('ORG_ANNOUNCER');

/** Null-safe wrapper: without a bound Announcer, announcements are dropped
 *  (the audit row and the chief's inbox event still exist). Never throws. */
@Injectable()
export class OrgAnnouncer implements Announcer {
  private readonly logger = new Logger(OrgAnnouncer.name);
  constructor(@Optional() @Inject(ORG_ANNOUNCER) private impl?: Announcer & Partial<UnitChannels>) {}

  get bound(): boolean { return Boolean(this.impl); }

  /** Late binding by the group-chat module (see the header). */
  bind(impl: Announcer & Partial<UnitChannels>): void { this.impl = impl; }

  /** The unit-channel operations, when the bound implementation offers them. */
  get channels(): UnitChannels | null {
    const i = this.impl;
    return i && i.ensureUnitChannel && i.companyChannel && i.channelMembers && i.addChannelMember && i.removeChannelMember && i.updateChannel && i.postSystem ? (i as UnitChannels) : null;
  }

  async announce(workspaceId: string, text: string): Promise<void> {
    if (!this.impl) return;
    try { await this.impl.announce(workspaceId, text.slice(0, 2_000)); } catch (err) {
      this.logger.warn(`announce failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
