/**
 * Announcer — the one-line seam between organization mode and the group
 * chat (docs/group-chat.md §1 `#company`, §5). Every executed structural
 * action and every mode change is announced in the workspace's `#company`
 * channel. The channel service lives in `server/src/groupchat/` (execution
 * plan item 15); this module only knows the `Announcer` shape, so it compiles
 * and tests without it. Wiring, once both land, is one provider in OrgModule:
 *
 *   { provide: ORG_ANNOUNCER, inject: [GroupChatService], useFactory: (gc) => ({
 *       announce: async (workspaceId, text) => {
 *         const ch = await gc.ensureChannel(workspaceId, 'company', 'company', { kind: 'public' });
 *         await gc.postSystem(ch.id, text);
 *       } }) }
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export interface Announcer {
  /** Post a system one-liner to the workspace's `#company` channel, creating it if needed. */
  announce(workspaceId: string, text: string): Promise<void>;
}

export const ORG_ANNOUNCER = Symbol('ORG_ANNOUNCER');

/** Null-safe wrapper: without a bound Announcer, announcements are dropped
 *  (the audit row and the chief's inbox event still exist). Never throws. */
@Injectable()
export class OrgAnnouncer implements Announcer {
  private readonly logger = new Logger(OrgAnnouncer.name);
  constructor(@Optional() @Inject(ORG_ANNOUNCER) private readonly impl?: Announcer) {}

  get bound(): boolean { return Boolean(this.impl); }

  async announce(workspaceId: string, text: string): Promise<void> {
    if (!this.impl) return;
    try { await this.impl.announce(workspaceId, text.slice(0, 2_000)); } catch (err) {
      this.logger.warn(`announce failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
