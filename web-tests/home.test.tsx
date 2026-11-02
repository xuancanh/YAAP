import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// No `globals: true` in vitest.config.ts, so RTL does not auto-clean between tests.
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
import { api, type HomeAgent, type HomeData, type HomeNeed } from '../src/lib/api';
import { HomeBoard, HomeStatus } from '../src/components/HomeBoard';
import { decide } from '../src/components/HomeView';
import { defaultSentence, headline, needTarget, recommendationLine, sinceLabel, targetOf } from '../src/lib/home';

const NOW = new Date('2026-11-02T08:00:00');
const iso = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();

const need = (over: Partial<HomeNeed> = {}): HomeNeed => ({
  id: 'approval:a1', kind: 'approval', subkind: 'hire', title: 'Ana as Researcher', detail: 'Research has no owner.', severity: 'normal', createdAt: iso(-120),
  deadline: iso(180), defaultAction: 'deny', recommendation: 'We need research capacity.', recommendedAction: 'approve', reversibility: 'reversible',
  confidence: 0.7, requestedBy: 'Chief', ref: { approvalId: 'a1' }, actions: ['approve', 'reject'], ...over,
});
const agent = (over: Partial<HomeAgent> = {}): HomeAgent => ({
  id: 'w', name: 'Writer', emoji: '✍️', colors: '["#111","#222"]', title: 'Writer', state: 'working', doing: 'Draft the launch post', taskId: 't1',
  lastActiveAt: iso(-5), lastBeatAt: iso(-10), isChief: false, errors: [], ...over,
});

function fixture(over: Partial<HomeData> = {}): HomeData {
  return {
    workspaceId: 'ws1', generatedAt: NOW.toISOString(), since: new Date('2026-11-01T21:30:00').toISOString(), firstVisit: false,
    company: { orgId: 'o1', name: 'Acme', mode: 'autonomous', status: 'active', chiefAgentId: 'c', chiefName: 'Chief', memberCount: 3 },
    headline: { tasksDone: 12, needsYou: 3, todayUsd: 4.2, monthUsd: 12.4, monthCapUsd: 20 },
    needs: [
      need({ id: 'approval:esc', kind: 'escalation', subkind: 'escalation', title: 'Pricing page: two leads disagree', severity: 'high', defaultAction: '', deadline: null, recommendation: '', recommendedAction: '', reversibility: '', confidence: null, ref: { approvalId: 'esc' } }),
      need(),
      need({ id: 'plan:p1', kind: 'plan', subkind: 'daily', title: 'Hire a researcher and open two tasks', defaultAction: 'apply', deadline: iso(20), recommendation: '', recommendedAction: '', reversibility: '', confidence: null, ref: { planId: 'p1' }, actions: ['veto', 'apply_now'] }),
    ],
    recap: {
      tasksDone: 12, tasksBlocked: 1, decisionsCount: 2, artifactsChanged: 4,
      decisions: [{ at: iso(-300), kind: 'auto', title: 'hire: Marketer as Growth', detail: 'Launch posts have no owner.', ref: { type: 'org', id: 'o1' } }],
      people: [{ at: iso(-300), kind: 'hire', title: 'Marketer joined as Growth', detail: '', ref: { type: 'agent', id: 'm' } }],
      brief: { at: iso(-60), text: '## Outcomes\n- Subscribers **+40** this week' }, pulse: { score: 82, breaches: 0 },
    },
    goals: [
      { id: 'o2', title: 'Grow subscribers', ownerName: 'Chief', progress: 0.1, confidence: 0.3, atRisk: true, atRiskReason: 'behind pace', rag: 'red', dueAt: null,
        keyResults: [{ id: 'k2', title: '1,000 subscribers', currentValue: 100, targetValue: 1000, unitLabel: 'subs', progress: 0.1, confidence: 0.3, atRisk: true, atRiskReason: 'behind pace', rag: 'red', dueAt: null }] },
      { id: 'o1', title: 'Ship the newsletter', ownerName: 'Writer', progress: 0.8, confidence: 0.9, atRisk: false, atRiskReason: '', rag: 'green', dueAt: null, keyResults: [] },
    ],
    team: [agent({ id: 'c', name: 'Chief', isChief: true, state: 'idle', doing: '' }), agent()],
    activity: [
      { id: 'a1', at: iso(-30), kind: 'task', title: 'Done: Draft the plan', detail: '', actor: 'Writer', ref: { type: 'task', id: 't9' } },
      { id: 'a2', at: iso(-40), kind: 'file', title: 'Created reports/weekly.md', detail: 'version 1', actor: 'Writer', ref: { type: 'file', id: 'reports/weekly.md' } },
      { id: 'a3', at: iso(-50), kind: 'decision', title: 'Approved hire', detail: '', actor: 'You', ref: null },
    ],
    spend: { todayUsd: 4.2, monthUsd: 12.4, monthCapUsd: 20, projectedUsd: 24, forecastState: 'warn', tokens: null },
    health: { status: 'ok', openIncidents: [], providers: [], audit: { id: 'au', at: iso(-600), status: 'done', findings: 2, top: [{ severity: 'warn', title: 'A task accepted without a check' }], summary: '' } },
    upcoming: [{ id: 'm1', at: iso(60), kind: 'ritual', title: 'Standup', detail: '0 9 * * *', ref: null }],
    artifacts: [{ path: 'reports/weekly.md', version: 2, size: 10, updatedAt: iso(-40), updatedBy: { kind: 'agent', id: 'w', name: 'Writer' } }],
    partial: [],
    ...over,
  };
}

