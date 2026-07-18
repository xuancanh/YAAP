/**
 * AppBridgeService — capability-checked operations mini apps may perform
 * (docs/miniapp-capabilities.md). Every method re-derives the grant from the
 * stored manifest: an approval is whatever `approved` says right now, so a
 * save_app edit (which re-parks elevated grants) takes effect immediately.
 *
 * Scoping rules, enforced here regardless of what the host page asked for:
 *  - storage + file writes land only under agents/<id>/apps/<appId>/ — an
 *    app can never write where the agent keeps its brain (self-injection);
 *  - reads see exactly what the agent's own fs tools see (own folder plus
 *    the assigned shared/ mount), nothing else;
 *  - app-originated turns are channel turns: Ask mode, approval-gated tools
 *    auto-denied, budgeted per app per day.
 */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AgentsService, AgentApp } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ChatsRepository } from '../chats/chats.repository';
import { TurnLoopService } from '../chats/turn-loop.service';
import { StorageService } from '../storage/storage.service';
import { agentFileKey, agentPrefix, agentRelativePath, workspaceFileKey } from '../storage/storage.keys';
import { previewKindFor } from '../storage/preview.util';

const STATE_CAP = 64_000;
const FILE_WRITE_CAP = 300_000;
const READ_CAP = 200_000;
const ASK_TURNS_PER_DAY = 20;
const ASK_PROMPT_CAP = 4_000;

@Injectable()
export class AppBridgeService {
  /** Ask budget, per app per UTC day. In-memory: a restart refills the tank,
   *  which errs on the forgiving side for a per-day nag limit. */
  private askUsage = new Map<string, { day: string; used: number }>();

  constructor(
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    private readonly repo: ChatsRepository,
    private readonly turns: TurnLoopService,
    private readonly storage: StorageService,
  ) {}

  /** Load the app entry and verify the capability is activated. */
  private async requireCap(agentId: string, appId: string, cap: string): Promise<AgentApp> {
    const entry = (await this.agents.listApps(agentId)).find((x) => x.id === appId);
    if (!entry) throw new NotFoundException(`app ${appId}`);
    if (!(entry.approved ?? []).includes(cap)) {
      throw new ForbiddenException(`capability "${cap}" is not activated for this app`);
    }
    return entry;
  }

  approve(agentId: string, appId: string, capabilities: string[]) {
    return this.agents.approveAppCaps(agentId, appId, capabilities);
  }

  // ---- storage: app-private KV state ----

  async storageGet(agentId: string, appId: string) {
    await this.requireCap(agentId, appId, 'storage');
    const body = await this.storage.get(agentFileKey(agentId, `apps/${appId}/state.json`));
    if (!body) return { state: null };
    try { return { state: JSON.parse(body.toString('utf8')) as unknown }; } catch { return { state: null }; }
  }

  async storagePut(agentId: string, appId: string, state: unknown) {
    await this.requireCap(agentId, appId, 'storage');
    const json = JSON.stringify(state ?? null);
    if (json.length > STATE_CAP) throw new BadRequestException(`state exceeds ${STATE_CAP} bytes`);
    await this.storage.put(agentFileKey(agentId, `apps/${appId}/state.json`), Buffer.from(json), 'application/json');
    return { ok: true };
  }

  // ---- files: the agent's own view, read-only + own-folder writes ----

  async filesList(agentId: string, appId: string, prefix: string, workspaceId?: string) {
    await this.requireCap(agentId, appId, 'files.read');
    const agent = await this.agents.get(agentId);
    const out: Array<{ path: string; size: number; lastModified?: string }> = [];
    for (const o of await this.storage.list(agentPrefix(agentId))) {
      out.push({ path: agentRelativePath(agentId, o.key), size: o.size, lastModified: o.lastModified });
    }
    const folder = agent.workspaceFolder?.trim();
    if (folder && workspaceId) {
      const shared = `${workspaceFileKey(workspaceId, folder)}/`;
      for (const o of await this.storage.list(shared)) {
        out.push({ path: `shared/${o.key.slice(shared.length)}`, size: o.size, lastModified: o.lastModified });
      }
    }
    const p = prefix.replace(/^\/+/, '');
    return out.filter((f) => !p || f.path.startsWith(p));
  }

