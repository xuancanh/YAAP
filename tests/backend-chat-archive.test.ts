/** Auto-archive of finished-task chats and the paged rail
 *  (docs/chat-archiving.md): the sweep and each of its exclusions, the
 *  `set_chat_auto_archive` tool (own chats only, null = off, classed read and
 *  free), the defaults (workspace tunable → agent default → chat) and their
 *  inheritance on promote, the migration's backfill of org task sessions,
 *  and the rail's pagination, loop folding, channel exclusion and search. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../server/src/database/schema';
import { actionLog, agentEvents, agentTasks, chatSessions, organizations } from '../server/src/database/schema';
import { runPgMigrations } from '../server/src/database/migrator';
import { scopeDb } from '../server/src/accounts/scoped-db';
import type { DrizzleDb } from '../server/src/database/database.module';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, pgliteQueryable, ScriptedProvider } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { ChatsController } from '../server/src/chats/chats.controller';
import { TurnLoopService, type TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { ChatArchiveService, CHAT_ARCHIVE_TOOLS } from '../server/src/chats/chat-archive.service';
import { CHAT_ARCHIVE_TUNABLES } from '../server/src/chats/chat-archive-tunables';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { classOf, runsFreely, unclassified } from '../server/src/actions/action-classes';
import { TUNABLES } from '../server/src/org/org-tunables';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** A turn-loop stand-in: which chats are running or waiting on an approval. */
function turnsStub() {
  const busy = new Set<string>();
  const pending = new Set<string>();
  const turns = { isBusy: (id: string) => busy.has(id), hasPendingApproval: (id: string) => pending.has(id), addToolProvider: () => () => undefined } as unknown as TurnLoopService;
  return { turns, busy, pending };
}

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const t = turnsStub();
  const archive = new ChatArchiveService(db, repo, t.turns, agents);
  const chats = new ChatsService(repo, agents);
  const ws = (await workspaces.list())[0];
  const agent = await agents.create({ name: 'Jong', workspaceId: ws.id });
  return { db, stub, agents, workspaces, repo, archive, chats, ws, agent, ...t };
}
type S = Awaited<ReturnType<typeof setup>>;

/** A kanban task in `status`, last changed `finished` days ago, and its chat, quiet for `quiet` days. */
async function taskChat(s: S, opts: { status?: string; finished?: number; quiet?: number; days?: number | null; name?: string; agentId?: string } = {}) {
  const agentId = opts.agentId ?? s.agent.id;
  const task = await s.agents.addTask(agentId, { title: opts.name ?? 'Write the report' });
  await s.db.update(agentTasks).set({ status: opts.status ?? 'done', updatedAt: daysAgo(opts.finished ?? 10) }).where(eq(agentTasks.id, task.id));
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId, name: opts.name ?? 'Write the report', taskKind: 'agent', taskId: task.id, autoArchiveDays: opts.days === undefined ? null : opts.days });
  await s.db.update(chatSessions).set({ updatedAt: daysAgo(opts.quiet ?? 10) }).where(eq(chatSessions.id, chat.id));
  return { task, chat };
}

const archivedAt = async (s: S, id: string) => (await s.repo.getSession(id))?.archivedAt ?? null;

test('the sweep archives a quiet chat whose task finished more than the workspace default ago, and says so in the inbox', async () => {
  const s = await setup();
  const { chat } = await taskChat(s);
  const res = await s.archive.sweep(NOW);
  assert.deepEqual(res.archived.map((a) => a.id), [chat.id]);
  assert.ok(await archivedAt(s, chat.id));
  const events = await s.db.select().from(agentEvents).where(eq(agentEvents.agentId, s.agent.id));
  const ev = events.find((e) => e.title === 'Archived 1 finished-task chat');
  assert.ok(ev, 'one explainable event');
  assert.match(ev!.body, /Write the report/);
  assert.ok(ev!.readAt, 'housekeeping: read, no badge');
  // restorable as today, and a restore starts the quiet window again
  await s.chats.restore(chat.id);
  assert.equal(await archivedAt(s, chat.id), null);
  const again = await s.archive.sweep(new Date());
  assert.equal(again.archived.length, 0, 'a restored chat is not swept straight back');
});

