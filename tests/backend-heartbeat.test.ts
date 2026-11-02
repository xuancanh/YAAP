/** The gated heartbeat (docs/company-vision.md §13, docs/triggers.md
 *  "Heartbeat"): the builtin loop on every agent, the model-free gate, the
 *  reasons that open it, quiet hours, the daily cap, pause, bounds, and the
 *  operating profile reaching the prompt. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { runPgMigrations } from '../server/src/database/migrator';
import { agentTasks, channels, channelMembers, channelMessages, heartbeatState } from '../server/src/database/schema';
import { LoopsService } from '../server/src/chats/loops.service';
import { HeartbeatService, heartbeatPrompt, nextCronMatch } from '../server/src/chats/heartbeat.service';
import { DistillService } from '../server/src/chats/distill.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { StorageService } from '../server/src/storage/storage.service';
import type { LoopDef } from '../server/src/chats/loop-def';
import { DEFAULT_HEARTBEAT_CRON, HEARTBEAT_BOUNDS, cronIntervalMinutes, effectiveHeartbeat } from '../server/src/chats/heartbeat-config';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, pgliteQueryable, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const round: AiStreamEvent[] = [{ type: 'answer', text: 'Checked the items; nothing more to do.' }, { type: 'done' }];
const NOON = new Date(Date.UTC(2026, 6, 16, 12, 0)); // a Thursday

async function setup(rounds: AiStreamEvent[][] = [round, round, round, round]) {
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: () => undefined } as unknown as ConfigService;
  const distill = new DistillService(repo, ctxStub(provider), agents, new AgentMemoryService(db, stub as unknown as StorageService));
  const loops = new LoopsService(agents, workspaces, repo, turns, distill, config);
  const heartbeat = new HeartbeatService(db, agents, workspaces, loops, config);
  const ws = (await workspaces.list())[0];
  return { db, agents, workspaces, repo, turns, loops, heartbeat, provider, ws };
}

/** A stale open task: the board says todo, last touched an hour ago. */
async function staleTask(s: Awaited<ReturnType<typeof setup>>, agentId: string, title = 'Reply to the vendor') {
  const task = await s.agents.addTask(agentId, { title });
  await s.db.update(agentTasks).set({ updatedAt: new Date(NOON.getTime() - 60 * 60_000).toISOString() }).where(eq(agentTasks.id, task.id));
  return task;
}

test('every agent is born with its heartbeat on: create and import leave it enabled on the workspace cadence; loops are untouched', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Atlas', loops: [{ name: 'Nightly', cron: '0 2 * * *' }] });
  assert.equal(a.heartbeatEnabled, 1);
  assert.equal(a.heartbeatCron, '', 'no agent override: the workspace default applies');
  assert.equal(a.heartbeatDailyRunCap, null);
  const view = await s.heartbeat.view(a.id, NOON);
  assert.equal(view.enabled, true);
  assert.equal(view.cron, DEFAULT_HEARTBEAT_CRON);
  assert.equal(view.dailyRunCap, 12);
  assert.equal(view.staleMinutes, 30);
  assert.equal(view.nextDueAt, new Date(Date.UTC(2026, 6, 16, 12, 30)).toISOString());
  // The heartbeat is not a loops entry: the editor's list and cap are untouched.
  assert.deepEqual(JSON.parse(a.loops) as LoopDef[], [{ name: 'Nightly', cron: '0 2 * * *' }]);
  const imported = await s.agents.importJson({ name: 'Imported', loops: [{ name: 'Weekly', cron: '0 9 * * 1' }] });
  assert.equal(imported.heartbeatEnabled, 1);
  assert.equal((await s.heartbeat.view(imported.id, NOON)).enabled, true);
});

test('migration 0034 gives existing agents a heartbeat through column defaults, creates heartbeat_state, and is idempotent', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  // An agent row written the old way (no heartbeat columns named) reads as enabled, on the workspace cadence.
  await q.query(`INSERT INTO agents ("id", "name", "loops", "createdAt") VALUES ('old1', 'Old', '[{"name":"Nightly","cron":"0 2 * * *"}]', '2026-01-01T00:00:00Z')`);
  const row = (await q.query(`SELECT "heartbeatEnabled", "heartbeatCron", "heartbeatDailyRunCap", "heartbeatStaleMinutes", "loops" FROM agents WHERE "id" = 'old1'`)).rows[0] as Record<string, unknown>;
  assert.equal(row.heartbeatEnabled, 1);
  assert.equal(row.heartbeatCron, '');
  assert.equal(row.heartbeatDailyRunCap, null);
  assert.equal(row.heartbeatStaleMinutes, null);
  assert.equal(row.loops, '[{"name":"Nightly","cron":"0 2 * * *"}]', 'loops JSON untouched');
  const tables = (await q.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('heartbeat_state')`)).rows;
  assert.equal(tables.length, 1);
  const col = (await q.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'heartbeatDefaults'`)).rows;
  assert.equal(col.length, 1);
  await runPgMigrations(q, { log: () => {} }); // twice: a no-op
  assert.equal((await q.query(`SELECT "id" FROM __migrations WHERE "id" = '0034-heartbeat-connection-cards'`)).rows.length, 1);
  await pg.close();
});

