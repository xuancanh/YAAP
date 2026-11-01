/**
 * Sensing routes (docs/sensing.md, execution-plan item 27).
 *
 *  /api/orgs/:id/… and the workspace alias /api/workspaces/:id/org/…:
 *    GET    metrics/sources                         every source (no secret values, no token)
 *    POST   metrics/sources                         create a live source (the CEO); a webhook source returns its token once
 *    PATCH  metrics/sources/:sourceId               name, unit, config, secrets, pollMinutes (the CEO)
 *    DELETE metrics/sources/:sourceId               delete it and its samples; bound key results become self-reported (the CEO)
 *    POST   metrics/sources/:sourceId/poll          fetch a polled source now (the CEO)
 *    POST   metrics/sources/:sourceId/token         rotate a webhook token, shown once (the CEO)
 *    GET    metrics/sources/:sourceId/samples?since=
 *    POST   metrics/sources/:sourceId/attest        { value, note, observedAt? } — a manual_attested source; CEO, board or employee
 *    POST   goals/:goalId/source                    { sourceId | null } — bind or unbind a key result (the CEO)
 *    GET    tasks/:taskId/checks                    the latest check results
 *    POST   tasks/:taskId/checks/run                run them now (reads only)
 *
 *  Public: POST /api/metrics/:sourceId/ingest { value, observedAt? } with
 *  the source's token (`?token=` or a bearer header), listed in
 *  isPublicRoute next to the loop webhooks; timing-safe, 30/min, 64 KB.
 *
 * Agents have no route here: their tools are org_metric_sources,
 * org_metric_read, org_propose_metric_source, org_task_checks and
 * org_run_checks (OrgSensingService), and none writes a sample.
 */
import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, NotFoundException, Optional, Param, Patch, PayloadTooLargeException, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { actorId, currentAccountId, currentViewer, runWithAccount } from '../accounts/account-context';
import { OrgService } from './org.service';
import { OrgModeService } from './org-mode.service';
import { OrgIntentService } from './org-intent.service';
import { OrgSensingService, SOURCE_KINDS } from './org-sensing.service';

export const INGEST_BODY_CAP = 64 * 1024;

export class MetricSourceDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(SOURCE_KINDS as unknown as string[]) kind?: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsNumber() pollMinutes?: number;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  /** Header secrets by name (sealed; never returned). null removes one. */
  @IsOptional() @IsObject() secrets?: Record<string, string | null>;
}
export class AttestDto {
  @IsNumber() value!: number;
  @IsString() note!: string;
  @IsOptional() @IsString() observedAt?: string;
}
export class BindSourceDto { @IsOptional() sourceId?: string | null }

/** The org-scoped half; the workspace alias delegates here. */
@Controller('orgs')
export class OrgSensingController {
  constructor(
    private readonly org: OrgService,
    private readonly sensing: OrgSensingService,
    private readonly config: ConfigService,
    @Optional() private readonly intent?: OrgIntentService,
  ) {}

  private guard(): void { if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)'); }

  private actor(): string {
    const v = currentViewer();
    return v && v.memberAccountId !== currentAccountId() ? `human:${v.memberAccountId}` : 'user';
  }

  /** A metric source defines what counts as truth: writing one is the CEO's. */
  private async assertCeo(orgId: string, what: string): Promise<void> {
    if ((await this.org.humanRole(orgId, actorId())) !== 'ceo') throw new ForbiddenException(`${what} is the CEO's`);
  }

  @Get(':id/metrics/sources') sources(@Param('id') id: string) { this.guard(); return this.sensing.list(id); }
  @Post(':id/metrics/sources') async create(@Param('id') id: string, @Body() dto: MetricSourceDto) {
    this.guard(); await this.assertCeo(id, 'a metric source');
    return this.sensing.create(id, dto, this.actor());
  }
  @Patch(':id/metrics/sources/:sourceId') async update(@Param('id') id: string, @Param('sourceId') sourceId: string, @Body() dto: MetricSourceDto) {
    this.guard(); await this.assertCeo(id, 'a metric source');
    return this.sensing.update(id, sourceId, dto, this.actor());
  }
  @Delete(':id/metrics/sources/:sourceId') async remove(@Param('id') id: string, @Param('sourceId') sourceId: string) {
    this.guard(); await this.assertCeo(id, 'a metric source');
    return this.sensing.remove(id, sourceId, this.actor());
  }
  @Post(':id/metrics/sources/:sourceId/poll') async poll(@Param('id') id: string, @Param('sourceId') sourceId: string) {
    this.guard(); await this.assertCeo(id, 'polling a metric source');
    return this.sensing.poll(id, sourceId, this.actor());
  }
  @Post(':id/metrics/sources/:sourceId/token') async rotate(@Param('id') id: string, @Param('sourceId') sourceId: string) {
    this.guard(); await this.assertCeo(id, 'a webhook token');
    return this.sensing.rotateToken(id, sourceId, this.actor());
  }
  @Get(':id/metrics/sources/:sourceId/samples') samples(@Param('id') id: string, @Param('sourceId') sourceId: string, @Query('since') since?: string) {
    this.guard(); return this.sensing.samples(id, sourceId, { since: since || undefined });
  }
  /** Humans with standing attest: the CEO, a board member, an employee — never an observer, never an agent. */
  @Post(':id/metrics/sources/:sourceId/attest') async attest(@Param('id') id: string, @Param('sourceId') sourceId: string, @Body() dto: AttestDto) {
    this.guard();
    const role = await this.org.humanRole(id, actorId());
    if (role !== 'ceo' && role !== 'board' && role !== 'employee') throw new ForbiddenException(role === 'observer' ? 'observers read the company; they do not attest to its numbers' : 'you have no standing in this organisation');
    return this.sensing.attest(id, sourceId, dto, this.actor());
  }
  @Post(':id/goals/:goalId/source') async bind(@Param('id') id: string, @Param('goalId') goalId: string, @Body() dto: BindSourceDto) {
    this.guard(); await this.assertCeo(id, 'binding a key result to a metric source');
    if (!this.intent) throw new NotFoundException('intent is not available');
    return this.intent.bindSource(id, goalId, dto?.sourceId ?? null, this.actor());
  }
  @Get(':id/tasks/:taskId/checks') checks(@Param('id') id: string, @Param('taskId') taskId: string) { this.guard(); return this.sensing.taskChecks(id, taskId); }
  @Post(':id/tasks/:taskId/checks/run') async runChecks(@Param('id') id: string, @Param('taskId') taskId: string) {
    this.guard();
    if (!(await this.org.humanRole(id, actorId()))) throw new ForbiddenException('you have no standing in this organisation');
    return this.sensing.runChecks(id, taskId, this.actor());
  }
}

