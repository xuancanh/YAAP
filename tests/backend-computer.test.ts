/** Desktop computer control (docs/computer-control.md): pairing binds one
 *  companion with a hashed token, scopes only narrow, every computer tool is
 *  Ask-gated (never Auto, never remembered for the acting tools, refused
 *  outright from loop/channel turns), the work queue hands actions to the
 *  companion and settles results, every action leaves an audit row, and the
 *  three kill switches (pause, disconnect, env) all refuse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ComputerService, sha256Hex } from '../server/src/computer/computer.service';
import {
  isNarrowing, parseScopes, pathWithinRoot, scopeDenial, summarizeInput, REMEMBERABLE_COMPUTER_TOOLS,
} from '../server/src/computer/computer-scopes';
import { isCompanionRoute, TokenAuthStrategy } from '../server/src/common/token-auth.strategy';
import { computerActions, computerRunners } from '../server/src/database/schema';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService, TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { toAnthropicMessages } from '../server/src/ai/anthropic-ai.provider';
import { toOpenAiMessages } from '../server/src/ai/openai-ai.provider';
import { testDb, memStorage, ctxStub, skillsStub, agentsStub, mcpStub, ScriptedProvider, wsStub } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

const cfg = (enabled = true) => ({ get: (k: string) => (k === 'computerControlEnabled' ? enabled : undefined) }) as unknown as ConfigService;

async function setup(enabled = true) {
  const db = await testDb();
  const { stub, map } = memStorage();
  const svc = new ComputerService(db, cfg(enabled), stub);
  return { db, svc, stub, map };
}

/** Pair a companion the way the CLI does and return its credentials. */
async function paired(svc: ComputerService, scopes: string[] = ['screen', 'input', 'shell', '/Users/me/Projects'].map((s) => (s.startsWith('/') ? `files:${s}` : s))) {
  const { code } = svc.mintPairCode();
  const res = await svc.pair({ code, name: 'laptop', platform: 'darwin', scopes });
  const runner = await svc.authenticateCompanion(`Bearer ${res.token}`);
  return { ...res, runner };
}

/** A fake companion: answers every polled action with `handler`. */
function companion(svc: ComputerService, runner: Awaited<ReturnType<typeof paired>>['runner'], handler: (tool: string, input: Record<string, unknown>) => { ok: boolean; output?: string; pngBase64?: string; width?: number; height?: number }) {
  let running = true;
  const seen: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const loop = (async () => {
    while (running) {
      const item = await svc.nextWork(runner, 50);
      if (!item) continue;
      seen.push({ tool: item.tool, input: item.input });
      svc.submitResult(runner, item.id, handler(item.tool, item.input));
    }
  })();
  return { seen, stop: async () => { running = false; await loop; } };
}

async function collect(gen: AsyncGenerator<TurnEvent>, onEvent?: (ev: TurnEvent) => void): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const ev of gen) { events.push(ev); onEvent?.(ev); }
  return events;
}

const finalRound: AiStreamEvent[] = [{ type: 'answer', text: 'Done.' }, { type: 'done' }];
const callRound = (name: string, input: Record<string, unknown>, id = 'c1'): AiStreamEvent[] => [
  { type: 'tool_call', id, name, input }, { type: 'done' },
];

async function turnLoop(svc: ComputerService, rounds: AiStreamEvent[][]) {
  const repo = new ChatsRepository(await testDb());
  const { stub } = memStorage();
  const agents = agentsStub();
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(new ScriptedProvider(rounds)), skillsStub(), stub, mcpStub(), agents, wsStub(), undefined, undefined, undefined, undefined, undefined, svc);
  return { repo, turns, agents };
}

// ---- pairing ---------------------------------------------------------------

