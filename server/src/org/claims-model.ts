/**
 * Evidence-gated claims, the pure half (docs/evidence.md). A claim is a
 * statement an agent writes into shared company state that others will
 * build on: a key result's value, a project's health story, "sent 40
 * emails" on a task, a fact inside a decision, a process step's output, a
 * lesson stated as fact. The classes are data (`CLAIM_CLASSES`): when a
 * write carries a claim, the evidence kinds that count, the tunable that
 * sets its strictness (block | mark-unverified | log — per company, derived
 * from its values and culture, claims-tunables.ts), and where it is shown.
 *
 * The references are the quality verifier's (`quality-model.ts`
 * `parseEvidenceRef`: action:, tool:, file:, url:, check:, task:) and are
 * verified by the same code (`OrgQualityService.verifyEvidence`); this
 * module adds the claim detector, the count cross-check grammar, the
 * verdict and the remediation text. No model, no I/O.
 */
import type { EvidenceKind, VerifiedRef } from './quality-model';

/** Strictness: 0 log only, 1 mark unverified (the write lands, flagged, and does not count), 2 block. */
export type Strictness = 0 | 1 | 2;
export const STRICTNESS_WORD: Record<Strictness, 'log' | 'mark' | 'block'> = { 0: 'log', 1: 'mark', 2: 'block' };

export type ClaimClassKey = 'kr_checkin' | 'project_update' | 'task_update' | 'decision' | 'step_output' | 'lesson';

export interface ClaimClass {
  key: ClaimClassKey;
  label: string;
  /** Where the claim is stored against (org_claims.refType). */
  refType: 'checkin' | 'project_update' | 'task_comment' | 'decision' | 'minutes_decision' | 'step_output' | 'minutes_lesson';
  /** The write is a claim by its shape (a value), not by what its text says. */
  always: boolean;
  /** Reference kinds that count as evidence for it. */
  evidence: EvidenceKind[];
  /** The strictness tunable. */
  tunable: string;
  /** What "does not count until verified" means for this class. */
  effect: string;
}

const ALL: EvidenceKind[] = ['file', 'url', 'tool', 'action', 'check', 'task'];

export const CLAIM_CLASSES: Record<ClaimClassKey, ClaimClass> = {
  kr_checkin: { key: 'kr_checkin', label: 'Key-result value', refType: 'checkin', always: true, evidence: ['file', 'url', 'tool', 'action', 'check'], tunable: 'claims.krCheckin', effect: 'the key result keeps its last verified value; pace and progress ignore the claimed one' },
  project_update: { key: 'project_update', label: 'Project update', refType: 'project_update', always: false, evidence: ALL, tunable: 'claims.projectUpdate', effect: 'the update is shown flagged; the chief and readers treat its facts as unconfirmed' },
  task_update: { key: 'task_update', label: 'Task update', refType: 'task_comment', always: false, evidence: ALL, tunable: 'claims.taskUpdate', effect: 'the note is flagged on the timeline and in every read of the task' },
  decision: { key: 'decision', label: 'Fact in a decision', refType: 'minutes_decision', always: false, evidence: ['file', 'url', 'tool', 'action', 'task'], tunable: 'claims.decision', effect: 'the decision is logged with its facts flagged unverified' },
  step_output: { key: 'step_output', label: 'Process step output', refType: 'step_output', always: true, evidence: ALL, tunable: 'claims.stepOutput', effect: 'later steps see the output flagged unverified on their step card' },
  lesson: { key: 'lesson', label: 'Lesson stated as fact', refType: 'minutes_lesson', always: false, evidence: ['file', 'url', 'task', 'action'], tunable: 'claims.lesson', effect: 'the lesson is kept marked "(unverified)" wherever it travels' },
};

/** Verdict of one claim. `mismatch`: a count the record contradicts; `fabricated`: a cited reference that does not exist. */
export type ClaimStatus = 'verified' | 'unverified' | 'mismatch' | 'fabricated';
export const CLAIM_STATUSES: readonly ClaimStatus[] = ['verified', 'unverified', 'mismatch', 'fabricated'];

