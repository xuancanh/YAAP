/** The top bar (docs/home.md "Top bar"): per mode (a company, no company, a
 *  phone), the switcher lists workspaces with their state and switches, the
 *  kill switch confirms, the live runs open their sessions, the command
 *  palette finds and runs (and opens on ⌘K / Ctrl+K), and the bell groups,
 *  filters, marks read and deep-links. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationsPage, TopNotification, WorkspaceStatus } from '../src/lib/api';
import type { WorkspaceEntry } from '../src/store';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
// The first render pays for the bar's imports; a loaded machine needs the slack.
vi.setConfig({ testTimeout: 20_000 });

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
vi.mock('../src/auth', () => ({ useAuth: () => ({ mode: 'single', authenticated: true, account: null, offline: false, refresh: async () => undefined, signOut: async () => undefined }) }));

const { TopBar, TopBarView, NotificationsPanel } = await import('../src/components/TopBar');
const { CommandPalette } = await import('../src/components/CommandPalette');
const { api } = await import('../src/lib/api');
const lib = await import('../src/lib/topbar');

const NOW = new Date('2026-11-04T10:00:00');
const iso = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

const ws = (over: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({
  id: 'ws1', name: 'Acme', color: '#8b8cf0', memory: '', profile: '', profilePending: '[]', quietHours: '', spendBudgetTokens: 0, spendMonth: '', spendTokens: 0,
  orgMode: 'autonomous', chiefOfStaffAgentId: null, orgMonthlyUsd: 0, orgAgentCap: 12, createdAt: '', ...over,
} as WorkspaceEntry);

const status = (over: Partial<WorkspaceStatus> = {}): WorkspaceStatus => ({
  workspaceId: 'ws1', generatedAt: NOW.toISOString(),
  company: { name: 'Acme', mode: 'autonomous', status: 'active' },
  needsYou: 3, urgent: 1,
  spend: { todayUsd: 4.2, monthUsd: 12.4, monthCapUsd: 20, projectedUsd: 24, forecastState: 'stop' },
  agents: { total: 5, working: 3, failing: 1, faces: [{ id: 'w', name: 'Writer', emoji: '✍️', colors: '[]', state: 'error' }, { id: 'c', name: 'Chief', emoji: '🧭', colors: '[]', state: 'working' }] },
  live: [{ sessionId: 's1', agentId: 'c', agentName: 'Chief', origin: 'loop', sessionName: 'Loop · heartbeat', startedAt: iso(-3), toolLabel: 'writing reports/weekly.md' }],
  nextMeeting: { id: 'meeting:m1', title: 'Standup', at: iso(12), meetingId: 'm1' },
  partial: [],
  ...over,
});

const note = (over: Partial<TopNotification> = {}): TopNotification => ({
  id: 'event:e1', kind: 'message', title: 'Chief wrote to you', body: '', at: iso(-30), severity: 'normal', read: false, waiting: false,
  deadline: null, expiresSoon: false, from: 'Chief', agentId: 'c', target: { to: 'chat', sessionId: 'dm1' }, ...over,
});

const page = (): NotificationsPage => ({
  generatedAt: NOW.toISOString(), unread: 3,
  items: [
    note({ id: 'need:approval:a1', kind: 'decision', title: 'Ana as Researcher', waiting: true, deadline: iso(90), expiresSoon: true, at: iso(-120), target: { to: 'need', need: { kind: 'approval', ref: { approvalId: 'a1' } } } }),
    note(),
    note({ id: 'event:e2', kind: 'run_failed', title: 'Heartbeat failed', from: 'Writer', at: iso(-60 * 30), severity: 'high', read: true, target: { to: 'agent', agentId: 'w' } }),
    note({ id: 'event:e3', kind: 'mention', title: '#general · Ann mentioned you', from: '#general', at: iso(-60 * 26), target: { to: 'hash', hash: '#/ws/ws1/channel/general/m9' } }),
  ],
});

function view(over: Partial<Parameters<typeof TopBarView>[0]> = {}) {
  const cb = {
    onOpenSwitcher: vi.fn(), onPickWorkspace: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onSpend: vi.fn(), onAgents: vi.fn(), onFailing: vi.fn(),
    onRun: vi.fn(), onMeeting: vi.fn(), onOpenNotification: vi.fn(), onMarkRead: vi.fn(), onMarkAllRead: vi.fn(), onInbox: vi.fn(), onSearch: vi.fn(),
    onCreate: vi.fn(), onToggleTheme: vi.fn(), onSettings: vi.fn(), onSignOut: vi.fn(),
  };
  render(<TopBarView now={NOW} phone={false} width={1512} theme="dark" workspace={ws()} workspaces={[ws(), ws({ id: 'ws2', name: 'Side project', color: '#4bd6a0', orgMode: 'off' })]}
    rows={null} status={status()} notifications={page()} canPause orgOn account={{ name: 'Linh', email: 'linh@example.com' }} canSignOut={false} {...cb} {...over} />);
  return cb;
}

describe('the top bar per mode', () => {
  it('a company: the mode chip and the status strand — run state, spend, agents, live runs, the next meeting', () => {
    view();
    expect(screen.getByTestId('top-bar')).toHaveAttribute('data-mode', 'company');
    expect(screen.getByTestId('mode-chip')).toHaveTextContent('Autonomous');
    const strand = screen.getByTestId('strand');
    expect(within(strand).getByRole('button', { name: /pause the company/i })).toHaveTextContent('Running');
    expect(screen.getByTestId('spend')).toHaveAttribute('data-tone', 'over');
    expect(screen.getByTestId('spend')).toHaveTextContent('$4.20');
    expect(within(strand).getByRole('button', { name: /3 of 5 agents working/ })).toBeInTheDocument();
    expect(screen.getByTestId('failing')).toHaveTextContent('1 failing');
    expect(screen.getByTestId('live-runs')).toHaveTextContent('1');
    expect(screen.getByTestId('next-meeting')).toHaveTextContent('Standup');
    expect(screen.getByTestId('next-meeting')).toHaveTextContent('in 12 min');
    expect(screen.getByTestId('bell-count')).toHaveTextContent('3');
  });

  it('the failing count opens mission control; spend and the meeting open their panes', () => {
    const cb = view();
    fireEvent.click(screen.getByTestId('failing'));
    fireEvent.click(screen.getByTestId('spend'));
    fireEvent.click(screen.getByTestId('next-meeting'));
    expect(cb.onFailing).toHaveBeenCalled(); expect(cb.onSpend).toHaveBeenCalled(); expect(cb.onMeeting).toHaveBeenCalled();
  });

  it('no company: no chips, no run state or spend — the live runs, search, create, the bell and the account stay', () => {
    view({ workspace: ws({ orgMode: 'off' }), orgOn: false, status: status({ company: null, spend: null, nextMeeting: null }) });
    expect(screen.getByTestId('top-bar')).toHaveAttribute('data-mode', 'plain');
    expect(screen.queryByTestId('mode-chip')).toBeNull();
    expect(screen.queryByRole('button', { name: /pause the company/i })).toBeNull();
    expect(screen.queryByTestId('spend')).toBeNull();
    expect(screen.queryByTestId('failing')).toBeNull();
    expect(screen.queryByTestId('next-meeting')).toBeNull();
    expect(screen.getByTestId('live-runs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search and commands' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Notifications/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account and preferences' })).toBeInTheDocument();
  });

  it('a narrower window keeps the run state and the live runs, and drops the meeting first', () => {
    view({ width: 1100 });
    expect(screen.queryByTestId('next-meeting')).toBeNull();
    expect(screen.getByTestId('spend')).toBeInTheDocument();
    cleanup();
    view({ width: 900 });
    expect(screen.queryByTestId('spend')).toBeNull();
    expect(screen.getByTestId('live-runs')).toBeInTheDocument();
  });

  it('a phone: the switcher, search, the bell and the overflow menu carry the strand', () => {
    const cb = view({ phone: true, width: 390 });
    expect(screen.queryByTestId('strand')).toBeNull();
    expect(screen.queryByTestId('mode-chip')).toBeNull();
    expect(screen.getByRole('button', { name: /Workspace: Acme/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const more = screen.getByRole('menu', { name: 'More' });
    expect(within(more).getByText('Spend today')).toBeInTheDocument();
    expect(within(more).getByText('Failing')).toBeInTheDocument();
    fireEvent.click(within(more).getByText('Failing'));
    expect(cb.onFailing).toHaveBeenCalled();
  });
});

describe('the switcher', () => {
  it('lists the workspaces with each company\'s state and what needs you, and switches', () => {
    const cb = view({ rows: { ws1: { workspaceId: 'ws1', company: { name: 'Acme', mode: 'autonomous', status: 'active' }, needsYou: 3, unread: 2 }, ws2: { workspaceId: 'ws2', company: null, needsYou: 0, unread: 4 } } });
    fireEvent.click(screen.getByRole('button', { name: /Workspace: Acme/ }));
    expect(cb.onOpenSwitcher).toHaveBeenCalled();
    const menu = screen.getByRole('menu', { name: 'Workspaces' });
    expect(within(menu).getByText('Running · Autonomous · 3 need you')).toBeInTheDocument();
    expect(within(menu).getByText('No company')).toBeInTheDocument();
    fireEvent.click(within(menu).getByText('Side project'));
    expect(cb.onPickWorkspace).toHaveBeenCalledWith('ws2');
  });

  it('a paused company reads Paused; New workspace opens the wizard', () => {
    const cb = view({ rows: { ws1: { workspaceId: 'ws1', company: { name: 'Acme', mode: 'supervised', status: 'paused' }, needsYou: 0, unread: 0 } } });
    fireEvent.click(screen.getByRole('button', { name: /Workspace: Acme/ }));
    expect(screen.getByText('Paused · Supervised')).toBeInTheDocument();
    fireEvent.click(screen.getByText('New workspace or company'));
    expect(cb.onCreate).toHaveBeenCalledWith('workspace');
  });
});

describe('pause and resume', () => {
  it('asks before pausing; Cancel does nothing', async () => {
    const cb = view();
    fireEvent.click(screen.getByRole('button', { name: /pause the company/i }));
    const dialog = screen.getByRole('dialog', { name: 'Pause the company' });
    expect(within(dialog).getByText('Pause Acme?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText('Cancel'));
    expect(cb.onPause).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /pause the company/i }));
    await act(async () => { fireEvent.click(screen.getByText('Pause company')); });
    expect(cb.onPause).toHaveBeenCalledTimes(1);
  });

  it('a paused company offers Resume; a member who is not the owner cannot press it', async () => {
    const cb = view({ status: status({ company: { name: 'Acme', mode: 'autonomous', status: 'paused' } }) });
    fireEvent.click(screen.getByRole('button', { name: /resume the company/i }));
    await act(async () => { fireEvent.click(screen.getByText('Resume company')); });
    expect(cb.onResume).toHaveBeenCalled();
    cleanup();
    view({ canPause: false });
    expect(screen.getByRole('button', { name: /Only the owner/ })).toBeDisabled();
  });
});

describe('live runs', () => {
  it('opens the list of turns running now; a row opens its session', () => {
    const cb = view();
    fireEvent.click(screen.getByTestId('live-runs'));
    const pop = screen.getByRole('dialog', { name: 'Running now' });
    expect(within(pop).getByText(/Writing reports\/weekly\.md · 3 min/)).toBeInTheDocument();
    fireEvent.click(within(pop).getByText('Chief'));
    expect(cb.onRun).toHaveBeenCalledWith('s1');
  });

  it('the stream\'s count wins until the status reloads; none running hides it', () => {
    view({ liveCount: 3 });
    expect(screen.getByTestId('live-runs')).toHaveTextContent('3');
    cleanup();
    view({ liveCount: 0 });
    expect(screen.queryByTestId('live-runs')).toBeNull();
  });
});

describe('the bell', () => {
  const panel = (over: Partial<Parameters<typeof NotificationsPanel>[0]> = {}) => {
    const cb = { onOpen: vi.fn(), onMarkRead: vi.fn(), onMarkAllRead: vi.fn(), onInbox: vi.fn() };
    render(<NotificationsPanel page={page()} now={NOW} orgOn {...cb} {...over} />);
    return cb;
  };

  it('groups waiting on you, today and earlier; a card expiring soon says so', () => {
    panel();
    const groups = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(groups).toEqual(['Waiting on you', 'Today', 'Earlier']);
    const waiting = screen.getByRole('region', { name: 'Waiting on you' });
    expect(within(waiting).getByText('Ana as Researcher')).toBeInTheDocument();
    expect(within(waiting).getByTestId('expires')).toHaveTextContent('Expires in 2 h');
    expect(within(screen.getByRole('region', { name: 'Earlier' })).getByText('Heartbeat failed')).toBeInTheDocument();
  });

  it('filters: waiting, messages (mentions too), runs', () => {
    panel();
    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
    expect(screen.queryByText('Ana as Researcher')).toBeNull();
    expect(screen.getByText('Chief wrote to you')).toBeInTheDocument();
    expect(screen.getByText('#general · Ann mentioned you')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
    expect(screen.getByText('Heartbeat failed')).toBeInTheDocument();
    expect(screen.queryByText('Chief wrote to you')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Waiting on you' }));
    expect(screen.getByText('Ana as Researcher')).toBeInTheDocument();
  });

  it('marks one read, marks all read, opens a row and the Inbox', () => {
    const cb = panel();
    fireEvent.click(screen.getByRole('button', { name: 'Mark read: Chief wrote to you' }));
    expect(cb.onMarkRead).toHaveBeenCalledWith(['event:e1']);
    expect(screen.queryByRole('button', { name: 'Mark read: Heartbeat failed' })).toBeNull();
    fireEvent.click(screen.getByText('Mark all read'));
    expect(cb.onMarkAllRead).toHaveBeenCalled();
    fireEvent.click(screen.getByText('#general · Ann mentioned you'));
    expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'event:e3' }));
    fireEvent.click(screen.getByText('Open Inbox'));
    expect(cb.onInbox).toHaveBeenCalled();
  });

  it('an empty bell says so', () => {
    panel({ page: { generatedAt: NOW.toISOString(), unread: 0, items: [] } });
    expect(screen.getByText(/all caught up/)).toBeInTheDocument();
    expect(screen.queryByText('Mark all read')).toBeNull();
  });

  it('deep links: a card goes where Home sends it, an event to its chat, link or agent', () => {
    const [card, msg, run, mention] = page().items;
    expect(lib.notificationTarget(card)).toEqual({ to: 'inbox' });
    expect(lib.notificationTarget(note({ target: { to: 'need', need: { kind: 'incident', ref: { incidentId: 'i1' } } } }))).toEqual({ to: 'pane', pane: 'incidents', focus: { kind: 'incident', id: 'i1' } });
    expect(lib.notificationTarget(msg)).toEqual({ to: 'chat', sessionId: 'dm1' });
    expect(lib.notificationTarget(run)).toEqual({ to: 'agent', agentId: 'w' });
    expect(lib.notificationTarget(mention)).toEqual({ to: 'hash', hash: '#/ws/ws1/channel/general/m9' });
  });
});

describe('the command palette', () => {
  type It = { id: string; group: 'Actions' | 'Go to' | 'Agents' | 'Tasks' | 'Files'; label: string; hint?: string; keywords?: string };
  const items: It[] = [
    { id: 'new-chat', group: 'Actions', label: 'New chat' },
    { id: 'pause', group: 'Actions', label: 'Pause the company', keywords: 'kill switch stop' },
    { id: 'go-home', group: 'Go to', label: 'Home' },
    { id: 'agent:w', group: 'Agents', label: 'Writer' },
    { id: 'agent:c', group: 'Agents', label: 'Chief of staff' },
  ];

  it('with no query, actions and places; typing finds agents; keywords match; Enter runs the pick', () => {
    const onRun = vi.fn(); const onClose = vi.fn();
    render(<CommandPalette items={items} onRun={onRun} onClose={onClose} />);
    const opts = () => screen.getAllByRole('option').map((o) => o.textContent);
    expect(opts()).toEqual(['New chat', 'Pause the company', 'Home']);
    const box = screen.getByRole('combobox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'wri' } });
    expect(opts()).toEqual(['Writer']);
    fireEvent.change(box, { target: { value: 'kill' } });
    expect(opts()).toEqual(['Pause the company']);
    fireEvent.change(box, { target: { value: 'ch' } });
    expect(opts()).toEqual(['New chat', 'Pause the company', 'Chief of staff']);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onClose).toHaveBeenCalled();
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent:c' }));
  });

  it('a task key gets its own row first; the server\'s results join after a pause; nothing found says how to search', async () => {
    const onRun = vi.fn();
    const remote = vi.fn(async (q: string): Promise<It[]> => (q.startsWith('eng') ? [{ id: 'file:r', group: 'Files', label: 'weekly.md', hint: 'reports/weekly.md', keywords: q }] : []));
    render(<CommandPalette items={items} onRun={onRun} onClose={() => undefined} remoteDelay={0}
      extra={(q) => (/^[a-z]+-\d+$/i.test(q) ? [{ id: `task:${q}`, group: 'Tasks', label: `Open task ${q.toUpperCase()}` }] : [])} remote={remote} />);
    const box = screen.getByRole('combobox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'eng-12' } });
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Open task ENG-12');
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(remote).toHaveBeenCalledWith('eng-12');
    expect(screen.getByText('weekly.md')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'zzzz' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/Nothing matches “zzzz”/)).toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();
  });

  it('Escape closes it', () => {
    const onClose = vi.fn();
    render(<CommandPalette items={items} onRun={() => undefined} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the connected bar', () => {
  beforeEach(() => {
    for (const k of Object.keys(fake)) delete fake[k];
    Object.assign(fake, {
      workspaceId: 'ws1', workspaces: [ws()], stacked: false, width: 1512, theme: 'dark', companiesEnabled: true,
      wsOrg: { mode: 'autonomous', orgStatus: 'active' }, me: { role: 'owner' }, agents: [{ id: 'w', name: 'Writer', role: 'writer' }], channels: [{ id: 'ch', slug: 'general', name: 'general' }], sessions: [],
      onWorkspaceEvent: () => () => undefined, openAgent: vi.fn(), openOrgTask: vi.fn(), showToast: vi.fn(), go: vi.fn(), toggleTheme: vi.fn(),
      setOrgFocus: vi.fn(), setOrgUnitId: vi.fn(), setOrgPane: vi.fn(), setMobileDetail: vi.fn(), refreshWsOrg: vi.fn(async () => undefined), openSession: vi.fn(), openChannel: vi.fn(), openFile: vi.fn(),
    });
    vi.spyOn(api, 'workspaceStatus').mockResolvedValue(status());
    vi.spyOn(api, 'notifications').mockResolvedValue(page());
    vi.spyOn(api, 'search').mockResolvedValue({ sessions: [], messages: [], files: [] });
  });

  it('⌘K / Ctrl+K opens the palette; an agent opens its page; a task key resolves to the task', async () => {
    vi.spyOn(api, 'orgTask').mockResolvedValue({ id: 'task-1' } as never);
    await act(async () => { render(<TopBar onSettings={() => undefined} />); });
    expect(screen.queryByRole('dialog', { name: 'Search and commands' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const box = screen.getByRole('combobox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'writ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(fake.openAgent).toHaveBeenCalledWith('w');
    expect(screen.queryByRole('dialog', { name: 'Search and commands' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByRole('combobox', { name: 'Search' }), { target: { value: 'eng-12' } });
    await act(async () => { fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search' }), { key: 'Enter' }); });
    expect(api.orgTask).toHaveBeenCalledWith('ws1', 'ENG-12');
    expect(fake.openOrgTask).toHaveBeenCalledWith('task-1');
  });

  it('failing opens mission control on the error filter; opening a notification marks it read', async () => {
    const mark = vi.spyOn(api, 'markNotificationsRead').mockResolvedValue({ ok: true, marked: 1 });
    await act(async () => { render(<TopBar onSettings={() => undefined} />); });
    fireEvent.click(screen.getByTestId('failing'));
    expect(fake.setOrgFocus).toHaveBeenCalledWith({ kind: 'mission', id: 'error' });
    expect(fake.setOrgPane).toHaveBeenCalledWith('chart');
    fireEvent.click(screen.getByRole('button', { name: /Notifications, 3 unread/ }));
    await act(async () => { fireEvent.click(screen.getByText('Chief wrote to you')); });
    expect(mark).toHaveBeenCalledWith('ws1', { ids: ['event:e1'] });
    expect(fake.openSession).toHaveBeenCalledWith('dm1');
  });
});

describe('pure helpers', () => {
  it('spend tone and the meter', () => {
    expect(lib.spendTone({ todayUsd: 1, monthUsd: 5, monthCapUsd: 20, projectedUsd: 10, forecastState: 'onTrack' })).toBe('ok');
    expect(lib.spendTone({ todayUsd: 1, monthUsd: 5, monthCapUsd: 20, projectedUsd: 18, forecastState: 'warn' })).toBe('warn');
    expect(lib.spendTone({ todayUsd: 1, monthUsd: 20, monthCapUsd: 20, projectedUsd: 30, forecastState: 'warn' })).toBe('over');
    expect(lib.spendMeter({ todayUsd: 1, monthUsd: 5, monthCapUsd: 20, projectedUsd: 30, forecastState: 'stop' })).toEqual({ spent: 0.25, forecast: 1 });
    expect(lib.spendMeter({ todayUsd: 1, monthUsd: 5, monthCapUsd: null, projectedUsd: null, forecastState: null })).toBeNull();
  });
  it('the meeting and run times in words', () => {
    expect(lib.meetingWhen(iso(12), NOW)).toBe('in 12 min');
    expect(lib.meetingWhen(iso(125), NOW)).toBe('in 2 h 5 min');
    expect(lib.meetingWhen(iso(-1), NOW)).toBe('now');
    expect(lib.elapsed(iso(-0.5), NOW)).toBe('30 s');
    expect(lib.elapsed(iso(-70), NOW)).toBe('1 h 10 min');
  });
  it('the shortcut is ⌘K or Ctrl+K, nothing else', () => {
    expect(lib.isPaletteShortcut({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(lib.isPaletteShortcut({ key: 'K', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false })).toBe(true);
    expect(lib.isPaletteShortcut({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false);
    expect(lib.isPaletteShortcut({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe(false);
  });
  it('match scores rank the start over a word over anywhere over letters in order', () => {
    expect(lib.matchScore('Writer', 'wri')).toBe(3);
    expect(lib.matchScore('Chief of staff', 'sta')).toBe(2);
    expect(lib.matchScore('Researcher', 'arch')).toBe(1);
    expect(lib.matchScore('Mission control', 'mctl')).toBe(0.5);
    expect(lib.matchScore('Writer', 'xyz')).toBe(0);
  });
});
