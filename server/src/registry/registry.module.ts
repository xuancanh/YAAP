import { Module } from '@nestjs/common';
import { RegistryController } from './registry.controller';
import { RegistryService } from './registry.service';
import { AgentsModule } from '../agents/agents.module';
import { SkillsModule } from '../skills/skills.module';
import { PortabilityModule } from '../portability/portability.module';

/** The market registry (execution-plan item 12, docs/registry.md): publish,
 *  browse, review-gated install, ratings, and the public feed other
 *  instances federate with. Exported so ChatsService can roll turn ratings
 *  up to the items an agent or skill was installed from. */
@Module({
  imports: [AgentsModule, SkillsModule, PortabilityModule],
  controllers: [RegistryController],
  providers: [RegistryService],
  exports: [RegistryService],
})
export class RegistryModule {}
