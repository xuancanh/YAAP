/**
 * Improvement proposals and admission control, the pure half
 * (docs/improvements.md). No Nest and no database: the service, the
 * tools, the minutes executor, the UI's lib and the tests share these.
 *
 * An improvement proposal names a target (a process version, a policy, a
 * quality standard, a playbook, a charter, a cadence or a tunable), the
 * evidence that something is wrong, a hypothesis, the proposed change and
 * the metric it should move, and one of Google's postmortem action classes
 * (investigate, mitigate, repair, detect, prevent). Its lifecycle reuses
 * the change-record pattern (plugins/changes.service.ts): a transition
 * table, every move in `history`, deadlines on the row so a restart resumes
 * — proposed → accepted → applied → verified, or reverted, rejected,
 * expired. Its change class is decided here without a model: a standard
 * change is pre-authorised and applies at once, a normal one is approved by
 * the target's owner, an emergency one applies during an open incident and
 * is reviewed afterwards.
 *
 * Admission control classifies where every task came from and decides,
 * model-free, whether self-started work (agent initiative, retro and
 * meeting actions) may enter: a trigger, a service request, an accepted
 * proposal, a subtask or a project bet lets it in; otherwise a small
 * per-unit WIP cap and a per-member rate cap do.
 */

// ---- the proposal ----

export const IMPROVEMENT_TARGETS = ['process', 'policy', 'quality_standard', 'playbook', 'charter', 'cadence', 'tunable'] as const;
export type ImprovementTarget = typeof IMPROVEMENT_TARGETS[number];
export const IMPROVEMENT_CATEGORIES = ['investigate', 'mitigate', 'repair', 'detect', 'prevent'] as const;
export type ImprovementCategory = typeof IMPROVEMENT_CATEGORIES[number];
export const CHANGE_CLASSES = ['standard', 'normal', 'emergency'] as const;
export type ChangeClass = typeof CHANGE_CLASSES[number];
export const IMPROVEMENT_STATUSES = ['proposed', 'accepted', 'applied', 'verified', 'reverted', 'rejected', 'expired'] as const;
export type ImprovementStatus = typeof IMPROVEMENT_STATUSES[number];
export const EVIDENCE_KINDS = ['event_query', 'metric', 'postmortem', 'incident', 'lessons', 'deviations', 'meeting', 'task'] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
/** Where a proposal came from. */
export const IMPROVEMENT_ORIGINS = ['retro', 'postmortem', 'process_review', 'discovery', 'incident', 'verification', 'agent', 'ceo'] as const;
export type ImprovementOrigin = typeof IMPROVEMENT_ORIGINS[number];

/** The transition table (the change-record pattern). */
export const IMPROVEMENT_NEXT: Record<ImprovementStatus, ImprovementStatus[]> = {
  proposed: ['accepted', 'rejected', 'expired'],
  accepted: ['applied', 'rejected'],
  applied: ['verified', 'reverted'],
  verified: [], reverted: [], rejected: [], expired: [],
};
export function canMove(from: string, to: ImprovementStatus): boolean {
  return (IMPROVEMENT_NEXT[from as ImprovementStatus] ?? []).includes(to);
}
/** Open for the per-unit cap: still waiting on someone. */
export const OPEN_STATUSES: readonly ImprovementStatus[] = ['proposed', 'accepted'];
/** Open for the per-target cap: not settled yet (an applied change is still being verified). */
export const UNSETTLED_STATUSES: readonly ImprovementStatus[] = ['proposed', 'accepted', 'applied'];

export const isImprovementTarget = (v: unknown): v is ImprovementTarget => typeof v === 'string' && (IMPROVEMENT_TARGETS as readonly string[]).includes(v);
export const isCategory = (v: unknown): v is ImprovementCategory => typeof v === 'string' && (IMPROVEMENT_CATEGORIES as readonly string[]).includes(v);

