/** Cron matching, scheduled loop firing (FR-11.6), and brain distillation
 *  appends (FR-11.4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { cronMatches } from '../server/src/chats/cron.util';
import { LoopsService } from '../server/src/chats/loops.service';
import { DistillService } from '../server/src/chats/distill.service';
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
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents);
  const config = { get: (k: string) => (k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const loops = new LoopsService(agents, workspaces, repo, turns, config);
  const distill = new DistillService(repo, ctxStub(provider), agents);
  return { db, stub: stub as unknown as StorageService, agents, workspaces, repo, turns, loops, distill, provider };
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
  assert.match(lessons, /## \d{4}-\d{2}-\d{2} {2}Draft persistence/);
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
