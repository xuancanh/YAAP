/** The Inbox's History (docs/home.md "Inbox"): the Done tab (Needs you by
 *  default); it lists what was resolved — outcome, who
 *  (decided-without-you marked apart), when — with the Inbox's filters, a
 *  search, a date window, "Decided without you", Load more and empty states;
 *  a row opens its record and offers the existing undo routes. */
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeFeed } from '../src/lib/feed-store';
import { feedPage } from './feed-fixtures';
import type { HistoryItem } from '../src/lib/api';
import { historyBy, historyFrom, historyTarget, outcomeColor } from '../src/lib/inbox';

// The lazy History chunk and the 250 ms search debounce can outlast the
// default 1 s on a cold, loaded runner.
configure({ asyncUtilTimeout: 4_000 });

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { InboxView } = await import('../src/components/InboxView');

let bump: () => void = () => undefined;
function Harness() {
  const [, set] = useState(0);
  bump = () => set((n) => n + 1);
  return <InboxView />;
}

const item = (over: Partial<HistoryItem>): HistoryItem => ({
  key: 'a:1', kind: 'approvals', title: 'hire: Researcher as Analyst', detail: '', outcome: 'approved', by: { kind: 'you', name: 'You' },
  withoutYou: false, at: '2026-11-01T10:00:00.000Z', link: { type: 'approval', id: '1' }, ...over,
});
const PAGE1: HistoryItem[] = [
  item({ key: 'a:1' }),
  item({ key: 'a:2', title: 'tune: intent.paceTolerance', by: { kind: 'default', name: 'the default at your deadline' }, withoutYou: true, at: '2026-11-01T09:00:00.000Z' }),
  item({ key: 'a:3', kind: 'approvals', title: 'budget raise: agent cap', outcome: 'rejected', by: { kind: 'delegate', name: 'Fin', id: 'fin-1' }, withoutYou: true, at: '2026-11-01T08:00:00.000Z', undo: { kind: 'revoke_delegation', delegationId: 'd1', label: 'Revoke budget raise delegation' } }),
  item({ key: 't:9', kind: 'mytasks', title: 'Write the launch post', outcome: 'done', at: '2026-11-01T07:00:00.000Z', link: { type: 'task', id: '9' }, undo: { kind: 'reopen_task', taskId: '9', label: 'Reopen' } }),
];
const PAGE2: HistoryItem[] = [
  item({ key: 'p:5', kind: 'plans', title: 'Plan: Open two tasks', outcome: 'applied', by: { kind: 'default', name: 'the default when the veto window closed' }, withoutYou: true, at: '2026-10-30T07:00:00.000Z', link: { type: 'plan', id: '5' } }),
];