export const CATEGORY_WORD: Record<ImprovementCategory, string> = { investigate: 'Investigate', mitigate: 'Mitigate', repair: 'Repair', detect: 'Detect', prevent: 'Prevent' };
export const TARGET_WORD: Record<ImprovementTarget, string> = { process: 'process', policy: 'policy', quality_standard: 'quality standard', playbook: 'playbook', charter: 'charter', cadence: 'cadence', tunable: 'tunable' };

export interface Evidence { kind: EvidenceKind; ref: string; summary: string }
export interface ExpectedChange { metric: string; direction: 'up' | 'down'; by: number }
export interface Verification { outcome: 'pass' | 'fail' | 'unverifiable'; baseline: number | null; value: number | null; detail: string; at: string }
export interface HistoryEntry { from: string; to: string; by: string; why: string; at: string }

/** "process:release-checklist", "policy:no-sale-below-cost", "tunable:work.selfAssign", "charter:Writer". */
export function parseTargetRef(raw: unknown): { kind: ImprovementTarget; ref: string } | null {
  if (raw && typeof raw === 'object') {
    const o = raw as { kind?: unknown; ref?: unknown };
    const kind = String(o.kind ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const ref = String(o.ref ?? '').trim();
    return isImprovementTarget(kind) && ref ? { kind, ref: ref.slice(0, 120) } : null;
  }
  const s = String(raw ?? '').trim();
  const m = /^([a-z_ -]+):\s*(.+)$/i.exec(s);
  if (!m) return null;
  const kind = m[1].trim().toLowerCase().replace(/[\s-]+/g, '_');
  const alias: Record<string, ImprovementTarget> = { standard: 'quality_standard', quality: 'quality_standard', ritual: 'cadence', meeting: 'cadence', setting: 'tunable' };
  const k = alias[kind] ?? kind;
  return isImprovementTarget(k) ? { kind: k, ref: m[2].trim().slice(0, 120) } : null;
}

export function parseEvidence(raw: unknown): Evidence[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
  const out: Evidence[] = [];
  for (const x of list.slice(0, 12)) {
    if (typeof x === 'string') { const s = x.trim(); if (s) out.push({ kind: kindOfRef(s), ref: refOf(s), summary: s.slice(0, 400) }); continue; }
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const kind = String(o.kind ?? '').trim().toLowerCase();
    const summary = String(o.summary ?? o.text ?? '').trim().slice(0, 400);
    const ref = String(o.ref ?? '').trim().slice(0, 200);
    if (!summary && !ref) continue;
    out.push({ kind: (EVIDENCE_KINDS as readonly string[]).includes(kind) ? kind as EvidenceKind : kindOfRef(ref || summary), ref, summary: summary || ref });
  }
  return out;
}

function kindOfRef(s: string): EvidenceKind {
  const l = s.toLowerCase();
  if (/\bincident\b/.test(l)) return 'incident';
  if (/\bpostmortem\b/.test(l)) return 'postmortem';
  if (/\bdeviat/.test(l)) return 'deviations';
  if (/\blesson/.test(l)) return 'lessons';
  if (/\bmeeting:|\bretro\b/.test(l)) return 'meeting';
  if (/\b[a-z][a-z0-9]{1,5}-\d+\b/i.test(s) || /\btask:/.test(l)) return 'task';
  if (/\b(rate|share|p50|median|trend|yield|metric|%)/.test(l)) return 'metric';
  return 'event_query';
}
function refOf(s: string): string {
  const m = /\b((?:meeting|incident|task|run|process|audit|signal):[\w-]+|[A-Z][A-Z0-9]{1,5}-\d+|PR-\d+)\b/.exec(s);
  return m ? m[1] : '';
}

/** Known metrics a change can be verified against (model-free). `metric:<id>`
 *  reads an org metric source's latest sample. */
export const METRICS: Record<string, { label: string; needs?: ImprovementTarget; better: 'up' | 'down' }> = {
  'process.deviationRate': { label: 'deviation rate of the process', needs: 'process', better: 'down' },
  'process.completionRate': { label: 'completion rate of the process', needs: 'process', better: 'up' },
  'process.cycleHours': { label: 'median cycle time of the process (hours)', needs: 'process', better: 'down' },
  'process.reworkRate': { label: 'rework rate of the process', needs: 'process', better: 'down' },
  'process.slaBreaches': { label: 'SLA breaches of the process', needs: 'process', better: 'down' },
  'quality.firstPassYield': { label: 'first-pass yield (the unit\'s, else the company\'s)', better: 'up' },
  'quality.reworkRate': { label: 'rework rate (the unit\'s, else the company\'s)', better: 'down' },
  'quality.escapes': { label: 'defect escapes', better: 'down' },
  'policy.violations': { label: 'violations of the policy', needs: 'policy', better: 'down' },
  'work.selfShare': { label: 'share of new tasks that were self-started', better: 'down' },
  'work.retroShare': { label: 'share of new tasks from retros', better: 'down' },
  'work.systemShare': { label: 'share of new tasks in Operating/Unsorted projects', better: 'down' },
  'work.blockedHours': { label: 'blocked hours per done task', better: 'down' },
};

export function parseExpected(raw: unknown): ExpectedChange | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string') {
    // "process.deviationRate down 0.1", "metric:abc up", "work.retroShare down by 0.2"
    const m = /^\s*([\w.:-]+)\s+(up|down)(?:\s+(?:by\s+)?(-?\d+(?:\.\d+)?)\s*%?)?\s*$/i.exec(raw);
    if (!m) throw new Error(`expected must read "<metric> up|down [by <number>]" — metrics: ${Object.keys(METRICS).join(', ')}, or metric:<source id>`);
    return normExpected({ metric: m[1], direction: m[2].toLowerCase(), by: m[3] ? Number(m[3]) : 0 });
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return normExpected({ metric: String(o.metric ?? ''), direction: String(o.direction ?? ''), by: Number(o.by ?? 0) });
  }
  return null;
}
function normExpected(x: { metric: string; direction: string; by: number }): ExpectedChange {
  const metric = x.metric.trim();
  if (!METRICS[metric] && !/^metric:[\w-]{4,}$/.test(metric)) throw new Error(`unknown metric "${metric}" — known: ${Object.keys(METRICS).join(', ')}, or metric:<source id>`);
  const direction = x.direction === 'down' ? 'down' : x.direction === 'up' ? 'up' : (METRICS[metric]?.better ?? 'up');
  const by = Number.isFinite(x.by) ? Math.abs(x.by) : 0;
  return { metric, direction, by };
}

