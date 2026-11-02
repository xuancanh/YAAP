/**
 * HarnessService — coding-agent CLIs as one agent tool, `code_agent`
 * (docs/coding-harnesses.md). Claude Code, Codex, Pi, and DeepSeek (the
 * Claude Code CLI on DeepSeek's Anthropic-compatible API).
 *
 * A run: detect the CLI → copy the requested workspace folder into a fresh
 * temp dir → spawn the CLI there (scrubbed env, optional OS sandbox, own
 * process group) → stream its JSONL as tool progress → stop it on timeout,
 * max turns, the cost cap or the chat's Stop → sync changed files back
 * through WorkspaceFs as the agent → delete the temp dir.
 *
 * Gating lives in the turn loop: the tool is mutation-class (`internal_write`,
 * like run_js — it executes code), so Ask mode pauses on it, loop turns queue
 * it, the trust ledger and the reviewer see it, and every call is an
 * action_log row. The owner may opt chosen agents into running it without
 * approval (`freeAgents`, never from a channel turn).
 */
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { constants, existsSync, realpathSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { AiToolCall, AiToolSpec } from '../ai/ai-provider.interface';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolExecCtx, type ToolProviderHook, type TurnOrigin } from '../chats/turn-loop.service';
import { resolvePath, WorkspaceFs, type FsActor } from '../files/workspace-fs.service';
import { SettingsService } from '../settings/settings.module';
import {
  agentAllowed, applyPatch, HARNESS_BINARY, HARNESS_IDS, HARNESS_LABEL, isHarnessId, LIMITS, openKey,
  parseSettings, redact, validModelName, type HarnessConfig, type HarnessId, type HarnessSettings, type RedactedHarnessConfig,
} from './harness-config';
import { buildCommand, harnessBwrap, harnessSeatbelt, parserFor, parseVersion, redactSecrets, type HarnessResult } from './harness-commands';
import { materialise, syncBack, type SyncReport } from './harness-workdir';

export const CODE_AGENT_TOOL = 'code_agent';
const SETTINGS_KEY = 'harness.config';
const DETECT_TTL_MS = 60_000;
const DETECT_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 3_000;
const STDOUT_CAP = 2_000_000;
const STDERR_TAIL = 8_000;
const FINAL_TEXT_CAP = 4_000;
const TASK_CAP = 20_000;
/** Concurrent runs per server process: each is a CLI, a model session and a temp dir. */
const MAX_CONCURRENT = 3;

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];

export interface HarnessStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  detail: string;
  checkedAt: string;
}

export interface RunRequest {
  id: HarnessId;
  cfg: HarnessConfig;
  task: string;
  model: string;
  maxTurns: number;
  workspaceId: string;
  /** Workspace-relative folder to work in (never '' — the root is refused). */
  folder: string;
  actor: FsActor;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}

export type RunEnd = 'finished' | 'error' | 'timeout' | 'max_turns' | 'cost_cap' | 'stopped';

export interface RunOutcome {
  end: RunEnd;
  exitCode: number | null;
  result: HarnessResult;
  sync: SyncReport | null;
  stderrTail: string;
  durationMs: number;
}

/** The OS sandbox this machine offers for harness runs. */
export function osSandboxKind(): 'seatbelt' | 'bwrap' | null {
  if (process.platform === 'darwin') return existsSync(SANDBOX_EXEC) ? 'seatbelt' : null;
  if (process.platform === 'linux') return BWRAP_CANDIDATES.some((p) => existsSync(p)) ? 'bwrap' : null;
  return null;
}

