/** Messages from your team (docs/agent-messages.md): the Inbox's Messages
 *  filter (unread first, urgency, opening the direct chat marks it read),
 *  unread messages in All and in the badge, and Home's "Messages from your
 *  team" block — agent text shown as text, never markup. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, HomeData } from '../src/lib/api';
import { buildInbox, inboxBadge, messagesList, waitingCount, INBOX_FILTERS } from '../src/lib/inbox';
import { HomeBoard } from '../src/components/HomeBoard';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { InboxView } = await import('../src/components/InboxView');

const msg = (over: Partial<AgentMessage>): AgentMessage => ({
  id: 'm', eventId: 'e', agentId: 'a1', agentName: 'Penny', emoji: '🤖', colors: '["#111","#222"]', text: 'Hello', urgency: 'normal', refs: [],
  sessionId: 's1', createdAt: '2026-11-02T09:00:00Z', read: false, ...over,
});
const MESSAGES: AgentMessage[] = [
  msg({ id: 'm1', eventId: 'e1', text: 'The launch slipped a day.\nThe vendor missed the build.', refs: ['OPS-12'], createdAt: '2026-11-02T08:00:00Z' }),
  msg({ id: 'm2', eventId: 'e2', agentId: 'a2', agentName: 'Otto', text: 'Site is down', urgency: 'urgent', sessionId: 's2', createdAt: '2026-11-02T10:00:00Z' }),
  msg({ id: 'm3', eventId: 'e3', text: 'Old news', urgency: 'fyi', read: true, createdAt: '2026-11-02T11:00:00Z' }),
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
      : u.endsWith('/inbox/messages') ? { items: MESSAGES, unread: 2 }
      : u.endsWith('/inbox/messages/read') ? { ok: true, marked: 1 }
      : u.endsWith('/humans/me/tasks') ? { assigned: [], reviewing: [] } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', companiesEnabled: true, wsOrg: { mode: 'supervised', orgId: 'o1', units: [] }, orgHealth: null, orgHeldActions: 0,
    inboxFilter: 'all', setInboxFilter: vi.fn((f: string) => { fake.inboxFilter = f; }), setOrgFocus: vi.fn(), openOrgTask: vi.fn(), openSession: vi.fn(),
    refreshWsOrg: vi.fn(async () => undefined), showToast: vi.fn(),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('messages in the Inbox (pure)', () => {
  it('has a Messages filter; unread messages wait on me in All and count in the badge', () => {
    expect(INBOX_FILTERS.map((f) => f.id)).toContain('messages');
    const items = buildInbox({ approvals: [], plans: [], tasks: null, incidents: [], heldActions: 0, messages: MESSAGES });
    expect(items.map((i) => i.key)).toEqual(['m:m2', 'm:m1']);
    expect(items[1].title).toBe('Penny: The launch slipped a day.');
    expect(items[1].detail).toBe('The vendor missed the build.');
    expect(waitingCount(items)).toBe(2);
    expect(inboxBadge({ pendingApprovals: 1, heldActions: 0, pendingPlans: 0, openIncidents: 0, myTasks: 0, unreadMessages: 2 })).toBe(3);
    expect(messagesList(MESSAGES).map((i) => i.refId)).toEqual(['m2', 'm1', 'm3']);
  });
});

describe('the Messages filter', () => {
  it('lists every message unread first with urgency; opening one opens the direct chat and marks it read', async () => {
    fake.inboxFilter = 'messages';
    render(<InboxView />);
    const list = await screen.findByTestId('messages-list');
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(3));
    expect(screen.getByRole('tab', { name: 'Messages · 2' })).toBeInTheDocument();
    const urgent = within(list).getByTestId('inbox-item-m:m2');
    expect(within(urgent).getByTestId('message-urgency')).toHaveTextContent('urgent');
    expect(within(urgent).getByTestId('message-unread')).toBeInTheDocument();
    expect(within(within(list).getByTestId('inbox-item-m:m3')).queryByTestId('message-unread')).toBeNull();
    fireEvent.click(within(list).getByTestId('inbox-item-m:m1'));
    expect(fake.openSession).toHaveBeenCalledWith('s1');
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/workspaces/ws1/inbox/messages/read', body: { sessionId: 's1' } }));
    expect(within(within(list).getByTestId('inbox-item-m:m1')).queryByTestId('message-unread')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Messages · 1' })).toBeInTheDocument();
  });
  it('shows unread messages in All', async () => {
    render(<InboxView />);
    const list = await screen.findByTestId('inbox-list');
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(2));
    expect(screen.getByText('2 waiting on you')).toBeInTheDocument();
  });
});

function home(messages: HomeData['messages']): HomeData {
  return {
    workspaceId: 'ws1', generatedAt: '2026-11-02T12:00:00Z', since: '2026-11-02T00:00:00Z', firstVisit: false, company: null,
    headline: { tasksDone: 0, needsYou: 0, todayUsd: null, monthUsd: null, monthCapUsd: null }, needs: [],
    recap: { tasksDone: 0, tasksBlocked: 0, decisions: [], decisionsCount: 0, people: [], artifactsChanged: 0, brief: null, pulse: null },
    goals: [], team: [{ id: 'a1', name: 'Penny', emoji: '🤖', colors: '["#111","#222"]', title: '', state: 'idle', doing: '', taskId: null, lastActiveAt: null, lastBeatAt: null, isChief: false, errors: [] }],
    activity: [], spend: { todayUsd: null, monthUsd: null, monthCapUsd: null, projectedUsd: null, forecastState: null, tokens: null },
    health: { status: 'ok', openIncidents: [], providers: [], audit: null }, upcoming: [], artifacts: [], partial: [], messages,
  };
}

describe('Home — Messages from your team', () => {
  it('shows the messages with the unread count, urgency and refs; a row opens its chat; agent text stays text', () => {
    const onMessage = vi.fn();
    const items = [msg({ id: 'h1', text: '<img src=x onerror=alert(1)> **bold?**', urgency: 'urgent', refs: ['OPS-1', '/org/a.md'] }), msg({ id: 'h2', read: true })];
    render(<HomeBoard data={home({ items, unread: 1 })} narrow={false} wide={false} now={new Date('2026-11-02T12:00:00Z')} onAct={vi.fn()} onOpen={vi.fn()} onAllAgents={vi.fn()} onMessage={onMessage} />);
    const block = screen.getByTestId('home-messages');
    expect(within(block).getByRole('heading')).toHaveTextContent('Messages from your team');
    expect(block).toHaveTextContent('1');
    const row = within(block).getByTestId('home-message-h1');
    expect(row).toHaveTextContent('<img src=x onerror=alert(1)> **bold?**');
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('strong')).toBeNull();
    expect(within(row).getByTestId('home-message-urgency')).toHaveTextContent(/urgent/i);
    expect(within(row).getByTestId('home-message-unread')).toBeInTheDocument();
    expect(row).toHaveTextContent('OPS-1, /org/a.md');
    expect(within(within(block).getByTestId('home-message-h2')).queryByTestId('home-message-unread')).toBeNull();
    fireEvent.click(row);
    expect(onMessage).toHaveBeenCalledWith(items[0]);
  });
  it('is absent when nobody wrote, and opens the chat through onOpen without a handler', () => {
    const { unmount } = render(<HomeBoard data={home({ items: [], unread: 0 })} narrow={false} wide={false} onAct={vi.fn()} onOpen={vi.fn()} onAllAgents={vi.fn()} />);
    expect(screen.queryByTestId('home-messages')).toBeNull();
    unmount();
    const onOpen = vi.fn();
    render(<HomeBoard data={home({ items: [msg({ id: 'h3', sessionId: 's9' })], unread: 1 })} narrow={false} wide={false} onAct={vi.fn()} onOpen={onOpen} onAllAgents={vi.fn()} />);
    fireEvent.click(screen.getByTestId('home-message-h3'));
    expect(onOpen).toHaveBeenCalledWith({ to: 'chat', sessionId: 's9' });
  });
});