test('the sweep leaves every excluded chat alone', async () => {
  const s = await setup();
  const base = await taskChat(s, { name: 'archives' });
  const open = await taskChat(s, { name: 'open task', status: 'doing' });
  const blocked = await taskChat(s, { name: 'blocked task', status: 'blocked' });
  const recentTask = await taskChat(s, { name: 'finished yesterday', finished: 2 });
  const recentChat = await taskChat(s, { name: 'still talking', quiet: 2 });
  const pinned = await taskChat(s, { name: 'pinned' });
  await s.db.update(chatSessions).set({ pinned: 1 }).where(eq(chatSessions.id, pinned.chat.id));
  const off = await taskChat(s, { name: 'off', days: 0 });
  const running = await taskChat(s, { name: 'running' });
  s.busy.add(running.chat.id);
  const live = await taskChat(s, { name: 'live approval' });
  s.pending.add(live.chat.id);
  const queued = await taskChat(s, { name: 'queued approval' });
  await s.agents.addEvent(s.agent.id, { kind: 'action_pending', title: 'Send the mail?', sessionId: queued.chat.id });
  const held = await taskChat(s, { name: 'held action' });
  await s.db.insert(actionLog).values({ id: 'al1', key: 'k1', workspaceId: s.ws.id, agentId: s.agent.id, sessionId: held.chat.id, tool: 'gmail_send', class: 'external_irreversible', inputHash: 'h', status: 'held', createdAt: daysAgo(9) });
  const unread = await taskChat(s, { name: 'unread' });
  const ev = await s.agents.addEvent(s.agent.id, { kind: 'loop_run', title: 'Done', sessionId: unread.chat.id });
  await s.db.update(agentEvents).set({ createdAt: new Date(NOW.getTime() - 3_600_000).toISOString() }).where(eq(agentEvents.id, ev.id));
  const oldUnread = await taskChat(s, { name: 'old unread' });
  const ev2 = await s.agents.addEvent(s.agent.id, { kind: 'loop_run', title: 'Done', sessionId: oldUnread.chat.id });
  await s.db.update(agentEvents).set({ createdAt: daysAgo(5) }).where(eq(agentEvents.id, ev2.id));
  const unlinked = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'no task' });
  await s.db.update(chatSessions).set({ updatedAt: daysAgo(60) }).where(eq(chatSessions.id, unlinked.id));

  const res = await s.archive.sweep(NOW);
  assert.deepEqual(new Set(res.archived.map((a) => a.id)), new Set([base.chat.id, oldUnread.chat.id]), 'only the plain one and the one whose unread event is older than the window');
  for (const kept of [open, blocked, recentTask, recentChat, pinned, off, running, live, queued, held, unread]) assert.equal(await archivedAt(s, kept.chat.id), null, kept.chat.name);
  assert.equal(await archivedAt(s, unlinked.id), null, 'a chat with no task is never swept');
  assert.equal(res.skipped.task_open, 2);
  assert.equal(res.skipped.task_recent, 1);
  assert.equal(res.skipped.recent, 1);
  assert.equal(res.skipped.pinned, 1);
  assert.equal(res.skipped.running, 1);
  assert.equal(res.skipped.approval, 3);
  assert.equal(res.skipped.unread, 1);
  // the off chat never reaches the loop (filtered in SQL)
  assert.ok(!res.skipped.off);
  // the queued approval decided: next sweep archives it
  await s.db.update(agentEvents).set({ kind: 'action_done', readAt: NOW.toISOString() }).where(eq(agentEvents.sessionId, queued.chat.id));
  s.busy.clear();
  const res2 = await s.archive.sweep(NOW);
  assert.ok(res2.archived.some((a) => a.id === queued.chat.id));
  assert.ok(res2.archived.some((a) => a.id === running.chat.id));
  const evs = await s.db.select().from(agentEvents).where(eq(agentEvents.agentId, s.agent.id));
  assert.ok(evs.some((e) => e.title === 'Archived 2 finished-task chats'));
});

test('org tasks: done and cancelled finish a chat, in_review does not; a deleted task counts as finished', async () => {
  const s = await setup();
  await s.db.insert(organizations).values({ id: 'o1', workspaceId: s.ws.id, name: 'Acme', createdAt: daysAgo(30) });
  const mk = async (id: string, status: string) => {
    await s.db.insert(schema.orgTasks).values({ id, orgId: 'o1', title: id, status, createdAt: daysAgo(30), updatedAt: daysAgo(10) });
    const c = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: `Org · Acme · ${id}`, taskKind: 'org', taskId: id });
    await s.db.update(chatSessions).set({ updatedAt: daysAgo(10) }).where(eq(chatSessions.id, c.id));
    return c;
  };
  const done = await mk('t-done', 'done');
  const cancelled = await mk('t-cancelled', 'cancelled');
  const review = await mk('t-review', 'in_review');
  const gone = await taskChat(s, { name: 'deleted' });
  await s.db.delete(agentTasks).where(eq(agentTasks.id, gone.task.id));
  const res = await s.archive.sweep(NOW);
  assert.deepEqual(new Set(res.archived.map((a) => a.id)), new Set([done.id, cancelled.id, gone.chat.id]));
  assert.equal(await archivedAt(s, review.id), null);
});

