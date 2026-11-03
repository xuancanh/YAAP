/**
 * The agent's direct chat with the owner (docs/agent-messages.md).
 *
 * An agent has many sessions; only some are a conversation with a person.
 * Loops and heartbeats (`Loop · …`), org runs and planning (`Org · …`),
 * evals, red-team probes, channel wakes (`#slug · Agent`, tagged
 * `channel`), app turns, the Telegram and email bridges and task chats are
 * the agent's working log or another surface. The **owner DM** is one
 * human-facing chat per agent, tagged `owner-dm`, private to the owner
 * (`initiatedBy` '' and not shared), created on first use. `message_owner`
 * writes into it, and the owner's reply there is an ordinary turn.
 *
 * Keep session classification here, in one place, so the rail and the
 * agent's Work log can reuse it.
 */
import type { ChatSession } from './chats.repository';

/** The tag that marks an agent's direct chat with the owner. */
export const OWNER_DM_TAG = 'owner-dm';
/** The name a new owner DM gets (the rail groups chats under their agent). */
export const OWNER_DM_NAME = 'Direct messages';

/** Name prefixes of sessions that are an agent's working log or another surface, never a DM. */
export const WORKING_SESSION_PREFIXES: readonly string[] = ['Loop · ', 'Org · ', 'Eval · ', 'Red team · ', 'App · ', 'Telegram · ', 'Email · '];

export function sessionTags(s: Pick<ChatSession, 'tags'>): string[] {
  try {
    const v = JSON.parse(s.tags || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/** Whether a session is the agent's own work (a loop, heartbeat, org run, eval,
 *  channel wake, bridge or task chat) rather than a chat a person reads. Pure. */
export function isWorkingSession(s: Pick<ChatSession, 'name' | 'tags' | 'taskId'>): boolean {
  if (WORKING_SESSION_PREFIXES.some((p) => s.name.startsWith(p))) return true;
  if (s.name.startsWith('#') && s.name.includes(' · ')) return true;
  if (sessionTags(s).includes('channel')) return true;
  return Boolean(s.taskId);
}

/** Whether a session is an agent's owner DM. Pure. */
export function isOwnerDm(s: Pick<ChatSession, 'tags' | 'agentId' | 'archivedAt'>): boolean {
  return Boolean(s.agentId) && !s.archivedAt && sessionTags(s).includes(OWNER_DM_TAG);
}

export interface OwnerDmRepo {
  listSessions(workspaceId: string): Promise<ChatSession[]>;
  createSession(input: Partial<ChatSession> & { workspaceId: string }): Promise<ChatSession>;
}

/**
 * The agent's owner DM in its workspace: the newest live session tagged
 * `owner-dm`, or (with `create`) a new one — Ask mode, owner-private,
 * never a working session. Returns null when there is none and `create` is
 * false.
 */
export async function ownerDmSession(
  repo: OwnerDmRepo,
  agent: { id: string; workspaceId: string },
  opts: { create?: boolean } = {},
): Promise<ChatSession | null> {
  const found = (await repo.listSessions(agent.workspaceId))
    .filter((s) => s.agentId === agent.id && isOwnerDm(s) && !isWorkingSession(s))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  if (found || !opts.create) return found ?? null;
  return repo.createSession({
    workspaceId: agent.workspaceId, agentId: agent.id, name: OWNER_DM_NAME, permissionMode: 'ask',
    initiatedBy: '', shared: 0, tags: JSON.stringify([OWNER_DM_TAG]),
  });
}
