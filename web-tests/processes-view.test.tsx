/** Operations › Processes on screen (docs/processes.md): the list with each
 *  process's mode, owner, runs and health and the open runs; a process's
 *  page with its stages as a graph, its runs with each step's state, and
 *  its versions with the diff and a rollback for the CEO. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgDetail, OrgProcess, OrgProcessDetail, ProcessSuggestion } from '../src/lib/api';

afterEach(cleanup);

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));

const metrics = (over: Partial<OrgProcess['metrics']> = {}): OrgProcess['metrics'] => ({ runs: 4, active: 1, done: 3, failed: 0, cancelled: 0, completionRate: 1, cycleHoursP50: 5, deviationRate: 0.5, reworkRate: 0.25, slaBreaches: 0, steps: [{ nodeId: 'ci', executions: 3, deviations: 2, deviationRate: 0.67, rework: 0, failures: 0, hoursP50: 1 }], health: 'revise', why: 'step ci deviates in 67% of runs', ...over });
const proc: OrgProcess = {
  id: 'p1', name: 'release-checklist', title: 'Release checklist', description: 'Before every release.', category: 'delivery', unitId: 'u1', status: 'active', version: 3, versionId: 'v3', templateId: 'release-checklist', source: 'template',
  reviewedAt: null, createdBy: 'system', createdAt: '', updatedAt: '', mode: 'strict', ownerAgentId: 'a1', ownerName: 'Writer', unitName: 'Engineering', triggers: [{ kind: 'manual' }], metrics: metrics(), reviewDue: true, pendingVersion: null,
};
const detail: OrgProcessDetail = {
  process: proc,
  def: { title: 'Release checklist', category: 'delivery', triggers: [{ kind: 'manual' }], stages: [{ id: 'check', title: 'Check', mode: 'strict' }], nodes: [
    { id: 'scope', title: 'List the changes', kind: 'task', stage: 'check', must: ['Every change closes a task'] },
    { id: 'ci', title: 'CI green', kind: 'task', stage: 'check', must: ['On the release commit'] },
    { id: 'go', title: 'Go / no-go', kind: 'approval', stage: 'check', approver: 'manager', question: 'Ship?' },
  ], edges: [{ from: 'scope', to: 'ci' }, { from: 'ci', to: 'go' }] },
  versions: [
    { id: 'v3', version: 3, status: 'active', author: 'agent:a1', reason: 'security scan added', diff: ['step ci + MUST: Security scan is clean'], def: {} as never, basedOn: 2, approvalId: null, createdAt: new Date().toISOString(), activatedAt: null },
    { id: 'v2', version: 2, status: 'superseded', author: 'system', reason: 'instantiated', diff: ['new process'], def: {} as never, basedOn: 1, approvalId: null, createdAt: new Date().toISOString(), activatedAt: null },
  ],
  runs: [{ id: 'r1', processId: 'p1', key: 'PR-4', title: 'Release v2.3', status: 'running', stage: 'check', version: 3, ownerAgentId: 'a1', initiator: 'user', note: '', startedAt: new Date().toISOString(), endedAt: null, vars: { release: 'v2.3' }, trigger: { kind: 'manual' }, steps: [
    { id: 's1', nodeId: 'scope', attempt: 1, kind: 'task', stage: 'check', status: 'done', current: 1, outcome: 'done', taskId: 't1', approvalId: null, childRunId: null, taskKey: 'ENG-7', taskStatus: 'done', assigneeAgentId: 'a1', title: 'List the changes', outputs: {}, deviations: [], slaAt: null, slaBreachedAt: null, startedAt: '', endedAt: '' },
    { id: 's2', nodeId: 'ci', attempt: 1, kind: 'task', stage: 'check', status: 'active', current: 1, outcome: '', taskId: 't2', approvalId: null, childRunId: null, taskKey: 'ENG-8', taskStatus: 'in_progress', assigneeAgentId: 'a1', title: 'CI green', outputs: {}, deviations: [{ level: 'should', item: 's2', reason: 'r', alternative: '', status: 'logged', by: 'agent:a1', at: '' }], slaAt: null, slaBreachedAt: null, startedAt: '', endedAt: null },
  ] }],
  events: [],
};
const suggestion: ProcessSuggestion = {
  id: 'sg1', kind: 'recurring', key: 'recurring:weekly report', title: 'Draft process: Weekly report', summary: '"Weekly report" was done 4 times by hand with no process.', count: 4,
  evidence: [{ ref: 'ENG-3', title: 'Weekly report 1', at: '' }], draft: { title: 'Weekly report', category: 'delivery', triggers: [{ kind: 'manual' }], stages: [{ id: 'main', title: 'Main', mode: 'strict' }], nodes: [{ id: 'weekly-report', title: 'Weekly report', kind: 'task', lane: 'Editor' }], edges: [] },
  unitId: 'u1', ownerAgentId: 'a1', processId: null, status: 'open', taskId: 't9', createdAt: '', updatedAt: '',
};
const conformance = { runs: 4, conformantRuns: 2, fitness: 0.5, checked: 8, conformant: 5, rate: 0.625, mustOpen: 0, waivers: 1, waiversPending: 0, shouldSkips: 2, adHoc: 0, outOfOrder: 1, steps: [{ nodeId: 'deploy', checked: 4, mustOpen: 0, waivers: 1, shouldSkips: 2, adHoc: 0, outOfOrder: 1, rate: 0.25 }], verdict: 'drifting' as const, why: '62% of steps followed the definition' };
const later: OrgProcessDetail = {
  ...detail,
  process: { ...proc, conformance, rollout: { candidateVersion: 4, percent: 25, verdict: 'rollback' }, candidateVersionId: 'v4', rampPct: 25 },
  def: { ...detail.def!, nodes: [
    { id: 'deploy', title: 'Deploy', kind: 'task', stage: 'check', compensate: 'undeploy' },
    { id: 'sync', title: 'Sync on the release', kind: 'meeting', stage: 'check', meetingKind: 'planning', attendees: ['owner', 'Editor'] },
    { id: 'undeploy', title: 'Roll the deploy back', kind: 'task', stage: 'check', compensation: true, must: ['The previous build is live'] },
  ], edges: [{ from: 'deploy', to: 'sync' }] },
  runs: [{ ...detail.runs[0], status: 'cancelled', compensation: 'running' }],
  rollout: {
    verdict: 'rollback', why: 'the candidate is worse on deviation', stableFinished: 5, candidateFinished: 3, stableVersion: 3, candidateVersion: 4, candidateVersionId: 'v4', percent: 25, startedAt: null, auto: false,
    rows: [{ metric: 'completion', stable: 1, candidate: 1, worse: false }, { metric: 'cycle', stable: 4, candidate: 5, worse: false }, { metric: 'deviation', stable: 0.1, candidate: 0.6, worse: true }, { metric: 'rework', stable: 0, candidate: 0, worse: false }],
    stable: metrics(), candidate: metrics(),
  },
  suggestions: [{ ...suggestion, id: 'sg2', kind: 'revise', title: 'Revise process: Release checklist — step "CI green"', processId: 'p1', draft: null }],
};
const apiMock = {
  orgHumans: vi.fn(async () => ({ me: { role: 'ceo' } })),
  orgProcesses: vi.fn(async () => ({ processes: [proc], runs: [detail.runs[0]], suggestions: [suggestion] })),
  orgProcess: vi.fn(async (_ws: string, id: string) => (id === 'p2' ? later : detail)),
  orgProcessTemplates: vi.fn(async () => [{ id: 'release-checklist', title: 'Release checklist', summary: 'Ship a release safely.', category: 'delivery', mode: 'strict', triggers: 'by hand', steps: 3, def: detail.def }]),
  createOrgProcess: vi.fn(async () => ({ ...detail, process: { ...proc, id: 'p9' } })),
  rollbackOrgProcess: vi.fn(async () => detail),
  rolloutOrgProcess: vi.fn(async () => detail),
  decideProcessSuggestion: vi.fn(async () => ({ ...suggestion, status: 'accepted' })),
  validateOrgProcess: vi.fn(async () => ({ problems: [], name: 'x', loopMaxCeiling: 3, processNames: [] })),
};
vi.mock('../src/lib/api', async (orig) => ({ ...(await orig<typeof import('../src/lib/api')>()), api: apiMock }));

const { ProcessesPane } = await import('../src/components/OrgProcessesView');
const org = { workspaceId: 'ws1', members: [] } as unknown as OrgDetail;

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, { agents: [{ id: 'a1', name: 'Writer', colors: ['#000', '#111'], emoji: 'W' }], wsOrg: { units: [] }, routeProcess: null, setRouteProcess: vi.fn((id: string | null) => { fake.routeProcess = id; }), showToast: vi.fn(), openOrgTask: vi.fn(), go: vi.fn(), setInboxFilter: vi.fn() });
});

/** Answer an inline "why?" form and confirm it. */
function answer(reason: string, confirm: string | RegExp) {
  const form = screen.getByTestId('reason-form');
  fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: reason } });
  fireEvent.click(within(form).getByRole('button', { name: confirm }));
}

