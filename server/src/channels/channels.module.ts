/**
 * ChannelsModule — presence channels (roadmap phase 4). Telegram (long
 * polling, pairing-code DM lock, Ask-mode turns) and email (per-agent
 * addresses, signed inbound webhook, pairing by code, threaded replies).
 */
import { Module, Controller, Get, Post, Body, Headers, Req, UnauthorizedException, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { TelegramService } from './telegram.service';
import { EmailService, type InboundEmail } from './email.service';
import { ChatsModule } from '../chats/chats.module';
import { AgentsModule } from '../agents/agents.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SettingsModule } from '../settings/settings.module';
import { GroupChatModule } from '../groupchat/groupchat.module';

@Controller('channels/telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Get('status') status() { return this.telegram.status(); }
  @Post('pair-code') pairCode() { return this.telegram.mintPairCode(); }
  @Post('unpair') unpair() { return this.telegram.unpair(); }
}

@Controller('channels/email')
export class EmailController {
  constructor(private readonly email: EmailService) {}

  @Get('status') status() { return this.email.status(); }
  @Post('pair-code') pairCode() { return this.email.mintPairCode(); }
  @Post('unpair') unpair(@Body() body: { address?: string }) { return this.email.unpair(body?.address); }

  /** The forwarder's webhook. Public route (token-auth.strategy.ts): the
   *  HMAC over the raw body is the credential, checked before parsing. */
  @Post('inbound')
  async inbound(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-yaam-signature') signature?: string) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (!this.email.verifySignature(raw, signature)) throw new UnauthorizedException('bad or missing X-Yaam-Signature');
    let mail: InboundEmail;
    try {
      mail = JSON.parse(raw.toString('utf8')) as InboundEmail;
    } catch {
      throw new BadRequestException('body must be JSON');
    }
    if (!mail || typeof mail.to !== 'string' || typeof mail.from !== 'string') throw new BadRequestException('to and from are required');
    return this.email.handleInbound(mail);
  }
}

@Module({
  imports: [ChatsModule, AgentsModule, WorkspacesModule, SettingsModule, GroupChatModule],
  controllers: [TelegramController, EmailController],
  providers: [TelegramService, EmailService],
  exports: [EmailService],
})
export class ChannelsModule {}
