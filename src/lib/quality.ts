/** Quality control on screen (docs/quality.md §8): the plain sentences,
 *  labels and links the Quality page and the task's QC panel show. Pure —
 *  the components and the tests use these. */
import type { OrgPolicy, PolicyCondition, PolicyViolation, QcResult, QualityOverview, QualityStandard } from './api';
import type { Tone } from './direction';
import { filePathOf } from './file-links';

/** 0.723 → "72%", null → "—". */
export const pct = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`);

export const OUTCOME_LABEL: Record<QcResult['outcome'], string> = { pending: 'in review', pass: 'passed', rework: 'sent back', fail: 'failed' };
export const OUTCOME_TONE: Record<QcResult['outcome'], Tone | undefined> = { pending: undefined, pass: 'ok', rework: 'warn', fail: 'bad' };
export const ENFORCEMENT_TONE: Record<OrgPolicy['enforcement'], Tone | undefined> = { block: 'bad', warn: 'warn', log: undefined };
export const INDEPENDENCE_LABEL: Record<string, string> = { different_family: 'another model family', same_family: 'same model family', human: 'a person', check: 'checks', unknown: '' };

/** Where the Quality section stands, in one sentence. */
export function qualityLede(q: QualityOverview | null | undefined): string | null {
  if (!q) return null;
  const active = q.standards.filter((s) => s.status === 'active').length;
  const pols = q.policies.filter((p) => p.status === 'active').length;
  const o = q.metrics.overall;
  if (!active && !pols && !o.tasks) return 'No quality standards or policies yet: work is accepted on its done_when alone.';
  const parts = [o.tasks ? `${pct(o.firstPassYield)} of work passed review first time` : 'Nothing has been reviewed yet'];
  if (o.escapes) parts.push(`${o.escapes} accepted result${o.escapes === 1 ? '' : 's'} came back`);
  if (q.metrics.policies.violations) parts.push(`${q.metrics.policies.violations} policy violation${q.metrics.policies.violations === 1 ? '' : 's'}`);
  return `${parts.join(', ')} in the last ${q.metrics.days} days.`;
}

/** "Deliverable: research", "Unit", "Company". */
export function scopeLabel(s: Pick<QualityStandard, 'scopeKind' | 'scopeRef' | 'unitId'>, unitName?: (id: string) => string | undefined): string {
  const ref = s.scopeKind === 'unit' ? unitName?.(s.scopeRef) ?? s.scopeRef.slice(0, 8) : s.scopeRef;
  const head = s.scopeKind === 'company' ? 'Company' : `${s.scopeKind.replace('_', ' ').replace(/^./, (c) => c.toUpperCase())}${ref ? `: ${ref}` : ''}`;
  return s.unitId && s.scopeKind !== 'unit' ? `${head} (in ${unitName?.(s.unitId) ?? 'one unit'})` : head;
}

const valueText = (v: unknown): string => (Array.isArray(v) ? v.map(valueText).join(', ') : typeof v === 'string' ? `"${v}"` : String(v));
export function conditionText(c: PolicyCondition): string {
  return `${c.field} ${c.op.replace(/_/g, ' ')}${c.value === undefined ? '' : ` ${valueText(c.value)}`}`;
}

/** A policy's rule in words: what it covers, what must hold, what may not. */
export function ruleLines(p: Pick<OrgPolicy, 'rule' | 'kind' | 'appliesAt'>): string[] {
  const r = p.rule ?? {};
  const out: string[] = [];
  const covers = [r.tools?.length ? `tools ${r.tools.join(', ')}` : '', r.classes?.length ? `classes ${r.classes.map((c) => c.replace(/_/g, ' ')).join(', ')}` : ''].filter(Boolean).join(' · ');
  out.push(`${p.appliesAt === 'result' ? 'At review' : p.appliesAt === 'both' ? 'Before calls and at review' : 'Before calls'}${covers ? ` — ${covers}` : ''}`);
  if (r.when?.length) out.push(`When ${r.when.map(conditionText).join(' and ')}`);
  if (r.require?.length) out.push(`Requires ${r.require.map(conditionText).join(' and ')}`);
  if (r.forbid?.length) out.push(`Forbids ${r.forbid.map(conditionText).join(' or ')}`);
  if (p.kind === 'judged') out.push('Judged by an independent checker');
  return out;
}

/** An evidence reference as something to open: a workspace file, a web page, or text. */
export function evidenceTarget(raw: string): { kind: 'file'; path: string } | { kind: 'url'; href: string } | { kind: 'text' } {
  const body = raw.replace(/^(file|url):/, '').replace(/#sha256=[a-f0-9]+$/i, '');
  if (/^https?:\/\//i.test(body)) return { kind: 'url', href: body };
  const path = raw.startsWith('file:') || raw.startsWith('/') ? filePathOf(body.startsWith('/') ? body : `/${body}`) : null;
  return path ? { kind: 'file', path } : { kind: 'text' };
}

/** The QC rounds of one task, oldest first, with the spot checks after. */
export function qcRounds(results: QcResult[]): QcResult[] {
  return [...results].sort((a, b) => (a.kind === b.kind ? (a.createdAt < b.createdAt ? -1 : 1) : a.kind === 'review' ? -1 : 1));
}

/** One line per criterion: score, floor, note and the evidence behind it. */
export function criterionRows(r: QcResult): Array<{ id: string; text: string; weight: number; min?: number; score: number | null; note: string; refs: string[]; below: boolean }> {
  const ev = new Map<string, string[]>();
  for (const c of r.evidence ?? []) ev.set(c.criterion, [...(ev.get(c.criterion) ?? []), ...c.refs.filter((x) => x.ok).map((x) => x.raw)]);
  const wild = ev.get('*') ?? [];
  return (r.rubric ?? []).map((c) => {
    const s = r.scores.find((x) => x.criterion === c.id);
    const score = s ? s.score : null;
    return { id: c.id, text: c.text, weight: c.weight, min: c.min, score, note: s?.note ?? '', refs: [...new Set([...(ev.get(c.id) ?? []), ...(s?.refs ?? []), ...(c.evidence?.includes('none') ? [] : wild)])], below: score !== null && score < (c.min ?? r.passScore) };
  });
}

/** Violations per policy id, newest first. */
export function violationsByPolicy(v: PolicyViolation[]): Map<string, PolicyViolation[]> {
  const m = new Map<string, PolicyViolation[]>();
  for (const x of [...v].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))) m.set(x.policyId, [...(m.get(x.policyId) ?? []), x]);
  return m;
}

/** The members ranked by first-pass yield, worst first (who needs a clearer brief or coaching). */
export function makersByYield(q: QualityOverview): Array<{ agentId: string; firstPassYield: number | null; reworkRate: number | null; escapes: number; tasks: number }> {
  return Object.entries(q.metrics.byAgent).map(([agentId, f]) => ({ agentId, firstPassYield: f.firstPassYield, reworkRate: f.reworkRate, escapes: f.escapes, tasks: f.tasks }))
    .sort((a, b) => (a.firstPassYield ?? 1) - (b.firstPassYield ?? 1) || b.escapes - a.escapes);
}

/** What a standard or policy covers, in plain words: "All work", "Research deliverables (in Marketing)", "Work in Product". */
export function scopeWords(s: { scopeKind: string; scopeRef: string; unitId?: string | null }, unitName?: (id: string) => string | undefined): string {
  const unit = (id: string) => unitName?.(id) ?? 'one department';
  const ref = s.scopeRef;
  const head = s.scopeKind === 'company' ? 'All work'
    : s.scopeKind === 'unit' ? `Work in ${unit(ref)}`
    : s.scopeKind === 'deliverable' ? `${ref.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase())} deliverables`
    : s.scopeKind === 'role' ? `Work by a ${ref}`
    : s.scopeKind === 'action_class' ? `${ref.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())} actions`
    : s.scopeKind === 'process_step' ? `Process step ${ref}`
    : `${s.scopeKind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())} ${ref}`.trim();
  return s.unitId && s.scopeKind !== 'unit' ? `${head} (in ${unit(s.unitId)})` : head;
}

/** A policy's enforcement as what happens to a call that breaks it. */
export const ENFORCEMENT_WORD: Record<OrgPolicy['enforcement'], string> = { block: 'blocks', warn: 'warns', log: 'logs only' };

/** A violation's state after the fact. */
export const VIOLATION_STATUS_WORD: Record<PolicyViolation['status'], string> = { open: '', exception_requested: 'exception requested', waived: 'exception granted', upheld: 'upheld', used: 'exception used' };

/** Evidence kinds in words, for a criterion. */
export function evidenceWords(kinds: string[] | undefined): string {
  if (!kinds?.length) return '';
  if (kinds.includes('none')) return 'judged, no evidence';
  const word: Record<string, string> = { file: 'a file', url: 'a page read', tool: 'a tool result', action: 'an action', check: 'a check', task: 'a task' };
  return `evidence: ${kinds.map((k) => word[k] ?? k).join(', ')}`;
}

/** What waits on the CEO on the Quality page: proposals to decide and exceptions asked for. */
export function qualityAttention(q: QualityOverview): Array<{ id: string; kind: 'standard' | 'policy' | 'exception' | 'escape'; title: string; why: string; taskId?: string }> {
  const out: Array<{ id: string; kind: 'standard' | 'policy' | 'exception' | 'escape'; title: string; why: string; taskId?: string }> = [];
  for (const s of q.standards) if (s.status === 'proposed' || s.pending) out.push({ id: `s-${s.id}`, kind: 'standard', title: s.status === 'proposed' ? `New standard proposed: ${s.name}` : `Revision proposed: ${s.name}`, why: 'A card in the Inbox waits on your decision.' });
  for (const p of q.policies) if (p.status === 'proposed' || p.pending) out.push({ id: `p-${p.id}`, kind: 'policy', title: p.status === 'proposed' ? `New rule proposed: ${p.statement}` : `Change proposed: ${p.statement}`, why: 'A card in the Inbox waits on your decision.' });
  const byId = new Map(q.policies.map((p) => [p.id, p]));
  for (const v of q.violations) if (v.status === 'exception_requested') out.push({ id: `v-${v.id}`, kind: 'exception', title: `Exception asked: ${byId.get(v.policyId)?.statement ?? 'a policy'}`, why: v.detail.slice(0, 160) });
  for (const r of q.recent) if (r.escapedAt) out.push({ id: `e-${r.id}`, kind: 'escape', title: `Came back: ${r.taskKey ? `${r.taskKey} ` : ''}${r.taskTitle}`, why: r.escapeReason || 'Accepted work that was reopened or failed a spot check.', taskId: r.taskId });
  return out;
}
