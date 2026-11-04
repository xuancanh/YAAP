/** Messages from your team (docs/agent-messages.md): the Inbox's Mentions
 *  tab lists them from the owner's feed (the same rows as the bell; opening
 *  one opens the direct chat and marks the chat read), and Home's "Messages
 *  from your team" block — agent text shown as text, never markup. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, HomeData } from '../src/lib/api';
import { HomeBoard } from '../src/components/HomeBoard';
import { primeFeed } from '../src/lib/feed-store';
import { feedItem, feedPage } from './feed-fixtures';

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

/** The feed's message rows: the server lists them in Mentions (docs/owners-seat.md). */
const FEED = feedPage([
  feedItem({ id: 'event:e2', ids: ['event:e2'], title: 'Site is down', severity: 'high', at: '2026-11-02T10:00:00Z', actor: { kind: 'agent', id: 'a2', name: 'Otto', emoji: '🤖', colors: '[]' }, target: { kind: 'chat', sessionId: 's2' }, ref: { sessionId: 's2' } }),
  feedItem({ id: 'event:e1', ids: ['event:e1'], title: 'The launch slipped a day.', body: 'The launch slipped a day.\nThe vendor missed the build.', at: '2026-11-02T08:00:00Z', actor: { kind: 'agent', id: 'a1', name: 'Penny', emoji: '🤖', colors: '[]' }, target: { kind: 'chat', sessionId: 's1' }, ref: { sessionId: 's1' } }),
  feedItem({ id: 'event:e3', ids: ['event:e3'], title: 'Old news', severity: 'low', read: true, at: '2026-11-02T11:00:00Z', actor: { kind: 'agent', id: 'a1', name: 'Penny', emoji: '🤖', colors: '[]' }, target: { kind: 'chat', sessionId: 's1' }, ref: { sessionId: 's1' } }),
]);

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
      : u.endsWith('/inbox/messages') ? { items: MESSAGES, unread: 2 }
      : u.endsWith('/inbox/messages/read') ? { ok: true, marked: 1 }
      : u.includes('/feed/read') ? { ok: true, marked: 1 }
      : u.includes('/feed') ? FEED
      : u.endsWith('/humans/me/tasks') ? { assigned: [], reviewing: [] } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', companiesEnabled: true, wsOrg: { mode: 'supervised', orgId: 'o1', units: [] }, orgHealth: null, orgHeldActions: 0,
    inboxFilter: 'all', setInboxFilter: vi.fn((f: string) => { fake.inboxFilter = f; }), setOrgFocus: vi.fn(), openOrgTask: vi.fn(), openSession: vi.fn(),
    refreshWsOrg: vi.fn(async () => undefined), showToast: vi.fn(), go: vi.fn(), me: { role: 'owner' }, stacked: false,
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('messages in the Inbox', () => {
  it('Mentions lists them with the sender, unread first counted on the tab; opening one opens the direct chat and marks it read', async () => {
    fake.inboxFilter = 'messages';
    render(<InboxView />);
    const list = await screen.findByTestId('inbox-list-mentions');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByTestId('inbox-tab-count-mentions')).toHaveTextContent('2');
    const urgent = within(list).getByTestId('feed-row-event:e2');
    expect(within(urgent).getByTestId('feed-actor')).toHaveTextContent('Otto');
    expect(urgent).toHaveAttribute('data-read', 'false');
    expect(within(list).getByTestId('feed-row-event:e3')).toHaveAttribute('data-read', 'true');
    fireEvent.click(within(within(list).getByTestId('feed-row-event:e1')).getByTestId('feed-open'));
    expect(fake.openSession).toHaveBeenCalledWith('s1');
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/workspaces/ws1/inbox/messages/read', body: { sessionId: 's1' } }));
    expect(posts).toContainEqual({ url: '/api/workspaces/ws1/feed/read', body: { ids: ['event:e1'] } });
    expect(within(list).getByTestId('feed-row-event:e1')).toHaveAttribute('data-read', 'true');
    expect(screen.getByTestId('inbox-tab-count-mentions')).toHaveTextContent('1');
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
