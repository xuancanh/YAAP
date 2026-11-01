/** Workspace is the company (docs/group-chat.md §5, execution plan item 16):
 *  organization mode on the workspace (off | supervised | autonomous), the
 *  1:1 organization created on first enable with every agent enrolled, the
 *  `#company` announcer seam, the kill switch through the workspace, the
 *  autonomous chief's structural tools executing within caps and refusing
 *  outside them with the reason, the structure review, board-event wakes,
 *  the brief's autonomous-actions section, and the /api/workspaces/:id/org
 *  aliases. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgController } from '../server/src/org/org.controller';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

async function setup(rounds: AiStreamEvent[][] = []) {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announced: Array<{ workspaceId: string; text: string }> = [];
  const announcer = new OrgAnnouncer({ announce: async (workspaceId, text) => { announced.push({ workspaceId, text }); } });
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus);
  runtime.debounceMs = 15;
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const controller = new WorkspaceOrgController(mode, orgs, config);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit.' });
  return { db, agents, workspaces, repo, turns, provider, bus, audit, org, tasks, approvals, brief, runtime, orgs, mode, controller, ws, chief, writer, editor, announced };
}

type S = Awaited<ReturnType<typeof setup>>;

/** Enable a mode and return the org id plus a chat session of the chief. */
async function enable(s: S, modeName: 'supervised' | 'autonomous', extra: { monthlyUsd?: number; agentCap?: number } = {}) {
  const st = await s.controller.set(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, ...extra });
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  return { orgId: st.orgId!, session, st };
}

test('enabling organization mode creates the 1:1 org, seats every agent (chief at the root), announces #company and audits', async () => {
  const s = await setup();
  assert.equal((await s.workspaces.get(s.ws.id)).orgMode, 'off');
  const before = await s.controller.status(s.ws.id);
  assert.equal(before.mode, 'off'); assert.equal(before.orgId, null); assert.equal(before.org, null);

  const st = await s.controller.set(s.ws.id, { mode: 'autonomous', chiefOfStaffAgentId: s.chief.id, monthlyUsd: 40, agentCap: 6 });
  assert.equal(st.mode, 'autonomous');
  assert.equal(st.chiefOfStaffAgentId, s.chief.id);
  assert.equal(st.orgMonthlyUsd, 40);
  assert.equal(st.orgAgentCap, 6);
  assert.ok(st.orgId);
  assert.deepEqual(st.enrolled!.sort(), [s.writer.id, s.editor.id].sort(), 'the two other agents joined');
  assert.deepEqual(st.notEnrolled, []);
  const ws = await s.workspaces.get(s.ws.id);
  assert.equal(ws.orgMode, 'autonomous'); assert.equal(ws.chiefOfStaffAgentId, s.chief.id); assert.equal(ws.orgMonthlyUsd, 40); assert.equal(ws.orgAgentCap, 6);

  const org = await s.org.get(st.orgId!);
  assert.equal(org.name, ws.name, 'the org is named after the workspace');
  assert.equal(org.workspaceId, s.ws.id);
  assert.equal(org.monthlyBudgetUsd, 40);
  assert.equal((await s.org.budget(org.id, 'company', org.id))!.monthlyUsd, 40);
  const members = await s.org.members(org.id);
  assert.equal(members.length, 3);
  const chief = members.find((m) => m.agentId === s.chief.id)!;
  assert.equal(chief.reportsToAgentId, null); assert.equal(chief.depth, 1); assert.equal(chief.title, 'Chief of staff');
  for (const m of members.filter((x) => x.agentId !== s.chief.id)) { assert.equal(m.reportsToAgentId, s.chief.id); assert.equal(m.depth, 2); }

  assert.equal(s.announced.length, 1);
  assert.equal(s.announced[0].workspaceId, s.ws.id);
  assert.match(s.announced[0].text, /Organization mode is on \(autonomous\)\. Chief is chief of staff; 2 agent\(s\) joined/);
  const actions = (await s.audit.list(org.id, { limit: 50 })).map((r) => r.action);
  assert.ok(actions.includes('org_mode') && actions.includes('org_create') && actions.filter((a) => a === 'member_add').length === 3);
  const modeRow = (await s.audit.list(org.id, { action: 'org_mode' }))[0];
  assert.deepEqual(JSON.parse(modeRow.payload).mode, 'autonomous');

  // a second org for the same workspace is refused: the workspace is the company
  await assert.rejects(s.org.create({ workspaceId: s.ws.id, name: 'Another', chiefOfStaffAgentId: s.writer.id }), /already has an organization/);
  // enabling again is idempotent on the roster and only changes settings
  const again = await s.controller.set(s.ws.id, { mode: 'autonomous', agentCap: 9 });
  assert.equal(again.enrolled, undefined);
  assert.equal(again.orgAgentCap, 9);
  assert.equal((await s.org.members(org.id)).length, 3);
  // the status carries the full detail for the panes
  const full = await s.controller.status(s.ws.id);
  assert.equal(full.org!.members.length, 3);
  assert.equal(full.pendingApprovals, 0);
});

