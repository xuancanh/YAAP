/**
 * Process routes (docs/processes.md), under the workspace's company:
 *
 *  GET    /api/workspaces/:id/org/processes                       every process with mode, owner, version, triggers, metrics and health
 *  GET    /api/workspaces/:id/org/processes/templates             the built-in library
 *  GET    /api/workspaces/:id/org/processes/:pid                  one process: definition, versions with diffs, runs with steps, events
 *  POST   /api/workspaces/:id/org/processes                       { template? | def?, name?, unitId?, reason } — a new process
 *  PUT    /api/workspaces/:id/org/processes/:pid                  { def, reason } — a new version
 *  POST   /api/workspaces/:id/org/processes/:pid/rollback         { version, reason }
 *  POST   /api/workspaces/:id/org/processes/:pid/retire           { reason, restore? }
 *  POST   /api/workspaces/:id/org/processes/:pid/runs             { title?, vars? } — start a run by hand
 *  POST   /api/workspaces/:id/org/processes/runs/:runId/cancel    { reason }
 *  POST   /api/workspaces/:id/org/processes/:pid/rollout          { action: promote | rollback | percent, percent?, reason? }
 *  POST   /api/workspaces/:id/org/processes/suggestions/:sid      { action: accept | dismiss, reason? }
 *
 * Reads are everyone's in the company; writes are the CEO's or a board
 * member's (a person's edit applies at once — the boundary binds agents,
 * which use the tools, org-processes.tools.ts).
 */
import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { actorId } from '../accounts/account-context';
import { OrgModeService } from './org-mode.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { OrgProcessesService } from './org-processes.service';
import { PROCESS_TEMPLATES } from './process-templates';
import { describeTriggers, modeOf } from './process-model';

export class ProcessCreateDto {
  @IsOptional() @IsString() template?: string;
  @IsOptional() @IsObject() def?: Record<string, unknown>;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() unitId?: string | null;
  @IsString() reason!: string;
}
export class ProcessEditDto {
  @IsObject() def!: Record<string, unknown>;
  @IsString() reason!: string;
  /** % of new runs on the new version while it is compared (0 = at once; default: process.rampPercent). */
  @IsOptional() @IsNumber() ramp?: number;
}
export class ProcessRolloutDto {
  @IsIn(['promote', 'rollback', 'percent']) action!: 'promote' | 'rollback' | 'percent';
  @IsOptional() @IsNumber() percent?: number;
  @IsOptional() @IsString() reason?: string;
}
export class ProcessSuggestionDto {
  @IsIn(['accept', 'dismiss']) action!: 'accept' | 'dismiss';
  @IsOptional() @IsString() reason?: string;
}
export class ProcessRollbackDto {
  @IsNumber() version!: number;
  @IsString() reason!: string;
}
export class ProcessRetireDto {
  @IsString() reason!: string;
  @IsOptional() @IsBoolean() restore?: boolean;
}
export class ProcessStartDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsObject() vars?: Record<string, unknown>;
}
export class ProcessCancelDto {
  @IsOptional() @IsString() reason?: string;
}

