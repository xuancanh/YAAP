/** Chat vs work (docs/work-log.md): session classification and the 0080
 *  backfill, every creation path stating its kind, the owner DM, the rail and
 *  chat pages and chat search keeping to conversations, thinking persisted on
 *  the transcript, and the Work log endpoint — trigger grouping, filters,
 *  paging, run detail with thinking and tool calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../server/src/database/schema';
import { chatSessions, chatTurns } from '../server/src/database/schema';
import { runPgMigrations } from '../server/src/database/migrator';
import { scopeDb } from '../server/src/accounts/scoped-db';
import type { DrizzleDb } from '../server/src/database/database.module';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, pgliteQueryable, ScriptedProvider } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { ChatsController } from '../server/src/chats/chats.controller';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { WorkLogService, labelOf } from '../server/src/chats/work-log.service';
import { WorkLogController } from '../server/src/chats/work-log.controller';
import { classifySession, OWNER_DM_TAG } from '../server/src/chats/session-kind';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { SearchService } from '../server/src/search/search.service';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

test('classifySession: run prefixes, channel working sessions, org task links are work; everything else is a chat', () => {
  for (const name of ['Loop · heartbeat', 'Loop · digest', 'Org · Acme · Close the books', 'Org · Acme · Chief review', 'Red team · x1', 'Eval · e2', 'App · Jong', '#general · Jong']) {
    assert.equal(classifySession({ name }), 'work', name);
  }
  for (const name of ['', 'Jong', 'Plan the launch', 'Telegram · Jong', 'Email · Jong · Ann', 'Fork · Loop · heartbeat', '#hashtag ideas', 'Loop ideas']) {
    assert.equal(classifySession({ name }), 'chat', name);
  }
  assert.equal(classifySession({ name: 'tagged', tags: '["channel"]' }), 'work');
  assert.equal(classifySession({ name: 'x', taskKind: 'org' }), 'work');
  assert.equal(classifySession({ name: 'x', taskKind: 'agent' }), 'chat', 'a chat promoted to the kanban stays a chat');
});

test('migration 0080 backfills the kind from names, tags, task links and org runs, and is idempotent', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  const db = scopeDb(drizzle(pg, { schema }) as unknown as DrizzleDb);
  const at = '2026-10-01T00:00:00.000Z';
  const base = { workspaceId: 'w1', agentId: 'a1', createdAt: at, updatedAt: at, kind: 'chat' };
  await db.insert(chatSessions).values([
    { ...base, id: 'loop', name: 'Loop · heartbeat' },
    { ...base, id: 'org', name: 'Org · Acme · Planning · Eng' },
    { ...base, id: 'chan', name: '#general · Jong' },
    { ...base, id: 'tag', name: 'old channel', tags: '["channel"]' },
    { ...base, id: 'task', name: 'renamed run', taskKind: 'org', taskId: 't1' },
    { ...base, id: 'ran', name: 'a session an org run used' },
    { ...base, id: 'app', name: 'App · Jong' },
    { ...base, id: 'dm', name: 'Plan the launch' },
    { ...base, id: 'tg', name: 'Telegram · Jong' },
    { ...base, id: 'promoted', name: 'Write the report', taskKind: 'agent', taskId: 'k1' },
  ]);
  await db.insert(schema.orgRuns).values({ id: 'r1', orgId: 'o1', taskId: 't9', agentId: 'a1', sessionId: 'ran', startedAt: at });
  await q.query(`DELETE FROM __migrations WHERE "id" = '0080-session-kind'`);
  await runPgMigrations(q, { log: () => {} });
  await runPgMigrations(q, { log: () => {} });
  const kinds = Object.fromEntries((await db.select().from(chatSessions)).map((r) => [r.id, r.kind]));
  assert.deepEqual(kinds, { loop: 'work', org: 'work', chan: 'work', tag: 'work', task: 'work', ran: 'work', app: 'work', dm: 'chat', tg: 'chat', promoted: 'chat' });
  // a re-run never undoes a later decision
  await db.update(chatSessions).set({ kind: 'chat' }).where(eq(chatSessions.id, 'loop'));
  await q.query(`DELETE FROM __migrations WHERE "id" = '0080-session-kind'`);
  await runPgMigrations(q, { log: () => {} });
  assert.equal((await db.select().from(chatSessions).where(eq(chatSessions.id, 'loop')))[0].kind, 'work', 'still a loop by its name');
  await pg.close();
});

test('every code path that creates a session states its kind', () => {
  // A source guard: new creation paths must decide chat or work explicitly
  // (the repository falls back to classifySession, but a fallback is not a decision).
  const root = fileURLToPath(new URL('../server/src', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(root);
  const missing: string[] = [];
  let calls = 0;
  for (const f of files) {
    if (f.includes(`${join('server', 'src', 'browser')}`)) continue; // browser sessions are another thing
    const src = readFileSync(f, 'utf8');
    const re = /\.createSession\(\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      calls++;
      // the object literal up to its closing `})`
      const end = src.indexOf('})', m.index);
      const literal = src.slice(m.index, end);
      if (!/\bkind: '(chat|work)'/.test(literal)) missing.push(`${f.slice(root.length + 1)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.ok(calls >= 14, `found ${calls} creation calls`);
  assert.deepEqual(missing, []);
});

async function setup(rounds: AiStreamEvent[][] = []) {
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const chats = new ChatsService(repo, agents);
  const provider = new ScriptedProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const log = new WorkLogService(db, agents);
  const ws = (await workspaces.list())[0];
  const agent = await agents.create({ name: 'Jong', workspaceId: ws.id });
  return { db, stub, agents, workspaces, repo, chats, turns, log, ws, agent, provider };
}
type S = Awaited<ReturnType<typeof setup>>;

test('user-started chats, forks and the owner DM are chats; the owner DM is one stable session per agent', async () => {
  const s = await setup();
  const made = await s.chats.create({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'Loop · ideas I had' });
  assert.equal(made.kind, 'chat', 'what a person starts is a chat, whatever its name');
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'Loop · heartbeat', kind: 'work' });
  const fork = await s.repo.forkSession(loop, null);
  assert.equal(fork.kind, 'chat', 'a fork is a person picking the run up');
  const dm = await s.chats.ownerChatFor(s.agent.id);
  assert.equal(dm.kind, 'chat');
  assert.equal(dm.initiatedBy, '', "the owner's");
  assert.deepEqual(JSON.parse(dm.tags), [OWNER_DM_TAG]);
  assert.equal((await s.chats.ownerChatFor(s.agent.id)).id, dm.id, 'reused');
  await s.chats.archive(dm.id);
  assert.notEqual((await s.chats.ownerChatFor(s.agent.id)).id, dm.id, 'an archived DM is replaced by a live one');
});

test('the rail and the chat pages list chats only; a work approval badges the agent, never a chat row; chat search skips work', async () => {
  const s = await setup();
  const ctl = new ChatsController(s.chats, {} as never, {} as never, {} as never);
  const chat = await s.chats.create({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'Plan the launch' });
  const beat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'Loop · heartbeat', kind: 'work' });
  const run = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'Org · Acme · Close the books', kind: 'work' });
  await s.agents.addEvent(s.agent.id, { kind: 'action_pending', title: 'Send the invoice?', sessionId: run.id });
  const rail = await ctl.rail(s.ws.id);
  const g = rail.groups.find((x) => x.agentId === s.agent.id)!;
  assert.deepEqual(g.items.map((x) => x.id), [chat.id]);
  assert.equal(g.total, 1);
  assert.deepEqual(g.approvalIds, [], 'no chat waits');
  assert.equal(g.work.total, 2);
  assert.deepEqual(g.work.approvalIds, [run.id], 'the agent is badged for the waiting run');
  assert.deepEqual((await ctl.page(s.ws.id, s.agent.id)).items.map((x) => x.id), [chat.id]);
  assert.deepEqual((await ctl.page(s.ws.id)).items.map((x) => x.id), [chat.id]);
  await s.chats.archive(beat.id);
  assert.equal((await ctl.rail(s.ws.id)).archivedTotal, 0, 'an archived run is not an archived chat');
  assert.deepEqual((await ctl.page(s.ws.id, undefined, 'true')).items, []);
  // a search reaches chats, not runs
  assert.deepEqual((await ctl.rail(s.ws.id, undefined, undefined, 'close the books')).groups, []);
  // chat search (FR-8.2) over chats only
  const t1 = await s.repo.createTurn(chat.id, { text: 'zebra plan' });
  await s.repo.appendMessage({ sessionId: chat.id, turnId: t1.id, role: 'user', content: 'zebra plan for launch' });
  const t2 = await s.repo.createTurn(run.id, { text: 'zebra books' });
  await s.repo.appendMessage({ sessionId: run.id, turnId: t2.id, role: 'user', content: 'zebra books for october' });
  const hits = await new SearchService(s.db, s.stub).search(s.ws.id, 'zebra');
  assert.deepEqual([...new Set(hits.messages.map((m) => m.sessionId))], [chat.id]);
  assert.deepEqual((await new SearchService(s.db, s.stub).search(s.ws.id, 'Close the books')).sessions, []);
});

test('a turn keeps its thinking on the transcript as thinking rows, out of provider history', async () => {
  const s = await setup([[{ type: 'thinking', text: 'The user wants ' }, { type: 'thinking', text: 'a haiku.' }, { type: 'answer', text: 'Here it is.' }, { type: 'done' }], [{ type: 'answer', text: 'Again.' }, { type: 'done' }]]);
  const chat = await s.chats.create({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'poem' });
  const drain = async (text: string) => { const evs: unknown[] = []; for await (const ev of s.turns.run(chat.id, { text })) evs.push(ev); return evs; };
  await drain('write a haiku');
  const msgs = await s.repo.listMessages(chat.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'thinking', 'assistant']);
  assert.equal(msgs[1].content, 'The user wants a haiku.');
  const history = await s.repo.providerHistory(chat.id, null);
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant']);
  await drain('again');
  assert.ok(!JSON.stringify(s.provider.requests[1].messages).includes('a haiku.'), 'thinking never goes back to the model');
});

/** A work session with one run written straight to the store: a prompt,
 *  thinking, tool calls (with inputs and outputs) and an answer. */
