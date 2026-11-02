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
 *  units (docs/group-chat.md §7): GET /:id/units (tree) · PATCH /:id/units/:unitId (rename) · GET /:id/units/:unitId/board · GET /:id/units/:unitId/goals/tree · GET /:id/goals/tree
 *  intent (docs/company-vision.md §1b–§2): GET|PUT /:id/vision · GET|PUT /:id/profile · GET|PUT /:id/tunables · GET /:id/intent?unitId= · POST /:id/goals/:goalId/checkin · GET …/checkins · GET /:id/why?taskId=|goalId= · POST /:id/plan · GET /:id/strategy
 *  goals / projects: GET · POST · PATCH (goals take unitId, parentGoalId, kind and the key-result fields; ?unitId= filters)
 *  tasks: GET /:id/tasks (board) · POST · PATCH /:id/tasks/:taskId · POST …/assign · …/comment · …/review · …/wake · GET …/runs
 *  approvals: GET /:id/approvals · POST /:id/approvals/:approvalId/decide — the only place an approval is decided
 *  humans (phase D): GET /:id/humans · POST /:id/humans { memberAccountId, role } · DELETE /:id/humans/:memberAccountId
 *  audit: GET /:id/audit · GET /:id/audit/verify
 *  brief: GET /:id/brief · POST /:id/brief (compose now) · POST /:id/brief/reply { text }
 *  spend: GET /:id/spend · PUT /:id/budgets
 *  messages: GET /:id/messages · POST /:id/messages (the user posts; nobody is woken)
 *  runs: GET /:id/runs
 *  assurance (docs/company-vision.md §5): GET /:id/signals?status=&severity=&unitId= · POST /:id/signals/:signalId/ack | /resolve ·
 *           GET /:id/pulse · GET /:id/slo · PATCH /:id/slo · GET /:id/audits · POST /:id/audit/run
 *  capital (docs/company-vision.md §7–§8): GET /:id/costs?period=&unitId= · GET /:id/forecast · GET|PUT /:id/routing · GET /:id/allocations ·
 *           GET /:id/plans?status= · GET /:id/plans/:planId · POST /:id/plans/:planId/veto | /apply-now · POST /:id/plan/dry-run · GET /:id/replay?day=
 *
 * Every route except /status answers 404 when COMPANIES_ENABLED=false.
 *
 * Since execution plan item 16 the primary surface is
 * `/api/workspaces/:id/org/...` (WorkspaceOrgController), which resolves the
 * workspace's one organization and delegates here; these routes stay as
 * aliases and keep working.
 */
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Optional, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { actorId, currentAccountId, currentViewer } from '../accounts/account-context';
import { ConfigService } from '@nestjs/config';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { OrgService, HUMAN_ROLES, mayDecide, type HumanRole } from './org.service';
import { OrgTasksService, TASK_STATUSES, verificationOf, type TaskStatus } from './org-tasks.service';
import { OrgApprovalsService, APPROVAL_KINDS, type ApprovalKind } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';
import { OrgBriefService, parseBriefReply } from './org-brief.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgUnitsService } from './org-units.service';
import { ASSURANCE_TUNABLES, parseTunables } from './org-assurance-tunables';
import { OrgSignalsService } from './org-signals.service';
import { OrgSloService } from './org-slo.service';
import { OrgAuditorService } from './org-auditor.service';
import { OrgIntentService } from './org-intent.service';
import { OrgCapitalService } from './org-capital.service';
import { describeTunables } from './org-tunables';

export class ChiefDto {
  @IsString() name!: string;
  @IsOptional() @IsString() charter?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() emoji?: string;
  /** Catalog pack whose charter seeds the chief when no charter is given. */
  @IsOptional() @IsString() packId?: string;
}

export class CreateOrgDto {
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

export class UpdateOrgDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() mission?: string;
  @IsOptional() @IsString() ceoUserNote?: string;
  @IsOptional() @IsInt() @Min(0) @Max(23) briefHour?: number;
  @IsOptional() @IsInt() maxDirectReports?: number;
  @IsOptional() @IsNumber() monthlyBudgetUsd?: number;
  /** Assurance (docs/company-vision.md §5.3): the auditor member, its cadence and the USD cap of one run. */
  @IsOptional() auditorAgentId?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(90) auditCadenceDays?: number;
  @IsOptional() @IsNumber() @Min(0.1) @Max(50) auditUsdCap?: number;
}

