#!/usr/bin/env node
/**
 * yaam-companion — lets your YAAP agents act on THIS computer.
 *
 *   yaam-companion pair <server-url> <code> --scopes screen,input,shell,files:/abs/dir [--name laptop]
 *   yaam-companion run
 *   yaam-companion status
 *   yaam-companion unpair
 *
 * Everything is outbound: the companion long-polls the server for work,
 * performs one action at a time after its own scope check, posts the result,
 * and prints every action to this console. Stop it with Ctrl-C; revoke it
 * from Settings → Computer; narrow what it may do there too.
 */
import { hostname } from 'node:os';
import { performAction } from './actions.js';
import { ApiError, CompanionClient } from './client.js';
import { clearConfig, configPath, loadConfig, saveConfig } from './config.js';
import { isSubset, parseScopes } from './scopes.js';

const log = (msg: string): void => { console.log(`${new Date().toISOString()}  ${msg}`); };

function usage(code = 1): never {
  console.error(`yaam-companion — act on this computer for your YAAP agents

  pair <server-url> <code> --scopes <list> [--name <label>]
        Redeem a pairing code from Settings → Computer. Scopes, comma separated:
          screen             take screenshots
          input              mouse and keyboard
          shell              run shell commands as you
          files:/abs/dir     read/write/list files under that directory (repeatable)
        Example: pair https://yaam.example 1a2b3c4d --scopes screen,input,files:$HOME/Projects
  run         Connect and wait for approved actions (Ctrl-C to stop).
  status      Show the pairing on this machine.
  unpair      Forget the pairing here (also Disconnect in Settings → Computer to revoke the token).

Config: ${configPath()} (mode 0600)`);
  process.exit(code);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

async function pair(args: string[]): Promise<void> {
  const [serverUrl, code] = args;
  const scopesArg = flag(args, '--scopes');
  if (!serverUrl || !code || !scopesArg) usage();
  let url: URL;
  try { url = new URL(serverUrl); } catch { console.error(`not a URL: ${serverUrl}`); process.exit(1); }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    console.error('refusing to pair over plain http to a non-local server — the token would travel in the clear');
    process.exit(1);
  }
  const scopes = parseScopes(scopesArg);
  const name = flag(args, '--name') ?? hostname();
  console.log(`Pairing with ${url.origin} as "${name}" with scopes:\n  ${scopes.join('\n  ')}`);
  if (scopes.includes('shell')) console.log('  ! shell: agents may run commands as you (each one approved in the app first).');
  const res = await CompanionClient.pair(url.origin, { code, name, platform: process.platform, scopes });
  await saveConfig({ serverUrl: url.origin, token: res.token, runnerId: res.runnerId, name, platform: process.platform, scopes: res.scopes, pairedAt: new Date().toISOString() });
  console.log(`Paired. Token saved to ${configPath()} (mode 0600).\nNext: yaam-companion run`);
}

async function status(): Promise<void> {
  const c = await loadConfig();
  if (!c) { console.log(`Not paired. Run: yaam-companion pair <server-url> <code> --scopes …`); return; }
  console.log(`Server:   ${c.serverUrl}\nName:     ${c.name} (${c.platform})\nPaired:   ${c.pairedAt}\nScopes:   ${c.scopes.join(', ')}\nConfig:   ${configPath()}`);
  try {
    const hb = await new CompanionClient(c.serverUrl, c.token).heartbeat();
    console.log(`Status:   ${hb.paused ? 'paused in the app' : 'active'}; server scopes: ${hb.scopes.join(', ')}`);
  } catch (err) {
    console.log(`Status:   cannot reach the server (${err instanceof Error ? err.message : err})`);
  }
}

async function run(): Promise<void> {
  const c = await loadConfig();
  if (!c) { console.error('Not paired. Run: yaam-companion pair <server-url> <code> --scopes …'); process.exit(1); }
  const client = new CompanionClient(c.serverUrl, c.token);
  let scopes = c.scopes;
  let paused = false;
  let stopping = false;
  const stop = () => { if (stopping) process.exit(0); stopping = true; log('stopping after the current action…'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log(`connected to ${c.serverUrl} as "${c.name}" · scopes: ${scopes.join(', ')}`);
  log('waiting for approved actions (every one is approved by you in the app first; Ctrl-C to stop)');

  // The server may only narrow scopes; accept its set when it is a subset of
  // what the owner typed here, never anything wider.
  const sync = async () => {
    try {
      const hb = await client.heartbeat();
      if (hb.paused !== paused) { paused = hb.paused; log(paused ? 'paused in Settings → Computer — refusing actions' : 'resumed'); }
      if (isSubset(scopes, hb.scopes) && hb.scopes.join('|') !== scopes.join('|')) { scopes = hb.scopes; log(`scopes narrowed by the server: ${scopes.join(', ')}`); }
    } catch { /* the poll loop reports connectivity */ }
  };
  await sync();
  const hbTimer = setInterval(() => { void sync(); }, 60_000);

  let backoff = 2_000;
  while (!stopping) {
    let item;
    try {
      item = await client.nextWork();
      backoff = 2_000;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { log('token revoked (disconnected in the app or re-paired elsewhere) — exiting; pair again to reconnect'); break; }
      if (err instanceof ApiError && err.status === 403) { log('computer control is disabled on the server — retrying in 30s'); await sleep(30_000); continue; }
      if (!(err instanceof Error && err.name === 'TimeoutError')) {
        log(`cannot reach the server (${err instanceof Error ? err.message : err}) — retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
      continue;
    }
    if (!item) continue;
    const summary = describe(item.tool, item.input);
    log(`▶ ${item.tool}  ${summary}`);
    const started = Date.now();
    const result = paused
      ? { ok: false, output: 'refused by the companion: paused in Settings → Computer' }
      : await performAction(item, scopes);
    const ms = Date.now() - started;
    log(`${result.ok ? '✔' : '✖'} ${item.tool}  ${ms}ms${result.ok ? '' : `  ${firstLine(result.output ?? '')}`}`);
    try {
      await client.submit(item.id, result);
    } catch (err) {
      log(`could not deliver the result (${err instanceof Error ? err.message : err})`);
    }
  }
  clearInterval(hbTimer);
}

function describe(tool: string, input: Record<string, unknown>): string {
  const s = (v: unknown, n = 120) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
  switch (tool) {
    case 'computer_click': return `${s(input.button ?? 'left')}${input.double ? ' ×2' : ''} at (${s(input.x)}, ${s(input.y)})`;
    case 'computer_move': return `to (${s(input.x)}, ${s(input.y)})`;
    case 'computer_scroll': return `(${s(input.dx)}, ${s(input.dy)}) at (${s(input.x)}, ${s(input.y)})`;
    case 'computer_type': return `${String(input.text ?? '').length} chars`;
    case 'computer_key': return s(input.combo, 40);
    case 'computer_shell': return `$ ${s(input.command, 200)}${input.cwd ? `  (in ${s(input.cwd, 80)})` : ''}`;
    case 'computer_read_file': case 'computer_list_dir': return s(input.path, 200);
    case 'computer_write_file': return `${s(input.path, 200)} (${String(input.content ?? '').length} chars)`;
    default: return '';
  }
}

const firstLine = (s: string): string => s.split('\n')[0].slice(0, 160);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'pair': return pair(rest);
    case 'run': return run();
    case 'status': return status();
    case 'unpair': await clearConfig(); console.log('Pairing forgotten on this machine. Also click Disconnect in Settings → Computer to revoke the token server-side.'); return;
    case '-h': case '--help': case 'help': return usage(0);
    default: return usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
