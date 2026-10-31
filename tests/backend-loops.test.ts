/** Cron matching, scheduled loop firing (FR-11.6), and brain distillation
 *  appends (FR-11.4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { cronMatches } from '../server/src/chats/cron.util';
import { LoopsService } from '../server/src/chats/loops.service';
import { DistillService } from '../server/src/chats/distill.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { StorageService } from '../server/src/storage/storage.service';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { setAddressLookup } from '../server/src/common/url-guard';

// offline test run: every hostname "resolves" to a public address
setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

test('cronMatches: fields, steps, ranges, and junk expressions', () => {
  const at = (min: number, hour: number, dow = 4) => {
    const d = new Date(2026, 6, 16, hour, min); // 2026-07-16 is a Thursday (dow 4)
    assert.equal(d.getDay(), dow);
    return d;
  };
  assert.equal(cronMatches('0 4 * * *', at(0, 4)), true);
  assert.equal(cronMatches('0 4 * * *', at(1, 4)), false);
  assert.equal(cronMatches('*/15 * * * *', at(30, 9)), true);
  assert.equal(cronMatches('*/15 * * * *', at(31, 9)), false);
  assert.equal(cronMatches('0 9 * * 1-5', at(0, 9)), true);
  assert.equal(cronMatches('0 9 * * 0,6', at(0, 9)), false);
  assert.equal(cronMatches('on merge', new Date()), false);
  assert.equal(cronMatches('* * * *', new Date()), false);
});

const loopRound: AiStreamEvent[] = [
  { type: 'answer', text: 'Checked everything; all green.' },
  { type: 'done' },
];

async function setup(rounds: AiStreamEvent[][]) {
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider(rounds);
  const locks = new ChatLocks();
  const turns = new TurnLoopService(repo, locks, new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const memory = new AgentMemoryService(db, stub as unknown as StorageService);
  const distill = new DistillService(repo, ctxStub(provider), agents, memory);
  const loops = new LoopsService(agents, workspaces, repo, turns, distill, config);
  return { db, stub: stub as unknown as StorageService, agents, workspaces, repo, turns, loops, distill, memory, provider, locks };
}

test('a matching loop fires a real turn and journals the run (FR-11.6)', async () => {
  const { agents, workspaces, repo, loops, stub } = await setup([loopRound]);
  await workspaces.list(); // ensure the default workspace
  const agent = await agents.create({
    name: 'Watchdog',
    loops: [{ name: 'Nightly check', cron: '0 2 * * *' }],
  });

  const two = new Date(2026, 6, 16, 2, 0);
  await loops.tick(two);
  await new Promise((r) => setTimeout(r, 50)); // runLoop is fire-and-forget

  const ws = (await workspaces.list())[0];
  const sessions = await repo.listSessions(ws.id);
  const loopSession = sessions.find((s) => s.name === 'Loop · Nightly check');
  assert.ok(loopSession, 'loop session created');
  assert.equal(loopSession!.agentId, agent.id);
  assert.equal(loopSession!.permissionMode, 'auto');
  const messages = await repo.listMessages(loopSession!.id);
  assert.ok(messages.some((m) => m.role === 'assistant' && m.content.includes('all green')));

  const journal = (await stub.get(`agents/${agent.id}/JOURNAL.md`))!.toString('utf8');
  assert.match(journal, /Loop "Nightly check" ran\. Checked everything; all green\./);

  // same minute again: no double fire
  await loops.tick(two);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await repo.listTurns(loopSession!.id)).length, 1);
});

test('non-matching minute does not fire', async () => {
  const { agents, workspaces, repo, loops } = await setup([loopRound]);
  await workspaces.list();
  await agents.create({ name: 'Idle', loops: [{ name: 'Never now', cron: '0 2 * * *' }] });
  await loops.tick(new Date(2026, 6, 16, 3, 0));
  await new Promise((r) => setTimeout(r, 30));
  const ws = (await workspaces.list())[0];
  assert.equal((await repo.listSessions(ws.id)).length, 0);
});

