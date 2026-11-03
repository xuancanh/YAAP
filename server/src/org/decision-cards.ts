/**
 * Decision cards (docs/owners-seat.md §1, execution-plan item 31, C12): the
 * pure half. Every approval carries a recommendation, alternatives,
 * reversibility, a confidence, a deadline and a default action the tick
 * applies at the deadline, so the owner's silence is a decision rather than a
 * stall. Reversibility comes from the card's kind, or from the action class
 * of a held action (`two_key`); irreversible and money cards always default
 * to deny, whatever is stored. Model-free.
 */
import { govTunable, DEFAULT_APPROVABLE_KINDS } from './governance-tunables';

export type Reversibility = 'reversible' | 'costly' | 'irreversible';
export const REVERSIBILITIES: readonly Reversibility[] = ['reversible', 'costly', 'irreversible'];
export type RecommendedAction = 'approve' | 'deny' | 'modify';
export const RECOMMENDED_ACTIONS: readonly RecommendedAction[] = ['approve', 'deny', 'modify'];
export type DefaultAction = 'approve' | 'deny';

const KIND_REVERSIBILITY: Record<string, Reversibility> = {
  hire: 'costly', scope_widen: 'reversible', reorg: 'reversible', budget_raise: 'costly', strategy: 'reversible',
  external: 'irreversible', terminate: 'costly', escalation: 'reversible', tune: 'reversible', cadence: 'reversible',
  routing: 'reversible', charter_change: 'reversible', blueprint: 'costly', human_review: 'reversible', metric_source: 'reversible',
  two_key: 'irreversible', experiment: 'reversible',
  project_now: 'reversible', project_appetite: 'costly', project_kill: 'costly',
};

/** Reversibility of a card: the action class for a held action, else the kind's. */
export function reversibilityOf(kind: string, payload: Record<string, unknown>): Reversibility {
  if (kind === 'two_key') {
    const cls = String(payload.class ?? '');
    return cls === 'external_reversible' || cls === 'internal_write' || cls === 'read' ? 'reversible' : 'irreversible';
  }
  return KIND_REVERSIBILITY[kind] ?? 'irreversible';
}

/** Whether a card spends money (a budget raise, a money-class held action). */
export function isMoneyCard(kind: string, payload: Record<string, unknown>): boolean {
  return kind === 'budget_raise' || (kind === 'two_key' && String(payload.class ?? '') === 'money') || (kind === 'hire' && Number(payload.monthlyBudgetUsd ?? 0) > 0);
}

/** The USD a card commits, when it says (for a delegation's maxUsd). */
export function amountUsdOf(kind: string, payload: Record<string, unknown>): number | null {
  if (kind === 'budget_raise') return Math.max(0, Number(payload.monthlyUsd ?? 0) - Number(payload.current ?? 0));
  if (kind === 'hire') return Math.max(0, Number(payload.monthlyBudgetUsd ?? 0));
  if (typeof payload.usd === 'number') return payload.usd;
  if (typeof payload.amountUsd === 'number') return payload.amountUsd;
  return kind === 'two_key' && String(payload.class ?? '') === 'money' ? null : 0;
}

/** The default action at the deadline: deny for irreversible, money and
 *  boundary-routed cards; approve only for a reversible internal kind whose
 *  `seat.defaultApprove.<kind>` is 1. Never approve-by-default otherwise. */
export function defaultActionFor(org: { tunables?: string | null } | null, kind: string, payload: Record<string, unknown>): DefaultAction {
  if (reversibilityOf(kind, payload) !== 'reversible') return 'deny';
  if (isMoneyCard(kind, payload)) return 'deny';
  if (payload.boundary === 'propose' || payload.boundary === 'experiment') return 'deny';
  if (!(DEFAULT_APPROVABLE_KINDS as readonly string[]).includes(kind)) return 'deny';
  return govTunable(org, `seat.defaultApprove.${kind}`) >= 1 ? 'approve' : 'deny';
}

/** Alternatives a system-generated card offers when the proposer named none. */
export function computedAlternatives(kind: string): string[] {
  switch (kind) {
    case 'hire': return ['Reject: keep the current team and re-plan the work', 'Revise: a cheaper role or a smaller envelope'];
    case 'budget_raise': return ['Reject: keep the envelope and cut scope', 'Revise: a smaller raise'];
    case 'two_key': return ['Reject: the action does not run', 'Revise: stage it for a later send'];
    case 'escalation': return ['Reject: cancel the task', 'Revise: rebrief and continue'];
    case 'project_now': return ['Reject: keep it in Next or Later', 'Revise: reshape it (a smaller appetite, a sharper brief)'];
    case 'project_appetite': return ['Reject: kill the project (cancel its open tasks)', 'Revise: cut scope — finish what fits a small extension'];
    case 'project_kill': return ['Reject: keep the project running', 'Revise: move it back to Next instead'];
    default: return ['Reject: keep things as they are', 'Revise: ask the proposer for a different change'];
  }
}

export function normalizeAlternatives(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw] : [];
  return list.map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 6);
}

export function clamp01(n: unknown): number | null {
  const v = Number(n);
  if (n === undefined || n === null || n === '' || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}
