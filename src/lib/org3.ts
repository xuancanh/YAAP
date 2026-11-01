/**
 * Pure helpers for the SPA of execution-plan items 27–30 (item 32, part one):
 * sensing (provenance, the selector tester, check summaries and the
 * verification badge), the action contract and the trust ledger (the grid,
 * the level legend, how an action was decided, why one is held), incidents
 * and health (the timeline, containment in words, the health strip, the
 * degraded-chat note, auditor quality), experiments (progress, verdicts),
 * calibration and reconciliation, plus the optional decision-card fields
 * item 31 adds. No fetches, no React — `web-tests/org3.test.ts` pins these.
 */
import type {
  ActionClass, ActionLogRow, CalibrationRow, ContainmentStep, ExperimentInput, IncidentSeverity, MetricProvenance, MetricSource, OrgAuditRun, OrgExperiment, OrgHealth,
  OrgIncident, ReconciliationGap, SpotCard, TaskCheck, TaskCheckKind, TaskCheckResult, TrustOverview,
} from './api';
import { safeJsonParse } from './util';

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
/** A number for display: integers as is, otherwise up to two decimals. */
export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}
export const pct = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
const hhmm = (iso: string | null | undefined): string => (iso ? iso.slice(11, 16) : '');

// ==== sensing (item 27, docs/sensing.md) ====

export const SOURCE_KIND_LABEL: Record<string, string> = { http_json: 'HTTP JSON', webhook: 'Webhook', connection: 'Connection query', manual_attested: 'Attested by a person' };
export const SOURCE_STATUS: Record<string, { label: string; color: string; title: string }> = {
  ok: { label: 'ok', color: 'var(--green)', title: 'Live: its last read or post worked' },
  error: { label: 'error', color: 'var(--red)', title: 'The last poll failed; it retries with backoff and key results keep the last value' },
  stale: { label: 'stale', color: 'var(--amber)', title: 'No sample for several poll intervals; the chief has a signal' },
  pending_approval: { label: 'pending approval', color: 'var(--blue)', title: 'Proposed by an agent; only the CEO makes it live (the metric_source card)' },
  rejected: { label: 'rejected', color: 'var(--text-faint)', title: 'The CEO rejected the proposal' },
};
export const sourceStatus = (s: string) => SOURCE_STATUS[s] ?? { label: s, color: 'var(--text-faint)', title: s };
export const CONNECTION_QUERIES: Array<{ id: 'gmail_unread' | 'gmail_matching' | 'calendar_events_week' | 'drive_changed'; label: string; hasDays: boolean }> = [
  { id: 'gmail_unread', label: 'Unread Gmail messages matching q', hasDays: false },
  { id: 'gmail_matching', label: 'Gmail messages matching q newer than N days', hasDays: true },
  { id: 'calendar_events_week', label: 'Calendar events this week matching q', hasDays: false },
  { id: 'drive_changed', label: 'Drive files changed in N days, name containing q', hasDays: true },
];

/** Provenance from a sample row (JSON) or an object. */
export function parseProvenance(raw: string | MetricProvenance | null | undefined): MetricProvenance {
  if (!raw) return { kind: 'unknown' };
  return typeof raw === 'string' ? safeJsonParse<MetricProvenance>(raw, { kind: 'unknown' }) : raw;
}

/** Where a number came from, in one line (the hover title of a value). */
export function provenanceLabel(raw: string | MetricProvenance | null | undefined): string {
  const p = parseProvenance(raw);
  const hash = p.responseHash ? ` · sha ${p.responseHash.slice(0, 10)}` : '';
  switch (p.kind) {
    case 'http_json': return `GET ${p.url ?? '?'}${p.status !== undefined ? ` → ${p.status}` : ''}${hash}`;
    case 'webhook': return `posted to the webhook${hash}`;
    case 'connection': return `${p.query ?? 'query'} over ${p.service ?? 'a'} connection${p.connection ? ` (${p.connection})` : ''}${hash}`;
    case 'manual_attested': return `attested by ${p.by === 'user' ? 'the owner' : p.by ?? 'a person'}${p.note ? ` — "${p.note}"` : ''}`;
    default: return p.kind === 'unknown' ? 'no provenance recorded' : `${p.kind}${hash}`;
  }
}

/** What a source reads, in one line. */
export function sourceTarget(s: Pick<MetricSource, 'kind' | 'config'>): string {
  const c = s.config ?? {};
  if (s.kind === 'http_json') return `${str(c.url)} → ${str(c.selector)}`;
  if (s.kind === 'connection') return `${str(c.query)}${c.q ? ` "${str(c.q)}"` : ''}${c.days ? ` · ${str(c.days)}d` : ''}`;
  if (s.kind === 'webhook') return 'POST /api/metrics/:id/ingest';
  return 'a person attests the value';
}

/** The public ingest URL of a webhook source. */
export const ingestUrl = (origin: string, sourceId: string): string => `${origin.replace(/\/$/, '')}/api/metrics/${sourceId}/ingest`;

/** Header names that carry credentials (the server's rule, docs/sensing.md §1.1). */
const SENSITIVE_HEADER = /authorization|cookie|token|secret|key|password|auth/i;
const SECRET_REF = /\{\{secret:([A-Za-z0-9_-]{1,40})\}\}/g;
/** Why a header would be refused, or null: a credential must be `{{secret:NAME}}`, optionally after a scheme word. */
export function headerError(name: string, value: string): string | null {
  if (!/^[A-Za-z0-9-]{1,60}$/.test(name)) return `header name "${name}" is not valid`;
  const refs = [...value.matchAll(SECRET_REF)].map((m) => m[1]);
  if (SENSITIVE_HEADER.test(name) && (refs.length === 0 || !/^[A-Za-z]{0,20}$/.test(value.replace(SECRET_REF, '').trim()))) {
    return `"${name}" carries a credential: write it as {{secret:NAME}} (e.g. "Bearer {{secret:API}}") and put the value under secrets`;
  }
  return null;
}
/** The secret names a header set references. */
export function secretRefs(headers: Record<string, string>): string[] {
  return [...new Set(Object.values(headers).flatMap((v) => [...v.matchAll(SECRET_REF)].map((m) => m[1])))];
}