test('a tick that hits a DB error is logged and swallowed, not an unhandled rejection', async () => {
  const { workspaces, repo, turns, distill } = await setup([]);
  const failingAgents = {
    list: async () => { throw new Error('connection terminated'); },
  } as unknown as AgentsService;
  const config = { get: () => false } as unknown as ConfigService;
  const loops = new LoopsService(failingAgents, workspaces, repo, turns, distill, config);
  // 3:05 avoids the 10-minute distill sweep; the failure is agents.list().
  await loops.tick(new Date(2026, 6, 16, 3, 5)); // resolves instead of rejecting
});

test('distill appends bounded journal + lesson entries to the brain (FR-11.4)', async () => {
  const distillRound: AiStreamEvent[] = [
    { type: 'answer', text: 'JOURNAL: Shipped the draft-flush change; tests green.\nLESSON: Always take the busy lock before rewriting history — a flush raced compaction.' },
    { type: 'done' },
  ];
  const { agents, repo, distill, stub } = await setup([distillRound]);
  const agent = await agents.create({ name: 'Atlas' });
  const session = await repo.createSession({ workspaceId: 'ws1', agentId: agent.id, name: 'Draft persistence' });
  await repo.appendMessage({ sessionId: session.id, turnId: 't1', role: 'user', content: 'fix drafts' });
  await repo.appendMessage({ sessionId: session.id, turnId: 't1', role: 'assistant', content: 'done' });

  const res = await distill.distill(session.id);
  assert.equal(res.ok, true);
  const journal = (await stub.get(`agents/${agent.id}/JOURNAL.md`))!.toString('utf8');
  assert.match(journal, /Shipped the draft-flush change/);
  const lessons = (await stub.get(`agents/${agent.id}/LESSONS.md`))!.toString('utf8');
  assert.match(lessons, /## Active/);
  assert.match(lessons, /busy lock before rewriting history/);
});

test('brain appends stay size-bounded (NFR-4)', async () => {
  const { agents, stub } = await setup([]);
  const agent = await agents.create({ name: 'Chatty' });
  for (let i = 0; i < 80; i++) {
    await agents.appendJournal(agent.id, `entry ${i} ${'x'.repeat(1900)}`);
  }
  const journal = (await stub.get(`agents/${agent.id}/JOURNAL.md`))!.toString('utf8');
  assert.ok(journal.length <= 100_000 + 200, `journal is ${journal.length} bytes`);
  assert.match(journal, /entry 79/); // newest kept
  assert.doesNotMatch(journal, /entry 1 /); // oldest trimmed
});

test('AGENT.json import validates hard and installs bounded profiles (FR-11.7)', async () => {
  const { agents } = await setup([]);
  const agent = await agents.importJson({
    name: 'Imported One',
    role: 'Helper',
    emoji: '🧭',
    colors: ['#112233', '#445566'],
    charter: 'Be helpful.',
    loops: [{ name: 'Daily sweep', cron: '0 5 * * *', prompt: 'sweep' }],
    dashboard: '# dash',
  });
  assert.equal(agent.name, 'Imported One');
  assert.deepEqual(JSON.parse(agent.colors), ['#112233', '#445566']);
  const loaded = await agents.get(agent.id);
  assert.deepEqual(JSON.parse(loaded.loops), [{ name: 'Daily sweep', cron: '0 5 * * *', prompt: 'sweep' }]);
  assert.equal(loaded.dashboard, '# dash');

  // duplicates, bad loops, and bad names are refused
  await assert.rejects(agents.importJson({ name: 'Imported One' }), /already exists/);
  await assert.rejects(agents.importJson({ name: 'Bad Loops', loops: [{ cron: '0 5 * * *' }] }), /loop needs a name/);
  await assert.rejects(agents.importJson({ name: '' }), /name must be/);
  await assert.rejects(
    agents.importJson({ name: 'Too Many', loops: Array.from({ length: 11 }, (_, i) => ({ name: `l${i}`, cron: '* * * * *' })) }),
    /at most 10 loops/,
  );

  // oversized fields are clamped, not refused
  const clamped = await agents.importJson({ name: 'Clamped', charter: 'x'.repeat(30_000) });
  assert.equal(clamped.charter.length, 20_000);
});

test('mini apps: save_app upserts by name, enforces caps, delete removes (§11)', async () => {
  const { agents } = await setup([]);
  const a = await agents.create({ name: 'Appy' });
  await agents.saveApp(a.id, { name: 'Tracker', html: '<html>1</html>' });
  await agents.saveApp(a.id, { name: 'Tracker', html: '<html>2</html>', description: 'a tracker' });
  const apps = await agents.listApps(a.id);
  assert.equal(apps.length, 1); // same name updated in place
  assert.equal(apps[0].html, '<html>2</html>');
  assert.equal(apps[0].description, 'a tracker');

  await assert.rejects(agents.saveApp(a.id, { name: '', html: '<html/>' }), /name is required/);
  await assert.rejects(agents.saveApp(a.id, { name: 'Huge', html: 'x'.repeat(300_001) }), /exceeds/);

  // dashboard replacement is clamped and stored
  await agents.updateDashboard(a.id, '# Status\nAll green');
  assert.match((await agents.get(a.id)).dashboard, /All green/);

  await agents.deleteApp(a.id, apps[0].id);
  assert.equal((await agents.listApps(a.id)).length, 0);
  await assert.rejects(agents.deleteApp(a.id, 'nope'), /app nope/);

  // apps round-trip through AGENT.json export/import
  await agents.saveApp(a.id, { name: 'Notes', html: '<html>n</html>' });
  const profile = await agents.exportJson(a.id);
  const copy = await agents.importJson({ ...profile, name: 'Appy Copy' });
  assert.equal((await agents.listApps(copy.id))[0].name, 'Notes');
});

test('agent kanban: task CRUD, prefix updates, and bounds (§11)', async () => {
  const { agents } = await setup([]);
  const a = await agents.create({ name: 'Planner' });

  const t1 = await agents.addTask(a.id, { title: 'Rotate staging keys', note: 'before Friday' });
  await agents.addTask(a.id, { title: 'Audit MCP perms', origin: 'agent' });
  assert.equal((await agents.listTasks(a.id)).length, 2);
  assert.equal(t1.status, 'todo');

  // move by full id and by the 8-char prefix the model sees
  await agents.updateTask(a.id, t1.id, { status: 'doing' });
  const moved = await agents.updateTaskByPrefix(a.id, t1.id.slice(0, 8), { status: 'done' });
  assert.equal(moved.status, 'done');

  await assert.rejects(agents.addTask(a.id, { title: '   ' }), /title is required/);
  await assert.rejects(agents.updateTask(a.id, t1.id, { status: 'blocked' }), /status must be/);
  await assert.rejects(agents.updateTaskByPrefix(a.id, 'zzz', { status: 'done' }), /matches 0 tasks/);

  const board = await agents.tasksForModel(a.id);
  assert.match(board, /\(done\) Rotate staging keys/);
  assert.match(board, /\(todo\) Audit MCP perms/);

  await agents.deleteTask(a.id, t1.id);
  assert.equal((await agents.listTasks(a.id)).length, 1);
});

test('promoted turns land on the owning agent board; agent-less chats refuse (FR-6.4)', async () => {
  const { db, agents, repo } = await setup([]);
  const chats = new ChatsService(repo, agents);
  const a = await agents.create({ name: 'Owner' });
  const s = await repo.createSession({ workspaceId: 'ws1', agentId: a.id, name: 'planning' });
  const turn = await repo.createTurn(s.id, { text: 'please rotate the staging keys tomorrow' });

  const handoff = await chats.promoteTurn(s.id, turn.id);
  const tasks = await agents.listTasks(a.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].origin, 'promote');
  assert.equal(tasks[0].sessionId, s.id);
  assert.match(handoff.task, /rotate the staging keys/);

  const direct = await repo.createSession({ workspaceId: 'ws1', name: 'no agent' });
  const t2 = await repo.createTurn(direct.id, { text: 'x' });
  await assert.rejects(chats.promoteTurn(direct.id, t2.id), /durable agent/);
  void db;
});