async function runIn(s: S, sessionId: string, opts: { input: string; at: string; status?: string; thinking?: string; tools?: Array<{ tool: string; input: Record<string, unknown>; result: string; isError?: boolean }>; answer?: string; tokens?: [number, number] }) {
  const turn = await s.repo.createTurn(sessionId, { text: opts.input, model: 'claude-sonnet-4-5' });
  await s.repo.appendMessage({ sessionId, turnId: turn.id, role: 'user', content: opts.input });
  if (opts.thinking) await s.repo.appendMessage({ sessionId, turnId: turn.id, role: 'thinking', content: opts.thinking });
  for (const t of opts.tools ?? []) await s.repo.appendMessage({ sessionId, turnId: turn.id, role: 'tool', content: t.result, toolName: t.tool });
  if (opts.answer) await s.repo.appendMessage({ sessionId, turnId: turn.id, role: 'assistant', content: opts.answer });
  await s.db.update(chatTurns).set({
    status: opts.status ?? 'done', createdAt: opts.at, tokensIn: opts.tokens?.[0] ?? 1000, tokensOut: opts.tokens?.[1] ?? 200,
    toolCalls: JSON.stringify((opts.tools ?? []).map((t) => ({ tool: t.tool, input: t.input, result: t.result, approved: 'allow-once', isError: t.isError === true }))),
    error: opts.status === 'error' ? 'provider timed out' : null,
  }).where(eq(chatTurns.id, turn.id));
  return turn;
}