type Step = { key: string } | { index: number } | { agg: 'length' | 'count' | 'sum'; field?: string[] };
/** The server's selector grammar (org-checks.ts `parseSelector`): a parser, not an evaluator. */
export function parseSelector(selector: string): Step[] {
  let s = String(selector ?? '').trim();
  if (!s) throw new Error('selector is required');
  if (s.length > 300) throw new Error('selector is at most 300 characters');
  if (s.startsWith('$')) s = s.slice(1);
  const steps: Step[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '.') { i++; continue; }
    if (s[i] === '[') {
      const close = s.indexOf(']', i);
      if (close < 0) throw new Error(`selector: unclosed [ at ${i}`);
      const inner = s.slice(i + 1, close).trim();
      if (/^\d+$/.test(inner)) steps.push({ index: Number(inner) });
      else if (/^"[^"]*"$|^'[^']*'$/.test(inner)) steps.push({ key: inner.slice(1, -1) });
      else throw new Error(`selector: [${inner}] must be an index or a quoted key`);
      i = close + 1;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)(\(([A-Za-z0-9_.-]*)\))?/.exec(s.slice(i));
    if (!m) throw new Error(`selector: unexpected "${s.slice(i, i + 10)}"`);
    const word = m[1];
    if (m[2] !== undefined) {
      if (word !== 'sum' && word !== 'count') throw new Error(`selector: ${word}() is not supported (sum(field), count())`);
      steps.push({ agg: word, field: m[3] ? m[3].split('.').filter(Boolean) : undefined });
    } else if (word === 'length') steps.push({ agg: 'length' });
    else steps.push({ key: word });
    i += m[0].length;
  }
  if (steps.length === 0) throw new Error('selector selects nothing');
  return steps;
}

export function selectValue(doc: unknown, selector: string): unknown {
  let cur: unknown = doc;
  for (const step of parseSelector(selector)) {
    if (cur === undefined || cur === null) return undefined;
    if ('key' in step) {
      if (typeof cur !== 'object' || Array.isArray(cur)) {
        if (Array.isArray(cur) && step.key === 'count') { cur = cur.length; continue; }
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[step.key];
    } else if ('index' in step) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[step.index];
    } else if (step.agg === 'length' || (step.agg === 'count' && !step.field)) {
      if (Array.isArray(cur) || typeof cur === 'string') cur = cur.length;
      else if (cur && typeof cur === 'object') cur = Object.keys(cur).length;
      else return undefined;
    } else {
      if (!Array.isArray(cur)) return undefined;
      const field = step.field ?? [];
      const vals = cur.map((x) => field.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), x));
      cur = step.agg === 'count' ? vals.filter((v) => v !== undefined && v !== null && v !== false).length : vals.reduce<number>((a, v) => a + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
    }
  }
  return cur;
}

/** The selector tester: paste a sample response, see the number the poll would store (or why not). */
export function testSelector(sampleJson: string, selector: string): { ok: true; value: number } | { ok: false; error: string } {
  try { parseSelector(selector); } catch (e) { return { ok: false, error: (e as Error).message }; }
  let doc: unknown;
  try { doc = JSON.parse(sampleJson); } catch { return { ok: false, error: 'the sample is not valid JSON' }; }
  const v = selectValue(doc, selector);
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'boolean' ? (v ? 1 : 0) : NaN;
  if (!Number.isFinite(n)) return { ok: false, error: `${selector} found ${v === undefined ? 'nothing' : JSON.stringify(v).slice(0, 80)}, not a number` };
  return { ok: true, value: n };
}

/** Values scaled to 0–100 for `sparkPath` (a flat series sits in the middle). */
export function normalizeSeries(values: number[]): number[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values); const hi = Math.max(...values);
  if (hi === lo) return values.map(() => 50);
  return values.map((v) => ((v - lo) / (hi - lo)) * 100);
}

export const CHECK_STATUS_COLOR: Record<string, string> = { pass: 'var(--green)', fail: 'var(--red)', error: 'var(--amber)', pending: 'var(--text-faint)' };

/** A task's check results in one line, and the outcome review would see. */
export function checkSummary(results: TaskCheckResult[]): { pass: number; fail: number; error: number; pending: number; outcome: 'none' | 'pass' | 'fail' | 'error' | 'pending'; label: string } {
  const n = (s: string) => results.filter((r) => r.status === s).length;
  const pass = n('pass'); const fail = n('fail'); const error = n('error'); const pending = n('pending');
  if (results.length === 0) return { pass, fail, error, pending, outcome: 'none', label: 'No checks — review decides' };
  const outcome = fail > 0 ? 'fail' : error > 0 ? 'error' : pending > 0 ? 'pending' : 'pass';
  const parts = [`${pass}/${results.length} pass`, fail ? `${fail} fail` : '', error ? `${error} could not run` : '', pending ? `${pending} not run yet` : ''].filter(Boolean);
  const tail = outcome === 'pass' ? ' — accepted by check at review' : outcome === 'fail' ? ' — review would send it back' : outcome === 'error' ? ' — falls back to a model review' : '';
  return { pass, fail, error, pending, outcome, label: `${parts.join(' · ')}${tail}` };
}

/** One line per check (the server's `describeCheck`, with source names when known). */
export function describeCheck(c: TaskCheck, sourceName: (id: string) => string | undefined = () => undefined): string {
  const src = (id: string) => sourceName(id) ?? id.slice(0, 8);
  switch (c.kind) {
    case 'metric_at_least': return `${src(c.sourceId)} ≥ ${c.value}`;
    case 'metric_increased': return `${src(c.sourceId)} up by ≥ ${c.by}${c.sinceTaskStart !== false ? ' since the task started' : ''}`;
    case 'http_status': return `GET ${c.url} answers ${c.status ?? 200}`;
    case 'http_json_match': return `GET ${c.url} → ${c.selector}${c.equals !== undefined ? ` = ${JSON.stringify(c.equals)}` : ''}${c.contains !== undefined ? ` contains "${c.contains}"` : ''}${c.atLeast !== undefined ? ` ≥ ${c.atLeast}` : ''}`;
    case 'file_exists': return `file ${c.path} exists`;
    case 'file_matches': return `file ${c.path}${c.contains !== undefined ? ` contains "${c.contains}"` : ''}${c.regex ? ` matches /${c.regex}/` : ''}${c.jsonSchemaKeys ? ` has keys ${c.jsonSchemaKeys.join(', ')}` : ''}`;
    case 'connection_query': return `${c.service}${c.query ? ` "${c.query}"` : ''} counts ≥ ${c.atLeast}`;
    default: return JSON.stringify(c);
  }
}