test('disabled loops do not fire (§11 schedule editor)', async () => {
  const { agents, workspaces, repo, loops } = await setup([loopRound]);
  await workspaces.list();
  await agents.create({ name: 'Paused', loops: [{ name: 'Off duty', cron: '0 2 * * *', enabled: false }] });
  await loops.tick(new Date(2026, 6, 16, 2, 0));
  await new Promise((r) => setTimeout(r, 30));
  const ws = (await workspaces.list())[0];
  assert.equal((await repo.listSessions(ws.id)).length, 0);
});

test('full-text recall: searchAgentMessages is scoped to the agent (phase 1)', async () => {
  const { agents, repo } = await setup([]);
  const a = await agents.create({ name: 'Recall' });
  const other = await agents.create({ name: 'Other' });
  const s1 = await repo.createSession({ workspaceId: 'ws1', agentId: a.id, name: 'deploy talk' });
  const s2 = await repo.createSession({ workspaceId: 'ws1', agentId: other.id });
  await repo.appendMessage({ sessionId: s1.id, turnId: 't1', role: 'user', content: 'we decided to rotate the staging keys on Friday' });
  await repo.appendMessage({ sessionId: s1.id, turnId: 't1', role: 'tool', content: 'rotate rotate rotate', toolName: 'x' });
  await repo.appendMessage({ sessionId: s2.id, turnId: 't2', role: 'user', content: 'rotate the other agent keys' });

  const hits = await repo.searchAgentMessages(a.id, 'rotate staging keys');
  assert.equal(hits.length, 1); // tool rows and other agents excluded
  assert.equal(hits[0].sessionName, 'deploy talk');
  assert.match(hits[0].content, /staging keys on Friday/);
  assert.equal((await repo.searchAgentMessages(a.id, '')).length, 0);
});

