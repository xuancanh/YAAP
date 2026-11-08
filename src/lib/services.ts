/** Services on screen (docs/services.md), the pure half: request status
 *  words and tones, the SLA countdown ("answer in 3h", "2h past the accept
 *  SLA"), the metrics as figures, the request form's input for each field
 *  type and its client-side check, and the catalog grouped by department.
 *  The page is OrgServicesView.tsx. */
import type { OrgServiceEntry, OrgServiceRequestRow, ServiceField, ServiceMetrics, ServiceRequestStatus } from './api';
import type { Tone } from './direction';

export const REQUEST_WORD: Record<ServiceRequestStatus, string> = {
  triage: 'to route', open: 'awaiting answer', negotiating: 'counter-proposal', accepted: 'accepted', declined: 'declined', delivered: 'delivered', cancelled: 'withdrawn', failed: 'failed',
};
export const REQUEST_TONE: Record<ServiceRequestStatus, Tone> = {
  triage: 'warn', open: 'info', negotiating: 'warn', accepted: 'info', declined: 'muted', delivered: 'ok', cancelled: 'muted', failed: 'bad',
};
export const isOpenRequest = (r: Pick<OrgServiceRequestRow, 'status'>): boolean => ['triage', 'open', 'negotiating', 'accepted'].includes(r.status);

/** Hours as a short duration: 45m, 5.5h, 3.0d. */
export const dur = (h: number): string => { const a = Math.abs(h); return a < 1 ? `${Math.round(a * 60)}m` : a < 48 ? `${a.toFixed(a < 10 ? 1 : 0)}h` : `${(a / 24).toFixed(1)}d`; };

/** The live SLA clock of a request in words and a tone, computed from its due times and `now`. */
export function slaCountdown(r: Pick<OrgServiceRequestRow, 'status' | 'acceptDueAt' | 'resolveDueAt' | 'committedDue'>, now: Date = new Date()): { label: string; tone: Tone } | null {
  const accept = r.status === 'open' || r.status === 'triage';
  const due = accept ? r.acceptDueAt : r.status === 'accepted' ? r.committedDue ?? r.resolveDueAt : null;
  if (r.status === 'negotiating') return { label: 'waiting on the requester', tone: 'warn' };
  if (!due) return r.status === 'triage' ? { label: 'waiting for the chief to route it', tone: 'warn' } : null;
  const h = (Date.parse(due) - now.getTime()) / 3_600_000;
  const what = accept ? 'answer' : 'delivery';
  if (h < 0) return { label: `${dur(h)} past the ${accept ? 'accept SLA' : 'delivery date'}`, tone: 'bad' };
  return { label: `${what} due in ${dur(h)}`, tone: h < (accept ? 2 : 24) ? 'warn' : 'info' };
}

export const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
export const hrsOrDash = (v: number | null): string => (v === null ? '—' : dur(v));

/** The figures a catalog card shows. */
export function metricFigures(m: ServiceMetrics): Array<{ label: string; value: string; tone?: Tone; title: string }> {
  return [
    { label: 'requests', value: String(m.requests), title: `${m.open} open, ${m.delivered} delivered, ${m.declined} declined` },
    { label: 'to answer', value: hrsOrDash(m.acceptHoursP50), title: 'Median time from the request to the provider\'s answer' },
    { label: 'to deliver', value: hrsOrDash(m.resolveHoursP50), title: 'Median time from the request to delivery' },
    { label: 'SLA breached', value: pct(m.breachRate), tone: (m.breachRate ?? 0) >= 0.3 && m.requests >= 3 ? 'bad' : (m.breachRate ?? 0) > 0 ? 'warn' : undefined, title: 'Share of requests that missed the accept or the delivery SLA' },
    { label: 'declined', value: pct(m.declineRate), title: 'Share of answers that declined' },
  ];
}

/** The input a field renders as. */
export function inputKind(f: ServiceField): 'text' | 'textarea' | 'number' | 'date' | 'url' | 'select' | 'checkbox' {
  if (f.type === 'choice') return 'select';
  if (f.type === 'boolean') return 'checkbox';
  if (f.type === 'number' || f.type === 'date' || f.type === 'url') return f.type;
  return /repro|steps|description|issue|scope|evidence|why|goal|outcome/.test(f.name) ? 'textarea' : 'text';
}

/** What is missing or malformed before the form is sent (the server checks again). */
export function formProblems(fields: ServiceField[], values: Record<string, string>, base: { title: string; why: string }): string[] {
  const out: string[] = [];
  if (!base.title.trim()) out.push('Say what you need in one line.');
  if (!base.why.trim()) out.push('Say why: what it unblocks or which goal it moves.');
  for (const f of fields) {
    const v = (values[f.name] ?? '').trim();
    if (!v) { if (f.required) out.push(`${f.label} is required.`); continue; }
    if (f.type === 'number' && !Number.isFinite(Number(v))) out.push(`${f.label} must be a number.`);
    if (f.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) out.push(`${f.label} must be a link (https://…).`);
  }
  return out;
}

/** The catalog grouped by department, departments by name, the company last. */
export function byDepartment(services: OrgServiceEntry[]): Array<{ unitId: string | null; unitName: string; services: OrgServiceEntry[] }> {
  const groups = new Map<string, { unitId: string | null; unitName: string; services: OrgServiceEntry[] }>();
  for (const s of services) {
    const k = s.unitId ?? '';
    if (!groups.has(k)) groups.set(k, { unitId: s.unitId, unitName: s.unitName, services: [] });
    groups.get(k)!.services.push(s);
  }
  return [...groups.values()].sort((a, b) => (a.unitId === null ? 1 : b.unitId === null ? -1 : a.unitName.localeCompare(b.unitName)));
}

/** A thread entry in words. */
export function threadWords(e: { action: string; due?: string; reason?: string; scope?: string; note?: string }): string {
  const verb: Record<string, string> = {
    requested: 'requested', accepted: 'accepted', declined: 'declined', negotiate: 'proposed instead', countered: 'countered', agreed: 'agreed', withdrawn: 'withdrew',
    routed: 'routed', accept_breached: 'missed the accept SLA', resolve_breached: 'missed the delivery date', held_to_answer: 'held the provider to an answer',
  };
  return [verb[e.action] ?? e.action.replace(/_/g, ' '), e.due ? `by ${e.due.slice(0, 10)}` : '', e.scope ? `scope: ${e.scope}` : '', e.reason ?? '', e.note ?? ''].filter(Boolean).join(' · ');
}
