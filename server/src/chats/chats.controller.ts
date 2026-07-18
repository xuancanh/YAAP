/**
 * ChatsController — the chat HTTP surface.
 *
 * Turns stream over SSE: POST /api/chats/:id/turns holds the response open
 * and writes `data: <json>` events (answer/thinking/usage/done/error) as the
 * loop yields them, so the frontend renders tokens as they arrive (FR-3.2)
 * and POST /api/chats/:id/stop aborts mid-flight (FR-5.4).
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ChatsService } from './chats.service';
import { TurnLoopService, ApprovalDecision } from './turn-loop.service';
import { CompactionService } from './compaction.service';
import { DistillService } from './distill.service';

class CreateChatDto {
  @IsString() workspaceId!: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() cwd?: string;
  @IsOptional() @IsString() agentId?: string;
  @IsOptional() @IsString() agentTypeId?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsInt() @Min(0) tokenCeiling?: number;
}

class UpdateChatDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() draft?: string;
  @IsOptional() @IsIn(['ask', 'auto']) permissionMode?: 'ask' | 'auto';
  @IsOptional() @IsIn(['off', 'low', 'medium', 'high']) thinkingEffort?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() agentTypeId?: string;
  @IsOptional() @IsInt() @Min(0) tokenCeiling?: number;
  @IsOptional() @IsString() cwd?: string;
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsArray() tags?: string[];
}

class SendTurnDto {
  @IsString() text!: string;
  @IsOptional() @IsArray() attachments?: unknown[];
}

class RateTurnDto {
  @IsIn(['up', 'down']) rating!: 'up' | 'down';
  @IsOptional() @IsString() note?: string;
}

class ApproveDto {
  @IsString() callId!: string;
  @IsIn(['allow-once', 'allow-always', 'allow-tool', 'deny']) decision!: ApprovalDecision;
}

@Controller('chats')
export class ChatsController {
  constructor(
    private readonly chats: ChatsService,
    private readonly turns: TurnLoopService,
    private readonly compaction: CompactionService,
    private readonly distillSvc: DistillService,
  ) {}

  @Get()
  list(@Query('workspaceId') workspaceId: string, @Query('archived') archived?: string) {
    return this.chats.list(workspaceId, archived === 'true');
  }

  @Post() create(@Body() dto: CreateChatDto) { return this.chats.create(dto); }
  @Get(':id') get(@Param('id') id: string) { return this.chats.get(id); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateChatDto) { return this.chats.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.chats.remove(id); }
  @Post(':id/archive')
  async archive(@Param('id') id: string) {
    const res = await this.chats.archive(id);
    // archiving an agent chat distills it into the brain (fire-and-forget)
    const session = await this.chats.get(id).catch(() => null);
    if (session?.agentId) void this.distillSvc.distill(id).catch(() => {});
    return res;
  }
  @Post(':id/restore') restore(@Param('id') id: string) { return this.chats.restore(id); }
  @Get(':id/transcript') transcript(@Param('id') id: string) { return this.chats.transcript(id); }
  @Post(':id/clear') clear(@Param('id') id: string) { return this.chats.clear(id); }

  @Get(':id/export')
  export(@Param('id') id: string, @Res() res: Response) {
    res.type('text/markdown').send(this.chats.exportMarkdown(id));
  }

  @Post(':id/turns')
  async sendTurn(@Param('id') id: string, @Body() dto: SendTurnDto, @Res() res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    try {
      for await (const ev of this.turns.run(id, dto)) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    }
    res.end();
    void this.compaction.maybeAutoCompact(id);
  }

  /** Distill this chat's work into the owning agent's brain (FR-11.4). */
  @Post(':id/distill')
  distill(@Param('id') id: string) {
    return this.distillSvc.distill(id);
  }

  /** Resolve a paused Ask-mode tool approval (§4). */
  @Post(':id/approve')
  approve(@Param('id') id: string, @Body() dto: ApproveDto) {
    return { resolved: this.turns.resolveApproval(id, dto.callId, dto.decision) };
  }

  /** /compact — distill private history into a summary (FR-7.3). */
  @Post(':id/compact')
  compact(@Param('id') id: string) {
    return this.compaction.compact(id);
  }

  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return { stopped: this.turns.stop(id) };
  }

  /** Fork into a new session, optionally branching at a turn (FR-6.3). */
  @Post(':id/fork')
  fork(@Param('id') id: string, @Body() body: { turnId?: string }) {
    return this.chats.fork(id, body?.turnId);
  }

  /** Edit & resend / retry: drop a turn and everything after it (FR-6.1/6.2). */
  @Post(':id/truncate')
  truncate(@Param('id') id: string, @Body() body: { turnId: string }) {
    return this.chats.truncateFrom(id, body.turnId);
  }

  /** Promote a turn to a board task (FR-6.4). */
  @Post(':id/turns/:turnId/promote')
  promote(@Param('id') id: string, @Param('turnId') turnId: string) {
    return this.chats.promoteTurn(id, turnId);
  }

  @Post(':id/turns/:turnId/rate')
  rate(@Param('id') id: string, @Param('turnId') turnId: string, @Body() dto: RateTurnDto) {
    return this.chats.rateTurn(id, turnId, dto.rating, dto.note);
  }
}
