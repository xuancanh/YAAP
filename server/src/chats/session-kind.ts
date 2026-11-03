/**
 * Session kinds (docs/work-log.md): every chat session is either
 *
 *  - `chat` — a conversation with people: the owner's chats with an agent,
 *    user-started chats, the owner DM agents write to (`message_owner`),
 *    a member's Telegram / email thread, forks;
 *  - `work` — the agent's own runs: heartbeat and scheduled loops
 *    (`Loop · …`), org task runs and every other org run (`Org · …`),
 *    meeting rounds and channel wakes (the hidden `#slug · Agent` working
 *    sessions), red-team and eval runs, mini-app asks (`App · …`).
 *
 * The rail lists both — chats as each agent's chat rows, `work` sessions in
 * its Work subsection — and both open in the chat view; the agent's Chats
 * tab and chat search keep to `chat`, and the Work log is the timeline of
 * the `work` sessions' runs.
 * Memory and turn context are the same for both — the kind is presentation
 * and classification, never a model input.
 *
 * Every code path that creates a session states its kind; `classifySession`
 * is the fallback for a caller that does not, and the rule the 0080
 * migration backfilled existing rows with (kept in step with its SQL).
 */
export const SESSION_KINDS = ['chat', 'work'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export function isSessionKind(v: unknown): v is SessionKind {
  return v === 'chat' || v === 'work';
}

/** Name prefixes of the agents' own run sessions. */
export const WORK_NAME_PREFIXES = ['Loop · ', 'Org · ', 'Red team · ', 'Eval · ', 'App · '] as const;

/** The kind a session's own signals imply: its name (the run prefixes, a
 *  channel's `#slug · Agent` working session), a `channel` tag, or an org
 *  task link. Anything else is a conversation. */
export function classifySession(s: { name?: string | null; tags?: string | null; taskKind?: string | null }): SessionKind {
  const name = s.name ?? '';
  if (WORK_NAME_PREFIXES.some((p) => name.startsWith(p))) return 'work';
  if (name.startsWith('#') && name.includes(' · ')) return 'work';
  if ((s.tags ?? '').includes('"channel"')) return 'work';
  if (s.taskKind === 'org') return 'work';
  return 'chat';
}

/** The tag of the owner DM: the one chat per agent its `message_owner`
 *  posts land in (ChatsService.ownerChatFor). */
export const OWNER_DM_TAG = 'owner-dm';
