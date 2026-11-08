/**
 * Automatic model selection by task complexity (docs/agent-types.md "Model
 * selection", docs/company-vision.md §7). Pure: no I/O, no model call.
 *
 * An agent in `auto` mode does not run on one fixed model. For each task
 * run, and for each chat or channel turn, the platform scores how complex
 * the work is from signals it already has — the task class, the brief's
 * size and structure, acceptance criteria and checks, how strict the
 * quality bar is, whether the work is risky, dependencies and cross-unit
 * scope — and picks a tier (cheap / standard / strong). The tier then moves
 * with what happened before (a step that declares a tier, failed or
 * reworked attempts escalate, the agent's record at the class), with the
 * agent's own request (`request_model_tier`, capped), and with money (a
 * tight envelope downgrades), always inside the workspace's floor and
 * ceiling and never below the risk floor for risky work. The CEO's routing
 * pins (org routing: class → tier, tier → model) still override.
 *
 * The tier becomes a model on an agent type: the agent's own type, or —
 * when the owner allows it and several are configured (Claude and OpenAI
 * by default) — another, by the owner's preference order, provider health,
 * price, and quality's rule that a verifier runs on another model family
 * than the maker's. Every decision records its tier, model and reasons.
 */
import { isKnownModel, isTierName, modelFamily, tierModelForType, typeFamily, TIERS, type ModelTypeLike, type Tier } from './model-resolution';

export type ModelMode = 'auto' | 'fixed';
export const MODEL_MODES = ['auto', 'fixed'] as const;
export function isModelMode(v: unknown): v is ModelMode { return v === 'auto' || v === 'fixed'; }

export const tierIndex = (t: Tier): number => TIERS.indexOf(t);
export const tierAt = (i: number): Tier => TIERS[Math.max(0, Math.min(TIERS.length - 1, Math.round(i)))];

/** The thresholds (model-tunables.ts; the registry defaults without a company). */
export interface SelectionPolicy {
  cheapMaxScore: number;
  strongMinScore: number;
  floorTier: number;
  ceilingTier: number;
  riskFloorTier: number;
  retryEscalateAfter: number;
  budgetTightPct: number;
  historyDowngradeRate: number;
  historyEscalateRate: number;
  historyMinRuns: number;
  requestCap: number;
}

export const DEFAULT_POLICY: SelectionPolicy = {
  cheapMaxScore: 1, strongMinScore: 6, floorTier: 0, ceilingTier: 2, riskFloorTier: 1,
  retryEscalateAfter: 1, budgetTightPct: 20, historyDowngradeRate: 0.9, historyEscalateRate: 0.5, historyMinRuns: 5, requestCap: 1,
};

/** What the platform knows about the work, model-free. Every field optional. */
export interface ComplexitySignals {
  kind: 'task' | 'chat';
  /** Task class (triage | research | synthesis | review | ops | general | …). */
  taskClass?: string;
  /** Characters of the brief (task) or the message (chat). */
  chars?: number;
  /** Filled brief fields (outcome, context, constraints, done_when). */
  briefFields?: number;
  /** Acceptance criteria lines in done_when, and model-free checks. */
  criteria?: number;
  checks?: number;
  /** A strict quality bar applies (a pass score of 4+, or evidence for every criterion and real refs). */
  strictStandard?: boolean;
  /** Risky work and why (external / irreversible / money / one-way door). */
  risky?: boolean;
  riskReasons?: string[];
  dependencies?: number;
  crossUnit?: boolean;
  /** A run reviewing someone else's work. */
  reviewer?: boolean;
  /** A tier the task or its process step declares. */
  declaredTier?: Tier | null;
  /** Failed / no-progress attempts so far, and review rounds sent back. */
  attempts?: number;
  reworkRounds?: number;
  /** The agent's recent record at this class. */
  history?: { rate: number; runs: number } | null;
  /** The tightest capped envelope's share left (0–1); null = no cap. */
  budgetLeft?: number | null;
  /** The agent asked for a tier (request_model_tier or a hint). */
  requested?: { tier: Tier; reason: string } | null;
  /** The CEO's routing for this class (org routing classes). */
  routedTier?: Tier | null;
  // chat
  mentionsWork?: boolean;
  toolsLikely?: boolean;
  code?: boolean;
}