test('off pauses the runtime and keeps the data; supervised/autonomous resume it; the workspace kill switch aliases pause', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'supervised');
  const t = await s.tasks.create(orgId, { title: 'Draft', assigneeAgentId: s.writer.id });
  assert.equal(s.runtime.pendingWakeKeys().length, 1);

  const off = await s.controller.set(s.ws.id, { mode: 'off' });
  assert.equal(off.mode, 'off'); assert.equal(off.orgStatus, 'paused');
  assert.deepEqual(s.runtime.pendingWakeKeys(), [], 'queued wakes dropped');
  assert.equal(await s.runtime.runTask(orgId, t.id, s.writer.id, 'manual'), 'skipped:paused');
  await assert.rejects(s.runtime.execute(session, 'org_read_board', {}), /paused/);
  assert.equal((await s.org.members(orgId)).length, 3, 'nothing deleted');
  assert.equal((await s.tasks.list(orgId)).length, 1);
  assert.match(s.announced.at(-1)!.text, /Organization mode is off/);
  // resume through the workspace route is refused while off
  await assert.rejects(s.controller.resume(s.ws.id), /organization mode is off/);

  const on = await s.controller.set(s.ws.id, { mode: 'supervised' });
  assert.equal(on.orgStatus, 'active');
  assert.match(await s.runtime.execute(session, 'org_read_board', {}), /Draft/);
  assert.match(s.announced.at(-1)!.text, /off → supervised/);

  // the kill switch under the workspace
  const paused = await s.controller.pause(s.ws.id);
  assert.equal(paused.orgStatus, 'paused'); assert.equal(paused.mode, 'supervised', 'pause does not change the mode');
  assert.equal((await s.controller.resume(s.ws.id)).orgStatus, 'active');
  const actions = (await s.audit.list(orgId, { limit: 100 })).map((r) => r.action);
  assert.ok(actions.includes('org_pause') && actions.includes('org_resume'));
});

