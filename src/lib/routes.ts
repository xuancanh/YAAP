/** The app's addresses (docs/routes.md): company first, then the place —
 *  `/real-jong-cad9a8/channels/company`, `/acme-1f2e3d/tasks/ENG-12`. Pure
 *  parse/build functions plus the translation of every older link form
 *  (`?section=…`, `?org=…`, `#/ws/<id>/…`, `#/chat/<id>`) into a route; the
 *  store derives its navigation state from the route and writes the route
 *  back on every navigation (src/store.tsx). Hand-rolled on purpose: the
 *  table is small and the store owns the state. */
import type { FileTarget, HomeView, OrgPane, Section } from '../store';
import { ORG_PANES_IN_ARTIFACTS, isCompanySection, isOrgPane, paneHome, LEGACY_COMPANY_SECTION, type CompanySection } from './company-nav';
import { INBOX_FILTERS, type InboxFilter } from './inbox';
import { navFromUrl, foundryPlaceOf } from './market';

/** Where in a company the address points. */
export type Place =
  | { kind: 'home' }
  | { kind: 'inbox'; filter?: InboxFilter }
  | { kind: 'chat' }
  | { kind: 'channel'; slug: string; messageId?: string }
  /** A chat or an agent's work session; `log` opens a work session's timeline in its agent's Work log. */
  | { kind: 'session'; id: string; log?: boolean }
  | { kind: 'agents' }
  | { kind: 'agent'; id: string; tab?: string }
  | { kind: 'agentFiles'; id: string; path?: string }
  | { kind: 'section'; section: CompanySection; pane?: OrgPane }
  | { kind: 'task'; key: string }
  | { kind: 'project'; key: string }
  | { kind: 'meeting'; id: string }
  | { kind: 'artifacts'; path?: string }
  | { kind: 'apps' }
  | { kind: 'foundry'; shelf?: string; item?: string; query?: string }
  | { kind: 'settings'; pane?: string };

/** `company` is the address's first segment (a company slug, or a bare
 *  workspace id from an older link); null when the address names none. */
export interface Route { company: string | null; place: Place }

// ---- the company segment ----

/** The readable part: the name, lower-case, ASCII, dashes. */
export function nameSlug(name: string): string {
  const s = (name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  return s || 'company';
}
const idKey = (id: string): string => id.replace(/-/g, '').toLowerCase();

/** `real-jong-cad9a8`: the name for people, a short id prefix so two
 *  companies of the same name never share an address. The id prefix is what
 *  resolves it; the name part is cosmetic (a rename keeps old links working). */
export function companySlug(ws: { id: string; name: string }): string {
  return `${nameSlug(ws.name)}-${idKey(ws.id).slice(0, 6)}`;
}

/** The company an address segment names: a workspace id (older links), its
 *  slug, its id prefix after the last dash (the name may have changed), or
 *  — typed by hand — a name alone when only one company has it. */
export function resolveCompany<T extends { id: string; name: string }>(seg: string | null | undefined, list: readonly T[]): T | null {
  const s = (seg ?? '').trim().toLowerCase();
  if (!s) return null;
  const exact = list.find((w) => w.id.toLowerCase() === s) ?? list.find((w) => companySlug(w) === s);
  if (exact) return exact;
  const suffix = /([a-z0-9]+)$/.exec(s)?.[1] ?? '';
  const byId = suffix.length >= 3 ? list.filter((w) => idKey(w.id).startsWith(suffix)) : [];
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) return byId.find((w) => s.startsWith(`${nameSlug(w.name)}-`)) ?? byId[0];
  const byName = list.filter((w) => nameSlug(w.name) === s);
  return byName.length === 1 ? byName[0] : null;
}

// The companies on screen (the store keeps this current), so a link built
// outside the store — a meeting's Expand, a task chip — carries the slug.
let known: Array<{ id: string; name: string }> = [];
export function rememberCompanies(list: ReadonlyArray<{ id: string; name: string }>): void {
  known = list.map((w) => ({ id: w.id, name: w.name }));
}
/** The address segment of a workspace: its slug when known, else its id (resolved all the same). */
export function companyRef(workspaceId: string): string {
  const w = known.find((x) => x.id === workspaceId);
  return w ? companySlug(w) : workspaceId;
}
/** The workspace id an address segment names, among the known companies; the segment itself otherwise. */
export function companyIdOf(seg: string): string {
  return resolveCompany(seg, known)?.id ?? seg;
}

// ---- parse and build ----