const board = (data: HomeData, extra: Partial<Parameters<typeof HomeBoard>[0]> = {}) => {
  const onAct = vi.fn(); const onOpen = vi.fn(); const onAllAgents = vi.fn();
  render(<HomeBoard data={data} narrow={false} wide now={NOW} name="Linh" onAct={onAct} onOpen={onOpen} onAllAgents={onAllAgents} {...extra} />);
  return { onAct, onOpen, onAllAgents };
};

describe('Home copy', () => {
  it('says the state of the company in three sentences', () => {
    expect(headline(fixture(), NOW)).toEqual(['Overnight your team closed 12 tasks.', '3 things need you.', '$4.20 spent today, $12.40 of $20.00 this month.']);
    const plain = fixture({ company: null, headline: { tasksDone: 1, needsYou: 0, todayUsd: 0.5, monthUsd: 3, monthCapUsd: null }, firstVisit: true });
    expect(headline(plain, NOW)).toEqual(['In the last day your agents closed 1 task.', 'Nothing needs you.', '$0.50 spent today.']);
  });
  it('labels the window since the last visit', () => {
    expect(sinceLabel(new Date('2026-11-02T07:30:00').toISOString(), NOW)).toBe('In the last hour');
    expect(sinceLabel(new Date('2026-11-01T22:00:00').toISOString(), NOW)).toBe('Overnight');
    expect(sinceLabel(new Date('2026-11-01T06:00:00').toISOString(), NOW)).toBe('Since yesterday');
  });
  it('words a card\'s default and the proposer\'s case', () => {
    expect(defaultSentence(need(), NOW)).toBe("If you don't answer, it will be denied in 3 h.");
    expect(defaultSentence(need({ defaultAction: 'apply', deadline: iso(20) }), NOW)).toBe('Applies on its own in 20 min unless you veto it.');
    expect(defaultSentence(need({ defaultAction: '' }), NOW)).toBe('');
    expect(recommendationLine(need())).toBe('Chief recommends approve. 70% sure. Reversible.');
  });
  it('maps references to where they open', () => {
    expect(targetOf({ type: 'task', id: 't' })).toEqual({ to: 'task', taskId: 't' });
    expect(targetOf({ type: 'goal', id: 'g' })).toEqual({ to: 'pane', pane: 'vision', focus: { kind: 'goal', id: 'g' } });
    expect(targetOf({ type: 'file', id: 'a/b.md' })).toEqual({ to: 'file', path: 'a/b.md' });
    expect(targetOf({ type: 'org', id: 'o' })).toBeNull();
    expect(needTarget(need())).toEqual({ to: 'inbox' });
    expect(needTarget(need({ kind: 'incident', ref: { incidentId: 'i1' }, actions: [] }))).toEqual({ to: 'pane', pane: 'incidents', focus: { kind: 'incident', id: 'i1' } });
  });
});

