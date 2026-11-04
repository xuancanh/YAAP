/**
 * Executable acceptance and metric extraction, the pure half
 * (docs/sensing.md, execution-plan item 27, capability C3 of
 * docs/autonomous-org-first-principles.md).
 *
 * A task's `done_when` may be accompanied by **checks**: small, typed,
 * model-free assertions the system evaluates itself — a metric reached a
 * value, an endpoint answers, a file exists in the workspace store, a
 * connection query counts enough items. This module holds their shapes, the
 * validator every writer goes through (`normalizeChecks`), the fixed menu of
 * connection queries shared with metric sources, and the JSONPath-like
 * selector both use to pull a number out of a JSON body. Nothing here does
 * I/O; OrgSensingService runs the checks. No code is ever evaluated: the
 * selector is a parser over dot and bracket paths with three aggregate
 * suffixes.
 */

/** The connection query menu (docs/sensing.md §1.3). Fixed on purpose: a
 *  source or a check names one of these, never a free-form API call. */
export const CONNECTION_QUERIES = ['gmail_unread', 'gmail_matching', 'calendar_events_week', 'drive_changed'] as const;
export type ConnectionQuery = typeof CONNECTION_QUERIES[number];

/** Which connection service a menu entry reads (a workspace agent must hold
 *  a grant on it). */
export function serviceOfQuery(q: ConnectionQuery): 'gmail' | 'calendar' | 'drive' {
  return q.startsWith('gmail') ? 'gmail' : q.startsWith('calendar') ? 'calendar' : 'drive';
}

export interface ConnectionQuerySpec { query: ConnectionQuery; q: string; days: number }

/** Validate a connection query (`q` is the provider's search string, `days`
 *  the look-back window where the entry has one). */
export function normalizeConnectionQuery(raw: Record<string, unknown>): ConnectionQuerySpec {
  const query = String(raw.query ?? raw.service ?? '').trim() as ConnectionQuery;
  if (!CONNECTION_QUERIES.includes(query)) throw new Error(`connection query must be one of ${CONNECTION_QUERIES.join(', ')}`);
  const q = typeof raw.q === 'string' ? raw.q : typeof raw.match === 'string' ? raw.match : typeof raw.queryString === 'string' ? raw.queryString : '';
  const days = raw.days === undefined || raw.days === null ? 7 : Number(raw.days);
  if (!Number.isFinite(days) || days < 1 || days > 90) throw new Error('days must be 1–90');
  return { query, q: q.slice(0, 300), days: Math.round(days) };
}

// ---- checks ----

export type Check =
  | { kind: 'metric_at_least'; sourceId: string; value: number }
  | { kind: 'metric_increased'; sourceId: string; by: number; sinceTaskStart: boolean }
  | { kind: 'http_status'; url: string; status: number }
  | { kind: 'http_json_match'; url: string; selector: string; equals?: string | number | boolean; contains?: string; atLeast?: number }
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_matches'; path: string; contains?: string; regex?: string; jsonSchemaKeys?: string[] }
  | { kind: 'connection_query'; service: ConnectionQuery; query: string; days: number; atLeast: number };

/** Check kinds. `github_check` is deliberately absent: YAAP has no
 *  GitHub connection to read CI from (docs/sensing.md §3). */
export const CHECK_KINDS = ['metric_at_least', 'metric_increased', 'http_status', 'http_json_match', 'file_exists', 'file_matches', 'connection_query'] as const;
export type CheckKind = typeof CHECK_KINDS[number];
export type CheckStatus = 'pass' | 'fail' | 'error' | 'pending';
export const MAX_CHECKS = 10;

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** A workspace-relative path with no traversal (the same rule as
 *  storage.keys.ts, checked at write time so a bad path never lands). */