test('autonomous hire executes within caps (audit, inbox, #company) and refuses each cap with its reason — never queues', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'autonomous', { monthlyUsd: 20, agentCap: 5 });
  const before = (await s.agents.list()).length;

  // why is required in autonomous mode
  await assert.rejects(s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'Marketer', title: 'Growth' }), /why is required/);
  const out = await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'Marketer', title: 'Growth', scopes: ['tool:fs_write', 'tool:gmail_send'], monthlyBudgetUsd: 5, why: 'Launch posts have no owner.' });
  assert.match(out, /^Hired Marketer \(Growth\) at depth 2, reporting to you/);
  assert.match(out, /dropped because you do not hold them: tool:gmail_send/);
  assert.equal((await s.agents.list()).length, before + 1, 'the agent exists at once');
  assert.equal((await s.approvals.pending(orgId)).length, 0, 'no approval card');
  const hired = (await s.agents.list()).find((a) => a.name === 'Marketer')!;
  const m = (await s.org.member(orgId, hired.id))!;
  assert.deepEqual(JSON.parse(m.scopes), ['tool:fs_write'], 'meet(chief, requested)');
  assert.equal(m.reportsToAgentId, s.chief.id);
  assert.equal(hired.loops, '[]', 'no inheritance');
  assert.equal((await s.org.budget(orgId, 'agent', hired.id))!.monthlyUsd, 5);
  const row = (await s.audit.list(orgId, { action: 'auto_hire' }))[0];
  assert.equal(row.actor, 'chief');
  const payload = JSON.parse(row.payload) as { reason: string; agentId: string; monthlyBudgetUsd: number };
  assert.equal(payload.reason, 'Launch posts have no owner.'); assert.equal(payload.agentId, hired.id); assert.equal(payload.monthlyBudgetUsd, 5);
  assert.ok((await s.agents.listEvents(s.chief.id)).some((e) => e.kind === 'info' && /Autonomous hire: Marketer as Growth/.test(e.title)));
  assert.match(s.announced.at(-1)!.text, /^Hired: Marketer as Growth \(Marketer pack\), reporting to Chief, \$5\.00\/month — Launch posts have no owner\./);

  // agent cap: 4 members of 5 → one more fits, the next is refused
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'Analyst', title: 'Numbers', charter: 'You count.', why: 'metrics' });
  await assert.rejects(s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'T6', title: 't', charter: 'c', why: 'x' }), /refused: the company already has 5 member\(s\), the agent cap is 5/);
  assert.equal((await s.approvals.pending(orgId)).length, 0, 'refusals are not queued');

  // fan-out: raise the cap, fill the chief's five seats, the sixth is refused
  await s.controller.set(s.ws.id, { mode: 'autonomous', agentCap: 20 });
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'T5', title: 't', charter: 'c', why: 'x' });
  assert.equal((await s.org.members(orgId)).filter((x) => x.reportsToAgentId === s.chief.id).length, 5);
  await assert.rejects(s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'T6', title: 't', charter: 'c', why: 'x' }), /refused: fan-out limit \(5 direct reports/);
  // depth: under Writer (depth 2) fits at depth 3; under that one is refused
  const d3 = await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'Deep', title: 'Deep', charter: 'c', reportsTo: 'Writer', why: 'x' });
  assert.match(d3, /at depth 3, reporting to Writer/);
  await assert.rejects(s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'Deeper', title: 'd', charter: 'c', reportsTo: 'Deep', why: 'x' }), /refused: depth limit \(3\)/);
  // envelope: $5 allocated of $20; a $16 hire is refused with the arithmetic
  await assert.rejects(s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'Pricey', title: 'p', charter: 'c', reportsTo: 'Writer', monthlyBudgetUsd: 16, why: 'x' }), /refused: allocating \$16\.00 would put allocated envelopes at \$21\.00, above the company envelope of \$20\.00 \(already allocated: \$5\.00\)/);
  // no company envelope at all → any allocation is refused
  await s.controller.set(s.ws.id, { mode: 'autonomous', monthlyUsd: 0 });
  await assert.rejects(s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'Pricey', title: 'p', charter: 'c', reportsTo: 'Writer', monthlyBudgetUsd: 1, why: 'x' }), /refused: the company has no monthly envelope/);
  assert.equal((await s.approvals.pending(orgId)).length, 0);
  // the chief's inbox and the audit carry every executed hire; refusals leave no auto_ row
  assert.equal((await s.audit.list(orgId, { action: 'auto_hire' })).length, 4);
});