export function describeExpected(e: ExpectedChange | null): string {
  if (!e) return 'no metric named (the owner verifies it by hand)';
  return `${METRICS[e.metric]?.label ?? e.metric} ${e.direction === 'down' ? '↓' : '↑'}${e.by ? ` by at least ${e.by}` : ''}`;
}

/** Did the metric move as expected? `by` 0 means it must not get worse. Pure. */
export function verdictOf(expected: ExpectedChange | null, baseline: number | null, value: number | null): 'pass' | 'fail' | 'unverifiable' {
  if (!expected || baseline === null || value === null || !Number.isFinite(baseline) || !Number.isFinite(value)) return 'unverifiable';
  const delta = expected.direction === 'up' ? value - baseline : baseline - value;
  return delta + 1e-9 >= expected.by ? 'pass' : 'fail';
}

// ---- the change class ----

export interface ClassInput {
  target: ImprovementTarget | null;
  category: ImprovementCategory;
  /** An incident it answers is open (not resolved). */
  incidentOpen: boolean;
  /** The change loosens a control (a policy retired or relaxed, a standard's bar lowered). */
  loosens: boolean;
  /** A process edit that touches MUST items, checkpoints, approvals, strict edges or denied tools. */
  touchesControls: boolean;
  /** The proposal carries a concrete change the target can apply (not only prose). */
  concrete: boolean;
}

