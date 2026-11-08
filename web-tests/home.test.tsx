import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// No `globals: true` in vitest.config.ts, so RTL does not auto-clean between tests.
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
import { api, type HomeAgent, type HomeData, type HomeNeed } from '../src/lib/api';
import { HomeBoard, HomeStatus } from '../src/components/HomeBoard';
import { decide } from '../src/components/HomeView';
import { askedBy, briefSummary, defaultSentence, defaultShort, headline, needBody, needHeadline, needTarget, recommendationChip, recommendationLine, sinceLabel, stateBanners, targetOf, weekOverWeek } from '../src/lib/home';

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

/** Switch Home's tab the way the owner does. */
const tab = (t: 'overview' | 'progress' | 'team' | 'activity') => fireEvent.click(screen.getByTestId(`home-tab-${t}`));

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

describe('Home copy — the command center', () => {
  it('cleans an escalation title: the ask leads, the task is named by its key, the body does not repeat it', () => {
    const esc = need({ kind: 'escalation', title: 'task "Make the kill criterion citable: fix D10/D11": User decision on the sandbox execution', detail: 'User decision on the sandbox execution', requestedBy: 'migration', task: { key: 'D-11', title: 'Make the kill criterion citable: fix D10/D11' } });
    expect(needHeadline(esc)).toEqual({ title: 'User decision on the sandbox execution', task: { key: 'D-11', title: 'Make the kill criterion citable: fix D10/D11' } });
    expect(needBody(esc)).toBe('');
    expect(askedBy(esc)).toBe('System');
    expect(needHeadline(need({ title: 'tune work.x 1 → 2' })).title).toBe('Tune work.x 1 → 2');
    expect(needHeadline(need({ kind: 'escalation', title: 'task "Pricing": ' })).title).toBe('Pricing');
  });
  it('words the default and the recommendation short, for the meta line', () => {
    expect(defaultShort(need(), NOW)).toBe('Denies in 3 h');
    expect(defaultShort(need({ defaultAction: 'apply', deadline: iso(20) }), NOW)).toBe('Applies in 20 min');
    expect(defaultShort(need({ deadline: iso(-5) }), NOW)).toBe('Past its deadline');
    expect(defaultShort(need({ defaultAction: '' }), NOW)).toBe('');
    expect(recommendationChip(need())).toBe('Recommends approve, 70%');
  });
  it('raises a banner for a paused company, spend over the envelope and a used-up token budget', () => {
    expect(stateBanners(fixture())).toEqual([]);
    const paused = stateBanners(fixture({ company: { ...fixture().company!, status: 'paused' } }));
    expect(paused.map((b) => b.id)).toEqual(['paused']);
    expect(paused[0].action).toEqual({ label: 'Resume in Company', target: { to: 'pane', pane: 'board' } });
    const over = stateBanners(fixture({ spend: { ...fixture().spend, monthUsd: 21 } }));
    expect(over[0]).toMatchObject({ id: 'envelope', tone: 'red', action: { label: 'Raise the envelope', target: { to: 'pane', pane: 'spend' } } });
    expect(stateBanners(fixture({ spend: { ...fixture().spend, forecastState: 'stop' } }))[0].id).toBe('forecast');
    expect(stateBanners(fixture({ company: null, spend: { ...fixture().spend, tokens: { spent: 2e6, budget: 1e6, over: true } } }))[0].id).toBe('tokens');
  });
  it('compares this week with the last, and shortens the brief to its first bullets', () => {
    expect(weekOverWeek([1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2])).toEqual({ thisWeek: 14, lastWeek: 7, delta: 7 });
    expect(weekOverWeek([1, 2, 3, 4, 5, 6, 7])).toEqual({ thisWeek: 28, lastWeek: null, delta: null });
    expect(weekOverWeek([1])).toBeNull();
    expect(briefSummary('## A\n- one\n- two\n- three\n- four')).toEqual({ md: '- one\n- two\n- three', more: true });
    expect(briefSummary('Just a paragraph.').md).toBe('Just a paragraph.');
  });
});