test('pairing: a 10-minute code binds exactly one companion; the token is stored only as sha256', async () => {
  const { svc, db } = await setup();
  let clock = 1_000_000;
  svc.now = () => clock;

  // no code minted yet
  await assert.rejects(svc.pair({ code: 'deadbeef', name: 'x', platform: 'darwin', scopes: ['screen'] }), UnauthorizedException);

  const { code, expiresInSeconds } = svc.mintPairCode();
  assert.equal(expiresInSeconds, 600);
  assert.match(code, /^[a-f0-9]{8}$/);

  // wrong code: refused; five wrong guesses burn the code
  for (let i = 0; i < 5; i++) {
    await assert.rejects(svc.pair({ code: '00000000', name: 'x', platform: 'darwin', scopes: ['screen'] }), /invalid pairing code/);
  }
  await assert.rejects(svc.pair({ code, name: 'x', platform: 'darwin', scopes: ['screen'] }), /no active pairing code/);

  // expiry
  const second = svc.mintPairCode();
  clock += 10 * 60_000 + 1;
  await assert.rejects(svc.pair({ code: second.code, name: 'x', platform: 'darwin', scopes: ['screen'] }), /no active pairing code/);

  // the real thing
  const third = svc.mintPairCode();
  const res = await svc.pair({ code: third.code, name: 'laptop', platform: 'darwin', scopes: ['screen', 'files:/Users/me/Projects/'] });
  assert.match(res.token, /^ycr_[a-f0-9]{64}$/);
  assert.deepEqual(res.scopes, ['screen', 'files:/Users/me/Projects']);
  const rows = await db.select().from(computerRunners);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenHash, sha256Hex(res.token));
  assert.ok(!JSON.stringify(rows[0]).includes(res.token), 'the raw token never touches the database');
  // the code is single-use
  await assert.rejects(svc.pair({ code: third.code, name: 'x', platform: 'darwin', scopes: ['screen'] }), UnauthorizedException);

  // companion auth: right token passes, wrong token / no token 401
  const runner = await svc.authenticateCompanion(`Bearer ${res.token}`);
  assert.equal(runner.name, 'laptop');
  await assert.rejects(svc.authenticateCompanion('Bearer ycr_' + '0'.repeat(64)), UnauthorizedException);
  await assert.rejects(svc.authenticateCompanion(undefined), UnauthorizedException);

  // pairing again replaces the one runner and revokes the old token
  const fourth = svc.mintPairCode();
  const res2 = await svc.pair({ code: fourth.code, name: 'desktop', platform: 'linux', scopes: ['shell'] });
  assert.equal((await db.select().from(computerRunners)).length, 1, 'exactly one companion at a time');
  await assert.rejects(svc.authenticateCompanion(`Bearer ${res.token}`), UnauthorizedException);
  assert.equal((await svc.authenticateCompanion(`Bearer ${res2.token}`)).name, 'desktop');
  const status = await svc.status();
  assert.equal(status.runner?.name, 'desktop');
  assert.equal(status.runner?.online, true);
});

test('pairing refuses bad scope sets: relative roots, whole-disk roots, unknown words, empty', async () => {
  const { svc } = await setup();
  for (const bad of [[], ['screen', 'camera'], ['files:relative/dir'], ['files:/'], ['files:C:\\'], 'screen']) {
    const { code } = svc.mintPairCode();
    await assert.rejects(svc.pair({ code, name: 'x', platform: 'darwin', scopes: bad }), /scope/);
  }
});

// ---- scopes -------------------------------------------------------------------

test('scopes: parsing canonicalises, narrowing is a subset check, widening is refused', async () => {
  assert.deepEqual(parseScopes(['screen', 'screen', 'files:/a/b/../c/']), ['screen', 'files:/a/c']);
  assert.deepEqual(parseScopes(['files:c:\\Users\\me\\Docs']), ['files:C:/Users/me/Docs']);
  assert.throws(() => parseScopes(['files:C:/']), /whole drive/);

  const current = ['screen', 'input', 'shell', 'files:/Users/me/Projects'];
  assert.equal(isNarrowing(current, ['screen']), true);
  assert.equal(isNarrowing(current, ['screen', 'files:/Users/me/Projects/one']), true, 'a root may shrink to a sub-directory');
  assert.equal(isNarrowing(current, ['screen', 'files:/Users/me']), false, 'a root may not grow');
  assert.equal(isNarrowing(['screen'], ['screen', 'shell']), false);
  assert.equal(isNarrowing(['screen'], ['input']), false);

  const { svc } = await setup();
  await paired(svc, ['screen', 'files:/Users/me/Projects']);
  await assert.rejects(svc.narrowScopes(['screen', 'shell']), /only be narrowed/);
  await assert.rejects(svc.narrowScopes(['screen', 'files:/Users/me']), /only be narrowed/);
  const after = await svc.narrowScopes(['files:/Users/me/Projects/site']);
  assert.deepEqual(after.runner?.scopes, ['files:/Users/me/Projects/site']);
  // and the tools follow the scopes: no screen scope → no screenshot tool
  const names = (await svc.specs()).map((s) => s.name);
  assert.deepEqual(names, ['computer_read_file', 'computer_write_file', 'computer_list_dir']);
  assert.match((await svc.specs())[0].description, /\/Users\/me\/Projects\/site/);
});

