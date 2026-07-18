/** Telegram channel (phase 4): pairing lock, routing to the default agent,
 *  and the Ask-mode deny for approval-gated tools. */
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
  const config = { get: (k: string) => (k === 'telegramBotToken' ? 'test-token' : undefined) } as unknown as ConfigService;
  const tg = new TelegramService(config, settings, agents, workspaces, repo, turns);
  const { fn, sent } = fakeTelegram();
  tg.fetchFn = fn;
  await workspaces.list(); // default workspace
  return { tg, sent, settings, agents, repo, workspaces, provider };
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
    { type: 'answer', text: 'Let me write that file. ' },
    { type: 'tool_call', id: 'c1', name: 'fs_write', input: { path: 'x.md', content: 'hi' } },
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
  assert.equal(session.permissionMode, 'ask', 'channel sessions never run in auto mode');
  const reply = sent.at(-1)!.text;
  assert.match(reply, /Noted anyway/);
  assert.match(reply, /skipped fs_write/);
  assert.match(reply, /only run from the app/);

  // /unpair closes the channel
  await tg.handleUpdate(msg(42, '/unpair'));
  assert.equal((await settings.all()).telegramChatId, '');
});
