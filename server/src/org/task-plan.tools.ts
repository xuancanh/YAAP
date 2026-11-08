/**
 * The task-execution tools (docs/task-execution.md), offered to every agent
 * session as a ToolProviderHook — a company task run, a private chat and a
 * channel alike (agents behave the same everywhere):
 *
 *  - `task_plan` (the master): read the plan, or create / revise it (a new
 *    version), record decisions, review step results, close it;
 *  - `task_step_run` (the master; a worker only below exec.maxDepth): run
 *    ready steps in fresh worker sessions and wait for their results;
 *  - `task_step_result` (a worker for its step; the master for a step it did
 *    itself): the output, each exit criterion with evidence, decisions,
 *    open questions, artifacts;
 *  - `task_handoff` (a worker, or a company task's lead): the packet a fresh
 *    session continues from.
 *
 * Also, without a tool call: the plan in the master's context (and the
 * handoff packet once, in the session that continues), the step card as a
 * worker's whole briefing, the nudge to hand off near the context ceiling,
 * and the refusal of the master's tools in a worker session.
 */
import { Injectable, Optional } from '@nestjs/common';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolExecCtx, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolCall, AiToolSpec } from '../ai/ai-provider.interface';
import { OrgRuntimeService } from './org-runtime.service';
import { TaskPlanService } from './task-plan.service';

const STR = { type: 'string' };
const STRS = { type: 'array', items: STR };
const STEP = {
  type: 'object',
  properties: { id: STR, title: STR, goal: STR, inputs: STRS, exit: STRS, dependsOn: STRS, parallel: { type: 'boolean', description: 'Only read/research work.' }, tier: { type: 'string', enum: ['cheap', 'standard', 'strong'] }, optional: { type: 'boolean' } },
  required: ['id', 'title', 'exit'],
};

export const TASK_PLAN_TOOLS: AiToolSpec[] = [
  { name: 'task_plan', description: 'Split this task when one session cannot do it reliably. No input: show the plan or the suggested mode. steps: create/revise (new version); mode single (you do the steps) | sequential (fresh session per handoff) | orchestrated (workers via task_step_run); decide: decisions all sessions honour; review: accept|redo|skip a step; status: done|abandoned.', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['single', 'sequential', 'orchestrated'] }, dynamic: { type: 'boolean' }, steps: { type: 'array', items: STEP }, reason: STR, decide: STRS, review: { type: 'array', items: { type: 'object', properties: { step: STR, verdict: { type: 'string', enum: ['accept', 'redo', 'skip'] }, note: STR } } }, status: { type: 'string', enum: ['done', 'abandoned'] } } } },
  { name: 'task_step_run', description: 'Run ready plan steps, each in a fresh worker session (you, with only its step card, inputs and the decisions); parallel-safe ones side by side. Waits; returns each output and its exit check.', inputSchema: { type: 'object', properties: { steps: { ...STRS, description: 'Default: every ready step.' } } } },
  { name: 'task_step_result', description: 'Report a plan step: output, and criteria [{met, evidence}] per exit criterion in order (all met = done). The master names the step it did itself.', inputSchema: { type: 'object', properties: { step: STR, output: STR, criteria: { type: 'array', items: { type: 'object', properties: { met: { type: 'boolean' }, evidence: STR } } }, decisions: STRS, questions: STRS, artifacts: STRS }, required: ['output', 'criteria'] } },
  { name: 'task_handoff', description: 'Context nearly full or at a step boundary: a fresh session continues from this packet and the plan. Then end your turn.', inputSchema: { type: 'object', properties: { state: { ...STR, description: 'What is done, where.' }, decisions: STRS, artifacts: STRS, questions: STRS, next: STR }, required: ['state', 'next'] } },
];
export const TASK_PLAN_TOOL_NAMES: ReadonlySet<string> = new Set(TASK_PLAN_TOOLS.map((t) => t.name));
const WORKER_TOOLS = new Set(['task_step_result', 'task_handoff']);

@Injectable()
export class TaskPlanTools implements ToolProviderHook {
  constructor(
    private readonly plans: TaskPlanService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() turns?: TurnLoopService,
  ) {
    turns?.addToolProvider(this);
  }

  /** Runs the plan does not belong in: the auditor's, a task-free aux run, a reviewer's or a tagged member's. */
  private excluded(session: ChatSession): boolean {
    const ctx = this.runtime?.runningCtx(session.id);
    return Boolean(ctx && (ctx.audit || ctx.aux || ctx.reviewer || ctx.consulted || ctx.planning || ctx.taskId === ''));
  }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!session.agentId || this.excluded(session)) return [];
    const row = await this.plans.sessionRow(session.id);
    if (row?.role === 'worker') {
      const plan = await this.plans.get(row.planId);
      const t = await this.plans.tunablesFor(plan?.orgId ?? null, session.agentId);
      return TASK_PLAN_TOOLS.filter((x) => WORKER_TOOLS.has(x.name) || (x.name === 'task_step_run' && row.depth < t['exec.maxDepth']));
    }
    return TASK_PLAN_TOOLS;
  }

  owns(name: string): boolean { return TASK_PLAN_TOOL_NAMES.has(name); }
  isReadOnly(): boolean { return false; }

  async contextFor(session: ChatSession): Promise<string | null> {
    if (!session.agentId || this.excluded(session)) return null;
    const card = await this.plans.workerCard(session).catch(() => null);
    if (card) return card;
    return this.plans.masterContext(session).catch(() => null);
  }

  async refuseCall(session: ChatSession, call: AiToolCall): Promise<string | null> {
    return this.plans.refusal(session, call.name, call.input ?? {});
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>, ctx?: ToolExecCtx): Promise<string> {
    if (this.excluded(session)) throw new Error(`${name} is not used in this run`);
    switch (name) {
      case 'task_plan': return this.plans.plan(session, input);
      case 'task_step_run': return this.plans.runSteps(session, input, ctx);
      case 'task_step_result': return this.plans.stepResult(session, input);
      case 'task_handoff': return this.plans.handoff(session, input);
      default: throw new Error(`unknown tool ${name}`);
    }
  }
}
