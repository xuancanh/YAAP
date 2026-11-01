/**
 * WorkspaceOrgController — the primary API of organization mode
 * (docs/group-chat.md §5, execution plan item 16): the workspace is the
 * company, so every company route hangs off the workspace.
 *
 *  GET    /api/workspaces/:id/org            { mode, chiefOfStaffAgentId, orgMonthlyUsd, orgAgentCap, orgId, orgStatus, pendingApprovals, org? }
 *  PUT    /api/workspaces/:id/org            { mode, chiefOfStaffAgentId?, monthlyUsd?, agentCap? } — enable / change / turn off
 *  POST   /api/workspaces/:id/org/pause | /resume   the kill switch
 *  GET    /api/workspaces/:id/org/caps       the autonomy caps in plain words (for the Settings card)
 *  GET    /api/workspaces/:id/org/units      the unit tree (docs/group-chat.md §7) · PATCH units/:unitId · GET units/:unitId/board · GET units/:unitId/goals/tree · GET goals/tree
 *
 * Everything else is a thin alias of `/api/orgs/:orgId/...` that resolves the
 * workspace's one org id and delegates to OrgController, so the two surfaces
 * cannot drift. `/api/orgs/...` keeps working.
 */
import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { ORG_MODES, type OrgMode } from '../workspaces/workspaces.service';
import { OrgModeService, AUTONOMY_CAPS, MAX_ORG_AGENT_CAP } from './org-mode.service';
import {
  OrgController, UpdateOrgDto, AddMemberDto, UpdateMemberDto, ScopesDto, GoalDto, ProjectDto, TaskDto, AssignDto, TextDto, ReviewDto, DecideDto, ProposalDto, BudgetDto, WakeDto, HumanDto, UnitDto,
} from './org.controller';

class OrgModeDto {
  @IsIn(ORG_MODES as unknown as string[]) mode!: OrgMode;
  @IsOptional() @IsString() chiefOfStaffAgentId?: string;
  @IsOptional() @IsNumber() @Min(0) monthlyUsd?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_ORG_AGENT_CAP) agentCap?: number;
}

