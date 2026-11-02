/**
 * AppBridgeService — capability-checked operations mini apps may perform
 * (docs/miniapp-capabilities.md). Every method re-derives the grant from the
 * stored manifest: an approval is whatever `approved` says right now, so a
 * save_app edit (which re-parks elevated grants) takes effect immediately.
 *
 * Scoping rules, enforced here regardless of what the host page asked for:
 *  - storage + file writes land only under <home>/apps/<appId>/ — an
 *    app can never write where the agent keeps its brain (self-injection);
 *  - reads see exactly what the agent's own fs tools see (own folder plus
 *    the assigned shared/ mount), nothing else;
 *  - app-originated turns are channel turns: Ask mode, approval-gated tools
 *    auto-denied, budgeted per app per day.
 */
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { AgentsService, AgentApp } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ChatsRepository } from '../chats/chats.repository';
import { TurnLoopService } from '../chats/turn-loop.service';
import { StorageService } from '../storage/storage.service';
import { workspaceFileKey } from '../storage/storage.keys';
import { homeKey } from '../files/agent-home';
import { previewKindFor } from '../storage/preview.util';
import { RateLimiter, ReadTally } from './bridge-limits';

const STATE_CAP = 64_000;
const FILE_WRITE_CAP = 300_000;
const READ_CAP = 200_000;
const ASK_TURNS_PER_DAY = 20;
const ASK_PROMPT_CAP = 4_000;

/** Files the agent reads as instructions, plus rollback history. A promoted
 *  app file may never land on any of these — see filePropose. */
const PROTECTED_PATHS = new Set(['AGENT.md', 'LESSONS.md', 'JOURNAL.md', 'AGENT.json']);
const PROTECTED_PREFIXES = new Set(['knowledge', '.checkpoints', 'apps', 'skills']);

@Injectable()
export class AppBridgeService {
  /** Ask budget, per app per UTC day. In-memory: a restart refills the tank,
   *  which errs on the forgiving side for a per-day nag limit. */
  private askUsage = new Map<string, { day: string; used: number }>();
  /** Frequency caps — sizes were always capped, call rates were not. */
  readonly limiter = new RateLimiter();
  /** Read provenance, logged on a curve so the feed stays readable. */
  private readonly reads = new ReadTally();

  constructor(
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    private readonly repo: ChatsRepository,
    private readonly turns: TurnLoopService,
    private readonly storage: StorageService,
  ) {}

  /** Load the app entry, verify the capability is activated, and bill the
   *  call against the app's rate ceiling for that op class. Every bridge
   *  entry point goes through here — including the collaborator services
   *  (llm, data, connections, compute), which is what makes one gate the
   *  whole boundary rather than each surface re-implementing it. */
  async gate(agentId: string, appId: string, cap: string, op: string): Promise<AgentApp> {
    const entry = (await this.agents.listApps(agentId)).find((x) => x.id === appId);
    if (!entry) throw new NotFoundException(`app ${appId}`);
    if (!(entry.approved ?? []).includes(cap)) {
      throw new ForbiddenException(`capability "${cap}" is not activated for this app`);
    }
    if (!this.limiter.allow(appId, op)) {
      throw new HttpException(`app "${entry.name}" is calling ${op} too fast — slow down`, HttpStatus.TOO_MANY_REQUESTS);
    }
    return entry;
  }

  /** Append a provenance line for a collaborator service (llm, data,
   *  connections, compute). Bridge activity is never silent. */
  async note(agentId: string, title: string, body?: string) {
    await this.agents.addEvent(agentId, { kind: 'info', title, body }).catch(() => {});
  }

  /** Append a read to the provenance feed, on the tally's curve. */
  private async noteRead(agentId: string, entry: AgentApp, what: string) {
    const line = this.reads.record(entry.id, entry.name, what);
    if (line) await this.agents.addEvent(agentId, { kind: 'info', title: line }).catch(() => {});
  }

  /** The agent's home folder (app state and data live under apps/ there). */
  home(agentId: string) {
    return this.agents.home(agentId);
  }

  approve(agentId: string, appId: string, capabilities: string[]) {
    return this.agents.approveAppCaps(agentId, appId, capabilities);
  }

