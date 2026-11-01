/** Skill outcome tracking (execution-plan item 10): which skills a turn
 *  loaded, how rated turns reach those skills, the 👎 → revise_skill loop,
 *  and the accept/reject of a pending revision. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillsService, parseRevision } from '../server/src/skills/skills.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, TurnEvent } from '../server/src/chats/turn-loop.service';
import { TurnContextService } from '../server/src/chats/turn-context.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { AgentTypesService } from '../server/src/agent-types/agent-types.service';
import { AiProviderFactory } from '../server/src/ai/providers.factory';
import type { ConfigService } from '@nestjs/config';
import type { StorageService } from '../server/src/storage/storage.service';
import { testDb, memStorage, ctxStub, mcpStub, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

async function setup() {
  const db = await testDb();
  const storage = memStorage().stub as unknown as StorageService;
  const agents = new AgentsService(db, storage);
  const memory = new AgentMemoryService(db, storage);
  const workspaces = new WorkspacesService(db, storage);
  const skills = new SkillsService(db);
  const repo = new ChatsRepository(db);
  const chats = new ChatsService(repo, agents, skills);
  const [ws] = await workspaces.list();
  const agent = await agents.create({ name: 'Atlas' });
  const skill = await skills.create({ name: 'close-month', description: 'Close the books', instructions: '1. Reconcile.\n2. Report.', workspaceId: ws.id });
  const loop = (provider: ScriptedProvider) =>
    new TurnLoopService(repo, new ChatLocks(), new ToolsService(storage), ctxStub(provider), skills, storage, mcpStub(), agents, workspaces);
  return { db, storage, agents, memory, workspaces, skills, repo, chats, ws, agent, skill, loop };
}

async function collect(gen: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const useSkillRound: AiStreamEvent[] = [
  { type: 'tool_call', id: 's1', name: 'skill_close_month', input: {} },
  { type: 'done' },
];
const finalRound: AiStreamEvent[] = [{ type: 'answer', text: 'Closed.' }, { type: 'done' }];

test('a turn that loads a skill records it on the turn and bumps the skill\'s use count', async () => {
  const { chats, repo, skills, skill, ws, agent, loop } = await setup();
  const turns = loop(new ScriptedProvider([useSkillRound, finalRound]));
  const s = await chats.create({ workspaceId: ws.id, agentId: agent.id });
  const events = await collect(turns.run(s.id, { text: 'close the month' }));
  assert.ok(events.some((e) => e.type === 'tool_result' && e.name === 'skill_close_month' && !e.isError));

  const [turn] = await repo.listTurns(s.id);
  assert.deepEqual(JSON.parse(turn.skillsUsed), [skill.id]);
  const after = await skills.get(skill.id);
  assert.equal(after.useCount, 1);
  assert.ok(after.lastUsedAt, 'lastUsedAt is stamped');

  // a turn without skills records none
  const plain = loop(new ScriptedProvider([finalRound]));
  const s2 = await chats.create({ workspaceId: ws.id });
  await collect(plain.run(s2.id, { text: 'hi' }));
  assert.deepEqual(JSON.parse((await repo.listTurns(s2.id))[0].skillsUsed), []);
  assert.equal((await skills.get(skill.id)).useCount, 1);
});

test('rating a skill turn upserts an outcome, updates aggregates, and names the skill in pending feedback', async () => {
  const { chats, repo, skills, skill, ws, agent, agents, loop } = await setup();
  const turns = loop(new ScriptedProvider([useSkillRound, finalRound]));
  const s = await chats.create({ workspaceId: ws.id, agentId: agent.id });
  await collect(turns.run(s.id, { text: 'close the month' }));
  const [turn] = await repo.listTurns(s.id);

  const res = await chats.rateTurn(s.id, turn.id, 'down', 'skipped the reconciliation');
  assert.deepEqual(res.skills, [{ id: skill.id, name: 'close-month' }]);
  let row = await skills.get(skill.id);
  assert.equal(row.downCount, 1);
  assert.equal(row.upCount, 0);
  let outcomes = await skills.outcomes(skill.id);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].rating, 'down');
  assert.equal(outcomes[0].note, 'skipped the reconciliation');

  // re-rating the same turn flips the counters rather than adding a second outcome
  await chats.rateTurn(s.id, turn.id, 'up');
  row = await skills.get(skill.id);
  assert.equal(row.downCount, 0);
  assert.equal(row.upCount, 1);
  outcomes = await skills.outcomes(skill.id);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].rating, 'up');

  // the agent's pending feedback carries the skill, so the next turn knows
  const pending = await agents.takeFeedback(agent.id) as Array<{ rating: string; skills?: Array<{ id: string; name: string }> }>;
  assert.equal(pending.length, 2);
  assert.deepEqual(pending[0].skills, [{ id: skill.id, name: 'close-month' }]);
  // a rating on an unknown turn is refused
  await assert.rejects(chats.rateTurn(s.id, 'nope', 'up'), /turn/);
});

test('after a 👎 on a skill turn, the next turn is told which skill, and revise_skill parks a pending revision', async () => {
  const { chats, repo, skills, skill, ws, agent, agents, memory, workspaces, loop, db } = await setup();
  const first = loop(new ScriptedProvider([useSkillRound, finalRound]));
  const s = await chats.create({ workspaceId: ws.id, agentId: agent.id });
  await collect(first.run(s.id, { text: 'close the month' }));
  const [turn] = await repo.listTurns(s.id);
  await chats.rateTurn(s.id, turn.id, 'down', 'it never reconciled');

  // the real TurnContextService builds the hint from pending feedback
  const factory = { resolve: () => new ScriptedProvider([]), defaultBaseUrl: () => undefined } as unknown as AiProviderFactory;
  const ctx = new TurnContextService(factory, new AgentTypesService(db), agents, memory, workspaces, { get: () => 24 } as unknown as ConfigService);
  const built = await ctx.build((await repo.getSession(s.id))!);
  assert.match(built.system, /rated 👎 had loaded these skills: "close-month"/);
  assert.match(built.system, new RegExp(skill.id));
  assert.match(built.system, /revise_skill/);

  // the agent proposes a revision through the tool; it auto-runs (read-only class)
  const reviseRound: AiStreamEvent[] = [
    { type: 'tool_call', id: 'r1', name: 'revise_skill', input: { skillId: skill.id, instructions: '1. Reconcile every account.\n2. Report.', reason: 'The user said it never reconciled.' } },
    { type: 'done' },
  ];
  const second = loop(new ScriptedProvider([reviseRound, finalRound]));
  const events = await collect(second.run(s.id, { text: 'please fix that' }));
  assert.ok(!events.some((e) => e.type === 'approval_required'), 'proposing a revision needs no approval — accepting it does');
  const result = events.find((e) => e.type === 'tool_result' && e.name === 'revise_skill');
  assert.ok(result && !result.isError, 'revise_skill ran');
  assert.match(result.output, /Revision of "close-month" proposed/);

  const row = await skills.get(skill.id);
  const rev = parseRevision(row.pendingRevision)!;
  assert.equal(rev.instructions, '1. Reconcile every account.\n2. Report.');
  assert.equal(rev.reason, 'The user said it never reconciled.');
  assert.equal(rev.proposedBy, 'Atlas');
  assert.equal(row.instructions, '1. Reconcile.\n2. Report.', 'the live text is untouched until the user accepts');

  // guards: unknown skill, draft skill, identical text
  await assert.rejects(skills.proposeRevision({ skillId: 'nope', instructions: 'x', reason: 'r', workspaceId: ws.id, proposedBy: 'a' }), /unknown skill/);
  const draft = await skills.create({ name: 'half-baked', instructions: 'x', workspaceId: ws.id, draft: true });
  await assert.rejects(skills.proposeRevision({ skillId: draft.id, instructions: 'y', reason: 'r', workspaceId: ws.id, proposedBy: 'a' }), /draft/);
  assert.match(await skills.proposeRevision({ skillId: 'close-month', instructions: '1. Reconcile.\n2. Report.', reason: 'r', workspaceId: ws.id, proposedBy: 'a' }), /identical/);
  // scope: an agent-private skill of another agent is not revisable from here
  const priv = await skills.create({ name: 'secret-move', instructions: 'x', agentId: 'someone-else' });
  await assert.rejects(skills.proposeRevision({ skillId: priv.id, instructions: 'y', reason: 'r', workspaceId: ws.id, agentId: agent.id, proposedBy: 'a' }), /unknown skill/);
});

test('accepting a revision replaces the instructions and keeps the last 5 in history; rejecting drops it', async () => {
  const { skills, skill, ws } = await setup();
  const propose = (n: number) => skills.proposeRevision({ skillId: skill.id, instructions: `version ${n}`, reason: `reason ${n}`, workspaceId: ws.id, proposedBy: 'Atlas' });

  await propose(1);
  const rejected = await skills.resolveRevision(skill.id, false);
  assert.equal(rejected.pendingRevision, '');
  assert.equal(rejected.instructions, '1. Reconcile.\n2. Report.');
  await assert.rejects(skills.resolveRevision(skill.id, true), /no pending revision/);

  for (let n = 1; n <= 7; n++) {
    await propose(n);
    await skills.resolveRevision(skill.id, true);
  }
  const row = await skills.get(skill.id);
  assert.equal(row.instructions, 'version 7');
  assert.equal(row.pendingRevision, '');
  const history = JSON.parse(row.history) as Array<{ instructions: string; reason: string; replacedAt: string }>;
  assert.equal(history.length, 5, 'history is capped at 5');
  assert.deepEqual(history.map((h) => h.instructions), ['version 6', 'version 5', 'version 4', 'version 3', 'version 2']);
  assert.equal(history[0].reason, 'reason 7');
  assert.ok(history[0].replacedAt);
  // the revised skill is what the model loads next
  assert.match(skills.invocation(row), /version 7/);
});
