import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, ValidateIf } from 'class-validator';
import { AgentsService } from './agents.service';
import { AgentMemoryService } from './agent-memory.service';
import { ConnectionsService } from '../connections/connections.service';
import { cardById } from '../connections/cards';
import { RunnerService } from '../runner/runner.service';
import { StorageService } from '../storage/storage.service';
import { agentFileKey, agentPrefix, agentRelativePath, workspaceFileKey } from '../storage/storage.keys';
import { contentTypeFor, previewKindFor } from '../storage/preview.util';
import { TranscriptionService, isAudioUpload } from '../voice/transcription.service';

class CreateAgentDto {
  @IsString() name!: string;
  /** The owning workspace (docs/shared-agents.md "Workspace ownership"): required over HTTP. */
  @IsString() workspaceId!: string;
  @IsOptional() @IsString() charter?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() homeDir?: string;
  @IsOptional() @IsString() emoji?: string;
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsArray() colors?: [string, string];
}

class UpdateAgentDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() charter?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() homeDir?: string;
  @IsOptional() @IsString() dashboard?: string;
  @IsOptional() @IsString() emoji?: string;
  @IsOptional() @IsString() role?: string;
  /** JSON [from,to] gradient pair. */
  @IsOptional() @IsString() colors?: string;
  /** JSON array of loops — validated server-side (≤10, bounded fields). */
  @IsOptional() @IsString() loops?: string;
  /** Assigned workspace folder, mounted into the agent's chats as shared/. */
  @IsOptional() @IsString() workspaceFolder?: string;
  /** The agent type the agent runs on (provider, key, base URL); null clears it. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() agentTypeId?: string | null;
  /** With agentTypeId/model: also switch the agent's existing chats. */
  @IsOptional() @IsBoolean() applyToChats?: boolean;
}

class MoveAgentDto {
  @IsString() workspaceId!: string;
}

class InstallLoopDto {
  @IsString() cardId!: string;
  @IsString() useId!: string;
}

class CreateTaskDto {
  @IsString() title!: string;
  @IsOptional() @IsString() note?: string;
}

class UpdateTaskDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsIn(['todo', 'doing', 'blocked', 'done', 'abandoned']) status?: string;
  /** Required when moving to blocked (what it waits on) or abandoned (why). */
  @IsOptional() @IsString() reason?: string;
}

class FeedbackDto {
  @IsIn(['up', 'down']) rating!: 'up' | 'down';
  @IsOptional() @IsString() note?: string;
  @IsString() turnId!: string;
}

class ActOnEventDto {
  @IsIn(['approve', 'dismiss']) decision!: 'approve' | 'dismiss';
}