/** Standard, normal or emergency — model-free, by the company's tunables. */
export function classify(i: ClassInput, t: { standardScope: number; emergency: number }): { cls: ChangeClass; why: string } {
  if (i.incidentOpen && t.emergency >= 1 && (i.category === 'mitigate' || i.category === 'repair') && i.target !== 'charter' && i.target !== 'tunable' && i.concrete) {
    return { cls: 'emergency', why: 'a mitigation or repair while its incident is open: it applies now and the owner reviews it afterwards (improve.emergency)' };
  }
  if (!i.target || !i.concrete) return { cls: 'normal', why: 'no concrete change to apply yet: the owner decides it' };
  if (i.target === 'charter' || i.target === 'tunable') return { cls: 'normal', why: `a ${TARGET_WORD[i.target]} changes how the company works: never pre-authorised` };
  if (i.loosens) return { cls: 'normal', why: 'it loosens a control: the owner approves it' };
  if (i.touchesControls) return { cls: 'normal', why: 'it changes what a run must do (MUST items, checkpoints, approvals, strict edges or denied tools): the owner approves it' };
  if (t.standardScope <= 0) return { cls: 'normal', why: 'this company approves every change (improve.standardScope 0)' };
  if (i.target === 'process' || i.target === 'playbook') return { cls: 'standard', why: `a reversible ${TARGET_WORD[i.target]} revision that leaves the controls alone: pre-authorised (improve.standardScope ≥ 1)` };
  if (t.standardScope >= 2 && (i.target === 'cadence' || i.target === 'policy' || i.target === 'quality_standard')) return { cls: 'standard', why: `a ${TARGET_WORD[i.target]} change that tightens or retimes: pre-authorised (improve.standardScope 2)` };
  return { cls: 'normal', why: `a ${TARGET_WORD[i.target]} change is approved by its owner here (improve.standardScope ${t.standardScope})` };
}

// ---- the minutes executor: retro actions → proposals ----

/** What a retro or postmortem action proposes, as the minutes carry it. */
export interface ActionLike {
  title: string; owner: string; done_when: string; outcome?: string;
  category?: string; target?: string | { kind: string; ref: string } | null; hypothesis?: string; evidence?: unknown; expected?: unknown;
  verdict?: string;
}

const CATEGORY_RANK: Record<ImprovementCategory, number> = { prevent: 5, repair: 4, detect: 3, mitigate: 2, investigate: 1 };

/** The category an action states, else one inferred from its words. */
export function categoryOf(a: Pick<ActionLike, 'category' | 'title' | 'outcome'>): ImprovementCategory {
  const c = String(a.category ?? '').trim().toLowerCase();
  if (isCategory(c)) return c;
  const t = `${a.title} ${a.outcome ?? ''}`.toLowerCase();
  if (/\b(fix|repair|patch|correct|restore)\b/.test(t)) return 'repair';
  if (/\b(prevent|guard|block|forbid|require|enforce|checklist|gate)\b/.test(t)) return 'prevent';
  if (/\b(alert|detect|monitor|notify|flag|watch)\b/.test(t)) return 'detect';
  if (/\b(mitigat|workaround|reduce|limit|contain)\w*/.test(t)) return 'mitigate';
  return 'investigate';
}

/**
 * Route a retro's actions (docs/improvements.md "Retros emit proposals"):
 * a concrete Repair of a specific defect — an owner, a done-when and no
 * standing target — may stay a task (improve.repairTasks); every other
 * action is a proposal, ranked (category, then a named target, evidence and
 * an expected metric) and capped at `perMeeting`; the rest are not raised
 * and say why. Rejected actions are skipped. Pure.
 */
export function routeActions(actions: ActionLike[], opts: { perMeeting: number; repairTasks: boolean }): Array<'task' | 'proposal' | 'over_cap' | 'skip'> {
  const out: Array<'task' | 'proposal' | 'over_cap' | 'skip'> = actions.map(() => 'skip');
  const proposals: Array<{ i: number; score: number }> = [];
  actions.forEach((a, i) => {
    if (a.verdict === 'rejected') return;
    const cat = categoryOf(a);
    const target = parseTargetRef(a.target ?? null);
    if (opts.repairTasks && cat === 'repair' && !target && a.owner.trim() && a.done_when.trim()) { out[i] = 'task'; return; }
    const score = CATEGORY_RANK[cat] * 10 + (target ? 4 : 0) + (parseEvidence(a.evidence).length ? 2 : 0) + (a.expected ? 1 : 0);
    proposals.push({ i, score });
  });
  proposals.sort((x, y) => y.score - x.score || x.i - y.i);
  proposals.forEach((p, rank) => { out[p.i] = rank < Math.max(1, opts.perMeeting) ? 'proposal' : 'over_cap'; });
  return out;
}

