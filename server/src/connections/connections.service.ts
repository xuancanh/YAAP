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
import { currentAccountId } from '../accounts/account-context';
import { unscoped } from '../accounts/scoped-db';
import { agents, agentEvents, connections, connectionGrants } from '../database/schema';
import { CARDS, cardContextBlock, cardFor, cardForProfile, mcpCardFor, type CardGrantLevel, type ContextCard } from './cards';
import { newId, nowIso } from '../common/ids.util';
import { seal, open } from '../common/secretbox';
import { AiToolSpec } from '../ai/ai-provider.interface';
import {
  CONNECTION_TOOLS, ConnectionRow, ConnectionProvider as ProviderName,
  ConnectionService as ServiceName, GOOGLE_AUTH_URL, GOOGLE_BASE_SCOPES,
  GOOGLE_DRIVE_SCOPES, GOOGLE_GMAIL_READ_SCOPES, GOOGLE_GMAIL_SCOPES, GOOGLE_READ_SCOPES, GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, GOOGLE_WRITE_SCOPES,
  MS_AUTH_URL, MS_BASE_SCOPES, MS_DRIVE_SCOPES, MS_MAIL_SCOPES, MS_READ_SCOPES,
  MS_TOKEN_URL, MS_USERINFO_URL, MS_WRITE_SCOPES,
  GoogleHttp, capabilitiesFor,
} from './connections.tools';
import { pollGcal, pollGmail, pollGraphCalendar, pollGraphMail, type CalendarEventSummary, type MailPollResult } from './connections.poll';

type GrantRow = typeof connectionGrants.$inferSelect;

/** A connection whose token was revoked or could not be refreshed
 *  (docs/incidents.md §4): only the actions that need it are refused, with
 *  this error; the loop poller skips it silently (the incident is the one signal). */
export class ConnectionDegradedError extends Error {
  constructor(readonly connectionId: string, message: string) { super(message); this.name = 'ConnectionDegradedError'; }
}

export interface ConnectionHealthEvent { connectionId: string; provider: string; accountEmail: string; state: 'degraded' | 'recovered'; reason: string; at: string }
export interface ConnectionDeliveryFailure { agentId: string; connectionId: string; provider: string; service: string; tool: string; error: string; at: string }
export interface DegradedConnection { connectionId: string; provider: string; accountEmail: string; reason: string; since: string }

export type GrantLevel = 'read' | 'write';
export type ScopeTier = 'read' | 'write' | 'gmail' | 'mailread' | 'drive';

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
        : tier === 'mailread' ? [...GOOGLE_BASE_SCOPES, ...GOOGLE_GMAIL_READ_SCOPES]
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
      : tier === 'gmail' || tier === 'mailread' ? [...MS_BASE_SCOPES, ...MS_MAIL_SCOPES]
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
  /** Whether the consented scopes let the `mail` trigger poll a query. */
  mailReadCapable: boolean;
  /** Whether the consented scopes cover drive read + export tools. */
  driveCapable: boolean;
  createdAt: string;
  grants: Array<{ agentId: string; service: string; level: string; memberAccountId: string }>;
}

/** A grant that lets an agent use a *member's* connection in a shared
 *  workspace (docs/shared-agents.md §3), as the Members pane lists it. */
export interface MemberGrant {
  id: string;
  connectionId: string;
  agentId: string;
  service: string;
  level: string;
  memberAccountId: string;
  provider: string;
  accountEmail: string;
}

@Injectable()
export class ConnectionsService implements GoogleHttp {
  /** Pending OAuth states: nonce → provider + createdAt (10-minute window). */
  private readonly pendingStates = new Map<string, { provider: ProviderName; at: number }>();
  /** Test seam. */
  fetchImpl: typeof fetch = fetch;
  /** connectionId → why it is degraded (docs/incidents.md §4); in memory. */
  private readonly degradedConns = new Map<string, DegradedConnection>();
  private readonly healthListeners: Array<(ev: ConnectionHealthEvent) => void | Promise<void>> = [];
  private readonly deliveryListeners: Array<(ev: ConnectionDeliveryFailure) => void | Promise<void>> = [];