async function workAgent() {
  const s = await setup();
  const mk = (name: string, extra: Partial<typeof chatSessions.$inferInsert> = {}) => s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name, kind: 'work', permissionMode: 'auto', ...extra });
  const beat = await mk('Loop · heartbeat');
  const digest = await mk('Loop · digest');
  const chan = await mk('#general · Jong', { tags: '["channel"]' });
  // an org task with a key, and the run that blocked on it
  await s.db.insert(schema.organizations).values({ id: 'o1', workspaceId: s.ws.id, name: 'Acme', createdAt: '2026-10-01T00:00:00.000Z' });
  await s.db.insert(schema.orgTasks).values({ id: 'task-1', orgId: 'o1', key: 'ENG-12', title: 'Close the books', status: 'blocked', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
  const org = await mk('Org · Acme · Close the books', { taskKind: 'org', taskId: 'task-1' });
  await s.db.insert(schema.orgRuns).values({ id: 'run-1', orgId: 'o1', taskId: 'task-1', agentId: s.agent.id, sessionId: org.id, status: 'done', outcome: 'blocked', usd: 0.42, startedAt: '2026-10-05T09:59:00.000Z' });
  const chat = await s.chats.create({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'Plan the launch' });

  const r = {
    beat1: await runIn(s, beat.id, { input: 'Heartbeat: check the board', at: '2026-10-03T08:00:00.000Z', thinking: 'Nothing urgent; read the inbox first.', tools: [{ tool: 'fs_read', input: { path: 'INBOX.md' }, result: 'empty' }], answer: 'All quiet.' }),
    beat2: await runIn(s, beat.id, { input: 'Heartbeat: check the board', at: '2026-10-04T08:00:00.000Z', status: 'error' }),
    digest: await runIn(s, digest.id, { input: 'Write the weekly digest', at: '2026-10-04T09:00:00.000Z', thinking: 'Collect the week.', tools: [{ tool: 'fs_write', input: { path: 'reports/digest.md', content: '# Digest' }, result: 'wrote reports/digest.md' }, { tool: 'fs_append', input: { path: 'JOURNAL.md', content: 'x' }, result: 'ok' }], answer: 'Digest written to reports/digest.md.' }),
    meeting: await runIn(s, chan.id, { input: 'Round 1 of 3: your one turn. Speak to the current item with meeting_speak', at: '2026-10-05T08:00:00.000Z', tools: [{ tool: 'meeting_speak', input: { text: 'Ship it' }, result: 'posted' }] }),
    wake: await runIn(s, chan.id, { input: '@Jong can you look at the zebra numbers?', at: '2026-10-05T09:00:00.000Z', answer: 'On it.' }),
    task: await runIn(s, org.id, { input: 'Work on ENG-12', at: '2026-10-05T10:00:00.000Z', thinking: 'Missing the bank export.', answer: 'Blocked: need the bank export.' }),
    chat: await runIn(s, chat.id, { input: 'not a run', at: '2026-10-06T10:00:00.000Z', answer: 'hi' }),
  };
  return { ...s, sessions: { beat, digest, chan, org, chat }, r };
}

test('the Work log: runs of work sessions newest first, triggers and outcomes, grouped by trigger', async () => {
  const s = await workAgent();
  const ctl = new WorkLogController(s.log);
  const page = await ctl.list(s.agent.id);
  assert.deepEqual(page.runs.map((x) => x.id), [s.r.task.id, s.r.wake.id, s.r.meeting.id, s.r.digest.id, s.r.beat2.id, s.r.beat1.id], 'chat turns are not runs');
  const by = Object.fromEntries(page.runs.map((x) => [x.id, x]));
  assert.equal(by[s.r.beat1.id].trigger, 'heartbeat');
  assert.equal(by[s.r.beat1.id].label, 'Heartbeat');
  assert.equal(by[s.r.beat2.id].outcome, 'error');
  assert.equal(by[s.r.digest.id].trigger, 'loop');
  assert.equal(by[s.r.digest.id].label, 'Loop · digest');
  assert.deepEqual(by[s.r.digest.id].files, [{ path: 'reports/digest.md', op: 'write' }, { path: 'JOURNAL.md', op: 'append' }]);
  assert.equal(by[s.r.digest.id].steps, 3, 'two tool calls and a thinking block');
  assert.deepEqual(by[s.r.digest.id].tools, ['fs_write', 'fs_append']);
  assert.ok(by[s.r.digest.id].usd! > 0, 'priced at the model list price');
  assert.equal(by[s.r.meeting.id].trigger, 'meeting');
  assert.equal(by[s.r.meeting.id].label, 'Meeting · #general');
  assert.equal(by[s.r.wake.id].trigger, 'channel');
  assert.equal(by[s.r.wake.id].label, '#general');
  const task = by[s.r.task.id];
  assert.equal(task.trigger, 'task');
  assert.equal(task.label, 'ENG-12 Close the books');
  assert.equal(task.outcome, 'blocked', "the org run's outcome");
  assert.equal(task.usd, 0.42, "the org run's settled cost");
  assert.deepEqual(task.task, { kind: 'org', id: 'task-1', key: 'ENG-12', title: 'Close the books' });
  assert.equal(task.answer, 'Blocked: need the bank export.');
  const groups = Object.fromEntries(page.groups.map((g) => [`${g.trigger}:${g.key}`, g.count]));
  assert.deepEqual(groups, { 'task:ENG-12': 1, 'channel:#general': 1, 'meeting:#general': 1, 'loop:digest': 1, 'heartbeat:': 2 });
  assert.equal(page.groups[0].trigger, 'task', 'newest group first');
  assert.equal(labelOf('org', 'Org · Acme · Planning · Eng', null, null), 'Acme · Planning · Eng');
});

test('the Work log filters by trigger and key, outcome, task key, date and search, and pages by cursor', async () => {
  const s = await workAgent();
  const ctl = new WorkLogController(s.log);
  const ids = async (...args: Parameters<WorkLogController['list']> extends [string, ...infer R] ? R : never) => (await ctl.list(s.agent.id, ...args)).runs.map((x) => x.id);
  assert.deepEqual(await ids('heartbeat'), [s.r.beat2.id, s.r.beat1.id]);
  assert.deepEqual(await ids('loop', 'digest'), [s.r.digest.id]);
  assert.deepEqual(await ids('loop', 'other'), []);
  assert.deepEqual(await ids(undefined, undefined, 'error'), [s.r.beat2.id]);
  assert.deepEqual(await ids(undefined, undefined, 'blocked'), [s.r.task.id]);
  assert.deepEqual(await ids(undefined, undefined, undefined, 'eng-12'), [s.r.task.id], 'a task by key, any case');
  assert.deepEqual(await ids(undefined, undefined, undefined, 'task-1'), [s.r.task.id], 'or by id');
  assert.deepEqual(await ids(undefined, undefined, undefined, undefined, s.sessions.chan.id), [s.r.wake.id, s.r.meeting.id], 'one session');
  assert.deepEqual(await ids(undefined, undefined, undefined, undefined, undefined, '2026-10-04', '2026-10-04'), [s.r.digest.id, s.r.beat2.id], 'a whole day');
  assert.deepEqual(await ids(undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'bank export'), [s.r.task.id], 'search reaches thinking and answers');
  assert.deepEqual(await ids(undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'zebra'), [s.r.wake.id], 'and prompts');
  assert.deepEqual(await ids(undefined, undefined, undefined, undefined, undefined, undefined, undefined, '%'), [], 'LIKE wildcards are literal');
  // the chips keep every trigger under the other filters
  const filtered = await ctl.list(s.agent.id, 'heartbeat', undefined, 'error');
  assert.deepEqual(filtered.groups.map((g) => g.trigger), ['heartbeat']);
  // paging: no duplicates, same order, a malformed cursor is the first page
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const p = await ctl.list(s.agent.id, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, '2', cursor ?? undefined);
    seen.push(...p.runs.map((x) => x.id));
    cursor = p.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, (await ctl.list(s.agent.id)).runs.map((x) => x.id));
  assert.equal((await ctl.list(s.agent.id, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, '1', 'garbage')).runs[0].id, s.r.task.id);
});