test('defaults: the workspace tunable, the agent default and the chat setting, inherited on promote', async () => {
  for (const k of Object.keys(CHAT_ARCHIVE_TUNABLES)) assert.ok(TUNABLES[k], `${k} is registered`);
  assert.equal(TUNABLES['chat.autoArchiveDays'].default, 7);
  const s = await setup();
  // 5 days after: the default 7 keeps it; the workspace at 3 archives it
  const { chat } = await taskChat(s, { finished: 5, quiet: 5 });
  assert.equal((await s.archive.sweep(NOW)).archived.length, 0);
  await s.db.insert(organizations).values({ id: 'o1', workspaceId: s.ws.id, name: 'Acme', createdAt: daysAgo(30), tunables: JSON.stringify({ 'chat.autoArchiveDays': 3 }) });
  assert.equal(await s.archive.workspaceDays(s.ws.id), 3);
  assert.equal((await s.archive.sweep(NOW)).archived[0]?.id, chat.id);
  // the workspace at 0: off for chats that follow it, not for a chat with its own days
  await s.db.update(organizations).set({ tunables: JSON.stringify({ 'chat.autoArchiveDays': 0 }) }).where(eq(organizations.id, 'o1'));
  const follows = await taskChat(s, { name: 'follows workspace' });
  const own = await taskChat(s, { name: 'own days', days: 2 });
  const res = await s.archive.sweep(NOW);
  assert.deepEqual(res.archived.map((a) => a.id), [own.chat.id]);
  assert.equal(await archivedAt(s, follows.chat.id), null);

  // the agent's default rides onto a task chat made by promote
  await assert.rejects(() => s.agents.update(s.agent.id, { chatAutoArchiveDays: 400 }), /0–365/);
  await s.agents.update(s.agent.id, { chatAutoArchiveDays: 14 });
  assert.equal((await s.agents.get(s.agent.id)).chatAutoArchiveDays, 14);
  const talk = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'talk' });
  const turn = await s.repo.createTurn(talk.id, { text: 'Draft the Q4 plan' });
  const handoff = await s.chats.promoteTurn(talk.id, turn.id);
  const linked = (await s.repo.getSession(talk.id))!;
  assert.equal(linked.taskKind, 'agent');
  assert.equal(linked.taskId, handoff.taskId);
  assert.equal(linked.autoArchiveDays, 14, 'inherits the agent default at link time');
  // a second promote does not re-link
  const turn2 = await s.repo.createTurn(talk.id, { text: 'And the Q1 plan' });
  await s.chats.promoteTurn(talk.id, turn2.id);
  assert.equal((await s.repo.getSession(talk.id))!.taskId, handoff.taskId);
  // the runtime's helper for new task chats
  assert.deepEqual(await s.archive.taskChatFields(s.agent.id, 'org', 't1'), { taskKind: 'org', taskId: 't1', autoArchiveDays: 14 });
  await s.agents.update(s.agent.id, { chatAutoArchiveDays: null });
  assert.equal((await s.archive.taskChatFields(s.agent.id, 'org', 't1')).autoArchiveDays, null, 'null: follow the workspace');
  // the chat header writes the chat's own setting
  const patched = await s.chats.update(talk.id, { autoArchiveDays: 3 });
  assert.equal(patched.autoArchiveDays, 3);
});

