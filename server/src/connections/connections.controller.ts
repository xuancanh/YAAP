/** HTTP surface for connections: list, OAuth start/callback, grants. */
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import type { Response } from 'express';
import { ConnectionsService, ScopeTier, isProviderName } from './connections.service';
import type { ConnectionService as ServiceName } from './connections.tools';
import { cardById, cardForProfile, cardsForService } from './cards';

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

  /** Context cards (docs/integrations.md "Context cards and suggested
   *  loops"); `?profile=` ranks suggested uses for an operating profile. */
  @Get('cards') cards(@Query('profile') profile?: string) { return this.svc.cards(profile); }

  /** One card by id (google-gmail) or the cards of a service (gmail → both
   *  providers' cards, the first one when there is only one). */
  @Get('cards/:service')
  card(@Param('service') idOrService: string, @Query('profile') profile?: string) {
    const byId = cardById(idOrService);
    if (byId) return cardForProfile(byId, profile);
    const cards = cardsForService(idOrService);
    if (cards.length === 0) throw new NotFoundException(`no context card for ${idOrService}`);
    return cards.length === 1 ? cardForProfile(cards[0], profile) : cards.map((c) => cardForProfile(c, profile));
  }

  /** tier=read on first connect; the other tiers are incremental re-consents. */
  @Get(':provider/start')
  start(@Param('provider') provider: string, @Query('tier') tier?: string) {
    if (!isProviderName(provider)) throw new BadRequestException('provider must be google or microsoft');
    if (tier && !['read', 'write', 'gmail', 'mailread', 'drive'].includes(tier)) throw new BadRequestException('tier must be read, write, gmail, mailread, or drive');
    return this.svc.startAuth(provider, (tier as ScopeTier) ?? 'read');
  }

  /** Browser lands here from the provider; respond with a tiny self-closing page. */
  @Get(':provider/callback')
  async callback(@Param('provider') provider: string, @Query('code') code: string, @Query('state') state: string, @Query('error') error: string, @Res() res: Response) {
    const page = (title: string, body: string) =>
      `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:40px;text-align:center"><h3>${title}</h3><p>${body}</p><script>setTimeout(()=>window.close(),1500)</script></body>`;
    if (!isProviderName(provider) || error || !code) {
      res.status(400).send(page('Connection cancelled', 'You can close this window.'));
      return;
    }
    try {
      const conn = await this.svc.handleCallback(provider, code, state);
      res.send(page('Connected', `${provider === 'google' ? 'Google' : 'Microsoft'} account ${conn.accountEmail || ''} is connected. You can close this window and return to yaam.`));
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
