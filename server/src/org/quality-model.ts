/**
 * Quality control, the pure half (docs/quality.md): the shapes of quality
 * standards and policies, the validators every writer goes through, the
 * evidence-reference grammar, the rubric grader, the deterministic policy
 * predicate evaluator, the starter templates and the quality metrics.
 * Nothing here does I/O; OrgQualityService does. No code is ever evaluated:
 * a predicate is a fixed set of operators over dot paths of a tool call's
 * arguments or a result's text.
 */

// ---- standards ----

/** Kinds of evidence a criterion may ask for (docs/quality.md "Evidence"). */
export const EVIDENCE_KINDS = ['action', 'tool', 'file', 'url', 'check', 'task'] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];

/** One criterion: an acceptance criterion the maker cites evidence for and
 *  a rubric line the verifier grades 1–5. `min` is a floor below which the
 *  work fails whatever the weighted score; `evidence` the reference kinds
 *  that count for it ([] = any kind, ['none'] = judged, no evidence). */
export interface Criterion { id: string; text: string; weight: number; min?: number; evidence?: Array<EvidenceKind | 'none'> }

export const STANDARD_SCOPES = ['company', 'unit', 'role', 'deliverable', 'project', 'task', 'process_step'] as const;
export type StandardScope = typeof STANDARD_SCOPES[number];
export const STANDARD_STATUSES = ['proposed', 'active', 'retired', 'rejected'] as const;
export const VERIFIERS = ['default', 'agent', 'family'] as const;
export type VerifierRule = typeof VERIFIERS[number];

/** How specific a scope is: the most specific active standard applies. */
export const SCOPE_RANK: Record<StandardScope, number> = { task: 100, process_step: 90, project: 80, deliverable: 50, role: 40, unit: 30, company: 10 };

export interface StandardInput {
  name: string; slug?: string; scopeKind: StandardScope; scopeRef: string; unitId?: string | null; summary: string;
  criteria: Criterion[]; passScore: number; requireEvidence: boolean; verifier: VerifierRule;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MAX_CRITERIA = 12;

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'standard';
}

const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));

/** Validate criteria; the message names what to fix. */
export function normalizeCriteria(raw: unknown): Criterion[] {
  const list = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown; } catch { return raw.split('\n').filter((l) => l.trim()); } })() : raw;
  if (!Array.isArray(list) || list.length === 0) throw new Error('criteria: give at least one criterion ({ id?, text, weight?, min?, evidence? })');
  if (list.length > MAX_CRITERIA) throw new Error(`criteria: at most ${MAX_CRITERIA}`);
  const out: Criterion[] = [];
  list.forEach((c, i) => {
    const o = (typeof c === 'string' ? { text: c } : c) as Record<string, unknown>;
    const text = String(o?.text ?? o?.criterion ?? '').trim().slice(0, 400);
    if (!text) throw new Error(`criteria[${i}]: text is required`);
    const id = String(o.id ?? `c${i + 1}`).trim().toLowerCase();
    if (!ID_RE.test(id)) throw new Error(`criteria[${i}].id "${id}" must be a short lowercase slug`);
    if (out.some((x) => x.id === id)) throw new Error(`criteria[${i}].id "${id}" is used twice`);
    const weight = num(o.weight) ?? 1;
    if (!Number.isFinite(weight) || weight <= 0 || weight > 10) throw new Error(`criteria[${i}].weight must be within 0–10`);
    const min = num(o.min);
    if (min !== undefined && (!Number.isFinite(min) || min < 1 || min > 5)) throw new Error(`criteria[${i}].min must be within 1–5`);
    const ev = o.evidence === undefined ? undefined : (Array.isArray(o.evidence) ? o.evidence : String(o.evidence).split(',')).map((x) => String(x).trim()).filter(Boolean);
    if (ev) for (const k of ev) if (k !== 'none' && !(EVIDENCE_KINDS as readonly string[]).includes(k)) throw new Error(`criteria[${i}].evidence "${k}" must be one of ${EVIDENCE_KINDS.join(', ')} or none`);
    out.push({ id, text, weight, ...(min !== undefined ? { min } : {}), ...(ev ? { evidence: ev as Criterion['evidence'] } : {}) });
  });
  return out;
}

