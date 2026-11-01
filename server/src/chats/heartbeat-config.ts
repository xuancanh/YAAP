/**
 * Heartbeat tunables (docs/company-vision.md §1b, §13; docs/triggers.md
 * "Heartbeat"): every number the gate uses is a default with a bound, set
 * per workspace (`workspaces.heartbeatDefaults`, JSON) and overridable per
 * agent on its heartbeat loop. The bounds live here, in code: culture
 * chooses within the fence, it never moves it.
 */
import { BadRequestException } from '@nestjs/common';
import { cronMatches } from './cron.util';

/** The built-in cadence (also the migrator's documented default). */
export const DEFAULT_HEARTBEAT_CRON = '*/30 * * * *';

export interface HeartbeatTunables {
  /** Five-field cron; the gate runs on each matching minute. */
  cron: string;
  /** Real (model) runs allowed per agent per UTC day. 0 = gate only. */
  dailyRunCap: number;
  /** A task untouched this long is a reason to wake. */
  staleMinutes: number;
}

/** Workspace-level overrides of the built-in defaults; '{}' = none. */
export type HeartbeatDefaults = Partial<HeartbeatTunables>;

export const HEARTBEAT_BUILTIN: HeartbeatTunables = { cron: DEFAULT_HEARTBEAT_CRON, dailyRunCap: 12, staleMinutes: 30 };

/** The fence. `minIntervalMinutes` is the shortest gap between two matching
 *  minutes a cron may have — a `* * * * *` heartbeat is refused. */
export const HEARTBEAT_BOUNDS = {
  minIntervalMinutes: 5,
  dailyRunCap: { min: 0, max: 48 },
  staleMinutes: { min: 5, max: 7 * 24 * 60 },
} as const;

/** Minutes between the first two matches of `cron` within the probe window,
 *  or null when it matches fewer than twice in 8 days (unusable as a
 *  heartbeat). Doubles as the staleness interval when none is configured. */
export function cronIntervalMinutes(cron: string, from = new Date(2026, 5, 1, 0, 0)): number | null {
  const start = from.getTime();
  let first: number | null = null;
  for (let m = 0; m < 8 * 24 * 60; m++) {
    if (!cronMatches(cron, new Date(start + m * 60_000))) continue;
    if (first === null) { first = m; continue; }
    return m - first;
  }
  return null;
}

/** Validate a cron as a heartbeat cadence against the fence. */
export function validateHeartbeatCron(cron: unknown): string {
  if (typeof cron !== 'string' || !cron.trim() || cron.length > 50) throw new BadRequestException('heartbeat cron must be a five-field cron string (≤50 chars)');
  const trimmed = cron.trim();
  const interval = cronIntervalMinutes(trimmed);
  if (interval === null) throw new BadRequestException(`heartbeat cron "${trimmed}" must match at least twice within 8 days`);
  if (interval < HEARTBEAT_BOUNDS.minIntervalMinutes) throw new BadRequestException(`heartbeat cron "${trimmed}" beats every ${interval} min; the floor is ${HEARTBEAT_BOUNDS.minIntervalMinutes}`);
  return trimmed;
}

function int(v: unknown, name: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new BadRequestException(`${name} must be an integer ${lo}..${hi}`);
  return v;
}

/** Validate a partial tunables object (workspace defaults or an agent
 *  override); unknown keys are dropped, absent keys stay absent. */
export function validateHeartbeatDefaults(raw: unknown): HeartbeatDefaults {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: HeartbeatDefaults = {};
  if (o.cron !== undefined && o.cron !== null && o.cron !== '') out.cron = validateHeartbeatCron(o.cron);
  if (o.dailyRunCap !== undefined && o.dailyRunCap !== null) out.dailyRunCap = int(o.dailyRunCap, 'dailyRunCap', HEARTBEAT_BOUNDS.dailyRunCap.min, HEARTBEAT_BOUNDS.dailyRunCap.max);
  if (o.staleMinutes !== undefined && o.staleMinutes !== null) out.staleMinutes = int(o.staleMinutes, 'staleMinutes', HEARTBEAT_BOUNDS.staleMinutes.min, HEARTBEAT_BOUNDS.staleMinutes.max);
  return out;
}

/** Parse the workspace column; malformed JSON reads as no overrides. */
export function parseHeartbeatDefaults(raw: string | null | undefined): HeartbeatDefaults {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as HeartbeatDefaults) : {};
  } catch { return {}; }
}

/** The agent columns the heartbeat reads ('' / null = inherit). */
export interface AgentHeartbeatColumns {
  heartbeatEnabled?: number | null;
  heartbeatCron?: string | null;
  heartbeatDailyRunCap?: number | null;
  heartbeatStaleMinutes?: number | null;
}

/** Effective tunables for one agent: built-in ← workspace ← the agent's own
 *  columns. The result is clamped to the fence even if a stored value
 *  predates a tighter bound. */
export function effectiveHeartbeat(ws: { heartbeatDefaults?: string | null } | null | undefined, agent: AgentHeartbeatColumns | null | undefined): HeartbeatTunables {
  const wsDefaults = parseHeartbeatDefaults(ws?.heartbeatDefaults);
  const cron = agent?.heartbeatCron || wsDefaults.cron || HEARTBEAT_BUILTIN.cron;
  const cap = agent?.heartbeatDailyRunCap ?? wsDefaults.dailyRunCap ?? HEARTBEAT_BUILTIN.dailyRunCap;
  const stale = agent?.heartbeatStaleMinutes ?? wsDefaults.staleMinutes ?? HEARTBEAT_BUILTIN.staleMinutes;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    cron,
    dailyRunCap: clamp(cap, HEARTBEAT_BOUNDS.dailyRunCap.min, HEARTBEAT_BOUNDS.dailyRunCap.max),
    staleMinutes: clamp(stale, HEARTBEAT_BOUNDS.staleMinutes.min, HEARTBEAT_BOUNDS.staleMinutes.max),
  };
}
