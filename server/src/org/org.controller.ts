/**
 * OrgController — the CEO surface (docs/autonomous-company.md §4.4).
 *
 *  GET    /api/orgs/status                       { enabled }
 *  GET    /api/orgs?workspaceId=                 organisations
 *  POST   /api/orgs                              create (with or creating a chief of staff)
 *  GET    /api/orgs/:id                          org + members + goals + projects + budgets
 *  PATCH  /api/orgs/:id · DELETE /api/orgs/:id
 *  POST   /api/orgs/:id/pause | /resume          the kill switch
 *  members: POST /:id/members · PATCH /:id/members/:agentId · DELETE (terminate)
 *           POST /:id/members/:agentId/scopes · /pause · /resume · /charter/accept
 *  goals / projects: GET · POST · PATCH
 *  tasks: GET /:id/tasks (board) · POST · PATCH /:id/tasks/:taskId · POST …/assign · …/comment · …/review · …/wake · GET …/runs
 *  approvals: GET /:id/approvals · POST /:id/approvals/:approvalId/decide — the only place an approval is decided
 *  audit: GET /:id/audit · GET /:id/audit/verify
 *  brief: GET /:id/brief · POST /:id/brief (compose now) · POST /:id/brief/reply { text }
 *  spend: GET /:id/spend · PUT /:id/budgets
 *  messages: GET /:id/messages · POST /:id/messages (the user posts; nobody is woken)
 *  runs: GET /:id/runs
 *
 * Every route except /status answers 404 when COMPANIES_ENABLED=false.
 */
import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { OrgService } from './org.service';
import { OrgTasksService, TASK_STATUSES, type TaskStatus } from './org-tasks.service';
import { OrgApprovalsService, APPROVAL_KINDS, type ApprovalKind } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';
import { OrgBriefService } from './org-brief.service';
import { OrgRuntimeService } from './org-runtime.service';

class ChiefDto {
  @IsString() name!: string;
  @IsOptional() @IsString() charter?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() emoji?: string;
  /** Catalog pack whose charter seeds the chief when no charter is given. */
  @IsOptional() @IsString() packId?: string;
}

class CreateOrgDto {
  @IsString() workspaceId!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() mission?: string;
  @IsOptional() @IsString() ceoUserNote?: string;
  @IsOptional() @IsString() chiefOfStaffAgentId?: string;
  @IsOptional() @IsObject() chief?: ChiefDto;
  @IsOptional() @IsArray() chiefScopes?: string[];
  @IsOptional() @IsNumber() monthlyBudgetUsd?: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) briefHour?: number;
}

class UpdateOrgDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() mission?: string;
  @IsOptional() @IsString() ceoUserNote?: string;
  @IsOptional() @IsInt() @Min(0) @Max(23) briefHour?: number;
  @IsOptional() @IsInt() maxDirectReports?: number;
  @IsOptional() @IsNumber() monthlyBudgetUsd?: number;
}

class AddMemberDto {
  @IsString() agentId!: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() reportsToAgentId?: string;
  @IsOptional() @IsArray() scopes?: string[];
}

class UpdateMemberDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() reportsToAgentId?: string | null;
}

class ScopesDto { @IsArray() scopes!: string[] }

class GoalDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() ownerAgentId?: string | null;
}

class ProjectDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() goalId?: string | null;
  @IsOptional() ownerAgentId?: string | null;
}

class TaskDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsObject() brief?: Record<string, string>;
  @IsOptional() @IsIn(TASK_STATUSES as unknown as string[]) status?: TaskStatus;
  @IsOptional() projectId?: string | null;
  @IsOptional() parentTaskId?: string | null;
  @IsOptional() assigneeAgentId?: string | null;
  @IsOptional() reviewerAgentId?: string | null;
  @IsOptional() @IsArray() blockers?: string[];
  @IsOptional() @IsArray() fileScope?: string[];
}

class AssignDto { @IsString() agentId!: string }
class TextDto { @IsString() text!: string }
class ReviewDto {
  @IsIn(['accept', 'request_changes', 'escalate']) verdict!: 'accept' | 'request_changes' | 'escalate';
  @IsOptional() @IsString() note?: string;
}
class DecideDto {
  @IsIn(['approve', 'reject', 'revise']) decision!: 'approve' | 'reject' | 'revise';
  @IsOptional() @IsString() note?: string;
}
class ProposalDto {
  @IsIn(APPROVAL_KINDS as unknown as string[]) kind!: ApprovalKind;
  @IsObject() payload!: Record<string, unknown>;
  @IsOptional() @IsString() recommendation?: string;
}
class BudgetDto {
  @IsIn(['company', 'agent', 'project']) scope!: 'company' | 'agent' | 'project';
  @IsOptional() @IsString() refId?: string;
  @IsNumber() monthlyUsd!: number;
}
class WakeDto { @IsOptional() @IsString() agentId?: string; @IsOptional() @IsBoolean() now?: boolean }

