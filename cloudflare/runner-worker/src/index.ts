/**
 * yaam runner worker — the Cloudflare Sandboxes backend for the run_js /
 * run_python tools (docs/code-execution.md §3d, §5).
 *
 * The yaam server never talks to Cloudflare's API directly: it POSTs
 * {language, code, stdin, timeout_seconds} here with a bearer token, and this
 * Worker runs the program inside a Sandbox container whose egress is
 * deny-all. The container never holds a credential — outbound Workers run
 * out here, outside the sandbox, and we inject nothing.
 *
 * Deploy:
 *   cd cloudflare/runner-worker
 *   npx wrangler secret put RUNNER_TOKEN     # same value as RUNNER_CF_TOKEN
 *   npx wrangler deploy
 * Then point the server at it: RUNNER_CF_URL=https://<worker>.workers.dev
 */
import { getSandbox, Sandbox } from '@cloudflare/sandbox';

/** Deny-all egress. `allowedHosts = []` makes the allowlist empty, which is
 *  deny-by-default with nothing allowed — the sandbox cannot reach the
 *  network at all, matching the local backend's guarantee. */
export class RunnerSandbox extends Sandbox {
  allowedHosts: string[] = [];
}

interface Env {
  Sandbox: DurableObjectNamespace<RunnerSandbox>;
  RUNNER_TOKEN: string;
}

interface RunRequest {
  language?: string;
  code?: string;
  stdin?: string;
  timeout_seconds?: number;
}

const MAX_CODE_BYTES = 200_000;
const MAX_STDIN_BYTES = 100_000;
const MAX_TIMEOUT_S = 30;
const OUTPUT_CAP = 32_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Constant-time-ish compare so the token check does not leak length by timing. */
function tokenOk(header: string | null, expected: string): boolean {
  if (!expected) return false;
  const got = (header ?? '').replace(/^Bearer\s+/i, '');
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const cap = (s: string) => (s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n…(truncated)` : s);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname !== '/run') return json({ ok: false, error: 'not found' }, 404);
    if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
    if (!tokenOk(request.headers.get('authorization'), env.RUNNER_TOKEN)) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }

    let body: RunRequest;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400);
    }

    const language = body.language === 'python' ? 'python' : body.language === 'javascript' ? 'javascript' : null;
    if (!language) return json({ ok: false, error: 'language must be "javascript" or "python"' }, 400);
    const code = String(body.code ?? '');
    if (!code.trim()) return json({ ok: false, error: 'code is required' }, 400);
    if (code.length > MAX_CODE_BYTES) return json({ ok: false, error: 'code too large' }, 413);
    const stdin = String(body.stdin ?? '').slice(0, MAX_STDIN_BYTES);
    const timeoutS = Math.min(Math.max(Math.floor(Number(body.timeout_seconds) || 10), 1), MAX_TIMEOUT_S);

    // One sandbox per request id: a fresh environment every call, torn down
    // shortly after. Persistence is how injected code outlives its injection.
    const sandbox = getSandbox(env.Sandbox, `run-${crypto.randomUUID()}`, { sleepAfter: '2m' });
    try {
      const file = language === 'python' ? 'main.py' : 'main.js';
      await sandbox.writeFile(`/workspace/${file}`, code);
      if (stdin) await sandbox.writeFile('/workspace/stdin.txt', stdin);
      const interp = language === 'python' ? 'python3' : 'node';
      const pipe = stdin ? '< /workspace/stdin.txt' : '< /dev/null';
      const result = await sandbox.exec(
        `cd /workspace && timeout ${timeoutS}s ${interp} ${file} ${pipe} 2>/tmp/stderr; echo "__EXIT__$?"; cat /tmp/stderr >&2`,
      );
      const stdout = String(result.stdout ?? '');
      const marker = /__EXIT__(\d+)\s*$/.exec(stdout);
      const exitCode = marker ? Number(marker[1]) : (result.exitCode ?? 0);
      return json({
        ok: true,
        // GNU timeout reports 124 when it killed the child.
        timedOut: exitCode === 124,
        exitCode,
        stdout: cap(marker ? stdout.slice(0, marker.index) : stdout),
        stderr: cap(String(result.stderr ?? '')),
      });
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : 'sandbox error' }, 502);
    } finally {
      await sandbox.destroy?.().catch(() => {});
    }
  },
};
