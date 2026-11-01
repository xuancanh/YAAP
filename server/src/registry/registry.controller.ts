/**
 * Registry HTTP surface (execution-plan item 12, docs/registry.md):
 *   GET  /api/registry?kind=&q=        local + cached remote items
 *   GET  /api/registry/status          remote URL, token presence, cache state
 *   GET  /api/registry/public          public feed (no auth): published items
 *   GET  /api/registry/public/:id      one public item with its manifest
 *   POST /api/registry/public          remote publish (bearer = publish token)
 *   POST /api/registry/public/:id/installed | /rate | /outcome   anonymous counters
 *   POST /api/registry/publish         publish an agent / skill / app (dryRun)
 *   GET  /api/registry/:id             item + manifest
 *   POST /api/registry/:id/install     { confirm?, options? } — review first
 *   POST /api/registry/:id/rate        { rating, note? }
 * The `public` routes are declared before `:id` so Nest matches them first.
 */
import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { RegistryService, REGISTRY_KINDS, type InstallOptions, type RegistryKind } from './registry.service';

class PublishDto {
  @IsIn([...REGISTRY_KINDS]) kind!: RegistryKind;
  @IsOptional() @IsString() agentId?: string;
  @IsOptional() @IsString() skillId?: string;
  @IsOptional() @IsString() appId?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() publisherName?: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

class RateDto {
  @IsIn(['up', 'down']) rating!: 'up' | 'down';
  @IsOptional() @IsString() note?: string;
}

@Controller('registry')
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  @Get() list(@Query('kind') kind?: string, @Query('q') q?: string) { return this.registry.list({ kind, q }); }
  @Get('status') status() { return this.registry.status(); }

  // ---- the public feed (TokenAuthStrategy leaves these open) ----
  @Get('public') listPublic() { return this.registry.listPublic(); }
  @Post('public') remotePublish(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    return this.registry.acceptRemotePublish(body, authorization);
  }
  @Get('public/:id') getPublic(@Param('id') id: string) { return this.registry.getPublic(id); }
  @Post('public/:id/installed') publicInstalled(@Param('id') id: string) { return this.registry.bumpPublicInstall(id); }
  @Post('public/:id/rate') publicRate(@Param('id') id: string, @Body() body: { rating?: unknown }) { return this.registry.bumpPublicRating(id, body?.rating); }
  /** Blueprint outcomes (docs/blueprints.md §4): an anonymous milestone counter. */
  @Post('public/:id/outcome') publicOutcome(@Param('id') id: string, @Body() body: { kind?: unknown }) { return this.registry.bumpPublicOutcome(id, body?.kind); }

  @Post('publish') publish(@Body() dto: PublishDto) { return this.registry.publish(dto); }
  @Get(':id') get(@Param('id') id: string) { return this.registry.get(id); }
  /** Two-step: without `confirm: true` this returns `{ requiresConfirm, review }`. */
  @Post(':id/install') install(@Param('id') id: string, @Body() body: { confirm?: unknown; options?: InstallOptions }) {
    return this.registry.install(id, body ?? {});
  }
  @Post(':id/rate') rate(@Param('id') id: string, @Body() dto: RateDto) { return this.registry.rate(id, dto); }
}
