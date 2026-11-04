/**
 * The owner's feed, shared (docs/owners-seat.md "Inbox and notifications"):
 * one page per workspace that the bell, the Inbox and the main menu's badge
 * all read, so a number never differs between them because one of them
 * fetched later. One request serves every subscriber; it refreshes on a
 * light poll while the tab is visible, on focus, when a caller asks
 * (`reloadFeed` — the top bar does on the workspace stream), and a read
 * mark updates every view at once before the server answers.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api, type FeedItem, type FeedPage, type FeedSection } from './api';
import { dropLocal, markLocal } from './feed';

const POLL_MS = 45_000;
/** Rows a page carries: Needs you in full and the recent news (the counts cover everything). */
export const FEED_PAGE_LIMIT = 200;

interface State { wsId: string; page: FeedPage | null; error: string | null }
let state: State = { wsId: '', page: null, error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setInterval> | null = null;
let subscribers = 0;

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Fetch the page for `wsId` now (one request at a time; a call during one runs once more after it). */
export function reloadFeed(wsId: string = state.wsId): Promise<void> {
  if (!wsId) return Promise.resolve();
  if (wsId !== state.wsId) set({ wsId, page: null, error: null });
  if (inflight) { again = true; return inflight; }
  inflight = api.feed(wsId, FEED_PAGE_LIMIT)
    .then((p) => { if (state.wsId === wsId) set({ page: p, error: null }); })
    .catch((e: unknown) => { if (state.wsId === wsId) set({ error: e instanceof Error ? e.message : String(e) }); })
    .finally(() => {
      inflight = null;
      if (again) { again = false; void reloadFeed(state.wsId); }
    });
  return inflight;
}

/** Tests and server-rendered seeds: put a page in place. */
export function primeFeed(page: FeedPage | null, wsId = page?.workspaceId ?? ''): void {
  set({ wsId, page, error: null });
}

function subscribe(l: () => void) {
  listeners.add(l);
  subscribers++;
  if (!timer && typeof window !== 'undefined') {
    timer = setInterval(() => { if (document.visibilityState === 'visible' && state.wsId) void reloadFeed(); }, POLL_MS);
    window.addEventListener('focus', onFocus);
  }
  return () => {
    listeners.delete(l);
    subscribers--;
    if (subscribers <= 0 && timer) { clearInterval(timer); timer = null; window.removeEventListener('focus', onFocus); }
  };
}
const onFocus = () => { if (state.wsId) void reloadFeed(); };
const snapshot = () => state;

/** Mark rows read everywhere at once, then on the server. */
export function markFeedRead(wsId: string, what: FeedItem[] | 'all' | FeedSection): Promise<void> {
  const ids = Array.isArray(what) ? [...new Set(what.flatMap((i) => i.ids))] : [];
  if (state.page && state.wsId === wsId) set({ page: markLocal(state.page, Array.isArray(what) ? ids : what) });
  const body = what === 'all' ? { all: true as const } : typeof what === 'string' ? { section: what } : { ids };
  if (Array.isArray(what) && ids.length === 0) return Promise.resolve();
  return api.markFeedRead(wsId, body).then(() => undefined).catch(() => { void reloadFeed(wsId); });
}

/** A card decided here leaves the list at once; the next fetch confirms it. */
export function dropFeedItems(wsId: string, ids: string[]): void {
  if (state.page && state.wsId === wsId) set({ page: dropLocal(state.page, ids) });
}

/** The workspace's feed page (null while the first one loads). */
export function useFeed(wsId: string): { page: FeedPage | null; error: string | null; reload: () => Promise<void> } {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { if (wsId && (wsId !== state.wsId || !state.page)) void reloadFeed(wsId); }, [wsId]);
  const reload = useCallback(() => reloadFeed(wsId), [wsId]);
  const mine = s.wsId === wsId;
  return { page: mine ? s.page : null, error: mine ? s.error : null, reload };
}
