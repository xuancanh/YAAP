/** Direction (Overview, Vision, Goals, Decisions): the pure summaries behind
 *  the pages — key-result and objective health, the needs-attention list,
 *  the vision's horizon, decision one-liners, filters and day groups — and
 *  the pages themselves: the OKR view with its check-in form, status menu
 *  and add form; the vision document with its inviting empty profile and
 *  the Plan now explainer; the searchable, filterable decision log. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgDecision, OrgDetail, OrgIntentNode, ProjectSummary } from '../src/lib/api';
import { attentionItems, decisionLine, filterDecisions, groupByDay, horizonOf, krHealth, objectiveHealth, plural, reversibilityOf } from '../src/lib/direction';

afterEach(cleanup);

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));

const NOW = new Date('2026-11-04T12:00:00Z');
const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const g = (id: string, kind: string, extra: Partial<OrgIntentNode> = {}): OrgIntentNode => ({
  id, orgId: 'o1', title: `Goal ${id}`, description: '', status: 'active', ownerAgentId: 'a1', unitId: null, parentGoalId: null, createdAt: day(2), kind, metric: 'signups', targetValue: 100, currentValue: 20, startValue: 0, unitLabel: 'signups', dueAt: null,
  confidence: 0.6, atRisk: 0, atRiskReason: '', lastCheckInAt: day(1), checkInCadenceDays: 7, progress: 0.2, tasks: { total: 3, done: 1 }, pace: 'onPace', expected: 0.2, measured: 0.2, ownerName: 'Atlas', children: [], ...extra,
} as OrgIntentNode);
const proj = (id: string, over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id, key: `P-${id}`, title: `Project ${id}`, kind: 'project', status: 'active', lane: 'now', rank: 0, unitId: null, unitName: null,
  lead: { kind: 'agent', id: 'a1', name: 'Atlas' }, goalIds: [], goals: [], startDate: '2026-11-01', targetDate: '2026-12-01', milestones: [], progress: { done: 1, total: 4, pct: 25 }, hill: null, hillInferred: true,
  health: 'on_track', healthReason: '', healthAsk: '', healthAt: null, update: { state: 'fresh', dueAt: null, cadenceDays: 7 },
  appetite: { days: 30, usd: 20, spentUsd: 5, usdShare: 0.25, daysUsed: 2, daysShare: 0.07, tripped: false, breakerAt: null }, blocked: 0, late: false, overBudget: false,
  forecast: { state: 'insufficient', remaining: 3, samples: 0, p50: null, p85: null, note: '' }, briefOk: true, ...over,
});
const dec = (id: string, over: Partial<OrgDecision> = {}): OrgDecision => ({ id, orgId: 'o1', unitId: null, meetingId: null, approvalId: null, title: `Decision ${id}`, decision: '', alternatives: '', rationale: '', decidedBy: 'chief', refType: 'org', refId: '', createdAt: day(0), ...over });

describe('direction summaries', () => {
  it('says plurals properly', () => {
    expect(plural(1, 'key result')).toBe('1 key result');
    expect(plural(3, 'key result')).toBe('3 key results');
    expect(plural(2, 'child goal')).toBe('2 child goals');
  });
  it('calls a key result on track, at risk or off track from its flag and pace, and an objective by its worst key result', () => {
    expect(krHealth(g('a', 'key_result'))).toBe('on_track');
    expect(krHealth(g('a', 'key_result', { pace: 'behind', measured: 0.3, expected: 0.4 }))).toBe('at_risk');
    expect(krHealth(g('a', 'key_result', { pace: 'behind', measured: 0.1, expected: 0.5 }))).toBe('off_track');
    expect(krHealth(g('a', 'key_result', { atRisk: 1 }))).toBe('at_risk');
    expect(krHealth(g('a', 'key_result', { status: 'achieved' }))).toBe('done');
    expect(krHealth(g('a', 'key_result', { pace: 'unknown' }))).toBe('unknown');
    const o = g('o', 'objective', { children: [g('k1', 'key_result'), g('k2', 'key_result', { atRisk: 1, pace: 'behind' })] });
    expect(objectiveHealth(o)).toBe('off_track');
    expect(objectiveHealth(g('o', 'objective'))).toBe('on_track');
  });
  it('lists what needs attention, worst first, each with where it is fixed', () => {
    const intent = [g('v', 'vision', { children: [g('o1', 'objective', { ownerAgentId: null, children: [
      g('k1', 'key_result', { atRisk: 1, atRiskReason: 'Signups stalled', pace: 'behind', measured: 0.1, expected: 0.5 }),
      g('k2', 'key_result', { lastCheckInAt: day(20) }),
    ] })] })];
    const projects = [
      proj('1', { appetite: { ...proj('1').appetite, tripped: true } }),
      proj('2', { update: { state: 'missing', dueAt: null, cadenceDays: 7 }, health: 'at_risk', healthReason: 'A sponsor went quiet' }),
      proj('3', { lead: { kind: 'none', id: null, name: '' } }),
      proj('4', { status: 'done', late: true }),
    ];
    const items = attentionItems({ intent, projects, program: null, hasVision: true }, new Date());
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['kr_risk', 'checkin', 'unowned_goal', 'appetite', 'update', 'project_risk', 'unowned_project']));
    expect(items[0].tone).toBe('bad');
    expect(items.find((i) => i.kind === 'kr_risk')).toMatchObject({ title: 'Off track: Goal k1', why: 'Signups stalled', target: { pane: 'goals', focus: { kind: 'goal', id: 'k1' } } });
    expect(items.find((i) => i.kind === 'checkin')!.why).toMatch(/20 days ago; due every 7 days/);
    expect(items.find((i) => i.kind === 'appetite')!.target).toEqual({ pane: 'roadmap', focus: { kind: 'project', id: '1' } });
    expect(items.some((i) => i.id.endsWith(':4'))).toBe(false);
    expect(attentionItems({ intent: [], projects: [], hasVision: false })[0].kind).toBe('no_vision');
  });
  it('words the horizon and the decisions', () => {
    const h = horizonOf({ createdAt: '2026-10-04T00:00:00Z', dueAt: '2026-12-04T00:00:00Z' }, NOW)!;
    expect(h.daysLeft).toBe(30);
    expect(h.elapsed).toBeGreaterThan(0.45);
    expect(h.label).toMatch(/30 days left/);
    expect(horizonOf({ createdAt: '', dueAt: null })).toBeNull();
    expect(decisionLine({ title: 'escalation: task **"Ship it"**: grant a key', decision: '' })).toEqual({ kind: 'escalation', line: 'Task "Ship it": grant a key' });
    expect(decisionLine({ title: 'Keep the price at $20', decision: '' })).toEqual({ kind: null, line: 'Keep the price at $20' });
    expect(reversibilityOf({ decision: 'This is a two-way door', rationale: '', alternatives: '' })).toBe('Reversible');
    expect(reversibilityOf({ decision: '', rationale: 'irreversible once sent', alternatives: '' })).toBe('Hard to reverse');
    expect(reversibilityOf({ decision: '', rationale: '', alternatives: '' })).toBeNull();
  });
  it('filters decisions by words, source, decider, period and link, and groups them by day', () => {
    const rows = [dec('a', { approvalId: 'x', decidedBy: 'user', rationale: 'cheaper' }), dec('b', { meetingId: 'm', decidedBy: 'agent:a1', createdAt: day(40) }), dec('c', { refType: 'goal', refId: 'k1' })];
    const f = { q: '', source: 'all', decider: 'all', since: 'all' as const, link: 'all' as const };
    expect(filterDecisions(rows, { ...f, q: 'CHEAP' }).map((d) => d.id)).toEqual(['a']);
    expect(filterDecisions(rows, { ...f, source: 'meeting' }).map((d) => d.id)).toEqual(['b']);
    expect(filterDecisions(rows, { ...f, decider: 'user' }).map((d) => d.id)).toEqual(['a']);
    expect(filterDecisions(rows, { ...f, since: '30d' }).map((d) => d.id)).toEqual(['a', 'c']);
    expect(filterDecisions(rows, { ...f, link: 'goal' }).map((d) => d.id)).toEqual(['c']);
    const groups = groupByDay(rows);
    expect(groups[0].label).toBe('Today');
    expect(groups.map((x) => x.rows.length)).toEqual([2, 1]);
  });
});

// ---- the pages ----

const intentTree = [g('v', 'vision', { title: 'Every learner improves', children: [
  g('o1', 'objective', { title: 'Prove learners pay', description: 'Revenue before scale.', progress: 0.4, children: [
    g('k1', 'key_result', { title: '40 paying learners', targetValue: 40, currentValue: 12, unitLabel: 'learners', measured: 0.3, expected: 0.25 }),
    g('k2', 'key_result', { title: 'Waitlist 300', atRisk: 1, atRiskReason: 'Ads paused', pace: 'behind', measured: 0.1, expected: 0.5, lastCheckInAt: day(10) }),
  ] }),
] })];

const apiMock = {
  orgIntent: vi.fn(async () => intentTree),
  orgMetricSources: vi.fn(async () => []),
  orgProgram: vi.fn(async () => ({ pms: [], chiefActing: true, chiefName: 'Atlas', items: [], members: [], requests: [], health: { items: 0, unowned: 0, acting: 0, nonPm: 0, stretched: 0, staleCadences: 0, openRequests: 0, overdueRequests: 0 }, bounds: {} })),
  orgHumans: vi.fn(async () => ({ me: { role: 'ceo' } })),
  orgCheckIns: vi.fn(async () => [{ id: 'c1', orgId: 'o1', goalId: 'k1', actor: 'agent:a1', currentValue: 10, confidence: 0.6, note: 'Started the course', createdAt: day(3) }]),
  goalMessages: vi.fn(async () => []),
  orgCheckIn: vi.fn(async () => ({})),
  updateOrgGoal: vi.fn(async () => ({})),
  addOrgGoal: vi.fn(async () => ({})),
  orgVision: vi.fn(async () => ({ vision: { ...g('v', 'vision'), title: 'Every learner improves', description: 'Tutors in every pocket.', dueAt: '2027-06-01T00:00:00Z' }, rules: 'Never sell data.', values: '', culture: '' })),
  orgStrategy: vi.fn(async () => ({ memo: '## Bets\n- Ship the **beta**', at: day(1) })),
  orgPlanNow: vi.fn(async () => ({ result: 'ran' })),
  setOrgVision: vi.fn(async () => ({})),
  setOrgProfile: vi.fn(async () => ({})),
  orgDecisions: vi.fn(async () => [
    dec('d1', { title: 'hire: Minh as Program Manager', decision: 'Hired Minh.', rationale: 'Nobody owned the program.', alternatives: 'Keep the chief acting.', approvalId: 'ap1', decidedBy: 'user' }),
    dec('d2', { title: 'Weekly retro moves to Friday', meetingId: 'm1', decidedBy: 'agent:a1' }),
  ]),
  orgMeetings: vi.fn(async () => [{ id: 'm1', title: 'Retro', kind: 'retro', channelId: 'c1', threadRootId: null, parentChannelId: null, status: 'done' }]),
};
vi.mock('../src/lib/api', async (orig) => ({ ...(await orig<typeof import('../src/lib/api')>()), api: apiMock }));

const { GoalsPane } = await import('../src/components/OrgGoalsView');
const { VisionPane } = await import('../src/components/OrgVisionView');
const { DecisionsPane } = await import('../src/components/OrgDecisionsView');

const org = { id: 'o1', workspaceId: 'ws1', name: 'Acme', mission: '', projects: [{ id: 'p1', orgId: 'o1', goalId: 'k1', title: 'Beta', status: 'active', ownerAgentId: null, createdAt: '', key: 'P-1', lane: 'now' }], goals: [],
  members: [{ id: 'm1', agentId: 'a1', title: 'Chief of staff', reportsToAgentId: null, depth: 0, status: 'active' }] } as unknown as OrgDetail;

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  for (const f of Object.values(apiMock)) f.mockClear();
  Object.assign(fake, {
    workspaceId: 'ws1', stacked: false, orgUnitId: null, orgFocus: null, orgIntent: intentTree,
    wsOrg: { mode: 'supervised', units: [{ id: 'u0', name: 'Acme', parentUnitId: null, leadAgentId: 'a1', children: [{ id: 'u1', name: 'Growth', parentUnitId: 'u0', leadAgentId: 'a1', children: [], counts: { goals: 1 } }], counts: { goals: 2 } }] },
    agents: [{ id: 'a1', name: 'Atlas', emoji: '🧭', colors: '' }],
    setOrgPane: vi.fn(), setOrgFocus: vi.fn(), setOrgUnitId: vi.fn(), setMobileDetail: vi.fn(), showToast: vi.fn(), openChannel: vi.fn(), refreshWsOrg: vi.fn(), nameOf: (id: string) => `Person ${id}`,
  });
});

describe('Goals', () => {
  it('shows each objective with its key results as compact rows: owner, value / target, health, next check-in; no inline ids', async () => {
    render(<GoalsPane org={org} reload={async () => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('kr-row')).toHaveLength(2));
    const [k1, k2] = screen.getAllByTestId('kr-row');
    expect(k1.dataset.health).toBe('on_track');
    expect(k1.textContent).toContain('12 / 40 learners');
    expect(k1.textContent).toContain('Atlas');
    expect(k1.textContent).toMatch(/Next /);
    expect(k2.dataset.health).toBe('off_track');
    expect(k2.textContent).toContain('Check-in due');
    expect(screen.getByTestId('objective').dataset.health).toBe('off_track');
    expect(screen.getByTestId('goals-summary').textContent).toMatch(/1on track/);
    expect(document.body.textContent).not.toMatch(/#goal:/);
    expect(screen.getByLabelText(/Copy reference: #goal:o1/)).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Department' }).textContent).toContain('Growth');
  });
  it('keeps the page explanation behind the (i): click opens it, Escape and an outside click close it', async () => {
    render(<GoalsPane org={org} reload={async () => {}} />);
    await waitFor(() => screen.getByTestId('goals-page'));
    expect(screen.queryByText(/Owners check in on a rhythm/)).toBeNull();
    const info = screen.getByRole('button', { name: 'About this page' });
    fireEvent.click(info);
    expect(info.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('page-info-pop').textContent).toMatch(/Owners check in on a rhythm/);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('page-info-pop')).toBeNull();
    fireEvent.click(info);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('page-info-pop')).toBeNull();
  });
  it('expands a key result to its history and records a check-in with value, confidence and note', async () => {
    render(<GoalsPane org={org} reload={async () => {}} />);
    await waitFor(() => screen.getByText('40 paying learners'));
    fireEvent.click(screen.getByText('40 paying learners'));
    await waitFor(() => expect(screen.getByTestId('checkin-history').textContent).toContain('Started the course'));
    expect(screen.getByTestId('kr-detail').textContent).toContain('Beta');
    fireEvent.click(screen.getByText('Check in'));
    const form = screen.getByTestId('checkin-form');
    fireEvent.change(within(form).getByPlaceholderText(/Target 40/), { target: { value: '15' } });
    fireEvent.change(within(form).getByRole('slider'), { target: { value: '80' } });
    fireEvent.change(within(form).getByPlaceholderText(/What moved/), { target: { value: 'Two cohorts started' } });
    fireEvent.click(within(form).getByText('Record check-in'));
    await waitFor(() => expect(apiMock.orgCheckIn).toHaveBeenCalledWith('ws1', 'k1', { currentValue: 15, confidence: 0.8, note: 'Two cohorts started' }));
  });
  it('changes status through the row menu and adds a key result with its metric and target', async () => {
    render(<GoalsPane org={org} reload={async () => {}} />);
    await waitFor(() => screen.getByText('Waitlist 300'));
    fireEvent.click(screen.getByLabelText('Actions for Waitlist 300'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Achieved' }));
    await waitFor(() => expect(apiMock.updateOrgGoal).toHaveBeenCalledWith('ws1', 'k2', { status: 'achieved' }));
    fireEvent.click(screen.getByLabelText('Actions for Prove learners pay'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add key result' }));
    const form = screen.getByTestId('goal-form');
    expect(within(form).getByText('New key result')).toBeTruthy();
    fireEvent.change(within(form).getByPlaceholderText(/40 paying learners by March/), { target: { value: 'NPS 50' } });
    fireEvent.change(within(form).getByPlaceholderText('40'), { target: { value: '50' } });
    fireEvent.click(within(form).getByText('Add key result'));
    await waitFor(() => expect(apiMock.addOrgGoal).toHaveBeenCalledWith('ws1', expect.objectContaining({ title: 'NPS 50', kind: 'key_result', parentGoalId: 'o1', targetValue: 50, checkInCadenceDays: 7 })));
  });
});

describe('Vision', () => {
  it('reads as a document: statement, horizon, rules, the memo rendered, an inviting empty profile; Plan now says what it does first', async () => {
    render(<VisionPane org={org} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByTestId('vision-statement').textContent).toBe('Every learner improves'));
    expect(screen.getByTestId('vision-doc').textContent).toContain('Tutors in every pocket.');
    expect(screen.getByTestId('vision-doc').textContent).toContain('Never sell data.');
    expect(screen.getByTestId('profile-empty-values').textContent).toMatch(/Write the company’s values/);
    expect(document.body.textContent).not.toMatch(/not written/);
    await waitFor(() => expect(screen.getByTestId('strategy-memo').querySelector('strong')?.textContent).toBe('beta'));
    fireEvent.click(screen.getByText('Plan now'));
    expect(screen.getByTestId('plan-now').textContent).toMatch(/supervised mode the plan arrives in your Inbox/);
    expect(apiMock.orgPlanNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Run planning'));
    await waitFor(() => expect(apiMock.orgPlanNow).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Revise vision'));
    expect(screen.getByTestId('vision-form').textContent).toMatch(/the chief re-plans/);
  });
});

describe('Decisions', () => {
  it('lists decisions as one-liners with filters, and shows the whole record beside them', async () => {
    render(<DecisionsPane org={org} />);
    await waitFor(() => expect(screen.getAllByTestId('decision-row')).toHaveLength(2));
    expect(screen.getAllByTestId('decision-row')[0].textContent).toContain('Minh as Program Manager');
    const rec = screen.getByTestId('decision-record');
    expect(rec.textContent).toContain('Nobody owned the program.');
    expect(rec.textContent).toContain('Keep the chief acting.');
    expect(rec.textContent).toContain('You (CEO)');
    fireEvent.click(screen.getByRole('tab', { name: /Meeting/ }));
    expect(screen.getAllByTestId('decision-row')).toHaveLength(1);
    expect(screen.getByTestId('decision-record').textContent).toContain('Retro');
    fireEvent.click(screen.getByRole('tab', { name: /^All/ }));
    fireEvent.change(screen.getByLabelText('Search decisions'), { target: { value: 'nothing like this' } });
    expect(screen.queryAllByTestId('decision-row')).toHaveLength(0);
    expect(screen.getByText('No decision matches')).toBeTruthy();
  });
});
