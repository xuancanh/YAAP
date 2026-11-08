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

/** Each step's stage: 0 for steps with no (known) dependency, else one past
 *  its latest dependency — steps of one stage can run side by side. Cycle-safe. Pure. */
export function stepStages(steps: Array<{ id: string; dependsOn: string[] }>): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const known = out.get(id);
    if (known !== undefined) return known;
    const s = byId.get(id);
    if (!s || seen.has(id)) return -1;
    seen.add(id);
    const deps = s.dependsOn.filter((d) => byId.has(d));
    const level = Math.max(0, deps.length ? Math.max(...deps.map((d) => visit(d, seen))) + 1 : 0);
    seen.delete(id);
    out.set(id, level);
    return level;
  };
  for (const s of steps) visit(s.id, new Set());
  return out;
}

export const STEP_STATUS_WORD: Record<string, string> = { pending: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped', interrupted: 'Interrupted' };

/** A step's status word: a pending step whose dependencies are met is "Ready". Pure. */
export function stepStatusWord(s: { status: string; ready: boolean }): string {
  return s.status === 'pending' && s.ready ? 'Ready' : STEP_STATUS_WORD[s.status] ?? s.status;
}

/** "2nd try" for a step's attempt count above one. Pure. */
export function attemptWord(n: number): string {
  if (n <= 1) return '';
  const suf = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suf} try`;
}

/** Whether the view should keep refreshing (something is running). */
export function planIsLive(v: TaskPlanView): boolean {
  return v.plan.status === 'active' && (v.steps.some((s) => s.status === 'running') || v.sessions.some((s) => s.role === 'worker' && s.status === 'running'));
}