/** The check builder's kinds and their fields (no github_check: there is no GitHub connection). */
export const CHECK_KIND_FIELDS: Record<TaskCheckKind, { label: string; fields: Array<{ key: string; label: string; kind: 'text' | 'number' | 'source' | 'query' | 'bool'; optional?: boolean }> }> = {
  metric_at_least: { label: 'Metric at least', fields: [{ key: 'sourceId', label: 'Source', kind: 'source' }, { key: 'value', label: 'Value ≥', kind: 'number' }] },
  metric_increased: { label: 'Metric increased', fields: [{ key: 'sourceId', label: 'Source', kind: 'source' }, { key: 'by', label: 'By at least', kind: 'number' }, { key: 'sinceTaskStart', label: 'since the task started', kind: 'bool', optional: true }] },
  http_status: { label: 'HTTP status', fields: [{ key: 'url', label: 'URL', kind: 'text' }, { key: 'status', label: 'Status', kind: 'number', optional: true }] },
  http_json_match: { label: 'HTTP JSON match', fields: [{ key: 'url', label: 'URL', kind: 'text' }, { key: 'selector', label: 'Selector', kind: 'text' }, { key: 'equals', label: 'Equals', kind: 'text', optional: true }, { key: 'contains', label: 'Contains', kind: 'text', optional: true }, { key: 'atLeast', label: 'At least', kind: 'number', optional: true }] },
  file_exists: { label: 'File exists', fields: [{ key: 'path', label: 'Workspace path', kind: 'text' }] },
  file_matches: { label: 'File matches', fields: [{ key: 'path', label: 'Workspace path', kind: 'text' }, { key: 'contains', label: 'Contains', kind: 'text', optional: true }, { key: 'regex', label: 'Regex', kind: 'text', optional: true }, { key: 'jsonSchemaKeys', label: 'Has keys (comma-separated)', kind: 'text', optional: true }] },
  connection_query: { label: 'Connection count', fields: [{ key: 'service', label: 'Query', kind: 'query' }, { key: 'query', label: 'q', kind: 'text', optional: true }, { key: 'days', label: 'Days', kind: 'number', optional: true }, { key: 'atLeast', label: 'At least', kind: 'number' }] },
};
const PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]+$/;

