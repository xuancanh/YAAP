/**
 * Assurance tunables (docs/company-vision.md §1b, §5): every threshold the
 * signals sweep, the SLOs, the pulse and the auditor use is a per-org
 * setting with a default and a bound, read from `organizations.tunables`
 * (JSON { key: number }). The chief tunes them (the `org_tune` tool, item 18)
 * to the company's culture; the bounds are the safety floor and stay in
 * code — a value outside them is clamped, never applied.
 *
 * TODO(rebase): item 18 adds `server/src/org/org-tunables.ts` with a generic
 * `tunable(org, key)` over the same column; switch `assuranceTunable` to it
 * and register these defaults there. Until then this module owns the keys
 * below and reads the column itself.
 */

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

export function parseTunables(raw: unknown): Record<string, number> {
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw || '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
    return out;
  } catch { return {}; }
}

/** The clamped value of a tunable for an org row (which carries `tunables`
 *  JSON; a row without the column, or with a bad value, yields the default). */
export function assuranceTunable(org: { tunables?: string | null } | Record<string, unknown>, key: AssuranceTunableKey): number {
  const spec: TunableSpec = ASSURANCE_TUNABLES[key];
  const v = parseTunables((org as { tunables?: unknown }).tunables)[key];
  if (v === undefined) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, v));
}

/** Validate a patch: known keys, finite numbers, inside the bounds. Returns
 *  the merged map; throws naming the first offending key. */
export function mergeTunables(current: Record<string, number>, patch: Record<string, unknown>): Record<string, number> {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    const spec = (ASSURANCE_TUNABLES as Record<string, TunableSpec | undefined>)[k];
    if (!spec) { if (v === null) { delete next[k]; continue; } next[k] = Number(v); continue; } // another module's key: pass through
    if (v === null) { delete next[k]; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${k} must be a number`);
    if (v < spec.min || v > spec.max) throw new Error(`${k} must be between ${spec.min} and ${spec.max} (the bound is the safety floor)`);
    next[k] = v;
  }
  return next;
}
