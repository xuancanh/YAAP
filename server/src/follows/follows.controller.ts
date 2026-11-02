/**
 * FollowsController — the person's side of follows (docs/follows.md):
 *
 *   GET  /api/workspaces/:id/follows?targetKind=&targetId=   followers + whether I follow
 *   GET  /api/workspaces/:id/follows/mine                    what I follow, with what is new
 *   POST /api/workspaces/:id/follows                         follow   { targetKind, targetId }
 *   POST /api/workspaces/:id/follows/unfollow                unfollow { targetKind, targetId }
 *   POST /api/workspaces/:id/follows/seen                    I looked { targetKind, targetId }
 *
 * The follower is always the caller (`actorId()`); viewers read only (the
 * WorkspaceAccessGuard), so they see followers but cannot follow.
 */
import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import { eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { workspaces } from '../database/schema';
import { actorId } from '../accounts/account-context';
import { FollowsService, FOLLOW_TARGET_KINDS, type FollowTargetKind } from './follows.service';

class TargetDto {
  @IsIn(FOLLOW_TARGET_KINDS as unknown as string[]) targetKind!: FollowTargetKind;
  @IsString() targetId!: string;
}

@Controller('workspaces/:id/follows')
export class FollowsController {
  constructor(
    private readonly follows: FollowsService,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
  ) {}

  /** The workspace must be the caller's (the scoped handle sees only its account's). */
  private async ws(id: string): Promise<string> {
    const row = (await this.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, id)).limit(1)).at(0);
    if (!row) throw new NotFoundException(`workspace ${id}`);
    return row.id;
  }

  private me() { return { kind: 'user' as const, id: actorId() }; }

  @Get()
  async view(@Param('id') id: string, @Query('targetKind') targetKind: string, @Query('targetId') targetId: string) {
    const t = await this.follows.target(await this.ws(id), targetKind as FollowTargetKind, targetId ?? '');
    return this.follows.view(t.kind, t.id, this.me());
  }

  @Get('mine')
  async mine(@Param('id') id: string) {
    return this.follows.list(this.me(), await this.ws(id));
  }

  @Post()
  async follow(@Param('id') id: string, @Body() dto: TargetDto) {
    const t = await this.follows.target(await this.ws(id), dto.targetKind, dto.targetId);
    await this.follows.follow(t, this.me());
    return this.follows.view(t.kind, t.id, this.me());
  }

  @Post('unfollow')
  async unfollow(@Param('id') id: string, @Body() dto: TargetDto) {
    const t = await this.follows.target(await this.ws(id), dto.targetKind, dto.targetId);
    await this.follows.unfollow(t, this.me());
    return this.follows.view(t.kind, t.id, this.me());
  }

  @Post('seen')
  async seen(@Param('id') id: string, @Body() dto: TargetDto) {
    const t = await this.follows.target(await this.ws(id), dto.targetKind, dto.targetId);
    await this.follows.markSeenFor(this.me(), t.kind, t.id);
    return { ok: true };
  }
}
