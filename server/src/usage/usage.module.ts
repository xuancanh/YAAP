/**
 * UsageModule — the cost dashboard (roadmap phase 2.5): tokens and dollars
 * over time, per agent and per loop, from the turn records that already
 * exist. Nothing is metered separately; chat_turns.tokensIn/tokensOut joined
 * to their sessions is the ledger, priced through ai/pricing.ts with the
 * `pricingOverrides` setting merged over the list table.
 *
 *  GET /api/agents/:id/usage?days=30      per-day series + per-kind buckets
 *  GET /api/workspaces/:id/usage?days=30  the same across every agent, plus
 *                                          the month's spend against budget
 *  GET /api/usage/pricing                  the merged price table, so the UI
 *                                          can put dollars next to a token
 *                                          meter without a round trip per chat
 */
import { Controller, Get, Inject, Injectable, Module, Param, Query } from '@nestjs/common';
import { eq, gte, inArray, and } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents, agentTypes, chatSessions, chatTurns, workspaces } from '../database/schema';
import { SettingsModule, SettingsService } from '../settings/settings.module';
import { LIST_PRICES, mergedPriceTable, parsePriceOverrides, PriceTable, usdFor } from '../ai/pricing';
import { spendStatus, SpendStatus } from '../workspaces/spend.util';

export interface UsageDay { day: string; tokensIn: number; tokensOut: number; usd: number }

/** One row of the per-kind breakdown: the agent's chats as a whole, each
 *  loop by name, and channel conversations. */
export interface UsageBucket {
  key: string;
  label: string;
  kind: 'chat' | 'loop' | 'channel';
  tokensIn: number;
  tokensOut: number;
  usd: number;
  turns: number;
  /** The loop/channel session, so the UI can link straight to it. */
  sessionId?: string;
}

export interface UsageReport {
  days: number;
  from: string;
  to: string;
  totals: { tokensIn: number; tokensOut: number; usd: number; turns: number };
  /** One entry per day in the window, oldest first, zeros filled in. */
  series: UsageDay[];
  byKind: UsageBucket[];
  /** Model ids that priced as unknown — their tokens are in the totals, their dollars are not. */
  unpricedModels: string[];
}

export interface AgentUsage extends UsageReport { agentId: string }
export interface WorkspaceUsage extends UsageReport {
  workspaceId: string;
  byAgent: Array<{ agentId: string; name: string; tokensIn: number; tokensOut: number; usd: number; turns: number }>;
  budget: SpendStatus;
}

type SessionRow = typeof chatSessions.$inferSelect;

const DAY_MS = 24 * 60 * 60_000;
const clampDays = (raw?: string): number => {
  const n = parseInt(raw ?? '30', 10);
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 30;
};

function classify(session: SessionRow): Pick<UsageBucket, 'key' | 'label' | 'kind'> {
  if (session.name.startsWith('Loop · ')) {
    const label = session.name.slice('Loop · '.length);
    return { key: `loop:${label}`, label, kind: 'loop' };
  }
  if (session.name.startsWith('Telegram · ')) return { key: 'channel', label: 'Telegram', kind: 'channel' };
  return { key: 'chat', label: 'Chats', kind: 'chat' };
}

