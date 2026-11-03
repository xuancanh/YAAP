/**
 * WorkspaceOrgController — the primary API of organization mode
 * (docs/group-chat.md §5, execution plan item 16): the workspace is the
 * company, so every company route hangs off the workspace.
 *
 *  GET    /api/workspaces/:id/org            { mode, chiefOfStaffAgentId, orgMonthlyUsd, orgAgentCap, orgId, orgStatus, pendingApprovals, org? }
 *  PUT    /api/workspaces/:id/org            { mode, chiefOfStaffAgentId?, monthlyUsd?, agentCap? } — enable / change / turn off
 *  POST   /api/workspaces/:id/org/pause | /resume   the kill switch
 *  GET    /api/workspaces/:id/org/caps       the autonomy caps in plain words (for the Settings card and the wizard), plus the default veto window
 *  POST   /api/workspaces/:id/org/bootstrap  company onboarding in one call (item 25): chief, mode, vision, profile, tunables, cadences, first hires, planning
 *  GET    /api/workspaces/:id/org/units      the unit tree (docs/group-chat.md §7) · PATCH units/:unitId · GET units/:unitId/board · GET units/:unitId/goals/tree · GET goals/tree
 *  assurance (docs/company-vision.md §5): GET signals · POST signals/:signalId/ack | /resolve · GET pulse · GET|PATCH slo · GET audits · POST audit/run
 *  intent (docs/company-vision.md §1b–§2): GET|PUT vision · GET|PUT profile · GET|PUT tunables · GET intent?unitId= · POST goals/:goalId/checkin · GET goals/:goalId/checkins · GET why?taskId=|goalId= · POST plan · GET strategy
 *  capital (docs/company-vision.md §7–§8): GET costs?period=&unitId= · GET forecast · GET|PUT routing · GET|PUT allocations · GET plans?status= · GET plans/:planId · POST plans/:planId/veto | /apply-now · POST plan/dry-run · GET replay?day=
 *
 *  meetings (docs/company-vision.md §3, item 19): GET /org/meetings?unitId=&status= · POST /org/meetings { kind, unitId?, agenda?, attendees? } (starts now)
 *           GET /org/meetings/:meetingId · POST /org/meetings/:meetingId/cancel ·
 *           the room (docs/meetings.md): POST …/:meetingId/join · /control { action: extend|skip|end } · /verdict { kind, index, verdict } · /answer { index, answer } · /agenda { text, why? } · GET /org/decisions?unitId= · GET /org/cadences · PATCH /org/cadences/:cadenceId { cron, enabled }
 *  memory (docs/company-vision.md §6, item 22): GET /org/decisions/search?q=&unitId= · POST /org/ask { question } (CEO, board, observers) · GET /org/recall?q= ·
 *           GET /org/graph?ref=<kind:id>&depth=1|2 · GET /org/playbooks?role=&status=
 *
 * Everything else is a thin alias of `/api/orgs/:orgId/...` that resolves the
 * workspace's one org id and delegates to OrgController, so the two surfaces
 * cannot drift. `/api/orgs/...` keeps working.
 */
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Optional, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { OrgBootstrapService, CADENCE_MODES, type BootstrapInput, type CadenceMode } from './org-bootstrap.service';
import { TUNABLES } from './org-tunables';
import { OrgMeetingsService, MEETING_KINDS, type MeetingKind, type Attendee } from './org-meetings.service';
import { OrgMeetingRuntime } from './org-meeting-runtime.service';
import { OrgMemoryService } from './org-memory.service';
import { OrgKnowledgeService } from './org-knowledge.service';
import { OrgPlaybooksService } from './org-playbooks.service';
import { OrgService } from './org.service';
import { actorId } from '../accounts/account-context';
import { ORG_MODES, type OrgMode } from '../workspaces/workspaces.service';
import { OrgModeService, AUTONOMY_CAPS, MAX_ORG_AGENT_CAP } from './org-mode.service';
import {
  OrgController, UpdateOrgDto, AddMemberDto, UpdateMemberDto, ScopesDto, GoalDto, ProjectDto, TaskDto, AssignDto, TextDto, ReviewDto, DecideDto, ProposalDto, BudgetDto, WakeDto, HumanDto, UnitDto, SloDto, AckDto,
  VisionDto, ProfileDto, TunableDto, CheckInDto, PlanDto, RoutingDto, AllocationDto, DryRunDto, VetoDto,
} from './org.controller';

class OrgModeDto {
  @IsIn(ORG_MODES as unknown as string[]) mode!: OrgMode;
  @IsOptional() @IsString() chiefOfStaffAgentId?: string;
  @IsOptional() @IsNumber() @Min(0) monthlyUsd?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_ORG_AGENT_CAP) agentCap?: number;
}

