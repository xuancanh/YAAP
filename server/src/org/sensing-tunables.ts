/**
 * Sensing and acceptance tunables (docs/sensing.md, execution-plan item 27;
 * docs/company-vision.md §1b): every threshold the metric sources and the
 * task checks read is a per-org setting with a default and a bound, on the
 * one registry of org-tunables.ts (area `sensing`), so `org_tune`,
 * `PUT …/org/tunables` and the Tunables editor read and write them like any
 * other.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';

export const SENSING_TUNABLES: Record<string, TunableDef> = {
  'sensing.staleMultiplier': { default: 3, min: 1, max: 20, area: 'sensing', description: 'A metric source with no sample in this many poll intervals is stale (a metric_stale signal to the chief).' },
  'sensing.minPollMinutes': { default: 5, min: 1, max: 1_440, area: 'sensing', description: 'The shortest poll interval a metric source may have.' },
  'acceptance.alsoReviewWhenChecksPass': { default: 0, min: 0, max: 1, area: 'sensing', description: '1: a task whose checks all pass still gets a model review when done_when has qualitative text; 0: the checks accept it.' },
  'acceptance.checkTimeoutSeconds': { default: 10, min: 2, max: 60, area: 'sensing', description: 'Seconds one check (an HTTP call, a connection query) may take before it errors.' },
};
registerTunables(SENSING_TUNABLES);

export function sensingTunable(org: { tunables?: string | null } | null | undefined, key: keyof typeof SENSING_TUNABLES): number {
  return tunable(org, key);
}