/** Validate a standard; the defaults come from the caller (the tunables). */
export function normalizeStandard(raw: Record<string, unknown>, defaults: { passScore: number }): StandardInput {
  const name = String(raw.name ?? '').trim().slice(0, 120);
  if (!name) throw new Error('name is required');
  const scopeKind = String(raw.scopeKind ?? raw.scope ?? 'company').trim() as StandardScope;
  if (!(STANDARD_SCOPES as readonly string[]).includes(scopeKind)) throw new Error(`scopeKind must be one of ${STANDARD_SCOPES.join(', ')}`);
  const scopeRef = String(raw.scopeRef ?? raw.ref ?? '').trim().slice(0, 120);
  if (scopeKind !== 'company' && !scopeRef) throw new Error(`scopeRef is required for a ${scopeKind} standard (${scopeKind === 'deliverable' ? 'the deliverable kind, e.g. report' : scopeKind === 'role' ? 'the role title' : `the ${scopeKind} id or key`})`);
  const slug = raw.slug ? String(raw.slug).trim().toLowerCase() : slugify(name);
  if (!SLUG_RE.test(slug)) throw new Error('slug must be a lowercase slug');
  const passScore = num(raw.passScore) ?? defaults.passScore;
  if (!Number.isFinite(passScore) || passScore < 1 || passScore > 5) throw new Error('passScore must be within 1–5');
  const verifier = String(raw.verifier ?? 'default') as VerifierRule;
  if (!(VERIFIERS as readonly string[]).includes(verifier)) throw new Error(`verifier must be one of ${VERIFIERS.join(', ')}`);
  return {
    name, slug, scopeKind, scopeRef: scopeKind === 'deliverable' ? scopeRef.toLowerCase() : scopeRef,
    unitId: raw.unitId ? String(raw.unitId) : null, summary: String(raw.summary ?? '').trim().slice(0, 600),
    criteria: normalizeCriteria(raw.criteria), passScore, requireEvidence: raw.requireEvidence === undefined ? true : Boolean(raw.requireEvidence) && raw.requireEvidence !== 'false', verifier,
  };
}

export function parseCriteria(raw: string | null | undefined): Criterion[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? (v as Criterion[]) : []; } catch { return []; }
}

/** Whether a revision lowers the bar (a loosening is the CEO's, boundary.ts). */
export function standardLoosens(before: { passScore: number; criteria: Criterion[]; requireEvidence: boolean }, after: { passScore: number; criteria: Criterion[]; requireEvidence: boolean }): boolean {
  if (after.passScore < before.passScore) return true;
  if (before.requireEvidence && !after.requireEvidence) return true;
  for (const b of before.criteria) {
    const a = after.criteria.find((x) => x.id === b.id);
    if (!a) return true;
    if ((b.min ?? 0) > (a.min ?? 0)) return true;
  }
  return false;
}

// ---- evidence ----

export interface EvidenceRef { kind: EvidenceKind; ref: string; hash?: string; raw: string }
export interface CitedEvidence { criterion: string; refs: EvidenceRef[] }
export interface VerifiedRef { raw: string; kind: string; ok: boolean; detail: string }

/** One reference: `action:<id>`, `tool:<name or message id>`,
 *  `file:<path>[#sha256=<hex>]`, `url:<https://…>`, `check:<n>`,
 *  `task:<key>`. A bare https URL is a url ref; a bare /path is a file ref. */
export function parseEvidenceRef(input: unknown): EvidenceRef | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', ref: raw, raw };
  if (raw.startsWith('/') || raw.startsWith('~/')) return parseEvidenceRef(`file:${raw}`);
  const m = /^([a-z]+):(.+)$/i.exec(raw);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const body = m[2].trim();
  if (!body || !(EVIDENCE_KINDS as readonly string[]).includes(kind)) return null;
  if (kind === 'file') {
    const h = /^(.*?)#sha256=([a-f0-9]{8,64})$/i.exec(body);
    return h ? { kind: 'file', ref: h[1], hash: h[2].toLowerCase(), raw } : { kind: 'file', ref: body, raw };
  }
  if (kind === 'url' && !/^https?:\/\//i.test(body)) return null;
  return { kind: kind as EvidenceKind, ref: body, raw };
}

