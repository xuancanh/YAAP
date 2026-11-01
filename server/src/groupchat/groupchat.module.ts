/**
 * GroupChatModule — channels, threads and agents that talk
 * (docs/group-chat.md, execution-plan item 15). Depends on ChatsModule for
 * the turn loop (channel wakes are ordinary turns) and registers its channel
 * tools on it at boot; on OrgModule for organisation-mode task routing; on
 * WorkspacesModule for the create hook that gives every workspace `#general`.
 * ChatsModule and OrgModule never import this module. Named `groupchat`
 * because `channels/` is the Telegram/email presence module.
 */
import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { ChatsModule } from '../chats/chats.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SettingsModule } from '../settings/settings.module';
import { OrgModule } from '../org/org.module';
import { GroupChatService } from './groupchat.service';
import { ChannelRuntimeService } from './channel-runtime.service';
import { GroupChatController } from './groupchat.controller';
import { WorkspaceEventBus } from './workspace-events';

@Module({
  imports: [AgentsModule, ChatsModule, WorkspacesModule, SettingsModule, OrgModule],
  controllers: [GroupChatController],
  providers: [GroupChatService, ChannelRuntimeService, WorkspaceEventBus],
  exports: [GroupChatService, ChannelRuntimeService, WorkspaceEventBus],
})
export class GroupChatModule {}
