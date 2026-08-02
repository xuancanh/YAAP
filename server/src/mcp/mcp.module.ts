/**
 * McpModule — MCP servers (FR-10.3): configuration plus a Streamable-HTTP
 * client. Enabled servers are discovered (tools/list cached on the row) and
 * their tools are offered to the turn loop as mcp_<server>_<tool>, gated by
 * the Ask/Auto policy like every other mutation-class tool (FR-4.2).
 */
import { Module } from '@nestjs/common';
import { Body, ConflictException, Controller, Delete, Get, Inject, Injectable, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { mcpServers } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { seal, open } from '../common/secretbox';
import { McpAuthRequiredError, McpHttpClient, McpToolDef } from './mcp-client';
import { discoverAuth, pkcePair, registerClient } from './mcp-oauth';
import { AiToolSpec } from '../ai/ai-provider.interface';

export const MCP_TOOL_PREFIX = 'mcp_';
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

type McpRow = typeof mcpServers.$inferSelect;

interface PendingAuth {
  serverId: string;
  verifier: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  createdAt: number;
}

@Injectable()
export class McpService {
  /** Lazy client cache keyed by server id; dropped on config changes. */
  private readonly clients = new Map<string, McpHttpClient>();
  /** Pending OAuth states: nonce → PKCE material (10-minute window). */
  private readonly pendingAuth = new Map<string, PendingAuth>();
  /** Test seam: swap the client constructor. */
  clientFactory: (url: string, getToken: () => Promise<string | null>) => McpHttpClient =
    (url, getToken) => new McpHttpClient(url, fetch, getToken);
  /** Test seam for the OAuth discovery/token HTTP. */
  fetchImpl: typeof fetch = fetch;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly config: ConfigService,
  ) {}

  list(): Promise<McpRow[]> {
    return this.db.select().from(mcpServers);
  }

  /** Rows for the API: tokens and client secrets never leave the server. */
  async listPublic() {
    return (await this.list()).map((r) => ({
      id: r.id, name: r.name, url: r.url, enabled: r.enabled, tools: r.tools, createdAt: r.createdAt,
      authStatus: r.authAccessToken ? 'connected' : 'none',
    }));
  }

  private client(server: McpRow): McpHttpClient {
    let c = this.clients.get(server.id);
    if (!c) {
      c = this.clientFactory(server.url, () => this.tokenFor(server.id));
      this.clients.set(server.id, c);
    }
    return c;
  }

  // ---- OAuth 2.1 (MCP authorization spec) ----

  private redirectUri(): string {
    const base = this.config.get<string>('publicBaseUrl') ?? 'http://localhost:8790';
    return `${base}/api/mcp/oauth/callback`;
  }

  /** Bearer token for a server, refreshed when close to expiry. */
  private async tokenFor(serverId: string): Promise<string | null> {
    const row = (await this.db.select().from(mcpServers).where(eq(mcpServers.id, serverId))).at(0);
    if (!row?.authAccessToken) return null;
    const fresh = row.authExpiresAt === '' || new Date(row.authExpiresAt).getTime() - Date.now() > 60_000;
    if (fresh) return open(row.authAccessToken);
    if (!row.authRefreshToken || !row.authTokenUrl) return open(row.authAccessToken);
    const res = await this.fetchImpl(row.authTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: open(row.authRefreshToken),
        client_id: row.authClientId,
        ...(row.authClientSecret ? { client_secret: open(row.authClientSecret) } : {}),
        resource: row.url,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`mcp token refresh failed (${res.status}) — reconnect the server`);
    const tok = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    await this.db.update(mcpServers).set({
      authAccessToken: seal(tok.access_token),
      ...(tok.refresh_token ? { authRefreshToken: seal(tok.refresh_token) } : {}),
      authExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : '',
    }).where(eq(mcpServers.id, serverId));
    return tok.access_token;
  }

  /** Begin the authorization-code + PKCE flow: probe the server for its 401
   *  challenge, discover endpoints, register a client, build the consent URL
   *  (the web client opens it in a popup). */
  async oauthStart(id: string): Promise<{ url: string }> {
    const row = (await this.db.select().from(mcpServers).where(eq(mcpServers.id, id))).at(0);
    if (!row) throw new NotFoundException(`mcp server ${id}`);
    let wwwAuthenticate = '';
    try {
      this.clients.delete(id);
      await this.client(row).listTools();
      throw new ConflictException('this MCP server did not ask for authorization');
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      if (err instanceof McpAuthRequiredError) wwwAuthenticate = err.wwwAuthenticate;
      // any other failure: still attempt discovery — some servers 400 before auth
    }
    const meta = await discoverAuth(row.url, wwwAuthenticate, this.fetchImpl);
    const reg = await registerClient(meta.registrationEndpoint, this.redirectUri(), this.fetchImpl);
    if (!reg) throw new ConflictException('the authorization server does not support dynamic client registration — add the server with a pre-authorized URL instead');
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString('base64url');
    this.pendingAuth.set(state, {
      serverId: id, verifier, tokenUrl: meta.tokenEndpoint,
      clientId: reg.clientId, clientSecret: reg.clientSecret, createdAt: Date.now(),
    });
    for (const [s, p] of this.pendingAuth) if (Date.now() - p.createdAt > 600_000) this.pendingAuth.delete(s);
    const url = `${meta.authorizationEndpoint}?${new URLSearchParams({
      client_id: reg.clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // RFC 8707: bind the token to this MCP server.
      resource: row.url,
      state,
    })}`;
    return { url };
  }

  /** OAuth callback: exchange the code, seal + store tokens on the row. */
  async oauthCallback(code: string, state: string): Promise<McpRow> {
    const pending = this.pendingAuth.get(state);
    if (!pending) throw new ConflictException('unknown or expired OAuth state');
    this.pendingAuth.delete(state);
    const row = (await this.db.select().from(mcpServers).where(eq(mcpServers.id, pending.serverId))).at(0);
    if (!row) throw new NotFoundException(`mcp server ${pending.serverId}`);
    const res = await this.fetchImpl(pending.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri(),
        client_id: pending.clientId,
        ...(pending.clientSecret ? { client_secret: pending.clientSecret } : {}),
        code_verifier: pending.verifier,
        resource: row.url,
      }),
    });
    if (!res.ok) throw new ConflictException(`token exchange failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const tok = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    await this.db.update(mcpServers).set({
      authAccessToken: seal(tok.access_token),
      authRefreshToken: tok.refresh_token ? seal(tok.refresh_token) : '',
      authExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : '',
      authTokenUrl: pending.tokenUrl,
      authClientId: pending.clientId,
      authClientSecret: pending.clientSecret ? seal(pending.clientSecret) : '',
    }).where(eq(mcpServers.id, pending.serverId));
    this.clients.delete(pending.serverId);
    return (await this.db.select().from(mcpServers).where(eq(mcpServers.id, pending.serverId)))[0];
  }

  /** Connect and cache the server's tool list on its row (shown in Settings
   *  and offered to chats without a per-turn network call). */
  async discover(id: string): Promise<{ tools: McpToolDef[] }> {
    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`mcp server ${id}`);
    this.clients.delete(id);
    const tools = await this.client(rows[0]).listTools();
    await this.db.update(mcpServers)
      .set({ tools: JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }))) })
      .where(eq(mcpServers.id, id));
    return { tools };
  }

  /** Tool specs for every enabled server, from the cached discovery. */
  async toolSpecs(): Promise<AiToolSpec[]> {
    const out: AiToolSpec[] = [];
    for (const server of await this.list()) {
      if (server.enabled !== 1) continue;
      let tools: McpToolDef[];
      try { tools = JSON.parse(server.tools) as McpToolDef[]; } catch { continue; }
      for (const t of tools) {
        out.push({
          name: `${MCP_TOOL_PREFIX}${slug(server.name)}_${slug(t.name)}`,
          description: `[MCP · ${server.name}] ${t.description ?? t.name}`,
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        });
      }
    }
    return out;
  }

  /** Route an mcp_<server>_<tool> call to its server. */
  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    for (const server of await this.list()) {
      if (server.enabled !== 1) continue;
      const prefix = `${MCP_TOOL_PREFIX}${slug(server.name)}_`;
      if (!toolName.startsWith(prefix)) continue;
      const wanted = toolName.slice(prefix.length);
      let tools: McpToolDef[];
      try { tools = JSON.parse(server.tools) as McpToolDef[]; } catch { continue; }
      const tool = tools.find((t) => slug(t.name) === wanted);
      if (!tool) continue;
      const text = await this.client(server).callTool(tool.name, args);
      return text.length > 20_000 ? `${text.slice(0, 20_000)}
…(truncated)` : text;
    }
    throw new Error(`unknown tool: ${toolName}`);
  }

  async create(input: { name: string; url: string; tools?: string[] }) {
    const row = {
      id: newId(), name: input.name, url: input.url, enabled: 1,
      tools: JSON.stringify(input.tools ?? []), createdAt: nowIso(),
    };
    await this.db.insert(mcpServers).values(row);
    return { ...row, authStatus: 'none' };
  }

  async update(id: string, patch: Partial<{ name: string; url: string; enabled: boolean; tools: string[] }>) {
    this.clients.delete(id);
    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`mcp server ${id}`);
    const set: Record<string, unknown> = { ...patch };
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
    if (patch.tools !== undefined) set.tools = JSON.stringify(patch.tools);
    // changing the URL invalidates any stored authorization
    if (patch.url && patch.url !== rows[0].url) {
      Object.assign(set, { authAccessToken: '', authRefreshToken: '', authExpiresAt: '', authTokenUrl: '', authClientId: '', authClientSecret: '' });
    }
    await this.db.update(mcpServers).set(set).where(eq(mcpServers.id, id));
    return (await this.listPublic()).find((r) => r.id === id);
  }

  async remove(id: string) {
    this.clients.delete(id);
    await this.db.delete(mcpServers).where(eq(mcpServers.id, id));
    return { ok: true };
  }
}

class CreateMcpDto {
  @IsString() name!: string;
  @IsString() url!: string;
}

class UpdateMcpDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Controller('mcp')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Get() list() { return this.mcp.listPublic(); }
  @Post() create(@Body() dto: CreateMcpDto) { return this.mcp.create(dto); }
  @Post(':id/discover') discover(@Param('id') id: string) { return this.mcp.discover(id); }

  // ---- OAuth 2.1 (MCP authorization spec) ----
  @Get(':id/oauth/start') oauthStart(@Param('id') id: string) { return this.mcp.oauthStart(id); }

  /** Browser lands here from the authorization server. */
  @Get('oauth/callback')
  async oauthCallback(@Query('code') code: string, @Query('state') state: string, @Query('error') error: string, @Res() res: Response) {
    const page = (title: string, body: string) =>
      `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:40px;text-align:center"><h3>${title}</h3><p>${body}</p><script>setTimeout(()=>window.close(),1500)</script></body>`;
    if (error || !code) {
      res.status(400).send(page('Connection cancelled', 'You can close this window.'));
      return;
    }
    try {
      const server = await this.mcp.oauthCallback(code, state);
      res.send(page('Connected', `${server.name} is authorized. You can close this window and return to yaam.`));
    } catch (err) {
      res.status(400).send(page('Connection failed', err instanceof Error ? err.message : 'unknown error'));
    }
  }

  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateMcpDto) { return this.mcp.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.mcp.remove(id); }
}

@Module({
  controllers: [McpController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
