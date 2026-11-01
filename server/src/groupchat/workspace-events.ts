/**
 * WorkspaceEventBus — the in-process fan-out behind the workspace SSE stream
 * (docs/group-chat.md §4, `GET /api/workspaces/:id/events`). Everything a
 * channel does that a client should see live is emitted here: a persisted
 * message, an agent starting to reply (typing), the tokens of its reply as
 * they stream, a task linked to a message changing status, a channel's
 * settings or membership changing, and an approval a channel wake needs from
 * one specific person. Listeners are per workspace and fire-and-forget; a
 * throwing listener never breaks the write that emitted the event.
 */
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface ChannelMessageShape {
  id: string;
  channelId: string;
  threadRootId: string | null;
  authorKind: string;
  authorId: string;
  text: string;
  attachments: string;
  mentions: string;
  taskId: string | null;
  runId: string | null;
  unprompted: number;
  editedAt: string | null;
  createdAt: string;
}

export type WorkspaceEvent =
  | { type: 'channel_message'; workspaceId: string; channelId: string; message: ChannelMessageShape }
  /** An agent run started for a channel message: show the typing indicator. */
  | { type: 'channel_typing'; workspaceId: string; channelId: string; threadRootId: string | null; agentId: string; liveId: string; on: boolean }
  /** Reply tokens as they stream; `done` closes the live message (the
   *  persisted row arrives as its own channel_message). */
  | { type: 'channel_stream'; workspaceId: string; channelId: string; threadRootId: string | null; agentId: string; liveId: string; delta: string; done?: boolean }
  | { type: 'task_update'; workspaceId: string; channelId: string; taskId: string; status: string; messageId: string | null; title: string }
  | { type: 'channel_update'; workspaceId: string; channelId: string }
  /** A channel wake paused on an Ask approval. Visible only to `forActor`
   *  (the human who started the turn, or the member whose connection the
   *  tool would use); the client filters by its own actor id. */
  | { type: 'channel_approval'; workspaceId: string; channelId: string; threadRootId: string | null; agentId: string; sessionId: string; callId: string; tool: string; input: Record<string, unknown>; forActor: string; forName: string };

@Injectable()
export class WorkspaceEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: WorkspaceEvent): void {
    try { this.emitter.emit(`ws:${event.workspaceId}`, event); } catch { /* listeners isolate their own failures */ }
  }

  subscribe(workspaceId: string, listener: (event: WorkspaceEvent) => void): () => void {
    const wrapped = (event: WorkspaceEvent) => { try { listener(event); } catch { /* see header */ } };
    this.emitter.on(`ws:${workspaceId}`, wrapped);
    return () => { this.emitter.off(`ws:${workspaceId}`, wrapped); };
  }
}
