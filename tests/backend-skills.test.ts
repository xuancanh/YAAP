/** Skills (§10): seeding, scoping, tool exposure, and turn-loop invocation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillsService } from '../server/src/skills/skills.service';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { testDb, memStorage, ctxStub, agentsStub, mcpStub, ScriptedProvider, wsStub } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

test('built-ins seed once and survive re-seeding; user edits stick', async () => {
  const skills = new SkillsService(await testDb());
  await skills.seedBuiltins();
  await skills.seedBuiltins();
  const all = await skills.list();
  const names = all.map((s) => s.name).sort();
  assert.deepEqual(names, ['create-slides', 'deep-research', 'design-polish', 'make-spreadsheet', 'org-member-onboarding', 'org-member-workflow', 'org-unit-retro', 'use-the-knowledge-base', 'verify-and-cite', 'write-document']);

  const edited = await skills.update(all[0].id, { instructions: 'my custom version' });
  await skills.seedBuiltins();
  assert.equal((await skills.get(edited.id)).instructions, 'my custom version');
});

test('workspace scoping: global skills everywhere, workspace skills only at home (FR-10.1)', async () => {
  const skills = new SkillsService(await testDb());
  await skills.seedBuiltins();
  await skills.create({ name: 'ws-only', instructions: 'do the thing', workspaceId: 'ws1' });

  assert.equal((await skills.list('ws1')).length, 11); // 10 builtins + ws-only
  assert.equal((await skills.list('ws2')).length, 10);

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

test('promotion: agent-private skill becomes workspace-shared (permissions §5)', async () => {
  const skills = new SkillsService(await testDb());
  const priv = await skills.create({ name: 'client-memory', instructions: 'keep per-client files', agentId: 'ag1' });

  // private: invisible to the workspace, visible to its agent
  assert.ok(!(await skills.list('ws1')).some((s) => s.name === 'client-memory'));
  assert.ok((await skills.list('ws1', 'ag1')).some((s) => s.name === 'client-memory'));

  const shared = await skills.promote(priv.id, 'ws1');
  assert.equal(shared.agentId, null);
  assert.equal(shared.workspaceId, 'ws1');
  // now every agent in ws1 sees it; other workspaces do not
  assert.ok((await skills.list('ws1', 'ag2')).some((s) => s.name === 'client-memory'));
  assert.ok(!(await skills.list('ws2')).some((s) => s.name === 'client-memory'));

  // re-promoting a shared skill is refused
  await assert.rejects(skills.promote(shared.id, 'ws1'), /already shared/);
});

test('promotion guards: drafts and name collisions are refused', async () => {
  const skills = new SkillsService(await testDb());
  const draft = await skills.create({ name: 'half-baked', instructions: 'not yet approved by anyone', agentId: 'ag1', draft: true, proposedBy: 'ag1' });
  await assert.rejects(skills.promote(draft.id, 'ws1'), /draft/);

  await skills.create({ name: 'run-sheet', instructions: 'the shared one', workspaceId: 'ws1' });
  const clash = await skills.create({ name: 'run-sheet', instructions: 'the private one', agentId: 'ag1' });
  await assert.rejects(skills.promote(clash.id, 'ws1'), /already exists/);
  // still promotable into a scope without the collision
  const shared = await skills.promote(clash.id, 'ws2');
  assert.equal(shared.workspaceId, 'ws2');
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
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(memStorage().stub), ctxStub(provider), skills, memStorage().stub, mcpStub(), agentsStub(), wsStub());

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

test('skill drafts: invisible until approved; rejection deletes (phase 3)', async () => {
  const skills = new SkillsService(await testDb());
  const msg = await skills.draftSkill({
    name: 'Weekly Dependency Audit!!',
    description: 'Audit deps weekly',
    instructions: '1. Run the audit.\n2. File tasks for criticals.',
    workspaceId: 'ws1',
    proposedBy: 'Sentinel',
  });
  assert.match(msg, /drafted/);
  const draft = (await skills.list('ws1')).find((s) => s.draft === 1)!;
  assert.equal(draft.name, 'weekly-dependency-audit'); // slugified
  assert.equal(draft.proposedBy, 'Sentinel');

  // drafts are never offered or resolvable as tools
  assert.ok(!(await skills.toolSpecs('ws1')).some((t) => t.name.includes('weekly_dependency_audit')));
  assert.equal(await skills.resolveTool('ws1', 'skill_weekly_dependency_audit'), undefined);

  // approval makes it live
  await skills.resolveDraft(draft.id, true);
  assert.ok((await skills.toolSpecs('ws1')).some((t) => t.name === 'skill_weekly_dependency_audit'));

  // a rejected draft disappears
  await skills.draftSkill({ name: 'bad-idea', instructions: 'x', workspaceId: 'ws1', proposedBy: 'Muse' });
  const bad = (await skills.list('ws1')).find((s) => s.name === 'bad-idea')!;
  await skills.resolveDraft(bad.id, false);
  assert.ok(!(await skills.list('ws1')).some((s) => s.name === 'bad-idea'));

  // duplicates and junk names are refused
  await assert.rejects(skills.create({ name: 'weekly-dependency-audit', instructions: 'x', workspaceId: 'ws1' }), /already exists/);
  await assert.rejects(skills.draftSkill({ name: '!!!', instructions: 'x', workspaceId: 'ws1', proposedBy: 'a' }), /valid slug/);
});

test('agent-scoped skills are private to their agent (working-folder model)', async () => {
  const skills = new SkillsService(await testDb());
  await skills.draftSkill({ name: 'my-private-move', instructions: 'do it my way', workspaceId: 'ws1', proposedBy: 'Sentinel', agentId: 'agA' });
  const draft = (await skills.list('ws1', 'agA')).find((s) => s.name === 'my-private-move')!;
  await skills.resolveDraft(draft.id, true);

  // visible + callable only with the owning agent's scope
  assert.ok((await skills.toolSpecs('ws1', 'agA')).some((t) => t.name === 'skill_my_private_move'));
  assert.ok(!(await skills.toolSpecs('ws1')).some((t) => t.name === 'skill_my_private_move'));
  assert.ok(!(await skills.toolSpecs('ws1', 'agB')).some((t) => t.name === 'skill_my_private_move'));
  assert.equal(await skills.resolveTool('ws1', 'skill_my_private_move', 'agB'), undefined);
  assert.equal((await skills.resolveTool('ws1', 'skill_my_private_move', 'agA'))?.name, 'my-private-move');
});