/** First segments that are never a company (API, build assets). */
const RESERVED = new Set(['api', 'assets', 'index.html', 'favicon.ico', 'favicon.svg', 'manifest.json', 'sw.js']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const ID_RE = /^[\w-]+$/;
const INBOX_IDS = new Set<string>(INBOX_FILTERS.map((f) => f.id));

const enc = (s: string): string => encodeURIComponent(s).replace(/%40/g, '@').replace(/%3A/gi, ':');
const encPath = (p: string): string => p.split('/').filter(Boolean).map(enc).join('/');

/** A company page by its pane id: where it lives now (a section, the Inbox, or Artifacts). */
function placeOfPane(pane: string, fallback: CompanySection): Place {
  if (ORG_PANES_IN_ARTIFACTS.includes(pane)) return { kind: 'artifacts' };
  if (!isOrgPane(pane)) return { kind: 'section', section: fallback };
  const home = paneHome(pane);
  return home.section === 'inbox' ? { kind: 'inbox', filter: home.filter } : { kind: 'section', section: home.section, pane: home.pane };
}

/** The route an address names; null for `/` and for paths that are not the app's. */
export function parseRoute(pathname: string, search = ''): Route | null {
  let segs: string[];
  try { segs = (pathname ?? '').split('/').filter(Boolean).map((s) => decodeURIComponent(s)); } catch { return null; }
  if (segs.length === 0 || RESERVED.has(segs[0].toLowerCase())) return null;
  const [company, head, ...rest] = segs;
  return { company, place: parsePlace(head?.toLowerCase(), rest, search) };
}

function parsePlace(head: string | undefined, rest: string[], search: string): Place {
  const [a, b] = rest;
  switch (head) {
    case undefined: case 'home': case 'overview': return { kind: 'home' };
    case 'inbox': return a && INBOX_IDS.has(a) && a !== 'all' ? { kind: 'inbox', filter: a as InboxFilter } : { kind: 'inbox' };
    case 'chat': return { kind: 'chat' };
    case 'channels': return a && SLUG_RE.test(a) ? { kind: 'channel', slug: a, ...(b && ID_RE.test(b) ? { messageId: b } : {}) } : { kind: 'chat' };
    case 'chats': return a && ID_RE.test(a) ? { kind: 'session', id: a, ...(b === 'log' ? { log: true } : {}) } : { kind: 'chat' };
    case 'agents':
      if (!a || !ID_RE.test(a)) return { kind: 'agents' };
      if (b === 'files') return { kind: 'agentFiles', id: a, ...(rest.length > 2 ? { path: rest.slice(2).join('/') } : {}) };
      return { kind: 'agent', id: a, ...(b ? { tab: b.toLowerCase() } : {}) };
    case 'workspace': case 'company': return a ? placeOfPane(a, LEGACY_COMPANY_SECTION) : { kind: 'section', section: LEGACY_COMPANY_SECTION };
    case 'tasks': return a ? { kind: 'task', key: a } : { kind: 'section', section: 'operations', pane: 'board' };
    case 'projects': return a ? { kind: 'project', key: a } : { kind: 'section', section: 'direction', pane: 'roadmap' };
    case 'meetings': return a && ID_RE.test(a) ? { kind: 'meeting', id: a } : { kind: 'section', section: 'operations', pane: 'meetings' };
    case 'artifacts': case 'files': return rest.length ? { kind: 'artifacts', path: rest.join('/') } : { kind: 'artifacts' };
    case 'apps': return { kind: 'apps' };
    case 'foundry': case 'market': {
      const query = search.replace(/^\?/, '');
      return { kind: 'foundry', ...(a ? { shelf: a } : {}), ...(rest.length > 1 ? { item: rest.slice(1).join('/') } : {}), ...(query ? { query } : {}) };
    }
    case 'settings': return a ? { kind: 'settings', pane: a } : { kind: 'settings' };
    default:
      if (isCompanySection(head)) return a ? placeOfPane(a, head) : { kind: 'section', section: head };
      return { kind: 'home' };
  }
}

/** The address of a route (`/` when it names no company). */
export function routeHref(route: Route): string {
  if (!route.company) return '/';
  const c = `/${enc(route.company)}`;
  const p = route.place;
  switch (p.kind) {
    case 'home': return `${c}/home`;
    case 'inbox': return `${c}/inbox${p.filter && p.filter !== 'all' ? `/${p.filter}` : ''}`;
    case 'chat': return `${c}/chat`;
    case 'channel': return `${c}/channels/${enc(p.slug)}${p.messageId ? `/${enc(p.messageId)}` : ''}`;
    case 'session': return `${c}/chats/${enc(p.id)}${p.log ? '/log' : ''}`;
    case 'agents': return `${c}/agents`;
    case 'agent': return `${c}/agents/${enc(p.id)}${p.tab ? `/${enc(p.tab)}` : ''}`;
    case 'agentFiles': return `${c}/agents/${enc(p.id)}/files${p.path ? `/${encPath(p.path)}` : ''}`;
    case 'section': return `${c}/${p.section}${p.pane ? `/${p.pane}` : ''}`;
    case 'task': return `${c}/tasks/${enc(p.key)}`;
    case 'project': return `${c}/projects/${enc(p.key)}`;
    case 'meeting': return `${c}/meetings/${enc(p.id)}`;
    case 'artifacts': return `${c}/artifacts${p.path ? `/${encPath(p.path)}` : ''}`;
    case 'apps': return `${c}/apps`;
    case 'foundry': return `${c}/foundry${p.shelf ? `/${enc(p.shelf)}${p.item ? `/${enc(p.item)}` : ''}` : ''}${p.query ? `?${p.query}` : ''}`;
    case 'settings': return `${c}/settings${p.pane ? `/${enc(p.pane)}` : ''}`;
  }
}

// ---- older links ----

/** Every link form from before path routing, as a route (null when the
 *  address is none of them). Agents' stored messages and notifications
 *  carry these, so they redirect once, on load or when clicked. */
export function legacyRoute(search: string, hash: string): Route | null {
  return legacyHash(hash ?? '') ?? legacySearch(search ?? '');
}

function legacyHash(hash: string): Route | null {
  let m = /^#\/chat\/([\w-]+)(\/chat|\/log)?\/?$/.exec(hash);
  if (m) return { company: null, place: { kind: 'session', id: m[1], ...(m[2] === '/log' ? { log: true } : {}) } };
  m = /^#\/(?:ws\/([\w-]+)\/)?meeting\/([\w-]+)\/?$/.exec(hash);
  if (m) return { company: m[1] ?? null, place: { kind: 'meeting', id: m[2] } };
  m = /^#\/ws\/([\w-]+)\/channel\/([a-z0-9][a-z0-9-]*)(?:\/([\w-]+))?\/?$/.exec(hash);
  if (m) return { company: m[1], place: { kind: 'channel', slug: m[2], ...(m[3] ? { messageId: m[3] } : {}) } };
  m = /^#\/ws\/([\w-]+)\/org\/(\w+)\/?(?:\?(.*))?$/.exec(hash);
  if (m) {
    const task = m[3] ? new URLSearchParams(m[3]).get('task') : null;
    if (task && /^[\w-]+$/.test(task)) return { company: m[1], place: { kind: 'task', key: task } };
    return { company: m[1], place: isCompanySection(m[2]) ? { kind: 'section', section: m[2] } : placeOfPane(m[2], LEGACY_COMPANY_SECTION) };
  }
  m = /^#\/ws\/([\w-]+)\/?$/.exec(hash);
  if (m) return { company: m[1], place: { kind: 'home' } };
  if (/^#\/home\/?$/.test(hash)) return { company: null, place: { kind: 'home' } };
  return null;
}

function legacySearch(search: string): Route | null {
  const p = new URLSearchParams(search);
  const q = p.get('section');
  const org = p.get('org');
  const company = p.get('workspace');
  const agent = p.get('agent');
  let place: Place | null = null;
  if (org && (ORG_PANES_IN_ARTIFACTS.includes(org) || isOrgPane(org))) place = placeOfPane(org, LEGACY_COMPANY_SECTION);
  else if (q === 'market' || q === 'foundry') place = { kind: 'foundry', ...foundryPlaceOf(navFromUrl(search) ?? {}) };
  else if (q === 'settings') place = p.get('pane') ? { kind: 'settings', pane: p.get('pane')! } : { kind: 'settings' };
  else if (q === 'agents' && agent) place = { kind: 'agent', id: agent, ...(p.get('tab') ? { tab: p.get('tab')! } : {}) };
  else if (q === 'agents') place = { kind: 'agents' };
  else if (q === 'overview' || q === 'home') place = { kind: 'home' };
  else if (q === 'inbox') place = { kind: 'inbox' };
  else if (q === 'artifacts' || q === 'files') place = { kind: 'artifacts' };
  else if (q === 'apps') place = { kind: 'apps' };
  else if (q === 'chats') place = { kind: 'chat' };
  else if (q === 'workspace' || q === 'company') place = { kind: 'section', section: LEGACY_COMPANY_SECTION };
  else if (isCompanySection(q)) place = { kind: 'section', section: q };
  if (!place && !company) return null;
  return { company, place: place ?? { kind: 'home' } };
}

/** Where the address bar points now: a legacy hash first (links appended to
 *  the app's base), then the path, then legacy query parameters. */
export function readLocation(loc: { pathname: string; search: string; hash: string }): Route | null {
  const hash = legacyHash(loc.hash ?? '');
  if (hash) return hash.company ? hash : { ...hash, company: parseRoute(loc.pathname)?.company ?? null };
  return parseRoute(loc.pathname, loc.search) ?? legacySearch(loc.search ?? '');
}

/** The in-app address a link points to — a path (`/acme-1f2e3d/…`), an
 *  absolute URL to it, or an older hash link — or null when it is not an
 *  app link. A link without a company stays in `current`'s. */
export function appHref(link: string, current?: string | null): string | null {
  const raw = (link ?? '').trim();
  if (!raw) return null;
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    try { const u = new URL(raw); path = `${u.pathname}${u.search}${u.hash}`; } catch { return null; }
  }
  const at = path.indexOf('#/');
  if (at >= 0) {
    const r = legacyHash(path.slice(at));
    if (!r) return null;
    const company = r.company ?? current ?? parseRoute(path.slice(0, at))?.company ?? null;
    return company ? routeHref({ ...r, company }) : null;
  }
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const q = path.indexOf('?');
  const r = parseRoute(q >= 0 ? path.slice(0, q) : path, q >= 0 ? path.slice(q) : '');
  return r ? routeHref(r) : null;
}

/** Go to an in-app link: a history entry (or a replacement), then the store
 *  follows the address (it listens to popstate). */
export function navigate(link: string, opts: { replace?: boolean } = {}): boolean {
  const href = appHref(link, parseRoute(window.location.pathname)?.company ?? null);
  if (!href) return false;
  if (href !== `${window.location.pathname}${window.location.search}`) {
    if (opts.replace) window.history.replaceState(null, '', href); else window.history.pushState(null, '', href);
  }
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  return true;
}

// ---- the store's navigation state ----

/** The part of the store's state an address encodes. */
export interface NavState {
  section: Section; homeView: HomeView;
  currentId: string | null; currentChannel: string | null; selectedAgent: string | null; agentTab: string | null;
  fileTarget: FileTarget | null; currentFile: string | null;
  orgPane: OrgPane | null; inboxFilter: InboxFilter; settingsPane: string;
  routeTask: string | null; routeProject: string | null; meetingId: string | null;
  foundry: FoundryPlace;
  /** Phone layout: the list is on screen, not the detail (no item in the address). */
  stacked: boolean; mobileChatOpen: boolean; mobileDetail: boolean;
}
export type FoundryPlace = { shelf?: string; item?: string; query?: string };

/** The place the store is showing. */
export function placeOf(s: NavState): Place {
  if (s.meetingId) return { kind: 'meeting', id: s.meetingId };
  const sec = s.section === 'workspace' ? LEGACY_COMPANY_SECTION : s.section;
  switch (sec) {
    case 'overview': return { kind: 'home' };
    case 'agents': return { kind: 'agents' };
    case 'inbox': return s.inboxFilter !== 'all' ? { kind: 'inbox', filter: s.inboxFilter } : { kind: 'inbox' };
    case 'apps': return { kind: 'apps' };
    case 'market': return { kind: 'foundry', ...s.foundry };
    case 'settings': return s.stacked && !s.mobileDetail ? { kind: 'settings' } : { kind: 'settings', pane: s.settingsPane };
    case 'artifacts': return s.currentFile && s.fileTarget?.kind !== 'agent' && (!s.stacked || s.mobileChatOpen) ? { kind: 'artifacts', path: s.currentFile } : { kind: 'artifacts' };
    case 'home': {
      if (s.stacked && !s.mobileChatOpen) return { kind: 'chat' };
      switch (s.homeView) {
        case 'chat': return s.currentId ? { kind: 'session', id: s.currentId } : { kind: 'chat' };
        case 'channel': return s.currentChannel ? { kind: 'channel', slug: s.currentChannel } : { kind: 'chat' };
        case 'agent': return s.selectedAgent ? { kind: 'agent', id: s.selectedAgent, ...(s.agentTab ? { tab: s.agentTab } : {}) } : { kind: 'agents' };
        case 'file':
          if (s.fileTarget?.kind === 'agent') return { kind: 'agentFiles', id: s.fileTarget.id, ...(s.currentFile ? { path: s.currentFile } : {}) };
          return s.currentFile ? { kind: 'artifacts', path: s.currentFile } : { kind: 'artifacts' };
      }
      return { kind: 'chat' };
    }
    default:
      if (sec === 'operations' && s.orgPane === 'board' && s.routeTask) return { kind: 'task', key: s.routeTask };
      if (sec === 'direction' && s.orgPane === 'roadmap' && s.routeProject) return { kind: 'project', key: s.routeProject };
      return s.orgPane ? { kind: 'section', section: sec, pane: s.orgPane } : { kind: 'section', section: sec };
  }
}

/** What the store sets to show a place (fields left out keep their value).
 *  A meeting is shown over whatever was on screen, so it sets only itself. */
export interface NavPatch extends Partial<Omit<NavState, 'stacked' | 'fileTarget'>> {
  fileTarget?: FileTarget | 'workspace';
  channelFocus?: string | null;
  agentTabRequest?: string | null;
  orgFocus?: { kind: 'task' | 'project'; id: string };
  orgUnitId?: null;
}
export function navOf(place: Place): NavPatch {
  if (place.kind === 'meeting') return { meetingId: place.id };
  const base: NavPatch = { meetingId: null, routeTask: null, routeProject: null };
  switch (place.kind) {
    case 'home': return { ...base, section: 'overview' };
    case 'inbox': return { ...base, section: 'inbox', inboxFilter: place.filter ?? 'all' };
    case 'chat': return { ...base, section: 'home', homeView: 'chat', mobileChatOpen: false };
    case 'channel': return { ...base, section: 'home', homeView: 'channel', currentChannel: place.slug, channelFocus: place.messageId ?? null, mobileChatOpen: true };
    case 'session': return place.log ? base : { ...base, section: 'home', homeView: 'chat', currentId: place.id, mobileChatOpen: true };
    case 'agents': return { ...base, section: 'agents' };
    case 'agent': return { ...base, section: 'home', homeView: 'agent', selectedAgent: place.id, agentTab: place.tab ?? null, agentTabRequest: place.tab ?? null, mobileChatOpen: true };
    case 'agentFiles': return { ...base, section: 'home', homeView: 'file', fileTarget: { kind: 'agent', id: place.id }, currentFile: place.path ?? null, mobileChatOpen: true };
    case 'section': return { ...base, section: place.section, orgPane: place.pane ?? null, mobileDetail: Boolean(place.pane) };
    case 'task': return { ...base, section: 'operations', orgPane: 'board', routeTask: place.key, orgFocus: { kind: 'task', id: place.key }, orgUnitId: null, mobileDetail: true };
    case 'project': return { ...base, section: 'direction', orgPane: 'roadmap', routeProject: place.key, orgFocus: { kind: 'project', id: place.key }, orgUnitId: null, mobileDetail: true };
    case 'artifacts': return { ...base, section: 'artifacts', fileTarget: 'workspace', currentFile: place.path ?? null, mobileChatOpen: Boolean(place.path) };
    case 'apps': return { ...base, section: 'apps' };
    case 'foundry': return { ...base, section: 'market', foundry: { ...(place.shelf ? { shelf: place.shelf } : {}), ...(place.item ? { item: place.item } : {}), ...(place.query ? { query: place.query } : {}) } };
    case 'settings': return { ...base, section: 'settings', ...(place.pane ? { settingsPane: place.pane } : {}), mobileDetail: Boolean(place.pane) };
  }
}

/** The agent page's tab as an address segment ('Work log' → `work-log`). */
export const agentTabSlug = (tab: string): string => tab.trim().toLowerCase().replace(/\s+/g, '-');

// ---- links built outside the store ----

export const taskHref = (workspaceId: string, key: string): string => routeHref({ company: companyRef(workspaceId), place: { kind: 'task', key } });
export const meetingHref = (workspaceId: string, id: string): string => routeHref({ company: companyRef(workspaceId), place: { kind: 'meeting', id } });
export const channelHref = (workspaceId: string, slug: string, messageId?: string | null): string =>
  routeHref({ company: companyRef(workspaceId), place: { kind: 'channel', slug, ...(messageId ? { messageId } : {}) } });

/** A meeting's Expand / Close travel through this event (src/lib/meetings.ts): the store owns the room. */
export const MEETING_EVENT = 'yaam:meeting';
export interface MeetingEventDetail { workspaceId: string; meetingId: string | null }