/** A verified reference as stored on the claim (the quality verifier's shape plus `missing`). */
export type ClaimRef = Pick<VerifiedRef, 'raw' | 'kind' | 'ok' | 'detail'> & { missing?: boolean };

// ---- detection ----

/** Past-tense completion and contact verbs: "sent", "published", "contacted". */
const DONE_VERBS = 'done|completed|finished|sent|emailed|mailed|published|posted|shipped|launched|deployed|released|contacted|called|messaged|signed|closed|delivered|paid|merged|submitted|booked|onboarded|reached out|resolved|fixed|migrated|uploaded|confirmed|secured|landed|won';
const DONE_RE = new RegExp(`\\b(?:${DONE_VERBS})\\b`, 'i');
/** A number that states a fact: money, a percent, or a count of something. */
const NUMBER_FACT_RE = /(?:[$€£]\s?\d[\d,.]*\s?[kmb]?\b|\b\d[\d,.]*\s?(?:%|percent\b|k\b|users?\b|customers?\b|subscribers?\b|signups?\b|sign-ups?\b|leads?\b|people\b|contacts?\b|prospects?\b|emails?\b|messages?\b|replies\b|orders?\b|sales?\b|deals?\b|visits?\b|visitors?\b|downloads?\b|installs?\b|tasks?\b|tickets?\b|posts?\b|followers?\b|mrr\b|arr\b|revenue\b|usd\b|dollars?\b))/i;
const FUTURE_RE = /\b(?:will|plan(?:s|ned)? to|going to|aim(?:s)? to|should|could|would|might|next week|tomorrow|by (?:mon|tue|wed|thu|fri|sat|sun))/i;

/** The sentences of `text` that state a checkable fact (pure, conservative):
 *  a completion verb or a factual number, not phrased as a plan. */
export function factualSentences(text: string): string[] {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  return t.split(/(?<=[.!?;])\s+|\n/).map((s) => s.trim()).filter((s) => s && !FUTURE_RE.test(s) && (DONE_RE.test(s) || NUMBER_FACT_RE.test(s))).slice(0, 8);
}

/** Whether a write of class `c` with this text and value carries a claim. */
export function carriesClaim(c: ClaimClass, text: string, value?: number | string | null): boolean {
  if (c.always) return value !== undefined && value !== null && String(value).trim() !== '';
  return factualSentences(text).length > 0;
}

// ---- counts the record can answer ----

/** What the record can count: outward actions (and their recipients), tasks the author finished, tool actions it took. */
export type CountMeasure = 'outward' | 'tasks_done' | 'actions';
export interface CountClaim { measure: CountMeasure; n: number; phrase: string }

const N = '(\\d{1,6}(?:,\\d{3})*)';
const COUNT_PATTERNS: Array<{ measure: CountMeasure; re: RegExp; at: number }> = [
  // "sent 40 emails", "contacted 93 people", "emailed 12 leads", "reached out to 30 prospects", "published 3 posts"
  { measure: 'outward', re: new RegExp(`\\b(?:sent|emailed|mailed|contacted|messaged|dm'?d|pitched|reached out to|published|posted)\\s+(?:out\\s+)?(?:to\\s+)?(?:about\\s+|over\\s+|~)?${N}\\b`, 'gi'), at: 1 },
  // "40 emails sent", "93 people contacted", "12 posts published"
  { measure: 'outward', re: new RegExp(`\\b${N}\\s+(?:outreach\\s+)?(?:emails?|messages?|dms?|people|contacts?|leads?|prospects?|customers?|posts?|invites?|invitations?)\\s+(?:were\\s+|have been\\s+|got\\s+)?(?:sent|emailed|contacted|messaged|reached|published|posted|invited)\\b`, 'gi'), at: 1 },
  // "completed 5 tasks", "closed 3 tickets"
  { measure: 'tasks_done', re: new RegExp(`\\b(?:completed|finished|closed|shipped|delivered|done with)\\s+${N}\\s+(?:tasks?|tickets?|items?)\\b`, 'gi'), at: 1 },
  // "5 tasks done"
  { measure: 'tasks_done', re: new RegExp(`\\b${N}\\s+(?:tasks?|tickets?)\\s+(?:are\\s+|were\\s+)?(?:done|completed|finished|closed)\\b`, 'gi'), at: 1 },
  // "ran 50 actions", "made 20 tool calls"
  { measure: 'actions', re: new RegExp(`\\b(?:ran|made|took|executed|performed)\\s+${N}\\s+(?:actions?|tool calls?|calls?|operations?)\\b`, 'gi'), at: 1 },
];

