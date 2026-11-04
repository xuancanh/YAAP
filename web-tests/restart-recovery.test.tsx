/** Restarts in the SPA (docs/architecture.md "Restarts and recovery"): an
 *  interrupted run reads "Interrupted by a restart · resumed / · retry" —
 *  never a red error — in the Work log and the chat; a read rides out the
 *  seconds the API is down instead of rendering empty; a provider round the
 *  server re-asks drops what it streamed; the event stream reconnects fast. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTurn, WorkRun } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { WorkLogTab } = await import('../src/components/WorkLog');
const { InterruptedNote } = await import('../src/components/ChatView');
const { fetchRetrying } = await import('../src/lib/api');
const { interruptedLabel, retryable } = await import('../src/lib/interrupted');
const { dropFailedRound, isConnectionLost, reconnectDelay } = await import('../src/lib/stream-recovery');

function run(id: string, extra: Partial<WorkRun> = {}): WorkRun {
  return {
    id, sessionId: 's-beat', sessionName: 'Loop · heartbeat', trigger: 'heartbeat', triggerKey: '', label: 'Heartbeat',
    outcome: 'done', status: 'done', error: null, input: 'Heartbeat: check the board', answer: `Answer of ${id}`,
    tokensIn: 10, tokensOut: 5, usd: null, model: '', steps: 0, toolCount: 0, thinkingCount: 0, tools: [],
    files: [], task: null, archived: false, createdAt: '2026-11-02T08:00:00.000Z', ...extra,
  };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  Object.assign(fake, {
    workspaceId: 'ws1', agents: [{ id: 'a1', name: 'Jong', workspaceId: 'ws1', colors: '["#000","#fff"]', emoji: '🤖' }],
    workLogFocus: null, clearWorkLogFocus: vi.fn(), openOrgTask: vi.fn(), setMobileDetail: vi.fn(), openAgent: vi.fn(), openFile: vi.fn(), showToast: vi.fn(),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the interrupted label', () => {
  it('says what the boot did, and when a Retry is the next step', () => {
    expect(interruptedLabel('resumed')).toBe('Interrupted by a restart · resumed');
    expect(interruptedLabel('retry')).toBe('Interrupted by a restart · retry');
    expect(interruptedLabel('pending')).toBe('Interrupted by a restart · retry');
    expect(interruptedLabel('held')).toMatch(/mid-action · check it/);
    expect(retryable('retry')).toBe(true);
    expect(retryable('resumed')).toBe(false);
    expect(retryable('held')).toBe(false);
  });

  it('the Work log shows an interrupted run quietly, with its resumed run, not as a red error', async () => {
    const runs = [
      run('r-new', { rerunOf: 'r-int', createdAt: '2026-11-02T09:00:00.000Z' }),
      run('r-int', { outcome: 'interrupted', status: 'interrupted', error: 'Interrupted by a server restart', recovery: 'resumed', resumedBy: 'r-new', rerunnable: true }),
      run('r-int2', { outcome: 'interrupted', status: 'interrupted', error: 'Interrupted by a server restart', recovery: 'retry', rerunnable: true, createdAt: '2026-11-02T07:00:00.000Z' }),
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/work-log/runs/')
      ? json({ ...runs[1], messages: [], toolCalls: [] })
      : json({ runs, nextCursor: null, groups: [{ trigger: 'heartbeat', key: '', label: 'Heartbeat', count: 3, lastAt: runs[0].createdAt }] }))));
    render(<WorkLogTab agentId="a1" />);
    await waitFor(() => expect(screen.getAllByTestId('work-run')).toHaveLength(3));
    const labels = screen.getAllByTestId('run-interrupted');
    expect(labels.map((l) => l.textContent)).toEqual(['Interrupted by a restart · resumed', 'Interrupted by a restart · retry']);
    for (const l of labels) expect(l.parentElement?.getAttribute('style') ?? '').not.toContain('var(--red)');
    expect(screen.queryByText('Interrupted by a server restart')).toBeNull(); // the raw note is not shown as an error
    expect(screen.getAllByLabelText('outcome interrupted')).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId('work-run')[1].querySelector('[role="button"]')!);
    await waitFor(() => expect(screen.getByTestId('run-interrupted-note')).toHaveTextContent('It ran again after the server came back.'));
    expect(screen.getByRole('button', { name: 'the resumed run →' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rerun' })).toBeInTheDocument();
  });

  it('the chat shows "Interrupted by a restart" with a Retry, or the resumed state without one', async () => {
    const turn = { id: 't1', sessionId: 's1', seq: 0, input: 'hi', attachments: '[]', status: 'interrupted', toolCalls: '[]', tokensIn: 0, tokensOut: 0, rating: null, taskHandoff: null, recovery: 'retry' } as ChatTurn;
    const onRetry = vi.fn(async () => {});
    render(<InterruptedNote turn={turn} onRetry={onRetry} />);
    expect(screen.getByTestId('interrupted-note')).toHaveTextContent('Interrupted by a restart');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    cleanup();
    render(<InterruptedNote turn={{ ...turn, recovery: 'resumed' }} onRetry={onRetry} />);
    expect(screen.getByTestId('interrupted-note')).toHaveTextContent('Interrupted by a restart · resumed');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('reads through a restart', () => {
  it('retries while the API is down (refused connection, the proxy\'s empty 500, a 503), then answers', async () => {
    const answers: Array<() => Response> = [
      () => { throw new TypeError('Failed to fetch'); },
      () => new Response('', { status: 500 }),
      () => new Response('', { status: 503 }),
      () => json({ ok: true }),
    ];
    const fetchMock = vi.fn(async () => answers.shift()!());
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchRetrying('/api/status', {}, [1, 1, 1, 1]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a real server error with a body is an answer, not a restart; it gives up after the budget', async () => {
    const fetchMock = vi.fn(async () => json({ message: 'boom' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchRetrying('/api/x', {}, [1, 1])).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', down);
    await expect(fetchRetrying('/api/x', {}, [1, 1])).rejects.toThrow('Failed to fetch');
    expect(down).toHaveBeenCalledTimes(3);
  });
});

describe('the live stream', () => {
  it('a re-asked round drops what it streamed, back to the last settled step', () => {
    const items = [
      { kind: 'user' }, { kind: 'answer' }, { kind: 'tool', status: 'done' },
      { kind: 'thinking' }, { kind: 'answer' }, { kind: 'tool', status: 'running' },
    ];
    expect(dropFailedRound(items)).toEqual(items.slice(0, 3));
    expect(dropFailedRound([{ kind: 'user' }, { kind: 'answer' }])).toEqual([{ kind: 'user' }]);
    const settled = [{ kind: 'user' }, { kind: 'tool', status: 'done' }];
    expect(dropFailedRound(settled)).toBe(settled);
  });

  it('a lost connection is an interruption; an abort or a server answer is not', () => {
    expect(isConnectionLost(new TypeError('Failed to fetch'))).toBe(true);
    expect(isConnectionLost(new Error('500 '))).toBe(true); // the dev proxy while the API is down
    expect(isConnectionLost(new Error('503 {"message":"the server is restarting"}'))).toBe(true);
    expect(isConnectionLost(new Error('500 {"message":"boom"}'))).toBe(false);
    expect(isConnectionLost(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(isConnectionLost(new Error('402 plan ceiling reached'))).toBe(false);
  });

  it('the event stream reconnects quickly, never waiting long', () => {
    expect(reconnectDelay(0)).toBe(500);
    expect(reconnectDelay(1)).toBe(1_000);
    expect(reconnectDelay(10)).toBe(5_000);
  });
});
