/**
 * Governance tunables (execution-plan item 31; docs/boundary.md,
 * docs/evals.md, docs/owners-seat.md, docs/company-vision.md §1b): every
 * threshold the self-modification boundary, the eval gate, the capacity
 * model and the owner's seat read is a per-org setting with a default and a
 * bound on the one registry of org-tunables.ts, so `PUT …/org/tunables`
 * reaches them. The boundary table decides who may change them: the
 * `boundary.*` keys are never an agent's, the `evals.*` and `seat.*` keys
 * only through a proposal, `capacity.*` alone within the bound.
 *
 * Default-approve is a per-kind switch only for the reversible internal
 * kinds (`seat.defaultApprove.<kind>`); there is deliberately no key for an
 * irreversible or money kind, and `defaultActionFor` refuses them in code
 * whatever is stored.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';

/** Kinds whose card may default to approve at its deadline (reversible and internal). */
export const DEFAULT_APPROVABLE_KINDS = ['tune', 'cadence', 'routing', 'escalation', 'scope_widen', 'reorg', 'strategy', 'charter_change', 'metric_source', 'human_review'] as const;
const DEFAULT_APPROVE_ON = new Set<string>(['tune', 'cadence', 'routing']);

export const GOVERNANCE_TUNABLES: Record<string, TunableDef> = {
  // boundary (docs/boundary.md)
  'boundary.experimentFallbackCard': { default: 1, min: 0, max: 1, area: 'boundary', description: '1: an experiment-only change becomes an approval card while no experiments service is available; 0: it is refused outright.' },
  // evals (docs/evals.md)
  'evals.casesPerRole': { default: 20, min: 1, max: 200, area: 'evals', description: 'Golden-set cases kept per role; harvesting stops at the cap (the CEO may retire cases).' },
  'evals.casesPerRun': { default: 5, min: 1, max: 20, area: 'evals', description: 'Cases one eval run replays (the newest first).' },
  'evals.runUsdCap': { default: 1, min: 0.05, max: 20, area: 'evals', description: 'USD one eval run may spend, reserved against the member\'s and the company envelopes; cases past it are skipped.' },
  'evals.regressionMargin': { default: 0.1, min: 0, max: 0.5, area: 'evals', description: 'A candidate regresses when its pass rate is below the baseline\'s by more than this (0–1).' },
  'evals.baselineCacheDays': { default: 7, min: 0, max: 30, area: 'evals', description: 'Days a baseline run of the current configuration is reused for the same cases; 0 = always rerun.' },
  'evals.harvestReviewMaxRounds': { default: 0, min: 0, max: 2, area: 'evals', description: 'A task accepted by review becomes a golden case only when it was accepted within this many request-changes rounds (0 = first time: the strong verdict).' },
  'evals.gate': { default: 1, min: 0, max: 1, area: 'evals', description: '1: charter changes, new playbook versions and agent routing changes replay the role\'s golden set before they roll out; 0: off.' },
  // capacity (docs/autonomous-org-first-principles.md C4)
  'capacity.wipPerMember': { default: 3, min: 1, max: 20, area: 'capacity', description: 'Open tasks (todo, claimed, in progress, blocked) one member may hold; assignment and claiming beyond it are refused unless the chief overrides with a reason.' },
  'capacity.historyDays': { default: 60, min: 7, max: 365, area: 'capacity', description: 'Trailing days of finished tasks the expected duration per task class is computed from.' },
  'capacity.dueSoonHours': { default: 24, min: 1, max: 168, area: 'capacity', description: 'A task due within this many hours is urgent for the heartbeat.' },
  'capacity.overdueEscalateHours': { default: 24, min: 1, max: 336, area: 'capacity', description: 'Hours a task may stay overdue with its owner before the signal goes to the unit lead.' },
  // the owner's seat (docs/owners-seat.md)
  'seat.deadlineHours': { default: 48, min: 1, max: 71, area: 'seat', description: 'Hours from a card\'s creation to its decision deadline (always before the 72 h expiry).' },
  'seat.noOutcomeWeeks': { default: 4, min: 1, max: 26, area: 'seat', description: 'Weeks a unit\'s objectives may show no measured key-result movement before a no_outcome signal tells the chief to shrink it.' },
  'seat.hopTimeoutHours': { default: 12, min: 1, max: 48, area: 'seat', description: 'Hours a manager may hold a decision card before it climbs one level on its own with "no recommendation (timed out)" (docs/owners-seat.md §7).' },
  'seat.urgentHopTimeoutHours': { default: 2, min: 0.25, max: 12, area: 'seat', description: 'The same window for an urgent card (a held outward action, an urgent escalation).' },
  'seat.defaultConfidence': { default: 0.5, min: 0, max: 1, area: 'seat', description: 'Confidence written on a system-generated card that states none.' },
  ...Object.fromEntries(DEFAULT_APPROVABLE_KINDS.map((k): [string, TunableDef] => [`seat.defaultApprove.${k}`, { default: DEFAULT_APPROVE_ON.has(k) ? 1 : 0, min: 0, max: 1, area: 'seat', description: `1: a ${k.replace(/_/g, ' ')} card the CEO does not answer is approved at its deadline; 0: denied. Irreversible and money cards always default to deny.` }])),
};
registerTunables(GOVERNANCE_TUNABLES);

export function govTunable(org: { tunables?: string | null } | null | undefined, key: string): number {
  return tunable(org, key);
}
