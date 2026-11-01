/**
 * ExperimentsController — experiments, the prediction ledger and
 * reconciliation on the workspace surface (docs/experiments.md §6,
 * execution-plan item 30):
 *
 *  GET  /api/workspaces/:id/org/experiments?status=
 *  POST /api/workspaces/:id/org/experiments                 { title, hypothesis, changeKind, change, metric | keyResult, direction, expectedEffect, effectKind?, windowDays?, design?, slice?, revertRule?, unitId? } — the CEO's proposal (status proposed)
 *  GET  /api/workspaces/:id/org/experiments/:expId
 *  POST /api/workspaces/:id/org/experiments/:expId/start    snapshot the baseline and apply the change (the CEO)
 *  POST /api/workspaces/:id/org/experiments/:expId/stop     abandon (a running one is reverted first) (the CEO)
 *  POST /api/workspaces/:id/org/experiments/:expId/keep     decide now: keep (the CEO)
 *  POST /api/workspaces/:id/org/experiments/:expId/revert   decide now: revert (the CEO)
 *  GET  /api/workspaces/:id/org/predictions?agentId=&status=
 *  GET  /api/workspaces/:id/org/calibration                 { bar, members: per member resolved, open, Brier, calibration, bias }
 *  GET  /api/workspaces/:id/org/reconciliation              the latest sweep's gaps
 *  POST /api/workspaces/:id/org/reconciliation/run          sweep now (the CEO)
 *
 * Reads need standing in the organization's workspace like every org route;
 * every write is the CEO's. Agents use the tools (org_propose_experiment,
 * org_experiments, org_forecast_outcome, org_calibration), never these routes.
 */
import { Body, Controller, Get, NotFoundException, Optional, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { actorId, currentAccountId, currentViewer } from '../accounts/account-context';
import { OrgModeService } from './org-mode.service';
import { OrgExperimentsService, CHANGE_KINDS } from './org-experiments.service';
import { OrgPredictionsService } from './org-predictions.service';
import { OrgReconciliationService } from './org-reconciliation.service';

export class ExperimentDto {
  @IsString() title!: string;
  @IsString() hypothesis!: string;
  @IsIn(CHANGE_KINDS as unknown as string[]) changeKind!: string;
  @IsObject() change!: Record<string, unknown>;
  @IsOptional() @IsString() metric?: string;
  @IsOptional() @IsString() keyResult?: string;
  @IsIn(['up', 'down']) direction!: string;
  @IsNumber() expectedEffect!: number;
  @IsOptional() @IsIn(['relative', 'absolute']) effectKind?: string;
  @IsOptional() @IsNumber() windowDays?: number;
  @IsOptional() @IsIn(['before_after', 'slice']) design?: string;
  @IsOptional() @IsObject() slice?: Record<string, unknown>;
  @IsOptional() @IsObject() revertRule?: { worseBy?: number; relative?: boolean };
  @IsOptional() @IsString() unitId?: string;
}
export class ExperimentNoteDto { @IsOptional() @IsString() note?: string }

@Controller('workspaces/:id/org')
export class ExperimentsController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly experiments: OrgExperimentsService,
    private readonly predictions: OrgPredictionsService,
    private readonly config: ConfigService,
    @Optional() private readonly reconciliation?: OrgReconciliationService,
  ) {}

  private async oid(workspaceId: string): Promise<string> {
    if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)');
    return this.mode.orgIdOf(workspaceId);
  }

  private actor(): string {
    const v = currentViewer();
    return v && v.memberAccountId !== currentAccountId() ? `human:${v.memberAccountId}` : 'user';
  }

  private async ceo(workspaceId: string): Promise<string> {
    const orgId = await this.oid(workspaceId);
    await this.experiments.assertCeo(orgId, actorId());
    return orgId;
  }

  @Get('experiments') async list(@Param('id') id: string, @Query('status') status?: string) {
    return (await this.experiments.list(await this.oid(id), { status: status || undefined })).map((r) => this.experiments.view(r));
  }

  @Post('experiments') async create(@Param('id') id: string, @Body() dto: ExperimentDto) {
    const orgId = await this.ceo(id);
    return this.experiments.view(await this.experiments.propose(orgId, dto, this.actor()));
  }

  @Get('experiments/:expId') async get(@Param('id') id: string, @Param('expId') expId: string) {
    const orgId = await this.oid(id);
    const row = await this.experiments.get(orgId, expId);
    return { ...this.experiments.view(row), predictions: (await this.predictions.list(orgId, { subjectKind: 'experiment', subjectId: row.id })).map((p) => this.predictions.view(p)) };
  }

  @Post('experiments/:expId/start') async start(@Param('id') id: string, @Param('expId') expId: string) {
    const orgId = await this.ceo(id);
    return this.experiments.view(await this.experiments.start(orgId, expId, this.actor()));
  }

  @Post('experiments/:expId/stop') async stop(@Param('id') id: string, @Param('expId') expId: string, @Body() dto: ExperimentNoteDto) {
    const orgId = await this.ceo(id);
    return this.experiments.view(await this.experiments.stop(orgId, expId, this.actor(), dto?.note ?? ''));
  }

  @Post('experiments/:expId/keep') async keep(@Param('id') id: string, @Param('expId') expId: string) {
    const orgId = await this.ceo(id);
    return this.experiments.view(await this.experiments.conclude(orgId, expId, { force: 'keep', actor: this.actor() }));
  }

  @Post('experiments/:expId/revert') async revert(@Param('id') id: string, @Param('expId') expId: string) {
    const orgId = await this.ceo(id);
    return this.experiments.view(await this.experiments.conclude(orgId, expId, { force: 'revert', actor: this.actor() }));
  }

  @Get('predictions') async listPredictions(@Param('id') id: string, @Query('agentId') agentId?: string, @Query('status') status?: string) {
    return (await this.predictions.list(await this.oid(id), { agentId: agentId || undefined, status: status || undefined })).map((p) => this.predictions.view(p));
  }

  /** `{ bar, members }`: `bar` is the trust ledger's promotion line (`trust.calibrationBar`). */
  @Get('calibration') async calibration(@Param('id') id: string) {
    const orgId = await this.oid(id);
    return { bar: await this.predictions.calibrationBar(orgId), members: await this.predictions.report(orgId) };
  }

  @Get('reconciliation') async reconciliationLatest(@Param('id') id: string) {
    if (!this.reconciliation) throw new NotFoundException('reconciliation is not available');
    return this.reconciliation.latest(await this.oid(id));
  }

  @Post('reconciliation/run') async reconciliationRun(@Param('id') id: string) {
    if (!this.reconciliation) throw new NotFoundException('reconciliation is not available');
    return this.reconciliation.sweep(await this.ceo(id));
  }
}
