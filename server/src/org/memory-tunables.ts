/**
 * Memory tunables (docs/company-vision.md §1b, §6; execution-plan item 22):
 * which failures trigger a postmortem retro, how long one ref stays quiet
 * after one, how much the ask-the-company turn may spend and how wide the
 * model-free recall reaches. Registered on the shared registry so `org_tune`
 * and `PUT …/org/tunables` reach them; the bounds are the fence.
 */
import { parseTunables, registerTunables, tunable, type TunableDef } from './org-tunables';
import type { ProfileDiagnosis } from './chief-os';

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
  // Learning as they work (docs/agent-memory.md §12).
  'memory.captureTriggers': { default: 15, min: 0, max: 15, area: 'memory', description: 'Bit set of the work moments a member learns from without a model: 1 a review sent back (the reviewer\'s note), 2 a breaker stop (loop, no progress), 4 a proposal the CEO rejected with a note, 8 a journal line when a task is accepted.' },
  'memory.guidanceRepeats': { default: 3, min: 2, max: 10, area: 'memory', description: 'Times a lesson must be learned again (confirmed, repeated) before it is proposed as a change to the member\'s charter (a card) or to a playbook it names (a revise task).' },
  'memory.lessonStaleDays': { default: 45, min: 7, max: 365, area: 'memory', description: 'Days a lesson learned once and never recalled stays active before consolidation retires it (kept, no longer injected).' },
};

/** Bits of `memory.captureTriggers`. */
export const CAPTURE_TRIGGERS = { review: 1, breaker: 2, decision: 4, journal: 8 } as const;
export type CaptureTrigger = keyof typeof CAPTURE_TRIGGERS;

/** The learning keys from the profile (docs/company-vision.md §1b): rigour
 *  wants more evidence before a lesson changes a charter and keeps lessons
 *  longer; speed codifies sooner and forgets sooner; a control culture
 *  codifies deliberately. Pure; values stay inside each bound. */
export function deriveMemoryTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor'>): Array<{ key: string; value: number; why: string }> {
  const { stage, cultureType: c, speed, rigor } = d;
  return [
    { key: 'memory.guidanceRepeats', value: rigor || c === 'hierarchy' ? 4 : speed || c === 'adhocracy' ? 2 : 3, why: rigor || c === 'hierarchy' ? 'evidence first: a lesson repeats four times before it may change a charter' : speed || c === 'adhocracy' ? 'a lesson learned twice is worth writing into how the member works' : 'three repeats and a lesson is proposed for the charter' },
    { key: 'memory.lessonStaleDays', value: rigor ? 90 : speed ? 21 : stage === 'early' ? 30 : 45, why: rigor ? 'lessons are kept for a quarter before they go stale' : speed ? 'a fast company forgets an unused lesson in three weeks' : stage === 'early' ? 'an early company changes fast: a month' : 'six weeks without use and a lesson is retired' },
  ];
}
registerTunables(MEMORY_TUNABLES);

export function memoryTunable(org: unknown, key: keyof typeof MEMORY_TUNABLES): number {
  return tunable(org as { tunables?: string | null } | null, key);
}

/** Whether `trigger` is switched on in the org's bit set. */
export function postmortemTriggerOn(org: unknown, trigger: PostmortemTrigger): boolean {
  return (Math.round(memoryTunable(org, 'memory.postmortemTriggers')) & POSTMORTEM_TRIGGERS[trigger]) !== 0;
}

/** Whether a capture trigger is on in the org's bit set. */
export function captureOn(org: unknown, trigger: CaptureTrigger): boolean {
  return (Math.round(memoryTunable(org, 'memory.captureTriggers')) & CAPTURE_TRIGGERS[trigger]) !== 0;
}

/**
 * A learning tunable: the stored value when the company set one; otherwise
 * the value its profile derives (values, culture, mission), so an existing
 * company that never re-ran onboarding still gets thresholds shaped by its
 * profile rather than one fixed default (company-mechanisms-adapt).
 */
export function learningTunable(org: { tunables?: string | null; values?: string | null; culture?: string | null; mission?: string | null } | null | undefined, key: 'memory.guidanceRepeats' | 'memory.lessonStaleDays', derive: (o: { values?: string | null; culture?: string | null; mission?: string | null }) => Array<{ key: string; value: number }>): number {
  if (parseTunables(org?.tunables)[key] !== undefined || !org) return memoryTunable(org, key);
  const derived = derive(org).find((t) => t.key === key);
  return derived ? Math.min(MEMORY_TUNABLES[key].max, Math.max(MEMORY_TUNABLES[key].min, derived.value)) : memoryTunable(org, key);
}
