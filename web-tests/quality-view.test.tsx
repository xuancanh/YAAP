/** Oversight › Quality on screen (docs/quality.md §8): what waits on the
 *  CEO, standards in plain words with their criteria behind an expander,
 *  the template library shown in place when there is no standard, retiring
 *  behind a confirm, policies with their violations and exceptions; and the
 *  task's QC panel with the latest round open. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgDetail, OrgPolicy, OrgTask, PolicyViolation, QcResult, QualityOverview, QualityStandard } from '../src/lib/api';
import { qualityAttention, scopeWords } from '../src/lib/quality';

afterEach(cleanup);

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));

const figures = (o: Partial<QualityOverview['metrics']['overall']> = {}) => ({ tasks: 0, graded: 0, firstPassYield: null, reworkRate: null, escapes: 0, escapeRate: null, spotChecks: 0, spotCheckFails: 0, sameFamilyShare: null, ...o });
const template = { id: 'general', name: 'Done means done', deliverable: '', summary: 'The company default', criteria: [{ id: 'done-when', text: 'Every done_when item is met', weight: 3, min: 3 }] };
const standard = (o: Partial<QualityStandard> = {}): QualityStandard => ({
  id: 's1', orgId: 'o', slug: 'research', name: 'Research brief', scopeKind: 'deliverable', scopeRef: 'research', unitId: 'u1', summary: 'Findings rest on sources',
  criteria: [{ id: 'sources', text: 'Every claim cites a source', weight: 3, min: 4, evidence: ['url', 'file'] }], passScore: 4, requireEvidence: 1, verifier: 'family', version: 2, status: 'active',
  source: 'template:research', ownerAgentId: null, createdBy: 'agent:a1', approvalId: null, pending: null, createdAt: '', updatedAt: '', ...o,
});
const policy: OrgPolicy = {
  id: 'p1', orgId: 'o', key: 'no-send', statement: 'No email without a draft', rationale: 'Cannot be unsent', scopeKind: 'unit', scopeRef: 'u1', kind: 'predicate', rule: { tools: ['gmail_send'], require: [{ field: 'draftId', op: 'exists' }] },
  appliesAt: 'action', severity: 'critical', enforcement: 'block', remediation: 'Draft first', ownerAgentId: null, version: 1, status: 'active', source: '', createdBy: '', approvalId: null, pending: null, createdAt: '', updatedAt: '',
};
const violation: PolicyViolation = { id: 'v1', orgId: 'o', policyId: 'p1', policyVersion: 1, agentId: 'a1', stage: 'action', tool: 'gmail_send', actionId: null, taskId: 't9', detail: 'draftId is absent', outcome: 'blocked', status: 'exception_requested', approvalId: 'c1', createdAt: new Date().toISOString(), decidedAt: null };
const overview = (o: Partial<QualityOverview> = {}): QualityOverview => ({
  standards: [standard()], policies: [policy], templates: [template], recent: [], violations: [violation],
  metrics: { days: 30, overall: figures({ tasks: 5, firstPassYield: 0.6 }), byAgent: { a1: figures({ tasks: 5, firstPassYield: 0.6 }) }, byUnit: {}, byStandard: {}, policies: { violations: 1, byPolicy: {}, resultConformance: 1 } },
  ...o,
});
const qc = (o: Partial<QcResult> = {}): QcResult => ({
  id: 'q1', taskId: 't1', kind: 'review', standardId: 's1', standardVersion: 2, passScore: 4, makerAgentId: 'a1', unitId: null, verifier: 'agent:a2', independence: 'different_family',
  round: 0, outcome: 'rework', score: 2.5, note: 'add sources', spotTaskId: null, escapedAt: null, escapeReason: '', createdAt: '2026-11-01T00:00:00Z', decidedAt: '2026-11-01T01:00:00Z', checks: [],
  rubric: [{ id: 'sources', text: 'Every claim cites a source', weight: 3, min: 4 }], scores: [{ criterion: 'sources', score: 2, note: 'two unsourced', refs: [] }], evidence: [], ...o,
});

const apiMock = {
  orgHumans: vi.fn(async () => ({ me: { role: 'ceo' } })),
  orgQuality: vi.fn(async () => overview()),
  orgClaimsSummary: vi.fn(async () => ({ days: 30, totals: { verified: 0, unverified: 0, mismatch: 0, fabricated: 0, total: 0 }, byAgent: {}, recent: [] })),
  createQualityStandard: vi.fn(async () => ({ standard: standard(), applied: true })),
  reviseQualityStandard: vi.fn(async () => ({ standard: standard(), applied: true })),
  reviseOrgPolicy: vi.fn(async () => ({ policy, applied: true })),
  runQualitySpotCheck: vi.fn(async () => ({ sampled: 0, reverified: 0, tasks: 0, escapes: 0 })),
  orgTaskQuality: vi.fn(async () => ({ taskId: 't1', standard: standard(), results: [qc(), qc({ id: 'q2', round: 1, outcome: 'pass', score: 4.5, scores: [{ criterion: 'sources', score: 5, note: 'all cited', refs: [] }], createdAt: '2026-11-02T00:00:00Z' })] })),
};
vi.mock('../src/lib/api', async (orig) => ({ ...(await orig<typeof import('../src/lib/api')>()), api: apiMock }));

const { QualityPane, TaskQcPanel } = await import('../src/components/OrgQualityView');
const org = { workspaceId: 'ws1', members: [] } as unknown as OrgDetail;

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  vi.clearAllMocks();
  Object.assign(fake, {
    agents: [{ id: 'a1', name: 'Writer', colors: ['#000', '#111'], emoji: 'W' }, { id: 'a2', name: 'Checker', colors: ['#000', '#111'], emoji: 'C' }],
    wsOrg: { units: [{ id: 'root', name: 'Acme', parentUnitId: null, children: [{ id: 'u1', name: 'Marketing', parentUnitId: 'root', children: [] }] }] },
    showToast: vi.fn(), go: vi.fn(), setInboxFilter: vi.fn(), openOrgTask: vi.fn(),
  });
});

describe('the Quality page', () => {
  it('lists what waits on the CEO and sends an exception to the Inbox', async () => {
    render(<QualityPane org={org} />);
    const attention = await screen.findByTestId('quality-attention');
    expect(attention).toHaveTextContent('Exception asked: No email without a draft');
    fireEvent.click(within(attention).getByText(/Exception asked/));
    expect(fake.go).toHaveBeenCalledWith('inbox');
    expect(fake.setInboxFilter).toHaveBeenCalledWith('approvals');
  });

  it('says what a standard covers in plain words and shows its criteria on expand; retiring asks first', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<QualityPane org={org} />);
    const row = await screen.findByTestId('quality-standard');
    expect(row).toHaveTextContent('Research deliverables (in Marketing)');
    expect(row).toHaveTextContent('passes at 4/5');
    expect(row).toHaveTextContent('another model family verifies');
    fireEvent.click(within(row).getByRole('button', { name: /Research brief/ }));
    expect(within(row).getByTestId('standard-criteria')).toHaveTextContent('must score at least 4 · evidence: a page read, a file');
    fireEvent.click(within(row).getByText('Retire standard'));
    expect(apiMock.reviseQualityStandard).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByText('Retire standard'));
    await waitFor(() => expect(apiMock.reviseQualityStandard).toHaveBeenCalledWith('ws1', 's1', { action: 'retire' }));
    confirm.mockRestore();
  });

  it('shows a policy\'s rule, violations and the exception to decide', async () => {
    render(<QualityPane org={org} />);
    const row = await screen.findByTestId('quality-policy');
    expect(row).toHaveTextContent('blocks');
    expect(row).toHaveTextContent('Work in Marketing');
    expect(row).toHaveTextContent('1 exception asked');
    fireEvent.click(within(row).getByRole('button', { name: /No email without a draft/ }));
    const v = within(row).getByTestId('policy-violation');
    expect(v).toHaveTextContent('Writer called gmail_send: draftId is absent');
    expect(v).toHaveTextContent('exception requested');
    fireEvent.click(within(v).getByText('Task'));
    expect(fake.openOrgTask).toHaveBeenCalledWith('t9');
  });

  it('with no standard, the templates are in place with their criteria; Adopt creates one', async () => {
    apiMock.orgQuality.mockResolvedValueOnce(overview({ standards: [] }));
    render(<QualityPane org={org} />);
    const lib = await screen.findByTestId('quality-library');
    expect(screen.getByTestId('standards-empty')).toHaveTextContent('No standards yet');
    expect(within(lib).getByTestId('quality-template')).toHaveTextContent('Every done_when item is met (at least 3/5)');
    expect(screen.queryByText('Add a standard')).toBeNull();
    fireEvent.click(within(lib).getByText('Adopt'));
    await waitFor(() => expect(apiMock.createQualityStandard).toHaveBeenCalledWith('ws1', { template: 'general' }));
  });
});

describe('the task QC panel', () => {
  it('opens the latest round and keeps earlier ones a click away', async () => {
    render(<TaskQcPanel wsId="ws1" task={{ id: 't1', status: 'done', reviewRounds: 2 } as unknown as OrgTask} />);
    const rounds = await screen.findAllByTestId('qc-round');
    expect(rounds).toHaveLength(2);
    expect(screen.getByTestId('task-qc')).toHaveTextContent('Research brief · passes at 4/5');
    expect(rounds[1]).toHaveTextContent('all cited');
    expect(rounds[0]).not.toHaveTextContent('two unsourced');
    fireEvent.click(within(rounds[0]).getByRole('button', { name: /round 1/ }));
    expect(rounds[0]).toHaveTextContent('two unsourced');
  });
});

describe('quality helpers for the page', () => {
  it('words scopes and gathers what waits on the CEO', () => {
    expect(scopeWords({ scopeKind: 'company', scopeRef: '' })).toBe('All work');
    expect(scopeWords({ scopeKind: 'unit', scopeRef: 'u1' }, () => 'Product')).toBe('Work in Product');
    expect(scopeWords({ scopeKind: 'deliverable', scopeRef: 'landing-copy', unitId: 'u1' }, () => 'Marketing')).toBe('Landing copy deliverables (in Marketing)');
    const items = qualityAttention(overview({ standards: [standard({ status: 'proposed' })] }));
    expect(items.map((i) => i.kind)).toEqual(['standard', 'exception']);
  });
});
