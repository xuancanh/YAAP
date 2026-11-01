/**
 * ActionsController — the action contract and the trust ledger over HTTP
 * (docs/actions-and-trust.md §8, execution-plan item 28).
 *
 *  GET  /api/workspaces/:id/trust                         levels per agent × class with counts, the ceilings and the matrix
 *  PUT  /api/workspaces/:id/trust/ceilings                { <class>: 0–3 } — owner / CEO
 *  POST /api/workspaces/:id/trust/:agentId/:class         { level, reason } — owner / CEO override, ≤ ceiling, audited
 *  GET  /api/workspaces/:id/actions?agentId=&class=&status=&limit=   the action log
 *  POST /api/workspaces/:id/actions/:actionId/revert-report { note } — owner / CEO: the action had to be undone
 *  POST /api/workspaces/:id/actions/:actionId/keys        { approve, note? } — owner / CEO key on a held or staged action
 *
 * Owner and CEO checks live in the services (TrustService.isOwnerOrCeo) so
 * the org approval path and this route cannot drift.
 */
import { Body, Controller, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { ActionsService } from './actions.service';
import { TrustService } from './trust.service';

export class CeilingsDto { @IsObject() ceilings!: Record<string, number> }
export class OverrideDto {
  @IsInt() @Min(0) @Max(3) level!: number;
  @IsString() reason!: string;
}
export class RevertDto { @IsOptional() @IsString() note?: string }
export class KeyDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() note?: string;
}

@Controller('workspaces/:id')
export class ActionsController {
  constructor(private readonly actions: ActionsService, private readonly trust: TrustService) {}

  private async ws(id: string): Promise<void> {
    if (!(await this.trust.workspaceRow(id))) throw new NotFoundException(`workspace ${id}`);
  }

  @Get('trust') overview(@Param('id') id: string) { return this.trust.overview(id); }

  /** Body: `{ ceilings: { external_irreversible: 2 } }`, or the map itself. */
  @Put('trust/ceilings') async ceilings(@Param('id') id: string, @Body() body: CeilingsDto | Record<string, number>) {
    const patch = (body as CeilingsDto).ceilings && typeof (body as CeilingsDto).ceilings === 'object' ? (body as CeilingsDto).ceilings : body as Record<string, number>;
    return { ceilings: await this.trust.setCeilings(id, patch) };
  }

  @Post('trust/:agentId/:class') override(@Param('id') id: string, @Param('agentId') agentId: string, @Param('class') cls: string, @Body() dto: OverrideDto) {
    return this.trust.override(id, agentId, cls, dto.level, dto.reason);
  }

  @Get('actions') async list(@Param('id') id: string, @Query('agentId') agentId?: string, @Query('class') cls?: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    await this.ws(id);
    return this.actions.list(id, { agentId: agentId || undefined, cls: cls || undefined, status: status || undefined, limit: limit ? Number(limit) : undefined });
  }

  @Post('actions/:actionId/revert-report') revert(@Param('id') id: string, @Param('actionId') actionId: string, @Body() dto: RevertDto) {
    return this.actions.revertReport(id, actionId, dto.note ?? '');
  }

  @Post('actions/:actionId/keys') key(@Param('id') id: string, @Param('actionId') actionId: string, @Body() dto: KeyDto) {
    return this.actions.ownerKey(id, actionId, dto.approve, dto.note ?? '');
  }
}
