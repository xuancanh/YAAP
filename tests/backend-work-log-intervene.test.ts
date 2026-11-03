/** Intervening in a work session (docs/work-log.md "Intervening"): a person's
 *  turn in a work session keeps it work, runs with origin user (Ask-mode
 *  approvals apply) and is labelled theirs; the live watch of a turn another
 *  caller started; stop and approve keep to sessions the caller may open;
 *  viewers read only; and Rerun for each trigger kind, with its guard. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import type { ConfigService } from '@nestjs/config';
import * as schema from '../server/src/database/schema';
import { agentTasks, chatTurns } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpWriterStub, ScriptedProvider } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { ChatsController } from '../server/src/chats/chats.controller';
import { TurnLoopService, type TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { WorkLogService } from '../server/src/chats/work-log.service';
import { WorkLogController } from '../server/src/chats/work-log.controller';
import { WorkRerunService } from '../server/src/chats/work-rerun.service';
import { OrgRerunBridge } from '../server/src/org/org-rerun.bridge';
import { LoopsService } from '../server/src/chats/loops.service';
import { HeartbeatService } from '../server/src/chats/heartbeat.service';
import { DistillService } from '../server/src/chats/distill.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { turnWatch, TurnWatchRegistry } from '../server/src/chats/live-turns';
import { runWithViewer, currentAccountId, type Viewer } from '../server/src/accounts/account-context';
import { checkRole } from '../server/src/shared/workspace-access.guard';
import type { StorageService } from '../server/src/storage/storage.service';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

const answer = (text: string): AiStreamEvent[] => [{ type: 'answer', text }, { type: 'done' }];
const write: AiStreamEvent[] = [{ type: 'thinking', text: 'Save it.' }, { type: 'tool_call', id: 'c1', name: 'mcp_notes_write', input: { path: 'notes.md', content: 'hi' } }, { type: 'done' }];

/** A provider whose rounds can be held open until released. */
class GatedProvider extends ScriptedProvider {
  gate: Promise<void> | null = null;
  release: () => void = () => {};
  hold() { this.gate = new Promise((r) => { this.release = () => { this.gate = null; r(); }; }); }
  override async *stream(req: Parameters<ScriptedProvider['stream']>[0]): AsyncGenerator<AiStreamEvent> {
    for await (const ev of super.stream(req)) {
      yield ev;
      if (this.gate && ev.type === 'thinking') await this.gate;
    }
  }
}

async function setup(rounds: AiStreamEvent[][] = []) {
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const chats = new ChatsService(repo, agents);
  const provider = new GatedProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpWriterStub(stub), agents, workspaces);
  const log = new WorkLogService(db, agents);
  const config = { get: () => undefined } as unknown as ConfigService;
  const distill = new DistillService(repo, ctxStub(provider), agents, new AgentMemoryService(db, stub as unknown as StorageService));
  const loops = new LoopsService(agents, workspaces, repo, turns, distill, config);
  const heartbeat = new HeartbeatService(db, agents, workspaces, loops, config);
  const reruns = new WorkRerunService(log, chats, repo, turns, heartbeat, loops, agents);
  const ctl = new ChatsController(chats, turns, { maybeAutoCompact: async () => false } as never, {} as never);
  const wl = new WorkLogController(log, reruns);
  const ws = (await workspaces.list())[0];
  const agent = await agents.create({ name: 'Jong', workspaceId: ws.id, loops: [{ name: 'digest', cron: '0 9 * * 1' }] });
  const work = (name: string, extra: Partial<typeof schema.chatSessions.$inferInsert> = {}) =>
    repo.createSession({ workspaceId: ws.id, agentId: agent.id, name, kind: 'work', permissionMode: 'auto', ...extra });
  return { db, repo, chats, agents, turns, log, loops, heartbeat, reruns, ctl, wl, ws, agent, provider, work };
}
type S = Awaited<ReturnType<typeof setup>>;

