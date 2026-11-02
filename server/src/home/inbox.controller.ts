/**
 * InboxController — the Inbox's History (docs/home.md "Inbox").
 *
 *  GET /api/workspaces/:id/inbox/history?kind=&q=&from=&to=&cursor=&limit=&without=
 *      what used to wait on you and is resolved, newest first:
 *      { items: HistoryItem[], nextCursor }. `kind` is one of approvals |
 *      keys | escalations | plans | mytasks | incidents | following (empty =
 *      all); `from`/`to` are ISO times; `without=1` keeps only what was
 *      decided without you (a default or a delegate).
 *
 * A GET, so a viewer of a shared workspace reads it too: the company records
 * they can already read, and only their own tasks and follows.
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { InboxHistoryService } from './inbox-history.service';

@Controller('workspaces/:id/inbox')
export class InboxController {
  constructor(private readonly history: InboxHistoryService) {}

  @Get('history') list(
    @Param('id') id: string,
    @Query('kind') kind?: string, @Query('q') q?: string, @Query('from') from?: string, @Query('to') to?: string,
    @Query('cursor') cursor?: string, @Query('limit') limit?: string, @Query('without') without?: string,
  ) {
    return this.history.history(id, { kind, q, from, to, cursor, limit, without });
  }
}