/** The workspace alias: resolves the workspace's one org and delegates. */
@Controller('workspaces/:id/org')
export class WorkspaceOrgSensingController {
  constructor(private readonly mode: OrgModeService, private readonly orgs: OrgSensingController, private readonly config: ConfigService) {}

  private oid(workspaceId: string): Promise<string> {
    if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)');
    return this.mode.orgIdOf(workspaceId);
  }

  @Get('metrics/sources') async sources(@Param('id') id: string) { return this.orgs.sources(await this.oid(id)); }
  @Post('metrics/sources') async create(@Param('id') id: string, @Body() dto: MetricSourceDto) { return this.orgs.create(await this.oid(id), dto); }
  @Patch('metrics/sources/:sourceId') async update(@Param('id') id: string, @Param('sourceId') sourceId: string, @Body() dto: MetricSourceDto) { return this.orgs.update(await this.oid(id), sourceId, dto); }
  @Delete('metrics/sources/:sourceId') async remove(@Param('id') id: string, @Param('sourceId') sourceId: string) { return this.orgs.remove(await this.oid(id), sourceId); }
  @Post('metrics/sources/:sourceId/poll') async poll(@Param('id') id: string, @Param('sourceId') sourceId: string) { return this.orgs.poll(await this.oid(id), sourceId); }
  @Post('metrics/sources/:sourceId/token') async rotate(@Param('id') id: string, @Param('sourceId') sourceId: string) { return this.orgs.rotate(await this.oid(id), sourceId); }
  @Get('metrics/sources/:sourceId/samples') async samples(@Param('id') id: string, @Param('sourceId') sourceId: string, @Query('since') since?: string) { return this.orgs.samples(await this.oid(id), sourceId, since); }
  @Post('metrics/sources/:sourceId/attest') async attest(@Param('id') id: string, @Param('sourceId') sourceId: string, @Body() dto: AttestDto) { return this.orgs.attest(await this.oid(id), sourceId, dto); }
  @Post('goals/:goalId/source') async bind(@Param('id') id: string, @Param('goalId') goalId: string, @Body() dto: BindSourceDto) { return this.orgs.bind(await this.oid(id), goalId, dto); }
  @Get('tasks/:taskId/checks') async checks(@Param('id') id: string, @Param('taskId') taskId: string) { return this.orgs.checks(await this.oid(id), taskId); }
  @Post('tasks/:taskId/checks/run') async runChecks(@Param('id') id: string, @Param('taskId') taskId: string) { return this.orgs.runChecks(await this.oid(id), taskId); }
}

/** POST /api/metrics/:sourceId/ingest — public; the source's token authenticates. */
@Controller('metrics')
export class MetricsIngestController {
  constructor(private readonly sensing: OrgSensingService) {}

  @Post(':sourceId/ingest')
  @HttpCode(202)
  async ingest(
    @Param('sourceId') sourceId: string,
    @Query('token') token: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > INGEST_BODY_CAP) throw new PayloadTooLargeException(`body must be ≤${INGEST_BODY_CAP} bytes`);
    if ((JSON.stringify(body ?? null) ?? '').length > INGEST_BODY_CAP) throw new PayloadTooLargeException(`body must be ≤${INGEST_BODY_CAP} bytes`);
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const run = () => this.sensing.ingest(sourceId, token || bearer, body ?? {});
    // No account is signed in here: the source's own account runs it.
    const accountId = await this.sensing.accountOfSource(sourceId);
    return accountId ? runWithAccount(accountId, run) : run();
  }
}
