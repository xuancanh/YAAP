/** HTTP surface for connections: list, OAuth start/callback, grants. */
import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import type { Response } from 'express';
import { ConnectionsService, ScopeTier } from './connections.service';
import type { ConnectionService as ServiceName } from './connections.tools';

class GrantDto {
  @IsString() agentId!: string;
  @IsIn(['calendar', 'gmail', 'drive']) service!: 'calendar' | 'gmail' | 'drive';
  @IsIn(['read', 'write']) level!: 'read' | 'write';
}

@Controller('connections')
export class ConnectionsController {
  constructor(private readonly svc: ConnectionsService) {}

  @Get() list() { return this.svc.list(); }
  @Get('providers') providers() { return this.svc.providers(); }
  @Get('tools') tools() { return this.svc.toolCatalog(); }

  /** tier=read on first connect; write/gmail are incremental re-consents. */
  @Get('google/start')
  start(@Query('tier') tier?: string) {
    if (tier && !['read', 'write', 'gmail', 'drive'].includes(tier)) throw new BadRequestException('tier must be read, write, gmail, or drive');
    return this.svc.startGoogleAuth((tier as ScopeTier) ?? 'read');
  }

  /** Browser lands here from Google; respond with a tiny self-closing page. */
  @Get('google/callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Query('error') error: string, @Res() res: Response) {
    const page = (title: string, body: string) =>
      `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:40px;text-align:center"><h3>${title}</h3><p>${body}</p><script>setTimeout(()=>window.close(),1500)</script></body>`;
    if (error || !code) {
      res.status(400).send(page('Connection cancelled', 'You can close this window.'));
      return;
    }
    try {
      const conn = await this.svc.handleGoogleCallback(code, state);
      res.send(page('Connected', `Google Calendar for ${conn.accountEmail || 'your account'} is connected. You can close this window and return to yaam.`));
    } catch (err) {
      res.status(400).send(page('Connection failed', err instanceof Error ? err.message : 'unknown error'));
    }
  }

  @Delete(':id') remove(@Param('id') id: string) { return this.svc.remove(id); }
  @Post(':id/grants') grant(@Param('id') id: string, @Body() dto: GrantDto) { return this.svc.setGrant(id, dto.agentId, dto.service, dto.level); }
  @Delete(':id/grants/:agentId') revoke(@Param('id') id: string, @Param('agentId') agentId: string, @Query('service') service?: string) {
    if (service && !['calendar', 'gmail', 'drive'].includes(service)) throw new BadRequestException('service must be calendar, gmail, or drive');
    return this.svc.revokeGrant(id, agentId, service as ServiceName | undefined);
  }
}
