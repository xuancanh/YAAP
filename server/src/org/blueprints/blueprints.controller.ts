/**
 * Blueprints and the role catalog on the workspace (docs/company-vision.md
 * §9, §4; docs/blueprints.md; execution-plan item 24):
 *
 *  GET  /api/workspaces/:id/org/blueprint              export the company as COMPANY.json v1
 *  POST /api/workspaces/:id/org/blueprint/plan         { ...blueprint } or { blueprint, mode?, monthlyUsd? } → the dry-run plan
 *  POST /api/workspaces/:id/org/blueprint/import       { blueprint, mode, monthlyUsd? } → create the company from it
 *  GET  /api/workspaces/:id/org/roles?profile=         the role catalog ranked by the profile (the org's own when absent)
 *
 * Import and plan work on a workspace with no organization yet, so they do
 * not resolve the org id first; export and the default roles ranking do.
 */
import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsNumber, IsObject, IsOptional, Min } from 'class-validator';
import { OrgModeService } from '../org-mode.service';
import { OrgService } from '../org.service';
import { OrgIntentService } from '../org-intent.service';
import { OrgBlueprintsService, type ImportMode } from '../org-blueprints.service';
import { OrgRolesService } from '../org-roles.service';
import { BLUEPRINT_FORMAT } from './format';

export class ImportBlueprintDto {
  @IsObject() blueprint!: Record<string, unknown>;
  @IsIn(['supervised', 'autonomous']) mode!: ImportMode;
  @IsOptional() @IsNumber() @Min(0) monthlyUsd?: number;
}

@Controller('workspaces/:id/org')
export class BlueprintsController {
  constructor(
    private readonly blueprints: OrgBlueprintsService,
    private readonly roles: OrgRolesService,
    private readonly mode: OrgModeService,
    private readonly org: OrgService,
    private readonly intent: OrgIntentService,
    private readonly config: ConfigService,
  ) {}

  private guard(): void { if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)'); }

  @Get('blueprint') async exportBlueprint(@Param('id') id: string) { this.guard(); return this.blueprints.export(await this.mode.orgIdOf(id)); }

  /** The body is the blueprint itself, or `{ blueprint, mode?, monthlyUsd? }`. */
  @Post('blueprint/plan') plan(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    this.guard();
    const bp = body?.format === BLUEPRINT_FORMAT ? body : (body?.blueprint as Record<string, unknown> | undefined);
    if (!bp) throw new NotFoundException(`body must be a "${BLUEPRINT_FORMAT}" blueprint or { blueprint }`);
    const mode = body?.mode === 'autonomous' || body?.mode === 'supervised' ? (body.mode as ImportMode) : undefined;
    return this.blueprints.importPlan(id, bp, { mode, monthlyUsd: typeof body?.monthlyUsd === 'number' ? body.monthlyUsd : undefined });
  }

  @Post('blueprint/import') importBlueprint(@Param('id') id: string, @Body() dto: ImportBlueprintDto) {
    this.guard();
    return this.blueprints.import(id, dto.blueprint, { mode: dto.mode, monthlyUsd: dto.monthlyUsd });
  }

  /** The catalog ranked against `profile`, or against the org's own operating profile and vision. */
  @Get('roles') async roles_(@Param('id') id: string, @Query('profile') profile?: string) {
    this.guard();
    let text = profile ?? '';
    if (!profile) {
      const org = await this.org.byWorkspace(id);
      if (org) {
        const vision = await this.intent.vision(org.id).catch(() => null);
        text = [org.values, org.culture, org.mission, vision?.title ?? '', vision?.description ?? ''].join('\n');
      }
    }
    return { profile: text.slice(0, 200), roles: this.roles.list(text) };
  }
}
