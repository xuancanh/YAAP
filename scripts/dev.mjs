/**
 * Dev runner — brings up the full stack with a single `npm run dev`:
 *   1. tsc --watch compiles the NestJS server to server/dist (CommonJS),
 *   2. the compiled server runs here and restarts after each finished compile,
 *   3. vite serves the frontend.
 *
 * The server must run from compiled output, not an on-the-fly transpiler:
 * Nest constructor injection needs emitDecoratorMetadata, which esbuild-based
 * loaders (tsx) do not support — under tsx every injected dependency arrives
 * as undefined at runtime.
 *
 * Kept robust (docs/architecture.md "Restarts and recovery"):
 *  - the server restarts once per *finished* compile (tsc's "Found N errors.
 *    Watching for file changes."), not on every file tsc writes — `node
 *    --watch` used to restart mid-emit, sometimes several times per compile,
 *    on a mix of old and new output; each restart interrupts the turns in
 *    flight, so fewer restarts is fewer interruptions. The old process gets
 *    its graceful shutdown (SIGTERM, the drain) before the new one starts;
 *  - a server crash no longer takes `npm run dev` down: it waits for the
 *    next compile (or restart it with `rs` + Enter);
 *  - compile errors are announced in a banner: tsc emits even when the code
 *    does not type-check, so without it the server quietly runs whatever
 *    half-applied change was saved, and the errors scroll away;
 *  - a stalled watcher is detected and restarted: tsc --watch can lose a
 *    file's watch when the file is replaced by rename (git checkout, merge
 *    and rebase; editors and agents that write atomically) and server/dist
 *    then silently stops updating while the watcher lives (today: a fix to
 *    home.service.ts never compiled, and the watcher kept reporting errors a
 *    fresh `tsc` does not have). Every few seconds each server/src file is
 *    compared — modification time, then content hash — with what it was when
 *    tsc last finished; a real change it has not picked up within STALL_MS
 *    restarts the compiler (a fresh, full compile; a mere touch does not).
 *    tsc also watches parent directories rather than file inodes
 *    (`--watchFile useFsEventsOnParentDirectory`), which survives atomic
 *    replaces in the first place.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
/** tsc itself, not through npx: a restart then signals the compiler, not a wrapper. */
const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const SRC = 'server/src';
/** A source change tsc has not compiled after this long means it stalled. */
const STALL_MS = Number(process.env.DEV_STALL_MS) || 15_000;
const WATCHDOG_EVERY_MS = 5_000;
/** How long a restarting server may take to drain before it is killed. */
const SERVER_STOP_MS = (Number(process.env.SHUTDOWN_GRACE_MS) || 3_000) + 9_000;

const log = (msg) => console.log(`\x1b[36m[dev]\x1b[0m ${msg}`);
const banner = (msg) => console.log(`\n\x1b[41m\x1b[97m [dev] ${msg} \x1b[0m\n`);
// eslint-disable-next-line no-control-regex -- ANSI colour codes from tsc --pretty
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