export interface TierChoice { tier: Tier; score: number; reasons: string[] }

const CLASS_WEIGHT: Record<string, number> = { triage: 0, ops: 1, general: 1, review: 2, research: 2, synthesis: 3 };

/** Words of risky work: external, irreversible, money, one-way doors
 *  (actions/action-classes.ts; the alignment classes externalCommitment,
 *  budget and oneWayDoor in org/alignment.ts). */
const RISK_WORDS: Array<[RegExp, string]> = [
  [/\b(deploy|release|ship|roll ?out|go live|launch)\w*/i, 'a release or launch'],
  [/\b(production|prod)\b/i, 'production'],
  [/\b(delete|drop|wipe|purge|destroy|irreversibl|one-way)\w*/i, 'an irreversible change'],
  [/\b(migrat)\w*/i, 'a migration'],
  [/\b(pay|payment|invoice|refund|charge|wire|transfer funds|purchase|spend)\w*\b/i, 'money'],
  [/\b(contract|legal|lawyer|compliance|terms of service|pricing)\b/i, 'a legal or pricing commitment'],
  [/\b(publish|announce|press release|post publicly|tweet)\w*/i, 'a public statement'],
  [/\b(email|message|write to) (the |our |all )?(customers?|clients?|users|partners?|investors?)\b/i, 'contact outside the company'],
];

/** Why a text reads as risky work, de-duplicated; [] when it does not. */
export function riskReasonsOf(text: string): string[] {
  const out: string[] = [];
  for (const [re, why] of RISK_WORDS) if (re.test(text) && !out.includes(why)) out.push(why);
  return out;
}

/** The complexity score and its reasons (docs/agent-types.md "Model selection" table). */
export function scoreComplexity(s: ComplexitySignals): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const add = (n: number, why: string, always = false) => { if (n || always) { score += n; reasons.push(`${n >= 0 ? '+' : ''}${n} ${why}`); } };
  const chars = s.chars ?? 0;
  if (s.kind === 'task') {
    const cls = s.taskClass ?? 'general';
    add(CLASS_WEIGHT[cls] ?? 1, `class ${cls}`, true);
    if (chars >= 2000) add(3, `long brief (${chars} chars)`);
    else if (chars >= 900) add(2, `substantial brief (${chars} chars)`);
    else if (chars >= 350) add(1, `brief of ${chars} chars`);
    else if (chars > 0 && chars < 120) add(-1, `short brief (${chars} chars)`);
    if ((s.briefFields ?? 0) >= 4) add(1, 'fully structured brief');
    const crit = (s.criteria ?? 0) + (s.checks ?? 0);
    if (crit >= 6) add(2, `${crit} acceptance criteria/checks`);
    else if (crit >= 3) add(1, `${crit} acceptance criteria/checks`);
    if (s.strictStandard) add(1, 'strict quality bar');
    if ((s.dependencies ?? 0) >= 2) add(1, `${s.dependencies} dependencies`);
    if (s.crossUnit) add(1, 'cross-unit scope');
    if (s.reviewer) add(1, 'verifying another member\'s work');
  } else {
    add(1, 'a chat turn');
    if (chars >= 1500) add(3, `long message (${chars} chars)`);
    else if (chars >= 500) add(2, `detailed message (${chars} chars)`);
    else if (chars >= 160) add(1, `message of ${chars} chars`);
    else if (chars > 0 && chars < 40) add(-1, `short message (${chars} chars)`);
    if (s.mentionsWork) add(1, 'asks for work');
    if (s.toolsLikely) add(1, 'tools likely needed');
    if (s.code) add(1, 'code in the message');
  }
  if (s.risky) add(2, `risky: ${(s.riskReasons ?? []).join(', ') || 'external or irreversible'}`);
  return { score, reasons };
}

