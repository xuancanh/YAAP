/**
 * GroupChatController — the channel HTTP surface (docs/group-chat.md §1–§4).
 *
 *   /api/workspaces/:id/chat/channels                  list · create
 *   /api/workspaces/:id/chat/channels/:slug            get · patch · archive · unarchive
 *   /api/workspaces/:id/chat/channels/:slug/members    list · add · patch · remove
 *   /api/workspaces/:id/chat/channels/:slug/messages   page (top level or ?thread=) · post
 *   /api/workspaces/:id/chat/channels/:slug/messages/:messageId/task   make a task
 *   /api/workspaces/:id/chat/channels/:slug/read       move the read cursor
 *   /api/workspaces/:id/chat/channels/:slug/files      the channel folder
 *   /api/workspaces/:id/chat/goals/:goalId/messages    messages that reference #goal:<id> (§7)
 *   /api/workspaces/:id/chat/decisions/:decisionId      the decision a #decision:<id> chip names (§8)
 *   /api/workspaces/:id/events                         workspace SSE (§4)
 *
 * `/chat/` sits in the path because `/api/workspaces/:id/channels` already
 * names a member's Telegram/email pairings (shared.controller.ts). Uploads
 * use the existing workspace file routes with a `channels/<slug>/…` path.
 * Role enforcement is the WorkspaceAccessGuard's: viewers read, members
 * write; channel-owner checks live in the service.
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { GroupChatService } from './groupchat.service';
import { ChannelRuntimeService } from './channel-runtime.service';
import { WorkspaceEventBus } from './workspace-events';
import { WorkspacesService } from '../workspaces/workspaces.service';

class CreateChannelDto {
  @IsString() name!: string;
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsString() topic?: string;
  @IsOptional() @IsIn(['public', 'private']) kind?: 'public' | 'private';
  @IsOptional() @IsArray() agentIds?: string[];
  @IsOptional() @IsArray() humanIds?: string[];
}

class UpdateChannelDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() topic?: string;
  @IsOptional() @IsIn(['public', 'private']) kind?: 'public' | 'private';
  @IsOptional() @IsInt() @Min(0) dailyTokenBudget?: number;
}

class AddMemberDto {
  @IsIn(['agent', 'human']) kind!: 'agent' | 'human';
  @IsString() id!: string;
  @IsOptional() @IsIn(['owner', 'member']) role?: 'owner' | 'member';
  @IsOptional() @IsIn(['all', 'mentions', 'none']) notify?: string;
  @IsOptional() @IsBoolean() unprompted?: boolean;
}

class UpdateMemberDto {
  @IsOptional() @IsIn(['owner', 'member']) role?: 'owner' | 'member';
  @IsOptional() @IsIn(['all', 'mentions', 'none']) notify?: string;
  @IsOptional() @IsBoolean() unprompted?: boolean;
}

class PostMessageDto {
  @IsString() text!: string;
  @IsOptional() @IsString() threadRootId?: string;
  @IsOptional() @IsArray() attachments?: Array<{ path: string; kind: string }>;
}

class MakeTaskDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() assigneeAgentId?: string;
}

class ReadDto { @IsOptional() @IsString() messageId?: string }

@Controller('workspaces/:id')
export class GroupChatController {
  constructor(
    private readonly groupchat: GroupChatService,
    private readonly runtime: ChannelRuntimeService,
    private readonly events: WorkspaceEventBus,
    private readonly workspaces: WorkspacesService,
  ) {}

  @Get('chat/channels')
  list(@Param('id') id: string, @Query('archived') archived?: string) {
    return this.groupchat.list(id, { archived: archived === 'true' });
  }

  @Post('chat/channels')
  create(@Param('id') id: string, @Body() dto: CreateChannelDto) {
    return this.groupchat.create(id, dto);
  }

  @Get('chat/channels/:slug')
  async get(@Param('id') id: string, @Param('slug') slug: string) {
    const c = await this.groupchat.open(id, slug);
    const members = await this.groupchat.members(c.id);
    const [spent, org, unit] = await Promise.all([this.runtime.spentToday(c).catch(() => 0), this.groupchat.orgFor(id), this.groupchat.unitOf(c.id).catch(() => null)]);
    return { ...c, members, spentToday: spent, orgMode: Boolean(org), unit };
  }

  /** Messages referencing `#goal:<id>` (docs/group-chat.md §3, §7): the goal page lists them. */
  @Get('chat/goals/:goalId/messages')
  goalMessages(@Param('id') id: string, @Param('goalId') goalId: string, @Query('limit') limit?: string) {
    return this.groupchat.goalMessages(id, goalId, limit ? Number(limit) : undefined);
  }

  /** The decision-log row a `#decision:<id>` reference names (docs/group-chat.md §8). */
  @Get('chat/decisions/:decisionId')
  decision(@Param('id') id: string, @Param('decisionId') decisionId: string) {
    return this.groupchat.decision(id, decisionId);
  }

  @Patch('chat/channels/:slug')
  async update(@Param('id') id: string, @Param('slug') slug: string, @Body() dto: UpdateChannelDto) {
    const c = await this.groupchat.open(id, slug);
    return this.groupchat.update(c.id, dto);
  }

  @Post('chat/channels/:slug/archive')
  async archive(@Param('id') id: string, @Param('slug') slug: string) {
    return this.groupchat.archive((await this.groupchat.open(id, slug)).id, true);
  }

  @Post('chat/channels/:slug/unarchive')
  async unarchive(@Param('id') id: string, @Param('slug') slug: string) {
    return this.groupchat.archive((await this.groupchat.bySlug(id, slug)).id, false);
  }

  @Get('chat/channels/:slug/members')
  async members(@Param('id') id: string, @Param('slug') slug: string) {
    return this.groupchat.members((await this.groupchat.open(id, slug)).id);
  }

  @Post('chat/channels/:slug/members')
  async addMember(@Param('id') id: string, @Param('slug') slug: string, @Body() dto: AddMemberDto) {
    return this.groupchat.addMember((await this.groupchat.open(id, slug)).id, dto);
  }

  @Patch('chat/channels/:slug/members/:kind/:memberId')
  async updateMember(@Param('id') id: string, @Param('slug') slug: string, @Param('kind') kind: 'agent' | 'human', @Param('memberId') memberId: string, @Body() dto: UpdateMemberDto) {
    return this.groupchat.updateMember((await this.groupchat.open(id, slug)).id, kind, memberId, dto);
  }

  @Delete('chat/channels/:slug/members/:kind/:memberId')
  async removeMember(@Param('id') id: string, @Param('slug') slug: string, @Param('kind') kind: 'agent' | 'human', @Param('memberId') memberId: string) {
    return this.groupchat.removeMember((await this.groupchat.open(id, slug)).id, kind, memberId);
  }

  @Get('chat/channels/:slug/messages')
  async messages(@Param('id') id: string, @Param('slug') slug: string, @Query('thread') thread?: string, @Query('before') before?: string, @Query('limit') limit?: string) {
    const c = await this.groupchat.open(id, slug);
    return this.groupchat.messages(c.id, { thread: thread || null, before: before || undefined, limit: limit ? Number(limit) : undefined });
  }

  @Post('chat/channels/:slug/messages')
  async post(@Param('id') id: string, @Param('slug') slug: string, @Body() dto: PostMessageDto) {
    const c = await this.groupchat.open(id, slug);
    return this.groupchat.post(c.id, { text: dto.text, threadRootId: dto.threadRootId ?? null, attachments: dto.attachments, authorKind: 'human' });
  }

  @Post('chat/channels/:slug/messages/:messageId/task')
  async makeTask(@Param('id') id: string, @Param('slug') slug: string, @Param('messageId') messageId: string, @Body() dto: MakeTaskDto, @Req() req: Request & { accountId?: string; viewer?: { memberAccountId: string } }) {
    const c = await this.groupchat.open(id, slug);
    const by = req.viewer?.memberAccountId ?? req.accountId ?? '';
    return this.groupchat.makeTask(c.id, messageId, { title: dto.title, assigneeAgentId: dto.assigneeAgentId ?? null, by: { kind: 'human', id: by } });
  }

  @Post('chat/channels/:slug/read')
  async read(@Param('id') id: string, @Param('slug') slug: string, @Body() dto: ReadDto) {
    return this.groupchat.markRead((await this.groupchat.open(id, slug)).id, dto.messageId);
  }

  @Get('chat/channels/:slug/files')
  async files(@Param('id') id: string, @Param('slug') slug: string) {
    return this.groupchat.files((await this.groupchat.open(id, slug)).id);
  }

  /** Workspace SSE (§4): channel_message · channel_typing · channel_stream ·
   *  task_update · channel_update · channel_approval. Same wire format as the
   *  turn stream; keepalive pings every 15s. */
  @Get('events')
  async events_(@Param('id') id: string, @Res() res: Response) {
    await this.workspaces.get(id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', workspaceId: id })}\n\n`);
    const unsubscribe = this.events.subscribe(id, (ev) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    const keepalive = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
    const close = () => { clearInterval(keepalive); unsubscribe(); if (!res.writableEnded) res.end(); };
    res.on('close', close);
    res.on('error', close);
  }
}
