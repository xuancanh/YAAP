/** An agent's page (docs/mission-control.md): the header names the cause of
 *  an error and links its run; what needs you comes first; the signals turn
 *  amber and red at their thresholds; the work list is one card with tabs
 *  and rows that expand in place; the activity is capped; the compact form
 *  for the mission control's side panel; six tabs, and every old tab name
 *  still lands. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentOverview, HomeActivity, NeedsYouItem, OverviewBlocked, OverviewTask } from '../src/lib/api';
import { AgentDashboard, AgentHeader, type DashboardActions } from '../src/components/AgentDashboard';
import { ACTIVITY_CAP, elapsed, mergedActivity, nextWake, signals, statusText, waitsOnWords } from '../src/lib/overview';
import { AGENT_TABS, resolveAgentTab } from '../src/lib/agent-tabs';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const NOW = new Date('2026-11-02T10:00:00Z');
const iso = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();

const task = (over: Partial<OverviewTask> = {}): OverviewTask => ({
  id: 't1', source: 'org', title: 'Draft three newsletter issues', status: 'in_progress', outcome: 'Three drafts in drafts/', doneWhen: 'Editor accepts all three',
  startedAt: iso(-120), updatedAt: iso(-10), createdAt: iso(-600), dueAt: null, lastComment: { at: iso(-15), from: 'Writer', text: 'First draft is up' },
  files: ['drafts/issue-1.md'], acceptedBy: '', assigneeName: 'Writer', ...over,
});
const blocked = (over: Partial<OverviewBlocked> = {}): OverviewBlocked => ({
  ...task({ id: 'b1', title: 'Pricing page copy', status: 'blocked', lastComment: null, files: [] }),
  blocker: { reason: 'Need the final price', waitsOn: { kind: 'ceo', id: null, name: 'You', taskId: null }, since: iso(-90) }, ...over,
});
const need = (over: Partial<NeedsYouItem> = {}): NeedsYouItem => ({
  id: 'event:e1', kind: 'action', title: 'Writer wants to run fs_write', detail: 'drafts/issue-2.md', at: iso(-18 * 60), eventId: 'e1', approvalId: null, taskId: null, sessionId: 's9', ...over,
});

function fixture(over: Partial<AgentOverview> = {}, status: Partial<AgentOverview['status']> = {}): AgentOverview {
  return {
    agentId: 'w', workspaceId: 'ws1', generatedAt: NOW.toISOString(),
    agent: { id: 'w', name: 'Writer', emoji: '✍️', colors: '["#111","#222"]', title: 'Head of content', role: 'Writer', provider: 'anthropic', model: 'claude', isChief: false, hasReports: true },
    inCompany: true,
    status: {
      id: 'w', name: 'Writer', emoji: '✍️', colors: '["#111","#222"]', title: 'Head of content', state: 'working', doing: 'Draft three newsletter issues', taskId: 't1',
      lastActiveAt: iso(-2), lastBeatAt: iso(-20), isChief: false, errors: [], live: null, doingSince: iso(-120), waitingOnYou: 0, blockedCount: 0, open: 2,
      lastRunAt: iso(-20), memberStatus: 'active', ...status,
    },
    cause: null, needsYou: [],
    heartbeat: { enabled: true, cron: '*/30 * * * *', nextDueAt: iso(14), lastBeatAt: iso(-20), lastRunAt: iso(-20), lastReason: '', runsToday: 4, dailyRunCap: 12 },
    nextLoop: null,
    now: task(), blocked: [], queue: [task({ id: 'q1', title: 'Plan the December issue', status: 'todo', outcome: '' }), task({ id: 'q2', title: 'Write the welcome email', status: 'todo', outcome: '' })],
    reviews: [], follows: [], done: [task({ id: 'd1', title: 'Outline Q1', status: 'done', updatedAt: iso(-300) })],
    files: [{ path: 'drafts/issue-1.md', version: 2, updatedAt: iso(-30) }],
    recent: [{ id: 'r', at: iso(-60), kind: 'agent', title: 'Writer · 10 heartbeat checks, nothing new', detail: '', actor: 'Writer', ref: null, runs: { count: 10, loops: ['heartbeat'], from: iso(-600), items: [{ id: 'e1', at: iso(-60), title: 'Loop "heartbeat" ran', detail: 'nothing new' }] } }],
    goals: [{ id: 'k1', kind: 'key_result', title: '1,000 subscribers', progress: 0.3, confidence: 0.4, rag: 'amber', atRisk: false, atRiskReason: '', currentValue: 300, targetValue: 1000, unitLabel: 'subs', dueAt: null }],
    team: {
      manager: { id: 'c', name: 'Chief', emoji: '🧭', colors: '["#333","#444"]', title: 'Chief of staff', state: 'idle', doing: '', taskId: null, lastBeatAt: iso(-5), open: 0, liveLabel: '' },
      reports: [{ id: 'e', name: 'Editor', emoji: '📝', colors: '["#555","#666"]', title: 'Editor', state: 'blocked', doing: 'Blocked on "Edit the launch post"', taskId: 'x', lastBeatAt: iso(-8), open: 1, liveLabel: '' }],
      humans: [], unit: { id: 'u', name: 'Writing', slug: 'writing' },
    },
    health: { errors: [], spend: { todayUsd: 0.42, d30Usd: 6.1, monthUsd: 4, monthCapUsd: 10, series: [{ day: '2026-11-01', usd: 0.2 }, { day: '2026-11-02', usd: 0.42 }] }, trust: [{ actionClass: 'read', effective: 3, ceiling: 3 }], wip: { open: 2, limit: 3 } },
    dashboard: '## My notes\n- shipping drafts', partial: [],
    ...over,
  };
}