/** The evidence as the maker gave it: `[{ criterion, refs }]`, or a map
 *  `{ <criterion>: refs }`, or a flat list of refs (they count for every
 *  criterion that takes any kind). Unparseable refs are returned apart, so
 *  the refusal can name them. */
export function normalizeEvidence(input: unknown): { cited: CitedEvidence[]; bad: string[] } {
  const bad: string[] = [];
  const toRefs = (v: unknown): EvidenceRef[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []).map((r) => {
    const p = parseEvidenceRef(r);
    if (!p && String(r ?? '').trim()) bad.push(String(r).slice(0, 200));
    return p;
  }).filter((x): x is EvidenceRef => x !== null).slice(0, 20);
  let v = input;
  if (typeof v === 'string') { const text = v; try { v = JSON.parse(text); } catch { v = text.trim() ? [{ criterion: '*', refs: text }] : []; } }
  const cited: CitedEvidence[] = [];
  if (Array.isArray(v)) {
    const flat = v.every((x) => typeof x === 'string');
    if (flat) { const refs = toRefs(v); if (refs.length) cited.push({ criterion: '*', refs }); }
    else for (const x of v.slice(0, 30)) {
      const o = (x ?? {}) as Record<string, unknown>;
      const refs = toRefs(o.refs ?? o.evidence ?? o.ref);
      cited.push({ criterion: String(o.criterion ?? o.id ?? '*').trim().toLowerCase() || '*', refs });
    }
  } else if (v && typeof v === 'object') {
    for (const [k, refs] of Object.entries(v as Record<string, unknown>).slice(0, 30)) cited.push({ criterion: k.trim().toLowerCase(), refs: toRefs(refs) });
  }
  return { cited, bad };
}

/** Which criteria lack an accepted reference, as remediation lines. `ok`
 *  says whether a ref was verified. A `*` entry counts for criteria that
 *  take any kind. */
export function evidenceGaps(criteria: Criterion[], cited: CitedEvidence[], ok: (raw: string) => boolean): Array<{ criterion: Criterion; want: string }> {
  const gaps: Array<{ criterion: Criterion; want: string }> = [];
  const wild = cited.filter((c) => c.criterion === '*').flatMap((c) => c.refs);
  for (const c of criteria) {
    if (c.evidence?.includes('none')) continue;
    const kinds = (c.evidence ?? []).filter((k): k is EvidenceKind => k !== 'none');
    const mine = cited.filter((x) => x.criterion === c.id || x.criterion === `${c.id}` || x.criterion === c.text.toLowerCase()).flatMap((x) => x.refs);
    const pool = kinds.length ? mine : [...mine, ...wild];
    const good = pool.filter((r) => ok(r.raw) && (kinds.length === 0 || kinds.includes(r.kind)));
    if (good.length === 0) gaps.push({ criterion: c, want: kinds.length ? kinds.map((k) => `${k}:`).join(' or ') : 'any real reference (file:, url:, action:, tool:, check:)' });
  }
  return gaps;
}

// ---- grading ----

export interface CriterionScore { criterion: string; score: number; note: string; refs: string[] }

/** The verifier's scores as given: `[{ criterion, score, note?, evidence? }]` or `{ <criterion>: score }`. */
export function normalizeScores(input: unknown): CriterionScore[] {
  let v = input;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  const out: CriterionScore[] = [];
  const push = (criterion: unknown, score: unknown, note: unknown, refs: unknown) => {
    const s = Number(score);
    if (!Number.isFinite(s)) return;
    out.push({ criterion: String(criterion ?? '').trim().toLowerCase(), score: Math.max(1, Math.min(5, Math.round(s * 2) / 2)), note: String(note ?? '').slice(0, 600), refs: (Array.isArray(refs) ? refs : typeof refs === 'string' ? refs.split(/[\s,]+/) : []).map(String).filter(Boolean).slice(0, 10) });
  };
  if (Array.isArray(v)) for (const x of v.slice(0, 30)) { const o = (x ?? {}) as Record<string, unknown>; push(o.criterion ?? o.id, o.score, o.note, o.evidence ?? o.refs); }
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 30)) {
    if (x && typeof x === 'object') { const o = x as Record<string, unknown>; push(k, o.score, o.note, o.evidence ?? o.refs); } else push(k, x, '', []);
  }
  return out;
}

