/** The Inbox's Following filter (docs/follows.md §7): what changed on the
 *  threads and tasks I follow — title, the latest change and who made it,
 *  the unseen count, a needs-you marker — listed under Following (and in All
 *  when there is news); opening one opens the thread or the task and marks it
 *  seen. Only follows that need me count in the badge. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowRow } from '../src/lib/api';
import { buildInbox, followingList, inboxBadge, waitingCount } from '../src/lib/inbox';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { InboxView } = await import('../src/components/InboxView');

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
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push({ url: u, body: JSON.parse(String(init.body ?? 'null')) });
    const body = u.endsWith('/org/detail') ? { id: 'o1', workspaceId: 'ws1', name: 'Acme', members: [] }
      : u.endsWith('/follows/mine') ? FOLLOWS
      : u.endsWith('/humans/me/tasks') ? { assigned: [], reviewing: [] }
      : u.endsWith('/follows/seen') ? { ok: true } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', companiesEnabled: true, wsOrg: { mode: 'supervised', orgId: 'o1', units: [] }, orgHealth: null, orgHeldActions: 0,
    inboxFilter: 'all', setInboxFilter: vi.fn((f: string) => { fake.inboxFilter = f; }), setOrgFocus: vi.fn(), openOrgTask: vi.fn(),
    refreshWsOrg: vi.fn(async () => undefined), showToast: vi.fn(),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('following in the Inbox (pure)', () => {
  it('lists followed news in All; the Following list has every live follow, needing-me first', () => {
    const items = buildInbox({ approvals: [], plans: [], tasks: null, incidents: [], heldActions: 0, follows: FOLLOWS });
    expect(items.map((i) => i.key)).toEqual(['f:thread:m1', 'f:org_task:t1']);
    expect(items[1].detail).toBe('Writer: blocked: waits on legal');
    expect(items[1].follow).toMatchObject({ unseen: 2, attention: 'blocked: waits on legal' });
    expect(waitingCount(items)).toBe(1); // a reply is news, not waiting on me
    expect(followingList(FOLLOWS).map((i) => i.refId)).toEqual(['t1', 'm1', 't3']);
  });
  it('counts follows in the badge only when they need me', () => {
    expect(inboxBadge({ pendingApprovals: 1, heldActions: 0, pendingPlans: 0, openIncidents: 0, myTasks: 0, followAttention: 1 })).toBe(2);
    expect(inboxBadge({ pendingApprovals: 1, heldActions: 0, pendingPlans: 0, openIncidents: 0, myTasks: 0 })).toBe(1);
  });
});

describe('the Following filter', () => {
  it('shows title, latest change, who, unseen count and the needs-you marker; opening a task opens it and marks it seen', async () => {
    fake.inboxFilter = 'following';
    render(<InboxView />);
    const list = await screen.findByTestId('following-list');
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(3));
    const task = within(list).getByTestId('inbox-item-f:org_task:t1');
    expect(task).toHaveTextContent('Ship the pricing page');
    expect(task).toHaveTextContent('Writer: blocked: waits on legal');
    expect(within(task).getByTestId('follow-unseen')).toHaveTextContent('2 new');
    expect(within(task).getByTestId('follow-attention')).toHaveTextContent('Needs you: blocked: waits on legal');
    expect(screen.getByRole('tab', { name: 'Following · 2' })).toBeInTheDocument();
    fireEvent.click(task);
    expect(fake.openOrgTask).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/workspaces/ws1/follows/seen', body: { targetKind: 'org_task', targetId: 't1' } }));
    expect(within(task).queryByTestId('follow-unseen')).toBeNull();
    expect(within(task).queryByTestId('follow-attention')).toBeNull();
  });
  it('opens a followed thread through its link', async () => {
    fake.inboxFilter = 'following';
    render(<InboxView />);
    fireEvent.click(await screen.findByTestId('inbox-item-f:thread:m1'));
    expect(window.location.pathname).toBe('/ws1/channels/general/m1'); // the older link, at its path (docs/routes.md)
    await waitFor(() => expect(posts.some((p) => (p.body as { targetId?: string }).targetId === 'm1')).toBe(true));
  });
  it('lists followed news in All too', async () => {
    render(<InboxView />);
    const list = await screen.findByTestId('inbox-list');
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(2));
    expect(screen.getByText('1 waiting on you')).toBeInTheDocument();
  });
});
