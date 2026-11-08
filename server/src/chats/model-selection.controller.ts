/**
 * Automatic model selection settings of a workspace (docs/agent-types.md
 * "Model selection"):
 *
 *  GET /api/workspaces/:id/model-selection           { selection, policy, types }
 *  PUT /api/workspaces/:id/model-selection           { mode?, order?, crossProvider? }
 *  GET /api/workspaces/:id/model-selection/outcomes  per tier: runs, success, rework, cost
 *
 * The thresholds themselves are the company's tunables (`model.*`, Company ›
 * Settings › Tunables, `org_tune`), derived from its values and culture.
 */
import { BadRequestException, Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { workspaces } from '../database/schema';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { AgentTypesService } from '../agent-types/agent-types.service';
import { tierModelForType, TIERS, typeFamily } from '../agent-types/model-resolution';
import { ModelSelectionService } from './model-selection.service';

class PutSelectionDto {
  /** '' (fixed unless an agent or type says auto) | auto | fixed. */
  @IsOptional() @IsString() mode?: string;
  /** Agent type ids, most preferred first. */
  @IsOptional() @IsArray() order?: string[];
  @IsOptional() @IsBoolean() crossProvider?: boolean;
}

@Controller('workspaces/:id/model-selection')
export class ModelSelectionController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly workspaces: WorkspacesService,
    private readonly types: AgentTypesService,
    private readonly selection: ModelSelectionService,
  ) {}

  @Get() async get(@Param('id') id: string) {
    await this.workspaces.get(id);
    const selection = await this.selection.workspaceSelection(id);
    const policy = await this.selection.policyFor(id);
    const types = (await this.types.list()).filter((t) => t.enabled && t.provider !== 'echo').map((t) => ({
      id: t.id, name: t.name, provider: t.provider, family: typeFamily(t), hasApiKey: t.hasApiKey, modelMode: t.modelMode ?? '',
      tiers: Object.fromEntries(TIERS.map((tier) => [tier, tierModelForType(t, tier)])),
    }));
    return { selection, policy, types };
  }

  @Put() async put(@Param('id') id: string, @Body() dto: PutSelectionDto) {
    await this.workspaces.get(id);
    const cur = await this.selection.workspaceSelection(id);
    const next: Record<string, unknown> = { ...(cur.mode ? { mode: cur.mode } : {}), order: cur.order, crossProvider: cur.crossProvider };
    if (dto.mode !== undefined) {
      if (!['', 'auto', 'fixed'].includes(dto.mode)) throw new BadRequestException('mode must be auto, fixed or \'\'');
      if (dto.mode) next.mode = dto.mode; else delete next.mode;
    }
    if (dto.order !== undefined) {
      const known = new Set((await this.types.list()).map((t) => t.id));
      const bad = dto.order.filter((x) => typeof x !== 'string' || !known.has(x));
      if (bad.length) throw new BadRequestException(`unknown agent type(s) in order: ${bad.join(', ')}`);
      next.order = [...new Set(dto.order)].slice(0, 20);
    }
    if (dto.crossProvider !== undefined) next.crossProvider = dto.crossProvider;
    await this.db.update(workspaces).set({ modelSelection: JSON.stringify(next) }).where(eq(workspaces.id, id));
    return this.get(id);
  }

  @Get('outcomes') async outcomes(@Param('id') id: string, @Query('days') days?: string) {
    await this.workspaces.get(id);
    const n = Number(days);
    return this.selection.outcomes(id, Number.isFinite(n) && n > 0 ? Math.floor(n) : 30);
  }
}