@Injectable()
export class HarnessService implements ToolProviderHook, OnModuleInit {
  private readonly logger = new Logger(HarnessService.name);
  private readonly statuses = new Map<string, HarnessStatus>();
  private running = 0;
  /** Test seams: where binaries are looked up, the real HOME, the OS sandbox. */
  searchDirs: string[] = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
    join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
  ];
  realHome = homedir();
  sandboxKind: () => 'seatbelt' | 'bwrap' | null = osSandboxKind;

  constructor(
    private readonly settings: SettingsService,
    private readonly fs: WorkspaceFs,
    @Optional() private readonly turns?: TurnLoopService,
  ) {}

  onModuleInit(): void { this.turns?.addToolProvider(this); }

  // ---- settings -----------------------------------------------------------

  async config(): Promise<HarnessSettings> {
    return parseSettings(await this.settings.getInternal(SETTINGS_KEY));
  }

  /** Validate and save one harness's patch; throws HarnessConfigError. */
  async update(id: HarnessId, patch: Record<string, unknown>): Promise<HarnessConfig> {
    const all = await this.config();
    const next = applyPatch(id, all[id], patch);
    all[id] = next;
    await this.settings.putInternal(SETTINGS_KEY, JSON.stringify(all));
    this.statuses.clear();
    return next;
  }

  /** The settings pane's view: redacted config, detection, the OS sandbox. */
  async view(): Promise<{ harnesses: Array<{ id: HarnessId; label: string; binary: string; config: RedactedHarnessConfig; status: HarnessStatus }>; osSandbox: 'seatbelt' | 'bwrap' | null }> {
    const all = await this.config();
    const harnesses = await Promise.all(HARNESS_IDS.map(async (id) => ({
      id, label: HARNESS_LABEL[id], binary: HARNESS_BINARY[id], config: redact(all[id]), status: await this.detect(id, all[id]),
    })));
    return { harnesses, osSandbox: this.sandboxKind() };
  }

  // ---- detection ----------------------------------------------------------

  /** Resolve the binary: the configured path, else the first executable on the search dirs. */
  async resolveBinary(id: HarnessId, cfg: HarnessConfig): Promise<string | null> {
    const candidates = cfg.binaryPath ? [cfg.binaryPath] : this.searchDirs.map((d) => join(d, HARNESS_BINARY[id]));
    for (const c of candidates) {
      try { await access(c, constants.X_OK); return c; } catch { /* next */ }
    }
    return null;
  }

  /** Binary on PATH (or the configured path) and its `--version`. Cached a minute; `force` re-checks. */
  async detect(id: HarnessId, cfg?: HarnessConfig, force = false): Promise<HarnessStatus> {
    const conf = cfg ?? (await this.config())[id];
    const path = await this.resolveBinary(id, conf);
    const now = new Date().toISOString();
    if (!path) {
      return { found: false, path: null, version: null, detail: conf.binaryPath ? `${conf.binaryPath} is not an executable file` : `${HARNESS_BINARY[id]} not found on PATH`, checkedAt: now };
    }
    const cached = this.statuses.get(path);
    if (cached && !force && Date.now() - Date.parse(cached.checkedAt) < DETECT_TTL_MS) return cached;
    const out = await this.capture(path, ['--version'], DETECT_TIMEOUT_MS).catch((err: Error) => ({ code: null as number | null, out: '', err: err.message }));
    const version = parseVersion(`${out.out}\n${out.err}`);
    const status: HarnessStatus = out.code === 0 && version
      ? { found: true, path, version, detail: `${HARNESS_BINARY[id]} ${version}`, checkedAt: now }
      : { found: false, path, version: null, detail: `${path} --version failed${out.err ? `: ${out.err.slice(0, 200)}` : ''}`, checkedAt: now };
    this.statuses.set(path, status);
    return status;
  }

  private pathDirsFor(binary: string): string[] {
    return [dirname(binary), dirname(process.execPath)];
  }

  /** Run a short command with the scrubbed env and capture its output. */
  private capture(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        env: { PATH: [...this.pathDirsFor(bin), '/usr/bin', '/bin'].join(':'), HOME: tmpdir(), LANG: 'en_US.UTF-8', TERM: 'dumb', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = ''; let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (d: Buffer) => { if (out.length < 4000) out += d.toString('utf8'); });
      child.stderr.on('data', (d: Buffer) => { if (err.length < 4000) err += d.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
  }

  // ---- the tool -------------------------------------------------------------

  /** Harnesses this agent may use right now: enabled, allowed, detected, keyed. */
  async availableFor(agentId: string): Promise<HarnessId[]> {
    const all = await this.config();
    const out: HarnessId[] = [];
    for (const id of HARNESS_IDS) {
      const cfg = all[id];
      if (!cfg.enabled || !agentAllowed(cfg, agentId)) continue;
      if (cfg.auth === 'api_key' && !cfg.apiKey) continue;
      if ((await this.detect(id, cfg)).found) out.push(id);
    }
    return out;
  }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!session.agentId) return [];
    const ids = await this.availableFor(session.agentId).catch(() => []);
    if (ids.length === 0) return [];
    return [codeAgentSpec(ids)];
  }

  owns(name: string): boolean { return name === CODE_AGENT_TOOL; }

  /** It executes code: never read-only. */
  isReadOnly(): boolean { return false; }

  /** Without the action contract, a loop turn queues it for the owner (like run_js). */
  queuesInLoops(name: string): boolean { return this.owns(name); }

  async contextFor(): Promise<string | null> { return null; }

  /** The owner's opt-in: chosen agents run code_agent without approval —
   *  never from a channel turn (an untrusted surface). */
  async runsFreely(session: ChatSession, call: AiToolCall, origin: TurnOrigin): Promise<boolean> {
    if (!this.owns(call.name) || !session.agentId || origin === 'channel') return false;
    const id = call.input?.harness;
    if (!isHarnessId(id)) return false;
    const cfg = (await this.config())[id];
    return cfg.enabled && agentAllowed(cfg, session.agentId) && cfg.freeAgents.includes(session.agentId);
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>, ctx?: ToolExecCtx): Promise<string> {
    if (!this.owns(name)) throw new Error(`unknown tool: ${name}`);
    const agentId = session.agentId;
    if (!agentId) throw new Error('code_agent is only available to durable agents');
    const id = input.harness;
    if (!isHarnessId(id)) throw new Error(`invalid arguments: "harness" must be one of ${HARNESS_IDS.join(', ')}`);
    const cfg = (await this.config())[id];
    if (!cfg.enabled) throw new Error(`${HARNESS_LABEL[id]} is not enabled in Settings › Coding agents`);
    if (!agentAllowed(cfg, agentId)) throw new Error(`this agent may not use ${HARNESS_LABEL[id]} (Settings › Coding agents)`);
    if (cfg.auth === 'api_key' && !cfg.apiKey) throw new Error(`${HARNESS_LABEL[id]} has no API key configured`);
    const task = typeof input.task === 'string' ? input.task.trim() : '';
    if (!task) throw new Error('invalid arguments: "task" must be a non-empty string');
    if (task.length > TASK_CAP) throw new Error(`invalid arguments: "task" is longer than ${TASK_CAP} characters`);
    const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : cfg.model;
    if (model && !validModelName(model)) throw new Error('invalid arguments: "model" must be a plain model id');
    const askedTurns = Number(input.maxTurns ?? input.max_turns);
    const maxTurns = Number.isFinite(askedTurns) && askedTurns >= 1 ? Math.min(Math.floor(askedTurns), cfg.maxTurns) : cfg.maxTurns;
    if (!ctx?.fileRoot) throw new Error('code_agent needs a file root');
    const root = await ctx.fileRoot();
    const actor = root.actor;
    if (!actor || actor.kind !== 'agent') throw new Error('code_agent runs as an agent');
    const folder = resolvePath(root, typeof input.folder === 'string' && input.folder.trim() ? input.folder.trim() : '~');
    if (!folder) throw new Error('refused: the workspace root is not a working folder — name a folder (your home is the default)');
    const out = await this.run({ id, cfg, task, model, maxTurns, workspaceId: root.workspaceId, folder, actor, signal: ctx.signal, onProgress: ctx.progress });
    return formatOutcome(id, model, folder, out);
  }

  // ---- a run ----------------------------------------------------------------

  async run(req: RunRequest): Promise<RunOutcome> {
    if (this.running >= MAX_CONCURRENT) throw new Error(`${MAX_CONCURRENT} coding-agent runs are already in progress — try again when one finishes`);
    if (req.signal?.aborted) throw new Error('stopped before the run started');
    const status = await this.detect(req.id, req.cfg);
    if (!status.found || !status.path) throw new Error(`${HARNESS_LABEL[req.id]} is not available: ${status.detail}`);
    const sandbox = req.cfg.osSandbox ? this.sandboxKind() : null;
    if (req.cfg.osSandbox && !sandbox) {
      throw new Error('the OS sandbox is on for this harness but this machine has none (sandbox-exec on macOS, bubblewrap on Linux) — install it, or turn the sandbox off in Settings › Coding agents');
    }
    this.running++;
    const started = Date.now();
    // realpath: macOS tmpdir() is under /var → /private/var, and the
    // Seatbelt subpath must name the resolved path.
    const runDir = realpathSync(await mkdtemp(join(tmpdir(), 'yaam-harness-')));
    try {
      const dirs = { runDir, workDir: join(runDir, 'work'), homeDir: join(runDir, 'home'), tmpDir: join(runDir, 'tmp') };
      await Promise.all([mkdir(dirs.homeDir, { recursive: true }), mkdir(dirs.tmpDir, { recursive: true })]);
      req.onProgress?.(`copying /${req.folder}/ into a private working directory`);
      const snap = await materialise(this.fs, req.workspaceId, req.folder, dirs.workDir);
      const apiKey = req.cfg.auth === 'api_key' || req.id === 'deepseek' ? openKey(req.cfg) : '';
      const cmd = buildCommand({ id: req.id, cfg: req.cfg, task: req.task, model: req.model, maxTurns: req.maxTurns, apiKey, dirs, realHome: this.realHome, pathDirs: this.pathDirsFor(status.path) });
      for (const f of cmd.files) {
        const abs = join(runDir, f.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, f.content, { mode: 0o600 });
        await chmod(abs, 0o600);
      }
      const argv = sandbox === 'seatbelt'
        ? [SANDBOX_EXEC, '-p', harnessSeatbelt(runDir, cmd.extraWritable), status.path, ...cmd.args]
        : sandbox === 'bwrap'
          ? [BWRAP_CANDIDATES.find((p) => existsSync(p))!, ...harnessBwrap(runDir, dirs.workDir, cmd.extraWritable), status.path, ...cmd.args]
          : [status.path, ...cmd.args];
      const secrets = [apiKey].filter(Boolean);
      const parser = parserFor(req.id, req.model);
      const progress = (line: string) => { if (line) req.onProgress?.(redactSecrets(line, secrets)); };
      req.onProgress?.(`${HARNESS_LABEL[req.id]} started${req.model ? ` (${req.model})` : ''} in /${req.folder}/ — ${snap.files.size} file(s)`);
      const proc = await this.spawnRun(argv, dirs.workDir, cmd.env, cmd.stdin, req, parser, progress);
      const result = parser.result();
      let sync: SyncReport | null = null;
      // A stop discards the run's changes; any other end syncs what it did.
      if (proc.end !== 'stopped') {
        req.onProgress?.('syncing changed files back');
        sync = await syncBack(this.fs, req.workspaceId, dirs.workDir, snap, req.actor);
      }
      const end: RunEnd = proc.end !== 'finished' ? proc.end : result.isError || proc.exitCode !== 0 ? 'error' : 'finished';
      return {
        end, exitCode: proc.exitCode, sync, durationMs: Date.now() - started,
        stderrTail: redactSecrets(proc.stderrTail, secrets),
        result: { ...result, finalText: redactSecrets(result.finalText, secrets), errorText: redactSecrets(result.errorText, secrets) },
      };
    } finally {
      this.running--;
      await rm(runDir, { recursive: true, force: true }).catch((err) => this.logger.warn(`could not remove ${runDir}: ${String(err)}`));
    }
  }

  private spawnRun(
    argv: string[], cwd: string, env: Record<string, string>, stdin: string | null, req: RunRequest,
    parser: ReturnType<typeof parserFor>, progress: (line: string) => void,
  ): Promise<{ end: RunEnd; exitCode: number | null; stderrTail: string }> {
    return new Promise((resolve, reject) => {
      // Own process group, so a kill reaches the CLI's shells and children.
      const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let end: RunEnd = 'finished';
      let buf = '';
      let seen = 0;
      let stderr = '';
      let killTimer: NodeJS.Timeout | null = null;
      const kill = (why: RunEnd) => {
        if (end !== 'finished') return;
        end = why;
        const signalGroup = (sig: NodeJS.Signals) => {
          try { if (child.pid) process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
        };
        signalGroup('SIGTERM');
        killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
      };
      const timer = setTimeout(() => { progress(`time limit (${req.cfg.timeoutS}s) reached — stopping`); kill('timeout'); }, req.cfg.timeoutS * 1000);
      const onAbort = () => { progress('stopped by the chat — the run\'s changes are discarded'); kill('stopped'); };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      const onLine = (line: string) => {
        for (const p of parser.feed(line)) progress(p);
        // Watchdogs: the CLI's own limits where it has them, ours as the floor.
        if (parser.turns() > req.maxTurns) { progress(`max turns (${req.maxTurns}) reached — stopping`); kill('max_turns'); }
        const cost = parser.costSoFar();
        if (req.cfg.costCapUsd > 0 && cost !== null && cost > req.cfg.costCapUsd) { progress(`cost cap ($${req.cfg.costCapUsd}) reached — stopping`); kill('cost_cap'); }
      };
      child.stdout.on('data', (d: Buffer) => {
        seen += d.length;
        if (seen > STDOUT_CAP) { if (end === 'finished') { progress('output cap reached — stopping'); kill('error'); } return; }
        buf += d.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); onLine(line); }
      });
      child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-STDERR_TAIL); });
      child.on('error', (e) => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); req.signal?.removeEventListener('abort', onAbort); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        req.signal?.removeEventListener('abort', onAbort);
        if (buf.trim()) onLine(buf);
        resolve({ end, exitCode: code, stderrTail: stderr });
      });
      child.stdin.on('error', () => { /* the CLI may exit before reading stdin */ });
      if (stdin !== null) child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