/** The tier for the signals under the policy, with every reason. */
export function chooseTier(s: ComplexitySignals, policy: SelectionPolicy = DEFAULT_POLICY): TierChoice {
  const { score, reasons } = scoreComplexity(s);
  let i = score >= policy.strongMinScore ? 2 : score <= policy.cheapMaxScore ? 0 : 1;
  reasons.push(`score ${score} → ${tierAt(i)} (cheap ≤ ${policy.cheapMaxScore}, strong ≥ ${policy.strongMinScore})`);
  if (s.declaredTier && isTierName(s.declaredTier)) { i = tierIndex(s.declaredTier); reasons.push(`the task declares ${s.declaredTier}`); }
  const retries = (s.attempts ?? 0) + (s.reworkRounds ?? 0);
  if (retries >= policy.retryEscalateAfter) {
    const up = Math.min(2, Math.floor(retries / Math.max(1, policy.retryEscalateAfter)));
    i += up; reasons.push(`+${up} tier after ${retries} failed or reworked attempt(s)`);
  }
  const h = s.history;
  if (h && h.runs >= policy.historyMinRuns) {
    if (h.rate >= policy.historyDowngradeRate && retries === 0) { i -= 1; reasons.push(`-1 tier: ${Math.round(h.rate * 100)}% success over ${h.runs} runs of this class`); }
    else if (h.rate <= policy.historyEscalateRate) { i += 1; reasons.push(`+1 tier: ${Math.round(h.rate * 100)}% success over ${h.runs} runs of this class`); }
  }
  if (s.requested && isTierName(s.requested.tier)) {
    const want = tierIndex(s.requested.tier);
    const capped = Math.max(i - policy.requestCap, Math.min(i + policy.requestCap, want));
    if (capped !== i) reasons.push(`the agent asked for ${s.requested.tier}${s.requested.reason ? ` ("${s.requested.reason.slice(0, 80)}")` : ''} → ${tierAt(capped)}${capped !== want ? ` (capped at ${policy.requestCap} tier${policy.requestCap === 1 ? '' : 's'})` : ''}`);
    else if (want !== i) reasons.push(`the agent asked for ${s.requested.tier}: not applied (requestCap ${policy.requestCap})`);
    i = capped;
  }
  if (s.budgetLeft !== null && s.budgetLeft !== undefined && s.budgetLeft * 100 < policy.budgetTightPct) {
    i -= 1; reasons.push(`-1 tier: ${Math.round(s.budgetLeft * 100)}% of the envelope left (tight below ${policy.budgetTightPct}%)`);
  }
  if (s.routedTier && isTierName(s.routedTier)) { i = tierIndex(s.routedTier); reasons.push(`the CEO routes class ${s.taskClass ?? 'general'} to ${s.routedTier}`); }
  else {
    const lo = Math.min(policy.floorTier, policy.ceilingTier);
    const hi = Math.max(policy.floorTier, policy.ceilingTier);
    if (i < lo) { i = lo; reasons.push(`floor ${tierAt(lo)}`); }
    if (i > hi) { i = hi; reasons.push(`ceiling ${tierAt(hi)}`); }
  }
  // The risk floor holds against everything above — a tight budget, a
  // cheap request, a ceiling, even a routing pin: risky work is never cheap.
  const riskFloor = Math.max(1, policy.riskFloorTier);
  if (s.risky && i < riskFloor) { i = riskFloor; reasons.push(`risk floor ${tierAt(riskFloor)}`); }
  i = Math.max(0, Math.min(2, i));
  return { tier: tierAt(i), score, reasons };
}

// ---- signals from what the platform has ----

/** A task row as the runtime holds it (org_tasks). */
export interface TaskLike {
  class?: string | null;
  title?: string;
  brief?: string | null;
  checks?: string | null;
  dependsOn?: string | null;
  reviewRounds?: number;
  noProgressCount?: number;
  failRepeats?: number;
  modelTier?: string | null;
}

const jsonArray = (raw: string | null | undefined): unknown[] => { try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v : []; } catch { return []; } };

/** The task's own signals: class, brief size and structure, criteria,
 *  checks, dependencies, attempts, rework, the declared tier and risk. */