  // ---- degradation (docs/incidents.md §4, execution-plan item 29) ----

  onHealth(fn: (ev: ConnectionHealthEvent) => void | Promise<void>): () => void {
    this.healthListeners.push(fn);
    return () => { const i = this.healthListeners.indexOf(fn); if (i >= 0) this.healthListeners.splice(i, 1); };
  }

  /** Told when a mutating connection action (a send, a create) fails at the provider. */
  onDeliveryFailure(fn: (ev: ConnectionDeliveryFailure) => void | Promise<void>): () => void {
    this.deliveryListeners.push(fn);
    return () => { const i = this.deliveryListeners.indexOf(fn); if (i >= 0) this.deliveryListeners.splice(i, 1); };
  }

  private tell<T>(fns: Array<(ev: T) => void | Promise<void>>, ev: T): void {
    for (const fn of fns) { try { void Promise.resolve(fn(ev)).catch(() => undefined); } catch { /* listeners isolate their own failures */ } }
  }

  /** Mark a connection degraded; listeners hear it once per transition. */
  markDegraded(conn: Pick<ConnectionRow, 'id' | 'provider' | 'accountEmail'>, reason: string): void {
    if (this.degradedConns.has(conn.id)) return;
    const row: DegradedConnection = { connectionId: conn.id, provider: conn.provider, accountEmail: conn.accountEmail, reason: reason.slice(0, 300), since: nowIso() };
    this.degradedConns.set(conn.id, row);
    this.tell(this.healthListeners, { connectionId: conn.id, provider: conn.provider, accountEmail: conn.accountEmail, state: 'degraded', reason: row.reason, at: row.since });
  }

  markRecovered(connectionId: string, reason: string): void {
    const row = this.degradedConns.get(connectionId);
    if (!row) return;
    this.degradedConns.delete(connectionId);
    this.tell(this.healthListeners, { connectionId, provider: row.provider, accountEmail: row.accountEmail, state: 'recovered', reason, at: nowIso() });
  }

  isDegraded(connectionId: string): boolean { return this.degradedConns.has(connectionId); }

  /** What is degraded now (the org health route and the brief). */
  degraded(): DegradedConnection[] { return [...this.degradedConns.values()]; }

  /** The agents holding a grant on a connection (to find their organisations). */
  async agentsOnConnection(connectionId: string): Promise<string[]> {
    const rows = await this.db.select({ agentId: connectionGrants.agentId }).from(connectionGrants).where(eq(connectionGrants.connectionId, connectionId));
    return [...new Set(rows.map((r) => r.agentId))];
  }

