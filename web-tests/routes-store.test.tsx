/** The store and the address (docs/routes.md): reload lands on the same
 *  company and place, `/` on the company used last, older links are
 *  replaced (not pushed) by their path, every navigation is a history
 *  entry, and Back restores the view. The real store, with fetch stubbed. */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from '../src/store';

// Two companies with the same name: their addresses differ by the id prefix.
const WS = [
  { id: 'aaa111-0001', name: 'Jong', color: '#fff', memory: '', createdAt: '' },
  { id: 'bbb222-0002', name: 'Jong', color: '#fff', memory: '', createdAt: '' },
];
const A = 'jong-aaa111';
const B = 'jong-bbb222';

function route(url: string): Response {
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === '/api/workspaces') return json(WS);
  if (url.startsWith('/api/chats/rail')) return json({ groups: [], archivedTotal: 0 });
  if (url.startsWith('/api/chats/page')) return json({ items: [], nextCursor: null });
  if (url.startsWith('/api/settings') || url.includes('/unread')) return json({});
  return json([]);
}

let app: ReturnType<typeof useApp> | null = null;
function Probe() { app = useApp(); return null; }
let stored: Map<string, string>;
const at = (url: string) => window.history.replaceState(null, '', url);
const here = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
async function boot(url: string) {
  at(url);
  render(<AppProvider><Probe /></AppProvider>);
  await waitFor(() => expect(app?.workspaceId).not.toBe(''));
  await waitFor(() => expect(window.location.pathname).not.toBe('/'));
}
/** Back, as the browser does it: the previous entry, then popstate. */
async function back() {
  await act(async () => {
    const popped = new Promise((r) => window.addEventListener('popstate', r, { once: true }));
    window.history.back();
    await popped;
  });
}

beforeEach(() => {
  app = null;
  stored = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => route(String(url))));
  vi.stubGlobal('EventSource', class { close() {} addEventListener() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); at('/'); });

describe('reload and sharing', () => {
  it('a company address opens that company (not the first one with that name) and its place', async () => {
    await boot(`/${B}/settings/company`);
    expect(app!.workspaceId).toBe('bbb222-0002');
    expect([app!.section, app!.settingsPane]).toEqual(['settings', 'company']);
    expect(here()).toBe(`/${B}/settings/company`);
  });

  it('`/` opens the company used last, on Home', async () => {
    stored.set('yaam-last-company', 'bbb222-0002');
    await boot('/');
    expect(app!.workspaceId).toBe('bbb222-0002');
    expect(here()).toBe(`/${B}/home`);
  });

  it('switching company is remembered for `/`', async () => {
    await boot(`/${A}/home`);
    act(() => { app!.pickWorkspace('bbb222-0002'); });
    await waitFor(() => expect(here()).toBe(`/${B}/home`));
    expect(stored.get('yaam-last-company')).toBe('bbb222-0002');
  });

  it('older links are replaced by their path, without a history entry', async () => {
    const before = window.history.length;
    await boot('/?section=money&workspace=bbb222-0002');
    expect(app!.section).toBe('money');
    await waitFor(() => expect(here()).toBe(`/${B}/money`));
    expect(window.history.length).toBe(before);
    cleanup();
    await boot('/#/ws/aaa111-0001/org/board?task=ENG-12');
    expect([app!.section, app!.orgPane, app!.routeTask]).toEqual(['operations', 'board', 'ENG-12']);
    await waitFor(() => expect(here()).toBe(`/${A}/tasks/ENG-12`));
  });
});

describe('navigating', () => {
  it('each navigation is a history entry with its address; Back restores the view', async () => {
    await boot(`/${A}/home`);
    const start = window.history.length;
    act(() => { app!.go('money'); });
    await waitFor(() => expect(here()).toBe(`/${A}/money`));
    act(() => { app!.setOrgPane('capital'); });
    await waitFor(() => expect(here()).toBe(`/${A}/money/capital`));
    act(() => { app!.openSettings('company'); });
    await waitFor(() => expect(here()).toBe(`/${A}/settings/company`));
    act(() => { app!.openChannel('general'); });
    await waitFor(() => expect(here()).toBe(`/${A}/channels/general`));
    act(() => { app!.openOrgTask('ENG-12'); });
    await waitFor(() => expect(here()).toBe(`/${A}/tasks/ENG-12`));
    expect(window.history.length).toBe(start + 5);

    await back();
    await waitFor(() => expect([app!.section, app!.homeView, app!.currentChannel]).toEqual(['home', 'channel', 'general']));
    expect(app!.routeTask).toBeNull();
    await back();
    await waitFor(() => expect([app!.section, app!.settingsPane]).toEqual(['settings', 'company']));
    await back();
    await waitFor(() => expect([app!.section, app!.orgPane]).toEqual(['money', 'capital']));
    expect(here()).toBe(`/${A}/money/capital`);
  });

  it('Back across companies switches back', async () => {
    await boot(`/${A}/inbox`);
    act(() => { app!.pickWorkspace('bbb222-0002'); });
    await waitFor(() => expect(here()).toBe(`/${B}/inbox`));
    await back();
    await waitFor(() => expect(app!.workspaceId).toBe('aaa111-0001'));
    expect(here()).toBe(`/${A}/inbox`);
  });

  it('a filter replaces the address instead of adding an entry', async () => {
    await boot(`/${A}/inbox`);
    const start = window.history.length;
    act(() => { app!.setInboxFilter('approvals'); });
    await waitFor(() => expect(here()).toBe(`/${A}/inbox/approvals`));
    expect(window.history.length).toBe(start);
  });

  it('opening a meeting room is an entry; closing it returns the address to what is underneath', async () => {
    await boot(`/${A}/operations/meetings`);
    const { openMeetingView, closeMeetingView } = await import('../src/lib/meetings');
    act(() => { openMeetingView('aaa111-0001', 'm1'); });
    await waitFor(() => expect(here()).toBe(`/${A}/meetings/m1`));
    expect(app!.meetingId).toBe('m1');
    act(() => { closeMeetingView(); });
    await waitFor(() => expect(here()).toBe(`/${A}/operations/meetings`));
    // a link to the room opens it over the place that was there
    act(() => { openMeetingView('aaa111-0001', 'm2'); });
    await waitFor(() => expect(app!.meetingId).toBe('m2'));
    await back();
    await waitFor(() => expect(app!.meetingId).toBeNull());
    expect([app!.section, app!.orgPane]).toEqual(['operations', 'meetings']);
  });

  it('a link clicked in the app (an older hash in a stored message) opens its place', async () => {
    await boot(`/${A}/home`);
    const { navigate } = await import('../src/lib/routes');
    act(() => { navigate('#/ws/bbb222-0002/channel/general/m9'); });
    await waitFor(() => expect(app!.workspaceId).toBe('bbb222-0002'));
    expect([app!.homeView, app!.currentChannel, app!.channelFocus]).toEqual(['channel', 'general', 'm9']);
    await waitFor(() => expect(here()).toBe(`/${B}/channels/general`));
  });
});
