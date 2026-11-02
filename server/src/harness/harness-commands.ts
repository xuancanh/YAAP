/**
 * Per-harness command builders and stream parsers (docs/coding-harnesses.md
 * §2-3). Pure: given the settings and a run's directories, the exact argv,
 * environment and stdin; given the CLI's JSONL output, progress lines and a
 * result. Every flag here is taken from the CLI's own documentation (links
 * in the doc), never guessed.
 *
 * Secrets travel in the environment only — never in argv (visible in `ps`)
 * and never in progress or results (`redactSecrets`).
 */
import { join } from 'node:path';
import { usdFor } from '../ai/pricing';
import { DEEPSEEK_ANTHROPIC_URL, PI_PROVIDERS, type HarnessConfig, type HarnessId, type HarnessMode } from './harness-config';

/** One run's directories. Everything the CLI may write is under `runDir`. */
export interface RunDirs {
  runDir: string;
  /** The materialised workspace folder: the CLI's cwd. */
  workDir: string;
  /** The CLI's HOME (and its config dir inside) for api_key runs. */
  homeDir: string;
  tmpDir: string;
}

export interface BuildInput {
  id: HarnessId;
  cfg: HarnessConfig;
  task: string;
  model: string;
  maxTurns: number;
  /** The clear API key ('' for cli_login). */
  apiKey: string;
  dirs: RunDirs;
  /** This machine's real HOME — only cli_login runs see it. */
  realHome: string;
  /** Directories for PATH: the CLI's own dir and node's (the CLIs are Node scripts). */
  pathDirs: string[];
}

export interface HarnessCommand {
  args: string[];
  env: Record<string, string>;
  /** Written to the CLI's stdin, then closed (null: stdin is /dev/null). */
  stdin: string | null;
  /** Files to create before the run (relative to runDir), e.g. Pi's models.json. */
  files: Array<{ path: string; content: string }>;
  /** Paths outside runDir the CLI must write (its real config dir, for a
   *  cli_login run) — the OS sandbox allows these too. */
  extraWritable: string[];
  /** Which env var holds the key (for tests and redaction). */
  keyEnv: string | null;
}

const SYSTEM_PATH = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];

/** The base environment: nothing from the server's own env but a PATH. */
function baseEnv(inp: BuildInput, home: string): Record<string, string> {
  const path = [...new Set([...inp.pathDirs, ...SYSTEM_PATH])].join(':');
  return {
    PATH: path,
    HOME: home,
    TMPDIR: inp.dirs.tmpDir,
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
  };
}

/** Claude Code permission flags per mode (code.claude.com/docs/en/cli-reference):
 *  `--tools` restricts the built-in set; in `-p` anything that would prompt is denied. */
export function claudeModeArgs(mode: HarnessMode): string[] {
  if (mode === 'read_only') return ['--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob'];
  if (mode === 'edit') return ['--permission-mode', 'acceptEdits', '--tools', 'Read,Grep,Glob,Edit,Write'];
  return ['--permission-mode', 'bypassPermissions'];
}

/** Codex sandbox per mode (learn.chatgpt.com/docs/cli/reference). Never
 *  danger-full-access: `full` is workspace-write plus network for commands. */
export function codexModeArgs(mode: HarnessMode): string[] {
  if (mode === 'read_only') return ['--sandbox', 'read-only'];
  if (mode === 'edit') return ['--sandbox', 'workspace-write'];
  return ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'];
}

/** Pi tool allowlist per mode (pi docs/cli.md: defaults are read, bash, edit, write). */
export function piModeArgs(mode: HarnessMode): string[] {
  if (mode === 'read_only') return ['--tools', 'read'];
  if (mode === 'edit') return ['--tools', 'read,edit,write'];
  return [];
}

