/**
 * PluginsModule — plugins on an enforcing core (docs/plugins.md), Phase 1:
 * manifest v1, the interface registry, binding resolver and dispatcher
 * (`InterfaceDispatcher`, the turn loop's fixed policy stage for interface
 * operations), generic floors and owner policies, the conformance runner
 * (mock), the registrar and dependency-driven suspension, the generic change
 * record, the approval pair and metering. First-party interface and
 * provider plugins load from `plugins/first-party/`.
 */
import { Module } from '@nestjs/common';
import { ChatsModule } from '../chats/chats.module';
import { ActionsModule } from '../actions/actions.module';
import { PluginsService } from './plugins.service';
import { ChangesService } from './changes.service';
import { PluginAuditService } from './plugin-audit';
import { InterfaceDispatcher } from './dispatcher';
import { PluginsController } from './plugins.controller';

@Module({
  imports: [ChatsModule, ActionsModule],
  controllers: [PluginsController],
  providers: [PluginAuditService, PluginsService, ChangesService, InterfaceDispatcher],
  exports: [PluginsService, ChangesService, InterfaceDispatcher],
})
export class PluginsModule {}
