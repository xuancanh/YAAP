/**
 * IncidentsController — incidents, health and audit independence on the
 * workspace surface (docs/incidents.md, execution-plan item 29):
 *
 *  GET  /api/workspaces/:id/org/incidents?status=          open | contained | resolved
 *  POST /api/workspaces/:id/org/incidents                  { title, detail, agentId?, severity, actionClass? } — the owner's report
 *  GET  /api/workspaces/:id/org/incidents/:incidentId
 *  POST /api/workspaces/:id/org/incidents/:incidentId/contain  { action: pause_member | freeze_class | supervised | pause_org, agentId?, actionClass? }
 *  POST /api/workspaces/:id/org/incidents/:incidentId/resolve  { resolution, undo? }
 *  GET  /api/workspaces/:id/org/health                     what is degraded, frozen, paused by an incident
 *  POST /api/workspaces/:id/org/audits/:auditId/spotcheck/:itemId  { agree, note? }
 *  POST /api/workspaces/:id/org/redteam/run                { agentId? }
 *
 * Containing, resolving and answering spot checks are the CEO's (or a board
 * member's); anyone with standing in the organisation may report.
 */
import { Body, Controller, ForbiddenException, Get, NotFoundException, Optional, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { actorId, currentAccountId, currentViewer } from '../accounts/account-context';
import { OrgModeService } from './org-mode.service';
import { OrgService } from './org.service';
import { OrgIncidentsService, INCIDENT_SEVERITIES, MANUAL_CONTAINMENTS, type IncidentSeverity, type ManualContainment } from './org-incidents.service';
import { OrgRedTeamService } from './org-redteam.service';

export class IncidentReportDto {
  @IsString() title!: string;
  @IsString() detail!: string;
  @IsIn(INCIDENT_SEVERITIES as unknown as string[]) severity!: IncidentSeverity;
  @IsOptional() @IsString() agentId?: string;
  @IsOptional() @IsString() actionClass?: string;
}
export class ContainDto {
  @IsIn(MANUAL_CONTAINMENTS as unknown as string[]) action!: ManualContainment;
  @IsOptional() @IsString() agentId?: string;
  @IsOptional() @IsString() actionClass?: string;
}
export class ResolveDto {
  @IsString() resolution!: string;
  @IsOptional() @IsBoolean() undo?: boolean;
}
export class SpotCheckDto {
  @IsBoolean() agree!: boolean;
  @IsOptional() @IsString() note?: string;
}
export class RedTeamDto { @IsOptional() @IsString() agentId?: string }

@Controller('workspaces/:id/org')
export class IncidentsController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly org: OrgService,
    private readonly incidents: OrgIncidentsService,
    private readonly config: ConfigService,
    @Optional() private readonly redteam?: OrgRedTeamService,
  ) {}

  private async oid(workspaceId: string): Promise<string> {
    if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)');
    return this.mode.orgIdOf(workspaceId);
  }

  private actor(): string {
    const v = currentViewer();
    return v && v.memberAccountId !== currentAccountId() ? `human:${v.memberAccountId}` : 'user';
  }

  private async standing(orgId: string): Promise<void> {
    if (!(await this.org.humanRole(orgId, actorId()))) throw new ForbiddenException('you have no standing in this organisation');
  }

  @Get('incidents') async list(@Param('id') id: string, @Query('status') status?: string) {
    const orgId = await this.oid(id);
    return (await this.incidents.list(orgId, { status: status || undefined })).map((r) => this.incidents.view(r));
  }

  @Post('incidents') async report(@Param('id') id: string, @Body() dto: IncidentReportDto) {
    const orgId = await this.oid(id);
    await this.standing(orgId);
    return this.incidents.view(await this.incidents.report(orgId, { title: dto.title, detail: dto.detail, severity: dto.severity, agentId: dto.agentId ?? null, actionClass: dto.actionClass ?? null }, { detectedBy: 'owner', reporter: this.actor() === 'user' ? undefined : this.actor() }));
  }

  @Get('incidents/:incidentId') async get(@Param('id') id: string, @Param('incidentId') incidentId: string) {
    return this.incidents.view(await this.incidents.get(await this.oid(id), incidentId));
  }

  @Post('incidents/:incidentId/contain') async contain(@Param('id') id: string, @Param('incidentId') incidentId: string, @Body() dto: ContainDto) {
    const orgId = await this.oid(id);
    await this.incidents.assertDecider(orgId, actorId());
    return this.incidents.view(await this.incidents.contain(orgId, incidentId, dto.action, this.actor(), { agentId: dto.agentId, actionClass: dto.actionClass }));
  }

  @Post('incidents/:incidentId/resolve') async resolve(@Param('id') id: string, @Param('incidentId') incidentId: string, @Body() dto: ResolveDto) {
    const orgId = await this.oid(id);
    await this.incidents.assertDecider(orgId, actorId());
    return this.incidents.view(await this.incidents.resolve(orgId, incidentId, { resolution: dto.resolution, undo: dto.undo }, this.actor()));
  }

  @Get('health') async health(@Param('id') id: string) {
    return this.incidents.healthReport(await this.oid(id));
  }

  @Post('audits/:auditId/spotcheck/:itemId') async spotcheck(@Param('id') id: string, @Param('auditId') auditId: string, @Param('itemId') itemId: string, @Body() dto: SpotCheckDto) {
    const orgId = await this.oid(id);
    await this.incidents.assertDecider(orgId, actorId());
    return this.incidents.answerSpotCheck(orgId, auditId, itemId, { agree: dto.agree, note: dto.note }, this.actor());
  }

  @Post('redteam/run') async redteamRun(@Param('id') id: string, @Body() dto: RedTeamDto) {
    const orgId = await this.oid(id);
    await this.incidents.assertDecider(orgId, actorId());
    if (!this.redteam) throw new NotFoundException('red-team runs are not available');
    const r = await this.redteam.run(orgId, { agentId: dto?.agentId, trigger: 'manual' });
    return { result: r.result, auditId: r.auditId, agentId: r.agentId, breach: r.breach, recorded: r.calls.map((c) => c.name) };
  }
}
