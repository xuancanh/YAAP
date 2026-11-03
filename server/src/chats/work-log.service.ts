/**
 * WorkLogService — an agent's Work log (docs/work-log.md): the timeline of
 * its own runs, read from the turns of its `work` sessions (heartbeat and
 * loops, org task runs and other org runs, meeting rounds, channel wakes,
 * mini-app asks). One turn is one run. Each run carries its trigger (and
 * the trigger's key: the loop name, the task key, the channel slug), its
 * outcome, tokens and cost, the steps it took, and — on detail — its
 * internal thinking, every tool call with input and output, and the files it
 * wrote. Read-only and presentation-only: the sessions, their memory and
 * their turn context are the same as before the split.
 */
import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { currentAccountId, currentViewer } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { parsePriceOverrides, usdFor, type PriceTable } from '../ai/pricing';
import { SettingsService } from '../settings/settings.module';

export const WORK_TRIGGERS = ['heartbeat', 'loop', 'task', 'meeting', 'channel', 'org', 'app', 'other'] as const;
export type WorkTrigger = (typeof WORK_TRIGGERS)[number];
export const WORK_OUTCOMES = ['done', 'blocked', 'error', 'stopped', 'running'] as const;
export type WorkOutcome = (typeof WORK_OUTCOMES)[number];

/** The prompts a meeting round opens with (OrgMeetingRuntimeService.turn):
 *  a meeting shares the channel's working session, so the turn tells them
 *  apart. */
export const MEETING_INPUT_RE = '^(Round [0-9]+ of [0-9]+: your one turn|Standup, your one turn|Closing turn: the rounds are over)';

/** Tools whose calls write a file (`path` in their input). */
const FILE_WRITE_TOOLS: Record<string, string> = { fs_write: 'write', fs_edit: 'edit', fs_append: 'append', fs_delete: 'delete', fs_restore: 'restore' };

export interface WorkRunTask { kind: 'org' | 'agent'; id: string; key: string | null; title: string }
export interface WorkRun {
  id: string;
  sessionId: string;
  sessionName: string;
  trigger: WorkTrigger;
  /** The trigger's key: the loop name, the task key (or id), the channel
   *  `#slug`, the org session's name; '' for the heartbeat. */
  triggerKey: string;
  /** "Heartbeat", "Loop · digest", "ENG-12 Close the books", "#general", … */
  label: string;
  outcome: WorkOutcome;
  status: string;
  error: string | null;
  /** The run's prompt, bounded. */
  input: string;
  /** The run's last answer, bounded. */
  answer: string;
  tokensIn: number;
  tokensOut: number;
  /** USD: the org run's settled cost, else the model's list price; null
   *  when the model is unknown to the price table. */
  usd: number | null;
  model: string;
  /** Tool calls + thinking blocks. */
  steps: number;
  toolCount: number;
  thinkingCount: number;
  /** Distinct tool names, in first-use order (at most 8). */
  tools: string[];
  files: Array<{ path: string; op: string }>;
  task: WorkRunTask | null;
  archived: boolean;
  createdAt: string;
}
export interface WorkRunDetail extends WorkRun {
  /** The run's transcript in order: the prompt ('user'), the thinking
   *  blocks, each tool result, the answers. */
  messages: Array<{ id: string; seq: number; role: string; content: string; toolName: string | null; createdAt: string }>;
  toolCalls: Array<{ tool: string; input: unknown; result: string; approved: string; isError: boolean; actionClass?: string }>;
}
export interface WorkLogGroup { trigger: WorkTrigger; key: string; label: string; count: number; lastAt: string }
export interface WorkLogQuery {
  trigger?: string; key?: string; outcome?: string; task?: string; sessionId?: string;
  from?: string; to?: string; q?: string; limit?: number; cursor?: string | null;
}

interface Row {
  id: string; sessionId: string; sessionName: string; seq: number; input: string; status: string; error: string | null;
  tokensIn: number; tokensOut: number; model: string; sessionModel: string; toolCalls: string; createdAt: string; archivedAt: string | null;
  trigger: WorkTrigger; triggerKey: string; outcome: WorkOutcome; runUsd: number | null;
  taskKind: 'org' | 'agent' | null; taskId: string | null; taskKey: string | null; taskTitle: string | null;
  answer: string | null; thinkingCount: number;
}

const rowsOf = (res: unknown): unknown[] => ((res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : []));