/** A stand-in for the Express response the SSE routes write to. */
function fakeRes() {
  const em = new EventEmitter();
  const events: Array<Record<string, unknown>> = [];
  let ended = false;
  const done = new Promise<void>((r) => em.once('ended', r));
  const res = {
    get writableEnded() { return ended; },
    writeHead() { return res; },
    write(chunk: string) {
      for (const line of chunk.split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      return true;
    },
    end() { if (!ended) { ended = true; em.emit('ended'); } },
    on(ev: string, fn: () => void) { em.on(ev, fn); return res; },
    close() { em.emit('close'); },
  };
  return { res, events, done };
}

async function drain(gen: AsyncGenerator<TurnEvent>, on?: (ev: TurnEvent) => void): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of gen) { out.push(ev); on?.(ev); }
  return out;
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};

test('a person messaging a work session: the session stays work, the turn is origin user from the person, and the Work log labels it', async () => {
  const s = await setup([answer('On it.')]);
  const beat = await s.work('Loop · heartbeat');
  const { res, done } = fakeRes();
  await s.ctl.sendTurn(beat.id, { text: 'Skip the vendor email today' }, res as never);
  await done;
  assert.equal((await s.repo.getSession(beat.id))!.kind, 'work', 'still a work session');
  const [turn] = await s.repo.listTurns(beat.id);
  assert.equal(turn.source, 'person');
  const page = await s.wl.list(s.agent.id);
  assert.equal(page.runs[0].source, 'person');
  assert.equal(page.runs[0].by, '', "the owner's message");
  assert.equal(page.runs[0].trigger, 'heartbeat', 'still in its trigger group');
  // a loop's own turn is labelled by its origin
  await drain(s.turns.run(beat.id, { text: 'Heartbeat: check the board', origin: 'loop' }));
  assert.equal((await s.wl.list(s.agent.id)).runs[0].source, 'loop');
});

test('Ask-mode approvals apply to a person\'s turn in a work session, and approve/stop answer for that session', async () => {
  const s = await setup([write, answer('Saved.')]);
  const run = await s.work('Org · Acme · Planning', { permissionMode: 'ask' });
  const { res, events, done } = fakeRes();
  const sending = s.ctl.sendTurn(run.id, { text: 'write the note' }, res as never);
  await until(() => events.some((e) => e.type === 'approval_required'));
  const pending = events.find((e) => e.type === 'approval_required')!;
  assert.equal(pending.tool, 'mcp_notes_write');
  assert.deepEqual(await s.ctl.approve(run.id, { callId: String(pending.callId), decision: 'allow-once' }), { resolved: true });
  await sending; await done;
  assert.ok(events.some((e) => e.type === 'tool_result' && e.isError === false));
  const [turn] = await s.repo.listTurns(run.id);
  assert.equal(JSON.parse(turn.toolCalls)[0].approved, 'allow-once');
  assert.deepEqual(await s.ctl.stop(run.id), { stopped: false }, 'nothing running now');
});

test('the live watch: a turn the watcher did not start replays its thinking and pending approval, then streams to the end', async () => {
  const s = await setup([write, answer('Saved.')]);
  const beat = await s.work('Loop · heartbeat', { permissionMode: 'ask' });
  // idle: nothing runs
  const idle = fakeRes();
  await s.ctl.live(beat.id, idle.res as never);
  assert.deepEqual(idle.events, [{ type: 'idle', busy: false }]);
  // a background turn (origin user so Ask applies) pauses on its approval
  let callId = '';
  const bg = drain(s.turns.run(beat.id, { text: 'Heartbeat', origin: 'user' }), (ev) => { if (ev.type === 'approval_required') callId = ev.callId; });
  await until(() => callId !== '');
  const w = fakeRes();
  await s.ctl.live(beat.id, w.res as never);
  assert.equal(w.events[0].type, 'live');
  assert.equal(w.events[0].source, 'user');
  assert.ok(w.events.some((e) => e.type === 'thinking' && e.text === 'Save it.'), 'thinking replayed');
  assert.ok(w.events.some((e) => e.type === 'approval_required' && e.callId === callId), 'the pending approval replayed');
  // approve from the watcher: the run goes on, the watch streams the rest and ends
  assert.equal((await s.ctl.approve(beat.id, { callId, decision: 'allow-once' })).resolved, true);
  await bg; await w.done;
  assert.ok(w.events.some((e) => e.type === 'tool_result'));
  assert.ok(w.events.some((e) => e.type === 'answer' && e.text === 'Saved.'));
  assert.equal(w.events.at(-1)!.type, 'end');
  assert.equal(turnWatch.running(beat.id), null);
});