test('an empty gate makes no model call and writes the state row', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Quiet' });
  const res = await s.heartbeat.beat(a.id, NOON);
  assert.equal(res.status, 'empty');
  assert.equal(res.ran, false);
  assert.deepEqual(res.reasons, []);
  assert.equal(s.provider.requests.length, 0, 'no model call');
  const state = (await s.db.select().from(heartbeatState).where(eq(heartbeatState.agentId, a.id)))[0];
  assert.ok(state);
  assert.equal(state.lastBeatAt, NOON.toISOString());
  assert.equal(state.lastReason, 'empty');
  assert.equal(state.nextDueAt, new Date(Date.UTC(2026, 6, 16, 12, 30)).toISOString());
  assert.equal(state.beatsSkipped, 1);
  // The cron tick never fires the gated loop itself.
  await s.loops.tick(new Date(2026, 6, 16, 12, 30));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.provider.requests.length, 0);
  const view = await s.heartbeat.view(a.id, NOON);
  assert.equal(view.enabled, true);
  assert.equal(view.runsToday, 0);
  assert.equal(view.lastReason, 'empty');
});

test('a stale open task opens the gate: one real turn with the reason and the charter in the prompt', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Worker', charter: 'You keep vendor relationships warm.' });
  await staleTask(s, a.id);
  const res = await s.heartbeat.beat(a.id, NOON);
  assert.equal(res.status, 'ran');
  assert.equal(res.ran, true);
  assert.equal(res.reasons.length, 1);
  assert.match(res.reasons[0], /Reply to the vendor/);
  assert.equal(s.provider.requests.length, 1);
  const prompt = s.provider.requests[0].messages.map((m) => m.content).join('\n');
  assert.match(prompt, /^Heartbeat\. You were woken because:\n- Task [A-Z][A-Z0-9]{1,5}-\d+ "/m);
  assert.match(prompt, /Reply to the vendor/);
  assert.match(prompt, /Do not invent work\./);
  assert.match(prompt, /Your charter[\s\S]*vendor relationships warm/);
  const sessions = await s.repo.listSessions(s.ws.id);
  assert.ok(sessions.some((x) => x.name === 'Loop · heartbeat' && x.agentId === a.id), 'runs in the heartbeat loop session');
  const events = await s.agents.listEvents(a.id);
  assert.ok(events.some((e) => e.kind === 'loop_run' && /heartbeat/.test(e.title)));
  const state = (await s.db.select().from(heartbeatState).where(eq(heartbeatState.agentId, a.id)))[0];
  assert.equal(state.lastRunAt, NOON.toISOString());
  assert.equal(state.runsToday, 1);
  assert.equal(state.beatsSkipped, 0);
  // A task touched just now is not stale.
  const b = await s.agents.create({ name: 'Fresh' });
  await s.agents.addTask(b.id, { title: 'Just added' });
  assert.equal((await s.heartbeat.beat(b.id, new Date())).status, 'empty');
});

test('an unanswered channel mention opens the gate; an answered one does not', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Scout' });
  const now = new Date().toISOString();
  await s.db.insert(channels).values({ id: 'ch1', workspaceId: s.ws.id, slug: 'general', name: 'general', createdAt: now });
  await s.db.insert(channelMembers).values({ id: 'cm1', channelId: 'ch1', memberKind: 'agent', memberId: a.id, joinedAt: now });
  await s.db.insert(channelMessages).values({ id: 'm1', channelId: 'ch1', authorKind: 'human', authorId: 'single', text: '@scout what is the plan?', mentions: JSON.stringify([{ kind: 'agent', id: a.id }]), createdAt: now });
  const res = await s.heartbeat.beat(a.id, new Date());
  assert.equal(res.status, 'ran');
  assert.match(res.reasons[0], /Unanswered mention in #general: "@scout what is the plan\?"/);
  // The agent answers in the thread: the mention is handled.
  await s.db.insert(channelMessages).values({ id: 'm2', channelId: 'ch1', threadRootId: 'm1', authorKind: 'agent', authorId: a.id, text: 'Here is the plan.', createdAt: new Date(Date.now() + 1000).toISOString() });
  const again = await s.heartbeat.beat(a.id, new Date(Date.now() + 2000));
  assert.equal(again.status, 'empty');
  // A mention in a channel the agent does not belong to is not its business.
  await s.db.insert(channels).values({ id: 'ch2', workspaceId: s.ws.id, slug: 'other', name: 'other', createdAt: now });
  await s.db.insert(channelMessages).values({ id: 'm3', channelId: 'ch2', authorKind: 'human', authorId: 'single', text: '@scout?', mentions: JSON.stringify([{ kind: 'agent', id: a.id }]), createdAt: new Date(Date.now() + 3000).toISOString() });
  assert.equal((await s.heartbeat.beat(a.id, new Date(Date.now() + 4000))).status, 'empty');
});

