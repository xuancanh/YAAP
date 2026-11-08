/** Operations › Processes on screen (docs/processes.md): the list with each
 *  process's mode, owner, runs and health and the open runs; a process's
 *  page with its stages as a graph, its runs with each step's state, and
 *  its versions with the diff and a rollback for the CEO. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgDetail, OrgProcess, OrgProcessDetail } from '../src/lib/api';

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
const apiMock = {
  orgHumans: vi.fn(async () => ({ me: { role: 'ceo' } })),
  orgProcesses: vi.fn(async () => ({ processes: [proc], runs: [detail.runs[0]] })),
  orgProcess: vi.fn(async () => detail),
  orgProcessTemplates: vi.fn(async () => []),
  rollbackOrgProcess: vi.fn(async () => detail),
};
vi.mock('../src/lib/api', async (orig) => ({ ...(await orig<typeof import('../src/lib/api')>()), api: apiMock }));

const { ProcessesPane } = await import('../src/components/OrgProcessesView');
const org = { workspaceId: 'ws1', members: [] } as unknown as OrgDetail;

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, { agents: [{ id: 'a1', name: 'Writer', colors: ['#000', '#111'], emoji: 'W' }], wsOrg: { units: [] }, routeProcess: null, setRouteProcess: vi.fn((id: string | null) => { fake.routeProcess = id; }), showToast: vi.fn(), openOrgTask: vi.fn() });
});

describe('the Processes pane', () => {
  it('lists processes with mode, owner, runs and health, and the open runs', async () => {
    render(<ProcessesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('process-list')).toHaveTextContent('Release checklist'));
    const row = screen.getByTestId('process-row');
    expect(row).toHaveTextContent('Strict · delivery · Engineering · Writer · by hand · 4 runs, 100% completed, cycle 5.0h');
    expect(row).toHaveTextContent('Needs revising');
    expect(row).toHaveTextContent('review due');
    expect(screen.getByTestId('process-counts')).toHaveTextContent('1need revising');
    expect(screen.getByText(/PR-4 · Release v2\.3/)).toBeInTheDocument();
    fireEvent.click(row);
    expect(fake.setRouteProcess).toHaveBeenCalledWith('p1');
  });

  it('a process page: the graph in the engine\'s order, the runs with step states, versions with the diff and a rollback', async () => {
    fake.routeProcess = 'p1';
    render(<ProcessesPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('process-page')).toBeInTheDocument());
    const steps = screen.getAllByTestId('process-step').map((s) => s.textContent ?? '');
    expect(steps[0]).toMatch(/List the changes/);
    expect(steps[1]).toMatch(/CI green.*deviated 67%.*after List the changes/);
    expect(steps[2]).toMatch(/Go \/ no-go.*Approval.*asks the manager/);
    expect(screen.getByTestId('process-metrics')).toHaveTextContent('50%steps deviated');
    const runs = screen.getByTestId('process-runs');
    expect(runs).toHaveTextContent('ENG-8');
    expect(runs).toHaveTextContent('1 deviation');
    fireEvent.click(within(runs).getByText('ENG-8'));
    expect(fake.openOrgTask).toHaveBeenCalledWith('t2');
    const versions = screen.getByTestId('process-versions');
    expect(versions).toHaveTextContent('v3 · security scan added');
    expect(versions).toHaveTextContent('by Writer');
    fireEvent.click(within(versions).getByText(/v2 · instantiated/));
    vi.spyOn(window, 'prompt').mockReturnValue('v3 blocks every release');
    fireEvent.click(screen.getByText('Roll back to v2'));
    await waitFor(() => expect(apiMock.rollbackOrgProcess).toHaveBeenCalledWith('ws1', 'p1', { version: 2, reason: 'v3 blocks every release' }));
  });
});
