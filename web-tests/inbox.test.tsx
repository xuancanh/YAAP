/** The Inbox (docs/owners-seat.md "Inbox and notifications"): the owner's feed
 *  in full, as two-pane triage — a compact list (urgent first, grouped) and
 *  the reading pane with the whole item and its actions. Tabs Needs you ·
 *  Mentions · Updates · Done carry their counts; chips show only kinds that
 *  have items; the open item is in the address; an escalation is answered in
 *  its box; mark read / mark a tab read / mark everything read and Customize
 *  live in the header menu; empty states; the keyboard (j/k, Enter, o, m, e,
 *  Esc, and a/r only with an item open); the phone opens an item full screen. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedPage } from '../src/lib/api';
import { primeFeed } from '../src/lib/feed-store';
import { inboxGroups, visibleChips, deadlineBadge, defaultLine, askOf, feedFacts } from '../src/lib/feed';
import { feedItem, feedPage, samplePage, NOW, iso } from './feed-fixtures';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { InboxView } = await import('../src/components/InboxView');

/** The store's filter and open item, kept in state so a click re-renders like the real store. */
let bump: () => void = () => undefined;
function Harness() {
  const [, set] = useState(0);
  bump = () => set((n) => n + 1);
  return <InboxView />;
}

const escalation = () => feedItem({
  id: 'need:approval:x1', ids: ['need:approval:x1'], type: 'escalation', section: 'needs', actionable: true, title: 'REJ-4 is stuck waiting on you',
  body: 'Two grants only the CEO can make: a static host and a mailbox.', at: iso(-300), severity: 'high', actor: { kind: 'agent', id: 'hm', name: 'Head of Marketing', emoji: '📣', colors: '[]' },
  context: { taskId: 't4', taskKey: 'REJ-4', taskTitle: 'Landing page' }, target: { kind: 'need', need: { kind: 'escalation', ref: { approvalId: 'x1', taskId: 't4' } } }, actions: ['approve', 'reject'],
  need: { id: 'approval:x1', kind: 'escalation', subkind: 'escalation', title: 'REJ-4 is stuck waiting on you', detail: '', severity: 'high', createdAt: iso(-300), deadline: null, defaultAction: '', recommendation: '', recommendedAction: '', reversibility: '', confidence: null, requestedBy: 'Head of Marketing', ref: { approvalId: 'x1', taskId: 't4' }, actions: ['approve', 'reject'], chain: { line: 'Head of Marketing → Chief → you', hops: [], reserved: '' } },
});

let FEED: FeedPage;
const calls: Array<{ url: string; method: string; body: unknown }> = [];
beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  calls.length = 0;
  FEED = feedPage([
    ...samplePage().items,
    feedItem({ id: 'event:c1', ids: ['event:c1'], type: 'connection_approval', section: 'needs', actionable: true, title: 'Writer asks to run gmail_send with your connection', at: iso(-2), severity: 'high', deadline: iso(8), expiresSoon: true, actions: ['allow', 'deny'], target: { kind: 'chat', sessionId: 's9' }, ref: { agentId: 'w', eventId: 'c1', sessionId: 's9' } }),
    feedItem({ id: 'need:incident:i1', ids: ['need:incident:i1'], type: 'incident', section: 'needs', actionable: true, title: 'Error spike on Writer', at: iso(-5), severity: 'critical', target: { kind: 'need', need: { kind: 'incident', ref: { incidentId: 'i1' } } } }),
  ]);
  primeFeed(null, '');
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const body = u.includes('/feed/types') ? [
      { type: 'follow', label: 'Following', description: 'News on what you follow.', key: 'notify.follow', on: true, default: true },
      { type: 'run_failed', label: 'Run failed', description: 'Failed runs.', key: 'notify.run_failed', on: true, default: true },
    ]
      : u.includes('/feed/read') ? { ok: true, marked: 1 }
      : u.includes('/feed') ? FEED
      : u.includes('/events/c1/decide') ? { resolved: true, decision: 'allow' }
      : u.includes('/org/approvals/') && method === 'POST' ? { approval: { id: 'a1', status: 'approved' } }
      : u.endsWith('/org/tunables') ? { id: 'o1' }
      : u.endsWith('/follows/mine') ? [] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', companiesEnabled: true, wsOrg: { mode: 'supervised', orgId: 'o1', units: [] }, me: { role: 'owner' }, stacked: false, width: 1440,
    inboxFilter: 'all', setInboxFilter: vi.fn((f: string) => { fake.inboxFilter = f; fake.inboxItem = null; bump(); }),
    inboxItem: null, setInboxItem: vi.fn((id: string | null) => { fake.inboxItem = id; bump(); }),
    setOrgFocus: vi.fn(), setOrgUnitId: vi.fn(), setOrgPane: vi.fn(), setMobileDetail: vi.fn(), openOrgTask: vi.fn(), openSession: vi.fn(), openChannel: vi.fn(), openAgent: vi.fn(), go: vi.fn(),
    refreshWsOrg: vi.fn(async () => undefined), showToast: vi.fn(),
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const posts = () => calls.filter((c) => c.method !== 'GET');
const reads = () => posts().filter((c) => c.url.endsWith('/feed/read'));
const rowIds = (list: HTMLElement) => within(list).getAllByRole('listitem').map((r) => r.getAttribute('data-testid'));
const menu = (id: string) => { fireEvent.click(screen.getByTestId('inbox-menu')); fireEvent.click(screen.getByTestId(id)); };

