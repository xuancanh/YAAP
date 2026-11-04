/** The meeting room views (docs/meetings.md "During" → "The room header",
 *  "The full-screen room"): the compact in-thread header and its drawer
 *  (collapsed by default, remembered per viewer, items clamped to one line),
 *  Expand and the /<company>/meetings/<id> route, and the full-screen room —
 *  agenda rail, transcript folded per attendee with the live reply, the
 *  Proposed board with inline verdicts, stats and controls, the viewer's
 *  read-only room, and the summary once it ended. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage, OrgMeeting, WorkspaceEvent } from '../src/lib/api';
import {
  agendaRows, closeMeetingView, foldTurns, meetingHash, openMeetingView, parseMeetingHash, parseRoom, meetingStream, proposedBoard, readDrawer, resetRoomStanding, roomStanding, saveDrawer, threadStream, useMeetingRoute,
} from '../src/lib/meetings';
import { parseMinutes } from '../src/lib/org';
import { MEETING_EVENT, type MeetingEventDetail } from '../src/lib/routes';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { MeetingRoom } = await import('../src/components/MeetingRoom');
const { MeetingView } = await import('../src/components/MeetingView');

const calls: Array<{ url: string; method: string; body: unknown }> = [];
let respond: (url: string, method: string) => unknown = () => ({});
let listeners: Array<(ev: WorkspaceEvent) => void> = [];
let store: Map<string, string>;
const emit = (ev: unknown) => act(() => { for (const l of listeners) l(ev as WorkspaceEvent); });

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ITEMS = ['Open items from the last meeting', 'Scorecard', 'Pricing for the Pro tier — do we move from per-seat to usage-based billing before the January launch?', 'Launch date and the press embargo', 'Hiring'];
const MINUTES = {
  summary: '', decisions: [{ title: 'Usage billing', decision: 'Bill by usage', alternatives: '', rationale: '', by: 'a2', messageId: 'p1' }],
  actions: [{ title: 'Draft the email', owner: 'Writer', done_when: 'reviewed', outcome: '', by: 'a2', messageId: 'p2', due: '2026-11-12' }],
  risks: [{ text: 'Churn at renewal', by: 'a3' }], questions: [{ question: 'Co-marketing?', by: 'a2', messageId: 'p3' }],
  parked: [{ text: 'Launch date and the press embargo', by: 'a1' }],
};
function meeting(p: Partial<OrgMeeting> = {}, room: Record<string, unknown> = {}, minutes: Record<string, unknown> = {}): OrgMeeting {
  return {
    id: 'm1', orgId: 'o1', unitId: 'u1', channelId: 'c1', threadRootId: 'r1', kind: 'weekly_review', title: 'Weekly review · Company', agenda: '',
    facilitatorAgentId: 'a1', attendees: JSON.stringify([{ kind: 'agent', id: 'a1' }, { kind: 'agent', id: 'a2' }, { kind: 'agent', id: 'a3' }, { kind: 'human', id: 'me' }, { kind: 'human', id: 'h2' }]),
    status: 'running', scheduledFor: null, startedAt: ago(22), endedAt: null, rounds: 2, usd: 0.42, tokensIn: 9800, tokensOut: 2600,
    minutes: JSON.stringify({ ...MINUTES, ...minutes }), createdBy: 'user', createdAt: ago(25),
    room: JSON.stringify({
      items: ITEMS, current: 2, itemStartedAt: ago(4), itemMinutes: 10, round: 2, roundCap: 3, speakers: ['a2', 'a3', 'a1'], speaking: 'a3',
      attendance: { a2: 'spoke', a3: 'speaking', a1: 'waiting' }, present: ['h2'], openItems: [{ title: 'Billing contract', owner: 'Growth', taskId: 't9', state: 'blocked', status: 'blocked', due: null }],
      preRead: '**Pre-read**\n- Board: two tasks done', proposals: [{ text: 'Sponsors', why: 'two offers', byKind: 'agent', by: 'a2', at: '' }],
      controls: { extend: 0, skip: 1, skipped: 1, end: null }, itemLog: [{ index: 0, how: 'settled', at: ago(16), minutes: 6 }, { index: 1, how: 'skipped', at: ago(4), minutes: 2 }], ...room,
    }),
    ...p,
  };
}
let n = 0;
const msg = (authorKind: ChannelMessage['authorKind'], authorId: string, text: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id: `x${n++}`, channelId: 'c1', threadRootId: 'r1', authorKind, authorId, text, attachments: '[]', mentions: '[]', taskId: null, runId: null, unprompted: 0, editedAt: null, createdAt: ago(10), ...extra,
});
const THREAD = (): ChannelMessage[] => [
  msg('agent', 'a1', 'Agenda: 1. Open items …', { id: 'r1', threadRootId: null }),
  msg('agent', 'a2', 'Copy shipped.'),
  msg('agent', 'a2', 'Contract still blocked.'),
  msg('system', 'system', 'Settled: "Open items from the last meeting". Now item 2 of 5: Scorecard.'),
  msg('human', 'h2', 'The big customers renew in February.'),
  msg('agent', 'a3', 'Long view. '.repeat(120)),
  msg('agent', 'a2', 'Decision proposed: Usage billing — Bill by usage', { id: 'p1' }),
];
const humans = (role: string | null, ceo = 'me') => ({ ceoAccountId: ceo, me: { actorId: 'me', role }, humans: [] });

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  calls.length = 0; listeners = [];
  resetRoomStanding();
  window.history.replaceState(null, '', '/');
  store = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  vi.stubGlobal('confirm', () => true);
  respond = (url) => (url.includes('/org/humans') ? humans('ceo') : url.includes('/messages') ? { messages: THREAD(), replies: {}, hasMore: false } : url.includes('/chat/channels/') ? { id: 'c1', slug: 'company', members: [] } : meeting());
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(respond(String(url), method)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', workspaces: [{ id: 'ws1' }], stacked: false, me: { actorId: 'me' },
    agents: [{ id: 'a1', name: 'Chief', emoji: '🧭', colors: '[]' }, { id: 'a2', name: 'Writer', emoji: '✍️', colors: '[]' }, { id: 'a3', name: 'Editor', emoji: '🔍', colors: '[]' }],
    channels: [{ id: 'c1', slug: 'company', folder: '/channels/company' }], nameOf: (id: string) => ({ me: 'Linh', h2: 'Ann' } as Record<string, string>)[id] ?? id,
    onWorkspaceEvent: (l: (ev: WorkspaceEvent) => void) => { listeners.push(l); return () => { listeners = listeners.filter((x) => x !== l); }; },
    showToast: vi.fn(), openChannel: vi.fn(), openFile: vi.fn(), openOrgTask: vi.fn(), pickWorkspace: vi.fn(), go: vi.fn(), setMobileDetail: vi.fn(), setOrgFocus: vi.fn(), setOrgPane: vi.fn(), setOrgUnitId: vi.fn(),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const names: Record<string, string> = { a1: 'Chief', a2: 'Writer', a3: 'Editor', me: 'Linh', h2: 'Ann' };
const name = (_k: 'agent' | 'human', id: string) => names[id] ?? id;

describe('room helpers', () => {
  it('agenda rows: done, skipped, parked, current, upcoming — every item upcoming before the start, none current after the end', () => {
    const m = meeting();
    const rows = agendaRows(parseRoom(m.room), 'running', parseMinutes(m.minutes));
    expect(rows.map((r) => r.state)).toEqual(['done', 'skipped', 'current', 'parked', 'upcoming']);
    expect(rows[0].minutes).toBe(6);
    expect(rows[2].minutes).toBeGreaterThanOrEqual(4);
    expect(agendaRows(parseRoom(m.room), 'scheduled').every((r) => r.state === 'upcoming')).toBe(true);
    expect(agendaRows(parseRoom(m.room), 'done').some((r) => r.state === 'current')).toBe(false);
    // ended part-way: nothing is "up next" — what it never reached is unreached; what it covered stays done/skipped
    const ended = agendaRows(parseRoom(m.room), 'done', parseMinutes(m.minutes)).map((r) => r.state);
    expect(ended).toEqual(['done', 'skipped', 'unreached', 'parked', 'unreached']);
    expect(agendaRows(parseRoom(m.room), 'cancelled').some((r) => r.state === 'upcoming')).toBe(false);
  });
  it('turns fold consecutive messages of one author; system lines stand alone', () => {
    const turns = foldTurns(THREAD().slice(1));
    expect(turns.map((t) => `${t.authorId}:${t.messages.length}`)).toEqual(['a2:2', 'system:1', 'h2:1', 'a3:1', 'a2:1']);
  });
  it('the Proposed board, standing, the route and the drawer memory', () => {
    const m = meeting({}, { verdicts: { 'decision:0': { verdict: 'approved', by: 'me', byName: 'Linh', at: '' } } });
    const board = proposedBoard(parseMinutes(m.minutes), parseRoom(m.room));
    expect(board.map((p) => p.kind)).toEqual(['decision', 'action', 'risk', 'question']);
    expect(board[0].verdictBy).toBe('Linh');
    expect(roomStanding('user', 'me', 'observer', 'me')).toEqual({ steer: true, rule: true, answer: false });
    expect(roomStanding('human:boss', 'me', 'observer', 'boss')).toEqual({ steer: false, rule: false, answer: false });
    expect(roomStanding('human:boss', 'me', 'board', 'boss')).toEqual({ steer: false, rule: true, answer: true });
    expect(roomStanding('x', 'me', undefined)).toEqual({ steer: true, rule: true, answer: true });
    expect(meetingHash('ws1', 'm1')).toBe('#/ws/ws1/meeting/m1');
    expect(parseMeetingHash('#/ws/ws1/meeting/m1')).toEqual({ workspaceId: 'ws1', meetingId: 'm1' });
    expect(parseMeetingHash('#/meeting/m1')).toEqual({ workspaceId: null, meetingId: 'm1' });
    expect(parseMeetingHash('#/ws/ws1/channel/company')).toBeNull();
    expect(readDrawer('me')).toBe(false);
    saveDrawer('me', true);
    expect(readDrawer('me')).toBe(true);
    expect(readDrawer('h2')).toBe(false);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readDrawer('me')).toBe(false);
    expect(() => saveDrawer('me', true)).not.toThrow();
  });
  it('the thread stream owns the thread\'s messages and live replies, nothing else', () => {
    const s = threadStream('ws1', { id: 'c1', slug: 'company' }, 'r1');
    expect(s.threadRootId).toBe('r1');
    expect(s.owns({ id: 'r1', threadRootId: null })).toBe(true);
    expect(s.owns({ id: 'y', threadRootId: 'r1' })).toBe(true);
    expect(s.owns({ id: 'y', threadRootId: null })).toBe(false);
    expect(s.ownsLive({ threadRootId: null, replyRootId: 'r1' })).toBe(true);
    expect(s.ownsLive({ threadRootId: 'other' })).toBe(false);
  });
  it('a meeting in its own sub-channel streams that channel\'s top level and posts there', () => {
    const chans = [{ id: 'c1', slug: 'company' }, { id: 's1', slug: 'meeting-weekly_review-2026-11-04', channelKind: 'sub' }];
    const sub = meetingStream('ws1', { channelId: 's1', threadRootId: 'root', parentChannelId: 'c1' }, chans)!;
    expect(sub.threadRootId).toBeNull();
    expect(sub.openerId).toBe('root');
    expect(sub.placeLabel).toBe('Channel');
    expect(sub.owns({ id: 'y', threadRootId: null })).toBe(true);
    expect(sub.owns({ id: 'y', threadRootId: 'someThread' })).toBe(false);
    expect(sub.ownsLive({ threadRootId: null })).toBe(true);
    expect(meetingStream('ws1', { channelId: 'c1', threadRootId: 'r1' }, chans)!.key).toBe('thread:c1:r1');
    expect(meetingStream('ws1', { channelId: 'c1', threadRootId: null }, chans)).toBeNull();
  });
});

describe('the compact room header', () => {
  it('the drawer is collapsed by default, remembered per viewer, and its agenda items clamp to one line with the full text as a tooltip', () => {
    const { unmount } = render(<MeetingRoom wsId="ws1" meeting={meeting()} me="me" name={name} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('room-drawer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the agenda' }));
    expect(screen.getByTestId('room-drawer')).toBeTruthy();
    expect(store.get('yaam-meeting-drawer:me')).toBe('1');
    const long = within(screen.getByRole('list', { name: 'Agenda items' })).getAllByRole('listitem')[2];
    expect(long.getAttribute('title')).toBe(ITEMS[2]);
    expect(long.querySelector('.mr-clamp')!.textContent).toBe(ITEMS[2]);
    expect(within(screen.getByRole('list', { name: 'Agenda items' })).getAllByRole('listitem').map((li) => li.getAttribute('data-state'))).toEqual(['done', 'skipped', 'current', 'parked', 'upcoming']);
    unmount();
    render(<MeetingRoom wsId="ws1" meeting={meeting()} me="me" name={name} onChanged={vi.fn()} />);
    expect(screen.getByTestId('room-drawer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide the agenda' }));
    expect(screen.queryByTestId('room-drawer')).toBeNull();
    expect(store.get('yaam-meeting-drawer:me')).toBe('0');
  });
  it('the header still works when storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    render(<MeetingRoom wsId="ws1" meeting={meeting()} me="me" name={name} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show the agenda' }));
    expect(screen.getByTestId('room-drawer')).toBeTruthy();
  });
  it('a viewer without standing gets no controls', async () => {
    respond = (url) => (url.includes('/org/humans') ? humans('observer', 'boss') : meeting());
    render(<MeetingRoom wsId="ws1" meeting={meeting({ createdBy: 'human:boss' })} me="me" name={name} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Meeting controls' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Join' })).toBeTruthy();
  });
  it('Expand opens the full-screen room (/<company>/meetings/<id>), and the route follows it, Back included', () => {
    let seen: unknown = 'unset';
    function Probe() { seen = useMeetingRoute(); return null; }
    render(<><Probe /><MeetingRoom wsId="ws1" meeting={meeting()} me="me" name={name} onChanged={vi.fn()} /></>);
    expect(seen).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand the meeting' }));
    expect(seen).toEqual({ workspaceId: 'ws1', meetingId: 'm1' });
    act(() => closeMeetingView());
    expect(seen).toBeNull();
    act(() => openMeetingView('ws1', 'm2'));
    expect(seen).toEqual({ workspaceId: 'ws1', meetingId: 'm2' });
    // Back or Forward onto a meeting address (the store wrote it)
    act(() => { window.history.replaceState(null, '', '/acme-ws1/home'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(seen).toBeNull();
    act(() => { window.history.replaceState(null, '', '/ws1/meetings/m3'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(seen).toEqual({ workspaceId: 'ws1', meetingId: 'm3' });
  });
});

describe('the full-screen room', () => {
  it('running: the agenda rail, the transcript folded per attendee, the live reply, the Proposed board, stats and controls', async () => {
    render(<MeetingView wsId="ws1" meetingId="m1" />);
    await waitFor(() => expect(screen.getByTestId('meeting-view')).toBeTruthy());
    const rail = screen.getByRole('complementary', { name: 'Agenda' });
    expect(within(rail).getAllByTestId('mv-item').map((li) => li.getAttribute('data-state'))).toEqual(['done', 'skipped', 'current', 'parked', 'upcoming']);
    expect(within(rail).getAllByTestId('mv-item')[2].getAttribute('aria-current')).toBe('step');
    expect(rail.textContent).toContain('From the last meeting');
    expect(rail.textContent).toContain('Billing contract');
    expect(rail.textContent).toContain('Pre-read');
    expect(rail.textContent).toContain('Sponsors');
    expect(rail.textContent).toContain('Proposals closed when the meeting started.');
    // the transcript: consecutive turns folded; the long one folded with a toggle
    await waitFor(() => expect(screen.getAllByTestId('mv-turn')).toHaveLength(4));
    expect(screen.getAllByTestId('mv-turn')[0].textContent).toContain('2 messages');
    expect(screen.getAllByTestId('mv-system')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show the whole turn' }));
    expect(screen.getByRole('button', { name: 'Fold the turn' })).toBeTruthy();
    // the speaker's reply streams in
    emit({ type: 'channel_stream', workspaceId: 'ws1', channelId: 'c1', threadRootId: 'r1', agentId: 'a3', liveId: 'l1', delta: 'Billing FAQ first' });
    expect(screen.getByTestId('mv-live').textContent).toContain('Billing FAQ first');
    expect(screen.getByTestId('mv-floor').textContent).toContain('Billing FAQ first');
    emit({ type: 'channel_stream', workspaceId: 'ws1', channelId: 'c1', threadRootId: null, replyRootId: 'other', agentId: 'a2', liveId: 'l2', delta: 'elsewhere' });
    expect(screen.queryByText(/elsewhere/)).toBeNull();
    // a new message in the thread lands
    emit({ type: 'channel_message', workspaceId: 'ws1', channelId: 'c1', message: msg('human', 'me', 'Ship it.') });
    expect(document.body.textContent).toContain('Ship it.');
    // the room: stats, attendees, proposals, the parking lot
    const right = screen.getByRole('complementary', { name: 'Room' });
    expect(within(right).getByTestId('mv-round').textContent).toContain('2/3');
    expect(within(right).getByTestId('mv-tokens').textContent).toContain('12.4k');
    expect(within(right).getByTestId('mv-usd').textContent).toContain('$0.42');
    expect(within(right).getAllByTestId('mv-seat').map((s) => s.getAttribute('data-state'))).toEqual(['spoke', 'speaking', 'waiting', 'away', 'present']);
    expect(within(right).getAllByTestId('mv-proposal').map((p) => p.getAttribute('data-kind'))).toEqual(['decision', 'action', 'risk', 'question']);
    expect(right.textContent).toContain('Launch date and the press embargo');
    // inline verdict on the board, an answer, the controls
    await waitFor(() => expect(within(right).getAllByRole('button', { name: 'Approve' }).length).toBeGreaterThan(0));
    fireEvent.click(within(within(right).getAllByTestId('mv-proposal')[1]).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/verdict'))?.body).toEqual({ kind: 'action', index: 0, verdict: 'reject' }));
    fireEvent.change(within(right).getByLabelText('Answer the question'), { target: { value: 'Not this year' } });
    fireEvent.click(within(right).getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/answer'))?.body).toEqual({ index: 0, answer: 'Not this year' }));
    for (const [label, action] of [['Extend', 'extend'], ['Skip item', 'skip'], ['End', 'end']] as const) {
      fireEvent.click(within(right).getByRole('button', { name: label }));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith('/control') && (c.body as { action: string }).action === action)).toBe(true));
    }
    // Join to speak, then the composer posts in the thread
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/org/meetings/m1/join'))).toBe(true));
    expect(screen.getAllByPlaceholderText(/heard at the next turn|read at the next round/).length).toBeGreaterThan(0);
  });

  it('a meeting_update refetches the room', async () => {
    render(<MeetingView wsId="ws1" meetingId="m1" />);
    await waitFor(() => expect(screen.getByTestId('meeting-view')).toBeTruthy());
    const before = calls.filter((c) => c.url.endsWith('/org/meetings/m1')).length;
    respond = (url) => (url.includes('/org/humans') ? humans('ceo') : url.includes('/messages') ? { messages: THREAD(), replies: {}, hasMore: false } : url.includes('/chat/channels/') ? { id: 'c1', slug: 'company', members: [] } : meeting({}, { round: 3, roundCap: 3 }));
    emit({ type: 'meeting_update', workspaceId: 'ws1', channelId: 'c1', meetingId: 'm1', threadRootId: 'r1', status: 'running' });
    await waitFor(() => expect(screen.getByTestId('mv-round').textContent).toContain('3/3'));
    expect(calls.filter((c) => c.url.endsWith('/org/meetings/m1')).length).toBe(before + 1);
  });

  it('a viewer reads: no controls, no verdicts', async () => {
    respond = (url) => (url.includes('/org/humans') ? humans('observer', 'boss') : url.includes('/messages') ? { messages: THREAD(), replies: {}, hasMore: false } : url.includes('/chat/channels/') ? { id: 'c1', slug: 'company', members: [] } : meeting({ createdBy: 'human:boss' }));
    render(<MeetingView wsId="ws1" meetingId="m1" />);
    await waitFor(() => expect(screen.getByText(/You are watching/)).toBeTruthy());
    const right = screen.getByRole('complementary', { name: 'Room' });
    expect(within(right).queryByRole('button', { name: 'End' })).toBeNull();
    expect(within(right).queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('before the start: propose an agenda item with why, and Join', async () => {
    respond = (url) => (url.includes('/org/humans') ? humans('ceo') : meeting({ status: 'scheduled', threadRootId: null, startedAt: null, scheduledFor: new Date(Date.now() + 3600_000).toISOString() }, { items: [], current: 0, speaking: null }));
    render(<MeetingView wsId="ws1" meetingId="m1" />);
    await waitFor(() => expect(screen.getByLabelText('Propose an agenda item')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Propose an agenda item'), { target: { value: 'Hiring' } });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'two open roles' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/agenda'))?.body).toEqual({ text: 'Hiring', why: 'two open roles' }));
    expect(screen.getByTestId('mv-join')).toBeTruthy();
    expect(screen.getByTestId('mv-elapsed').nextSibling?.textContent).toMatch(/starts in \d+ min/);
  });

  it('after the end: the summary — the minutes open in Artifacts, decisions taken, action items with their task keys, the cost', async () => {
    window.history.replaceState(null, '', '/ws1/meetings/m1');
    const rooms: MeetingEventDetail[] = [];
    const onRoom = (e: Event) => { rooms.push((e as CustomEvent<MeetingEventDetail>).detail); };
    window.addEventListener(MEETING_EVENT, onRoom);
    respond = (url) => (url.includes('/org/humans') ? humans('ceo') : url.includes('/messages') ? { messages: THREAD(), replies: {}, hasMore: false } : url.includes('/chat/channels/') ? { id: 'c1', slug: 'company', members: [] }
      : meeting({ status: 'done', endedAt: ago(1), minutesPath: 'org/meetings/company/2026/2026-11-04-weekly_review.md', summary: 'We kept January.' }, { current: 5, speaking: null, verdicts: { 'decision:0': { verdict: 'approved', by: 'me', byName: 'Linh', at: '' } } },
        { summary: 'We kept January.', endedBy: 'closed', decisions: [{ ...MINUTES.decisions[0], decisionId: 'dec12345678' }], actions: [{ ...MINUTES.actions[0], taskId: 't1', taskKey: 'COM-142' }] }));
    render(<MeetingView wsId="ws1" meetingId="m1" />);
    const summary = await screen.findByTestId('mv-summary');
    expect(summary.textContent).toContain('We kept January.');
    expect(screen.getByTestId('mv-summary-cost').textContent).toBe('12.4k tokens · $0.42');
    expect(screen.getAllByTestId('mv-decision')[0].textContent).toContain('approved by Linh');
    expect(within(summary).getByRole('button', { name: '#decision:dec12345' })).toBeTruthy();
    fireEvent.click(within(summary).getByRole('button', { name: 'COM-142' }));
    expect(fake.openOrgTask).toHaveBeenCalledWith('t1');
    fireEvent.click(within(summary).getByRole('button', { name: 'Open the minutes' }));
    expect(fake.openFile).toHaveBeenCalledWith({ kind: 'workspace', id: 'ws1' }, 'org/meetings/company/2026/2026-11-04-weekly_review.md');
    expect(rooms.at(-1)).toEqual({ workspaceId: '', meetingId: null }); // opening the minutes closed the room
    window.removeEventListener(MEETING_EVENT, onRoom);
    // no controls once it ended; the transcript is a tab away
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    await waitFor(() => expect(screen.getAllByTestId('mv-turn').length).toBeGreaterThan(0));
  });

  it('an ended meeting reads as a record: its duration and how it ended, items covered and skipped, who attended — no running clock, no waiting seats, no "up next"', async () => {
    window.history.replaceState(null, '', '/#/ws/ws1/meeting/m1');
    // ended at the budget cap during item 3 of 5, 5 minutes after it started
    respond = (url) => (url.includes('/org/humans') ? humans('ceo') : url.includes('/messages') ? { messages: THREAD(), replies: {}, hasMore: false } : url.includes('/chat/channels/') ? { id: 'c1', slug: 'company', members: [] }
      : meeting({ status: 'done', startedAt: ago(60), endedAt: ago(55) }, { speaking: null, attendance: { a1: 'waiting' }, present: [] }, { endedBy: 'usd_cap', parked: [] }));
    render(<MeetingView wsId="ws1" meetingId="m1" />);
    await screen.findByTestId('mv-summary');
    expect(screen.getByTestId('mv-ended').textContent).toMatch(/^5 min.*Ended/);
    expect(screen.getByTestId('mv-ended').textContent).toMatch(/stopped at the USD cap/);
    expect(screen.getByTestId('mv-elapsed').textContent).not.toMatch(/:/); // a duration, not a clock
    expect(screen.queryByText(/of ~\d+ min/)).toBeNull();
    expect(screen.getByTestId('mv-covered').textContent).toContain('1/5');
    expect(screen.getByTestId('mv-skipped').textContent).toContain('4');
    const items = screen.getAllByTestId('mv-item');
    expect(items.map((i) => i.getAttribute('data-state'))).toEqual(['done', 'skipped', 'unreached', 'unreached', 'unreached']);
    expect(items.some((i) => /up next/.test(i.textContent ?? ''))).toBe(false);
    expect(items[2].textContent).toContain('not reached');
    const seats = screen.getAllByTestId('mv-seat');
    expect(seats.some((x) => /waiting|not joined/.test(x.textContent ?? ''))).toBe(false);
    expect(seats.filter((x) => /attended/.test(x.textContent ?? ''))).toHaveLength(3);
    expect(seats.find((x) => /Linh/.test(x.textContent ?? ''))!.textContent).toContain('did not join');
  });

  it('on a phone the columns are tabs', async () => {
    fake.stacked = true;
    render(<MeetingView wsId="ws1" meetingId="m1" />);
    await waitFor(() => expect(screen.getByRole('tablist', { name: 'Meeting sections' })).toBeTruthy());
    expect(screen.queryByRole('complementary', { name: 'Agenda' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Room' }));
    expect(screen.getByTestId('mv-stats')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }));
    expect(screen.getAllByTestId('mv-item')).toHaveLength(5);
  });
});
