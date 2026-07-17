/**
 * ChatsModule — conversations, the transcript, the streaming tool-using turn
 * loop, approvals, and compaction. Depends on AiModule for provider adapters
 * and on the agent-type / agent / workspace modules for turn context.
 */
import { Module } from '@nestjs/common';
import { ChatsController } from './chats.controller';
import { ChatsService } from './chats.service';
import { ChatsRepository } from './chats.repository';
import { TurnLoopService } from './turn-loop.service';
import { TurnContextService } from './turn-context.service';
import { ToolsService } from './tools.service';
import { ChatLocks } from './chat-locks';
import { CompactionService } from './compaction.service';
import { AiModule } from '../ai/ai.module';
import { AgentTypesModule } from '../agent-types/agent-types.module';
import { AgentsModule } from '../agents/agents.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [AiModule, AgentTypesModule, AgentsModule, WorkspacesModule],
  controllers: [ChatsController],
  providers: [ChatsService, ChatsRepository, TurnLoopService, TurnContextService, ToolsService, ChatLocks, CompactionService],
  exports: [ChatsService],
})
export class ChatsModule {}
