/**
 * Work tracking routes (docs/work-tracking.md), under the workspace's company:
 *
 *  GET    /api/workspaces/:id/org/roadmap                     projects with progress, health, update state, appetite, forecast; the goal tree and units to group by
 *  GET    /api/workspaces/:id/org/portfolio?since=            the CEO's exceptions and the digest of project changes since `since`
 *  GET    /api/workspaces/:id/org/projects                    raw project rows (system projects included)
 *  POST   /api/workspaces/:id/org/projects                    create (a person: as given, default Now)
 *  GET    /api/workspaces/:id/org/projects/:projectId         the project page
 *  PATCH  /api/workspaces/:id/org/projects/:projectId         change (lane, dates, brief, appetite, lead, key results, status)
 *  GET|POST /api/workspaces/:id/org/projects/:projectId/updates          health updates (the lead posts)
 *  POST   /api/workspaces/:id/org/projects/:projectId/milestones         { name, date }
 *  PATCH  /api/workspaces/:id/org/projects/:projectId/milestones/:mid    { name?, date?, done? }
 *  POST   /api/workspaces/:id/org/projects/:projectId/appetite           { decision: extend|cut_scope|kill, extendDays?, extendUsd?, note? }
 *  POST   /api/workspaces/:id/org/projects/:projectId/tasks              { taskId } — move a task under the project
 *  GET    /api/workspaces/:id/org/tasks/:taskId/transitions             the task's status history
 *  POST   /api/workspaces/:id/org/tasks/:taskId/steps                   { add? | done? | undo? | drop? }
 *  POST   /api/workspaces/:id/org/tasks/:taskId/blocked-on              { kind, ref?, reason } or { clear: true }
 *
 * People write as the CEO or a board member; an employee who leads a
 * project posts its updates. Agents use the tools (org-projects.tools.ts).
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { actorId } from '../accounts/account-context';
import { OrgModeService } from './org-mode.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgProjectsService } from './org-projects.service';
import { BLOCKED_KINDS } from './blocked-on';
import { PROJECT_HEALTH, PROJECT_LANES, PROJECT_STATUSES } from './work-model';

export class WorkProjectDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() goalId?: string | null;
  @IsOptional() @IsArray() goalIds?: string[];
  @IsOptional() @IsString() ownerAgentId?: string | null;
  @IsOptional() @IsString() leadHumanId?: string | null;
  @IsOptional() @IsString() unitId?: string | null;
  @IsOptional() @IsObject() brief?: Record<string, string>;
  @IsOptional() @IsString() startDate?: string | null;
  @IsOptional() @IsString() targetDate?: string | null;
  @IsOptional() @IsArray() milestones?: unknown[];
  @IsOptional() @IsNumber() appetiteDays?: number;
  @IsOptional() @IsNumber() appetiteUsd?: number;
  @IsOptional() @IsIn(PROJECT_LANES as unknown as string[]) lane?: string;
  @IsOptional() @IsIn(PROJECT_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsNumber() rank?: number;
  @IsOptional() @IsNumber() updateCadenceDays?: number | null;
}
export class HealthUpdateDto {
  @IsIn(PROJECT_HEALTH as unknown as string[]) health!: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() ask?: string;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsNumber() hill?: number | null;
}
export class MilestoneDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() date?: string | null;
  @IsOptional() @IsBoolean() done?: boolean;
}
export class AppetiteDto {
  @IsIn(['extend', 'cut_scope', 'kill']) decision!: 'extend' | 'cut_scope' | 'kill';
  @IsOptional() @IsNumber() extendDays?: number;
  @IsOptional() @IsNumber() extendUsd?: number;
  @IsOptional() @IsString() note?: string;
}
export class LinkTaskDto { @IsString() taskId!: string }
export class StepDto {
  @IsOptional() @IsString() add?: string;
  @IsOptional() @IsString() done?: string;
  @IsOptional() @IsString() undo?: string;
  @IsOptional() @IsString() drop?: string;
}
export class BlockedOnDto {
  @IsOptional() @IsIn(BLOCKED_KINDS as unknown as string[]) kind?: string;
  @IsOptional() @IsString() ref?: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsBoolean() clear?: boolean;
}

@Controller('workspaces/:id/org')
export class WorkController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly orgs: OrgController,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly projects: OrgProjectsService,
    private readonly config: ConfigService,
  ) {}

  private async oid(workspaceId: string): Promise<string> {
    if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)');
    return this.mode.orgIdOf(workspaceId);
  }

  /** Writes are the CEO's or a board member's. */
  private async writer(orgId: string): Promise<string> {
    const role = await this.org.humanRole(orgId, actorId());
    if (role !== 'ceo' && role !== 'board') throw new ForbiddenException(role === 'observer' ? 'observers can read the company but not change it' : 'only the CEO or a board member changes projects');
    return this.orgs.actorName();
  }

  @Get('roadmap') async roadmap(@Param('id') id: string) { return this.projects.roadmap(await this.oid(id)); }
  @Get('portfolio') async portfolio(@Param('id') id: string, @Query('since') since?: string) {
    const s = since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : new Date(Date.now() - 7 * 86_400_000).toISOString();
    return this.projects.portfolio(await this.oid(id), s);
  }
  @Get('projects') async list(@Param('id') id: string) { return this.projects.list(await this.oid(id), { includeSystem: true }); }
  @Post('projects') async create(@Param('id') id: string, @Body() dto: WorkProjectDto) {
    const orgId = await this.oid(id);
    const r = await this.projects.create(orgId, { ...dto, title: dto.title ?? '', goalIds: dto.goalIds, goalId: dto.goalId ?? undefined }, await this.writer(orgId));
    return r.project;
  }
  @Get('projects/:projectId') async page(@Param('id') id: string, @Param('projectId') projectId: string) { return this.projects.page(await this.oid(id), projectId); }
  @Patch('projects/:projectId') async update(@Param('id') id: string, @Param('projectId') projectId: string, @Body() dto: WorkProjectDto) {
    const orgId = await this.oid(id);
    return (await this.projects.update(orgId, projectId, dto, await this.writer(orgId))).project;
  }
  @Get('projects/:projectId/updates') async updates(@Param('id') id: string, @Param('projectId') projectId: string) {
    const orgId = await this.oid(id);
    return this.projects.updates(orgId, (await this.projects.resolve(orgId, projectId)).id);
  }
  @Post('projects/:projectId/updates') async postUpdate(@Param('id') id: string, @Param('projectId') projectId: string, @Body() dto: HealthUpdateDto) {
    const orgId = await this.oid(id);
    const p = await this.projects.resolve(orgId, projectId);
    // The lead posts: a person who leads it, or the CEO / a board member.
    const actor = p.leadHumanId && p.leadHumanId === actorId() ? this.orgs.actorName() : await this.writer(orgId);
    return this.projects.postUpdate(orgId, p.id, dto, actor);
  }
  @Post('projects/:projectId/milestones') async addMilestone(@Param('id') id: string, @Param('projectId') projectId: string, @Body() dto: MilestoneDto) {
    const orgId = await this.oid(id);
    if (!dto.name) throw new BadRequestException('name is required');
    return this.projects.addMilestone(orgId, projectId, { name: dto.name, date: dto.date ?? null }, await this.writer(orgId));
  }
  @Patch('projects/:projectId/milestones/:milestoneId') async setMilestone(@Param('id') id: string, @Param('projectId') projectId: string, @Param('milestoneId') milestoneId: string, @Body() dto: MilestoneDto) {
    const orgId = await this.oid(id);
    return this.projects.setMilestone(orgId, projectId, milestoneId, dto, await this.writer(orgId));
  }
  @Post('projects/:projectId/appetite') async appetite(@Param('id') id: string, @Param('projectId') projectId: string, @Body() dto: AppetiteDto) {
    const orgId = await this.oid(id);
    return (await this.projects.decideAppetite(orgId, projectId, dto, await this.writer(orgId))).project;
  }
  @Post('projects/:projectId/tasks') async link(@Param('id') id: string, @Param('projectId') projectId: string, @Body() dto: LinkTaskDto) {
    const orgId = await this.oid(id);
    return this.projects.linkTask(orgId, dto.taskId, projectId, await this.writer(orgId));
  }
  @Get('tasks/:taskId/transitions') async transitions(@Param('id') id: string, @Param('taskId') taskId: string) {
    const orgId = await this.oid(id);
    return this.tasks.transitions(orgId, (await this.tasks.resolve(orgId, taskId)).id);
  }
  @Post('tasks/:taskId/steps') async steps(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: StepDto) {
    const orgId = await this.oid(id);
    const t = await this.tasks.resolve(orgId, taskId);
    return (await this.tasks.step(orgId, t.id, dto, await this.writer(orgId))).task;
  }
  @Post('tasks/:taskId/blocked-on') async blockedOn(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: BlockedOnDto) {
    const orgId = await this.oid(id);
    const t = await this.tasks.resolve(orgId, taskId);
    const actor = await this.writer(orgId);
    if (dto.clear) return this.tasks.update(orgId, t.id, { blockedOn: null }, actor);
    if (!dto.kind) throw new BadRequestException('kind is required (or clear: true)');
    return this.tasks.update(orgId, t.id, { blockedOn: { kind: dto.kind, ref: dto.ref ?? null, reason: dto.reason ?? '' } }, actor);
  }
}