export interface Grade { score: number | null; pass: boolean; missing: Criterion[]; below: Array<{ criterion: Criterion; score: number }>; perCriterion: CriterionScore[] }

/** Grade the scores against the criteria: the weighted mean on the 1–5
 *  scale; it passes when every criterion is scored, the mean reaches
 *  `passScore` and no criterion is under its `min`. */
export function grade(criteria: Criterion[], scores: CriterionScore[], passScore: number): Grade {
  const by = new Map(scores.map((s) => [s.criterion, s]));
  const missing = criteria.filter((c) => !by.has(c.id));
  const below: Grade['below'] = [];
  let sum = 0; let w = 0;
  for (const c of criteria) {
    const s = by.get(c.id);
    if (!s) continue;
    sum += s.score * c.weight; w += c.weight;
    if (c.min !== undefined && s.score < c.min) below.push({ criterion: c, score: s.score });
  }
  const score = w > 0 ? Math.round((sum / w) * 100) / 100 : null;
  return { score, pass: missing.length === 0 && below.length === 0 && score !== null && score >= passScore, missing, below, perCriterion: criteria.map((c) => by.get(c.id)).filter((x): x is CriterionScore => Boolean(x)) };
}

// ---- policies ----

export const POLICY_SCOPES = ['company', 'unit', 'role', 'action_class', 'deliverable'] as const;
export type PolicyScope = typeof POLICY_SCOPES[number];
export const POLICY_KINDS = ['predicate', 'judged'] as const;
export const POLICY_STAGES = ['action', 'result', 'both'] as const;
export const POLICY_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type PolicySeverity = typeof POLICY_SEVERITIES[number];
export const ENFORCEMENTS = ['block', 'warn', 'log'] as const;
export type Enforcement = typeof ENFORCEMENTS[number];
export const SEVERITY_RANK: Record<PolicySeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
export const ENFORCEMENT_RANK: Record<Enforcement, number> = { log: 0, warn: 1, block: 2 };

export const CONDITION_OPS = ['exists', 'absent', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'matches', 'not_matches', 'in', 'not_in', 'max_len'] as const;
export type ConditionOp = typeof CONDITION_OPS[number];
/** `field` is a dot path into the call's input (`price`, `items.0.discount`,
 *  `to`), `*` for the whole input as text, or for a result `text` (the
 *  submission note and the cited files) and `note`. */
export interface Condition { field: string; op: ConditionOp; value?: unknown }
export interface PolicyRule { tools?: string[]; classes?: string[]; when?: Condition[]; require?: Condition[]; forbid?: Condition[] }

export interface PolicyInput {
  key: string; statement: string; rationale: string; scopeKind: PolicyScope; scopeRef: string;
  kind: 'predicate' | 'judged'; rule: PolicyRule; appliesAt: 'action' | 'result' | 'both';
  severity: PolicySeverity; enforcement: Enforcement; remediation: string;
}

/** Tools a policy never applies to: the quality tools themselves, so a
 *  member can always ask for an exception or see what blocked it. */
export const POLICY_EXEMPT = /^org_(policy|policies|quality|qc)_?/;
const TOOL_PATTERN = /^[a-z0-9_*.:-]{1,80}$/i;
const ACTION_CLASSES = ['internal_write', 'external_reversible', 'external_irreversible', 'money'];

