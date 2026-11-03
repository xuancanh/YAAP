/** Telegram channel (phase 4): pairing lock, routing to the default agent,
 *  the Ask-mode deny for approval-gated tools, and the outbound sweep that
 *  pushes inbox events back to the paired chat (two-way, phase 2 finish). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from '../server/src/channels/telegram.service';
import { SettingsService } from '../server/src/settings/settings.module';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

function fakeTelegram() {
  const sent: Array<{ chat_id: number; text: string }> = [];
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop();
    if (method === 'sendMessage') sent.push(JSON.parse(String(init?.body)) as { chat_id: number; text: string });
    return new Response(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : {} }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, sent };
}

async function setup(rounds: AiStreamEvent[][]) {
  const db = await testDb();
  const { stub } = memStorage();
  const settings = new SettingsService(db);
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'telegramBotToken' ? 'test-token' : k === 'publicAppUrl' ? 'https://yaam.example/' : undefined) } as unknown as ConfigService;
  const tg = new TelegramService(config, settings, agents, workspaces, repo, turns);
  const { fn, sent } = fakeTelegram();
  tg.fetchFn = fn;
  await workspaces.list(); // default workspace
  return { tg, sent, settings, agents, repo, workspaces, provider, turns };
}

const msg = (chatId: number, text: string) => ({ update_id: 1, message: { chat: { id: chatId }, text } });

test('unknown chats only get pairing instructions; a valid code pairs exactly one chat', async () => {
  const { tg, sent, settings } = await setup([]);

  await tg.handleUpdate(msg(111, 'hello?'));
  assert.match(sent[0].text, /pairing code/);
  assert.equal((await settings.all()).telegramChatId, undefined);

  await tg.handleUpdate(msg(111, '/pair deadbeef')); // no code minted
  assert.match(sent[1].text, /pairing code/);

  const { code } = tg.mintPairCode();
  await tg.handleUpdate(msg(111, `/pair ${code}`));
  assert.match(sent[2].text, /Paired/);
  assert.equal((await settings.all()).telegramChatId, '111');

  // the code is single-use: a second chat cannot replay it
  await tg.handleUpdate(msg(222, `/pair ${code}`));
  assert.match(sent[3].text, /pairing code/);
  assert.equal((await settings.all()).telegramChatId, '111');
});

test('paired messages run an Ask-mode turn for the default agent; gated tools deny with a pointer to the app', async () => {
  const toolRound: AiStreamEvent[] = [
    { type: 'answer', text: 'Let me post that. ' },
    { type: 'tool_call', id: 'c1', name: 'http_request', input: { url: 'https://example.com/hook', method: 'POST', body: 'hi' } },
    { type: 'done' },
  ];
  const finalRound: AiStreamEvent[] = [{ type: 'answer', text: 'Noted anyway.' }, { type: 'done' }];
  const { tg, sent, settings, agents, repo, workspaces } = await setup([toolRound, finalRound]);
  const agent = await agents.create({ name: 'Fieldy' });
  const { code } = tg.mintPairCode();
  await tg.handleUpdate(msg(42, `/pair ${code}`));

  // no default agent yet: helpful hint, no turn
  await tg.handleUpdate(msg(42, 'status?'));
  assert.match(sent.at(-1)!.text, /No default agent/);

  await settings.put({ telegramDefaultAgentId: agent.id });
  await tg.handleUpdate(msg(42, 'write hi to x.md'));

  const ws = (await workspaces.list())[0];
  const session = (await repo.listSessions(ws.id)).find((s) => s.name === 'Telegram · Fieldy')!;
  assert.equal(session.kind, 'chat', 'a person writing over Telegram is a conversation');
  assert.equal(session.permissionMode, 'ask', 'channel sessions never run in auto mode');
  const reply = sent.at(-1)!.text;
  assert.match(reply, /Noted anyway/);
  assert.match(reply, /skipped http_request/);
  assert.match(reply, /only run from the app/);

  // /unpair closes the channel
  await tg.handleUpdate(msg(42, '/unpair'));
  assert.equal((await settings.all()).telegramChatId, '');
});

// ---- outbound delivery ----

test('deliverSweep pushes the default agent\'s undelivered events in one batched message with deep links, then marks them delivered', async () => {
  const { tg, sent, settings, agents, repo, workspaces } = await setup([]);
  const agent = await agents.create({ name: 'Fieldy' });
  const other = await agents.create({ name: 'Backstage' });
  const ws = (await workspaces.list())[0];
  const session = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'Loop · Nightly' });

  // not paired yet: nothing moves, nothing is marked
  await agents.addEvent(agent.id, { kind: 'loop_run', title: 'Loop "Nightly" ran', body: 'All  green.', sessionId: session.id, origin: 'loop' });
  assert.equal(await tg.deliverSweep(), 0);
  assert.equal(sent.length, 0);

  const { code } = tg.mintPairCode();
  await tg.handleUpdate(msg(42, `/pair ${code}`));
  await settings.put({ telegramDefaultAgentId: agent.id });
  sent.length = 0;

  await agents.addEvent(agent.id, { kind: 'info', title: 'Second thing', origin: 'loop' });
  await agents.addEvent(other.id, { kind: 'info', title: 'Backstage chatter', origin: 'loop' }); // not the default agent, not flagged
  await agents.addEvent(other.id, { kind: 'loop_error', title: 'Loop "Sync" failed', body: 'boom', origin: 'loop' }); // flagged: failures travel for every agent

  assert.equal(await tg.deliverSweep(), 3);
  assert.equal(sent.length, 1, 'one message for the whole batch');
  assert.equal(sent[0].chat_id, 42);
  const text = sent[0].text;
  assert.match(text, /✅ Fieldy · Loop "Nightly" ran\nAll green\.\nhttps:\/\/yaam\.example\/#\/chat\// );
  assert.ok(text.includes(`/#/chat/${session.id}`), 'deep link uses the configured public app URL without a double slash');
  assert.match(text, /ℹ️ Fieldy · Second thing/);
  assert.match(text, /❌ Backstage · Loop "Sync" failed\nboom/);
  assert.doesNotMatch(text, /Backstage chatter/, 'another agent\'s ordinary events stay in its inbox');
  assert.equal(text.indexOf('Nightly') < text.indexOf('Second thing'), true, 'oldest first');

  const delivered = (await agents.listEvents(agent.id)).filter((e) => e.deliveredAt);
  assert.equal(delivered.length, 2);
  assert.equal((await agents.listEvents(other.id)).filter((e) => e.deliveredAt).length, 1);

  // idempotent: a second sweep has nothing to push
  assert.equal(await tg.deliverSweep(), 0);
  assert.equal(sent.length, 1);
});

test('deliverSweep honours quiet hours (deliverAfter, silent) and never echoes channel-born events back', async () => {
  const { tg, sent, settings, agents } = await setup([]);
  const agent = await agents.create({ name: 'Fieldy' });
  const { code } = tg.mintPairCode();
  await tg.handleUpdate(msg(7, `/pair ${code}`));
  await settings.put({ telegramDefaultAgentId: agent.id });
  sent.length = 0;

  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  await agents.addEvent(agent.id, { kind: 'loop_run', title: 'Queued until morning', origin: 'loop', deliverAfter: later });
  await agents.addEvent(agent.id, { kind: 'loop_run', title: 'Inbox only', origin: 'loop', silent: true });
  await agents.addEvent(agent.id, { kind: 'info', title: 'Born on the phone', origin: 'channel' });

  assert.equal(await tg.deliverSweep(), 0, 'deferred, silent, and channel-origin events are all held back');
  assert.equal(sent.length, 0);

  // once the window has passed, only the queued one goes out
  assert.equal(await tg.deliverSweep(new Date(Date.now() + 2 * 60 * 60_000)), 1);
  assert.match(sent[0].text, /Queued until morning/);
  assert.doesNotMatch(sent[0].text, /Inbox only|Born on the phone/);

  // a failed push is not marked delivered, so it retries next sweep
  await agents.addEvent(agent.id, { kind: 'info', title: 'Flaky network', origin: 'loop' });
  const okFetch = tg.fetchFn;
  tg.fetchFn = (async () => new Response(JSON.stringify({ ok: false, description: 'Too Many Requests' }), { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(tg.deliverSweep(), /Too Many Requests/);
  tg.fetchFn = okFetch;
  assert.equal(await tg.deliverSweep(), 1);
  assert.match(sent.at(-1)!.text, /Flaky network/);
});

test('channel turns are stamped origin=channel so their events never loop back', async () => {
  const { tg, settings, agents, repo, workspaces, turns } = await setup([[{ type: 'answer', text: 'hi' }, { type: 'done' }]]);
  const agent = await agents.create({ name: 'Fieldy' });
  const { code } = tg.mintPairCode();
  await tg.handleUpdate(msg(9, `/pair ${code}`));
  await settings.put({ telegramDefaultAgentId: agent.id });
  // observe what the channel hands the turn loop
  const seen: unknown[] = [];
  const realRun = turns.run.bind(turns);
  turns.run = ((id: string, input: { origin?: string }) => { seen.push(input.origin); return realRun(id, input as never); }) as typeof turns.run;
  await tg.handleUpdate(msg(9, 'hello'));
  assert.deepEqual(seen, ['channel']);
  const ws = (await workspaces.list())[0];
  assert.ok((await repo.listSessions(ws.id)).some((s) => s.name === 'Telegram · Fieldy'));
});