test('scope widening executes in autonomous mode (within the chief\'s holdings) and is an approval in supervised mode', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'autonomous');
  await s.org.setScopes(orgId, s.writer.id, ['tool:fs_read'], { actor: 'user', force: true });
  await assert.rejects(s.runtime.execute(session, 'org_set_scope', { agent: 'Writer', scopes: ['tool:fs_read', 'tool:web_search'] }), /why is required/);
  const out = await s.runtime.execute(session, 'org_set_scope', { agent: 'Writer', scopes: ['tool:fs_read', 'tool:web_search'], why: 'needs research' });
  assert.match(out, /widened to: tool:fs_read, tool:web_search \(\+tool:web_search/);
  assert.deepEqual(JSON.parse((await s.org.member(orgId, s.writer.id))!.scopes), ['tool:fs_read', 'tool:web_search']);
  assert.equal((await s.approvals.pending(orgId)).length, 0);
  assert.equal((await s.audit.list(orgId, { action: 'auto_scope_widen' })).length, 1);
  assert.match(s.announced.at(-1)!.text, /^Scope widened: Writer \+tool:web_search — needs research/);
  // never beyond the chief's own holdings, in either mode
  await assert.rejects(s.runtime.execute(session, 'org_set_scope', { agent: 'Writer', scopes: ['tool:run_code'], why: 'x' }), /cannot grant what you do not hold: tool:run_code/);
  // narrowing stays immediate and silent (no auto_ row)
  assert.match(await s.runtime.execute(session, 'org_set_scope', { agent: 'Writer', scopes: ['tool:fs_read'] }), /narrowed to: tool:fs_read/);

  await s.controller.set(s.ws.id, { mode: 'supervised' });
  const sup = await s.runtime.execute(session, 'org_set_scope', { agent: 'Writer', scopes: ['tool:fs_read', 'tool:web_search'], why: 'again' });
  assert.match(sup, /Widening needs the CEO/);
  assert.deepEqual(JSON.parse((await s.org.member(orgId, s.writer.id))!.scopes), ['tool:fs_read']);
  assert.equal((await s.approvals.pending(orgId))[0].kind, 'scope_widen');
});

test('org_allocate_budget respects the company envelope in autonomous mode; the company cap stays the CEO\'s; the old tool names still work', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'autonomous', { monthlyUsd: 10 });
  const ok = await s.runtime.execute(session, 'org_allocate_budget', { scope: 'agent', agent: 'Writer', monthlyUsd: 6, why: 'most of the work' });
  assert.match(ok, /agent envelope of Writer set to \$6\.00\/month \(allocated \$6\.00 of the \$10\.00 company envelope\)/);
  assert.equal((await s.org.budget(orgId, 'agent', s.writer.id))!.monthlyUsd, 6);
  await assert.rejects(s.runtime.execute(session, 'org_allocate_budget', { scope: 'agent', agent: 'Editor', monthlyUsd: 5, why: 'x' }), /refused: allocating \$5\.00 would put allocated envelopes at \$11\.00, above the company envelope of \$10\.00 \(already allocated: \$6\.00\)/);
  // re-allocating the same envelope counts only the others
  assert.match(await s.runtime.execute(session, 'org_allocate_budget', { scope: 'agent', agent: 'Writer', monthlyUsd: 8, why: 'more' }), /\$8\.00\/month \(allocated \$8\.00 of the \$10\.00/);
  // Item 31 (docs/boundary.md): money above the envelope is a card for the CEO, in every mode.
  assert.match(await s.runtime.execute(session, 'org_allocate_budget', { scope: 'company', monthlyUsd: 50, why: 'x' }), /Not yours to change alone: the company envelope \(\$10\.00\/month\) is the CEO's to set .*Proposed to the CEO as approval/);
  assert.equal((await s.org.get(orgId)).monthlyBudgetUsd, 10);
  // lowering stays a narrowing, no why needed
  assert.match(await s.runtime.execute(session, 'org_allocate_budget', { scope: 'agent', agent: 'Writer', monthlyUsd: 2 }), /lowered to \$2\.00/);
  assert.equal((await s.audit.list(orgId, { action: 'auto_budget' })).length, 2);
  assert.deepEqual((await s.approvals.pending(orgId)).map((a) => a.kind), ['budget_raise'], 'only the company envelope card');
  // the alias name routes to the same tool
  assert.match(await s.runtime.execute(session, 'org_budget_request', { scope: 'agent', agent: 'Editor', monthlyUsd: 3, why: 'alias' }), /agent envelope of Editor set to \$3\.00/);
  assert.ok(s.runtime.owns('org_budget_request') && s.runtime.owns('org_propose_reorg') && s.runtime.owns('org_allocate_budget') && s.runtime.owns('org_reorg'));
  const specs = (await s.runtime.specsFor(session)).map((x) => x.name);
  assert.ok(specs.includes('org_reorg') && specs.includes('org_allocate_budget') && specs.includes('org_review_structure'));
  assert.ok(!specs.includes('org_propose_reorg') && !specs.includes('org_budget_request'), 'old names are accepted, not offered');
  // in supervised mode the same calls are approvals again
  await s.controller.set(s.ws.id, { mode: 'supervised' });
  assert.match(await s.runtime.execute(session, 'org_budget_request', { scope: 'company', monthlyUsd: 50, why: 'more' }), /Budget raise proposed/);
  assert.equal((await s.approvals.pending(orgId))[0].kind, 'budget_raise');
});

