/**
 * HeartbeatService — the gated heartbeat every agent has by default
 * (docs/company-vision.md §13, docs/triggers.md "Heartbeat").
 *
 * Every agent has a heartbeat from birth: `agents.heartbeatEnabled` (on by
 * default), `heartbeatCron` and the two caps ('' / null = inherit the
 * workspace's `heartbeatDefaults`, then the built-in). It is not an entry
 * in `agents.loops` — the editor cannot delete it and the loop cap, export
 * and import are untouched — but it runs *as* a loop named `heartbeat`.
 * This service runs its own minute tick and, on each matching minute,
 * computes the agent's *reasons* without a model: open tasks untouched for the staleness interval, inbox events
 * addressed to it since its last run, channel mentions it never answered,
 * and whatever other modules register through `addReasonProvider` (the org
 * module's key-result check-ins, signals and rituals). Only a non-empty
 * list runs a real turn — through LoopsService.runLoop, so budget, model
 * override and `origin 'loop'` apply unchanged — framed "Heartbeat. You
 * were woken because: …". An empty gate costs nothing and writes one
 * `heartbeat_state` row.
 *
 * Everything the gate uses is a tunable with a default and a bound
 * (heartbeat-config.ts): cadence, the daily real-run cap and the staleness
 * interval come from the workspace's `heartbeatDefaults`, overridden per
 * agent on its columns, clamped to the fence in code. Quiet hours
 * defer the beat to the window's end (no beat inside them, unlike other
 * loops, which run and only hold their notifications); the monthly spend
 * stop, LOOPS_ENABLED and the org module's paused members all close it.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents, heartbeatState } from '../database/schema';
import { nowIso } from '../common/ids.util';
import { AgentsService } from '../agents/agents.service';
import { AccountsService } from '../accounts/accounts.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { isQuiet } from '../workspaces/quiet-hours';
import { spendStatus } from '../workspaces/spend.util';
import { cronMatches } from './cron.util';
import { LoopsService, type LoopRunStatus } from './loops.service';
import type { LoopDef } from './loop-def';
import { effectiveHeartbeat, validateHeartbeatCron, validateHeartbeatDefaults, type HeartbeatTunables } from './heartbeat-config';
import { FollowsService } from '../follows/follows.service';
import { taskRef } from '../common/task-keys';

/** The loop name every heartbeat run carries ("Loop · heartbeat" session). */
export const HEARTBEAT_LOOP_NAME = 'heartbeat';

/** Another module's reasons for waking an agent (one short line each).
 *  Registered with `addReasonProvider`; a throwing provider is skipped. */
export interface HeartbeatReasonProvider {
  /** A name for logs ("org"). */
  readonly name: string;
  reasons(agentId: string, ctx: HeartbeatContext): Promise<string[]>;
}

/** Another module's context for the heartbeat prompt: the operating
 *  profile (values, culture, vision, goals — docs/company-vision.md §1b),
 *  so the agent checks its work the way this company works. Returned text
 *  is appended to the prompt as data, bounded. */
export interface HeartbeatContextProvider {
  readonly name: string;
  context(agentId: string, ctx: HeartbeatContext): Promise<string | null>;
}

/** Another module's own titled section of the heartbeat prompt (the org's
 *  "Your next work", docs/work-tracking.md): shown only when the gate opened
 *  for other reasons — a section never opens the gate by itself. */
export interface HeartbeatSectionProvider {
  readonly name: string;
  section(agentId: string, ctx: HeartbeatContext): Promise<{ title: string; text: string } | null>;
}

export interface HeartbeatContext {
  now: Date;
  workspaceId: string;
  tunables: HeartbeatTunables;
  /** When the agent last ran a heartbeat turn (null = never). */
  lastRunAt: string | null;
}

export type BeatStatus = 'ran' | 'empty' | 'disabled' | 'paused' | 'quiet' | 'spend_stop' | 'cap' | 'busy' | 'budget_stop' | 'loops_off';

export interface BeatResult {
  status: BeatStatus;
  reasons: string[];
  ran: boolean;
}

export interface HeartbeatView {
  enabled: boolean;
  cron: string;
  dailyRunCap: number;
  staleMinutes: number;
  lastBeatAt: string | null;
  lastReason: string;
  lastRunAt: string | null;
  nextDueAt: string | null;
  beatsSkipped: number;
  runsToday: number;
}

