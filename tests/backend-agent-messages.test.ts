/** Agents message the owner directly (docs/agent-messages.md): the owner DM
 *  helper (created once, reused, never a working session), message_owner
 *  (agent-authored row, inbox event, quiet hours per urgency, the daily cap,
 *  dedupe, refusing from the DM itself, free internal class), the Inbox's
 *  Messages list and read marking, Home's "Messages from your team", and the
 *  owner's reply continuing the conversation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { agentEvents, chatMessages, organizations, workspaces as workspacesT } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService, AGENT_INITIATED_MARKER, type TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { OwnerMessagesService, MESSAGE_OWNER_SPECS, AGENT_MESSAGE_TUNABLES } from '../server/src/chats/owner-messages.service';
import { ownerDmSession, isWorkingSession, isOwnerDm, OWNER_DM_TAG } from '../server/src/chats/owner-dm';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { HomeService } from '../server/src/home/home.service';
import { InboxMessagesController } from '../server/src/home/inbox-messages.controller';
import { classOf, runsFreely, unclassified } from '../server/src/actions/action-classes';
import { TUNABLES } from '../server/src/org/org-tunables';
import { ruleFor } from '../server/src/org/boundary';
import { runWithViewer, currentAccountId } from '../server/src/accounts/account-context';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const svc = new OwnerMessagesService(db, repo, agents);
  const ws = (await workspaces.list())[0];
  const agent = await agents.create({ name: 'Penny', workspaceId: ws.id });
  const beat = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'Loop · heartbeat', permissionMode: 'auto' });
  return { db, stub, agents, workspaces, repo, svc, ws, agent, beat };
}
type S = Awaited<ReturnType<typeof setup>>;

const events = (s: S) => s.db.select().from(agentEvents).where(eq(agentEvents.kind, 'agent_message'));
/** A quiet window around the real current time, in UTC. */
function quietNow(policy: 'queue' | 'silent' | 'allow-urgent') {
  const h = new Date().getUTCHours();
  const pad = (n: number) => String((n + 24) % 24).padStart(2, '0');
  return JSON.stringify({ start: `${pad(h - 1)}:00`, end: `${pad(h + 2)}:00`, timezone: 'UTC', policy });
}

test('the owner DM: created once, tagged, owner-private, reused; working sessions never qualify', async () => {
  const s = await setup();
  assert.equal(await ownerDmSession(s.repo, { id: s.agent.id, workspaceId: s.ws.id }), null, 'none until asked to create');
  // A heartbeat, an org run, a channel wake and a task chat are working sessions.
  for (const name of ['Loop · heartbeat', 'Org · Acme · Planning', '#general · Penny', 'Eval · 1']) assert.equal(isWorkingSession({ name, tags: '[]', taskId: null }), true, name);
  assert.equal(isWorkingSession({ name: 'Plan the launch', tags: '[]', taskId: 't1' }), true, 'a task chat');
  assert.equal(isWorkingSession({ name: 'Plan the launch', tags: '[]', taskId: null }), false);
  // A working session wrongly tagged owner-dm is still not the DM.
  await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'Loop · other', tags: JSON.stringify([OWNER_DM_TAG]) });
  const dm = await ownerDmSession(s.repo, { id: s.agent.id, workspaceId: s.ws.id }, { create: true });
  assert.ok(dm);
  assert.equal(isOwnerDm(dm!), true);
  assert.equal(dm!.name, 'Direct messages');
  assert.equal(dm!.shared, 0);
  assert.equal(dm!.initiatedBy, '');
  assert.equal(dm!.permissionMode, 'ask');
  const again = await ownerDmSession(s.repo, { id: s.agent.id, workspaceId: s.ws.id }, { create: true });
  assert.equal(again!.id, dm!.id, 'reused');
});

