/**
 * AppModule — root NestJS module wiring every feature module together.
 *
 *  ConfigModule (global)   — typed config factory (env)
 *  DatabaseModule (global) — Drizzle + Postgres, boot-time idempotent migrations
 *  StorageModule (global)  — S3-compatible object storage for workspace files
 *  FilesModule (global)    — WorkspaceFs over it: homes, versions, revisions (docs/filesystem.md)
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
 *  ChannelsModule    → /api/channels/telegram|email  (presence, phase 4)
 *  PushModule        → /api/push                      (web push, phase 4.3)
 *  UsageModule       → GET  /api/agents|workspaces/:id/usage (cost dashboard, phase 2)
 *  PortabilityModule → AGENT.json v2 export/import, memory importers (plan item 9)
 *  SecurityModule    → GET  /api/security            (threat model, docs/security.md)
 *  VoiceModule       → /api/voice/status, /api/voice/tts (voice notes, docs/voice.md)
 *  ComputerModule    → /api/computer                 (paired desktop companion, docs/computer-control.md)
 *  RegistryModule    → /api/registry                  (market registry, docs/registry.md)
 *  OrgModule         → /api/orgs                      (autonomous company, docs/autonomous-company.md)
 *  SharedModule      → /api/workspaces/:id/members|invites|flow-rules, /api/invites (shared workspaces, docs/shared-agents.md)
 *  GroupChatModule   → /api/workspaces/:id/chat/channels, /api/workspaces/:id/events (group chat, docs/group-chat.md)
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
import { FilesModule } from './files/files.module';
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
import { PushModule } from './push/push.module';
import { AppBridgeModule } from './appbridge/app-bridge.module';
import { ConnectionsModule } from './connections/connections.module';
import { RunnerModule } from './runner/runner.module';
import { BrowserModule } from './browser/browser.module';
import { SecurityModule } from './security/security.module';
import { UsageModule } from './usage/usage.module';
import { VoiceModule } from './voice/voice.module';
import { PortabilityModule } from './portability/portability.module';
import { ComputerModule } from './computer/computer.module';
import { RegistryModule } from './registry/registry.module';
import { OrgModule } from './org/org.module';
import { AccountsModule } from './accounts/accounts.module';
import { SharedModule } from './shared/shared.module';
import { GroupChatModule } from './groupchat/groupchat.module';
import { WorkspaceAccessGuard } from './shared/workspace-access.guard';
import { SessionAuthStrategy } from './accounts/session-auth.strategy';
import { SuiteJwtStrategy } from './accounts/suite-jwt.strategy';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
    DatabaseModule,
    AccountsModule,
    SharedModule,
    StorageModule,
    FilesModule,
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
    PushModule,
    AppBridgeModule,
    ConnectionsModule,
    RunnerModule,
    BrowserModule,
    SecurityModule,
    UsageModule,
    VoiceModule,
    PortabilityModule,
    ComputerModule,
    RegistryModule,
    OrgModule,
    GroupChatModule,
  ],
  providers: [
    // Identity is bound here and nowhere else: swapping this one provider
    // replaces the app's auth model without touching a controller
    // (docs/shared-accounts.md, phase 5 — shipped as docs/accounts.md).
    // AUTH_MODE=single → the shared token; accounts → the session cookie, or
    // the suite's JWT when SUITE_ACCOUNTS_* are set (experimental).
    TokenAuthStrategy,
    {
      provide: AUTH_STRATEGY,
      inject: [ConfigService, TokenAuthStrategy, SessionAuthStrategy, SuiteJwtStrategy],
      useFactory: (config: ConfigService, token: TokenAuthStrategy, session: SessionAuthStrategy, suite: SuiteJwtStrategy) => {
        if (config.get<string>('authMode') !== 'accounts') return token;
        return config.get<string>('suiteAccountsUrl') ? suite : session;
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    // After the caller is known: a member of a shared workspace acts inside
    // its owner's account with a role (docs/shared-agents.md §2).
    { provide: APP_GUARD, useClass: WorkspaceAccessGuard },
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
    const mode = this.config.get<string>('authMode') ?? 'single';
    if (mode === 'accounts') {
      const suite = this.config.get<string>('suiteAccountsUrl');
      this.logger.log(`AUTH_MODE=accounts — ${suite ? `suite JWT strategy (experimental, ${suite})` : 'email magic-link sessions'}; every query is account-scoped`);
      if (this.config.get<string>('emailSendProvider') === 'off') {
        this.logger.warn('EMAIL_SEND_PROVIDER is off — sign-in links are logged, not mailed. Fine for dev; hosted deployments need a sender.');
      }
    } else if (!this.config.get<string>('apiToken')) {
      this.logger.warn(
        'YAAM_API_TOKEN is not set — the API is unauthenticated (fine for single-user localhost). Set YAAM_API_TOKEN if the API is reachable beyond this machine, or AUTH_MODE=accounts for sign-in.',
      );
    }
  }
}