function normalizeConditions(raw: unknown, where: string): Condition[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > 10) throw new Error(`${where}: at most 10 conditions`);
  return list.map((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const field = String(o.field ?? '').trim();
    if (!field || field.length > 120 || !/^[A-Za-z0-9_.*-]+$/.test(field)) throw new Error(`${where}[${i}].field must be a dot path into the input (e.g. price, items.0.discount), * for the whole input, or text for a result`);
    const op = String(o.op ?? '').trim() as ConditionOp;
    if (!(CONDITION_OPS as readonly string[]).includes(op)) throw new Error(`${where}[${i}].op must be one of ${CONDITION_OPS.join(', ')}`);
    if (op !== 'exists' && op !== 'absent' && (o.value === undefined || o.value === null || o.value === '')) throw new Error(`${where}[${i}]: ${op} needs a value`);
    if ((op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte' || op === 'max_len') && !Number.isFinite(Number(o.value))) throw new Error(`${where}[${i}]: ${op} needs a number`);
    if (op === 'matches' || op === 'not_matches') { try { new RegExp(String(o.value)); } catch { throw new Error(`${where}[${i}]: "${String(o.value).slice(0, 60)}" is not a valid pattern`); } if (String(o.value).length > 200) throw new Error(`${where}[${i}]: pattern too long`); }
    if ((op === 'in' || op === 'not_in') && !Array.isArray(o.value)) throw new Error(`${where}[${i}]: ${op} needs a list`);
    return { field, op, ...(o.value !== undefined ? { value: o.value } : {}) };
  });
}

export function normalizePolicyRule(raw: unknown, opts: { kind: 'predicate' | 'judged'; appliesAt: 'action' | 'result' | 'both'; scopeKind: PolicyScope; scopeRef: string }): PolicyRule {
  const o = (typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown; } catch { throw new Error('rule must be JSON'); } })() : raw ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean);
  const tools = list(o.tools);
  for (const t of tools) if (!TOOL_PATTERN.test(t)) throw new Error(`rule.tools: "${t}" is not a tool name or pattern (letters, digits, _ and * as a wildcard)`);
  const classes = list(o.classes);
  if (opts.scopeKind === 'action_class' && !classes.includes(opts.scopeRef)) classes.push(opts.scopeRef);
  for (const c of classes) if (!ACTION_CLASSES.includes(c)) throw new Error(`rule.classes: "${c}" must be one of ${ACTION_CLASSES.join(', ')}`);
  const rule: PolicyRule = {
    ...(tools.length ? { tools } : {}), ...(classes.length ? { classes } : {}),
    when: normalizeConditions(o.when, 'rule.when'), require: normalizeConditions(o.require, 'rule.require'), forbid: normalizeConditions(o.forbid, 'rule.forbid'),
  };
  if (opts.appliesAt !== 'result' && !tools.length && !classes.length) throw new Error('a policy enforced at actions names the tools (rule.tools, * as a wildcard) or the action classes (rule.classes) it covers');
  if (opts.kind === 'predicate' && !rule.require!.length && !rule.forbid!.length) throw new Error('a predicate policy needs rule.require or rule.forbid conditions (or make it kind judged)');
  return rule;
}

export function normalizePolicy(raw: Record<string, unknown>): PolicyInput {
  const statement = String(raw.statement ?? '').trim().slice(0, 600);
  if (!statement) throw new Error('statement is required: the rule in one sentence');
  const key = raw.key ? String(raw.key).trim().toLowerCase() : slugify(statement).slice(0, 40);
  if (!SLUG_RE.test(key)) throw new Error('key must be a lowercase slug');
  const pick = <T extends string>(v: unknown, all: readonly T[], def: T, name: string): T => {
    const x = (v === undefined || v === null || v === '' ? def : String(v).trim()) as T;
    if (!all.includes(x)) throw new Error(`${name} must be one of ${all.join(', ')}`);
    return x;
  };
  const scopeKind = pick(raw.scopeKind ?? raw.scope, POLICY_SCOPES, 'company', 'scopeKind');
  const scopeRef = String(raw.scopeRef ?? raw.ref ?? '').trim().slice(0, 120);
  if (scopeKind !== 'company' && !scopeRef) throw new Error(`scopeRef is required for a ${scopeKind} policy`);
  const kind = pick(raw.kind, POLICY_KINDS, 'predicate', 'kind');
  const appliesAt = pick(raw.appliesAt, POLICY_STAGES, 'action', 'appliesAt');
  const rule = normalizePolicyRule(raw.rule ?? {}, { kind, appliesAt, scopeKind, scopeRef });
  return {
    key, statement, rationale: String(raw.rationale ?? '').trim().slice(0, 600), scopeKind, scopeRef: scopeKind === 'deliverable' ? scopeRef.toLowerCase() : scopeRef, kind, rule, appliesAt,
    severity: pick(raw.severity, POLICY_SEVERITIES, 'medium', 'severity'), enforcement: pick(raw.enforcement, ENFORCEMENTS, 'block', 'enforcement'),
    remediation: String(raw.remediation ?? '').trim().slice(0, 600),
  };
}