/** Every count the text claims that the record can check (pure). */
export function countClaims(text: string): CountClaim[] {
  const t = (text ?? '').replace(/\s+/g, ' ');
  const out: CountClaim[] = [];
  for (const p of COUNT_PATTERNS) {
    for (const m of t.matchAll(p.re)) {
      const n = Number(String(m[p.at]).replace(/,/g, ''));
      if (!Number.isFinite(n) || n <= 0) continue;
      if (FUTURE_RE.test(t.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0)))) continue;
      out.push({ measure: p.measure, n, phrase: m[0].trim().slice(0, 80) });
    }
  }
  return out.slice(0, 6);
}

/** A claimed count against the measured one: within `tolerancePct` over the record is fine. */
export function countMismatch(claimed: number, measured: number, tolerancePct: number): boolean {
  return claimed > Math.ceil(measured * (1 + Math.max(0, tolerancePct) / 100));
}

export const MEASURE_WORD: Record<CountMeasure, string> = { outward: 'outward actions (sends, posts) and their recipients', tasks_done: 'tasks you finished', actions: 'actions you took' };

// ---- the verdict ----

export interface ClaimVerdictInput {
  refs: ClaimRef[];
  /** Counts checked against the record. */
  counts: Array<CountClaim & { measured: number; mismatch: boolean }>;
  /** Unparseable references, as given. */
  bad: string[];
  /** The kinds that count for the class. */
  kinds: EvidenceKind[];
}

/** One status for the claim (pure): a nonexistent ref is a fabrication,
 *  a contradicted count a mismatch; otherwise verified when one accepted
 *  reference (of a kind that counts) checks out — or, with no refs, when
 *  every claimed count matches the record — and nothing cited fails. */
export function claimStatus(v: ClaimVerdictInput): ClaimStatus {
  if (v.refs.some((r) => r.missing)) return 'fabricated';
  if (v.counts.some((c) => c.mismatch)) return 'mismatch';
  const good = v.refs.filter((r) => r.ok && v.kinds.includes(r.kind as EvidenceKind));
  if (v.refs.some((r) => !r.ok) || v.bad.length) return 'unverified';
  if (good.length) return 'verified';
  return v.counts.length > 0 ? 'verified' : 'unverified';
}

/** The remediation a refusal (or a flagged write) carries: what to cite and how, never a bare "no". */
export function remediation(c: ClaimClass, v: ClaimVerdictInput & { status: ClaimStatus; tool: string; facts: string[] }): string {
  const parts: string[] = [];
  const missing = v.refs.filter((r) => r.missing);
  const failed = v.refs.filter((r) => !r.ok && !r.missing);
  if (missing.length) parts.push(`These references do not exist: ${missing.slice(0, 5).map((r) => `${r.raw} (${r.detail})`).join('; ')}. Citing what does not exist is recorded as a fabrication.`);
  if (failed.length) parts.push(`Not verifiable: ${failed.slice(0, 5).map((r) => `${r.raw} (${r.detail})`).join('; ')}.`);
  if (v.bad.length) parts.push(`Unreadable: ${v.bad.slice(0, 4).join(', ')}.`);
  for (const k of v.counts.filter((x) => x.mismatch).slice(0, 3)) parts.push(`"${k.phrase}" — the record shows ${k.measured} ${MEASURE_WORD[k.measure]} in this window. Write the number the record shows, or cite where the rest happened.`);
  if (!v.refs.some((r) => r.ok) && !v.counts.some((x) => x.mismatch)) {
    const what = v.facts.length ? ` for: "${v.facts.slice(0, 2).map((f) => f.slice(0, 90)).join('" / "')}"` : '';
    parts.push(`Cite evidence${what} — ${c.evidence.map((k) => EVIDENCE_HOW[k]).join('; ')}.`);
  }
  parts.push(`Call ${v.tool} again with evidence: ["file:/org/…", "action:<id>", …]; or state it as unconfirmed ("not yet verified: …") without the number.`);
  return parts.join(' ');
}