test('quiet hours defer the beat: no reasons computed, no turn, next due after the window', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Sleeper' });
  await staleTask(s, a.id);
  await s.workspaces.update(s.ws.id, { quietHours: JSON.stringify({ start: '22:00', end: '07:00', timezone: 'UTC', policy: 'queue' }) });
  const night = new Date(Date.UTC(2026, 6, 16, 23, 30));
  const res = await s.heartbeat.beat(a.id, night);
  assert.equal(res.status, 'quiet');
  assert.equal(s.provider.requests.length, 0);
  const state = (await s.db.select().from(heartbeatState).where(eq(heartbeatState.agentId, a.id)))[0];
  assert.equal(state.lastReason, 'quiet');
  assert.ok(state.nextDueAt! >= new Date(Date.UTC(2026, 6, 17, 7, 0)).toISOString(), `next due ${state.nextDueAt} is after the window`);
  // Outside the window the same task wakes it.
  const morning = new Date(Date.UTC(2026, 6, 17, 7, 30));
  assert.equal((await s.heartbeat.beat(a.id, morning)).status, 'ran');
});

test('the daily run cap bounds cost: past the cap the gate reports its reasons but runs nothing', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Busy' });
  await staleTask(s, a.id);
  await s.heartbeat.setHeartbeat(a.id, { dailyRunCap: 1 });
  assert.equal((await s.heartbeat.beat(a.id, NOON)).status, 'ran');
  const second = await s.heartbeat.beat(a.id, new Date(NOON.getTime() + 30 * 60_000));
  assert.equal(second.status, 'cap');
  assert.equal(second.reasons.length, 1, 'reasons still reported');
  assert.equal(s.provider.requests.length, 1, 'no second model call');
  const view = await s.heartbeat.view(a.id, NOON);
  assert.equal(view.runsToday, 1);
  assert.equal(view.dailyRunCap, 1);
  // A new UTC day resets the counter.
  const tomorrow = new Date(NOON.getTime() + 24 * 60 * 60_000);
  assert.equal((await s.heartbeat.beat(a.id, tomorrow)).status, 'ran');
});

test('pausing the heartbeat disables it; the spend stop closes the gate; deleting the agent removes its state', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Paused' });
  await staleTask(s, a.id);
  const view = await s.heartbeat.setHeartbeat(a.id, { enabled: false });
  assert.equal(view.enabled, false);
  assert.equal((await s.agents.get(a.id)).heartbeatEnabled, 0);
  assert.equal((await s.heartbeat.beat(a.id, NOON)).status, 'disabled');
  // The tick skips a paused heartbeat even on a matching minute.
  await s.heartbeat.tick(new Date(2026, 6, 16, 12, 30));
  assert.equal(s.provider.requests.length, 0);
  // "Beat now" on a paused heartbeat still runs the gate.
  assert.equal((await s.heartbeat.beat(a.id, NOON, { force: true })).status, 'ran');
  await s.heartbeat.setHeartbeat(a.id, { enabled: true });
  // Spend stop: reached budget refuses before any model call.
  await s.workspaces.update(s.ws.id, { spendBudgetTokens: 10 });
  await s.workspaces.addSpend(s.ws.id, 10, NOON);
  assert.equal((await s.heartbeat.beat(a.id, new Date(NOON.getTime() + 60_000))).status, 'spend_stop');
  assert.equal(s.provider.requests.length, 1);
  await s.agents.remove(a.id);
  assert.equal((await s.db.select().from(heartbeatState).where(eq(heartbeatState.agentId, a.id))).length, 0);
});

