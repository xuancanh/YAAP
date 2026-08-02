import { Controller, Get, Param, Post } from '@nestjs/common';
import { MarketService } from './market.service';
import { CONNECTORS } from './connectors.catalog';

@Controller('market')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  @Get() list() { return this.market.list(); }
  /** Curated connector directory (docs/integrations.md §4a). Static data —
   *  the client merges live state from /api/mcp and /api/connections. */
  @Get('connectors') connectors() { return CONNECTORS; }
  /** Full skill bodies for the hire review modal (docs/permissions.md). */
  @Get(':id/skills') packSkills(@Param('id') id: string) { return this.market.packSkills(id); }
  @Post(':id/hire') hire(@Param('id') id: string) { return this.market.hire(id); }
}
