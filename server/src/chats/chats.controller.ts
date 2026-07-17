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
import { TurnLoopService } from './turn-loop.service';

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

@Controller('chats')
export class ChatsController {
  constructor(
    private readonly chats: ChatsService,
    private readonly turns: TurnLoopService,
  ) {}

  @Get()
  list(@Query('workspaceId') workspaceId: string, @Query('archived') archived?: string) {
    return this.chats.list(workspaceId, archived === 'true');
  }

  @Post() create(@Body() dto: CreateChatDto) { return this.chats.create(dto); }
  @Get(':id') get(@Param('id') id: string) { return this.chats.get(id); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateChatDto) { return this.chats.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.chats.remove(id); }
  @Post(':id/archive') archive(@Param('id') id: string) { return this.chats.archive(id); }
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
  }

  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return { stopped: this.turns.stop(id) };
  }

  @Post(':id/turns/:turnId/rate')
  rate(@Param('id') id: string, @Param('turnId') turnId: string, @Body() dto: RateTurnDto) {
    return this.chats.rateTurn(id, turnId, dto.rating, dto.note);
  }
}
