/** A task's plan on screen (docs/task-execution.md "On screen"): steps with
 *  status, the session that ran each, outputs, criteria and cost; the
 *  decisions and handoff packets; the master/worker session tree whose
 *  worker transcripts stay collapsed until opened. Nothing without a plan. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPlanView } from '../src/lib/api';
import { planIsLive, planSummary, sessionTree } from '../src/lib/task-plans';

const { TaskPlanPanel } = await import('../src/components/TaskPlanPanel');

const VIEW: TaskPlanView = {
  plan: { id: 'p1', title: 'ENG-4 Market study', mode: 'orchestrated', dynamic: false, status: 'active', version: 2, sessions: 3, usd: 0.0421, tokensIn: 9000, tokensOut: 2000, taskId: 't1', orgId: 'o1', rootSessionId: 'm', leadSessionId: null, note: '', caps: { maxSessions: 12, maxParallel: 3, maxDepth: 1, planUsdCap: 5, planTokenCap: 3_000_000 }, createdAt: '', updatedAt: '' },
  steps: [
    { id: 'r1', title: 'Size market one', goal: 'Size it', inputs: [], exit: ['size with a source'], dependsOn: [], parallel: true, tier: 'cheap', status: 'done', attempts: 1, sessionId: 'w1', output: 'About **$2bn**', criteria: [{ criterion: 'size with a source', met: true, evidence: 'gartner.com/x' }], questions: [], artifacts: [], note: '', model: 'claude-haiku-4-5', tokensIn: 3000, tokensOut: 700, usd: 0.004, startedAt: null, endedAt: null, ready: false },
    { id: 'w', title: 'Write the comparison', goal: 'Compare', inputs: [], exit: ['written'], dependsOn: ['r1'], parallel: false, status: 'pending', attempts: 0, sessionId: null, output: '', criteria: [], questions: [], artifacts: [], note: '', model: '', tokensIn: 0, tokensOut: 0, usd: 0, startedAt: null, endedAt: null, ready: true },
  ],
  sessions: [
    { sessionId: 'm', role: 'master', stepId: null, parentSessionId: null, depth: 0, status: 'running', model: 'claude-sonnet-4-5', tokensIn: 6000, tokensOut: 1300, usd: 0.038, error: '', startedAt: '', endedAt: null },
    { sessionId: 'w1', role: 'worker', stepId: 'r1', parentSessionId: 'm', depth: 1, status: 'done', model: 'claude-haiku-4-5', tokensIn: 3000, tokensOut: 700, usd: 0.004, error: '', startedAt: '', endedAt: null },
  ],
  decisions: [{ text: 'Figures in USD', stepId: null, sessionId: 'm', proposed: false, createdAt: '' }],
  handoffs: [{ state: 'Section 1 drafted', decisions: [], artifacts: ['drafts/s1.md'], questions: [], next: 'Write section 2', stepId: null, fromSessionId: 'm', toSessionId: 'm2', createdAt: '2026-11-08T10:00:00.000Z' }],
  versions: [{ version: 1, reason: 'created', diff: ['created'], createdAt: '' }, { version: 2, reason: 'added the writer', diff: ['+ step w'], createdAt: '' }],
};

const calls: string[] = [];
let answer: unknown = VIEW;
beforeEach(() => {
  calls.length = 0; answer = VIEW;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    const body = String(url).includes('/transcript')
      ? { messages: [{ id: 'x1', sessionId: 'w1', turnId: 't', seq: 0, role: 'user', content: 'Work step r1', toolName: null, createdAt: '' }, { id: 'x2', sessionId: 'w1', turnId: 't', seq: 1, role: 'tool', content: 'Recorded: step r1 done.', toolName: 'task_step_result', createdAt: '' }, { id: 'x3', sessionId: 'w1', turnId: 't', seq: 2, role: 'assistant', content: 'Sized market one.', toolName: null, createdAt: '' }], turns: [] }
      : answer;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the task plan panel', () => {
  it('shows the steps, cost, decisions and handoffs of a task\'s plan', async () => {
    render(<TaskPlanPanel source={{ kind: 'task', wsId: 'ws1', taskId: 't1' }} />);
    await waitFor(() => expect(screen.getAllByTestId('task-plan-step')).toHaveLength(2));
    expect(calls[0]).toBe('/api/workspaces/ws1/org/tasks/t1/plan');
    expect(screen.getByTestId('task-plan-summary')).toHaveTextContent('1/2 steps · 3 sessions · $0.04');
    expect(screen.getByText('Orchestrated')).toBeInTheDocument();
    const r1 = screen.getAllByTestId('task-plan-step')[0];
    expect(r1).toHaveAttribute('data-status', 'done');
    expect(within(r1).getByText(/after|parallel-safe/)).toHaveTextContent('parallel-safe · cheap');
    expect(within(r1).getByText(/gartner\.com/)).toBeInTheDocument();
    expect(within(screen.getAllByTestId('task-plan-step')[1]).getByText('ready')).toBeInTheDocument();
    expect(within(screen.getByTestId('task-plan-decisions')).getByText('Figures in USD')).toBeInTheDocument();
    expect(within(screen.getByTestId('task-plan-handoffs')).getByText('Write section 2')).toBeInTheDocument();
  });

  it('nests workers under the master; a worker transcript is fetched only when opened', async () => {
    render(<TaskPlanPanel source={{ kind: 'session', sessionId: 'm' }} />);
    await waitFor(() => expect(screen.getAllByTestId('task-plan-session')).toHaveLength(2));
    const [master, worker] = screen.getAllByTestId('task-plan-session');
    expect(master).toHaveAttribute('data-role', 'master');
    expect(master).toContainElement(worker);
    const transcript = within(worker).getByTestId('worker-transcript') as HTMLDetailsElement;
    expect(transcript.open).toBe(false);
    expect(calls.some((u) => u.includes('/transcript'))).toBe(false);
    transcript.open = true;
    fireEvent(transcript, new Event('toggle'));
    await waitFor(() => expect(within(transcript).getByText('Sized market one.')).toBeInTheDocument());
    expect(calls).toContain('/api/chats/w1/transcript');
    // tool calls and the prompt stay folded inside
    expect((within(transcript).getByText('task_step_result').closest('details') as HTMLDetailsElement).open).toBe(false);
  });

  it('renders nothing without a plan', async () => {
    answer = { plan: null };
    const { container } = render(<TaskPlanPanel source={{ kind: 'session', sessionId: 'chat' }} />);
    await waitFor(() => expect(calls).toContain('/api/chats/chat/task-plan'));
    expect(container).toBeEmptyDOMElement();
  });

  it('pure helpers: the tree, the summary, liveness', () => {
    const tree = sessionTree(VIEW.sessions);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.s.sessionId)).toEqual(['w1']);
    expect(planSummary(VIEW)).toBe('1/2 steps · 3 sessions · $0.04');
    expect(planIsLive(VIEW)).toBe(false);
    expect(planIsLive({ ...VIEW, steps: [{ ...VIEW.steps[1], status: 'running' }] })).toBe(true);
  });
});