describe('HomeBoard — a company', () => {
  it('opens with the greeting, the headline, the mode and the run state', () => {
    const { onOpen } = board(fixture());
    expect(screen.getByText('Good morning, Linh.')).toBeInTheDocument();
    expect(screen.getByTestId('home-headline')).toHaveTextContent('Overnight your team closed 12 tasks. 3 things need you.');
    expect(screen.getByTestId('home-mode')).toHaveTextContent('Autonomous');
    fireEvent.click(screen.getByTestId('home-run-state'));
    expect(onOpen).toHaveBeenCalledWith({ to: 'pane', pane: 'board' });
  });

  it('shows a paused company loudly', () => {
    board(fixture({ company: { ...fixture().company!, status: 'paused' } }));
    expect(screen.getByTestId('home-run-state')).toHaveTextContent('Paused: nothing runs until you resume');
  });

  it('lists what needs the owner with defaults, deadlines and inline decisions', () => {
    const { onAct, onOpen } = board(fixture());
    const cards = screen.getAllByTestId('need-card');
    expect(cards.map((c) => c.getAttribute('data-kind'))).toEqual(['escalation', 'approval', 'plan']);
    const hire = cards[1];
    expect(hire).toHaveTextContent('Ana as Researcher');
    expect(hire).toHaveTextContent('Chief recommends approve. 70% sure. Reversible.');
    expect(within(hire).getByTestId('need-default')).toHaveTextContent("If you don't answer, it will be denied in 3 h.");
    fireEvent.click(within(hire).getByRole('button', { name: 'Approve' }));
    expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'approval:a1' }), 'approve');
    fireEvent.click(within(cards[2]).getByRole('button', { name: 'Veto' }));
    expect(onAct).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'plan:p1' }), 'veto');
    expect(within(cards[2]).getByTestId('need-default')).toHaveTextContent('Applies on its own in 20 min unless you veto it.');
    fireEvent.click(screen.getByRole('button', { name: 'See all in Inbox' }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'inbox' });
  });

  it('disables a card while its decision is in flight', () => {
    board(fixture(), { busy: new Set(['approval:a1']) });
    const hire = screen.getAllByTestId('need-card')[1];
    expect(within(hire).getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('summarises since the last visit with the brief, and goals at risk first', () => {
    board(fixture());
    const recap = screen.getByTestId('home-recap');
    expect(recap).toHaveTextContent('decided without you');
    expect(recap).toHaveTextContent('hire: Marketer as Growth');
    expect(recap).toHaveTextContent('Marketer joined as Growth');
    expect(within(screen.getByTestId('home-brief')).getByText('+40')).toBeInTheDocument();
    const goals = screen.getAllByTestId('home-goal');
    expect(goals.map((g) => g.getAttribute('data-rag'))).toEqual(['red', 'green']);
    expect(goals[0]).toHaveTextContent('At risk');
    expect(goals[0]).toHaveTextContent('100 / 1000 subs');
  });

  it('filters the activity feed', () => {
    board(fixture());
    const list = () => screen.getByTestId('activity-list');
    expect(within(list()).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1);
    expect(list()).toHaveTextContent('Created reports/weekly.md');
  });

  it('shows spend against the envelope with the forecast, and the last audit', () => {
    board(fixture());
    const s = screen.getByTestId('home-spend');
    expect(s).toHaveTextContent('$12.40');
    expect(s).toHaveTextContent('of $20.00 this month');
    expect(s).toHaveTextContent('On pace for $24.00 by month end, over the envelope.');
    expect(s).toHaveTextContent('2 findings');
  });

  it('surfaces agent errors loudly and links to the full directory', () => {
    const failing = agent({ id: 'x', name: 'Analyst', state: 'error', errors: [{ kind: 'turn', message: 'model "gpt-9-ultra" not found (404)', at: iso(-3) }] });
    const { onAllAgents, onOpen } = board(fixture({ team: [failing, agent()] }));
    expect(screen.getByRole('alert')).toHaveTextContent('One agent is failing.');
    const tile = screen.getAllByTestId('team-agent').find((t) => t.getAttribute('data-state') === 'error')!;
    expect(within(tile).getByTestId('agent-error')).toHaveTextContent('model "gpt-9-ultra" not found (404)');
    expect(tile).toHaveTextContent('Failing');
    fireEvent.click(tile);
    expect(onOpen).toHaveBeenCalledWith({ to: 'agent', agentId: 'x' });
    fireEvent.click(screen.getByRole('button', { name: 'All agents' }));
    expect(onAllAgents).toHaveBeenCalled();
  });

  it('says which sections did not load', () => {
    board(fixture({ partial: ['goals'] }));
    expect(screen.getByText("Some parts didn't load: goals.")).toBeInTheDocument();
  });
});

describe('HomeBoard — no company', () => {
  it('guides an empty workspace to start a company', () => {
    const onStartCompany = vi.fn(); const onNewAgent = vi.fn();
    board(fixture({ company: null, team: [], needs: [], goals: [], activity: [], artifacts: [], upcoming: [], headline: { tasksDone: 0, needsYou: 0, todayUsd: 0, monthUsd: 0, monthCapUsd: null } }), { onStartCompany, onNewAgent });
    expect(screen.getByTestId('home-start')).toHaveTextContent('Start a company with a Chief of Staff');
    fireEvent.click(screen.getByRole('button', { name: 'Start a company' }));
    expect(onStartCompany).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create one agent' }));
    expect(onNewAgent).toHaveBeenCalled();
    expect(screen.getByTestId('needs-empty')).toHaveTextContent("You're clear.");
    expect(screen.queryByTestId('home-mode')).toBeNull();
    expect(screen.queryByTestId('home-goals')).toBeNull();
  });

  it('lists queued background actions with Approve and Dismiss, and recent files', () => {
    const queued = need({ id: 'event:e1', kind: 'queued_action', subkind: 'gmail_send', title: 'Send the newsletter', requestedBy: 'Writer', deadline: null, defaultAction: '', recommendation: '', recommendedAction: '', reversibility: '', confidence: null, ref: { agentId: 'w', eventId: 'e1' }, actions: ['approve', 'dismiss'] });
    const { onAct, onOpen } = board(fixture({ company: null, needs: [queued], headline: { tasksDone: 2, needsYou: 1, todayUsd: 0.1, monthUsd: 1, monthCapUsd: null } }), { narrow: true, wide: false });
    const card = screen.getByTestId('need-card');
    expect(card).toHaveTextContent('Queued action');
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'event:e1' }), 'dismiss');
    expect(screen.queryByRole('button', { name: 'See all in Inbox' })).toBeNull();
    fireEvent.click(within(screen.getByTestId('home-artifacts')).getByRole('button', { name: /weekly\.md/ }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'file', path: 'reports/weekly.md' });
  });
});