export class SloDto {
  @IsOptional() @IsNumber() cycleTimeHours?: number;
  @IsOptional() @IsNumber() firstReviewAcceptancePct?: number;
  @IsOptional() @IsNumber() decisionLatencyHours?: number;
  /** Any other assurance tunable (`pulse.*`, `signals.*`, `audit.*`), null removes an override. */
  @IsOptional() @IsObject() tunables?: Record<string, number | null>;
}

export class AckDto { @IsOptional() @IsString() note?: string }

export class AddMemberDto {
  @IsString() agentId!: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() reportsToAgentId?: string;
  @IsOptional() @IsArray() scopes?: string[];
}

export class UpdateMemberDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() reportsToAgentId?: string | null;
}

export class ScopesDto { @IsArray() scopes!: string[] }

export class GoalDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() ownerAgentId?: string | null;
  /** Units (docs/group-chat.md §7). */
  @IsOptional() unitId?: string | null;
  @IsOptional() parentGoalId?: string | null;
  /** Intent (docs/company-vision.md §2): kind and the key-result fields. */
  @IsOptional() @IsIn(['vision', 'objective', 'key_result']) kind?: 'vision' | 'objective' | 'key_result';
  @IsOptional() @IsString() metric?: string;
  @IsOptional() targetValue?: number | null;
  @IsOptional() startValue?: number | null;
  @IsOptional() @IsString() unitLabel?: string;
  @IsOptional() dueAt?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(90) checkInCadenceDays?: number;
}

export class VisionDto {
  @IsString() title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() dueAt?: string | null;
  @IsOptional() @IsString() rules?: string;
  @IsOptional() @IsNumber() @Min(0) monthlyUsd?: number;
}
export class ProfileDto { @IsOptional() @IsString() values?: string; @IsOptional() @IsString() culture?: string }
export class TunableDto { @IsString() key!: string; @IsNumber() value!: number; @IsOptional() @IsString() why?: string }
export class CheckInDto { @IsOptional() currentValue?: number | null; @IsOptional() confidence?: number | null; @IsOptional() @IsString() note?: string }
export class PlanDto { @IsOptional() @IsString() unitId?: string; @IsOptional() @IsString() reason?: string }
/** Capital (docs/company-vision.md §7–§8). */
export class RoutingDto { @IsOptional() @IsObject() classes?: Record<string, string | null>; @IsOptional() @IsObject() models?: Record<string, string | null>; @IsOptional() @IsString() why?: string }
export class AllocationDto { @IsString() goalId!: string; @IsNumber() @Min(0) monthlyUsd!: number; @IsOptional() @IsString() buys?: string }
export class DryRunDto { @IsOptional() @IsString() prompt?: string; @IsOptional() @IsObject() assume?: { monthlyUsd?: number } }
export class VetoDto { @IsOptional() @IsString() note?: string }

export class UnitDto { @IsString() name!: string }

export class ProjectDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() goalId?: string | null;
  @IsOptional() ownerAgentId?: string | null;
}

export class TaskDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsObject() brief?: Record<string, string>;
  @IsOptional() @IsIn(TASK_STATUSES as unknown as string[]) status?: TaskStatus;
  @IsOptional() projectId?: string | null;
  @IsOptional() parentTaskId?: string | null;
  @IsOptional() assigneeAgentId?: string | null;
  @IsOptional() reviewerAgentId?: string | null;
  @IsOptional() @IsArray() blockers?: string[];
  @IsOptional() @IsArray() fileScope?: string[];
  /** Units (docs/group-chat.md §7): the board the task sits on; defaulted by the rule when absent. */
  @IsOptional() @IsString() unitId?: string;
  /** Capital (docs/company-vision.md §7): the task class (triage | research | synthesis | review | ops | general). */
  @IsOptional() @IsString() class?: string;
  /** Executable acceptance (docs/sensing.md §3): model-free checks run before review. */
  @IsOptional() @IsArray() checks?: unknown[];
  /** Capacity (item 31): task ids (or 8-char prefixes) this task waits on, and its deadline (ISO; null clears). */
  @IsOptional() @IsArray() dependsOn?: string[];
  @IsOptional() dueAt?: string | null;
}