@Injectable()
export class UsageService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly settings: SettingsService,
  ) {}

  async overrides(): Promise<PriceTable> {
    return parsePriceOverrides((await this.settings.all()).pricingOverrides);
  }

  async pricing() {
    const overrides = await this.overrides();
    return {
      prices: mergedPriceTable(overrides),
      overrides,
      overridden: Object.keys(overrides),
      listed: Object.keys(LIST_PRICES).length,
      note: 'List prices, Oct 2026 (USD per million tokens). Override in Settings → Usage.',
    };
  }

  async agentUsage(agentId: string, days = 30, now = new Date()): Promise<AgentUsage> {
    const sessions = await this.db.select().from(chatSessions).where(eq(chatSessions.agentId, agentId));
    const report = await this.report(sessions, days, now);
    return { agentId, ...report };
  }

  async workspaceUsage(workspaceId: string, days = 30, now = new Date()): Promise<WorkspaceUsage> {
    const sessions = await this.db.select().from(chatSessions).where(eq(chatSessions.workspaceId, workspaceId));
    const ws = (await this.db.select().from(workspaces).where(eq(workspaces.id, workspaceId))).at(0);
    const report = await this.report(sessions, days, now);
    const names = new Map((await this.db.select({ id: agents.id, name: agents.name }).from(agents)).map((a) => [a.id, a.name]));
    const byAgent = new Map<string, WorkspaceUsage['byAgent'][number]>();
    for (const row of report.perSession) {
      const id = row.session.agentId ?? '';
      const cur = byAgent.get(id) ?? { agentId: id, name: id ? (names.get(id) ?? 'Deleted agent') : 'Direct chats', tokensIn: 0, tokensOut: 0, usd: 0, turns: 0 };
      cur.tokensIn += row.tokensIn; cur.tokensOut += row.tokensOut; cur.usd += row.usd; cur.turns += row.turns;
      byAgent.set(id, cur);
    }
    const { perSession: _drop, ...rest } = report;
    void _drop;
    return {
      workspaceId,
      ...rest,
      byAgent: [...byAgent.values()].sort((a, b) => b.usd - a.usd || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut)),
      budget: spendStatus(ws, now),
    };
  }

  /** The shared aggregation. Turns are fetched once for all sessions, then
   *  folded into the day series and the per-kind buckets in one pass. */
  private async report(sessions: SessionRow[], days: number, now: Date) {
    const overrides = await this.overrides();
    const since = new Date(now.getTime() - (days - 1) * DAY_MS);
    since.setUTCHours(0, 0, 0, 0);
    const from = since.toISOString();
    const ids = sessions.map((s) => s.id);
    const turns = ids.length === 0 ? [] : await this.db.select().from(chatTurns)
      .where(and(inArray(chatTurns.sessionId, ids), gte(chatTurns.createdAt, from)));

    // Model fallbacks mirror what the turn actually ran: the turn's own
    // model, else the session's, else the agent type's default, else the
    // agent's declared model. Loaded once; these tables are tiny.
    const bySession = new Map(sessions.map((s) => [s.id, s]));
    const typeModels = new Map((await this.db.select({ id: agentTypes.id, model: agentTypes.model }).from(agentTypes)).map((t) => [t.id, t.model]));
    const agentIds = [...new Set(sessions.map((s) => s.agentId).filter((x): x is string => Boolean(x)))];
    const agentModels = new Map(agentIds.length === 0 ? [] :
      (await this.db.select({ id: agents.id, model: agents.model }).from(agents).where(inArray(agents.id, agentIds))).map((a) => [a.id, a.model]));

    const series = new Map<string, UsageDay>();
    for (let i = 0; i < days; i++) {
      const day = new Date(since.getTime() + i * DAY_MS).toISOString().slice(0, 10);
      series.set(day, { day, tokensIn: 0, tokensOut: 0, usd: 0 });
    }
    const byKind = new Map<string, UsageBucket>();
    const perSession = new Map<string, { session: SessionRow; tokensIn: number; tokensOut: number; usd: number; turns: number }>();
    const unpriced = new Set<string>();
    const totals = { tokensIn: 0, tokensOut: 0, usd: 0, turns: 0 };

    for (const t of turns) {
      const session = bySession.get(t.sessionId);
      if (!session) continue;
      const model = t.model || session.model || (session.agentTypeId ? typeModels.get(session.agentTypeId) ?? '' : '') || (session.agentId ? agentModels.get(session.agentId) ?? '' : '');
      const usd = usdFor(model, t.tokensIn, t.tokensOut, overrides);
      if (usd === null && t.tokensIn + t.tokensOut > 0) unpriced.add(model || '(no model)');
      const dollars = usd ?? 0;

      const day = series.get(t.createdAt.slice(0, 10));
      if (day) { day.tokensIn += t.tokensIn; day.tokensOut += t.tokensOut; day.usd += dollars; }

      const cls = classify(session);
      const bucket = byKind.get(cls.key) ?? { ...cls, tokensIn: 0, tokensOut: 0, usd: 0, turns: 0, ...(cls.kind !== 'chat' ? { sessionId: session.id } : {}) };
      bucket.tokensIn += t.tokensIn; bucket.tokensOut += t.tokensOut; bucket.usd += dollars; bucket.turns += 1;
      byKind.set(cls.key, bucket);

      const ps = perSession.get(session.id) ?? { session, tokensIn: 0, tokensOut: 0, usd: 0, turns: 0 };
      ps.tokensIn += t.tokensIn; ps.tokensOut += t.tokensOut; ps.usd += dollars; ps.turns += 1;
      perSession.set(session.id, ps);

      totals.tokensIn += t.tokensIn; totals.tokensOut += t.tokensOut; totals.usd += dollars; totals.turns += 1;
    }

    return {
      days,
      from,
      to: now.toISOString(),
      totals,
      series: [...series.values()],
      byKind: [...byKind.values()].sort((a, b) => b.usd - a.usd || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut)),
      unpricedModels: [...unpriced].sort(),
      perSession: [...perSession.values()],
    };
  }
}

@Controller()
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('agents/:id/usage')
  agent(@Param('id') id: string, @Query('days') days?: string) {
    return this.usage.agentUsage(id, clampDays(days));
  }

  @Get('workspaces/:id/usage')
  workspace(@Param('id') id: string, @Query('days') days?: string) {
    return this.usage.workspaceUsage(id, clampDays(days));
  }

  @Get('usage/pricing')
  pricing() {
    return this.usage.pricing();
  }
}

@Module({
  imports: [SettingsModule],
  controllers: [UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
