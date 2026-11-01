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

@Injectable()
export class TriggerBus {
  private readonly emitter = new EventEmitter();

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
}