export function cleanPath(path: string): string {
  const segments = String(path ?? '').split('/').filter((s) => s.length > 0);
  if (segments.length === 0) throw new Error('path is required');
  for (const seg of segments) if (seg === '.' || seg === '..' || !SEGMENT.test(seg)) throw new Error(`invalid path segment "${seg}" (letters, digits, . _ - only; no ..)`);
  return segments.join('/');
}

function num(v: unknown, what: string): number {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) throw new Error(`${what} must be a number`);
  return n;
}

function httpUrl(v: unknown): string {
  const s = String(v ?? '').trim();
  let u: URL;
  try { u = new URL(s); } catch { throw new Error(`"${s.slice(0, 80)}" is not a URL`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s) URLs');
  return u.toString().slice(0, 2_000);
}

/** Validate a list of checks from a tool, the API or a brief. Throws with
 *  the index and the reason; returns the normalized list. */
export function normalizeChecks(raw: unknown): Check[] {
  if (raw === undefined || raw === null || raw === '') return [];
  let list: unknown = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { throw new Error('checks must be a JSON array'); } }
  if (!Array.isArray(list)) throw new Error('checks must be an array');
  if (list.length > MAX_CHECKS) throw new Error(`at most ${MAX_CHECKS} checks per task`);
  return list.map((c, i) => {
    try { return normalizeCheck(c); } catch (err) { throw new Error(`check ${i + 1}: ${err instanceof Error ? err.message : String(err)}`, { cause: err }); }
  });
}

function normalizeCheck(c: unknown): Check {
  if (!c || typeof c !== 'object') throw new Error('a check is an object with a kind');
  const o = c as Record<string, unknown>;
  const kind = String(o.kind ?? '');
  const sourceId = () => { const s = String(o.sourceId ?? o.source ?? '').trim(); if (!s) throw new Error('sourceId is required'); return s.slice(0, 64); };
  switch (kind) {
    case 'metric_at_least': return { kind, sourceId: sourceId(), value: num(o.value, 'value') };
    case 'metric_increased': return { kind, sourceId: sourceId(), by: num(o.by, 'by'), sinceTaskStart: o.sinceTaskStart !== false };
    case 'http_status': {
      const status = o.status === undefined ? 200 : num(o.status, 'status');
      if (status < 100 || status > 599) throw new Error('status must be an HTTP status code');
      return { kind, url: httpUrl(o.url), status: Math.round(status) };
    }
    case 'http_json_match': {
      const selector = String(o.selector ?? '').trim();
      parseSelector(selector);
      const out: Check = { kind, url: httpUrl(o.url), selector };
      if (o.equals !== undefined) {
        if (!['string', 'number', 'boolean'].includes(typeof o.equals)) throw new Error('equals must be a string, number or boolean');
        out.equals = o.equals as string | number | boolean;
      }
      if (o.contains !== undefined) out.contains = String(o.contains).slice(0, 500);
      if (o.atLeast !== undefined) out.atLeast = num(o.atLeast, 'atLeast');
      if (out.equals === undefined && out.contains === undefined && out.atLeast === undefined) throw new Error('http_json_match needs equals, contains or atLeast');
      return out;
    }
    case 'file_exists': return { kind, path: cleanPath(String(o.path ?? '')) };
    case 'file_matches': {
      const out: Check = { kind, path: cleanPath(String(o.path ?? '')) };
      if (o.contains !== undefined) out.contains = String(o.contains).slice(0, 500);
      if (o.regex !== undefined) {
        const r = String(o.regex);
        if (r.length > 200) throw new Error('regex is at most 200 characters');
        try { new RegExp(r); } catch { throw new Error('regex does not compile'); }
        out.regex = r;
      }
      if (o.jsonSchemaKeys !== undefined) {
        if (!Array.isArray(o.jsonSchemaKeys) || o.jsonSchemaKeys.length === 0) throw new Error('jsonSchemaKeys must be a non-empty array of key paths');
        out.jsonSchemaKeys = o.jsonSchemaKeys.map((k) => { const s = String(k).trim(); parseSelector(s); return s; }).slice(0, 30);
      }
      if (out.contains === undefined && out.regex === undefined && out.jsonSchemaKeys === undefined) throw new Error('file_matches needs contains, regex or jsonSchemaKeys');
      return out;
    }
    case 'connection_query': {
      const spec = normalizeConnectionQuery({ query: o.service ?? o.query, q: typeof o.service === 'string' ? o.query : o.q, days: o.days });
      return { kind, service: spec.query, query: spec.q, days: spec.days, atLeast: num(o.atLeast ?? 1, 'atLeast') };
    }
    case 'github_check': throw new Error('github_check is not available: this server has no GitHub connection (docs/sensing.md §3)');
    default: throw new Error(`kind must be one of ${CHECK_KINDS.join(', ')}`);
  }
}

