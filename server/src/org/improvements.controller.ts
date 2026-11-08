/**
 * Improvement routes (docs/improvements.md), under the workspace's company:
 *
 *  GET    /api/workspaces/:id/org/improvements                  every proposal (newest first) and the work sources
 *  GET    /api/workspaces/:id/org/improvements/sources?days=14  where work comes from, against the caps
 *  GET    /api/workspaces/:id/org/improvements/:ref             one proposal: evidence, diff, history, verification
 *  POST   /api/workspaces/:id/org/improvements/:ref/accept      { note? } — accept and apply (decides its card)
 *  POST   /api/workspaces/:id/org/improvements/:ref/reject      { note? } — reject (decides its card)
 *  POST   /api/workspaces/:id/org/improvements/:ref/verify      check an applied change against its metric now
 *
 * Reads are everyone's in the company; decisions are the CEO's or a board
 * member's. Agents use the tools (org-improvements.tools.ts) and decide the
 * cards they hold with org_decide.
 */
import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';
import { actorId } from '../accounts/account-context';
import { OrgModeService } from './org-mode.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgImprovementsService } from './org-improvements.service';

export class ImprovementDecideDto {
  @IsOptional() @IsString() note?: string;
}

@Controller('workspaces/:id/org/improvements')
export class ImprovementsController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly orgs: OrgController,
    private readonly org: OrgService,
    private readonly approvals: OrgApprovalsService,
    private readonly improvements: OrgImprovementsService,
    private readonly config: ConfigService,
  ) {}

  private async oid(workspaceId: string): Promise<string> {
    if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)');
    return this.mode.orgIdOf(workspaceId);
  }

  /** Decisions are the CEO's or a board member's. */
  private async decider(orgId: string): Promise<string> {
    const role = await this.org.humanRole(orgId, actorId());
    if (role !== 'ceo' && role !== 'board') throw new ForbiddenException(role === 'observer' ? 'observers can read the company but not change it' : 'only the CEO or a board member decides an improvement');
    return this.orgs.actorName();
  }

  @Get() async list(@Param('id') id: string) {
    const orgId = await this.oid(id);
    return { improvements: (await this.improvements.list(orgId, { limit: 200 })).map((p) => this.improvements.view(p)), sources: await this.improvements.workSources(orgId, { days: 14 }) };
  }

  @Get('sources') async sources(@Param('id') id: string, @Query('days') days?: string) {
    return this.improvements.workSources(await this.oid(id), { days: Number(days) || 14 });
  }

  @Get(':ref') async one(@Param('id') id: string, @Param('ref') ref: string) {
    return this.improvements.view(await this.improvements.get(await this.oid(id), ref));
  }

  @Post(':ref/accept') async accept(@Param('id') id: string, @Param('ref') ref: string, @Body() dto: ImprovementDecideDto) {
    const orgId = await this.oid(id);
    const actor = await this.decider(orgId);
    const p = await this.improvements.get(orgId, ref);
    const card = p.approvalId ? await this.approvals.get(orgId, p.approvalId).catch(() => null) : null;
    // A pending card is decided through the approvals path (the applier accepts and applies; the decision log and the inbox follow).
    if (card && card.status === 'pending') await this.approvals.decide(orgId, card.id, 'approve', dto.note ?? '', actor, actorId());
    else await this.improvements.accept(orgId, p.id, actor, dto.note ? `accepted: ${dto.note}` : 'accepted by the CEO');
    return this.improvements.view(await this.improvements.get(orgId, p.id));
  }

  @Post(':ref/reject') async reject(@Param('id') id: string, @Param('ref') ref: string, @Body() dto: ImprovementDecideDto) {
    const orgId = await this.oid(id);
    const actor = await this.decider(orgId);
    const p = await this.improvements.get(orgId, ref);
    const card = p.approvalId ? await this.approvals.get(orgId, p.approvalId).catch(() => null) : null;
    if (card && card.status === 'pending') await this.approvals.decide(orgId, card.id, 'reject', dto.note ?? '', actor, actorId());
    else await this.improvements.reject(orgId, p.id, actor, dto.note ? `rejected: ${dto.note}` : 'rejected by the CEO');
    return this.improvements.view(await this.improvements.get(orgId, p.id));
  }

  @Post(':ref/verify') async verify(@Param('id') id: string, @Param('ref') ref: string) {
    const orgId = await this.oid(id);
    const actor = await this.decider(orgId);
    return this.improvements.view(await this.improvements.verify(orgId, ref, actor));
  }
}