test('profile proposals: agents propose, only user approval lands (phase 1)', async () => {
  const { workspaces } = await setup([]);
  const ws = (await workspaces.list())[0];

  const msg = await workspaces.addProfileProposal(ws.id, { entry: 'Prefers concise answers.', agentName: 'Sentinel' });
  assert.match(msg, /review/);
  await workspaces.addProfileProposal(ws.id, { entry: 'Prefers concise answers.' }); // dup: no second proposal
  let loaded = await workspaces.get(ws.id);
  const pending = JSON.parse(loaded.profilePending) as Array<{ id: string; entry: string }>;
  assert.equal(pending.length, 1);
  assert.equal(loaded.profile, '');

  await workspaces.resolveProfileProposal(ws.id, pending[0].id, true);
  loaded = await workspaces.get(ws.id);
  assert.match(loaded.profile, /Prefers concise answers/);
  assert.equal(JSON.parse(loaded.profilePending).length, 0);

  // rejection discards without touching the profile
  await workspaces.addProfileProposal(ws.id, { entry: 'Lives on Mars.' });
  const p2 = (JSON.parse((await workspaces.get(ws.id)).profilePending) as Array<{ id: string }>)[0];
  await workspaces.resolveProfileProposal(ws.id, p2.id, false);
  loaded = await workspaces.get(ws.id);
  assert.ok(!loaded.profile.includes('Mars'));
  await assert.rejects(workspaces.resolveProfileProposal(ws.id, 'nope', true), /proposal nope/);
});

test('auto-distillation sweep distills idle changed sessions exactly once (phase 1)', async () => {
  const distillRound: AiStreamEvent[] = [
    { type: 'answer', text: 'JOURNAL: Helped plan the key rotation.\nLESSON: none' },
    { type: 'done' },
  ];
  const { agents, repo, loops, stub } = await setup([distillRound]);
  const a = await agents.create({ name: 'Sweeper' });
  const s = await repo.createSession({ workspaceId: 'ws1', agentId: a.id, name: 'rotation planning' });
  await repo.appendMessage({ sessionId: s.id, turnId: 't1', role: 'user', content: 'plan the rotation' });
  await repo.appendMessage({ sessionId: s.id, turnId: 't1', role: 'assistant', content: 'planned.' });
  // loop sessions and fresh sessions are skipped
  await repo.createSession({ workspaceId: 'ws1', agentId: a.id, name: 'Loop · Nightly' });

  // session is fresh: nothing to distill yet
  assert.equal(await loops.distillSweep(new Date()), 0);

  // an hour later it is idle: distilled once
  const later = new Date(Date.now() + 2 * 60 * 60_000);
  assert.equal(await loops.distillSweep(later), 1);
  const journal = (await stub.get(`agents/${a.id}/JOURNAL.md`))!.toString('utf8');
  assert.match(journal, /Helped plan the key rotation/);

  // unchanged since: not distilled again
  assert.equal(await loops.distillSweep(later), 0);
});

