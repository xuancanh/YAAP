/** Intervening from the Work log (docs/work-log.md "Intervening"): a running
 *  run expands live (thinking, tool calls, "running · step N" with a pulse),
 *  stops, answers its approvals inline; the composer starts a turn when idle
 *  and queues while one runs; Continue in chat; Rerun with its double-click
 *  guard; a person's message is labelled theirs; viewers read only. And the
 *  chat view of a work session: its trigger chip, Open in Work log, Rerun. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatTurn, WorkRun, WorkRunDetail } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { WorkLogTab } = await import('../src/components/WorkLog');
const { ChatView } = await import('../src/components/ChatView');

function run(id: string, extra: Partial<WorkRun> = {}): WorkRun {
  return {
    id, sessionId: 's-beat', sessionName: 'Loop · heartbeat', trigger: 'heartbeat', triggerKey: '', label: 'Heartbeat',
    outcome: 'done', status: 'done', error: null, input: 'Heartbeat: check the board', answer: `Answer of ${id}`,
    tokensIn: 1200, tokensOut: 300, usd: 0.0123, model: 'claude-sonnet-4-5', steps: 2, toolCount: 1, thinkingCount: 1, tools: [],
    files: [], task: null, archived: false, createdAt: '2026-11-02T08:00:00.000Z', source: 'loop', by: '', rerunOf: null, rerunnable: false, ...extra,
  };
}
const detail = (r: WorkRun): WorkRunDetail => ({ ...r, messages: [{ id: 'm1', seq: 0, role: 'user', content: r.input, toolName: null, createdAt: '' }, { id: 'm2', seq: 1, role: 'assistant', content: r.answer, toolName: null, createdAt: '' }], toolCalls: [] });

const sse = (...evs: unknown[]) => evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const calls: Array<{ url: string; method: string; body?: string }> = [];
let runs: WorkRun[] = [];
let live = '';
let rerunReply: () => Promise<unknown> = async () => ({ started: true, turnId: 't-new', sessionId: 's-beat', status: 'running' });

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  calls.length = 0;
  runs = [];
  live = sse({ type: 'idle', busy: false });
  rerunReply = async () => ({ started: true, turnId: 't-new', sessionId: 's-beat', status: 'running' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/live')) {
      // keep the stream open after the scripted events, like a turn still running
      const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(live)); if (live.includes('"idle"') || live.includes('"end"')) c.close(); } });
      return new Response(body, { status: 200 });
    }
    if (url.endsWith('/rerun')) return json(await rerunReply());
    if (url.endsWith('/stop')) return json({ stopped: true });
    if (url.endsWith('/approve')) return json({ resolved: true });
    if (url.startsWith('/api/agents/a1/work-log/runs/')) { const id = url.split('/').at(-1)!; const r = runs.find((x) => x.id === id) ?? run(id); return json(detail(r)); }
    if (url.startsWith('/api/agents/a1/work-log')) return json({ runs, nextCursor: null, groups: [] });
    return json([]);
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', agents: [{ id: 'a1', name: 'Jong', workspaceId: 'ws1', colors: '["#000","#fff"]', emoji: '🤖' }],
    workLogFocus: null, clearWorkLogFocus: vi.fn(), openOrgTask: vi.fn(), setMobileDetail: vi.fn(), openAgent: vi.fn(), openFile: vi.fn(), showToast: vi.fn(),
    me: { actorId: 'owner-1', role: 'owner', ownerAccountId: 'owner-1', names: {}, hasMembers: false }, nameOf: (x: string) => (x === 'm-2' ? 'Ann' : x),
    queueAll: [], streamingIds: new Set(), removeQueued: vi.fn(), openInChat: vi.fn(), openWorkLog: vi.fn(),
    sendToSession: vi.fn(async (_id: string, _t: string, o?: { serverBusy?: boolean }) => (o?.serverBusy ? 'queued' : 'started')),
    browserSteps: [], browserOpen: false, current: null,
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const row = (id: string) => screen.getAllByTestId('work-run').find((el) => el.getAttribute('data-run') === id)!;
const posted = (suffix: string) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(suffix));

describe('a run in progress, live', () => {
  it('expands by itself and streams thinking and tool calls with "running · step N" and a pulse', async () => {
    runs = [run('r-live', { outcome: 'running', status: 'running', answer: '' })];
    live = sse({ type: 'live', turnId: 'r-live', source: 'loop', startedAt: '' }, { type: 'thinking', text: 'Reading the inbox ' }, { type: 'thinking', text: 'first.' },
      { type: 'tool_call', id: 'c1', name: 'fs_read', input: { path: 'INBOX.md' } }, { type: 'tool_result', id: 'c1', name: 'fs_read', output: 'empty', isError: false });
    render(<WorkLogTab agentId="a1" />);
    const r = await waitFor(() => row('r-live'));
    await waitFor(() => expect(within(r).getByTestId('work-live')).toBeInTheDocument());
    // thinking is folded by default; one click reads it
    const thinking = await waitFor(() => within(r).getByTestId('work-thinking'));
    expect(thinking).not.toHaveTextContent('Reading the inbox first.');
    fireEvent.click(within(thinking).getByRole('button', { name: /Thinking/ }));
    await waitFor(() => expect(within(r).getByTestId('work-thinking')).toHaveTextContent('Reading the inbox first.'));
    expect(within(r).getAllByText(/running · step 2/).length).toBeGreaterThan(0);
    expect(within(r).getByTestId('run-live')).toHaveTextContent('running · step 2');
    expect(within(r).getByText('fs_read')).toBeInTheDocument();
    expect(within(r).getByLabelText('outcome running').style.animation).toMatch(/pulse/);
    expect(calls.some((c) => c.url === '/api/chats/s-beat/live')).toBe(true);
  });

  it('stops the running turn and answers its approval inline, with the reviewer\'s reason', async () => {
    runs = [run('r-live', { outcome: 'running', status: 'running' })];
    live = sse({ type: 'live', turnId: 'r-live', source: 'user', startedAt: '' },
      { type: 'approval_required', callId: 'c9', tool: 'gmail_send', input: { to: 'ann@x.com' }, review: { verdict: 'ask', reason: 'sends mail outside the company', sensitive: [], model: 'm' } });
    render(<WorkLogTab agentId="a1" />);
    const r = await waitFor(() => row('r-live'));
    await waitFor(() => expect(within(r).getByText(/The reviewer asked for your decision — sends mail outside the company/)).toBeInTheDocument());
    fireEvent.click(within(r).getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(posted('/api/chats/s-beat/approve')).toHaveLength(1));
    expect(JSON.parse(posted('/api/chats/s-beat/approve')[0].body!)).toEqual({ callId: 'c9', decision: 'allow-once' });
    fireEvent.click(within(r).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(posted('/api/chats/s-beat/stop')).toHaveLength(1));
  });

  it('falls back to polling the run when the turn cannot be watched here', async () => {
    runs = [run('r-live', { outcome: 'running', status: 'running' })];
    live = sse({ type: 'idle', busy: true });
    render(<WorkLogTab agentId="a1" />);
    const r = await waitFor(() => row('r-live'));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/agents/a1/work-log/runs/r-live').length).toBeGreaterThan(0));
    await waitFor(() => expect(within(r).queryByTestId('work-live')).toBeNull());
    expect(within(r).getByTestId('run-live')).toHaveTextContent(/running · step/);
  });
});

describe('messaging the agent in a work session', () => {
  it('queues while a turn runs and shows the queued message', async () => {
    runs = [run('r-live', { outcome: 'running', status: 'running' })];
    live = sse({ type: 'live', turnId: 'r-live', source: 'loop', startedAt: '' });
    fake.queueAll = [{ id: 1, sessionId: 's-beat', text: 'earlier note', attachments: [], waitServer: true }];
    render(<WorkLogTab agentId="a1" />);
    const r = await waitFor(() => row('r-live'));
    const box = await within(r).findByTestId('session-composer');
    expect(within(box).getByText('earlier note')).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('button', { name: 'Remove queued message' }));
    expect(fake.removeQueued).toHaveBeenCalledWith(1);
    fireEvent.change(within(box).getByLabelText('Message Jong in this work session'), { target: { value: 'skip the vendor' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Queue' }));
    await waitFor(() => expect(fake.sendToSession).toHaveBeenCalledWith('s-beat', 'skip the vendor', { serverBusy: true }));
    expect(fake.showToast).toHaveBeenCalledWith(expect.stringMatching(/^Queued/));
  });

  it('starts a turn when the session is idle; the session view has a composer and Continue in chat', async () => {
    runs = [run('r-done')];
    fake.workLogFocus = { agentId: 'a1', sessionId: 's-beat', at: 1 };
    render(<WorkLogTab agentId="a1" />);
    const box = await screen.findByTestId('work-session-box');
    fireEvent.change(within(box).getByLabelText('Message Jong in this work session'), { target: { value: 'run the digest now' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fake.sendToSession).toHaveBeenCalledWith('s-beat', 'run the digest now', { serverBusy: false }));
    expect(fake.showToast).toHaveBeenCalledWith(expect.stringMatching(/^Sent/));
    fireEvent.click(within(box).getByRole('button', { name: 'Continue in chat' }));
    expect(fake.openInChat).toHaveBeenCalledWith('s-beat');
  });

  it('labels a person\'s message as theirs', async () => {
    runs = [run('r-me', { source: 'person', by: '', input: 'please skip the vendor', answer: 'Skipped.' }), run('r-ann', { source: 'person', by: 'm-2', input: 'and Ann asks too' })];
    render(<WorkLogTab agentId="a1" />);
    await waitFor(() => expect(screen.getAllByTestId('from-person')).toHaveLength(2));
    expect(within(row('r-me')).getByTestId('from-person')).toHaveTextContent('from you');
    expect(within(row('r-ann')).getByTestId('from-person')).toHaveTextContent('from Ann');
    fireEvent.click(within(row('r-me')).getByRole('button', { expanded: false }));
    expect(await within(row('r-me')).findByTestId('person-message')).toHaveTextContent('Message from youplease skip the vendor');
  });
});

describe('rerun', () => {
  it('reruns a failed run once (double clicks guarded) and opens the new run', async () => {
    runs = [run('r-err', { outcome: 'error', status: 'error', error: 'Tool names must be unique', rerunnable: true })];
    let release: (v: unknown) => void = () => {};
    rerunReply = () => new Promise((r) => { release = r; });
    render(<WorkLogTab agentId="a1" />);
    const r = await waitFor(() => row('r-err'));
    fireEvent.click(within(r).getByRole('button', { expanded: false }));
    const btn = await within(r).findByRole('button', { name: 'Rerun' });
    fireEvent.click(btn);
    fireEvent.click(within(r).getByRole('button', { name: 'Rerunning…' }));
    expect(posted('/api/agents/a1/work-log/runs/r-err/rerun')).toHaveLength(1);
    release({ started: true, turnId: 't-new', sessionId: 's-beat', status: 'running' });
    await waitFor(() => expect(fake.showToast).toHaveBeenCalledWith('Rerunning Heartbeat'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/agents/a1/work-log/runs/t-new')).toBe(true));
  });

  it('says why a rerun did not start', async () => {
    runs = [run('r-err', { outcome: 'stopped', status: 'stopped', rerunnable: true })];
    rerunReply = async () => ({ started: false, turnId: null, sessionId: 's-beat', status: 'skipped:closed' });
    render(<WorkLogTab agentId="a1" />);
    const r = await waitFor(() => row('r-err'));
    fireEvent.click(within(r).getByRole('button', { expanded: false }));
    fireEvent.click(await within(r).findByRole('button', { name: 'Rerun' }));
    await waitFor(() => expect(fake.showToast).toHaveBeenCalledWith('The rerun did not start: its task is already done or cancelled. Reopen the task to run it again.'));
  });

  it('a rerun links back to the run it re-ran', async () => {
    runs = [run('r-new', { rerunOf: 'r-err' })];
    render(<WorkLogTab agentId="a1" />);
    const r = await waitFor(() => row('r-new'));
    fireEvent.click(within(r).getByRole('button', { expanded: false }));
    fireEvent.click(await within(r).findByRole('button', { name: 'rerun of an earlier run →' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/agents/a1/work-log/runs/r-err')).toBe(true));
  });
});

describe('viewers read only', () => {
  it('see the live run and its approval but no Stop, approve, composer or Rerun', async () => {
    fake.me = { actorId: 'v-1', role: 'viewer', ownerAccountId: 'owner-1', names: {}, hasMembers: true };
    runs = [run('r-live', { outcome: 'running', status: 'running' }), run('r-err', { outcome: 'error', status: 'error', rerunnable: true, createdAt: '2026-11-02T07:00:00.000Z' })];
    live = sse({ type: 'live', turnId: 'r-live', source: 'user', startedAt: '' }, { type: 'approval_required', callId: 'c9', tool: 'gmail_send', input: {} });
    render(<WorkLogTab agentId="a1" />);
    const r = await waitFor(() => row('r-live'));
    await waitFor(() => expect(within(r).getByText(/viewers can see it but not answer it/)).toBeInTheDocument());
    expect(within(r).queryByRole('button', { name: 'Allow once' })).toBeNull();
    expect(within(r).queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(within(r).queryByTestId('session-composer')).toBeNull();
    fireEvent.click(within(row('r-err')).getByRole('button', { expanded: false }));
    await within(row('r-err')).findByTestId('run-actions');
    expect(within(row('r-err')).queryByRole('button', { name: 'Rerun' })).toBeNull();
    expect(within(row('r-err')).getByRole('button', { name: 'Continue in chat' })).toBeInTheDocument();
  });
});

describe('the chat view of a work session', () => {
  const s: ChatSession = {
    id: 's-beat', workspaceId: 'ws1', agentId: 'a1', agentTypeId: null, name: 'Loop · heartbeat', autoTitle: '', cwd: null, model: '', thinkingEffort: 'off', permissionMode: 'auto',
    pinned: 0, tags: '[]', archivedAt: null, draft: '', tokenCeiling: 0, compactSummary: '', compactCutoff: null, tokensIn: 0, tokensOut: 0, createdAt: '', updatedAt: '', kind: 'work',
    trigger: 'heartbeat', triggerKey: '', triggerLabel: 'Heartbeat',
  };
  const turn = (id: string, seq: number, status: string): ChatTurn => ({ id, sessionId: 's-beat', seq, input: 'Heartbeat', attachments: '[]', status, toolCalls: '[]', tokensIn: 0, tokensOut: 0, rating: null, taskHandoff: null } as ChatTurn);
  const viewStore = (turns: ChatTurn[]) => Object.assign(fake, {
    current: s, currentId: s.id, sessions: [], transcript: { turns, messages: [] }, live: [], streaming: false, drafts: {}, attachments: [], queue: [], settings: {}, workspaces: [], agentTypes: [], pricing: {}, skills: [], fileList: [],
    me: null, orgHealth: null, wsOrg: null, companiesEnabled: false, stacked: false, width: 1200,
    patchSession: vi.fn(), archiveChat: vi.fn(), setDraft: vi.fn(), send: vi.fn(), approve: vi.fn(), openArtifact: vi.fn(), openBrowserPanel: vi.fn(), go: vi.fn(), setMobileChatOpen: vi.fn(), refreshFiles: vi.fn(),
    refreshTranscript: vi.fn(async () => undefined),
  });

  it('shows the trigger chip and opens the session in the Work log', () => {
    viewStore([turn('t0', 0, 'done')]);
    render(<ChatView />);
    const banner = screen.getByTestId('work-session-banner');
    expect(within(banner).getByTestId('work-trigger-chip')).toHaveTextContent('Heartbeat');
    expect(banner).toHaveTextContent("Jong's work");
    expect(within(banner).queryByRole('button', { name: 'Rerun' })).toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: 'Open in Work log' }));
    expect(fake.openWorkLog).toHaveBeenCalledWith('a1', { sessionId: 's-beat' });
  });

  it('offers Rerun when the last run failed, through the Work log rerun endpoint', async () => {
    viewStore([turn('t0', 0, 'done'), turn('t1', 1, 'error')]);
    render(<ChatView />);
    fireEvent.click(within(screen.getByTestId('work-session-banner')).getByRole('button', { name: 'Rerun' }));
    await waitFor(() => expect(posted('/api/agents/a1/work-log/runs/t1/rerun')).toHaveLength(1));
    await waitFor(() => expect(fake.showToast).toHaveBeenCalledWith('Rerunning Heartbeat'));
    expect(fake.refreshTranscript).toHaveBeenCalled();
  });
});
