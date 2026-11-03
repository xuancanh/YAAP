/** The meetings list and calendar (docs/meetings.md): the month grid and
 *  week helpers; MeetingsBoard lists upcoming then past, opens a past
 *  meeting's minutes in Artifacts and an upcoming one's details, draws a
 *  month grid (a week agenda at phone width), filters by channel, and says
 *  what to do without an organization. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byDay, dayKey, monthGrid, rangeFor, splitList, weekDays } from '../src/lib/meetings';
import type { CalendarMeeting, CalendarResponse } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { MeetingsBoard } = await import('../src/components/MeetingsBoard');

const HOUR = 3600_000;
function row(p: Partial<CalendarMeeting>): CalendarMeeting {
  return {
    id: 'x', source: 'meeting', meetingId: 'x', cadenceId: null, kind: 'standup', title: 'Standup · Company', unitId: 'u1', unitName: 'Company', channelId: 'c1', channelSlug: 'company',
    status: 'done', at: new Date().toISOString(), endedAt: null, facilitator: { id: 'a1', name: 'Chief' }, attendees: [{ kind: 'agent', id: 'a1', name: 'Chief' }, { kind: 'human', id: 'h1', name: 'Ann' }],
    minutesPath: null, summary: '', cron: null, threadRootId: null, decisions: 0, actions: 0, rounds: 1, usd: 0, ...p,
  };
}

let response: CalendarResponse;
const urls: string[] = [];

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  urls.length = 0;
  const now = Date.now();
  response = {
    from: '', to: '', now: new Date(now).toISOString(), hasOrg: true,
    meetings: [
      row({ id: 'past1', meetingId: 'past1', title: 'Weekly review · Company', kind: 'weekly_review', status: 'done', at: new Date(now - HOUR).toISOString(), minutesPath: 'org/meetings/2026/2026-11-02-company-weekly-review.md', summary: 'We ship Friday.', threadRootId: 'r1', decisions: 1, actions: 2 }),
      row({ id: 'past2', meetingId: 'past2', title: 'Meeting: Launch', kind: 'adhoc', status: 'cancelled', at: new Date(now - 3 * HOUR).toISOString(), minutesPath: 'channels/launch/meetings/2026-11-02-meeting-launch.md' }),
      row({ id: 'cadence:k1:a', source: 'cadence', meetingId: null, cadenceId: 'k1', title: 'Standup · Company', status: 'upcoming', at: new Date(now + HOUR).toISOString(), cron: '30 9 * * 1-5' }),
      row({ id: 'cadence:k2:a', source: 'cadence', meetingId: null, cadenceId: 'k2', title: 'Standup · Writer', unitId: 'u2', unitName: 'Writer', status: 'upcoming', at: new Date(now + HOUR).toISOString(), cron: '30 9 * * 1-5' }),
    ],
  };
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } }); }));
  Object.assign(fake, { workspaceId: 'ws1', stacked: false, openFile: vi.fn(), openChannel: vi.fn(), showToast: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('calendar helpers', () => {
  it('builds Monday-first month grids and weeks', () => {
    const grid = monthGrid(new Date(2026, 10, 15)); // November 2026: Sun 1 … Mon 30
    expect(grid).toHaveLength(6);
    expect(dayKey(grid[0][0])).toBe('2026-10-26');
    expect(dayKey(grid[5][0])).toBe('2026-11-30');
    expect(grid.every((w) => w.length === 7 && w[0].getDay() === 1)).toBe(true);
    expect(monthGrid(new Date(2027, 1, 1))).toHaveLength(4); // February 2027 starts on a Monday
    expect(weekDays(new Date(2026, 10, 4)).map(dayKey)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    const r = rangeFor('month', new Date(2026, 10, 15));
    expect(dayKey(r.from)).toBe('2026-10-26'); expect(dayKey(r.to)).toBe('2026-12-07');
    expect(dayKey(rangeFor('week', new Date(2026, 10, 8)).to)).toBe('2026-11-09');
  });

  it('splits upcoming (soonest first, running on top) from past (latest first) and groups by day', () => {
    const a = row({ id: 'a', status: 'upcoming', at: '2026-11-05T09:30:00Z' });
    const b = row({ id: 'b', status: 'running', at: '2026-11-02T08:00:00Z' });
    const c = row({ id: 'c', status: 'done', at: '2026-11-01T09:30:00Z' });
    const d = row({ id: 'd', status: 'cancelled', at: '2026-11-02T07:00:00Z' });
    const e = row({ id: 'e', status: 'upcoming', at: '2026-11-03T09:30:00Z' });
    const { upcoming, past } = splitList([a, c, b, d, e]);
    expect(upcoming.map((x) => x.id)).toEqual(['b', 'e', 'a']);
    expect(past.map((x) => x.id)).toEqual(['d', 'c']);
    const days = byDay([a, e]);
    expect(days.get(dayKey(new Date(e.at)))?.map((x) => x.id)).toEqual(['e']);
  });
});

describe('MeetingsBoard', () => {
  it('lists upcoming, then past; minutes open in Artifacts, an upcoming meeting opens its details', async () => {
    render(<MeetingsBoard wsId="ws1" unitId={null} />);
    await waitFor(() => expect(screen.getAllByTestId('meeting-row')).toHaveLength(4));
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Upcoming (2)')).toBeLessThan(text.indexOf('Past (2)'));
    const rows = screen.getAllByTestId('meeting-row').map((r) => r.textContent ?? '');
    expect(rows[0]).toMatch(/Standup · (Company|Writer)/);
    expect(rows[2]).toMatch(/Weekly review · Company/); // the latest past first
    expect(rows[2]).toMatch(/We ship Friday\./);
    expect(rows[3]).toMatch(/Meeting: Launch.*cancelled/);
    // the two units' standups at the same time are both there, by name
    expect(rows.filter((r) => /Standup · Company/.test(r))).toHaveLength(1);
    expect(rows.filter((r) => /Standup · Writer/.test(r))).toHaveLength(1);
    // cadence in words
    expect(rows[0]).toMatch(/every weekday at|Mon/);
    fireEvent.click(within(screen.getAllByTestId('meeting-row')[2]).getByRole('button', { name: 'Minutes' }));
    expect(fake.openFile).toHaveBeenCalledWith({ kind: 'workspace', id: 'ws1' }, 'org/meetings/2026/2026-11-02-company-weekly-review.md');
    fireEvent.click(within(screen.getAllByTestId('meeting-row')[2]).getByRole('button', { name: 'View' }));
    expect(window.location.hash).toBe('#/ws/ws1/meeting/past1'); // the full-screen room, its summary
    window.location.hash = '';
    fireEvent.click(screen.getByRole('button', { name: 'Standup · Writer' }));
    const dialog = screen.getByRole('dialog', { name: 'Standup · Writer details' });
    expect(dialog.textContent).toMatch(/Facilitator Chief/);
    expect(dialog.textContent).toMatch(/Attendees Chief, Ann/);
    expect(dialog.textContent).toMatch(/From the cadence/);
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(urls[0]).toMatch(/^\/api\/workspaces\/ws1\/meetings\?from=.*&to=/);
  });

  it('draws a month grid on a wide screen: chips on their day; a past chip opens the minutes, an upcoming one the details', async () => {
    render(<MeetingsBoard wsId="ws1" />);
    await waitFor(() => screen.getAllByTestId('meeting-row'));
    fireEvent.click(screen.getByRole('button', { name: /^calendar$/i }));
    const grid = await screen.findByTestId('month-grid');
    await waitFor(() => expect(within(grid).getAllByText(/Weekly review · Company/).length).toBeGreaterThan(0));
    expect(grid.querySelectorAll('[data-day]').length % 7).toBe(0);
    const pastDay = grid.querySelector(`[data-day="${dayKey(new Date(response.meetings[0].at))}"]`)!;
    fireEvent.click(within(pastDay as HTMLElement).getByText(/Weekly review · Company/));
    expect(fake.openFile).toHaveBeenCalledWith({ kind: 'workspace', id: 'ws1' }, 'org/meetings/2026/2026-11-02-company-weekly-review.md');
    // four on one day: three chips and "+1 more", which lists the day under the grid
    const upDay = grid.querySelector(`[data-day="${dayKey(new Date(response.meetings[3].at))}"]`)! as HTMLElement;
    const more = within(upDay).queryByRole('button', { name: '+1 more' });
    if (more) fireEvent.click(more);
    fireEvent.click(within(grid).getAllByText(/Standup · Writer/).at(-1)!);
    expect(screen.getByRole('dialog', { name: 'Standup · Writer details' })).toBeTruthy();
    // next month: a new range is fetched
    const before = urls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(urls.length).toBeGreaterThan(before));
  });

  it('shows the week agenda at phone width and filters by channel', async () => {
    fake.stacked = true;
    render(<MeetingsBoard wsId="ws1" channel="company" />);
    await waitFor(() => screen.getAllByTestId('meeting-row'));
    expect(urls[0]).toMatch(/channel=company/);
    fireEvent.click(screen.getByRole('button', { name: /^calendar$/i }));
    const week = await screen.findByTestId('week-agenda');
    expect(screen.queryByTestId('month-grid')).toBeNull();
    await waitFor(() => expect(within(week).getAllByText(/Standup · Company/).length).toBeGreaterThan(0));
  });

  it('says meetings need organization mode when the workspace has none', async () => {
    response = { from: '', to: '', now: '', hasOrg: false, meetings: [] };
    render(<MeetingsBoard wsId="ws1" channel="general" />);
    await waitFor(() => expect(document.body.textContent).toMatch(/Meetings run in organization mode/));
  });
});
