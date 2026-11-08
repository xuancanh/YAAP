/**
 * ModelSelectionService — automatic model selection by task complexity
 * (docs/agent-types.md "Model selection"). The pure rules live in
 * agent-types/model-selection.ts; this service reads what they need: the
 * agent's, its type's and its workspace's mode, the workspace company's
 * tunables (model-tunables.ts), the enabled agent types and their keys,
 * provider health, prices, the agent's record at a task class, and the
 * tier an agent asked for with `request_model_tier`.
 *
 * One path for every surface (agent channel parity): a task run asks
 * `decide` with the task's signals; a chat, channel, loop or heartbeat turn
 * asks `decideForTurn` with the message's. Both return the type, the model
 * and the decision to record. Agents and their decisions stay inside their
 * own workspace: the agent row, its workspace's settings and its company.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentTypes, organizations, orgRuns, orgTasks, workspaces, chatTurns, chatSessions } from '../database/schema';
import { AgentsService } from '../agents/agents.service';
import { ProviderHealthService } from '../ai/provider-health';
import { SettingsService } from '../settings/settings.module';
import { parsePriceOverrides, priceFor } from '../ai/pricing';
import { isTierName, typeFamily, TIERS, type Tier } from '../agent-types/model-resolution';
import {
  chatSignals, chooseProvider, chooseTier, DEFAULT_POLICY, effectiveMode, familyOfModel, parseDecision, parseWorkspaceSelection,
  type ComplexitySignals, type ModelDecision, type ModelMode, type ProviderCandidate, type SelectionPolicy,
} from '../agent-types/model-selection';
import { MODEL_TUNABLES, modelTunable } from '../org/model-tunables';
import { nowIso } from '../common/ids.util';
import type { ChatSession } from './chats.repository';

/** What a turn runs on when its model was chosen automatically. */
export interface ModelChoice { agentTypeId: string; model: string; decision: ModelDecision }

interface AgentLike { id: string; workspaceId?: string; provider: string; model: string; agentTypeId?: string | null; modelMode?: string | null }

/** How long an agent's tier request waits for its next turn. */
const REQUEST_TTL_MS = 6 * 60 * 60_000;

