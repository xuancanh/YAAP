/**
 * AccountsService — the account domain (docs/accounts.md): who the tenants
 * are, how a browser proves it is one of them, what each plan allows, and
 * how much each has spent this month.
 *
 *  - Identity: email + magic link. `requestLink` creates a pending account
 *    for a new address and mails (or logs) a one-time link; `consumeLink`
 *    activates the account and mints a session. Tokens are random, stored
 *    as SHA-256, and never signed — nothing to leak but a hash.
 *  - Plans: free | hosted | byo (plans.ts), changed only through
 *    BillingProvider — today the manual admin route.
 *  - Ceilings: `resolveProviderKey` decides whether a turn runs on the
 *    account's own key or a platform key, and refuses with 402 when the
 *    hosted ceiling is spent; `recordUsage` keeps the month's rollup.
 *    Platform-key dollars are priced from the list table only — a user's
 *    `pricingOverrides` setting cannot lower what the ceiling sees.
 *  - Background work: `activeAccountIds` is what every sweep iterates, and
 *    `accountOfAgent` / `findAccountIdBySetting` resolve whose agent a
 *    webhook, inbound mail or Telegram message is for.
 *
 * Reads its own tables through the unscoped handle (scoped-db.ts): sessions
 * are looked up before an account is bound, and the admin list crosses
 * accounts by definition. In AUTH_MODE=single every method answers for the
 * one 'single' account, which is on `byo` with no ceilings.
 */
import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { accountLoginTokens, accountSessions, accountUsage, accounts, agents, appSettings } from '../database/schema';
import { newId } from '../common/ids.util';
import { createEmailSender, type EmailSender } from '../channels/email-sender';
import { LIST_PRICES, usdFor } from '../ai/pricing';
import { monthKey } from '../workspaces/spend.util';
import { SINGLE_ACCOUNT, currentAccountId, runWithAccount } from './account-context';
import { unscoped } from './scoped-db';
import { BILLING_PROVIDER, ManualBillingProvider, type BillingProvider } from './billing-provider';
import { isPlan, limitsFor, type Plan, type PlanLimits } from './plans';

export type AccountRow = typeof accounts.$inferSelect;
export type AuthMode = 'single' | 'accounts';

export interface AccountUsageMonth {
  month: string;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  hostedUsd: number;
  turns: number;
}

/** GET /api/account. */
export interface AccountSummary {
  mode: AuthMode;
  id: string;
  email: string;
  name: string;
  plan: Plan;
  status: string;
  isAdmin: boolean;
  limits: PlanLimits;
  usage: AccountUsageMonth;
  /** Providers the hosted plan can spend from on this deployment. */
  platformProviders: string[];
  billing: { provider: string; manageUrl: string | null };
}

/** 402: the plan does not allow the thing. */
export class PlanLimitException extends HttpException {
  constructor(message: string) { super(message, HttpStatus.PAYMENT_REQUIRED); }
}

export const SESSION_COOKIE = 'yaam_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const LINK_TTL_MS = 15 * 60_000;
const LINK_WINDOW_MS = 15 * 60_000;
export const LINK_LIMIT_PER_EMAIL = 3;
export const LINK_LIMIT_PER_IP = 20;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const usdToMicros = (usd: number) => Math.round(usd * 1_000_000);

