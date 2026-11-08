/** Task plans on screen (docs/task-execution.md), the pure half: words and
 *  tones for modes, step and session states, the session tree (master →
 *  workers, lead → continuations) and the one-line summary. The panel is
 *  TaskPlanPanel.tsx. */
import type { TaskPlanSessionView, TaskPlanView } from './api';
import type { Tone } from './direction';

export const EXEC_MODE_WORD: Record<string, string> = { single: 'One session', sequential: 'Sequential sessions', orchestrated: 'Orchestrated' };
export const EXEC_MODE_HINT: Record<string, string> = {
  single: 'The agent works the steps itself and records each with evidence.',
  sequential: 'Each session hands off a packet; a fresh session continues from it.',
  orchestrated: 'A master session runs steps in worker sessions, side by side when they are independent, and integrates the results.',
};
export const ROLE_WORD: Record<string, string> = { master: 'Master', lead: 'Continuation', worker: 'Worker' };

export function planStepTone(status: string): Tone {
  return status === 'done' ? 'ok' : status === 'failed' ? 'bad' : status === 'interrupted' ? 'warn' : status === 'running' ? 'info' : 'muted';
}
export function planTone(status: string): Tone {
  return status === 'done' ? 'ok' : status === 'blocked' ? 'warn' : status === 'abandoned' ? 'muted' : 'info';
}
export function sessionTone(status: string): Tone {
  return status === 'done' || status === 'handed_off' ? 'ok' : status === 'failed' ? 'bad' : status === 'interrupted' ? 'warn' : status === 'running' ? 'info' : 'muted';
}

export const usd = (n: number): string => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`);

export interface SessionNode { s: TaskPlanSessionView; children: SessionNode[] }

/** The session tree: roots are sessions whose parent is not in the plan. Pure. */
export function sessionTree(sessions: TaskPlanSessionView[]): SessionNode[] {
  const nodes = new Map(sessions.map((s) => [s.sessionId, { s, children: [] as SessionNode[] }]));
  const roots: SessionNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.s.parentSessionId ? nodes.get(n.s.parentSessionId) : undefined;
    if (parent && parent !== n) parent.children.push(n); else roots.push(n);
  }
  return roots;
}

/** "3/4 steps · 5 sessions · $0.12" Pure. */
export function planSummary(v: TaskPlanView): string {
  const req = v.steps.filter((s) => !s.optional);
  const done = req.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return `${done}/${req.length} steps · ${v.plan.sessions} session${v.plan.sessions === 1 ? '' : 's'} · ${usd(v.plan.usd)}`;
}

/** Whether the view should keep refreshing (something is running). */
export function planIsLive(v: TaskPlanView): boolean {
  return v.plan.status === 'active' && (v.steps.some((s) => s.status === 'running') || v.sessions.some((s) => s.role === 'worker' && s.status === 'running'));
}
