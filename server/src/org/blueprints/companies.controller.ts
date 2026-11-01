/**
 * Companies in the market registry (docs/registry.md §8, docs/blueprints.md
 * §3; execution-plan item 24). A blueprint is a registry item of kind
 * `company`, published and review-gated like an agent or a skill, installed
 * into a workspace as a dry-run plan first and the import on confirm:
 *
 *  GET  /api/market/companies?q=                        published blueprints (local + remote) with their outcome counts
 *  POST /api/market/companies                           { workspaceId, name?, description?, publisherName?, dryRun? } publish this workspace's company
 *  POST /api/market/companies/:id/install               { workspaceId, mode, monthlyUsd?, confirm? } — without confirm: { requiresConfirm, review, plan }
 */
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { RegistryService } from '../../registry/registry.service';
import { OrgModeService } from '../org-mode.service';
import { OrgBlueprintsService, type ImportMode } from '../org-blueprints.service';

export class PublishCompanyDto {
  @IsString() workspaceId!: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() publisherName?: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

export class InstallCompanyDto {
  @IsString() workspaceId!: string;
  @IsIn(['supervised', 'autonomous']) mode!: ImportMode;
  @IsOptional() @IsNumber() @Min(0) monthlyUsd?: number;
  @IsOptional() confirm?: unknown;
}

@Controller('market/companies')
export class CompaniesController {
  constructor(
    private readonly registry: RegistryService,
    private readonly blueprints: OrgBlueprintsService,
    private readonly mode: OrgModeService,
    private readonly config: ConfigService,
  ) {}

  private guard(): void { if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)'); }

  @Get() async list(@Query('q') q?: string) {
    this.guard();
    const { items, remote } = await this.registry.list({ kind: 'company', q });
    const outcomes = await this.registry.outcomesOf(items.map((i) => i.id));
    return { items: items.map((i) => ({ ...i, outcomes: outcomes.get(i.id) ?? { first_key_result: 0, thirty_days_in_envelope: 0 } })), remote };
  }

  /** Export the workspace's company and publish it (the scan and the review gate are the registry's). */
  @Post() async publish(@Body() dto: PublishCompanyDto) {
    this.guard();
    const orgId = await this.mode.orgIdOf(dto.workspaceId);
    const manifest = await this.blueprints.export(orgId);
    return this.registry.publish({ kind: 'company', manifest: manifest as unknown as Record<string, unknown>, name: dto.name, description: dto.description, publisherName: dto.publisherName, dryRun: dto.dryRun });
  }

  /** Two-step like every registry install: the review and the import plan
   *  first; with `confirm: true` the blueprint is re-validated and re-scanned,
   *  the company is created and the install row written. */
  @Post(':id/install') async install(@Param('id') id: string, @Body() dto: InstallCompanyDto) {
    this.guard();
    const { review, manifest } = await this.registry.review(id);
    if (review.kind !== 'company') throw new BadRequestException(`registry item ${id} is a ${review.kind}, not a company`);
    const plan = await this.blueprints.importPlan(dto.workspaceId, manifest, { mode: dto.mode, monthlyUsd: dto.monthlyUsd });
    if (dto.confirm !== true) return { requiresConfirm: true as const, review, plan };
    if (!review.scanReport.ok) throw new BadRequestException(`install refused: ${review.scanReport.flags.filter((f) => f.severity === 'block').map((f) => f.detail).join('; ')}`);
    const result = await this.blueprints.import(dto.workspaceId, manifest, { mode: dto.mode, monthlyUsd: dto.monthlyUsd, itemId: id });
    const install = await this.registry.recordExternalInstall(id, { orgId: result.orgId });
    return { ok: true as const, install, ...result };
  }
}