export function parseChecks(raw: string | null | undefined): Check[] {
  try { return normalizeChecks(JSON.parse(raw || '[]')); } catch { return []; }
}

/** One line per check for prompts, the board and comments. */
export function describeCheck(c: Check): string {
  switch (c.kind) {
    case 'metric_at_least': return `metric ${c.sourceId.slice(0, 8)} ≥ ${c.value}`;
    case 'metric_increased': return `metric ${c.sourceId.slice(0, 8)} up by ≥ ${c.by}${c.sinceTaskStart ? ' since the task started' : ''}`;
    case 'http_status': return `GET ${c.url} answers ${c.status}`;
    case 'http_json_match': return `GET ${c.url} → ${c.selector}${c.equals !== undefined ? ` = ${JSON.stringify(c.equals)}` : ''}${c.contains !== undefined ? ` contains "${c.contains}"` : ''}${c.atLeast !== undefined ? ` ≥ ${c.atLeast}` : ''}`;
    case 'file_exists': return `file ${c.path} exists`;
    case 'file_matches': return `file ${c.path}${c.contains !== undefined ? ` contains "${c.contains}"` : ''}${c.regex ? ` matches /${c.regex}/` : ''}${c.jsonSchemaKeys ? ` has keys ${c.jsonSchemaKeys.join(', ')}` : ''}`;
    case 'connection_query': return `${c.service}${c.query ? ` "${c.query}"` : ''} counts ≥ ${c.atLeast}`;
  }
}

// ---- the selector ----

type Step = { key: string } | { index: number } | { agg: 'length' | 'count' | 'sum'; field?: string[] };

/**
 * Parse a selector: `$.data.items[0].count`, `stats.subscribers`,
 * `items.length` (array length), `items.count` (same), `items.sum(amount)`
 * or `items.sum(meta.amount)` (sum a numeric field over an array),
 * `["odd key"]` for keys with dots. A leading `$` is optional. Throws on
 * anything else — nothing is evaluated.
 */
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

/** Walk a parsed JSON value by a selector; returns the value found
 *  (undefined when a step misses). */
export function selectValue(doc: unknown, selector: string): unknown {
  let cur: unknown = doc;
  for (const step of parseSelector(selector)) {
    if (cur === undefined || cur === null) return undefined;
    if ('key' in step) {
      if (typeof cur !== 'object' || Array.isArray(cur)) {
        // `.count` on an array reads as its length, like `.length`.
        if (Array.isArray(cur) && step.key === 'count') { cur = cur.length; continue; }
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[step.key];
    } else if ('index' in step) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[step.index];
    } else {
      if (step.agg === 'length' || (step.agg === 'count' && !step.field)) {
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
  }
  return cur;
}

/** The number a selector yields, or an error naming what it found. */
export function selectNumber(doc: unknown, selector: string): number {
  const v = selectValue(doc, selector);
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'boolean' ? (v ? 1 : 0) : NaN;
  if (!Number.isFinite(n)) throw new Error(`selector ${selector} found ${v === undefined ? 'nothing' : JSON.stringify(v).slice(0, 80)}, not a number`);
  return n;
}
