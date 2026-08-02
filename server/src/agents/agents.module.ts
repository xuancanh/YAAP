import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentMemoryService } from './agent-memory.service';
import { ConnectionsModule } from '../connections/connections.module';
import { RunnerModule } from '../runner/runner.module';

@Module({
  imports: [ConnectionsModule, RunnerModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentMemoryService],
  exports: [AgentsService, AgentMemoryService],
})
export class AgentsModule {}
