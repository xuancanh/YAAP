/**
 * AppModule — root NestJS module wiring every feature module together.
 *
 *  ConfigModule (global)   — typed config factory (env)
 *  DatabaseModule (global) — Drizzle + Postgres, boot-time idempotent migrations
 *  StorageModule (global)  — S3-compatible object storage for workspace files
 *
 *  StatusModule      → GET  /api/status
 *  WorkspacesModule  → CRUD /api/workspaces        (scoping + memory, §12)
 *  AgentTypesModule  → CRUD /api/agent-types       (provider presets, §9)
 *  AgentsModule      → CRUD /api/agents            (durable agents, §11)
 *  ChatsModule       → CRUD /api/chats, SSE turns  (§1–§8)
 *  SkillsModule      → CRUD /api/skills            (instruction packs, §10)
 *  SearchModule      → GET  /api/search            (sessions/messages/files, FR-8.2)
 *  MarketModule      → GET  /api/market, hire       (agent registry, FR-11.7)
 *  McpModule         → CRUD /api/mcp                (server config, FR-10.3)
 *  SettingsModule    → GET/PUT /api/settings        (app-wide defaults)
 *  ChannelsModule    → /api/channels/telegram        (presence, phase 4)
 *
 * Layering: Controllers → Services → Repositories (Drizzle).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { StatusModule } from './status/status.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { AgentTypesModule } from './agent-types/agent-types.module';
import { AgentsModule } from './agents/agents.module';
import { ChatsModule } from './chats/chats.module';
import { SkillsModule } from './skills/skills.module';
import { SearchModule } from './search/search.module';
import { MarketModule } from './market/market.module';
import { McpModule } from './mcp/mcp.module';
import { SettingsModule } from './settings/settings.module';
import { ChannelsModule } from './channels/channels.module';
import { AppBridgeModule } from './appbridge/app-bridge.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    StorageModule,
    StatusModule,
    WorkspacesModule,
    AgentTypesModule,
    AgentsModule,
    ChatsModule,
    SkillsModule,
    SearchModule,
    MarketModule,
    McpModule,
    SettingsModule,
    ChannelsModule,
    AppBridgeModule,
  ],
})
export class AppModule {}
