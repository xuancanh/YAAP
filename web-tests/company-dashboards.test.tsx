/** The company section dashboards (docs/company-vision.md §8 "On screen"):
 *  each opens with one sentence on where the section stands, summarises its
 *  pages in cards that link into them, and sends what waits on the CEO to
 *  the Inbox instead of deciding it here. Also the People › Teams page and
 *  the pure summaries behind the cards. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgDetail, OrgIncident, OrgIntentNode, OrgSpend, OrgTask } from '../src/lib/api';
import { boardCounts, budgetLines, capitalByGoal, directionLede, incidentHistory, laneCounts, objectivesOf, operationsLede, pausedMembers, spendWindowLabel, yesterdayKey } from '../src/lib/company-dash';

afterEach(cleanup);

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));

const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const goal = (id: string, kind: string, extra: Partial<OrgIntentNode> = {}): OrgIntentNode => ({
  id, orgId: 'o1', title: `Goal ${id}`, description: '', status: 'active', ownerAgentId: null, unitId: null, parentGoalId: null, createdAt: '', kind, metric: '', targetValue: null, currentValue: null, startValue: null, unitLabel: '', dueAt: null,
  confidence: null, atRisk: 0, atRiskReason: '', lastCheckInAt: null, checkInCadenceDays: 7, progress: 0.4, tasks: { total: 0, done: 0 }, pace: 'onPace', expected: null, measured: null, ownerName: null, children: [], ...extra,
} as OrgIntentNode);
const intent: OrgIntentNode[] = [goal('v', 'vision', { children: [
  goal('o1', 'objective', { title: 'Launch Pro', progress: 0.62, children: [goal('k1', 'key_result', { parentGoalId: 'o1', atRisk: 1 })] }),
  goal('o2', 'objective', { title: 'Grow support', progress: 0.1 }),
] })];
const task = (id: string, status: string, updatedAt = day(1)) => ({ id, key: `ENG-${id}`, title: `Task ${id}`, status, updatedAt, createdAt: day(9), assigneeAgentId: null }) as unknown as OrgTask;

const apiMock = {
  orgVision: vi.fn(async () => ({ vision: { ...goal('v', 'vision'), title: 'Every small team runs like a big one', description: 'We build the company OS.', dueAt: '2028-01-01T00:00:00Z' }, rules: '', values: 'Candour\nCraft', culture: '' })),
  orgRoadmap: vi.fn(async () => ({ generatedAt: '', today: '', goals: [], units: [], system: [], projects: [
    { id: 'p1', key: 'PRO', title: 'Pricing page', kind: 'project', status: 'active', lane: 'now', rank: 1, health: 'at_risk', progress: { done: 3, total: 5, pct: 60 } },
    { id: 'p2', key: null, title: 'Onboarding', kind: 'project', status: 'active', lane: 'next', rank: 2, health: '', progress: { done: 0, total: 0, pct: 0 } },
  ] })),
  orgDecisions: vi.fn(async () => [{ id: 'd1', title: 'Usage-based billing', decision: 'Bill by usage', createdAt: day(1) }]),
  orgTasks: vi.fn(async () => [task('1', 'in_progress'), task('2', 'blocked'), task('3', 'todo'), task('4', 'done'), task('5', 'done', day(20))]),
  orgPulse: vi.fn(async () => ({ score: 72, breaches: [{ metric: 'cycleTimeHours', value: 40, target: 24, detail: 'Cycle time 40h against 24h' }] })),
  orgBrief: vi.fn(async () => ({ orgId: 'o1', at: day(0.2), text: '- Shipped the pricing page\n- Two hires wait on you', items: [] })),
  orgCapacity: vi.fn(async () => ({ wip: 3, byClass: {}, members: [{ agentId: 'a2', name: 'Writer', title: '', open: 3, wip: 3, atLimit: true, expectedHours: null, tasks: [] }, { agentId: 'a1', name: 'Atlas', title: '', open: 0, wip: 3, atLimit: false, expectedHours: null, tasks: [] }] })),
  orgSpend: vi.fn(async (): Promise<OrgSpend> => ({ month: '2026-11', company: { usd: 120, reservedUsd: 5, monthlyUsd: 500, runs: 40, tokensIn: 0, tokensOut: 0 }, projects: [{ id: 'p1', title: 'Pricing page', usd: 45, reservedUsd: 0, monthlyUsd: 50, runs: 3, tokensIn: 0, tokensOut: 0 }], members: [{ agentId: 'a2', name: 'Writer', title: '', usd: 10, reservedUsd: 0, monthlyUsd: 100, runs: 2, tokensIn: 0, tokensOut: 0 }, { agentId: 'a1', name: 'Atlas', title: 'Chief of staff', usd: 110, reservedUsd: 0, monthlyUsd: 0, runs: 38, tokensIn: 0, tokensOut: 0 }], acceptedTasks: 4, costPerAcceptedTask: 2.5, series: [{ day: '2026-11-01', usd: 3, tokensIn: 0, tokensOut: 0 }, { day: '2026-11-02', usd: 6, tokensIn: 0, tokensOut: 0 }] })),
  orgForecast: vi.fn(async () => ({ month: '2026-11', day: 4, daysInMonth: 30, windowDays: 7, warnPct: 80, criticalPct: 100, company: { scope: 'company', refId: 'o1', name: 'Acme', capUsd: 500, spentUsd: 125, dailyBurnUsd: 20, projectedUsd: 640, projectedPct: 128, state: 'stop' }, agents: [], projects: [{ scope: 'project', refId: 'p1', name: 'Pricing page', capUsd: 50, spentUsd: 45, dailyBurnUsd: 4, projectedUsd: 90, projectedPct: 180, state: 'stop' }], objectives: [] })),
  orgAllocations: vi.fn(async () => [{ id: 'al1', orgId: 'o1', goalId: 'o1', unitId: null, scope: 'agent', refId: 'a2', monthlyUsd: 80, rationale: '' }, { id: 'al2', orgId: 'o1', goalId: 'o1', unitId: null, scope: 'project', refId: 'p1', monthlyUsd: 40, rationale: '' }]),
  verifyOrgAudit: vi.fn(async () => ({ ok: true, length: 214, brokenAt: null })),
  orgAudit: vi.fn(async () => [{ id: 'r1', orgId: 'o1', seq: 214, actor: 'chief', action: 'auto_hire', refType: 'member', refId: 'm1', payload: '{}', prevHash: '', hash: '', createdAt: day(0.1) }]),
  orgAudits: vi.fn(async () => [{ id: 'au1', status: 'done', findings: JSON.stringify([{ title: 'x' }, { title: 'y' }]), summary: 'Two tasks closed without a check.', startedAt: day(1), endedAt: day(1) }]),
  workspaceTrust: vi.fn(async () => ({ workspaceId: 'ws1', orgMode: 'supervised', ceilings: {}, matrix: [], agents: [{ agentId: 'a2', name: 'Writer', classes: [{ effective: 0 }] }] })),
  orgIncidents: vi.fn(async (): Promise<OrgIncident[]> => [{ id: 'i9', title: 'Provider outage', status: 'resolved', openedAt: day(3), resolvedAt: day(2), containedAt: day(3) } as OrgIncident]),
};
vi.mock('../src/lib/api', async (orig) => ({ ...(await orig<typeof import('../src/lib/api')>()), api: apiMock }));

const { SectionDashboard, TeamsPane } = await import('../src/components/CompanyDashboards');

const org = { id: 'o1', workspaceId: 'ws1', name: 'Acme', chiefOfStaffAgentId: 'a1', briefHour: 8, monthlyBudgetUsd: 500,
  members: [{ id: 'm1', agentId: 'a1', title: 'Chief of staff', reportsToAgentId: null, depth: 0, status: 'active' }, { id: 'm2', agentId: 'a2', title: 'Writer', reportsToAgentId: 'a1', depth: 1, status: 'active' }] } as unknown as OrgDetail;
const units = [{ id: 'u0', name: 'Acme', slug: 'company', parentUnitId: null, leadAgentId: 'a1', channelId: 'c0', memberAgentIds: ['a1', 'a2'], counts: { openTasks: 3, tasks: 5, goals: 2 }, children: [
  { id: 'u1', name: 'Content', slug: 'content', parentUnitId: 'u0', leadAgentId: 'a2', channelId: 'c1', memberAgentIds: ['a2'], counts: { openTasks: 1, tasks: 1, goals: 1 }, children: [] },
] }];

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, {
    workspaceId: 'ws1', stacked: false,
    wsOrg: { mode: 'supervised', orgStatus: 'active', pendingApprovals: 2, units },
    orgIntent: intent, orgCadences: [{ id: 'c1', unitId: 'u0', kind: 'standup', cron: '0 9 * * *', enabled: 1, nextRunAt: new Date(Date.now() + 3_600_000).toISOString() }],
    orgHealth: { status: 'incident', lines: [], openIncidents: [{ id: 'i1', kind: 'x', severity: 'major', status: 'open', title: 'Spike in errors', agentId: null, openedAt: day(0.1) }] },
    orgPendingPlans: 1, orgHeldActions: 2,
    agents: [{ id: 'a1', name: 'Atlas', emoji: '🧭', colors: '' }, { id: 'a2', name: 'Writer', emoji: '✍️', colors: '' }, { id: 'a3', name: 'Solo', emoji: '🙂', colors: '' }],
    channels: [{ id: 'c0', slug: 'company' }, { id: 'c1', slug: 'content' }],
    setOrgPane: vi.fn(), setOrgFocus: vi.fn(), setOrgUnitId: vi.fn(), setMobileDetail: vi.fn(), go: vi.fn(), openSettings: vi.fn(), openOrgTask: vi.fn(), openChannel: vi.fn(),
  });
});

describe('the section dashboards', () => {
  it('Direction: the state sentence, vision, goals, roadmap, decisions; pending cards link to the Inbox', async () => {
    render(<SectionDashboard section="direction" org={org} />);
    expect(screen.getByTestId('dash-lede')).toHaveTextContent('2 objectives in play, 1 at risk.');
    await waitFor(() => expect(screen.getByTestId('dash-card-vision')).toHaveTextContent('Every small team runs like a big one'));
    await waitFor(() => expect(screen.getByTestId('dash-lede')).toHaveTextContent('1 project in Now.'));
    expect(screen.getByTestId('dash-card-goals')).toHaveTextContent('Launch Pro');
    expect(screen.getByTestId('dash-card-goals')).toHaveTextContent('at risk');
    await waitFor(() => expect(screen.getByTestId('dash-card-roadmap')).toHaveTextContent('Pricing page'));
    await waitFor(() => expect(screen.getByTestId('dash-card-decisions')).toHaveTextContent('Usage-based billing'));
    // the cards link into the pages
    fireEvent.click(within(screen.getByTestId('dash-card-roadmap')).getByText('Open roadmap'));
    expect(fake.setOrgPane).toHaveBeenCalledWith('roadmap');
    fireEvent.click(within(screen.getByTestId('dash-card-goals')).getByText('Launch Pro'));
    expect(fake.setOrgFocus).toHaveBeenCalledWith({ kind: 'goal', id: 'o1' });
    // decisions waiting on you are decided in the Inbox, not here
    fireEvent.click(screen.getByTestId('dash-inbox-row'));
    expect(fake.setOrgPane).toHaveBeenCalledWith('approvals');
  });

  it('Operations: board counts and blocked work, pulse, brief, rituals, incidents; pending changes link to the Inbox', async () => {
    render(<SectionDashboard section="operations" org={org} />);
    await waitFor(() => expect(screen.getByTestId('dash-card-board')).toHaveTextContent('1in progress'));
    expect(screen.getByTestId('dash-card-board')).toHaveTextContent('1done this week');
    expect(screen.getByTestId('dash-lede')).toHaveTextContent('3 open tasks, 1 blocked.');
    expect(screen.getByTestId('dash-lede')).toHaveTextContent('1 open incident.');
    expect(screen.getByTestId('incidents-health')).toHaveTextContent('1 open');
    fireEvent.click(within(screen.getByTestId('dash-card-board')).getByText('Task 2'));
    expect(fake.openOrgTask).toHaveBeenCalledWith('ENG-2');
    await waitFor(() => expect(screen.getByTestId('dash-card-pulse')).toHaveTextContent('72 / 100'));
    await waitFor(() => expect(screen.getByTestId('dash-card-brief')).toHaveTextContent('Shipped the pricing page'));
    expect(screen.getByTestId('dash-card-meetings')).toHaveTextContent('Standup');
    expect(screen.getByTestId('dash-card-incidents')).toHaveTextContent('Spike in errors');
    expect(screen.getByTestId('dash-inbox-row')).toHaveTextContent('1 pending change will apply unless you veto it.');
    fireEvent.click(screen.getByTestId('dash-inbox-row'));
    expect(fake.setOrgPane).toHaveBeenCalledWith('plans');
  });

  it('Operations: contained incidents are not open — the lede, the card\'s health word and its rows agree', async () => {
    fake.orgHealth = { status: 'degraded', lines: [], openIncidents: [
      { id: 'i1', kind: 'breaker', severity: 'major', status: 'contained', title: 'Loop on REJ-12', agentId: null, openedAt: day(0.1) },
      { id: 'i2', kind: 'breaker', severity: 'major', status: 'contained', title: 'Loop on REJ-14', agentId: null, openedAt: day(0.2) },
    ] } as never;
    render(<SectionDashboard section="operations" org={org} />);
    await waitFor(() => expect(screen.getByTestId('dash-lede')).toHaveTextContent('No open incidents; 2 contained.'));
    expect(screen.getByTestId('incidents-health')).toHaveTextContent('2 contained');
    expect(screen.getByTestId('incidents-health')).not.toHaveTextContent('incident');
    expect(screen.getByTestId('dash-card-incidents')).toHaveTextContent('Loop on REJ-12');
  });

  it('People: the org chart, teams, capacity and agents', async () => {
    render(<SectionDashboard section="people" org={org} />);
    expect(screen.getByTestId('dash-card-chart')).toHaveTextContent('Atlas');
    expect(screen.getByTestId('dash-card-teams')).toHaveTextContent('Content');
    await waitFor(() => expect(screen.getByTestId('dash-card-capacity')).toHaveTextContent('at limit'));
    // `wip` is the limit, `open` what a member holds (Governance › Capacity says "open of WIP")
    expect(screen.getByTestId('dash-card-capacity')).toHaveTextContent('WIP limit 3 each');
    expect(screen.getByTestId('dash-card-capacity')).toHaveTextContent('3 of 3 open');
    expect(screen.getByTestId('dash-card-capacity')).not.toHaveTextContent('Atlas');
    expect(screen.getByTestId('dash-lede')).toHaveTextContent('2 members in 2 teams. 1 member at their work-in-progress limit.');
    expect(screen.getByTestId('dash-card-agents')).toHaveTextContent('3 agents in this workspace, 1 outside the company');
    fireEvent.click(within(screen.getByTestId('dash-card-chart')).getByText('Open mission control'));
    expect(fake.setOrgPane).toHaveBeenCalledWith('chart');
    fireEvent.click(within(screen.getByTestId('dash-card-agents')).getByText('All agents'));
    expect(fake.go).toHaveBeenCalledWith('agents');
  });

  it('Money: this month and the forecast, budgets, capital by goal, envelopes that will stop', async () => {
    render(<SectionDashboard section="money" org={org} />);
    // spent is the settled figure (the Spend page's and Home's), in the labelled UTC month; the $5 held for runs in flight is said beside it
    await waitFor(() => expect(screen.getByTestId('dash-lede')).toHaveTextContent('$120 of $500 spent in November.'));
    expect(screen.getByTestId('dash-card-spend')).toHaveTextContent('November (UTC) to date');
    expect(screen.getByTestId('dash-card-spend')).toHaveTextContent('$5.00 held for runs in flight');
    await waitFor(() => expect(screen.getByTestId('dash-lede')).toHaveTextContent('past the envelope'));
    expect(screen.getByTestId('dash-card-budgets')).toHaveTextContent('Pricing page');
    // every member that spends is listed — the chief without an envelope too, and the card says what no envelope caps
    expect(screen.getByTestId('dash-card-budgets')).toHaveTextContent('Atlasno envelope$110');
    expect(screen.getByTestId('dash-card-budgets')).toHaveTextContent('$110 of $120 was spent by members without their own envelope');
    await waitFor(() => expect(screen.getByTestId('dash-card-capital')).toHaveTextContent('Launch Pro'));
    expect(screen.getByTestId('dash-card-capital')).toHaveTextContent('$120');
    expect(screen.getByTestId('dash-card-forecast')).toHaveTextContent('will stop');
    fireEvent.click(within(screen.getByTestId('dash-card-forecast')).getByText('Settings › Usage'));
    expect(fake.openSettings).toHaveBeenCalledWith('usage');
  });

  it('Oversight: the audit chain, the auditor, trust, incident history, replay and the governance link', async () => {
    render(<SectionDashboard section="oversight" org={org} />);
    await waitFor(() => expect(screen.getByTestId('dash-card-audit')).toHaveTextContent('chain intact · 214 entries'));
    await waitFor(() => expect(screen.getByTestId('dash-lede')).toHaveTextContent('The audit chain is intact. The last audit raised 2 findings.'));
    expect(screen.getByTestId('dash-card-audit')).toHaveTextContent('chief acting on its own');
    await waitFor(() => expect(screen.getByTestId('dash-card-trust')).toHaveTextContent('at level 0'));
    await waitFor(() => expect(screen.getByTestId('dash-card-incident-history')).toHaveTextContent('Provider outage'));
    fireEvent.click(within(screen.getByTestId('dash-card-replay')).getByText('Replay yesterday'));
    expect(fake.setOrgFocus).toHaveBeenCalledWith({ kind: 'replay', id: yesterdayKey() });
    expect(fake.setOrgPane).toHaveBeenCalledWith('replay');
    fireEvent.click(within(screen.getByTestId('dash-card-governance')).getByText('Company settings'));
    expect(fake.openSettings).toHaveBeenCalledWith('company');
  });
});

describe('People › Teams', () => {
  it('lists every unit with its lead and links to its channel, board and goals', () => {
    render(<TeamsPane org={org} />);
    const content = screen.getByTestId('team-content');
    expect(content).toHaveTextContent('led by Writer');
    fireEvent.click(within(content).getByText('#content'));
    expect(fake.openChannel).toHaveBeenCalledWith('content');
    fireEvent.click(within(content).getByText('Board'));
    expect(fake.setOrgUnitId).toHaveBeenLastCalledWith('u1');
    expect(fake.setOrgPane).toHaveBeenLastCalledWith('board');
    fireEvent.click(within(screen.getByTestId('team-company')).getByText('Goals'));
    expect(fake.setOrgUnitId).toHaveBeenLastCalledWith(null);
    expect(fake.setOrgPane).toHaveBeenLastCalledWith('goals');
  });
});

describe('the summaries', () => {
  it('counts the board, the lanes, the objectives and the incident history', () => {
    const now = new Date();
    expect(boardCounts([task('1', 'in_progress'), task('2', 'claimed'), task('3', 'blocked'), task('4', 'done'), task('5', 'done', day(10))], now)).toEqual({ open: 3, inProgress: 2, inReview: 0, blocked: 1, todo: 0, doneThisWeek: 1 });
    expect(laneCounts([{ lane: 'now', status: 'active' }, { lane: 'now', status: 'done' }, { lane: 'later', status: 'active' }] as never)).toEqual({ now: 1, next: 0, later: 1 });
    const o = objectivesOf(intent);
    expect(o.map((x) => [x.title, x.atRisk, x.krs])).toEqual([['Launch Pro', true, 1], ['Grow support', false, 0]]);
    expect(directionLede([], null)).toBe('No objectives yet.');
    const clear = { open: 0, inProgress: 0, inReview: 0, blocked: 0, todo: 0, doneThisWeek: 0 };
    expect(operationsLede(clear, { open: 0, contained: 0 }, null)).toBe('The board is clear. No open incidents.');
    expect(operationsLede(clear, { open: 0, contained: 2 }, null)).toBe('The board is clear. No open incidents; 2 contained.');
    expect(operationsLede(clear, { open: 1, contained: 2 }, null)).toBe('The board is clear. 1 open incident, 2 contained.');
    const h = incidentHistory([{ id: 'a', status: 'resolved', openedAt: day(2) }, { id: 'b', status: 'open', openedAt: day(1) }, { id: 'c', status: 'contained', openedAt: day(40) }] as OrgIncident[], now);
    expect([h.opened, h.resolved, h.open, h.recent.map((i) => i.id)]).toEqual([2, 1, 2, ['a', 'c']]);
  });

  it('paused: a paused seat, or every member while the company is paused (the org chart\'s set)', () => {
    const members = [{ status: 'active' }, { status: 'paused' }, { status: 'terminated' }];
    expect(pausedMembers(members, 'active')).toBe(1);
    expect(pausedMembers(members, 'paused')).toBe(2);
  });

  it('ranks budgets by use and sums capital per goal', async () => {
    const spend = await apiMock.orgSpend();
    const lines = budgetLines(spend);
    expect(lines.map((b) => [b.label, b.pct])).toEqual([['Atlas', null], ['Writer', 0.1], ['Pricing page', 0.9]]);
    expect(lines.filter((b) => b.key.startsWith('a:')).reduce((n, b) => n + b.usd, 0)).toBe(spend.company.usd);
    expect(spendWindowLabel('2026-11')).toBe('November');
    expect(capitalByGoal([{ goalId: 'g1', monthlyUsd: 10 }, { goalId: 'g2', monthlyUsd: 30 }, { goalId: 'g1', monthlyUsd: 5 }] as never, (id) => (id === 'g1' ? 'One' : undefined)))
      .toEqual([{ goalId: 'g2', title: 'A goal', monthlyUsd: 30 }, { goalId: 'g1', title: 'One', monthlyUsd: 15 }]);
  });
});