describe('the Inbox', () => {
  it('opens on Needs you: counts on the tabs, urgent first, the first row previewed in the pane (not read)', async () => {
    render(<Harness />);
    const list = await screen.findByTestId('inbox-list-needs');
    expect(screen.getByTestId('inbox-tab-needs')).toHaveAttribute('aria-selected', 'true');
    // Needs you: open items (read or not) — the badge; the rest: unread rows — the bell
    expect(screen.getByTestId('inbox-tab-count-needs')).toHaveTextContent('3');
    expect(screen.getByTestId('inbox-tab-count-mentions')).toHaveTextContent('2');
    expect(screen.getByTestId('inbox-tab-count-updates')).toHaveTextContent('1');
    expect(screen.getByTestId('inbox-counts')).toHaveTextContent('3 need you · 6 unread');
    // all three are urgent (two expire within 6 h, one is critical): soonest deadline first
    expect(screen.getByText('Urgent')).toBeInTheDocument();
    expect(rowIds(list)).toEqual(['feed-row-event:c1', 'feed-row-need:approval:a1', 'feed-row-need:incident:i1']);
    expect(within(screen.getByTestId('feed-row-event:c1')).getByTestId('feed-expires')).toHaveTextContent('8 min left');
    // a preview, not a read: nothing is marked
    expect(within(screen.getByTestId('inbox-pane')).getByTestId('inbox-detail-event:c1')).toBeInTheDocument();
    expect(reads()).toHaveLength(0);
  });

  it('a row opens in the reading pane: in the address, read, with what is asked, the deadline and the default', async () => {
    render(<Harness />);
    await screen.findByTestId('inbox-list-needs');
    fireEvent.click(within(screen.getByTestId('feed-row-need:approval:a1')).getByTestId('feed-open'));
    expect(fake.setInboxItem).toHaveBeenLastCalledWith('need:approval:a1', {});
    const pane = screen.getByTestId('inbox-detail-need:approval:a1');
    expect(within(pane).getByRole('heading', { level: 1 })).toHaveTextContent('Hire Ana as Researcher');
    expect(within(pane).getByTestId('inbox-detail-ask')).toHaveTextContent('needs your yes before the hire goes ahead');
    expect(within(pane).getByTestId('inbox-detail-deadline')).toHaveTextContent(/If you do nothing by .* \(in 1 h 30 min\), it is denied\./);
    await waitFor(() => expect(reads()).toContainEqual(expect.objectContaining({ body: { ids: ['need:approval:a1'] } })));
    expect(screen.getByTestId('feed-row-need:approval:a1')).toHaveAttribute('data-selected', 'true');
  });

  it('decides in the pane: approve leaves the list and the next item opens; allow a connection request', async () => {
    fake.inboxItem = 'need:approval:a1';
    render(<Harness />);
    const pane = await screen.findByTestId('inbox-detail-need:approval:a1');
    FEED = feedPage(FEED.items.filter((i) => i.id !== 'need:approval:a1'));
    await act(async () => { fireEvent.click(within(pane).getByRole('button', { name: /^Approve/ })); });
    expect(posts()).toContainEqual(expect.objectContaining({ url: '/api/workspaces/ws1/org/approvals/a1/decide', body: { decision: 'approve' } }));
    expect(fake.showToast).toHaveBeenCalledWith('Approved');
    expect(fake.setInboxItem).toHaveBeenLastCalledWith('need:incident:i1', { replace: true });
    await waitFor(() => expect(screen.queryByTestId('feed-row-need:approval:a1')).toBeNull());
    fireEvent.click(within(screen.getByTestId('feed-row-event:c1')).getByTestId('feed-open'));
    await act(async () => { fireEvent.click(within(screen.getByTestId('inbox-detail-event:c1')).getByRole('button', { name: /^Allow/ })); });
    expect(posts()).toContainEqual(expect.objectContaining({ url: '/api/agents/w/events/c1/decide', body: { decision: 'allow' } }));
    expect(fake.showToast).toHaveBeenCalledWith('Allowed');
  });

  it('an escalation is a question: the answer goes with "Answer and unblock"; cancelling the task asks to confirm', async () => {
    FEED = feedPage([escalation(), ...FEED.items]);
    fake.inboxItem = 'need:approval:x1';
    render(<Harness />);
    await screen.findByTestId('inbox-list-needs');
    const pane = screen.getByTestId('inbox-detail-need:approval:x1');
    expect(within(pane).getByTestId('feed-route')).toHaveTextContent('Head of Marketing→Chief→you');
    expect(within(pane).getByTestId('inbox-detail-body')).toHaveTextContent('Two grants only the CEO can make');
    const answer = within(pane).getByRole('button', { name: 'Answer and unblock' });
    expect(answer).toBeDisabled();
    // a / r never decide an escalation
    fireEvent.keyDown(screen.getByTestId('inbox-root'), { key: 'a' });
    expect(posts().filter((c) => c.url.includes('/decide'))).toHaveLength(0);
    fireEvent.click(within(pane).getByRole('button', { name: 'Cancel the task' }));
    expect(posts().filter((c) => c.url.includes('/decide'))).toHaveLength(0);
    expect(within(pane).getByRole('button', { name: 'Confirm: cancel REJ-4' })).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole('button', { name: 'Keep it' }));
    fireEvent.click(within(pane).getByTestId('inbox-detail-task'));
    expect(fake.openOrgTask).toHaveBeenCalledWith('t4');
    fireEvent.change(within(pane).getByTestId('inbox-answer'), { target: { value: 'Use GitHub Pages; the mailbox waits a week.' } });
    await act(async () => { fireEvent.click(answer); });
    expect(posts()).toContainEqual(expect.objectContaining({ url: '/api/workspaces/ws1/org/approvals/x1/decide', body: { decision: 'approve', note: 'Use GitHub Pages; the mailbox waits a week.' } }));
  });

  it('chips show only kinds with items; a chip narrows the list; a kind\'s full queue is one click away', async () => {
    render(<Harness />);
    await screen.findByTestId('inbox-list-needs');
    expect(screen.getAllByRole('button', { pressed: false }).concat(screen.getAllByRole('button', { pressed: true })).map((b) => b.getAttribute('data-testid')).filter((x) => x?.startsWith('inbox-chip-')).sort())
      .toEqual(['inbox-chip-approvals', 'inbox-chip-incidents', 'inbox-chip-keys', 'inbox-chip-needs']);
    expect(screen.queryByTestId('inbox-chip-plans')).toBeNull();
    expect(screen.queryByTestId('inbox-chip-mytasks')).toBeNull();
    fireEvent.click(screen.getByTestId('inbox-chip-incidents'));
    expect(within(screen.getByTestId('inbox-list-needs')).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(screen.getByText('All incidents in Operations'));
    expect(fake.setOrgPane).toHaveBeenCalledWith('incidents');
    // open where it lives: the incident in Operations
    fireEvent.click(within(screen.getByTestId('feed-row-need:incident:i1')).getByTestId('feed-go'));
    expect(fake.setOrgFocus).toHaveBeenLastCalledWith({ kind: 'incident', id: 'i1' });
    fireEvent.click(screen.getByTestId('inbox-chip-approvals'));
    fireEvent.click(screen.getByTestId('inbox-queue'));
    expect(screen.getByTestId('inbox-back')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('inbox-back'));
    // a decision's "Open the full card" lands on its queue too
    fireEvent.click(screen.getByTestId('inbox-chip-needs'));
    fireEvent.click(within(screen.getByTestId('feed-row-need:approval:a1')).getByTestId('feed-open'));
    fireEvent.click(screen.getByTestId('inbox-detail-go'));
    expect(fake.setInboxFilter).toHaveBeenLastCalledWith('approvals');
    expect(screen.getByTestId('inbox-back')).toBeInTheDocument();
  });

  it('Mentions and Updates group by day; a grouped update is one row with its count and opens where it lives', async () => {
    render(<Harness />);
    await screen.findByTestId('inbox-list-needs');
    fireEvent.click(screen.getByTestId('inbox-tab-mentions'));
    const mentions = screen.getByTestId('inbox-list-mentions');
    expect(within(mentions).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    fireEvent.click(within(within(mentions).getByTestId('feed-row-event:e3')).getByTestId('feed-go'));
    expect(fake.openChannel).toHaveBeenCalledWith('general', 'm9');
    fireEvent.click(screen.getByTestId('inbox-tab-updates'));
    const group = within(screen.getByTestId('inbox-list-updates')).getByTestId('feed-row-group:task:t1');
    expect(within(group).getByTestId('feed-count')).toHaveTextContent('3 updates');
    fireEvent.click(within(group).getByTestId('feed-go'));
    expect(fake.openOrgTask).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(posts()).toContainEqual(expect.objectContaining({ url: '/api/workspaces/ws1/feed/read', body: { ids: ['audit:1', 'audit:2', 'event:e4'] } })));
  });

  it('marks one read, a tab read, everything read (the header menu) — the counts follow at once', async () => {
    render(<Harness />);
    await screen.findByTestId('inbox-list-needs');
    fireEvent.click(within(screen.getByTestId('feed-row-event:c1')).getByTestId('feed-mark-read'));
    expect(screen.getByTestId('feed-row-event:c1')).toHaveAttribute('data-read', 'true');
    expect(screen.getByTestId('inbox-counts')).toHaveTextContent('3 need you · 5 unread');
    fireEvent.click(screen.getByTestId('inbox-tab-mentions'));
    menu('inbox-mark-section');
    await waitFor(() => expect(posts()).toContainEqual(expect.objectContaining({ body: { section: 'mentions' } })));
    expect(screen.queryByTestId('inbox-tab-count-mentions')).toBeNull();
    menu('inbox-mark-all');
    await waitFor(() => expect(posts()).toContainEqual(expect.objectContaining({ body: { all: true } })));
    expect(screen.getByTestId('inbox-counts')).toHaveTextContent('3 need you · 0 unread');
    fireEvent.click(screen.getByTestId('inbox-menu'));
    expect(screen.queryByTestId('inbox-mark-all')).toBeNull();
  });

  it('the keyboard: j/k move the open item, m marks read, e reads and moves on, o opens where it lives, a/r only with an item open, Esc closes', async () => {
    render(<Harness />);
    const list = await screen.findByTestId('inbox-list-needs');
    const root = screen.getByTestId('inbox-root');
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveAttribute('tabindex', '0');
    // a / r do nothing from a preview
    fireEvent.keyDown(root, { key: 'a' });
    expect(posts()).toHaveLength(0);
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'j' });
    expect(fake.setInboxItem).toHaveBeenLastCalledWith('need:approval:a1', { replace: false });
    expect(document.activeElement).toBe(screen.getByTestId('feed-row-need:approval:a1'));
    fireEvent.keyDown(document.activeElement!, { key: 'm' });
    expect(screen.getByTestId('feed-row-need:approval:a1')).toHaveAttribute('data-read', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'k' });
    expect(fake.setInboxItem).toHaveBeenLastCalledWith('event:c1', { replace: true });
    fireEvent.keyDown(document.activeElement!, { key: 'e' });
    expect(screen.getByTestId('feed-row-event:c1')).toHaveAttribute('data-read', 'true');
    expect(fake.setInboxItem).toHaveBeenLastCalledWith('need:approval:a1', { replace: true });
    // a: approve the open decision
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'a' }); });
    expect(posts()).toContainEqual(expect.objectContaining({ url: '/api/workspaces/ws1/org/approvals/a1/decide', body: { decision: 'approve' } }));
    fireEvent.keyDown(screen.getByTestId('feed-row-need:incident:i1'), { key: 'o' });
    expect(fake.setOrgPane).toHaveBeenCalledWith('incidents');
    fireEvent.keyDown(root, { key: 'Escape' });
    expect(fake.setInboxItem).toHaveBeenLastCalledWith(null, {});
  });

  it('empty states: you\'re clear, and a way to what is unread elsewhere', async () => {
    FEED = feedPage([feedItem()]);
    render(<Harness />);
    expect(await screen.findByTestId('inbox-empty')).toHaveTextContent(/You're clear/);
    fireEvent.click(screen.getByRole('button', { name: 'Read the 1 unread mention' }));
    expect(fake.setInboxFilter).toHaveBeenLastCalledWith('mentions');
    cleanup();
    primeFeed(null, '');
    FEED = feedPage([]);
    fake.inboxFilter = 'all';
    render(<Harness />);
    expect(await screen.findByTestId('inbox-empty')).toHaveTextContent(/You're clear/);
    expect(screen.getByTestId('inbox-pane-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('inbox-tab-mentions'));
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(/No mentions/);
    fireEvent.click(screen.getByTestId('inbox-tab-updates'));
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(/No news/);
    expect(screen.getByTestId('inbox-counts')).toHaveTextContent('nothing needs you · 0 unread');
  });

  it('Customize (the header menu) turns an update kind off for the workspace (its tunable)', async () => {
    render(<Harness />);
    await screen.findByTestId('inbox-list-needs');
    menu('inbox-customize-toggle');
    const box = await screen.findByTestId('notify-run_failed');
    expect(box).toBeChecked();
    await act(async () => { fireEvent.click(box); });
    expect(posts()).toContainEqual(expect.objectContaining({ url: '/api/workspaces/ws1/org/tunables', method: 'PUT', body: expect.objectContaining({ key: 'notify.run_failed', value: 0 }) }));
    expect(screen.getByTestId('notify-run_failed')).not.toBeChecked();
  });

  it('on a phone: the list alone, an item full screen with Back; without a company it says how to turn it on', async () => {
    fake.stacked = true;
    render(<Harness />);
    expect(await screen.findByTestId('inbox-list-needs')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-pane')).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['Needs you', 'Mentions', 'Updates', 'Done']);
    fireEvent.click(within(screen.getByTestId('feed-row-need:approval:a1')).getByTestId('feed-open'));
    expect(screen.getByTestId('inbox-detail-need:approval:a1')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-list-needs')).toBeNull();
    fireEvent.click(screen.getByTestId('inbox-detail-back'));
    expect(screen.getByTestId('inbox-list-needs')).toBeInTheDocument();
    cleanup();
    fake.wsOrg = { mode: 'off' };
    render(<Harness />);
    expect(screen.getByText(/turn organization mode on/)).toBeInTheDocument();
  });
});

describe('the Inbox (pure)', () => {
  it('groups: urgent first by deadline; days for news; one group has no heading', () => {
    const items = FEED.items.filter((i) => i.section === 'needs');
    expect(inboxGroups(items, 'needs', NOW).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([['Urgent', ['event:c1', 'need:approval:a1', 'need:incident:i1']]]);
    const calm = items.map((i) => ({ ...i, expiresSoon: false, severity: 'normal' as const }));
    expect(inboxGroups(calm, 'needs', NOW).map((g) => g.label)).toEqual(['']);
    const news = FEED.items.filter((i) => i.section === 'updates');
    expect(inboxGroups(news, 'updates', NOW).map((g) => g.label)).toEqual(['Today', 'Yesterday']);
  });

  it('chips, badges, the default and the facts', () => {
    expect(visibleChips(FEED, 'needs').map((c) => c.id)).toEqual(['needs', 'approvals', 'keys', 'incidents']);
    expect(visibleChips(FEED, 'plans').map((c) => c.id)).toContain('plans');
    expect(deadlineBadge({ deadline: iso(180), expiresSoon: true }, NOW)).toBe('3 h left');
    expect(deadlineBadge({ deadline: iso(-5), expiresSoon: false }, NOW)).toBe('Overdue');
    expect(deadlineBadge({ deadline: iso(60 * 48), expiresSoon: false }, NOW)).toBe('');
    const a1 = FEED.items.find((i) => i.id === 'need:approval:a1')!;
    expect(defaultLine(a1, NOW)).toMatch(/it is denied\.$/);
    expect(askOf(a1)).toMatch(/needs your yes/);
    const hire = { ...a1, need: { ...a1.need!, facts: { title: 'Researcher', name: 'Ana', reportsTo: 'Chief', monthlyBudgetUsd: 20, scopes: ['web.fetch'] } } };
    expect(feedFacts(hire)).toEqual([
      { label: 'Role', value: 'Researcher' }, { label: 'Name', value: 'Ana' }, { label: 'Reports to', value: 'Chief' }, { label: 'Budget', value: '$20 a month' }, { label: 'Access', value: 'web.fetch' },
    ]);
  });
});