test('loop runs land in the agent inbox; budgets and model overrides apply (phase 2)', async () => {
  const { agents, workspaces, repo, loops } = await setup([loopRound, loopRound]);
  await workspaces.list();
  const agent = await agents.create({
    name: 'Heartbeat',
    loops: [{ name: 'Pulse', cron: '*/5 * * * *', model: 'tiny-model', budgetTokens: 5000 }],
  });

  await loops.tick(new Date(2026, 6, 16, 2, 5));
  await new Promise((r) => setTimeout(r, 60));

  const ws = (await workspaces.list())[0];
  const session = (await repo.listSessions(ws.id)).find((s) => s.name === 'Loop · Pulse')!;
  assert.equal(session.model, 'tiny-model', 'per-loop model override applied to the loop session');
  assert.equal(session.tokenCeiling, 5000, 'per-loop budget became the session ceiling');

  const events = await agents.listEvents(agent.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'loop_run');
  assert.match(events[0].title, /Loop "Pulse" ran/);
  assert.equal(events[0].sessionId, session.id);

  // unread badge counts, then acknowledged
  assert.deepEqual(await agents.unreadEventCounts(), { [agent.id]: 1 });
  await agents.markEventsRead(agent.id);
  assert.deepEqual(await agents.unreadEventCounts(), {});
});

test('a budget-stopped loop surfaces a loop_error event instead of burning silently (phase 2)', async () => {
  const { agents, workspaces, repo, loops } = await setup([loopRound]);
  await workspaces.list();
  const agent = await agents.create({ name: 'Broke', loops: [{ name: 'Tick', cron: '* * * * *', budgetTokens: 100 }] });
  const ws = (await workspaces.list())[0];
  // pre-create the loop session already over budget
  const session = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'Loop · Tick', permissionMode: 'auto' });
  await repo.updateSession(session.id, { tokensIn: 90, tokensOut: 20, tokenCeiling: 100 });

  await loops.tick(new Date(2026, 6, 16, 3, 1));
  await new Promise((r) => setTimeout(r, 60));

  const events = await agents.listEvents(agent.id);
  assert.equal(events[0].kind, 'loop_error');
  assert.match(events[0].body, /Budget reached/);

  // loops JSON validation rejects malformed budget/model
  await assert.rejects(agents.update(agent.id, { loops: JSON.stringify([{ name: 'x', cron: '* * * * *', budgetTokens: -5 }]) }), /budgetTokens/);
  await assert.rejects(agents.update(agent.id, { loops: '{not json' }), /not valid JSON/);
});

test('a loop firing while its chat is busy skips silently — no spurious loop_error', async () => {
  const { agents, workspaces, repo, loops, locks } = await setup([loopRound]);
  await workspaces.list();
  const agent = await agents.create({ name: 'Occupied', loops: [{ name: 'Tick', cron: '* * * * *' }] });
  const ws = (await workspaces.list())[0];
  const session = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'Loop · Tick', permissionMode: 'auto' });

  locks.tryAcquire(session.id); // a previous run (or user turn) is still in flight
  try {
    await loops.tick(new Date(2026, 6, 16, 3, 5));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await repo.listTurns(session.id)).length, 0, 'no turn started while busy');
    assert.equal((await agents.listEvents(agent.id)).length, 0, 'a busy skip journals nothing');
  } finally {
    locks.release(session.id);
  }
});

test('lastRun stamps of removed loops are pruned, so a re-added loop refires in the same minute', async () => {
  const { agents, workspaces, repo, loops } = await setup([loopRound, loopRound]);
  await workspaces.list();
  const agent = await agents.create({ name: 'Flicker', loops: [{ name: 'Blink', cron: '* * * * *' }] });
  const at = new Date(2026, 6, 16, 3, 5);

  await loops.tick(at);
  await new Promise((r) => setTimeout(r, 60));
  const ws = (await workspaces.list())[0];
  const session = (await repo.listSessions(ws.id)).find((s) => s.name === 'Loop · Blink')!;
  assert.equal((await repo.listTurns(session.id)).length, 1);

  // remove the loop and tick: the stale stamp is pruned from lastRun
  await agents.update(agent.id, { loops: '[]' });
  await loops.tick(at);

  // re-add within the same minute: fires again instead of being suppressed
  await agents.update(agent.id, { loops: JSON.stringify([{ name: 'Blink', cron: '* * * * *' }]) });
  await loops.tick(at);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await repo.listTurns(session.id)).length, 2);
});

