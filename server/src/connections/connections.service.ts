/**
 * ConnectionsService — external service connections (docs/integrations.md).
 *
 * A connection is a user-level OAuth link to a provider (google first);
 * which agents may use it is a separate per-agent grant, off by default
 * (three-gate model: connect = creation, grant = activation, per-call
 * policy = execution). Tokens are sealed at rest (secretbox) and never
 * leave the server; list() redacts them.
 *
 * Scopes grow via Google incremental auth: first connect is calendar
 * read-only; the calendar write tier (calendar.events) and the gmail tier
 * (gmail.compose, draft + send, deliberately no read) are separate
 * re-consents. Grants are per-service — a grant is only accepted once the
 * connection actually holds that service's scopes.
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents, connections, connectionGrants } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { seal, open } from '../common/secretbox';
import { AiToolSpec } from '../ai/ai-provider.interface';
import {
  CONNECTION_TOOLS, ConnectionRow, ConnectionProvider as ProviderName,
  ConnectionService as ServiceName, GOOGLE_AUTH_URL, GOOGLE_BASE_SCOPES,
  GOOGLE_DRIVE_SCOPES, GOOGLE_GMAIL_SCOPES, GOOGLE_READ_SCOPES, GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, GOOGLE_WRITE_SCOPES,
  MS_AUTH_URL, MS_BASE_SCOPES, MS_DRIVE_SCOPES, MS_MAIL_SCOPES, MS_READ_SCOPES,
  MS_TOKEN_URL, MS_USERINFO_URL, MS_WRITE_SCOPES,
  GoogleHttp, capabilitiesFor,
} from './connections.tools';

type GrantRow = typeof connectionGrants.$inferSelect;

export type GrantLevel = 'read' | 'write';
export type ScopeTier = 'read' | 'write' | 'gmail' | 'drive';

/** Per-provider OAuth shape: endpoints, tier scopes, account resolution. */
interface ProviderMeta {
  authUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  userinfoUrl: string;
  emailFrom: (info: Record<string, unknown>) => string;
  tierScopes: (tier: ScopeTier) => string[];
  extraAuthParams: Record<string, string>;
  configKeys: { id: string; secret: string };
  configHint: string;
}

const PROVIDERS: Record<ProviderName, ProviderMeta> = {
  google: {
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    revokeUrl: GOOGLE_REVOKE_URL,
    userinfoUrl: GOOGLE_USERINFO_URL,
    emailFrom: (info) => String(info.email ?? ''),
    tierScopes: (tier) => tier === 'write' ? [...GOOGLE_BASE_SCOPES, ...GOOGLE_WRITE_SCOPES]
      : tier === 'gmail' ? [...GOOGLE_BASE_SCOPES, ...GOOGLE_GMAIL_SCOPES]
        : tier === 'drive' ? [...GOOGLE_BASE_SCOPES, ...GOOGLE_DRIVE_SCOPES]
          : [...GOOGLE_BASE_SCOPES, ...GOOGLE_READ_SCOPES],
    // Incremental auth: Google unions these scopes with prior consents,
    // so a write upgrade keeps calendar.readonly without re-listing it.
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    configKeys: { id: 'googleClientId', secret: 'googleClientSecret' },
    configHint: 'set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
  },
  microsoft: {
    authUrl: MS_AUTH_URL,
    tokenUrl: MS_TOKEN_URL,
    userinfoUrl: MS_USERINFO_URL,
    emailFrom: (info) => String(info.mail ?? info.userPrincipalName ?? ''),
    // Graph consent is cumulative per app+user; each tier requests base +
    // its own scopes and the stored set merges on callback.
    tierScopes: (tier) => tier === 'write' ? [...MS_BASE_SCOPES, ...MS_WRITE_SCOPES]
      : tier === 'gmail' ? [...MS_BASE_SCOPES, ...MS_MAIL_SCOPES]
        : tier === 'drive' ? [...MS_BASE_SCOPES, ...MS_DRIVE_SCOPES]
          : [...MS_BASE_SCOPES, ...MS_READ_SCOPES],
    extraAuthParams: { prompt: 'select_account' },
    configKeys: { id: 'msClientId', secret: 'msClientSecret' },
    configHint: 'set MS_CLIENT_ID and MS_CLIENT_SECRET',
  },
};

