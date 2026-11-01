/**
 * Memory tunables (docs/company-vision.md §1b, §6; execution-plan item 22):
 * which failures trigger a postmortem retro, how long one ref stays quiet
 * after one, how much the ask-the-company turn may spend and how wide the
 * model-free recall reaches. Registered on the shared registry so `org_tune`
 * and `PUT …/org/tunables` reach them; the bounds are the fence.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';

/** Bits of `memory.postmortemTriggers`. */
export const POSTMORTEM_TRIGGERS = {
  goal_abandoned: 1,
  escalation: 2,
  breaker: 4,
  audit_critical: 8,
  /** A major or critical incident (docs/incidents.md, item 29). */
  incident: 16,
} as const;
export type PostmortemTrigger = keyof typeof POSTMORTEM_TRIGGERS;
export const ALL_POSTMORTEM_TRIGGERS = Object.values(POSTMORTEM_TRIGGERS).reduce((a, b) => a | b, 0);

export const MEMORY_TUNABLES: Record<string, TunableDef> = {
  'memory.postmortemTriggers': { default: ALL_POSTMORTEM_TRIGGERS, min: 0, max: ALL_POSTMORTEM_TRIGGERS, area: 'memory', description: 'Bit set of what schedules a postmortem retro: 1 goal abandoned, 2 task escalated after the review rounds, 4 a breaker tripped twice on one task, 8 a critical audit finding, 16 a major or critical incident.' },
  'memory.postmortemCooldownDays': { default: 7, min: 1, max: 90, area: 'memory', description: 'Days before the same task, goal or finding may schedule another postmortem.' },
  'memory.breakerTrips': { default: 2, min: 1, max: 10, area: 'memory', description: 'Breaker trips (loop or no-progress stops) on one task within a day that schedule a postmortem.' },
  'memory.recallCap': { default: 12, min: 3, max: 40, area: 'memory', description: 'Items per source (tasks, decisions, minutes, messages, …) the model-free recall pack carries.' },
  'memory.askUsdCap': { default: 0.5, min: 0.05, max: 5, area: 'memory', description: 'USD one ask-the-company turn may reserve.' },
};
registerTunables(MEMORY_TUNABLES);

export function memoryTunable(org: unknown, key: keyof typeof MEMORY_TUNABLES): number {
  return tunable(org as { tunables?: string | null } | null, key);
}

/** Whether `trigger` is switched on in the org's bit set. */
export function postmortemTriggerOn(org: unknown, trigger: PostmortemTrigger): boolean {
  return (Math.round(memoryTunable(org, 'memory.postmortemTriggers')) & POSTMORTEM_TRIGGERS[trigger]) !== 0;
}