// ---- admission control: where work comes from ----

/** Where a task came from, as admission control and the Work sources panel read it. */
export const WORK_ORIGINS = ['plan', 'process', 'service', 'incident', 'escalation', 'human', 'proposal', 'chief', 'retro', 'meeting', 'agent'] as const;
export type WorkOrigin = typeof WORK_ORIGINS[number];
export const ORIGIN_WORD: Record<WorkOrigin, string> = {
  plan: 'plans and goals', process: 'process steps', service: 'service requests', incident: 'incidents', escalation: 'escalations', human: 'the CEO and people',
  proposal: 'accepted proposals', chief: 'the chief\'s sweep', retro: 'retros', meeting: 'meetings', agent: 'agent initiative',
};
/** Self-started origins: what the admission caps count. */
export const SELF_ORIGINS: readonly WorkOrigin[] = ['retro', 'meeting', 'agent'];

/** What admission reads of a task (fields of other features may not exist yet). */
export interface AdmissionTask {
  source?: string | null;
  createdBy?: string | null;
  title?: string | null;
  class?: string | null;
  brief?: unknown;
  parentTaskId?: string | null;
  processRunId?: unknown;
  process?: unknown;
  /** A service request (the service catalog, when it exists). */
  serviceId?: unknown;
  service?: unknown;
  serviceRequestId?: unknown;
  /** The kind of the project it landed in (project | unsorted | operating). */
  projectKind?: string | null;
}

function constraints(brief: unknown): string {
  if (typeof brief === 'string') { try { const v = JSON.parse(brief) as { constraints?: unknown }; return typeof v.constraints === 'string' ? v.constraints : ''; } catch { return ''; } }
  if (brief && typeof brief === 'object') { const c = (brief as { constraints?: unknown }).constraints; return typeof c === 'string' ? c : ''; }
  return '';
}

/**
 * Whether a task is a service request: source `service`, a service id or
 * request id on it, or a `service:<name>` tag in its constraints. Tolerates
 * the service catalog's fields not existing yet; other code may call it.
 */
export function isServiceRequest(t: AdmissionTask): boolean {
  if (String(t.source ?? '') === 'service') return true;
  if ((typeof t.serviceId === 'string' && t.serviceId) || (typeof t.serviceRequestId === 'string' && t.serviceRequestId)) return true;
  if (t.service && (typeof t.service === 'string' || typeof t.service === 'object')) return true;
  if (t.process && typeof t.process === 'object' && String((t.process as { trigger?: unknown }).trigger ?? '') === 'service') return true;
  return /\bservice:\s*[a-z0-9][\w-]*/i.test(constraints(t.brief));
}

/** The task's origin. `chiefAgentId` tells the chief's sweep from other agents. Pure. */
export function originOf(t: AdmissionTask, chiefAgentId: string | null): WorkOrigin {
  const source = String(t.source ?? '');
  const by = String(t.createdBy ?? '');
  if (isServiceRequest(t)) return 'service';
  if (source === 'process' || t.processRunId) return 'process';
  if (source === 'proposal' || by.startsWith('improvement:')) return 'proposal';
  if (source === 'incident') return 'incident';
  if (source === 'escalation') return 'escalation';
  if (source === 'ceo' || by === 'user' || by.startsWith('human:')) return 'human';
  if (source === 'plan') return 'plan';
  if (by === 'chief' || (chiefAgentId && by === `agent:${chiefAgentId}`)) return 'chief';
  if (source === 'retro') return 'retro';
  if (source === 'meeting') return 'meeting';
  if (source === 'chat' && !by.startsWith('agent:')) return 'human';
  return by.startsWith('agent:') || source === 'agent' || source === 'chat' ? 'agent' : 'plan';
}