/** Build a check from the builder's string fields, or say what is missing. */
export function buildCheck(kind: TaskCheckKind, f: Record<string, string | boolean | undefined>): TaskCheck | string {
  const t = (k: string) => (typeof f[k] === 'string' ? (f[k] as string).trim() : '');
  const num = (k: string): number | undefined => (t(k) === '' ? undefined : Number(t(k)));
  const need = (k: string, label: string): string | null => (t(k) ? null : `${label} is required`);
  const badNum = (k: string) => { const v = num(k); return v !== undefined && !Number.isFinite(v) ? `${k} must be a number` : null; };
  switch (kind) {
    case 'metric_at_least': return need('sourceId', 'a source') ?? need('value', 'the value') ?? badNum('value') ?? { kind, sourceId: t('sourceId'), value: num('value')! };
    case 'metric_increased': return need('sourceId', 'a source') ?? need('by', '"by"') ?? badNum('by') ?? { kind, sourceId: t('sourceId'), by: num('by')!, sinceTaskStart: f.sinceTaskStart !== false };
    case 'http_status': {
      const e = need('url', 'the URL') ?? (/^https?:\/\//.test(t('url')) ? null : 'the URL must start with https://') ?? badNum('status');
      return e ?? { kind, url: t('url'), ...(num('status') !== undefined ? { status: num('status')! } : {}) };
    }
    case 'http_json_match': {
      const e = need('url', 'the URL') ?? need('selector', 'a selector') ?? badNum('atLeast');
      if (e) return e;
      try { parseSelector(t('selector')); } catch (err) { return (err as Error).message; }
      if (!t('equals') && !t('contains') && num('atLeast') === undefined) return 'give equals, contains or at least';
      return { kind, url: t('url'), selector: t('selector'), ...(t('equals') ? { equals: t('equals') } : {}), ...(t('contains') ? { contains: t('contains') } : {}), ...(num('atLeast') !== undefined ? { atLeast: num('atLeast')! } : {}) };
    }
    case 'file_exists': return need('path', 'a path') ?? (PATH_RE.test(t('path')) ? { kind, path: t('path') } : 'a workspace-relative path, no ..');
    case 'file_matches': {
      const e = need('path', 'a path') ?? (PATH_RE.test(t('path')) ? null : 'a workspace-relative path, no ..');
      if (e) return e;
      if (!t('contains') && !t('regex') && !t('jsonSchemaKeys')) return 'give contains, a regex or keys';
      if (t('regex').length > 200) return 'the regex is at most 200 characters';
      if (t('regex')) { try { new RegExp(t('regex')); } catch { return 'the regex does not compile'; } }
      const keys = t('jsonSchemaKeys').split(',').map((x) => x.trim()).filter(Boolean);
      return { kind, path: t('path'), ...(t('contains') ? { contains: t('contains') } : {}), ...(t('regex') ? { regex: t('regex') } : {}), ...(keys.length ? { jsonSchemaKeys: keys } : {}) };
    }
    case 'connection_query': {
      const svc = t('service');
      if (!CONNECTION_QUERIES.some((q) => q.id === svc)) return 'pick a query from the menu';
      const e = need('atLeast', '"at least"') ?? badNum('atLeast') ?? badNum('days');
      if (e) return e;
      const days = num('days') ?? 7;
      if (days < 1 || days > 90) return 'days must be 1–90';
      return { kind, service: svc as 'gmail_unread', query: t('query'), days, atLeast: num('atLeast')! };
    }
  }
}

/** How a done task was accepted (docs/sensing.md §3.2): check, opinion, or by hand. */
export function verificationBadge(v: string | null | undefined): { label: string; color: string; title: string } | null {
  if (v === 'check') return { label: '✓ by check', color: 'var(--green)', title: 'Accepted because every executable check passed — no model was asked' };
  if (v === 'review') return { label: 'by review', color: 'var(--blue)', title: 'Accepted by a reviewer\'s judgment (a model or a person)' };
  if (v === 'none') return { label: 'unverified', color: 'var(--text-faint)', title: 'Set done by hand — neither checks nor a review accepted it' };
  return null;
}

/** The task's checks from its JSON column (an empty list on junk). */
export function parseTaskChecks(raw: string | null | undefined): TaskCheck[] {
  const v = safeJsonParse<unknown>(raw ?? '[]', []);
  return Array.isArray(v) ? v.filter((x): x is TaskCheck => Boolean(x) && typeof x === 'object' && typeof (x as { kind?: unknown }).kind === 'string') : [];
}

// ==== actions and trust (item 28, docs/actions-and-trust.md) ====

export const ACTION_CLASSES: ActionClass[] = ['read', 'internal_write', 'external_reversible', 'external_irreversible', 'money'];
export const CLASS_LABEL: Record<string, string> = { read: 'Read', internal_write: 'Internal write', external_reversible: 'External, reversible', external_irreversible: 'External, irreversible', money: 'Money' };
export const CLASS_SHORT: Record<string, string> = { read: 'read', internal_write: 'internal', external_reversible: 'ext. reversible', external_irreversible: 'irreversible', money: 'money' };
export const CLASS_COLOR: Record<string, string> = { read: 'var(--text-faint)', internal_write: 'var(--blue)', external_reversible: 'var(--amber)', external_irreversible: 'var(--red)', money: 'var(--red)' };
export const CLASS_HINT: Record<string, string> = {
  read: 'nothing changes anywhere',
  internal_write: 'changes the workspace only (files, boards, the sandbox)',
  external_reversible: 'leaves the workspace but can be undone or reached nobody yet (a draft, a click)',
  external_irreversible: 'reaches another person or system for good (a sent email, an invite, your computer)',
  money: 'moves money',
};
/** The level legend (docs/actions-and-trust.md §5). */
export const LEVEL_LEGEND: Array<{ level: number; label: string; text: string }> = [
  { level: 0, label: 'Proposes', text: 'asks the person present; held (or staged as a draft) for your key when nobody is there' },
  { level: 1, label: 'Acts, you hear after', text: 'reversible actions run and you are told after; irreversible and money still need your key' },
  { level: 2, label: 'Peer-checked', text: 'acts; irreversible and money need a second agent key on another model family' },
  { level: 3, label: 'Trusted', text: 'acts; the auditor samples its work' },
];

export interface TrustCell { cls: ActionClass; level: number; ceiling: number; effective: number; capped: boolean; clean: number; rejectStreak: number; lastIncidentAt: string | null; reason: string; counts: Record<string, number>; title: string }
export interface TrustGridRow { agentId: string; name: string; cells: TrustCell[]; lastIncidentAt: string | null }
/** The agents × classes grid (read hidden unless asked — every agent reads at 3). */
export function trustRows(o: TrustOverview | null, opts: { withRead?: boolean } = {}): TrustGridRow[] {
  if (!o) return [];
  const classes = ACTION_CLASSES.filter((c) => opts.withRead || c !== 'read');
  return o.agents.map((a) => {
    const cells = classes.map((cls) => {
      const r = a.classes.find((x) => x.actionClass === cls);
      const level = r?.level ?? 0; const ceiling = r?.ceiling ?? 0; const effective = r?.effective ?? Math.min(level, ceiling);
      const counts = r?.counts ?? {};
      const tally = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
      return {
        cls, level, ceiling, effective, capped: effective < level, clean: r?.cleanCount ?? 0, rejectStreak: r?.rejectStreak ?? 0, lastIncidentAt: r?.lastIncidentAt ?? null, reason: r?.reason ?? '', counts,
        title: `${CLASS_LABEL[cls]}: level ${level} of ceiling ${ceiling}${effective < level ? `, effective ${effective} (the organization mode caps it)` : ''} · ${r?.cleanCount ?? 0} clean since the last change${tally ? ` · ${tally}` : ''}${r?.reason ? ` · ${r.reason}` : ''}`,
      };
    });
    const last = cells.map((c) => c.lastIncidentAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
    return { agentId: a.agentId, name: a.name, cells, lastIncidentAt: last };
  });
}
export const LEVEL_COLOR = ['var(--text-faint)', 'var(--blue)', 'var(--accent)', 'var(--green)'];

export type ActionDecision = 'acted' | 'acted, you heard after' | 'staged' | 'held' | 'frozen' | 'co-signed' | 'deduplicated' | 'denied' | 'refused' | 'failed' | 'asked' | 'running';
/** How an action was decided, in the owner's words (acted / staged / held / frozen / co-signed / deduplicated …). */
export function actionDecisionLabel(r: Pick<ActionLogRow, 'status' | 'decision' | 'dedupeCount' | 'keys'>): { label: ActionDecision; color: string } {
  const keys = safeJsonParse<Record<string, unknown>>(r.keys || '{}', {});
  const cosigned = typeof keys.agent === 'object' && keys.agent !== null && (keys.agent as { verdict?: string }).verdict === 'approve';
  if (r.status === 'held') return { label: r.decision === 'frozen' ? 'frozen' : 'held', color: r.decision === 'frozen' ? 'var(--red)' : 'var(--amber)' };
  if (r.status === 'staged') return { label: 'staged', color: 'var(--amber)' };
  if (r.status === 'denied') return { label: 'denied', color: 'var(--red)' };
  if (r.status === 'refused') return { label: 'refused', color: 'var(--red)' };
  if (r.status === 'failed') return { label: 'failed', color: 'var(--red)' };
  if (r.status === 'started') return { label: 'running', color: 'var(--text-faint)' };
  if (r.dedupeCount > 0) return { label: 'deduplicated', color: 'var(--text-dim)' };
  if (r.decision === 'cosign' || cosigned) return { label: 'co-signed', color: 'var(--accent)' };
  if (r.decision === 'run_notify') return { label: 'acted, you heard after', color: 'var(--green)' };
  if (r.decision === 'ask' || r.decision === 'legacy' || r.decision.startsWith('cosign→')) return { label: r.decision === 'legacy' ? 'acted' : 'asked', color: 'var(--green)' };
  return { label: 'acted', color: 'var(--green)' };
}

/** Why an action waits for the owner's key: the frozen class, the two-key rule, or the level. */
export function heldReason(r: Pick<ActionLogRow, 'decision' | 'class' | 'level' | 'keys' | 'status'>): string {
  const keys = safeJsonParse<Record<string, unknown>>(r.keys || '{}', {});
  const cls = (CLASS_LABEL[r.class] ?? r.class).toLowerCase();
  if (r.decision === 'frozen') return `An incident froze ${cls} actions for the organization — every member's call of this class waits for your key.`;
  if (keys.singleFamily) return `Two-key rule: ${cls} needs a second key, and no member runs on another model family to co-sign — so the second key is yours.`;
  const agent = keys.agent as { verdict?: string; reason?: string } | undefined;
  if (agent && agent.verdict && agent.verdict !== 'approve') return `The co-signer could not approve (${agent.reason ?? agent.verdict}); the key falls to you.`;
  const why = typeof keys.why === 'string' ? keys.why : '';
  return `${r.status === 'staged' ? 'Staged as a draft' : 'Held'}: ${cls} at trust level ${r.level ?? 0}${why ? ` — ${why}` : ''}.`;
}

/** The exact call, pretty-printed (what the owner's key will run). */
export function actionCallText(r: Pick<ActionLogRow, 'tool' | 'input'>): string {
  const input = safeJsonParse<unknown>(r.input || '{}', r.input);
  return `${r.tool}(${JSON.stringify(input, null, 2)})`;
}

/** What "Approve" will do on a held or staged action, in words. */
export function keyButtonLabel(r: Pick<ActionLogRow, 'status' | 'tool' | 'stagedRef'>): string {
  if (r.status === 'staged') return r.tool.includes('mail') ? 'Send the draft (my key)' : 'Promote the staged action (my key)';
  return `Approve — run ${r.tool} (my key)`;
}

/** A tool result that says the call was parked for the owner's key (the turn loop's `hold` text). */
export function parseHeldToolResult(output: string | undefined): { kind: 'held' | 'staged'; cls: string | null; actionPrefix: string | null } | null {
  if (!output) return null;
  const held = /^Held for the owner's key: \S+ is an? ([a-z ]+?) action/.exec(output);
  const staged = /^Staged, not sent: \S+ is an? ([a-z ]+?) action/.exec(output);
  const m = held ?? staged;
  if (!m) return null;
  const id = /\(action ([0-9a-f-]{6,})\)/i.exec(output)?.[1] ?? null;
  return { kind: held ? 'held' : 'staged', cls: m[1].trim().replace(/ /g, '_'), actionPrefix: id };
}

/** The class of a tool by name, when the registry fixes it (docs/actions-and-trust.md §1). Provider tools whose owner flag decides (org_, channel_, meeting_, mcp_) return null. */
export function toolClassHint(tool: string): ActionClass | null {
  const exact: Record<string, ActionClass> = {
    fs_list: 'read', fs_read: 'read', fs_search: 'read', web_search: 'read', web_fetch: 'read', fs_write: 'internal_write', fs_delete: 'internal_write', slides_create: 'internal_write',
    http_request: 'external_reversible', run_js: 'internal_write', run_python: 'internal_write', browser_open: 'read', browser_read: 'read', browser_screenshot: 'read', browser_act: 'external_reversible',
    gcal_upcoming: 'read', gcal_search: 'read', gcal_freebusy: 'read', gcal_create_event: 'external_reversible', gcal_update_event: 'external_reversible',
    gmail_draft: 'external_reversible', gmail_send: 'external_irreversible', drive_search: 'read', drive_read: 'read', drive_export_doc: 'external_reversible', drive_export_sheet: 'external_reversible',
    mscal_upcoming: 'read', mscal_search: 'read', mscal_create_event: 'external_reversible', mscal_update_event: 'external_reversible', msmail_draft: 'external_reversible', msmail_send: 'external_irreversible',
    msdrive_search: 'read', msdrive_read: 'read', msdrive_export_doc: 'external_reversible', msdrive_export_sheet: 'external_reversible', trust_status: 'read',
    list_tasks: 'read', search_history: 'read', update_dashboard: 'internal_write', save_app: 'internal_write', add_task: 'internal_write', update_task: 'internal_write',
  };
  if (exact[tool]) return exact[tool];
  if (/(?:^|_)(pay|payment|payout|charge|refund|transfer|invoice_send|purchase|buy|checkout|stripe_charge)(?:_|$)/.test(tool)) return 'money';
  if (tool.startsWith('computer_')) return 'external_irreversible';
  if (tool.startsWith('skill_')) return 'read';
  if (tool.startsWith('tool_')) return 'external_reversible';
  return null;
}

// ==== incidents and health (item 29, docs/incidents.md) ====

export const INCIDENT_SEVERITY_COLOR: Record<IncidentSeverity, string> = { minor: 'var(--amber)', major: 'var(--red)', critical: '#b91c1c' };
const SEV_RANK: Record<string, number> = { critical: 0, major: 1, minor: 2 };
export const INCIDENT_KIND_LABEL: Record<string, string> = {
  breaker: 'loop breaker', budget_stop: 'budget stop', check_failed: 'check failed after acceptance', revert: 'reverted by the owner', audit_critical: 'critical audit finding',
  delivery_failure: 'delivery refused', tool_error_streak: 'tool errors in a row', provider_degraded: 'provider degraded', connection_degraded: 'connection degraded',
  auditor_miss: 'auditor disagreement', redteam_breach: 'red-team breach', owner_report: 'reported by you', member_report: 'reported by a member', claim_mismatch: 'claim mismatch', experiment_harm: 'experiment harm',
};

/** Open and contained first (worst severity, newest), then resolved newest first. */
export function sortIncidents(list: OrgIncident[]): { open: OrgIncident[]; resolved: OrgIncident[] } {
  const open = list.filter((i) => i.status !== 'resolved').sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3) || (a.openedAt < b.openedAt ? 1 : -1));
  const resolved = list.filter((i) => i.status === 'resolved').sort((a, b) => ((a.resolvedAt ?? a.openedAt) < (b.resolvedAt ?? b.openedAt) ? 1 : -1));
  return { open, resolved };
}

