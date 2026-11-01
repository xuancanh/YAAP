/**
 * AgentsService — durable agent identities (§11): global persistent agents
 * with a charter, provider/model defaults, and an optional file-brain home
 * folder. The brain (LESSONS.md / JOURNAL.md / knowledge/) and mini apps are
 * follow-up work; this scaffold owns the profile CRUD and pending feedback.
 */
import { Injectable, Inject, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import { AccountsService } from '../accounts/accounts.service';
import { actorId, currentAccountId } from '../accounts/account-context';
import { unscoped } from '../accounts/scoped-db';
import type { DrizzleDb } from '../database/database.module';
import { agents, agentEvents, agentTasks, chatSessions, chatTurns, heartbeatState } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { StorageService } from '../storage/storage.service';
import { agentFileKey, agentPrefix } from '../storage/storage.keys';
import { assertPublicUrl, fetchPublic } from '../common/url-guard';
import { AiToolSpec } from '../ai/ai-provider.interface';
import { TriggerBus } from '../chats/trigger-bus';
import { hashWebhookSecret, validateLoopDef, type LoopDef } from '../chats/loop-def';
import { cardById, loopForUse, type CardGrantLevel } from '../connections/cards';

/** A self-built mini app (FR-11.5): a self-contained HTML tool the agent
 *  writes for itself via save_app. Rendered only in a network-blocked
 *  sandboxed iframe (FR-13.1). */
export interface AgentApp {
  id: string;
  name: string;
  description: string;
  html: string;
  updatedAt: string;
  /** Capability manifest requested via save_app (docs/miniapp-capabilities.md). */
  capabilities?: string[];
  /** Subset of `capabilities` the user has activated. Free-tier caps are
   *  granted at save; elevated ones park here only after explicit review. */
  approved?: string[];
}

/** The full capability vocabulary; unknown names are rejected at save. */
export const APP_CAPABILITIES = [
  'storage', 'chat.compose', 'files.read', 'files.write', 'tasks.read', 'tasks.write', 'agent.ask',
  // docs/miniapp-roadmap.md: act two — a tool-free model call, structured
  // data, connection-backed reads with propose-to-mutate, and the sandboxed
  // code runner. All elevated; none of them widen an app past its agent.
  'llm', 'data', 'connections', 'compute',
] as const;
/** Caps that activate silently — they add persistence/convenience, not reach. */
export const APP_FREE_CAPS = new Set<string>(['storage', 'chat.compose']);

const APP_LIMIT = 12;
const APP_HTML_CAP = 300_000;
const DASHBOARD_CAP = 50_000;

/** A self-built HTTP tool (roadmap: agents build tools from user requests).
 *  Proposed by the agent, inert until the user approves it, executed through
 *  the same SSRF guard as http_request. {param} placeholders in url/body are
 *  filled from the tool call's arguments. */
export interface AgentCustomTool {
  id: string;
  name: string;
  slug: string;
  description: string;
  method: 'GET' | 'POST';
  url: string;
  body?: string;
  params: string[];
  enabled: boolean;
  proposedAt: string;
  approvedAt?: string;
}

export const CUSTOM_TOOL_PREFIX = 'tool_';
const TOOL_LIMIT = 12;
const PARAM_RE = /\{([a-z0-9_]+)\}/g;

export type TaskStatus = 'todo' | 'doing' | 'done';
const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'done'];
const TASK_LIMIT = 200;

/** `Fieldy, the Scout!` → `fieldy-the-scout`; nothing usable → `agent`. */
export function emailSlugify(name: string): string {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return slug || 'agent';
}

/** Push channels that each own a delivered-at column on agent_events. */
export type DeliveryChannel = 'telegram' | 'email' | 'push';

/** Where a delivered inbox event should take the person: a deep link the
 *  event carries in its payload (group-chat mentions: `#/ws/<id>/channel/
 *  <slug>/<messageId>`, docs/group-chat.md §4), else its chat session, else
 *  nothing. Shared by the Telegram, email and push sweeps. */
export function eventLink(e: { sessionId: string | null; payload?: string | null }, base: string): string {
  const link = payloadField(e.payload, 'link');
  if (link) return link.startsWith('http') ? link : `${base}${link.startsWith('/') ? '' : '/'}${link}`;
  return e.sessionId ? `${base}/#/chat/${e.sessionId}` : '';
}

/** `<sender> · <title>`: the agent's name, or what the payload names as the
 *  sender for events that belong to no agent (a channel mention). */
export function eventHead(e: { agentId: string; title: string; payload?: string | null }, names: Map<string, string>): string {
  const from = names.get(e.agentId) ?? payloadField(e.payload, 'from') ?? 'Agent';
  return `${from} · ${e.title}`;
}

