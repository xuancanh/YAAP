/**
 * Plugin tunables (docs/plugins.md §4.3 step 8, §4.8, §4.11): registered
 * on the shared registry so `org_tune` and `PUT …/org/tunables` reach them;
 * a workspace without an organization reads the defaults. None of them
 * parameterises a floor: they bound budgets and how long a key may wait.
 */
import { registerTunables, tunable, type TunableDef } from '../org/org-tunables';

export const PLUGINS_TUNABLES: Record<string, TunableDef> = {
  'plugins.monthlyUsd': { default: 25, min: 0, max: 10_000, area: 'plugins', description: 'The plugin envelope: metered USD every plugin call in the workspace may spend per calendar month (UTC); a call that would exceed it is refused before it runs.' },
  'plugins.gateDeadlineHours': { default: 72, min: 1, max: 720, area: 'plugins', description: 'Hours a change record may wait at its apply gate for the keys it needs; then it is rejected as unavailable (no answer is a no).' },
  'plugins.heldDeadlineHours': { default: 72, min: 1, max: 720, area: 'plugins', description: 'Hours a held plugin call may wait for the owner\'s key; then it is denied as unavailable.' },
};
registerTunables(PLUGINS_TUNABLES);

export function pluginsTunable(org: { tunables?: string | null } | null | undefined, key: keyof typeof PLUGINS_TUNABLES): number {
  return tunable(org, key);
}
