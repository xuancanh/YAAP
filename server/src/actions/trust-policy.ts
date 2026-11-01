/**
 * The trust policy — pure, bounded, model-free (docs/actions-and-trust.md
 * §5–§6, docs/autonomous-org-first-principles.md C10, execution-plan item 28).
 *
 * A level per (agent, action class):
 *
 *   0  proposes only — the owner decides
 *   1  acts, the owner is notified after
 *   2  acts, a peer checks (the action reviewer on every call; a second
 *      agent key on a different model family for irreversible and money)
 *   3  acts, only the auditor samples
 *
 * `decide` turns (class, effective level, whether a person is at the
 * keyboard, whether a staging twin exists) into one decision. The matrix is
 * code, not data: the owner moves levels and ceilings, never the meaning of
 * a level. `applyOutcome` / `applyIncident` are the ledger's arithmetic:
 * promotion after N clean outcomes since the last change (and a calibration
 * bar once the prediction ledger exists), demotion by one on a rejection
 * streak or an incident, to 0 on a critical incident.
 */
import type { ActionClass } from './action-classes';

export type TrustLevel = 0 | 1 | 2 | 3;
export const TRUST_LEVELS: readonly TrustLevel[] = [0, 1, 2, 3];

export function clampLevel(n: unknown): TrustLevel {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(3, v)) as TrustLevel;
}

/** What the owner allows at most, per class, until they change it. */
export const DEFAULT_CEILINGS: Record<ActionClass, TrustLevel> = {
  read: 3, internal_write: 3, external_reversible: 2, external_irreversible: 1, money: 0,
};

/** Where a new agent starts (never above the ceiling). */
export const DEFAULT_START: Record<ActionClass, TrustLevel> = {
  read: 3, internal_write: 2, external_reversible: 1, external_irreversible: 0, money: 0,
};

/** Organization mode as a ceiling preset: supervised caps every external
 *  class at 1 (act-and-notify at most; irreversible and money never without
 *  the owner); autonomous and off leave the ledger's ceilings. */
export const SUPERVISED_EXTERNAL_CAP: TrustLevel = 1;

export function presetCap(orgMode: string | null | undefined, cls: ActionClass): TrustLevel {
  if (orgMode === 'supervised' && (cls === 'external_reversible' || cls === 'external_irreversible' || cls === 'money')) return SUPERVISED_EXTERNAL_CAP;
  return 3;
}

/** The level that governs a call: the earned level under the owner's
 *  ceiling and the organization preset. */
export function effectiveLevel(p: { level: number; ceiling: number; orgMode?: string | null; cls: ActionClass }): TrustLevel {
  return clampLevel(Math.min(p.level, p.ceiling, presetCap(p.orgMode, p.cls)));
}

/**
 * The decision for one call.
 *
 *  run         execute (the action reviewer still reads it when it would run without a fresh human decision)
 *  run_notify  execute, then tell the owner (level 1, nobody at the keyboard)
 *  ask         pause inline for the person at the keyboard — the owner's key
 *  hold        nobody at the keyboard: held for the owner's key in the inbox / org approvals
 *  stage       convert to the staging twin, then an approval to promote it
 *  cosign      a second, independent agent key (different model family) decides; none available → owner key
 */
export type TrustDecision = 'run' | 'run_notify' | 'ask' | 'hold' | 'stage' | 'cosign';

export function decide(p: { cls: ActionClass; level: TrustLevel; humanPresent: boolean; hasStaging: boolean }): TrustDecision {
  const ownerKey: TrustDecision = p.humanPresent ? 'ask' : p.hasStaging ? 'stage' : 'hold';
  if (p.cls === 'read') return 'run';
  if (p.cls === 'external_irreversible' || p.cls === 'money') {
    if (p.level >= 3) return 'run';
    if (p.level === 2) return 'cosign';
    return ownerKey;
  }
  // internal_write, external_reversible
  if (p.level === 0) return p.humanPresent ? 'ask' : 'hold';
  // Level 1 tells the owner after an unattended outward act; an internal
  // write at level 1 acts on the record alone (the action log), since a
  // notification per file or board edit would be noise the owner learns to skip.
  if (p.level === 1) return p.humanPresent || p.cls === 'internal_write' ? 'run' : 'run_notify';
  return 'run';
}