type StateRow = typeof heartbeatState.$inferSelect;

/** Reasons per built-in source and in total, so a prompt stays readable. */
const REASONS_PER_SOURCE = 5;
const REASONS_CAP = 15;
/** Mentions older than this are not chased. */
const MENTION_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Context providers' text is bounded in the prompt. */
const CONTEXT_CAP = 1_500;
/** Each titled section is bounded too. */
const SECTION_CAP = 1_200;

@Injectable()
export class HeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatService.name);
  private timer?: ReturnType<typeof setInterval>;
  /** agentId → last beaten minute stamp (one beat per matching minute). */
  private readonly lastBeat = new Map<string, string>();
  private readonly reasonProviders: HeartbeatReasonProvider[] = [];
  private readonly contextProviders: HeartbeatContextProvider[] = [];
  private readonly sectionProviders: HeartbeatSectionProvider[] = [];
  /** Whether the org module's `org_members` table may be consulted for
   *  paused members; probed once, false when the table is missing. */
  private orgMembersProbe?: Promise<boolean>;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    private readonly loops: LoopsService,
    private readonly config: ConfigService,
    @Optional() private readonly accounts?: AccountsService,
    /** Optional: follows (docs/follows.md) — a gated, debounced reason when
     *  something the agent follows needs it, and the "Following" section. */
    @Optional() public follows?: FollowsService,
  ) {}

  onModuleInit(): void {
    if (this.loopsEnabled()) this.timer = setInterval(() => { void this.tick(new Date()); }, 60_000);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private loopsEnabled(): boolean {
    return this.config.get<boolean>('loopsEnabled') !== false;
  }

  // ---- registries for other modules ----

  addReasonProvider(p: HeartbeatReasonProvider): () => void {
    this.reasonProviders.push(p);
    return () => { const i = this.reasonProviders.indexOf(p); if (i >= 0) this.reasonProviders.splice(i, 1); };
  }

  addContextProvider(p: HeartbeatContextProvider): () => void {
    this.contextProviders.push(p);
    return () => { const i = this.contextProviders.indexOf(p); if (i >= 0) this.contextProviders.splice(i, 1); };
  }

  addSectionProvider(p: HeartbeatSectionProvider): () => void {
    this.sectionProviders.push(p);
    return () => { const i = this.sectionProviders.indexOf(p); if (i >= 0) this.sectionProviders.splice(i, 1); };
  }

  // ---- the tick ----

  async tick(now: Date): Promise<void> {
    try {
      if (!this.accounts) await this.tickAccount(now);
      else await this.accounts.forEachAccount(() => this.tickAccount(now));
    } catch (err) {
      this.logger.warn(`heartbeat tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async tickAccount(now: Date): Promise<void> {
    const stamp = now.toISOString().slice(0, 16);
    const live = new Set<string>();
    for (const agent of await this.agents.list()) {
      live.add(agent.id);
      if (!agent.heartbeatEnabled) continue;
      // The cadence defaults come from the agent's own workspace (item 26).
      const { cron } = effectiveHeartbeat(await this.workspaceOf(agent), agent);
      if (!cronMatches(cron, now) || this.lastBeat.get(agent.id) === stamp) continue;
      this.lastBeat.set(agent.id, stamp);
      await this.beat(agent.id, now).catch((err) => {
        this.logger.warn(`heartbeat for ${agent.name} failed: ${err instanceof Error ? err.message : err}`);
      });
    }
    for (const id of [...this.lastBeat.keys()]) if (!live.has(id)) this.lastBeat.delete(id);
  }

  /** The agent's own workspace (execution-plan item 26); the account's
   *  default only for a row that never got one. */
  private async workspaceOf(agent: { workspaceId?: string }) {
    const own = agent.workspaceId ? await this.workspaces.get(agent.workspaceId).catch(() => null) : null;
    return own ?? (await this.workspaces.list())[0];
  }

  // ---- one beat ----

  /** Run the gate for one agent now. `force` ignores the enabled flag (the
   *  "Beat now" button on a paused heartbeat still shows its reasons) but
   *  never the quiet hours, the spend stop or the daily cap. */
  async beat(agentId: string, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<BeatResult> {
    const agent = await this.agents.get(agentId);
    const ws = await this.workspaceOf(agent);
    const tunables = effectiveHeartbeat(ws, agent);
    const prior = await this.state(agentId);
    const nextDue = nextCronMatch(tunables.cron, now);
    const finish = async (status: BeatStatus, reasons: string[], patch: Partial<StateRow> = {}): Promise<BeatResult> => {
      await this.putState(agentId, {
        lastBeatAt: now.toISOString(),
        lastReason: (reasons.length > 0 ? reasons.join('\n') : status).slice(0, 2_000),
        nextDueAt: nextDue?.toISOString() ?? null,
        beatsSkipped: status === 'ran' ? 0 : (prior?.beatsSkipped ?? 0) + 1,
        ...patch,
      });
      return { status, reasons, ran: status === 'ran' };
    };

    if (!this.loopsEnabled()) return finish('loops_off', []);
    if (!agent.heartbeatEnabled && !opts.force) return finish('disabled', []);
    if (!ws) return finish('busy', []);
    if (await this.orgPaused(agentId)) return finish('paused', []);
    const quiet = isQuiet(ws, now);
    if (quiet.quiet) {
      // No beat inside quiet hours: the next due is the window's end (or the
      // first cron match after it).
      const until = quiet.until ?? nextDue;
      return finish('quiet', [], { nextDueAt: (until && nextDue && until > nextDue ? nextCronMatch(tunables.cron, until) ?? until : until)?.toISOString() ?? null });
    }
    if (spendStatus(ws, now).over) return finish('spend_stop', []);

    const ctx: HeartbeatContext = { now, workspaceId: ws.id, tunables, lastRunAt: prior?.lastRunAt ?? null };
    const reasons = await this.reasonsFor(agentId, ctx);
    if (reasons.length === 0) return finish('empty', []);

    const today = now.toISOString().slice(0, 10);
    const runsToday = prior?.runsDay === today ? prior.runsToday : 0;
    if (runsToday >= tunables.dailyRunCap) return finish('cap', reasons, { runsDay: today, runsToday });

    const context = await this.contextFor(agentId, ctx);
    const following = this.follows ? await this.follows.digest(agentId, now).catch(() => ({ text: '', ids: [] as string[] })) : { text: '', ids: [] as string[] };
    const sections = await this.sectionsFor(agentId, ctx);
    const prompt = heartbeatPrompt(reasons, agent.charter, context, following.text, sections);
    const loop: LoopDef = { name: HEARTBEAT_LOOP_NAME, cron: tunables.cron, prompt };
    const status: LoopRunStatus = await this.loops.runLoop(agent.id, agent.name, loop);
    if (status !== 'ran') return finish(status, reasons, { runsDay: today, runsToday });
    // The beat read what is new on what it follows: it is seen now.
    await this.follows?.markSeen(following.ids, now).catch(() => undefined);
    return finish('ran', reasons, { lastRunAt: now.toISOString(), runsDay: today, runsToday: runsToday + 1 });
  }

  /** The reasons list: built-in sources first, then registered providers,
   *  each bounded; the whole list capped. Model-free. */
  async reasonsFor(agentId: string, ctx: HeartbeatContext): Promise<string[]> {
    const out: string[] = [];
    const sources: Array<() => Promise<string[]>> = [
      () => this.staleTasks(agentId, ctx),
      () => this.unhandledEvents(agentId, ctx),
      () => this.unansweredMentions(agentId, ctx),
      // Followed threads and tasks that need the agent (docs/follows.md):
      // debounced per agent; never what a mention already wakes it for.
      () => (this.follows ? this.follows.wakeReasons(agentId, ctx.now) : Promise.resolve([])),
      ...this.reasonProviders.map((p) => () => p.reasons(agentId, ctx)),
    ];
    for (const source of sources) {
      try {
        for (const r of (await source()).slice(0, REASONS_PER_SOURCE)) {
          if (typeof r === 'string' && r.trim()) out.push(r.trim().slice(0, 300));
        }
      } catch (err) {
        this.logger.warn(`heartbeat reason source failed for ${agentId}: ${err instanceof Error ? err.message : err}`);
      }
      if (out.length >= REASONS_CAP) break;
    }
    return out.slice(0, REASONS_CAP);
  }

  private async contextFor(agentId: string, ctx: HeartbeatContext): Promise<string> {
    const parts: string[] = [];
    for (const p of this.contextProviders) {
      try {
        const text = await p.context(agentId, ctx);
        if (text && text.trim()) parts.push(text.trim());
      } catch (err) {
        this.logger.warn(`heartbeat context provider "${p.name}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return parts.join('\n\n').slice(0, CONTEXT_CAP);
  }

  /** Titled sections from registered providers, each bounded; model-free. */
  async sectionsFor(agentId: string, ctx: HeartbeatContext): Promise<string[]> {
    const out: string[] = [];
    for (const p of this.sectionProviders) {
      try {
        const sec = await p.section(agentId, ctx);
        if (sec && sec.text.trim()) out.push(`${sec.title.trim()}:\n${sec.text.trim().slice(0, SECTION_CAP)}`);
      } catch (err) {
        this.logger.warn(`heartbeat section provider "${p.name}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return out;
  }

  // ---- built-in reason sources ----

  /** Open board tasks (todo | doing) not touched for the staleness interval,
   *  and blocked ones on an exponential back-off (docs/work-tracking.md): a
   *  blocked task wakes its owner when the back-off crosses a step since the
   *  last heartbeat run — four staleness intervals after it was blocked, then
   *  twelve, twenty-eight… (base × (2^k − 1)) — so re-checking an unchanged
   *  blocker and rewriting its note no longer resets the clock. Kanban rows
   *  merged into the company board are not on it. */
  private async staleTasks(agentId: string, ctx: HeartbeatContext): Promise<string[]> {
    const before = new Date(ctx.now.getTime() - ctx.tunables.staleMinutes * 60_000).toISOString();
    const all = (await this.db.execute(sql`
      SELECT "id", "key", "title", "status", "note", "createdAt", "updatedAt" FROM agent_tasks
      WHERE "agentId" = ${agentId} AND "mergedInto" IS NULL AND (("status" IN ('todo', 'doing') AND "updatedAt" <= ${before}) OR "status" = 'blocked')
      ORDER BY "updatedAt" ASC LIMIT 200
    `)).rows as unknown as Array<{ id: string; key: string | null; title: string; status: string; note: string; createdAt: string; updatedAt: string }>;
    const base = 4 * ctx.tunables.staleMinutes * 60_000;
    const rows = all.filter((t) => t.status !== 'blocked' || blockedBackoffDue(t, base, ctx.now, ctx.lastRunAt)).slice(0, REASONS_PER_SOURCE + 1);
    const lines = rows.slice(0, REASONS_PER_SOURCE).map((t) => `Task ${taskRef(t)} "${t.title.slice(0, 80)}" is ${t.status === 'doing' ? 'in progress' : t.status === 'blocked' ? 'blocked (check whether it can move now)' : 'to do'} and untouched since ${t.updatedAt.slice(0, 16).replace('T', ' ')}`);
    if (rows.length > REASONS_PER_SOURCE) lines[REASONS_PER_SOURCE - 1] += ' (and more on your board)';
    return lines;
  }

  /** Inbox events addressed to the agent that arrived since its last
   *  heartbeat run and nobody read: the kinds another actor writes *to* the
   *  agent (a mention relayed by a channel, an escalation, an info note),
   *  never its own loop_run / loop_error / budget_stop or action_* rows —
   *  those are the self-wake chain docs/autonomous-company.md warns about. */
  private async unhandledEvents(agentId: string, ctx: HeartbeatContext): Promise<string[]> {
    const since = ctx.lastRunAt ?? new Date(ctx.now.getTime() - MENTION_WINDOW_MS).toISOString();
    const rows = (await this.db.execute(sql`
      SELECT "kind", "title", "createdAt" FROM agent_events
      WHERE "agentId" = ${agentId} AND "readAt" IS NULL AND "createdAt" > ${since}
        AND "kind" IN ('mention', 'escalation', 'blocked', 'info') AND "origin" NOT IN ('loop', 'system')
      ORDER BY "createdAt" ASC LIMIT ${REASONS_PER_SOURCE}
    `)).rows as unknown as Array<{ kind: string; title: string; createdAt: string }>;
    return rows.map((e) => `Inbox (${e.kind}): "${e.title.slice(0, 100)}" at ${e.createdAt.slice(0, 16).replace('T', ' ')}`);
  }

  /** Channel messages that mention the agent, in a channel it belongs to,
   *  with no later reply from the agent in the same channel and thread. */
  private async unansweredMentions(agentId: string, ctx: HeartbeatContext): Promise<string[]> {
    const since = new Date(ctx.now.getTime() - MENTION_WINDOW_MS).toISOString();
    const needle = `%"id":"${agentId}"%`;
    const rows = (await this.db.execute(sql`
      SELECT m."id", m."text", m."createdAt", c."slug"
      FROM channel_messages m
      JOIN channels c ON c."id" = m."channelId"
      JOIN channel_members cm ON cm."channelId" = m."channelId" AND cm."memberKind" = 'agent' AND cm."memberId" = ${agentId}
      WHERE m."mentions" LIKE ${needle} AND m."mentions" LIKE '%"kind":"agent"%'
        AND NOT (m."authorKind" = 'agent' AND m."authorId" = ${agentId})
        AND m."createdAt" > ${since} AND c."archivedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM channel_messages r
          WHERE r."channelId" = m."channelId" AND r."authorKind" = 'agent' AND r."authorId" = ${agentId}
            AND r."createdAt" > m."createdAt"
            AND (r."threadRootId" = m."id" OR r."threadRootId" IS NOT DISTINCT FROM m."threadRootId")
        )
      ORDER BY m."createdAt" ASC LIMIT ${REASONS_PER_SOURCE}
    `)).rows as unknown as Array<{ id: string; text: string; createdAt: string; slug: string }>;
    return rows.map((m) => `Unanswered mention in #${m.slug}: "${m.text.replace(/\s+/g, ' ').slice(0, 100)}" (${m.createdAt.slice(0, 16).replace('T', ' ')})`);
  }

  /** The org module pauses members (`org_members.status = 'paused'`); a
   *  paused member's heartbeat does not beat. A seat in an archived company
   *  is suspended, so it does not hold the plain agent's heartbeat. Read defensively: the table
   *  belongs to another module and may be absent in a test database. */
  private async orgPaused(agentId: string): Promise<boolean> {
    this.orgMembersProbe ??= this.db.execute(sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'org_members'`)
      .then((r) => r.rows.length > 0).catch(() => false);
    if (!(await this.orgMembersProbe)) return false;
    try {
      const rows = (await this.db.execute(sql`SELECT 1 FROM org_members m WHERE m."agentId" = ${agentId} AND m."status" = 'paused' AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o."id" = m."orgId" AND o."status" = 'archived') LIMIT 1`)).rows;
      return rows.length > 0;
    } catch { return false; }
  }

  // ---- state and settings ----

  async state(agentId: string): Promise<StateRow | undefined> {
    return (await this.db.select().from(heartbeatState).where(eq(heartbeatState.agentId, agentId))).at(0);
  }

  private async putState(agentId: string, patch: Partial<StateRow>): Promise<void> {
    const existing = await this.state(agentId);
    const updatedAt = nowIso();
    if (existing) await this.db.update(heartbeatState).set({ ...patch, updatedAt }).where(eq(heartbeatState.agentId, agentId));
    else await this.db.insert(heartbeatState).values({ agentId, lastReason: '', beatsSkipped: 0, runsDay: '', runsToday: 0, ...patch, updatedAt });
  }

  /** GET /api/agents/:id/heartbeat: settings in effect, state, today's runs. */
  async view(agentId: string, now: Date = new Date()): Promise<HeartbeatView> {
    const agent = await this.agents.get(agentId);
    const ws = await this.workspaceOf(agent);
    const t = effectiveHeartbeat(ws, agent);
    const s = await this.state(agentId);
    const today = now.toISOString().slice(0, 10);
    return {
      enabled: agent.heartbeatEnabled === 1,
      cron: t.cron,
      dailyRunCap: t.dailyRunCap,
      staleMinutes: t.staleMinutes,
      lastBeatAt: s?.lastBeatAt ?? null,
      lastReason: s?.lastReason ?? '',
      lastRunAt: s?.lastRunAt ?? null,
      nextDueAt: s?.nextDueAt ?? nextCronMatch(t.cron, now)?.toISOString() ?? null,
      beatsSkipped: s?.beatsSkipped ?? 0,
      runsToday: s?.runsDay === today ? s.runsToday : 0,
    };
  }

  /**
   * Tune one agent's heartbeat (PATCH /api/agents/:id/heartbeat; the org
   * module calls it for the chief's reports). Bounds-checked: the cron must
   * beat no more often than every 5 minutes, the daily cap stays ≤ 48, the
   * staleness interval within 5 min … 7 days. `cron: null` clears the
   * agent override back to the workspace default.
   */
  async setHeartbeat(agentId: string, patch: { enabled?: boolean; cron?: string | null; dailyRunCap?: number | null; staleMinutes?: number | null }): Promise<HeartbeatView> {
    await this.agents.get(agentId);
    const set: { heartbeatEnabled?: number; heartbeatCron?: string; heartbeatDailyRunCap?: number | null; heartbeatStaleMinutes?: number | null } = {};
    if (patch.enabled !== undefined) set.heartbeatEnabled = patch.enabled ? 1 : 0;
    if (patch.cron !== undefined) set.heartbeatCron = patch.cron === null || patch.cron === '' ? '' : validateHeartbeatCron(patch.cron);
    const bounded = validateHeartbeatDefaults({ dailyRunCap: patch.dailyRunCap ?? undefined, staleMinutes: patch.staleMinutes ?? undefined });
    if (patch.dailyRunCap !== undefined) set.heartbeatDailyRunCap = patch.dailyRunCap === null ? null : bounded.dailyRunCap!;
    if (patch.staleMinutes !== undefined) set.heartbeatStaleMinutes = patch.staleMinutes === null ? null : bounded.staleMinutes!;
    if (Object.keys(set).length > 0) await this.db.update(agents).set(set).where(eq(agents.id, agentId));
    return this.view(agentId);
  }
}

/** The prompt of a heartbeat run: the reasons as a list, the agent's own
 *  charter (its purpose) and the company's operating profile when a context
 *  provider supplied one — all framed so the agent checks the items and
 *  stops, rather than inventing work. */
export function heartbeatPrompt(reasons: string[], charter: string, context: string, following = '', sections: string[] = []): string {
  const parts = [
    `Heartbeat. You were woken because:\n${reasons.map((r) => `- ${r}`).join('\n')}\nCheck each item, act with your tools, then stop. Do not invent work. Keep your board true with update_task: doing when you work on a task, done when finished, blocked (with what it waits on) when you cannot move it, abandoned (with why) when it is no longer worth doing.`,
  ];
  for (const sec of sections) if (sec.trim()) parts.push(sec.trim());
  const purpose = (charter ?? '').trim();
  if (purpose) parts.push(`Your charter (check your work against it):\n${purpose.slice(0, 1_200)}`);
  if (following.trim()) parts.push(`Following — new since your last beat (threads and tasks you follow; follow, unfollow and list_follows manage them — unfollow what no longer concerns you):\n${following.trim()}`);
  if (context.trim()) parts.push(`How this company works (its operating profile — values, culture, vision, goals; follow it in what you prioritise and how you communicate):\n${context.trim()}`);
  return parts.join('\n\n');
}

/** When a kanban task was blocked: its latest "Blocked (YYYY-MM-DD): …" note line, else its last update. */
export function blockedSince(t: { note?: string | null; updatedAt: string }): number {
  const m = [...(t.note ?? '').matchAll(/Blocked \((\d{4}-\d{2}-\d{2})\):/g)].at(-1);
  const ms = m ? Date.parse(`${m[1]}T00:00:00.000Z`) : NaN;
  return Number.isFinite(ms) ? ms : Date.parse(t.updatedAt);
}

/** Whether a blocked kanban task is due a wake: the elapsed time since it
 *  was blocked crossed a back-off step (base × (2^k − 1), k ≥ 1) after the
 *  last heartbeat run. Pure and stateless. */
export function blockedBackoffDue(t: { note?: string | null; updatedAt: string }, baseMs: number, now: Date, lastRunAt: string | null): boolean {
  if (baseMs <= 0) return true;
  const since = blockedSince(t);
  const step = (ms: number) => (ms < baseMs ? 0 : Math.floor(Math.log2(ms / baseMs + 1)));
  const nowStep = step(now.getTime() - since);
  if (nowStep === 0) return false;
  const last = lastRunAt ? Date.parse(lastRunAt) : NaN;
  if (!Number.isFinite(last) || last < since) return true;
  return nowStep > step(last - since);
}

/** The first minute at or after `from` + 1 min matching `cron`, within 8
 *  days; null for a cron that never matches. */
export function nextCronMatch(cron: string, from: Date): Date | null {
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  for (let m = 0; m < 8 * 24 * 60; m++) {
    const d = new Date(start + m * 60_000);
    if (cronMatches(cron, d)) return d;
  }
  return null;
}