/** A containment step in words. */
export function containmentLabel(s: ContainmentStep): string {
  const d = s.data ?? {};
  // A step that changed nothing (already paused, the chief, not an external class) says so in its result.
  if (!s.reversible && s.action !== 'note' && s.action !== 'cancel_wakes' && s.result) return s.result.charAt(0).toUpperCase() + s.result.slice(1);
  const base = (() => {
    switch (s.action) {
      case 'note': return 'Noted (signal raised)';
      case 'pause_member': return `Paused ${d.name || 'the member'}`;
      case 'cancel_wakes': return 'Dropped queued wakes and stopped in-flight runs';
      case 'freeze_class': return `Froze ${(CLASS_LABEL[d.actionClass ?? d.class ?? ''] ?? d.actionClass ?? d.class ?? 'the class').toLowerCase()} actions`;
      case 'supervised': return 'Switched the company to supervised';
      case 'pause_org': return 'Paused the company (kill switch)';
      default: return s.action.replace(/_/g, ' ');
    }
  })();
  return `${base}${s.undone ? ' — undone' : ''}`;
}

/** What is still contained (reversible steps in force). */
export const containedNow = (i: Pick<OrgIncident, 'containment'>): ContainmentStep[] => i.containment.filter((s) => s.reversible && !s.undone && s.action !== 'note');