test('scopes: the server-side denial check covers every tool and blocks lexical escapes', () => {
  const scopes = ['screen', 'files:/Users/me/Projects'];
  assert.equal(scopeDenial(scopes, 'computer_screenshot', {}), null);
  assert.match(scopeDenial(scopes, 'computer_click', { x: 1, y: 1 })!, /input scope/);
  assert.match(scopeDenial(scopes, 'computer_shell', { command: 'ls' })!, /shell scope/);
  assert.equal(scopeDenial(scopes, 'computer_read_file', { path: '/Users/me/Projects/a.txt' }), null);
  assert.equal(scopeDenial(scopes, 'computer_list_dir', { path: '/Users/me/Projects' }), null);
  assert.match(scopeDenial(scopes, 'computer_read_file', { path: '/Users/me/Projects/../.ssh/id_rsa' })!, /outside/);
  assert.match(scopeDenial(scopes, 'computer_read_file', { path: '/Users/me/Projectsx/a' })!, /outside/, 'prefix without a separator is not inside');
  assert.match(scopeDenial(scopes, 'computer_write_file', { path: 'relative.txt', content: '' })!, /absolute/);
  assert.match(scopeDenial(['screen'], 'computer_read_file', { path: '/x' })!, /files:<dir> scope/);
  assert.match(scopeDenial(scopes, 'fs_read', {})!, /unknown computer tool/);
  assert.equal(pathWithinRoot('C:\\Users\\me\\Docs\\a.txt', 'c:/Users/me/Docs'), true);
  // summaries never carry typed text or file content
  assert.equal(summarizeInput('computer_type', { text: 'hunter2' }), 'type 7 chars');
  assert.equal(summarizeInput('computer_write_file', { path: '/p/x', content: 'secret' }), 'write /p/x (6 chars)');
  assert.equal(summarizeInput('computer_shell', { command: 'ls -la', cwd: '/tmp' }), '$ ls -la (in /tmp)');
});

// ---- the auth boundary ---------------------------------------------------------

test('only the companion routes are public to the app token; user routes under /api/computer are not', () => {
  assert.equal(isCompanionRoute('POST', '/api/computer/pair'), true);
  assert.equal(isCompanionRoute('GET', '/api/computer/work'), true);
  assert.equal(isCompanionRoute('POST', '/api/computer/heartbeat'), true);
  assert.equal(isCompanionRoute('POST', '/api/computer/result/0b2f1c8e-1111-4222-8333-444455556666'), true);
  assert.equal(isCompanionRoute('GET', '/api/computer/status'), false);
  assert.equal(isCompanionRoute('POST', '/api/computer/pair-code'), false);
  assert.equal(isCompanionRoute('POST', '/api/computer/disconnect'), false);
  assert.equal(isCompanionRoute('GET', '/api/computer/actions'), false);
  assert.equal(isCompanionRoute('POST', '/api/computer/result/../../chats'), false);
  const strategy = new TokenAuthStrategy({ get: () => 'secret' } as unknown as ConfigService);
  const req = (method: string, path: string) => ({ method, path, headers: {} }) as unknown as Parameters<TokenAuthStrategy['isPublic']>[0];
  assert.equal(strategy.isPublic(req('GET', '/api/computer/work')), true);
  assert.equal(strategy.isPublic(req('GET', '/api/computer/status')), false);
  assert.throws(() => strategy.authenticate(req('GET', '/api/computer/status')), UnauthorizedException);
});

// ---- tool classification through the turn loop ---------------------------------

