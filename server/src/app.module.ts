/**
 * AppModule — root NestJS module wiring every feature module together.
 *
 *  ConfigModule (global)   — dotenv-free typed config factory
 *  DatabaseModule (global) — Drizzle + SQLite, boot-time idempotent migrations
 *
 *  StatusModule      → GET  /api/status
 *  WorkspacesModule  → CRUD /api/workspaces        (scoping + memory, §12)
 *  AgentTypesModule  → CRUD /api/agent-types       (provider presets, §9)
 *  AgentsModule      → CRUD /api/agents            (durable agents, §11)
 *  ChatsModule       → CRUD /api/chats, SSE turns  (§1–§8)
 *
 * Layering: Controllers → Services → Repositories (Drizzle).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { StatusModule } from './status/status.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { AgentTypesModule } from './agent-types/agent-types.module';
import { AgentsModule } from './agents/agents.module';
import { ChatsModule } from './chats/chats.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    StatusModule,
    WorkspacesModule,
    AgentTypesModule,
    AgentsModule,
    ChatsModule,
  ],
})
export class AppModule {}
