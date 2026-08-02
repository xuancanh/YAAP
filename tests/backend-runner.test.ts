/** Code runner (docs/code-execution.md): the local OS sandbox really blocks
 *  network and out-of-jail writes, both backends share one tool contract, and
 *  the tools are mutation-class so Ask mode always pauses on the code. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigService } from '@nestjs/config';
import { RunnerService, seatbeltProfile, bwrapArgs } from '../server/src/runner/runner.service';

const cfg = (over: Record<string, unknown> = {}) => ({
  get: (key: string) => ({ runnerBackend: 'auto', runnerCfUrl: '', runnerCfToken: '', ...over })[key],
} as unknown as ConfigService);

const localOnly = process.platform === 'darwin' || process.platform === 'linux';

test('tool contract: both tools are mutation-class and owned by the runner', () => {
  const svc = new RunnerService(cfg({ runnerBackend: 'cloudflare', runnerCfUrl: 'https://r.test', runnerCfToken: 't' }));
  assert.equal(svc.owns('run_js'), true);
  assert.equal(svc.owns('run_python'), true);
  assert.equal(svc.owns('fs_read'), false);
  // never read-only: Ask mode must pause on every execution
  assert.equal(svc.isReadOnly('run_js'), false);
  assert.equal(svc.isReadOnly('run_python'), false);
  assert.equal(svc.isReadOnly('fs_read'), undefined);
  const names = svc.specs().map((s) => s.name).sort();
  assert.deepEqual(names, ['run_js', 'run_python']);
  // the schema tells the model to pipe data in, since the sandbox has no files
  const spec = svc.specs().find((s) => s.name === 'run_js')!;
  assert.match(spec.description, /No network/);
  assert.deepEqual((spec.inputSchema as { required: string[] }).required, ['code']);
});

test('backend selection: off hides the tools, cloudflare needs its url + token', () => {
  const off = new RunnerService(cfg({ runnerBackend: 'off' }));
  assert.equal(off.status().backend, null);
  assert.deepEqual(off.specs(), []);

  const misconfigured = new RunnerService(cfg({ runnerBackend: 'cloudflare' }));
  assert.equal(misconfigured.status().backend, null);
  assert.match(misconfigured.status().detail, /RUNNER_CF_URL/);
  assert.deepEqual(misconfigured.specs(), []);

  const cloud = new RunnerService(cfg({ runnerBackend: 'cloudflare', runnerCfUrl: 'https://r.test', runnerCfToken: 't' }));
  assert.equal(cloud.status().backend, 'cloudflare');
  // an explicit paid setup wins over the local sandbox under 'auto'
  const auto = new RunnerService(cfg({ runnerBackend: 'auto', runnerCfUrl: 'https://r.test', runnerCfToken: 't' }));
  assert.equal(auto.status().backend, 'cloudflare');
});

test('seatbelt profile denies network and jails writes to the scratch dir', () => {
  const p = seatbeltProfile('/private/tmp/yaam-run-x');
  assert.match(p, /\(deny network\*\)/);
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /\(allow file-write\* \(subpath "\/private\/tmp\/yaam-run-x"\)\)/);
  // the path is JSON-quoted, so a dir name with a quote cannot break out
  assert.match(seatbeltProfile('/tmp/a"b'), /subpath "\/tmp\/a\\"b"/);
});

test('bubblewrap args drop the network namespace and bind only the scratch dir rw', () => {
  const a = bwrapArgs('/tmp/yaam-run-y');
  assert.ok(a.includes('--unshare-all'), 'no network namespace');
  assert.ok(a.includes('--die-with-parent'));
  const roBind = a.indexOf('--ro-bind');
  assert.deepEqual(a.slice(roBind, roBind + 3), ['--ro-bind', '/', '/']);
  const bind = a.indexOf('--bind');
  assert.deepEqual(a.slice(bind, bind + 3), ['--bind', '/tmp/yaam-run-y', '/tmp/yaam-run-y']);
});

test('unknown tool and empty code are refused before any sandbox starts', async () => {
  const svc = new RunnerService(cfg({ runnerBackend: 'cloudflare', runnerCfUrl: 'https://r.test', runnerCfToken: 't' }));
  await assert.rejects(svc.execute('run_ruby', { code: 'x' }), /unknown tool/);
  await assert.rejects(svc.execute('run_js', { code: '   ' }), /"code" must be a non-empty string/);
});

test('cloudflare backend posts the run to the worker with a bearer token', async () => {
  const svc = new RunnerService(cfg({ runnerBackend: 'cloudflare', runnerCfUrl: 'https://r.test/', runnerCfToken: 'secret-token' }));
  let seen: { url: string; auth?: string; body?: string } | null = null;
  svc.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen = { url: String(url), auth: headers.authorization, body: init?.body ? String(init.body) : undefined };
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, exitCode: 0, stdout: '42\n', stderr: '' }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;

  const out = await svc.execute('run_js', { code: 'console.log(6*7)', stdin: 'in', timeout_seconds: 99 });
  assert.match(out, /exit code 0/);
  assert.match(out, /42/);
  assert.ok(seen, 'the worker was called');
  assert.equal(seen!.url, 'https://r.test/run');
  assert.equal(seen!.auth, 'Bearer secret-token');
  const body = JSON.parse(seen!.body!) as { language: string; code: string; stdin: string; timeout_seconds: number };
  assert.equal(body.language, 'javascript');
  assert.equal(body.stdin, 'in');
  assert.equal(body.timeout_seconds, 30, 'timeout is clamped to the max before it leaves the server');
});

test('cloudflare backend surfaces worker errors instead of pretending to run', async () => {
  const svc = new RunnerService(cfg({ runnerBackend: 'cloudflare', runnerCfUrl: 'https://r.test', runnerCfToken: 't' }));
  svc.fetchImpl = (async () => ({ ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) }) as unknown as Response) as typeof fetch;
  await assert.rejects(svc.execute('run_js', { code: 'x' }), /runner worker error 401/);

  svc.fetchImpl = (async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ ok: false, error: 'container boot failed' }) }) as unknown as Response) as typeof fetch;
  await assert.rejects(svc.execute('run_js', { code: 'x' }), /container boot failed/);

  svc.fetchImpl = (async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ ok: true, exitCode: 124, timedOut: true, stdout: 'partial', stderr: '' }) }) as unknown as Response) as typeof fetch;
  const out = await svc.execute('run_js', { code: 'while(1){}', timeout_seconds: 2 });
  assert.match(out, /killed: exceeded the 2s time limit/);
  assert.match(out, /partial/);
});

// The remaining tests exercise the real OS sandbox. They are the whole point
// of the local backend, so they run for real rather than against a stub.
test('local backend: runs JS, captures stdout, reports the exit code', { skip: !localOnly }, async () => {
  const svc = new RunnerService(cfg({ runnerBackend: 'local' }));
  if (svc.status().backend !== 'local') return; // no sandbox binary on this box
  const out = await svc.execute('run_js', { code: 'console.log("sum", 2+3)' });
  assert.match(out, /exit code 0/);
  assert.match(out, /sum 5/);

  const failed = await svc.execute('run_js', { code: 'process.exit(3)' });
  assert.match(failed, /exit code 3/);
});

test('local backend: stdin is the data channel; stderr is reported', { skip: !localOnly }, async () => {
  const svc = new RunnerService(cfg({ runnerBackend: 'local' }));
  if (svc.status().backend !== 'local') return;
  const out = await svc.execute('run_js', {
    code: 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.error("note");console.log("got:"+s.trim())})',
    stdin: 'payload',
  });
  assert.match(out, /got:payload/);
  assert.match(out, /stderr:\nnote/);
});

test('local backend: the sandbox has no network', { skip: !localOnly }, async () => {
  const svc = new RunnerService(cfg({ runnerBackend: 'local' }));
  if (svc.status().backend !== 'local') return;
  const out = await svc.execute('run_js', {
    code: 'fetch("https://example.com").then(()=>console.log("NET-ALLOWED")).catch(e=>console.log("blocked:"+(e.cause?.code||e.message)))',
    timeout_seconds: 15,
  });
  assert.doesNotMatch(out, /NET-ALLOWED/, 'the sandbox must not reach the network');
  assert.match(out, /blocked:/);
});

test('local backend: writes outside the scratch jail fail', { skip: !localOnly }, async () => {
  const svc = new RunnerService(cfg({ runnerBackend: 'local' }));
  if (svc.status().backend !== 'local') return;
  const escape = await svc.execute('run_js', {
    code: 'try{require("fs").writeFileSync("/tmp/yaam-escape-test.txt","x");console.log("ESCAPED")}catch(e){console.log("denied:"+e.code)}',
  });
  assert.doesNotMatch(escape, /ESCAPED/, 'writes outside the scratch dir must be denied');
  // …while the scratch dir itself is writable, so real work is possible
  const inside = await svc.execute('run_js', {
    code: 'const fs=require("fs");fs.writeFileSync("f.txt","ok");console.log("read back:"+fs.readFileSync("f.txt","utf8"))',
  });
  assert.match(inside, /read back:ok/);
});

test('local backend: python runs under the same jail', { skip: !localOnly }, async () => {
  const svc = new RunnerService(cfg({ runnerBackend: 'local' }));
  if (!svc.status().languages.includes('python')) return; // no python3 on this box
  const out = await svc.execute('run_python', { code: 'import sys\nprint("sum", sum(range(5)))\nprint("stdin", sys.stdin.read().strip())', stdin: 'data' });
  assert.match(out, /sum 10/);
  assert.match(out, /stdin data/);
  // direct-IP sockets are blocked too, not just DNS
  const net = await svc.execute('run_python', {
    code: 'import socket\ntry:\n  socket.create_connection(("1.1.1.1",443),timeout=3); print("NET-ALLOWED")\nexcept Exception as e: print("blocked:", type(e).__name__)',
    timeout_seconds: 15,
  });
  assert.doesNotMatch(net, /NET-ALLOWED/);
  assert.match(net, /blocked:/);
});

test('local backend: a runaway program is killed at the deadline', { skip: !localOnly }, async () => {
  const svc = new RunnerService(cfg({ runnerBackend: 'local' }));
  if (svc.status().backend !== 'local') return;
  const started = Date.now();
  const out = await svc.execute('run_js', { code: 'while(true){}', timeout_seconds: 2 });
  assert.match(out, /killed: exceeded the 2s time limit/);
  assert.ok(Date.now() - started < 20_000, 'the kill actually happened');
});