  // ---- storage: app-private KV state ----

  async storageGet(agentId: string, appId: string) {
    await this.gate(agentId, appId, 'storage', 'storage.get');
    const body = await this.storage.get(homeKey(await this.agents.home(agentId), `apps/${appId}/state.json`));
    if (!body) return { state: null };
    try { return { state: JSON.parse(body.toString('utf8')) as unknown }; } catch { return { state: null }; }
  }

  async storagePut(agentId: string, appId: string, state: unknown) {
    await this.gate(agentId, appId, 'storage', 'storage.set');
    const json = JSON.stringify(state ?? null);
    if (json.length > STATE_CAP) throw new BadRequestException(`state exceeds ${STATE_CAP} bytes`);
    await this.storage.put(homeKey(await this.agents.home(agentId), `apps/${appId}/state.json`), Buffer.from(json), 'application/json');
    return { ok: true };
  }

  // ---- files: the agent's own view, read-only + own-folder writes ----

  async filesList(agentId: string, appId: string, prefix: string, workspaceId?: string) {
    const entry = await this.gate(agentId, appId, 'files.read', 'files.list');
    const agent = await this.agents.get(agentId);
    const out: Array<{ path: string; size: number; lastModified?: string }> = [];
    const home = await this.agents.home(agent);
    for (const o of await this.storage.list(home.prefix)) {
      out.push({ path: o.key.slice(home.prefix.length), size: o.size, lastModified: o.lastModified });
    }
    const folder = agent.workspaceFolder?.trim();
    if (folder && workspaceId) {
      const shared = `${workspaceFileKey(workspaceId, folder)}/`;
      for (const o of await this.storage.list(shared)) {
        out.push({ path: `shared/${o.key.slice(shared.length)}`, size: o.size, lastModified: o.lastModified });
      }
    }
    const p = prefix.replace(/^\/+/, '');
    const hits = out.filter((f) => !p || f.path.startsWith(p));
    await this.noteRead(agentId, entry, `${p || 'the whole folder'} (${hits.length} files)`);
    return hits;
  }

  /** `offset` pages past the preview cap: a CSV visualizer over a real export
   *  needs more than the first 200 KB, and truncating in silence made every
   *  such app quietly wrong. */
  async fileRead(agentId: string, appId: string, path: string, workspaceId?: string, offset = 0) {
    const entry = await this.gate(agentId, appId, 'files.read', 'files.read');
    const agent = await this.agents.get(agentId);
    const clean = path.replace(/^\/+/, '');
    let key: string;
    const folder = agent.workspaceFolder?.trim();
    if (clean.startsWith('shared/') && folder && workspaceId) {
      key = workspaceFileKey(workspaceId, `${folder}/${clean.slice('shared/'.length)}`);
    } else if (clean.startsWith('shared/')) {
      throw new NotFoundException('no shared folder is assigned to this agent');
    } else {
      key = homeKey(await this.agents.home(agent), clean);
    }
    const body = await this.storage.get(key);
    if (body === null) throw new NotFoundException(`file ${clean}`);
    await this.noteRead(agentId, entry, clean);
    const kind = previewKindFor(clean);
    if (kind === 'markdown' || kind === 'html' || kind === 'text') {
      const from = Math.max(0, Math.floor(offset));
      const text = body.toString('utf8').slice(from, from + READ_CAP);
      return { path: clean, kind, size: body.length, text, offset: from, eof: from + text.length >= body.length };
    }
    return { path: clean, kind, size: body.length, base64: body.length <= 2_000_000 ? body.toString('base64') : undefined };
  }

  async fileWrite(agentId: string, appId: string, path: string, content: string) {
    const entry = await this.gate(agentId, appId, 'files.write', 'files.write');
    const clean = path.replace(/^\/+/, '');
    if (!clean) throw new BadRequestException('path is required');
    if (typeof content !== 'string' || content.length > FILE_WRITE_CAP) {
      throw new BadRequestException(`content must be a string of at most ${FILE_WRITE_CAP} bytes`);
    }
    // writes never leave the app's own folder — the agent's brain files are
    // instructions, and apps must not be able to author instructions
    const scoped = `apps/${appId}/${clean}`;
    await this.storage.put(homeKey(await this.agents.home(agentId), scoped), Buffer.from(content, 'utf8'));
    await this.agents.addEvent(agentId, { kind: 'info', title: `App "${entry.name}" wrote ${scoped}` }).catch(() => {});
    return { ok: true, path: scoped };
  }

