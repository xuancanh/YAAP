/**
 * InboxMessagesController — Messages from your team (docs/agent-messages.md,
 * docs/home.md "Inbox").
 *
 *  GET  /api/workspaces/:id/inbox/messages?days=        what agents sent the owner
 *       with message_owner, unread first: { items, unread }
 *  POST /api/workspaces/:id/inbox/messages/read  { eventId? | sessionId? }
 *       marks the messages of that direct chat read (opening the chat reads them)
 *
 * The messages are addressed to the owner: a member of a shared workspace
 * gets an empty list and cannot mark them.
 */
import { Body, Controller, ForbiddenException, Get, Param, Post, Query } from '@nestjs/common';
import { currentViewer } from '../accounts/account-context';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { OwnerMessagesService } from '../chats/owner-messages.service';

const isOwner = () => { const v = currentViewer(); return !v || v.role === 'owner'; };

@Controller('workspaces/:id/inbox/messages')
export class InboxMessagesController {
  constructor(private readonly messages: OwnerMessagesService, private readonly workspaces: WorkspacesService) {}

  @Get() async list(@Param('id') id: string, @Query('days') days?: string) {
    await this.workspaces.get(id);
    if (!isOwner()) return { items: [], unread: 0 };
    const d = Number(days);
    return this.messages.list(id, { days: Number.isFinite(d) && d > 0 ? Math.min(90, d) : 14, limit: 100 });
  }

  @Post('read') async read(@Param('id') id: string, @Body() body: { eventId?: string; sessionId?: string }) {
    await this.workspaces.get(id);
    if (!isOwner()) throw new ForbiddenException('messages from agents are addressed to the owner');
    return this.messages.markRead(id, { eventId: typeof body?.eventId === 'string' ? body.eventId : undefined, sessionId: typeof body?.sessionId === 'string' ? body.sessionId : undefined });
  }
}
