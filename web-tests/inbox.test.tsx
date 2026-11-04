/** The Inbox (docs/owners-seat.md "Inbox and notifications"): the owner's feed
 *  in full — tabs Needs you · Mentions · Updates · Done with what each number
 *  counts, inline actions (approve, allow…), mark read / mark all read / mark
 *  a section read, chips that narrow Needs you, grouped updates, empty
 *  states, the keyboard (↑/↓ j/k, Enter, m), the phone layout, and which
 *  update kinds arrive (Customize → the workspace's tunables). */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedPage } from '../src/lib/api';
import { primeFeed } from '../src/lib/feed-store';
import { feedItem, feedPage, samplePage, NOW, iso } from './feed-fixtures';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { InboxView } = await import('../src/components/InboxView');

/** The store's filter, kept in state so a tab click re-renders like the real store. */
let bump: () => void = () => undefined;
function Harness() {
  const [, set] = useState(0);
  bump = () => set((n) => n + 1);
  return <InboxView />;
}

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
      : u.includes('/org/approvals/a1/') ? { id: 'a1', status: 'approved' }
      : u.endsWith('/org/tunables') ? { id: 'o1' }
      : u.endsWith('/follows/mine') ? [] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', companiesEnabled: true, wsOrg: { mode: 'supervised', orgId: 'o1', units: [] }, me: { role: 'owner' }, stacked: false,
    inboxFilter: 'all', setInboxFilter: vi.fn((f: string) => { fake.inboxFilter = f; bump(); }),
    setOrgFocus: vi.fn(), setOrgUnitId: vi.fn(), setOrgPane: vi.fn(), setMobileDetail: vi.fn(), openOrgTask: vi.fn(), openSession: vi.fn(), openChannel: vi.fn(), openAgent: vi.fn(), go: vi.fn(),
    refreshWsOrg: vi.fn(async () => undefined), showToast: vi.fn(),
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const posts = () => calls.filter((c) => c.method !== 'GET');

