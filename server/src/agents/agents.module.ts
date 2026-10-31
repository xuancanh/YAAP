import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentMemoryService } from './agent-memory.service';
import { ConnectionsModule } from '../connections/connections.module';
import { RunnerModule } from '../runner/runner.module';
import { VoiceModule } from '../voice/voice.module';

@Module({
  imports: [ConnectionsModule, RunnerModule, VoiceModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentMemoryService],
  exports: [AgentsService, AgentMemoryService],
})
export class AgentsModule {}
