import { Module } from '@nestjs/common';
import { PortabilityController } from './portability.controller';
import { PortabilityService } from './portability.service';
import { AgentsModule } from '../agents/agents.module';
import { SkillsModule } from '../skills/skills.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

/** AGENT.json v2 export/import and the memory importers (execution-plan
 *  item 9). SKILL.md import/export sits on SkillsModule. */
@Module({
  imports: [AgentsModule, SkillsModule, WorkspacesModule],
  controllers: [PortabilityController],
  providers: [PortabilityService],
  exports: [PortabilityService],
})
export class PortabilityModule {}