const EVIDENCE_HOW: Record<EvidenceKind, string> = {
  file: 'file:/path of the file that holds it',
  url: 'url:https://… a tool of yours fetched',
  tool: 'tool:<tool name> you ran for it',
  action: 'action:<action id> of the outward action',
  check: 'check:<n> of a passing task check',
  task: 'task:<key> of a finished task',
};

/** The short tag readers append: "" for verified, else "[unverified]" etc. */
export function claimTag(status: ClaimStatus | null | undefined): string {
  if (!status || status === 'verified') return '';
  return status === 'fabricated' ? '[fabricated evidence]' : status === 'mismatch' ? '[contradicted by the record]' : '[unverified]';
}

/** Per-agent tallies for the Claims panel (pure). */
export function claimTallies(rows: Array<{ agentId: string; status: string }>): Record<string, Record<ClaimStatus, number> & { total: number }> {
  const out: Record<string, Record<ClaimStatus, number> & { total: number }> = {};
  for (const r of rows) {
    const t = out[r.agentId] ??= { verified: 0, unverified: 0, mismatch: 0, fabricated: 0, total: 0 };
    if ((CLAIM_STATUSES as readonly string[]).includes(r.status)) t[r.status as ClaimStatus]++;
    t.total++;
  }
  return out;
}

/** The `evidence` input the gated tools take (kept short: it is on the chief's tool list four times). */
export const EVIDENCE_PROP = { type: 'array', items: { type: 'string' }, description: 'Refs backing stated facts: file:/…, url:…, action:<id>, tool:<name>, task:<key>' } as const;

// ---- the write-path gate (bound on OrgTasksService by OrgClaimsService) ----

/** A write that may carry a claim. `actor` is the writer (`agent:<id>`; anything else is not gated). */
export interface ClaimInput {
  cls: ClaimClassKey;
  actor: string;
  /** The tool the agent called, for the remediation ("call org_check_in again with evidence"). */
  tool: string;
  text?: string;
  value?: number | string | null;
  evidence?: unknown;
  context?: { taskId?: string | null; projectId?: string | null; goalId?: string | null; meetingId?: string | null; runId?: string | null };
}

/** What the gate decided for a write that lands. `counts`: whether the
 *  claim may count (toward a key result's progress, a derived figure) now. */
export interface ClaimTicket {
  status: ClaimStatus;
  enforcement: 'log' | 'mark' | 'block';
  counts: boolean;
  /** One line for the author: verified by …, or flagged with the remediation. */
  note: string;
  /** Store the claim against the record that was written; returns the claim id. */
  commit(refType: string, refId: string): Promise<string>;
}

/** The evidence gate: `check` throws (with remediation) to refuse a blocked
 *  claim, returns null when the write carries none; `flags` answers readers. */
export interface EvidenceGate {
  check(orgId: string, input: ClaimInput): Promise<ClaimTicket | null>;
  flags(orgId: string, refType: string, refIds: string[]): Promise<Map<string, ClaimStatus>>;
  /** Recent claims still not verified (flagged, not merely logged), newest first — the briefing's line. */
  unverified(orgId: string, opts?: { days?: number; limit?: number }): Promise<Array<{ agentId: string; classKey: string; statement: string; status: ClaimStatus; refType: string; refId: string; createdAt: string }>>;
}