export function buildCommand(inp: BuildInput): HarnessCommand {
  const { id, cfg, dirs } = inp;
  const login = cfg.auth === 'cli_login' && id !== 'deepseek';
  const home = login ? inp.realHome : dirs.homeDir;
  const env = baseEnv(inp, home);
  const files: HarnessCommand['files'] = [];
  const extraWritable: string[] = [];
  let keyEnv: string | null = null;

  if (id === 'claude_code' || id === 'deepseek') {
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--max-turns', String(inp.maxTurns),
      '--no-session-persistence',
      // No MCP servers but the (none) we pass; settings from the user scope
      // only — a `.claude/settings.json` planted in the workspace folder
      // cannot add hooks or permissions.
      '--strict-mcp-config',
      '--setting-sources', 'user',
      ...claudeModeArgs(cfg.mode),
    ];
    if (inp.model) args.push('--model', inp.model);
    // Claude Code's budget is computed from Anthropic prices: meaningful for
    // Claude Code itself, wrong for DeepSeek (the service caps that one from usage).
    if (id === 'claude_code' && cfg.costCapUsd > 0) args.push('--max-budget-usd', String(cfg.costCapUsd));
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    if (login) {
      extraWritable.push(join(inp.realHome, '.claude'), join(inp.realHome, '.claude.json'));
    } else {
      env.CLAUDE_CONFIG_DIR = join(dirs.homeDir, '.claude');
    }
    if (id === 'deepseek') {
      // DeepSeek's documented Claude Code setup
      // (api-docs.deepseek.com/quick_start/agent_integrations/claude_code).
      env.ANTHROPIC_BASE_URL = cfg.baseUrl || DEEPSEEK_ANTHROPIC_URL;
      env.ANTHROPIC_AUTH_TOKEN = inp.apiKey;
      keyEnv = 'ANTHROPIC_AUTH_TOKEN';
      const model = inp.model || 'deepseek-v4-pro';
      env.ANTHROPIC_MODEL = model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = model;
    } else {
      if (cfg.baseUrl) env.ANTHROPIC_BASE_URL = cfg.baseUrl;
      if (!login) { env.ANTHROPIC_API_KEY = inp.apiKey; keyEnv = 'ANTHROPIC_API_KEY'; }
    }
    return { args, env, stdin: inp.task, files, extraWritable, keyEnv };
  }

  if (id === 'codex') {
    const args = [
      'exec', '--json', '--skip-git-repo-check', '--ephemeral',
      '--cd', dirs.workDir,
      ...codexModeArgs(cfg.mode),
      '-c', 'approval_policy="never"',
    ];
    if (inp.model) args.push('--model', inp.model);
    if (login) {
      extraWritable.push(join(inp.realHome, '.codex'));
    } else {
      env.CODEX_HOME = join(dirs.homeDir, '.codex');
      args.push('--ignore-user-config');
      if (cfg.baseUrl) {
        // An OpenAI-compatible endpoint as a custom model provider; the key
        // is read from the env var it names.
        args.push(
          '-c', 'model_provider="yaam"',
          '-c', 'model_providers.yaam.name="yaam"',
          '-c', `model_providers.yaam.base_url=${JSON.stringify(cfg.baseUrl)}`,
          '-c', 'model_providers.yaam.env_key="YAAM_CODEX_API_KEY"',
          '-c', 'model_providers.yaam.wire_api="responses"',
        );
        env.YAAM_CODEX_API_KEY = inp.apiKey;
        keyEnv = 'YAAM_CODEX_API_KEY';
      } else {
        env.CODEX_API_KEY = inp.apiKey;
        keyEnv = 'CODEX_API_KEY';
      }
    }
    args.push('-'); // the prompt comes from stdin
    return { args, env, stdin: inp.task, files, extraWritable, keyEnv };
  }

  // pi
  const args = ['--mode', 'json', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-approve', ...piModeArgs(cfg.mode)];
  if (login) {
    extraWritable.push(join(inp.realHome, '.pi'));
    if (cfg.provider) args.push('--provider', cfg.provider);
  } else {
    const agentDir = join(dirs.homeDir, '.pi', 'agent');
    env.PI_CODING_AGENT_DIR = agentDir;
    if (cfg.baseUrl) {
      // A custom OpenAI-compatible provider (pi docs/models.md). The file
      // lives in the run's own home and is deleted with it.
      files.push({
        path: join('home', '.pi', 'agent', 'models.json'),
        content: JSON.stringify({ providers: { yaam: { baseUrl: cfg.baseUrl, api: 'openai-completions', apiKey: inp.apiKey, models: [{ id: inp.model || 'default' }] } } }, null, 2),
      });
      args.push('--provider', 'yaam');
    } else {
      const provider = cfg.provider || 'anthropic';
      keyEnv = PI_PROVIDERS[provider] ?? 'ANTHROPIC_API_KEY';
      env[keyEnv] = inp.apiKey;
      args.push('--provider', provider);
    }
  }
  if (inp.model) args.push('--model', inp.model);
  // `--` stops option parsing, so a task starting with "-" stays a prompt.
  args.push('--', inp.task);
  return { args, env, stdin: null, files, extraWritable, keyEnv };
}

