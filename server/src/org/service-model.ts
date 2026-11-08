/**
 * Services, the pure half (docs/services.md): the request schema a service
 * declares and the check of a request against it (each problem with its
 * fix), the words an unlisted ask is compared by for repeat counting, the
 * diff between two versions of a service and whether a change loosens its
 * promise, the SLA clock of a request and the per-service metrics. No I/O,
 * no model.
 */

export const FIELD_TYPES = ['text', 'number', 'date', 'url', 'choice', 'boolean'] as const;
export type FieldType = typeof FIELD_TYPES[number];

/** One field a requester must (or may) give. */
export interface ServiceField { name: string; label: string; type: FieldType; required: boolean; options?: string[]; description?: string }

export const SERVICE_STATUSES = ['draft', 'active', 'retired'] as const;
export type ServiceStatus = typeof SERVICE_STATUSES[number];
export const REQUEST_STATUSES = ['triage', 'open', 'negotiating', 'accepted', 'declined', 'delivered', 'cancelled', 'failed'] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];
/** Statuses still in flight (the SLA clocks run on some of them). */
export const OPEN_REQUEST: RequestStatus[] = ['triage', 'open', 'negotiating', 'accepted'];

export const SLUG_RE = /^[a-z][a-z0-9-]{1,47}$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_FIELDS = 12;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Whatever a caller gave, as fields (unknown keys dropped, types defaulted to text). */
export function normalizeFields(raw: unknown): ServiceField[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_FIELDS + 4).map((r) => {
    const o = (r && typeof r === 'object' ? r : { name: r }) as Record<string, unknown>;
    const name = str(o.name, 40).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    const type = (FIELD_TYPES as readonly string[]).includes(String(o.type)) ? o.type as FieldType : 'text';
    const f: ServiceField = { name, label: str(o.label, 80) || name.replace(/_/g, ' '), type, required: o.required !== false };
    if (type === 'choice') f.options = (Array.isArray(o.options) ? o.options : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 12);
    const d = str(o.description, 200);
    if (d) f.description = d;
    return f;
  });
}

