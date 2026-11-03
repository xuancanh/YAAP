/**
 * The top bar (docs/home.md "Top bar"):
 *
 *  GET  /api/workspaces/:id/status               the company at a glance (WorkspaceStatus)
 *  GET  /api/workspaces/:id/notifications        the bell: waiting cards and inbox events (NotificationsPage)
 *  POST /api/workspaces/:id/notifications/read   { ids: string[] } | { all: true }
 *  GET  /api/topbar/workspaces                   the switcher's rows, one per own workspace
 *
 * The reads are GETs, so a viewer of a shared workspace gets a bar too; the
 * read marks are that person's own bookkeeping (TopBarService), set by the
 * owner and members (a viewer is read-only, WorkspaceAccessGuard). The
 * switcher's rows are the caller's own workspaces: the SPA never sends the
 * shared-workspace header with them.
 */
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { TopBarService } from './topbar.service';

@Controller('workspaces/:id')
export class TopBarController {
  constructor(private readonly topbar: TopBarService) {}

  @Get('status') status(@Param('id') id: string) {
    return this.topbar.status(id);
  }

  @Get('notifications') notifications(@Param('id') id: string) {
    return this.topbar.notifications(id);
  }

  @Post('notifications/read') read(@Param('id') id: string, @Body() body: { ids?: unknown; all?: unknown }) {
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
