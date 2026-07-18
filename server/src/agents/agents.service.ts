/**
 * AgentsService — durable agent identities (§11): global persistent agents
 * with a charter, provider/model defaults, and an optional file-brain home
 * folder. The brain (LESSONS.md / JOURNAL.md / knowledge/) and mini apps are
 * follow-up work; this scaffold owns the profile CRUD and pending feedback.
 */
import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents, agentTasks, chatSessions, chatTurns } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { StorageService } from '../storage/storage.service';
import { agentFileKey, agentPrefix } from '../storage/storage.keys';

/** A self-built mini app (FR-11.5): a self-contained HTML tool the agent
 *  writes for itself via save_app. Rendered only in a network-blocked
 *  sandboxed iframe (FR-13.1). */
export interface AgentApp {
  id: string;
  name: string;
  description: string;
  html: string;
  updatedAt: string;
}

const APP_LIMIT = 12;
const APP_HTML_CAP = 300_000;
const DASHBOARD_CAP = 50_000;

export type TaskStatus = 'todo' | 'doing' | 'done';
const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'done'];
const TASK_LIMIT = 200;

@Injectable()
export class AgentsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly storage: StorageService,
  ) {}

  list() {
    return this.db.select().from(agents);
  }

  async get(id: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`agent ${id}`);
    return rows[0];
  }

  async create(input: { name: string; charter?: string; provider?: string; model?: string; homeDir?: string; emoji?: string; colors?: [string, string]; role?: string; loops?: unknown[] }) {
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
      createdAt: nowIso(),
    };
    await this.db.insert(agents).values(row);
    await this.seedBrain(row.id, row.name);
    return row;
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

  async update(id: string, patch: Partial<{ name: string; charter: string; provider: string; model: string; homeDir: string; dashboard: string; emoji: string; colors: string; role: string; loops: string }>) {
    await this.get(id);
    if (patch.loops !== undefined) patch.loops = validateLoopsJson(patch.loops);
    await this.db.update(agents).set(patch).where(eq(agents.id, id));
    return this.get(id);
  }

  // ---- the agent's own kanban board (§11) ----

  listTasks(agentId: string) {
    return this.db.select().from(agentTasks).where(eq(agentTasks.agentId, agentId));
  }

  async addTask(agentId: string, input: { title: string; note?: string; origin?: string; sessionId?: string }) {
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
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    await this.db.insert(agentTasks).values(row);
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
    return (await this.db.select().from(agentTasks).where(eq(agentTasks.id, taskId)))[0];
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

  /** save_app: create or update (by name) a self-contained HTML mini app. */
  async saveApp(id: string, input: { name: string; description?: string; html: string }): Promise<string> {
    const name = (input.name ?? '').trim().slice(0, 60);
    if (!name) throw new BadRequestException('app name is required');
    if (typeof input.html !== 'string' || !input.html.trim()) throw new BadRequestException('app html is required');
    if (input.html.length > APP_HTML_CAP) throw new BadRequestException(`app html exceeds ${APP_HTML_CAP} bytes`);
    const apps = await this.listApps(id);
    const existing = apps.find((x) => x.name === name);
    if (existing) {
      existing.html = input.html;
      existing.description = input.description ?? existing.description;
      existing.updatedAt = nowIso();
    } else {
      if (apps.length >= APP_LIMIT) {
        throw new BadRequestException(`app limit (${APP_LIMIT}) reached — delete or update an existing app`);
      }
      apps.push({ id: newId(), name, description: input.description ?? '', html: input.html, updatedAt: nowIso() });
    }
    await this.db.update(agents).set({ apps: JSON.stringify(apps) }).where(eq(agents.id, id));
    return `Mini app "${name}" saved (${apps.length}/${APP_LIMIT}). It appears on your home page; the user can open it or embed it in a chat.`;
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
    await this.storage.deletePrefix(agentPrefix(id)).catch(() => {});
    return { ok: true };
  }

  /** Size-bounded append to a brain file (FR-11.4): the append is capped and
   *  the file keeps only its newest tail once it outgrows the bound. */
  private async appendBrainFile(agentId: string, file: string, entry: string, header: string): Promise<void> {
    const APPEND_CAP = 2_000;
    const FILE_CAP = 100_000;
    const KEEP = 80_000;
    const key = agentFileKey(agentId, file);
    const existing = await this.storage.get(key).catch(() => null);
    let text = existing ? existing.toString('utf8') : header;
    text = `${text.trimEnd()}\n\n${entry.slice(0, APPEND_CAP).trim()}\n`;
    if (text.length > FILE_CAP) text = `${header}(older entries trimmed)\n\n…${text.slice(text.length - KEEP)}`;
    await this.storage.put(key, Buffer.from(text, 'utf8'), 'text/markdown');
  }

  async appendJournal(agentId: string, entry: string): Promise<void> {
    await this.appendBrainFile(agentId, 'JOURNAL.md', entry, '# JOURNAL.md\n');
  }

  async appendLessons(agentId: string, entry: string): Promise<void> {
    await this.appendBrainFile(agentId, 'LESSONS.md', entry, '# LESSONS.md\n');
  }

  /** Chats owned + 👍/👎 totals across this agent's sessions (agent home). */
  async stats(id: string) {
    await this.get(id);
    const sessions = await this.db.select({ id: chatSessions.id }).from(chatSessions)
      .where(eq(chatSessions.agentId, id));
    const ids = sessions.map((s) => s.id);
    let up = 0; let down = 0;
    if (ids.length > 0) {
      const turns = await this.db.select({ rating: chatTurns.rating }).from(chatTurns)
        .where(inArray(chatTurns.sessionId, ids));
      for (const t of turns) {
        if (t.rating === 'up') up++;
        if (t.rating === 'down') down++;
      }
    }
    const rating = up + down > 0 ? Math.round((up / (up + down)) * 100) : null;
    return { chats: ids.length, up, down, rating };
  }

  /** AGENT.json import (FR-11.7): validate hard before install, because
   *  imported loops enable immediately — the client shows the capability
   *  review, the server enforces the bounds. */
  async importJson(profile: Record<string, unknown>) {
    const fail = (msg: string) => { throw new BadRequestException(`invalid AGENT.json: ${msg}`); };
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
    const loops = rawLoops.map((l) => {
      const loop = l as Record<string, unknown>;
      if (typeof loop?.name !== 'string' || loop.name.length < 1 || loop.name.length > 100) fail('every loop needs a name (≤100 chars)');
      if (typeof loop?.cron !== 'string' || loop.cron.length > 50) fail('every loop needs a cron (≤50 chars)');
      return {
        name: loop.name as string,
        cron: loop.cron as string,
        ...(typeof loop.prompt === 'string' ? { prompt: (loop.prompt as string).slice(0, 2_000) } : {}),
      };
    });
    const agent = await this.create({ name: name as string, charter, role, emoji, colors, loops });
    if (typeof profile.dashboard === 'string' && profile.dashboard) {
      await this.update(agent.id, { dashboard: profile.dashboard.slice(0, DASHBOARD_CAP) });
    }
    if (Array.isArray(profile.apps)) {
      for (const raw of profile.apps.slice(0, APP_LIMIT)) {
        const app = raw as Record<string, unknown>;
        if (typeof app?.name !== 'string' || typeof app?.html !== 'string') continue;
        await this.saveApp(agent.id, {
          name: app.name,
          description: typeof app.description === 'string' ? app.description.slice(0, 300) : undefined,
          html: app.html.slice(0, APP_HTML_CAP),
        }).catch(() => {});
      }
    }
    return this.get(agent.id);
  }

  /** AGENT.json export: profile, loops, dashboard, mini apps (FR-11.7). */
  async exportJson(id: string) {
    const a = await this.get(id);
    return {
      name: a.name, emoji: a.emoji, colors: JSON.parse(a.colors), role: a.role,
      charter: a.charter, provider: a.provider, model: a.model,
      loops: JSON.parse(a.loops), dashboard: a.dashboard, apps: await this.listApps(id),
    };
  }

  /** Record a 👍/👎 on a turn owned by this agent; surfaced to the model on
   *  its next reply, then cleared (FR-6.5). */
  async addFeedback(id: string, feedback: { rating: 'up' | 'down'; note?: string; turnId: string }) {
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
 *  bounds as AGENT.json import (loops enable immediately). */
function validateLoopsJson(raw: string): string {
  const fail = (msg: string) => { throw new BadRequestException(`invalid loops: ${msg}`); };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail('not valid JSON'); }
  if (!Array.isArray(parsed)) fail('must be an array');
  const loops = parsed as unknown[];
  if (loops.length > 10) fail('at most 10 loops');
  const out = loops.map((l) => {
    const loop = l as Record<string, unknown>;
    if (typeof loop?.name !== 'string' || loop.name.length < 1 || loop.name.length > 100) fail('every loop needs a name (≤100 chars)');
    if (typeof loop?.cron !== 'string' || loop.cron.length > 50) fail('every loop needs a cron (≤50 chars)');
    return {
      name: loop.name as string,
      cron: loop.cron as string,
      ...(typeof loop.prompt === 'string' ? { prompt: (loop.prompt as string).slice(0, 2_000) } : {}),
      ...(loop.enabled === false ? { enabled: false } : {}),
    };
  });
  return JSON.stringify(out);
}
