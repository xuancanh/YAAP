import { Module } from '@nestjs/common';
import { PluginsModule } from '../plugins/plugins.module';
import { SkillsModule } from '../skills/skills.module';
import { FoundryController } from './foundry.controller';
import { KitsService } from './kits.service';

/** Foundry (docs/foundry.md): the shelf index and kits — the catalog,
 *  the plan (review), install, upgrade, rollback and uninstall. The
 *  Plugins shelf's registry lives in PluginsModule. The org module binds
 *  the kits' people hook (seats) and the chief's proposal tools. */
@Module({
  imports: [PluginsModule, SkillsModule],
  controllers: [FoundryController],
  providers: [KitsService],
  exports: [KitsService],
})
export class FoundryModule {}
