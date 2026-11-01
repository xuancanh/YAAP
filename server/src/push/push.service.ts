/**
 * PushService — web push (roadmap phase 4.3): the agent inbox reaches the
 * phone's lock screen.
 *
 *  - Subscriptions are rows in `push_subscriptions`, one per browser that
 *    turned on "Notifications on this device" in Settings → Channels. The
 *    endpoint is the identity; re-subscribing from the same browser upserts.
 *  - Delivery is the Telegram sweep pattern over its own `pushDeliveredAt`
 *    column: every minute, every deliverable event (not silent, past its
 *    quiet-hours release, not channel-born) becomes one notification per
 *    device, with a deep link to the session. 404/410 from the push service
 *    drops the subscription; other failures leave the event for the next
 *    sweep. Only when at least one device accepted the event is it marked.
 *  - Everything cryptographic lives in web-push.ts (VAPID + aes128gcm on
 *    node:crypto, no dependency). Push is off without VAPID keys; the UI
 *    toggle then explains how to generate them.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { pushSubscriptions } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { AgentsService } from '../agents/agents.service';
import { AccountsService } from '../accounts/accounts.service';
import { isValidVapidPublicKey, sendWebPush } from './web-push';

export interface SubscribeInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

const SWEEP_MS = 60_000;

@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushService.name);
  /** Test seam: the push service endpoint. */
  fetchFn: typeof fetch = fetch;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly config: ConfigService,
    private readonly agents: AgentsService,
    /** Optional: without it the sweep runs for the current (single) account. */
    @Optional() private readonly accounts?: AccountsService,
  ) {}

  private get vapid() {
    return {
      publicKey: this.config.get<string>('vapidPublicKey') ?? '',
      privateKey: this.config.get<string>('vapidPrivateKey') ?? '',
      subject: this.config.get<string>('vapidSubject') ?? 'mailto:admin@localhost',
    };
  }

  get enabled(): boolean {
    const v = this.vapid;
    return Boolean(v.publicKey && v.privateKey) && isValidVapidPublicKey(v.publicKey);
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.sweepTimer = setInterval(() => { void this.deliverSweep().catch((err) => this.logger.warn(`push sweep: ${err instanceof Error ? err.message : err}`)); }, SWEEP_MS);
    this.logger.log('Web push enabled (VAPID keys present)');
  }

  onModuleDestroy(): void { clearInterval(this.sweepTimer); }

  // ---- subscriptions ----

  async publicKey() {
    return { enabled: this.enabled, publicKey: this.enabled ? this.vapid.publicKey : '', subscriptions: (await this.list()).length };
  }

  async list() {
    return this.db.select().from(pushSubscriptions);
  }

  async subscribe(input: SubscribeInput) {
    if (!input?.endpoint || !/^https:\/\//.test(input.endpoint)) throw new Error('endpoint must be an https URL');
    if (!input.keys?.p256dh || !input.keys?.auth) throw new Error('keys.p256dh and keys.auth are required');
    const existing = (await this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, input.endpoint))).at(0);
    const patch = { p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: (input.userAgent ?? '').slice(0, 300) };
    if (existing) {
      await this.db.update(pushSubscriptions).set(patch).where(eq(pushSubscriptions.id, existing.id));
      return { ok: true, id: existing.id };
    }
    const row = { id: newId(), endpoint: input.endpoint, ...patch, createdAt: nowIso() };
    await this.db.insert(pushSubscriptions).values(row);
    return { ok: true, id: row.id };
  }

  async unsubscribe(endpoint: string) {
    if (!endpoint) return { ok: true, removed: 0 };
    const rows = await this.db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    if (rows.length > 0) await this.db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, rows.map((r) => r.id)));
    return { ok: true, removed: rows.length };
  }

  // ---- delivery ----

  /** Push every deliverable inbox event to every subscribed device. Returns
   *  how many events were marked delivered. Exposed for tests. */
  async deliverSweep(now: Date = new Date()): Promise<number> {
    if (!this.enabled || this.sweeping) return 0;
    this.sweeping = true;
    try {
      if (!this.accounts) return await this.sweepAccount(now);
      // Once per active account, each under its own context: subscriptions
      // and events are that tenant's alone (docs/accounts.md §3).
      let delivered = 0;
      await this.accounts.forEachAccount(async () => { delivered += await this.sweepAccount(now); });
      return delivered;
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepAccount(now: Date): Promise<number> {
    {
      const subs = await this.list();
      if (subs.length === 0) return 0;
      const events = (await this.agents.undeliveredEvents(now, 'push')).slice(0, 20);
      if (events.length === 0) return 0;
      const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
      const base = (this.config.get<string>('publicAppUrl') ?? 'http://localhost:5175').replace(/\/+$/, '');
      const dead = new Set<string>();
      const delivered: string[] = [];
      for (const e of events) {
        const payload = JSON.stringify({
          title: `${names.get(e.agentId) ?? 'Agent'} · ${e.title}`.slice(0, 120),
          body: e.body.replace(/\s+/g, ' ').slice(0, 240),
          tag: e.id,
          kind: e.kind,
          url: e.sessionId ? `${base}/#/chat/${e.sessionId}` : `${base}/#/home`,
        });
        let accepted = 0;
        for (const sub of subs) {
          if (dead.has(sub.id)) continue;
          try {
            const res = await sendWebPush(sub, payload, this.vapid, this.fetchFn, {
              urgency: e.kind === 'loop_error' || e.kind === 'budget_stop' ? 'high' : 'normal',
            });
            if (res.gone) dead.add(sub.id);
            else if (res.ok) accepted++;
            else this.logger.warn(`push ${sub.endpoint.slice(0, 60)}… → ${res.status}`);
          } catch (err) {
            this.logger.warn(`push failed: ${err instanceof Error ? err.message : err}`);
          }
        }
        if (accepted > 0) delivered.push(e.id);
      }
      if (dead.size > 0) await this.db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, [...dead]));
      await this.agents.markEventsDelivered(delivered, now, 'push');
      return delivered.length;
    }
  }
}
