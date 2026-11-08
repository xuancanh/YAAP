/**
 * QualityController — quality control of results and policies on the
 * workspace surface (docs/quality.md):
 *
 *  GET  /api/workspaces/:id/org/quality                    standards, policies, figures, templates
 *  GET  /api/workspaces/:id/org/quality/results?taskId=     QC results (newest first)
 *  GET  /api/workspaces/:id/org/quality/tasks/:taskRef      what a task is held to and its QC results
 *  GET  /api/workspaces/:id/org/quality/violations?policyId=&status=
 *  POST /api/workspaces/:id/org/quality/standards           create (fields or { template })
 *  POST /api/workspaces/:id/org/quality/standards/:ref      revise, or { action: "retire" }
 *  POST /api/workspaces/:id/org/quality/policies            create
 *  POST /api/workspaces/:id/org/quality/policies/:ref       revise, or { action: "retire" }
 *  POST /api/workspaces/:id/org/quality/spot-check          run today's post-acceptance sample now
 *
 * Reads need standing in the organisation; writes are the CEO's or a board
 * member's (a person is not bound by the boundary; agents author through
 * their tools).
 */
import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { actorId, currentAccountId, currentViewer } from '../accounts/account-context';
import { OrgModeService } from './org-mode.service';
import { OrgService } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgQualityService } from './org-quality.service';
import { QUALITY_TEMPLATES, parseCriteria, parseRule } from './quality-model';

@Controller('workspaces/:id/org/quality')
export class QualityController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly quality: OrgQualityService,
    private readonly config: ConfigService,
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

  private async decider(orgId: string): Promise<void> {
    const role = await this.org.humanRole(orgId, actorId());
    if (role !== 'ceo' && role !== 'board') throw new ForbiddenException('only the CEO or a board member sets quality standards and policies');
  }

  private standardView(s: Awaited<ReturnType<OrgQualityService['listStandards']>>[number]) {
    return { ...s, criteria: parseCriteria(s.criteria), pending: s.pending ? JSON.parse(s.pending) as unknown : null };
  }

  private policyView(p: Awaited<ReturnType<OrgQualityService['listPolicies']>>[number]) {
    return { ...p, rule: parseRule(p.rule), pending: p.pending ? JSON.parse(p.pending) as unknown : null };
  }

  private resultView(r: Awaited<ReturnType<OrgQualityService['results']>>[number]) {
    const j = (s: string) => { try { return JSON.parse(s) as unknown; } catch { return []; } };
    return { ...r, rubric: j(r.rubric), scores: j(r.scores), evidence: j(r.evidence), checks: j(r.checks) };
  }

  @Get() async overview(@Param('id') id: string, @Query('days') days?: string) {
    const orgId = await this.oid(id);
    await this.standing(orgId);
    const [standards, policies, metrics, results, violations, tasks] = await Promise.all([
      this.quality.listStandards(orgId), this.quality.listPolicies(orgId), this.quality.metrics(orgId, { days: Number(days) || 30 }),
      this.quality.results(orgId, { limit: 40 }), this.quality.violations(orgId, { limit: 100 }), this.tasks.list(orgId),
    ]);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const recent = results.filter((r) => r.outcome !== 'pending').slice(0, 20).map((r) => ({ ...this.resultView(r), taskKey: byId.get(r.taskId)?.key ?? null, taskTitle: byId.get(r.taskId)?.title ?? '' }));
    return { standards: standards.map((s) => this.standardView(s)), policies: policies.map((p) => this.policyView(p)), metrics, templates: QUALITY_TEMPLATES, recent, violations };
  }

  @Get('results') async results(@Param('id') id: string, @Query('taskId') taskId?: string, @Query('limit') limit?: string) {
    const orgId = await this.oid(id);
    await this.standing(orgId);
    return (await this.quality.results(orgId, { taskId: taskId || undefined, limit: Number(limit) || 100 })).map((r) => this.resultView(r));
  }

  @Get('tasks/:taskRef') async task(@Param('id') id: string, @Param('taskRef') taskRef: string) {
    const orgId = await this.oid(id);
    await this.standing(orgId);
    const t = await this.tasks.byPrefix(orgId, taskRef);
    const standard = await this.quality.resolveStandard(orgId, t);
    return { taskId: t.id, standard: standard ? this.standardView(standard) : null, results: (await this.quality.results(orgId, { taskId: t.id })).map((r) => this.resultView(r)) };
  }

  @Get('violations') async violations(@Param('id') id: string, @Query('policyId') policyId?: string, @Query('status') status?: string) {
    const orgId = await this.oid(id);
    await this.standing(orgId);
    return this.quality.violations(orgId, { policyId: policyId || undefined, status: status || undefined, limit: 200 });
  }

  @Post('standards') async createStandard(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const orgId = await this.oid(id);
    await this.decider(orgId);
    const r = await this.quality.createStandard(orgId, body ?? {}, this.actor(), String(body?.why ?? ''));
    return { ...r, standard: this.standardView(r.standard) };
  }

  @Post('standards/:ref') async reviseStandard(@Param('id') id: string, @Param('ref') ref: string, @Body() body: Record<string, unknown>) {
    const orgId = await this.oid(id);
    await this.decider(orgId);
    const r = await this.quality.reviseStandard(orgId, ref, body ?? {}, this.actor(), String(body?.why ?? ''));
    return { ...r, standard: this.standardView(r.standard) };
  }

  @Post('policies') async createPolicy(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const orgId = await this.oid(id);
    await this.decider(orgId);
    const r = await this.quality.createPolicy(orgId, body ?? {}, this.actor(), String(body?.why ?? ''));
    return { ...r, policy: this.policyView(r.policy) };
  }

  @Post('policies/:ref') async revisePolicy(@Param('id') id: string, @Param('ref') ref: string, @Body() body: Record<string, unknown>) {
    const orgId = await this.oid(id);
    await this.decider(orgId);
    const r = await this.quality.revisePolicy(orgId, ref, body ?? {}, this.actor(), String(body?.why ?? ''));
    return { ...r, policy: this.policyView(r.policy) };
  }

  @Post('spot-check') async spotCheck(@Param('id') id: string) {
    const orgId = await this.oid(id);
    await this.decider(orgId);
    return this.quality.spotCheck(orgId);
  }
}