  /**
   * files.propose — the promotion path out of the app's own folder
   * (docs/miniapp-roadmap.md §4). Writes are jailed to apps/<appId>/ for good
   * reason, but the consequence was that an app could never produce anything
   * the user sees in the Files tab; the workaround was asking the agent, via
   * chat.compose, to go move the file.
   *
   * The host renders the content for approval before calling this. That
   * confirm is client-side by construction (the server cannot observe a
   * click), so the boundary that actually matters is enforced here: the
   * agent's instruction files are refused no matter what was approved. A user
   * cannot click their way into letting an app rewrite the brain its agent
   * reads and obeys — that is the self-injection hole, and it is not a
   * decision worth offering.
   */
  async filePropose(agentId: string, appId: string, path: string, content: string) {
    const entry = await this.gate(agentId, appId, 'files.write', 'files.propose');
    const clean = path.replace(/^\/+/, '');
    if (!clean) throw new BadRequestException('path is required');
    if (typeof content !== 'string' || content.length > FILE_WRITE_CAP) {
      throw new BadRequestException(`content must be a string of at most ${FILE_WRITE_CAP} bytes`);
    }
    const top = clean.split('/')[0];
    if (PROTECTED_PATHS.has(clean) || PROTECTED_PREFIXES.has(top)) {
      throw new ForbiddenException(
        `"${clean}" is part of the agent's brain — apps may not author what an agent reads as instructions, approved or not`,
      );
    }
    await this.storage.put(homeKey(await this.agents.home(agentId), clean), Buffer.from(content, 'utf8'));
    await this.agents.addEvent(agentId, {
      kind: 'info',
      title: `App "${entry.name}" saved ${clean} to the agent's folder (you approved it)`,
    }).catch(() => {});
    return { ok: true, path: clean };
  }

  /**
   * files.watch — has anything under `prefix` changed since `since`?
   * Without it every dashboard freezes at open time, which was the whole
   * reason files.read exists. Polled by the app; cheap because it only
   * compares the listing's timestamps.
   */
  async filesWatch(agentId: string, appId: string, prefix: string, since?: string, workspaceId?: string) {
    const files = await this.filesList(agentId, appId, prefix, workspaceId);
    const latest = files.reduce((max, f) => (f.lastModified && f.lastModified > max ? f.lastModified : max), '');
    return { latest, changed: !since || (!!latest && latest > since), count: files.length };
  }

  // ---- tasks: the agent's kanban ----

  async tasksList(agentId: string, appId: string) {
    await this.gate(agentId, appId, 'tasks.read', 'tasks.list');
    return this.agents.listTasks(agentId);
  }

  async taskAdd(agentId: string, appId: string, title: string, note?: string) {
    const entry = await this.gate(agentId, appId, 'tasks.write', 'tasks.add');
    const task = await this.agents.addTask(agentId, { title, note, origin: 'app' });
    await this.agents.addEvent(agentId, { kind: 'info', title: `App "${entry.name}" filed task: ${task.title}` }).catch(() => {});
    return task;
  }

  async taskMove(agentId: string, appId: string, taskId: string, status: string) {
    await this.gate(agentId, appId, 'tasks.write', 'tasks.move');
    if (!['todo', 'doing', 'done'].includes(status)) throw new BadRequestException('status must be todo|doing|done');
    // status moves only — apps never retitle or annotate someone else's task
    return this.agents.updateTask(agentId, taskId, { status });
  }

  // ---- agent.ask: a budgeted Ask-mode channel turn ----

  async ask(agentId: string, appId: string, prompt: string, workspaceId?: string) {
    const entry = await this.gate(agentId, appId, 'agent.ask', 'agent.ask');
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
      for await (const ev of this.turns.run(session.id, { text: `[from mini app "${entry.name}"] ${text}`, confined: true })) {
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