@Injectable()
export class WorkLogService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly agents: AgentsService,
    /** Optional: the workspace's price overrides (Settings → Usage). */
    @Optional() private readonly settings?: SettingsService,
  ) {}

  /** One page of the agent's runs, newest first, with the trigger groups
   *  (counts under the same filters, all triggers) for the filter chips. */
  async list(agentId: string, query: WorkLogQuery = {}): Promise<{ runs: WorkRun[]; nextCursor: string | null; groups: WorkLogGroup[] }> {
    await this.agents.get(agentId); // 404 for an agent the caller cannot see
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 30)));
    const filters = this.filters(query, { withTrigger: true });
    const cur = decodeCursor(query.cursor);
    if (cur) filters.push(sql`(x."createdAt" < ${cur.at} OR (x."createdAt" = ${cur.at} AND x."id" < ${cur.id}))`);
    const res = await this.db.execute(sql`
      SELECT * FROM (${this.base(agentId, 'work')}) x
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY x."createdAt" DESC, x."id" DESC
      LIMIT ${limit + 1}
    `);
    const rows = rowsOf(res) as Row[];
    const prices = await this.prices();
    const runs = rows.slice(0, limit).map((r) => this.toRun(r, prices));
    const last = runs.at(-1);
    const nextCursor = rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;

    // the chips: every trigger group under the other filters
    const gres = await this.db.execute(sql`
      SELECT x."trigger" AS "trigger", x."triggerKey" AS "key", COUNT(*) AS "count", MAX(x."createdAt") AS "lastAt",
             MAX(x."taskKey") AS "taskKey", MAX(x."taskTitle") AS "taskTitle"
      FROM (${this.base(agentId, 'work')}) x
      WHERE ${sql.join(this.filters(query, { withTrigger: false }), sql` AND `)}
      GROUP BY x."trigger", x."triggerKey"
      ORDER BY MAX(x."createdAt") DESC
      LIMIT 60
    `);
    const groups = (rowsOf(gres) as Array<{ trigger: WorkTrigger; key: string; count: unknown; lastAt: string; taskKey: string | null; taskTitle: string | null }>)
      .map((g) => ({ trigger: g.trigger, key: g.key ?? '', label: labelOf(g.trigger, g.key ?? '', g.taskKey, g.taskTitle), count: Number(g.count), lastAt: g.lastAt }));
    return { runs, nextCursor, groups };
  }

  /** One run in full: the summary plus its transcript (thinking included)
   *  and its tool calls with inputs and outputs. Any session of the agent —
   *  a link to a run never 404s because of its session's kind. */
  async run(agentId: string, turnId: string): Promise<WorkRunDetail> {
    await this.agents.get(agentId);
    const res = await this.db.execute(sql`SELECT * FROM (${this.base(agentId, 'any')}) x WHERE x."id" = ${turnId} LIMIT 1`);
    const row = (rowsOf(res) as Row[])[0];
    if (!row) throw new NotFoundException(`run ${turnId}`);
    const run = this.toRun(row, await this.prices());
    const mres = await this.db.execute(sql`
      SELECT m."id", m."seq", m."role", m."content", m."toolName", m."createdAt"
      FROM chat_messages m WHERE m."sessionId" = ${row.sessionId} AND m."turnId" = ${turnId}
      ORDER BY m."seq" ASC
    `);
    const messages = (rowsOf(mres) as WorkRunDetail['messages']).map((m) => ({ ...m, seq: Number(m.seq), toolName: m.toolName ?? null }));
    const toolCalls = parseCalls(row.toolCalls).map((c) => ({
      tool: c.tool, input: c.input ?? {}, result: typeof c.result === 'string' ? c.result : '', approved: c.approved ?? '', isError: c.isError === true,
      ...(c.actionClass ? { actionClass: c.actionClass } : {}),
    }));
    return { ...run, messages, toolCalls };
  }

  /** Where a session's runs live: the newest run of a session, so a deep
   *  link to a work session opens its latest run in the Work log. */
  async latestRunOf(agentId: string, sessionId: string): Promise<{ turnId: string | null }> {
    await this.agents.get(agentId);
    const res = await this.db.execute(sql`
      SELECT t."id" FROM chat_turns t JOIN chat_sessions s ON s."id" = t."sessionId"
      WHERE s."id" = ${sessionId} AND s."agentId" = ${agentId} AND s."accountId" = ${currentAccountId()}
      ORDER BY t."seq" DESC LIMIT 1
    `);
    return { turnId: (rowsOf(res) as Array<{ id: string }>)[0]?.id ?? null };
  }

  // ---- query ----

  /** Every turn of the agent's sessions of `kind`, with its trigger,
   *  outcome, task and cost columns. A member of a shared workspace sees
   *  the shared sessions and their own (docs/shared-agents.md §5). */
  private base(agentId: string, kind: 'work' | 'any'): SQL {
    const viewer = currentViewer();
    const visible = viewer && viewer.role !== 'owner'
      ? sql`AND (s."shared" = 1 OR s."initiatedBy" = ${viewer.memberAccountId})`
      : sql``;
    const ofKind = kind === 'work' ? sql`AND s."kind" = 'work'` : sql``;
    const isChannel = sql`((s."name" LIKE '#%' AND s."name" LIKE '% · %') OR s."tags" LIKE '%"channel"%')`;
    return sql`
      SELECT y.*,
        CASE y."trigger"
          WHEN 'loop' THEN SUBSTRING(y."sessionName" FROM 8)
          WHEN 'task' THEN COALESCE(y."taskKey", y."taskId")
          WHEN 'meeting' THEN SPLIT_PART(y."sessionName", ' · ', 1)
          WHEN 'channel' THEN SPLIT_PART(y."sessionName", ' · ', 1)
          WHEN 'heartbeat' THEN ''
          ELSE y."sessionName"
        END AS "triggerKey"
      FROM (
        SELECT t."id", t."sessionId", t."seq", LEFT(t."input", 2000) AS "input", t."status", t."error",
          t."tokensIn", t."tokensOut", t."model", s."model" AS "sessionModel", t."toolCalls", t."createdAt",
          s."name" AS "sessionName", s."archivedAt",
          CASE
            WHEN s."name" = 'Loop · heartbeat' THEN 'heartbeat'
            WHEN s."name" LIKE 'Loop · %' THEN 'loop'
            WHEN ot."id" IS NOT NULL OR atk."id" IS NOT NULL THEN 'task'
            WHEN ${isChannel} AND t."input" ~ ${MEETING_INPUT_RE} THEN 'meeting'
            WHEN ${isChannel} THEN 'channel'
            WHEN s."name" LIKE 'App · %' THEN 'app'
            WHEN s."name" LIKE 'Org · %' OR s."name" LIKE 'Red team · %' OR s."name" LIKE 'Eval · %' THEN 'org'
            ELSE 'other'
          END AS "trigger",
          CASE
            WHEN t."status" = 'running' THEN 'running'
            WHEN t."status" = 'error' OR r."status" IN ('failed', 'loop', 'killed') THEN 'error'
            WHEN r."outcome" = 'blocked' OR r."status" IN ('budget_stop', 'refused') THEN 'blocked'
            WHEN t."status" = 'stopped' THEN 'stopped'
            ELSE 'done'
          END AS "outcome",
          r."usd" AS "runUsd",
          CASE WHEN ot."id" IS NOT NULL THEN 'org' WHEN atk."id" IS NOT NULL THEN 'agent' ELSE NULL END AS "taskKind",
          COALESCE(ot."id", atk."id") AS "taskId",
          COALESCE(ot."key", atk."key") AS "taskKey",
          COALESCE(ot."title", atk."title") AS "taskTitle",
          (SELECT LEFT(m."content", 400) FROM chat_messages m WHERE m."turnId" = t."id" AND m."role" = 'assistant' ORDER BY m."seq" DESC LIMIT 1) AS "answer",
          (SELECT COUNT(*) FROM chat_messages m WHERE m."turnId" = t."id" AND m."role" = 'thinking') AS "thinkingCount"
        FROM chat_turns t
        JOIN chat_sessions s ON s."id" = t."sessionId"
        LEFT JOIN LATERAL (
          SELECT r0."taskId", r0."status", r0."outcome", r0."usd" FROM org_runs r0
          WHERE r0."sessionId" = t."sessionId" AND r0."startedAt" <= t."createdAt"
          ORDER BY r0."startedAt" DESC LIMIT 1
        ) r ON TRUE
        LEFT JOIN org_tasks ot ON ot."id" = COALESCE(r."taskId", CASE WHEN s."taskKind" = 'org' THEN s."taskId" END)
        LEFT JOIN agent_tasks atk ON s."taskKind" = 'agent' AND atk."id" = s."taskId"
        WHERE s."agentId" = ${agentId} AND s."accountId" = ${currentAccountId()} ${ofKind} ${visible}
      ) y
    `;
  }

  private filters(query: WorkLogQuery, opts: { withTrigger: boolean }): SQL[] {
    const out: SQL[] = [sql`TRUE`];
    const trigger = (query.trigger ?? '').trim();
    if (opts.withTrigger && (WORK_TRIGGERS as readonly string[]).includes(trigger)) {
      out.push(sql`x."trigger" = ${trigger}`);
      if (query.key !== undefined && query.key !== '') out.push(sql`x."triggerKey" = ${query.key}`);
    }
    const outcome = (query.outcome ?? '').trim();
    if ((WORK_OUTCOMES as readonly string[]).includes(outcome)) out.push(sql`x."outcome" = ${outcome}`);
    const task = (query.task ?? '').trim();
    if (task) out.push(sql`(x."taskId" = ${task} OR UPPER(COALESCE(x."taskKey", '')) = ${task.toUpperCase()})`);
    if (query.sessionId) out.push(sql`x."sessionId" = ${query.sessionId}`);
    const from = dayStart(query.from);
    if (from) out.push(sql`x."createdAt" >= ${from}`);
    const to = dayEnd(query.to);
    if (to) out.push(sql`x."createdAt" < ${to}`);
    const q = (query.q ?? '').trim().slice(0, 200);
    if (q) {
      const pat = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      out.push(sql`(x."input" ILIKE ${pat} OR x."sessionName" ILIKE ${pat} OR COALESCE(x."taskKey", '') ILIKE ${pat} OR COALESCE(x."taskTitle", '') ILIKE ${pat}
        OR EXISTS (SELECT 1 FROM chat_messages m WHERE m."turnId" = x."id" AND m."content" ILIKE ${pat}))`);
    }
    return out;
  }

  private async prices() {
    try { return this.settings ? parsePriceOverrides((await this.settings.all()).pricingOverrides) : {}; } catch { return {}; }
  }

  private toRun(r: Row, prices: PriceTable): WorkRun {
    const calls = parseCalls(r.toolCalls);
    const tools: string[] = [];
    for (const c of calls) if (c.tool && !tools.includes(c.tool) && tools.length < 8) tools.push(c.tool);
    const files: WorkRun['files'] = [];
    for (const c of calls) {
      const op = FILE_WRITE_TOOLS[c.tool];
      const path = op && c.input && typeof (c.input as { path?: unknown }).path === 'string' ? (c.input as { path: string }).path : '';
      if (path && !c.isError && !files.some((f) => f.path === path && f.op === op)) files.push({ path, op });
    }
    const tokensIn = Number(r.tokensIn) || 0;
    const tokensOut = Number(r.tokensOut) || 0;
    const model = r.model || r.sessionModel || '';
    const runUsd = r.runUsd === null || r.runUsd === undefined ? null : Number(r.runUsd);
    const usd = runUsd !== null && runUsd > 0 ? runUsd : (model ? usdFor(model, tokensIn, tokensOut, prices) : null);
    const thinkingCount = Number(r.thinkingCount) || 0;
    const task: WorkRunTask | null = r.taskKind && r.taskId ? { kind: r.taskKind, id: r.taskId, key: r.taskKey ?? null, title: r.taskTitle ?? '' } : null;
    return {
      id: r.id, sessionId: r.sessionId, sessionName: r.sessionName,
      trigger: r.trigger, triggerKey: r.triggerKey ?? '', label: labelOf(r.trigger, r.triggerKey ?? '', r.taskKey, r.taskTitle),
      outcome: r.outcome, status: r.status, error: r.error ?? null,
      input: (r.input ?? '').slice(0, 2000), answer: (r.answer ?? '').slice(0, 400),
      tokensIn, tokensOut, usd, model,
      steps: calls.length + thinkingCount, toolCount: calls.length, thinkingCount, tools, files, task,
      archived: !!r.archivedAt, createdAt: r.createdAt,
    };
  }
}

