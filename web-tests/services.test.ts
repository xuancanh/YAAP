/** Services on screen, the pure half (docs/services.md): the SLA countdown,
 *  status words, metric figures, the form's checks and inputs, the catalog
 *  by department, and where the page lives (People › Services). */
import { describe, expect, it } from 'vitest';
import { byDepartment, formProblems, inputKind, metricFigures, slaCountdown, threadWords } from '../src/lib/services';
import { parseRoute, navOf } from '../src/lib/routes';
import { sectionDef, sectionOfPane } from '../src/lib/company-nav';
import type { OrgServiceEntry, ServiceMetrics } from '../src/lib/api';

const now = new Date('2026-11-08T12:00:00.000Z');
const at = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
const m0: ServiceMetrics = { requests: 0, open: 0, accepted: 0, declined: 0, delivered: 0, cancelled: 0, acceptHoursP50: null, resolveHoursP50: null, breachRate: null, acceptBreachRate: null, declineRate: null };

describe('services lib', () => {
  it('counts down the clock that runs: the answer while open, the delivery once accepted, past it in red', () => {
    expect(slaCountdown({ status: 'open', acceptDueAt: at(3), resolveDueAt: at(70), committedDue: null }, now)).toEqual({ label: 'answer due in 3.0h', tone: 'info' });
    expect(slaCountdown({ status: 'open', acceptDueAt: at(0.5), resolveDueAt: null, committedDue: null }, now)?.tone).toBe('warn');
    expect(slaCountdown({ status: 'open', acceptDueAt: at(-2), resolveDueAt: null, committedDue: null }, now)).toEqual({ label: '2.0h past the accept SLA', tone: 'bad' });
    expect(slaCountdown({ status: 'accepted', acceptDueAt: at(-2), resolveDueAt: at(72), committedDue: at(96) }, now)?.label).toBe('delivery due in 4.0d');
    expect(slaCountdown({ status: 'negotiating', acceptDueAt: at(1), resolveDueAt: null, committedDue: null }, now)?.label).toBe('waiting on the requester');
    expect(slaCountdown({ status: 'delivered', acceptDueAt: null, resolveDueAt: null, committedDue: null }, now)).toBeNull();
  });

  it('metrics as figures; a high breach rate is flagged; the form checks required fields and links; inputs by type', () => {
    const f = metricFigures({ ...m0, requests: 4, open: 1, delivered: 2, declined: 1, acceptHoursP50: 2.5, resolveHoursP50: 30, breachRate: 0.5, declineRate: 0.25 });
    expect(f.map((x) => `${x.value} ${x.label}`)).toEqual(['4 requests', '2.5h to answer', '30h to deliver', '50% SLA breached', '25% declined']);
    expect(f.find((x) => x.label === 'SLA breached')?.tone).toBe('bad');
    const fields = [{ name: 'repro', label: 'Steps', type: 'text' as const, required: true }, { name: 'link', label: 'Link', type: 'url' as const, required: false }, { name: 'severity', label: 'Severity', type: 'choice' as const, required: true, options: ['low', 'high'] }];
    expect(formProblems(fields, { link: 'nope' }, { title: '', why: 'x' })).toEqual(['Say what you need in one line.', 'Steps is required.', 'Link must be a link (https://…).', 'Severity is required.']);
    expect(formProblems(fields, { repro: 'a', severity: 'low' }, { title: 't', why: 'w' })).toEqual([]);
    expect(fields.map(inputKind)).toEqual(['textarea', 'url', 'select']);
    expect(threadWords({ action: 'negotiate', due: '2026-12-05T23:59:59.000Z', scope: 'Safari only' })).toBe('proposed instead · by 2026-12-05 · scope: Safari only');
  });

  it('groups the catalog by department, the company last', () => {
    const s = (id: string, unitId: string | null, unitName: string) => ({ id, unitId, unitName } as OrgServiceEntry);
    expect(byDepartment([s('a', null, 'Company'), s('b', 'u2', 'Marketing'), s('c', 'u1', 'Engineering'), s('d', 'u1', 'Engineering')]).map((g) => `${g.unitName}:${g.services.length}`)).toEqual(['Engineering:2', 'Marketing:1', 'Company:1']);
  });

  it('lives under People: /<company>/people/services and the /services shortcut', () => {
    expect(sectionOfPane('services')).toBe('people');
    expect(sectionDef('people').pages.map((p) => p.pane)).toContain('services');
    expect(parseRoute('/c/people/services')?.place).toEqual({ kind: 'section', section: 'people', pane: 'services' });
    expect(parseRoute('/c/services')?.place).toEqual({ kind: 'section', section: 'people', pane: 'services' });
    expect(navOf({ kind: 'section', section: 'people', pane: 'services' })).toMatchObject({ section: 'people', orgPane: 'services' });
  });
});