test('every computer tool is mutation-class; the acting ones can never be remembered', async () => {
  const { svc } = await setup();
  await paired(svc);
  const names = (await svc.specs()).map((s) => s.name);
  assert.equal(names.length, 10);
  for (const n of names) {
    assert.equal(svc.owns(n), true);
    assert.equal(svc.isReadOnly(n), false, `${n} must never be read-only`);
  }
  assert.equal(svc.isReadOnly('fs_read'), undefined);
  for (const acting of ['computer_click', 'computer_type', 'computer_key', 'computer_shell', 'computer_write_file']) {
    assert.equal(REMEMBERABLE_COMPUTER_TOOLS.has(acting), false, `${acting} must ask on every call`);
  }
});

test('auto mode never applies: computer_click pauses for approval even in an Auto chat', async () => {
  const { svc } = await setup();
  const { runner } = await paired(svc);
  const comp = companion(svc, runner, () => ({ ok: true, output: 'clicked' }));
  try {
    const { repo, turns } = await turnLoop(svc, [callRound('computer_click', { x: 10, y: 20 }), finalRound]);
    const s = await repo.createSession({ workspaceId: 'ws1', agentId: 'ag1', name: 'c', permissionMode: 'auto' });
    let paused = 0;
    const events = await collect(turns.run(s.id, { text: 'click it' }), (ev) => {
      if (ev.type === 'approval_required') { paused++; assert.equal(ev.tool, 'computer_click'); turns.resolveApproval(s.id, ev.callId, 'allow-once'); }
    });
    assert.equal(paused, 1, 'Auto mode still paused');
    const result = events.find((e) => e.type === 'tool_result');
    assert.ok(result && !result.isError && result.output.includes('clicked'));
    assert.deepEqual(comp.seen, [{ tool: 'computer_click', input: { x: 10, y: 20, button: 'left', double: false } }]);
    // the live tab got its event
    const step = events.find((e) => e.type === 'computer');
    assert.ok(step && step.type === 'computer' && step.status === 'ok' && step.summary === 'click left at (10, 20)');
  } finally {
    await comp.stop();
  }
});

test('"always allow" on computer_shell is not remembered — the next call pauses again; computer_screenshot can be remembered', async () => {
  const { svc, map } = await setup();
  const { runner } = await paired(svc);
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const comp = companion(svc, runner, (tool) => (tool === 'computer_screenshot' ? { ok: true, pngBase64: png, width: 1, height: 1 } : { ok: true, output: 'ran' }));
  try {
    const rounds = [
      callRound('computer_shell', { command: 'ls' }, 'c1'), callRound('computer_shell', { command: 'ls' }, 'c2'),
      callRound('computer_screenshot', {}, 'c3'), callRound('computer_screenshot', {}, 'c4'), finalRound,
    ];
    const { repo, turns } = await turnLoop(svc, rounds);
    const s = await repo.createSession({ workspaceId: 'ws1', agentId: 'ag1', name: 'c', permissionMode: 'ask' });
    const pausedFor: string[] = [];
    const events = await collect(turns.run(s.id, { text: 'go' }), (ev) => {
      if (ev.type === 'approval_required') { pausedFor.push(ev.tool); turns.resolveApproval(s.id, ev.callId, 'allow-tool'); }
    });
    assert.deepEqual(pausedFor, ['computer_shell', 'computer_shell', 'computer_screenshot'], 'shell asked twice; the second screenshot was remembered');
    const session = (await repo.getSession(s.id))!;
    const approvals = JSON.parse(session.approvals) as { tools: string[] };
    assert.deepEqual(approvals.tools, ['computer_screenshot']);
    // screenshots landed in the workspace file store, numbered, and the events carry the path
    assert.ok(map.has(`workspaces/ws1/computer/${s.id}/1.png`));
    assert.ok(map.has(`workspaces/ws1/computer/${s.id}/2.png`));
    const shots = events.filter((e) => e.type === 'computer' && e.tool === 'computer_screenshot');
    assert.equal(shots.length, 2);
    assert.equal((shots[1] as { screenshotPath?: string }).screenshotPath, `computer/${s.id}/2.png`);
  } finally {
    await comp.stop();
  }
});