  async fileRead(agentId: string, appId: string, path: string, workspaceId?: string) {
    await this.requireCap(agentId, appId, 'files.read');
    const agent = await this.agents.get(agentId);
    const clean = path.replace(/^\/+/, '');
    let key: string;
    const folder = agent.workspaceFolder?.trim();
    if (clean.startsWith('shared/') && folder && workspaceId) {
      key = workspaceFileKey(workspaceId, `${folder}/${clean.slice('shared/'.length)}`);
    } else if (clean.startsWith('shared/')) {
      throw new NotFoundException('no shared folder is assigned to this agent');
    } else {
      key = agentFileKey(agentId, clean);
    }
    const body = await this.storage.get(key);
    if (body === null) throw new NotFoundException(`file ${clean}`);
    const kind = previewKindFor(clean);
    if (kind === 'markdown' || kind === 'html' || kind === 'text') {
      return { path: clean, kind, size: body.length, text: body.toString('utf8').slice(0, READ_CAP) };
    }
    return { path: clean, kind, size: body.length, base64: body.length <= 2_000_000 ? body.toString('base64') : undefined };
  }

  async fileWrite(agentId: string, appId: string, path: string, content: string) {
    const entry = await this.requireCap(agentId, appId, 'files.write');
    const clean = path.replace(/^\/+/, '');
    if (!clean) throw new BadRequestException('path is required');
    if (typeof content !== 'string' || content.length > FILE_WRITE_CAP) {
      throw new BadRequestException(`content must be a string of at most ${FILE_WRITE_CAP} bytes`);
    }
    // writes never leave the app's own folder — the agent's brain files are
    // instructions, and apps must not be able to author instructions
    const scoped = `apps/${appId}/${clean}`;
    await this.storage.put(agentFileKey(agentId, scoped), Buffer.from(content, 'utf8'));
    await this.agents.addEvent(agentId, { kind: 'info', title: `App "${entry.name}" wrote ${scoped}` }).catch(() => {});
    return { ok: true, path: scoped };
  }

  // ---- tasks: the agent's kanban ----

  async tasksList(agentId: string, appId: string) {
    await this.requireCap(agentId, appId, 'tasks.read');
    return this.agents.listTasks(agentId);
  }

  async taskAdd(agentId: string, appId: string, title: string, note?: string) {
    const entry = await this.requireCap(agentId, appId, 'tasks.write');
    const task = await this.agents.addTask(agentId, { title, note, origin: 'app' });
    await this.agents.addEvent(agentId, { kind: 'info', title: `App "${entry.name}" filed task: ${task.title}` }).catch(() => {});
    return task;
  }

  async taskMove(agentId: string, appId: string, taskId: string, status: string) {
    await this.requireCap(agentId, appId, 'tasks.write');
    if (!['todo', 'doing', 'done'].includes(status)) throw new BadRequestException('status must be todo|doing|done');
    // status moves only — apps never retitle or annotate someone else's task
    return this.agents.updateTask(agentId, taskId, { status });
  }

  // ---- agent.ask: a budgeted Ask-mode channel turn ----

  async ask(agentId: string, appId: string, prompt: string, workspaceId?: string) {
    const entry = await this.requireCap(agentId, appId, 'agent.ask');
    const text = prompt.trim().slice(0, ASK_PROMPT_CAP);
    if (!text) throw new BadRequestException('prompt is required');

    const day = new Date().toISOString().slice(0, 10);
    const usage = this.askUsage.get(appId);
    const used = usage?.day === day ? usage.used : 0;
    if (used >= ASK_TURNS_PER_DAY) {
      throw new ForbiddenException(`this app has used its ${ASK_TURNS_PER_DAY} agent turns for today`);
    }
    this.askUsage.set(appId, { day, used: used + 1 });

    const agent = await this.agents.get(agentId);
    const ws = workspaceId ?? (await this.workspaces.list())[0]?.id;
    if (!ws) throw new BadRequestException('no workspace');
    const name = `App · ${agent.name}`;
    const existing = (await this.repo.listSessions(ws)).find((x) => x.agentId === agentId && x.name === name);
    // Ask mode, deliberately: an app can make its agent think, never act.
    const session = existing ?? await this.repo.createSession({ workspaceId: ws, agentId, name, permissionMode: 'ask' });

    let answer = '';
    const denied: string[] = [];
    try {
      for await (const ev of this.turns.run(session.id, { text: `[from mini app "${entry.name}"] ${text}` })) {
        if (ev.type === 'answer') answer += ev.text;
        if (ev.type === 'approval_required') {
          denied.push(ev.tool);
          this.turns.resolveApproval(session.id, ev.callId, 'deny');
        }
        if (ev.type === 'error') answer += `\n(error: ${ev.message})`;
      }
    } catch (err) {
      throw new BadRequestException(`turn failed: ${err instanceof Error ? err.message : err}`);
    }
    return {
      answer: answer.trim(),
      denied: [...new Set(denied)],
      remainingToday: ASK_TURNS_PER_DAY - used - 1,
      sessionId: session.id,
    };
  }
}