test('tunables are defaults with bounds: workspace defaults apply, agent overrides win, the fence refuses', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Tuned' });
  // Workspace defaults (docs/company-vision.md §1b).
  await s.workspaces.update(s.ws.id, { heartbeatDefaults: JSON.stringify({ cron: '0 */2 * * *', dailyRunCap: 4, staleMinutes: 120 }) });
  const ws = await s.workspaces.get(s.ws.id);
  const eff = effectiveHeartbeat(ws, undefined);
  assert.deepEqual(eff, { cron: '0 */2 * * *', dailyRunCap: 4, staleMinutes: 120 });
  // An agent without overrides follows the workspace.
  let view = await s.heartbeat.view(a.id, NOON);
  assert.equal(view.cron, '0 */2 * * *');
  assert.equal(view.dailyRunCap, 4);
  assert.equal(view.staleMinutes, 120);
  // Agent overrides win; clearing one falls back to the workspace default.
  view = await s.heartbeat.setHeartbeat(a.id, { cron: '*/15 * * * *', dailyRunCap: 20, staleMinutes: 15 });
  assert.equal(view.cron, '*/15 * * * *');
  assert.equal(view.dailyRunCap, 20);
  assert.equal(view.staleMinutes, 15);
  assert.equal((await s.agents.get(a.id)).heartbeatDailyRunCap, 20, 'override stored on the agent');
  view = await s.heartbeat.setHeartbeat(a.id, { cron: null, dailyRunCap: null });
  assert.equal(view.cron, '0 */2 * * *');
  assert.equal(view.dailyRunCap, 4);
  assert.equal(view.staleMinutes, 15);
  // The fence.
  await assert.rejects(s.heartbeat.setHeartbeat(a.id, { cron: '* * * * *' }), /floor is 5/);
  await assert.rejects(s.heartbeat.setHeartbeat(a.id, { cron: 'on merge' }), /at least twice/);
  await assert.rejects(s.heartbeat.setHeartbeat(a.id, { dailyRunCap: HEARTBEAT_BOUNDS.dailyRunCap.max + 1 }), /dailyRunCap/);
  await assert.rejects(s.heartbeat.setHeartbeat(a.id, { staleMinutes: 1 }), /staleMinutes/);
  await assert.rejects(s.workspaces.update(s.ws.id, { heartbeatDefaults: JSON.stringify({ cron: '*/2 * * * *' }) }), /floor is 5/);
  await assert.rejects(s.workspaces.update(s.ws.id, { heartbeatDefaults: 'nope' }), /JSON/);
  assert.equal(cronIntervalMinutes('*/30 * * * *'), 30);
  assert.equal(cronIntervalMinutes('0 9 * * 1-5'), 24 * 60);
  assert.equal(cronIntervalMinutes('0 0 31 2 *'), null);
  assert.equal(nextCronMatch('*/30 * * * *', NOON)?.toISOString(), new Date(Date.UTC(2026, 6, 16, 12, 30)).toISOString());
  // Stale interval is the workspace's 120 min unless the agent says otherwise: a 60-minute-old task is not stale at 120.
  const b = await s.agents.create({ name: 'Patient' });
  await staleTask(s, b.id);
  assert.equal((await s.heartbeat.beat(b.id, NOON)).status, 'empty');
  await s.heartbeat.setHeartbeat(b.id, { staleMinutes: 30 });
  assert.equal((await s.heartbeat.beat(b.id, NOON)).status, 'ran');
});

test('registered providers extend the gate: reasons wake the agent and the operating profile reaches the prompt', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Member', charter: 'Research lead.' });
  const unsubscribe = s.heartbeat.addReasonProvider({ name: 'org', reasons: async () => ['Key result "Ship v2" check-in is due'] });
  s.heartbeat.addContextProvider({ name: 'org', context: async () => 'Values: terse, evidence first. Culture: weekly review, no standup. Vision: the best research digest.' });
  s.heartbeat.addReasonProvider({ name: 'broken', reasons: async () => { throw new Error('boom'); } });
  const res = await s.heartbeat.beat(a.id, NOON);
  assert.equal(res.status, 'ran');
  assert.deepEqual(res.reasons, ['Key result "Ship v2" check-in is due']);
  const prompt = s.provider.requests[0].messages.map((m) => m.content).join('\n');
  assert.match(prompt, /- Key result "Ship v2" check-in is due/);
  assert.match(prompt, /How this company works[\s\S]*Values: terse, evidence first/);
  assert.match(prompt, /Research lead\./);
  unsubscribe();
  assert.equal((await s.heartbeat.beat(a.id, new Date(NOON.getTime() + 60_000))).status, 'empty');
  // The prompt builder alone: no charter, no profile → just the list.
  const bare = heartbeatPrompt(['x'], '', '');
  assert.equal(bare, 'Heartbeat. You were woken because:\n- x\nCheck each item, act with your tools, then stop. Do not invent work. Keep your board true with update_task: doing when you work on a task, done when finished, blocked (with what it waits on) when you cannot move it, abandoned (with why) when it is no longer worth doing.');
});
