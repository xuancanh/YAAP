import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { MarketService } from './market.service';
import { CONNECTORS } from './connectors.catalog';

@Controller('market')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  @Get() list(@Query('workspaceId') workspaceId?: string) { return this.market.list(workspaceId || undefined); }
  /** Curated connector directory (docs/integrations.md §4a). Static data —
   *  the client merges live state from /api/mcp and /api/connections. */
  @Get('connectors') connectors() { return CONNECTORS; }
  /** Personal categories and business functions with their counts. */
  @Get('segments') segments() { return this.market.segments(); }
  /** Full skill bodies for the hire review modal (docs/permissions.md). */
  @Get(':id/skills') packSkills(@Param('id') id: string) { return this.market.packSkills(id); }
  @Post(':id/hire') hire(@Param('id') id: string, @Body() body: { workspaceId?: string } = {}) { return this.market.hire(id, typeof body?.workspaceId === 'string' && body.workspaceId ? body.workspaceId : undefined); }
}
