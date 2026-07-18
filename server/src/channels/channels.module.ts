/**
 * ChannelsModule — presence channels (roadmap phase 4). Telegram first:
 * outbound-only long polling, pairing-code DM lock, Ask-mode turns.
 */
import { Module, Controller, Get, Post } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { ChatsModule } from '../chats/chats.module';
import { AgentsModule } from '../agents/agents.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SettingsModule } from '../settings/settings.module';

@Controller('channels/telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Get('status') status() { return this.telegram.status(); }
  @Post('pair-code') pairCode() { return this.telegram.mintPairCode(); }
  @Post('unpair') unpair() { return this.telegram.unpair(); }
}

@Module({
  imports: [ChatsModule, AgentsModule, WorkspacesModule, SettingsModule],
  controllers: [TelegramController],
  providers: [TelegramService],
})
export class ChannelsModule {}
