/**
 * Chat auto-archive tunables (docs/chat-archiving.md): how long a chat whose
 * task is finished stays in the rail, and how long unread activity keeps it
 * there. Registered on the shared registry of `org-tunables.ts`, so
 * `org_tune` and `PUT …/org/tunables` reach them and each workspace shapes
 * them to how it works (a fast-moving company clears finished work sooner;
 * one that revisits it keeps it longer). Workspaces without an organization
 * read the defaults. The bounds are the fence.
 */
import { registerTunables, tunable, type TunableDef } from '../org/org-tunables';

export const CHAT_ARCHIVE_TUNABLES: Record<string, TunableDef> = {
  'chat.autoArchiveDays': { default: 7, min: 0, max: 365, area: 'chat', description: 'Days after a chat\'s task is done, cancelled or abandoned (and the chat has gone quiet) before it is archived, for task chats that follow the workspace default; 0 turns auto-archive off. Archived chats restore from the Archived group.' },
  'chat.autoArchiveUnreadHours': { default: 24, min: 0, max: 720, area: 'chat', description: 'Hours an unread inbox event of a chat keeps it from being auto-archived.' },
};
registerTunables(CHAT_ARCHIVE_TUNABLES);

export function chatArchiveTunable(org: { tunables?: string | null } | null | undefined, key: keyof typeof CHAT_ARCHIVE_TUNABLES): number {
  return tunable(org, key);
}