describe('the Inbox', () => {
  it('opens on Needs you; the header and the tabs say what each number counts', async () => {
    render(<Harness />);
    const list = await screen.findByTestId('inbox-list-needs');
    expect(screen.getByTestId('inbox-tab-needs')).toHaveAttribute('aria-selected', 'true');
    // Needs you: open items (read or not) — the badge; the rest: unread rows — the bell
    expect(screen.getByTestId('inbox-counts')).toHaveTextContent('3 need you · 6 unread');
    expect(screen.getByTestId('inbox-tab-count-needs')).toHaveTextContent('3');
    expect(screen.getByTestId('inbox-tab-count-mentions')).toHaveTextContent('2');
    expect(screen.getByTestId('inbox-tab-count-updates')).toHaveTextContent('1');
    // ranked as the server sent them: the critical incident, the expiring approval, the decision
    expect(within(list).getAllByRole('listitem').map((r) => r.getAttribute('data-testid'))).toEqual(['feed-row-need:approval:a1', 'feed-row-event:c1', 'feed-row-need:incident:i1']);
    expect(within(screen.getByTestId('feed-row-event:c1')).getByTestId('feed-expires')).toHaveTextContent('Expires in 8 min');
  });

  it('acts in place: allow a connection request, approve a decision; each leaves the list', async () => {
    render(<Harness />);
    const row = await screen.findByTestId('feed-row-event:c1');
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Allow' })); });
    expect(posts()).toContainEqual(expect.objectContaining({ url: '/api/agents/w/events/c1/decide', body: { decision: 'allow' } }));
    expect(fake.showToast).toHaveBeenCalledWith('Allowed');
    FEED = feedPage(FEED.items.filter((i) => i.id !== 'event:c1' && i.id !== 'need:approval:a1'));
    await act(async () => { fireEvent.click(within(screen.getByTestId('feed-row-need:approval:a1')).getByRole('button', { name: 'Approve' })); });
    expect(posts().some((c) => c.url.includes('/org/approvals/a1/'))).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('feed-row-need:approval:a1')).toBeNull());
    expect(screen.queryByTestId('feed-row-event:c1')).toBeNull();
  });

  it('a chip narrows Needs you; Incidents links to Operations; a card opens its queue', async () => {
    render(<Harness />);
    await screen.findByTestId('inbox-list-needs');
    fireEvent.click(screen.getByTestId('inbox-chip-incidents'));
    expect(within(screen.getByTestId('inbox-list-needs')).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(screen.getByText('All incidents in Operations'));
    expect(fake.setOrgPane).toHaveBeenCalledWith('incidents');
    fireEvent.click(within(screen.getByTestId('feed-row-need:incident:i1')).getByTestId('feed-open'));
    expect(fake.setOrgFocus).toHaveBeenLastCalledWith({ kind: 'incident', id: 'i1' });
    fireEvent.click(screen.getByTestId('inbox-chip-needs'));
    fireEvent.click(within(screen.getByTestId('feed-row-need:approval:a1')).getByTestId('feed-open'));
    expect(fake.setInboxFilter).toHaveBeenLastCalledWith('approvals');
    expect(screen.getByTestId('inbox-back')).toBeInTheDocument();
  });

  it('Mentions and Updates list their rows; a grouped update is one row with its count and opens the task', async () => {
    render(<Harness />);
    await screen.findByTestId('inbox-list-needs');
    fireEvent.click(screen.getByTestId('inbox-tab-mentions'));
    const mentions = screen.getByTestId('inbox-list-mentions');
    expect(within(mentions).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(within(within(mentions).getByTestId('feed-row-event:e3')).getByTestId('feed-open'));
    expect(fake.openChannel).toHaveBeenCalledWith('general', 'm9');
    fireEvent.click(screen.getByTestId('inbox-tab-updates'));
    const group = within(screen.getByTestId('inbox-list-updates')).getByTestId('feed-row-group:task:t1');
    expect(within(group).getByTestId('feed-count')).toHaveTextContent('3 updates');
    fireEvent.click(within(group).getByTestId('feed-open'));
    expect(fake.openOrgTask).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(posts()).toContainEqual(expect.objectContaining({ url: '/api/workspaces/ws1/feed/read', body: { ids: ['audit:1', 'audit:2', 'event:e4'] } })));
  });

  it('marks one read, a section read, everything read — the counts follow at once', async () => {
    render(<Harness />);
    await screen.findByTestId('inbox-list-needs');
    fireEvent.click(within(screen.getByTestId('feed-row-event:c1')).getByTestId('feed-mark-read'));
    expect(screen.getByTestId('feed-row-event:c1')).toHaveAttribute('data-read', 'true');
    expect(screen.getByTestId('inbox-counts')).toHaveTextContent('3 need you · 5 unread');
    fireEvent.click(screen.getByTestId('inbox-tab-mentions'));
    fireEvent.click(screen.getByTestId('inbox-mark-section'));
    await waitFor(() => expect(posts()).toContainEqual(expect.objectContaining({ body: { section: 'mentions' } })));
    expect(screen.queryByTestId('inbox-tab-count-mentions')).toBeNull();
    fireEvent.click(screen.getByTestId('inbox-mark-all'));
    await waitFor(() => expect(posts()).toContainEqual(expect.objectContaining({ body: { all: true } })));
    expect(screen.getByTestId('inbox-counts')).toHaveTextContent('3 need you · 0 unread');
    expect(screen.queryByTestId('inbox-mark-all')).toBeNull();
  });

  it('the keyboard: ↓ / j move, m marks read, Enter opens', async () => {
    render(<Harness />);
    const list = await screen.findByTestId('inbox-list-needs');
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveAttribute('tabindex', '0');
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: 'm' });
    expect(rows[1]).toHaveAttribute('data-read', 'true');
    fireEvent.keyDown(rows[1], { key: 'j' });
    fireEvent.keyDown(within(list).getAllByRole('listitem')[2], { key: 'Enter' });
    expect(fake.setOrgPane).toHaveBeenCalledWith('incidents');
  });

  it('empty states per tab', async () => {
    FEED = feedPage([]);
    render(<Harness />);
    expect(await screen.findByTestId('inbox-empty')).toHaveTextContent(/Nothing needs you/);
    fireEvent.click(screen.getByTestId('inbox-tab-mentions'));
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(/No mentions or messages/);
    fireEvent.click(screen.getByTestId('inbox-tab-updates'));
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(/No updates/);
    expect(screen.getByTestId('inbox-counts')).toHaveTextContent('nothing needs you · 0 unread');
  });

  it('Customize turns an update kind off for the workspace (its tunable)', async () => {
    render(<Harness />);
    await screen.findByTestId('inbox-list-needs');
    fireEvent.click(screen.getByTestId('inbox-customize-toggle'));
    const box = await screen.findByTestId('notify-run_failed');
    expect(box).toBeChecked();
    await act(async () => { fireEvent.click(box); });
    expect(posts()).toContainEqual(expect.objectContaining({ url: '/api/workspaces/ws1/org/tunables', method: 'PUT', body: expect.objectContaining({ key: 'notify.run_failed', value: 0 }) }));
    expect(screen.getByTestId('notify-run_failed')).not.toBeChecked();
  });

  it('works on the phone layout, and without a company says how to turn it on', async () => {
    fake.stacked = true;
    render(<Harness />);
    expect(await screen.findByTestId('inbox-list-needs')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['Needs you', 'Mentions', 'Updates', 'Done']);
    cleanup();
    fake.wsOrg = { mode: 'off' };
    render(<Harness />);
    expect(screen.getByText(/turn organization mode on/)).toBeInTheDocument();
  });
});