describe('the Processes pane', () => {
  it('leads with what needs attention, lists processes by department with owner, runs and health, and the open runs', async () => {
    render(<ProcessesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('process-list')).toHaveTextContent('Release checklist'));
    const row = screen.getByTestId('process-row');
    expect(row).toHaveTextContent('Strict · starts by hand · 100% of runs complete, median 5.0h');
    expect(row).toHaveTextContent('Writer');
    expect(row).toHaveTextContent('1 open · 4 runs');
    expect(row).toHaveTextContent('Needs revising');
    expect(row).toHaveTextContent('review due');
    expect(screen.getByTestId('process-counts')).toHaveTextContent('1need revising');
    expect(screen.getByTestId('process-attention')).toHaveTextContent('Release checklist: needs revising');
    expect(screen.getByTestId('process-open-runs')).toHaveTextContent('PR-4Release v2.3');
    fireEvent.click(row);
    expect(fake.setRouteProcess).toHaveBeenCalledWith('p1');
  });

  it('the library is a dialog of templates; picking one previews its graph, and adding it opens the new process', async () => {
    render(<ProcessesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('process-list')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Add from library/ }));
    const dialog = await screen.findByTestId('process-library-dialog');
    await waitFor(() => expect(within(dialog).getByTestId('process-template')).toHaveTextContent('Release checklist'));
    expect(within(dialog).getByTestId('process-template')).toHaveTextContent('added');
    fireEvent.click(within(dialog).getByTestId('process-template'));
    expect(within(dialog).getByTestId('process-template-graph')).toHaveTextContent('List the changes');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add another copy' }));
    await waitFor(() => expect(apiMock.createOrgProcess).toHaveBeenCalledWith('ws1', { template: 'release-checklist', unitId: null, reason: 'added from the library by the CEO' }));
    await waitFor(() => expect(fake.setRouteProcess).toHaveBeenCalledWith('p9'));
  });

  it('a process page: the graph in lanes with the open run laid over it, the run as a step timeline, versions with the diff and a rollback', async () => {
    fake.routeProcess = 'p1';
    render(<ProcessesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('process-page')).toBeInTheDocument());
    const graph = screen.getByTestId('process-graph');
    expect(graph).toHaveTextContent('Owner');
    expect(graph).toHaveTextContent("Owner's manager");
    const steps = screen.getAllByTestId('process-step').map((s) => s.textContent ?? '');
    expect(steps[0]).toMatch(/List the changes.*1 MUST.*Done · Writer/);
    expect(steps[1]).toMatch(/CI green.*deviated 67%.*In progress/);
    expect(steps[2]).toMatch(/Approval.*Go \/ no-go.*Asks the owner's manager/);
    expect(screen.getByTestId('process-run-banner')).toHaveTextContent('PR-4 · Release v2.3');
    expect(screen.getByTestId('process-run-banner')).toHaveTextContent('1/3 steps');
    // a step opens its detail, with what the run did there
    fireEvent.click(screen.getAllByTestId('process-step')[1]);
    expect(screen.getByTestId('process-step-detail')).toHaveTextContent('On the release commit');
    expect(screen.getByTestId('process-step-detail')).toHaveTextContent('In PR-4');
    // the definition only
    fireEvent.change(screen.getByTestId('process-overlay-select'), { target: { value: '' } });
    expect(screen.queryByTestId('process-run-banner')).toBeNull();
    expect(screen.getAllByTestId('process-step')[0].textContent).not.toMatch(/Done/);
    expect(screen.getByTestId('process-metrics')).toHaveTextContent('50%steps deviated');
    const runs = screen.getByTestId('process-runs');
    expect(runs).toHaveTextContent('Now: CI green (Writer)');
    expect(runs).toHaveTextContent('SHOULD skipped (s2): r');
    expect(runs).toHaveTextContent('Go / no-go');
    fireEvent.click(within(runs).getByText('ENG-8'));
    expect(fake.openOrgTask).toHaveBeenCalledWith('t2');
    const versions = screen.getByTestId('process-versions');
    expect(versions).toHaveTextContent('v3security scan added');
    expect(versions).toHaveTextContent('by Writer');
    fireEvent.click(within(versions).getByText(/instantiated/));
    fireEvent.click(screen.getByText('Roll back to v2'));
    answer('v3 blocks every release', 'Roll back to v2');
    await waitFor(() => expect(apiMock.rollbackOrgProcess).toHaveBeenCalledWith('ws1', 'p1', { version: 2, reason: 'v3 blocks every release' }));
  });

  it('lists the processes suggested from repeated work; the CEO creates one from its draft', async () => {
    render(<ProcessesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('process-suggestions')).toHaveTextContent('Weekly report'));
    const box = screen.getByTestId('process-suggestions');
    expect(box).toHaveTextContent('Recurring work · seen 4× · for Writer');
    fireEvent.click(within(box).getByText('Weekly report'));
    expect(box).toHaveTextContent('Drafted steps');
    expect(box).toHaveTextContent('Weekly report · Editor');
    fireEvent.click(within(box).getByText('ENG-3'));
    expect(fake.openOrgTask).toHaveBeenCalledWith('ENG-3');
    fireEvent.click(within(box).getByText('Create from the draft'));
    await waitFor(() => expect(apiMock.decideProcessSuggestion).toHaveBeenCalledWith('ws1', 'sg1', { action: 'accept', reason: 'created from the draft by the CEO' }));
  });

  it('dismissing a suggestion asks why inline', async () => {
    render(<ProcessesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('process-suggestions')).toBeInTheDocument());
    const box = screen.getByTestId('process-suggestions');
    fireEvent.click(within(box).getByText('Weekly report'));
    fireEvent.click(within(box).getByText('Dismiss'));
    answer('a one-off', 'Dismiss');
    await waitFor(() => expect(apiMock.decideProcessSuggestion).toHaveBeenCalledWith('ws1', 'sg1', { action: 'dismiss', reason: 'a one-off' }));
  });

  it('a meeting step and the undo steps in the graph, the ramp\'s comparison with promote / roll back, conformance on its own tab, a revision suggestion', async () => {
    fake.routeProcess = 'p2';
    render(<ProcessesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('process-page')).toBeInTheDocument());
    const steps = screen.getAllByTestId('process-step').map((s) => s.textContent ?? '');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatch(/Deploy.*Undoable/);
    expect(steps[1]).toMatch(/Meeting.*Sync on the release.*Holds a planning meeting with the owner, Editor/);
    expect(screen.getByTestId('process-compensation')).toHaveTextContent('DeployRoll the deploy backOwner · 1 MUST');
    expect(screen.getByTestId('process-runs')).toHaveTextContent('undoing');
    const ramp = screen.getByTestId('process-rollout');
    expect(ramp).toHaveTextContent('Trying v4 on 25% of new runs');
    expect(ramp).toHaveTextContent('Worse — roll back');
    expect(ramp).toHaveTextContent('Steps deviated10%60% · worse');
    expect(screen.getByTestId('process-attention')).toHaveTextContent('Suggested revision: step "CI green"');
    expect(screen.queryByTestId('process-conformance')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Conformance' }));
    const c = screen.getByTestId('process-conformance');
    expect(c).toHaveTextContent('62% of steps followed the definition');
    expect(c).toHaveTextContent('2/4runs fully followed');
    expect(c).toHaveTextContent('1 out of order');
    expect(c).toHaveTextContent('Deploy');
    expect(c).toHaveTextContent('25% followed');
    expect(c).toHaveTextContent('4 runs · 1 waived · 2 SHOULD skipped · 1 out of order');
    expect(screen.queryByTestId('process-metrics')).toBeNull();
    fireEvent.click(within(ramp).getByText('Roll back'));
    answer('deviations doubled', 'Roll back');
    await waitFor(() => expect(apiMock.rolloutOrgProcess).toHaveBeenCalledWith('ws1', 'p1', { action: 'rollback', reason: 'deviations doubled' }));
  });
  it('Edit swaps the graph for the visual editor in place; Cancel brings the graph back', async () => {
    fake.routeProcess = 'p1';
    render(<ProcessesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('process-graph')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('process-edit'));
    const editor = await screen.findByTestId('process-editor', {}, { timeout: 3_000 });
    expect(editor).toHaveTextContent('Edit Release checklist');
    expect(screen.queryByTestId('process-graph')).not.toBeInTheDocument();
    expect(within(editor).getAllByTestId('editor-node')).toHaveLength(3);
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('process-graph')).toBeInTheDocument();
  });

  it('a template can be customised before adding; a new process starts blank in the same editor', async () => {
    render(<ProcessesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('process-list')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Add from library/ }));
    const dialog = await screen.findByTestId('process-library-dialog');
    await waitFor(() => expect(within(dialog).getByTestId('process-template')).toBeInTheDocument());
    fireEvent.click(within(dialog).getByTestId('process-template'));
    fireEvent.click(within(dialog).getByTestId('process-customise'));
    const editor = await screen.findByTestId('process-editor', {}, { timeout: 3_000 });
    expect(editor).toHaveTextContent('Customise Release checklist');
    expect(within(editor).getAllByTestId('editor-node')).toHaveLength(3);
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByTestId('process-new'));
    expect(await screen.findByTestId('process-editor')).toHaveTextContent('New process');
  });
});
