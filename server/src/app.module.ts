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
 *  UsageModule       → GET  /api/agents|workspaces/:id/usage (cost dashboard, phase 2)
 *  SecurityModule    → GET  /api/security            (threat model, docs/security.md)
 *
 * Layering: Controllers → Services → Repositories (Drizzle).
 */
import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import configuration from './config/configuration';
import { validateEnv } from './config/validation';
import { AuthGuard } from './common/auth.guard';
import { AUTH_STRATEGY } from './common/auth-strategy.interface';
import { TokenAuthStrategy } from './common/token-auth.strategy';
import { HttpLoggingInterceptor } from './common/http-logging.interceptor';
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
import { ConnectionsModule } from './connections/connections.module';
import { RunnerModule } from './runner/runner.module';
import { SecurityModule } from './security/security.module';
import { UsageModule } from './usage/usage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
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
    ConnectionsModule,
    RunnerModule,
    SecurityModule,
    UsageModule,
  ],
  providers: [
    // Identity is bound here and nowhere else: swapping this one provider
    // replaces the app's auth model without touching a controller
    // (docs/shared-accounts.md, phase 5).
    { provide: AUTH_STRATEGY, useClass: TokenAuthStrategy },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
  ],
})
export class AppModule implements OnModuleInit {
  private readonly logger = new Logger(AppModule.name);

  constructor(private readonly config: ConfigService) {}

  /** Make the plain:-token fallback visible: secretbox silently stores tokens
   *  unencrypted without a key, which hosted deployments must not miss. Also
   *  flag the unauthenticated default: without YAAM_API_TOKEN any website open
   *  in the user's browser could call the API and spend LLM keys. */
  onModuleInit(): void {
    if (!this.config.get<string>('tokenEncryptionKey')) {
      this.logger.warn(
        'TOKEN_ENCRYPTION_KEY is not set — tokens at rest will be stored as "plain:" (unencrypted). Set TOKEN_ENCRYPTION_KEY for any hosted deployment.',
      );
    }
    if (!this.config.get<string>('apiToken')) {
      this.logger.warn(
        'YAAM_API_TOKEN is not set — the API is unauthenticated (fine for single-user localhost). Set YAAM_API_TOKEN if the API is reachable beyond this machine.',
      );
    }
  }
}
