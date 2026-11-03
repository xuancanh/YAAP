/**
 * DataAccessModule — the workspace's data as read tools for agents
 * (docs/agent-data-access.md): ws_catalog, ws_workspace, ws_agents,
 * ws_market and ws_plugins. It owns no state; every answer comes from the
 * service that owns the data. The company's own data tools (org_company,
 * org_people, org_task, org_meetings, org_approvals) live in OrgModule.
 */
import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ChatsModule } from '../chats/chats.module';
import { SkillsModule } from '../skills/skills.module';
import { ConnectionsModule } from '../connections/connections.module';
import { UsageModule } from '../usage/usage.module';
import { PluginsModule } from '../plugins/plugins.module';
import { RegistryModule } from '../registry/registry.module';
import { OrgModule } from '../org/org.module';
import { AiModule } from '../ai/ai.module';
import { WorkspaceDataTools } from './workspace-data.tools';

@Module({
  imports: [AgentsModule, WorkspacesModule, ChatsModule, SkillsModule, ConnectionsModule, UsageModule, PluginsModule, RegistryModule, OrgModule, AiModule],
  providers: [WorkspaceDataTools],
})
export class DataAccessModule {}
