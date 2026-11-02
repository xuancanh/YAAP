/** The meeting room (docs/meetings.md "During"): the room header — agenda
 *  items and the current one, round N of M, cost, the attendee strip with
 *  speaking / passed / not called / present — Join and the steering
 *  controls; the inline Approve / Reject and Answer under proposals; the
 *  start dialog; Join and the cost on the Meetings list. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarMeeting, OrgMeeting } from '../src/lib/api';
import { parseRoom, proposalFor, seats, tokensText } from '../src/lib/meetings';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { MeetingRoom, ProposalActions } = await import('../src/components/MeetingRoom');
const { MeetingStartDialog } = await import('../src/components/MeetingStartDialog');
const { MeetingsBoard } = await import('../src/components/MeetingsBoard');

const calls: Array<{ url: string; method: string; body: unknown }> = [];
let respond: (url: string, method: string) => unknown = () => ({});

function meeting(p: Partial<OrgMeeting> = {}, room: Record<string, unknown> = {}, minutes: Record<string, unknown> = {}): OrgMeeting {
  return {
    id: 'm1', orgId: 'o1', unitId: 'u1', channelId: 'c1', threadRootId: 'r1', kind: 'weekly_review', title: 'Weekly review · Company', agenda: '',
    facilitatorAgentId: 'a1', attendees: JSON.stringify([{ kind: 'agent', id: 'a1' }, { kind: 'agent', id: 'a2' }, { kind: 'agent', id: 'a3' }, { kind: 'human', id: 'me' }, { kind: 'human', id: 'h2' }]),
    status: 'running', scheduledFor: null, startedAt: new Date(Date.now() - 12 * 60_000).toISOString(), endedAt: null, rounds: 2, usd: 0.12,
    minutes: JSON.stringify({ summary: '', decisions: [], actions: [], risks: [], questions: [], ...minutes }), createdBy: 'user', createdAt: new Date().toISOString(),
    tokensIn: 1000, tokensOut: 500,
    room: JSON.stringify({
      items: ['Open items from the last meeting', 'Scorecard', 'Replans'], current: 1, itemStartedAt: new Date(Date.now() - 4 * 60_000).toISOString(), itemMinutes: 10,
      round: 2, roundCap: 3, speakers: ['a2', 'a3', 'a1'], speaking: 'a3', attendance: { a2: 'passed', a3: 'speaking', a1: 'idle' }, present: ['h2'], ...room,
    }),
    ...p,
  };
}
const names: Record<string, string> = { a1: 'Chief', a2: 'Writer', a3: 'Editor', me: 'Me', h2: 'Ann' };
const name = (_k: 'agent' | 'human', id: string) => names[id] ?? id;

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  calls.length = 0;
  respond = () => meeting();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(respond(String(url), method)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, { workspaceId: 'ws1', stacked: false, me: { actorId: 'me' }, agents: [{ id: 'a1', name: 'Chief' }, { id: 'a2', name: 'Writer' }, { id: 'a3', name: 'Editor' }], showToast: vi.fn(), openChannel: vi.fn(), openFile: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('room helpers', () => {
  it('reads the room, seats the attendees, finds a proposal by its message and formats tokens', () => {
    const m = meeting();
    const room = parseRoom(m.room);
    const strip = seats(room, JSON.parse(m.attendees), 'a1', name);
    expect(strip.map((s) => `${s.name}:${s.state}`)).toEqual(['Writer:passed', 'Editor:speaking', 'Chief:idle', 'Me:away', 'Ann:present']);
    expect(parseRoom('{oops').items).toEqual([]);
    expect(proposalFor('x2', { summary: '', decisions: [], actions: [{ title: 'Draft', owner: 'W', done_when: '', outcome: '', by: 'a2', messageId: 'x2' }], risks: [], questions: [] })).toEqual({ kind: 'action', index: 0, title: 'Draft' });
    expect(tokensText(1500)).toBe('1.5k');
  });
});

describe('MeetingRoom', () => {
  it('shows the agenda with the current item, round N of M, the cost and the attendee strip; Join, Extend, Skip item and End call the room API', async () => {
    const changed = vi.fn();
    render(<MeetingRoom wsId="ws1" meeting={meeting()} me="me" name={name} onChanged={changed} />);
    expect(screen.getByTestId('room-round').textContent).toBe('Round 2 of 3');
    expect(screen.getByTestId('room-cost').textContent).toContain('1.5k tokens');
    const items = screen.getByRole('list', { name: 'Agenda items' }).querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[1].getAttribute('aria-current')).toBe('step');
    expect(items[1].textContent).toContain('← now');
    expect(document.body.textContent).toContain('Item 2 of 3 · 4 / 10 min');
    const states = screen.getAllByTestId('seat').map((el) => el.getAttribute('data-state'));
    expect(states).toEqual(['passed', 'speaking', 'idle', 'away', 'present']);
    expect(screen.getAllByTestId('seat')[2].textContent).toContain('Chief ★');
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/org/meetings/m1/join') && c.method === 'POST')).toBe(true));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    for (const [label, action] of [['Extend', 'extend'], ['Skip item', 'skip'], ['End', 'end']] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith('/org/meetings/m1/control') && (c.body as { action: string }).action === action)).toBe(true));
    }
  });

  it('before the start: no controls, the pre-read on demand and agenda proposals', async () => {
    render(<MeetingRoom wsId="ws1" meeting={meeting({ status: 'scheduled', startedAt: null, scheduledFor: new Date(Date.now() + 3600_000).toISOString() }, { items: [], preRead: '**Pre-read**\n- Board: nothing moved', proposals: [{ text: 'Sponsors', why: 'two offers', byKind: 'agent', by: 'a2', at: '' }] })} me="h2" name={name} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Extend' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull();
    expect(document.body.textContent).toContain('Sponsors');
    fireEvent.click(screen.getByRole('button', { name: /Show the pre-read/ }));
    expect(document.body.textContent).toContain('Board: nothing moved');
    fireEvent.change(screen.getByLabelText('Propose an agenda item'), { target: { value: 'Hiring' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/org/meetings/m1/agenda'))?.body).toEqual({ text: 'Hiring' }));
  });
});

describe('ProposalActions', () => {
  const minutes = {
    decisions: [{ title: 'Biweekly', decision: 'Every other week', alternatives: '', rationale: '', by: 'a3', messageId: 'md' }],
    actions: [{ title: 'Draft', owner: 'Writer', done_when: 'x', outcome: '', by: 'a2', messageId: 'ma' }],
    questions: [{ question: 'Sponsors?', by: 'a2', messageId: 'mq' }],
  };
  it('approves or rejects a proposed decision inline', async () => {
    const changed = vi.fn();
    render(<ProposalActions wsId="ws1" meeting={meeting({}, {}, minutes)} messageId="md" onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/verdict'))?.body).toEqual({ kind: 'decision', index: 0, verdict: 'reject' }));
    expect(changed).toHaveBeenCalled();
  });
  it('shows a verdict once given, and nothing on a message that is no proposal', () => {
    const { container } = render(<ProposalActions wsId="ws1" meeting={meeting({}, { verdicts: { 'action:0': { verdict: 'rejected', by: 'user', byName: 'Ann', at: '' } } }, minutes)} messageId="ma" onChanged={vi.fn()} />);
    expect(screen.getByTestId('proposal-verdict').textContent).toBe('Rejected by Ann — not executed');
    cleanup();
    const other = render(<ProposalActions wsId="ws1" meeting={meeting({}, {}, minutes)} messageId="nope" onChanged={vi.fn()} />);
    expect(other.container.textContent).toBe('');
    void container;
  });
  it('answers a question for the CEO where it was asked', async () => {
    render(<ProposalActions wsId="ws1" meeting={meeting({}, {}, minutes)} messageId="mq" onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Answer the question'), { target: { value: 'Not this year' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/answer'))?.body).toEqual({ index: 0, answer: 'Not this year' }));
  });
});

describe('MeetingStartDialog', () => {
  it('starts a meeting in a channel with the picked attendees and joins the room', async () => {
    respond = (url) => (url.includes('/chat/channels/launch') ? { id: 'c9', slug: 'launch', members: [{ memberKind: 'agent', memberId: 'a2', name: 'Writer' }, { memberKind: 'agent', memberId: 'a3', name: 'Editor' }, { memberKind: 'human', memberId: 'me', name: 'Me' }] } : meeting({ id: 'm9' }));
    const done = vi.fn();
    render(<MeetingStartDialog wsId="ws1" units={[]} channel={{ id: 'c9', slug: 'launch' }} onDone={done} />);
    await waitFor(() => expect(screen.getByLabelText('Editor')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Editor'));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'planning' } });
    fireEvent.change(screen.getByLabelText('Agenda'), { target: { value: '- Pricing\n- Launch date' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start now' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    const start = calls.find((c) => c.url.endsWith('/org/meetings') && c.method === 'POST')!;
    expect(start.body).toEqual({ kind: 'planning', channelId: 'c9', agenda: '- Pricing\n- Launch date', attendees: [{ kind: 'agent', id: 'a2' }, { kind: 'human', id: 'me' }] });
    expect(calls.some((c) => c.url.endsWith('/org/meetings/m9/join'))).toBe(true);
  });

  it('starts a unit meeting with the unit\'s agents by default', async () => {
    const done = vi.fn();
    render(<MeetingStartDialog wsId="ws1" units={[{ id: 'u1', name: 'Default', parentUnitId: null, depth: 0, leadAgentId: 'a1', memberAgentIds: ['a2'] }]} onDone={done} />);
    expect(screen.getByLabelText('Chief')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start now' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    const body = calls.find((c) => c.url.endsWith('/org/meetings') && c.method === 'POST')!.body as Record<string, unknown>;
    expect(body.unitId).toBe('u1');
    expect(body.attendees).toEqual([{ kind: 'agent', id: 'a1' }, { kind: 'agent', id: 'a2' }, { kind: 'human', id: 'me' }]);
  });
});

describe('MeetingsBoard', () => {
  function row(p: Partial<CalendarMeeting>): CalendarMeeting {
    return {
      id: 'x', source: 'meeting', meetingId: 'x', cadenceId: null, kind: 'weekly_review', title: 'Weekly review · Company', unitId: 'u1', unitName: 'Company', channelId: 'c1', channelSlug: 'company',
      status: 'done', at: new Date().toISOString(), endedAt: null, facilitator: null, attendees: [], minutesPath: null, summary: '', cron: null, threadRootId: 'r1', decisions: 0, actions: 0, rounds: 1, usd: 0, ...p,
    };
  }
  it('a running meeting offers Join (present in the room, then its thread); a held one View and its cost; a channel tab starts one', async () => {
    respond = (url) => (url.includes('/meetings?') ? { from: '', to: '', now: '', hasOrg: true, meetings: [row({ id: 'run', meetingId: 'run', status: 'running', threadRootId: 'rr', usd: 0.05, tokensIn: 800, tokensOut: 400 }), row({ id: 'old', meetingId: 'old', status: 'done', at: new Date(Date.now() - 3600_000).toISOString(), usd: 0.42, tokensIn: 9000, tokensOut: 3000 })] } : meeting());
    render(<MeetingsBoard wsId="ws1" channel="company" startIn={{ id: 'c1', slug: 'company' }} />);
    await waitFor(() => expect(screen.getAllByTestId('meeting-row')).toHaveLength(2));
    expect(screen.getAllByTestId('meeting-cost').map((e) => e.textContent)).toEqual([' · 1.2k tokens · $0.05', ' · 12.0k tokens · $0.42']);
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/org/meetings/run/join'))).toBe(true));
    expect(fake.openChannel).toHaveBeenCalledWith('company', 'rr');
    expect(screen.getByRole('button', { name: 'View' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }));
    expect(screen.getByRole('dialog', { name: 'Start a meeting' })).toBeTruthy();
  });
});