@Controller('orgs')
export class OrgController {
  constructor(
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly approvals: OrgApprovalsService,
    private readonly audit: OrgAuditService,
    private readonly brief: OrgBriefService,
    private readonly runtime: OrgRuntimeService,
    private readonly config: ConfigService,
  ) {}

  private enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }
  private guard(): void { if (!this.enabled()) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)'); }

  @Get('status') status() { return { enabled: this.enabled() }; }

  @Get() list(@Query('workspaceId') workspaceId?: string) { this.guard(); return this.org.list(workspaceId || undefined); }
  @Post() create(@Body() dto: CreateOrgDto) { this.guard(); return this.org.create(dto); }

  @Get(':id') async get(@Param('id') id: string) {
    this.guard();
    const [org, members, goals, projects, budgets, grants] = await Promise.all([
      this.org.get(id), this.org.members(id), this.org.goals(id), this.org.projects(id), this.org.budgets(id), this.org.grants(id),
    ]);
    const drift = await this.org.checkCharters(id);
    return { ...org, members, goals, projects, budgets, grants, charterDrift: drift };
  }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateOrgDto) { this.guard(); return this.org.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { this.guard(); return this.org.remove(id); }
  @Post(':id/pause') pause(@Param('id') id: string) { this.guard(); return this.runtime.pause(id); }
  @Post(':id/resume') resume(@Param('id') id: string) { this.guard(); return this.runtime.resume(id); }

  // ---- members ----
  @Post(':id/members') addMember(@Param('id') id: string, @Body() dto: AddMemberDto) {
    this.guard();
    return this.org.addMember(id, { agentId: dto.agentId, title: dto.title, reportsToAgentId: dto.reportsToAgentId ?? null, scopes: dto.scopes, actor: 'user' });
  }
  @Patch(':id/members/:agentId') updateMember(@Param('id') id: string, @Param('agentId') agentId: string, @Body() dto: UpdateMemberDto) {
    this.guard(); return this.org.updateMember(id, agentId, dto);
  }
  @Delete(':id/members/:agentId') terminate(@Param('id') id: string, @Param('agentId') agentId: string) { this.guard(); return this.org.terminateMember(id, agentId); }
  /** The user may widen directly: approvals exist to gate agents, not the CEO. */
  @Post(':id/members/:agentId/scopes') setScopes(@Param('id') id: string, @Param('agentId') agentId: string, @Body() dto: ScopesDto) {
    this.guard(); return this.org.setScopes(id, agentId, dto.scopes, { actor: 'user', force: true });
  }
  @Post(':id/members/:agentId/pause') async pauseMember(@Param('id') id: string, @Param('agentId') agentId: string) {
    this.guard(); const m = await this.org.setMemberStatus(id, agentId, 'paused'); this.runtime.cancelWakesFor(id, agentId); return m;
  }
  @Post(':id/members/:agentId/resume') resumeMember(@Param('id') id: string, @Param('agentId') agentId: string) { this.guard(); return this.org.setMemberStatus(id, agentId, 'active'); }
  @Post(':id/members/:agentId/charter/accept') acceptCharter(@Param('id') id: string, @Param('agentId') agentId: string) { this.guard(); return this.org.acceptCharter(id, agentId); }

  // ---- goals / projects ----
  @Get(':id/goals') goals(@Param('id') id: string) { this.guard(); return this.org.goals(id); }
  @Post(':id/goals') addGoal(@Param('id') id: string, @Body() dto: GoalDto) { this.guard(); return this.org.addGoal(id, { title: dto.title ?? '', description: dto.description, ownerAgentId: dto.ownerAgentId, status: dto.status }); }
  @Patch(':id/goals/:goalId') updateGoal(@Param('id') id: string, @Param('goalId') goalId: string, @Body() dto: GoalDto) { this.guard(); return this.org.updateGoal(id, goalId, dto); }
  @Get(':id/projects') projects(@Param('id') id: string) { this.guard(); return this.org.projects(id); }
  @Post(':id/projects') addProject(@Param('id') id: string, @Body() dto: ProjectDto) { this.guard(); return this.org.addProject(id, { title: dto.title ?? '', goalId: dto.goalId, ownerAgentId: dto.ownerAgentId }); }
  @Patch(':id/projects/:projectId') updateProject(@Param('id') id: string, @Param('projectId') projectId: string, @Body() dto: ProjectDto) { this.guard(); return this.org.updateProject(id, projectId, dto); }

  // ---- tasks (the board) ----
  @Get(':id/tasks') board(@Param('id') id: string, @Query('projectId') projectId?: string, @Query('status') status?: string) { this.guard(); return this.tasks.list(id, { projectId: projectId || undefined, status: status || undefined }); }
  @Post(':id/tasks') addTask(@Param('id') id: string, @Body() dto: TaskDto) {
    this.guard();
    return this.tasks.create(id, { title: dto.title ?? '', brief: dto.brief, projectId: dto.projectId, parentTaskId: dto.parentTaskId, status: dto.status, assigneeAgentId: dto.assigneeAgentId, reviewerAgentId: dto.reviewerAgentId, fileScope: dto.fileScope, createdBy: 'user' });
  }
  @Patch(':id/tasks/:taskId') updateTask(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: TaskDto) {
    this.guard();
    return this.tasks.update(id, taskId, { title: dto.title, brief: dto.brief, status: dto.status, blockers: dto.blockers, projectId: dto.projectId, reviewerAgentId: dto.reviewerAgentId, fileScope: dto.fileScope });
  }
  @Post(':id/tasks/:taskId/assign') assign(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: AssignDto) { this.guard(); return this.tasks.assign(id, taskId, dto.agentId); }
  @Post(':id/tasks/:taskId/comment') comment(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: TextDto) { this.guard(); return this.tasks.comment(id, taskId, { text: dto.text, fromAgentId: null }); }
  @Get(':id/tasks/:taskId/comments') comments(@Param('id') id: string, @Param('taskId') taskId: string) { this.guard(); return this.tasks.messages(id, { taskId }); }
  /** The CEO reviews directly (no independent check: the human is the floor). */
  @Post(':id/tasks/:taskId/review') review(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: ReviewDto) { this.guard(); return this.tasks.review(id, taskId, { verdict: dto.verdict, note: dto.note, byAgentId: null }); }
  @Post(':id/tasks/:taskId/request-review') requestReview(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: Partial<TextDto>) { this.guard(); return this.tasks.requestReview(id, taskId, { note: dto.text, fromAgentId: null }); }
  /** Manual wake of the owner (or a named member): debounced like any wake, or now=true. */
  @Post(':id/tasks/:taskId/wake') async wake(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: WakeDto) {
    this.guard();
    const t = await this.tasks.get(id, taskId);
    const agentId = dto.agentId ?? (t.status === 'in_review' ? t.reviewerAgentId : t.assigneeAgentId);
    if (!agentId) throw new NotFoundException('task has no owner to wake');
    if (dto.now) return { result: await this.runtime.runTask(id, taskId, agentId, 'manual') };
    this.runtime.wake({ orgId: id, taskId, agentId, reason: 'manual' });
    return { queued: true };
  }
  @Get(':id/tasks/:taskId/runs') taskRuns(@Param('id') id: string, @Param('taskId') taskId: string) { this.guard(); return this.tasks.runs(id, { taskId }); }
  @Get(':id/runs') runs(@Param('id') id: string, @Query('limit') limit?: string) { this.guard(); return this.tasks.runs(id, { limit: Number(limit) || 100 }); }

  // ---- approvals ----
  @Get(':id/approvals') async listApprovals(@Param('id') id: string, @Query('status') status?: string) {
    this.guard();
    await this.approvals.expireStale(id);
    return this.approvals.list(id, { status: status || undefined });
  }
  /** The user may also raise a proposal by hand (e.g. an external action to record). */
  @Post(':id/approvals') propose(@Param('id') id: string, @Body() dto: ProposalDto) { this.guard(); return this.approvals.create(id, { kind: dto.kind, payload: dto.payload, requestedBy: 'user', recommendation: dto.recommendation }); }
  @Post(':id/approvals/:approvalId/decide') decide(@Param('id') id: string, @Param('approvalId') approvalId: string, @Body() dto: DecideDto) {
    this.guard(); return this.approvals.decide(id, approvalId, dto.decision, dto.note ?? '', 'user');
  }

  // ---- audit ----
  @Get(':id/audit') auditList(@Param('id') id: string, @Query('limit') limit?: string, @Query('action') action?: string, @Query('refId') refId?: string) {
    this.guard(); return this.audit.list(id, { limit: Number(limit) || 100, action: action || undefined, refId: refId || undefined });
  }
  @Get(':id/audit/verify') verify(@Param('id') id: string) { this.guard(); return this.audit.verify(id); }

  // ---- brief ----
  @Get(':id/brief') latestBrief(@Param('id') id: string) { this.guard(); return this.brief.latest(id); }
  @Post(':id/brief') composeBrief(@Param('id') id: string) { this.guard(); return this.brief.compose(id, { deliver: true, by: 'user' }); }
  @Post(':id/brief/reply') replyBrief(@Param('id') id: string, @Body() dto: TextDto) { this.guard(); return this.brief.reply(id, dto.text); }

  // ---- spend ----
  @Get(':id/spend') spend(@Param('id') id: string) { this.guard(); return this.runtime.spendTree(id); }
  @Put(':id/budgets') setBudget(@Param('id') id: string, @Body() dto: BudgetDto) { this.guard(); return this.org.setBudget(id, { scope: dto.scope, refId: dto.refId ?? id, monthlyUsd: dto.monthlyUsd }); }

  // ---- the group log ----
  @Get(':id/messages') messages(@Param('id') id: string) { this.guard(); return this.tasks.messages(id); }
  @Post(':id/messages') post(@Param('id') id: string, @Body() dto: TextDto) { this.guard(); return this.tasks.post(id, { text: dto.text, fromAgentId: null }); }
}
