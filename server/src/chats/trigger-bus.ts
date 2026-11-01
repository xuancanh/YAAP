/**
 * TriggerBus — a tiny in-process event bus that lets the agents domain tell
 * the loops domain something happened without importing it (AgentsModule is
 * a dependency of ChatsModule, never the other way round). It carries two
 * events: a task landed on an agent's board (docs/triggers.md, the `task`
 * trigger), and an org wake (docs/autonomous-company.md §4.2: assignment,
 * comment on an owned task, approval decision, review request, manual) that
 * OrgRuntimeService debounces into one run per task. Listeners are
 * fire-and-forget; a throwing listener must not break the write that emitted
 * the event.
 */
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface TaskAddedEvent {
  agentId: string;
  task: { id: string; title: string; note: string; origin: string; sessionId: string | null; createdAt: string };
}

export type OrgWakeReason = 'assignment' | 'comment' | 'approval' | 'review' | 'manual' | 'trigger' | 'rewake';

export interface OrgWakeEvent {
  orgId: string;
  taskId: string;
  /** The one member this wake is for. Mentions never produce an event. */
  agentId: string;
  reason: OrgWakeReason;
}

/** A board-level event the autonomous chief of staff reviews
 *  (docs/group-chat.md §5): a task blocked, an escalation, a budget warning
 *  or a new goal. OrgRuntimeService coalesces them into one review run. */
export type OrgBoardEventKind = 'blocked' | 'escalation' | 'budget_warn' | 'goal';

export interface OrgBoardEvent {
  orgId: string;
  kind: OrgBoardEventKind;
  refId: string;
  detail: string;
}

/** A task's status changed (docs/group-chat.md §3): the group chat posts a
 *  system line into the thread the task was made from. Emitted by both task
 *  services (agent kanban and the organisation board). */
export interface TaskStatusEvent {
  source: 'agent' | 'org';
  taskId: string;
  title: string;
  status: string;
  previous: string;
  channelId: string;
  messageId: string | null;
  /** The agent whose board it is (agent tasks) or the assignee (org tasks). */
  agentId: string | null;
}

@Injectable()
export class TriggerBus {
  private readonly emitter = new EventEmitter();

  emitTaskStatus(event: TaskStatusEvent): void {
    try { this.emitter.emit('task.status', event); } catch { /* see header */ }
  }

  onTaskStatus(listener: (event: TaskStatusEvent) => void): () => void {
    const wrapped = (event: TaskStatusEvent) => { try { listener(event); } catch { /* see header */ } };
    this.emitter.on('task.status', wrapped);
    return () => { this.emitter.off('task.status', wrapped); };
  }

  emitTaskAdded(event: TaskAddedEvent): void {
    try { this.emitter.emit('task.added', event); } catch { /* listeners isolate their own failures */ }
  }

  onTaskAdded(listener: (event: TaskAddedEvent) => void): () => void {
    const wrapped = (event: TaskAddedEvent) => { try { listener(event); } catch { /* see header */ } };
    this.emitter.on('task.added', wrapped);
    return () => { this.emitter.off('task.added', wrapped); };
  }

  emitOrgWake(event: OrgWakeEvent): void {
    try { this.emitter.emit('org.wake', event); } catch { /* see header */ }
  }

  onOrgWake(listener: (event: OrgWakeEvent) => void): () => void {
    const wrapped = (event: OrgWakeEvent) => { try { listener(event); } catch { /* see header */ } };
    this.emitter.on('org.wake', wrapped);
    return () => { this.emitter.off('org.wake', wrapped); };
  }

  emitOrgBoard(event: OrgBoardEvent): void {
    try { this.emitter.emit('org.board', event); } catch { /* see header */ }
  }

  onOrgBoard(listener: (event: OrgBoardEvent) => void): () => void {
    const wrapped = (event: OrgBoardEvent) => { try { listener(event); } catch { /* see header */ } };
    this.emitter.on('org.board', wrapped);
    return () => { this.emitter.off('org.board', wrapped); };
  }
}