test('the watch registry merges token deltas, keeps the cap, and a refused turn never ends another turn\'s watch', async () => {
  const r = new TurnWatchRegistry();
  r.begin('s1', 't1', 'loop');
  r.publish('s1', { type: 'thinking', text: 'a' });
  r.publish('s1', { type: 'thinking', text: 'b' });
  r.publish('s1', { type: 'usage', inputTokens: 1 });
  r.publish('s1', { type: 'answer', text: 'c' });
  const seen: string[] = [];
  const sub = r.watch('s1', (ev) => seen.push(ev.type))!;
  assert.deepEqual(sub.start.replay, [{ type: 'thinking', text: 'ab' }, { type: 'answer', text: 'c' }]);
  for (let i = 0; i < 2000; i++) r.publish('s1', { type: 'tool_call', id: `c${i}` });
  assert.ok(r.watch('s1', () => {})!.start.replay.length <= 1500);
  r.end('s1');
  assert.equal(seen.at(-1), 'end');
  assert.equal(r.watch('s1', () => {}), null);

  const s = await setup([write, answer('ok')]);
  const sess = await s.work('Loop · heartbeat', { permissionMode: 'ask' });
  let callId = '';
  const bg = drain(s.turns.run(sess.id, { text: 'one', origin: 'user' }), (ev) => { if (ev.type === 'approval_required') callId = ev.callId; });
  await until(() => callId !== '');
  await assert.rejects(drain(s.turns.run(sess.id, { text: 'two' })), /busy/);
  assert.ok(turnWatch.running(sess.id), 'the first turn is still watched');
  s.turns.resolveApproval(sess.id, callId, 'deny');
  await bg;
});

test('access: a member cannot watch, stop, approve or rerun a private run of the owner; viewers are read-only', async () => {
  const s = await setup([answer('x')]);
  const beat = await s.work('Loop · heartbeat');
  await drain(s.turns.run(beat.id, { text: 'Heartbeat', origin: 'loop' }));
  await s.db.update(chatTurns).set({ status: 'error', error: 'provider 400' }).where(eq(chatTurns.sessionId, beat.id));
  const [turn] = await s.repo.listTurns(beat.id);
  const member: Viewer = { memberAccountId: 'member-1', role: 'member' };
  const as = <T,>(fn: () => Promise<T>) => runWithViewer(currentAccountId(), member, fn);
  await assert.rejects(as(() => s.ctl.stop(beat.id)), /chat/);
  await assert.rejects(as(() => s.ctl.approve(beat.id, { callId: 'c', decision: 'deny' })), /chat/);
  await assert.rejects(as(() => s.ctl.live(beat.id, fakeRes().res as never)), /chat/);
  await assert.rejects(as(() => s.wl.rerun(s.agent.id, turn.id)), /run/);
  // shared, the member may
  await s.repo.updateSession(beat.id, { shared: 1 });
  assert.deepEqual(await as(() => s.ctl.stop(beat.id)), { stopped: false });
  // viewers: GET only — the live watch reads, every intervention is a POST
  const viewer = (method: string, path: string) => () => checkRole('viewer', method, path);
  assert.doesNotThrow(viewer('GET', `/api/chats/${beat.id}/live`));
  assert.doesNotThrow(viewer('GET', `/api/agents/${s.agent.id}/work-log/runs/${turn.id}`));
  for (const path of [`/api/chats/${beat.id}/turns`, `/api/chats/${beat.id}/stop`, `/api/chats/${beat.id}/approve`, `/api/agents/${s.agent.id}/work-log/runs/${turn.id}/rerun`]) {
    assert.throws(viewer('POST', path), /read-only/, path);
    assert.doesNotThrow(() => checkRole('member', 'POST', path), `a member may ${path}`);
  }
});