/** Problems with a schema, each with its fix. */
export function validateFields(fields: ServiceField[]): Array<{ problem: string; fix: string }> {
  const out: Array<{ problem: string; fix: string }> = [];
  if (fields.length > MAX_FIELDS) out.push({ problem: `${fields.length} fields`, fix: `keep at most ${MAX_FIELDS}: ask for what the provider needs to start, not everything it might want` });
  const seen = new Set<string>();
  for (const f of fields) {
    if (!FIELD_RE.test(f.name)) out.push({ problem: `field "${f.name}" has no usable name`, fix: 'name each field in snake_case, e.g. "repro_steps"' });
    if (seen.has(f.name)) out.push({ problem: `field "${f.name}" appears twice`, fix: 'give each field one name' });
    seen.add(f.name);
    if (f.type === 'choice' && !(f.options ?? []).length) out.push({ problem: `choice field "${f.name}" has no options`, fix: 'list its options, e.g. ["low", "high"]' });
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A date a caller gave (yyyy-mm-dd or ISO) as ISO, or null. A bare date is the end of that day (UTC). */
export function normalizeDate(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v || !DATE_RE.test(v)) return null;
  const t = Date.parse(v.length === 10 ? `${v}T23:59:59.000Z` : v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * A request against a schema: the values to keep (as strings) and every
 * problem with what to give instead. Unknown fields are kept (they may help
 * the provider) but never satisfy a required one.
 */
export function checkRequest(fields: ServiceField[], given: Record<string, unknown>): { values: Record<string, string>; problems: string[] } {
  const values: Record<string, string> = {};
  const problems: string[] = [];
  const g = Object.fromEntries(Object.entries(given ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const f of fields) {
    const raw = g[f.name];
    const v = raw === undefined || raw === null ? '' : typeof raw === 'string' ? raw.trim() : String(raw);
    const what = `${f.name} (${f.label}${f.description ? ` — ${f.description}` : ''})`;
    if (!v) { if (f.required) problems.push(`missing ${what}: give fields.${f.name}${f.type === 'choice' ? ` as one of ${(f.options ?? []).join(' | ')}` : f.type === 'date' ? ' as yyyy-mm-dd' : ''}`); continue; }
    if (f.type === 'number' && !Number.isFinite(Number(v))) { problems.push(`${what} must be a number, got "${v.slice(0, 40)}"`); continue; }
    if (f.type === 'date' && !normalizeDate(v)) { problems.push(`${what} must be a date (yyyy-mm-dd), got "${v.slice(0, 40)}"`); continue; }
    if (f.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) { problems.push(`${what} must be a link (https://…), got "${v.slice(0, 40)}"`); continue; }
    if (f.type === 'boolean' && !/^(true|false|yes|no)$/i.test(v)) { problems.push(`${what} must be yes or no`); continue; }
    if (f.type === 'choice') {
      const hit = (f.options ?? []).find((o) => o.toLowerCase() === v.toLowerCase());
      if (!hit) { problems.push(`${what} must be one of ${(f.options ?? []).join(' | ')}, got "${v.slice(0, 40)}"`); continue; }
      values[f.name] = hit; continue;
    }
    values[f.name] = v.slice(0, 2_000);
  }
  for (const [k, v] of Object.entries(g)) if (!(k in values) && !fields.some((f) => f.name === k) && FIELD_RE.test(k) && v !== undefined && v !== null && String(v).trim()) values[k] = String(v).trim().slice(0, 2_000);
  return { values, problems };
}

/** The fields as one line for a brief: "summary: …; severity: high". */
export function fieldsLine(fields: ServiceField[], values: Record<string, string>): string {
  const order = [...fields.map((f) => f.name), ...Object.keys(values).filter((k) => !fields.some((f) => f.name === k))];
  return order.filter((k) => values[k]).map((k) => `${k}: ${values[k].replace(/\s+/g, ' ').slice(0, 300)}`).join('; ').slice(0, 1_500) || 'no fields given';
}

// ---- repeat counting of unlisted asks ----

const STOP = new Set(['a', 'an', 'the', 'for', 'of', 'to', 'and', 'or', 'in', 'on', 'with', 'from', 'by', 'at', 'our', 'my', 'we', 'please', 'need', 'needs', 'request', 'new', 'some', 'this', 'that', 'is', 'be', 'can', 'you', 'it', 'as', 'into']);

/** The significant words of an ask, sorted (the stored need key). */
export function needWords(title: string): string[] {
  const words = (title ?? '').toLowerCase().replace(/^request for [^:]+:\s*/, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ies)$/, 'y').replace(/s$/, ''));
  return [...new Set(words)].sort().slice(0, 12);
}

/** Two asks are the same kind when their significant words overlap by half (Jaccard). */
export function sameNeed(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const sa = new Set(a);
  const inter = b.filter((w) => sa.has(w)).length;
  return inter / new Set([...a, ...b]).size >= 0.5;
}

// ---- versions ----

export interface ServiceShape { title: string; description: string; fields: ServiceField[]; ownerRole: string; processId: string | null; acceptSlaHours: number; resolveSlaHours: number; unitId: string | null }

/** What changed, line by line (for the history and the approval card). */
export function diffService(prev: ServiceShape | null, next: ServiceShape): string[] {
  if (!prev) return [`new service "${next.title}": ${next.fields.length} field(s), accept ${next.acceptSlaHours}h, resolve ${next.resolveSlaHours}h`];
  const out: string[] = [];
  if (prev.title !== next.title) out.push(`title "${prev.title}" → "${next.title}"`);
  if (prev.description !== next.description) out.push('description changed');
  if (prev.acceptSlaHours !== next.acceptSlaHours) out.push(`accept SLA ${prev.acceptSlaHours}h → ${next.acceptSlaHours}h`);
  if (prev.resolveSlaHours !== next.resolveSlaHours) out.push(`resolve SLA ${prev.resolveSlaHours}h → ${next.resolveSlaHours}h`);
  if (prev.ownerRole !== next.ownerRole) out.push(`answered by ${prev.ownerRole} → ${next.ownerRole}`);
  if (prev.processId !== next.processId) out.push(`process ${prev.processId ? 'changed' : 'linked'}${next.processId ? '' : ' → the default intake'}`);
  if (prev.unitId !== next.unitId) out.push('moved to another department');
  const pf = new Map(prev.fields.map((f) => [f.name, f]));
  const nf = new Map(next.fields.map((f) => [f.name, f]));
  for (const [k, f] of nf) { const o = pf.get(k); if (!o) out.push(`+ field ${k}${f.required ? ' (required)' : ''}`); else if (o.required !== f.required || o.type !== f.type) out.push(`field ${k}: ${o.type}${o.required ? ' required' : ''} → ${f.type}${f.required ? ' required' : ''}`); }
  for (const k of pf.keys()) if (!nf.has(k)) out.push(`- field ${k}`);
  return out;
}

/** Whether a change loosens what the service promises or who answers it
 *  (a longer SLA, another role, process or department, a required field
 *  dropped) — the edits `service.editApproval` 1 sends for approval. */
export function loosens(prev: ServiceShape | null, next: ServiceShape): boolean {
  if (!prev) return false;
  if (next.acceptSlaHours > prev.acceptSlaHours || next.resolveSlaHours > prev.resolveSlaHours) return true;
  if (prev.ownerRole !== next.ownerRole || prev.processId !== next.processId || prev.unitId !== next.unitId) return true;
  const req = new Set(next.fields.filter((f) => f.required).map((f) => f.name));
  return prev.fields.some((f) => f.required && !req.has(f.name));
}

// ---- the clock and the metrics ----

export interface RequestLike {
  status: string; createdAt: string; answeredAt: string | null; acceptedAt: string | null; resolvedAt: string | null;
  acceptDueAt: string | null; resolveDueAt: string | null; acceptBreachedAt: string | null; resolveBreachedAt: string | null;
}

/** Which SLA clock runs and how long is left (negative: past it). */
export function slaClock(r: RequestLike, now: Date): { phase: 'accept' | 'resolve' | null; dueAt: string | null; hoursLeft: number | null; breached: boolean } {
  const phase = r.status === 'open' || r.status === 'triage' ? 'accept' : r.status === 'accepted' ? 'resolve' : null;
  const dueAt = phase === 'accept' ? r.acceptDueAt : phase === 'resolve' ? r.resolveDueAt : null;
  const hoursLeft = dueAt ? (Date.parse(dueAt) - now.getTime()) / 3_600_000 : null;
  return { phase, dueAt, hoursLeft, breached: hoursLeft !== null && hoursLeft < 0 };
}

export interface ServiceMetrics {
  requests: number; open: number; accepted: number; declined: number; delivered: number; cancelled: number;
  /** Median hours from the request to the provider's answer, and to delivery. */
  acceptHoursP50: number | null; resolveHoursP50: number | null;
  /** Shares (0–1) of requests that breached an SLA, the accept SLA, and of answers that declined. */
  breachRate: number | null; acceptBreachRate: number | null; declineRate: number | null;
}

const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const hoursBetween = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 3_600_000);

/** Per-service metrics over the requests given (the caller picks the window). */
export function computeServiceMetrics(rows: RequestLike[]): ServiceMetrics {
  const n = rows.length;
  const answered = rows.filter((r) => r.answeredAt);
  const declined = rows.filter((r) => r.status === 'declined').length;
  const breached = rows.filter((r) => r.acceptBreachedAt || r.resolveBreachedAt).length;
  return {
    requests: n,
    open: rows.filter((r) => OPEN_REQUEST.includes(r.status as RequestStatus)).length,
    accepted: rows.filter((r) => r.acceptedAt).length,
    declined,
    delivered: rows.filter((r) => r.status === 'delivered').length,
    cancelled: rows.filter((r) => r.status === 'cancelled' || r.status === 'failed').length,
    acceptHoursP50: median(answered.map((r) => hoursBetween(r.createdAt, r.answeredAt!))),
    resolveHoursP50: median(rows.filter((r) => r.status === 'delivered' && r.resolvedAt).map((r) => hoursBetween(r.createdAt, r.resolvedAt!))),
    breachRate: n ? breached / n : null,
    acceptBreachRate: n ? rows.filter((r) => r.acceptBreachedAt).length / n : null,
    declineRate: answered.length ? declined / answered.length : null,
  };
}

/** One line of metrics for an agent's context or a tool result. */
export function metricsLine(m: ServiceMetrics): string {
  if (!m.requests) return 'no requests yet';
  const p = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const h = (x: number | null) => (x === null ? '—' : `${x.toFixed(1)}h`);
  return `${m.requests} request(s) (${m.open} open, ${m.delivered} delivered, ${m.declined} declined); answer ${h(m.acceptHoursP50)}, delivery ${h(m.resolveHoursP50)} (medians); SLA breached ${p(m.breachRate)}, declined ${p(m.declineRate)}`;
}
