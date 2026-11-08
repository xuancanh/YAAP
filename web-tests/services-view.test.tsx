/** People › Services on screen (docs/services.md): the catalog by
 *  department with SLAs, fields and metrics; the open requests with their
 *  SLA clock and the CEO's answer to a counter-proposal; the request form,
 *  refused with what is missing before anything is sent. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgDetail, OrgServiceEntry, OrgServiceRequestRow, ServiceTemplate } from '../src/lib/api';

afterEach(cleanup);

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));

const svc: OrgServiceEntry = {
  id: 's1', name: 'bug-fix', title: 'Bug fix', description: 'Fix a defect', unitId: 'u1', unitName: 'Engineering', ownerRole: 'head', ownerAgentId: 'a1', processId: null, processName: 'service-request',
  acceptSlaHours: 8, resolveSlaHours: 72, status: 'active', version: 2, templateId: 'bug-fix', source: 'bootstrap', createdAt: '', updatedAt: '', pendingChange: false,
  fieldList: [{ name: 'summary', label: 'What is broken', type: 'text', required: true }, { name: 'severity', label: 'Severity', type: 'choice', required: true, options: ['low', 'high'] }],
  metrics: { requests: 5, open: 1, accepted: 4, declined: 1, delivered: 3, cancelled: 0, acceptHoursP50: 2, resolveHoursP50: 30, breachRate: 0.4, acceptBreachRate: 0.2, declineRate: 0.2 },
};
const soon = new Date(Date.now() + 3 * 3_600_000).toISOString();
const req: OrgServiceRequestRow = {
  id: 'r1', key: 'SR-3', serviceId: 's1', serviceVersion: 2, title: 'Signup crash', fields: { summary: 'crash' }, why: 'launch', neededBy: null, servesKind: '', servesLabel: '', requester: 'user', requesterAgentId: null,
  providerUnitId: 'u1', status: 'negotiating', runId: 'run1', acceptTaskId: 't1', acceptSlaHours: 8, resolveSlaHours: 72, acceptDueAt: soon, resolveDueAt: soon, committedDue: null,
  counter: { due: '2026-12-05T23:59:59.000Z', scope: 'Safari only' }, declineReason: '', thread: [{ at: '2026-11-08T10:00:00.000Z', by: 'user', action: 'requested' }, { at: '2026-11-08T11:00:00.000Z', by: 'agent:a1', action: 'negotiate', due: '2026-12-05', scope: 'Safari only' }],
  answeredAt: null, acceptedAt: null, resolvedAt: null, acceptBreachedAt: null, resolveBreachedAt: null, breaches: 0, createdAt: new Date().toISOString(),
  clock: { phase: null, dueAt: null, hoursLeft: null, breached: false },
};
const open: OrgServiceRequestRow = { ...req, id: 'r2', key: 'SR-4', title: 'Export list', status: 'open', counter: null, requester: 'agent:a2', requesterAgentId: 'a2', thread: [] };
const apiMock = {
  orgHumans: vi.fn(async () => ({ me: { role: 'ceo' } })),
  orgServices: vi.fn(async () => ({ services: [svc], requests: [req, open] })),
  orgServiceTemplates: vi.fn(async (): Promise<ServiceTemplate[]> => []),
  respondOrgServiceRequest: vi.fn(async () => ({ request: { ...req, status: 'accepted' }, note: 'SR-3 accepted, due 2026-12-05.' })),
  requestOrgService: vi.fn(async () => ({ request: req, note: 'SR-5 → Engineering' })),
};
vi.mock('../src/lib/api', async (orig) => ({ ...(await orig<typeof import('../src/lib/api')>()), api: apiMock }));

const { ServicesPane } = await import('../src/components/OrgServicesView');
const org = { workspaceId: 'ws1', members: [] } as unknown as OrgDetail;

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  vi.clearAllMocks();
  Object.assign(fake, {
    agents: [{ id: 'a1', name: 'Writer', colors: ['#000', '#111'], emoji: 'W' }, { id: 'a2', name: 'Marketer', colors: ['#000', '#111'], emoji: 'M' }],
    wsOrg: { units: [{ id: 'root', name: 'Acme', parentUnitId: null, children: [{ id: 'u1', name: 'Engineering', parentUnitId: 'root', children: [] }] }] },
    orgUnitId: null, setOrgUnitId: vi.fn(), showToast: vi.fn(),
  });
});

describe('the Services pane', () => {
  it('shows the catalog by department with who answers, the SLAs and the metrics; Details opens the fields and the process', async () => {
    render(<ServicesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('catalog-u1')).toHaveTextContent('Bug fix'));
    const row = screen.getByTestId('service-row');
    const sla = within(row).getByTestId('service-sla');
    expect(sla).toHaveTextContent(/Writer\s+answers/);
    expect(sla).toHaveTextContent('replies within 8 hours');
    expect(sla).toHaveTextContent('delivers within 3 days');
    expect(within(row).getByTestId('service-metrics')).toHaveTextContent('5 requests');
    expect(within(row).getByTestId('service-metrics')).toHaveTextContent('40% SLA breached');
    expect(within(row).queryByTestId('service-detail')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: /Bug fix/ }));
    const detail = within(row).getByTestId('service-detail');
    expect(detail).toHaveTextContent('What is broken');
    expect(detail).toHaveTextContent('low / high');
    expect(detail).toHaveTextContent('The standard intake: accept, do, deliver');
    expect(screen.getByTestId('service-counts')).toHaveTextContent('2open requests');
    expect(screen.getByTestId('service-counts')).toHaveTextContent('1wait on you');
  });

  it('lists the open requests with their clock; the CEO agrees to a counter-proposal on its own request', async () => {
    render(<ServicesPane org={org} />);
    await waitFor(() => expect(screen.getAllByTestId('request-row')).toHaveLength(2));
    const [mine, theirs] = screen.getAllByTestId('request-row');
    expect(within(mine).getByTestId('request-counter')).toHaveTextContent(/Engineering proposes: by Dec 5(, 2026)? · Safari only/);
    expect(within(mine).queryByTestId('sla-clock')).toBeNull();
    expect(mine).toHaveTextContent('counter-proposal');
    expect(within(theirs).getByTestId('sla-clock')).toHaveTextContent(/answer due in \d/);
    expect(within(theirs).queryByText('Agree')).toBeNull();
    fireEvent.click(within(mine).getByText('Agree'));
    await waitFor(() => expect(apiMock.respondOrgServiceRequest).toHaveBeenCalledWith('ws1', 'r1', { answer: 'agree' }));
    fireEvent.click(within(mine).getByRole('button', { name: /Signup crash/ }));
    expect(within(mine).getByTestId('request-thread')).toHaveTextContent(/proposed instead · by Dec 5(, 2026)? · scope: Safari only/);
  });

  it('the request form refuses an incomplete request before sending, then sends the service and its fields', async () => {
    render(<ServicesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('service-row')).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId('service-row')).getByText('Request'));
    const form = screen.getByRole('form', { name: 'Request a service' });
    fireEvent.click(within(form).getByText('Send the request'));
    expect(within(form).getByTestId('request-problems')).toHaveTextContent('What is broken is required.');
    expect(apiMock.requestOrgService).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByPlaceholderText('Bug fix: …'), { target: { value: 'Signup crash' } });
    fireEvent.change(within(form).getByPlaceholderText('What it unblocks, or which goal it moves'), { target: { value: 'launch' } });
    fireEvent.change(within(form).getByLabelText('What is broken'), { target: { value: 'crash on Safari' } });
    fireEvent.change(within(form).getByLabelText('Severity'), { target: { value: 'high' } });
    fireEvent.click(within(form).getByText('Send the request'));
    await waitFor(() => expect(apiMock.requestOrgService).toHaveBeenCalledWith('ws1', { service: 'bug-fix', title: 'Signup crash', why: 'launch', fields: { summary: 'crash on Safari', severity: 'high' } }));
  });

  it('puts an ask nobody routed on top and routes it to a department or a service', async () => {
    const triage: OrgServiceRequestRow = { ...open, id: 'r3', key: 'SR-9', title: 'Privacy wording', serviceId: null, providerUnitId: null, status: 'triage' };
    apiMock.orgServices.mockResolvedValueOnce({ services: [svc], requests: [open, triage] });
    render(<ServicesPane org={org} />);
    await waitFor(() => expect(screen.getAllByTestId('request-row')).toHaveLength(2));
    const first = screen.getAllByTestId('request-row')[0];
    expect(first).toHaveTextContent('Privacy wording');
    const route = within(first).getByTestId('request-route');
    fireEvent.change(within(route).getByLabelText('Route SR-9 to'), { target: { value: 'svc:bug-fix' } });
    fireEvent.click(within(route).getByText('Route'));
    await waitFor(() => expect(apiMock.respondOrgServiceRequest).toHaveBeenCalledWith('ws1', 'r3', { answer: 'route', service: 'bug-fix' }));
  });

  it('withdraws the CEO\'s own request only after a confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<ServicesPane org={org} />);
    await waitFor(() => expect(screen.getAllByTestId('request-row')).toHaveLength(2));
    const mine = screen.getAllByTestId('request-row')[0];
    fireEvent.click(within(mine).getByText('Withdraw'));
    expect(apiMock.respondOrgServiceRequest).not.toHaveBeenCalled();
    fireEvent.click(within(mine).getByText('Withdraw'));
    await waitFor(() => expect(apiMock.respondOrgServiceRequest).toHaveBeenCalledWith('ws1', 'r1', { answer: 'withdraw', reason: 'withdrawn by the CEO' }));
    confirm.mockRestore();
  });

  it('an empty catalog teaches what a service is and shows the starters to add in place', async () => {
    apiMock.orgServices.mockResolvedValueOnce({ services: [], requests: [] });
    apiMock.orgServiceTemplates.mockResolvedValueOnce([{ id: 'bug-fix', title: 'Bug fix', summary: 'Fix a defect', unitHint: [], effort: 1, fields: svc.fieldList, unitId: 'u1', unitName: 'Engineering', adopted: false }]);
    render(<ServicesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('services-empty')).toHaveTextContent('No services yet'));
    const item = await screen.findByTestId('library-item');
    expect(item).toHaveTextContent('For Engineering');
    expect(item).toHaveTextContent('What is broken');
    expect(screen.queryByText('Add from library')).toBeNull();
  });
});

describe('services helpers', () => {
  it('words SLAs and due dates, and orders open requests by what waits on the CEO', async () => {
    const { slaWords, shortDate, sortOpenRequests, needsCeo, answererWords } = await import('../src/lib/services');
    expect(slaWords(4)).toBe('4 hours');
    expect(slaWords(48)).toBe('2 days');
    expect(slaWords(36)).toBe('36 hours');
    expect(slaWords(0.5)).toBe('30 minutes');
    expect(shortDate('2026-12-05T23:59:59.000Z', new Date('2026-11-08'))).toBe('Dec 5');
    expect(shortDate('2027-01-02', new Date('2026-11-08'))).toBe('Jan 2, 2027');
    expect(needsCeo({ status: 'negotiating', requesterAgentId: null })).toBe(true);
    expect(needsCeo({ status: 'negotiating', requesterAgentId: 'a1' })).toBe(false);
    const late = { ...open, id: 'late', clock: { ...open.clock, breached: true } };
    expect(sortOpenRequests([open, late, req]).map((r) => r.id)).toEqual(['r1', 'late', 'r2']);
    expect(answererWords({ ownerRole: 'engineer', unitName: 'Engineering' })).toBe('An engineer in Engineering');
  });
});