export interface TimelineEntry { at: string; kind: 'detected' | 'contain' | 'contained' | 'postmortem' | 'resolved'; text: string; detail?: string; undone?: boolean }
/** Detection → containment steps (with results) → postmortem → resolution, in time order. */
export function incidentTimeline(i: OrgIncident): TimelineEntry[] {
  const rank: Record<TimelineEntry['kind'], number> = { detected: 0, contain: 1, contained: 2, postmortem: 3, resolved: 4 };
  const out: TimelineEntry[] = [{ at: i.openedAt, kind: 'detected', text: `Detected by ${i.detectedBy === 'system' ? 'the system' : i.detectedBy === 'owner' ? 'you' : `the ${i.detectedBy}`} — ${INCIDENT_KIND_LABEL[i.kind] ?? i.kind.replace(/_/g, ' ')}`, detail: i.detail || undefined }];
  for (const s of i.containment) out.push({ at: s.at, kind: 'contain', text: containmentLabel(s), detail: s.result || undefined, undone: s.undone });
  if (i.containedAt) out.push({ at: i.containedAt, kind: 'contained', text: 'Contained' });
  if (i.postmortemMeetingId) out.push({ at: i.containedAt ?? i.openedAt, kind: 'postmortem', text: 'Postmortem retro scheduled' });
  if (i.resolvedAt) out.push({ at: i.resolvedAt, kind: 'resolved', text: 'Resolved', detail: i.resolution || undefined });
  return out.map((e, idx) => ({ e, idx })).sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : rank[a.e.kind] - rank[b.e.kind] || a.idx - b.idx)).map((x) => x.e);
}

export const MANUAL_CONTAINMENT_LABEL: Record<string, { label: string; hint: string }> = {
  pause_member: { label: 'Pause the member', hint: 'stops its wakes and in-flight runs' },
  freeze_class: { label: 'Freeze the action class', hint: 'every member\'s call of this class waits for your key' },
  supervised: { label: 'Switch to supervised', hint: 'structural changes become cards again' },
  pause_org: { label: 'Pause the company', hint: 'the kill switch: every wake and run stops' },
};

export interface HealthItem { tone: 'red' | 'amber' | 'blue'; text: string; title?: string }
/** The health strip: degraded providers and connections with since-when, frozen classes, members paused by an incident. */
export function healthStrip(h: OrgHealth | null): HealthItem[] {
  if (!h) return [];
  const out: HealthItem[] = [];
  for (const p of h.providers) out.push({ tone: p.state === 'degraded' ? 'red' : 'amber', text: `${p.provider} ${p.state}${p.since ? ` since ${hhmm(p.since)} UTC` : ''}${p.state === 'degraded' && p.until ? ` · retry ${hhmm(p.until)} UTC` : ''}`, title: `${p.failures} transient failure(s)${p.lastError ? ` — ${p.lastError}` : ''}. Turns run on another model family meanwhile.` });
  for (const c of h.connections) out.push({ tone: 'red', text: `${c.provider} connection ${c.accountEmail} degraded since ${hhmm(c.since)} UTC`, title: `${c.reason} — only the actions that need it are refused; reconnect it in Settings → Connections.` });
  for (const f of h.frozenClasses) out.push({ tone: 'amber', text: `${(CLASS_LABEL[f] ?? f).toLowerCase()} frozen`, title: 'Every member\'s call of this class waits for your key until the incident is resolved with "undo containment".' });
  for (const m of h.pausedByIncident) out.push({ tone: 'amber', text: `${m.name || 'a member'} paused by an incident` });
  if (h.orgStatus === 'paused') out.push({ tone: 'red', text: 'company paused' });
  return out;
}

/** The chat header line when a turn ran on a fallback model, or the agent's provider is degraded now. */
export function degradedChatNote(turnDegraded: string | null | undefined, health: OrgHealth | null, provider: string | undefined): string | null {
  const d = safeJsonParse<{ from?: string; to?: string } | null>(turnDegraded ?? '', null);
  if (d && d.to) {
    const fromProvider = (d.from ?? '').split(':')[0] || 'its provider';
    const toModel = d.to.split(':').slice(1).join(':') || d.to;
    return `running on ${toModel} — ${fromProvider} degraded`;
  }
  const family = (p: string) => (p.startsWith('anthropic') ? 'anthropic' : p);
  const hit = provider ? health?.providers.find((p) => family(p.provider) === family(provider) && p.state === 'degraded') : undefined;
  return hit ? `${hit.provider} degraded — the next turn runs on a fallback model` : null;
}