@Controller('workspaces/:id/org/processes')
export class ProcessesController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly orgs: OrgController,
    private readonly org: OrgService,
    private readonly processes: OrgProcessesService,
    private readonly config: ConfigService,
  ) {}

  private async oid(workspaceId: string): Promise<string> {
    if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)');
    return this.mode.orgIdOf(workspaceId);
  }

  /** Writes are the CEO's or a board member's. */
  private async writer(orgId: string): Promise<string> {
    const role = await this.org.humanRole(orgId, actorId());
    if (role !== 'ceo' && role !== 'board') throw new ForbiddenException(role === 'observer' ? 'observers can read the company but not change it' : 'only the CEO or a board member changes a process');
    return this.orgs.actorName();
  }

  @Get() async list(@Param('id') id: string) {
    const orgId = await this.oid(id);
    return {
      processes: await this.processes.overview(orgId, { includeRetired: true }), runs: (await this.processes.runs(orgId, { limit: 50 })).filter((r) => r.status === 'running' || r.status === 'blocked'),
      suggestions: (await this.processes.suggestions(orgId, { status: 'open' })).map((x) => this.processes.suggestionView(x)),
    };
  }

  @Get('templates') async templates(@Param('id') id: string) {
    await this.oid(id);
    return PROCESS_TEMPLATES.map((t) => ({ id: t.id, title: t.def.title, summary: t.summary, category: t.def.category, mode: modeOf(t.def), triggers: describeTriggers(t.def.triggers), steps: t.def.nodes.length, def: t.def }));
  }

  @Get(':pid') async detail(@Param('id') id: string, @Param('pid') pid: string) {
    return this.processes.detail(await this.oid(id), pid);
  }

  @Post() async create(@Param('id') id: string, @Body() dto: ProcessCreateDto) {
    const orgId = await this.oid(id);
    const r = await this.processes.author(orgId, { template: dto.template, def: dto.def, name: dto.name, unitId: dto.unitId ?? null, reason: dto.reason }, await this.writer(orgId));
    return this.processes.detail(orgId, r.process.id);
  }

  @Put(':pid') async edit(@Param('id') id: string, @Param('pid') pid: string, @Body() dto: ProcessEditDto) {
    const orgId = await this.oid(id);
    const r = await this.processes.author(orgId, { process: pid, def: dto.def, reason: dto.reason, ramp: dto.ramp }, await this.writer(orgId));
    return this.processes.detail(orgId, r.process.id);
  }

  @Post(':pid/rollout') async rollout(@Param('id') id: string, @Param('pid') pid: string, @Body() dto: ProcessRolloutDto) {
    const orgId = await this.oid(id);
    const actor = await this.writer(orgId);
    const reason = dto.reason || 'decided by the CEO';
    if (dto.action === 'promote') await this.processes.promote(orgId, pid, reason, actor);
    else if (dto.action === 'rollback') await this.processes.rollbackRamp(orgId, pid, reason, actor);
    else await this.processes.setRamp(orgId, pid, Number(dto.percent), actor);
    return this.processes.detail(orgId, pid);
  }

  @Post('suggestions/:sid') async suggestion(@Param('id') id: string, @Param('sid') sid: string, @Body() dto: ProcessSuggestionDto) {
    const orgId = await this.oid(id);
    return this.processes.suggestionView(await this.processes.decideSuggestion(orgId, sid, dto.action, dto.reason ?? '', await this.writer(orgId)));
  }

  @Post(':pid/rollback') async rollback(@Param('id') id: string, @Param('pid') pid: string, @Body() dto: ProcessRollbackDto) {
    const orgId = await this.oid(id);
    const r = await this.processes.rollback(orgId, pid, dto.version, dto.reason, await this.writer(orgId));
    return this.processes.detail(orgId, r.process.id);
  }

  @Post(':pid/retire') async retire(@Param('id') id: string, @Param('pid') pid: string, @Body() dto: ProcessRetireDto) {
    const orgId = await this.oid(id);
    const actor = await this.writer(orgId);
    if (dto.restore) await this.processes.restore(orgId, pid, dto.reason, actor);
    else await this.processes.retire(orgId, pid, dto.reason, actor);
    return this.processes.detail(orgId, pid);
  }

  @Post(':pid/runs') async start(@Param('id') id: string, @Param('pid') pid: string, @Body() dto: ProcessStartDto) {
    const orgId = await this.oid(id);
    const run = await this.processes.start(orgId, pid, { title: dto.title, vars: dto.vars, initiator: await this.writer(orgId), trigger: { kind: 'manual' } });
    await this.processes.settle();
    return this.processes.run(orgId, run.id);
  }

  @Post('runs/:runId/cancel') async cancel(@Param('id') id: string, @Param('runId') runId: string, @Body() dto: ProcessCancelDto) {
    const orgId = await this.oid(id);
    return this.processes.cancel(orgId, runId, dto.reason || 'cancelled by the CEO', await this.writer(orgId));
  }
}
