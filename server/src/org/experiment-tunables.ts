/**
 * Experiment, prediction and reconciliation tunables (docs/experiments.md,
 * execution-plan item 30; docs/company-vision.md §1b): the default window
 * and its bounds, the noise guard, extensions, how many experiments may run
 * at once in one unit, the calibration window and the overclaim threshold.
 * Registered on the shared registry (areas `experiments` and
 * `predictions`), so `org_tune` and `PUT …/org/tunables` reach them; the
 * bounds are the fence.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';

export const EXPERIMENT_TUNABLES: Record<string, TunableDef> = {
  'experiments.windowDays': { default: 14, min: 3, max: 90, area: 'experiments', description: 'Default days an experiment runs before its verdict; a proposal\'s own window must stay within these bounds.' },
  'experiments.minSamples': { default: 5, min: 2, max: 100, area: 'experiments', description: 'Samples the baseline and the window each need before a verdict is more than inconclusive.' },
  'experiments.noiseFloor': { default: 1, min: 0.25, max: 3, area: 'experiments', description: 'A difference counts only when it exceeds this many baseline standard deviations (the noise guard).' },
  'experiments.maxExtensions': { default: 1, min: 0, max: 3, area: 'experiments', description: 'Times an inconclusive experiment is extended by its window before it is reverted.' },
  'experiments.concurrentPerUnit': { default: 1, min: 1, max: 5, area: 'experiments', description: 'Experiments that may run at once in one unit, so their effects do not confound.' },
  'predictions.calibrationWindow': { default: 20, min: 5, max: 200, area: 'predictions', description: 'The last N resolved forecasts a member\'s calibration is computed from.' },
  'predictions.calibrationMinCount': { default: 5, min: 3, max: 50, area: 'predictions', description: 'Resolved forecasts a member needs before it has a calibration score (none below it).' },
  'reconciliation.overclaimConfidence': { default: 0.7, min: 0.5, max: 0.95, area: 'predictions', description: 'Owner confidence at or above this on two check-ins in a row while the measured pace is behind is an overclaim.' },
};
registerTunables(EXPERIMENT_TUNABLES);

export function experimentTunable(org: unknown, key: keyof typeof EXPERIMENT_TUNABLES): number {
  return tunable(org as { tunables?: string | null } | null, key);
}