function payloadField(payload: string | null | undefined, key: string): string | null {
  if (!payload) return null;
  try {
    const v = (JSON.parse(payload) as Record<string, unknown>)[key];
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}
const DELIVERY_COLUMNS = { telegram: 'deliveredAt', email: 'emailDeliveredAt', push: 'pushDeliveredAt' } as const;

/** Enabled loops across a set of agents (plan cap, docs/accounts.md §4). */
function enabledLoopCount(rows: Array<{ loops: string }>): number {
  let n = 0;
  for (const r of rows) {
    try {
      for (const l of JSON.parse(r.loops) as Array<{ enabled?: boolean }>) if (l?.enabled !== false) n++;
    } catch { /* unparseable loops count as none */ }
  }
  return n;
}

@Injectable()
export class AgentsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly storage: StorageService,
    /** Optional so test constructors without a bus keep working; when
     *  present, every addTask announces itself (the `task` trigger). */
    @Optional() private readonly bus?: TriggerBus,
    /** Optional likewise; when present, plan caps (agents, enabled loops)
     *  are enforced on every write (docs/accounts.md §4). */
    @Optional() private readonly accounts?: AccountsService,
  ) {}

  list() {
    return this.db.select().from(agents);
  }

  async get(id: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`agent ${id}`);
    return rows[0];
  }

  /** `workspaceId` is accepted ahead of the per-workspace agents migration
   *  (each workspace owns its agents); until that column exists it is read
   *  and ignored here, so callers already pass it. */
  async create(input: { name: string; charter?: string; provider?: string; model?: string; homeDir?: string; emoji?: string; colors?: [string, string]; role?: string; loops?: unknown[]; workspaceId?: string }) {
    if (this.accounts) {
      const existing = await this.list();
      await this.accounts.assertCanCreateAgent(existing.length);
      await this.accounts.assertLoopCap(enabledLoopCount(existing) + enabledLoopCount([{ loops: JSON.stringify(input.loops ?? []) }]));
    }
    const id = newId();
    const row = {
      id,
      name: input.name,
      emoji: input.emoji ?? '\u{1F916}',
      colors: JSON.stringify(input.colors ?? ['#8b8cf0', '#5cc2f2']),
      role: input.role ?? '',
      charter: input.charter ?? '',
      provider: input.provider ?? 'anthropic',
      model: input.model ?? '',
      homeDir: input.homeDir ?? `agents/${id}`,
      dashboard: '',
      apps: '[]',
      loops: JSON.stringify(input.loops ?? []),
      pendingFeedback: '[]',
      emailSlug: await this.uniqueEmailSlug(input.name),
      // The gated heartbeat is on from birth, on the workspace cadence
      // (docs/company-vision.md §13; chats/heartbeat.service.ts).
      heartbeatEnabled: 1,
      heartbeatCron: '',
      heartbeatDailyRunCap: null,
      heartbeatStaleMinutes: null,
      createdAt: nowIso(),
    };
    await this.db.insert(agents).values(row);
    await this.seedBrain(row.id, row.name);
    return row;
  }

  // ---- email addresses (channels/email.service.ts) ----

  /** A free `emailSlug` derived from `name`: lowercase ascii, dashes for
   *  runs of anything else, '-2', '-3', … on collision. Never empty. */
  async uniqueEmailSlug(name: string): Promise<string> {
    const base = emailSlugify(name);
    // Unscoped on purpose: the address is global, so the slug must be unique
    // across every account, not just this one.
    const taken = new Set((await unscoped(this.db).select({ emailSlug: agents.emailSlug }).from(agents)).map((r) => r.emailSlug));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Agents created before the email channel have no slug yet: assign one
   *  to each, idempotently. Returns every agent with its slug. */
  async ensureEmailSlugs() {
    const rows = await this.db.select().from(agents);
    for (const a of rows) {
      if (a.emailSlug) continue;
      a.emailSlug = await this.uniqueEmailSlug(a.name);
      await this.db.update(agents).set({ emailSlug: a.emailSlug }).where(eq(agents.id, a.id));
    }
    return rows;
  }

  /** Unscoped on purpose: inbound mail arrives before any account is known;
   *  the caller runs the rest under `row.accountId`. */
  async findByEmailSlug(slug: string) {
    const rows = await unscoped(this.db).select().from(agents).where(eq(agents.emailSlug, slug)).limit(1);
    return rows.at(0) ?? null;
  }

  /** Seed the transparent file brain (FR-11.3) so the fs view has structure
   *  from day one. */
  private async seedBrain(id: string, name: string): Promise<void> {
    const files: Array<[string, string]> = [
      ['LESSONS.md', `# LESSONS.md\n\n${name} has not recorded lessons yet.\nCompleted work distills into size-bounded appends here.\n`],
      ['JOURNAL.md', `# JOURNAL.md\n\nFreshly created. The journal fills as ${name} completes scheduled and interactive work.\n`],
      ['knowledge/README.md', `# knowledge/\n\nUser- and agent-maintained reference files live here.\n`],
    ];
    for (const [path, content] of files) {
      await this.storage.put(agentFileKey(id, path), Buffer.from(content, 'utf8'), 'text/markdown').catch(() => {});
    }
  }

  async update(id: string, patch: Partial<{ name: string; charter: string; provider: string; model: string; homeDir: string; dashboard: string; emoji: string; colors: string; role: string; loops: string; workspaceFolder: string }>) {
    await this.get(id);
    if (patch.loops !== undefined) {
      patch.loops = validateLoopsJson(patch.loops);
      if (this.accounts) {
        const others = (await this.list()).filter((a) => a.id !== id);
        await this.accounts.assertLoopCap(enabledLoopCount(others) + enabledLoopCount([{ loops: patch.loops }]));
      }
    }
    if (patch.workspaceFolder !== undefined) {
      const folder = patch.workspaceFolder.trim().replace(/^\/+|\/+$/g, '');
      // reuse the storage-key validation as the safety boundary
      if (folder) agentFileKey('probe', folder);
      patch.workspaceFolder = folder;
    }
    await this.db.update(agents).set(patch).where(eq(agents.id, id));
    return this.get(id);
  }

  // ---- the agent's own kanban board (§11) ----

  listTasks(agentId: string) {
    return this.db.select().from(agentTasks).where(eq(agentTasks.agentId, agentId));
  }

  async addTask(agentId: string, input: { title: string; note?: string; origin?: string; sessionId?: string; channelId?: string | null; messageId?: string | null }) {
    await this.get(agentId);
    const title = (input.title ?? '').trim().slice(0, 200);
    if (!title) throw new BadRequestException('task title is required');
    if ((await this.listTasks(agentId)).length >= TASK_LIMIT) {
      throw new BadRequestException(`task limit (${TASK_LIMIT}) reached — clear done tasks first`);
    }
    const row = {
      id: newId(), agentId, title,
      note: (input.note ?? '').slice(0, 2_000),
      status: 'todo', origin: input.origin ?? 'user',
      sessionId: input.sessionId ?? null,
      // Group chat linkage (docs/group-chat.md §3): the message this task was made from.
      channelId: input.channelId ?? null,
      messageId: input.messageId ?? null,
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    await this.db.insert(agentTasks).values(row);
    this.bus?.emitTaskAdded({ agentId, task: row });
    return row;
  }

  async updateTask(agentId: string, taskId: string, patch: { title?: string; note?: string; status?: string }) {
    const rows = await this.db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
    if (!rows[0] || rows[0].agentId !== agentId) throw new NotFoundException(`task ${taskId}`);
    const set: Record<string, string> = { updatedAt: nowIso() };
    if (patch.title !== undefined) {
      const title = patch.title.trim().slice(0, 200);
      if (!title) throw new BadRequestException('task title cannot be empty');
      set.title = title;
    }
    if (patch.note !== undefined) set.note = patch.note.slice(0, 2_000);
    if (patch.status !== undefined) {
      if (!TASK_STATUSES.includes(patch.status as TaskStatus)) throw new BadRequestException(`status must be one of ${TASK_STATUSES.join(', ')}`);
      set.status = patch.status;
    }
    await this.db.update(agentTasks).set(set).where(eq(agentTasks.id, taskId));
    const updated = (await this.db.select().from(agentTasks).where(eq(agentTasks.id, taskId)))[0];
    // A task made from a channel message reports its status back into that
    // thread (docs/group-chat.md §3) — the group chat listens on the bus.
    if (set.status && set.status !== rows[0].status && updated.channelId) {
      this.bus?.emitTaskStatus({ source: 'agent', taskId, title: updated.title, status: updated.status, previous: rows[0].status, channelId: updated.channelId, messageId: updated.messageId, agentId });
    }
    return updated;
  }

  async deleteTask(agentId: string, taskId: string) {
    const rows = await this.db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
    if (!rows[0] || rows[0].agentId !== agentId) throw new NotFoundException(`task ${taskId}`);
    await this.db.delete(agentTasks).where(eq(agentTasks.id, taskId));
    return { ok: true };
  }

  /** Tool-call variant: the model addresses tasks by the 8-char id prefix it
   *  saw in list_tasks. */
  async updateTaskByPrefix(agentId: string, idPrefix: string, patch: { title?: string; note?: string; status?: string }) {
    const match = (await this.listTasks(agentId)).filter((t) => t.id.startsWith(idPrefix));
    if (match.length !== 1) throw new BadRequestException(`task id "${idPrefix}" matches ${match.length} tasks — use the id from list_tasks`);
    return this.updateTask(agentId, match[0].id, patch);
  }

  /** Board summary for the agent's tool calls: bounded, text-shaped. */
  async tasksForModel(agentId: string): Promise<string> {
    const tasks = await this.listTasks(agentId);
    if (tasks.length === 0) return 'The board is empty.';
    const lines = tasks
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, 100)
      .map((t) => `[${t.id.slice(0, 8)}] (${t.status}) ${t.title}${t.note ? ` — ${t.note.slice(0, 120)}` : ''}`);
    return lines.join('\n');
  }

  // ---- self-built HTTP tools: proposed by the agent, user-activated ----

  async listCustomTools(id: string): Promise<AgentCustomTool[]> {
    const a = await this.get(id);
    try { return JSON.parse(a.tools) as AgentCustomTool[]; } catch { return []; }
  }

  /** save_tool: the agent turns a recurring user request into a callable
   *  HTTP tool. It lands disabled — the user reviews destination and shape
   *  before it can ever run. Same name replaces (re-approval required). */
  async saveCustomTool(id: string, input: { name: string; description?: string; method?: string; url: string; body?: string }): Promise<string> {
    const name = (input.name ?? '').trim().slice(0, 60);
    if (!name) throw new BadRequestException('tool name is required');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!slug) throw new BadRequestException('could not derive a slug from that tool name');
    const method = (input.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw new BadRequestException('method must be GET or POST');
    const url = (input.url ?? '').trim().slice(0, 500);
    const body = typeof input.body === 'string' ? input.body.slice(0, 2_000) : undefined;
    // the host must be literal: a {param} in the authority would let the
    // approved destination be swapped at call time
    if (url.split('/').slice(0, 3).join('/').includes('{')) {
      throw new BadRequestException('the URL host must be literal — placeholders are only allowed in the path and query');
    }
    await assertPublicUrl(url.replace(PARAM_RE, 'x'));
    const params = [...new Set([...`${url} ${body ?? ''}`.matchAll(PARAM_RE)].map((m) => m[1]))];
    const tools = await this.listCustomTools(id);
    const existing = tools.find((t) => t.slug === slug);
    const row: AgentCustomTool = {
      id: existing?.id ?? newId(), name, slug,
      description: (input.description ?? '').slice(0, 300),
      method, url, ...(body ? { body } : {}), params,
      enabled: false, proposedAt: nowIso(),
    };
    const next = existing ? tools.map((t) => (t.slug === slug ? row : t)) : [...tools, row];
    if (!existing && next.length > TOOL_LIMIT) {
      throw new BadRequestException(`tool limit (${TOOL_LIMIT}) reached — delete one first`);
    }
    await this.db.update(agents).set({ tools: JSON.stringify(next) }).where(eq(agents.id, id));
    return `Tool "${name}" proposed${existing ? ' (replaces the previous version, which is disabled until re-approved)' : ''}. The user must review and enable it before you can call it.`;
  }

  async resolveCustomTool(id: string, toolId: string, approve: boolean) {
    const tools = await this.listCustomTools(id);
    const tool = tools.find((t) => t.id === toolId);
    if (!tool) throw new NotFoundException(`tool ${toolId}`);
    const next = approve
      ? tools.map((t) => (t.id === toolId ? { ...t, enabled: true, approvedAt: nowIso() } : t))
      : tools.filter((t) => t.id !== toolId);
    await this.db.update(agents).set({ tools: JSON.stringify(next) }).where(eq(agents.id, id));
    return { ok: true };
  }

  /** Enabled custom tools as provider tool specs. */
  async customToolSpecs(id: string): Promise<AiToolSpec[]> {
    const tools = await this.listCustomTools(id);
    return tools.filter((t) => t.enabled).map((t) => ({
      name: CUSTOM_TOOL_PREFIX + t.slug,
      description: `[Your tool · user-approved] ${t.description || t.name}. ${t.method} ${t.url}`,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(t.params.map((param) => [param, { type: 'string' }])),
        required: t.params,
      },
    }));
  }

  /** Execute an approved custom tool: substitute params, re-check the SSRF
   *  guard on the resolved URL, cap the response. */
  async executeCustomTool(id: string, toolName: string, input: Record<string, unknown>): Promise<string> {
    const slug = toolName.slice(CUSTOM_TOOL_PREFIX.length);
    const tool = (await this.listCustomTools(id)).find((t) => t.slug === slug && t.enabled);
    if (!tool) throw new Error(`unknown tool: ${toolName}`);
    // Values are escaped for the syntax they land in. The body is sent as
    // JSON, so a raw substitution would let a param close its string and add
    // fields the user never approved ('","admin":true,"x":"'); JSON-escaping
    // keeps it one string value. The host is already literal, so this bounds
    // what a hostile argument can reshape inside an approved request.
    const fill = (template: string, syntax: 'url' | 'json') => template.replace(PARAM_RE, (_m, param: string) => {
      const v = input[param];
      if (typeof v !== 'string') throw new Error(`missing argument "${param}"`);
      return syntax === 'url'
        ? encodeURIComponent(v.slice(0, 500))
        : JSON.stringify(v.slice(0, 2_000)).slice(1, -1);
    });
    const res = await fetchPublic(fill(tool.url, 'url'), {
      method: tool.method,
      headers: tool.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: tool.method === 'POST' && tool.body ? fill(tool.body, 'json') : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    return `${res.status} ${res.statusText}\n${text.length > 8_000 ? `${text.slice(0, 8_000)}\n…(truncated)` : text}`;
  }

  // ---- self-maintenance tools (§11): the agent keeps its own home page ----

  /** update_dashboard: full-markdown replacement of the agent's home page. */
  async updateDashboard(id: string, markdown: string): Promise<string> {
    await this.update(id, { dashboard: markdown.slice(0, DASHBOARD_CAP) });
    return 'Dashboard updated.';
  }

  async listApps(id: string): Promise<AgentApp[]> {
    const a = await this.get(id);
    try { return JSON.parse(a.apps) as AgentApp[]; } catch { return []; }
  }

  /** save_app: create or update (by name) a self-contained HTML mini app.
   *  Any edit re-parks elevated capability grants (what the user approved is
   *  what runs — same rule as custom-tool edits). */
  async saveApp(id: string, input: { name: string; description?: string; html: string; capabilities?: string[] }): Promise<string> {
    const name = (input.name ?? '').trim().slice(0, 60);
    if (!name) throw new BadRequestException('app name is required');
    if (typeof input.html !== 'string' || !input.html.trim()) throw new BadRequestException('app html is required');
    if (input.html.length > APP_HTML_CAP) throw new BadRequestException(`app html exceeds ${APP_HTML_CAP} bytes`);
    const caps = [...new Set(input.capabilities ?? [])];
    const unknown = caps.filter((c) => !(APP_CAPABILITIES as readonly string[]).includes(c));
    if (unknown.length > 0) {
      throw new BadRequestException(`unknown capabilities: ${unknown.join(', ')} (valid: ${APP_CAPABILITIES.join(', ')})`);
    }
    const freeGrants = caps.filter((c) => APP_FREE_CAPS.has(c));
    const apps = await this.listApps(id);
    const existing = apps.find((x) => x.name === name);
    if (existing) {
      existing.html = input.html;
      existing.description = input.description ?? existing.description;
      existing.capabilities = caps;
      existing.approved = freeGrants; // elevated grants re-park on every edit
      existing.updatedAt = nowIso();
    } else {
      if (apps.length >= APP_LIMIT) {
        throw new BadRequestException(`app limit (${APP_LIMIT}) reached — delete or update an existing app`);
      }
      apps.push({ id: newId(), name, description: input.description ?? '', html: input.html, capabilities: caps, approved: freeGrants, updatedAt: nowIso() });
    }
    await this.db.update(agents).set({ apps: JSON.stringify(apps) }).where(eq(agents.id, id));
    const parked = caps.filter((c) => !APP_FREE_CAPS.has(c));
    return `Mini app "${name}" saved (${apps.length}/${APP_LIMIT}). It appears on your home page; the user can open it or embed it in a chat.`
      + (parked.length > 0 ? ` Elevated capabilities (${parked.join(', ')}) are parked until the user reviews them on the app card.` : '');
  }

  /** Activate reviewed capabilities for one app (must be requested ones). */
  async approveAppCaps(id: string, appId: string, capabilities: string[]) {
    const apps = await this.listApps(id);
    const entry = apps.find((x) => x.id === appId);
    if (!entry) throw new NotFoundException(`app ${appId}`);
    const requested = new Set(entry.capabilities ?? []);
    const bad = capabilities.filter((c) => !requested.has(c));
    if (bad.length > 0) throw new BadRequestException(`not requested by this app: ${bad.join(', ')}`);
    const free = (entry.capabilities ?? []).filter((c) => APP_FREE_CAPS.has(c));
    entry.approved = [...new Set([...free, ...capabilities])];
    await this.db.update(agents).set({ apps: JSON.stringify(apps) }).where(eq(agents.id, id));
    return entry;
  }

  async deleteApp(id: string, appId: string) {
    const apps = await this.listApps(id);
    const next = apps.filter((x) => x.id !== appId);
    if (next.length === apps.length) throw new NotFoundException(`app ${appId}`);
    await this.db.update(agents).set({ apps: JSON.stringify(next) }).where(eq(agents.id, id));
    return { ok: true };
  }

  async remove(id: string) {
    await this.db.delete(agents).where(eq(agents.id, id));
    await this.db.delete(agentTasks).where(eq(agentTasks.agentId, id));
    await this.db.delete(heartbeatState).where(eq(heartbeatState.agentId, id)).catch(() => {});
    await this.storage.deletePrefix(agentPrefix(id)).catch(() => {});
    return { ok: true };
  }

  /** Per-agent append queues: a brain-file append is get-modify-put against
   *  storage with no concurrency control, so two distills racing the same
   *  agent would lose an entry. Queued (not rejected, unlike ChatLocks) —
   *  an append must never be dropped. */
  private readonly brainAppends = new Map<string, Promise<void>>();

  /** Size-bounded append to a brain file (FR-11.4): the append is capped and
   *  the file keeps only its newest tail once it outgrows the bound. */
  private async appendBrainFile(agentId: string, file: string, entry: string, header: string): Promise<void> {
    const prev = this.brainAppends.get(agentId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.writeBrainFile(agentId, file, entry, header));
    this.brainAppends.set(agentId, next);
    try {
      await next;
    } finally {
      if (this.brainAppends.get(agentId) === next) this.brainAppends.delete(agentId);
    }
  }

  private async writeBrainFile(agentId: string, file: string, entry: string, header: string): Promise<void> {
    const APPEND_CAP = 2_000;
    const FILE_CAP = 100_000;
    const KEEP = 80_000;
    const key = agentFileKey(agentId, file);
    const existing = await this.storage.get(key).catch(() => null);
    if (existing) await this.checkpointBrainFile(agentId, file, existing).catch(() => {});
    let text = existing ? existing.toString('utf8') : header;
    text = `${text.trimEnd()}\n\n${entry.slice(0, APPEND_CAP).trim()}\n`;
    if (text.length > FILE_CAP) text = `${header}(older entries trimmed)\n\n…${text.slice(text.length - KEEP)}`;
    await this.storage.put(key, Buffer.from(text, 'utf8'), 'text/markdown');
  }

  /** Brain checkpoints (phase 3): before the first change of a day, snapshot
   *  the file to .checkpoints/<date>/<file> so growth is never a one-way
   *  door. The newest 14 days are kept; restore = copy a checkpoint back. */
  private async checkpointBrainFile(agentId: string, file: string, current: Buffer): Promise<void> {
    const date = nowIso().slice(0, 10);
    const cpKey = agentFileKey(agentId, `.checkpoints/${date}/${file}`);
    if ((await this.storage.get(cpKey).catch(() => null)) !== null) return; // one per day
    await this.storage.put(cpKey, current, 'text/markdown');
    // prune: keep the newest 14 checkpoint days
    const all = await this.storage.list(`${agentPrefix(agentId)}.checkpoints/`).catch(() => []);
    const days = [...new Set(all.map((o) => o.key.split('/.checkpoints/')[1]?.split('/')[0]).filter(Boolean))].sort();
    for (const old of days.slice(0, Math.max(0, days.length - 14))) {
      await this.storage.deletePrefix(`${agentPrefix(agentId)}.checkpoints/${old}/`).catch(() => {});
    }
  }

  async appendJournal(agentId: string, entry: string): Promise<void> {
    await this.appendBrainFile(agentId, 'JOURNAL.md', entry, '# JOURNAL.md\n');
  }

  async appendLessons(agentId: string, entry: string): Promise<void> {
    await this.appendBrainFile(agentId, 'LESSONS.md', entry, '# LESSONS.md\n');
  }

  /** Chats owned, 👍/👎 totals, and token spend across this agent's
   *  sessions (agent home + cost visibility, roadmap phase 2). */
  async stats(id: string) {
    await this.get(id);
    const sessions = await this.db.select({ id: chatSessions.id }).from(chatSessions)
      .where(eq(chatSessions.agentId, id));
    const ids = sessions.map((s) => s.id);
    let up = 0; let down = 0; let tokensIn = 0; let tokensOut = 0;
    if (ids.length > 0) {
      const turns = await this.db.select({ rating: chatTurns.rating, tokensIn: chatTurns.tokensIn, tokensOut: chatTurns.tokensOut })
        .from(chatTurns).where(inArray(chatTurns.sessionId, ids));
      for (const t of turns) {
        if (t.rating === 'up') up++;
        if (t.rating === 'down') down++;
        tokensIn += t.tokensIn;
        tokensOut += t.tokensOut;
      }
    }
    const rating = up + down > 0 ? Math.round((up / (up + down)) * 100) : null;
    return { chats: ids.length, up, down, rating, tokensIn, tokensOut };
  }

  // ---- the agent inbox (roadmap phase 2): unattended work is never silent ----

  async addEvent(agentId: string, input: {
    kind: string; title: string; body?: string; sessionId?: string; payload?: string;
    /** Quiet-hours delivery (quiet-hours.ts deliveryFor): when channels may
     *  push it, or never. The inbox is unaffected. */
    deliverAfter?: string | null; silent?: boolean;
    /** The turn surface that produced it; channel-originated events are
     *  never echoed back to the channel. */
    origin?: string;
    /** Push to the paired channel even for a non-default agent. */
    channel?: boolean;
    /** Addressed to one member (a routed approval): visible to and
     *  deliverable for them alone (docs/shared-agents.md §3). */
    forMemberAccountId?: string;
  }) {
    const row = {
      id: newId(), agentId,
      forMemberAccountId: input.forMemberAccountId ?? '',
      kind: input.kind, title: input.title.slice(0, 200),
      body: (input.body ?? '').slice(0, 1_000),
      payload: input.payload ?? '',
      sessionId: input.sessionId ?? null,
      readAt: null, createdAt: nowIso(),
      deliverAfter: input.deliverAfter ?? null,
      silent: input.silent ? 1 : 0,
      origin: input.origin ?? '',
      // Failures and budget stops are the alerts people pair a channel for;
      // they travel regardless of which agent is the channel's default.
      channel: (input.channel ?? (input.kind === 'loop_error' || input.kind === 'budget_stop')) ? 1 : 0,
      deliveredAt: null,
    };
    await this.db.insert(agentEvents).values(row);
    // keep the inbox bounded: retain the newest 200 events per agent,
    // SQL-side so every insert doesn't re-read the whole inbox
    await this.db.execute(sql`
      DELETE FROM agent_events
      WHERE "agentId" = ${agentId}
        AND "id" NOT IN (
          SELECT "id" FROM agent_events
          WHERE "agentId" = ${agentId}
          ORDER BY "createdAt" DESC
          LIMIT 200
        )
    `);
    return row;
  }

  /** The inbox as the current actor may see it: an event addressed to one
   *  member (a routed approval) is hidden from everyone else — the group only
   *  ever learns that someone's approval is awaited, never what. */
  async listEvents(agentId: string, limit = 50) {
    const me = actorId();
    const rows = await this.db.select().from(agentEvents).where(eq(agentEvents.agentId, agentId));
    return rows
      .filter((r) => r.forMemberAccountId === '' || r.forMemberAccountId === me)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
  }

  async getEvent(agentId: string, eventId: string) {
    const ev = (await this.db.select().from(agentEvents).where(eq(agentEvents.id, eventId))).at(0);
    if (!ev || ev.agentId !== agentId) throw new NotFoundException(`event ${eventId}`);
    return ev;
  }

  async patchEvent(eventId: string, patch: Partial<typeof agentEvents.$inferInsert>) {
    await this.db.update(agentEvents).set(patch).where(eq(agentEvents.id, eventId));
  }

  /** Unread event counts for every agent (rail badges), one query. */
  async unreadEventCounts(): Promise<Record<string, number>> {
    const me = actorId();
    const rows = await this.db.select({ agentId: agentEvents.agentId, forMemberAccountId: agentEvents.forMemberAccountId })
      .from(agentEvents).where(isNull(agentEvents.readAt));
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (r.forMemberAccountId !== '' && r.forMemberAccountId !== me) continue;
      out[r.agentId] = (out[r.agentId] ?? 0) + 1;
    }
    return out;
  }

  /** Events a channel may push now: not yet delivered on that channel, not
   *  silent, past their quiet-hours release, and not born on a channel turn
   *  (echoing those back would loop). Each channel owns a delivery column —
   *  Telegram `deliveredAt`, email `emailDeliveredAt`, web push
   *  `pushDeliveredAt` — so a phone push never hides an event from the
   *  inbox digest. Oldest first so a batch reads chronologically. */
  async undeliveredEvents(now: Date = new Date(), channel: DeliveryChannel = 'telegram') {
    const nowIso = now.toISOString();
    const col = DELIVERY_COLUMNS[channel];
    const rows = await this.db.select().from(agentEvents)
      .where(and(
        isNull(agentEvents[col]),
        eq(agentEvents.silent, 0),
        or(isNull(agentEvents.deliverAfter), lte(agentEvents.deliverAfter, nowIso)),
      ));
    // Addressed events travel to their addressee's channels only
    // (SharedService.addressedEvents); the account's own sweep skips them.
    return rows
      .filter((r) => r.origin !== 'channel' && (r.forMemberAccountId === '' || r.forMemberAccountId === currentAccountId()))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async markEventsDelivered(ids: string[], at: Date = new Date(), channel: DeliveryChannel = 'telegram') {
    if (ids.length === 0) return;
    const col = DELIVERY_COLUMNS[channel];
    await this.db.update(agentEvents).set({ [col]: at.toISOString() }).where(inArray(agentEvents.id, ids));
  }

  async markEventsRead(agentId: string) {
    await this.db.update(agentEvents).set({ readAt: nowIso() })
      .where(and(eq(agentEvents.agentId, agentId), isNull(agentEvents.readAt)));
    return { ok: true };
  }

  /** Resolve an action_pending inbox event: a mutating call a background
   *  turn queued instead of executing (docs/integrations.md §5). The caller
   *  supplies the executor so this module stays decoupled from the tool
   *  owner (the controller wires in ConnectionsService.execute). */
  async resolveActionEvent(
    agentId: string,
    eventId: string,
    approve: boolean,
    executor: (agentId: string, tool: string, input: Record<string, unknown>) => Promise<string>,
  ): Promise<{ ok: boolean; status: 'done' | 'failed' | 'dismissed'; result?: string; error?: string }> {
    const ev = (await this.db.select().from(agentEvents).where(eq(agentEvents.id, eventId))).at(0);
    if (!ev || ev.agentId !== agentId) throw new NotFoundException(`event ${eventId}`);
    if (ev.kind !== 'action_pending') throw new BadRequestException('event is not awaiting approval');
    if (!approve) {
      await this.db.update(agentEvents).set({ kind: 'action_dismissed', readAt: nowIso() }).where(eq(agentEvents.id, eventId));
      return { ok: true, status: 'dismissed' };
    }
    const payload = JSON.parse(ev.payload || '{}') as { tool?: string; input?: Record<string, unknown> };
    if (!payload.tool) throw new BadRequestException('event has no runnable payload');
    try {
      const result = await executor(agentId, payload.tool, payload.input ?? {});
      await this.db.update(agentEvents)
        .set({ kind: 'action_done', body: `${ev.body}\n→ ${result}`.slice(0, 1_000), readAt: nowIso() })
        .where(eq(agentEvents.id, eventId));
      return { ok: true, status: 'done', result: result.slice(0, 500) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db.update(agentEvents)
        .set({ kind: 'action_failed', body: `${ev.body}\n→ failed: ${message}`.slice(0, 1_000), readAt: nowIso() })
        .where(eq(agentEvents.id, eventId));
      return { ok: false, status: 'failed', error: message.slice(0, 300) };
    }
  }

  /** AGENT.json import (FR-11.7): validate hard before install, because
   *  imported loops enable immediately — the client shows the capability
   *  review, the server enforces the bounds. */
  async importJson(profile: Record<string, unknown>) {
    const fail = (msg: string): never => { throw new BadRequestException(`invalid AGENT.json: ${msg}`); };
    const name = profile.name;
    if (typeof name !== 'string' || name.length < 1 || name.length > 60) fail('name must be 1-60 chars');
    if ((await this.list()).some((a) => a.name === name)) fail(`an agent named "${name}" already exists`);
    const charter = typeof profile.charter === 'string' ? profile.charter.slice(0, 20_000) : '';
    const role = typeof profile.role === 'string' ? profile.role.slice(0, 80) : '';
    const emoji = typeof profile.emoji === 'string' && profile.emoji.length <= 8 ? profile.emoji : undefined;
    let colors: [string, string] | undefined;
    if (Array.isArray(profile.colors) && profile.colors.length === 2 &&
        profile.colors.every((c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c))) {
      colors = profile.colors as [string, string];
    }
    const rawLoops = Array.isArray(profile.loops) ? profile.loops : [];
    if (rawLoops.length > 10) fail('at most 10 loops');
    // Shared validator with the schedule editor; a webhook trigger in a
    // profile never carries a usable secret, so it is minted on import.
    const loops = JSON.parse(validateLoopsJson(JSON.stringify(rawLoops.map((l) => validateLoopDef(l, fail))))) as LoopDef[];
    const agent = await this.create({ name: name as string, charter, role, emoji, colors, loops });
    if (typeof profile.dashboard === 'string' && profile.dashboard) {
      await this.update(agent.id, { dashboard: profile.dashboard.slice(0, DASHBOARD_CAP) });
    }
    if (Array.isArray(profile.apps)) {
      for (const raw of profile.apps.slice(0, APP_LIMIT)) {
        const app = raw as Record<string, unknown>;
        if (typeof app?.name !== 'string' || typeof app?.html !== 'string') continue;
        // Capabilities travel with the app; saveApp grants the free tier and
        // parks the elevated ones for review, exactly as for a save_app call.
        const caps = Array.isArray(app.capabilities)
          ? app.capabilities.filter((c): c is string => typeof c === 'string' && (APP_CAPABILITIES as readonly string[]).includes(c))
          : [];
        await this.saveApp(agent.id, {
          name: app.name,
          description: typeof app.description === 'string' ? app.description.slice(0, 300) : undefined,
          html: app.html.slice(0, APP_HTML_CAP),
          capabilities: caps,
        }).catch(() => {});
      }
    }
    return this.get(agent.id);
  }

  /**
   * Install a context card's suggested loop (docs/integrations.md "Context
   * cards and suggested loops"). `held` is the grant level the agent holds
   * on the card's service (null = none): connection cards refuse without
   * it, or with read when the use needs write; surface cards (browser,
   * computer, channels) carry no grant and install freely. The loop is an
   * ordinary loop afterwards and can be edited.
   */
  async installSuggestedLoop(agentId: string, cardId: string, useId: string, held: CardGrantLevel | null): Promise<{ loop: LoopDef; loops: LoopDef[] }> {
    const agent = await this.get(agentId);
    const card = cardById(cardId);
    if (!card) throw new NotFoundException(`no context card ${cardId}`);
    const use = card.suggestedUses.find((u) => u.id === useId);
    if (!use) throw new NotFoundException(`card ${cardId} has no suggested use ${useId}`);
    const isConnection = card.provider !== '';
    if (isConnection) {
      if (!held) throw new BadRequestException(`${agent.name} holds no ${card.service} grant on ${card.provider} — grant it on the Skills & tools tab first`);
      if (use.grantLevel === 'write' && held !== 'write') throw new BadRequestException(`"${use.title}" needs a write grant on ${card.title}; ${agent.name} holds read`);
    }
    const existing = parseLoopsOf(agent.loops);
    if (existing.length >= 10) throw new BadRequestException('at most 10 loops');
    const loop = loopForUse(use, existing);
    const next = [...existing, loop];
    await this.update(agentId, { loops: JSON.stringify(next) });
    return { loop, loops: parseLoopsOf((await this.get(agentId)).loops) };
  }

  /** Mint (or replace) the shared secret of a webhook-triggered loop. Only
   *  the SHA-256 of the secret is stored, inside the loop definition; the
   *  plaintext is returned exactly once (docs/triggers.md). */
  async rotateWebhookSecret(agentId: string, loopName: string): Promise<{ secret: string; path: string }> {
    const a = await this.get(agentId);
    const loops = JSON.parse(a.loops) as LoopDef[];
    const loop = loops.find((l) => l.name === loopName);
    if (!loop) throw new NotFoundException(`loop "${loopName}"`);
    if (loop.trigger?.kind !== 'webhook') throw new BadRequestException(`loop "${loopName}" is not webhook-triggered`);
    const secret = randomBytes(24).toString('base64url');
    loop.trigger = { kind: 'webhook', secretHash: hashWebhookSecret(secret) };
    await this.db.update(agents).set({ loops: JSON.stringify(loops) }).where(eq(agents.id, agentId));
    return { secret, path: `/api/hooks/${agentId}/${encodeURIComponent(loopName)}` };
  }

  /** AGENT.json v1 core: identity, loops, dashboard, mini apps (FR-11.7).
   *  PortabilityService wraps this with the v2 sections (lessons, skills,
   *  tasks, profile). */
  async exportJson(id: string) {
    const a = await this.get(id);
    return {
      name: a.name, emoji: a.emoji, colors: JSON.parse(a.colors), role: a.role,
      charter: a.charter, provider: a.provider, model: a.model,
      // A webhook secret belongs to this install: exports carry the trigger
      // shape only, and an import mints a fresh one.
      loops: (JSON.parse(a.loops) as LoopDef[]).map((l) => (l.trigger?.kind === 'webhook' ? { ...l, trigger: { kind: 'webhook' } } : l)),
      dashboard: a.dashboard, apps: await this.listApps(id),
    };
  }

  /** Record a 👍/👎 on a turn owned by this agent; surfaced to the model on
   *  its next reply, then cleared (FR-6.5). */
  async addFeedback(id: string, feedback: { rating: 'up' | 'down'; note?: string; turnId: string; skills?: Array<{ id: string; name: string }> }) {
    const agent = await this.get(id);
    const pending = JSON.parse(agent.pendingFeedback) as unknown[];
    pending.push({ ...feedback, at: nowIso() });
    await this.db.update(agents).set({ pendingFeedback: JSON.stringify(pending) }).where(eq(agents.id, id));
    return { ok: true };
  }

  /** Drain pending feedback for injection into the agent's next turn. */
  async takeFeedback(id: string): Promise<unknown[]> {
    const agent = await this.get(id);
    const pending = JSON.parse(agent.pendingFeedback) as unknown[];
    if (pending.length > 0) {
      await this.db.update(agents).set({ pendingFeedback: '[]' }).where(eq(agents.id, id));
    }
    return pending;
  }
}

/** Loops arrive from the schedule editor as a JSON string; enforce the same
 *  bounds as AGENT.json import (loops enable immediately). A webhook trigger
 *  saved without a secret hash gets one minted here so the hook is never
 *  open; the plaintext is only ever handed out by rotateWebhookSecret. */
function validateLoopsJson(raw: string): string {
  const fail = (msg: string): never => { throw new BadRequestException(`invalid loops: ${msg}`); };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail('not valid JSON'); }
  if (!Array.isArray(parsed)) fail('must be an array');
  const loops = parsed as unknown[];
  if (loops.length > 10) fail('at most 10 loops');
  const out = loops.map((l) => validateLoopDef(l, fail));
  const names = new Set<string>();
  for (const l of out) {
    if (names.has(l.name)) fail(`duplicate loop name "${l.name}"`);
    names.add(l.name);
    if (l.trigger?.kind === 'webhook' && !l.trigger.secretHash) {
      l.trigger = { kind: 'webhook', secretHash: hashWebhookSecret(randomBytes(24).toString('base64url')) };
    }
  }
  return JSON.stringify(out);
}

/** An agent's loops column; malformed JSON reads as no loops. */
function parseLoopsOf(raw: string | null | undefined): LoopDef[] {
  try {
    const parsed = JSON.parse(raw || '[]') as unknown;
    return Array.isArray(parsed) ? (parsed as LoopDef[]) : [];
  } catch { return []; }
}
