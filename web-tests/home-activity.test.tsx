/** Home polish (docs/home.md): cadences in words in the viewer's time
 *  zone, one Coming-up row per ritual and time (naming the units), routine
 *  loop runs collapsed in Activity with an "Agent runs" filter for the raw
 *  ones, and task references opening the task itself. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeActivity, HomeData, HomeUpcoming } from '../src/lib/api';
import { HomeBoard } from '../src/components/HomeBoard';
import { activityFilters, activityRows, cadenceText, clockTime, dedupeUpcoming, needTarget, upcomingDetail } from '../src/lib/home';

afterEach(cleanup);

const NOW = new Date('2026-11-02T08:00:00');
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m, d, h, min).toISOString();

describe('cadences in words', () => {
  it('puts common crons in words, with the time in the viewer\'s zone', () => {
    const fri4pm = local(2026, 10, 6, 16); // Friday 6 Nov 2026, 16:00 here
    expect(cadenceText('0 16 * * 5', fri4pm)).toBe(`Fridays at ${clockTime(new Date(fri4pm))}`);
    expect(cadenceText('30 9 * * 1-5', local(2026, 10, 3, 9, 30))).toBe(`every weekday at ${clockTime(new Date(2026, 10, 3, 9, 30))}`);
    expect(cadenceText('0 8 1 * *', local(2026, 11, 1, 8))).toBe(`1st of each month at ${clockTime(new Date(2026, 11, 1, 8))}`);
    expect(cadenceText('0 9 * * 1')).toBe(`Mondays at ${clockTime(new Date(2000, 0, 1, 9))}`);
    expect(cadenceText('0 9 * * *')).toMatch(/^every day at /);
    expect(cadenceText('0 9 * * 1,3')).toMatch(/^Mondays and Wednesdays at /);
    expect(cadenceText('0 */2 * * *')).toBe('every 2 hours');
    expect(cadenceText('*/15 * * * *')).toBe('every 15 minutes');
    expect(cadenceText('0 9 1 1 *')).toBe('0 9 1 1 *');
    expect(cadenceText('not a cron')).toBe('not a cron');
  });
  it('moves the weekday when the server\'s day is not the viewer\'s', () => {
    // a Monday-only cron whose next fire falls on Sunday here (the server is ahead)
    const sundayHere = local(2026, 10, 8, 20);
    expect(cadenceText('0 9 * * 1', sundayHere)).toBe(`Sundays at ${clockTime(new Date(sundayHere))}`);
  });
});

describe('Coming up, one row per thing', () => {
  const ritual = (id: string, title: string, at: string, units: string[], cron = '0 16 * * 5'): HomeUpcoming => ({ id, at, kind: 'ritual', title, detail: units.join(', '), cron, units, ref: null });
  it('merges the same title at the same time and names the units', () => {
    const at = local(2026, 10, 6, 16);
    const rows = dedupeUpcoming([ritual('1', 'Weekly review', at, ['Sales']), ritual('2', 'Weekly review', at, ['Engineering']), ritual('3', 'Retro', at, ['Sales'], '30 16 * * 5'), ritual('4', 'Weekly review', local(2026, 10, 13, 16), ['Sales'])]);
    expect(rows.map((r) => r.id)).toEqual(['1', '3', '4']);
    expect(rows[0].units).toEqual(['Sales', 'Engineering']);
    expect(upcomingDetail(rows[0])).toBe(`Sales, Engineering · Fridays at ${clockTime(new Date(at))}`);
  });
  it('renders words, not crons, and no duplicate rows', () => {
    const at = local(2026, 10, 6, 16);
    const data = { ...base(), upcoming: [ritual('1', 'Weekly review', at, ['Sales']), ritual('2', 'Weekly review', at, ['Engineering'])] };
    render(<HomeBoard data={data} narrow={false} wide now={NOW} onAct={vi.fn()} onOpen={vi.fn()} onAllAgents={vi.fn()} tab="progress" />);
    const section = screen.getByRole('region', { name: 'Coming up' });
    expect(within(section).getAllByText('Weekly review')).toHaveLength(1);
    expect(section.textContent).toContain('Sales, Engineering');
    expect(section.textContent).toContain('Fridays at');
    expect(section.textContent).not.toContain('0 16 * * 5');
  });
});

