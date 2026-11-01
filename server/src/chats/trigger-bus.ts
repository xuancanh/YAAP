/**
 * TriggerBus — a tiny in-process event bus that lets the agents domain tell
 * the loops domain something happened without importing it (AgentsModule is
 * a dependency of ChatsModule, never the other way round). Today it carries
 * one event: a task landed on an agent's board (docs/triggers.md, the `task`
 * trigger). Listeners are fire-and-forget; a throwing listener must not
 * break the write that emitted the event.
 */
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface TaskAddedEvent {
  agentId: string;
  task: { id: string; title: string; note: string; origin: string; sessionId: string | null; createdAt: string };
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
}
