/** Skills (§10): seeding, scoping, tool exposure, and turn-loop invocation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillsService } from '../server/src/skills/skills.service';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { testDb, memStorage, ctxStub, agentsStub, mcpStub, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

test('built-ins seed once and survive re-seeding; user edits stick', async () => {
  const skills = new SkillsService(await testDb());
  await skills.seedBuiltins();
  await skills.seedBuiltins();
  const all = await skills.list();
  const names = all.map((s) => s.name).sort();
  assert.deepEqual(names, ['create-slides', 'deep-research', 'write-document']);

  const edited = await skills.update(all[0].id, { instructions: 'my custom version' });
  await skills.seedBuiltins();
  assert.equal((await skills.get(edited.id)).instructions, 'my custom version');
});

test('workspace scoping: global skills everywhere, workspace skills only at home (FR-10.1)', async () => {
  const skills = new SkillsService(await testDb());
  await skills.seedBuiltins();
  await skills.create({ name: 'ws-only', instructions: 'do the thing', workspaceId: 'ws1' });

  assert.equal((await skills.list('ws1')).length, 4);
  assert.equal((await skills.list('ws2')).length, 3);

  const specs = await skills.toolSpecs('ws1');
  assert.ok(specs.some((s) => s.name === 'skill_ws_only'));
  assert.ok(specs.some((s) => s.name === 'skill_deep_research'));

  const resolved = await skills.resolveTool('ws1', 'skill_ws_only');
  assert.equal(resolved?.name, 'ws-only');
  assert.equal(await skills.resolveTool('ws2', 'skill_ws_only'), undefined);
});

test('disabled skills are not offered or resolvable', async () => {
  const skills = new SkillsService(await testDb());
  const row = await skills.create({ name: 'sometimes', instructions: 'x' });
  await skills.update(row.id, { enabled: false });
  assert.equal((await skills.toolSpecs('ws1')).length, 0);
  assert.equal(await skills.resolveTool('ws1', 'skill_sometimes'), undefined);
});

test('invalid skill names are rejected', async () => {
  const skills = new SkillsService(await testDb());
  await assert.rejects(skills.create({ name: 'Bad Name!', instructions: 'x' }), /lowercase slug/);
});

test('the turn loop offers skills as tools and invoking one returns its instructions (FR-10.2)', async () => {
  const db = await testDb();
  const skills = new SkillsService(db);
  await skills.create({ name: 'greet-politely', description: 'greeting etiquette', instructions: 'Always greet with a haiku.' });

  const repo = new ChatsRepository(db);
  const chats = new ChatsService(repo, agentsStub());
  const skillRound: AiStreamEvent[] = [
    { type: 'tool_call', id: 's1', name: 'skill_greet_politely', input: {} },
    { type: 'done' },
  ];
  const finalRound: AiStreamEvent[] = [{ type: 'answer', text: 'done' }, { type: 'done' }];
  const provider = new ScriptedProvider([skillRound, finalRound]);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(memStorage().stub), ctxStub(provider), skills, memStorage().stub, mcpStub());

  const s = await chats.create({ workspaceId: 'ws1' });
  const events: TurnEvent[] = [];
  for await (const ev of turns.run(s.id, { text: 'greet me' })) events.push(ev);

  // offered to the provider
  assert.ok(provider.requests[0].tools!.some((t) => t.name === 'skill_greet_politely'));
  // ran without approval (skills are read-only) and returned the instructions
  assert.ok(!events.some((e) => e.type === 'approval_required'));
  const result = events.find((e) => e.type === 'tool_result');
  assert.ok(result && !result.isError);
  assert.match(result.output, /Always greet with a haiku/);
});