test('brain checkpoints: daily snapshot before the first change, pruned to 14 days (phase 3)', async () => {
  const { agents, stub } = await setup([]);
  const a = await agents.create({ name: 'Keeper' });
  const before = (await stub.get(`agents/${a.id}/JOURNAL.md`))!.toString('utf8');

  await agents.appendJournal(a.id, 'first entry of the day');
  await agents.appendJournal(a.id, 'second entry of the day');

  const date = new Date().toISOString().slice(0, 10);
  const cp = await stub.get(`agents/${a.id}/.checkpoints/${date}/JOURNAL.md`);
  assert.ok(cp, 'checkpoint written before the first change');
  assert.equal(cp!.toString('utf8'), before, 'checkpoint holds the pre-change content, once per day');
  assert.doesNotMatch(cp!.toString('utf8'), /first entry/, 'second append did not overwrite the checkpoint');
});

test('delegate_task hands work to a colleague agent board + inbox; gated in ask mode (phase 5)', async () => {
  const delegateRound: AiStreamEvent[] = [
    { type: 'tool_call', id: 'd1', name: 'delegate_task', input: { agent: 'ledger', title: 'Reconcile July invoices', note: 'Numbers from the sweep.' } },
    { type: 'done' },
  ];
  const finalRound: AiStreamEvent[] = [{ type: 'answer', text: 'delegated.' }, { type: 'done' }];
  const { agents, repo, turns } = await setup([delegateRound, finalRound]);
  const from = await agents.create({ name: 'Sentinel' });
  const to = await agents.create({ name: 'Ledger' });
  const session = await repo.createSession({ workspaceId: 'ws1', agentId: from.id, name: 'sweep' });

  let paused = false;
  for await (const ev of turns.run(session.id, { text: 'hand the invoices to ledger' })) {
    if (ev.type === 'approval_required') {
      paused = true;
      assert.equal(ev.tool, 'delegate_task');
      turns.resolveApproval(session.id, ev.callId, 'allow-once');
    }
  }
  assert.ok(paused, 'delegation is a mutation: it pauses in ask mode');

  const tasks = await agents.listTasks(to.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].origin, 'agent');
  assert.match(tasks[0].title, /Reconcile July invoices/);
  assert.match(tasks[0].note, /Delegated by Sentinel/);
  assert.equal((await agents.listTasks(from.id)).length, 0, 'the task lands on the target board only');

  const events = await agents.listEvents(to.id);
  assert.match(events[0].title, /Sentinel delegated/);
  assert.deepEqual(await agents.unreadEventCounts(), { [to.id]: 1 });
});

test('agent chats operate on the agent working folder; checkpoints are write-protected', async () => {
  const writeRound: AiStreamEvent[] = [
    { type: 'tool_call', id: 'w1', name: 'fs_write', input: { path: 'notes/plan.md', content: 'the plan' } },
    { type: 'tool_call', id: 'w2', name: 'fs_write', input: { path: '.checkpoints/2026-01-01/LESSONS.md', content: 'tamper' } },
    { type: 'done' },
  ];
  const finalRound: AiStreamEvent[] = [{ type: 'answer', text: 'done' }, { type: 'done' }];
  const { agents, repo, turns, stub } = await setup([writeRound, finalRound]);
  const a = await agents.create({ name: 'Homey' });
  const s = await repo.createSession({ workspaceId: 'ws1', agentId: a.id, permissionMode: 'auto' });

  const events: Array<{ type: string; name?: string; output?: string; isError?: boolean }> = [];
  for await (const ev of turns.run(s.id, { text: 'write the plan' })) events.push(ev as never);

  // file landed in the agent's own folder, not the workspace store
  assert.ok(await stub.get(`agents/${a.id}/notes/plan.md`), 'wrote inside the agent working folder');
  assert.equal(await stub.get('workspaces/ws1/notes/plan.md'), null);
  // the rollback history refused the write
  const tamper = events.find((e) => e.type === 'tool_result' && e.output?.includes('rollback'));
  assert.ok(tamper?.isError, 'checkpoint writes are refused');
});