/** The matrix in words, for GET …/trust and the docs. */
export function describeMatrix(): Array<{ cls: ActionClass; levels: Record<TrustLevel, string> }> {
  const word = (d: TrustDecision): string => ({
    run: 'acts', run_notify: 'acts, owner notified after', ask: 'asks the person present', hold: 'held for the owner\'s key',
    stage: 'staged (draft), owner promotes', cosign: 'acts with a second agent key (other model family)',
  })[d];
  return (['read', 'internal_write', 'external_reversible', 'external_irreversible', 'money'] as ActionClass[]).map((cls) => {
    const levels = {} as Record<TrustLevel, string>;
    for (const l of TRUST_LEVELS) {
      const absent = decide({ cls, level: l, humanPresent: false, hasStaging: cls === 'external_irreversible' });
      const present = decide({ cls, level: l, humanPresent: true, hasStaging: cls === 'external_irreversible' });
      levels[l] = absent === present ? word(absent) : `${word(present)} (present) · ${word(absent)} (unattended)`;
    }
    return { cls, levels };
  });
}

// ---- the ledger's arithmetic ----

export type TrustOutcome = 'success' | 'reverted' | 'rejected' | 'incident' | 'deduplicated';
export const TRUST_OUTCOMES: readonly TrustOutcome[] = ['success', 'reverted', 'rejected', 'incident', 'deduplicated'];

export interface LedgerRow {
  level: TrustLevel;
  ceiling: TrustLevel;
  cleanCount: number;
  rejectStreak: number;
}

export interface LedgerChange { from: TrustLevel; to: TrustLevel; reason: string }

export interface LedgerTunables {
  promoteAfterClean: number;
  demoteAfterRejections: number;
  /** null = no calibration ledger yet (the bar is not applied). */
  calibration: number | null;
  calibrationBar: number;
}

/** One outcome applied to a row. Pure: returns the next row and the change, if any. */
export function applyOutcome(row: LedgerRow, outcome: TrustOutcome, t: LedgerTunables): { row: LedgerRow; change: LedgerChange | null } {
  const next: LedgerRow = { ...row };
  switch (outcome) {
    case 'deduplicated':
      return { row: next, change: null }; // neutral: a retry is not a new act
    case 'success': {
      next.cleanCount += 1;
      next.rejectStreak = 0;
      const calibrated = t.calibration === null || t.calibration >= t.calibrationBar;
      if (next.cleanCount >= t.promoteAfterClean && next.level < next.ceiling && calibrated) {
        const to = clampLevel(next.level + 1);
        const change = { from: next.level, to, reason: `${next.cleanCount} clean outcome(s) since the last change` };
        next.level = to; next.cleanCount = 0;
        return { row: next, change };
      }
      return { row: next, change: null };
    }
    case 'rejected': {
      next.rejectStreak += 1;
      next.cleanCount = 0;
      if (next.rejectStreak >= t.demoteAfterRejections && next.level > 0) {
        const to = clampLevel(next.level - 1);
        const change = { from: next.level, to, reason: `${next.rejectStreak} rejection(s) in a row` };
        next.level = to; next.rejectStreak = 0;
        return { row: next, change };
      }
      return { row: next, change: null };
    }
    case 'reverted':
    case 'incident': {
      // A revert the owner reported counts as a minor incident: one level down at once.
      return applyIncident(row, 'minor', outcome === 'reverted' ? 'the owner reported a revert' : 'incident');
    }
  }
}

export function applyIncident(row: LedgerRow, severity: 'minor' | 'major' | 'critical', why: string): { row: LedgerRow; change: LedgerChange | null } {
  const next: LedgerRow = { ...row, cleanCount: 0, rejectStreak: 0 };
  const to = severity === 'critical' ? 0 : clampLevel(row.level - 1);
  if (to === row.level) return { row: next, change: null };
  next.level = to;
  return { row: next, change: { from: row.level, to, reason: `${why} (${severity})` } };
}

/** The calibration hook (C7, item 30): the agent's forecast calibration in
 *  0–1 once the prediction ledger exists. Until then null, and promotion
 *  needs clean outcomes only. */
export function calibrationOf(agentId: string): number | null {
  void agentId;
  return null;
}
