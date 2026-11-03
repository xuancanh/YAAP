/** Sub-channels in the SPA (docs/group-chat.md §9): the rail's nesting and
 *  "Past discussions (N)", the parent's link card (live from the list,
 *  closed from its text), the breadcrumb and the status strip with Close /
 *  Reopen, "Start a discussion", and ChannelView rendering a sub-channel
 *  like a channel — breadcrumb, status, read-only once closed. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, ChannelDetail } from '../src/lib/api';
import { agoText, linkCardSubId, parseLinkCardText, railChannels } from '../src/lib/channels';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { SubChannelCard, SubChannelRows, SubBreadcrumb, SubStatusBar, StartDiscussionForm } = await import('../src/components/SubChannels');
const { ChannelView } = await import('../src/components/ChannelView');

const calls: Array<{ url: string; method: string; body: unknown }> = [];
let respond: (url: string, method: string) => unknown = () => ({});

const at = new Date(Date.now() - 5 * 60_000).toISOString();
function ch(p: Partial<Channel> = {}): Channel {
  return {
    id: 'c-general', workspaceId: 'ws1', slug: 'general', name: 'general', topic: '', kind: 'public', createdBy: 'system', folder: 'channels/general',
    dailyTokenBudget: 0, archivedAt: null, createdAt: '2026-11-01T00:00:00.000Z', unread: 0, memberCount: 4, pastSubs: 0, channelKind: 'channel', parentChannelId: null, status: 'open', purpose: '',
    ...p,
  };
}
const general = ch({ pastSubs: 2 });
const launch = ch({ id: 'c-launch', slug: 'launch', name: 'launch', createdAt: '2026-11-02T00:00:00.000Z' });
const copy = ch({ id: 's-copy', slug: 'discuss-launch-copy', name: 'Launch copy', channelKind: 'sub', parentChannelId: 'c-general', purpose: 'discussion', createdAt: '2026-11-04T10:00:00.000Z', lastActivityAt: at, unread: 2, memberCount: 3, folder: 'channels/general/sub/discuss-launch-copy', linkMessageId: 'card1' });
const standup = ch({ id: 's-standup', slug: 'meeting-standup-2026-11-04', name: 'Standup · Company', channelKind: 'sub', parentChannelId: 'c-general', purpose: 'meeting', createdAt: '2026-11-04T09:30:00.000Z' });

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  calls.length = 0;
  respond = () => ({});
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(respond(String(url), method)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', stacked: false, me: { actorId: 'me' }, agents: [{ id: 'a1', name: 'Scout' }], channels: [general, launch, copy, standup],
    showToast: vi.fn(), openChannel: vi.fn(), openFile: vi.fn(), refreshChannels: vi.fn(async () => undefined), nameOf: (id: string) => id,
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('helpers', () => {
  it('nests open sub-channels under their parent, oldest first; an orphan stands alone', () => {
    const tree = railChannels([general, launch, copy, standup, ch({ id: 's-orphan', slug: 'discuss-x', channelKind: 'sub', parentChannelId: 'gone' })]);
    expect(tree.map((g) => [g.channel.slug, g.subs.map((s) => s.slug)])).toEqual([
      ['general', ['meeting-standup-2026-11-04', 'discuss-launch-copy']], ['launch', []], ['discuss-x', []],
    ]);
  });

  it('reads the link card: its sub-channel and, from the text, title, members, status, outcome and slug', () => {
    expect(linkCardSubId(JSON.stringify([{ path: 'subchannel/s-1', kind: 'subchannel' }]))).toBe('s-1');
    expect(linkCardSubId('[]')).toBeNull();
    expect(linkCardSubId('{bad')).toBeNull();
    expect(parseLinkCardText('🗣 Discussion: Launch copy · 3 members · live · 4 messages · #discuss-launch-copy')).toEqual({ title: 'Launch copy', members: 3, status: 'live', outcome: '', slug: 'discuss-launch-copy' });
    expect(parseLinkCardText('📅 Meeting: Planning · Company · 5 members · ended — We ship Friday · Minutes: /org/meetings/x.md · #meeting-planning-2026-11-04'))
      .toEqual({ title: 'Planning · Company', members: 5, status: 'ended', outcome: 'We ship Friday · Minutes: /org/meetings/x.md', slug: 'meeting-planning-2026-11-04' });
    expect(parseLinkCardText('🗣 Discussion: Pricing · 1 member · closed · #discuss-pricing').status).toBe('closed');
    expect(agoText(new Date(Date.now() - 3 * 60_000).toISOString())).toBe('3m ago');
    expect(agoText(null)).toBe('');
  });
});

describe('the rail', () => {
  it('shows open sub-channels indented under the parent with the unread badge, and a collapsed Past discussions list loaded on demand', async () => {
    respond = (url) => (url.includes('/subs?status=closed') ? [{ id: 's-old', slug: 'discuss-old', name: 'Old pricing', purpose: 'discussion', status: 'closed', kind: 'public', memberCount: 2, createdAt: at, closedAt: at, lastActivityAt: at, outcome: 'Price at $9', meetingId: null, linkMessageId: 'x', createdBy: 'human:me' }] : {});
    render(<SubChannelRows wsId="ws1" parent={general} subs={[standup, copy]} past={2} current="discuss-launch-copy" onOpen={fake.openChannel as (s: string) => void} />);
    expect(screen.getByText('Launch copy')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('📅')).toBeTruthy();
    fireEvent.click(screen.getByText('Launch copy'));
    expect(fake.openChannel).toHaveBeenCalledWith('discuss-launch-copy');
    expect(screen.queryByText('Old pricing')).toBeNull();
    fireEvent.click(screen.getByText('Past discussions (2)'));
    await waitFor(() => expect(screen.getByText('Old pricing')).toBeTruthy());
    expect(calls.some((c) => c.url.endsWith('/chat/channels/general/subs?status=closed'))).toBe(true);
  });

  it('draws nothing for a channel without discussions', () => {
    const { container } = render(<SubChannelRows wsId="ws1" parent={launch} subs={[]} past={0} current={null} onOpen={() => undefined} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('the link card', () => {
  it('is live from the channel list and opens the sub-channel', () => {
    render(<SubChannelCard subId="s-copy" text="🗣 Discussion: Launch copy · 3 members · live · #discuss-launch-copy" onOpen={fake.openChannel as (s: string) => void} />);
    expect(screen.getByText('Launch copy')).toBeTruthy();
    expect(screen.getByText('live')).toBeTruthy();
    expect(screen.getByText(/3 members · last activity 5m ago · 2 unread/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('sub-card'));
    expect(fake.openChannel).toHaveBeenCalledWith('discuss-launch-copy');
  });

  it('shows a closed discussion\'s outcome from the card text when the list no longer has it', () => {
    render(<SubChannelCard subId="s-gone" text="🗣 Discussion: Pricing · 2 members · closed — Price at $9 · #discuss-pricing" onOpen={fake.openChannel as (s: string) => void} />);
    expect(screen.getByText('closed')).toBeTruthy();
    expect(screen.getByText('Price at $9')).toBeTruthy();
    expect(screen.getByText(/View/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('sub-card'));
    expect(fake.openChannel).toHaveBeenCalledWith('discuss-pricing');
  });
});

describe('breadcrumb, status, start', () => {
  it('reads "#parent › Title" and the parent opens', () => {
    const detail = { ...copy, members: [], spentToday: 0, orgMode: false, parent: { id: 'c-general', slug: 'general', name: 'general', kind: 'public' } } as ChannelDetail;
    render(<SubBreadcrumb detail={detail} channel={copy} onParent={fake.openChannel as (s: string) => void} />);
    expect(screen.getByTestId('sub-breadcrumb').textContent).toBe('#general›Launch copy');
    fireEvent.click(screen.getByText('#general'));
    expect(fake.openChannel).toHaveBeenCalledWith('general');
  });

  it('an open discussion closes with an outcome; a closed one says so and reopens', async () => {
    const onChanged = vi.fn();
    const { unmount } = render(<SubStatusBar wsId="ws1" channel={copy} onChanged={onChanged} />);
    expect(screen.getByTestId('sub-status').textContent).toMatch(/Discussion · open · last activity 5m ago/);
    fireEvent.click(screen.getByText('Close'));
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'Ship the short one' } });
    fireEvent.click(screen.getByText('Close discussion'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/workspaces/ws1/chat/channels/discuss-launch-copy/close', body: { outcome: 'Ship the short one' } });
    unmount();
    render(<SubStatusBar wsId="ws1" channel={{ ...copy, status: 'closed', outcome: 'Ship the short one' }} onChanged={onChanged} />);
    expect(screen.getByTestId('sub-status').textContent).toMatch(/This discussion is closed — read-only: Ship the short one/);
    fireEvent.click(screen.getByText('Reopen'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/discuss-launch-copy/reopen'))).toBe(true));
    // a meeting closes with the meeting, not by hand
    cleanup();
    render(<SubStatusBar wsId="ws1" channel={standup} onChanged={onChanged} />);
    expect(screen.queryByText('Close')).toBeNull();
    expect(screen.getByTestId('sub-status').textContent).toMatch(/closes when the meeting ends/);
  });

  it('"Start a discussion" posts the title, why and the chosen members, then opens it', async () => {
    respond = (_url, method) => (method === 'POST' ? { ...copy } : {});
    const onDone = vi.fn();
    const members = [
      { id: 'm1', channelId: 'c-general', memberKind: 'human' as const, memberId: 'me', role: 'owner' as const, notify: 'mentions' as const, unprompted: 0, joinedAt: at, name: 'Me' },
      { id: 'm2', channelId: 'c-general', memberKind: 'agent' as const, memberId: 'a1', role: 'member' as const, notify: 'mentions' as const, unprompted: 0, joinedAt: at, name: 'Scout' },
    ];
    render(<StartDiscussionForm wsId="ws1" slug="general" members={members} originMessageId="msg1" defaultTitle="Launch copy" onDone={onDone} onCancel={() => undefined} />);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Launch copy');
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'too long for a thread' } });
    fireEvent.click(screen.getByText('🤖 Scout')); // leave Scout out
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/workspaces/ws1/chat/channels/general/subs', body: { title: 'Launch copy', reason: 'too long for a thread', originMessageId: 'msg1', members: [{ kind: 'human', id: 'me' }] } });
  });
});

describe('ChannelView renders a sub-channel like a channel', () => {
  const store = (current: string, channels: Channel[]) => Object.assign(fake, {
    currentChannel: current, channels, channelFocus: null, setChannelFocus: vi.fn(), onWorkspaceEvent: () => () => undefined, wsOrg: null, companiesEnabled: false,
    homeView: 'channel', setMobileChatOpen: vi.fn(), openOrgTask: vi.fn(), openAgent: vi.fn(), setOrgUnitId: vi.fn(), setOrgPane: vi.fn(), go: vi.fn(), setMobileDetail: vi.fn(), setOrgFocus: vi.fn(),
  });
  const detailOf = (c: Channel): ChannelDetail => ({ ...c, members: [{ id: 'm1', channelId: c.id, memberKind: 'human', memberId: 'me', role: 'owner', notify: 'mentions', unprompted: 0, joinedAt: at, name: 'Me' }], spentToday: 0, orgMode: false, parent: c.parentChannelId ? { id: 'c-general', slug: 'general', name: 'general', kind: 'public' } : null, subs: [], pastSubs: 0 });

  it('an open discussion: the breadcrumb, the status strip, the composer', async () => {
    store('discuss-launch-copy', [general, copy]);
    respond = (url) => (url.includes('/messages') ? { messages: [], replies: {}, hasMore: false } : url.includes('/follows') ? { following: true, reason: 'started', followers: [] } : url.endsWith('/chat/channels/discuss-launch-copy') ? detailOf(copy) : {});
    render(<ChannelView />);
    await waitFor(() => expect(screen.getByTestId('sub-breadcrumb').textContent).toBe('#general›Launch copy'));
    expect(screen.getByTestId('sub-status').textContent).toMatch(/Discussion · open/);
    expect(screen.getByPlaceholderText(/Message Launch copy/)).toBeTruthy();
    expect(screen.queryByText(/ Discussion$/)).toBeNull();
  });

  it('a closed discussion (no longer in the rail) still opens from its detail, read-only, with Reopen', async () => {
    const closedCopy = { ...copy, status: 'closed' as const, outcome: 'Ship the short one' };
    store('discuss-launch-copy', [general]);
    respond = (url) => (url.includes('/messages') ? { messages: [], replies: {}, hasMore: false } : url.includes('/follows') ? { following: false, reason: null, followers: [] } : url.endsWith('/chat/channels/discuss-launch-copy') ? detailOf(closedCopy) : {});
    render(<ChannelView />);
    await waitFor(() => expect(screen.getByTestId('sub-status').textContent).toMatch(/closed — read-only: Ship the short one/));
    expect(screen.getByText('Reopen')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Message/)).toBeNull();
    expect(screen.getByText(/Closed — read-only/)).toBeTruthy();
  });

  it('a parent channel draws the link card and offers "Start a discussion"', async () => {
    store('general', [general, copy]);
    const card = { id: 'card1', channelId: 'c-general', threadRootId: null, authorKind: 'system', authorId: '', text: '🗣 Discussion: Launch copy · 3 members · live · #discuss-launch-copy', attachments: JSON.stringify([{ path: 'subchannel/s-copy', kind: 'subchannel' }]), mentions: '[]', taskId: null, runId: null, unprompted: 0, editedAt: null, createdAt: at };
    respond = (url) => (url.includes('/messages') ? { messages: [card], replies: {}, hasMore: false } : url.endsWith('/chat/channels/general') ? detailOf(general) : {});
    render(<ChannelView />);
    await waitFor(() => expect(screen.getByTestId('sub-card')).toBeTruthy());
    fireEvent.click(screen.getByTestId('sub-card'));
    expect(fake.openChannel).toHaveBeenCalledWith('discuss-launch-copy');
    fireEvent.click(screen.getByTitle(/Start a discussion: a temporary sub-channel/));
    expect(screen.getByRole('dialog', { name: 'Start a discussion' })).toBeTruthy();
  });
});