/**
 * Whether a new task is self-started work the admission caps count, or the
 * reason it enters freely: a trigger (process, incident, escalation), a
 * service request, an accepted proposal, the CEO's or the chief's work, a
 * subtask of admitted work, a task under a project bet, or review work.
 * Pure: `{ self: false, why }` or `{ self: true, origin }`.
 */
export function admissionOf(t: AdmissionTask, chiefAgentId: string | null): { self: false; why: string; origin: WorkOrigin } | { self: true; origin: WorkOrigin } {
  const origin = originOf(t, chiefAgentId);
  if (!SELF_ORIGINS.includes(origin)) return { self: false, why: ORIGIN_WORD[origin], origin };
  if (!String(t.createdBy ?? '').startsWith('agent:')) return { self: false, why: 'not created by an agent', origin };
  if (t.parentTaskId) return { self: false, why: 'a subtask of admitted work', origin };
  if (t.projectKind === 'project') return { self: false, why: 'it serves a project bet', origin };
  if (String(t.class ?? '') === 'review') return { self: false, why: 'review work', origin };
  return { self: true, origin };
}

/** The refusal (or parking note) an agent reads over the caps. */
export function admissionRefusal(x: { unitName: string; open: number; cap: number; today: number; perDay: number; over: 'wip' | 'rate'; parked: boolean }): string {
  const what = x.over === 'wip'
    ? `${x.unitName} already holds ${x.open} of ${x.cap} open self-started tasks (admission.selfWip)`
    : `you started ${x.today} of ${x.perDay} self-started tasks in the last 24 hours (admission.selfPerDay)`;
  const fix = 'finish or cancel one; attach it to the project bet it serves (project: P-n) or make it a subtask of the task it belongs to; ask the owning function through a service request; or raise it as an improvement proposal with org_improvement_propose (target, evidence, hypothesis, expected metric)';
  return x.parked ? `parked: ${what}, so it waits unassigned in the backlog as a proposal nobody is woken for. To move it: ${fix}.` : `refused: ${what}. Instead: ${fix}.`;
}

// ---- measurement ----

export interface SourceRow { origin: WorkOrigin; projectKind: string | null; createdAt: string; status: string; unitId: string | null }

/** Share of tasks by origin, the share in Operating/Unsorted projects and the self-started share. Pure. */
export function sourceShares(rows: SourceRow[]): { total: number; byOrigin: Record<WorkOrigin, number>; selfShare: number | null; systemShare: number | null; retroShare: number | null } {
  const byOrigin = Object.fromEntries(WORK_ORIGINS.map((o) => [o, 0])) as Record<WorkOrigin, number>;
  for (const r of rows) byOrigin[r.origin] += 1;
  const total = rows.length;
  const share = (n: number) => (total ? Math.round((n / total) * 1000) / 1000 : null);
  return {
    total, byOrigin,
    selfShare: share(rows.filter((r) => SELF_ORIGINS.includes(r.origin)).length),
    systemShare: share(rows.filter((r) => r.projectKind === 'operating' || r.projectKind === 'unsorted').length),
    retroShare: share(byOrigin.retro),
  };
}

/** One line for the chief's and heads' context. Pure. */
export function sourcesLine(s: ReturnType<typeof sourceShares>, proposals: { open: number; waiting: number; applied: number; verified: number }, days: number): string {
  if (!s.total && !proposals.open) return '';
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const top = WORK_ORIGINS.map((o) => [o, s.byOrigin[o]] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([o, n]) => `${ORIGIN_WORD[o]} ${n}`).join(', ');
  return `Work sources (${days}d): ${s.total} new task(s)${top ? ` — ${top}` : ''}; self-started ${pct(s.selfShare)}, in Operating/Unsorted ${pct(s.systemShare)}. Improvements: ${proposals.open} open (${proposals.waiting} awaiting a decision), ${proposals.applied} being verified, ${proposals.verified} verified.`;
}
