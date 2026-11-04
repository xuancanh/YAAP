import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentMemoryService } from './agent-memory.service';
import { AgentGuidanceService } from './agent-guidance.service';
import { ConnectionsModule } from '../connections/connections.module';
import { RunnerModule } from '../runner/runner.module';
import { VoiceModule } from '../voice/voice.module';
import { TriggerBus } from '../chats/trigger-bus';

@Module({
  imports: [ConnectionsModule, RunnerModule, VoiceModule],
  controllers: [AgentsController],
  // TriggerBus lives here (the emitting side) and is exported so ChatsModule's
  // LoopsService can listen without AgentsModule importing ChatsModule.
  providers: [AgentsService, AgentMemoryService, AgentGuidanceService, TriggerBus],
  exports: [AgentsService, AgentMemoryService, AgentGuidanceService, TriggerBus],
})
export class AgentsModule {}
