/**
 * HomeController — the owner's mission control in one request (docs/home.md).
 *
 *  GET /api/workspaces/:id/home            the aggregate (HomeData); records the visit
 *  GET /api/workspaces/:id/home?since=ISO  the same for a fixed window, without touching
 *                                          the visit (the page's live refreshes)
 *
 * It is a GET so a viewer of a shared workspace gets a Home too; the visit
 * row is that person's bookkeeping, not workspace state.
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { HomeService } from './home.service';

@Controller('workspaces/:id/home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get() get(@Param('id') id: string, @Query('since') since?: string) {
    return this.home.home(id, { since: since || undefined });
  }
}
