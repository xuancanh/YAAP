/** The Home rail (docs/chat-archiving.md "The rail"): agent groups collapsed
 *  by default except the open chat's group and groups with unread activity or
 *  an approval; the header's badges and count; collapse kept per viewer;
 *  "Show more" pages; no work-session rows — one "Work log" row per agent,
 *  badged when a run waits on an approval (docs/work-log.md); Collapse
 *  all / Expand all; search reaches collapsed groups and opens them; the
 *  archive pages too. And the chat header's auto-archive control and the
 *  agent Settings default. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRailGroup, ChatSession } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { HomeRail } = await import('../src/components/Rails');
const { AutoArchiveMenu, AgentAutoArchiveCard } = await import('../src/components/ChatAutoArchive');

const KEY = 'yaam-rail-groups';
let storage: Record<string, string> = {};

function chat(id: string, agentId: string | null, name: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id, workspaceId: 'ws1', agentId, agentTypeId: null, name, autoTitle: '', cwd: null, model: '', thinkingEffort: 'off', permissionMode: 'ask',
    pinned: 0, tags: '[]', archivedAt: null, draft: '', tokenCeiling: 0, compactSummary: '', compactCutoff: null, tokensIn: 0, tokensOut: 0,
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...extra,
  };
}
const agent = (id: string, name: string) => ({ id, name, emoji: '🤖', colors: '["#000","#fff"]', role: '', charter: '', provider: 'anthropic', model: '', homeDir: null, workspaceFolder: '', dashboard: '', loops: '[]', apps: '[]', createdAt: '' });

function group(agentId: string | null, n: number, extra: Partial<ChatRailGroup> = {}): ChatRailGroup {
  const items = Array.from({ length: Math.min(5, n) }, (_, i) => chat(`${agentId ?? 'ws'}-${i}`, agentId, `${agentId ?? 'ws'} chat ${i}`));
  return { agentId, total: n, items, nextCursor: n > 5 ? 'c1' : null, approvalIds: [], work: { total: 0, approvalIds: [] }, ...extra };
}

const fetchCalls: string[] = [];
let searchResult: unknown = { groups: [], archivedTotal: 0 };

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  storage = {};
  fetchCalls.length = 0;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify(String(url).includes('/api/chats/rail') ? searchResult : []), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', agents: [agent('a1', 'Jong'), agent('a2', 'Mai'), agent('a3', 'Quinn')],
    chatRail: [group('a1', 12), group('a2', 3), group('a3', 2)],
    unread: {}, sessions: [], currentId: null, homeView: 'chat', selectedAgent: null,
    archived: [], archivedTotal: 0, archivedHasMore: false,
    channels: [], currentChannel: null, me: null, nameOf: (x: string) => x,
    loadMoreChats: vi.fn(async () => undefined), loadMoreArchived: vi.fn(async () => undefined),
    restoreChat: vi.fn(), newChat: vi.fn(), openAgent: vi.fn(), openSession: vi.fn(), openWorkLog: vi.fn(), setNewAgentOpen: vi.fn(),
    refreshChannels: vi.fn(), openChannel: vi.fn(), showToast: vi.fn(), patchSession: vi.fn(async () => undefined), refreshAgents: vi.fn(async () => undefined),
    width: 1200,
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const groupEl = (key: string) => screen.getByTestId(`rail-group-${key}`);
const rows = (key: string) => within(groupEl(key)).queryAllByText(/chat \d+$/);

describe('the Home rail', () => {
  it('collapses every agent group by default and shows the count on the header', () => {
    render(<HomeRail />);
    for (const k of ['a1', 'a2', 'a3']) expect(rows(k)).toHaveLength(0);
    expect(within(groupEl('a1')).getByTitle('12 chats')).toHaveTextContent('12');
    expect(within(groupEl('a1')).getByRole('button', { name: 'Expand Jong' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the open chat\'s group and groups with unread activity or an approval', () => {
    fake.sessions = [chat('a2-1', 'a2', 'a2 chat 1')];
    fake.currentId = 'a2-1';
    fake.unread = { a3: 2 };
    fake.chatRail = [group('a1', 12, { approvalIds: ['a1-0'] }), group('a2', 3), group('a3', 2)];
    render(<HomeRail />);
    expect(rows('a1')).toHaveLength(5);
    expect(rows('a2')).toHaveLength(3);
    expect(rows('a3')).toHaveLength(2);
    expect(within(groupEl('a3')).getByTitle(/Unread activity/)).toHaveTextContent('2');
    expect(within(groupEl('a1')).getByTitle('1 chat(s) waiting on your approval')).toHaveTextContent('1');
    expect(within(groupEl('a1')).getAllByLabelText('Waiting on your approval')).toHaveLength(1);
  });

  it('keeps the viewer\'s collapse choice in localStorage and reads it back', () => {
    const { unmount } = render(<HomeRail />);
    fireEvent.click(within(groupEl('a2')).getByRole('button', { name: 'Expand Mai' }));
    expect(rows('a2')).toHaveLength(3);
    expect(JSON.parse(storage[KEY])).toEqual({ a2: true });
    unmount();
    render(<HomeRail />);
    expect(rows('a2')).toHaveLength(3);
    expect(rows('a1')).toHaveLength(0);
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => undefined });
    render(<HomeRail />);
    fireEvent.click(within(groupEl('a1')).getByRole('button', { name: 'Expand Jong' }));
    expect(rows('a1')).toHaveLength(5);
  });

  it('shows the five newest, then "Show more (N)" loads the next page', () => {
    storage[KEY] = JSON.stringify({ a1: true });
    render(<HomeRail />);
    expect(rows('a1')).toHaveLength(5);
    fireEvent.click(within(groupEl('a1')).getByRole('button', { name: 'Show more (7)' }));
    expect(fake.loadMoreChats).toHaveBeenCalledWith('a1');
    // a group with nothing more shows no button
    storage[KEY] = JSON.stringify({ a2: true });
    cleanup();
    render(<HomeRail />);
    expect(within(groupEl('a2')).queryByRole('button', { name: /Show more/ })).toBeNull();
  });

  it('lists conversations only: the agent runs are one "Work log" row, never chat rows', () => {
    storage[KEY] = JSON.stringify({ a1: true });
    fake.chatRail = [group('a1', 2, { work: { total: 7, approvalIds: [] } })];
    render(<HomeRail />);
    const g = groupEl('a1');
    expect(within(g).queryByText('Heartbeat runs')).toBeNull();
    expect(within(g).queryByText(/^Loop · /)).toBeNull();
    expect(rows('a1')).toHaveLength(2);
    fireEvent.click(within(g).getByTestId('rail-worklog-a1'));
    expect(fake.openWorkLog).toHaveBeenCalledWith('a1');
    expect(fake.openSession).not.toHaveBeenCalled();
  });

  it('a run waiting on an approval badges the agent and opens its group, without a chat row', () => {
    fake.chatRail = [group('a1', 2, { work: { total: 3, approvalIds: ['run-1'] } }), group('a2', 3)];
    render(<HomeRail />);
    const g = groupEl('a1');
    expect(within(g).getByTitle(/1 waiting on your approval \(1 in its Work log\)/)).toHaveTextContent('1');
    expect(rows('a1')).toHaveLength(2);
    expect(within(g).getByLabelText('A run is waiting on your approval')).toBeInTheDocument();
    expect(rows('a2')).toHaveLength(0);
  });

  it('Collapse all / Expand all sets every group and persists', () => {
    fake.unread = { a1: 1 };
    render(<HomeRail />);
    expect(rows('a1')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    for (const k of ['a1', 'a2', 'a3']) expect(rows(k)).toHaveLength(0);
    expect(JSON.parse(storage[KEY])).toEqual({ a1: false, a2: false, a3: false });
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(rows('a2')).toHaveLength(3);
    expect(rows('a3')).toHaveLength(2);
  });

  it('search asks the server, finds chats in collapsed groups and opens them', async () => {
    searchResult = { groups: [group('a3', 1, { items: [chat('deep', 'a3', 'Quarterly close notes')] })], archivedTotal: 0 };
    render(<HomeRail />);
    expect(screen.queryByText('Quarterly close notes')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'quarterly' } });
    await waitFor(() => expect(screen.getByText('Quarterly close notes')).toBeInTheDocument());
    expect(fetchCalls.some((u) => u.includes('/api/chats/rail?') && u.includes('q=quarterly'))).toBe(true);
    expect(screen.queryByTestId('rail-group-a2')).toBeNull();
    fireEvent.click(screen.getByText('Quarterly close notes'));
    expect(fake.openSession).toHaveBeenCalledWith('deep');
    // clearing the search returns to the collapsed rail
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText('Quarterly close notes')).toBeNull());
  });

  it('pages the archive the same way', () => {
    fake.archived = [chat('x1', 'a1', 'Old task chat', { archivedAt: '2026-10-01T00:00:00Z' })];
    fake.archivedTotal = 25;
    fake.archivedHasMore = true;
    render(<HomeRail />);
    fireEvent.click(screen.getByText('Archived'));
    expect(screen.getByText('Old task chat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more (24)' }));
    expect(fake.loadMoreArchived).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(fake.restoreChat).toHaveBeenCalledWith('x1');
  });
});

describe('auto-archive controls', () => {
  it('the chat header offers Off / 1 / 3 / 7 / 14 / 30 days for a task chat only', async () => {
    const { container } = render(<AutoArchiveMenu s={chat('c1', 'a1', 'plain')} />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    render(<AutoArchiveMenu s={chat('c2', 'a1', 'task chat', { taskKind: 'org', taskId: 't1', autoArchiveDays: null })} />);
    const select = screen.getByLabelText('Auto-archive after the task is done') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['Default', 'Off', '1 day after done', '3 days after done', '7 days after done', '14 days after done', '30 days after done']);
    expect(select.value).toBe('');
    await act(async () => { fireEvent.change(select, { target: { value: '14' } }); });
    expect(fake.patchSession).toHaveBeenCalledWith('c2', { autoArchiveDays: 14 });
    await act(async () => { fireEvent.change(select, { target: { value: '0' } }); });
    expect(fake.patchSession).toHaveBeenCalledWith('c2', { autoArchiveDays: 0 });
    await act(async () => { fireEvent.change(select, { target: { value: '' } }); });
    expect(fake.patchSession).toHaveBeenLastCalledWith('c2', { autoArchiveDays: null });
  });

  it('the agent Settings field saves the default its task chats start with', async () => {
    render(<AgentAutoArchiveCard a={{ ...agent('a1', 'Jong'), chatAutoArchiveDays: 3 }} />);
    const select = screen.getByLabelText("Auto-archive Jong's task chats") as HTMLSelectElement;
    expect(select.value).toBe('3');
    await act(async () => { fireEvent.change(select, { target: { value: '' } }); });
    const patch = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]) === '/api/agents/a1');
    expect(patch).toBeTruthy();
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ chatAutoArchiveDays: null });
    await waitFor(() => expect(fake.refreshAgents).toHaveBeenCalled());
  });
});
