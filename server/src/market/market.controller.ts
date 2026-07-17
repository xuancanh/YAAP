import { Controller, Get, Param, Post } from '@nestjs/common';
import { MarketService } from './market.service';

@Controller('market')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  @Get() list() { return this.market.list(); }
  @Post(':id/hire') hire(@Param('id') id: string) { return this.market.hire(id); }
}
