/**
 * ConnectionsService — external service connections (docs/integrations.md).
 *
 * A connection is a user-level OAuth link to a provider (google first);
 * which agents may use it is a separate per-agent grant, off by default
 * (three-gate model: connect = creation, grant = activation, per-call
 * policy = execution). Tokens are sealed at rest (secretbox) and never
 * leave the server; list() redacts them.
 *
 * Scopes grow via Google incremental auth: first connect is read-only;
 * the write tier (calendar.events) is a separate re-consent, and a 'write'
 * grant is only accepted once the connection actually holds those scopes.
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
  ConnectionRow, GCAL_TOOLS, GOOGLE_AUTH_URL, GOOGLE_BASE_SCOPES, GOOGLE_READ_SCOPES,
  GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, GOOGLE_WRITE_SCOPES,
  GoogleHttp, hasWriteScopes,
} from './connections.tools';

type GrantRow = typeof connectionGrants.$inferSelect;

export type GrantLevel = 'read' | 'write';
export type ScopeTier = 'read' | 'write';

export interface ConnectionInfo {
  id: string;
  provider: string;
  accountEmail: string;
  scopes: string[];
  /** Whether the consented scopes cover write-tier tools. */
  writeCapable: boolean;
  createdAt: string;
  grants: Array<{ agentId: string; level: string }>;
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
        createdAt: r.createdAt,
        grants: grants.filter((g) => g.connectionId === r.id).map((g) => ({ agentId: g.agentId, level: g.level })),
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
    const scopes = tier === 'write'
      ? [...GOOGLE_BASE_SCOPES, ...GOOGLE_WRITE_SCOPES]
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

  async setGrant(connectionId: string, agentId: string, level: GrantLevel): Promise<{ ok: boolean }> {
    const row = (await this.db.select().from(connections).where(eq(connections.id, connectionId))).at(0);
    if (!row) throw new NotFoundException(`connection ${connectionId}`);
    if (level === 'write' && !hasWriteScopes(JSON.parse(row.scopes) as string[])) {
      throw new ConflictException('this connection has read-only consent — enable write access in Settings → Connections first');
    }
    const existing = (await this.db.select().from(connectionGrants)
      .where(and(eq(connectionGrants.connectionId, connectionId), eq(connectionGrants.agentId, agentId)))).at(0);
    if (existing) {
      await this.db.update(connectionGrants).set({ level }).where(eq(connectionGrants.id, existing.id));
    } else {
      await this.db.insert(connectionGrants).values({ id: newId(), connectionId, agentId, level, createdAt: nowIso() });
    }
    return { ok: true };
  }

  async revokeGrant(connectionId: string, agentId: string): Promise<{ ok: boolean }> {
    await this.db.delete(connectionGrants)
      .where(and(eq(connectionGrants.connectionId, connectionId), eq(connectionGrants.agentId, agentId)));
    return { ok: true };
  }

  /** The literal tools an agent would gain per grant level — shown in the
   *  activation review (permissions: approve the real artifact). */
  toolCatalog(): Array<{ name: string; description: string; level: string }> {
    return GCAL_TOOLS.map((t) => ({ name: t.name, description: t.description ?? '', level: t.level }));
  }

  // ---- turn-loop integration ----

  /** Connection tools visible to one agent: only where a grant exists, and
   *  only the tools that grant's level covers (write implies read). */
  async toolSpecs(agentId: string): Promise<AiToolSpec[]> {
    const granted = await this.grantedConnection(agentId);
    if (!granted) return [];
    return GCAL_TOOLS
      .filter((t) => t.level === 'read' || granted.level === 'write')
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  /** undefined = not a connection tool. */
  isReadOnly(name: string): boolean | undefined {
    return GCAL_TOOLS.find((t) => t.name === name)?.readOnly;
  }

  owns(name: string): boolean {
    return GCAL_TOOLS.some((t) => t.name === name);
  }

  async execute(agentId: string | undefined, name: string, input: Record<string, unknown>): Promise<string> {
    const tool = GCAL_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    if (!agentId) throw new Error('connection tools are available to durable agents with a granted connection only');
    const granted = await this.grantedConnection(agentId);
    if (!granted) throw new Error('no connection grant: the user has not granted this agent access to a connected calendar');
    if (tool.level === 'write' && granted.level !== 'write') {
      throw new Error(`no write grant: the user granted read access only — ${name} needs a write grant on the agent's Skills & tools tab`);
    }
    const agent = (await this.db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId))).at(0);
    return tool.execute(granted.conn, input, this, { agentName: agent?.name ?? 'an agent' });
  }

  private async grantedConnection(agentId: string): Promise<{ conn: ConnectionRow; level: GrantLevel } | undefined> {
    const grants: GrantRow[] = await this.db.select().from(connectionGrants).where(eq(connectionGrants.agentId, agentId));
    for (const g of grants) {
      const row = (await this.db.select().from(connections).where(eq(connections.id, g.connectionId))).at(0);
      if (row?.provider === 'google') return { conn: row, level: g.level === 'write' ? 'write' : 'read' };
    }
    return undefined;
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