@Injectable()
export class ModelSelectionService {
  /** sessionId → the tier the agent asked for, applied on the session's next turn or run. */
  private readonly requests = new Map<string, { tier: Tier; reason: string; at: number }>();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly agents: AgentsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly health?: ProviderHealthService,
  ) {}

  // ---- mode and policy ----

  async workspaceSelection(workspaceId: string) {
    const ws = (await this.db.select({ modelSelection: workspaces.modelSelection }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)).at(0);
    return parseWorkspaceSelection(ws?.modelSelection);
  }

  /** The mode the agent runs in: its own, else its type's, else its workspace's, else fixed. */
  async modeFor(agent: AgentLike, workspaceId?: string): Promise<ModelMode> {
    if (agent.modelMode === 'auto' || agent.modelMode === 'fixed') return agent.modelMode;
    const type = await this.agents.typeOf(agent).catch(() => undefined);
    const typeMode = (type as { modelMode?: string } | undefined)?.modelMode;
    if (typeMode === 'auto' || typeMode === 'fixed') return typeMode;
    const ws = workspaceId || agent.workspaceId;
    return effectiveMode(agent.modelMode, typeMode, ws ? (await this.workspaceSelection(ws)).mode : undefined);
  }

  /** The workspace company's thresholds; the registry defaults without one. */
  async policyFor(workspaceId: string): Promise<SelectionPolicy> {
    const org = (await this.db.select({ tunables: organizations.tunables }).from(organizations).where(eq(organizations.workspaceId, workspaceId)).limit(1).catch(() => [])).at(0) ?? null;
    const p = { ...DEFAULT_POLICY };
    for (const key of Object.keys(MODEL_TUNABLES)) {
      const field = key.slice('model.'.length) as keyof SelectionPolicy;
      p[field] = modelTunable(org, key as keyof typeof MODEL_TUNABLES);
    }
    return p;
  }

  // ---- the agent's own choice ----

  /** `request_model_tier`: the tier the agent wants from its next turn on. */
  requestTier(sessionId: string, tier: Tier, reason: string): void {
    this.requests.set(sessionId, { tier, reason: reason.slice(0, 200), at: Date.now() });
  }

  /** The pending request of a session (consumed by the decision that applies it). */
  private takeRequest(sessionId: string | undefined | null): { tier: Tier; reason: string } | null {
    if (!sessionId) return null;
    const r = this.requests.get(sessionId);
    if (!r) return null;
    this.requests.delete(sessionId);
    return Date.now() - r.at > REQUEST_TTL_MS ? null : { tier: r.tier, reason: r.reason };
  }

  // ---- history ----

  /** The agent's record at a class: finished runs of the last 30 days. */
  async history(orgId: string, agentId: string, cls: string): Promise<{ rate: number; runs: number } | null> {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const rows = await this.db.select({ status: orgRuns.status, outcome: orgRuns.outcome })
      .from(orgRuns).innerJoin(orgTasks, eq(orgTasks.id, orgRuns.taskId))
      .where(and(eq(orgRuns.orgId, orgId), eq(orgRuns.agentId, agentId), eq(orgTasks.class, cls), gte(orgRuns.startedAt, since), ne(orgRuns.status, 'running')))
      .limit(200).catch(() => []);
    const finished = rows.filter((r) => !['refused', 'interrupted'].includes(r.status));
    if (finished.length === 0) return null;
    const ok = finished.filter((r) => r.outcome === 'done' || r.outcome === 'progressed').length;
    return { rate: ok / finished.length, runs: finished.length };
  }

  /** The provider and model each auto agent last ran a task on (the
   *  verifier-independence check judges what actually ran). */
  async lastRunModels(agentIds: string[]): Promise<Map<string, { provider: string; model: string }>> {
    const out = new Map<string, { provider: string; model: string }>();
    if (agentIds.length === 0) return out;
    const rows = await this.db.select({ agentId: orgRuns.agentId, modelDecision: orgRuns.modelDecision })
      .from(orgRuns).where(and(inArray(orgRuns.agentId, agentIds), ne(orgRuns.modelDecision, ''))).orderBy(desc(orgRuns.startedAt)).limit(500).catch(() => []);
    for (const r of rows) {
      if (out.has(r.agentId)) continue;
      const d = parseDecision(r.modelDecision);
      if (d) out.set(r.agentId, { provider: d.provider, model: d.model });
    }
    return out;
  }

  // ---- the decision ----

  private async candidates(): Promise<ProviderCandidate[]> {
    const platform = this.config?.get<Record<string, string>>('platformKeys') ?? {};
    const rows = await this.db.select().from(agentTypes).catch(() => [] as Array<typeof agentTypes.$inferSelect>);
    return rows.filter((r) => r.enabled === 1).map((r) => ({
      id: r.id, name: r.name, provider: r.provider, model: r.model, models: r.models, baseUrl: r.baseUrl, tierModels: r.tierModels, enabled: r.enabled,
      usable: Boolean(r.apiKey) || Boolean(platform[r.provider]),
    }));
  }

  private async prices() {
    try { return this.settings ? parsePriceOverrides((await this.settings.all()).pricingOverrides) : {}; } catch { return {}; }
  }

  /**
   * Choose the tier, the type and the model for one run or turn of an auto
   * agent. `routing` carries the CEO's pins (class → tier, tier → model);
   * `avoidFamily` the maker's vendor family when this run verifies its work.
   * Null when nothing can be chosen (no usable type) — the turn then runs
   * as a fixed one would.
   */
  async decide(input: {
    workspaceId: string; agent: AgentLike; signals: ComplexitySignals; sessionId?: string | null;
    avoidFamily?: string | null; routing?: { tier?: Tier | null; pinnedModel?: Partial<Record<Tier, string>> };
  }): Promise<ModelChoice | null> {
    const policy = await this.policyFor(input.workspaceId);
    const requested = this.takeRequest(input.sessionId) ?? input.signals.requested ?? null;
    const signals: ComplexitySignals = { ...input.signals, requested, routedTier: input.routing?.tier ?? input.signals.routedTier ?? null };
    const { tier, score, reasons } = chooseTier(signals, policy);
    const sel = await this.workspaceSelection(input.workspaceId);
    const own = await this.agents.typeOf(input.agent).catch(() => undefined);
    const prices = await this.prices();
    const pick = chooseProvider(await this.candidates(), {
      tier, ownTypeId: own?.id ?? null, order: sel.order, crossProvider: sel.crossProvider,
      degraded: this.health ? (p) => this.health!.isDegraded(input.workspaceId, p) : undefined,
      avoidFamily: input.avoidFamily ?? null,
      price: (m) => { const pr = priceFor(m, prices); return pr ? pr.input + pr.output : null; },
      pinnedModel: input.routing?.pinnedModel?.[tier] ?? null,
    });
    if (!pick) return null;
    const decision: ModelDecision = {
      mode: 'auto', kind: signals.kind, tier, score, model: pick.model, agentTypeId: pick.type.id, provider: pick.type.provider,
      family: familyOfModel(pick.model, pick.type.provider) ?? typeFamily(pick.type), reasons: [...reasons, ...pick.reasons], requested, at: nowIso(),
    };
    return { agentTypeId: pick.type.id, model: pick.model, decision };
  }

  /**
   * A chat, channel, loop or heartbeat turn (the lighter heuristic). Null
   * when the agent is fixed, or when a person picked a model for this chat
   * by hand in its header (that pick wins for the chat, docs/agent-types.md).
   * Org task runs pass their own decision and never come here.
   */
  async decideForTurn(session: Pick<ChatSession, 'id' | 'agentId' | 'workspaceId' | 'model' | 'agentTypeId'>, text: string): Promise<ModelChoice | null> {
    if (!session.agentId) return null;
    const agent = await this.agents.get(session.agentId).catch(() => null) as (AgentLike & { workspaceId: string }) | null;
    if (!agent) return null;
    if ((await this.modeFor(agent, session.workspaceId)) !== 'auto') return null;
    const handPicked = (session.model && session.model !== agent.model) || (session.agentTypeId && agent.agentTypeId && session.agentTypeId !== agent.agentTypeId);
    if (handPicked) return null;
    return this.decide({ workspaceId: session.workspaceId, agent, signals: chatSignals(text), sessionId: session.id });
  }

  // ---- outcomes per tier (tuning the thresholds) ----

  /**
   * How each tier did in the workspace's company over `days`: runs, done or
   * progressed, failed / no progress, reworked (run after an escalation for
   * failed or reworked attempts), spend; and chat turns per tier. Model-free.
   */
  async outcomes(workspaceId: string, days = 30): Promise<{ days: number; tiers: Array<{ tier: Tier; runs: number; succeeded: number; failed: number; reworked: number; usd: number; avgUsd: number; turns: number; successRate: number | null }> }> {
    const since = new Date(Date.now() - Math.max(1, Math.min(365, days)) * 86_400_000).toISOString();
    const orgIds = (await this.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.workspaceId, workspaceId)).catch(() => [])).map((o) => o.id);
    const runs = orgIds.length
      ? await this.db.select({ tier: orgRuns.tier, status: orgRuns.status, outcome: orgRuns.outcome, usd: orgRuns.usd, modelDecision: orgRuns.modelDecision })
        .from(orgRuns).where(and(inArray(orgRuns.orgId, orgIds), ne(orgRuns.tier, ''), gte(orgRuns.startedAt, since))).limit(5000).catch(() => [])
      : [];
    const turns = await this.db.select({ modelDecision: chatTurns.modelDecision })
      .from(chatTurns).innerJoin(chatSessions, eq(chatSessions.id, chatTurns.sessionId))
      .where(and(eq(chatSessions.workspaceId, workspaceId), ne(chatTurns.modelDecision, ''), gte(chatTurns.createdAt, since))).limit(5000).catch(() => []);
    const tiers = TIERS.map((tier) => {
      const mine = runs.filter((r) => r.tier === tier);
      const finished = mine.filter((r) => !['running', 'refused', 'interrupted'].includes(r.status));
      const succeeded = finished.filter((r) => r.outcome === 'done' || r.outcome === 'progressed').length;
      const failed = finished.filter((r) => r.status === 'failed' || r.status === 'loop' || r.outcome === 'no_progress').length;
      const reworked = mine.filter((r) => (parseDecision(r.modelDecision)?.reasons ?? []).some((x) => /failed or reworked attempt/.test(x))).length;
      const usd = mine.reduce((s, r) => s + (Number(r.usd) || 0), 0);
      const nTurns = turns.filter((t) => parseDecision(t.modelDecision)?.tier === tier).length;
      return { tier, runs: mine.length, succeeded, failed, reworked, usd: Number(usd.toFixed(4)), avgUsd: mine.length ? Number((usd / mine.length).toFixed(4)) : 0, turns: nTurns, successRate: finished.length ? Number((succeeded / finished.length).toFixed(3)) : null };
    });
    return { days, tiers };
  }
}

/** Whether a value is a tier (re-exported for the tool and the controller). */
export { isTierName };
