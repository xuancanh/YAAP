/** The agents' voice and personalities (docs/agent-writing.md): one voice
 *  section in every system prompt, its register picked by where the agent
 *  speaks (chat / channel or meeting / task work), the workspace knobs, and
 *  the per-agent personality — random at creation, a stable default for old
 *  rows, settable through the API, 'none' for neutral. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigService } from '@nestjs/config';
import { registerFor, voiceSection } from '../server/src/chats/voice';
import { NO_PERSONALITY, PERSONALITIES, effectivePersonality, personalityById, personalityForId, personalityIdOf, pickPersonality } from '../server/src/agents/personalities';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentsController } from '../server/src/agents/agents.controller';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { SettingsService } from '../server/src/settings/settings.module';
import { TurnContextService } from '../server/src/chats/turn-context.service';
import type { AgentTypesService } from '../server/src/agent-types/agent-types.service';
import type { AiProviderFactory } from '../server/src/ai/providers.factory';
import type { StorageService } from '../server/src/storage/storage.service';
import { agents as agentsTable } from '../server/src/database/schema';
import { eq } from 'drizzle-orm';
import { testDb, memStorage, ScriptedProvider } from './helpers';

test('the register follows the session: channels and meetings converse, work sessions do the task, the rest is a chat', () => {
  // channel wakes and meeting rounds both run in the agent's `#slug · Agent` session, tagged channel
  assert.equal(registerFor({ name: '#eng · Ada', tags: '["channel"]', kind: 'work' }), 'conversation');
  assert.equal(registerFor({ name: '#launch-review · Ada', tags: '[]', kind: 'work' }), 'conversation');
  assert.equal(registerFor({ name: 'Org · Acme · ENG-3', tags: '[]', kind: 'work', taskKind: 'org' }), 'task');
  assert.equal(registerFor({ name: 'Loop · Heartbeat', kind: 'work' }), 'task');
  assert.equal(registerFor({ name: 'App · Ada', kind: 'work' }), 'task');
  assert.equal(registerFor({ name: 'Pricing questions', kind: 'chat' }), 'chat');
  assert.equal(registerFor({ name: '', tags: '["owner-dm"]', kind: 'chat' }), 'chat');
  // no kind stored: classified like the 0080 backfill
  assert.equal(registerFor({ name: 'Loop · digest' }), 'task');
  assert.equal(registerFor({ name: 'Hello' }), 'chat');
});

test('every register shares the colleague rules with a before/after example; only the length rules differ', () => {
  const chat = voiceSection({ register: 'chat' });
  const conv = voiceSection({ register: 'conversation' });
  const task = voiceSection({ register: 'task' });
  for (const v of [chat, conv, task]) {
    assert.match(v, /like a capable colleague, not a report/);
    assert.match(v, /Lead with the point/);
    assert.match(v, /no recap of what they just said/);
    assert.match(v, /Ask one clear question instead of listing options/);
    assert.match(v, /Not "I have completed a thorough review/);
    assert.doesNotMatch(v, /full sentences|Be thorough|Be concise/);
  }
  // chat: short by default, longer when asked
  assert.match(chat, /talking with a person directly\. Usually a few sentences; longer only when they ask/);
  // channel / meeting: Slack between teammates
  assert.match(conv, /write like Slack between teammates/);
  assert.match(conv, /Usually one to three sentences\. React to what was just said and use names/);
  assert.match(conv, /Don't re-summarise the thread or restate the agenda/);
  assert.match(conv, /\+1, ship it/);
  // task mode: no brevity cap
  assert.match(task, /no length limit/);
  assert.match(task, /as long and structured as the work needs/);
  assert.match(task, /handoff must stand on its own/);
  assert.doesNotMatch(task, /one to three sentences|Usually a few sentences|Slack/);
  // the style moves the chat register only
  assert.match(voiceSection({ register: 'chat', style: 'concise' }), /One to three sentences unless they ask for more/);
  assert.match(voiceSection({ register: 'chat', style: 'detailed' }), /include your reasoning and the trade-offs/);
  assert.equal(voiceSection({ register: 'task', style: 'concise' }), task);
  assert.equal(voiceSection({ register: 'conversation', style: 'detailed' }), conv);
});

test('the personality line shapes tone only; none adds nothing', () => {
  const dry = personalityById('dry')!;
  const v = voiceSection({ register: 'conversation', personality: dry });
  assert.match(v, /Personality: you're dry and matter-of-fact/);
  assert.match(v, /E\.g\. "Deploy is green/);
  assert.match(v, /never your accuracy, judgment, safety or length/);
  assert.doesNotMatch(voiceSection({ register: 'conversation', personality: null }), /Personality:/);
});

test('the catalog: distinct, complete entries with an example each', () => {
  assert.ok(PERSONALITIES.length >= 8 && PERSONALITIES.length <= 12);
  assert.equal(new Set(PERSONALITIES.map((p) => p.id)).size, PERSONALITIES.length);
  assert.ok(!PERSONALITIES.some((p) => p.id === NO_PERSONALITY));
  for (const p of PERSONALITIES) {
    assert.ok(p.name && p.description && p.prompt && p.example, p.id);
    assert.ok(p.prompt.length + p.example.length <= 200, `${p.id}: the prompt fragment stays small`);
  }
});

test('assignment: a pick prefers the least-used personalities; an old row resolves to a stable default', () => {
  const all = PERSONALITIES.map((p) => p.id);
  // all but one taken: the free one is chosen whatever the seed
  const free = all[3];
  for (const seed of ['a', 'b', 'c', 'd']) assert.equal(pickPersonality(seed, all.filter((x) => x !== free)), free);
  // nobody yet: seeded, spread over the catalog
  const picks = new Set(Array.from({ length: 60 }, (_, i) => pickPersonality(`seed-${i}`)));
  assert.ok(picks.size >= 6, `random picks vary (${picks.size})`);
  assert.equal(pickPersonality('same'), pickPersonality('same'));
  // a null row: the id-derived default, the same every time
  assert.equal(personalityForId('agent-1'), personalityForId('agent-1'));
  assert.equal(effectivePersonality({ id: 'agent-1', personality: null })?.id, personalityForId('agent-1'));
  assert.equal(personalityIdOf({ id: 'agent-1', personality: null }), personalityForId('agent-1'));
  assert.equal(effectivePersonality({ id: 'agent-1', personality: 'none' }), null);
  assert.equal(effectivePersonality({ id: 'agent-1', personality: 'warm' })?.id, 'warm');
});

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const storage = stub as unknown as StorageService;
  const agents = new AgentsService(db, storage);
  const memory = new AgentMemoryService(db, storage);
  const workspaces = new WorkspacesService(db, storage);
  const settings = new SettingsService(db);
  const ws = (await workspaces.list())[0];
  const context = new TurnContextService(
    { resolve: () => new ScriptedProvider([]), defaultBaseUrl: () => undefined } as unknown as AiProviderFactory,
    { resolve: async () => undefined, list: async () => [] } as unknown as AgentTypesService,
    agents, memory, workspaces,
    { get: () => 24 } as unknown as ConfigService,
    undefined, undefined, settings,
  );
  const system = async (agentId: string, s: { name: string; kind: string; tags?: string; taskKind?: string | null }) =>
    (await context.build({ id: 's1', workspaceId: ws.id, agentId, agentTypeId: null, model: '', tags: '[]', taskKind: null, ...s } as Parameters<typeof context.build>[0])).system;
  return { db, agents, settings, ws, system };
}

test('creation assigns a personality on every path through AgentsService.create, spread across a small team', async () => {
  const { agents, ws } = await setup();
  const team = [];
  for (const name of ['Ada', 'Ben', 'Cy', 'Dee', 'Eve']) team.push(await agents.create({ name, workspaceId: ws.id }));
  for (const a of team) assert.ok(PERSONALITIES.some((p) => p.id === a.personality), `${a.name}: ${a.personality}`);
  assert.equal(new Set(team.map((a) => a.personality)).size, team.length, 'a team smaller than the catalog gets no repeats');
  const chosen = await agents.create({ name: 'Fay', workspaceId: ws.id, personality: 'calm' });
  assert.equal(chosen.personality, 'calm');
  await assert.rejects(agents.create({ name: 'Gus', workspaceId: ws.id, personality: 'grumpy' }), /unknown personality/);
});

test('the API: the catalog, a null row shown as its stable default, PATCH sets one, none works, junk is refused', async () => {
  const { db, agents, ws } = await setup();
  const ctl = new AgentsController(agents, {} as never, {} as never, {} as never, {} as never, {} as never);
  assert.deepEqual(ctl.personalities().map((p) => p.id), PERSONALITIES.map((p) => p.id));
  const a = await agents.create({ name: 'Ada', workspaceId: ws.id });
  await db.update(agentsTable).set({ personality: null }).where(eq(agentsTable.id, a.id));
  assert.equal((await ctl.get(a.id)).personality, personalityForId(a.id), 'lazy: an unassigned row shows its stable pick');
  assert.equal((await ctl.list(ws.id)).find((x) => x.id === a.id)?.personality, personalityForId(a.id));
  assert.equal((await ctl.update(a.id, { personality: 'playful' })).personality, 'playful');
  assert.equal((await ctl.update(a.id, { personality: 'none' })).personality, 'none');
  await assert.rejects(Promise.resolve().then(() => ctl.update(a.id, { personality: 'grumpy' })), /personality must be one of/);
});

test('the system prompt: the register by session, the personality unless "none" or the workspace switched it off', async () => {
  const { agents, settings, ws, system } = await setup();
  const a = await agents.create({ name: 'Ada', workspaceId: ws.id, personality: 'blunt' });
  const chat = await system(a.id, { name: 'Pricing', kind: 'chat' });
  assert.match(chat, /talking with a person directly/);
  assert.match(chat, /Personality: you're a blunt pragmatist/);
  assert.doesNotMatch(chat, /Slack between teammates|no length limit/);
  const channel = await system(a.id, { name: '#eng · Ada', kind: 'work', tags: '["channel"]' });
  assert.match(channel, /write like Slack between teammates/);
  assert.doesNotMatch(channel, /no length limit/);
  const work = await system(a.id, { name: 'Org · Acme · ENG-3', kind: 'work', taskKind: 'org' });
  assert.match(work, /This is a work session, so no length limit/);
  assert.doesNotMatch(work, /one to three sentences/);
  assert.equal(work.split('How you talk:').length - 1, 1, 'one voice section');
  // the workspace knobs
  await settings.put({ writingStyle: 'concise' });
  assert.match(await system(a.id, { name: 'Pricing', kind: 'chat' }), /One to three sentences unless they ask for more/);
  await settings.put({ agentPersonalities: 'off' });
  assert.doesNotMatch(await system(a.id, { name: 'Pricing', kind: 'chat' }), /Personality:/);
  await settings.put({ agentPersonalities: 'on' });
  await agents.update(a.id, { personality: 'none' });
  assert.doesNotMatch(await system(a.id, { name: 'Pricing', kind: 'chat' }), /Personality:/);
});