  private degradedMessage(row: DegradedConnection): string {
    return `Refused: the ${row.provider} connection${row.accountEmail ? ` (${row.accountEmail})` : ''} is degraded — ${row.reason}. Only actions that need it are paused; reconnect it in Settings → Connections. Do not retry; your other tools work.`;
  }

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
        grants: grants.filter((g) => g.connectionId === r.id).map((g) => ({ agentId: g.agentId, service: g.service, level: g.level, memberAccountId: g.memberAccountId })),
      };
    });
  }

  /** The connections of one account, redacted — what a member sees of their
   *  own services while acting in someone else's workspace. Unscoped on
   *  purpose: the caller's context is the workspace owner's account. */
  async listOwnedBy(accountId: string): Promise<Array<Omit<ConnectionInfo, 'grants'>>> {
    const rows = await unscoped(this.db).select().from(connections).where(eq(connections.accountId, accountId));
    return rows.map((r) => {
      const scopes = JSON.parse(r.scopes) as string[];
      return { id: r.id, provider: r.provider, accountEmail: r.accountEmail, scopes, ...capabilitiesFor(r.provider as ProviderName, scopes), createdAt: r.createdAt };
    });
  }

  /** Grants in this workspace's account that use a member's connection. */
  async memberGrants(): Promise<MemberGrant[]> {
    const grants = (await this.db.select().from(connectionGrants)).filter((g) => g.memberAccountId !== '');
    const out: MemberGrant[] = [];
    for (const g of grants) {
      const conn = await this.connectionRow(g.connectionId, g.memberAccountId);
      out.push({ id: g.id, connectionId: g.connectionId, agentId: g.agentId, service: g.service, level: g.level, memberAccountId: g.memberAccountId, provider: conn?.provider ?? '', accountEmail: conn?.accountEmail ?? '' });
    }
    return out;
  }

  async removeMemberGrant(grantId: string, onlyIfMember?: string): Promise<{ ok: boolean }> {
    const g = (await this.db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId))).at(0);
    if (!g) throw new NotFoundException(`grant ${grantId}`);
    if (onlyIfMember !== undefined && g.memberAccountId !== onlyIfMember) throw new ConflictException('you can only remove grants on your own connections');
    await this.db.delete(connectionGrants).where(eq(connectionGrants.id, grantId));
    return { ok: true };
  }

  /** The connection row a grant points at. The owner's grants ('' member)
   *  resolve in the current account; a member's in *their* account — the one
   *  cross-account read this service makes, keyed by both id and owner so a
   *  guessed id in another account cannot be reached. */
  private async connectionRow(connectionId: string, memberAccountId: string): Promise<ConnectionRow | undefined> {
    if (!memberAccountId) return (await this.db.select().from(connections).where(eq(connections.id, connectionId))).at(0);
    return (await unscoped(this.db).select().from(connections)
      .where(and(eq(connections.id, connectionId), eq(connections.accountId, memberAccountId))).limit(1)).at(0);
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
      accountId: currentAccountId(),
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
    this.markRecovered(row.id, 'reconnected');
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
    this.markRecovered(id, 'disconnected');
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

  async setGrant(connectionId: string, agentId: string, service: ServiceName, level: GrantLevel, opts: { memberAccountId?: string } = {}): Promise<{ ok: boolean }> {
    // A member's grant names their own connection, which lives in their
    // account; the owner's names one in this account. Either way the row
    // must exist *there* — a member cannot grant the owner's connection.
    const memberAccountId = opts.memberAccountId && opts.memberAccountId !== currentAccountId() ? opts.memberAccountId : '';
    const row = await this.connectionRow(connectionId, memberAccountId);
    if (!row) throw new NotFoundException(`connection ${connectionId}${memberAccountId ? ' (not one of yours)' : ''}`);
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
      .where(and(eq(connectionGrants.connectionId, connectionId), eq(connectionGrants.agentId, agentId), eq(connectionGrants.service, service), eq(connectionGrants.memberAccountId, memberAccountId)))).at(0);
    if (existing) {
      await this.db.update(connectionGrants).set({ level }).where(eq(connectionGrants.id, existing.id));
    } else {
      await this.db.insert(connectionGrants).values({ id: newId(), connectionId, agentId, service, level, memberAccountId, createdAt: nowIso() });
    }
    // The card's suggested uses as one-click installs (docs/integrations.md
    // "Context cards"): one inbox event per new grant, carrying the card id.
    const card = cardFor(row.provider, service);
    if (card && !existing) {
      const uses = card.suggestedUses.filter((u) => u.grantLevel === 'read' || level === 'write');
      await this.db.insert(agentEvents).values({
        id: newId(), agentId, kind: 'info',
        // A member's grant is their business (docs/shared-agents.md §3); the
        // owner's is for everyone. Informational: silent, never pushed, and
        // already read so it never lights the inbox badge — the Skills &
        // tools tab shows the same installs next to the grant.
        forMemberAccountId: memberAccountId,
        title: `New connection: ${card.title} — ${uses.length} suggested use${uses.length === 1 ? '' : 's'}`,
        body: uses.map((u) => `- ${u.title}`).join('\n').slice(0, 1_000),
        payload: JSON.stringify({ cardId: card.id, service, level, useIds: uses.map((u) => u.id) }),
        sessionId: null, readAt: nowIso(), createdAt: nowIso(), deliverAfter: null, silent: 1, origin: 'system', channel: 0, deliveredAt: null,
      }).catch(() => {});
    }
    return { ok: true };
  }

  // ---- context cards (docs/integrations.md "Context cards and suggested loops") ----

  /** The grant levels an agent holds, per provider and service — the
   *  activation gate as data, for cards and the install route. */
  async grantLevels(agentId: string, initiator = ''): Promise<Array<{ provider: ProviderName; service: ServiceName; level: GrantLevel }>> {
    const granted = await this.grantedConnections(agentId, initiator);
    const out: Array<{ provider: ProviderName; service: ServiceName; level: GrantLevel }> = [];
    for (const provider of Object.keys(granted) as ProviderName[]) {
      const levels = granted[provider]!.levels;
      for (const service of Object.keys(levels) as ServiceName[]) out.push({ provider, service, level: levels[service]! });
    }
    return out;
  }

  /** The static catalog, uses ranked for `profile` when given. */
  cards(profile?: string | null): ContextCard[] {
    return CARDS.map((c) => cardForProfile(c, profile));
  }

  /** Cards the agent holds a grant on (connection cards only), with the
   *  level held. Other surfaces (browser, computer, MCP) are added by the
   *  turn loop, which knows what is available. */
  async heldCards(agentId: string, initiator = ''): Promise<Array<{ card: ContextCard; level: CardGrantLevel }>> {
    const held: Array<{ card: ContextCard; level: CardGrantLevel }> = [];
    for (const g of await this.grantLevels(agentId, initiator)) {
      const card = cardFor(g.provider, g.service);
      if (card) held.push({ card, level: g.level });
    }
    return held;
  }

  /** The compact system-context block for this agent: its connection cards
   *  plus the surface cards the caller says are available. Null when the
   *  agent holds nothing. */
  async cardContext(agentId: string, initiator = '', available: { browser?: boolean; computer?: boolean; mcp?: Array<{ id: string; name: string; tools: string | string[] }> } = {}): Promise<string | null> {
    const held = await this.heldCards(agentId, initiator);
    if (available.browser) held.push({ card: CARDS.find((c) => c.id === 'browser')!, level: 'write' });
    if (available.computer) held.push({ card: CARDS.find((c) => c.id === 'computer')!, level: 'write' });
    for (const server of available.mcp ?? []) held.push({ card: mcpCardFor(server), level: 'write' });
    return cardContextBlock(held);
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
  async toolSpecs(agentId: string, initiator = ''): Promise<AiToolSpec[]> {
    const granted = await this.grantedConnections(agentId, initiator);
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

  /**
   * Whose connection a call would use (docs/shared-agents.md §3): the
   * initiating member's own grant when they hold one for the service, else the
   * agent's default (the owner's). '' = the owner. Null when the agent has no
   * usable grant at all, or the tool is not a connection tool.
   */
  async resolveConnectionOwner(agentId: string, name: string, initiator = ''): Promise<string | null> {
    const tool = CONNECTION_TOOLS.find((t) => t.name === name);
    if (!tool) return null;
    const granted = (await this.grantedConnections(agentId, initiator))[tool.provider];
    if (!granted || granted.levels[tool.service] === undefined) return null;
    return granted.memberAccountId;
  }

  async execute(agentId: string | undefined, name: string, input: Record<string, unknown>, opts: { initiator?: string } = {}): Promise<string> {
    const tool = CONNECTION_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    if (!agentId) throw new Error('connection tools are available to durable agents with a granted connection only');
    const granted = (await this.grantedConnections(agentId, opts.initiator ?? ''))[tool.provider];
    const level = granted?.levels[tool.service];
    if (!granted || level === undefined) {
      throw new Error(`no connection grant: the user has not granted this agent ${tool.service} access on ${tool.provider} — grants live on the agent's Skills & tools tab`);
    }
    if (tool.level === 'write' && level !== 'write') {
      throw new Error(`no write grant: the user granted read access only — ${name} needs a write grant on the agent's Skills & tools tab`);
    }
    const degraded = this.degradedConns.get(granted.conn.id);
    if (degraded) throw new ConnectionDegradedError(granted.conn.id, this.degradedMessage(degraded));
    const agent = (await this.db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId))).at(0);
    try {
      return await tool.execute(granted.conn, input, this, { agentName: agent?.name ?? 'an agent' });
    } catch (err) {
      // An external bounce (docs/incidents.md §2): a mutating action the provider refused.
      if (!tool.readOnly && !(err instanceof ConnectionDegradedError) && !this.degradedConns.has(granted.conn.id) && !/^token refresh failed/.test(err instanceof Error ? err.message : '')) {
        this.tell(this.deliveryListeners, { agentId, connectionId: granted.conn.id, provider: tool.provider, service: tool.service, tool: name, error: (err instanceof Error ? err.message : String(err)).slice(0, 300), at: nowIso() });
      }
      throw err;
    }
  }

  // ---- event-trigger polling (docs/triggers.md) ----

  /** The connection a trigger may poll on this agent's behalf: one the agent
   *  holds a grant for on `service` (any level — reads are the floor), on
   *  `provider`, optionally pinned to a connection id. Same activation gate
   *  as the tools: no grant, no poll. */
  async connectionFor(agentId: string, provider: ProviderName, service: ServiceName, connectionId?: string): Promise<ConnectionRow> {
    // Triggers poll unattended, on the owner's behalf: only default grants.
    const grants: GrantRow[] = await this.db.select().from(connectionGrants)
      .where(and(eq(connectionGrants.agentId, agentId), eq(connectionGrants.service, service), eq(connectionGrants.memberAccountId, '')));
    for (const g of grants) {
      if (connectionId && g.connectionId !== connectionId) continue;
      const row = (await this.db.select().from(connections).where(eq(connections.id, g.connectionId))).at(0);
      if (row && row.provider === provider) {
        const degraded = this.degradedConns.get(row.id);
        if (degraded) throw new ConnectionDegradedError(row.id, this.degradedMessage(degraded));
        return row;
      }
    }
    throw new Error(`no ${service} grant on a ${provider} connection for this agent${connectionId ? ` (connection ${connectionId})` : ''} — grant it on the agent's Skills & tools tab`);
  }

  /** Mail poll for the `mail` trigger: ids matching the query plus
   *  summaries (from, subject, snippet, date — no bodies) of unseen ones. */
  async fetchMail(agentId: string, opts: { service: 'gmail' | 'msmail'; connectionId?: string; query: string; knownIds: Set<string> }): Promise<MailPollResult> {
    const provider: ProviderName = opts.service === 'gmail' ? 'google' : 'microsoft';
    const conn = await this.connectionFor(agentId, provider, 'gmail', opts.connectionId);
    if (!capabilitiesFor(provider, JSON.parse(conn.scopes) as string[]).mailReadCapable) {
      throw new Error('this Gmail connection has no read consent — enable "Gmail reading" in Settings → Connections (the mail trigger polls a query; the tools still never read mail)');
    }
    return provider === 'google'
      ? pollGmail(conn, this, opts.query, opts.knownIds)
      : pollGraphMail(conn, this, opts.query, opts.knownIds);
  }

  /** Calendar poll for the `calendar` trigger: events in the next N hours. */
  async fetchCalendarWindow(agentId: string, opts: { service: 'gcal' | 'mscal'; connectionId?: string; withinHours: number; now?: Date }): Promise<CalendarEventSummary[]> {
    const provider: ProviderName = opts.service === 'gcal' ? 'google' : 'microsoft';
    const conn = await this.connectionFor(agentId, provider, 'calendar', opts.connectionId);
    const now = opts.now ?? new Date();
    return provider === 'google'
      ? pollGcal(conn, this, now, opts.withinHours)
      : pollGraphCalendar(conn, this, now, opts.withinHours);
  }

  /**
   * All connections this agent may use, keyed by provider, with per-service
   * grant levels. An agent can hold grants on google and microsoft at once.
   *
   * With an `initiator` (the member who started the turn, '' for the owner),
   * that member's own grants win for the services they cover; the owner's
   * default grants fill the rest. A member's connection is never used for a
   * turn another member started unless that member holds the grant — the
   * "no implicit cross-member connection use" rule.
   */
  private async grantedConnections(agentId: string, initiator = ''): Promise<Partial<Record<ProviderName, { conn: ConnectionRow; memberAccountId: string; levels: Partial<Record<ServiceName, GrantLevel>> }>>> {
    const all: GrantRow[] = await this.db.select().from(connectionGrants).where(eq(connectionGrants.agentId, agentId));
    if (all.length === 0) return {};
    const own = initiator && initiator !== currentAccountId() ? initiator : '';
    const mine = all.filter((g) => g.memberAccountId === own);
    const defaults = own ? all.filter((g) => g.memberAccountId === '') : [];
    const out: Partial<Record<ProviderName, { conn: ConnectionRow; memberAccountId: string; levels: Partial<Record<ServiceName, GrantLevel>> }>> = {};
    for (const g of [...mine, ...defaults]) {
      const row = await this.connectionRow(g.connectionId, g.memberAccountId);
      if (!row || !isProviderName(row.provider)) continue;
      const entry = out[row.provider] ?? (out[row.provider] = { conn: row, memberAccountId: g.memberAccountId, levels: {} });
      // One connection per provider per turn: the first (the initiator's own
      // when they have one) wins; a default grant never widens it.
      if (entry.conn.id !== row.id) continue;
      if (entry.levels[g.service as ServiceName] !== undefined) continue;
      entry.levels[g.service as ServiceName] = g.level === 'write' ? 'write' : 'read';
    }
    return out;
  }

  // ---- Google HTTP with refresh ----

  private async accessToken(conn: ConnectionRow): Promise<string> {
    const fresh = conn.expiresAt && new Date(conn.expiresAt).getTime() - Date.now() > 60_000;
    if (fresh && conn.accessToken) return open(conn.accessToken);
    if (!conn.refreshToken) {
      this.markDegraded(conn, 'it has no refresh token');
      throw new ConnectionDegradedError(conn.id, 'connection has no refresh token — reconnect the account in Settings');
    }
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
    if (!res.ok) {
      // 400 invalid_grant / 401: the grant was revoked or expired — degrade
      // the connection (one incident), not every call that needs it.
      if (res.status === 400 || res.status === 401 || res.status === 403) this.markDegraded(conn, `its token could not be refreshed (${res.status}): access was revoked or expired`);
      throw new Error(`token refresh failed (${res.status}) — reconnect the account in Settings`);
    }
    const tok = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    this.markRecovered(conn.id, 'token refreshed');
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
    if (res.status === 401) this.markDegraded(conn, 'the provider rejected its access token (401)');
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
    if (res.status === 401) this.markDegraded(conn, 'the provider rejected its access token (401)');
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
    if (res.status === 401) this.markDegraded(conn, 'the provider rejected its access token (401)');
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
    if (res.status === 401) this.markDegraded(conn, 'the provider rejected its access token (401)');
    if (!res.ok) throw new Error(`google api error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
}