test('org_reorg executes in autonomous mode (in order, stopping at the first refusal), terminates immediately, and audits every step', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'autonomous');
  const out = await s.runtime.execute(session, 'org_reorg', { changes: [{ op: 'move', agent: 'Editor', reportsTo: 'Writer' }, { op: 'retitle', agent: 'Writer', title: 'Lead writer' }], why: 'Editor reviews Writer; one line of report.' });
  assert.match(out, /^Reorg applied \(2 change\(s\)\): move Editor → Writer; retitle Writer → "Lead writer"/);
  const editor = (await s.org.member(orgId, s.editor.id))!;
  assert.equal(editor.reportsToAgentId, s.writer.id); assert.equal(editor.depth, 3);
  assert.equal((await s.org.member(orgId, s.writer.id))!.title, 'Lead writer');
  assert.equal((await s.approvals.pending(orgId)).length, 0);
  const row = (await s.audit.list(orgId, { action: 'auto_reorg' }))[0];
  assert.equal((JSON.parse(row.payload) as { changes: unknown[]; reason: string }).changes.length, 2);
  assert.match(s.announced.at(-1)!.text, /^Reorganized: move Editor → Writer; retitle Writer → "Lead writer" — Editor reviews/);
  // a refused step stops the batch with the reason; earlier steps stay
  const deep = await s.agents.create({ name: 'Deep' });
  await s.org.addMember(orgId, { agentId: deep.id, reportsToAgentId: s.chief.id });
  // Item 31 (docs/boundary.md): moving Deep into Writer's unit crosses units — a card, nothing applied
  assert.match(await s.runtime.execute(session, 'org_reorg', { changes: [{ op: 'pause', agent: 'Deep' }, { op: 'move', agent: 'Deep', reportsTo: 'Editor' }], why: 'x' }), /reorg across units changes only through an experiment/);
  assert.equal((await s.org.member(orgId, deep.id))!.status, 'active');
  await assert.rejects(s.runtime.execute(session, 'org_reorg', { changes: [{ op: 'pause', agent: 'Chief' }], why: 'x' }), /cannot move, pause or terminate yourself/);
  // termination is immediate, with the reports moving up
  // Item 31: terminating a lead (Writer leads Editor) reshapes two units — an experiment, a card until experiments exist
  assert.match(await s.runtime.execute(session, 'org_terminate_agent', { agent: 'Writer', why: 'redundant' }), /terminate a unit lead .*changes only through an experiment/);
  assert.equal((await s.org.member(orgId, s.writer.id))!.status, 'active');
  const t = await s.tasks.create(orgId, { title: 'x', assigneeAgentId: s.editor.id });
  s.runtime.cancelWakesFor(orgId, s.editor.id);
  assert.match(await s.runtime.execute(session, 'org_terminate_agent', { agent: 'Editor', why: 'redundant' }), /Editor is terminated: its reports moved up one level/);
  assert.equal((await s.org.member(orgId, s.editor.id))!.status, 'terminated');
  assert.equal(await s.runtime.runTask(orgId, t.id, s.editor.id, 'manual'), 'skipped:member_inactive');
  assert.equal((await s.audit.list(orgId, { action: 'auto_terminate' })).length, 1);
  // supervised: the same call is a proposal, and the old name still proposes
  await s.controller.set(s.ws.id, { mode: 'supervised' });
  assert.match(await s.runtime.execute(session, 'org_propose_reorg', { changes: [{ op: 'resume', agent: 'Deep' }], why: 'back' }), /Reorg proposed/);
  assert.equal((await s.approvals.pending(orgId))[0].kind, 'reorg');
});