test('message_owner posts an agent-authored message into the DM (created if missing) and notifies the owner', async () => {
  const s = await setup();
  const r = await s.svc.send(s.beat, { text: 'The launch slipped a day.\nThe vendor missed the build.', refs: ['OPS-12', '/org/launch.md'] });
  assert.equal(r.delivery, 'now');
  assert.match(r.summary, /Sent to the owner/);
  const dm = (await s.repo.getSession(r.sessionId))!;
  assert.equal(isOwnerDm(dm), true);
  assert.notEqual(dm.id, s.beat.id, 'never the heartbeat session');
  const msgs = await s.repo.listMessages(dm.id);
  assert.equal(msgs.length, 1, 'no owner message is invented');
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[0].toolName, 'message_owner');
  assert.equal(msgs[0].authorAccountId, '');
  assert.match(msgs[0].content, /Refs: OPS-12, \/org\/launch\.md$/);
  const turn = (await s.repo.listTurns(dm.id))[0];
  assert.equal(turn.input, '');
  assert.equal(turn.status, 'done');
  const [ev] = await events(s);
  assert.equal(ev.agentId, s.agent.id);
  assert.equal(ev.sessionId, dm.id);
  assert.equal(ev.title, 'The launch slipped a day.');
  assert.equal(ev.channel, 1, 'pushed to the paired channel even for a non-default agent');
  assert.equal(ev.silent, 0);
  assert.equal(ev.readAt, null);
  assert.deepEqual(JSON.parse(ev.payload), { urgency: 'normal', refs: ['OPS-12', '/org/launch.md'], messageId: msgs[0].id });
  // The next message reuses the DM.
  const r2 = await s.svc.send(s.beat, { text: 'Fixed.' });
  assert.equal(r2.sessionId, dm.id);
  // Refusals: empty text, a bad urgency, and the DM itself.
  await assert.rejects(() => s.svc.send(s.beat, { text: '  ' }), /text is required/);
  await assert.rejects(() => s.svc.send(s.beat, { text: 'x', urgency: 'panic' }), /urgency must be one of/);
  await assert.rejects(() => s.svc.send(dm, { text: 'hello' }), /already in your direct chat/);
});

test('quiet hours: fyi is inbox-only; normal is queued; urgent goes now only when the workspace allows urgent', async () => {
  const s = await setup();
  await s.db.update(workspacesT).set({ quietHours: quietNow('queue') }).where(eq(workspacesT.id, s.ws.id));
  assert.equal((await s.svc.send(s.beat, { text: 'fyi note', urgency: 'fyi' })).delivery, 'inbox');
  assert.equal((await s.svc.send(s.beat, { text: 'normal note' })).delivery, 'queued');
  assert.equal((await s.svc.send(s.beat, { text: 'urgent but queue policy', urgency: 'urgent' })).delivery, 'queued', 'queue policy holds urgent too');
  await s.db.update(workspacesT).set({ quietHours: quietNow('allow-urgent') }).where(eq(workspacesT.id, s.ws.id));
  assert.equal((await s.svc.send(s.beat, { text: 'the site is down', urgency: 'urgent' })).delivery, 'now');
  assert.equal((await s.svc.send(s.beat, { text: 'normal under allow-urgent' })).delivery, 'queued');
  await s.db.update(workspacesT).set({ quietHours: quietNow('silent') }).where(eq(workspacesT.id, s.ws.id));
  assert.equal((await s.svc.send(s.beat, { text: 'urgent under silent', urgency: 'urgent' })).delivery, 'inbox');
  const evs = await events(s);
  const fyi = evs.find((e) => e.body === 'fyi note')!;
  assert.equal(fyi.silent, 1);
  assert.equal(fyi.channel, 0);
  const queued = evs.find((e) => e.body === 'normal note')!;
  assert.ok(queued.deliverAfter && queued.deliverAfter > new Date().toISOString());
  const now = evs.find((e) => e.body === 'the site is down')!;
  assert.equal(now.deliverAfter, null);
  assert.match(now.title, /^Urgent: /);
  // Channels see the urgent one now and not the queued one.
  const deliverable = (await s.agents.undeliveredEvents(new Date(), 'push')).map((e) => e.body);
  assert.ok(deliverable.includes('the site is down'));
  assert.ok(!deliverable.includes('normal note'));
  assert.ok(!deliverable.includes('fyi note'));
});

