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
  CONNECTION_TOOLS, ConnectionRow, ConnectionService as ServiceName, GOOGLE_AUTH_URL,
  GOOGLE_BASE_SCOPES, GOOGLE_DRIVE_SCOPES, GOOGLE_GMAIL_SCOPES, GOOGLE_READ_SCOPES,
  GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, GOOGLE_WRITE_SCOPES,
  GoogleHttp, hasDriveScopes, hasGmailScopes, hasWriteScopes,
} from './connections.tools';

type GrantRow = typeof connectionGrants.$inferSelect;

export type GrantLevel = 'read' | 'write';
export type ScopeTier = 'read' | 'write' | 'gmail' | 'drive';

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
  /** Pending OAuth states: nonce → createdAt (10-minute window). */
  private readonly pendingStates = new Map<string, number>();
  /** Test seam. */
  fetchImpl: typeof fetch = fetch;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly config: ConfigService,
  ) {}

  private google(): { clientId: string; clientSecret: string; redirectUri: string } {
    const clientId = this.config.get<string>('googleClientId') ?? '';
    const clientSecret = this.config.get<string>('googleClientSecret') ?? '';
    const base = this.config.get<string>('publicBaseUrl') ?? 'http://localhost:8790';
    return { clientId, clientSecret, redirectUri: `${base}/api/connections/google/callback` };
  }

  providers(): Array<{ provider: string; configured: boolean; redirectUri: string }> {
    const g = this.google();
    return [{ provider: 'google', configured: !!(g.clientId && g.clientSecret), redirectUri: g.redirectUri }];
  }

  async list(): Promise<ConnectionInfo[]> {
    const rows = await this.db.select().from(connections);
    const grants = await this.db.select().from(connectionGrants);
    return rows.map((r) => {
      const scopes = JSON.parse(r.scopes) as string[];
      return {
        id: r.id,
        provider: r.provider,
        accountEmail: r.accountEmail,
        scopes,
        writeCapable: hasWriteScopes(scopes),
        gmailCapable: hasGmailScopes(scopes),
        driveCapable: hasDriveScopes(scopes),
        createdAt: r.createdAt,
        grants: grants.filter((g) => g.connectionId === r.id).map((g) => ({ agentId: g.agentId, service: g.service, level: g.level })),
      };
    });
  }

  /** Build the Google consent URL; the client opens it in a popup.
   *  tier 'read' is the first connect; tier 'write' is the incremental
   *  re-consent that adds calendar.events on top of existing grants. */
  startGoogleAuth(tier: ScopeTier = 'read'): { url: string } {
    const g = this.google();
    if (!g.clientId || !g.clientSecret) {
      throw new ConflictException('Google OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    }
    const state = randomBytes(16).toString('base64url');
    this.pendingStates.set(state, Date.now());
    for (const [s, at] of this.pendingStates) if (Date.now() - at > 600_000) this.pendingStates.delete(s);
    const scopes = tier === 'write' ? [...GOOGLE_BASE_SCOPES, ...GOOGLE_WRITE_SCOPES]
      : tier === 'gmail' ? [...GOOGLE_BASE_SCOPES, ...GOOGLE_GMAIL_SCOPES]
        : tier === 'drive' ? [...GOOGLE_BASE_SCOPES, ...GOOGLE_DRIVE_SCOPES]
          : [...GOOGLE_BASE_SCOPES, ...GOOGLE_READ_SCOPES];
    const url = `${GOOGLE_AUTH_URL}?${new URLSearchParams({
      client_id: g.clientId,
      redirect_uri: g.redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      // Incremental auth: Google unions these scopes with prior consents,
      // so a write upgrade keeps calendar.readonly without re-listing it.
      include_granted_scopes: 'true',
      state,
    })}`;
    return { url };
  }

  /** OAuth callback: exchange the code, resolve the account, upsert.
   *  On re-consent the token response's scope string is the union of all
   *  grants, so the stored scopes upgrade automatically. */
  async handleGoogleCallback(code: string, state: string): Promise<ConnectionInfo> {
    if (!this.pendingStates.delete(state)) throw new ConflictException('unknown or expired OAuth state');
    const g = this.google();
    const tokenRes = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: g.clientId, client_secret: g.clientSecret,
        redirect_uri: g.redirectUri, grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new ConflictException(`token exchange failed: ${tokenRes.status} ${(await tokenRes.text()).slice(0, 200)}`);
    const tok = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };

    const infoRes = await this.fetchImpl(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${tok.access_token}` } });
    const info = infoRes.ok ? await infoRes.json() as { email?: string } : {};
    const email = info.email ?? '';

    const existing = (await this.db.select().from(connections)
      .where(and(eq(connections.provider, 'google'), eq(connections.accountEmail, email)))).at(0);
    const returned = (tok.scope ?? '').split(' ').filter(Boolean);
    const prior = existing ? (JSON.parse(existing.scopes) as string[]) : [];
    const scopes = [...new Set([...prior, ...(returned.length ? returned : [...GOOGLE_BASE_SCOPES, ...GOOGLE_READ_SCOPES])])];
    const row: ConnectionRow = {
      id: existing?.id ?? newId(),
      provider: 'google',
      accountEmail: email,
      scopes: JSON.stringify(scopes),
      accessToken: seal(tok.access_token),
      // Google only returns a refresh token on first consent; keep the old one.
      refreshToken: tok.refresh_token ? seal(tok.refresh_token) : (existing?.refreshToken ?? ''),
      expiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      createdAt: existing?.createdAt ?? nowIso(),
    };
    if (existing) await this.db.update(connections).set(row).where(eq(connections.id, existing.id));
    else await this.db.insert(connections).values(row);
    return (await this.list()).find((c) => c.id === row.id)!;
  }

  /** Disconnect: best-effort revoke at the provider, then delete row + grants. */
  async remove(id: string): Promise<{ ok: boolean }> {
    const row = (await this.db.select().from(connections).where(eq(connections.id, id))).at(0);
    if (!row) throw new NotFoundException(`connection ${id}`);
    const token = row.refreshToken || row.accessToken;
    if (token) {
      await this.fetchImpl(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(open(token))}`, { method: 'POST' }).catch(() => undefined);
    }
    await this.db.delete(connectionGrants).where(eq(connectionGrants.connectionId, id));
    await this.db.delete(connections).where(eq(connections.id, id));
    return { ok: true };
  }

  // ---- grants (activation gate) ----

  async setGrant(connectionId: string, agentId: string, service: ServiceName, level: GrantLevel): Promise<{ ok: boolean }> {
    const row = (await this.db.select().from(connections).where(eq(connections.id, connectionId))).at(0);
    if (!row) throw new NotFoundException(`connection ${connectionId}`);
    const scopes = JSON.parse(row.scopes) as string[];
    if (service === 'calendar' && level === 'write' && !hasWriteScopes(scopes)) {
      throw new ConflictException('this connection has read-only consent — enable write access in Settings → Connections first');
    }
    if (service === 'gmail') {
      if (!hasGmailScopes(scopes)) {
        throw new ConflictException('this connection has no Gmail consent — enable Gmail in Settings → Connections first');
      }
      if (level !== 'write') throw new ConflictException('gmail tools are all write-level — grant level must be write');
    }
    if (service === 'drive' && !hasDriveScopes(scopes)) {
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

  /** The literal tools an agent would gain per service and grant level —
   *  shown in the activation review (permissions: approve the real artifact). */
  toolCatalog(): Array<{ name: string; description: string; service: string; level: string }> {
    return CONNECTION_TOOLS.map((t) => ({ name: t.name, description: t.description ?? '', service: t.service, level: t.level }));
  }

  // ---- turn-loop integration ----

  /** Connection tools visible to one agent: only services with a grant, and
   *  within a service only the tools its level covers (write implies read). */
  async toolSpecs(agentId: string): Promise<AiToolSpec[]> {
    const granted = await this.grantedConnection(agentId);
    if (!granted) return [];
    return CONNECTION_TOOLS
      .filter((t) => {
        const level = granted.levels[t.service];
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
    const granted = await this.grantedConnection(agentId);
    const level = granted?.levels[tool.service];
    if (!granted || level === undefined) {
      throw new Error(`no connection grant: the user has not granted this agent ${tool.service} access — grants live on the agent's Skills & tools tab`);
    }
    if (tool.level === 'write' && level !== 'write') {
      throw new Error(`no write grant: the user granted read access only — ${name} needs a write grant on the agent's Skills & tools tab`);
    }
    const agent = (await this.db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId))).at(0);
    return tool.execute(granted.conn, input, this, { agentName: agent?.name ?? 'an agent' });
  }

  private async grantedConnection(agentId: string): Promise<{ conn: ConnectionRow; levels: Partial<Record<ServiceName, GrantLevel>> } | undefined> {
    const grants: GrantRow[] = await this.db.select().from(connectionGrants).where(eq(connectionGrants.agentId, agentId));
    if (grants.length === 0) return undefined;
    const row = (await this.db.select().from(connections).where(eq(connections.id, grants[0].connectionId))).at(0);
    if (row?.provider !== 'google') return undefined;
    const levels: Partial<Record<ServiceName, GrantLevel>> = {};
    for (const g of grants.filter((g) => g.connectionId === row.id)) {
      levels[g.service as ServiceName] = g.level === 'write' ? 'write' : 'read';
    }
    return { conn: row, levels };
  }

  // ---- Google HTTP with refresh ----

  private async accessToken(conn: ConnectionRow): Promise<string> {
    const fresh = conn.expiresAt && new Date(conn.expiresAt).getTime() - Date.now() > 60_000;
    if (fresh && conn.accessToken) return open(conn.accessToken);
    if (!conn.refreshToken) throw new Error('connection has no refresh token — reconnect the account in Settings');
    const g = this.google();
    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: open(conn.refreshToken), client_id: g.clientId,
        client_secret: g.clientSecret, grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`token refresh failed (${res.status}) — reconnect the account in Settings`);
    const tok = await res.json() as { access_token: string; expires_in?: number };
    const expiresAt = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString();
    await this.db.update(connections)
      .set({ accessToken: seal(tok.access_token), expiresAt })
      .where(eq(connections.id, conn.id));
    conn.accessToken = seal(tok.access_token);
    conn.expiresAt = expiresAt;
    return tok.access_token;
  }

  async googleGet(conn: ConnectionRow, url: string): Promise<unknown> {
    const token = await this.accessToken(conn);
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`google api error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async googlePost(conn: ConnectionRow, url: string, body: unknown): Promise<unknown> {
    return this.googleSend(conn, url, 'POST', body);
  }

  async googleGetText(conn: ConnectionRow, url: string, maxBytes: number): Promise<string> {
    const token = await this.accessToken(conn);
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`google api error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    if (text.includes('\u0000')) throw new Error('file is binary — only text files and Google Docs/Sheets/Slides can be read');
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n[truncated at ${maxBytes} bytes]` : text;
  }

  async googleUpload(conn: ConnectionRow, url: string, metadata: unknown, mediaType: string, media: string): Promise<unknown> {
    const token = await this.accessToken(conn);
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
    });
    if (!res.ok) throw new Error(`google api error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
}