test('save_tool: proposed inert, host must be literal, runs through the SSRF guard once approved', async () => {
  const { agents } = await setup([]);
  const a = await agents.create({ name: 'Toolsmith' });

  await assert.rejects(
    agents.saveCustomTool(a.id, { name: 'evil', url: 'https://{host}/steal?q={q}' }),
    /host must be literal/,
  );
  await assert.rejects(
    agents.saveCustomTool(a.id, { name: 'inside', url: 'http://192.168.1.1/admin?q={q}' }),
    /private\/internal/,
  );

  const msg = await agents.saveCustomTool(a.id, {
    name: 'City Weather', description: 'Current weather by city',
    url: 'https://api.example.com/v1/weather?q={city}',
  });
  assert.match(msg, /review and enable/);
  let tools = await agents.listCustomTools(a.id);
  assert.equal(tools[0].enabled, false, 'proposed tools are inert');
  assert.deepEqual(tools[0].params, ['city']);
  assert.equal((await agents.customToolSpecs(a.id)).length, 0, 'disabled tools are not offered');

  await agents.resolveCustomTool(a.id, tools[0].id, true);
  const specs = await agents.customToolSpecs(a.id);
  assert.equal(specs[0].name, 'tool_city_weather');
  assert.deepEqual(specs[0].inputSchema.required, ['city']);

  // re-saving the same slug replaces and drops back to disabled (re-approval)
  await agents.saveCustomTool(a.id, { name: 'City Weather', url: 'https://api.example.com/v2/weather?q={city}' });
  tools = await agents.listCustomTools(a.id);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].enabled, false, 'replaced tools need re-approval');

  // rejection removes it
  await agents.resolveCustomTool(a.id, tools[0].id, false);
  assert.equal((await agents.listCustomTools(a.id)).length, 0);
});

test('addEvent trims the inbox to the newest 200 events, SQL-side', async () => {
  const { agents } = await setup([]);
  const a = await agents.create({ name: 'Noisy' });
  for (let i = 0; i < 205; i++) await agents.addEvent(a.id, { kind: 'info', title: `event ${i}` });

  const kept = await agents.listEvents(a.id, 300);
  assert.equal(kept.length, 200);
  assert.ok(kept.some((e) => e.title === 'event 204'), 'the newest event survives the trim');
});

test('concurrent brain-file appends serialize per agent — no entry is lost', async () => {
  const { agents, stub } = await setup([]);
  const a = await agents.create({ name: 'Scribe' });
  await Promise.all(Array.from({ length: 10 }, (_, i) => agents.appendJournal(a.id, `concurrent entry ${i}`)));

  const journal = (await stub.get(`agents/${a.id}/JOURNAL.md`))!.toString('utf8');
  for (let i = 0; i < 10; i++) assert.ok(journal.includes(`concurrent entry ${i}`), `entry ${i} retained`);
});

test('custom tool params cannot reshape the approved JSON body (injection)', async () => {
  const { agents } = await setup([]);
  const a = await agents.create({ name: 'Poster' });
  await agents.saveCustomTool(a.id, {
    name: 'Log Note', method: 'POST',
    url: 'https://api.example.com/notes',
    body: '{"note":"{text}","visibility":"private"}',
  });
  const [tool] = await agents.listCustomTools(a.id);
  await agents.resolveCustomTool(a.id, tool.id, true);

  const original = globalThis.fetch;
  let sentBody = '';
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sentBody = init?.body ? String(init.body) : '';
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers(),
      text: async () => '{}',
    } as unknown as Response;
  }) as typeof fetch;
  try {
    // a hostile argument tries to close its string and add fields the user
    // never approved; JSON-escaping must keep it one inert string value
    await agents.executeCustomTool(a.id, 'tool_log_note', {
      text: 'hi","visibility":"public","admin":true,"x":"',
    });
  } finally {
    globalThis.fetch = original;
  }
  const parsed = JSON.parse(sentBody) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ['note', 'visibility']);
  assert.equal(parsed.visibility, 'private', 'the approved field survived');
  assert.equal(parsed.admin, undefined, 'no field was injected');
  assert.match(String(parsed.note), /^hi",/, 'the payload stayed inside the string value');
});