describe('HomeBoard — a company', () => {
  it('opens with the greeting, the company, the mode and the run state', () => {
    const { onOpen } = board(fixture());
    expect(screen.getByText('Good morning, Linh.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Acme');
    expect(screen.getByTestId('home-headline')).toHaveTextContent('Overnight your team closed 12 tasks. 3 things need you.');
    expect(screen.getByTestId('home-mode')).toHaveTextContent('Autonomous');
    expect(screen.getByTestId('home-run-state')).toHaveTextContent('Running');
    fireEvent.click(screen.getByTestId('home-run-state'));
    expect(onOpen).toHaveBeenCalledWith({ to: 'pane', pane: 'board' });
    expect(screen.queryByTestId('home-banner-paused')).toBeNull();
  });

  it('shows a paused company as a banner with its primary action', () => {
    const { onOpen } = board(fixture({ company: { ...fixture().company!, status: 'paused' } }));
    expect(screen.getByTestId('home-run-state')).toHaveTextContent('Paused');
    const banner = screen.getByTestId('home-banner-paused');
    expect(banner).toHaveTextContent('Acme is paused');
    expect(banner).toHaveTextContent('Nothing runs until you resume');
    fireEvent.click(within(banner).getByRole('button', { name: 'Resume in Company' }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'pane', pane: 'board' });
  });

  it('shows the key numbers: needs you, spend against the envelope with the forecast, done this week against last, blocked, agents, pulse', () => {
    const series = Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(20 + i).padStart(2, '0')}`, done: i < 7 ? 1 : 2 }));
    const { onOpen } = board(fixture({ recap: { ...fixture().recap, doneSeries: series } }));
    expect(screen.getByTestId('kpi-needs')).toHaveTextContent('3');
    fireEvent.click(screen.getByTestId('kpi-needs'));
    expect(onOpen).toHaveBeenLastCalledWith({ to: 'inbox' });
    const spend = screen.getByTestId('kpi-spend');
    expect(spend).toHaveTextContent('$12.40');
    expect(spend).toHaveTextContent('Forecast $24.00');
    expect(within(spend).getByRole('meter')).toHaveAttribute('aria-valuemax', '20');
    fireEvent.click(spend);
    expect(onOpen).toHaveBeenLastCalledWith({ to: 'pane', pane: 'spend' });
    expect(screen.getByTestId('kpi-done')).toHaveTextContent('Done this week14');
    expect(screen.getByTestId('kpi-done')).toHaveTextContent('+7 vs last week');
    expect(within(screen.getByTestId('kpi-done')).getByRole('img')).toHaveAccessibleName(/Tasks done per day/);
    expect(screen.getByTestId('kpi-blocked')).toHaveTextContent('1');
    expect(screen.getByTestId('kpi-agents')).toHaveTextContent('1/ 2');
    expect(screen.getByTestId('kpi-pulse')).toHaveTextContent('82');
    fireEvent.click(screen.getByTestId('kpi-agents'));
    expect(screen.getByTestId('home-panel-team')).toBeInTheDocument();
    expect(screen.getByTestId('home-tab-team')).toHaveAttribute('aria-selected', 'true');
  });

  it('lists what needs the owner as compact rows: kind, a clean title, the default, the recommendation, inline decisions, detail on demand', () => {
    const { onAct, onOpen } = board(fixture());
    const cards = screen.getAllByTestId('need-card');
    expect(cards.map((c) => c.getAttribute('data-kind'))).toEqual(['escalation', 'approval', 'plan']);
    const hire = cards[1];
    expect(hire).toHaveTextContent('Ana as Researcher');
    expect(within(hire).getByTestId('need-rec')).toHaveTextContent('Recommends approve, 70%');
    expect(within(hire).getByTestId('need-default')).toHaveTextContent('Denies in 3 h');
    expect(within(hire).queryByTestId('need-detail')).toBeNull();
    fireEvent.click(within(hire).getByRole('button', { name: 'Show details' }));
    const detail = within(hire).getByTestId('need-detail');
    expect(detail).toHaveTextContent('Research has no owner.');
    expect(detail).toHaveTextContent('Chief recommends approve. 70% sure. Reversible.');
    expect(within(hire).getByTestId('need-default-full')).toHaveTextContent("If you don't answer, it will be denied in 3 h.");
    fireEvent.click(within(hire).getByRole('button', { name: 'Approve' }));
    expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'approval:a1' }), 'approve');
    fireEvent.click(within(cards[2]).getByRole('button', { name: 'Veto' }));
    expect(onAct).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'plan:p1' }), 'veto');
    expect(within(cards[2]).getByTestId('need-default')).toHaveTextContent('Applies in 20 min');
    fireEvent.click(screen.getByRole('button', { name: 'See all in Inbox' }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'inbox' });
  });

  it('names an escalation by its ask and its task key; the key opens the task', () => {
    const esc = need({ id: 'approval:e', kind: 'escalation', title: 'task "Fix D10/D11 references": User decision on the sandbox', detail: 'User decision on the sandbox', requestedBy: 'migration', task: { key: 'D-11', title: 'Fix D10/D11 references' }, ref: { approvalId: 'e', taskId: 't11' } });
    const { onOpen } = board(fixture({ needs: [esc], headline: { ...fixture().headline, needsYou: 1 } }));
    const card = screen.getByTestId('need-card');
    expect(within(card).getByRole('button', { name: 'User decision on the sandbox' })).toBeInTheDocument();
    expect(card).not.toHaveTextContent('task "');
    expect(card).toHaveTextContent('System');
    expect(card).not.toHaveTextContent('migration');
    fireEvent.click(within(card).getByRole('button', { name: 'D-11' }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'task', taskId: 't11' });
  });

  it('shows the top three and links the rest to the Inbox; without a company, the top five and the rest in place', () => {
    const many = Array.from({ length: 7 }, (_, i) => need({ id: `approval:${i}`, title: `Card ${i}` }));
    const { onOpen } = board(fixture({ needs: many, headline: { ...fixture().headline, needsYou: 9 } }));
    expect(screen.getAllByTestId('need-card')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '6 more in the Inbox' }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'inbox' });
    cleanup();
    board(fixture({ company: null, needs: many, headline: { ...fixture().headline, needsYou: 7 } }));
    expect(screen.getAllByTestId('need-card')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: '2 more' }));
    expect(screen.getAllByTestId('need-card')).toHaveLength(7);
  });

  it('disables a card while its decision is in flight', () => {
    board(fixture(), { busy: new Set(['approval:a1']) });
    const hire = screen.getAllByTestId('need-card')[1];
    expect(within(hire).getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('opens on the Overview: banners, key numbers, the top of Needs you and a short "while you were away"', () => {
    const { onOpen } = board(fixture());
    expect(screen.getByTestId('home-tab-overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('home-tab-overview')).toHaveAccessibleName('Overview, 3 need you');
    expect(screen.getByTestId('home-kpis')).toBeInTheDocument();
    expect(screen.getByTestId('home-needs')).toBeInTheDocument();
    const away = screen.getByTestId('home-away');
    expect(away).toHaveTextContent('Overnight');
    expect(within(away).getByTestId('away-facts')).toHaveTextContent('12 tasks done, 2 decided without you, 4 files changed.');
    expect(within(away).getByTestId('home-brief')).toHaveTextContent('+40');
    expect(within(away).getAllByRole('listitem').length).toBeGreaterThan(0);
    // the rest lives on the other tabs
    for (const id of ['home-team', 'home-goals', 'home-portfolio', 'home-recap', 'home-activity', 'home-spend', 'home-artifacts', 'home-upcoming']) expect(screen.queryByTestId(id)).toBeNull();
    fireEvent.click(within(away).getByRole('button', { name: 'Everything that happened' }));
    expect(screen.getByTestId('home-panel-activity')).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('home-recap')).getByRole('button', { name: 'Read the brief' }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'pane', pane: 'brief' });
  });

  it('moves between tabs with the arrow keys, Home and End, and reports each pick', () => {
    const onTab = vi.fn();
    board(fixture(), { onTab });
    const overview = screen.getByTestId('home-tab-overview');
    expect(overview).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('home-tab-team')).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    expect(onTab).toHaveBeenLastCalledWith('progress');
    expect(screen.getByTestId('home-tab-progress')).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'home-tab-progress');
    fireEvent.keyDown(screen.getByTestId('home-tab-progress'), { key: 'End' });
    expect(onTab).toHaveBeenLastCalledWith('activity');
    fireEvent.keyDown(screen.getByTestId('home-tab-activity'), { key: 'ArrowRight' });
    expect(onTab).toHaveBeenLastCalledWith('overview');
    fireEvent.keyDown(screen.getByTestId('home-tab-overview'), { key: 'ArrowLeft' });
    expect(onTab).toHaveBeenLastCalledWith('activity');
  });

  it('shows the tab the address names', () => {
    board(fixture(), { tab: 'progress' });
    expect(screen.getByTestId('home-tab-progress')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('home-goals')).toBeInTheDocument();
    expect(screen.queryByTestId('home-kpis')).toBeNull();
  });

  it('summarises since the last visit with the brief\'s first bullets, and goals at risk first', () => {
    const { onOpen } = board(fixture());
    tab('activity');
    const recap = screen.getByTestId('home-recap');
    expect(recap).toHaveTextContent('Overnight');
    expect(recap).toHaveTextContent('2 decided without you, 4 files changed.');
    expect(recap).toHaveTextContent('hire: Marketer as Growth');
    expect(recap).toHaveTextContent('Marketer joined as Growth');
    const brief = screen.getByTestId('home-brief');
    expect(within(brief).getByText('+40')).toBeInTheDocument();
    expect(brief).not.toHaveTextContent('Outcomes');
    fireEvent.click(within(brief).getByRole('button', { name: 'Read the brief' }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'pane', pane: 'brief' });
    tab('progress');
    const goals = screen.getAllByTestId('home-goal');
    expect(goals.map((g) => g.getAttribute('data-rag'))).toEqual(['red', 'green']);
    expect(goals[0]).toHaveTextContent('At risk');
    expect(goals[0]).toHaveTextContent('100 / 1000 subs');
  });

  it('shows highlights, file edits grouped per person, and the full feed behind a toggle', () => {
    const edits = ['JOURNAL.md', 'a.md', 'b.md'].map((f, i) => ({ id: `f${i}`, at: iso(-60 - i), kind: 'file' as const, title: `Edited notes/${f}`, detail: 'version 5', actor: 'Tutor Engineer', ref: { type: 'file', id: `notes/${f}` } }));
    const { onOpen } = board(fixture({ activity: [...fixture().activity, ...edits] }));
    tab('activity');
    const hl = screen.getByTestId('activity-highlights');
    expect(within(hl).getAllByRole('listitem')).toHaveLength(4); // 3 events (Writer's one file among them), Tutor Engineer's group
    const group = within(hl).getByTestId('highlight-files');
    expect(group).toHaveTextContent('Tutor Engineer edited 3 files');
    expect(group).not.toHaveTextContent('JOURNAL.md');
    fireEvent.click(within(group).getByRole('button', { name: /Tutor Engineer edited 3 files/ }));
    fireEvent.click(within(group).getByRole('button', { name: 'JOURNAL.md' }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'file', path: 'notes/JOURNAL.md' });
    fireEvent.click(screen.getByRole('button', { name: 'All activity' }));
    expect(within(screen.getByTestId('activity-list')).getAllByRole('listitem')).toHaveLength(6);
  });

  it('filters the full activity feed', () => {
    board(fixture());
    tab('activity');
    fireEvent.click(screen.getByRole('button', { name: 'All activity' }));
    const list = () => screen.getByTestId('activity-list');
    expect(within(list()).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1);
    expect(list()).toHaveTextContent('Created reports/weekly.md');
  });

  it('shows spend against the envelope with the forecast, and the last audit', () => {
    board(fixture());
    tab('progress');
    const s = screen.getByTestId('home-spend');
    expect(s).toHaveTextContent('$12.40');
    expect(s).toHaveTextContent('of $20.00 this month');
    expect(s).toHaveTextContent('On pace for $24.00 by month end, over the envelope.');
    expect(s).toHaveTextContent('2 findings');
  });

  it('surfaces agent errors loudly, pins failing agents on top with a fix, and links to the full directory', () => {
    const failing = agent({ id: 'x', name: 'Analyst', state: 'error', errors: [{ kind: 'turn', message: 'model "gpt-9-ultra" not found (404)', at: iso(-3), sessionId: 's9' }] });
    const { onAllAgents, onOpen } = board(fixture({ team: [agent(), failing] }));
    expect(screen.getByTestId('kpi-agents')).toHaveTextContent('1 failing');
    expect(screen.getByTestId('home-tab-team')).toHaveAccessibleName('Team, 1 failing');
    tab('team');
    expect(within(screen.getByTestId('home-team')).getByRole('alert')).toHaveTextContent('One agent is failing.');
    const rows = screen.getAllByTestId('team-agent');
    expect(rows[0].getAttribute('data-state')).toBe('error');
    const tile = rows[0];
    expect(within(tile).getByTestId('agent-error')).toHaveTextContent('model "gpt-9-ultra" not found (404)');
    expect(tile).toHaveTextContent('Failing');
    fireEvent.click(within(tile).getByRole('button', { name: 'Open the run' }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'chat', sessionId: 's9' });
    fireEvent.click(within(tile).getByRole('button', { name: 'Fix' }));
    expect(onOpen).toHaveBeenLastCalledWith({ to: 'agent', agentId: 'x' });
    fireEvent.click(within(rows[1]).getByRole('button', { name: /Writer/ }));
    expect(onOpen).toHaveBeenLastCalledWith({ to: 'agent', agentId: 'w' });
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
    // an empty workspace: the start card leads; no strip of zeros, no empty panels
    expect(screen.queryByTestId('home-kpis')).toBeNull();
    expect(screen.queryByTestId('home-team')).toBeNull();
    expect(screen.queryByTestId('home-tabs')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Good morning, Linh.');
  });

  it('lists queued background actions with Approve and Dismiss, and recent files', () => {
    const queued = need({ id: 'event:e1', kind: 'queued_action', subkind: 'gmail_send', title: 'Send the newsletter', requestedBy: 'Writer', deadline: null, defaultAction: '', recommendation: '', recommendedAction: '', reversibility: '', confidence: null, ref: { agentId: 'w', eventId: 'e1' }, actions: ['approve', 'dismiss'] });
    const { onAct, onOpen } = board(fixture({ company: null, needs: [queued], spend: { todayUsd: 0.1, monthUsd: 1, monthCapUsd: null, projectedUsd: null, forecastState: null, tokens: null }, headline: { tasksDone: 2, needsYou: 1, todayUsd: 0.1, monthUsd: 1, monthCapUsd: null } }), { narrow: true, wide: false });
    const card = screen.getByTestId('need-card');
    expect(card).toHaveTextContent('Queued action');
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'event:e1' }), 'dismiss');
    expect(screen.queryByRole('button', { name: 'See all in Inbox' })).toBeNull();
    // the simpler variant: no company numbers, no roadmap, no goals
    expect(screen.queryByTestId('kpi-pulse')).toBeNull();
    expect(screen.getByTestId('kpi-spend')).toHaveTextContent('Spend this month');
    expect(screen.getByTestId('home-away')).toHaveTextContent('2 tasks done, 4 files changed.');
    tab('progress');
    expect(screen.queryByTestId('home-portfolio')).toBeNull();
    expect(screen.queryByTestId('home-goals')).toBeNull();
    expect(screen.getByTestId('home-spend')).toBeInTheDocument();
    expect(screen.getByTestId('home-upcoming')).toBeInTheDocument();
    tab('activity');
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

describe('HomeBoard — the portfolio (docs/work-tracking.md)', () => {
  const portfolio: NonNullable<HomeData['portfolio']> = {
    counts: { now: 3, next: 2, later: 1, atRisk: 1, offTrack: 1, updateMissing: 1, overBudget: 0, late: 0 },
    exceptions: [
      { projectId: 'p1', key: 'P-1', title: 'Referral loop', kinds: ['off_track'], detail: 'The ESP rejected the template', leadName: 'Writer' },
      { projectId: 'p2', key: 'P-2', title: 'Sponsorships', kinds: ['at_risk', 'update_missing'], detail: 'Ask: an intro to the agency', leadName: 'Sales Head' },
    ],
    digest: [{ at: iso(-60), projectId: 'p3', key: 'P-3', title: 'Podcast pilot', kind: 'lane', text: 'moved to now' }],
    doneByProject: [{ projectId: 'p1', key: 'P-1', title: 'Referral loop', done: 4 }],
  };
  const nowProjects: NonNullable<NonNullable<HomeData['portfolio']>['nowProjects']> = [
    { projectId: 'p1', key: 'P-1', title: 'Referral loop', health: 'off_track', progress: { done: 3, total: 10, pct: 30 }, targetDate: '2026-11-20', late: false, blocked: 2, leadName: 'Writer' },
    { projectId: 'p3', key: 'P-3', title: 'Podcast pilot', health: 'on_track', progress: { done: 1, total: 4, pct: 25 }, targetDate: '2026-10-30', late: true, blocked: 0, leadName: 'Chief' },
  ];
  it('shows the Now projects with progress, health and target; flagged ones carry their reasons; elsewhere-flagged follow; a row opens the project page', () => {
    const { onOpen } = board(fixture({ portfolio: { ...portfolio, nowProjects } }));
    tab('progress');
    const sec = screen.getByTestId('home-portfolio');
    expect(screen.getByTestId('portfolio-counts').textContent).toBe('3 in Now, 2 next, 1 later');
    const rows = within(sec).getAllByTestId('portfolio-project');
    expect(rows).toHaveLength(3); // two in Now, P-2 flagged elsewhere
    expect(rows[0].textContent).toContain('P-1Referral loop');
    expect(rows[0].textContent).toContain('Off track');
    expect(rows[0].textContent).toContain('The ESP rejected the template');
    expect(rows[0].textContent).toContain('3/10');
    expect(within(rows[0]).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
    expect(rows[1].textContent).toContain('3 d late');
    expect(rows[1].getAttribute('data-flagged')).toBeNull();
    expect(rows[2].textContent).toContain('Update missing');
    expect(rows[2].textContent).toContain('Ask: an intro to the agency');
    expect(sec.textContent).toContain('Also flagged');
    fireEvent.click(within(rows[0]).getByRole('button'));
    expect(onOpen).toHaveBeenCalledWith({ to: 'pane', pane: 'roadmap', focus: { kind: 'project', id: 'p1' } });
    fireEvent.click(within(sec).getByText('Open roadmap'));
    expect(onOpen).toHaveBeenCalledWith({ to: 'pane', pane: 'roadmap' });
    tab('activity');
    const digest = screen.getByTestId('portfolio-digest');
    expect(digest.textContent).toContain('moved to now');
    expect(digest.textContent).toContain('Tasks done');
  });
  it('an empty roadmap is one line and a call to action, not a strip of zeros', () => {
    const { onOpen } = board(fixture({ portfolio: { counts: { now: 0, next: 0, later: 0, atRisk: 0, offTrack: 0, updateMissing: 0, overBudget: 0, late: 0 }, exceptions: [], digest: [], doneByProject: [], nowProjects: [] } }));
    tab('progress');
    const sec = screen.getByTestId('home-portfolio');
    expect(sec).toHaveTextContent('No project is in Now yet.');
    expect(within(sec).queryAllByTestId('portfolio-project')).toHaveLength(0);
    fireEvent.click(within(sec).getByRole('button', { name: 'Propose a bet' }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'pane', pane: 'roadmap' });
  });
  it('is absent without a portfolio, and a KR shows its projects\' health beside the RAG', () => {
    const data = fixture({ portfolio: null });
    data.goals[0].keyResults[0].projectHealth = 'at_risk';
    board(data, { tab: 'progress' });
    expect(screen.queryByTestId('home-portfolio')).toBeNull();
    expect(screen.getByTestId('kr-project-health').textContent).toBe('projects at risk');
  });
});