test('a Work log run in full: thinking, tool calls with inputs and outputs, files, the task; a session deep link finds its newest run', async () => {
  const s = await workAgent();
  const ctl = new WorkLogController(s.log);
  const run = await ctl.run(s.agent.id, s.r.digest.id);
  assert.deepEqual(run.messages.map((m) => m.role), ['user', 'thinking', 'tool', 'tool', 'assistant']);
  assert.equal(run.messages[1].content, 'Collect the week.');
  assert.deepEqual(run.toolCalls.map((c) => [c.tool, (c.input as { path: string }).path, c.result]), [['fs_write', 'reports/digest.md', 'wrote reports/digest.md'], ['fs_append', 'JOURNAL.md', 'ok']]);
  assert.equal(run.tokensIn, 1000);
  assert.equal((await ctl.run(s.agent.id, s.r.task.id)).task!.key, 'ENG-12');
  // a chat turn of the agent opens too (links never 404 on the kind); another agent's run does not
  assert.equal((await ctl.run(s.agent.id, s.r.chat.id)).id, s.r.chat.id);
  const other = await s.agents.create({ name: 'Mai', workspaceId: s.ws.id });
  await assert.rejects(ctl.run(other.id, s.r.digest.id), /run/);
  assert.deepEqual(await ctl.latest(s.agent.id, s.sessions.beat.id), { turnId: s.r.beat2.id });
  assert.deepEqual(await ctl.latest(other.id, s.sessions.beat.id), { turnId: null });
});