export class AssignDto { @IsOptional() @IsString() agentId?: string; /** Hybrid staff (item 24): a human employee's account id instead. */ @IsOptional() @IsString() humanId?: string }
export class TextDto { @IsString() text!: string }
export class ReviewDto {
  @IsIn(['accept', 'request_changes', 'escalate']) verdict!: 'accept' | 'request_changes' | 'escalate';
  @IsOptional() @IsString() note?: string;
}
export class DecideDto {
  @IsIn(['approve', 'reject', 'revise']) decision!: 'approve' | 'reject' | 'revise';
  @IsOptional() @IsString() note?: string;
}
export class ProposalDto {
  @IsIn(APPROVAL_KINDS as unknown as string[]) kind!: ApprovalKind;
  @IsObject() payload!: Record<string, unknown>;
  @IsOptional() @IsString() recommendation?: string;
}
export class BudgetDto {
  @IsIn(['company', 'agent', 'project']) scope!: 'company' | 'agent' | 'project';
  @IsOptional() @IsString() refId?: string;
  @IsNumber() monthlyUsd!: number;
}
export class WakeDto { @IsOptional() @IsString() agentId?: string; @IsOptional() @IsBoolean() now?: boolean }
export class HumanDto {
  @IsString() memberAccountId!: string;
  @IsIn(HUMAN_ROLES as unknown as string[]) role!: HumanRole;
  /** Employees (docs/company-vision.md §4, item 24): the member they report to and their title. */
  @IsOptional() reportsToAgentId?: string | null;
  @IsOptional() @IsString() title?: string;
}

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
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() private readonly slo?: OrgSloService,
    @Optional() private readonly auditor?: OrgAuditorService,
    @Optional() private readonly intent?: OrgIntentService,
    @Optional() private readonly capital?: OrgCapitalService,
  ) {}

  private enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }
  private guard(): void { if (!this.enabled()) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)'); }

  /** The audit actor for a human decision: 'user' for the owner (CEO),
   *  `human:<accountId>` for a member of the shared workspace (phase D). */
  actorName(): string { return this.actor(); }

  private actor(): string {
    const v = currentViewer();
    return v && v.memberAccountId !== currentAccountId() ? `human:${v.memberAccountId}` : 'user';
  }

  /** Phase D: who may decide what. The owner is CEO; others need an
   *  org_humans row — board for hire | budget_raise | strategy, nothing else. */
  private async assertMayDecide(orgId: string, kind: string): Promise<void> {
    const role = await this.org.humanRole(orgId, actorId());
    if (!mayDecide(role, kind)) {
      throw new ForbiddenException(role === 'board'
        ? `board members decide hire, budget_raise and strategy approvals; a ${kind} approval is the CEO's`
        : role === 'observer' ? 'observers can read the company but not decide for it' : 'you have no standing in this organisation');
    }
  }

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

  // ---- units (docs/group-chat.md §7) ----
  private unitsOr(): OrgUnitsService { if (!this.units) throw new NotFoundException('units are not available'); return this.units; }
  @Get(':id/units') async units_(@Param('id') id: string) { this.guard(); return this.unitsOr().unitTree(id); }
  @Patch(':id/units/:unitId') async renameUnit(@Param('id') id: string, @Param('unitId') unitId: string, @Body() dto: UnitDto) { this.guard(); return this.unitsOr().rename(id, unitId, dto.name, this.actor()); }
  @Get(':id/units/:unitId/board') unitBoard(@Param('id') id: string, @Param('unitId') unitId: string, @Query('rollUp') rollUp?: string, @Query('status') status?: string) {
    this.guard(); return this.tasks.list(id, { unitId, rollUp: rollUp === 'true', status: status || undefined }).then((rows) => rows.map((t) => ({ ...t, verification: verificationOf(t) })));
  }
  @Get(':id/units/:unitId/goals/tree') async unitGoals(@Param('id') id: string, @Param('unitId') unitId: string) { this.guard(); return this.unitsOr().goalTree(id, { unitId }); }
  @Get(':id/goals/tree') async goalTree(@Param('id') id: string, @Query('unitId') unitId?: string) { this.guard(); return this.unitsOr().goalTree(id, { unitId: unitId || null }); }

  // ---- intent (docs/company-vision.md §1b–§2, item 18) ----
  private intentOr(): OrgIntentService { if (!this.intent) throw new NotFoundException('intent is not available'); return this.intent; }
  /** The CEO's seat only: the vision, the profile and the tunables are theirs to write. */
  private async assertCeo(orgId: string, what: string): Promise<void> {
    if ((await this.org.humanRole(orgId, actorId())) !== 'ceo') throw new ForbiddenException(`${what} is the CEO's to write`);
  }
  @Get(':id/vision') async vision(@Param('id') id: string) {
    this.guard();
    const org = await this.org.get(id);
    return { vision: await this.intentOr().vision(id), rules: org.rules, values: org.values, culture: org.culture };
  }
  @Put(':id/vision') async setVision(@Param('id') id: string, @Body() dto: VisionDto) { this.guard(); await this.assertCeo(id, 'the vision'); return this.intentOr().setVision(id, dto, this.actor()); }
  @Get(':id/profile') async profile(@Param('id') id: string) { this.guard(); const o = await this.org.get(id); return { values: o.values, culture: o.culture, rules: o.rules, mission: o.mission }; }
  @Put(':id/profile') async setProfile(@Param('id') id: string, @Body() dto: ProfileDto) { this.guard(); await this.assertCeo(id, 'the operating profile'); const o = await this.org.setProfile(id, dto, this.actor()); return { values: o.values, culture: o.culture, rules: o.rules, mission: o.mission }; }
  @Get(':id/tunables') async tunables(@Param('id') id: string) { this.guard(); return describeTunables(await this.org.get(id)); }
  @Put(':id/tunables') async setTunable(@Param('id') id: string, @Body() dto: TunableDto) { this.guard(); await this.assertCeo(id, 'a tunable'); return this.org.setTunable(id, dto.key, dto.value, { actor: this.actor(), why: dto.why, decidedBy: actorId() }); }
  @Get(':id/intent') async intentTree(@Param('id') id: string, @Query('unitId') unitId?: string) { this.guard(); return this.intentOr().intentTree(id, { unitId: unitId || null }); }
  @Post(':id/goals/:goalId/checkin') checkIn(@Param('id') id: string, @Param('goalId') goalId: string, @Body() dto: CheckInDto) { this.guard(); return this.intentOr().checkIn(id, goalId, dto, this.actor()); }
  @Get(':id/goals/:goalId/checkins') checkIns(@Param('id') id: string, @Param('goalId') goalId: string) { this.guard(); return this.intentOr().checkIns(id, goalId); }
  @Get(':id/why') why(@Param('id') id: string, @Query('taskId') taskId?: string, @Query('goalId') goalId?: string) { this.guard(); return this.intentOr().whyChain(id, { taskId: taskId || undefined, goalId: goalId || undefined }); }
  /** A planning session now (the CEO): the unit's lead, the root by default. Ignores the cooldown. */
  @Post(':id/plan') async plan(@Param('id') id: string, @Body() dto: PlanDto) {
    this.guard();
    const unitId = dto.unitId ?? (await this.unitsOr().rootUnit(id)).id;
    return { result: await this.runtime.runPlanning(id, { unitId, trigger: 'manual', reasons: [dto.reason || 'planning requested by the CEO'] }) };
  }
  @Get(':id/strategy') strategy(@Param('id') id: string) { this.guard(); return this.intentOr().strategy(id); }

  // ---- capital (docs/company-vision.md §7–§8, item 23) ----
  private capitalOr(): OrgCapitalService { if (!this.capital) throw new NotFoundException('capital is not available'); return this.capital; }
  @Get(':id/costs') costs(@Param('id') id: string, @Query('period') period?: string, @Query('unitId') unitId?: string) { this.guard(); return this.capitalOr().costByGoal(id, { period: period === 'all' ? 'all' : 'month', unitId: unitId || null }); }
  @Get(':id/forecast') forecast(@Param('id') id: string) { this.guard(); return this.capitalOr().forecast(id); }
  @Get(':id/routing') async routing(@Param('id') id: string) { this.guard(); return this.org.routing(id); }
  @Put(':id/routing') async setRouting(@Param('id') id: string, @Body() dto: RoutingDto) { this.guard(); await this.assertCeo(id, 'the routing'); return this.org.setRouting(id, { classes: dto.classes, models: dto.models }, { actor: this.actor(), why: dto.why, decidedBy: actorId() }); }
  @Get(':id/allocations') allocations(@Param('id') id: string) { this.guard(); return this.org.allocations(id); }
  @Put(':id/allocations') async setAllocation(@Param('id') id: string, @Body() dto: AllocationDto) { this.guard(); await this.assertCeo(id, 'an allocation'); return this.org.setAllocation(id, { goalId: dto.goalId, monthlyUsd: dto.monthlyUsd, rationale: dto.buys, actor: this.actor() }); }
  @Get(':id/plans') plans(@Param('id') id: string, @Query('status') status?: string) { this.guard(); return this.capitalOr().plans(id, { status: status || undefined }); }
  @Get(':id/plans/:planId') planGet(@Param('id') id: string, @Param('planId') planId: string) { this.guard(); return this.capitalOr().plan(id, planId); }
  @Post(':id/plans/:planId/veto') async vetoPlan(@Param('id') id: string, @Param('planId') planId: string, @Body() dto: VetoDto) { this.guard(); await this.assertCeo(id, 'a plan'); return this.capitalOr().veto(id, planId, this.actor(), dto?.note ?? ''); }
  @Post(':id/plans/:planId/apply-now') async applyPlan(@Param('id') id: string, @Param('planId') planId: string) { this.guard(); await this.assertCeo(id, 'a plan'); return this.capitalOr().applyNow(id, planId, this.actor()); }
  @Post(':id/plan/dry-run') async dryRun(@Param('id') id: string, @Body() dto: DryRunDto) { this.guard(); await this.assertCeo(id, 'a dry run'); return this.runtime.dryRunPlanning(id, { prompt: dto?.prompt, assume: dto?.assume }); }
  @Get(':id/replay') replay(@Param('id') id: string, @Query('day') day?: string) { this.guard(); return this.capitalOr().replay(id, day || new Date().toISOString().slice(0, 10)); }

  // ---- goals / projects ----
  @Get(':id/goals') goals(@Param('id') id: string, @Query('unitId') unitId?: string) { this.guard(); return this.org.goals(id, { unitId: unitId || undefined }); }
  @Post(':id/goals') addGoal(@Param('id') id: string, @Body() dto: GoalDto) {
    this.guard();
    const input = { title: dto.title ?? '', description: dto.description, ownerAgentId: dto.ownerAgentId, status: dto.status, unitId: dto.unitId, parentGoalId: dto.parentGoalId, kind: dto.kind, metric: dto.metric, targetValue: dto.targetValue, startValue: dto.startValue, unitLabel: dto.unitLabel, dueAt: dto.dueAt, checkInCadenceDays: dto.checkInCadenceDays };
    return this.units ? this.units.addGoal(id, input, this.actor()) : this.org.addGoal(id, input, this.actor());
  }
  @Patch(':id/goals/:goalId') updateGoal(@Param('id') id: string, @Param('goalId') goalId: string, @Body() dto: GoalDto) { this.guard(); return this.org.updateGoal(id, goalId, dto); }
  @Get(':id/projects') projects(@Param('id') id: string) { this.guard(); return this.org.projects(id); }
  @Post(':id/projects') addProject(@Param('id') id: string, @Body() dto: ProjectDto) { this.guard(); return this.org.addProject(id, { title: dto.title ?? '', goalId: dto.goalId, ownerAgentId: dto.ownerAgentId }); }
  @Patch(':id/projects/:projectId') updateProject(@Param('id') id: string, @Param('projectId') projectId: string, @Body() dto: ProjectDto) { this.guard(); return this.org.updateProject(id, projectId, dto); }

  // ---- tasks (the board) ----
  @Get(':id/tasks') board(@Param('id') id: string, @Query('projectId') projectId?: string, @Query('status') status?: string, @Query('unitId') unitId?: string, @Query('rollUp') rollUp?: string) {
    this.guard();
    // Executable acceptance (docs/sensing.md §3): how each done task was verified.
    // Capacity (item 31): `waitingOn` and the expected duration per task.
    return this.tasks.list(id, { projectId: projectId || undefined, status: status || undefined, unitId: unitId || undefined, rollUp: rollUp === 'true' })
      .then((rows) => this.tasks.annotate(id, rows)).then((rows) => rows.map((t) => ({ ...t, verification: verificationOf(t) })));
  }
  /** One task by id or its short prefix, whatever its status or unit (the task deep link, docs/home.md). */
  @Get(':id/tasks/:taskId') task(@Param('id') id: string, @Param('taskId') taskId: string) {
    this.guard();
    return this.tasks.byPrefix(id, taskId).then((t) => this.tasks.annotate(id, [t])).then(([t]) => ({ ...t, verification: verificationOf(t) }));
  }
  @Post(':id/tasks') addTask(@Param('id') id: string, @Body() dto: TaskDto) {
    this.guard();
    return this.tasks.create(id, { title: dto.title ?? '', brief: dto.brief, projectId: dto.projectId, parentTaskId: dto.parentTaskId, status: dto.status, assigneeAgentId: dto.assigneeAgentId, reviewerAgentId: dto.reviewerAgentId, fileScope: dto.fileScope, unitId: dto.unitId, class: dto.class, checks: dto.checks, dependsOn: dto.dependsOn, dueAt: dto.dueAt, createdBy: 'user' });
  }
  @Patch(':id/tasks/:taskId') updateTask(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: TaskDto) {
    this.guard();
    return this.tasks.update(id, taskId, { title: dto.title, brief: dto.brief, status: dto.status, blockers: dto.blockers, projectId: dto.projectId, reviewerAgentId: dto.reviewerAgentId, fileScope: dto.fileScope, unitId: dto.unitId, class: dto.class, checks: dto.checks, dependsOn: dto.dependsOn, dueAt: dto.dueAt });
  }
  @Post(':id/tasks/:taskId/assign') async assign(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: AssignDto) {
    this.guard();
    if (dto.humanId) return this.tasks.assignHuman(id, taskId, dto.humanId, this.actor());
    if (!dto.agentId) throw new BadRequestException('agentId or humanId is required');
    return this.tasks.assign(id, taskId, dto.agentId, this.actor());
  }
  @Post(':id/tasks/:taskId/comment') comment(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: TextDto) { this.guard(); return this.tasks.comment(id, taskId, { text: dto.text, fromAgentId: null }); }
  @Get(':id/tasks/:taskId/comments') comments(@Param('id') id: string, @Param('taskId') taskId: string) { this.guard(); return this.tasks.messages(id, { taskId }); }
  /** The CEO reviews directly (no independent check: the human is the floor). */
  @Post(':id/tasks/:taskId/review') review(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: ReviewDto) { this.guard(); return this.tasks.review(id, taskId, { verdict: dto.verdict, note: dto.note, byAgentId: null }); }
  @Post(':id/tasks/:taskId/request-review') requestReview(@Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: Partial<TextDto> & { reviewerHumanId?: string }) { this.guard(); return this.tasks.requestReview(id, taskId, { note: dto.text, fromAgentId: null, reviewerHumanId: dto.reviewerHumanId ?? null }); }
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
  @Post(':id/approvals') propose(@Param('id') id: string, @Body() dto: ProposalDto) {
    this.guard();
    // A hire named by catalog ref (`role:<id>` or a pack, from the Hire
    // dialog or the Market) is validated and resolved like the chief's own
    // proposal: depth and fan-out checked now, scopes met with the chief's
    // holdings, the role's charter and the pack's playbooks on the card.
    const p = dto.payload ?? {};
    if (dto.kind === 'hire' && typeof p.templateOrPack === 'string' && p.templateOrPack.trim()) {
      const str = (k: string) => { const v = p[k]; return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
      return this.approvals.proposeHire(id, {
        templateOrPack: p.templateOrPack.trim(), name: str('name'), title: str('title'), charter: str('charter'), reportsToAgentId: str('reportsToAgentId'),
        scopes: Array.isArray(p.scopes) ? p.scopes.filter((s): s is string => typeof s === 'string') : undefined,
        provider: str('provider'), model: str('model'), monthlyBudgetUsd: typeof p.monthlyBudgetUsd === 'number' ? p.monthlyBudgetUsd : undefined,
        requestedBy: 'user', recommendation: dto.recommendation,
      });
    }
    return this.approvals.create(id, { kind: dto.kind, payload: dto.payload, requestedBy: 'user', recommendation: dto.recommendation });
  }
  @Post(':id/approvals/:approvalId/decide') async decide(@Param('id') id: string, @Param('approvalId') approvalId: string, @Body() dto: DecideDto) {
    this.guard();
    const a = await this.approvals.get(id, approvalId);
    // A human_review card (item 24) is its addressee's to decide (or the CEO's).
    const addressee = a.kind === 'human_review' ? (JSON.parse(a.payload || '{}') as { reviewerHumanId?: string }).reviewerHumanId : undefined;
    // A delegate (docs/owners-seat.md §2) decides the cards delegated to them, nothing else.
    const via = addressee && addressee === actorId() ? null : await this.approvals.delegateVia(id, a, actorId());
    if (via && actorId() !== currentAccountId()) return this.approvals.decide(id, approvalId, dto.decision, dto.note ?? '', this.actor(), actorId(), { via });
    if (!(addressee && addressee === actorId())) await this.assertMayDecide(id, a.kind);
    return this.approvals.decide(id, approvalId, dto.decision, dto.note ?? '', this.actor(), actorId());
  }

  // ---- humans (phase D): the CEO is the owner; board and observers are members of the shared workspace ----
  @Get(':id/humans') async humans(@Param('id') id: string) {
    this.guard();
    return { ceoAccountId: currentAccountId(), me: { actorId: actorId(), role: await this.org.humanRole(id, actorId()) }, humans: await this.org.humans(id) };
  }
  @Post(':id/humans') setHuman(@Param('id') id: string, @Body() dto: HumanDto) { this.guard(); return this.org.setHuman(id, dto, this.actor()); }
  /** Hybrid staff (item 24): the task cards of the calling human (or of one member, for the CEO). */
  @Get(':id/humans/me/tasks') myTasks(@Param('id') id: string) { this.guard(); return this.tasks.tasksOfHuman(id, actorId()); }
  @Get(':id/humans/:memberAccountId/tasks') humanTasks(@Param('id') id: string, @Param('memberAccountId') memberAccountId: string) { this.guard(); return this.tasks.tasksOfHuman(id, memberAccountId); }
  @Delete(':id/humans/:memberAccountId') removeHuman(@Param('id') id: string, @Param('memberAccountId') memberAccountId: string) { this.guard(); return this.org.removeHuman(id, memberAccountId, this.actor()); }

  // ---- audit ----
  @Get(':id/audit') auditList(@Param('id') id: string, @Query('limit') limit?: string, @Query('action') action?: string, @Query('refId') refId?: string) {
    this.guard(); return this.audit.list(id, { limit: Number(limit) || 100, action: action || undefined, refId: refId || undefined });
  }
  @Get(':id/audit/verify') verify(@Param('id') id: string) { this.guard(); return this.audit.verify(id); }

  // ---- brief ----
  @Get(':id/brief') latestBrief(@Param('id') id: string) { this.guard(); return this.brief.latest(id); }
  @Post(':id/brief') composeBrief(@Param('id') id: string) { this.guard(); return this.brief.compose(id, { deliver: true, by: 'user' }); }
  @Post(':id/brief/reply') async replyBrief(@Param('id') id: string, @Body() dto: TextDto) {
    this.guard();
    const role = await this.org.humanRole(id, actorId());
    if (role !== 'ceo' && role !== 'board') throw new ForbiddenException('only the CEO or a board member answers the brief');
    // A board member may only answer the items of their kinds; a reply that
    // touches a CEO-only item is refused whole rather than half-applied.
    if (role === 'board') {
      const brief = await this.brief.latest(id);
      const { decisions } = parseBriefReply(dto.text, brief?.items.length ?? 0);
      const ceoOnly = decisions.map((d) => brief?.items.find((i) => i.n === d.n)).filter((i) => i && !mayDecide(role, i.kind));
      if (ceoOnly.length > 0) throw new ForbiddenException(`item(s) ${ceoOnly.map((i) => i!.n).join(', ')} are the CEO's to decide`);
    }
    return this.brief.reply(id, dto.text, this.actor(), actorId());
  }

  // ---- spend ----
  @Get(':id/spend') spend(@Param('id') id: string) { this.guard(); return this.runtime.spendTree(id); }
  @Put(':id/budgets') setBudget(@Param('id') id: string, @Body() dto: BudgetDto) { this.guard(); return this.org.setBudget(id, { scope: dto.scope, refId: dto.refId ?? id, monthlyUsd: dto.monthlyUsd }); }

  /** Autonomous mode: run the chief's structure review now (docs/group-chat.md §5). */
  async reviewStructureNow(id: string) {
    this.guard();
    return this.runtime.runChiefReview(id, ['manual review requested by the CEO'], 'manual');
  }

  // ---- assurance (docs/company-vision.md §5) ----
  private signalsOr(): OrgSignalsService { if (!this.signals) throw new NotFoundException('signals are not available'); return this.signals; }
  private sloOr(): OrgSloService { if (!this.slo) throw new NotFoundException('SLOs are not available'); return this.slo; }
  private auditorOr(): OrgAuditorService { if (!this.auditor) throw new NotFoundException('the auditor is not available'); return this.auditor; }
  @Get(':id/signals') signalsList(@Param('id') id: string, @Query('status') status?: string, @Query('severity') severity?: string, @Query('unitId') unitId?: string, @Query('kind') kind?: string) {
    this.guard(); return this.signalsOr().list(id, { status: status || undefined, severity: severity || undefined, unitId: unitId || undefined, kind: kind || undefined });
  }
  @Post(':id/signals/:signalId/ack') ackSignal(@Param('id') id: string, @Param('signalId') signalId: string, @Body() dto: AckDto) { this.guard(); return this.signalsOr().ack(id, signalId, dto?.note ?? '', this.actor()); }
  @Post(':id/signals/:signalId/resolve') resolveSignal(@Param('id') id: string, @Param('signalId') signalId: string) { this.guard(); return this.signalsOr().resolve(id, signalId, this.actor()); }
  @Get(':id/pulse') pulse(@Param('id') id: string) { this.guard(); return this.sloOr().pulse(id); }
  @Get(':id/slo') async sloTargets(@Param('id') id: string) {
    this.guard();
    const org = await this.org.get(id);
    return { targets: await this.sloOr().targets(id), weights: await this.sloOr().weights(id), tunables: parseTunables(org.tunables), bounds: ASSURANCE_TUNABLES };
  }
  @Patch(':id/slo') async setSlo(@Param('id') id: string, @Body() dto: SloDto) {
    this.guard();
    const { tunables, ...targets } = dto;
    return this.sloOr().setTargets(id, { ...Object.fromEntries(Object.entries(targets).filter(([, v]) => v !== undefined)), ...(tunables ?? {}) }, this.actor());
  }
  @Get(':id/audits') audits(@Param('id') id: string, @Query('limit') limit?: string) { this.guard(); return this.auditorOr().list(id, Number(limit) || 50); }
  /** Run the auditor now (the CEO's manual trigger). */
  @Post(':id/audit/run') async runAudit(@Param('id') id: string) { this.guard(); return { result: await this.auditorOr().runAudit(id, 'manual') }; }

  // ---- the group log ----
  @Get(':id/messages') messages(@Param('id') id: string) { this.guard(); return this.tasks.messages(id); }
  @Post(':id/messages') post(@Param('id') id: string, @Body() dto: TextDto) { this.guard(); return this.tasks.post(id, { text: dto.text, fromAgentId: null }); }
}
