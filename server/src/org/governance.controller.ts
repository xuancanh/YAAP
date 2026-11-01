/**
 * GovernanceController — the boundary, evals, capacity and the owner's seat
 * on the workspace surface (execution-plan item 31; docs/boundary.md,
 * docs/evals.md, docs/owners-seat.md):
 *
 *  GET    /api/workspaces/:id/org/boundary                 the self-modification boundary table
 *  GET    /api/workspaces/:id/org/evals/cases?roleKey=      golden sets
 *  POST   /api/workspaces/:id/org/evals/cases               { roleKey?, taskId? | title + brief + checks?, rubric? } — CEO
 *  DELETE /api/workspaces/:id/org/evals/cases/:caseId       retire — CEO
 *  POST   /api/workspaces/:id/org/evals/run                 { roleKey, candidate: { kind, ref?, after } } — CEO
 *  GET    /api/workspaces/:id/org/evals/runs?roleKey=
 *  GET    /api/workspaces/:id/org/capacity                  open vs WIP per member, expected durations
 *  GET    /api/workspaces/:id/org/delegations · POST { kind, maxUsd?, delegateType, delegateRef } — CEO · DELETE …/:delegationId — CEO
 *  GET    /api/workspaces/:id/org/outcomes                  measured movement and value vs spend per objective
 *  GET    /api/workspaces/:id/org/value-events?since=
 *  PUT    /api/workspaces/:id/org/goals/:goalId/value       { valuePerUnit?, valueOnAchieve?, valueNote? } — CEO
 *
 * Writes are the CEO's (the owner, or a human with the ceo role); the
 * services also put every change through the boundary.
 */
import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { actorId, currentAccountId, currentViewer } from '../accounts/account-context';
import { OrgModeService } from './org-mode.service';
import { OrgService } from './org.service';
import { OrgBoundaryService } from './org-boundary.service';
import { OrgEvalsService } from './org-evals.service';
import { OrgCapacityService } from './org-capacity.service';
import { OrgSeatService } from './org-seat.service';

export class EvalCaseDto {
  @IsOptional() @IsString() roleKey?: string;
  @IsOptional() @IsString() taskId?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsObject() brief?: Record<string, string>;
  @IsOptional() checks?: unknown;
  @IsOptional() @IsString() rubric?: string;
}
export class EvalRunDto {
  @IsString() roleKey!: string;
  @IsObject() candidate!: Record<string, unknown>;
}
export class DelegationDto {
  @IsString() kind!: string;
  @IsOptional() @IsNumber() maxUsd?: number | null;
  @IsIn(['human', 'role']) delegateType!: 'human' | 'role';
  @IsString() delegateRef!: string;
}
export class GoalValueDto {
  @IsOptional() valuePerUnit?: number | null;
  @IsOptional() valueOnAchieve?: number | null;
  @IsOptional() @IsString() valueNote?: string;
}

@Controller('workspaces/:id/org')
export class GovernanceController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly org: OrgService,
    private readonly boundary: OrgBoundaryService,
    private readonly evals: OrgEvalsService,
    private readonly capacity: OrgCapacityService,
    private readonly seat: OrgSeatService,
    private readonly config: ConfigService,
  ) {}

  private async oid(workspaceId: string): Promise<string> {
    if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)');
    return this.mode.orgIdOf(workspaceId);
  }

  private actor(): string {
    const v = currentViewer();
    return v && v.memberAccountId !== currentAccountId() ? `human:${v.memberAccountId}` : 'user';
  }

  private async ceo(orgId: string, what: string): Promise<void> {
    if ((await this.org.humanRole(orgId, actorId())) !== 'ceo') throw new ForbiddenException(`${what} is the CEO's`);
  }

  @Get('boundary') async table(@Param('id') id: string) { await this.oid(id); return { rules: this.boundary.table() }; }

  @Get('evals/cases') async cases(@Param('id') id: string, @Query('roleKey') roleKey?: string) {
    const orgId = await this.oid(id);
    return (await this.evals.cases(orgId, { roleKey: roleKey || undefined })).map((c) => this.evals.view(c));
  }
  @Post('evals/cases') async addCase(@Param('id') id: string, @Body() dto: EvalCaseDto) {
    const orgId = await this.oid(id); await this.ceo(orgId, 'adding a golden case');
    return this.evals.view(await this.evals.addCase(orgId, dto, this.actor()));
  }
  @Delete('evals/cases/:caseId') async retireCase(@Param('id') id: string, @Param('caseId') caseId: string) {
    const orgId = await this.oid(id); await this.ceo(orgId, 'retiring a golden case');
    return this.evals.view(await this.evals.retireCase(orgId, caseId, this.actor()));
  }
  @Post('evals/run') async run(@Param('id') id: string, @Body() dto: EvalRunDto) {
    const orgId = await this.oid(id); await this.ceo(orgId, 'an eval run');
    const roleKey = dto.roleKey.trim().toLowerCase();
    const candidate = await this.evals.normalizeCandidate(orgId, roleKey, dto.candidate);
    return this.evals.viewRun(await this.evals.run(orgId, { roleKey, candidate }, { requestedBy: this.actor() }));
  }
  @Get('evals/runs') async runs(@Param('id') id: string, @Query('roleKey') roleKey?: string) {
    const orgId = await this.oid(id);
    return (await this.evals.runs(orgId, { roleKey: roleKey || undefined })).map((r) => this.evals.viewRun(r));
  }

  @Get('capacity') async capacityOf(@Param('id') id: string) {
    const orgId = await this.oid(id);
    const exp = await this.capacity.expectations(orgId);
    return { ...(await this.capacity.overview(orgId)), byClass: Object.fromEntries([...exp.entries()].filter(([k]) => k.startsWith('*|')).map(([k, v]) => [k.slice(2), v])) };
  }

  @Get('delegations') async delegations(@Param('id') id: string) { return this.seat.delegations(await this.oid(id)); }
  @Post('delegations') async delegate(@Param('id') id: string, @Body() dto: DelegationDto) {
    const orgId = await this.oid(id); await this.ceo(orgId, 'delegating approvals');
    return this.seat.delegate(orgId, dto, this.actor());
  }
  @Delete('delegations/:delegationId') async revoke(@Param('id') id: string, @Param('delegationId') delegationId: string) {
    const orgId = await this.oid(id); await this.ceo(orgId, 'revoking a delegation');
    return this.seat.revoke(orgId, delegationId, this.actor());
  }

  @Get('outcomes') async outcomes(@Param('id') id: string) { return this.seat.outcomes(await this.oid(id)); }
  @Get('value-events') async valueEvents(@Param('id') id: string, @Query('since') since?: string) { return this.seat.valueEvents(await this.oid(id), { since: since || undefined }); }
  @Put('goals/:goalId/value') async setValue(@Param('id') id: string, @Param('goalId') goalId: string, @Body() dto: GoalValueDto) {
    const orgId = await this.oid(id); await this.ceo(orgId, 'what an outcome is worth');
    return this.seat.setGoalValue(orgId, goalId, dto, this.actor());
  }
}
