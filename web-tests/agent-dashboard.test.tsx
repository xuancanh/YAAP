/** An agent's Dashboard tab (docs/mission-control.md): the status sentence in
 *  each state, the live tool call, Now, Blocked with what each waits on and
 *  how to unblock it, Up next, the compact form for the mission control's
 *  side panel, and the agent's own notes folded. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentOverview, OverviewBlocked, OverviewTask } from '../src/lib/api';
import { AgentDashboard, type DashboardActions } from '../src/components/AgentDashboard';
import { elapsed, nextWake, statusText, waitsOnWords } from '../src/lib/overview';

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
    health: { errors: [], spend: { todayUsd: 0.42, d30Usd: 6.1, monthUsd: 4, monthCapUsd: 10 }, trust: [{ actionClass: 'read', effective: 3, ceiling: 3 }], wip: { open: 2, limit: 3 } },
    dashboard: '## My notes\n- shipping drafts', partial: [],
    ...over,
  };
}

function actions(): DashboardActions & { calls: string[] } {
  const calls: string[] = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push(`${name}:${args.map((a) => (typeof a === 'object' && a && 'id' in a ? (a as { id: string }).id : String(a))).join(',')}`); };
  return {
    calls,
    openTask: rec('openTask'), openAgent: rec('openAgent'), openFile: rec('openFile'), openFollow: rec('openFollow'), openTab: rec('openTab'), openActivity: rec('openActivity'),
    chat: rec('chat'), beatNow: rec('beatNow'), togglePause: rec('togglePause'), openApprovals: rec('openApprovals'),
    comment: async (taskId, text) => { calls.push(`comment:${taskId},${text}`); },
    reassign: async (taskId, agentId) => { calls.push(`reassign:${taskId},${agentId}`); },
  };
}

const heading = () => screen.getByTestId('agent-sentence').textContent;

describe('the status sentence', () => {
  it('working: the task and how long it has been on it, the live tool call, the quick actions', () => {
    const act = actions();
    render(<AgentDashboard o={fixture({}, { live: { sessionId: 's', sessionName: 'Loop · heartbeat', origin: 'loop', startedAt: iso(-3), tool: 'fs_write', toolLabel: 'writing org/sales/reports/2026-W45.md', toolAt: iso(-1), calls: 4 } })} now={NOW} act={act} />);
    expect(heading()).toBe('Working on Draft three newsletter issues · 2 h in');
    expect(screen.getByTestId('agent-status').dataset.state).toBe('working');
    expect(screen.getByTestId('agent-live').textContent).toContain('writing org/sales/reports/2026-W45.md');
    expect(screen.getByTestId('agent-live').textContent).toContain('4 calls');
    fireEvent.click(screen.getByRole('button', { name: 'Beat now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(act.calls).toEqual(['beatNow:', 'chat:', 'togglePause:']);
  });

  it('blocked: how many, and how many wait on you', () => {
    const o = fixture({ now: null, blocked: [blocked(), blocked({ id: 'b2', title: 'Logo', blocker: { reason: 'Which tone?', waitsOn: { kind: 'agent', id: 'c', name: 'Chief', taskId: null }, since: iso(-30) } }), blocked({ id: 'b3', title: 'Legal', blocker: { reason: 'legal review', waitsOn: { kind: 'unknown', id: null, name: '', taskId: null }, since: iso(-30) } })] },
      { state: 'blocked', doing: 'Blocked on "Pricing page copy"', blockedCount: 3, waitingOnYou: 1, doingSince: null });
    render(<AgentDashboard o={o} now={NOW} act={actions()} />);
    expect(heading()).toBe('Blocked on 3 tasks · waiting on you for 1');
  });

  it('idle: when it next wakes', () => {
    render(<AgentDashboard o={fixture({ now: null, queue: [] }, { state: 'idle', doing: '', taskId: null, doingSince: null })} now={NOW} act={actions()} />);
    expect(heading()).toBe('Idle: next heartbeat in 14 min');
    expect(screen.getByTestId('section-now').textContent).toContain('Not on a task right now.');
  });

  it('paused and erroring', () => {
    const { unmount } = render(<AgentDashboard o={fixture({ now: null }, { state: 'paused', memberStatus: 'paused' })} now={NOW} act={actions()} />);
    expect(heading()).toBe('Paused: nothing runs until you resume it');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Beat now' }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    const errors = [{ kind: 'turn' as const, message: 'provider rejected model claude-opus-4-5', at: iso(-5) }];
    render(<AgentDashboard o={fixture({ health: { ...fixture().health, errors } }, { state: 'error', errors })} now={NOW} act={actions()} />);
    expect(heading()).toBe('Erroring: provider rejected model claude-opus-4-5');
    expect(screen.getByTestId('section-health').textContent).toContain('provider rejected model claude-opus-4-5');
  });
});

describe('the sections', () => {
  it('Now: outcome, done-when, the last comment and its files; the title opens the task', () => {
    const act = actions();
    render(<AgentDashboard o={fixture()} now={NOW} act={act} />);
    const now = screen.getByTestId('agent-now');
    expect(now.textContent).toContain('Three drafts in drafts/');
    expect(now.textContent).toContain('Done when Editor accepts all three');
    expect(now.textContent).toContain('First draft is up');
    fireEvent.click(within(now).getByRole('button', { name: 'drafts/issue-1.md' }));
    fireEvent.click(within(now).getByRole('button', { name: 'Draft three newsletter issues' }));
    expect(act.calls).toEqual(['openFile:drafts/issue-1.md', 'openTask:t1']);
  });

  it('Blocked: what each waits on, Decide for yours, Answer posts on the task, Reassign picks a teammate', async () => {
    const act = actions();
    const o = fixture({ blocked: [blocked(), blocked({ id: 'b2', title: 'Logo', blocker: { reason: 'Which tone?', waitsOn: { kind: 'agent', id: 'c', name: 'Chief', taskId: null }, since: iso(-30) } })] });
    render(<AgentDashboard o={o} now={NOW} act={act} teammates={[{ id: 'c', name: 'Chief' }, { id: 'w', name: 'Writer' }]} />);
    const section = screen.getByTestId('section-blocked');
    expect(section.textContent).toContain('Waiting on you');
    expect(section.textContent).toContain('Waiting on Chief');
    expect(section.textContent).toContain('Need the final price');
    fireEvent.click(within(section).getByRole('button', { name: 'Decide' }));
    fireEvent.click(within(section).getAllByRole('button', { name: 'Answer' })[0]);
    fireEvent.change(screen.getByLabelText('Answer on Pricing page copy'), { target: { value: 'Price is $20' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Send' }));
    await screen.findAllByRole('button', { name: 'Answer' });
    fireEvent.click(within(section).getAllByRole('button', { name: 'Reassign' })[1]);
    const select = screen.getByLabelText('Reassign Logo') as HTMLSelectElement;
    expect([...select.options].map((x) => x.textContent)).toEqual(['Reassign to…', 'Chief'], 'not the agent itself');
    fireEvent.change(select, { target: { value: 'c' } });
    await screen.findAllByRole('button', { name: 'Reassign' });
    expect(act.calls).toEqual(['openApprovals:', 'comment:b1,Price is $20', 'reassign:b2,c']);
  });

  it('Up next is in order; goals, team, health; routine runs collapse; the notes are folded', () => {
    render(<AgentDashboard o={fixture()} now={NOW} act={actions()} />);
    const queue = screen.getByTestId('section-queue');
    expect(within(queue).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('1Plan the December issue'), expect.stringContaining('2Write the welcome email')]);
    expect(screen.getByTestId('section-goals').textContent).toContain('300 / 1000 subs');
    const team = screen.getByTestId('section-team').textContent!;
    expect(team).toContain('Manager · Chief of staff');
    expect(team).toContain('Editor');
    expect(team).toContain('Leads Writing · #writing');
    const health = screen.getByTestId('section-health').textContent!;
    expect(health).toContain('No errors');
    expect(health).toContain('WIP 2/3');
    expect(health).toContain('$4.00 of $10.00');
    expect(screen.getByTestId('section-recent').textContent).toContain('10 heartbeat checks, nothing new');
    expect((screen.getByTestId('agent-notes') as HTMLDetailsElement).open).toBe(false);
  });

  it('compact: the header, Now, Blocked and the next three, without the quick actions', () => {
    render(<AgentDashboard o={fixture({ blocked: [blocked()] })} now={NOW} act={actions()} compact />);
    expect(screen.getByTestId('agent-dashboard').dataset.compact).toBe('true');
    expect(screen.queryByRole('button', { name: 'Beat now' })).toBeNull();
    expect(screen.queryByTestId('section-health')).toBeNull();
    expect(screen.getByText('Pricing page copy')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
    expect(screen.getByText(/WIP 2\/3/)).toBeTruthy();
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
  });
});
