/**
 * Tunables — the per-organization settings every adaptive mechanism reads
 * (docs/company-vision.md §1b). Nothing in the company is a fixed rule:
 * each threshold is a **tunable with a default and a bound**, stored as JSON
 * on `organizations.tunables` and read through `tunable(org, key)`, which
 * clamps whatever is stored to the bound and falls back to the default. The
 * bounds are the safety floor and live in code; culture chooses within them.
 *
 * Other items register their own keys with `registerTunables` (rituals,
 * assurance, heartbeat), so one column and one helper serve the company.
 * The chief tunes with `org_tune` (within bounds in autonomous mode, an
 * approval card in supervised mode); the CEO with `PUT …/org/tunables`.
 * Every change is a decision-style audit row (`tunable_set`).
 */

export interface TunableDef {
  default: number;
  min: number;
  max: number;
  /** One line for the CEO and the chief. */
  description: string;
  /** Who else reads it, for the settings card. */
  area: 'intent' | 'planning' | 'rituals' | 'assurance' | 'heartbeat' | 'brief' | 'capital' | 'memory' | 'sensing' | 'incidents';
}

/** The registry: item 18's keys here, other items' keys through registerTunables. */
export const TUNABLES: Record<string, TunableDef> = {
  'intent.paceTolerance': { default: 0.15, min: 0.02, max: 0.5, area: 'intent', description: 'How far (0–1) a key result may trail its linear pace before it is at risk.' },
  'intent.confidenceDrops': { default: 2, min: 1, max: 5, area: 'intent', description: 'Consecutive check-ins with falling confidence that put a key result at risk.' },
  'intent.overdueCadences': { default: 2, min: 1, max: 6, area: 'intent', description: 'Missed cadences before a key result is at risk for want of a check-in.' },
  'intent.checkInCadenceDays': { default: 7, min: 1, max: 90, area: 'intent', description: 'Default days between check-ins on a new key result.' },
  'intent.objectiveRiskCount': { default: 2, min: 1, max: 5, area: 'intent', description: 'At-risk key results under one objective that put the objective at risk.' },
  'planning.debounceSeconds': { default: 120, min: 0, max: 3_600, area: 'planning', description: 'How long a unit waits for more reasons before one planning session.' },
  'planning.cooldownSeconds': { default: 1_800, min: 0, max: 86_400, area: 'planning', description: 'Minimum gap between two planning sessions of one unit.' },
  'planning.objectivesPerVision': { default: 4, min: 1, max: 8, area: 'planning', description: 'Objectives the chief aims for per vision (the prompt\'s guidance, not a cap).' },
  'planning.keyResultsPerObjective': { default: 3, min: 1, max: 6, area: 'planning', description: 'Key results the facilitator aims for per objective.' },
  // Capital (docs/company-vision.md §7–§8, item 23): read by OrgCapitalService and the runtime.
  'capital.overspendMargin': { default: 0.2, min: 0, max: 1, area: 'capital', description: 'How far (0–1) an objective\'s share of its envelope may exceed its measured progress before the brief flags it as overspending.' },
  'capital.vetoWindowMinutes': { default: 30, min: 0, max: 1_440, area: 'capital', description: 'Minutes the CEO has to veto a plan the autonomous chief prepared before its structural actions apply; 0 applies at once.' },
  'capital.forecastWindowDays': { default: 7, min: 1, max: 30, area: 'capital', description: 'Trailing days the burn-rate forecast averages over.' },
};

/** Another item adds its keys (idempotent; an existing key keeps its first definition). */
export function registerTunables(defs: Record<string, TunableDef>): void {
  for (const [k, v] of Object.entries(defs)) if (!TUNABLES[k]) TUNABLES[k] = v;
}

export function parseTunables(raw: string | null | undefined): Record<string, number> {
  try {
    const v = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, x] of Object.entries(v ?? {})) if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    return out;
  } catch { return {}; }
}

/** The effective value: stored, clamped to the bound; the default otherwise. */
export function tunable(org: { tunables?: string | null } | null | undefined, key: string): number {
  const def = TUNABLES[key];
  if (!def) throw new Error(`unknown tunable "${key}"`);
  const stored = parseTunables(org?.tunables)[key];
  if (stored === undefined) return def.default;
  return Math.min(def.max, Math.max(def.min, stored));
}

/** Validate a proposed value against the bound; the message names the fence. */
export function checkTunable(key: string, value: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  const def = TUNABLES[key];
  if (!def) return { ok: false, reason: `unknown tunable "${key}" — known: ${Object.keys(TUNABLES).join(', ')}` };
  const v = Number(value);
  if (!Number.isFinite(v)) return { ok: false, reason: `${key} needs a number` };
  if (v < def.min || v > def.max) return { ok: false, reason: `${key} must stay within ${def.min}–${def.max} (the safety floor; default ${def.default})` };
  return { ok: true, value: v };
}

/** Every tunable with its default, bound and the org's effective value. */
export function describeTunables(org: { tunables?: string | null } | null | undefined): Array<TunableDef & { key: string; value: number; stored: number | null }> {
  const stored = parseTunables(org?.tunables);
  return Object.entries(TUNABLES).map(([key, def]) => ({ key, ...def, value: tunable(org, key), stored: stored[key] ?? null }));
}