test('set_chat_auto_archive: own chats only, null = off, "default" follows the workspace, taskId links', async () => {
  const s = await setup();
  const { chat, task } = await taskChat(s, { quiet: 0, finished: 0 });
  const r1 = await s.archive.setFor(chat, { days: 3 });
  assert.match(r1, /3 days after its task is finished/);
  assert.equal((await s.repo.getSession(chat.id))!.autoArchiveDays, 3);
  const r2 = await s.archive.setFor(chat, { days: null });
  assert.match(r2, /: off\./);
  assert.equal((await s.repo.getSession(chat.id))!.autoArchiveDays, 0, 'null = off');
  await s.archive.setFor(chat, { days: 'default' });
  assert.equal((await s.repo.getSession(chat.id))!.autoArchiveDays, null);
  await assert.rejects(() => s.archive.setFor(chat, { days: -2 }), /whole number/);
  // another agent's chat, by id or from another session
  const other = await s.agents.create({ name: 'Mai', workspaceId: s.ws.id });
  const theirs = await s.repo.createSession({ workspaceId: s.ws.id, agentId: other.id, name: 'theirs' });
  await assert.rejects(() => s.archive.setFor(chat, { chatId: theirs.id, days: 1 }), /not one of your chats/);
  const direct = await s.repo.createSession({ workspaceId: s.ws.id, agentId: null, name: 'no agent' });
  await assert.rejects(() => s.archive.setFor(chat, { chatId: direct.id, days: 1 }), /not one of your chats/);
  assert.equal((await s.repo.getSession(theirs.id))!.autoArchiveDays, null, 'untouched');
  // a chat of mine named by id; linking a task
  const mine = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'side chat' });
  const r3 = await s.archive.setFor(chat, { chatId: mine.id, days: 5, taskId: task.id.slice(0, 8) });
  assert.match(r3, /Linked to task/);
  const after = (await s.repo.getSession(mine.id))!;
  assert.equal(after.taskId, task.id);
  assert.equal(after.autoArchiveDays, 5);
  assert.match(await s.archive.setFor(mine, { days: 1, chatId: (await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'x' })).id }), /not linked to a task yet/);
  await assert.rejects(() => s.archive.setFor(chat, { days: 1, taskId: 'zzzzzzzz' }), /no task of yours/);
});

test('set_chat_auto_archive is classed read, runs freely and needs no approval in an Ask-mode chat', async () => {
  for (const spec of CHAT_ARCHIVE_TOOLS) { assert.equal(classOf(spec.name), 'read'); assert.ok(runsFreely(spec.name)); }
  assert.deepEqual(unclassified(CHAT_ARCHIVE_TOOLS.map((t) => t.name)), []);
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const call: AiStreamEvent[] = [{ type: 'tool_call', id: 'c1', name: 'set_chat_auto_archive', input: { days: null } }, { type: 'done' }];
  const provider = new ScriptedProvider([call, [{ type: 'answer', text: 'ok' }, { type: 'done' }]]);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  new ChatArchiveService(db, repo, turns, agents).onModuleInit();
  const ws = (await workspaces.list())[0];
  const a = await agents.create({ name: 'Jong', workspaceId: ws.id });
  const session = await repo.createSession({ workspaceId: ws.id, agentId: a.id, name: 'chat' });
  assert.equal(session.permissionMode, 'ask');
  const evs: TurnEvent[] = [];
  for await (const ev of turns.run(session.id, { text: 'keep this chat' })) evs.push(ev);
  assert.equal(evs.some((e) => e.type === 'approval_required'), false);
  const r = evs.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }>;
  assert.equal(r.isError, false);
  assert.equal((await repo.getSession(session.id))!.autoArchiveDays, 0);
  assert.ok(provider.requests[0].tools?.some((t) => t.name === 'set_chat_auto_archive'), 'offered to agent chats');
});

test('migration 0051 links existing per-task org sessions to their task and is idempotent', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  const db = scopeDb(drizzle(pg, { schema }) as unknown as DrizzleDb);
  const at = daysAgo(3);
  await db.insert(organizations).values({ id: 'o1', workspaceId: 'w1', name: 'Acme', createdAt: at });
  const longTitle = 'Close the books for October and reconcile every account';
  await db.insert(schema.orgTasks).values([{ id: 't1', orgId: 'o1', title: longTitle, status: 'done', createdAt: at, updatedAt: at }, { id: 't2', orgId: 'o1', title: 'Other', createdAt: at, updatedAt: at }]);
  const base = { workspaceId: 'w1', agentId: 'a1', createdAt: at, updatedAt: at };
  await db.insert(chatSessions).values([
    { ...base, id: 's1', name: `Org · Acme · ${longTitle.slice(0, 48)}` },
    { ...base, id: 's2', name: 'Org · Acme · Chief review' },
  ]);
  await db.insert(schema.orgRuns).values([
    { id: 'r1', orgId: 'o1', taskId: 't1', agentId: 'a1', sessionId: 's1', startedAt: at },
    { id: 'r2', orgId: 'o1', taskId: 't2', agentId: 'a1', sessionId: 's2', startedAt: at },
  ]);
  await q.query(`DELETE FROM __migrations WHERE "id" = '0051-chat-auto-archive'`);
  await runPgMigrations(q, { log: () => {} });
  await runPgMigrations(q, { log: () => {} });
  const rows = await db.select().from(chatSessions);
  const s1 = rows.find((r) => r.id === 's1')!;
  assert.equal(s1.taskKind, 'org');
  assert.equal(s1.taskId, 't1');
  assert.equal(s1.autoArchiveDays, null, 'follows the workspace default');
  assert.equal(rows.find((r) => r.id === 's2')!.taskId, null, 'a task-free session is not linked by a stray run');
});