function actions(): DashboardActions & { calls: string[] } {
  const calls: string[] = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push(`${name}:${args.map((a) => (typeof a === 'object' && a && 'id' in a ? (a as { id: string }).id : String(a))).join(',')}`); };
  const recAsync = (name: string) => async (...args: unknown[]) => { rec(name)(...args); };
  return {
    calls,
    openTask: rec('openTask'), openAgent: rec('openAgent'), openFile: rec('openFile'), openFollow: rec('openFollow'), openTab: rec('openTab'), openActivity: rec('openActivity'),
    openSession: rec('openSession'), chat: rec('chat'), beatNow: rec('beatNow'), togglePause: rec('togglePause'), openApprovals: rec('openApprovals'),
    comment: recAsync('comment'), reassign: recAsync('reassign'), actOnEvent: recAsync('actOnEvent'), decideEvent: recAsync('decideEvent'),
  };
}

const heading = () => screen.getByTestId('agent-sentence').textContent;
const level = (id: string) => screen.getByTestId(`signal-${id}`).dataset.level;

describe('the header', () => {
  it('working: the pill, the task and how long, the live tool call, the quick actions and the overflow menu', () => {
    const act = actions();
    const exported: string[] = [];
    const o = fixture({}, { live: { sessionId: 's', sessionName: 'Loop · heartbeat', origin: 'loop', startedAt: iso(-3), tool: 'fs_write', toolLabel: 'writing org/sales/reports/2026-W45.md', toolAt: iso(-1), calls: 4 } });
    render(<AgentHeader who={{ name: 'Writer', emoji: '✍️', colors: '["#111","#222"]', role: 'Writer', model: 'claude-sonnet' }} o={o} now={NOW} act={act}
      menu={[{ label: 'Import memory…', onSelect: () => exported.push('import') }, { label: 'Export AGENT.json', href: '/x.json', download: true }, { label: 'Publish to the market…', onSelect: () => exported.push('publish') }]} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Writer');
    expect(screen.getByTestId('agent-header').textContent).toContain('claude-sonnet');
    expect(screen.getByTestId('agent-pill').textContent).toBe('Working, live');
    expect(heading()).toBe('Working on Draft three newsletter issues · 2 h in');
    expect(screen.getByTestId('agent-live').textContent).toContain('writing org/sales/reports/2026-W45.md');
    expect(screen.getByTestId('agent-live').textContent).toContain('4 calls');
    fireEvent.click(screen.getByRole('button', { name: 'Beat now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(act.calls).toEqual(['beatNow:', 'chat:', 'togglePause:']);
    // Import, Export and Publish live in the overflow menu, not as big buttons
    expect(screen.queryByRole('button', { name: 'Import memory…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Import memory…', 'Export AGENT.json', 'Publish to the market…']);
    expect(screen.getByRole('menuitem', { name: 'Export AGENT.json' }).getAttribute('href')).toBe('/x.json');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publish to the market…' }));
    expect(exported).toEqual(['publish']);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('erroring: the sentence names the cause, links the failing run and says how to fix it', () => {
    const act = actions();
    const errors = [
      { kind: 'turn' as const, message: 'The last turn failed and recorded no reason', at: iso(-30), sessionId: 's1' },
      { kind: 'loop' as const, message: 'tool round limit (24) reached', at: iso(-29), sessionId: 's1' },
    ];
    const o = fixture({
      cause: { kind: 'loop', message: 'tool round limit (24) reached', at: iso(-29), sessionId: 's1', taskId: null, fix: { text: 'It used all 24 tool rounds in one turn. Split the work into smaller steps, or raise the server\'s MAX_TOOL_ROUNDS.', tab: null } },
      health: { ...fixture().health, errors },
    }, { state: 'error', errors });
    render(<AgentDashboard o={o} now={NOW} act={act} />);
    expect(screen.getByTestId('agent-pill').textContent).toBe('Erroring');
    expect(heading()).toBe('Tool round limit (24) reached');
    const cause = screen.getByTestId('agent-cause');
    expect(cause.textContent).toContain('It used all 24 tool rounds');
    fireEvent.click(within(cause).getByRole('button', { name: 'See the run' }));
    expect(act.calls).toEqual(['openSession:s1']);
    expect(within(cause).queryByRole('button', { name: 'Fix it' })).toBeNull();
    cleanup();
    const act2 = actions();
    const o2 = fixture({ cause: { kind: 'turn', message: 'provider rejected model claude-opus-4-5', at: iso(-5), sessionId: null, taskId: null, fix: { text: 'The provider does not accept this model. Pick another one.', tab: 'Settings:General' } } },
      { state: 'error', errors: [{ kind: 'turn', message: 'provider rejected model claude-opus-4-5', at: iso(-5) }] });
    render(<AgentDashboard o={o2} now={NOW} act={act2} />);
    expect(heading()).toBe('Provider rejected model claude-opus-4-5');
    fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
    expect(act2.calls).toEqual(['openTab:Settings:General']);
  });

  it('blocked, idle and paused say it in one line', () => {
    const o = fixture({ now: null, blocked: [blocked(), blocked({ id: 'b2', title: 'Logo', blocker: { reason: 'Which tone?', waitsOn: { kind: 'agent', id: 'c', name: 'Chief', taskId: null }, since: iso(-30) } }), blocked({ id: 'b3', title: 'Legal', blocker: { reason: 'legal review', waitsOn: { kind: 'unknown', id: null, name: '', taskId: null }, since: iso(-30) } })] },
      { state: 'blocked', doing: 'Blocked on "Pricing page copy"', blockedCount: 3, waitingOnYou: 1, doingSince: null });
    const { unmount } = render(<AgentDashboard o={o} now={NOW} act={actions()} />);
    expect(heading()).toBe('Blocked on 3 tasks · waiting on you for 1');
    unmount();
    const idle = render(<AgentDashboard o={fixture({ now: null, queue: [] }, { state: 'idle', doing: '', taskId: null, doingSince: null })} now={NOW} act={actions()} />);
    expect(heading()).toBe('Next heartbeat in 14 min');
    expect(screen.getByTestId('section-work').textContent).toContain('Not on a task right now.');
    idle.unmount();
    render(<AgentDashboard o={fixture({ now: null }, { state: 'paused', memberStatus: 'paused' })} now={NOW} act={actions()} />);
    expect(heading()).toBe('Nothing runs until you resume it');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Beat now' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('needs you', () => {
  it('comes first, right under the signals, with its actions inline', async () => {
    const act = actions();
    const o = fixture({ needsYou: [
      need(),
      need({ id: 'event:e2', kind: 'connection', title: 'Writer asks to use your Gmail', eventId: 'e2', sessionId: null }),
      need({ id: 'approval:a1', kind: 'escalation', title: 'Escalated: Pricing page copy', eventId: null, approvalId: 'a1', taskId: 'b1', sessionId: null }),
    ] });
    render(<AgentDashboard o={o} now={NOW} act={act} />);
    const needs = screen.getByTestId('section-needs-you');
    const work = screen.getByTestId('section-work');
    const signalsEl = screen.getByTestId('agent-signals');
    expect(signalsEl.compareDocumentPosition(needs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(needs.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('section-health').compareDocumentPosition(needs) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(needs).getAllByTestId('needs-you-row')).toHaveLength(3);
    expect(needs.textContent).toContain('Queued action, 18 h ago: drafts/issue-2.md');
    fireEvent.click(within(needs).getByRole('button', { name: 'Approve' }));
    fireEvent.click(within(needs).getByRole('button', { name: 'Deny' }));
    fireEvent.click(within(needs).getByRole('button', { name: 'Decide' }));
    fireEvent.click(within(needs).getByRole('button', { name: 'Writer wants to run fs_write' }));
    await screen.findByRole('button', { name: 'Approve' });
    expect(act.calls).toEqual(['actOnEvent:e1,approve', 'decideEvent:e2,deny', 'openApprovals:', 'openSession:s9']);
  });

  it('is not there when nothing waits on you', () => {
    render(<AgentDashboard o={fixture()} now={NOW} act={actions()} />);
    expect(screen.queryByTestId('section-needs-you')).toBeNull();
  });
});

describe('the signals', () => {
  it('turn amber and red at their thresholds', () => {
    const base = fixture();
    const at = (wip: { open: number; limit: number }, monthUsd: number, monthCapUsd: number | null) => signals({ ...base, health: { ...base.health, wip, spend: { ...base.health.spend, monthUsd, monthCapUsd } } }, NOW);
    const by = (list: ReturnType<typeof signals>, id: string) => list.find((s) => s.id === id)!;
    expect(by(at({ open: 2, limit: 3 }, 1, 3), 'wip').level).toBe('ok');
    expect(by(at({ open: 3, limit: 3 }, 1, 3), 'wip').level).toBe('warn');
    const over = by(at({ open: 8, limit: 3 }, 1, 3), 'wip');
    expect([over.level, over.value, over.note]).toEqual(['bad', '8/3', '5 over limit']);
    expect(by(at({ open: 2, limit: 3 }, 1, 3), 'budget').level).toBe('ok');
    const near = by(at({ open: 2, limit: 3 }, 2.77, 3), 'budget');
    expect([near.level, near.value, near.note]).toEqual(['warn', '$2.77', 'of $3.00']);
    expect(by(at({ open: 2, limit: 3 }, 3.2, 3), 'budget').level).toBe('bad');
    expect(by(at({ open: 2, limit: 3 }, 3.2, null), 'budget')).toMatchObject({ label: 'Spend', level: 'quiet' });
    expect(by(signals({ ...base, blocked: [blocked()] }, NOW), 'blocked')).toMatchObject({ level: 'bad', note: '1 on you' });
    expect(by(signals({ ...base, blocked: [blocked({ blocker: { reason: '', waitsOn: { kind: 'agent', id: 'c', name: 'Chief', taskId: null }, since: iso(-5) } })] }, NOW), 'blocked').level).toBe('warn');
    expect(by(signals({ ...base, status: { ...base.status, errors: [] }, health: { ...base.health, errors: [{ kind: 'breaker', message: 'No progress', at: iso(-5) }] } }, NOW), 'errors')).toMatchObject({ level: 'bad', value: '1' });
    expect(by(signals({ ...base, health: { ...base.health, errors: [{ kind: 'provider', message: 'degraded', at: iso(-5) }] } }, NOW), 'errors').level).toBe('warn');
    expect(signals({ ...base, health: { ...base.health, wip: null } }, NOW).some((s) => s.id === 'wip')).toBe(false);
  });

  it('show on the page, and a click filters the work list', () => {
    const o = fixture({ blocked: [blocked()], health: { ...fixture().health, wip: { open: 8, limit: 3 }, spend: { ...fixture().health.spend, monthUsd: 2.77, monthCapUsd: 3 } } });
    render(<AgentDashboard o={o} now={NOW} act={actions()} />);
    expect(level('wip')).toBe('bad');
    expect(level('budget')).toBe('warn');
    expect(level('blocked')).toBe('bad');
    expect(screen.getByTestId('work-tab-now').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByTestId('signal-blocked'));
    expect(screen.getByTestId('work-tab-blocked').getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByTestId('section-work')).getByText('Pricing page copy')).toBeTruthy();
    fireEvent.click(screen.getByTestId('signal-queue'));
    expect(screen.getByTestId('work-tab-next').getAttribute('aria-selected')).toBe('true');
  });
});

describe('the work card', () => {
  it('one line a task; a click expands it in place with the outcome, done-when, last comment and files', () => {
    const act = actions();
    const long = 'A very long outcome. '.repeat(20);
    render(<AgentDashboard o={fixture({ now: task({ outcome: long }) })} now={NOW} act={act} />);
    const work = screen.getByTestId('section-work');
    expect(within(work).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Now', 'Blocked', 'Up next2', 'Done1']);
    expect(within(work).queryByTestId('work-detail')).toBeNull();
    fireEvent.click(within(work).getByRole('button', { name: /Draft three newsletter issues/ }));
    const detail = within(work).getByTestId('work-detail');
    expect(detail.textContent).toContain('Done when');
    expect(detail.textContent).toContain('Editor accepts all three');
    expect(detail.textContent).toContain('First draft is up');
    expect(within(detail).getAllByRole('button', { name: 'more' }).length).toBeGreaterThan(0);
    fireEvent.click(within(detail).getByRole('button', { name: 'drafts/issue-1.md' }));
    fireEvent.click(within(detail).getByRole('button', { name: 'Open task' }));
    expect(act.calls).toEqual(['openFile:drafts/issue-1.md', 'openTask:t1']);
    fireEvent.click(within(work).getByTestId('work-tab-next'));
    expect(within(work).getAllByTestId('work-row').map((r) => r.textContent)).toEqual([expect.stringContaining('1Plan the December issue'), expect.stringContaining('2Write the welcome email')]);
  });

  it('Blocked: what each waits on; no reason recorded asks; Answer, Reassign, Decide', async () => {
    const act = actions();
    const o = fixture({ blocked: [
      blocked(),
      blocked({ id: 'b2', title: 'Logo', blocker: { reason: 'Which tone?', waitsOn: { kind: 'agent', id: 'c', name: 'Chief', taskId: null }, since: iso(-30) } }),
      blocked({ id: 'b3', title: 'Legal', blocker: { reason: '', waitsOn: { kind: 'unknown', id: null, name: '', taskId: null }, since: iso(-30) } }),
    ] });
    render(<AgentDashboard o={o} now={NOW} act={act} teammates={[{ id: 'c', name: 'Chief' }, { id: 'w', name: 'Writer' }]} />);
    const work = screen.getByTestId('section-work');
    fireEvent.click(within(work).getByTestId('work-tab-blocked'));
    expect(work.textContent).toContain('Waiting on you');
    expect(work.textContent).toContain('Waiting on Chief');
    expect(work.textContent).toContain('no reason recorded');
    expect(work.textContent).not.toContain('No reason given');
    // the row without a reason: Ask opens the answer box
    fireEvent.click(within(work).getByRole('button', { name: 'Ask' }));
    fireEvent.change(screen.getByLabelText('Answer on Legal'), { target: { value: 'What does legal need?' } });
    fireEvent.click(within(work).getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Ask' });
    // the one on you: Decide
    fireEvent.click(within(work).getByRole('button', { name: /Pricing page copy/ }));
    fireEvent.click(within(work).getByRole('button', { name: 'Decide' }));
    // the one on Chief: Reassign picks a teammate, not the agent itself
    fireEvent.click(within(work).getByRole('button', { name: /^Logo/ }));
    fireEvent.click(within(work).getByRole('button', { name: 'Reassign' }));
    const select = screen.getByLabelText('Reassign Logo') as HTMLSelectElement;
    expect([...select.options].map((x) => x.textContent)).toEqual(['Reassign to…', 'Chief']);
    fireEvent.change(select, { target: { value: 'c' } });
    await screen.findByRole('button', { name: 'Reassign' });
    expect(act.calls).toEqual(['comment:b3,What does legal need?', 'openApprovals:', 'reassign:b2,c']);
  });
});

describe('activity and the side column', () => {
  it('one merged timeline capped at ten rows, Show all, filters', () => {
    const recent: HomeActivity[] = Array.from({ length: 13 }, (_, i) => ({ id: `m${i}`, at: iso(-100 - i), kind: i % 2 ? 'task' : 'decision', title: `Item ${i}`, detail: '', actor: 'Writer', ref: { type: 'task', id: `t${i}` } }));
    const o = fixture({ recent: [...fixture().recent, ...recent] });
    expect(mergedActivity(o)).toHaveLength(15);
    expect(mergedActivity(o)[0].title).toBe('Wrote drafts/issue-1.md');
    const act = actions();
    render(<AgentDashboard o={o} now={NOW} act={act} />);
    const section = screen.getByTestId('section-activity');
    expect(within(section).getAllByTestId('activity-row')).toHaveLength(ACTIVITY_CAP);
    fireEvent.click(within(section).getByRole('button', { name: 'Show all 15' }));
    expect(within(section).getAllByTestId('activity-row')).toHaveLength(15);
    fireEvent.click(within(section).getByRole('button', { name: 'Files' }));
    expect(within(section).getAllByTestId('activity-row')).toHaveLength(1);
    fireEvent.click(within(section).getByRole('button', { name: 'Wrote drafts/issue-1.md' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Runs' }));
    expect(section.textContent).toContain('10 heartbeat checks, nothing new');
    expect(act.calls).toEqual(['openFile:drafts/issue-1.md']);
  });

  it('team, health with the spend sparkline, goals; no trust chips, no recent conversations; the notes are folded', () => {
    render(<AgentDashboard o={fixture()} now={NOW} act={actions()} />);
    const team = screen.getByTestId('section-team').textContent!;
    expect(team).toContain('Chief');
    expect(team).toContain('manager');
    expect(team).toContain('Editor');
    expect(team).toContain('Leads Writing (#writing)');
    const health = screen.getByTestId('section-health');
    expect(health.textContent).toContain('No errors');
    expect(health.textContent).toContain('$4.00 of $10.00');
    expect(within(health).getByTestId('spend-sparkline')).toBeTruthy();
    expect(health.textContent).not.toContain('read: auto');
    expect(screen.getByTestId('section-goals').textContent).toContain('300 / 1000 subs');
    expect(screen.queryByText('Recent conversations')).toBeNull();
    expect((screen.getByTestId('agent-notes') as HTMLDetailsElement).open).toBe(false);
  });

  it('compact: the status, signals and work, without the quick actions, health or inline actions', () => {
    const act = actions();
    render(<AgentDashboard o={fixture({ now: null, blocked: [blocked()] }, { state: 'blocked', blockedCount: 1, waitingOnYou: 1 })} now={NOW} act={act} compact />);
    expect(screen.getByTestId('agent-dashboard').dataset.compact).toBe('true');
    expect(screen.queryByRole('button', { name: 'Beat now' })).toBeNull();
    expect(screen.queryByTestId('section-health')).toBeNull();
    expect(screen.getByTestId('work-tab-blocked').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Pricing page copy/ }));
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
    expect(act.calls).toEqual(['openTask:b1']);
    expect(screen.getByTestId('signal-wip').textContent).toContain('2/3');
  });
});

describe('the tabs', () => {
  it('six tabs; old names and ?tab= deep links land on the new tab and section', () => {
    expect([...AGENT_TABS]).toEqual(['Overview', 'Work', 'Chats', 'Artifacts', 'Memory', 'Settings']);
    expect(resolveAgentTab('Dashboard')).toEqual({ tab: 'Overview', section: null });
    expect(resolveAgentTab('Tasks')).toEqual({ tab: 'Work', section: 'Tasks' });
    expect(resolveAgentTab('Schedule')).toEqual({ tab: 'Work', section: 'Schedule' });
    expect(resolveAgentTab('Mini apps')).toEqual({ tab: 'Settings', section: 'Mini apps' });
    expect(resolveAgentTab('Skills & tools')).toEqual({ tab: 'Settings', section: 'Skills & tools' });
    expect(resolveAgentTab('Trust')).toEqual({ tab: 'Settings', section: 'Trust' });
    expect(resolveAgentTab('Files')).toEqual({ tab: 'Artifacts', section: null });
    expect(resolveAgentTab('Settings')).toEqual({ tab: 'Settings', section: null });
    expect(resolveAgentTab('chats')).toEqual({ tab: 'Chats', section: null });
    expect(resolveAgentTab('Memory')).toEqual({ tab: 'Memory', section: null });
    expect(resolveAgentTab('Settings:Trust')).toEqual({ tab: 'Settings', section: 'Trust' });
    expect(resolveAgentTab('Settings:Model')).toEqual({ tab: 'Settings', section: 'General' });
    expect(resolveAgentTab('Work:Schedule')).toEqual({ tab: 'Work', section: 'Schedule' });
    expect(resolveAgentTab('Nope')).toBeNull();
    expect(resolveAgentTab(null)).toBeNull();
  });
});

describe('the words', () => {
  it('elapsed, the next wake, what a blocker waits on, the sentence as text', () => {
    expect(elapsed(iso(-35), NOW)).toBe('35 min');
    expect(elapsed(iso(-150), NOW)).toBe('3 h');
    expect(nextWake({ heartbeat: fixture().heartbeat, nextLoop: { name: 'digest', at: iso(5), cron: '* * * * *' } })?.what).toBe('digest loop');
    expect(nextWake({ heartbeat: { ...fixture().heartbeat!, enabled: false }, nextLoop: null })).toBeNull();
    expect(waitsOnWords({ kind: 'task', id: null, name: 'Get the logo', taskId: 'x' })).toBe('Waiting on “Get the logo”');
    expect(waitsOnWords({ kind: 'unknown', id: null, name: '', taskId: null })).toBe('');
    expect(statusText(fixture({ now: null }, { state: 'working', doing: '', live: { sessionId: 's', sessionName: 'Weekly report', origin: 'user', startedAt: iso(-1), tool: null, toolLabel: '', toolAt: null, calls: 0 } }), NOW)).toBe('Working · in Weekly report');
    expect(statusText(fixture({ cause: { kind: 'loop', message: 'tool round limit (24) reached', at: iso(-1), sessionId: null, taskId: null, fix: null } }, { state: 'error', errors: [{ kind: 'turn', message: 'The last turn failed', at: iso(-1) }] }), NOW)).toBe('Erroring: tool round limit (24) reached');
  });
});