export class MeetingDto {
  @IsIn(MEETING_KINDS as unknown as string[]) kind!: MeetingKind;
  @IsOptional() @IsString() unitId?: string;
  @IsOptional() @IsString() channelId?: string;
  @IsOptional() @IsString() agenda?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsArray() attendees?: Attendee[];
  @IsOptional() @IsString() facilitatorAgentId?: string;
}

/** The room (docs/meetings.md "During"): a person's control, verdict, answer or agenda proposal. */
export class MeetingControlDto { @IsIn(['extend', 'skip', 'end']) action!: 'extend' | 'skip' | 'end' }
export class MeetingVerdictDto {
  @IsIn(['decision', 'action']) kind!: 'decision' | 'action';
  @IsInt() @Min(0) index!: number;
  @IsIn(['approve', 'reject']) verdict!: 'approve' | 'reject';
  @IsOptional() @IsString() note?: string;
}
export class MeetingAnswerDto { @IsInt() @Min(0) index!: number; @IsString() answer!: string }
export class MeetingAgendaDto { @IsString() text!: string; @IsOptional() @IsString() why?: string }

export class CadenceDto {
  @IsOptional() @IsString() cron?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class AskDto { @IsString() question!: string }
/** Company onboarding (item 25). Nested shapes are checked by the service. */
export class BootstrapDto implements BootstrapInput {
  @IsIn(['supervised', 'autonomous']) mode!: 'supervised' | 'autonomous';
  @IsObject() chief!: BootstrapInput['chief'];
  @IsNumber() @Min(0) monthlyUsd!: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_ORG_AGENT_CAP) agentCap?: number;
  @IsOptional() @IsObject() vision?: BootstrapInput['vision'];
  @IsOptional() @IsObject() profile?: BootstrapInput['profile'];
  @IsOptional() @IsObject() tunables?: Record<string, number>;
  @IsOptional() @IsIn(CADENCE_MODES as unknown as string[]) cadences?: CadenceMode;
  @IsOptional() @IsArray() roles?: string[];
  @IsOptional() @IsBoolean() planNow?: boolean;
}