/** Replace every occurrence of a secret in text a person or model will see. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  return out;
}

// ---- OS sandbox around the CLI --------------------------------------------

/** Seatbelt profile for a harness: reads allowed (the CLI and node live all
 *  over the disk), every write denied except the run directory and the
 *  CLI's own config dir on a cli_login run. Network stays on: the CLI
 *  must reach its model API. */
export function harnessSeatbelt(runDir: string, extraWritable: string[] = []): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${JSON.stringify(runDir)}))`,
    // A prefix regex, so `~/.claude.json` also covers its `.backup` / lock siblings.
    ...extraWritable.map((p) => `(allow file-write* (regex #"^${p.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')}"))`),
    '(allow file-write* (subpath "/dev"))',
  ].join('\n');
}

/** bubblewrap prefix for a harness: the whole FS read-only, the run dir
 *  (and a cli_login CLI's config dir) writable, own pid/ipc/uts namespaces,
 *  network shared. */
export function harnessBwrap(runDir: string, workDir: string, extraWritable: string[] = []): string[] {
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--bind', runDir, runDir,
    ...extraWritable.flatMap((p) => ['--bind-try', p, p]),
    '--unshare-all',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--chdir', workDir,
  ];
}

// ---- stream parsers ---------------------------------------------------------

export interface HarnessResult {
  finalText: string;
  isError: boolean;
  errorText: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  /** USD; null when neither the CLI nor the price table knows it. */
  costUsd: number | null;
  /** 'reported' by the CLI, or 'estimated' from tokens and the price table. */
  costSource: 'reported' | 'estimated' | null;
  /** Whether the CLI emitted its terminal event (result / agent_end / turn.completed). */
  finished: boolean;
}

export interface StreamParser {
  /** Feed one stdout line; returns progress lines for the chat. */
  feed(line: string): string[];
  /** Turns (or steps) so far, for the max-turns watchdog. */
  turns(): number;
  /** Spend so far (USD) for the cost-cap watchdog; null when unknown. */
  costSoFar(): number | null;
  result(): HarnessResult;
}

const clip = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** One line describing a tool call: its name and the argument that matters. */
export function toolLine(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const arg = i.command ?? i.cmd ?? i.file_path ?? i.path ?? i.filePath ?? i.pattern ?? i.query ?? i.url ?? '';
  return clip(`${name}${arg ? `: ${typeof arg === 'string' ? arg : JSON.stringify(arg)}` : ''}`);
}

function parseJson(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t) as Record<string, unknown>; } catch { return null; }
}

function estimate(model: string, tin: number, tout: number): number | null {
  return model ? usdFor(model, tin, tout) : null;
}

/** Claude Code `--output-format stream-json` (code.claude.com/docs/en/headless,
 *  SDKMessage types in the Agent SDK reference). `priceFromTokens`: compute
 *  cost from usage (DeepSeek), since total_cost_usd uses Anthropic prices. */