log('building server…');
const build = spawnSync(process.execPath, [TSC, '-p', 'server/tsconfig.json'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

let shuttingDown = false;

// ---- the server ----

let server = null;
let serverStopping = null;

function startServer() {
  if (shuttingDown) return;
  const child = spawn(process.execPath, ['server/dist/main.js', ...args], { stdio: 'inherit' });
  server = child;
  child.on('exit', (code, signal) => {
    if (server === child) server = null;
    if (shuttingDown || child.restarting) return;
    log(`server exited (${signal ?? `code ${code}`}); it starts again after the next compile — or type rs and Enter`);
  });
}

/** Stop the running server gracefully (SIGTERM → its drain), then start it. */
async function restartServer(why) {
  if (shuttingDown) return;
  if (serverStopping) { await serverStopping; return; }
  const old = server;
  if (old) {
    log(`restarting the server (${why})`);
    old.restarting = true;
    serverStopping = new Promise((resolve) => {
      const kill = setTimeout(() => { old.kill('SIGKILL'); }, SERVER_STOP_MS);
      old.once('exit', () => { clearTimeout(kill); resolve(); });
      old.kill('SIGTERM');
    });
    await serverStopping;
    serverStopping = null;
  }
  startServer();
}

// ---- the compiler ----

let tsc = null;
let compiling = false;
let compiles = 0;
let errorsShown = false;

function startTsc() {
  const child = spawn(process.execPath, [TSC, '-p', 'server/tsconfig.json', '--watch', '--preserveWatchOutput', '--pretty', '--watchFile', 'useFsEventsOnParentDirectory'], { stdio: ['ignore', 'pipe', 'inherit'] });
  tsc = child;
  compiling = true;
  createInterface({ input: child.stdout }).on('line', (line) => {
    process.stdout.write(`${line}\n`);
    const plain = strip(line);
    if (/Starting compilation|File change detected/.test(plain)) { compiling = true; return; }
    const found = /Found (\d+) errors?\. Watching for file changes/.exec(plain);
    if (!found) return;
    compiling = false;
    compiles++;
    snapshot();
    const errors = Number(found[1]);
    if (errors > 0) {
      banner(`the server has ${errors} compile error${errors === 1 ? '' : 's'} — it runs the output anyway, which may be broken or stale`);
      errorsShown = true;
    } else if (errorsShown) {
      log('the compile errors are fixed');
      errorsShown = false;
    }
    // The watcher's first compile rebuilds what the one-shot build just did.
    if (child.firstDone) void restartServer(errors > 0 ? 'compiled with errors' : 'compiled');
    child.firstDone = true;
  });
  child.on('exit', (code) => {
    if (tsc !== child || shuttingDown || child.restarting) return;
    log(`the compiler exited (code ${code}); starting it again`);
    startTsc();
  });
}

function restartTsc(why) {
  const old = tsc;
  log(`restarting the compiler: ${why}`);
  if (old) { old.restarting = true; old.kill('SIGTERM'); }
  startTsc();
  // its first compile is a full one: restart the server after it
  tsc.firstDone = true;
}

/** Every .ts file under server/src with its modification time (ms). */
function sources(dir = SRC, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (entry.name.endsWith('.ts')) out.set(path, statSync(path).mtimeMs);
  }
  return out;
}

const hashOf = (path) => createHash('sha1').update(readFileSync(path)).digest('hex');

/** What tsc last compiled, as far as the runner can tell: each file's
 *  modification time and content hash when a compile finished. A file
 *  touched without a change (same hash) is not a missed change. */
let compiled = new Map();
function snapshot() {
  const next = new Map();
  try { for (const [path, at] of sources()) next.set(path, { at, hash: hashOf(path) }); } catch { return; }
  compiled = next;
}

const watchdog = setInterval(() => {
  if (shuttingDown || compiling || compiles === 0) return;
  let now;
  let files;
  try { files = sources(); now = Date.now(); } catch { return; }
  for (const [path, at] of files) {
    const seen = compiled.get(path);
    if (seen && seen.at === at) continue;
    if (now - at <= STALL_MS) continue; // tsc may still be about to pick it up
    let hash;
    try { hash = hashOf(path); } catch { continue; }
    if (seen && seen.hash === hash) { seen.at = at; continue; } // touched, not changed
    restartTsc(`it did not pick up ${path} (changed ${Math.round((now - at) / 1000)}s ago) — its file watch was lost`);
    return;
  }
}, WATCHDOG_EVERY_MS);
watchdog.unref();

// ---- the frontend ----

const vite = spawn('npx', ['vite', '--host', '0.0.0.0'], { stdio: 'inherit' });
vite.on('exit', (code) => { if (code && code !== 0) shutdown(code); });

startTsc();
startServer();

// `rs` + Enter restarts the server by hand, as nodemon does.
if (process.stdin.isTTY) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === 'rs') void restartServer('by hand');
  });
}

function shutdown(code = 0) {
  shuttingDown = true;
  clearInterval(watchdog);
  for (const child of [tsc, server, vite]) {
    if (child && !child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
