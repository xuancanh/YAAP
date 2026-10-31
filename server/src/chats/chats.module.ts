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
import { LoopsService } from './loops.service';
import { DistillService } from './distill.service';
import { AiModule } from '../ai/ai.module';
import { AgentTypesModule } from '../agent-types/agent-types.module';
import { AgentsModule } from '../agents/agents.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SkillsModule } from '../skills/skills.module';
import { McpModule } from '../mcp/mcp.module';
import { ConnectionsModule } from '../connections/connections.module';
import { RunnerModule } from '../runner/runner.module';
import { ActionReviewModule } from '../review/action-review.module';

@Module({
  imports: [AiModule, AgentTypesModule, AgentsModule, WorkspacesModule, SkillsModule, McpModule, ConnectionsModule, RunnerModule, ActionReviewModule],
  controllers: [ChatsController],
  providers: [ChatsService, ChatsRepository, TurnLoopService, TurnContextService, ToolsService, ChatLocks, CompactionService, LoopsService, DistillService],
  exports: [ChatsService, ChatsRepository, TurnLoopService],
})
export class ChatsModule {}