test('the rail: per-agent first page, cursor pages, work sessions (loops, channel sessions) out of the chat rows, search reaches every chat', async () => {
  const s = await setup();
  const ctl = new ChatsController(s.chats, {} as never, {} as never, {} as never);
  const mk = async (name: string, minutes: number, extra: Partial<typeof chatSessions.$inferInsert> = {}) => {
    const c = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name, ...extra });
    await s.db.update(chatSessions).set({ updatedAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(), ...(extra.pinned ? { pinned: 1 } : {}), ...(extra.tags ? { tags: extra.tags } : {}) }).where(eq(chatSessions.id, c.id));
    return c;
  };
  for (let i = 0; i < 12; i++) await mk(`Chat ${i}`, i + 10);
  const pinned = await mk('Old but pinned', 10_000, { pinned: 1 });
  await mk('Loop · heartbeat', 1);
  await mk('Loop · digest', 2);
  await mk('#general · Jong', 3);
  await mk('tagged', 4, { tags: '["channel"]' });
  const direct = await s.repo.createSession({ workspaceId: s.ws.id, agentId: null, name: 'Scratch' });
  const gone = await mk('Archived one', 50);
  await s.chats.archive(gone.id);

  const waiting = await mk('Needs a yes', 5_000);
  await s.agents.addEvent(s.agent.id, { kind: 'action_pending', title: 'Send it?', sessionId: waiting.id });
  await s.chats.archive(waiting.id);
  await s.chats.restore(waiting.id);
  await s.db.update(chatSessions).set({ updatedAt: new Date(NOW.getTime() - 5_000 * 60_000).toISOString() }).where(eq(chatSessions.id, waiting.id));
  const rail = await ctl.rail(s.ws.id);
  assert.deepEqual(rail.groups.find((x) => x.agentId === s.agent.id)!.approvalIds, [waiting.id], 'chats waiting on an approval');
  const g = rail.groups.find((x) => x.agentId === s.agent.id)!;
  assert.equal(g.total, 14, '12 chats + the pinned one + the waiting one; loops and channel sessions not counted');
  assert.deepEqual(g.items.map((c) => c.name), ['Old but pinned', 'Chat 0', 'Chat 1', 'Chat 2', 'Chat 3']);
  assert.ok(g.nextCursor);
  assert.equal(g.work.total, 4, 'two loops and two channel working sessions: the agent work, read in its Work log');
  assert.deepEqual(g.work.approvalIds, []);
  assert.equal('loops' in g, false, 'no Heartbeat runs row any more');
  assert.equal(rail.groups.find((x) => x.agentId === null)!.items[0].id, direct.id);
  assert.equal(rail.archivedTotal, 1);

  // Show more: cursor pages until the end, no duplicates, same order
  const seen = g.items.map((c) => c.id);
  let cursor = g.nextCursor;
  while (cursor) {
    const page = await ctl.page(s.ws.id, s.agent.id, undefined, undefined, '5', cursor);
    seen.push(...page.items.map((c) => c.id));
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 14);
  assert.equal(new Set(seen).size, 14);
  assert.equal(seen[0], pinned.id);
  // the rail keeps a group's loaded count on refresh
  const wider = await ctl.rail(s.ws.id, undefined, `${s.agent.id}:9`);
  assert.equal(wider.groups.find((x) => x.agentId === s.agent.id)!.items.length, 9);
  // search reaches a chat beyond the first page; LIKE wildcards are literal
  const hit = await ctl.rail(s.ws.id, undefined, undefined, 'chat 11');
  const hg = hit.groups.find((x) => x.agentId === s.agent.id)!;
  assert.deepEqual(hg.items.map((c) => c.name), ['Chat 11']);
  assert.equal(hg.total, 1);
  assert.equal((await ctl.rail(s.ws.id, undefined, undefined, '%')).groups.length, 0);
  // the archive pages the same way; the agent-less group by 'none'
  assert.deepEqual((await ctl.page(s.ws.id, undefined, 'true')).items.map((c) => c.id), [gone.id]);
  assert.deepEqual((await ctl.page(s.ws.id, 'none')).items.map((c) => c.id), [direct.id]);
  // a malformed cursor reads as the first page
  assert.equal((await ctl.page(s.ws.id, s.agent.id, undefined, undefined, '3', 'garbage')).items[0].id, pinned.id);
});