test('org_review_structure summarises idle and overloaded members, unassigned goals, blocked tasks and headroom', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'autonomous', { monthlyUsd: 30, agentCap: 8 });
  await s.org.addGoal(orgId, { title: 'Grow the newsletter' });
  await s.org.setBudget(orgId, { scope: 'agent', refId: s.writer.id, monthlyUsd: 12 });
  for (let i = 0; i < 4; i++) { await s.tasks.create(orgId, { title: `Piece ${i}`, assigneeAgentId: s.writer.id }); }
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  const blocked = await s.tasks.create(orgId, { title: 'Stuck', assigneeAgentId: s.editor.id });
  s.runtime.cancelWakesFor(orgId, s.editor.id);
  await s.tasks.update(orgId, blocked.id, { status: 'blocked', blockers: ['no source'] });
  await s.tasks.create(orgId, { title: 'Nobody owns this', status: 'backlog' });
  const out = await s.runtime.execute(session, 'org_review_structure', {});
  assert.match(out, /Members: 3 of 8 \(cap\)/);
  assert.match(out, /Envelopes: \$12\.00 allocated of the \$30\.00 company envelope/);
  assert.match(out, /Mode: autonomous/);
  assert.match(out, /Writer \(member, depth 2, 0\/5 reports\): 4 open task\(s\), 0 run\(s\) this week — OVERLOADED \(4 open tasks\)/);
  assert.match(out, /Editor .* — IDLE \(no open task, no run in 7 days\)/, 'a blocked task is not open work');
  assert.match(out, /Grow the newsletter — UNASSIGNED: no owner and no open task under it/);
  assert.match(out, /1 unassigned task\(s\), 1 blocked/);
  assert.match(out, /blocked \[.{8}\] Stuck \(Editor\)/);
  // a member cannot call it
  const w = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'w' });
  await assert.rejects(s.runtime.execute(w, 'org_review_structure', {}), /chief-of-staff tool/);
});