describe('HomeStatus and decisions', () => {
  it('explains a failed load and retries', () => {
    const onRetry = vi.fn();
    render(<HomeStatus error="502 Bad Gateway" narrow onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Home didn't load");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('sends each inline decision through the route that owns it', async () => {
    const card = vi.spyOn(api, 'decideOrgApproval').mockResolvedValue({} as never);
    const key = vi.spyOn(api, 'giveActionKey').mockResolvedValue({} as never);
    const veto = vi.spyOn(api, 'vetoOrgPlan').mockResolvedValue({} as never);
    const ack = vi.spyOn(api, 'ackOrgSignal').mockResolvedValue({} as never);
    const ev = vi.spyOn(api, 'actOnAgentEvent').mockResolvedValue({} as never);
    await decide('ws1', need(), 'reject');
    expect(card).toHaveBeenCalledWith('ws1', 'a1', 'reject');
    await decide('ws1', need({ kind: 'held_action', ref: { actionId: 'act1' } }), 'approve');
    expect(key).toHaveBeenCalledWith('ws1', 'act1', true);
    await decide('ws1', need({ kind: 'plan', ref: { planId: 'p1' } }), 'veto');
    expect(veto).toHaveBeenCalledWith('ws1', 'p1');
    await decide('ws1', need({ kind: 'signal', ref: { signalId: 's1' } }), 'ack');
    expect(ack).toHaveBeenCalledWith('ws1', 's1');
    await decide('ws1', need({ kind: 'queued_action', ref: { agentId: 'w', eventId: 'e1' } }), 'approve');
    expect(ev).toHaveBeenCalledWith('w', 'e1', 'approve');
    await expect(decide('ws1', need({ kind: 'incident', ref: { incidentId: 'i' } }), 'approve')).rejects.toThrow(/open it for details/);
  });
});
