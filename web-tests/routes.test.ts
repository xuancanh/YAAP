/** The app's addresses (docs/routes.md, src/lib/routes.ts): company slugs
 *  that stay unambiguous and survive a rename, parse/href round trips for
 *  every place, the store's state ⇄ place, and every older link form
 *  redirecting to its path. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  appHref, companyIdOf, companyRef, companySlug, legacyRoute, navOf, parseRoute, placeOf, readLocation, rememberCompanies, resolveCompany, routeHref,
  type NavState, type Place, type Route,
} from '../src/lib/routes';

const JONG_A = { id: 'cad9a8f1-0000-4000-8000-000000000001', name: 'Real Jong' };
const JONG_B = { id: '7be2c400-0000-4000-8000-000000000002', name: 'Real Jong' };
const ACME = { id: 'ws1', name: 'Acmé Corp' };
const LIST = [JONG_A, JONG_B, ACME];

afterEach(() => { rememberCompanies([]); });

describe('the company segment', () => {
  it('is the name plus a short id prefix, so same-named companies differ', () => {
    expect(companySlug(JONG_A)).toBe('real-jong-cad9a8');
    expect(companySlug(JONG_B)).toBe('real-jong-7be2c4');
    expect(companySlug(ACME)).toBe('acme-corp-ws1');
    expect(companySlug({ id: 'abcdef12', name: '🚀' })).toBe('company-abcdef');
  });

  it('resolves by slug, by id prefix whatever the name part (a rename), by id, and by a unique name', () => {
    expect(resolveCompany('real-jong-cad9a8', LIST)).toBe(JONG_A);
    expect(resolveCompany('real-jong-7be2c4', LIST)).toBe(JONG_B);
    expect(resolveCompany('old-name-cad9a8', LIST)).toBe(JONG_A); // renamed since the link was made
    expect(resolveCompany(JONG_B.id, LIST)).toBe(JONG_B); // older links carry the id
    expect(resolveCompany('acme-corp', LIST)).toBe(ACME);
    expect(resolveCompany('real-jong', LIST)).toBeNull(); // two of them: ambiguous
    expect(resolveCompany('nope-zzz999', LIST)).toBeNull();
    expect(resolveCompany(null, LIST)).toBeNull();
  });

  it('links built outside the store use the known slug, and read back to the id', () => {
    expect(companyRef(JONG_A.id)).toBe(JONG_A.id);
    rememberCompanies(LIST);
    expect(companyRef(JONG_A.id)).toBe('real-jong-cad9a8');
    expect(companyIdOf('real-jong-cad9a8')).toBe(JONG_A.id);
    expect(companyIdOf('unknown-seg')).toBe('unknown-seg');
  });
});

describe('parse and href', () => {
  const C = 'real-jong-cad9a8';
  const table: Array<[string, Place]> = [
    ['/c/home', { kind: 'home' }],
    ['/c/inbox', { kind: 'inbox' }],
    ['/c/inbox/approvals', { kind: 'inbox', filter: 'approvals' }],
    ['/c/chat', { kind: 'chat' }],
    ['/c/channels/company', { kind: 'channel', slug: 'company' }],
    ['/c/channels/eng-standup-2/m-1', { kind: 'channel', slug: 'eng-standup-2', messageId: 'm-1' }],
    ['/c/chats/s-1', { kind: 'session', id: 's-1' }],
    ['/c/chats/s-1/log', { kind: 'session', id: 's-1', log: true }],
    ['/c/agents', { kind: 'agents' }],
    ['/c/agents/a1', { kind: 'agent', id: 'a1' }],
    ['/c/agents/a1/work-log', { kind: 'agent', id: 'a1', tab: 'work-log' }],
    ['/c/agents/a1/files/notes/plan.md', { kind: 'agentFiles', id: 'a1', path: 'notes/plan.md' }],
    ['/c/direction', { kind: 'section', section: 'direction' }],
    ['/c/operations/board', { kind: 'section', section: 'operations', pane: 'board' }],
    ['/c/people/chart', { kind: 'section', section: 'people', pane: 'chart' }],
    ['/c/money/capital', { kind: 'section', section: 'money', pane: 'capital' }],
    ['/c/oversight/replay', { kind: 'section', section: 'oversight', pane: 'replay' }],
    ['/c/tasks/ENG-12', { kind: 'task', key: 'ENG-12' }],
    ['/c/projects/WEB-3', { kind: 'project', key: 'WEB-3' }],
    ['/c/meetings/m1', { kind: 'meeting', id: 'm1' }],
    ['/c/artifacts', { kind: 'artifacts' }],
    ['/c/artifacts/org/meetings/2026/weekly%20review.md', { kind: 'artifacts', path: 'org/meetings/2026/weekly review.md' }],
    ['/c/apps', { kind: 'apps' }],
    ['/c/foundry', { kind: 'foundry' }],
    ['/c/foundry/plugins/scm@yaam?iface=scm', { kind: 'foundry', shelf: 'plugins', item: 'scm@yaam', query: 'iface=scm' }],
    ['/c/settings', { kind: 'settings' }],
    ['/c/settings/company', { kind: 'settings', pane: 'company' }],
  ];
  it.each(table)('%s', (path, place) => {
    const [pathname, search] = path.replace('/c/', `/${C}/`).split('?');
    const route = parseRoute(pathname, search ? `?${search}` : '');
    expect(route).toEqual({ company: C, place });
    expect(routeHref(route!)).toBe(path.replace('/c/', `/${C}/`));
  });

  it('a page asked for in the wrong section lands where it lives; aliases and unknowns land somewhere sensible', () => {
    expect(parseRoute('/c/operations/goals')?.place).toEqual({ kind: 'section', section: 'direction', pane: 'goals' });
    expect(parseRoute('/c/operations/approvals')?.place).toEqual({ kind: 'inbox', filter: 'approvals' });
    expect(parseRoute('/c/direction/playbooks')?.place).toEqual({ kind: 'artifacts' });
    expect(parseRoute('/c/operations/nope')?.place).toEqual({ kind: 'section', section: 'operations' });
    expect(parseRoute('/c/company')?.place).toEqual({ kind: 'section', section: 'operations' });
    expect(parseRoute('/c/market/kits')?.place).toEqual({ kind: 'foundry', shelf: 'kits' });
    expect(parseRoute('/c')?.place).toEqual({ kind: 'home' });
    expect(parseRoute('/c/what/ever')?.place).toEqual({ kind: 'home' });
    expect(parseRoute('/c/tasks')?.place).toEqual({ kind: 'section', section: 'operations', pane: 'board' });
    expect(parseRoute('/c/channels/Bad Slug')?.place).toEqual({ kind: 'chat' });
  });

  it('is not the app at / or under /api', () => {
    expect(parseRoute('/')).toBeNull();
    expect(parseRoute('/api/workspaces')).toBeNull();
    expect(parseRoute('/assets/index.js')).toBeNull();
    expect(routeHref({ company: null, place: { kind: 'home' } })).toBe('/');
  });
});

describe('older links redirect', () => {
  const R = (company: string | null, place: Place): Route => ({ company, place });
  it.each<[string, string, Route]>([
    ['', '#/chat/s1', R(null, { kind: 'session', id: 's1' })],
    ['', '#/chat/s1/chat', R(null, { kind: 'session', id: 's1' })],
    ['', '#/chat/s1/log', R(null, { kind: 'session', id: 's1', log: true })],
    ['', '#/ws/w1/meeting/m1', R('w1', { kind: 'meeting', id: 'm1' })],
    ['', '#/meeting/m1', R(null, { kind: 'meeting', id: 'm1' })],
    ['', '#/ws/w1/channel/general', R('w1', { kind: 'channel', slug: 'general' })],
    ['', '#/ws/w1/channel/general/m9', R('w1', { kind: 'channel', slug: 'general', messageId: 'm9' })],
    ['', '#/ws/w1/org/board?task=ENG-12', R('w1', { kind: 'task', key: 'ENG-12' })],
    ['', '#/ws/w1/org/replay', R('w1', { kind: 'section', section: 'oversight', pane: 'replay' })],
    ['', '#/ws/w1/org/people', R('w1', { kind: 'section', section: 'people' })],
    ['', '#/ws/w1/org/plans', R('w1', { kind: 'inbox', filter: 'plans' })],
    ['', '#/ws/w1/org/metrics', R('w1', { kind: 'artifacts' })],
    ['', '#/home', R(null, { kind: 'home' })],
    ['?workspace=w2', '', R('w2', { kind: 'home' })],
    ['?section=workspace', '', R(null, { kind: 'section', section: 'operations' })],
    ['?section=company&workspace=w2', '', R('w2', { kind: 'section', section: 'operations' })],
    ['?section=money', '', R(null, { kind: 'section', section: 'money' })],
    ['?org=capital', '', R(null, { kind: 'section', section: 'money', pane: 'capital' })],
    ['?org=approvals', '', R(null, { kind: 'inbox', filter: 'approvals' })],
    ['?section=inbox', '', R(null, { kind: 'inbox' })],
    ['?section=overview', '', R(null, { kind: 'home' })],
    ['?section=chats', '', R(null, { kind: 'chat' })],
    ['?section=files', '', R(null, { kind: 'artifacts' })],
    ['?section=agents', '', R(null, { kind: 'agents' })],
    ['?section=agents&agent=a1&tab=Trust', '', R(null, { kind: 'agent', id: 'a1', tab: 'Trust' })],
    ['?section=settings&pane=company', '', R(null, { kind: 'settings', pane: 'company' })],
    ['?section=foundry&shelf=plugins&plugin=scm@yaam&iface=scm', '', R(null, { kind: 'foundry', shelf: 'plugins', item: 'scm@yaam', query: 'iface=scm' })],
    ['?section=market&segment=business&fn=finance', '', R(null, { kind: 'foundry', query: 'segment=business&fn=finance' })],
    ['?section=foundry&shelf=connectors', '', R(null, { kind: 'foundry', shelf: 'plugins', query: 'role=connectors' })],
  ])('%s%s', (search, hash, route) => {
    expect(legacyRoute(search, hash)).toEqual(route);
  });

  it('nothing older is nothing', () => {
    expect(legacyRoute('', '')).toBeNull();
    expect(legacyRoute('?foo=1', '#/elsewhere')).toBeNull();
  });

  it('reads the address: a legacy hash wins (links appended to the base), then the path, then the query', () => {
    expect(readLocation({ pathname: '/', search: '', hash: '#/ws/w1/channel/general' })).toEqual(R('w1', { kind: 'channel', slug: 'general' }));
    expect(readLocation({ pathname: '/acme-ws1/home', search: '', hash: '#/chat/s1' })).toEqual(R('acme-ws1', { kind: 'session', id: 's1' }));
    expect(readLocation({ pathname: '/acme-ws1/settings/company', search: '', hash: '' })).toEqual(R('acme-ws1', { kind: 'settings', pane: 'company' }));
    expect(readLocation({ pathname: '/', search: '?section=money', hash: '' })).toEqual(R(null, { kind: 'section', section: 'money' }));
    expect(readLocation({ pathname: '/', search: '', hash: '' })).toBeNull();
  });

  it('in-app links (clicked in messages, notifications, the Inbox) become paths', () => {
    expect(appHref('#/ws/w1/channel/general/m1')).toBe('/w1/channels/general/m1');
    expect(appHref('http://app.example/#/ws/w1/org/board?task=t1')).toBe('/w1/tasks/t1');
    expect(appHref('https://app.example/acme-ws1/tasks/ENG-12')).toBe('/acme-ws1/tasks/ENG-12');
    expect(appHref('/acme-ws1/channels/general')).toBe('/acme-ws1/channels/general');
    expect(appHref('#/chat/s1', 'acme-ws1')).toBe('/acme-ws1/chats/s1');
    expect(appHref('#/chat/s1')).toBeNull(); // no company to put it in
    expect(appHref('//evil.example/x')).toBeNull();
    expect(appHref('mailto:a@b.c')).toBeNull();
    expect(appHref('/api/chats')).toBeNull();
  });
});

describe('the store state ⇄ the place', () => {
  const base: NavState = {
    section: 'overview', homeView: 'chat', currentId: null, currentChannel: null, selectedAgent: null, agentTab: null,
    fileTarget: { kind: 'workspace', id: 'ws1' }, currentFile: null, orgPane: null, inboxFilter: 'all', settingsPane: 'providers',
    routeTask: null, routeProject: null, meetingId: null, foundry: {}, stacked: false, mobileChatOpen: false, mobileDetail: false,
  };
  const at = (p: Partial<NavState>) => placeOf({ ...base, ...p });

  it('names what is on screen', () => {
    expect(at({})).toEqual({ kind: 'home' });
    expect(at({ section: 'home', currentId: 's1', mobileChatOpen: true })).toEqual({ kind: 'session', id: 's1' });
    expect(at({ section: 'home', homeView: 'channel', currentChannel: 'general' })).toEqual({ kind: 'channel', slug: 'general' });
    expect(at({ section: 'home', homeView: 'agent', selectedAgent: 'a1', agentTab: 'memory' })).toEqual({ kind: 'agent', id: 'a1', tab: 'memory' });
    expect(at({ section: 'home', homeView: 'file', fileTarget: { kind: 'agent', id: 'a1' }, currentFile: 'x.md' })).toEqual({ kind: 'agentFiles', id: 'a1', path: 'x.md' });
    expect(at({ section: 'artifacts', currentFile: 'org/a.md' })).toEqual({ kind: 'artifacts', path: 'org/a.md' });
    expect(at({ section: 'operations', orgPane: 'board', routeTask: 'ENG-12' })).toEqual({ kind: 'task', key: 'ENG-12' });
    expect(at({ section: 'operations', orgPane: 'pulse', routeTask: 'ENG-12' })).toEqual({ kind: 'section', section: 'operations', pane: 'pulse' });
    expect(at({ section: 'direction', orgPane: 'roadmap', routeProject: 'WEB-3' })).toEqual({ kind: 'project', key: 'WEB-3' });
    expect(at({ section: 'workspace' })).toEqual({ kind: 'section', section: 'operations' });
    expect(at({ section: 'inbox', inboxFilter: 'mytasks' })).toEqual({ kind: 'inbox', filter: 'mytasks' });
    expect(at({ section: 'market', foundry: { shelf: 'kits' } })).toEqual({ kind: 'foundry', shelf: 'kits' });
    expect(at({ section: 'settings', settingsPane: 'company' })).toEqual({ kind: 'settings', pane: 'company' });
    expect(at({ section: 'channels' as never, meetingId: 'm1' })).toEqual({ kind: 'meeting', id: 'm1' });
  });

  it('on a phone, the list (no detail open) has no item in the address', () => {
    expect(at({ stacked: true, section: 'home', currentId: 's1', mobileChatOpen: false })).toEqual({ kind: 'chat' });
    expect(at({ stacked: true, section: 'home', currentId: 's1', mobileChatOpen: true })).toEqual({ kind: 'session', id: 's1' });
    expect(at({ stacked: true, section: 'settings', settingsPane: 'company', mobileDetail: false })).toEqual({ kind: 'settings' });
    expect(at({ stacked: true, section: 'artifacts', currentFile: 'a.md', mobileChatOpen: false })).toEqual({ kind: 'artifacts' });
  });

  it('a deep link opens the detail (the phone shows it, not the list)', () => {
    expect(navOf({ kind: 'channel', slug: 'general' })).toMatchObject({ section: 'home', homeView: 'channel', currentChannel: 'general', mobileChatOpen: true, meetingId: null });
    expect(navOf({ kind: 'session', id: 's1' })).toMatchObject({ section: 'home', homeView: 'chat', mobileChatOpen: true });
    expect(navOf({ kind: 'settings', pane: 'company' })).toMatchObject({ section: 'settings', settingsPane: 'company', mobileDetail: true });
    expect(navOf({ kind: 'task', key: 'ENG-12' })).toMatchObject({ section: 'operations', orgPane: 'board', routeTask: 'ENG-12', orgFocus: { kind: 'task', id: 'ENG-12' }, mobileDetail: true });
    expect(navOf({ kind: 'chat' })).toMatchObject({ mobileChatOpen: false });
    // the room is shown over what was there: it sets nothing else
    expect(navOf({ kind: 'meeting', id: 'm1' })).toEqual({ meetingId: 'm1' });
  });

  it('round-trips every place that names a store state', () => {
    const places: Place[] = [
      { kind: 'home' }, { kind: 'inbox', filter: 'plans' }, { kind: 'channel', slug: 'general' }, { kind: 'agents' },
      { kind: 'agent', id: 'a1', tab: 'work' }, { kind: 'agentFiles', id: 'a1', path: 'x.md' }, { kind: 'section', section: 'money', pane: 'spend' },
      { kind: 'task', key: 'ENG-1' }, { kind: 'project', key: 'P-1' }, { kind: 'artifacts', path: 'a/b.md' }, { kind: 'apps' },
      { kind: 'foundry', shelf: 'plugins' }, { kind: 'settings', pane: 'company' }, { kind: 'meeting', id: 'm1' },
    ];
    for (const p of places) {
      const n = navOf(p);
      const state: NavState = { ...base, ...n, fileTarget: n.fileTarget === 'workspace' ? { kind: 'workspace', id: 'ws1' } : n.fileTarget ?? base.fileTarget } as NavState;
      expect(placeOf(state)).toEqual(p);
    }
  });
});
