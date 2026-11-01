/**
 * Incident and degradation tunables (docs/company-vision.md §1b,
 * docs/incidents.md; execution-plan item 29): what containment each
 * severity gets, how many tool errors in a row are an incident, when a
 * provider counts as degraded and how long before it is probed again — and
 * the audit-independence knobs (the CEO's spot checks, auditor rotation, the
 * red-team cadence). Registered on the shared registry so `org_tune` and
 * `PUT …/org/tunables` reach them; the bounds are the fence (a critical
 * incident always pauses the member at least).
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';

/** Containment levels, cumulative: each includes the ones before it. */
export const CONTAINMENT_LEVELS = {
  /** 0: a signal and a note on the incident; nothing is paused. */
  note: 0,
  /** 1: pause the member and drop its queued wakes. */
  pause: 1,
  /** 2: also freeze the action class workspace-wide when it is external. */
  freeze: 2,
  /** 3: also drop an autonomous company to supervised until the CEO resumes. */
  supervise: 3,
} as const;

export const INCIDENT_TUNABLES: Record<string, TunableDef> = {
  'incidents.containMinor': { default: 0, min: 0, max: 3, area: 'incidents', description: 'Containment for a minor incident: 0 signal and note, 1 pause the member, 2 also freeze its external action class, 3 also drop autonomous to supervised.' },
  'incidents.containMajor': { default: 1, min: 0, max: 3, area: 'incidents', description: 'Containment for a major incident (same scale; default: pause the member and drop its queued wakes).' },
  'incidents.containCritical': { default: 3, min: 1, max: 3, area: 'incidents', description: 'Containment for a critical incident (same scale; at least a pause; default: pause, freeze the external class, supervised).' },
  'incidents.toolErrorStreak': { default: 5, min: 2, max: 50, area: 'incidents', description: 'Tool errors in a row by one member that open a minor incident.' },
  'degrade.providerFailures': { default: 3, min: 1, max: 20, area: 'incidents', description: 'Transient provider failures (5xx, 429, timeouts) within the window that mark a provider degraded for the workspace.' },
  'degrade.windowSeconds': { default: 300, min: 30, max: 3_600, area: 'incidents', description: 'The window, in seconds, the provider failures are counted over.' },
  'degrade.cooldownSeconds': { default: 600, min: 60, max: 86_400, area: 'incidents', description: 'Seconds a degraded provider is avoided before one turn probes it again.' },
  'audit.ownerSpotChecks': { default: 2, min: 0, max: 10, area: 'assurance', description: 'Items of each audit the CEO is asked to spot-check (agree or not with the auditor), which measures the auditor\'s precision and recall; 0 = none.' },
  'audit.rotateEveryAudits': { default: 4, min: 1, max: 20, area: 'assurance', description: 'Audits before the auditor seat rotates to the next eligible member.' },
  'redteam.cadenceDays': { default: 7, min: 0, max: 60, area: 'assurance', description: 'Days between red-team runs (canary prompt injections against one member, record-only tools); 0 = off.' },
};
registerTunables(INCIDENT_TUNABLES);

export function incidentTunable(org: unknown, key: keyof typeof INCIDENT_TUNABLES): number {
  return tunable(org as { tunables?: string | null } | null, key);
}