test('board events wake the autonomous chief into one coalesced structure review; supervised mode never does', async () => {
  const reviewRound: AiStreamEvent[] = [{ type: 'tool_call', id: 'r1', name: 'org_review_structure', input: {} }, { type: 'done' }];
  const answer: AiStreamEvent[] = [{ type: 'answer', text: 'Structure is fine.' }, { type: 'done' }];
  const s = await setup([reviewRound, answer]);
  const { orgId } = await enable(s, 'supervised');
  await s.org.addGoal(orgId, { title: 'A goal' });
  assert.deepEqual(s.runtime.pendingReviewOrgs(), [orgId], 'the event is queued');
  assert.equal(await s.runtime.flushReview(orgId), 'skipped:not_autonomous');
  assert.equal(s.provider.requests.length, 0);

  await s.controller.set(s.ws.id, { mode: 'autonomous' });
  const t = await s.tasks.create(orgId, { title: 'Stuck', assigneeAgentId: s.writer.id });
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  await s.tasks.update(orgId, t.id, { status: 'blocked', blockers: ['waiting on data'] });
  await s.tasks.escalate(orgId, t.id, 'cannot proceed', 'system');
  await s.org.addGoal(orgId, { title: 'Another goal' });
  assert.deepEqual(s.runtime.pendingReviewOrgs(), [orgId], 'three events, one review');
  await s.runtime.flushReviews();
  assert.equal(s.provider.requests.length, 2, 'one run: the review tool round and the answer');
  const req = s.provider.requests[0];
  assert.match(req.system, /# Organisation structure review/);
  assert.match(req.system, /Caps you act within: depth ≤ 3, ≤ 5 direct reports per member, ≤ 12 members/);
  const user = [...req.messages].reverse().find((m) => m.role === 'user')!.content;
  assert.match(user, /trigger: board/);
  assert.match(user, /blocked: "Stuck" is blocked: waiting on data/);
  assert.match(user, /escalation: "Stuck" escalated: cannot proceed/);
  assert.match(user, /goal: new objective "Another goal"/);
  assert.ok(req.tools!.some((x) => x.name === 'org_review_structure') && req.tools!.some((x) => x.name === 'org_hire_agent'), 'manager tools offered');
  const toolResult = s.provider.requests[1].messages.find((m) => m.role === 'tool')!.content;
  assert.match(toolResult, /structure review/);
  const sess = (await s.repo.listSessions(s.ws.id)).find((x) => x.name.endsWith('Chief review'))!;
  assert.ok(sess && sess.agentId === s.chief.id && sess.permissionMode === 'auto');
  const actions = (await s.audit.list(orgId, { limit: 100 })).map((r) => r.action);
  assert.ok(actions.includes('chief_review_start') && actions.includes('chief_review_end') && actions.includes('spend_reserve'));
  assert.ok((await s.agents.listEvents(s.chief.id)).some((e) => e.kind === 'org_run' && /Reviewed the structure/.test(e.title)));
  // cooldown: a second burst within the window is skipped, not run
  await s.org.addGoal(orgId, { title: 'Third' });
  assert.equal(await s.runtime.flushReview(orgId), 'skipped:cooldown');
  assert.equal(s.provider.requests.length, 2);
  // the daily review fires at the brief hour once a day (workspace time)
  s.runtime.reviewCooldownMs = 0;
  await s.workspaces.update(s.ws.id, { quietHours: JSON.stringify({ start: '22:00', end: '07:00', timezone: 'Asia/Bangkok', policy: 'queue' }) });
  await s.org.update(orgId, { briefHour: 8 });
  await s.runtime.tick(new Date('2026-07-16T01:00:00.000Z'));
  const daily = (await s.audit.list(orgId, { action: 'chief_review_start' })).filter((r) => (JSON.parse(r.payload) as { trigger: string }).trigger === 'daily');
  assert.equal(daily.length, 1);
  await s.runtime.tick(new Date('2026-07-16T01:20:00.000Z'));
  assert.equal((await s.audit.list(orgId, { action: 'chief_review_start' })).filter((r) => (JSON.parse(r.payload) as { trigger: string }).trigger === 'daily').length, 1, 'once a day');
  s.runtime.onModuleDestroy();
});

test('the brief lists the autonomous actions since the last brief; the workspace aliases resolve to the org', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'autonomous', { monthlyUsd: 25 });
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'Analyst', title: 'Numbers', charter: 'You count.', monthlyBudgetUsd: 4, why: 'metrics nobody tracks' });
  await s.runtime.execute(session, 'org_reorg', { changes: [{ op: 'retitle', agent: 'Writer', title: 'Lead' }], why: 'clarity' });
  const b = await s.brief.compose(orgId, { deliver: false });
  assert.match(b.text, /## Autonomous actions\n- hire: Analyst as Numbers, reporting to Chief, \$4\.00\/month — metrics nobody tracks\n- reorg: retitle Writer → "Lead" — clarity/);
  assert.match(b.text, /## Decisions needed\n- none/);

  // aliases: the workspace-scoped controller resolves the org and delegates
  const detail = await s.controller.detail(s.ws.id);
  assert.equal(detail.id, orgId); assert.equal(detail.members.length, 4);
  const board = await s.controller.board(s.ws.id);
  assert.equal(board.length, 0);
  const task = await s.controller.addTask(s.ws.id, { title: 'Via alias', assigneeAgentId: s.writer.id } as never);
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  assert.equal((await s.orgs.board(orgId))[0].id, task.id);
  assert.equal((await s.controller.spend(s.ws.id)).company.monthlyUsd, 25);
  assert.equal((await s.controller.auditList(s.ws.id)).length > 5, true);
  assert.deepEqual(s.controller.caps().maxDepth, 3);
  assert.equal((await s.controller.latestBrief(s.ws.id)), null, 'compose without deliver stores nothing');
  const other = await s.workspaces.create({ name: 'Other' });
  await assert.rejects(s.controller.detail(other.id), /no organization yet/);
  // a goal added through the alias emits the board event like the direct route
  await s.controller.addGoal(s.ws.id, { title: 'Alias goal' } as never);
  assert.deepEqual(s.runtime.pendingReviewOrgs(), [orgId]);
  s.runtime.onModuleDestroy();
});