@Controller('workspaces/:id/org')
export class WorkspaceOrgController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly orgs: OrgController,
    private readonly config: ConfigService,
    @Optional() private readonly meetings?: OrgMeetingsService,
    @Optional() private readonly meetingRuntime?: OrgMeetingRuntime,
    /** Memory (item 22): ask-the-company, the decision search, the graph, playbooks. */
    @Optional() private readonly memory?: OrgMemoryService,
    @Optional() private readonly knowledge?: OrgKnowledgeService,
    @Optional() private readonly playbooks?: OrgPlaybooksService,
    @Optional() private readonly orgService?: OrgService,
    @Optional() private readonly bootstrapper?: OrgBootstrapService,
  ) {}

  private knowledgeOr(): OrgKnowledgeService { if (!this.knowledge) throw new NotFoundException('company memory is not available'); return this.knowledge; }

  private roomOr(): OrgMeetingRuntime { if (!this.meetingRuntime) throw new NotFoundException('meetings are not available'); return this.meetingRuntime; }

  private meetingsOr(): OrgMeetingsService { if (!this.meetings) throw new NotFoundException('meetings are not available'); return this.meetings; }

  private guard(): void { if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)'); }
  private oid(workspaceId: string): Promise<string> { this.guard(); return this.mode.orgIdOf(workspaceId); }

  @Get() async status(@Param('id') id: string) {
    this.guard();
    const st = await this.mode.status(id);
    // Units (docs/group-chat.md §7) ride along so the rail draws them without a second call.
    return { ...st, org: st.orgId ? await this.orgs.get(st.orgId) : null, units: st.orgId ? await this.orgs.units_(st.orgId).catch(() => []) : [] };
  }
  @Put() set(@Param('id') id: string, @Body() dto: OrgModeDto) { this.guard(); return this.mode.setMode(id, dto, this.orgs.actorName()); }
  @Get('caps') caps() { this.guard(); return { ...AUTONOMY_CAPS, vetoWindowMinutes: TUNABLES['capital.vetoWindowMinutes']?.default ?? 30 }; }
  /** Company onboarding (item 25): the whole setup in order, refused with 400 when the workspace already has a company. */
  @Post('bootstrap') bootstrap(@Param('id') id: string, @Body() dto: BootstrapDto) {
    this.guard();
    if (!this.bootstrapper) throw new NotFoundException('company onboarding is not available');
    return this.bootstrapper.bootstrap(id, dto, this.orgs.actorName());
  }
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

  // Intent (docs/company-vision.md §1b–§2, item 18)
  @Get('vision') async vision(@Param('id') id: string) { return this.orgs.vision(await this.oid(id)); }
  @Put('vision') async setVision(@Param('id') id: string, @Body() dto: VisionDto) { return this.orgs.setVision(await this.oid(id), dto); }
  @Get('profile') async profile(@Param('id') id: string) { return this.orgs.profile(await this.oid(id)); }
  @Put('profile') async setProfile(@Param('id') id: string, @Body() dto: ProfileDto) { return this.orgs.setProfile(await this.oid(id), dto); }
  @Get('tunables') async tunables(@Param('id') id: string) { return this.orgs.tunables(await this.oid(id)); }
  @Put('tunables') async setTunable(@Param('id') id: string, @Body() dto: TunableDto) { return this.orgs.setTunable(await this.oid(id), dto); }
  @Get('intent') async intentTree(@Param('id') id: string, @Query('unitId') unitId?: string) { return this.orgs.intentTree(await this.oid(id), unitId); }
  @Post('goals/:goalId/checkin') async checkIn(@Param('id') id: string, @Param('goalId') goalId: string, @Body() dto: CheckInDto) { return this.orgs.checkIn(await this.oid(id), goalId, dto); }
  @Get('goals/:goalId/checkins') async checkIns(@Param('id') id: string, @Param('goalId') goalId: string) { return this.orgs.checkIns(await this.oid(id), goalId); }
  @Get('why') async why(@Param('id') id: string, @Query('taskId') taskId?: string, @Query('goalId') goalId?: string) { return this.orgs.why(await this.oid(id), taskId, goalId); }
  @Post('plan') async plan(@Param('id') id: string, @Body() dto: PlanDto) { return this.orgs.plan(await this.oid(id), dto); }
  @Get('strategy') async strategy(@Param('id') id: string) { return this.orgs.strategy(await this.oid(id)); }

  // Capital (docs/company-vision.md §7–§8, item 23)
  @Get('costs') async costs(@Param('id') id: string, @Query('period') period?: string, @Query('unitId') unitId?: string) { return this.orgs.costs(await this.oid(id), period, unitId); }
  @Get('forecast') async forecast(@Param('id') id: string) { return this.orgs.forecast(await this.oid(id)); }
  @Get('routing') async routing(@Param('id') id: string) { return this.orgs.routing(await this.oid(id)); }
  @Put('routing') async setRouting(@Param('id') id: string, @Body() dto: RoutingDto) { return this.orgs.setRouting(await this.oid(id), dto); }
  @Get('allocations') async allocations(@Param('id') id: string) { return this.orgs.allocations(await this.oid(id)); }
  @Put('allocations') async setAllocation(@Param('id') id: string, @Body() dto: AllocationDto) { return this.orgs.setAllocation(await this.oid(id), dto); }
  @Get('plans') async plans(@Param('id') id: string, @Query('status') status?: string) { return this.orgs.plans(await this.oid(id), status); }
  @Get('plans/:planId') async planGet(@Param('id') id: string, @Param('planId') planId: string) { return this.orgs.planGet(await this.oid(id), planId); }
  @Post('plans/:planId/veto') async vetoPlan(@Param('id') id: string, @Param('planId') planId: string, @Body() dto: VetoDto) { return this.orgs.vetoPlan(await this.oid(id), planId, dto); }
  @Post('plans/:planId/apply-now') async applyPlan(@Param('id') id: string, @Param('planId') planId: string) { return this.orgs.applyPlan(await this.oid(id), planId); }
  @Post('plan/dry-run') async dryRun(@Param('id') id: string, @Body() dto: DryRunDto) { return this.orgs.dryRun(await this.oid(id), dto); }
  @Get('replay') async replay(@Param('id') id: string, @Query('day') day?: string) { return this.orgs.replay(await this.oid(id), day); }

  @Get('goals') async goals(@Param('id') id: string, @Query('unitId') unitId?: string) { return this.orgs.goals(await this.oid(id), unitId); }
  @Post('goals') async addGoal(@Param('id') id: string, @Body() dto: GoalDto) { return this.orgs.addGoal(await this.oid(id), dto); }
  @Patch('goals/:goalId') async updateGoal(@Param('id') id: string, @Param('goalId') goalId: string, @Body() dto: GoalDto) { return this.orgs.updateGoal(await this.oid(id), goalId, dto); }
  @Get('projects') async projects(@Param('id') id: string) { return this.orgs.projects(await this.oid(id)); }
  @Post('projects') async addProject(@Param('id') id: string, @Body() dto: ProjectDto) { return this.orgs.addProject(await this.oid(id), dto); }
  @Patch('projects/:projectId') async updateProject(@Param('id') id: string, @Param('projectId') projectId: string, @Body() dto: ProjectDto) { return this.orgs.updateProject(await this.oid(id), projectId, dto); }

  @Get('tasks') async board(@Param('id') id: string, @Query('projectId') projectId?: string, @Query('status') status?: string, @Query('unitId') unitId?: string, @Query('rollUp') rollUp?: string) { return this.orgs.board(await this.oid(id), projectId, status, unitId, rollUp); }
  @Get('tasks/:taskId') async task(@Param('id') id: string, @Param('taskId') taskId: string) { return this.orgs.task(await this.oid(id), taskId); }
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
  @Get('decisions/authority') decisionAuthority() { return this.orgs.decisionAuthority(); }
  @Get('decisions/route') async decisionRoute(@Param('id') id: string, @Query('from') from?: string, @Query('kind') kind?: string) { return this.orgs.decisionRoute(await this.oid(id), from, kind); }
  @Get('decisions/mine') async myDecisions(@Param('id') id: string) { return this.orgs.myDecisions(await this.oid(id)); }

  @Get('humans') async humans(@Param('id') id: string) { return this.orgs.humans(await this.oid(id)); }
  @Post('humans') async setHuman(@Param('id') id: string, @Body() dto: HumanDto) { return this.orgs.setHuman(await this.oid(id), dto); }
  @Get('humans/me/tasks') async myTasks(@Param('id') id: string) { return this.orgs.myTasks(await this.oid(id)); }
  @Get('humans/:memberAccountId/tasks') async humanTasks(@Param('id') id: string, @Param('memberAccountId') memberAccountId: string) { return this.orgs.humanTasks(await this.oid(id), memberAccountId); }
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

  // ---- assurance (docs/company-vision.md §5) ----
  @Get('signals') async signals(@Param('id') id: string, @Query('status') status?: string, @Query('severity') severity?: string, @Query('unitId') unitId?: string, @Query('kind') kind?: string) { return this.orgs.signalsList(await this.oid(id), status, severity, unitId, kind); }
  @Post('signals/:signalId/ack') async ackSignal(@Param('id') id: string, @Param('signalId') signalId: string, @Body() dto: AckDto) { return this.orgs.ackSignal(await this.oid(id), signalId, dto); }
  @Post('signals/:signalId/resolve') async resolveSignal(@Param('id') id: string, @Param('signalId') signalId: string) { return this.orgs.resolveSignal(await this.oid(id), signalId); }
  @Get('pulse') async pulse(@Param('id') id: string) { return this.orgs.pulse(await this.oid(id)); }
  @Get('slo') async slo(@Param('id') id: string) { return this.orgs.sloTargets(await this.oid(id)); }
  @Patch('slo') async setSlo(@Param('id') id: string, @Body() dto: SloDto) { return this.orgs.setSlo(await this.oid(id), dto); }
  @Get('audits') async audits(@Param('id') id: string, @Query('limit') limit?: string) { return this.orgs.audits(await this.oid(id), limit); }
  @Post('audit/run') async runAudit(@Param('id') id: string) { return this.orgs.runAudit(await this.oid(id)); }

  // ---- meetings, decisions, cadences (docs/company-vision.md §3, §6; item 19) ----
  @Get('meetings') async meetingList(@Param('id') id: string, @Query('unitId') unitId?: string, @Query('status') status?: string) { return this.meetingsOr().list(await this.oid(id), { unitId: unitId || null, status: status || null }); }
  @Post('meetings') async startMeeting(@Param('id') id: string, @Body() dto: MeetingDto) {
    if (!this.meetingRuntime) throw new NotFoundException('meetings are not available');
    const orgId = await this.oid(id);
    return this.meetingRuntime.start(orgId, { ...dto, createdBy: this.orgs.actorName() });
  }
  @Get('meetings/:meetingId') async meeting(@Param('id') id: string, @Param('meetingId') meetingId: string) { return this.meetingsOr().get(await this.oid(id), meetingId); }
  @Post('meetings/:meetingId/join') async joinMeeting(@Param('id') id: string, @Param('meetingId') meetingId: string) { return this.roomOr().join(await this.oid(id), meetingId, { id: actorId() }); }
  @Post('meetings/:meetingId/control') async controlMeeting(@Param('id') id: string, @Param('meetingId') meetingId: string, @Body() dto: MeetingControlDto) { return this.roomOr().control(await this.oid(id), meetingId, { id: actorId() }, dto.action); }
  @Post('meetings/:meetingId/verdict') async meetingVerdict(@Param('id') id: string, @Param('meetingId') meetingId: string, @Body() dto: MeetingVerdictDto) { return this.roomOr().verdict(await this.oid(id), meetingId, { id: actorId() }, dto); }
  @Post('meetings/:meetingId/answer') async meetingAnswer(@Param('id') id: string, @Param('meetingId') meetingId: string, @Body() dto: MeetingAnswerDto) { return this.roomOr().answer(await this.oid(id), meetingId, { id: actorId() }, dto); }
  @Post('meetings/:meetingId/agenda') async meetingAgenda(@Param('id') id: string, @Param('meetingId') meetingId: string, @Body() dto: MeetingAgendaDto) { return this.roomOr().proposeAgenda(await this.oid(id), meetingId, { kind: 'human', id: actorId() }, dto); }
  @Post('meetings/:meetingId/cancel') async cancelMeeting(@Param('id') id: string, @Param('meetingId') meetingId: string) { return this.meetingsOr().cancel(await this.oid(id), meetingId, this.orgs.actorName()); }
  @Get('decisions') async decisions(@Param('id') id: string, @Query('unitId') unitId?: string) { return this.meetingsOr().decisions(await this.oid(id), { unitId: unitId || null }); }
  @Get('cadences') async cadences(@Param('id') id: string) { const orgId = await this.oid(id); await this.meetingsOr().ensureCadenceDefaults(orgId); return this.meetingsOr().cadences(orgId); }
  @Patch('cadences/:cadenceId') async updateCadence(@Param('id') id: string, @Param('cadenceId') cadenceId: string, @Body() dto: CadenceDto) {
    if (dto.cron === undefined && dto.enabled === undefined) throw new BadRequestException('cron or enabled is required');
    return this.meetingsOr().updateCadence(await this.oid(id), cadenceId, dto, this.orgs.actorName());
  }

  // ---- memory (docs/company-vision.md §6; item 22) ----
  @Get('decisions/search') async searchDecisions(@Param('id') id: string, @Query('q') q?: string, @Query('unitId') unitId?: string, @Query('limit') limit?: string) { return this.knowledgeOr().searchDecisions(await this.oid(id), q ?? '', { unitId: unitId || null, limit: Number(limit) || 50 }); }
  @Get('recall') async recall(@Param('id') id: string, @Query('q') q?: string) { return this.knowledgeOr().recall(await this.oid(id), q ?? ''); }
  @Get('graph') async graph(@Param('id') id: string, @Query('ref') ref?: string, @Query('depth') depth?: string) { return this.knowledgeOr().graph(await this.oid(id), ref ?? '', Number(depth) || 1); }
  @Get('playbooks') async playbookList(@Param('id') id: string, @Query('role') role?: string, @Query('status') status?: string) {
    if (!this.playbooks) throw new NotFoundException('playbooks are not available');
    return this.playbooks.list(await this.oid(id), { role: role || null, status: status || null });
  }
  /** Retire a playbook (CEO or board): its skill is disabled and it is no longer offered. */
  @Post('playbooks/:playbookId/retire') async retirePlaybook(@Param('id') id: string, @Param('playbookId') playbookId: string, @Body() dto: Partial<AskDto> & { why?: string }) {
    if (!this.playbooks) throw new NotFoundException('playbooks are not available');
    const orgId = await this.oid(id);
    const role = this.orgService ? await this.orgService.humanRole(orgId, actorId()) : 'ceo';
    if (role !== 'ceo' && role !== 'board') throw new ForbiddenException('only the CEO or the board may retire a playbook');
    return this.playbooks.retire(orgId, playbookId, this.orgs.actorName(), typeof dto?.why === 'string' ? dto.why.slice(0, 500) : '');
  }
  /** Ask the company: anyone with standing (CEO, board, observer) may ask; the chief answers read-only with verified citations. */
  @Post('ask') async ask(@Param('id') id: string, @Body() dto: AskDto) {
    if (!this.memory) throw new NotFoundException('company memory is not available');
    const orgId = await this.oid(id);
    const role = this.orgService ? await this.orgService.humanRole(orgId, actorId()) : 'ceo';
    if (!role) throw new ForbiddenException('you have no standing in this organisation');
    return this.memory.ask(orgId, dto.question, this.orgs.actorName());
  }

  /** Manual structure review (autonomous mode only): runs the chief now. */
  @Post('review') async reviewNow(@Param('id') id: string) { return { result: await this.orgs.reviewStructureNow(await this.oid(id)) }; }
}