async function failed(s: S, sessionId: string, text: string, origin: 'loop' | 'user' = 'loop', status: 'error' | 'stopped' = 'error') {
  await drain(s.turns.run(sessionId, { text, origin }));
  const turns = await s.repo.listTurns(sessionId);
  const t = turns.at(-1)!;
  await s.db.update(chatTurns).set({ status, error: status === 'error' ? 'Tool names must be unique' : null }).where(eq(chatTurns.id, t.id));
  return t;
}

test('rerun: only failed or stopped runs; the default re-sends the input in the same session with the same origin, linked as a rerun', async () => {
  const s = await setup([answer('first'), answer('again'), answer('third')]);
  const chan = await s.work('#general · Jong', { tags: '["channel"]' });
  const done = (await s.repo.listTurns(chan.id)).length;
  assert.equal(done, 0);
  await drain(s.turns.run(chan.id, { text: '@Jong look at the numbers', origin: 'user' }));
  const ok = (await s.repo.listTurns(chan.id))[0];
  await assert.rejects(s.wl.rerun(s.agent.id, ok.id), /only a failed or stopped run/);
  await s.db.update(chatTurns).set({ status: 'stopped' }).where(eq(chatTurns.id, ok.id));
  const res = await s.wl.rerun(s.agent.id, ok.id);
  assert.equal(res.started, true);
  assert.equal(res.sessionId, chan.id);
  assert.ok(res.turnId);
  await until(() => !s.turns.isBusy(chan.id) && !s.reruns.isRerunning(chan.id));
  const again = (await s.repo.getTurn(res.turnId!))!;
  assert.equal(again.input, '@Jong look at the numbers');
  assert.equal(again.sessionId, chan.id);
  assert.equal(again.rerunOf, ok.id);
  assert.equal(again.source, 'user', 'the same origin');
  const run = (await s.wl.list(s.agent.id)).runs.find((r) => r.id === again.id)!;
  assert.equal(run.rerunOf, ok.id);
  assert.equal(run.trigger, 'channel');
});

test('rerun: a meeting round re-runs its prompt as a loop turn; one rerun at a time per session; a running session is refused', async () => {
  const s = await setup([answer('round'), answer('again'), answer('later')]);
  const chan = await s.work('#eng · Jong', { tags: '["channel"]' });
  const t = await failed(s, chan.id, 'Round 1 of 3: your one turn. Speak to the item');
  s.provider.hold();
  // the provider holds the rerun's round open after its first thinking event, so script one
  ;(s.provider as unknown as { rounds: AiStreamEvent[][] }).rounds[1] = [{ type: 'thinking', text: 'hm' }, { type: 'answer', text: 'again' }, { type: 'done' }];
  const res = await s.wl.rerun(s.agent.id, t.id);
  assert.equal(res.started, true);
  await assert.rejects(s.wl.rerun(s.agent.id, t.id), /already running/, 'a double click');
  s.provider.release();
  await until(() => !s.turns.isBusy(chan.id) && !s.reruns.isRerunning(chan.id));
  const again = (await s.repo.getTurn(res.turnId!))!;
  assert.equal(again.source, 'loop');
  assert.equal((await s.wl.list(s.agent.id)).runs.find((r) => r.id === again.id)!.trigger, 'meeting');
  // a session mid-turn is refused
  s.provider.hold();
  ;(s.provider as unknown as { rounds: AiStreamEvent[][] }).rounds[2] = [{ type: 'thinking', text: 'busy' }, { type: 'answer', text: 'later' }, { type: 'done' }];
  const bg = drain(s.turns.run(chan.id, { text: 'someone else', origin: 'loop' }));
  await until(() => s.turns.isBusy(chan.id));
  await assert.rejects(s.wl.rerun(s.agent.id, t.id), /running a turn now/);
  s.provider.release();
  await bg;
});