@Controller('workspaces/:id/org')
export class WorkspaceOrgController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly orgs: OrgController,
    private readonly config: ConfigService,
  ) {}

  private guard(): void { if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)'); }
  private oid(workspaceId: string): Promise<string> { this.guard(); return this.mode.orgIdOf(workspaceId); }

  @Get() async status(@Param('id') id: string) {
    this.guard();
    const st = await this.mode.status(id);
    // Units (docs/group-chat.md §7) ride along so the rail draws them without a second call.
    return { ...st, org: st.orgId ? await this.orgs.get(st.orgId) : null, units: st.orgId ? await this.orgs.units_(st.orgId).catch(() => []) : [] };
  }
  @Put() set(@Param('id') id: string, @Body() dto: OrgModeDto) { this.guard(); return this.mode.setMode(id, dto, this.orgs.actorName()); }
  @Get('caps') caps() { this.guard(); return AUTONOMY_CAPS; }
  @Post('pause') pause(@Param('id') id: string) { this.guard(); return this.mode.pause(id, this.orgs.actorName()); }
  @Post('resume') resume(@Param('id') id: string) { this.guard(); return this.mode.resume(id, this.orgs.actorName()); }

  // ---- aliases of /api/orgs/:orgId/... ----
  @Get('detail') async detail(@Param('id') id: string) { return this.orgs.get(await this.oid(id)); }
  @Patch('detail') async update(@Param('id') id: string, @Body() dto: UpdateOrgDto) { return this.orgs.update(await this.oid(id), dto); }

  @Post('members') async addMember(@Param('id') id: string, @Body() dto: AddMemberDto) { return this.orgs.addMember(await this.oid(id), dto); }
  @Patch('members/:agentId') async updateMember(@Param('id') id: string, @Param('agentId') agentId: string, @Body() dto: UpdateMemberDto) { return this.orgs.updateMember(await this.oid(id), agentId, dto); }
  @Delete('members/:agentId') async terminate(@Param('id') id: string, @Param('agentId') agentId: string) { return this.orgs.terminate(await this.oid(id), agentId); }
  @Post('members/:agentId/scopes') async setScopes(@Param('id') id: string, @Param('agentId') agentId: string, @Body() dto: ScopesDto) { return this.orgs.setScopes(await this.oid(id), agentId, dto); }
  @Post('members/:agentId/pause') async pauseMember(@Param('id') id: string, @Param('agentId') agentId: string) { return this.orgs.pauseMember(await this.oid(id), agentId); }
  @Post('members/:agentId/resume') async resumeMember(@Param('id') id: string, @Param('agentId') agentId: string) { return this.orgs.resumeMember(await this.oid(id), agentId); }
  @Post('members/:agentId/charter/accept') async acceptCharter(@Param('id') id: string, @Param('agentId') agentId: string) { return this.orgs.acceptCharter(await this.oid(id), agentId); }

  @Get('units') async units(@Param('id') id: string) { return this.orgs.units_(await this.oid(id)); }
  @Patch('units/:unitId') async renameUnit(@Param('id') id: string, @Param('unitId') unitId: string, @Body() dto: UnitDto) { return this.orgs.renameUnit(await this.oid(id), unitId, dto); }
  @Get('units/:unitId/board') async unitBoard(@Param('id') id: string, @Param('unitId') unitId: string, @Query('rollUp') rollUp?: string, @Query('status') status?: string) { return this.orgs.unitBoard(await this.oid(id), unitId, rollUp, status); }
  @Get('units/:unitId/goals/tree') async unitGoals(@Param('id') id: string, @Param('unitId') unitId: string) { return this.orgs.unitGoals(await this.oid(id), unitId); }
  @Get('goals/tree') async goalTree(@Param('id') id: string, @Query('unitId') unitId?: string) { return this.orgs.goalTree(await this.oid(id), unitId); }

  @Get('goals') async goals(@Param('id') id: string, @Query('unitId') unitId?: string) { return this.orgs.goals(await this.oid(id), unitId); }
  @Post('goals') async addGoal(@Param('id') id: string, @Body() dto: GoalDto) { return this.orgs.addGoal(await this.oid(id), dto); }
  @Patch('goals/:goalId') async updateGoal(@Param('id') id: string, @Param('goalId') goalId: string, @Body() dto: GoalDto) { return this.orgs.updateGoal(await this.oid(id), goalId, dto); }
  @Get('projects') async projects(@Param('id') id: string) { return this.orgs.projects(await this.oid(id)); }
  @Post('projects') async addProject(@Param('id') id: string, @Body() dto: ProjectDto) { return this.orgs.addProject(await this.oid(id), dto); }
  @Patch('projects/:projectId') async updateProject(@Param('id') id: string, @Param('projectId') projectId: string, @Body() dto: ProjectDto) { return this.orgs.updateProject(await this.oid(id), projectId, dto); }

  @Get('tasks') async board(@Param('id') id: string, @Query('projectId') projectId?: string, @Query('status') status?: string, @Query('unitId') unitId?: string, @Query('rollUp') rollUp?: string) { return this.orgs.board(await this.oid(id), projectId, status, unitId, rollUp); }
  @Post('tasks') async addTask(@Param('id') id: string, @Body() dto: TaskDto) { return this.orgs.addTask(await this.oid(id), dto); }
  @Patch('tasks/:taskId') async updateTask(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: TaskDto) { return this.orgs.updateTask(await this.oid(id), taskId, dto); }
  @Post('tasks/:taskId/assign') async assign(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: AssignDto) { return this.orgs.assign(await this.oid(id), taskId, dto); }
  @Post('tasks/:taskId/comment') async comment(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: TextDto) { return this.orgs.comment(await this.oid(id), taskId, dto); }
  @Get('tasks/:taskId/comments') async comments(@Param('id') id: string, @Param('taskId') taskId: string) { return this.orgs.comments(await this.oid(id), taskId); }
  @Post('tasks/:taskId/review') async review(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: ReviewDto) { return this.orgs.review(await this.oid(id), taskId, dto); }
  @Post('tasks/:taskId/request-review') async requestReview(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: Partial<TextDto>) { return this.orgs.requestReview(await this.oid(id), taskId, dto); }
  @Post('tasks/:taskId/wake') async wake(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: WakeDto) { return this.orgs.wake(await this.oid(id), taskId, dto); }
  @Get('tasks/:taskId/runs') async taskRuns(@Param('id') id: string, @Param('taskId') taskId: string) { return this.orgs.taskRuns(await this.oid(id), taskId); }
  @Get('runs') async runs(@Param('id') id: string, @Query('limit') limit?: string) { return this.orgs.runs(await this.oid(id), limit); }

  @Get('approvals') async listApprovals(@Param('id') id: string, @Query('status') status?: string) { return this.orgs.listApprovals(await this.oid(id), status); }
  @Post('approvals') async propose(@Param('id') id: string, @Body() dto: ProposalDto) { return this.orgs.propose(await this.oid(id), dto); }
  @Post('approvals/:approvalId/decide') async decide(@Param('id') id: string, @Param('approvalId') approvalId: string, @Body() dto: DecideDto) { return this.orgs.decide(await this.oid(id), approvalId, dto); }

  @Get('humans') async humans(@Param('id') id: string) { return this.orgs.humans(await this.oid(id)); }
  @Post('humans') async setHuman(@Param('id') id: string, @Body() dto: HumanDto) { return this.orgs.setHuman(await this.oid(id), dto); }
  @Delete('humans/:memberAccountId') async removeHuman(@Param('id') id: string, @Param('memberAccountId') memberAccountId: string) { return this.orgs.removeHuman(await this.oid(id), memberAccountId); }

  @Get('audit') async auditList(@Param('id') id: string, @Query('limit') limit?: string, @Query('action') action?: string, @Query('refId') refId?: string) { return this.orgs.auditList(await this.oid(id), limit, action, refId); }
  @Get('audit/verify') async verify(@Param('id') id: string) { return this.orgs.verify(await this.oid(id)); }

  @Get('brief') async latestBrief(@Param('id') id: string) { return this.orgs.latestBrief(await this.oid(id)); }
  @Post('brief') async composeBrief(@Param('id') id: string) { return this.orgs.composeBrief(await this.oid(id)); }
  @Post('brief/reply') async replyBrief(@Param('id') id: string, @Body() dto: TextDto) { return this.orgs.replyBrief(await this.oid(id), dto); }

  @Get('spend') async spend(@Param('id') id: string) { return this.orgs.spend(await this.oid(id)); }
  @Put('budgets') async setBudget(@Param('id') id: string, @Body() dto: BudgetDto) { return this.orgs.setBudget(await this.oid(id), dto); }

  @Get('messages') async messages(@Param('id') id: string) { return this.orgs.messages(await this.oid(id)); }
  @Post('messages') async post(@Param('id') id: string, @Body() dto: TextDto) { return this.orgs.post(await this.oid(id), dto); }

  /** Manual structure review (autonomous mode only): runs the chief now. */
  @Post('review') async reviewNow(@Param('id') id: string) { return { result: await this.orgs.reviewStructureNow(await this.oid(id)) }; }
}