/** Precision and recall from the latest audit that has them, plus the no-rotation flag. */
export function auditorQuality(audits: OrgAuditRun[]): { precision: number | null; recall: number | null; noRotation: boolean; text: string } {
  const runs = audits.filter((a) => a.trigger !== 'redteam');
  const scored = runs.find((a) => (a.precision ?? null) !== null || (a.recall ?? null) !== null);
  const noRotation = runs[0]?.noRotation === 1;
  const precision = scored?.precision ?? null; const recall = scored?.recall ?? null;
  const text = scored ? `precision ${pct(precision)}, recall ${pct(recall)} from your spot checks` : 'no spot check answered yet — precision and recall appear once you answer one';
  return { precision, recall, noRotation, text };
}
/** Spot-check cards waiting for the CEO's answer, newest audit first. */
export function pendingSpotChecks(audits: OrgAuditRun[]): Array<SpotCard & { auditId: string }> {
  return audits.flatMap((a) => safeJsonParse<SpotCard[]>(a.spotChecks ?? '[]', []).filter((c) => c.agree === null).map((c) => ({ ...c, auditId: a.id })));
}
/** The latest red-team run: when, whom, held or breached. */
export function lastRedTeam(audits: OrgAuditRun[]): { at: string; agentId: string; breach: boolean; summary: string } | null {
  const r = audits.find((a) => a.trigger === 'redteam');
  if (!r) return null;
  const findings = safeJsonParse<Array<{ kind?: string }>>(r.findings, []);
  return { at: r.startedAt, agentId: r.auditorAgentId, breach: findings.some((f) => f.kind === 'redteam_breach'), summary: r.summary };
}

// ==== experiments, calibration, reconciliation (item 30, docs/experiments.md) ====

export type ExperimentGroup = 'proposed' | 'running' | 'decided';
export const experimentGroup = (status: string): ExperimentGroup => (status === 'proposed' ? 'proposed' : status === 'running' || status === 'extended' ? 'running' : 'decided');
export const EXPERIMENT_STATUS_COLOR: Record<string, string> = { proposed: 'var(--blue)', running: 'var(--accent)', extended: 'var(--accent)', kept: 'var(--green)', reverted: 'var(--amber)', abandoned: 'var(--text-faint)' };

/** The window as a progress bar: day n of N. */
export function experimentProgress(e: Pick<OrgExperiment, 'startedAt' | 'endsAt' | 'windowDays' | 'status'>, now: Date = new Date()): { pct: number; label: string } {
  if (!e.startedAt || !e.endsAt) return { pct: 0, label: `${e.windowDays}-day window, not started` };
  const t0 = Date.parse(e.startedAt); const t1 = Date.parse(e.endsAt);
  const span = Math.max(1, t1 - t0);
  const p = Math.min(1, Math.max(0, (now.getTime() - t0) / span));
  const totalDays = Math.max(1, Math.round(span / 86_400_000));
  const day = Math.min(totalDays, Math.max(1, Math.ceil((now.getTime() - t0) / 86_400_000)));
  if (experimentGroup(e.status) === 'decided') return { pct: p, label: `${totalDays}-day window` };
  return { pct: p, label: p >= 1 ? `window over — verdict due` : `day ${day} of ${totalDays}` };
}

/** The expected effect in words: "+20% (up is better)". */
export function effectLabel(e: Pick<OrgExperiment, 'expectedEffect' | 'effectKind' | 'direction'>): string {
  const v = e.effectKind === 'relative' ? `${e.expectedEffect >= 0 ? '+' : ''}${Math.round(e.expectedEffect * 100)}%` : `${e.expectedEffect >= 0 ? '+' : ''}${fmtNum(e.expectedEffect)}`;
  return `${v} (${e.direction} is better)`;
}
export function revertRuleLabel(r: { worseBy?: number; relative?: boolean } | undefined): string {
  const by = r?.worseBy ?? 0.1;
  return `reverts at once if ${r?.relative === false ? `${fmtNum(by)} worse` : `${Math.round(by * 100)}% worse`} than the baseline`;
}
/** Baseline versus the current (or final) mean with n. */
export function baselineVsCurrent(e: Pick<OrgExperiment, 'baseline' | 'result'>): string {
  const b = e.baseline ?? {}; const r = e.result ?? {};
  const left = b.mean !== undefined ? `baseline ${fmtNum(b.mean)} (n ${b.n ?? 0})` : 'baseline not taken yet';
  const right = r.mean !== undefined ? `now ${fmtNum(r.mean)} (n ${r.n ?? 0})` : '';
  return right ? `${left} → ${right}` : left;
}
export const VERDICT_LABEL: Record<string, string> = { improved: 'Improved', worse: 'Worse', inconclusive: 'Inconclusive', harm: 'Harm (revert rule)' };
/** The verdict sentence of a decided experiment, or null. */
export function verdictText(e: Pick<OrgExperiment, 'status' | 'result' | 'effectKind'>): string | null {
  const r = e.result ?? {};
  if (!r.verdict && experimentGroup(e.status) !== 'decided') return null;
  const effect = r.relative !== undefined && r.relative !== null ? `${r.relative >= 0 ? '+' : ''}${Math.round(r.relative * 100)}%` : r.delta !== undefined ? `${r.delta >= 0 ? '+' : ''}${fmtNum(r.delta)}` : '';
  const head = r.verdict ? VERDICT_LABEL[r.verdict] ?? r.verdict : e.status;
  const met = r.met === undefined ? '' : r.met ? ', expected effect met' : ', below the expected effect';
  const noise = r.threshold !== undefined ? ` (noise ±${fmtNum(r.threshold)})` : '';
  return `${head}${effect ? `: ${effect}` : ''}${noise}${met} — ${e.status}${r.note ? `. ${r.note}` : ''}`;
}
/** The change in one line (a stored change is `{ apply, revert }`; a draft is the bare change). */
export function changeSummary(kind: string, raw: Record<string, unknown>): string {
  const c = (raw && typeof raw.apply === 'object' && raw.apply ? raw.apply : raw ?? {}) as Record<string, unknown>;
  switch (kind) {
    case 'tunable': return `tune ${str(c.key)} → ${str(c.value)}`;
    case 'cadence': { const unit = str(c.unitName) || str(c.unit) || str(c.unitId); return `${str(c.kind)} cadence${unit ? ` of ${unit}` : ''} → ${c.off || !c.cron ? 'off' : str(c.cron)}`; }
    case 'routing': return `route ${str(c.class)} → ${str(c.tier)}`;
    case 'playbook': return `${str(c.action) || 'activate'} playbook ${str(c.title) || str(c.playbook) || str(c.playbookId)}`;
    case 'charter': return `${str(c.mode) || 'append'} the charter of ${str(c.agentName) || str(c.agent)}`;
    case 'structure': return `${Array.isArray(c.changes) ? c.changes.length : 0} structure step(s)`;
    default: return str(c.description) || kind;
  }
}
/** Client hints before the server's own validation (docs/experiments.md §1.2). */
export function experimentHints(f: Partial<ExperimentInput>): string[] {
  const out: string[] = [];
  if (!f.title?.trim()) out.push('a title');
  if (!f.hypothesis?.trim()) out.push('a hypothesis: what changes, what it should move, and why');
  if (f.changeKind !== 'other' && !f.metric && !f.keyResult) out.push('a measured metric — a live source, or a key result bound to one (self-reported key results are refused)');
  if (f.windowDays !== undefined && (f.windowDays < 3 || f.windowDays > 90)) out.push('a window of 3–90 days');
  if (f.expectedEffect === undefined || !Number.isFinite(f.expectedEffect)) out.push('an expected effect');
  const c = f.change ?? {};
  if (f.changeKind === 'tunable' && (!c.key || c.value === undefined || c.value === '')) out.push('the tunable key and its new value');
  if (f.changeKind === 'tunable' && str(c.key).startsWith('experiments.')) out.push('a tunable outside experiments.*');
  if (f.changeKind === 'routing' && (!c.class || !c.tier)) out.push('the class and the tier');
  if (f.changeKind === 'cadence' && (!c.kind || (!c.cron && !c.off))) out.push('the meeting kind and a cron (or off)');
  if (f.changeKind === 'playbook' && (!c.playbook || !c.action)) out.push('the playbook and activate / retire');
  if (f.changeKind === 'charter' && (!c.agent || !c.text)) out.push('the member and the charter text');
  if (f.changeKind === 'other' && !c.description) out.push('a description of the change');
  return out;
}

