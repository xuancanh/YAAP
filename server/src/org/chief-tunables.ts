/**
 * The chief of staff's operating-system tunables (docs/chief-of-staff.md;
 * reports/Chief of staff operating model.md, "An AI chief of staff is a
 * profile, a ledger and a bounded mandate"). Every cadence, timer and
 * hygiene threshold the chief runs the company's operating system by is a
 * per-org setting with a default and a bound on the one registry of
 * org-tunables.ts, so `org_tune` and `PUT …/org/tunables` reach them. The
 * defaults are only starting points: onboarding derives the values from the
 * operating profile (`chief-os.ts` `deriveOperatingSystem`) and the chief
 * proposes changes as the company changes.
 *
 * `chief.proxyLevel` is the archetype dial (Conductor ↔ CEO brain
 * extension). Proxy scope is earned, never self-granted, so the boundary
 * makes it a proposal for the CEO (docs/boundary.md); the chief may tune
 * every other key here alone within its bound.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';

/** The archetype dial's settings (Bain Capital Ventures' four archetypes). */
export const PROXY_LEVELS = ['generalist', 'conductor', 'stand-in', 'brain-extension'] as const;
export type ProxyLevel = (typeof PROXY_LEVELS)[number];

export const CHIEF_TUNABLES: Record<string, TunableDef> = {
  'chief.proxyLevel': { default: 1, min: 0, max: 3, area: 'chief', description: 'Where the chief sits on the archetype axis: 0 early-team generalist, 1 conductor (cadence, follow-through), 2 functional stand-in, 3 CEO brain extension (cross-team prioritisation, board prep). Proxy scope is earned: only the CEO raises it.' },
  'chief.maxObjectives': { default: 5, min: 1, max: 8, area: 'chief', description: 'Active company objectives above which goal hygiene flags the plan as unfocused (Google re:Work: three to five).' },
  'chief.preReadHours': { default: 48, min: 0, max: 168, area: 'chief', description: 'Hours before a ritual that its pre-reads are due; the chief chases owners from this point (GitLab: T−2 days).' },
  'chief.ritualLookaheadHours': { default: 48, min: 6, max: 336, area: 'chief', description: 'How far ahead the chief\'s heartbeat lists the rituals coming up.' },
  'chief.handoffSlaHours': { default: 24, min: 1, max: 336, area: 'chief', description: 'Hours a task handed from one unit to another may sit without moving before the handoff is breached and goes to the shared manager or the issues list.' },
  'chief.decisionOverdueHours': { default: 24, min: 1, max: 336, area: 'chief', description: 'Hours a decision card may wait for the CEO before the chief lists it as overdue.' },
  'chief.riskReviewDays': { default: 14, min: 1, max: 90, area: 'chief', description: 'Days an at-risk key result or an open warning may go without a fresh check-in or acknowledgement before it is a stale risk.' },
  'chief.offTrackWeeks': { default: 2, min: 1, max: 8, area: 'chief', description: 'Weeks a key result may stay off track with no issue raised before goal hygiene flags it.' },
  'chief.sunsetEmptyCycles': { default: 3, min: 1, max: 12, area: 'chief', description: 'Consecutive cycles a ritual\'s output may be empty (no decision, no action) before the chief proposes retiring it.' },
  'chief.memoFirst': { default: 0, min: 0, max: 1, area: 'chief', description: '1: every decision item needs a written pre-read before the forum; 0: only one-way-door decisions do.' },
};
registerTunables(CHIEF_TUNABLES);

export function chiefTunable(org: { tunables?: string | null } | null | undefined, key: keyof typeof CHIEF_TUNABLES): number {
  return tunable(org, key);
}

export function proxyLevelOf(org: { tunables?: string | null } | null | undefined): ProxyLevel {
  return PROXY_LEVELS[Math.round(chiefTunable(org, 'chief.proxyLevel'))] ?? 'conductor';
}