/** How a trigger group reads: "Heartbeat", "Loop · digest", "ENG-12 Close
 *  the books", "Meeting · #eng", "#general", the org session's name. */
export function labelOf(trigger: WorkTrigger, key: string, taskKey: string | null, taskTitle: string | null): string {
  switch (trigger) {
    case 'heartbeat': return 'Heartbeat';
    case 'loop': return `Loop · ${key}`;
    case 'task': return [taskKey, taskTitle].filter(Boolean).join(' ') || `Task ${key.slice(0, 8)}`;
    case 'meeting': return `Meeting · ${key}`;
    case 'channel': return key;
    case 'app': return key.replace(/^App · /, 'Mini app · ');
    default: return key.replace(/^Org · /, '');
  }
}

function parseCalls(raw: string): Array<{ tool: string; input?: unknown; result?: unknown; approved?: string; isError?: boolean; actionClass?: string }> {
  try {
    const v = JSON.parse(raw || '[]') as unknown;
    return Array.isArray(v) ? v.filter((c): c is { tool: string } => !!c && typeof (c as { tool?: unknown }).tool === 'string') : [];
  } catch { return []; }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function dayStart(v?: string): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  const d = new Date(DATE_ONLY.test(s) ? `${s}T00:00:00.000Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** The exclusive end: a date-only `to` covers that whole day. */
function dayEnd(v?: string): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  const d = new Date(DATE_ONLY.test(s) ? `${s}T00:00:00.000Z` : s);
  if (Number.isNaN(d.getTime())) return null;
  return DATE_ONLY.test(s) ? new Date(d.getTime() + 86_400_000).toISOString() : d.toISOString();
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString('base64url');
}
function decodeCursor(raw?: string | null): { at: string; id: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') return { at: v[0], id: v[1] };
  } catch { /* a malformed cursor reads as the first page */ }
  return null;
}