export function isProviderName(v: string): v is ProviderName {
  return v === 'google' || v === 'microsoft';
}

/** Outbound provider API calls time out so a stalled-but-open connection
 *  cannot hang a turn (and the chat busy lock) forever. */
const HTTP_TIMEOUT_MS = 30_000;

export interface ConnectionInfo {
  id: string;
  provider: string;
  accountEmail: string;
  scopes: string[];
  /** Whether the consented scopes cover calendar write-tier tools. */
  writeCapable: boolean;
  /** Whether the consented scopes cover gmail draft/send tools. */
  gmailCapable: boolean;
  /** Whether the consented scopes cover drive read + export tools. */
  driveCapable: boolean;
  createdAt: string;
  grants: Array<{ agentId: string; service: string; level: string }>;
}

@Injectable()
export class ConnectionsService implements GoogleHttp {
  /** Pending OAuth states: nonce → provider + createdAt (10-minute window). */
  private readonly pendingStates = new Map<string, { provider: ProviderName; at: number }>();
  /** Test seam. */
  fetchImpl: typeof fetch = fetch;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly config: ConfigService,
  ) {}

  private oauthClient(provider: ProviderName): { clientId: string; clientSecret: string; redirectUri: string } {
    const meta = PROVIDERS[provider];
    const clientId = this.config.get<string>(meta.configKeys.id) ?? '';
    const clientSecret = this.config.get<string>(meta.configKeys.secret) ?? '';
    const base = this.config.get<string>('publicBaseUrl') ?? 'http://localhost:8790';
    return { clientId, clientSecret, redirectUri: `${base}/api/connections/${provider}/callback` };
  }

  providers(): Array<{ provider: string; configured: boolean; redirectUri: string }> {
    return (Object.keys(PROVIDERS) as ProviderName[]).map((p) => {
      const c = this.oauthClient(p);
      return { provider: p, configured: !!(c.clientId && c.clientSecret), redirectUri: c.redirectUri };
    });
  }

  async list(): Promise<ConnectionInfo[]> {
    const rows = await this.db.select().from(connections);
    const grants = await this.db.select().from(connectionGrants);
    return rows.map((r) => {
      const scopes = JSON.parse(r.scopes) as string[];
      const caps = capabilitiesFor(r.provider as ProviderName, scopes);
      return {
        id: r.id,
        provider: r.provider,
        accountEmail: r.accountEmail,
        scopes,
        ...caps,
        createdAt: r.createdAt,
        grants: grants.filter((g) => g.connectionId === r.id).map((g) => ({ agentId: g.agentId, service: g.service, level: g.level })),
      };
    });
  }

  /** Build a provider consent URL; the client opens it in a popup. tier
   *  'read' is the first connect; the other tiers are incremental
   *  re-consents layered onto the same connection. */
  startAuth(provider: ProviderName, tier: ScopeTier = 'read'): { url: string } {
    const meta = PROVIDERS[provider];
    const c = this.oauthClient(provider);
    if (!c.clientId || !c.clientSecret) {
      throw new ConflictException(`${provider} OAuth is not configured — ${meta.configHint}`);
    }
    const state = randomBytes(16).toString('base64url');
    this.pendingStates.set(state, { provider, at: Date.now() });
    for (const [s, p] of this.pendingStates) if (Date.now() - p.at > 600_000) this.pendingStates.delete(s);
    const url = `${meta.authUrl}?${new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      response_type: 'code',
      scope: meta.tierScopes(tier).join(' '),
      ...meta.extraAuthParams,
      state,
    })}`;
    return { url };
  }

  /** Back-compat alias (older tests/clients). */
  startGoogleAuth(tier: ScopeTier = 'read'): { url: string } {
    return this.startAuth('google', tier);
  }

  /** OAuth callback: exchange the code, resolve the account, upsert. Stored
   *  scopes merge with prior consents, so re-consent upgrades in place. */
  async handleCallback(provider: ProviderName, code: string, state: string): Promise<ConnectionInfo> {
    const pending = this.pendingStates.get(state);
    if (!pending || pending.provider !== provider) throw new ConflictException('unknown or expired OAuth state');
    this.pendingStates.delete(state);
    const meta = PROVIDERS[provider];
    const c = this.oauthClient(provider);
    const tokenRes = await this.fetchImpl(meta.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: c.clientId, client_secret: c.clientSecret,
        redirect_uri: c.redirectUri, grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!tokenRes.ok) throw new ConflictException(`token exchange failed: ${tokenRes.status} ${(await tokenRes.text()).slice(0, 200)}`);
    const tok = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };

    const infoRes = await this.fetchImpl(meta.userinfoUrl, {
      headers: { authorization: `Bearer ${tok.access_token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const info = infoRes.ok ? await infoRes.json() as Record<string, unknown> : {};
    const email = meta.emailFrom(info);

    const existing = (await this.db.select().from(connections)
      .where(and(eq(connections.provider, provider), eq(connections.accountEmail, email)))).at(0);
    const returned = (tok.scope ?? '').split(' ').filter(Boolean);
    const prior = existing ? (JSON.parse(existing.scopes) as string[]) : [];
    const scopes = [...new Set([...prior, ...(returned.length ? returned : meta.tierScopes('read'))])];
    const row: ConnectionRow = {
      id: existing?.id ?? newId(),
      provider,
      accountEmail: email,
      scopes: JSON.stringify(scopes),
      accessToken: seal(tok.access_token),
      // Providers only return a refresh token on first consent; keep the old one.
      refreshToken: tok.refresh_token ? seal(tok.refresh_token) : (existing?.refreshToken ?? ''),
      expiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      createdAt: existing?.createdAt ?? nowIso(),
    };
    if (existing) await this.db.update(connections).set(row).where(eq(connections.id, existing.id));
    else await this.db.insert(connections).values(row);
    return (await this.list()).find((c2) => c2.id === row.id)!;
  }

  /** Back-compat alias (older tests/clients). */
  handleGoogleCallback(code: string, state: string): Promise<ConnectionInfo> {
    return this.handleCallback('google', code, state);
  }

  /** Disconnect: best-effort revoke at the provider, then delete row + grants. */
  async remove(id: string): Promise<{ ok: boolean }> {
    const row = (await this.db.select().from(connections).where(eq(connections.id, id))).at(0);
    if (!row) throw new NotFoundException(`connection ${id}`);
    const token = row.refreshToken || row.accessToken;
    const revokeUrl = PROVIDERS[row.provider as ProviderName]?.revokeUrl;
    if (token && revokeUrl) {
      await this.fetchImpl(`${revokeUrl}?token=${encodeURIComponent(open(token))}`, {
        method: 'POST',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      }).catch(() => undefined);
    }
    await this.db.delete(connectionGrants).where(eq(connectionGrants.connectionId, id));
    await this.db.delete(connections).where(eq(connections.id, id));
    return { ok: true };
  }

  // ---- grants (activation gate) ----

  async setGrant(connectionId: string, agentId: string, service: ServiceName, level: GrantLevel): Promise<{ ok: boolean }> {
    const row = (await this.db.select().from(connections).where(eq(connections.id, connectionId))).at(0);
    if (!row) throw new NotFoundException(`connection ${connectionId}`);
    const caps = capabilitiesFor(row.provider as ProviderName, JSON.parse(row.scopes) as string[]);
    if (service === 'calendar' && level === 'write' && !caps.writeCapable) {
      throw new ConflictException('this connection has read-only consent — enable write access in Settings → Connections first');
    }
    if (service === 'gmail') {
      if (!caps.gmailCapable) {
        throw new ConflictException('this connection has no mail consent — enable it in Settings → Connections first');
      }
      if (level !== 'write') throw new ConflictException('mail tools are all write-level — grant level must be write');
    }
    if (service === 'drive' && !caps.driveCapable) {
      throw new ConflictException('this connection has no Drive consent — enable Drive in Settings → Connections first');
    }
    const existing = (await this.db.select().from(connectionGrants)
      .where(and(eq(connectionGrants.connectionId, connectionId), eq(connectionGrants.agentId, agentId), eq(connectionGrants.service, service)))).at(0);
    if (existing) {
      await this.db.update(connectionGrants).set({ level }).where(eq(connectionGrants.id, existing.id));
    } else {
      await this.db.insert(connectionGrants).values({ id: newId(), connectionId, agentId, service, level, createdAt: nowIso() });
    }
    return { ok: true };
  }

  /** Revoke one service's grant, or every grant this agent holds on the
   *  connection when no service is given. */
  async revokeGrant(connectionId: string, agentId: string, service?: ServiceName): Promise<{ ok: boolean }> {
    await this.db.delete(connectionGrants)
      .where(and(
        eq(connectionGrants.connectionId, connectionId),
        eq(connectionGrants.agentId, agentId),
        ...(service ? [eq(connectionGrants.service, service)] : []),
      ));
    return { ok: true };
  }

  /** The literal tools an agent would gain per provider, service, and grant
   *  level — shown in the activation review (permissions: approve the real
   *  artifact). */
  toolCatalog(): Array<{ name: string; description: string; provider: string; service: string; level: string }> {
    return CONNECTION_TOOLS.map((t) => ({ name: t.name, description: t.description ?? '', provider: t.provider, service: t.service, level: t.level }));
  }

  // ---- turn-loop integration ----

  /** Connection tools visible to one agent: only providers + services with a
   *  grant, and within a service only the tools its level covers (write
   *  implies read). */
  async toolSpecs(agentId: string): Promise<AiToolSpec[]> {
    const granted = await this.grantedConnections(agentId);
    return CONNECTION_TOOLS
      .filter((t) => {
        const level = granted[t.provider]?.levels[t.service];
        return level !== undefined && (t.level === 'read' || level === 'write');
      })
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  /** undefined = not a connection tool. */
  isReadOnly(name: string): boolean | undefined {
    return CONNECTION_TOOLS.find((t) => t.name === name)?.readOnly;
  }

  /** Tools that confirm in host chrome on every call, even in Auto mode. */
  isConfirmAlways(name: string): boolean {
    return CONNECTION_TOOLS.find((t) => t.name === name)?.confirmAlways === true;
  }

  owns(name: string): boolean {
    return CONNECTION_TOOLS.some((t) => t.name === name);
  }

  async execute(agentId: string | undefined, name: string, input: Record<string, unknown>): Promise<string> {
    const tool = CONNECTION_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    if (!agentId) throw new Error('connection tools are available to durable agents with a granted connection only');
    const granted = (await this.grantedConnections(agentId))[tool.provider];
    const level = granted?.levels[tool.service];
    if (!granted || level === undefined) {
      throw new Error(`no connection grant: the user has not granted this agent ${tool.service} access on ${tool.provider} — grants live on the agent's Skills & tools tab`);
    }
    if (tool.level === 'write' && level !== 'write') {
      throw new Error(`no write grant: the user granted read access only — ${name} needs a write grant on the agent's Skills & tools tab`);
    }
    const agent = (await this.db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId))).at(0);
    return tool.execute(granted.conn, input, this, { agentName: agent?.name ?? 'an agent' });
  }

  /** All connections this agent may use, keyed by provider, with per-service
   *  grant levels. An agent can hold grants on google and microsoft at once. */
  private async grantedConnections(agentId: string): Promise<Partial<Record<ProviderName, { conn: ConnectionRow; levels: Partial<Record<ServiceName, GrantLevel>> }>>> {
    const grants: GrantRow[] = await this.db.select().from(connectionGrants).where(eq(connectionGrants.agentId, agentId));
    if (grants.length === 0) return {};
    const out: Partial<Record<ProviderName, { conn: ConnectionRow; levels: Partial<Record<ServiceName, GrantLevel>> }>> = {};
    for (const g of grants) {
      const row = (await this.db.select().from(connections).where(eq(connections.id, g.connectionId))).at(0);
      if (!row || !isProviderName(row.provider)) continue;
      const entry = out[row.provider] ?? (out[row.provider] = { conn: row, levels: {} });
      if (entry.conn.id === row.id) entry.levels[g.service as ServiceName] = g.level === 'write' ? 'write' : 'read';
    }
    return out;
  }

  // ---- Google HTTP with refresh ----

  private async accessToken(conn: ConnectionRow): Promise<string> {
    const fresh = conn.expiresAt && new Date(conn.expiresAt).getTime() - Date.now() > 60_000;
    if (fresh && conn.accessToken) return open(conn.accessToken);
    if (!conn.refreshToken) throw new Error('connection has no refresh token — reconnect the account in Settings');
    const provider = isProviderName(conn.provider) ? conn.provider : 'google';
    const c = this.oauthClient(provider);
    const res = await this.fetchImpl(PROVIDERS[provider].tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: open(conn.refreshToken), client_id: c.clientId,
        client_secret: c.clientSecret, grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`token refresh failed (${res.status}) — reconnect the account in Settings`);
    const tok = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    const expiresAt = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString();
    await this.db.update(connections)
      .set({
        accessToken: seal(tok.access_token),
        // Microsoft rotates refresh tokens on use; keep the newest.
        ...(tok.refresh_token ? { refreshToken: seal(tok.refresh_token) } : {}),
        expiresAt,
      })
      .where(eq(connections.id, conn.id));
    conn.accessToken = seal(tok.access_token);
    conn.expiresAt = expiresAt;
    return tok.access_token;
  }

  async googleGet(conn: ConnectionRow, url: string): Promise<unknown> {
    const token = await this.accessToken(conn);
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`google api error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async googlePost(conn: ConnectionRow, url: string, body: unknown): Promise<unknown> {
    return this.googleSend(conn, url, 'POST', body);
  }

  async googleGetText(conn: ConnectionRow, url: string, maxBytes: number): Promise<string> {
    const token = await this.accessToken(conn);
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`google api error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    if (text.includes('\u0000')) throw new Error('file is binary — only text files and Google Docs/Sheets/Slides can be read');
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n[truncated at ${maxBytes} bytes]` : text;
  }

  async googleUpload(conn: ConnectionRow, url: string, metadata: unknown, mediaType: string, media: string): Promise<unknown> {
    const token = await this.accessToken(conn);
    // No metadata part = a plain content upload (OneDrive simple upload).
    if (metadata === null) {
      const res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': mediaType },
        body: media,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`api error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res.json();
    }
    const boundary = `yaam-${randomBytes(12).toString('hex')}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${mediaType}; charset=UTF-8`,
      '',
      media,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`google api error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async googlePatch(conn: ConnectionRow, url: string, body: unknown): Promise<unknown> {
    return this.googleSend(conn, url, 'PATCH', body);
  }

  private async googleSend(conn: ConnectionRow, url: string, method: string, body: unknown): Promise<unknown> {
    const token = await this.accessToken(conn);
    const res = await this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`google api error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
}
