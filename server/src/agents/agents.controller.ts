import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Optional, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';
import { AgentsService } from './agents.service';
import { AgentMemoryService } from './agent-memory.service';
import { ConnectionsService } from '../connections/connections.service';
import { cardById } from '../connections/cards';
import { RunnerService } from '../runner/runner.service';
import { StorageService } from '../storage/storage.service';
import { workspaceFileKey } from '../storage/storage.keys';
import { WorkspaceFs, resolvePath } from '../files/workspace-fs.service';
import { fsHttp } from '../files/fs-http';
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
  /** Default auto-archive for the agent's new task chats (docs/chat-archiving.md):
   *  days after the task is finished; 0 = off; null = the workspace default. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(0) @Max(365) chatAutoArchiveDays?: number | null;
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
    /** Optional so test constructors without it keep working (unversioned). */
    @Optional() fs?: WorkspaceFs,
  ) {
    this.fs = fs ?? new WorkspaceFs(storage);
  }

  private readonly fs: WorkspaceFs;

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

  // ---- file brain (FR-11.3): the agent's home in its workspace's tree ----
  // (docs/filesystem.md "API": these routes stay and map onto the home, so
  // paths here are home-relative; shared/… is the assigned folder.)

  @Get(':id/files')
  async listFiles(@Param('id') id: string) {
    const { agent, workspaceId, home } = await this.homeOf(id);
    const out = (await this.fs.list(workspaceId, home)).map((f) => ({ ...f, path: f.path.slice(home.length + 1) }));
    // the assigned workspace folder appears under shared/ (same view the
    // agent's own fs tools have)
    const folder = agent.workspaceFolder?.trim().replace(/^\/+|\/+$/g, '');
    if (folder) {
      for (const f of await this.fs.list(workspaceId, folder).catch(() => [])) {
        out.push({ ...f, path: `shared/${f.path.slice(folder.length + 1)}` });
      }
    }
    return out;
  }

  @Post(':id/files')
  async putFile(@Param('id') id: string, @Body() body: { path: string; contentBase64: string; contentType?: string; durationSeconds?: number; expectedVersion?: number }) {
    const target = await this.resolve(id, body.path);
    const bytes = Buffer.from(body.contentBase64 ?? '', 'base64');
    // Voice notes (docs/voice.md): same bounds + transcript sidecar as the workspace endpoint.
    const audio = isAudioUpload(body.path, body.contentType);
    if (audio) this.voice.assertAudioBounds(body.path, bytes, body.contentType);
    const by = await this.fs.userActor();
    const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;
    const meta = await fsHttp(() => this.fs.write(target.workspaceId, target.path, bytes, { by, contentType: body.contentType, expectedVersion }));
    if (!audio) return { ok: true, path: body.path, version: meta.version };
    const duration = typeof body.durationSeconds === 'number' ? body.durationSeconds : undefined;
    const key = workspaceFileKey(target.workspaceId, target.path);
    const { transcript, durationHint } = await this.voice.transcribeUpload(key, body.path, bytes, body.contentType, duration);
    return { ok: true, path: body.path, version: meta.version, transcript, durationHint };
  }

  @Get(':id/preview')
  async preview(@Param('id') id: string, @Query('path') path: string) {
    const target = await this.resolve(id, path ?? '');
    const file = await this.fs.read(target.workspaceId, target.path);
    if (file === null) throw new NotFoundException(`file ${path}`);
    const body = file.body;
    const kind = previewKindFor(path ?? '');
    const meta = file.meta ? { version: file.meta.version, updatedBy: file.meta.updatedBy, updatedAt: file.meta.updatedAt } : {};
    const base = { path, kind, size: body.length, contentType: contentTypeFor(path ?? ''), ...meta };
    if (kind === 'markdown' || kind === 'html' || kind === 'text') {
      return { ...base, text: body.toString('utf8').slice(0, 200_000) };
    }
    if (body.length <= 5_000_000) return { ...base, base64: body.toString('base64') };
    return base;
  }

  @Delete(':id/file')
  async deleteFile(@Param('id') id: string, @Query('path') path: string) {
    const target = await this.resolve(id, path ?? '');
    const by = await this.fs.userActor();
    await fsHttp(() => this.fs.delete(target.workspaceId, target.path, { by }));
    return { ok: true };
  }

  /** The agent, its workspace and its home folder (400 if it has no home:
   *  an agent without a workspace). */
  private async homeOf(id: string) {
    const agent = await this.agents.get(id);
    const home = await this.agents.home(agent);
    if (!home.home) throw new BadRequestException(`${agent.name} has no workspace, so no home folder yet`);
    return { agent, workspaceId: home.workspaceId, home: home.home };
  }

  /** A home-relative path (or shared/<rest> into the assigned folder) as a
   *  workspace-relative one. */
  private async resolve(id: string, path: string): Promise<{ workspaceId: string; path: string }> {
    const { agent, workspaceId, home } = await this.homeOf(id);
    const folder = agent.workspaceFolder?.trim().replace(/^\/+|\/+$/g, '') || undefined;
    try {
      const resolved = resolvePath({ home, sharedFolder: folder }, path.replace(/^\/+/, ''));
      if (!resolved) throw new Error('empty path');
      return { workspaceId, path: resolved };
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'invalid path');
    }
  }
}
