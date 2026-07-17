import { Module } from '@nestjs/common';
import { AgentTypesController } from './agent-types.controller';
import { AgentTypesService } from './agent-types.service';

@Module({
  controllers: [AgentTypesController],
  providers: [AgentTypesService],
  exports: [AgentTypesService],
})
export class AgentTypesModule {}