export function claudeParser(model: string, priceFromTokens = false): StreamParser {
  const seen = new Set<string>();
  let tin = 0; let tout = 0; let turns = 0;
  let res: Record<string, unknown> | null = null;
  let lastText = '';
  let initModel = '';
  return {
    feed(line) {
      const ev = parseJson(line);
      if (!ev) return [];
      const out: string[] = [];
      if (ev.type === 'system' && ev.subtype === 'init') {
        initModel = typeof ev.model === 'string' ? ev.model : '';
        out.push(`session started${initModel ? ` (${initModel})` : ''}`);
      } else if (ev.type === 'assistant') {
        const msg = (ev.message ?? {}) as { id?: string; content?: unknown[]; usage?: Record<string, number> };
        const main = ev.parent_tool_use_id == null;
        if (msg.id && !seen.has(msg.id)) {
          seen.add(msg.id);
          if (main) turns++;
          const u = msg.usage ?? {};
          tin += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          tout += u.output_tokens ?? 0;
        }
        for (const b of (msg.content ?? []) as Array<Record<string, unknown>>) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            if (main) lastText = b.text;
            out.push(clip(b.text));
          } else if (b.type === 'tool_use') out.push(toolLine(String(b.name ?? 'tool'), b.input));
        }
      } else if (ev.type === 'user') {
        const msg = (ev.message ?? {}) as { content?: unknown[] };
        for (const b of (Array.isArray(msg.content) ? msg.content : []) as Array<Record<string, unknown>>) {
          if (b.type === 'tool_result' && b.is_error) out.push(clip(`tool error: ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}`));
        }
      } else if (ev.type === 'system' && ev.subtype === 'api_retry') {
        out.push(`API retry ${String(ev.attempt ?? '')}`.trim());
      } else if (ev.type === 'result') {
        res = ev;
      }
      return out;
    },
    turns: () => turns,
    costSoFar: () => (priceFromTokens || !res ? estimate(model || initModel, tin, tout) : Number(res.total_cost_usd) || 0),
    result() {
      const r = res;
      if (!r) return { finalText: lastText, isError: true, errorText: 'the CLI ended without a result', turns, tokensIn: tin, tokensOut: tout, costUsd: estimate(model || initModel, tin, tout), costSource: 'estimated', finished: false };
      const usage = (r.usage ?? {}) as Record<string, number>;
      const ri = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      const ro = usage.output_tokens ?? 0;
      const tokensIn = Math.max(ri, tin); const tokensOut = Math.max(ro, tout);
      const isError = r.is_error === true || (typeof r.subtype === 'string' && r.subtype !== 'success');
      const errors = Array.isArray(r.errors) ? r.errors.map(String).join('; ') : '';
      const reported = typeof r.total_cost_usd === 'number' && !priceFromTokens;
      const est = estimate(model || initModel, tokensIn, tokensOut);
      return {
        finalText: typeof r.result === 'string' ? r.result : lastText,
        isError,
        errorText: isError ? (errors || String(r.subtype ?? 'error')) : '',
        turns: typeof r.num_turns === 'number' ? r.num_turns : turns,
        tokensIn, tokensOut,
        costUsd: reported ? (r.total_cost_usd as number) : est,
        costSource: reported ? 'reported' : est === null ? null : 'estimated',
        finished: true,
      };
    },
  };
}

/** Codex `exec --json` (learn.chatgpt.com/docs/non-interactive-mode):
 *  thread/turn/item events; usage on turn.completed; no dollar cost. Turns
 *  here are steps (commands, file changes, tool calls) — Codex has no
 *  max-turns flag, so the watchdog counts these. */