test('guardrails: the daily cap (a seat tunable) and dedupe of the same text', async () => {
  const s = await setup();
  await s.db.insert(organizations).values({ id: 'o1', workspaceId: s.ws.id, name: 'Acme', createdAt: new Date().toISOString(), tunables: JSON.stringify({ 'seat.agentMessagesPerDay': 3 }) });
  await s.svc.send(s.beat, { text: 'one' });
  await assert.rejects(() => s.svc.send(s.beat, { text: 'One ' }), /same message/, 'normalised text counts as the same');
  await s.svc.send(s.beat, { text: 'one', refs: ['OPS-1'] }); // different refs: a different message
  await s.svc.send(s.beat, { text: 'three' });
  await assert.rejects(() => s.svc.send(s.beat, { text: 'four' }), /3 messages in the last 24 hours, the limit is 3/);
  // The cap is the agent's, not the workspace's.
  const other = await s.agents.create({ name: 'Otto', workspaceId: s.ws.id });
  const otherBeat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: other.id, name: 'Loop · heartbeat' });
  await s.svc.send(otherBeat, { text: 'four' });
  // Messages older than the window do not count.
  await s.db.update(chatMessages).set({ createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }).where(eq(chatMessages.toolName, 'message_owner'));
  await s.svc.send(s.beat, { text: 'one' });
  // 0 turns direct messages off.
  await s.db.update(organizations).set({ tunables: JSON.stringify({ 'seat.agentMessagesPerDay': 0 }) }).where(eq(organizations.id, 'o1'));
  await assert.rejects(() => s.svc.send(s.beat, { text: 'five' }), /turned off/);
  // The keys are the owner's seat: an agent can only propose them.
  for (const k of Object.keys(AGENT_MESSAGE_TUNABLES)) {
    assert.ok(TUNABLES[k]);
    assert.equal(ruleFor({ kind: 'tunable', key: k }).verdict, 'propose');
  }
});

test('message_owner is free internal work: classed, runs freely, and needs no approval in an Ask-mode chat', async () => {
  for (const spec of MESSAGE_OWNER_SPECS) { assert.equal(classOf(spec.name), 'internal_write'); assert.ok(runsFreely(spec.name)); }
  assert.deepEqual(unclassified(MESSAGE_OWNER_SPECS.map((t) => t.name)), []);
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const call: AiStreamEvent[] = [{ type: 'tool_call', id: 'c1', name: 'message_owner', input: { text: 'Need your call on pricing.' } }, { type: 'done' }];
  const provider = new ScriptedProvider([call, [{ type: 'answer', text: 'sent' }, { type: 'done' }]]);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  new OwnerMessagesService(db, repo, agents, turns).onModuleInit();
  const ws = (await workspaces.list())[0];
  const a = await agents.create({ name: 'Penny', workspaceId: ws.id });
  const session = await repo.createSession({ workspaceId: ws.id, agentId: a.id, name: 'Plan the week' });
  const evs: TurnEvent[] = [];
  for await (const ev of turns.run(session.id, { text: 'tell the boss' })) evs.push(ev);
  assert.equal(evs.some((e) => e.type === 'approval_required'), false);
  const r = evs.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }>;
  assert.equal(r.isError, false);
  assert.ok(provider.requests[0].tools?.some((t) => t.name === 'message_owner'), 'offered to agent chats');
  const dm = await ownerDmSession(repo, { id: a.id, workspaceId: ws.id });
  assert.ok(dm && dm.id !== session.id);
  assert.equal((await repo.listMessages(dm!.id))[0].content, 'Need your call on pricing.');
});

