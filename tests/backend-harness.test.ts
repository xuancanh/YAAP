/** Coding harnesses as the code_agent tool (docs/coding-harnesses.md): the
 *  command/env builder per harness (flags from settings, the key in the env
 *  only), settings validation and redaction, detection with a fake binary,
 *  a run with a fake CLI (materialise → run → sync back through WorkspaceFs
 *  as the agent; a refused path; symlinks never followed; secrets redacted;
 *  the env scrubbed), the timeout, max-turns and Stop kills, and the tool's
 *  gating in the turn loop with the owner's per-agent opt-in. No real CLI
 *  and no network is ever used. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub } from './helpers';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService, type TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { WorkspaceFs, type FsActor } from '../server/src/files/workspace-fs.service';
import { SettingsService } from '../server/src/settings/settings.module';
import { HarnessService, codeAgentSpec, CODE_AGENT_TOOL, osSandboxKind } from '../server/src/harness/harness.service';
import { HarnessController } from '../server/src/harness/harness.module';
import {
  applyPatch, defaultConfig, HarnessConfigError, openKey, parseSettings, redact, type HarnessConfig, type HarnessId,
} from '../server/src/harness/harness-config';
import { buildCommand, claudeParser, codexParser, harnessBwrap, harnessSeatbelt, piParser, redactSecrets, type RunDirs } from '../server/src/harness/harness-commands';
import { classOf, runsFreely } from '../server/src/actions/action-classes';
import { isOwnerOnlyRoute } from '../server/src/shared/workspace-access.guard';

const KEY = 'sk-test-SECRET-1234567890';
const dirs: RunDirs = { runDir: '/r', workDir: '/r/work', homeDir: '/r/home', tmpDir: '/r/tmp' };
const cfgOf = (id: HarnessId, patch: Partial<HarnessConfig> = {}): HarnessConfig => ({ ...defaultConfig(id), enabled: true, ...patch });
const build = (id: HarnessId, patch: Partial<HarnessConfig> = {}, model = '') => buildCommand({
  id, cfg: cfgOf(id, patch), task: '-rm everything', model, maxTurns: 7, apiKey: KEY, dirs, realHome: '/Users/owner', pathDirs: ['/opt/cli/bin'],
});

// ---- command / env builders ------------------------------------------------

test('claude_code: headless stream-json, turns, isolated config dir, the mode as permission flags, the key in env only', () => {
  const c = build('claude_code', { mode: 'edit', costCapUsd: 1.5 }, 'sonnet');
  assert.deepEqual(c.args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.ok(c.args.join(' ').includes('--max-turns 7'));
  assert.ok(c.args.join(' ').includes('--permission-mode acceptEdits --tools Read,Grep,Glob,Edit,Write'));
  assert.ok(c.args.join(' ').includes('--model sonnet'));
  assert.ok(c.args.join(' ').includes('--max-budget-usd 1.5'));
  assert.ok(c.args.includes('--strict-mcp-config') && c.args.join(' ').includes('--setting-sources user'), 'no workspace-planted settings or MCP');
  assert.equal(c.stdin, '-rm everything', 'the task goes through stdin, never argv');
  assert.equal(c.env.ANTHROPIC_API_KEY, KEY);
  assert.equal(c.env.CLAUDE_CONFIG_DIR, '/r/home/.claude');
  assert.equal(c.env.HOME, '/r/home');
  assert.equal(c.env.TMPDIR, '/r/tmp');
  assert.ok(c.env.PATH.startsWith('/opt/cli/bin:'));
  assert.ok(!c.args.some((a) => a.includes(KEY)), 'no secret in argv');
  assert.deepEqual(Object.keys(c.env).filter((k) => !['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'NO_COLOR', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY'].includes(k)), []);
  assert.ok(build('claude_code', { mode: 'read_only' }).args.join(' ').includes('--permission-mode dontAsk --tools Read,Grep,Glob'));
  assert.ok(build('claude_code', { mode: 'full' }).args.join(' ').includes('--permission-mode bypassPermissions'));
  assert.ok(!build('claude_code', { costCapUsd: 0 }).args.includes('--max-budget-usd'));
});

test('claude_code with the CLI login: the real HOME and its config dir writable, no key', () => {
  const c = build('claude_code', { auth: 'cli_login' });
  assert.equal(c.env.HOME, '/Users/owner');
  assert.equal(c.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(c.env.CLAUDE_CONFIG_DIR, undefined);
  assert.deepEqual(c.extraWritable, ['/Users/owner/.claude', '/Users/owner/.claude.json']);
});

test('deepseek: the Claude Code CLI on DeepSeek\'s Anthropic-compatible endpoint, every model slot mapped, no Anthropic budget flag', () => {
  const c = build('deepseek', { costCapUsd: 3 });
  assert.equal(c.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(c.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(c.env.ANTHROPIC_API_KEY, undefined);
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(c.env[k], 'deepseek-v4-pro');
  assert.ok(!c.args.includes('--max-budget-usd'), 'Claude Code prices DeepSeek tokens wrong; the service caps from usage');
  assert.equal(c.keyEnv, 'ANTHROPIC_AUTH_TOKEN');
});

test('codex: exec --json with the prompt on stdin, the mode as --sandbox (never danger-full-access), CODEX_HOME isolated', () => {
  const c = build('codex', { mode: 'full' }, 'gpt-5');
  assert.deepEqual(c.args.slice(0, 4), ['exec', '--json', '--skip-git-repo-check', '--ephemeral']);
  assert.equal(c.args[c.args.length - 1], '-');
  assert.ok(c.args.join(' ').includes('--sandbox workspace-write -c sandbox_workspace_write.network_access=true'));
  assert.ok(c.args.join(' ').includes('approval_policy="never"'));
  assert.ok(!c.args.includes('danger-full-access'));
  assert.ok(c.args.join(' ').includes('--cd /r/work'));
  assert.equal(c.env.CODEX_API_KEY, KEY);
  assert.equal(c.env.CODEX_HOME, '/r/home/.codex');
  assert.ok(build('codex', { mode: 'read_only' }).args.join(' ').includes('--sandbox read-only'));
  const custom = build('codex', { baseUrl: 'https://llm.example.com/v1' });
  assert.ok(custom.args.join(' ').includes('model_providers.yaam.base_url="https://llm.example.com/v1"'));
  assert.equal(custom.env.YAAM_CODEX_API_KEY, KEY);
  assert.equal(custom.env.CODEX_API_KEY, undefined);
  assert.ok(!custom.args.some((a) => a.includes(KEY)));
});

test('pi: json mode, no session, no extensions, the provider\'s key env, tools by mode, "--" before the task', () => {
  const c = build('pi', { provider: 'deepseek', mode: 'edit' }, 'deepseek-v4-pro');
  assert.ok(c.args.join(' ').includes('--mode json --no-session --no-extensions --no-skills --no-prompt-templates --no-approve'));
  assert.ok(c.args.join(' ').includes('--tools read,edit,write'));
  assert.ok(c.args.join(' ').includes('--provider deepseek --model deepseek-v4-pro'));
  assert.deepEqual(c.args.slice(-2), ['--', '-rm everything']);
  assert.equal(c.env.DEEPSEEK_API_KEY, KEY);
  assert.equal(c.env.PI_CODING_AGENT_DIR, '/r/home/.pi/agent');
  assert.equal(c.stdin, null);
  const custom = build('pi', { baseUrl: 'https://llm.example.com/v1' }, 'm1');
  assert.equal(custom.files.length, 1);
  assert.equal(JSON.parse(custom.files[0].content).providers.yaam.baseUrl, 'https://llm.example.com/v1');
  assert.ok(!custom.args.some((a) => a.includes(KEY)));
});

test('OS sandbox wrappers: writes jailed to the run dir (+ a login CLI\'s config dir), network kept', () => {
  const sb = harnessSeatbelt('/r', ['/Users/o/.claude.json']);
  assert.ok(sb.includes('(deny file-write*)') && sb.includes('(allow file-write* (subpath "/r"))'));
  assert.ok(sb.includes('regex #"^/Users/o/\\.claude\\.json"'));
  assert.ok(!sb.includes('deny network'));
  const bw = harnessBwrap('/r', '/r/work', ['/home/o/.codex']);
  assert.ok(bw.includes('--share-net') && bw.includes('--unshare-all'));
  assert.ok(bw.join(' ').includes('--bind /r /r') && bw.join(' ').includes('--bind-try /home/o/.codex /home/o/.codex'));
});

test('stream parsers: progress lines, final text, turns, usage and cost per CLI', () => {
  const cp = claudeParser('claude-sonnet-4-5');
  const lines = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-4-5' },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 100, output_tokens: 20 } } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'dup' }], usage: { input_tokens: 100, output_tokens: 20 } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Done: tests pass.', num_turns: 3, total_cost_usd: 0.0123, usage: { input_tokens: 500, output_tokens: 80 } },
  ];
  const progress = lines.flatMap((l) => cp.feed(JSON.stringify(l)));
  assert.ok(progress.includes('Bash: npm test') && progress.includes('session started (claude-sonnet-4-5)'));
  assert.equal(cp.turns(), 1, 'the same message id counts once');
  const r = cp.result();
  assert.equal(r.finalText, 'Done: tests pass.');
  assert.equal(r.turns, 3); assert.equal(r.costUsd, 0.0123); assert.equal(r.costSource, 'reported'); assert.equal(r.isError, false);
  const err = claudeParser('x');
  err.feed(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['hit the limit'], num_turns: 7, total_cost_usd: 0.5, usage: {} }));
  assert.equal(err.result().isError, true); assert.equal(err.result().errorText, 'hit the limit');

  const xp = codexParser('gpt-5');
  for (const l of [
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'bash -lc ls', exit_code: 0 } },
    { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }] } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Changed a.ts.' } },
    { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } },
  ]) xp.feed(JSON.stringify(l));
  const xr = xp.result();
  assert.equal(xr.finalText, 'Changed a.ts.'); assert.equal(xr.turns, 2); assert.equal(xr.tokensIn, 1000); assert.equal(xr.isError, false);
  assert.equal(xr.costSource, 'estimated');

  const pp = piParser('m');
  for (const l of [
    { type: 'turn_start' },
    { type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash', args: { command: 'ls' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'All done.' }], usage: { input: 10, output: 5, cost: { total: 0.002 } } } },
    { type: 'agent_end', messages: [], willRetry: false },
  ]) pp.feed(JSON.stringify(l));
  const pr = pp.result();
  assert.equal(pr.finalText, 'All done.'); assert.equal(pr.costUsd, 0.002); assert.equal(pr.costSource, 'reported'); assert.equal(pr.turns, 1);
  assert.equal(redactSecrets(`key=${KEY}!`, [KEY]), 'key=[redacted]!');
});

// ---- settings ------------------------------------------------------------

test('settings: strict validation, the key sealed at rest and never in the redacted view', () => {
  const base = defaultConfig('claude_code');
  for (const bad of [
    { maxTurns: 0 }, { maxTurns: 'x' }, { timeoutS: 5 }, { costCapUsd: -1 }, { mode: 'yolo' }, { enabled: 'yes' },
    { binaryPath: 'claude' }, { baseUrl: 'http://evil.example.com' }, { baseUrl: 'https://u:p@x.example.com' }, { model: '--dangerously-skip-permissions' },
    { agents: ['a b'] }, { freeAgents: 'all' }, { provider: 'nope' }, { auth: 'magic' },
  ]) assert.throws(() => applyPatch('claude_code', base, bad), HarnessConfigError, JSON.stringify(bad));
  assert.throws(() => applyPatch('deepseek', defaultConfig('deepseek'), { auth: 'cli_login' }), HarnessConfigError);
  const next = applyPatch('claude_code', base, { enabled: true, apiKey: KEY, maxTurns: 12, agents: ['a1'], freeAgents: ['a1'], baseUrl: 'http://localhost:4000/' });
  assert.notEqual(next.apiKey, KEY);
  assert.ok(!next.apiKey.includes(KEY) || next.apiKey.startsWith('plain:'), 'sealed (or marked plaintext without TOKEN_ENCRYPTION_KEY)');
  assert.equal(openKey(next), KEY);
  assert.equal(next.baseUrl, 'http://localhost:4000');
  const view = redact(next) as unknown as Record<string, unknown>;
  assert.equal(view.apiKey, undefined); assert.equal(view.hasApiKey, true);
  const round = parseSettings(JSON.stringify({ claude_code: next }));
  assert.equal(openKey(round.claude_code), KEY, 'a stored row reads back without re-sealing');
  assert.equal(parseSettings('not json').codex.enabled, false);
});

test('settings API: validated per harness, the key never returned, internal rows kept out of GET /settings, owner-only writes', async () => {
  const db = await testDb();
  const { stub } = memStorage();
  const settings = new SettingsService(db);
  const svc = new HarnessService(settings, new WorkspaceFs(stub, db));
  svc.searchDirs = [];
  const ctl = new HarnessController(svc);
  await assert.rejects(ctl.update('claude_code', { maxTurns: 1000 }), /maxTurns/);
  await assert.rejects(ctl.update('nope', {}), /unknown harness/);
  const view = await ctl.update('claude_code', { enabled: true, apiKey: KEY, mode: 'read_only' });
  const cc = view.harnesses.find((h) => h.id === 'claude_code')!;
  assert.equal(cc.config.enabled, true); assert.equal(cc.config.mode, 'read_only'); assert.equal(cc.config.hasApiKey, true);
  assert.ok(!JSON.stringify(view).includes(KEY));
  assert.equal(cc.status.found, false);
  const all = await settings.all();
  assert.ok(!Object.keys(all).some((k) => k.startsWith('harness.')), 'the sealed row is not a plain setting');
  await settings.put({ 'harness.config': '{}' } as Record<string, string>);
  assert.equal((await svc.config()).claude_code.enabled, true, 'PUT /settings cannot overwrite it');
  assert.ok(isOwnerOnlyRoute('PUT', '/api/harness/claude_code'));
  assert.ok(!isOwnerOnlyRoute('GET', '/api/harness'));
});

// ---- fake CLIs -------------------------------------------------------------

/** A fake `claude` (Node script) driven by its stdin task: OK edits the
 *  folder and reports; SLEEP never ends; TURNS emits endless turns; ENV
 *  prints its environment's keys; SLOW edits, reports progress, then waits. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('2.1.310 (Claude Code)'); process.exit(0); }
let task = '';
process.stdin.on('data', (d) => { task += d; });
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5' });
  if (task.startsWith('SLEEP')) { setInterval(() => {}, 1000); return; }
  if (task.startsWith('TURNS')) { let i = 0; setInterval(() => out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm' + (i++), content: [{ type: 'text', text: 'turn ' + i }], usage: { input_tokens: 1, output_tokens: 1 } } }), 5); return; }
  if (task.startsWith('ENV')) { out({ type: 'result', subtype: 'success', is_error: false, result: Object.keys(process.env).sort().join(','), num_turns: 1, total_cost_usd: 0, usage: {} }); return; }
  if (task.startsWith('ESCAPE')) { let r = 'blocked'; try { fs.writeFileSync(__dirname + '/escaped.txt', 'x'); r = 'escaped'; } catch {} fs.writeFileSync('inside.txt', 'ok'); out({ type: 'result', subtype: 'success', is_error: false, result: r, num_turns: 1, total_cost_usd: 0, usage: {} }); return; }
  if (task.startsWith('SLOW')) { fs.writeFileSync('notes.md', 'never synced'); out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'a', content: [{ type: 'text', text: 'working' }], usage: {} } }); setInterval(() => {}, 1000); return; }
  fs.appendFileSync('notes.md', '\\nedited by the fake');
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync('src/new.ts', 'export const x = 1;\\n');
  if (fs.existsSync('old.txt')) fs.unlinkSync('old.txt');
  try { fs.symlinkSync('/etc/hosts', 'hosts-link'); } catch {}
  fs.writeFileSync('../outside.txt', 'not in the folder');
  out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'a1', content: [{ type: 'text', text: 'my key is ' + (process.env.ANTHROPIC_API_KEY || 'none') }, { type: 'tool_use', name: 'Edit', input: { file_path: 'notes.md' } }], usage: { input_tokens: 10, output_tokens: 5 } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Edited notes.md, added src/new.ts, removed old.txt. key=' + process.env.ANTHROPIC_API_KEY, num_turns: 2, total_cost_usd: 0.0042, usage: { input_tokens: 10, output_tokens: 5 } });
});
`;

async function fakeBin(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yaam-fakecli-'));
  const p = join(dir, name);
  await writeFile(p, body);
  await chmod(p, 0o755);
  return dir;
}

async function setup() {
  const db = await testDb();
  const { stub, map } = memStorage();
  const fs = new WorkspaceFs(stub, db);
  const settings = new SettingsService(db);
  const agents = new AgentsService(db, stub, new TriggerBus());
  const workspaces = new WorkspacesService(db, stub);
  const ws = (await workspaces.list())[0];
  const ada = await agents.create({ name: 'Ada', charter: 'You code.' });
  const bob = await agents.create({ name: 'Bob', charter: 'You review.' });
  const adaHome = (await agents.home(ada.id)).home;
  const bobHome = (await agents.home(bob.id)).home;
  const binDir = await fakeBin('claude', FAKE_CLAUDE);
  const svc = new HarnessService(settings, fs);
  svc.searchDirs = [binDir];
  svc.sandboxKind = () => null;
  const actor: FsActor = { kind: 'agent', id: ada.id, name: 'Ada', home: adaHome };
  const user: FsActor = { kind: 'user', id: 'u1', name: 'Uma' };
  await fs.write(ws.id, `${adaHome}/notes.md`, Buffer.from('hello'), { by: user });
  await fs.write(ws.id, `${adaHome}/old.txt`, Buffer.from('bye'), { by: user });
  await fs.write(ws.id, `${bobHome}/notes.md`, Buffer.from('bob'), { by: user });
  await svc.update('claude_code', { enabled: true, apiKey: KEY, osSandbox: false });
  return { db, map, fs, settings, agents, workspaces, ws, ada, bob, adaHome, bobHome, svc, actor, binDir };
}
type S = Awaited<ReturnType<typeof setup>>;

const runCfg = async (s: S, patch: Partial<HarnessConfig> = {}) => ({ ...(await s.svc.config()).claude_code, ...patch });

test('detection: a fake binary on the search path and its --version; a configured path that is not executable', async () => {
  const dir = await fakeBin('claude', '#!/bin/sh\ntouch yaam-detect-marker\necho "2.1.310 (Claude Code)"\n');
  const db = await testDb();
  const { stub } = memStorage();
  const svc = new HarnessService(new SettingsService(db), new WorkspaceFs(stub, db));
  svc.searchDirs = ['/nonexistent', dir];
  const st = await svc.detect('claude_code', cfgOf('claude_code'));
  assert.equal(st.found, true); assert.equal(st.version, '2.1.310'); assert.equal(st.path, join(dir, 'claude'));
  assert.equal(existsSync(join(process.cwd(), 'yaam-detect-marker')), false, '--version runs in a throwaway dir, never the server cwd');
  const dsk = await svc.detect('deepseek', cfgOf('deepseek'));
  assert.equal(dsk.found, true, 'DeepSeek runs the claude binary');
  const missing = await svc.detect('codex', cfgOf('codex'));
  assert.equal(missing.found, false); assert.match(missing.detail, /codex not found/);
  const notExec = join(dir, 'plain');
  await writeFile(notExec, 'x');
  assert.equal((await svc.detect('claude_code', cfgOf('claude_code', { binaryPath: notExec }), true)).found, false);
  const broken = await fakeBin('codex', '#!/bin/sh\nexit 3\n');
  svc.searchDirs = [broken];
  assert.equal((await svc.detect('codex', cfgOf('codex'), true)).found, false);
});

test('a run: the folder copied out, the fake CLI edits it, changes sync back as the agent (versioned, attributed), deletes kept as revisions, symlinks and outside writes ignored, the key redacted', async () => {
  const s = await setup();
  const progress: string[] = [];
  const out = await s.svc.run({ id: 'claude_code', cfg: await runCfg(s), task: 'OK', model: '', maxTurns: 10, workspaceId: s.ws.id, folder: s.adaHome, actor: s.actor, onProgress: (l) => progress.push(l) });
  assert.equal(out.end, 'finished');
  assert.equal(out.result.costUsd, 0.0042);
  assert.ok(!JSON.stringify(out).includes(KEY), 'the key never reaches the result');
  assert.ok(!progress.join('\n').includes(KEY), 'nor the progress');
  assert.ok(progress.some((p) => p.includes('[redacted]')));
  assert.ok(progress.some((p) => p === 'Edit: notes.md'));
  const notes = await s.fs.read(s.ws.id, `${s.adaHome}/notes.md`);
  assert.equal(notes!.body.toString(), 'hello\nedited by the fake');
  assert.equal(notes!.meta!.version, 2);
  assert.deepEqual(notes!.meta!.updatedBy, { kind: 'agent', id: s.ada.id, name: 'Ada' });
  const created = await s.fs.read(s.ws.id, `${s.adaHome}/src/new.ts`);
  assert.equal(created!.meta!.updatedBy.kind, 'agent');
  assert.equal(await s.fs.read(s.ws.id, `${s.adaHome}/old.txt`), null);
  assert.ok((await s.fs.revisions(s.ws.id, `${s.adaHome}/old.txt`)).length > 0, 'the deleted body is kept');
  assert.equal(await s.fs.read(s.ws.id, `${s.adaHome}/hosts-link`), null, 'a symlink is never followed');
  assert.ok(out.sync!.skipped.some((x) => x.path.endsWith('hosts-link')));
  assert.ok(![...s.map.keys()].some((k) => k.endsWith('outside.txt')));
  assert.deepEqual(out.sync!.written.map((w) => [w.path, w.created]).sort(), [[`${s.adaHome}/notes.md`, false], [`${s.adaHome}/src/new.ts`, true]]);
});

test('a run in another agent\'s home: every write and delete is refused by WorkspaceFs, nothing changes', async () => {
  const s = await setup();
  const out = await s.svc.run({ id: 'claude_code', cfg: await runCfg(s), task: 'OK', model: '', maxTurns: 10, workspaceId: s.ws.id, folder: s.bobHome, actor: s.actor });
  assert.equal(out.sync!.written.length, 0);
  assert.ok(out.sync!.refused.some((r) => r.path === `${s.bobHome}/notes.md` && /another agent's home/.test(r.reason)));
  assert.equal((await s.fs.read(s.ws.id, `${s.bobHome}/notes.md`))!.body.toString(), 'bob');
});

test('the CLI sees a scrubbed environment: no server variables, only what it needs', async () => {
  const s = await setup();
  process.env.YAAM_SERVER_SECRET_FOR_TEST = 'leak';
  try {
    const out = await s.svc.run({ id: 'claude_code', cfg: await runCfg(s), task: 'ENV', model: '', maxTurns: 10, workspaceId: s.ws.id, folder: s.adaHome, actor: s.actor });
    const keys = out.result.finalText.split(',');
    assert.ok(!keys.includes('YAAM_SERVER_SECRET_FOR_TEST'));
    assert.ok(!keys.includes('DATABASE_URL'));
    assert.ok(keys.includes('ANTHROPIC_API_KEY') && keys.includes('CLAUDE_CONFIG_DIR') && keys.includes('HOME'));
  } finally { delete process.env.YAAM_SERVER_SECRET_FOR_TEST; }
});

test('timeout, max turns and the chat\'s Stop kill the CLI; a stop discards its changes', async () => {
  const s = await setup();
  const t0 = Date.now();
  const timed = await s.svc.run({ id: 'claude_code', cfg: await runCfg(s, { timeoutS: 1 }), task: 'SLEEP', model: '', maxTurns: 10, workspaceId: s.ws.id, folder: s.adaHome, actor: s.actor });
  assert.equal(timed.end, 'timeout');
  assert.ok(Date.now() - t0 < 8000);
  const turns = await s.svc.run({ id: 'claude_code', cfg: await runCfg(s), task: 'TURNS', model: '', maxTurns: 3, workspaceId: s.ws.id, folder: s.adaHome, actor: s.actor });
  assert.equal(turns.end, 'max_turns');
  const ctl = new AbortController();
  const stopped = await s.svc.run({
    id: 'claude_code', cfg: await runCfg(s), task: 'SLOW', model: '', maxTurns: 10, workspaceId: s.ws.id, folder: s.adaHome, actor: s.actor,
    signal: ctl.signal, onProgress: (l) => { if (l === 'working') ctl.abort(); },
  });
  assert.equal(stopped.end, 'stopped');
  assert.equal(stopped.sync, null);
  assert.equal((await s.fs.read(s.ws.id, `${s.adaHome}/notes.md`))!.body.toString(), 'hello', 'nothing synced after a stop');
});

test('the OS sandbox (Seatbelt on macOS, bubblewrap on Linux) jails the CLI\'s writes to its run dir', { skip: !osSandboxKind() && 'no OS sandbox on this machine' }, async () => {
  const s = await setup();
  s.svc.sandboxKind = osSandboxKind;
  const out = await s.svc.run({ id: 'claude_code', cfg: await runCfg(s, { osSandbox: true }), task: 'ESCAPE', model: '', maxTurns: 10, workspaceId: s.ws.id, folder: s.adaHome, actor: s.actor });
  assert.equal(out.result.finalText, 'blocked');
  assert.ok(out.sync!.written.some((w) => w.path.endsWith('inside.txt')), 'the run dir stays writable');
});

test('a cost cap stops a run whose reported spend passes it', async () => {
  const s = await setup();
  const out = await s.svc.run({ id: 'claude_code', cfg: await runCfg(s, { costCapUsd: 0.001 }), task: 'OK', model: '', maxTurns: 10, workspaceId: s.ws.id, folder: s.adaHome, actor: s.actor });
  assert.equal(out.end, 'cost_cap');
});

// ---- the tool in the turn loop ---------------------------------------------

class QueueProvider implements AiProvider {
  readonly name = 'queue';
  readonly requests: AiRequest[] = [];
  readonly queue: AiStreamEvent[][] = [];
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    const events = this.queue.shift() ?? [{ type: 'answer', text: 'ok' } as AiStreamEvent, { type: 'done' } as AiStreamEvent];
    for (const ev of events) yield ev;
  }
}

async function turnSetup() {
  const s = await setup();
  const provider = new QueueProvider();
  const repo = new ChatsRepository(s.db);
  const { stub } = memStorage();
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub, s.fs), ctxStub(provider), skillsStub(), stub, mcpStub(), s.agents, s.workspaces);
  const svc = new HarnessService(s.settings, s.fs, turns);
  svc.searchDirs = [s.binDir];
  svc.sandboxKind = () => null;
  svc.onModuleInit();
  return { ...s, provider, repo, turns, svc };
}

async function drive(t: Awaited<ReturnType<typeof turnSetup>>, sessionId: string, decide: 'allow-once' | 'deny' = 'deny', origin: 'user' | 'loop' | 'channel' = 'user') {
  const events: TurnEvent[] = [];
  for await (const ev of t.turns.run(sessionId, { text: 'build it', origin })) {
    events.push(ev);
    if (ev.type === 'approval_required') t.turns.resolveApproval(sessionId, ev.callId, decide);
  }
  return events;
}

test('code_agent: classed like run_js (internal_write, never free by registry), offered only to allowed agents with an enabled, detected harness', async () => {
  assert.equal(classOf(CODE_AGENT_TOOL), 'internal_write');
  assert.equal(runsFreely(CODE_AGENT_TOOL), false);
  assert.deepEqual((codeAgentSpec(['codex']).inputSchema as { properties: { harness: { enum: string[] } } }).properties.harness.enum, ['codex']);
  const t = await turnSetup();
  const session = await t.repo.createSession({ workspaceId: t.ws.id, agentId: t.ada.id, name: 'Build', permissionMode: 'ask' });
  assert.equal((await t.svc.specsFor(session)).length, 1);
  await t.svc.update('claude_code', { agents: [t.bob.id] });
  assert.equal((await t.svc.specsFor(session)).length, 0, 'not an allowed agent');
  await t.svc.update('claude_code', { agents: 'all', enabled: false });
  assert.equal((await t.svc.specsFor(session)).length, 0, 'disabled');
  const noAgent = await t.repo.createSession({ workspaceId: t.ws.id, name: 'Plain', permissionMode: 'ask' });
  await t.svc.update('claude_code', { enabled: true });
  assert.equal((await t.svc.specsFor(noAgent)).length, 0, 'durable agents only');
});

test('code_agent in Ask mode pauses for approval; a denial runs nothing', async () => {
  const t = await turnSetup();
  const session = await t.repo.createSession({ workspaceId: t.ws.id, agentId: t.ada.id, name: 'Build', permissionMode: 'ask' });
  t.provider.queue.push([{ type: 'tool_call', id: 'c1', name: CODE_AGENT_TOOL, input: { harness: 'claude_code', task: 'OK' } }, { type: 'done' }]);
  const events = await drive(t, session.id, 'deny');
  assert.ok(events.some((e) => e.type === 'approval_required'));
  const res = events.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }>;
  assert.equal(res.isError, true);
  assert.equal((await t.fs.read(t.ws.id, `${t.adaHome}/notes.md`))!.body.toString(), 'hello');
});

test('approved, it streams tool_progress and returns the summary and changed files; a loop turn queues it instead', async () => {
  const t = await turnSetup();
  const session = await t.repo.createSession({ workspaceId: t.ws.id, agentId: t.ada.id, name: 'Build', permissionMode: 'ask' });
  t.provider.queue.push([{ type: 'tool_call', id: 'c1', name: CODE_AGENT_TOOL, input: { harness: 'claude_code', task: 'OK' } }, { type: 'done' }]);
  const events = await drive(t, session.id, 'allow-once');
  const prog = events.filter((e) => e.type === 'tool_progress') as Array<Extract<TurnEvent, { type: 'tool_progress' }>>;
  assert.ok(prog.length >= 3 && prog.every((p) => p.id === 'c1'));
  const res = events.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }>;
  assert.equal(res.isError, false);
  const toolMsg = (t.provider.requests[1].messages.find((m) => m.role === 'tool'))!.content as string;
  assert.match(toolMsg, /Claude Code finished/);
  assert.match(toolMsg, new RegExp(`M /${t.adaHome}/notes.md \\(v2\\)`));
  assert.match(toolMsg, new RegExp(`A /${t.adaHome}/src/new.ts`));
  assert.ok(!toolMsg.includes(KEY));

  const loop = await t.repo.createSession({ workspaceId: t.ws.id, agentId: t.ada.id, name: 'Loop', permissionMode: 'auto' });
  t.provider.queue.push([{ type: 'tool_call', id: 'c2', name: CODE_AGENT_TOOL, input: { harness: 'claude_code', task: 'OK' } }, { type: 'done' }]);
  const lev = await drive(t, loop.id, 'deny', 'loop');
  const lres = lev.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }>;
  assert.match(lres.output, /Queued for the user's approval/);
});

test('the owner\'s opt-in: a chosen agent runs code_agent without approval — never from a channel turn', async () => {
  const t = await turnSetup();
  await t.svc.update('claude_code', { freeAgents: [t.ada.id] });
  const session = await t.repo.createSession({ workspaceId: t.ws.id, agentId: t.ada.id, name: 'Build', permissionMode: 'ask' });
  t.provider.queue.push([{ type: 'tool_call', id: 'c1', name: CODE_AGENT_TOOL, input: { harness: 'claude_code', task: 'OK' } }, { type: 'done' }]);
  const events = await drive(t, session.id, 'deny');
  assert.ok(!events.some((e) => e.type === 'approval_required'), 'no pause for an opted-in agent');
  assert.equal((events.find((e) => e.type === 'tool_result') as { isError: boolean }).isError, false);
  assert.equal(await t.svc.runsFreely(session, { id: 'x', name: CODE_AGENT_TOOL, input: { harness: 'claude_code' } }, 'channel'), false);
  assert.equal(await t.svc.runsFreely({ ...session, agentId: t.bob.id }, { id: 'x', name: CODE_AGENT_TOOL, input: { harness: 'claude_code' } }, 'user'), false);
});

test('code_agent refuses the workspace root and a bad model id before anything runs', async () => {
  const t = await turnSetup();
  const session = await t.repo.createSession({ workspaceId: t.ws.id, agentId: t.ada.id, name: 'Build', permissionMode: 'ask' });
  const root = async () => ({ workspaceId: t.ws.id, home: t.adaHome, actor: t.actor });
  await assert.rejects(t.svc.execute(session, CODE_AGENT_TOOL, { harness: 'claude_code', task: 'OK', folder: '/' }, { fileRoot: root }), /workspace root/);
  await assert.rejects(t.svc.execute(session, CODE_AGENT_TOOL, { harness: 'claude_code', task: 'OK', model: '--yolo' }, { fileRoot: root }), /model/);
  await assert.rejects(t.svc.execute(session, CODE_AGENT_TOOL, { harness: 'codex', task: 'OK' }, { fileRoot: root }), /not enabled/);
});