test('loop and channel turns: computer tools are refused outright with an inbox event — never queued, never paused', async () => {
  const { svc } = await setup();
  const { runner } = await paired(svc);
  const comp = companion(svc, runner, () => ({ ok: true, output: 'should not happen' }));
  try {
    for (const origin of ['loop', 'channel'] as const) {
      const { repo, turns, agents } = await turnLoop(svc, [callRound('computer_shell', { command: 'rm -rf /' }), finalRound]);
      const s = await repo.createSession({ workspaceId: 'ws1', agentId: 'ag1', name: 'c', permissionMode: 'auto' });
      const events = await collect(turns.run(s.id, { text: 'nightly', origin }));
      assert.equal(events.some((e) => e.type === 'approval_required'), false, `${origin}: no approval pause`);
      const result = events.find((e) => e.type === 'tool_result');
      assert.ok(result && result.isError && /Refused/.test(result.output), `${origin}: refused`);
      const ev = agents.calls.filter((c) => c.method === 'addEvent').map((c) => c.args[1] as { kind: string; title: string; body: string });
      assert.equal(ev.length, 1);
      assert.equal(ev[0].kind, 'info');
      assert.match(ev[0].title, new RegExp(`Computer action refused \\(${origin} turn\\): computer_shell`));
      assert.equal(ev[0].body, '$ rm -rf /');
    }
    assert.equal(comp.seen.length, 0, 'nothing reached the companion');
  } finally {
    await comp.stop();
  }
});

// ---- work queue and audit ------------------------------------------------------------

test('work queue: long-poll hands out the next action, the result settles the call, audit rows record it', async () => {
  const { svc, db } = await setup();
  const { runner } = await paired(svc);

  // nothing queued → null after the wait
  const t0 = Date.now();
  assert.equal(await svc.nextWork(runner, 30), null);
  assert.ok(Date.now() - t0 >= 25);

  const pending = svc.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_read_file', { path: '/Users/me/Projects/README.md' });
  const item = (await svc.nextWork(runner, 2_000))!;
  assert.equal(item.tool, 'computer_read_file');
  assert.deepEqual(item.input, { path: '/Users/me/Projects/README.md' });
  assert.equal(item.deadlineMs, 60_000);
  // the same action is not handed out twice
  assert.equal(await svc.nextWork(runner, 20), null);

  assert.deepEqual(svc.submitResult(runner, 'nope', { ok: true }), { accepted: false });
  assert.deepEqual(svc.submitResult(runner, item.id, { ok: true, output: '# hello' }), { accepted: true });
  assert.equal(await pending, '# hello');
  assert.deepEqual(svc.submitResult(runner, item.id, { ok: true }), { accepted: false }, 'a result settles once');

  const rows = await db.select().from(computerActions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].tool, 'computer_read_file');
  assert.equal(rows[0].sessionId, 's1');
  assert.equal(rows[0].runnerId, runner.id);
  assert.equal(rows[0].inputSummary, 'read /Users/me/Projects/README.md');
  assert.ok(rows[0].completedAt);

  // a failed action is an error to the model and an 'error' row
  const failing = svc.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_shell', { command: 'false', timeoutSec: 999 });
  const item2 = (await svc.nextWork(runner, 2_000))!;
  assert.equal(item2.deadlineMs, 300_000 + 15_000, 'shell timeout clamps to 300s plus grace');
  assert.deepEqual(item2.input, { command: 'false', cwd: '', timeoutSec: 300 });
  svc.submitResult(runner, item2.id, { ok: false, output: 'exit 1' });
  await assert.rejects(failing, /exit 1/);
  const list = await svc.actions(50);
  assert.equal(list[0].status, 'error');
  assert.equal(list[0].inputSummary, '$ false');
});

test('work queue: a silent companion turns into a timeout error and a timeout audit row', async () => {
  const { svc, db } = await setup();
  const { runner } = await paired(svc);
  svc.deadlines.default = 40;
  const pending = svc.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_move', { x: 1, y: 2 });
  const item = (await svc.nextWork(runner, 500))!;
  await assert.rejects(pending, /did not answer within/);
  assert.deepEqual(svc.submitResult(runner, item.id, { ok: true }), { accepted: false }, 'a late result is ignored');
  const rows = await db.select().from(computerActions);
  assert.equal(rows[0].status, 'timeout');
});