type Hook = (accountId: string) => Promise<void>;

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);
  private readonly db: DrizzleDb;
  /** Test seam: where magic links go. */
  sender: EmailSender;
  private readonly billing: BillingProvider;
  private readonly linkHits = new Map<string, number[]>();
  private readonly activatedHooks: Hook[] = [];

  constructor(
    @Inject(DRIZZLE_DB) db: DrizzleDb,
    private readonly config: ConfigService,
    @Optional() @Inject(BILLING_PROVIDER) billing?: BillingProvider,
  ) {
    // Account tables are read before any account is bound; see header.
    this.db = unscoped(db);
    this.billing = billing ?? new ManualBillingProvider();
    this.sender = createEmailSender({
      provider: this.config.get<string>('emailSendProvider') ?? 'off',
      token: this.config.get<string>('emailSendToken') ?? '',
      cfAccountId: this.config.get<string>('emailCfAccountId') ?? '',
    });
  }

  get mode(): AuthMode {
    return this.config.get<string>('authMode') === 'accounts' ? 'accounts' : 'single';
  }

  // ---- lookup ----

  async get(id: string): Promise<AccountRow | null> {
    return (await this.db.select().from(accounts).where(eq(accounts.id, id)).limit(1)).at(0) ?? null;
  }

  async findByEmail(email: string): Promise<AccountRow | null> {
    return (await this.db.select().from(accounts).where(eq(accounts.email, email)).limit(1)).at(0) ?? null;
  }

  /** The account of the current context. Tolerant: a missing single row
   *  (a database older than migration 0023 mid-boot) reads as the byo single
   *  account rather than failing every request. */
  async current(): Promise<AccountRow> {
    const id = currentAccountId();
    const row = await this.get(id);
    if (row) return row;
    if (id === SINGLE_ACCOUNT) return { id, email: '', name: 'Single user', status: 'active', plan: 'byo', createdAt: '', lastSeenAt: null };
    throw new UnauthorizedException('account not found');
  }

  /** Every account background work should run for. */
  async activeAccountIds(): Promise<string[]> {
    if (this.mode === 'single') return [SINGLE_ACCOUNT];
    const rows = await this.db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.status, 'active'), ne(accounts.id, SINGLE_ACCOUNT)));
    return rows.map((r) => r.id);
  }

  /** Run `fn` once per active account, under that account. Errors are
   *  isolated per account so one tenant's failure never stalls the rest. */
  async forEachAccount(fn: (accountId: string) => Promise<void>): Promise<void> {
    for (const id of await this.activeAccountIds()) {
      try {
        await runWithAccount(id, () => fn(id));
      } catch (err) {
        this.logger.warn(`account ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Which account owns an agent — for routes whose caller is a third-party
   *  system (webhooks, inbound mail) that knows an agent, not an account. */
  async accountOfAgent(agentId: string): Promise<string | null> {
    const rows = await this.db.select({ accountId: agents.accountId }).from(agents).where(eq(agents.id, agentId)).limit(1);
    return rows.at(0)?.accountId ?? null;
  }

  /** Which account has `key` = `value` in its settings (the paired Telegram
   *  chat id). Null when none. */
  async findAccountIdBySetting(key: string, value: string): Promise<string | null> {
    if (!value) return null;
    const rows = await this.db.select({ accountId: appSettings.accountId }).from(appSettings)
      .where(and(eq(appSettings.key, key), eq(appSettings.value, value))).limit(1);
    return rows.at(0)?.accountId ?? null;
  }

  /** Register per-account seeding (built-in skills, the default workspace):
   *  runs under the new account the first time it signs in. */
  onAccountActivated(hook: Hook): void {
    this.activatedHooks.push(hook);
  }

  // ---- magic link ----

  /** Request a sign-in link. Always answers the same for known and unknown
   *  addresses; rate-limited per address and per caller. */
  async requestLink(rawEmail: string, meta: { ip?: string } = {}, now: Date = new Date()): Promise<{ ok: true; sent: boolean }> {
    if (this.mode !== 'accounts') throw new ForbiddenException('AUTH_MODE=single: sign-in is not used');
    const email = (rawEmail ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpException('a valid email address is required', HttpStatus.BAD_REQUEST);
    this.rateLimit(`email:${email}`, LINK_LIMIT_PER_EMAIL, now);
    if (meta.ip) this.rateLimit(`ip:${meta.ip}`, LINK_LIMIT_PER_IP, now);

    let account = await this.findByEmail(email);
    if (!account) {
      const plan = this.config.get<string>('accountsDefaultPlan');
      account = {
        id: newId(), email, name: '', status: 'pending',
        plan: isPlan(plan) ? plan : 'free', createdAt: now.toISOString(), lastSeenAt: null,
      };
      await this.db.insert(accounts).values(account);
    }
    if (account.status === 'disabled') return { ok: true, sent: false }; // same answer, no mail

    const token = randomBytes(32).toString('base64url');
    await this.db.insert(accountLoginTokens).values({
      id: newId(), accountId: account.id, email, tokenHash: sha256(token),
      expiresAt: new Date(now.getTime() + LINK_TTL_MS).toISOString(), usedAt: null, createdAt: now.toISOString(),
    });
    const base = (this.config.get<string>('publicBaseUrl') ?? 'http://localhost:8790').replace(/\/+$/, '');
    const link = `${base}/api/auth/callback?token=${encodeURIComponent(token)}`;

    if (this.sender.name === 'off') {
      this.logger.log(`magic link for ${email} (EMAIL_SEND_PROVIDER=off, dev only): ${link}`);
      return { ok: true, sent: false };
    }
    const domain = this.config.get<string>('emailDomain') ?? '';
    const address = this.config.get<string>('authFromAddress') || (domain ? `login@${domain}` : 'login@localhost');
    await this.sender.send({
      to: email,
      from: { address, name: this.config.get<string>('emailFromName') ?? 'YAAM' },
      subject: 'Your sign-in link',
      text: `Open this link to sign in (valid for 15 minutes, one use):\n\n${link}\n\nIf you did not ask for it, ignore this message.`,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    return { ok: true, sent: true };
  }

  /** Redeem a link: one use, within its 15 minutes. Returns the session
   *  token for the cookie. First sign-in activates the account and runs the
   *  seeding hooks under it. */
  async consumeLink(token: string, userAgent = '', now: Date = new Date()): Promise<{ accountId: string; sessionToken: string; expiresAt: string }> {
    if (!token) throw new UnauthorizedException('missing token');
    const row = (await this.db.select().from(accountLoginTokens).where(eq(accountLoginTokens.tokenHash, sha256(token))).limit(1)).at(0);
    if (!row || row.usedAt || row.expiresAt <= now.toISOString()) throw new UnauthorizedException('this sign-in link is invalid or has expired');
    await this.db.update(accountLoginTokens).set({ usedAt: now.toISOString() }).where(eq(accountLoginTokens.id, row.id));
    const account = await this.get(row.accountId);
    if (!account || account.status === 'disabled') throw new UnauthorizedException('account unavailable');
    if (account.status === 'pending') {
      await this.db.update(accounts).set({ status: 'active', lastSeenAt: now.toISOString() }).where(eq(accounts.id, account.id));
      for (const hook of this.activatedHooks) {
        await runWithAccount(account.id, () => hook(account.id)).catch((err: unknown) => {
          this.logger.warn(`activation hook failed for ${account.id}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } else {
      await this.db.update(accounts).set({ lastSeenAt: now.toISOString() }).where(eq(accounts.id, account.id));
    }
    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    await this.db.insert(accountSessions).values({
      id: newId(), accountId: account.id, tokenHash: sha256(sessionToken), expiresAt,
      userAgent: userAgent.slice(0, 300), createdAt: now.toISOString(),
    });
    return { accountId: account.id, sessionToken, expiresAt };
  }

  /** The account behind a session cookie, or null. */
  async resolveSession(token: string | undefined, now: Date = new Date()): Promise<AccountRow | null> {
    if (!token) return null;
    const s = (await this.db.select().from(accountSessions).where(eq(accountSessions.tokenHash, sha256(token))).limit(1)).at(0);
    if (!s) return null;
    if (s.expiresAt <= now.toISOString()) {
      await this.db.delete(accountSessions).where(eq(accountSessions.id, s.id));
      return null;
    }
    const account = await this.get(s.accountId);
    return account && account.status === 'active' ? account : null;
  }

  async revokeSession(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.delete(accountSessions).where(eq(accountSessions.tokenHash, sha256(token)));
  }

  /** Suite front door (experimental): a verified JWT names an account by id
   *  and email; make sure the row exists and is active. */
  async ensureFromSuite(id: string, email: string, now: Date = new Date()): Promise<AccountRow> {
    const existing = await this.get(id);
    if (existing) {
      if (existing.status === 'disabled') throw new UnauthorizedException('account disabled');
      return existing;
    }
    const plan = this.config.get<string>('accountsDefaultPlan');
    const row: AccountRow = { id, email: email.toLowerCase(), name: '', status: 'active', plan: isPlan(plan) ? plan : 'free', createdAt: now.toISOString(), lastSeenAt: now.toISOString() };
    await this.db.insert(accounts).values(row);
    for (const hook of this.activatedHooks) await runWithAccount(id, () => hook(id)).catch(() => {});
    return row;
  }

  private rateLimit(key: string, limit: number, now: Date): void {
    const hits = (this.linkHits.get(key) ?? []).filter((t) => now.getTime() - t < LINK_WINDOW_MS);
    if (hits.length >= limit) throw new HttpException('too many sign-in links requested; try again in a few minutes', HttpStatus.TOO_MANY_REQUESTS);
    hits.push(now.getTime());
    this.linkHits.set(key, hits);
    if (this.linkHits.size > 10_000) this.linkHits.clear();
  }

  // ---- admin ----

  isAdmin(account: Pick<AccountRow, 'id' | 'email'>): boolean {
    if (this.mode === 'single') return true;
    const list = (this.config.get<string>('adminEmails') ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    return Boolean(account.email) && list.includes(account.email.toLowerCase());
  }

  async listAccounts(): Promise<AccountRow[]> {
    return this.db.select().from(accounts);
  }

  async setPlan(id: string, plan: unknown, by: string): Promise<AccountRow> {
    if (!isPlan(plan)) throw new HttpException('plan must be free, hosted or byo', HttpStatus.BAD_REQUEST);
    const account = await this.get(id);
    if (!account) throw new HttpException(`account ${id}`, HttpStatus.NOT_FOUND);
    await this.db.update(accounts).set({ plan }).where(eq(accounts.id, id));
    await this.billing.onPlanChanged(id, plan, by);
    return { ...account, plan };
  }

  async setStatus(id: string, status: unknown): Promise<AccountRow> {
    if (status !== 'active' && status !== 'disabled') throw new HttpException('status must be active or disabled', HttpStatus.BAD_REQUEST);
    const account = await this.get(id);
    if (!account) throw new HttpException(`account ${id}`, HttpStatus.NOT_FOUND);
    await this.db.update(accounts).set({ status }).where(eq(accounts.id, id));
    if (status === 'disabled') await this.db.delete(accountSessions).where(eq(accountSessions.accountId, id));
    return { ...account, status };
  }

  // ---- plans, ceilings, usage ----

  limits(account: Pick<AccountRow, 'plan'>): PlanLimits {
    const plan: Plan = isPlan(account.plan) ? account.plan : 'free';
    return limitsFor(plan, this.config.get<number>('hostedPlanUsd') ?? 15);
  }

  platformProviders(): string[] {
    const keys = this.config.get<Record<string, string>>('platformKeys') ?? {};
    return Object.entries(keys).filter(([, v]) => Boolean(v)).map(([k]) => k);
  }

  async usageThisMonth(accountId = currentAccountId(), now: Date = new Date()): Promise<AccountUsageMonth> {
    const month = monthKey(now);
    const row = (await this.db.select().from(accountUsage).where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.month, month))).limit(1)).at(0);
    return {
      month,
      tokensIn: row?.tokensIn ?? 0,
      tokensOut: row?.tokensOut ?? 0,
      usd: (row?.usdMicros ?? 0) / 1_000_000,
      hostedUsd: (row?.hostedUsdMicros ?? 0) / 1_000_000,
      turns: row?.turns ?? 0,
    };
  }

  /** One upsert per settled turn; concurrent turns must not lose increments. */
  async recordUsage(input: { model: string; tokensIn: number; tokensOut: number; hosted: boolean }, now: Date = new Date()): Promise<void> {
    if (input.tokensIn + input.tokensOut <= 0) return;
    const usd = usdFor(input.model, input.tokensIn, input.tokensOut, {}) ?? 0;
    const micros = usdToMicros(usd);
    const hostedMicros = input.hosted ? micros : 0;
    await this.db.insert(accountUsage).values({
      accountId: currentAccountId(), month: monthKey(now),
      tokensIn: input.tokensIn, tokensOut: input.tokensOut,
      usdMicros: micros, hostedUsdMicros: hostedMicros, turns: 1, updatedAt: now.toISOString(),
    }).onConflictDoUpdate({
      target: [accountUsage.accountId, accountUsage.month],
      set: {
        tokensIn: sql`${accountUsage.tokensIn} + ${input.tokensIn}`,
        tokensOut: sql`${accountUsage.tokensOut} + ${input.tokensOut}`,
        usdMicros: sql`${accountUsage.usdMicros} + ${micros}`,
        hostedUsdMicros: sql`${accountUsage.hostedUsdMicros} + ${hostedMicros}`,
        turns: sql`${accountUsage.turns} + 1`,
        updatedAt: now.toISOString(),
      },
    });
  }

  async summary(now: Date = new Date()): Promise<AccountSummary> {
    const account = await this.current();
    const plan: Plan = isPlan(account.plan) ? account.plan : 'free';
    return {
      mode: this.mode,
      id: account.id,
      email: account.email,
      name: account.name,
      plan,
      status: account.status,
      isAdmin: this.isAdmin(account),
      limits: this.limits(account),
      usage: await this.usageThisMonth(account.id, now),
      platformProviders: this.platformProviders(),
      billing: { provider: this.billing.name, manageUrl: await this.billing.manageUrl(account.id) },
    };
  }

  /** Called before an agent row is written. `existing` = agents the account
   *  already has. */
  async assertCanCreateAgent(existing: number): Promise<void> {
    const limits = this.limits(await this.current());
    if (limits.maxAgents > 0 && existing >= limits.maxAgents) {
      throw new PlanLimitException(`the free plan allows ${limits.maxAgents} agents; delete one or upgrade in Settings → Account`);
    }
  }

  /** Called before an agent's loops are written. `enabledTotal` = enabled
   *  loops across all of the account's agents after the write. */
  async assertLoopCap(enabledTotal: number): Promise<void> {
    const limits = this.limits(await this.current());
    if (limits.maxLoops > 0 && enabledTotal > limits.maxLoops) {
      throw new PlanLimitException(`the free plan allows ${limits.maxLoops} enabled loops across your agents; pause one or upgrade in Settings → Account`);
    }
  }

  /**
   * Which key a turn runs on. An own key always wins and is never metered
   * against the hosted ceiling. Without one: the hosted plan spends a
   * platform key while the month's hosted dollars stay under the ceiling;
   * every other plan is told to add a key. `echo` needs none.
   */
  async resolveProviderKey(provider: string, ownKey: string | null | undefined, now: Date = new Date()): Promise<{ apiKey?: string; hosted: boolean }> {
    if (ownKey) return { apiKey: ownKey, hosted: false };
    if (provider === 'echo') return { hosted: false };
    const account = await this.current();
    const limits = this.limits(account);
    if (!limits.hostedKeys) {
      throw new PlanLimitException(`no API key for ${provider}: the ${account.plan} plan runs on your own keys — add one in Settings → Account`);
    }
    const platform = (this.config.get<Record<string, string>>('platformKeys') ?? {})[provider] ?? '';
    if (!platform) throw new PlanLimitException(`the hosted plan has no platform key for ${provider}; add your own key in Settings → Account`);
    if (limits.hostedUsd > 0) {
      const usage = await this.usageThisMonth(account.id, now);
      if (usage.hostedUsd >= limits.hostedUsd) {
        throw new PlanLimitException(`monthly hosted ceiling reached ($${usage.hostedUsd.toFixed(2)} of $${limits.hostedUsd.toFixed(2)}); add your own key in Settings → Account or wait for the month to turn`);
      }
    }
    return { apiKey: platform, hosted: true };
  }

  /** Response headers the turn route sets so a client sees the month at a
   *  glance without a second request. */
  async usageHeaders(now: Date = new Date()): Promise<Record<string, string>> {
    const account = await this.current();
    const usage = await this.usageThisMonth(account.id, now);
    const limits = this.limits(account);
    return {
      'X-Yaam-Plan': isPlan(account.plan) ? account.plan : 'free',
      'X-Yaam-Usage-Usd': usage.usd.toFixed(4),
      'X-Yaam-Hosted-Usd': usage.hostedUsd.toFixed(4),
      'X-Yaam-Ceiling-Usd': limits.hostedUsd.toFixed(2),
    };
  }

  /** Session lifetime, for the cookie. */
  sessionTtlMs(): number { return SESSION_TTL_MS; }

  /** Models the list table knows — surfaced so the Account pane can say
   *  which hosted models are priced. */
  pricedModels(): string[] { return Object.keys(LIST_PRICES); }
}