const calls: Array<{ url: string; method: string }> = [];
let historyBody: (u: URL) => unknown;
beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  calls.length = 0;
  primeFeed(null, '');
  historyBody = (u) => (u.searchParams.get('cursor') ? { items: PAGE2, nextCursor: null } : { items: PAGE1, nextCursor: 'c1' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://x');
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    const body = u.pathname.endsWith('/inbox/history') ? historyBody(u)
      : u.pathname.endsWith('/feed') ? feedPage([])
      : u.pathname.endsWith('/follows/mine') ? []
      : u.pathname.endsWith('/humans/me/tasks') ? { assigned: [], reviewing: [] }
      : u.pathname.includes('/org/delegations/') ? { id: 'd1', revokedAt: 'now' }
      : u.pathname.includes('/org/tasks/') ? { id: '9', status: 'todo' }
      : u.pathname.endsWith('/org/detail') ? { id: 'o1', workspaceId: 'ws1', name: 'Acme', members: [] } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', companiesEnabled: true, wsOrg: { mode: 'supervised', orgId: 'o1', units: [] }, orgHealth: null, orgHeldActions: 0,
    inboxFilter: 'all', setInboxFilter: vi.fn((f: string) => { fake.inboxFilter = f; bump(); }), me: { role: 'owner' }, stacked: false, setOrgFocus: vi.fn(), openOrgTask: vi.fn(), openSession: vi.fn(),
    setOrgPane: vi.fn(), setOrgUnitId: vi.fn(), setMobileDetail: vi.fn(), refreshWsOrg: vi.fn(async () => undefined), showToast: vi.fn(),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

const historyCalls = () => calls.filter((c) => c.url.includes('/inbox/history')).map((c) => new URL(c.url, 'http://x').searchParams);

describe('history helpers (pure)', () => {
  it('names who resolved it and where it opens', () => {
    expect(historyBy({ by: { kind: 'you', name: 'You' }, outcome: 'approved' })).toBe('by you');
    expect(historyBy({ by: { kind: 'default', name: 'the default at your deadline' }, outcome: 'approved' })).toBe('by the default at your deadline');
    expect(historyBy({ by: { kind: 'delegate', name: 'Fin' }, outcome: 'rejected' })).toBe('by your delegate Fin');
    expect(historyBy({ by: { kind: 'delegate', name: 'Penny (controller)' }, outcome: 'approved' })).toBe('by your delegate Penny (controller)');
    expect(historyBy({ by: { kind: 'agent', name: 'Penny' }, outcome: 'approved' })).toBe('by Penny (agent)');
    expect(historyBy({ by: { kind: 'system', name: 'nobody — it expired' }, outcome: 'expired' })).toBe('nobody answered');
    expect(historyTarget(item({ link: { type: 'task', id: 't' } }))).toEqual({ to: 'task', taskId: 't' });
    expect(historyTarget(item({ kind: 'keys', link: { type: 'action', id: 'x', sessionId: 's' } }))).toEqual({ to: 'chat', sessionId: 's' });
    expect(historyTarget(item({ kind: 'escalations', link: { type: 'approval', id: 'a' } }))).toEqual({ to: 'inbox', filter: 'escalations' });
    expect(historyTarget(item({ link: { type: 'incident', id: 'i' } }))).toEqual({ to: 'pane', pane: 'incidents', focus: { kind: 'incident', id: 'i' } });
    // the link as written (a path, or an older hash link); routes.ts `navigate` opens either
    expect(historyTarget(item({ link: { type: 'thread', id: 'm', href: 'http://h/#/ws/ws1/channel/general/m' } }))).toEqual({ to: 'hash', hash: 'http://h/#/ws/ws1/channel/general/m' });
    expect(historyTarget(item({ link: { type: 'thread', id: 'm', href: '/acme-ws1/channels/general/m' } }))).toEqual({ to: 'hash', hash: '/acme-ws1/channels/general/m' });
    expect(historyFrom(0)).toBeUndefined();
    expect(historyFrom(7, new Date('2026-11-08T00:00:00Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(outcomeColor('vetoed')).toBe('var(--red)');
    expect(outcomeColor('done')).toBe('var(--green)');
  });
});

describe('the Done tab (History)', () => {
  it('opens on Needs you; Done lists rows with outcome, who and the decided-without-you marker; Load more appends the next page', async () => {
    render(<Harness />);
    expect(screen.getByTestId('inbox-tab-needs')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tablist', { name: 'Inbox sections' })).toBeInTheDocument();
    expect(historyCalls()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('inbox-tab-history'));
    const list = await screen.findByTestId('history-list');
    await waitFor(() => expect(within(list).getByTestId('history-item-a:1')).toBeInTheDocument());
    expect(screen.queryByRole('tablist', { name: 'Inbox filters' })).toBeNull();
    expect(historyCalls()[0].get('from')).toBeTruthy(); // 30 days by default
    expect(historyCalls()[0].get('kind')).toBeNull();

    const mine = screen.getByTestId('history-item-a:1');
    expect(within(mine).getByTestId('history-outcome')).toHaveTextContent('approved');
    expect(within(mine).getByTestId('history-by')).toHaveTextContent('by you');
    expect(within(mine).queryByTestId('history-without-you')).toBeNull();
    const byDefault = screen.getByTestId('history-item-a:2');
    expect(within(byDefault).getByTestId('history-without-you')).toBeInTheDocument();
    expect(within(byDefault).getByTestId('history-by')).toHaveTextContent('by the default at your deadline');
    expect(within(screen.getByTestId('history-item-a:3')).getByTestId('history-by')).toHaveTextContent('by your delegate Fin');

    fireEvent.click(screen.getByTestId('history-more'));
    await waitFor(() => expect(screen.getByTestId('history-item-p:5')).toBeInTheDocument());
    expect(historyCalls().at(-1)!.get('cursor')).toBe('c1');
    expect(screen.queryByTestId('history-more')).toBeNull();
    expect(screen.getAllByTestId(/^history-item-/)).toHaveLength(5);
  });

  it('filters by kind, search, date range and decided-without-you; an empty result says so', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('inbox-tab-history'));
    await screen.findByTestId('history-item-a:1');
    const tabs = screen.getByRole('tablist', { name: 'History filters' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['All', 'Approvals', 'Keys', 'Escalations', 'Pending changes', 'My tasks', 'Incidents', 'Following']);

    historyBody = () => ({ items: [], nextCursor: null });
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Keys' }));
    await waitFor(() => expect(historyCalls().at(-1)!.get('kind')).toBe('keys'));
    expect(await screen.findByTestId('history-empty')).toHaveTextContent('Nothing matches');

    fireEvent.change(screen.getByLabelText('Search history'), { target: { value: 'pricing' } });
    await waitFor(() => expect(historyCalls().at(-1)!.get('q')).toBe('pricing'));

    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: '0' } });
    await waitFor(() => expect(historyCalls().at(-1)!.get('from')).toBeNull());
    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: '7' } });
    await waitFor(() => {
      const from = historyCalls().at(-1)!.get('from');
      expect(from && Date.now() - Date.parse(from)).toBeGreaterThan(6.9 * 86_400_000);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Decided without you' }));
    await waitFor(() => expect(historyCalls().at(-1)!.get('without')).toBe('1'));
  });

  it('says when nothing was resolved yet', async () => {
    historyBody = () => ({ items: [], nextCursor: null });
    render(<Harness />);
    fireEvent.click(screen.getByTestId('inbox-tab-history'));
    expect(await screen.findByTestId('history-empty')).toHaveTextContent('Nothing resolved in the last 30 days');
  });

  it('a row opens its record: a task through its link, a card back in Needs you, a plan in its pane', async () => {
    // the approvals pane itself is not under test here: only the Done tab switches
    fake.setInboxFilter = vi.fn((f: string) => { if (f === 'history') { fake.inboxFilter = f; bump(); } });
    render(<Harness />);
    fireEvent.click(screen.getByTestId('inbox-tab-history'));
    fireEvent.click(within(await screen.findByTestId('history-item-t:9')).getByText('Write the launch post'));
    expect(fake.openOrgTask).toHaveBeenCalledWith('9');

    fireEvent.click(screen.getByTestId('history-more'));
    fireEvent.click(within(await screen.findByTestId('history-item-p:5')).getByText('Plan: Open two tasks'));
    expect(fake.setOrgFocus).toHaveBeenCalledWith({ kind: 'plan', id: '5' });
    expect(fake.setOrgPane).toHaveBeenCalledWith('plans');

    fireEvent.click(within(screen.getByTestId('history-item-a:1')).getByText('hire: Researcher as Analyst'));
    expect(fake.setInboxFilter).toHaveBeenCalledWith('approvals');
  });

  it('offers the existing undo routes behind a confirm: revoke the delegation, reopen the task', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('inbox-tab-history'));
    const deleg = await screen.findByTestId('history-item-a:3');
    const undo = within(deleg).getByTestId('history-undo');
    expect(undo).toHaveTextContent('Revoke budget raise delegation');
    fireEvent.click(undo);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(undo).toHaveTextContent('Confirm: Revoke budget raise delegation');
    fireEvent.click(undo);
    await waitFor(() => expect(calls).toContainEqual({ url: '/api/workspaces/ws1/org/delegations/d1', method: 'DELETE' }));
    await waitFor(() => expect(fake.showToast).toHaveBeenCalledWith(expect.stringMatching(/Delegation revoked/)));

    const reopen = within(await screen.findByTestId('history-item-t:9')).getByTestId('history-undo');
    fireEvent.click(reopen); fireEvent.click(reopen);
    await waitFor(() => expect(calls).toContainEqual({ url: '/api/workspaces/ws1/org/tasks/9', method: 'PATCH' }));
    expect(screen.getByTestId('history-item-a:2')).toBeInTheDocument();
  });
});