test('replying in the DM continues the conversation: the model sees the message as its own, after a marker', async () => {
  const s = await setup();
  const provider = new ScriptedProvider([[{ type: 'answer', text: 'Will do.' }, { type: 'done' }]]);
  const turns = new TurnLoopService(s.repo, new ChatLocks(), new ToolsService(s.stub), ctxStub(provider), skillsStub(), s.stub, mcpStub(), s.agents, s.workspaces);
  const { sessionId } = await s.svc.send(s.beat, { text: 'Can I spend $40 on the stock photos?' });
  const evs: TurnEvent[] = [];
  for await (const ev of turns.run(sessionId, { text: 'Yes, go ahead.' })) evs.push(ev);
  assert.ok(!evs.some((e) => e.type === 'error'));
  const msgs = provider.requests[0].messages.filter((m) => m.role !== 'system');
  const i = msgs.findIndex((m) => m.content === 'Can I spend $40 on the stock photos?');
  assert.ok(i >= 1);
  assert.equal(msgs[i].role, 'assistant');
  assert.deepEqual(msgs[i - 1], { role: 'user', content: AGENT_INITIATED_MARKER });
  assert.equal(msgs[i + 1].role, 'user');
  assert.match(String(msgs[i + 1].content), /Yes, go ahead\./);
  const rows = await s.repo.listMessages(sessionId);
  assert.deepEqual(rows.map((m) => m.role), ['assistant', 'user', 'assistant']);
});

test('the Inbox lists messages unread first, counts unread, and opening the chat reads them; members see none', async () => {
  const s = await setup();
  const ctl = new InboxMessagesController(s.svc, s.workspaces);
  const a = await s.svc.send(s.beat, { text: 'first', urgency: 'urgent' });
  await s.svc.send(s.beat, { text: 'second', refs: ['OPS-3'] });
  const other = await s.agents.create({ name: 'Otto', workspaceId: s.ws.id });
  const otherBeat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: other.id, name: 'Loop · heartbeat' });
  const b = await s.svc.send(otherBeat, { text: 'from Otto' });
  let list = await ctl.list(s.ws.id);
  assert.equal(list.unread, 3);
  assert.deepEqual(list.items.map((m) => m.text).sort(), ['first', 'from Otto', 'second']);
  const second = list.items.find((m) => m.text === 'second')!;
  assert.deepEqual(second.refs, ['OPS-3']);
  assert.equal(second.agentName, 'Penny');
  assert.equal(list.items.find((m) => m.text === 'first')!.urgency, 'urgent');
  // Opening Penny's DM reads both of her messages.
  assert.deepEqual(await ctl.read(s.ws.id, { eventId: a.eventId }), { ok: true, marked: 2 });
  list = await ctl.list(s.ws.id);
  assert.equal(list.unread, 1);
  assert.equal(list.items[0].sessionId, b.sessionId, 'unread first');
  assert.equal(list.items[0].read, false);
  await ctl.read(s.ws.id, { sessionId: b.sessionId });
  assert.equal((await ctl.list(s.ws.id)).unread, 0);
  // A member of a shared workspace: the owner's messages are not theirs.
  const member = { memberAccountId: 'm1', role: 'editor', workspaceId: s.ws.id, displayName: 'Mo' } as never;
  const asMember = await runWithViewer(currentAccountId(), member, () => ctl.list(s.ws.id));
  assert.deepEqual(asMember, { items: [], unread: 0 });
  await assert.rejects(() => runWithViewer(currentAccountId(), member, () => ctl.read(s.ws.id, { sessionId: b.sessionId })), /addressed to the owner/);
});

test('Home carries "Messages from your team" with the unread count', async () => {
  const s = await setup();
  const home = new HomeService(s.db, s.workspaces, s.agents, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, s.svc);
  await s.svc.send(s.beat, { text: 'Heads up: invoices are late.', urgency: 'fyi' });
  const d = await home.home(s.ws.id);
  assert.equal(d.partial.includes('messages'), false);
  assert.equal(d.messages.unread, 1);
  assert.equal(d.messages.items[0].text, 'Heads up: invoices are late.');
  assert.equal(d.messages.items[0].agentName, 'Penny');
  assert.equal(d.messages.items[0].urgency, 'fyi');
  // Without the service Home still renders, with no messages.
  const bare = new HomeService(s.db, s.workspaces, s.agents);
  assert.deepEqual((await bare.home(s.ws.id)).messages, { items: [], unread: 0 });
});
