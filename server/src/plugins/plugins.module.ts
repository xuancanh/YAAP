/**
 * PluginsModule — plugins on an enforcing core (docs/plugins.md), Phase 1:
 * manifest v1, the interface registry, binding resolver and dispatcher
 * (`InterfaceDispatcher`, the turn loop's fixed policy stage for interface
 * operations), generic floors and owner policies, the conformance runner
 * (mock), the registrar and dependency-driven suspension, the generic change
 * record, the approval pair and metering. First-party interface and
 * provider plugins load from `plugins/first-party/`. The plugin registry
 * (packages, versions, tiers, recall, updates) backs Foundry's Plugins shelf.
 */
import { Module } from '@nestjs/common';
import { ChatsModule } from '../chats/chats.module';
import { SkillsModule } from '../skills/skills.module';
import { ActionsModule } from '../actions/actions.module';
import { PluginsService } from './plugins.service';
import { ChangesService } from './changes.service';
import { PluginAuditService } from './plugin-audit';
import { InterfaceDispatcher } from './dispatcher';
import { PluginsController } from './plugins.controller';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginRegistryController } from './plugin-registry.controller';
import { PluginUiService } from './plugin-ui.service';

@Module({
  imports: [ChatsModule, ActionsModule, SkillsModule],
  controllers: [PluginsController, PluginRegistryController],
  providers: [PluginAuditService, PluginsService, ChangesService, InterfaceDispatcher, PluginRegistryService, PluginUiService],
  exports: [PluginsService, ChangesService, InterfaceDispatcher, PluginAuditService, PluginRegistryService, PluginUiService],
})
export class PluginsModule {}
