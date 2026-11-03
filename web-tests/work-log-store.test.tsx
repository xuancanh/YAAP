/** The store's side of intervening in a work session (docs/work-log.md
 *  "Intervening"): Continue in chat opens a work session in the chat view
 *  (the same as any link to it), the #/chat/<id>/chat deep link does too,
 *  and messaging a session starts a turn when it is idle or queues for the
 *  next turn while one runs — sent once the server's turn ends. */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '../src/lib/api';
import { AppProvider, parseChatLink, useApp } from '../src/store';

function chat(id: string, agentId: string | null, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id, workspaceId: 'ws1', agentId, agentTypeId: null, name: id, autoTitle: '', cwd: null, model: '', thinkingEffort: 'off', permissionMode: 'ask',
    pinned: 0, tags: '[]', archivedAt: null, draft: '', tokenCeiling: 0, compactSummary: '', compactCutoff: null, tokensIn: 0, tokensOut: 0,
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...extra,
  };
}

const calls: Array<{ url: string; method: string; body?: string }> = [];
/** What GET /api/chats/run/live answers next: a turn running, then over. */
let liveScript: string[] = [];
const sse = (...evs: unknown[]) => evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

function route(url: string, method: string): Response {
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('/api/chats/rail')) return json({ groups: [{ agentId: 'a1', total: 1, items: [chat('c0', 'a1')], nextCursor: null, approvalIds: [], work: { total: 1, approvalIds: [] } }], archivedTotal: 0 });
  if (url.startsWith('/api/chats/page')) return json({ items: [], nextCursor: null });
  if (url === '/api/chats/run') return json(chat('run', 'a1', { name: 'Loop · heartbeat', kind: 'work' }));
  if (url === '/api/chats/run/live') return new Response(liveScript.shift() ?? sse({ type: 'idle', busy: false }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  if (url === '/api/chats/run/turns' && method === 'POST') return new Response(sse({ type: 'turn', turnId: 't-new' }, { type: 'answer', text: 'ok' }, { type: 'done' }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  if (url.endsWith('/transcript')) return json({ messages: [], turns: [] });
  if (url === '/api/workspaces') return json([{ id: 'ws1', name: 'Home', color: '#fff', memory: '', createdAt: '' }]);
  if (url.startsWith('/api/settings')) return json({});
  if (url.includes('/unread')) return json({});
  return json([]);
}

let app: ReturnType<typeof useApp> | null = null;
function Probe() { app = useApp(); return null; }

beforeEach(() => {
  calls.length = 0;
  liveScript = [];
  app = null;
  window.location.hash = '';
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: typeof init?.body === 'string' ? init.body : undefined });
    return route(String(url), method);
  }));
  vi.stubGlobal('EventSource', class { close() {} addEventListener() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => calls.filter((c) => c.url === '/api/chats/run/turns' && c.method === 'POST');

describe('intervening from the store', () => {
  it('parses #/chat/<id>, #/chat/<id>/chat and #/chat/<id>/log links', () => {
    const asLog = new Set<string>();
    expect(parseChatLink('#/chat/abc', asLog)).toBe('abc');
    expect(parseChatLink('#/chat/abc/chat', asLog)).toBe('abc');
    expect(asLog.has('abc')).toBe(false);
    expect(parseChatLink('#/chat/abc/log', asLog)).toBe('abc');
    expect(asLog.has('abc')).toBe(true);
    expect(parseChatLink('#/ws/x/org/board', asLog)).toBeNull();
  });

  it('Continue in chat opens a work session in the chat view, like the plain link', async () => {
    render(<AppProvider><Probe /></AppProvider>);
    await waitFor(() => expect(app?.sessions.map((s) => s.id)).toEqual(['c0']));
    act(() => { app!.openInChat('run'); });
    await waitFor(() => expect(app!.current?.id).toBe('run'));
    expect(app!.homeView).toBe('chat');
    expect(app!.current?.kind).toBe('work');
    expect(app!.chatRail.flatMap((g) => g.items).some((s) => s.id === 'run')).toBe(false);
    // the plain link opens the chat view as well, not the Work log
    act(() => { app!.openAgent('a1'); });
    act(() => { app!.openSession('run'); });
    await waitFor(() => expect(app!.homeView).toBe('chat'));
    expect(app!.workLogFocus).toBeNull();
  });

  it('a #/chat/<id>/chat deep link opens the work session in the chat view', async () => {
    window.location.hash = '#/chat/run/chat';
    render(<AppProvider><Probe /></AppProvider>);
    await waitFor(() => expect(app?.currentId).toBe('run'));
    expect(app!.homeView).toBe('chat');
    expect(app!.workLogFocus).toBeNull();
  });

  it('messaging an idle work session starts a turn there now', async () => {
    render(<AppProvider><Probe /></AppProvider>);
    await waitFor(() => expect(app?.sessions.length).toBe(1));
    let res = '';
    await act(async () => { res = await app!.sendToSession('run', 'skip the vendor today'); });
    expect(res).toBe('started');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0].body!).text).toBe('skip the vendor today');
    expect(app!.queueAll).toHaveLength(0);
  });

  it('while the server runs a turn there, the message queues and is sent when that turn ends', async () => {
    liveScript = [sse({ type: 'live', turnId: 't1', source: 'loop', startedAt: '' }, { type: 'thinking', text: 'busy' }, { type: 'end' })];
    render(<AppProvider><Probe /></AppProvider>);
    await waitFor(() => expect(app?.sessions.length).toBe(1));
    let res = '';
    await act(async () => { res = await app!.sendToSession('run', 'also check the invoices', { serverBusy: true }); });
    expect(res).toBe('queued');
    // the watch ends (the server's turn is over): the queued message goes
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0].body!).text).toBe('also check the invoices');
    await waitFor(() => expect(app!.queueAll).toHaveLength(0));
    expect(calls.some((c) => c.url === '/api/chats/run/live')).toBe(true);
  });

  it('a removed queued message is never sent', async () => {
    // the turn keeps running (the watch never ends) until the message is removed
    liveScript = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: String(url), method });
      if (String(url) === '/api/chats/run/live') {
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse({ type: 'live', turnId: 't1', source: 'loop', startedAt: '' }))); } }), { status: 200 });
      }
      return route(String(url), method);
    }));
    render(<AppProvider><Probe /></AppProvider>);
    await waitFor(() => expect(app?.sessions.length).toBe(1));
    await act(async () => { await app!.sendToSession('run', 'never mind', { serverBusy: true }); });
    expect(app!.queueAll.map((q) => q.text)).toEqual(['never mind']);
    act(() => { app!.removeQueued(app!.queueAll[0].id); });
    await waitFor(() => expect(app!.queueAll).toHaveLength(0));
    expect(posts()).toHaveLength(0);
  });
});