test('rerun: a loop fires the loop now (its own prompt, its session); a vanished loop is a 404', async () => {
  const s = await setup([answer('digest v1'), answer('digest v2')]);
  await s.loops.runLoop(s.agent.id, s.agent.name, { name: 'digest', cron: '0 9 * * 1' });
  const loopSession = (await s.repo.listSessions(s.ws.id)).find((x) => x.name === 'Loop · digest')!;
  const [t] = await s.repo.listTurns(loopSession.id);
  await s.db.update(chatTurns).set({ status: 'error', error: 'outage' }).where(eq(chatTurns.id, t.id));
  const res = await s.wl.rerun(s.agent.id, t.id);
  assert.equal(res.started, true);
  await until(() => !s.reruns.isRerunning(loopSession.id));
  const turns = await s.repo.listTurns(loopSession.id);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].rerunOf, t.id);
  assert.match(turns[1].input, /Scheduled loop firing: "digest"/);
  // the loop is gone: nothing runs
  await s.agents.update(s.agent.id, { loops: '[]' });
  await s.db.update(chatTurns).set({ status: 'error' }).where(eq(chatTurns.id, turns[1].id));
  const gone = await s.wl.rerun(s.agent.id, turns[1].id);
  assert.equal(gone.started, false);
  assert.match(gone.error ?? '', /no longer exists/);
});

test('rerun: the heartbeat beats now through its gate, in its session', async () => {
  const s = await setup([answer('beat 1'), answer('beat 2')]);
  const task = await s.agents.addTask(s.agent.id, { title: 'Reply to the vendor' });
  await s.db.update(agentTasks).set({ updatedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }).where(eq(agentTasks.id, task.id));
  await s.heartbeat.beat(s.agent.id, new Date(), { force: true });
  const beatSession = (await s.repo.listSessions(s.ws.id)).find((x) => x.name === 'Loop · heartbeat')!;
  const [t] = await s.repo.listTurns(beatSession.id);
  assert.ok(t, 'the first beat ran');
  await s.db.update(chatTurns).set({ status: 'error', error: 'Tool names must be unique' }).where(eq(chatTurns.id, t.id));
  const res = await s.wl.rerun(s.agent.id, t.id);
  await until(() => !s.reruns.isRerunning(beatSession.id));
  if (res.started) {
    const turns = await s.repo.listTurns(beatSession.id);
    assert.equal(turns.at(-1)!.rerunOf, t.id);
    assert.match(turns.at(-1)!.input, /Reply to the vendor/, 'a fresh beat prompt from the reasons');
  } else {
    // the gate refused (quiet hours on the test clock, the daily cap): it says why
    assert.ok(['quiet', 'cap', 'spend_stop', 'loops_off'].includes(res.status), res.status);
  }
});

test('rerun: an org task run is re-dispatched by the registered handler, never replayed', async () => {
  const s = await setup([answer('task run')]);
  await s.db.insert(schema.organizations).values({ id: 'o1', workspaceId: s.ws.id, name: 'Acme', createdAt: '2026-10-01T00:00:00.000Z' });
  await s.db.insert(schema.orgTasks).values({ id: 'task-1', orgId: 'o1', key: 'ENG-12', title: 'Close the books', status: 'in_progress', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
  const org = await s.work('Org · Acme · Close the books', { taskKind: 'org', taskId: 'task-1' });
  const t = await failed(s, org.id, 'Work on ENG-12');
  const calls: Array<{ taskId: string; sessionId: string; orgId: string; reason: string }> = [];
  // the real bridge, over a runtime that runs the task's own wake prompt in the task session
  const runtime = {
    runTask: async (orgId: string, taskId: string, agentId: string, reason: string) => {
      calls.push({ taskId, sessionId: org.id, orgId, reason });
      assert.equal(agentId, s.agent.id);
      await drain(s.turns.run(org.id, { text: 'You were woken (manual) for ENG-12', origin: 'loop' }));
      return 'ran';
    },
  };
  new OrgRerunBridge(s.db, s.reruns, runtime as never).onModuleInit();
  const res = await s.wl.rerun(s.agent.id, t.id);
  await until(() => !s.reruns.isRerunning(org.id));
  assert.deepEqual(calls, [{ taskId: 'task-1', sessionId: org.id, orgId: 'o1', reason: 'manual' }]);
  assert.equal(res.started, true);
  const turns = await s.repo.listTurns(org.id);
  assert.equal(turns.at(-1)!.rerunOf, t.id);
  assert.match(turns.at(-1)!.input, /woken \(manual\)/, 'the runtime\'s prompt, not the old one');
});