export const BIAS_LABEL: Record<string, string> = { over: 'over-forecasts', under: 'under-forecasts', balanced: 'balanced' };
/** A member's calibration in words and against the trust bar. */
export function calibrationLabel(r: CalibrationRow, bar = 0.7): { text: string; below: boolean | null; bias: string } {
  const bias = r.biasLabel ? BIAS_LABEL[r.biasLabel] ?? r.biasLabel : '—';
  if (r.calibration === null) return { text: `not scored yet (${r.resolved} resolved)`, below: null, bias };
  const below = r.calibration < bar;
  return { text: `${pct(r.calibration)}${below ? ` — below the ${pct(bar)} bar: discount its estimates; promotion waits` : ''}`, below, bias };
}

export const GAP_KIND: Record<string, { label: string; blurb: string }> = {
  overclaim: { label: 'Overclaim', blurb: 'high confidence while the measured value is behind pace' },
  claimed_number: { label: 'Claimed number', blurb: 'a check-in note names a number the source disagrees with' },
  claim_mismatch: { label: 'Claim mismatch', blurb: 'accepted by review, but the derived check fails' },
  report_drift: { label: 'Report drift', blurb: 'the brief\'s numbers disagree with the ledger' },
};
const GAP_ORDER = ['claim_mismatch', 'overclaim', 'claimed_number', 'report_drift'];
/** The latest gaps grouped by kind in a fixed order, each with its deep-link target. */
export function groupGaps(gaps: ReconciliationGap[]): Array<{ kind: string; label: string; blurb: string; gaps: Array<ReconciliationGap & { link: { kind: string; id: string } | null }> }> {
  const kinds = [...new Set([...GAP_ORDER.filter((k) => gaps.some((g) => g.kind === k)), ...gaps.map((g) => g.kind)])];
  return kinds.map((kind) => ({
    kind, label: GAP_KIND[kind]?.label ?? kind, blurb: GAP_KIND[kind]?.blurb ?? '',
    gaps: gaps.filter((g) => g.kind === kind).map((g) => ({ ...g, link: g.refId && (g.refType === 'task' || g.refType === 'goal' || g.refType === 'key_result') ? { kind: g.refType === 'task' ? 'task' : 'goal', id: g.refId } : null })),
  }));
}

// ==== the decision card's optional fields (item 31 lands them; rendered when present) ====

export interface DecisionExtra { key: string; label: string; value: string }
const EXTRA_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'recommendation', label: 'Recommendation' }, { key: 'alternatives', label: 'Alternatives' }, { key: 'reversibility', label: 'Reversibility' },
  { key: 'confidence', label: 'Confidence' }, { key: 'deadline', label: 'Decide by' }, { key: 'defaultAction', label: 'If you do not answer' },
];
/** The optional decision-card fields an object carries (top level or under `card`), as label/value rows. */
export function decisionExtras(o: Record<string, unknown> | null | undefined, skip: string[] = []): DecisionExtra[] {
  if (!o) return [];
  const src = { ...(typeof o.card === 'object' && o.card ? o.card as Record<string, unknown> : {}), ...o };
  const out: DecisionExtra[] = [];
  for (const f of EXTRA_FIELDS) {
    if (skip.includes(f.key)) continue;
    const v = src[f.key];
    if (v === undefined || v === null || v === '') continue;
    let value: string;
    if (f.key === 'confidence' && typeof v === 'number') value = v <= 1 ? pct(v) : `${v}%`;
    else if (Array.isArray(v)) value = v.map((x) => (typeof x === 'object' && x ? str((x as Record<string, unknown>).title ?? (x as Record<string, unknown>).option ?? JSON.stringify(x)) : String(x))).join(' · ');
    else if (typeof v === 'object') value = JSON.stringify(v);
    else value = String(v);
    if (f.key === 'deadline' && /^\d{4}-\d{2}-\d{2}T/.test(value)) value = `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
    out.push({ key: f.key, label: f.label, value });
  }
  return out;
}