export function parseRule(raw: string | null | undefined): PolicyRule {
  try { const v = JSON.parse(raw || '{}') as PolicyRule; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** Whether a policy revision loosens it (the CEO's, boundary.ts). */
export function policyLoosens(before: { enforcement: string; severity: string; status: string }, after: { enforcement: string; severity: string; status: string }): boolean {
  if (after.status === 'retired' && before.status === 'active') return true;
  return (ENFORCEMENT_RANK[after.enforcement as Enforcement] ?? 0) < (ENFORCEMENT_RANK[before.enforcement as Enforcement] ?? 0)
    || (SEVERITY_RANK[after.severity as PolicySeverity] ?? 0) < (SEVERITY_RANK[before.severity as PolicySeverity] ?? 0);
}

/** `gmail_*` style wildcard match. */
export function toolMatches(pattern: string, tool: string): boolean {
  if (pattern === '*') return true;
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  return re.test(tool);
}

/** A value at a dot path; `*` is the whole subject as text. */
export function fieldValue(subject: Record<string, unknown>, path: string): unknown {
  if (path === '*') return JSON.stringify(subject);
  let cur: unknown = subject;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && seg === '*') return cur;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/** One condition, true when it holds. A list value (`items.*`) holds when it holds for every element. */
export function holds(c: Condition, subject: Record<string, unknown>): boolean {
  const v = fieldValue(subject, c.field);
  if (Array.isArray(v) && c.field.endsWith('.*')) return v.length > 0 && v.every((x) => holds({ ...c, field: '__x' }, { __x: x }));
  const n = Number(v);
  const want = c.value;
  switch (c.op) {
    case 'exists': return v !== undefined && v !== null && v !== '';
    case 'absent': return v === undefined || v === null || v === '';
    case 'eq': return asText(v).toLowerCase() === asText(want).toLowerCase() || (Number.isFinite(n) && n === Number(want));
    case 'neq': return !(asText(v).toLowerCase() === asText(want).toLowerCase() || (Number.isFinite(n) && n === Number(want)));
    case 'gt': return v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n > Number(want);
    case 'gte': return v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n >= Number(want);
    case 'lt': return v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n < Number(want);
    case 'lte': return v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n <= Number(want);
    case 'contains': return asText(v).toLowerCase().includes(asText(want).toLowerCase());
    case 'not_contains': return !asText(v).toLowerCase().includes(asText(want).toLowerCase());
    case 'matches': try { return new RegExp(String(want), 'i').test(asText(v)); } catch { return false; }
    case 'not_matches': try { return !new RegExp(String(want), 'i').test(asText(v)); } catch { return true; }
    case 'in': return Array.isArray(want) && want.map((x) => asText(x).toLowerCase()).includes(asText(v).toLowerCase());
    case 'not_in': return !(Array.isArray(want) && want.map((x) => asText(x).toLowerCase()).includes(asText(v).toLowerCase()));
    case 'max_len': return asText(v).length <= Number(want);
  }
  return false;
}

export function describeCondition(c: Condition): string {
  const v = c.value === undefined ? '' : ` ${Array.isArray(c.value) ? `[${c.value.map(asText).join(', ')}]` : asText(c.value)}`;
  return `${c.field} ${c.op.replace(/_/g, ' ')}${v}`;
}

/** Whether the rule covers an action at all (tool and class filters). */
export function ruleCoversAction(rule: PolicyRule, tool: string, cls: string): boolean {
  if (POLICY_EXEMPT.test(tool)) return false;
  if (rule.tools?.length && !rule.tools.some((p) => toolMatches(p, tool))) return false;
  if (rule.classes?.length && !rule.classes.includes(cls)) return false;
  return Boolean(rule.tools?.length || rule.classes?.length);
}

/** Evaluate a predicate rule on a subject (a call's input, or a result's
 *  `{ text, note }`). `applies` is false when a `when` condition does not
 *  hold; `failed` lists the requirements that do not hold and the
 *  forbidden conditions that do. */
export function evaluateRule(rule: PolicyRule, subject: Record<string, unknown>): { applies: boolean; violated: boolean; failed: string[] } {
  if ((rule.when ?? []).some((c) => !holds(c, subject))) return { applies: false, violated: false, failed: [] };
  const failed = [
    ...(rule.require ?? []).filter((c) => !holds(c, subject)).map((c) => `required: ${describeCondition(c)}`),
    ...(rule.forbid ?? []).filter((c) => holds(c, subject)).map((c) => `forbidden: ${describeCondition(c)}`),
  ];
  return { applies: true, violated: failed.length > 0, failed };
}

/** The refusal or warning an agent reads: what rule, what failed, what to do instead. */
export function policyMessage(p: { key: string; statement: string; enforcement: string; remediation: string; severity: string }, failed: string[], tool?: string): string {
  const what = p.enforcement === 'block' ? `Refused by policy "${p.key}"` : `Policy warning "${p.key}"`;
  return `${what} (${p.severity}): ${p.statement}${tool ? ` — ${tool}` : ''} failed ${failed.join('; ')}. ${p.remediation ? `Instead: ${p.remediation}` : 'Change the call so it meets the rule.'}${p.enforcement === 'block' ? ' Nothing was done. If the rule should not apply here, ask for a one-time exception with org_policy_exception (the violation id and why); do not retry the same call.' : ''}`;
}

// ---- templates ----

/** Starter standards (docs/quality.md "Templates"): seeded into a company
 *  on first use, then the company's own to refine. `deliverable` matches a
 *  task's class (or a `deliverable:` line in its constraints). */
export const QUALITY_TEMPLATES: Array<{ id: string; name: string; deliverable: string; summary: string; criteria: Criterion[] }> = [
  {
    id: 'general', name: 'Done means done', deliverable: '', summary: 'The company default: the done_when is met, the result is where the brief says, and the handoff explains it.',
    criteria: [
      { id: 'done-when', text: 'Every done_when item is met, each pointing at where it is met', weight: 3, min: 3 },
      { id: 'located', text: 'The result exists where the brief says (a file, a record, a sent draft) and can be opened', weight: 2, min: 3, evidence: ['file', 'action', 'tool', 'check', 'url'] },
      { id: 'handoff', text: 'The handoff says what was done, where it is and what is left, for someone who was not there', weight: 1, evidence: ['none'] },
    ],
  },
  {
    id: 'research', name: 'Research brief', deliverable: 'research', summary: 'Findings rest on sources the maker actually read.',
    criteria: [
      { id: 'question', text: 'Answers the question the brief asked, with a clear conclusion', weight: 2, min: 3, evidence: ['file'] },
      { id: 'sources', text: 'Every material claim cites a source that was actually fetched', weight: 3, min: 3, evidence: ['url', 'file'] },
      { id: 'uncertainty', text: 'Says what is unknown or estimated, never a made-up number', weight: 2, min: 3, evidence: ['none'] },
    ],
  },
  {
    id: 'report', name: 'Written report', deliverable: 'synthesis', summary: 'A document a reader can act on.',
    criteria: [
      { id: 'purpose', text: 'Leads with the conclusion or the ask', weight: 2, evidence: ['file'] },
      { id: 'numbers', text: 'Every number comes from a metric source, a file or a named person, or is labelled an estimate', weight: 3, min: 3, evidence: ['file', 'check', 'url', 'tool'] },
      { id: 'clarity', text: 'Clear, concise and fit for its audience', weight: 1, evidence: ['none'] },
    ],
  },
  {
    id: 'ops-change', name: 'Operational change', deliverable: 'ops', summary: 'A change to a system, with proof it worked and a way back.',
    criteria: [
      { id: 'effect', text: 'The change took effect, shown by a check or a tool result', weight: 3, min: 3, evidence: ['check', 'action', 'tool'] },
      { id: 'rollback', text: 'How to undo it is written down', weight: 1, evidence: ['file'] },
      { id: 'scope', text: 'Nothing outside the brief was changed', weight: 2, min: 3, evidence: ['none'] },
    ],
  },
  {
    id: 'outreach', name: 'Outward message', deliverable: 'outreach', summary: 'Anything a customer, candidate or vendor will read.',
    criteria: [
      { id: 'accurate', text: 'Every fact, price and date in it is correct and sourced', weight: 3, min: 4, evidence: ['file', 'url', 'tool', 'action'] },
      { id: 'policy', text: 'Meets the company\'s outward policies (disclaimers, approvals, tone)', weight: 2, min: 3, evidence: ['none'] },
      { id: 'drafted', text: 'Drafted or staged for review, not sent without the grant', weight: 2, min: 3, evidence: ['action', 'file'] },
    ],
  },
];

/** The deliverable kind of a task: a `deliverable:` line in its constraints, else its class. */
export function deliverableOf(task: { class?: string | null; brief: string }): string {
  let constraints = '';
  try { constraints = String((JSON.parse(task.brief || '{}') as { constraints?: unknown }).constraints ?? ''); } catch { /* not JSON */ }
  const m = /\bdeliverable:\s*([a-z][a-z0-9_-]*)/i.exec(constraints);
  return (m?.[1] ?? task.class ?? 'general').toLowerCase();
}

/** A `standard: <slug>` line in a task's constraints names its standard explicitly. */
export function standardSlugOf(task: { brief: string }): string | null {
  let constraints = '';
  try { constraints = String((JSON.parse(task.brief || '{}') as { constraints?: unknown }).constraints ?? ''); } catch { /* not JSON */ }
  return /\b(?:quality[ _-]?)?standard:\s*([a-z0-9][a-z0-9-]*)/i.exec(constraints)?.[1]?.toLowerCase() ?? null;
}

// ---- metrics ----

export interface QcRow { taskId: string; kind: string; outcome: string; round: number; makerAgentId: string | null; unitId: string | null; standardId: string | null; escapedAt: string | null; createdAt: string; independence: string }
export interface QualityFigures { tasks: number; graded: number; firstPassYield: number | null; reworkRate: number | null; escapes: number; escapeRate: number | null; spotChecks: number; spotCheckFails: number; sameFamilyShare: number | null }

/** First-pass yield (share of tasks whose first decided QC result passed),
 *  rework rate (share of tasks that needed at least one rework), defect
 *  escapes (accepted work later found defective). Pure. */
export function qualityFigures(rows: QcRow[]): QualityFigures {
  const reviews = rows.filter((r) => r.kind === 'review' && r.outcome !== 'pending');
  const byTask = new Map<string, QcRow[]>();
  for (const r of reviews) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  let first = 0; let rework = 0; let accepted = 0; let escapes = 0;
  for (const list of byTask.values()) {
    list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (list[0].outcome === 'pass') first++;
    if (list.some((r) => r.outcome === 'rework' || r.outcome === 'fail')) rework++;
    if (list.some((r) => r.outcome === 'pass')) accepted++;
    if (list.some((r) => r.outcome === 'pass' && r.escapedAt)) escapes++;
  }
  const spots = rows.filter((r) => r.kind === 'spot_check' && r.outcome !== 'pending');
  const n = byTask.size;
  const decidedAgent = reviews.filter((r) => r.independence === 'same_family' || r.independence === 'different_family');
  return {
    tasks: n, graded: reviews.length,
    firstPassYield: n ? Math.round((first / n) * 1000) / 1000 : null,
    reworkRate: n ? Math.round((rework / n) * 1000) / 1000 : null,
    escapes, escapeRate: accepted ? Math.round((escapes / accepted) * 1000) / 1000 : null,
    spotChecks: spots.length, spotCheckFails: spots.filter((r) => r.outcome === 'fail' || r.outcome === 'rework').length,
    sameFamilyShare: decidedAgent.length ? Math.round((decidedAgent.filter((r) => r.independence === 'same_family').length / decidedAgent.length) * 1000) / 1000 : null,
  };
}

/** The figures per maker, unit and standard. */
export function qualityBreakdown(rows: QcRow[]): { overall: QualityFigures; byAgent: Record<string, QualityFigures>; byUnit: Record<string, QualityFigures>; byStandard: Record<string, QualityFigures> } {
  const group = (key: (r: QcRow) => string | null) => {
    const m = new Map<string, QcRow[]>();
    for (const r of rows) { const k = key(r); if (k) m.set(k, [...(m.get(k) ?? []), r]); }
    return Object.fromEntries([...m.entries()].map(([k, v]) => [k, qualityFigures(v)]));
  };
  return { overall: qualityFigures(rows), byAgent: group((r) => r.makerAgentId), byUnit: group((r) => r.unitId), byStandard: group((r) => r.standardId) };
}

/** Deterministic sampling: the same task is always in or out for a rate. */
export function sampled(taskId: string, pct: number): boolean {
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  let h = 2166136261;
  for (let i = 0; i < taskId.length; i++) { h ^= taskId.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10_000) < pct * 100;
}