const run = (id: string, at: string, detail = 'Nothing changed.') => ({ id, at, title: 'Loop "heartbeat" ran', detail });
const ACTIVITY: HomeActivity[] = [
  { id: 'event:n1', at: local(2026, 10, 2, 7, 30), kind: 'agent', title: 'Heartbeat: moved task 91ef6d61 to blocked, posted in #company', detail: 'Blocked on legal.', actor: 'Writer', ref: { type: 'task', id: '91ef6d61-full' }, loop: 'heartbeat' },
  { id: 'routine:w:2026-11-02', at: local(2026, 10, 2, 7, 50), kind: 'agent', title: 'Unit Test Writer · 3 heartbeat checks, nothing new', detail: '', actor: 'Unit Test Writer', ref: { type: 'agent', id: 'w' },
    runs: { count: 3, loops: ['heartbeat'], from: local(2026, 10, 2, 6), items: [run('event:r3', local(2026, 10, 2, 7, 50)), run('event:r2', local(2026, 10, 2, 7)), run('event:r1', local(2026, 10, 2, 6), 'Checked the board.')] } },
  { id: 'task:t9:done', at: local(2026, 10, 2, 7, 40), kind: 'task', title: 'Done: Draft the plan', detail: '', actor: 'Writer', ref: { type: 'task', id: 't9' } },
];

function base(): HomeData {
  return {
    workspaceId: 'ws1', generatedAt: NOW.toISOString(), since: NOW.toISOString(), firstVisit: false,
    company: { orgId: 'o1', name: 'Acme', mode: 'autonomous', status: 'active', chiefAgentId: null, chiefName: null, memberCount: 2 },
    headline: { tasksDone: 0, needsYou: 0, todayUsd: null, monthUsd: null, monthCapUsd: null }, needs: [],
    recap: { tasksDone: 0, tasksBlocked: 0, decisions: [], decisionsCount: 0, people: [], artifactsChanged: 0, brief: null, pulse: null },
    goals: [], team: [{ id: 'w', name: 'Unit Test Writer', emoji: 'W', colors: '', title: 'Writer', state: 'idle', doing: '', taskId: null, lastActiveAt: null, lastBeatAt: null, isChief: false, errors: [] }], activity: ACTIVITY,
    spend: { todayUsd: null, monthUsd: null, monthCapUsd: null, projectedUsd: null, forecastState: null, tokens: null },
    health: { status: 'ok', openIncidents: [], providers: [], audit: null }, upcoming: [], artifacts: [], partial: [],
  };
}

describe('Activity: routine runs collapsed', () => {
  it('keeps the collapsed line by default and lists every raw run under "Agent runs"', () => {
    expect(activityRows(ACTIVITY, 'all')).toHaveLength(3);
    const raw = activityRows(ACTIVITY, 'runs');
    expect(raw.map((r) => r.id)).toEqual(['event:r3', 'event:n1', 'event:r2', 'event:r1']);
    expect(raw.every((r) => r.actor)).toBe(true);
    expect(activityFilters(ACTIVITY).map((f) => f.id)).toEqual(['all', 'task', 'agent', 'runs']);
    expect(activityFilters(ACTIVITY.slice(2)).map((f) => f.id)).toEqual(['all', 'task']);
  });
  it('shows one line per agent and day, expandable, with the notable run described by what it did', () => {
    const onOpen = vi.fn();
    render(<HomeBoard data={base()} narrow wide={false} now={NOW} onAct={vi.fn()} onOpen={onOpen} onAllAgents={vi.fn()} tab="activity" />);
    // Highlights leave routine runs out; the notable run stands alone
    const hl = screen.getByTestId('activity-highlights');
    expect(hl.textContent).not.toContain('heartbeat checks, nothing new');
    expect(hl.textContent).toContain('moved task 91ef6d61 to blocked');
    fireEvent.click(screen.getByRole('button', { name: 'All activity' }));
    const list = screen.getByTestId('activity-list');
    expect(list.textContent).toContain('Unit Test Writer · 3 heartbeat checks, nothing new');
    expect(list.textContent).not.toContain('Loop "heartbeat" ran');
    fireEvent.click(within(list).getByRole('button', { name: 'Show the 3 runs' }));
    expect(within(list).getByTestId('routine-runs').querySelectorAll('li')).toHaveLength(3);
    expect(list.textContent).toContain('Checked the board.');
    // the notable run opens the task it changed
    fireEvent.click(within(list).getByRole('button', { name: /moved task 91ef6d61 to blocked/ }));
    expect(onOpen).toHaveBeenCalledWith({ to: 'task', taskId: '91ef6d61-full' });
    // "Agent runs": every run, raw
    fireEvent.click(screen.getByRole('button', { name: 'Agent runs' }));
    expect(within(screen.getByTestId('activity-list')).getAllByRole('listitem')).toHaveLength(4);
  });
  it('opens an escalation\'s task from Needs you', () => {
    expect(needTarget({ id: 'approval:e', kind: 'escalation', ref: { approvalId: 'e', taskId: 't1' } } as never)).toEqual({ to: 'task', taskId: 't1' });
  });
});
