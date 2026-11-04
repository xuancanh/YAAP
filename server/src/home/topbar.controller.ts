/**
 * The top bar (docs/home.md "Top bar"):
 *
 *  GET  /api/workspaces/:id/status               the company at a glance (WorkspaceStatus)
 *  GET  /api/workspaces/:id/feed?limit=          the owner's feed: Needs you, mentions, updates (FeedPage)
 *  POST /api/workspaces/:id/feed/read            { ids: string[] } | { section } | { all: true }
 *  GET  /api/workspaces/:id/feed/types           the update types this workspace can turn off
 *  GET  /api/workspaces/:id/notifications        the bell: the same feed
 *  POST /api/workspaces/:id/notifications/read   the same marks
 *  GET  /api/topbar/workspaces                   the switcher's rows, one per own workspace
 *
 * The reads are GETs, so a viewer of a shared workspace gets a bar too; the
 * read marks are that person's own bookkeeping (FeedService), set by the
 * owner and members (a viewer is read-only, WorkspaceAccessGuard). The
 * switcher's rows are the caller's own workspaces: the SPA never sends the
 * shared-workspace header with them.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { TopBarService } from './topbar.service';
import { FeedService } from './feed.service';

type ReadBody = { ids?: unknown; all?: unknown; section?: unknown };

@Controller('workspaces/:id')
export class TopBarController {
  constructor(private readonly topbar: TopBarService, private readonly feeds: FeedService) {}

  @Get('feed') feed(@Param('id') id: string, @Query('limit') limit?: string) {
    const n = Number(limit);
    return this.feeds.feed(id, { limit: Number.isFinite(n) && n > 0 ? Math.min(500, Math.floor(n)) : undefined });
  }

  @Post('feed/read') feedRead(@Param('id') id: string, @Body() body: ReadBody) {
    return this.feeds.markRead(id, body ?? {});
  }

  @Get('feed/types') feedTypes(@Param('id') id: string) {
    return this.feeds.types(id);
  }

  @Get('status') status(@Param('id') id: string) {
    return this.topbar.status(id);
  }

  @Get('notifications') notifications(@Param('id') id: string) {
    return this.topbar.notifications(id);
  }

  @Post('notifications/read') read(@Param('id') id: string, @Body() body: ReadBody) {
    return this.topbar.markRead(id, body ?? {});
  }
}

@Controller('topbar')
export class TopBarWorkspacesController {
  constructor(private readonly topbar: TopBarService) {}

  @Get('workspaces') workspaces() {
    return this.topbar.workspaceRows();
  }
}
