/** The store's side of the paged rail (docs/chat-archiving.md "The rail"):
 *  sessions come from GET /api/chats/rail (not the full list), "Show more"
 *  appends the next page and is kept on refresh, and an open chat on no
 *  loaded page is looked up by id and stays open. A link to an agent's run
 *  (a `work` session, docs/work-log.md) opens its Work log, never the chat
 *  view — from openSession and from a #/chat/<id> deep link. */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '../src/lib/api';
import { AppProvider, useApp } from '../src/store';

function chat(id: string, agentId: string | null, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id, workspaceId: 'ws1', agentId, agentTypeId: null, name: id, autoTitle: '', cwd: null, model: '', thinkingEffort: 'off', permissionMode: 'ask',
    pinned: 0, tags: '[]', archivedAt: null, draft: '', tokenCeiling: 0, compactSummary: '', compactCutoff: null, tokensIn: 0, tokensOut: 0,
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...extra,
  };
}

const calls: string[] = [];
const first = Array.from({ length: 5 }, (_, i) => chat(`c${i}`, 'a1'));
const second = Array.from({ length: 5 }, (_, i) => chat(`c${i + 5}`, 'a1'));

function route(url: string): unknown {
  if (url.startsWith('/api/chats/rail')) {
    const wide = url.includes('limits=a1%3A10');
    return { groups: [{ agentId: 'a1', total: 30, items: wide ? [...first, ...second] : first, nextCursor: 'cur1', approvalIds: [], work: { total: 1, approvalIds: [] } }], archivedTotal: 0 };
  }
  if (url.startsWith('/api/chats/page')) {
    if (url.includes('archived=true')) return { items: [], nextCursor: null };
    return { items: second, nextCursor: 'cur2' };
  }
  if (url === '/api/chats/far') return chat('far', 'a1');
  if (url === '/api/chats/run') return chat('run', 'a1', { name: 'Loop · heartbeat', kind: 'work' });
  if (url.endsWith('/transcript')) return { messages: [], turns: [] };
  if (url === '/api/workspaces') return [{ id: 'ws1', name: 'Home', color: '#fff', memory: '', createdAt: '' }];
  if (url.startsWith('/api/settings')) return {};
  if (url.includes('/unread')) return {};
  return [];
}

let app: ReturnType<typeof useApp> | null = null;
function Probe() { app = useApp(); return null; }

beforeEach(() => {
  calls.length = 0;
  app = null;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(route(String(url))), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  vi.stubGlobal('EventSource', class { close() {} addEventListener() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the paged rail in the store', () => {
  it('loads the rail, pages a group, keeps the page on refresh, and keeps an open chat that is on no page', async () => {
    render(<AppProvider><Probe /></AppProvider>);
    await waitFor(() => expect(app?.sessions.map((s) => s.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']));
    expect(calls.some((u) => u === '/api/chats?workspaceId=ws1')).toBe(false);
    expect(app!.chatRail[0].total).toBe(30);

    await act(async () => { await app!.loadMoreChats('a1'); });
    expect(app!.chatRail[0].items.map((s) => s.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
    expect(app!.chatRail[0].nextCursor).toBe('cur2');
    expect(calls.some((u) => u.startsWith('/api/chats/page?') && u.includes('agentId=a1') && u.includes('cursor=cur1') && !u.includes('loops='))).toBe(true);

    await act(async () => { await app!.refreshSessions(); });
    expect(calls.some((u) => u.startsWith('/api/chats/rail') && u.includes('limits=a1%3A10'))).toBe(true);
    expect(app!.chatRail[0].items).toHaveLength(10);

    // a chat on no loaded page (a link, a search hit) is fetched and stays open
    act(() => { app!.openSession('far'); });
    await waitFor(() => expect(app!.current?.id).toBe('far'));
    expect(calls).toContain('/api/chats/far');
    expect(app!.currentId).toBe('far');

    // a link to an agent's run opens its Work log; the open chat stays
    act(() => { app!.openSession('run'); });
    await waitFor(() => expect(app!.workLogFocus).toMatchObject({ agentId: 'a1', sessionId: 'run' }));
    expect(app!.homeView).toBe('agent');
    expect(app!.selectedAgent).toBe('a1');
    expect(app!.agentTabRequest).toBe('Work log');
    expect(app!.currentId).toBe('far');
    expect(app!.sessions.some((s) => s.id === 'run')).toBe(false);
  });

  it('a #/chat/<id> deep link to a work session opens the Work log, not the chat view', async () => {
    window.location.hash = '#/chat/run';
    render(<AppProvider><Probe /></AppProvider>);
    await waitFor(() => expect(app?.workLogFocus).toMatchObject({ agentId: 'a1', sessionId: 'run' }));
    expect(app!.homeView).toBe('agent');
    expect(app!.currentId).not.toBe('run');
    expect(window.location.hash).toBe('');
  });
});
