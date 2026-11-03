/** Old links keep working after the company split into five sections
 *  (docs/company-vision.md §8 "On screen"): `?section=workspace|company`,
 *  `?org=<pane>`, `#/ws/<id>/org/<pane>` and `setOrgPane(pane)` open the
 *  page in its new section (or the Inbox); `#/ws/<id>/org/<section>` opens a
 *  dashboard; going to a section opens its dashboard; openSettings opens a
 *  Settings pane from anywhere. The real store, with fetch stubbed. */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from '../src/store';

function route(url: string): Response {
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === '/api/workspaces') return json([{ id: 'ws1', name: 'Acme', color: '#fff', memory: '', createdAt: '' }]);
  if (url.startsWith('/api/chats/rail')) return json({ groups: [], archivedTotal: 0 });
  if (url.startsWith('/api/chats/page')) return json({ items: [], nextCursor: null });
  if (url.startsWith('/api/settings') || url.includes('/unread')) return json({});
  return json([]);
}

let app: ReturnType<typeof useApp> | null = null;
function Probe() { app = useApp(); return null; }

function at(search: string, hash = '') {
  window.history.replaceState(null, '', `/${search}${hash}`);
}

beforeEach(() => {
  app = null;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => route(String(url))));
  vi.stubGlobal('EventSource', class { close() {} addEventListener() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); at(''); });

describe('old links land in the new sections', () => {
  it.each([
    ['?section=workspace', 'operations', null],
    ['?section=company', 'operations', null],
    ['?section=direction', 'direction', null],
    ['?section=money', 'money', null],
    ['?org=capital', 'money', 'capital'],
    ['?org=vision', 'direction', 'vision'],
    ['?org=replay', 'oversight', 'replay'],
    ['?org=chart', 'people', 'chart'],
    ['?org=brief', 'operations', 'brief'],
  ])('%s opens %s', (search, section, pane) => {
    at(search);
    render(<AppProvider><Probe /></AppProvider>);
    expect(app!.section).toBe(section);
    expect(app!.orgPane).toBe(pane);
  });

  it('?org=plans and ?org=approvals open the Inbox on their filter', () => {
    at('?org=plans');
    render(<AppProvider><Probe /></AppProvider>);
    expect(app!.section).toBe('inbox');
    expect(app!.inboxFilter).toBe('plans');
    cleanup();
    at('?org=approvals');
    render(<AppProvider><Probe /></AppProvider>);
    expect(app!.inboxFilter).toBe('approvals');
  });

  it('#/ws/<id>/org/<pane> opens the page in its section; #/ws/<id>/org/<section> its dashboard', async () => {
    at('', '#/ws/ws1/org/replay');
    render(<AppProvider><Probe /></AppProvider>);
    await waitFor(() => expect(app!.section).toBe('oversight'));
    expect(app!.orgPane).toBe('replay');
    cleanup();
    at('', '#/ws/ws1/org/people');
    render(<AppProvider><Probe /></AppProvider>);
    await waitFor(() => expect(app!.section).toBe('people'));
    expect(app!.orgPane).toBeNull();
  });
});

describe('moving around', () => {
  it('setOrgPane opens a page in its own section, or the Inbox; go() opens a dashboard', () => {
    at('');
    render(<AppProvider><Probe /></AppProvider>);
    act(() => { app!.setOrgPane('goals'); });
    expect([app!.section, app!.orgPane]).toEqual(['direction', 'goals']);
    act(() => { app!.setOrgPane('incidents'); });
    expect([app!.section, app!.orgPane]).toEqual(['operations', 'incidents']);
    act(() => { app!.setOrgPane('plans'); });
    expect([app!.section, app!.inboxFilter]).toEqual(['inbox', 'plans']);
    act(() => { app!.setOrgPane('spend'); });
    act(() => { app!.go('money'); });
    expect([app!.section, app!.orgPane]).toEqual(['money', null]);
    act(() => { app!.go('workspace'); });
    expect(app!.section).toBe('operations');
    // a caller that opens a section and then a page lands on the page
    act(() => { app!.go('workspace'); app!.setOrgPane('approvals'); });
    expect([app!.section, app!.inboxFilter]).toEqual(['inbox', 'approvals']);
  });

  it('openSettings opens a Settings pane from anywhere', () => {
    at('');
    render(<AppProvider><Probe /></AppProvider>);
    act(() => { app!.openSettings('company'); });
    expect(app!.section).toBe('settings');
    expect(app!.settingsPane).toBe('company');
  });
});
