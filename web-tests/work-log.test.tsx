/** The Work log tab (docs/work-log.md): the agent's runs as a timeline with
 *  trigger chips, filters, search and paging; a run expands to its thinking,
 *  tool calls with inputs and outputs, files and task; a link to a work
 *  session focuses it. And the human chat: a turn's thinking and tool calls
 *  fold behind "worked on it · N steps", the answer stays in view. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatSession, ChatTurn, WorkRun, WorkRunDetail } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { WorkLogTab } = await import('../src/components/WorkLog');
const { ChatView } = await import('../src/components/ChatView');

function run(id: string, extra: Partial<WorkRun> = {}): WorkRun {
  return {
    id, sessionId: 's-beat', sessionName: 'Loop · heartbeat', trigger: 'heartbeat', triggerKey: '', label: 'Heartbeat',
    outcome: 'done', status: 'done', error: null, input: 'Heartbeat: check the board', answer: `Answer of ${id}`,
    tokensIn: 1200, tokensOut: 300, usd: 0.0123, model: 'claude-sonnet-4-5', steps: 2, toolCount: 1, thinkingCount: 1, tools: ['fs_write'],
    files: [], task: null, archived: false, createdAt: '2026-11-02T08:00:00.000Z', ...extra,
  };
}
const RUNS = [
  run('r-task', { trigger: 'task', triggerKey: 'ENG-12', label: 'ENG-12 Close the books', outcome: 'blocked', answer: 'Blocked: need the bank export', task: { kind: 'org', id: 't1', key: 'ENG-12', title: 'Close the books' }, createdAt: '2026-11-02T10:00:00.000Z' }),
  run('r-beat', { createdAt: '2026-11-02T08:00:00.000Z' }),
  run('r-old', { outcome: 'error', error: 'provider timed out', answer: '', createdAt: '2026-11-01T08:00:00.000Z' }),
];
const GROUPS = [
  { trigger: 'task', key: 'ENG-12', label: 'ENG-12 Close the books', count: 1, lastAt: '2026-11-02T10:00:00.000Z' },
  { trigger: 'heartbeat', key: '', label: 'Heartbeat', count: 2, lastAt: '2026-11-02T08:00:00.000Z' },
];
const DETAIL: WorkRunDetail = {
  ...RUNS[1], files: [{ path: 'reports/digest.md', op: 'write' }],
  messages: [
    { id: 'm1', seq: 0, role: 'user', content: 'Heartbeat: check the board', toolName: null, createdAt: '' },
    { id: 'm2', seq: 1, role: 'thinking', content: 'Nothing urgent; write the digest first.', toolName: null, createdAt: '' },
    { id: 'm3', seq: 2, role: 'tool', content: 'wrote reports/digest.md', toolName: 'fs_write', createdAt: '' },
    { id: 'm4', seq: 3, role: 'assistant', content: 'All quiet; digest written.', toolName: null, createdAt: '' },
  ],
  toolCalls: [{ tool: 'fs_write', input: { path: 'reports/digest.md', content: '# Digest' }, result: 'wrote reports/digest.md', approved: 'allow-once', isError: false }],
};

const calls: string[] = [];
let page: () => unknown = () => ({ runs: RUNS, nextCursor: null, groups: GROUPS });
function route(url: string): unknown {
  calls.push(url);
  if (url.startsWith('/api/agents/a1/work-log/runs/')) return { ...DETAIL, id: decodeURIComponent(url.split('/').at(-1)!) };
  if (url.startsWith('/api/agents/a1/work-log')) return page();
  return [];
}
const logCalls = () => calls.filter((u) => u.startsWith('/api/agents/a1/work-log?') || u === '/api/agents/a1/work-log');

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  calls.length = 0;
  page = () => ({ runs: RUNS, nextCursor: null, groups: GROUPS });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(route(String(url))), { status: 200, headers: { 'content-type': 'application/json' } })));
  Object.assign(fake, {
    workspaceId: 'ws1', agents: [{ id: 'a1', name: 'Jong', workspaceId: 'ws1', colors: '["#000","#fff"]', emoji: '🤖' }],
    workLogFocus: null, clearWorkLogFocus: vi.fn(() => { fake.workLogFocus = null; }),
    openOrgTask: vi.fn(), setMobileDetail: vi.fn(), openAgent: vi.fn(), openFile: vi.fn(), showToast: vi.fn(),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('the Work log tab', () => {
  it('shows the runs by day with outcome, cost and trigger chips', async () => {
    render(<WorkLogTab agentId="a1" />);
    await waitFor(() => expect(screen.getAllByTestId('work-run')).toHaveLength(3));
    expect(screen.getByText('Blocked: need the bank export')).toBeInTheDocument();
    expect(screen.getByText('provider timed out')).toBeInTheDocument();
    expect(screen.getByLabelText('outcome blocked')).toBeInTheDocument();
    expect(screen.getAllByText(/1.5k tok · \$0\.01/).length).toBeGreaterThan(0);
    const chips = within(screen.getByRole('group', { name: 'Filter by trigger' }));
    expect(chips.getByRole('button', { name: 'All · 3' })).toHaveAttribute('aria-pressed', 'true');
    expect(chips.getByRole('button', { name: 'Heartbeat · 2' })).toBeInTheDocument();
    // two days
    expect(screen.getByText(/Nov 2, 2026|2 Nov 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Nov 1, 2026|1 Nov 2026/)).toBeInTheDocument();
  });

  it('filters by a trigger chip, an outcome, a task and search; pages with Load more', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    page = () => ({ runs: RUNS, nextCursor: 'next1', groups: GROUPS });
    render(<WorkLogTab agentId="a1" />);
    await waitFor(() => expect(screen.getAllByTestId('work-run')).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'ENG-12 Close the books · 1' }));
    await waitFor(() => expect(logCalls().some((u) => u.includes('trigger=task') && u.includes('key=ENG-12'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'blocked' } });
    await waitFor(() => expect(logCalls().some((u) => u.includes('outcome=blocked') && u.includes('trigger=task'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'ENG-12' } });
    await waitFor(() => expect(logCalls().some((u) => u.includes('task=ENG-12'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Search the work log'), { target: { value: 'bank' } });
    await act(async () => { vi.advanceTimersByTime(300); });
    await waitFor(() => expect(logCalls().some((u) => u.includes('q=bank'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Load more runs' }));
    await waitFor(() => expect(logCalls().some((u) => u.includes('cursor=next1'))).toBe(true));
  });

  it('expands a run to its thinking, tool calls with input and output, files and task', async () => {
    render(<WorkLogTab agentId="a1" />);
    await waitFor(() => expect(screen.getAllByTestId('work-run')).toHaveLength(3));
    const beat = screen.getAllByTestId('work-run').find((el) => el.getAttribute('data-run') === 'r-beat')!;
    fireEvent.click(within(beat).getByRole('button', { expanded: false }));
    const thinking = await waitFor(() => within(beat).getByTestId('work-thinking'));
    fireEvent.click(within(thinking).getByRole('button', { name: /Thinking/ }));
    await waitFor(() => expect(within(beat).getByTestId('work-thinking')).toHaveTextContent('Nothing urgent; write the digest first.'));
    expect(calls).toContain('/api/agents/a1/work-log/runs/r-beat');
    const tool = within(beat).getByTestId('work-tool');
    expect(tool).toHaveTextContent('fs_write');
    fireEvent.click(within(tool).getByText('fs_write'));
    expect(within(tool).getByText(/"content": "# Digest"/)).toBeInTheDocument();
    expect(within(tool).getByText('wrote reports/digest.md')).toBeInTheDocument();
    expect(within(beat).getByText('All quiet; digest written.')).toBeInTheDocument();
    fireEvent.click(within(beat).getByRole('button', { name: 'reports/digest.md' }));
    expect(fake.openFile).toHaveBeenCalledWith({ kind: 'agent', id: 'a1' }, 'reports/digest.md');
    // the task link of a task run
    const task = screen.getAllByTestId('work-run').find((el) => el.getAttribute('data-run') === 'r-task')!;
    fireEvent.click(within(task).getByRole('button', { expanded: false }));
    fireEvent.click(await within(task).findByRole('button', { name: 'ENG-12 Close the books →' }));
    expect(fake.openOrgTask).toHaveBeenCalledWith('t1');
  });

  it('an auto-selected run says which tier and model, and why', async () => {
    const decided = run('r-auto', { trigger: 'task', label: 'ENG-13 Price it', model: 'claude-opus-5-5', modelDecision: { mode: 'auto', kind: 'task', tier: 'strong', score: 7, model: 'claude-opus-5-5', agentTypeId: 'tC', provider: 'anthropic', family: 'anthropic', reasons: ['+3 class synthesis', 'risk floor standard'], at: '' } });
    page = () => ({ runs: [decided], nextCursor: null, groups: GROUPS });
    render(<WorkLogTab agentId="a1" />);
    const row = await waitFor(() => screen.getByTestId('work-run'));
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    const d = await waitFor(() => within(row).getByTestId('run-model-decision'));
    expect(d).toHaveTextContent(/Auto\s*Strong\s*claude-opus-5-5/);
    // the reasons stay folded until asked for
    expect(d).not.toHaveTextContent('class synthesis');
    fireEvent.click(within(d).getByRole('button', { name: 'Why this model' }));
    expect(d).toHaveTextContent('Complexity score 7');
    expect(within(d).getByRole('list', { name: 'What the score counted' })).toHaveTextContent('+3class synthesis');
    expect(within(d).getByRole('list', { name: 'Then' })).toHaveTextContent('risk floor standard');
  });

  it('a link to a work session filters to it and opens its newest run', async () => {
    fake.workLogFocus = { agentId: 'a1', sessionId: 's-beat', at: 1 };
    page = () => ({ runs: RUNS.slice(1, 2), nextCursor: null, groups: GROUPS.slice(1) });
    render(<WorkLogTab agentId="a1" />);
    await waitFor(() => expect(logCalls().some((u) => u.includes('session=s-beat'))).toBe(true));
    expect(fake.clearWorkLogFocus).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('work-thinking')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Loop · heartbeat ×' })).toBeInTheDocument();
  });

  it('a link to a run off the loaded page still shows it, open', async () => {
    fake.workLogFocus = { agentId: 'a1', turnId: 'r-far', at: 2 };
    render(<WorkLogTab agentId="a1" />);
    await waitFor(() => expect(screen.getAllByTestId('work-run').map((el) => el.getAttribute('data-run'))).toContain('r-far'));
    expect(calls).toContain('/api/agents/a1/work-log/runs/r-far');
    await waitFor(() => expect(screen.getByTestId('work-run-detail')).toBeInTheDocument());
  });
});

// ---- the human chat: thinking folded ----

function session(extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'c1', workspaceId: 'ws1', agentId: 'a1', agentTypeId: null, name: 'Plan the launch', autoTitle: '', cwd: null, model: '', thinkingEffort: 'off', permissionMode: 'ask',
    pinned: 0, tags: '[]', archivedAt: null, draft: '', tokenCeiling: 0, compactSummary: '', compactCutoff: null, tokensIn: 0, tokensOut: 0,
    createdAt: '', updatedAt: '', kind: 'chat', ...extra,
  };
}
const msg = (id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, sessionId: 'c1', turnId: 't1', seq: Number(id.slice(1)), role, content, toolName: null, createdAt: '', ...extra });
const TURN: ChatTurn = { id: 't1', sessionId: 'c1', seq: 0, input: 'plan it', attachments: '[]', status: 'done', toolCalls: '[]', tokensIn: 0, tokensOut: 0, rating: null, taskHandoff: null } as ChatTurn;

function chatStore(s: ChatSession, live: unknown[] = []) {
  Object.assign(fake, {
    current: s, currentId: s.id, sessions: [s], transcript: {
      turns: [TURN],
      messages: [msg('m0', 'user', 'plan it'), msg('m1', 'thinking', 'Secret reasoning about the launch.'), msg('m2', 'tool', 'read the calendar', { toolName: 'gcal_list' }), msg('m3', 'assistant', 'Here is the plan.')],
    },
    live, streaming: live.length > 0, drafts: {}, attachments: [], queue: [], settings: {}, workspaces: [], agentTypes: [], pricing: {}, skills: [], fileList: [],
    me: null, nameOf: (x: string) => x, orgHealth: null, wsOrg: null, companiesEnabled: false, stacked: false, width: 1200, browserSteps: [], browserOpen: false,
    patchSession: vi.fn(), archiveChat: vi.fn(), setDraft: vi.fn(), send: vi.fn(), approve: vi.fn(), editResend: vi.fn(), fork: vi.fn(), retry: vi.fn(), promote: vi.fn(), rate: vi.fn(),
    openArtifact: vi.fn(), openBrowserPanel: vi.fn(), go: vi.fn(), removeQueued: vi.fn(), removeAttachment: vi.fn(), stopTurn: vi.fn(), setMobileChatOpen: vi.fn(), refreshFiles: vi.fn(), addAttachment: vi.fn(),
  });
}

describe('ChatView keeps the answer prominent', () => {
  it('folds a turn\'s thinking and tool calls behind "worked on it · N steps"; the owner can expand', () => {
    chatStore(session());
    render(<ChatView />);
    expect(screen.getByText('Here is the plan.')).toBeInTheDocument();
    const fold = screen.getByTestId('worked-on');
    expect(fold).toHaveTextContent('worked on it · 2 steps');
    expect(screen.queryByText('Secret reasoning about the launch.')).toBeNull();
    fireEvent.click(within(fold).getByRole('button', { expanded: false }));
    // inside the fold, thinking and tool calls are one line each until opened
    expect(screen.queryByText('Secret reasoning about the launch.')).toBeNull();
    fireEvent.click(within(fold).getByRole('button', { name: /Thinking/ }));
    expect(screen.getByText('Secret reasoning about the launch.')).toBeInTheDocument();
  });

  it('keeps a live call waiting on approval in view while the rest folds', () => {
    chatStore(session(), [
      { kind: 'thinking', text: 'thinking live', streaming: false },
      { kind: 'tool', id: 'call-1', name: 'fs_read', input: {}, status: 'done', result: 'ok' },
      { kind: 'tool', id: 'call-2', name: 'gmail_send', input: { to: 'x' }, status: 'pending' },
    ]);
    render(<ChatView />);
    const folds = screen.getAllByTestId('worked-on');
    expect(folds.at(-1)).toHaveTextContent('working · 2 steps');
    expect(screen.queryByText('thinking live')).toBeNull();
    expect(screen.getAllByText(/gmail_send/).length).toBeGreaterThan(0);
  });

  it('an agent run opened as a chat lists every step, each folded to one line', () => {
    chatStore(session({ kind: 'work', name: 'Loop · heartbeat' }));
    render(<ChatView />);
    expect(screen.queryByTestId('worked-on')).toBeNull();
    expect(screen.queryByText('Secret reasoning about the launch.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Thinking/ }));
    expect(screen.getByText('Secret reasoning about the launch.')).toBeInTheDocument();
  });
});

describe('a tool call folds to one line', () => {
  it('shows its name and status; the result opens on click; a call waiting on approval stays open', async () => {
    const { ToolCard } = await import('../src/components/ChatView');
    chatStore(session());
    const { rerender } = render(<ToolCard t={{ kind: 'tool', id: 't1', name: 'fs_read', input: { path: 'notes.md' }, status: 'done', result: 'the file body' }} />);
    expect(screen.getByText('fs_read')).toBeInTheDocument();
    expect(screen.queryByText('the file body')).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('the file body')).toBeInTheDocument();
    rerender(<ToolCard t={{ kind: 'tool', id: 't2', name: 'gmail_send', input: { to: 'x' }, status: 'pending' }} />);
    expect(screen.getByText('Allow once')).toBeInTheDocument();
  });
});
