/**
 * RunnerService — Tier-1 code execution behind the standard tool gates
 * (docs/code-execution.md §5-6). Two interchangeable backends:
 *
 *  - local: the interpreter runs on this machine inside an OS sandbox —
 *    sandbox-exec with a generated Seatbelt profile on macOS, bubblewrap on
 *    Linux. No network at the kernel level, writes jailed to a per-run
 *    scratch directory, hard wall-clock kill.
 *  - cloudflare: a Worker facade in front of Cloudflare Sandboxes
 *    (cloudflare/runner-worker/). The container has deny-all egress
 *    (allowedHosts = []) and our server talks to the facade with a bearer
 *    token. Paid-tier backend (docs/code-execution.md §3d).
 *
 * Invariants shared by both: every run starts from a fresh environment
 * (persistence is how injected code outlives its injection), the tools are
 * mutation-class so Ask mode pauses on the full code, and loop-origin calls
 * queue as action_pending instead of executing (turn-loop.service.ts).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiToolSpec } from '../ai/ai-provider.interface';

export type RunnerLanguage = 'javascript' | 'python';
export type RunnerBackendName = 'local' | 'cloudflare';

const OUTPUT_CAP = 32_000;
const DEFAULT_TIMEOUT_S = 10;
const MAX_TIMEOUT_S = 30;
const CF_HTTP_TIMEOUT_MS = 90_000;

const PYTHON_CANDIDATES = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Seatbelt profile: default-allow reads (interpreters live all over the
 *  disk), deny all network and all writes except the scratch dir. The
 *  network deny is the exfiltration wall; validated to block direct-IP
 *  sockets, not just DNS. */