/** The tool spec, its harness enum narrowed to what this agent may use. */
export function codeAgentSpec(ids: HarnessId[]): AiToolSpec {
  const names = ids.map((id) => `${id} (${HARNESS_LABEL[id]})`).join(', ');
  return {
    name: CODE_AGENT_TOOL,
    description: `Hand a multi-step coding task to a coding-agent CLI — ${names} — that works in a private copy of one workspace folder for many turns: reading the code, editing many files and (where the owner allows) running commands and tests. When it ends, the files it changed are synced back as you: versioned and attributed, each overwrite and delete revertible with fs_restore. Use it for real coding work in a folder — implement a feature, fix a failing build, refactor, add tests, scaffold a project. Do NOT use it for a quick calculation or a short script (run_js / run_python), a single file edit (fs_edit), or reading (fs_read). Runs take minutes and cost money: write a complete, self-contained task — the goal, the files or area, constraints, and how to check the result. It executes code, so it needs approval like run_js. Returns the CLI's summary and the changed files.`,
    inputSchema: {
      type: 'object',
      properties: {
        harness: { type: 'string', enum: ids, description: 'Which coding agent to run.' },
        task: { type: 'string', description: 'The complete task for the coding agent, as you would brief an engineer.' },
        folder: { type: 'string', description: 'The workspace folder it works in: your home by default (~); a shared folder such as /org/site/ for team work. You must be allowed to write it for changes to sync back.' },
        model: { type: 'string', description: 'Optional model id override (otherwise the owner\'s default for that harness).' },
        maxTurns: { type: 'number', description: `Optional turn limit, at most the owner's limit (default ${LIMITS.maxTurns.def}).` },
      },
      required: ['harness', 'task'],
    },
  };
}