test('changing the chief swaps the two seats and keeps the tree shape; the migration-era legacy route still creates a supervised company', async () => {
  const s = await setup();
  const { orgId } = await enable(s, 'supervised');
  const deep = await s.agents.create({ name: 'Deep' });
  await s.org.addMember(orgId, { agentId: deep.id, reportsToAgentId: s.writer.id });
  const st = await s.controller.set(s.ws.id, { mode: 'supervised', chiefOfStaffAgentId: s.writer.id });
  assert.equal(st.chiefOfStaffAgentId, s.writer.id);
  const members = await s.org.members(orgId);
  const by = (id: string) => members.find((m) => m.agentId === id)!;
  assert.equal(by(s.writer.id).reportsToAgentId, null); assert.equal(by(s.writer.id).depth, 1); assert.equal(by(s.writer.id).title, 'Chief of staff');
  assert.equal(by(s.chief.id).reportsToAgentId, s.writer.id); assert.equal(by(s.chief.id).depth, 2);
  assert.equal(by(s.editor.id).reportsToAgentId, s.writer.id); assert.equal(by(s.editor.id).depth, 2);
  assert.equal(by(deep.id).reportsToAgentId, s.chief.id, 'Writer\'s old report now sits under the old chief, where Writer was'); assert.equal(by(deep.id).depth, 3);
  assert.equal((await s.workspaces.get(s.ws.id)).chiefOfStaffAgentId, s.writer.id);
  assert.ok((await s.audit.list(orgId, { action: 'chief_replace' })).length === 1);

  // legacy POST /api/orgs on a fresh workspace lands it in supervised mode
  const other = await s.workspaces.create({ name: 'Legacy' });
  const legacyChief = await s.agents.create({ name: 'Legacy chief', workspaceId: other.id }); // an agent of that workspace (item 26)
  const o = await s.orgs.create({ workspaceId: other.id, name: 'Legacy Co', chiefOfStaffAgentId: legacyChief.id });
  const w = await s.workspaces.get(other.id);
  assert.equal(w.orgMode, 'supervised'); assert.equal(w.chiefOfStaffAgentId, legacyChief.id);
  assert.equal((await s.controller.status(other.id)).orgId, o.id);
});