export function taskSignals(t: TaskLike, extra: Partial<ComplexitySignals> = {}): ComplexitySignals {
  let brief: Record<string, unknown> = {};
  try { brief = JSON.parse(t.brief || '{}') as Record<string, unknown>; } catch { /* a malformed brief is an empty one */ }
  const fields = ['outcome', 'context', 'constraints', 'done_when'].map((k) => (typeof brief[k] === 'string' ? (brief[k] as string).trim() : ''));
  const text = [t.title ?? '', ...fields].join('\n');
  const doneWhen = fields[3];
  const criteria = doneWhen ? doneWhen.split(/\n|;|(?:^|\s)\d+[.)]\s|(?:^|\n)\s*[-*•]\s/).map((x) => x.trim()).filter((x) => x.length >= 3).length : 0;
  const riskReasons = riskReasonsOf(text);
  const declared = isTierName(t.modelTier) ? t.modelTier : null;
  return {
    kind: 'task',
    taskClass: t.class || 'general',
    chars: fields.join('').length,
    briefFields: fields.filter(Boolean).length,
    criteria,
    checks: jsonArray(t.checks).length,
    dependencies: jsonArray(t.dependsOn).length,
    risky: riskReasons.length > 0,
    riskReasons,
    declaredTier: declared,
    attempts: Math.max(t.noProgressCount ?? 0, t.failRepeats ?? 0),
    reworkRounds: t.reviewRounds ?? 0,
    ...extra,
  };
}

const WORK_WORDS = /\b(task|plan|analy[sz]e|review|design|implement|debug|research|investigat|compare|draft|write (a|an|the)|build|refactor|fix|estimate|strategy|report)\w*/i;
const TOOL_WORDS = /https?:\/\/|\b(search|look up|fetch|browse|run|execute|deploy|send|schedule|create|update|file|folder|spreadsheet|calendar|email)\b/i;

/** The lighter chat heuristic: message length, work and tool words, code,
 *  @mentions of work, risk. */
