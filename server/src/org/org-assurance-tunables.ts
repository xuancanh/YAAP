/**
 * Assurance tunables (docs/company-vision.md §1b, §5): every threshold the
 * signals sweep, the SLOs, the pulse and the auditor use is a per-org
 * setting with a default and a bound. Since item 18 the one store is
 * `organizations.tunables` read through `server/src/org/org-tunables.ts`:
 * this module registers the assurance keys there at import and keeps
 * `assuranceTunable` / `mergeTunables` / `parseTunables` as thin, typed
 * wrappers, so `org_tune`, `PUT …/org/tunables` and `PATCH …/org/slo` all
 * read and write the same column with the same bounds.
 */
import { checkTunable, registerTunables, tunable, TUNABLES, parseTunables as parseAll, type TunableDef } from './org-tunables';

export interface TunableSpec { default: number; min: number; max: number; doc: string }

export const ASSURANCE_TUNABLES = {
  // signals (§5.1)
  'signals.staleTaskHours': { default: 24, min: 1, max: 720, doc: 'Hours without a run before a claimed/in-progress task is stale.' },
  'signals.reviewAgeHours': { default: 12, min: 1, max: 720, doc: 'Hours a task may wait in review before its reviewer is signalled.' },
  'signals.burnWarnPct': { default: 100, min: 50, max: 300, doc: 'Projected month-end spend as % of the envelope that warns the chief.' },
  'signals.burnCriticalPct': { default: 120, min: 60, max: 500, doc: 'Projected % of the envelope that is critical and reaches the CEO.' },
  'signals.idleMemberDays': { default: 7, min: 1, max: 90, doc: 'Days without a task or a run before a member is idle (org debt).' },
  'signals.overloadedOpenTasks': { default: 5, min: 1, max: 50, doc: 'Open tasks above which a member is overloaded (org debt).' },
  // SLO targets (§5.2)
  'slo.cycleTimeHours': { default: 48, min: 1, max: 2_160, doc: 'Target median hours from task creation to acceptance.' },
  'slo.firstReviewAcceptancePct': { default: 70, min: 1, max: 100, doc: 'Target share of tasks accepted on the first review round.' },
  'slo.decisionLatencyHours': { default: 24, min: 1, max: 2_160, doc: 'Target median hours a CEO decision card waits.' },
  // pulse weights (what this CEO cares about; normalised to 100)
  'pulse.weightCycle': { default: 25, min: 0, max: 100, doc: 'Weight of cycle time in the pulse score.' },
  'pulse.weightAcceptance': { default: 25, min: 0, max: 100, doc: 'Weight of first-review acceptance in the pulse score.' },
  'pulse.weightLatency': { default: 25, min: 0, max: 100, doc: 'Weight of decision latency in the pulse score.' },
  'pulse.weightHealth': { default: 25, min: 0, max: 100, doc: 'Weight of spend-vs-envelope and goal ownership in the pulse score.' },
  'pulse.criticalPenalty': { default: 5, min: 0, max: 25, doc: 'Points subtracted per open critical signal.' },
  // the auditor (§5.3)
  'audit.sampleSize': { default: 10, min: 1, max: 30, doc: 'Accepted tasks sampled per audit.' },
} satisfies Record<string, TunableSpec>;

export type AssuranceTunableKey = keyof typeof ASSURANCE_TUNABLES;

// One registry: the assurance keys join item 18's table at import time.
registerTunables(Object.fromEntries(Object.entries(ASSURANCE_TUNABLES).map(([k, v]): [string, TunableDef] => [k, {
  default: v.default, min: v.min, max: v.max, description: v.doc, area: 'assurance',
}])));

export function parseTunables(raw: unknown): Record<string, number> {
  return parseAll(typeof raw === 'string' ? raw : undefined);
}

/** The clamped value of a tunable for an org row (which carries `tunables`
 *  JSON; a row without the column, or with a bad value, yields the default). */
export function assuranceTunable(org: { tunables?: string | null } | Record<string, unknown>, key: AssuranceTunableKey): number {
  return tunable(org as { tunables?: string | null }, key);
}

/** Validate a patch against the shared registry: known keys must be finite
 *  numbers inside their bound (the message names it); null removes an
 *  override; a key no module registered is refused, so the SLO route and
 *  `org_tune` agree on what a tunable is. Returns the merged map. */
export function mergeTunables(current: Record<string, number>, patch: Record<string, unknown>): Record<string, number> {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) { delete next[k]; continue; }
    if (!TUNABLES[k]) throw new Error(`unknown tunable "${k}" — known: ${Object.keys(TUNABLES).join(', ')}`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${k} must be a number`);
    const check = checkTunable(k, v);
    if (!check.ok) throw new Error(`${k} must be between ${TUNABLES[k].min} and ${TUNABLES[k].max} (the bound is the safety floor)`);
    next[k] = check.value;
  }
  return next;
}