/** The concise result the model reads (and the action log keeps). */
export function formatOutcome(id: HarnessId, model: string, folder: string, o: RunOutcome): string {
  const r = o.result;
  const head: Record<RunEnd, string> = {
    finished: 'finished', error: 'ended with an error', timeout: 'was stopped at its time limit', max_turns: 'was stopped at its turn limit',
    cost_cap: 'was stopped at its cost cap', stopped: 'was stopped from the chat (changes discarded)',
  };
  const lines = [`${HARNESS_LABEL[id]}${model ? ` (${model})` : ''} ${head[o.end]} after ${Math.round(o.durationMs / 1000)}s in /${folder}/.`];
  const stats = [`turns: ${r.turns}`];
  if (r.tokensIn || r.tokensOut) stats.push(`tokens: ${r.tokensIn} in / ${r.tokensOut} out`);
  if (r.costUsd !== null) stats.push(`cost: $${r.costUsd.toFixed(4)}${r.costSource === 'estimated' ? ' (estimated)' : ''}`);
  lines.push(stats.join(' · '));
  if (r.errorText && o.end !== 'finished') lines.push(`Error: ${r.errorText.slice(0, 500)}`);
  if (!r.finished && o.stderrTail.trim() && o.end === 'error') lines.push(`stderr (tail): ${o.stderrTail.trim().slice(-800)}`);
  const text = r.finalText.trim();
  lines.push('', 'Summary from the coding agent:', text ? (text.length > FINAL_TEXT_CAP ? `${text.slice(0, FINAL_TEXT_CAP)}…(truncated)` : text) : '(none)');
  const s = o.sync;
  if (s) {
    lines.push('');
    if (s.written.length === 0 && s.deleted.length === 0) lines.push('No files changed.');
    else {
      lines.push(`Files changed (synced as you, versioned):`);
      for (const w of s.written.slice(0, 100)) lines.push(`  ${w.created ? 'A' : 'M'} /${w.path} (v${w.version})`);
      for (const d of s.deleted.slice(0, 50)) lines.push(`  D /${d} (restorable with fs_restore)`);
      const more = s.written.length - 100 + Math.max(0, s.deleted.length - 50);
      if (more > 0) lines.push(`  …and ${more} more`);
    }
    if (s.refused.length) lines.push('Refused (not written):', ...s.refused.slice(0, 20).map((x) => `  /${x.path}: ${x.reason}`));
    if (s.conflicts.length) lines.push('Conflicts (changed by someone else during the run — not overwritten; merge by hand):', ...s.conflicts.slice(0, 20).map((x) => `  /${x.path}`));
    if (s.skipped.length) lines.push('Skipped:', ...s.skipped.slice(0, 10).map((x) => `  /${x.path}: ${x.reason}`));
  }
  return lines.join('\n');
}