test('execute refuses before queueing: out of scope, offline companion, bad arguments — each with a refused audit row', async () => {
  const { svc, db } = await setup();
  const { runner } = await paired(svc, ['screen', 'files:/Users/me/Projects']);
  await assert.rejects(svc.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_shell', { command: 'ls' }), /out of scope/);
  await assert.rejects(svc.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_read_file', { path: '/etc/passwd' }), /outside the allowed roots/);
  await assert.rejects(svc.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_click', { x: 'a', y: 1 }), /out of scope/);
  await assert.rejects(svc.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_write_file', { path: '/Users/me/Projects/x', content: 42 }), /must be a string/);
  const rows = await db.select().from(computerActions);
  assert.equal(rows.filter((r) => r.status === 'refused').length, 3, 'scope refusals are audited');
  // offline: last seen too long ago → fail fast, not a 60s wait
  svc.now = () => Date.now() + 10 * 60_000;
  await assert.rejects(svc.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_screenshot', {}), /not connected/);
  assert.equal(runner.name, 'laptop');
});

// ---- kill switches ----------------------------------------------------------------

test('pause keeps the pairing but hides the tools and refuses actions; resume restores', async () => {
  const { svc, db } = await setup();
  const { token } = await paired(svc);
  await svc.pause();
  assert.deepEqual(await svc.specs(), []);
  assert.equal((await svc.status()).runner?.paused, true);
  await assert.rejects(svc.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_screenshot', {}), /paused/);
  assert.equal((await db.select().from(computerActions))[0].status, 'refused');
  // the companion still authenticates (so it learns it is paused)
  const runner = await svc.authenticateCompanion(`Bearer ${token}`);
  assert.equal((await svc.heartbeat(runner)).paused, true);
  await svc.resume();
  assert.equal((await svc.specs()).length, 10);
});

test('disconnect revokes the token at once and refuses queued and in-flight actions', async () => {
  const { svc, db } = await setup();
  const { token, runner } = await paired(svc);
  const inflight = svc.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_shell', { command: 'sleep 5' });
  const item = (await svc.nextWork(runner, 1_000))!;
  const queued = svc.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_move', { x: 1, y: 1 });
  await new Promise((r) => setTimeout(r, 10));

  const status = await svc.disconnect();
  assert.equal(status.runner, null);
  await assert.rejects(inflight, /refused: the companion was disconnected/);
  await assert.rejects(queued, /refused/);
  assert.deepEqual(svc.submitResult(runner, item.id, { ok: true, output: 'late' }), { accepted: false });
  await assert.rejects(svc.authenticateCompanion(`Bearer ${token}`), UnauthorizedException);
  assert.deepEqual(await svc.specs(), []);
  const rows = await db.select().from(computerActions);
  assert.deepEqual(rows.map((r) => r.status).sort(), ['refused', 'refused']);
});

test('COMPUTER_CONTROL_ENABLED=false hides the tools and refuses pairing and companion traffic', async () => {
  const live = await setup(true);
  const { token } = await paired(live.svc);
  // flip the switch on the same database: the paired runner is still there
  const off = new ComputerService(live.db, cfg(false), live.stub);
  assert.deepEqual(await off.specs(), []);
  assert.equal((await off.status()).enabled, false);
  assert.throws(() => off.mintPairCode(), /disabled/);
  await assert.rejects(off.authenticateCompanion(`Bearer ${token}`), UnauthorizedException);
  await assert.rejects(off.execute({ id: 's1', workspaceId: 'ws1' }, 'computer_screenshot', {}), /disabled/);
});

// ---- the screenshot reaches the model as an image ------------------------------------

test('a screenshot rides on the tool result as an image for both provider families', () => {
  const history = [
    { role: 'user' as const, content: 'look' },
    { role: 'assistant' as const, content: '', toolCalls: [{ id: 't1', name: 'computer_screenshot', input: {} }] },
    { role: 'tool' as const, content: 'Screenshot taken', toolCallId: 't1', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] },
  ];
  const anth = toAnthropicMessages(history);
  const toolMsg = anth[2];
  assert.equal(toolMsg.role, 'user');
  const block = (toolMsg.content as Array<{ type: string; content?: unknown }>)[0];
  assert.equal(block.type, 'tool_result');
  const inner = block.content as Array<{ type: string }>;
  assert.deepEqual(inner.map((b) => b.type), ['text', 'image']);

  const oai = toOpenAiMessages(undefined, history);
  assert.equal(oai[2].role, 'tool');
  const follow = oai[3] as { role: string; content: Array<{ type: string }> };
  assert.equal(follow.role, 'user');
  assert.deepEqual(follow.content.map((p) => p.type), ['text', 'image_url']);
});
