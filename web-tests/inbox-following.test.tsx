/** The Inbox's Following list (docs/follows.md §7): Updates › "Everything I
 *  follow" lists every live follow — title, the latest change and who made
 *  it, the unseen count, a needs-you marker; opening one opens the thread or
 *  the task and marks it seen. A follow that needs me is a Needs-you row of
 *  the owner's feed (the server's follow_attention), so it counts in the
 *  badge; plain news is an update. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowRow } from '../src/lib/api';
import { followingList } from '../src/lib/inbox';
import { primeFeed } from '../src/lib/feed-store';
import { feedItem, feedPage } from './feed-fixtures';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { InboxView } = await import('../src/components/InboxView');

let bump: () => void = () => undefined;
function Harness() {
  const [, set] = useState(0);
  bump = () => set((n) => n + 1);
  return <InboxView />;
}
const FEED = feedPage([
  feedItem({ id: 'attention:org_task:t1:x', ids: ['attention:org_task:t1:x'], type: 'follow_attention', section: 'needs', actionable: true, title: 'Ship the pricing page: blocked: waits on legal', target: { kind: 'task', taskId: 't1' }, ref: { follow: { targetKind: 'org_task', targetId: 't1' } } }),
  feedItem({ id: 'event:f2', ids: ['event:f2'], type: 'follow', section: 'updates', title: 'Ada updated #general: launch plan', target: { kind: 'channel', channelId: 'ch', slug: 'general', messageId: 'm1' }, ref: { follow: { targetKind: 'thread', targetId: 'm1' } } }),
]);

const row = (over: Partial<FollowRow>): FollowRow => ({
  id: 'f', workspaceId: 'ws1', followerKind: 'user', followerId: 'single', targetKind: 'org_task', targetId: 't1', reason: 'started', title: 'Ship the pricing page',
  link: '#/ws/ws1/org/board?task=t1', createdAt: '2026-11-01T00:00:00Z', mutedAt: null, lastSeenAt: null, unseenCount: 0, lastActivity: '', lastActorName: '',
  lastActivityAt: null, attentionAt: null, attention: '', closedAt: null, ...over,
});
const FOLLOWS: FollowRow[] = [
  row({ id: 'f1', targetId: 't1', unseenCount: 2, lastActivity: 'blocked: waits on legal', lastActorName: 'Writer', lastActivityAt: '2026-11-02T09:00:00Z', attentionAt: '2026-11-02T09:00:00Z', attention: 'blocked: waits on legal' }),
  row({ id: 'f2', targetKind: 'thread', targetId: 'm1', title: '#general: launch plan', link: '#/ws/ws1/channel/general/m1', unseenCount: 3, lastActivity: 'replied: sounds good', lastActorName: 'Ada', lastActivityAt: '2026-11-02T10:00:00Z' }),
  row({ id: 'f3', targetId: 't3', title: 'Quiet task' }),
  row({ id: 'f4', targetId: 't4', title: 'Muted', mutedAt: '2026-11-01T00:00:00Z', unseenCount: 5 }),
];

const posts: Array<{ url: string; body: unknown }> = [];
beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  posts.length = 0;
  primeFeed(null, '');
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push({ url: u, body: JSON.parse(String(init.body ?? 'null')) });
    const body = u.endsWith('/org/detail') ? { id: 'o1', workspaceId: 'ws1', name: 'Acme', members: [] }
      : u.endsWith('/follows/mine') ? FOLLOWS
      : u.endsWith('/humans/me/tasks') ? { assigned: [], reviewing: [] }
      : u.endsWith('/follows/seen') ? { ok: true }
      : u.includes('/feed/read') ? { ok: true, marked: 1 }
      : u.includes('/feed') ? FEED : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', companiesEnabled: true, wsOrg: { mode: 'supervised', orgId: 'o1', units: [] }, orgHealth: null, orgHeldActions: 0,
    inboxFilter: 'all', setInboxFilter: vi.fn((f: string) => { fake.inboxFilter = f; fake.inboxItem = null; bump(); }), inboxItem: null, setInboxItem: vi.fn((id: string | null) => { fake.inboxItem = id; bump(); }), setOrgFocus: vi.fn(), openOrgTask: vi.fn(), openChannel: vi.fn(),
    refreshWsOrg: vi.fn(async () => undefined), showToast: vi.fn(), me: { role: 'owner' }, stacked: false,
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('following in the Inbox (pure)', () => {
  it('the Following list has every live follow, needing-me first, then news, newest first', () => {
    const items = followingList(FOLLOWS);
    expect(items.map((i) => i.refId)).toEqual(['t1', 'm1', 't3']);
    expect(items[0].detail).toBe('Writer: blocked: waits on legal');
    expect(items[0].follow).toMatchObject({ unseen: 2, attention: 'blocked: waits on legal' });
  });
});

describe('the Following list', () => {
  it('shows title, latest change, who, unseen count and the needs-you marker; opening a task opens it and marks it seen', async () => {
    fake.inboxFilter = 'following';
    render(<Harness />);
    const list = await screen.findByTestId('following-list');
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(3));
    const task = within(list).getByTestId('follow-item-f:org_task:t1');
    expect(task).toHaveTextContent('Ship the pricing page');
    expect(task).toHaveTextContent('Writer: blocked: waits on legal');
    expect(within(task).getByTestId('follow-unseen')).toHaveTextContent('2 new');
    expect(within(task).getByTestId('follow-attention')).toHaveTextContent('Needs you: blocked: waits on legal');
    expect(screen.getByTestId('inbox-tab-updates')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(task);
    expect(fake.openOrgTask).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/workspaces/ws1/follows/seen', body: { targetKind: 'org_task', targetId: 't1' } }));
    expect(within(task).queryByTestId('follow-unseen')).toBeNull();
    expect(within(task).queryByTestId('follow-attention')).toBeNull();
  });
  it('opens a followed thread through its link', async () => {
    fake.inboxFilter = 'following';
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('follow-item-f:thread:m1'));
    expect(window.location.pathname).toBe('/ws1/channels/general/m1'); // the older link, at its path (docs/routes.md)
    await waitFor(() => expect(posts.some((p) => (p.body as { targetId?: string }).targetId === 'm1')).toBe(true));
  });
  it('a follow that needs me is in Needs you; news is an update; opening either where it lives marks the follow seen', async () => {
    render(<Harness />);
    const row = await screen.findByTestId('feed-row-attention:org_task:t1:x');
    fireEvent.click(within(row).getByTestId('feed-go'));
    expect(fake.openOrgTask).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/workspaces/ws1/follows/seen', body: { targetKind: 'org_task', targetId: 't1' } }));
    fireEvent.click(screen.getByTestId('inbox-tab-updates'));
    fireEvent.click(within(screen.getByTestId('feed-row-event:f2')).getByTestId('feed-go'));
    expect(fake.openChannel).toHaveBeenCalledWith('general', 'm1');
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/workspaces/ws1/follows/seen', body: { targetKind: 'thread', targetId: 'm1' } }));
  });
});
