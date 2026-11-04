/**
 * Program management routes (docs/work-tracking.md "Program management:
 * the matrix"), under the workspace's company:
 *
 *  GET    /api/workspaces/:id/org/program                                the matrix: goals and projects with owner, rhythm, team and requests; members with line manager and seats; health
 *  POST   /api/workspaces/:id/org/program/assign                         { ref, agentId, cascade? } — make a member the owner of a goal or project
 *  POST   /api/workspaces/:id/org/program/cadence                        { ref, kind: sync|milestone_review|goal_review, cron | null } — within the company's bounds
 *  GET    /api/workspaces/:id/org/program/requests                       every resource request with its answer
 *  POST   /api/workspaces/:id/org/program/requests                       { project, role, allocation, agentId?, headAgentId?, skills?, startDate?, endDate?, budgetUsd?, why? }
 *  POST   /api/workspaces/:id/org/program/requests/:requestId/decide     { action: approve|adjust|decline|hire, agentId?, allocation?, endDate?, note? }
 *  POST   /api/workspaces/:id/org/program/requests/:requestId/withdraw
 *
 * Writes are the CEO's or a board member's; agents use the tools
 * (org-program.tools.ts).
 */
import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import { actorId } from '../accounts/account-context';
import { OrgModeService } from './org-mode.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { OrgProgramService } from './org-program.service';

export class ProgramAssignDto {
  @IsString() ref!: string;
  @IsString() agentId!: string;
  @IsOptional() @IsBoolean() cascade?: boolean;
}
export class ProgramCadenceDto {
  @IsString() ref!: string;
  @IsIn(['sync', 'milestone_review', 'goal_review']) kind!: string;
  @IsOptional() @IsString() cron?: string | null;
}
export class ResourceRequestDto {
  @IsString() project!: string;
  @IsString() role!: string;
  @IsNumber() allocation!: number;
  @IsOptional() @IsString() agentId?: string | null;
  @IsOptional() @IsString() headAgentId?: string | null;
  @IsOptional() @IsString() skills?: string;
  @IsOptional() @IsString() startDate?: string | null;
  @IsOptional() @IsString() endDate?: string | null;
  @IsOptional() @IsNumber() budgetUsd?: number;
  @IsOptional() @IsString() why?: string;
}
export class ResourceDecideDto {
  @IsIn(['approve', 'adjust', 'decline', 'hire']) action!: 'approve' | 'adjust' | 'decline' | 'hire';
  @IsOptional() @IsString() agentId?: string | null;
  @IsOptional() @IsNumber() allocation?: number;
  @IsOptional() @IsString() endDate?: string | null;
  @IsOptional() @IsString() note?: string;
}

@Controller('workspaces/:id/org/program')
export class ProgramController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly orgs: OrgController,
    private readonly org: OrgService,
    private readonly program: OrgProgramService,
    private readonly config: ConfigService,
  ) {}

  private async oid(workspaceId: string): Promise<string> {
    if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)');
    return this.mode.orgIdOf(workspaceId);
  }

  /** Writes are the CEO's or a board member's. */
  private async writer(orgId: string): Promise<string> {
    const role = await this.org.humanRole(orgId, actorId());
    if (role !== 'ceo' && role !== 'board') throw new ForbiddenException(role === 'observer' ? 'observers can read the company but not change it' : 'only the CEO or a board member changes the program');
    return this.orgs.actorName();
  }

  @Get() async matrix(@Param('id') id: string) { return this.program.matrix(await this.oid(id)); }

  @Post('assign') async assign(@Param('id') id: string, @Body() dto: ProgramAssignDto) {
    const orgId = await this.oid(id);
    await this.program.assign(orgId, dto.ref, dto.agentId, await this.writer(orgId), { cascade: dto.cascade });
    return this.program.matrix(orgId);
  }

  @Post('cadence') async cadence(@Param('id') id: string, @Body() dto: ProgramCadenceDto) {
    const orgId = await this.oid(id);
    const cron = dto.cron && dto.cron.trim() && dto.cron.trim() !== 'off' ? dto.cron.trim() : null;
    await this.program.setCadence(orgId, dto.ref, dto.kind, cron, await this.writer(orgId));
    return this.program.matrix(orgId);
  }

  @Get('requests') async requests(@Param('id') id: string) {
    const orgId = await this.oid(id);
    return this.program.describeRequests(orgId, await this.program.requestRows(orgId));
  }

  @Post('requests') async request(@Param('id') id: string, @Body() dto: ResourceRequestDto) {
    const orgId = await this.oid(id);
    const r = await this.program.request(orgId, { project: dto.project, role: dto.role, allocation: dto.allocation, member: dto.agentId ?? null, head: dto.headAgentId ?? null, skills: dto.skills, startDate: dto.startDate, endDate: dto.endDate, budgetUsd: dto.budgetUsd, why: dto.why }, await this.writer(orgId));
    return (await this.program.describeRequests(orgId, [r.row]))[0];
  }

  @Post('requests/:requestId/decide') async decide(@Param('id') id: string, @Param('requestId') requestId: string, @Body() dto: ResourceDecideDto) {
    const orgId = await this.oid(id);
    const r = await this.program.decide(orgId, requestId, { action: dto.action, member: dto.agentId ?? null, allocation: dto.allocation, endDate: dto.endDate, note: dto.note }, await this.writer(orgId));
    return (await this.program.describeRequests(orgId, [r.row]))[0];
  }

  @Post('requests/:requestId/withdraw') async withdraw(@Param('id') id: string, @Param('requestId') requestId: string) {
    const orgId = await this.oid(id);
    await this.program.withdraw(orgId, requestId, await this.writer(orgId));
    return { ok: true };
  }
}