export function codexParser(model: string): StreamParser {
  let tin = 0; let tout = 0; let steps = 0;
  let lastText = ''; let error = ''; let completed = false;
  return {
    feed(line) {
      const ev = parseJson(line);
      if (!ev) return [];
      const out: string[] = [];
      const item = (ev.item ?? {}) as Record<string, unknown>;
      if (ev.type === 'thread.started') out.push('session started');
      else if (ev.type === 'item.started' && item.type === 'command_execution') out.push(clip(`$ ${String(item.command ?? '')}`));
      else if (ev.type === 'item.completed') {
        if (item.type === 'agent_message' && typeof item.text === 'string') { lastText = item.text; out.push(clip(item.text)); }
        else if (item.type === 'command_execution') { steps++; if (typeof item.exit_code === 'number' && item.exit_code !== 0) out.push(`command exited ${item.exit_code}`); }
        else if (item.type === 'file_change') {
          steps++;
          const changes = Array.isArray(item.changes) ? item.changes as Array<{ path?: string; kind?: string }> : [];
          for (const c of changes.slice(0, 5)) out.push(clip(`${c.kind ?? 'edit'}: ${c.path ?? ''}`));
        } else if (item.type === 'mcp_tool_call' || item.type === 'web_search') steps++;
        else if (item.type === 'error' && typeof item.message === 'string') out.push(clip(`error: ${item.message}`));
      } else if (ev.type === 'turn.completed') {
        completed = true;
        const u = (ev.usage ?? {}) as Record<string, number>;
        tin += u.input_tokens ?? 0; tout += (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
      } else if (ev.type === 'turn.failed') {
        error = String(((ev.error ?? {}) as { message?: string }).message ?? 'turn failed');
      } else if (ev.type === 'error') {
        error = String(ev.message ?? 'error');
      }
      return out;
    },
    turns: () => steps,
    costSoFar: () => estimate(model, tin, tout),
    result() {
      const est = estimate(model, tin, tout);
      return {
        finalText: lastText, isError: Boolean(error) || !completed, errorText: error || (completed ? '' : 'the CLI ended without completing its turn'),
        turns: steps, tokensIn: tin, tokensOut: tout, costUsd: est, costSource: est === null ? null : 'estimated', finished: completed,
      };
    },
  };
}

/** Pi `--mode json` (pi docs/json.md): lifecycle, message and
 *  tool_execution events; usage with cost on assistant messages. */
export function piParser(model: string): StreamParser {
  let tin = 0; let tout = 0; let turns = 0; let cost = 0; let costSeen = false;
  let lastText = ''; let error = ''; let ended = false;
  return {
    feed(line) {
      const ev = parseJson(line);
      if (!ev) return [];
      const out: string[] = [];
      if (ev.type === 'turn_start') turns++;
      else if (ev.type === 'tool_execution_start') out.push(toolLine(String(ev.toolName ?? 'tool'), ev.args));
      else if (ev.type === 'tool_execution_end' && ev.isError) out.push(`tool error: ${String(ev.toolName ?? '')}`);
      else if (ev.type === 'message_end') {
        const m = (ev.message ?? {}) as { role?: string; content?: unknown; usage?: { input?: number; output?: number; cost?: { total?: number } }; stopReason?: string; errorMessage?: string };
        if (m.role === 'assistant') {
          const blocks = Array.isArray(m.content) ? m.content as Array<Record<string, unknown>> : [];
          const text = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n').trim();
          if (text) { lastText = text; out.push(clip(text)); }
          tin += m.usage?.input ?? 0; tout += m.usage?.output ?? 0;
          if (typeof m.usage?.cost?.total === 'number') { cost += m.usage.cost.total; costSeen = true; }
          if (m.stopReason === 'error' || m.stopReason === 'aborted') error = m.errorMessage || m.stopReason;
        }
      } else if (ev.type === 'agent_end') ended = true;
      return out;
    },
    turns: () => turns,
    costSoFar: () => (costSeen ? cost : estimate(model, tin, tout)),
    result() {
      const est = costSeen ? cost : estimate(model, tin, tout);
      return {
        finalText: lastText, isError: Boolean(error) || !ended, errorText: error || (ended ? '' : 'the CLI ended without finishing'),
        turns, tokensIn: tin, tokensOut: tout, costUsd: est, costSource: costSeen ? 'reported' : est === null ? null : 'estimated', finished: ended,
      };
    },
  };
}

export function parserFor(id: HarnessId, model: string): StreamParser {
  if (id === 'claude_code') return claudeParser(model);
  if (id === 'deepseek') return claudeParser(model || 'deepseek-v4-pro', true);
  if (id === 'codex') return codexParser(model);
  return piParser(model);
}

/** First version-looking token in `--version` output. */
export function parseVersion(out: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/.exec(out);
  return m ? m[1] : null;
}