export function seatbeltProfile(scratchDir: string): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${JSON.stringify(scratchDir)}))`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper"))',
  ].join('\n');
}

/** bubblewrap argv prefix: whole FS read-only, fresh /tmp and /dev, scratch
 *  bind-mounted read-write, and — the wall that matters — no network
 *  namespace at all (--unshare-all). */
export function bwrapArgs(scratchDir: string): string[] {
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--bind', scratchDir, scratchDir,
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--chdir', scratchDir,
  ];
}

export interface RunnerStatus {
  backend: RunnerBackendName | null;
  languages: RunnerLanguage[];
  /** Human-readable reason when backend is null. */
  detail: string;
}

interface RunInput {
  language: RunnerLanguage;
  code: string;
  stdin: string;
  timeoutS: number;
}

const TOOL_META: Array<{ name: string; language: RunnerLanguage; blurb: string }> = [
  { name: 'run_js', language: 'javascript', blurb: 'JavaScript (Node-compatible runtime)' },
  { name: 'run_python', language: 'python', blurb: 'Python 3' },
];

@Injectable()
export class RunnerService {
  /** Injectable for tests (same seam as ConnectionsService). */
  fetchImpl: typeof fetch = fetch;

  constructor(private readonly config: ConfigService) {}

  /** Resolve the active backend. 'auto' prefers cloudflare when configured
   *  (it is an explicit paid setup), else local when the OS supports it. */
  status(): RunnerStatus {
    const mode = String(this.config.get('runnerBackend') ?? 'auto');
    const cfReady = Boolean(this.config.get('runnerCfUrl') && this.config.get('runnerCfToken'));
    const localSandbox = this.localSandboxPath();
    if (mode === 'off') return { backend: null, languages: [], detail: 'disabled (RUNNER_BACKEND=off)' };
    if (mode === 'cloudflare' || (mode === 'auto' && cfReady)) {
      if (!cfReady) return { backend: null, languages: [], detail: 'cloudflare backend selected but RUNNER_CF_URL / RUNNER_CF_TOKEN are not set' };
      return { backend: 'cloudflare', languages: ['javascript', 'python'], detail: 'Cloudflare Sandboxes via runner worker' };
    }
    if (!localSandbox) {
      return {
        backend: null, languages: [],
        detail: process.platform === 'darwin'
          ? 'sandbox-exec not found' : 'bubblewrap (bwrap) not installed — required for the local OS sandbox',
      };
    }
    const languages: RunnerLanguage[] = ['javascript'];
    if (this.pythonPath()) languages.push('python');
    return { backend: 'local', languages, detail: `local OS sandbox (${process.platform === 'darwin' ? 'Seatbelt' : 'bubblewrap'})` };
  }

  /** Tool specs for the turn loop — empty when no backend is available, so
   *  the tools simply do not exist rather than existing-but-broken. */
  specs(): AiToolSpec[] {
    const { backend, languages } = this.status();
    if (!backend) return [];
    return TOOL_META.filter((t) => languages.includes(t.language)).map((t) => ({
      name: t.name,
      description: `Run a short ${t.blurb} program in a disposable sandbox and return its output. No network, no filesystem outside a scratch directory, fresh environment every call, killed after the time limit. Mutating-class: each call needs approval in Ask mode. Pass input data via "stdin" — the sandbox cannot read your files.`,
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The complete program to run' },
          stdin: { type: 'string', description: 'Optional text piped to standard input' },
          timeout_seconds: { type: 'number', description: `Wall-clock limit, 1-${MAX_TIMEOUT_S} (default ${DEFAULT_TIMEOUT_S})` },
        },
        required: ['code'],
      },
    }));
  }

  owns(name: string): boolean {
    return TOOL_META.some((t) => t.name === name);
  }

  /** Both tools execute arbitrary programs: always mutation-class. */
  isReadOnly(name: string): boolean | undefined {
    return this.owns(name) ? false : undefined;
  }

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const meta = TOOL_META.find((t) => t.name === name);
    if (!meta) throw new Error(`unknown tool: ${name}`);
    const { backend, languages } = this.status();
    if (!backend) throw new Error(`code runner is not available: ${this.status().detail}`);
    if (!languages.includes(meta.language)) throw new Error(`${meta.language} is not available on the ${backend} backend`);
    const code = typeof input.code === 'string' ? input.code : '';
    if (!code.trim()) throw new Error('invalid arguments: "code" must be a non-empty string');
    const run: RunInput = {
      language: meta.language,
      code,
      stdin: typeof input.stdin === 'string' ? input.stdin.slice(0, 100_000) : '',
      timeoutS: Math.min(Math.max(Math.floor(Number(input.timeout_seconds) || DEFAULT_TIMEOUT_S), 1), MAX_TIMEOUT_S),
    };
    return backend === 'local' ? this.runLocal(run) : this.runCloudflare(run);
  }

  // ---- local backend ------------------------------------------------------

  private localSandboxPath(): string | null {
    if (process.platform === 'darwin') return existsSync(SANDBOX_EXEC) ? SANDBOX_EXEC : null;
    if (process.platform === 'linux') return BWRAP_CANDIDATES.find((p) => existsSync(p)) ?? null;
    return null;
  }

  private pythonPath(): string | null {
    return PYTHON_CANDIDATES.find((p) => existsSync(p)) ?? null;
  }

  private async runLocal(run: RunInput): Promise<string> {
    const sandbox = this.localSandboxPath();
    if (!sandbox) throw new Error('local sandbox unavailable');
    // realpath: on macOS tmpdir() lives under /var → /private/var, and the
    // Seatbelt subpath must name the resolved path or the write allow misses.
    const scratch = realpathSync(await mkdtemp(join(tmpdir(), 'yaam-run-')));
    try {
      const file = run.language === 'python' ? 'main.py' : 'main.js';
      await writeFile(join(scratch, file), run.code, 'utf8');
      const interp = run.language === 'python' ? this.pythonPath()! : process.execPath;
      const argv = process.platform === 'darwin'
        ? [sandbox, '-p', seatbeltProfile(scratch), interp, file]
        : [sandbox, ...bwrapArgs(scratch), interp, file];
      return await this.spawnCapped(argv, scratch, run);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  private spawnCapped(argv: string[], cwd: string, run: RunInput): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        // TMPDIR inside the jail so interpreters never reach for /var/folders.
        env: { PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd, LANG: 'en_US.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, run.timeoutS * 1000);
      child.stdout.on('data', (d: Buffer) => { if (out.length < OUTPUT_CAP) out += d.toString('utf8'); });
      child.stderr.on('data', (d: Buffer) => { if (err.length < OUTPUT_CAP) err += d.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve(`killed: exceeded the ${run.timeoutS}s time limit\n${this.format(out, err)}`);
          return;
        }
        resolve(`exit code ${exitCode ?? 'unknown'}\n${this.format(out, err)}`);
      });
      if (run.stdin) child.stdin.write(run.stdin);
      child.stdin.end();
    });
  }

  private format(out: string, err: string): string {
    const cap = (s: string) => (s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n…(truncated)` : s);
    const parts = [`stdout:\n${cap(out) || '(empty)'}`];
    if (err.trim()) parts.push(`stderr:\n${cap(err)}`);
    return parts.join('\n');
  }

  // ---- cloudflare backend --------------------------------------------------

  private async runCloudflare(run: RunInput): Promise<string> {
    const base = String(this.config.get('runnerCfUrl') ?? '').replace(/\/+$/, '');
    const res = await this.fetchImpl(`${base}/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${String(this.config.get('runnerCfToken') ?? '')}`,
      },
      body: JSON.stringify({
        language: run.language,
        code: run.code,
        stdin: run.stdin,
        timeout_seconds: run.timeoutS,
      }),
      signal: AbortSignal.timeout(CF_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`runner worker error ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json() as { ok?: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string; timedOut?: boolean };
    if (data.ok === false) throw new Error(`runner worker refused: ${String(data.error ?? 'unknown error').slice(0, 300)}`);
    const head = data.timedOut
      ? `killed: exceeded the ${run.timeoutS}s time limit`
      : `exit code ${data.exitCode ?? 0}`;
    return `${head}\n${this.format(String(data.stdout ?? ''), String(data.stderr ?? ''))}`;
  }
}