@Controller('agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly storage: StorageService,
    private readonly connections: ConnectionsService,
    private readonly runner: RunnerService,
    private readonly memory: AgentMemoryService,
    private readonly voice: TranscriptionService,
  ) {}

  /** `?workspaceId=` lists that workspace's agents (the SPA always passes
   *  one); without it, every agent of the account. */
  @Get() list(@Query('workspaceId') workspaceId?: string) { return this.agents.list({ workspaceId: workspaceId || undefined }); }
  @Get(':id') get(@Param('id') id: string) { return this.agents.get(id); }
  @Post() async create(@Body() dto: CreateAgentDto) {
    if (!dto.workspaceId?.trim()) throw new BadRequestException('workspaceId is required: an agent belongs to one workspace');
    return this.agents.create(dto);
  }
  /** The explicit way an agent changes workspace; refused while it sits in an organization. */
  @Post(':id/move') async move(@Param('id') id: string, @Body() dto: MoveAgentDto) {
    if (!dto.workspaceId?.trim()) throw new BadRequestException('workspaceId is required');
    return this.agents.move(id, dto.workspaceId);
  }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateAgentDto) { return this.agents.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.agents.remove(id); }
  @Post(':id/feedback') async feedback(@Param('id') id: string, @Body() dto: FeedbackDto) {
    const res = await this.agents.addFeedback(id, dto);
    // A correction used to shape exactly one reply and then evaporate
    // (takeFeedback drains on read), which made the most explicit "learn
    // this" signal in the product the most ephemeral thing in it. A 👎 with
    // a note is now also a pinned lesson.
    if (dto.rating === 'down' && dto.note?.trim()) {
      const { lesson } = await this.memory.record(id, `The user corrected me: ${dto.note.trim()}`, { source: 'feedback' });
      await this.memory.update(id, lesson.id, { pinned: true });
    }
    return res;
  }

  // ---- memory (docs/agent-memory.md): visible, promotable, revocable ----

  @Get(':id/lessons') lessons(@Param('id') id: string) { return this.memory.list(id); }

  @Patch(':id/lessons/:lessonId')
  patchLesson(
    @Param('id') id: string, @Param('lessonId') lessonId: string,
    @Body() body: { trusted?: boolean; pinned?: boolean },
  ) {
    return this.memory.update(id, lessonId, body);
  }

  /** A memory nobody can delete is one nobody can correct. */
  @Delete(':id/lessons/:lessonId')
  deleteLesson(@Param('id') id: string, @Param('lessonId') lessonId: string) {
    return this.memory.remove(id, lessonId);
  }
  @Get(':id/stats') stats(@Param('id') id: string) { return this.agents.stats(id); }
  @Get(':id/apps') apps(@Param('id') id: string) { return this.agents.listApps(id); }
  @Delete(':id/apps/:appId') deleteApp(@Param('id') id: string, @Param('appId') appId: string) { return this.agents.deleteApp(id, appId); }

  // ---- the agent inbox: proactive-work notifications (phase 2) ----
  @Get('events/unread') unreadEvents() { return this.agents.unreadEventCounts(); }
  @Get(':id/events') events(@Param('id') id: string) { return this.agents.listEvents(id); }
  @Post(':id/events/read') markEventsRead(@Param('id') id: string) { return this.agents.markEventsRead(id); }
  /** Approve or dismiss a queued background action (action_pending event).
   *  Approval executes the queued connection tool through the same grant
   *  checks a live turn would apply. */
  @Post(':id/events/:eventId/act')
  actOnEvent(@Param('id') id: string, @Param('eventId') eventId: string, @Body() dto: ActOnEventDto) {
    return this.agents.resolveActionEvent(id, eventId, dto.decision === 'approve',
      (agentId, tool, input) => this.runner.owns(tool)
        ? this.runner.execute(tool, input)
        : this.connections.execute(agentId, tool, input));
  }

  // ---- self-built HTTP tools: proposed by the agent, user-activated ----
  /** Install a context card's suggested loop (docs/integrations.md "Context
   *  cards and suggested loops"); refused without the grant level it needs. */
  @Post(':id/loops/install')
  async installLoop(@Param('id') id: string, @Body() dto: InstallLoopDto) {
    const card = cardById(dto.cardId);
    const held = card && card.provider
      ? (await this.connections.grantLevels(id)).find((g) => g.provider === card.provider && g.service === card.service)?.level ?? null
      : null;
    return this.agents.installSuggestedLoop(id, dto.cardId, dto.useId, held);
  }

  @Get(':id/tools') customTools(@Param('id') id: string) { return this.agents.listCustomTools(id); }
  @Post(':id/tools/:toolId/approve') approveTool(@Param('id') id: string, @Param('toolId') toolId: string) { return this.agents.resolveCustomTool(id, toolId, true); }
  @Delete(':id/tools/:toolId') deleteTool(@Param('id') id: string, @Param('toolId') toolId: string) { return this.agents.resolveCustomTool(id, toolId, false); }

  // ---- the agent's kanban board (§11) ----
  @Get(':id/tasks') tasks(@Param('id') id: string) { return this.agents.listTasks(id); }
  @Post(':id/tasks') addTask(@Param('id') id: string, @Body() dto: CreateTaskDto) { return this.agents.addTask(id, dto); }
  @Patch(':id/tasks/:taskId') updateTask(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: UpdateTaskDto) {
    return this.agents.updateTask(id, taskId, dto);
  }
  @Delete(':id/tasks/:taskId') deleteTask(@Param('id') id: string, @Param('taskId') taskId: string) { return this.agents.deleteTask(id, taskId); }
  // AGENT.json export/import: PortabilityController (server/src/portability/).

  // ---- file brain (FR-11.3): same S3 store, agent-scoped prefix ----

  @Get(':id/files')
  async listFiles(@Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    const agent = await this.agents.get(id);
    const objects = await this.storage.list(agentPrefix(id));
    const out = objects.map((o) => ({ path: agentRelativePath(id, o.key), size: o.size, lastModified: o.lastModified }));
    // the assigned workspace folder appears under shared/ (same view the
    // agent's own fs tools have)
    const folder = agent.workspaceFolder?.trim();
    if (folder && workspaceId) {
      const prefix = `${workspaceFileKey(workspaceId, folder)}/`;
      for (const o of await this.storage.list(prefix)) {
        out.push({ path: `shared/${o.key.slice(prefix.length)}`, size: o.size, lastModified: o.lastModified });
      }
    }
    return out;
  }

  @Post(':id/files')
  async putFile(@Param('id') id: string, @Body() body: { path: string; contentBase64: string; contentType?: string; durationSeconds?: number }) {
    await this.agents.get(id);
    const key = this.key(id, body.path);
    const bytes = Buffer.from(body.contentBase64 ?? '', 'base64');
    // Voice notes (docs/voice.md): same bounds + transcript sidecar as the workspace endpoint.
    const audio = isAudioUpload(body.path, body.contentType);
    if (audio) this.voice.assertAudioBounds(body.path, bytes, body.contentType);
    await this.storage.put(key, bytes, body.contentType);
    if (!audio) return { ok: true, path: body.path };
    const duration = typeof body.durationSeconds === 'number' ? body.durationSeconds : undefined;
    const { transcript, durationHint } = await this.voice.transcribeUpload(key, body.path, bytes, body.contentType, duration);
    return { ok: true, path: body.path, transcript, durationHint };
  }

  @Get(':id/preview')
  async preview(@Param('id') id: string, @Query('path') path: string, @Query('workspaceId') workspaceId?: string) {
    const body = await this.storage.get(await this.resolveKey(id, path ?? '', workspaceId));
    if (body === null) throw new NotFoundException(`file ${path}`);
    const kind = previewKindFor(path ?? '');
    const base = { path, kind, size: body.length, contentType: contentTypeFor(path ?? '') };
    if (kind === 'markdown' || kind === 'html' || kind === 'text') {
      return { ...base, text: body.toString('utf8').slice(0, 200_000) };
    }
    if (body.length <= 5_000_000) return { ...base, base64: body.toString('base64') };
    return base;
  }

  @Delete(':id/file')
  async deleteFile(@Param('id') id: string, @Query('path') path: string) {
    await this.agents.get(id);
    await this.storage.delete(this.key(id, path ?? ''));
    return { ok: true };
  }

  private key(id: string, path: string): string {
    try {
      return agentFileKey(id, path);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'invalid path');
    }
  }

  /** shared/<rest> resolves into the agent's assigned workspace folder. */
  private async resolveKey(id: string, path: string, workspaceId?: string): Promise<string> {
    const agent = await this.agents.get(id);
    const folder = agent.workspaceFolder?.trim();
    if (folder && workspaceId && path.startsWith('shared/')) {
      try {
        return workspaceFileKey(workspaceId, `${folder}/${path.slice('shared/'.length)}`);
      } catch (err) {
        throw new BadRequestException(err instanceof Error ? err.message : 'invalid path');
      }
    }
    return this.key(id, path);
  }
}
