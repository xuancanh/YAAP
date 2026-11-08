/**
 * ClaimsController — evidence-gated claims on the workspace surface
 * (docs/evidence.md §7):
 *
 *  GET  /api/workspaces/:id/org/claims?refType=&refIds=a,b&agentId=&status=&days=   claims with their evidence
 *  GET  /api/workspaces/:id/org/claims/summary?days=30                              per-member tallies and the latest flagged
 *  POST /api/workspaces/:id/org/claims/:claimId/confirm  { note? }                  a person confirms a flagged claim
 *
 * Reads need standing in the organisation; confirming is the CEO's or a
 * board member's.
 */
import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { actorId, currentAccountId, currentViewer } from '../accounts/account-context';
import { OrgModeService } from './org-mode.service';
import { OrgService } from './org.service';
import { OrgClaimsService, type OrgClaim } from './org-claims.service';

export function claimView(c: OrgClaim) {
  const parse = (raw: string) => { try { return JSON.parse(raw || '[]') as unknown; } catch { return []; } };
  return { ...c, refs: parse(c.refs), counts: parse(c.counts), context: (() => { try { return JSON.parse(c.context || '{}') as unknown; } catch { return {}; } })() };
}

@Controller('workspaces/:id/org/claims')
export class ClaimsController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly org: OrgService,
    private readonly claims: OrgClaimsService,
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

  @Get()
  async list(@Param('id') id: string, @Query('refType') refType?: string, @Query('refIds') refIds?: string, @Query('agentId') agentId?: string, @Query('status') status?: string, @Query('days') days?: string, @Query('limit') limit?: string) {
    const orgId = await this.oid(id);
    await this.standing(orgId);
    const rows = await this.claims.list(orgId, {
      refType: refType || undefined, refIds: refIds ? refIds.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
      agentId: agentId || undefined, status: status || undefined, days: days ? Number(days) || undefined : undefined, limit: limit ? Number(limit) || undefined : undefined,
    });
    return rows.map(claimView);
  }

  @Get('summary')
  async summary(@Param('id') id: string, @Query('days') days?: string) {
    const orgId = await this.oid(id);
    await this.standing(orgId);
    const s = await this.claims.summary(orgId, Math.min(365, Math.max(1, Number(days) || 30)));
    return { ...s, recent: s.recent.map(claimView) };
  }

  @Post(':claimId/confirm')
  async confirm(@Param('id') id: string, @Param('claimId') claimId: string, @Body() body: { note?: string }) {
    const orgId = await this.oid(id);
    const role = await this.org.humanRole(orgId, actorId());
    if (role !== 'ceo' && role !== 'board') throw new ForbiddenException('only the CEO or a board member confirms a flagged claim');
    return claimView(await this.claims.confirm(orgId, claimId, this.actor(), String(body?.note ?? '')));
  }
}