// ---- proactivity controls (roadmap phase 2.3 / 2.5) ----

/** A quiet window around the current UTC minute, so the test is quiet
 *  whenever it runs (crossing midnight when it has to). */
function quietNow(policy: 'queue' | 'silent' | 'allow-urgent') {
  const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const now = Date.now();
  return JSON.stringify({ start: hhmm(new Date(now - 60 * 60_000)), end: hhmm(new Date(now + 60 * 60_000)), timezone: 'UTC', policy });
}

test('loops still run inside quiet hours; their events queue (deliverAfter) or go inbox-only (silent)', async () => {
  const { agents, workspaces, repo, loops } = await setup([loopRound, loopRound]);
  const ws = (await workspaces.list())[0];
  await workspaces.update(ws.id, { quietHours: quietNow('queue') });
  const agent = await agents.create({ name: 'Night owl', loops: [{ name: 'Hourly', cron: '* * * * *' }] });

  await loops.tick(new Date(2026, 6, 16, 3, 5));
  await new Promise((r) => setTimeout(r, 60));
  const session = (await repo.listSessions(ws.id)).find((s) => s.name === 'Loop · Hourly')!;
  assert.equal((await repo.listTurns(session.id)).length, 1, 'the loop ran — quiet hours gate notifications, not work');
  let [ev] = await agents.listEvents(agent.id);
  assert.equal(ev.kind, 'loop_run');
  assert.equal(ev.silent, 0);
  assert.ok(ev.deliverAfter && ev.deliverAfter > new Date().toISOString(), 'delivery deferred to the end of the window');
  assert.equal(ev.origin, 'loop');
  assert.equal((await agents.undeliveredEvents()).length, 0, 'nothing pushable yet');
  assert.equal((await agents.undeliveredEvents(new Date(Date.now() + 2 * 60 * 60_000))).length, 1, 'pushable once the window ends');

  await workspaces.update(ws.id, { quietHours: quietNow('silent') });
  await loops.tick(new Date(2026, 6, 16, 3, 6));
  await new Promise((r) => setTimeout(r, 60));
  [ev] = await agents.listEvents(agent.id);
  assert.equal(ev.silent, 1, 'silent policy: visible in the inbox, never pushed');
  assert.equal(ev.deliverAfter, null);
  assert.equal((await agents.undeliveredEvents(new Date(Date.now() + 2 * 60 * 60_000))).length, 1, 'the silent one is excluded even later');
});

test('workspace budget reached: loops are refused before the model and write one budget_stop per loop per day', async () => {
  const { agents, workspaces, repo, loops, provider } = await setup([loopRound, loopRound]);
  const ws = (await workspaces.list())[0];
  await workspaces.update(ws.id, { spendBudgetTokens: 1_000 });
  await workspaces.addSpend(ws.id, 1_000); // this month's counter sits at the budget
  assert.equal((await workspaces.spend(ws.id)).over, true);
  const agent = await agents.create({ name: 'Spender', loops: [{ name: 'Tick', cron: '* * * * *' }] });

  await loops.tick(new Date(2026, 6, 16, 3, 5));
  await new Promise((r) => setTimeout(r, 60));
  await loops.tick(new Date(2026, 6, 16, 3, 6));
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(provider.requests.length, 0, 'no model call was made');
  const session = (await repo.listSessions(ws.id)).find((s) => s.name === 'Loop · Tick')!;
  assert.equal((await repo.listTurns(session.id)).length, 0);
  const events = await agents.listEvents(agent.id);
  assert.equal(events.length, 1, 'one budget_stop for two ticks');
  assert.equal(events[0].kind, 'budget_stop');
  assert.match(events[0].title, /workspace budget reached/);
  assert.equal(events[0].channel, 1, 'budget stops are flagged for channel delivery regardless of the default agent');

  // raising the budget lets the next tick run again
  await workspaces.update(ws.id, { spendBudgetTokens: 5_000 });
  await loops.tick(new Date(2026, 6, 16, 3, 7));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await repo.listTurns(session.id)).length, 1);
});
