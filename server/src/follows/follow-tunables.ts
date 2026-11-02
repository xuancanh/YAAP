/**
 * Follow tunables (docs/follows.md): how soon a follower is woken and how
 * long a closed task keeps reporting. Registered on the shared registry of
 * `org-tunables.ts`, so `org_tune` and `PUT …/org/tunables` reach them and
 * the chief shapes them to the operating profile (a fast, chatty culture
 * wakes sooner; a deep-work one batches). Workspaces without an organization
 * read the defaults. The bounds are the fence.
 */
import { registerTunables, tunable, type TunableDef } from '../org/org-tunables';

export const FOLLOW_TUNABLES: Record<string, TunableDef> = {
  'follow.wakeDebounceMinutes': { default: 30, min: 0, max: 1_440, area: 'heartbeat', description: 'Minutes between two heartbeat wakes of one agent for something it follows (blocked, review requested, reopened, a comment naming it); 0 wakes on every beat that finds one. Mentions are not affected.' },
  'follow.closedWindowHours': { default: 24, min: 0, max: 720, area: 'heartbeat', description: 'Hours a followed task that is done, cancelled or abandoned keeps appearing in the follower\'s heartbeat context; the follow row is kept.' },
  'follow.contextItems': { default: 8, min: 1, max: 20, area: 'heartbeat', description: 'Followed threads and tasks the heartbeat\'s "Following" section lists per beat (most recent first).' },
};
registerTunables(FOLLOW_TUNABLES);

export function followTunable(org: { tunables?: string | null } | null | undefined, key: keyof typeof FOLLOW_TUNABLES): number {
  return tunable(org, key);
}
