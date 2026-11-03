/**
 * ChatsController — the chat HTTP surface.
 *
 * Turns stream over SSE: POST /api/chats/:id/turns holds the response open
 * and writes `data: <json>` events (answer/thinking/usage/done/error) as the
 * loop yields them, so the frontend renders tokens as they arrive (FR-3.2)
 * and POST /api/chats/:id/stop aborts mid-flight (FR-5.4).
 */
import { Body, Controller, Delete, Get, Optional, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AccountsService } from '../accounts/accounts.service';
import { actorId } from '../accounts/account-context';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';
import { ChatsService } from './chats.service';
import { TurnLoopService, ApprovalDecision } from './turn-loop.service';
import { CompactionService } from './compaction.service';
import { turnWatch } from './live-turns';
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
  /** Shared workspaces: visible to every member (true) or the creator and
   *  the owner only (false). */
  @IsOptional() @IsBoolean() shared?: boolean;
  /** Auto-archive (docs/chat-archiving.md): days after the linked task is
   *  finished; 0 = off; null = the workspace default. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(0) @Max(365) autoArchiveDays?: number | null;
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
    /** Optional so test constructors keep working; with it the turn stream
     *  carries the account's month in headers (docs/accounts.md §4). */
    @Optional() private readonly accounts?: AccountsService,
  ) {}

  @Get()
  list(@Query('workspaceId') workspaceId: string, @Query('archived') archived?: string) {
    return this.chats.list(workspaceId, archived === 'true');
  }

  /** The Home rail (docs/chat-archiving.md): `limits` is `agentId:count`
   *  pairs (comma-separated; '' = agent-less) for groups showing more than
   *  `perAgent`. */
  @Get('rail')
  rail(@Query('workspaceId') workspaceId: string, @Query('perAgent') perAgent?: string, @Query('limits') limits?: string, @Query('q') q?: string) {
    const parsed: Record<string, number> = {};
    for (const pair of (limits ?? '').split(',')) {
      const i = pair.lastIndexOf(':');
      if (i < 0) continue;
      const n = Number(pair.slice(i + 1));
      if (Number.isFinite(n) && n > 0) parsed[pair.slice(0, i)] = n;
    }
    return this.chats.rail(workspaceId, { perAgent: perAgent ? Number(perAgent) || undefined : undefined, limits: parsed, q });
  }

  /** One page of chats: `agentId` ('none' = agent-less; omitted = all),
   *  `archived`, `q`, `limit`, `cursor`. Conversations only — the agents'
   *  runs (`kind: 'work'`) page through GET /agents/:id/work-log. */
  @Get('page')
  page(@Query('workspaceId') workspaceId: string, @Query('agentId') agentId?: string, @Query('archived') archived?: string,
    @Query('q') q?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.chats.page(workspaceId, {
      agentId: agentId === undefined || agentId === '' ? undefined : agentId === 'none' ? null : agentId,
      archived: archived === 'true',
      q, limit: limit ? Number(limit) || undefined : undefined, cursor: cursor || null,
    });
  }

  @Post() create(@Body() dto: CreateChatDto) { return this.chats.create(dto); }
  @Get(':id') get(@Param('id') id: string) { return this.chats.get(id); }
  @Patch(':id') async update(@Param('id') id: string, @Body() dto: UpdateChatDto) {
    const { shared, ...rest } = dto;
    if (shared !== undefined) await this.chats.setShared(id, shared);
    return Object.keys(rest).length > 0 ? this.chats.update(id, rest) : this.chats.get(id);
  }
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
  async export(@Param('id') id: string, @Res() res: Response) {
    res.type('text/markdown').send(await this.chats.exportMarkdown(id));
  }

  @Post(':id/turns')
  async sendTurn(@Param('id') id: string, @Body() dto: SendTurnDto, @Res() res: Response) {
    await this.chats.get(id); // 404 for a session the actor may not see
    // X-Yaam-Plan / -Usage-Usd / -Hosted-Usd / -Ceiling-Usd: the account's
    // month at a glance, before the stream starts.
    const usage = this.accounts ? await this.accounts.usageHeaders().catch(() => ({})) : {};
    res.writeHead(200, {
      ...usage,
      'Content-Type': 'text/event-stream',
      // no-transform stops proxies (Cloudflare, CDNs) from recompressing the
      // stream; X-Accel-Buffering stops nginx/tunnel hops from batching SSE.
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    // A client disconnect mid-turn (e.g. while paused on an approval) must
    // abort the turn through the same path as /stop, otherwise the busy lock
    // and the pending approval resolver leak until restart.
    let finished = false;
    res.on('close', () => { if (!finished) this.turns.stop(id); });
    // A dead socket must never crash the process with an unhandled error.
    res.on('error', () => {});
    // SSE keepalive: idle-timeout proxies kill the connection during long
    // thinking pauses, tool runs, or approval waits, so ping while quiet.
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);
    try {
      // A person typed this (the chat or the Work log composer): origin
      // 'user', so Ask-mode approvals apply in a work session too.
      for await (const ev of this.turns.run(id, { text: dto.text, attachments: dto.attachments, origin: 'user', source: 'person' })) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    } finally {
      finished = true;
      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
    }
    void this.compaction.maybeAutoCompact(id);
  }

  /** Distill this chat's work into the owning agent's brain (FR-11.4). */
  @Post(':id/distill')
  distill(@Param('id') id: string) {
    return this.distillSvc.distill(id);
  }

  /** Resolve a paused Ask-mode tool approval (§4). Only for a session the
   *  caller may see (a member's on shared sessions and their own). */
  @Post(':id/approve')
  async approve(@Param('id') id: string, @Body() dto: ApproveDto) {
    await this.chats.get(id);
    // An approval routed to another member (docs/shared-agents.md §3) is
    // theirs to answer: this path reports it unresolved for anyone else.
    return { resolved: this.turns.resolveApproval(id, dto.callId, dto.decision, actorId()) };
  }

  /** Watch the turn running in a session, whoever started it (the Work
   *  log's live view, docs/work-log.md "Intervening"). SSE: `{ type: 'live',
   *  turnId, source, startedAt }`, the turn's events so far, then each new
   *  one, then `{ type: 'end' }`; `{ type: 'idle' }` when nothing runs here. */
  @Get(':id/live')
  async live(@Param('id') id: string, @Res() res: Response) {
    await this.chats.get(id); // 404 for a session the actor may not see
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.on('error', () => {});
    const write = (ev: unknown) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    let unsubscribe = () => {};
    const timers: { keepalive?: ReturnType<typeof setInterval> } = {};
    const close = () => { unsubscribe(); if (timers.keepalive) clearInterval(timers.keepalive); if (!res.writableEnded) res.end(); };
    const sub = turnWatch.watch(id, (ev) => { write(ev); if (ev.type === 'end') close(); });
    if (!sub) { write({ type: 'idle', busy: this.turns.isBusy(id) }); res.end(); return; }
    unsubscribe = sub.unsubscribe;
    write({ type: 'live', turnId: sub.start.turnId, source: sub.start.source, startedAt: sub.start.startedAt });
    for (const ev of sub.start.replay) write(ev);
    timers.keepalive = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
    res.on('close', close);
  }

  /** /compact — distill private history into a summary (FR-7.3). */
  @Post(':id/compact')
  compact(@Param('id') id: string) {
    return this.compaction.compact(id);
  }

  @Post(':id/stop')
  async stop(@Param('id') id: string) {
    await this.chats.get(id); // only a session the caller may see
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