export function chatSignals(text: string): ComplexitySignals {
  const t = text ?? '';
  const riskReasons = riskReasonsOf(t);
  return {
    kind: 'chat',
    chars: t.trim().length,
    mentionsWork: WORK_WORDS.test(t) || (/@[\w-]+/.test(t) && /\b(task|work|ask|help|do)\b/i.test(t)),
    toolsLikely: TOOL_WORDS.test(t),
    code: /```|\bfunction\s*\(|=>|\bclass\s+\w+/.test(t),
    risky: riskReasons.length > 0,
    riskReasons,
  };
}

// ---- workspace settings ----

/** workspaces.modelSelection: the workspace's default mode, the owner's
 *  provider preference order (agent type ids) and whether an auto agent may
 *  leave its own type. */
export interface WorkspaceModelSelection { mode?: ModelMode; order: string[]; crossProvider: boolean }

export function parseWorkspaceSelection(raw: string | null | undefined): WorkspaceModelSelection {
  const out: WorkspaceModelSelection = { order: [], crossProvider: true };
  try {
    const v = JSON.parse(raw || '{}') as Record<string, unknown>;
    if (isModelMode(v.mode)) out.mode = v.mode;
    if (Array.isArray(v.order)) out.order = [...new Set(v.order.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, 64)))].slice(0, 20);
    if (v.crossProvider === false) out.crossProvider = false;
  } catch { /* malformed: defaults */ }
  return out;
}

/** The mode an agent runs in: its own setting, else its type's, else the
 *  workspace's, else fixed. */
export function effectiveMode(agentMode: string | null | undefined, typeMode: string | null | undefined, workspaceMode: string | null | undefined): ModelMode {
  if (isModelMode(agentMode)) return agentMode;
  if (isModelMode(typeMode)) return typeMode;
  if (isModelMode(workspaceMode)) return workspaceMode;
  return 'fixed';
}

// ---- provider choice within a tier ----

export interface ProviderCandidate extends ModelTypeLike {
  id: string;
  name: string;
  enabled?: number;
  /** A key the turn can use (its own, or the plan's platform key). */
  usable: boolean;
}

export interface ProviderChoice { type: ProviderCandidate; model: string; reasons: string[] }

/**
 * The type and model a tier runs on. Candidates are the agent's own type
 * and, with cross-provider allowed, the owner's ordered types (or, with no
 * order, every usable Claude / OpenAI type). Degraded providers drop out
 * (unless nothing else is left); a verifier prefers a family other than
 * the maker's; then the owner's order, else the agent's own type first and
 * the rest by the tier model's price. A CEO-pinned tier model applies on a
 * type that serves it.
 */
export function chooseProvider(cands: ProviderCandidate[], opts: {
  tier: Tier; ownTypeId: string | null; order: string[]; crossProvider: boolean;
  degraded?: (provider: string) => boolean; avoidFamily?: string | null;
  price?: (model: string) => number | null; pinnedModel?: string | null;
}): ProviderChoice | null {
  const reasons: string[] = [];
  const usable = cands.filter((c) => c.provider !== 'echo' && (c.enabled ?? 1) === 1 && (c.usable || c.id === opts.ownTypeId));
  const allowed = usable.filter((c) => c.id === opts.ownTypeId || (opts.crossProvider && (opts.order.length ? opts.order.includes(c.id) : ['anthropic', 'openai'].includes(typeFamily(c) ?? ''))));
  if (allowed.length === 0) return null;
  let pool = allowed;
  if (opts.degraded) {
    const healthy = pool.filter((c) => !opts.degraded!(c.provider));
    if (healthy.length && healthy.length < pool.length) reasons.push(`skipped degraded: ${pool.filter((c) => opts.degraded!(c.provider)).map((c) => c.name).join(', ')}`);
    if (healthy.length) pool = healthy;
  }
  if (opts.avoidFamily) {
    const other = pool.filter((c) => (typeFamily(c) ?? '') !== opts.avoidFamily);
    if (other.length) { if (other.length < pool.length) reasons.push(`a verifier on another family than the maker's (${opts.avoidFamily})`); pool = other; }
  }
  const modelOf = (c: ProviderCandidate) => (opts.pinnedModel && isKnownModel(c, opts.pinnedModel) ? opts.pinnedModel : tierModelForType(c, opts.tier));
  const rank = (c: ProviderCandidate): number => {
    const at = opts.order.indexOf(c.id);
    if (at >= 0) return at;
    return opts.order.length + (c.id === opts.ownTypeId ? 0 : 1);
  };
  const price = (c: ProviderCandidate) => opts.price?.(modelOf(c)) ?? Number.POSITIVE_INFINITY;
  const sorted = [...pool].sort((a, b) => rank(a) - rank(b) || price(a) - price(b) || a.name.localeCompare(b.name));
  const pick = sorted[0];
  if (opts.order.length && opts.order.includes(pick.id)) reasons.push(`the owner's preference: ${pick.name}`);
  else if (pick.id === opts.ownTypeId) reasons.push(`the agent's own type: ${pick.name}`);
  else reasons.push(`${pick.name}: the cheapest ${opts.tier} model among the allowed types`);
  const model = modelOf(pick);
  if (opts.pinnedModel && model === opts.pinnedModel) reasons.push(`the CEO pins ${opts.tier} to ${model}`);
  return { type: pick, model, reasons };
}

/** The record a run or turn keeps (org_runs.modelDecision, chat_turns.modelDecision). */
export interface ModelDecision {
  mode: 'auto';
  kind: 'task' | 'chat';
  tier: Tier;
  score: number;
  model: string;
  agentTypeId: string | null;
  provider: string;
  /** Vendor family of the model (anthropic, openai, …). */
  family: string | null;
  reasons: string[];
  requested?: { tier: Tier; reason: string } | null;
  at: string;
}

export function familyOfModel(model: string, provider?: string): string | null {
  return modelFamily(model) ?? (provider?.startsWith('anthropic') ? 'anthropic' : provider === 'openai' ? 'openai' : null);
}

export function parseDecision(raw: string | null | undefined): ModelDecision | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as ModelDecision;
    return v && isTierName(v.tier) && typeof v.model === 'string' ? v : null;
  } catch { return null; }
}

/** One line for logs and the UI: "strong · claude-opus-5-5 — score 7; …". */
export function describeDecision(d: ModelDecision): string {
  return `${d.tier} · ${d.model}${d.reasons.length ? ` — ${d.reasons.join('; ')}` : ''}`;
}
