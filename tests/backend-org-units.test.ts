/** Units (docs/group-chat.md §7, execution-plan item 17): a board, a channel
 *  and a goal tracker per org level. The root unit and `#company` appear when
 *  organization mode is enabled; a unit and its `#<slug>` channel appear when
 *  a member gains its first report and are archived when its last report
 *  leaves; channel membership follows hires, reorgs and terminations; tasks
 *  default to the unit led by the assignee's manager; status lines of tasks
 *  that did not come from a channel post into the unit channel; goal progress
 *  blends linked tasks with child goals; leads get a unit-scoped tool set;
 *  `#goal:<id>` references resolve; the migration backfills an existing org. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import * as schema from '../server/src/database/schema';
import { channelMembers, channels, orgGoals, orgTasks, orgUnits } from '../server/src/database/schema';
import { runPgMigrations, backfillOrgUnits } from '../server/src/database/migrator';
import type { DrizzleDb } from '../server/src/database/database.module';
import { scopeDb } from '../server/src/accounts/scoped-db';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, pgliteQueryable, ScriptedProvider } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { GroupChatService, COMPANY_SLUG } from '../server/src/groupchat/groupchat.service';
import { WorkspaceEventBus } from '../server/src/groupchat/workspace-events';
import { parseGoalRefs } from '../server/src/groupchat/mentions';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService, blendProgress, unitSlug } from '../server/src/org/org-units.service';
import { OrgController } from '../server/src/org/org.controller';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

/** The org stack with the group chat bound into the Announcer seam (what
 *  the modules do at boot), or without it (`groupchat: false`). */
async function setup(opts: { groupchat?: boolean; db?: DrizzleDb } = {}) {
  const db = opts.db ?? await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider([]);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer();
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units);
  runtime.debounceMs = 15;
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config, units);
  const controller = new WorkspaceOrgController(mode, orgs, config);
  const groupchat = opts.groupchat === false ? null : new GroupChatService(db, workspaces, agents, stub, new WorkspaceEventBus(), config, undefined, bus, org, tasks, announcer);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit.' });
  return { db, agents, workspaces, repo, bus, audit, org, units, tasks, approvals, runtime, mode, orgs, controller, groupchat, ws, chief, writer, editor, announcer };
}
type S = Awaited<ReturnType<typeof setup>>;

async function enable(s: S, modeName: 'supervised' | 'autonomous' = 'autonomous') {
  const st = await s.mode.setMode(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: 10 });
  return st.orgId!;
}

const agentsIn = async (s: S, channelId: string) => (await s.groupchat!.members(channelId)).filter((m) => m.memberKind === 'agent').map((m) => m.memberId).sort();
const humansIn = async (s: S, channelId: string) => (await s.groupchat!.members(channelId)).filter((m) => m.memberKind === 'human').map((m) => m.memberId).sort();

// ---- 1. root unit ----

test('enabling organization mode creates the root unit (the company) with #company as its channel; the tree lists it', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const list = await s.units.units(orgId);
  assert.equal(list.length, 1, 'only the root: nobody but the chief has reports');
  const root = list[0];
  assert.equal(root.leadAgentId, s.chief.id);
  assert.equal(root.parentUnitId, null);
  assert.equal(root.slug, 'company');
  assert.equal(root.name, s.ws.name, 'the root is named after the workspace');
  const company = await s.groupchat!.bySlug(s.ws.id, COMPANY_SLUG);
  assert.equal(root.channelId, company.id);
  assert.deepEqual(await agentsIn(s, company.id), [s.chief.id, s.writer.id, s.editor.id].sort(), 'every member is in #company');
  assert.ok((await s.groupchat!.unitOf(company.id))?.id === root.id, 'the channel knows its unit');
  const tree = await s.units.unitTree(orgId);
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].memberAgentIds.sort(), [s.chief.id, s.writer.id, s.editor.id].sort());
  assert.equal(tree[0].children.length, 0);
  // the workspace status carries the tree for the rail
  const st = await s.controller.status(s.ws.id);
  assert.equal(st.units.length, 1);
  assert.equal(st.units[0].slug, 'company');
  // ensureUnitFor is idempotent for the chief
  assert.equal((await s.units.ensureUnitFor(orgId, s.chief.id)).id, root.id);
  assert.equal((await s.db.select().from(orgUnits)).length, 1);
});

// ---- 2 + 3. hires ----

test('hiring under the chief adds the hire to #company only; hiring under a report creates that report\'s unit and #<slug> with lead + reports + the human CEO', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  // under the chief
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'Marketer', title: 'Growth', why: 'Posts have no owner.' });
  const growth = (await s.agents.list()).find((a) => a.name === 'Marketer')!;
  const company = await s.groupchat!.bySlug(s.ws.id, COMPANY_SLUG);
  assert.ok((await agentsIn(s, company.id)).includes(growth.id), 'the hire is in #company');
  assert.equal((await s.units.units(orgId)).length, 1, 'no new unit: the chief already leads the root');
  // under Writer → Writer leads a unit now
  const out = await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'Researcher', charter: 'You find sources.', title: 'Analyst', reportsTo: 'Writer', why: 'Writer needs sources.' });
  assert.match(out, /reporting to Writer/);
  const analyst = (await s.agents.list()).find((a) => a.name === 'Researcher')!;
  const list = await s.units.units(orgId);
  assert.equal(list.length, 2);
  const unit = list.find((u) => u.leadAgentId === s.writer.id)!;
  assert.equal(unit.slug, 'writer');
  assert.equal(unit.name, "Writer's team");
  assert.equal(unit.parentUnitId, list.find((u) => u.slug === 'company')!.id);
  const ch = await s.groupchat!.get(unit.channelId!);
  assert.equal(ch.slug, 'writer');
  assert.deepEqual(await agentsIn(s, ch.id), [s.writer.id, analyst.id].sort(), 'lead + direct report, nobody else');
  assert.deepEqual(await humansIn(s, ch.id), ['single'], 'the owner (CEO)');
  assert.ok((await agentsIn(s, company.id)).includes(analyst.id), 'and the hire is in #company too');
  // the autonomous hire line landed in the unit channel as well as #company
  const unitMsgs = (await s.groupchat!.messages(ch.id)).messages;
  assert.equal(unitMsgs.length, 1);
  assert.match(unitMsgs[0].text, /Researcher joined this unit as Analyst, reporting to Writer/);
  assert.match((await s.groupchat!.messages(company.id)).messages.at(-1)!.text, /^Hired: Researcher as Analyst/);
  // audit
  const actions = (await s.audit.list(orgId, { limit: 100 })).map((r) => r.action);
  assert.ok(actions.includes('unit_create'));
  // the slug de-duplicates against a channel a person already made
  await s.groupchat!.create(s.ws.id, { name: 'Editor' });
  await s.org.addMember(orgId, { agentId: (await s.agents.create({ name: 'Proofreader' })).id, reportsToAgentId: s.editor.id, scopes: [] });
  const editorUnit = (await s.units.units(orgId)).find((u) => u.leadAgentId === s.editor.id)!;
  assert.equal(editorUnit.slug, 'editor-2');
  assert.equal((await s.groupchat!.get(editorUnit.channelId!)).slug, 'editor-2');
});

// ---- 4 + 5. reorg and terminate ----

test('a reorg moves channel membership between unit channels; terminating the last report archives the unit and its channel; it comes back when the lead gains a report again', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const a1 = await s.agents.create({ name: 'Alpha' });
  const a2 = await s.agents.create({ name: 'Beta' });
  await s.org.addMember(orgId, { agentId: a1.id, reportsToAgentId: s.writer.id, scopes: [] });
  await s.org.addMember(orgId, { agentId: a2.id, reportsToAgentId: s.editor.id, scopes: [] });
  const writerUnit = (await s.units.units(orgId)).find((u) => u.leadAgentId === s.writer.id)!;
  const editorUnit = (await s.units.units(orgId)).find((u) => u.leadAgentId === s.editor.id)!;
  assert.deepEqual(await agentsIn(s, writerUnit.channelId!), [s.writer.id, a1.id].sort());
  assert.deepEqual(await agentsIn(s, editorUnit.channelId!), [s.editor.id, a2.id].sort());

  // reorg: Beta moves from Editor's unit to Writer's. Since item 31 (docs/boundary.md) a move
  // across units is an experiment — a card for the CEO until experiments exist — so the CEO approves it.
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  const out = await s.runtime.execute(session, 'org_reorg', { changes: [{ op: 'move', agent: 'Beta', reportsTo: 'Writer' }], why: 'Beta edits what Writer writes.' });
  assert.match(out, /reorg across units changes only through an experiment/);
  const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'reorg')!;
  await s.approvals.decide(orgId, card.id, 'approve');
  assert.deepEqual(await agentsIn(s, writerUnit.channelId!), [s.writer.id, a1.id, a2.id].sort(), 'Beta joined #writer');
  // Editor lost its last report: its unit is archived, the channel archived, the data kept
  const editorNow = (await s.db.select().from(orgUnits).where(eq(orgUnits.id, editorUnit.id)))[0];
  assert.ok(editorNow.archivedAt, 'archived');
  assert.ok((await s.groupchat!.get(editorUnit.channelId!)).archivedAt, 'channel archived');
  assert.equal((await s.units.units(orgId)).length, 2, 'root + writer');
  // the unit it emptied closed with an archive line
  assert.match((await s.groupchat!.messages(editorUnit.channelId!)).messages.at(-1)!.text, /^Unit archived: Editor has no direct reports left/);

  // terminate Alpha (user path): Writer still has Beta, so #writer stays and Alpha leaves it and #company
  await s.org.terminateMember(orgId, a1.id);
  assert.deepEqual(await agentsIn(s, writerUnit.channelId!), [s.writer.id, a2.id].sort());
  const company = await s.groupchat!.bySlug(s.ws.id, COMPANY_SLUG);
  assert.ok(!(await agentsIn(s, company.id)).includes(a1.id), 'terminated members leave #company');
  // terminate Beta: Writer's unit empties and is archived
  await s.org.terminateMember(orgId, a2.id);
  assert.ok((await s.db.select().from(orgUnits).where(eq(orgUnits.id, writerUnit.id)))[0].archivedAt);
  assert.equal((await s.units.units(orgId)).length, 1);
  // a new report under Editor un-archives the same unit row and channel (one row per lead, ever)
  const a3 = await s.agents.create({ name: 'Gamma' });
  await s.org.addMember(orgId, { agentId: a3.id, reportsToAgentId: s.editor.id, scopes: [] });
  const back = (await s.units.units(orgId)).find((u) => u.leadAgentId === s.editor.id)!;
  assert.equal(back.id, editorUnit.id);
  assert.equal(back.channelId, editorUnit.channelId);
  assert.equal((await s.groupchat!.get(editorUnit.channelId!)).archivedAt, null);
  assert.deepEqual(await agentsIn(s, editorUnit.channelId!), [s.editor.id, a3.id].sort());
  assert.equal((await s.db.select().from(orgUnits)).length, 3, 'rows are kept, never duplicated');

  // a chief swap re-roots: the root follows the new chief, the old chief leads a unit of its reports
  await s.org.replaceChief(orgId, s.editor.id);
  const units = await s.units.units(orgId);
  const root = units.find((u) => u.parentUnitId === null)!;
  assert.equal(root.leadAgentId, s.editor.id);
  assert.equal(root.channelId, company.id, 'the root keeps #company');
  const oldChief = units.find((u) => u.leadAgentId === s.chief.id);
  assert.ok(oldChief, 'the old chief now reports to Editor and leads Writer (its remaining report)');
  assert.equal(oldChief!.parentUnitId, root.id);
});

// ---- 6. default unitId on tasks ----

test('tasks default to the unit led by the assignee\'s manager: a lead\'s own task sits on its parent board, a task for its report on its own; an explicit unitId is preserved across re-assignment', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const a1 = await s.agents.create({ name: 'Alpha' });
  await s.org.addMember(orgId, { agentId: a1.id, reportsToAgentId: s.writer.id, scopes: [] });
  const root = await s.units.rootUnit(orgId);
  const writerUnit = (await s.units.ledBy(orgId, s.writer.id))!;
  const own = await s.tasks.create(orgId, { title: 'Plan the issue', assigneeAgentId: s.writer.id });
  assert.equal(own.unitId, root.id, "the lead's own task belongs to the parent unit");
  assert.equal(own.unitExplicit, 0);
  const forReport = await s.tasks.create(orgId, { title: 'Collect sources', assigneeAgentId: a1.id });
  assert.equal(forReport.unitId, writerUnit.id, 'a task for a report belongs to the lead\'s unit');
  const chiefTask = await s.tasks.create(orgId, { title: 'Set direction', assigneeAgentId: s.chief.id });
  assert.equal(chiefTask.unitId, root.id, 'the chief\'s tasks are the company\'s');
  const unassigned = await s.tasks.create(orgId, { title: 'Someday' });
  assert.equal(unassigned.unitId, root.id, 'unowned work is the company\'s');
  const byLead = await s.tasks.create(orgId, { title: 'Backlog for my team', createdBy: `agent:${s.writer.id}` });
  assert.equal(byLead.unitId, writerUnit.id, 'an unassigned task a lead creates sits on its own board');
  // re-assignment re-homes a defaulted task …
  await s.tasks.assign(orgId, own.id, a1.id);
  assert.equal((await s.tasks.get(orgId, own.id)).unitId, writerUnit.id);
  // … but not an explicit one
  const pinned = await s.tasks.create(orgId, { title: 'Pinned', assigneeAgentId: s.writer.id, unitId: writerUnit.id });
  assert.equal(pinned.unitId, writerUnit.id); assert.equal(pinned.unitExplicit, 1);
  await s.tasks.assign(orgId, pinned.id, s.chief.id);
  assert.equal((await s.tasks.get(orgId, pinned.id)).unitId, writerUnit.id, 'explicit unit preserved');
  // board filters: the unit's own tasks, and the company roll-up
  const unitBoard = await s.tasks.list(orgId, { unitId: writerUnit.id });
  assert.deepEqual(unitBoard.map((t) => t.id).sort(), [forReport.id, byLead.id, own.id, pinned.id].sort());
  const rootOnly = await s.tasks.list(orgId, { unitId: root.id });
  assert.deepEqual(rootOnly.map((t) => t.id).sort(), [chiefTask.id, unassigned.id].sort());
  assert.equal((await s.tasks.list(orgId, { unitId: root.id, rollUp: true })).length, 6);
  assert.equal((await s.orgs.unitBoard(orgId, writerUnit.id)).length, 4);
  // the tree counts them
  const tree = await s.units.unitTree(orgId);
  assert.equal(tree[0].counts.tasks, 2);
  assert.equal(tree[0].children[0].counts.tasks, 4);
  // PATCH moves a task to another board and pins it
  await s.tasks.update(orgId, unassigned.id, { unitId: writerUnit.id });
  const moved = await s.tasks.get(orgId, unassigned.id);
  assert.equal(moved.unitId, writerUnit.id); assert.equal(moved.unitExplicit, 1);
});

// ---- 7. status lines ----

test('a status change of a task that did not come from a channel posts a one-liner into its unit channel; one made from a message still posts into its thread', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const a1 = await s.agents.create({ name: 'Alpha' });
  await s.org.addMember(orgId, { agentId: a1.id, reportsToAgentId: s.writer.id, scopes: [] });
  const writerUnit = (await s.units.ledBy(orgId, s.writer.id))!;
  const t = await s.tasks.create(orgId, { title: 'Collect sources', assigneeAgentId: a1.id });
  assert.equal(t.channelId, null);
  await s.tasks.update(orgId, t.id, { status: 'in_progress' }, `agent:${a1.id}`);
  await new Promise((r) => setTimeout(r, 30));
  const lines = (await s.groupchat!.messages(writerUnit.channelId!)).messages;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].authorKind, 'system');
  assert.equal(lines[0].threadRootId, null);
  assert.match(lines[0].text, new RegExp(`^Task \\[${t.id.slice(0, 8)}\\] "Collect sources" → in progress$`));
  // a company task → #company
  const c = await s.tasks.create(orgId, { title: 'Set direction', assigneeAgentId: s.chief.id });
  await s.tasks.update(orgId, c.id, { status: 'blocked', blockers: ['waiting'] });
  await new Promise((r) => setTimeout(r, 30));
  const company = await s.groupchat!.bySlug(s.ws.id, COMPANY_SLUG);
  assert.match((await s.groupchat!.messages(company.id)).messages.at(-1)!.text, /"Set direction" → blocked/);
  // made from a message: the thread, not the unit channel
  const general = await s.groupchat!.bySlug(s.ws.id, 'general');
  await s.groupchat!.addMember(general.id, { kind: 'agent', id: a1.id });
  const root = await s.groupchat!.post(general.id, { text: 'Find three sources', authorKind: 'human' });
  const made = await s.groupchat!.makeTask(general.id, root.id, { assigneeAgentId: a1.id, by: { kind: 'human', id: 'single' } });
  assert.equal((await s.tasks.get(orgId, made.task.id)).unitId, writerUnit.id, 'it still sits on the unit board');
  await s.tasks.update(orgId, made.task.id, { status: 'in_progress' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await s.groupchat!.messages(writerUnit.channelId!)).messages.length, 1, 'nothing more in the unit channel');
  const thread = (await s.groupchat!.messages(general.id, { thread: root.id })).messages;
  assert.match(thread.at(-1)!.text, /"Find three sources" → in progress/);
});

// ---- 8. goal tree ----

test('goal progress = done/total of linked tasks blended with the mean of child goals; the tree is scoped by unit; parents must be visible from the unit', async () => {
  // the pure formula
  assert.equal(blendProgress({ total: 4, done: 1 }, []), 0.25);
  assert.equal(blendProgress({ total: 0, done: 0 }, [0.5, 1]), 0.75);
  assert.equal(blendProgress({ total: 2, done: 2 }, [0, 0]), 0.5, 'tasks and children average');
  assert.equal(blendProgress({ total: 0, done: 0 }, []), 0);
  assert.equal(unitSlug('Research Lead'), 'research-lead');

  const s = await setup();
  const orgId = await enable(s);
  const a1 = await s.agents.create({ name: 'Alpha' });
  await s.org.addMember(orgId, { agentId: a1.id, reportsToAgentId: s.writer.id, scopes: [] });
  const root = await s.units.rootUnit(orgId);
  const writerUnit = (await s.units.ledBy(orgId, s.writer.id))!;
  const company = await s.units.addGoal(orgId, { title: 'Ship the newsletter' });
  assert.equal(company.unitId, root.id, 'a goal without a unit is the company\'s');
  const child = await s.units.addGoal(orgId, { title: 'Three issues drafted', unitId: writerUnit.id, parentGoalId: company.id });
  assert.equal(child.parentGoalId, company.id);
  const leaf = await s.units.addGoal(orgId, { title: 'Sources collected', unitId: writerUnit.id, parentGoalId: child.id });
  // a parent outside the unit's ancestry is refused
  const other = await s.org.addMember(orgId, { agentId: (await s.agents.create({ name: 'Omega' })).id, reportsToAgentId: s.editor.id, scopes: [] });
  const editorUnit = (await s.units.ledBy(orgId, s.editor.id))!;
  const editorGoal = await s.units.addGoal(orgId, { title: 'Style guide', unitId: editorUnit.id });
  await assert.rejects(s.units.addGoal(orgId, { title: 'nope', unitId: writerUnit.id, parentGoalId: editorGoal.id }), /must be a goal of this unit or of a unit above it/);
  void other;
  // linked tasks through projects
  const p1 = await s.org.addProject(orgId, { title: 'Issue 1', goalId: child.id });
  const p2 = await s.org.addProject(orgId, { title: 'Sources', goalId: leaf.id });
  const t1 = await s.tasks.create(orgId, { title: 'Draft 1', projectId: p1.id, assigneeAgentId: a1.id });
  await s.tasks.create(orgId, { title: 'Draft 2', projectId: p1.id, assigneeAgentId: a1.id });
  const t3 = await s.tasks.create(orgId, { title: 'Find sources', projectId: p2.id, assigneeAgentId: a1.id });
  await s.tasks.create(orgId, { title: 'Cancelled', projectId: p2.id, status: 'cancelled' });
  await s.tasks.update(orgId, t1.id, { status: 'done' });
  await s.tasks.update(orgId, t3.id, { status: 'done' });
  // leaf: 1/1 tasks (cancelled ignored) = 1; child: 1/2 tasks blended with mean(children)=1 → 0.75; company: no tasks → mean(children) = 0.75
  assert.equal((await s.units.goalProgress(orgId, leaf.id)).progress, 1);
  assert.deepEqual((await s.units.goalProgress(orgId, leaf.id)).tasks, { total: 1, done: 1 });
  assert.equal((await s.units.goalProgress(orgId, child.id)).progress, 0.75);
  assert.equal((await s.units.goalProgress(orgId, company.id)).progress, 0.75);
  // the company tree and the unit tree
  const all = await s.units.goalTree(orgId);
  assert.deepEqual(all.map((g) => g.title).sort(), ['Ship the newsletter', 'Style guide']);
  const ship = all.find((g) => g.title === 'Ship the newsletter')!;
  assert.equal(ship.children.length, 1);
  assert.equal(ship.children[0].children[0].title, 'Sources collected');
  const mine = await s.units.goalTree(orgId, { unitId: writerUnit.id });
  assert.equal(mine.length, 1, 'the unit tree starts at the first goal inside the unit');
  assert.equal(mine[0].title, 'Three issues drafted');
  assert.equal(mine[0].progress, 0.75);
  assert.deepEqual(mine[0].tasks, { total: 2, done: 1 });
  assert.equal((await s.orgs.unitGoals(orgId, editorUnit.id))[0].title, 'Style guide');
  // achieved pins to 100%; the report reads it
  await s.org.updateGoal(orgId, editorGoal.id, { status: 'achieved' });
  assert.equal((await s.units.goalProgress(orgId, editorGoal.id)).progress, 1);
  const names = new Map((await s.agents.list()).map((a) => [a.id, a.name]));
  const report = await s.units.unitReport(orgId, writerUnit.id, names);
  assert.match(report, /# Writer's team \(#writer\)/);
  assert.match(report, /Three issues drafted — 75% \(1\/2 tasks\)/);
  assert.match(report, /Sources collected — 100%/);
  // no cycles through PATCH
  await assert.rejects(s.org.updateGoal(orgId, company.id, { parentGoalId: leaf.id }), /cycle/);
});

// ---- 9. lead tools ----

test('a unit lead gets org_set_goal, org_assign, org_unit_report and may assign only itself and its reports; a plain member gets none; the chief keeps the company-wide set', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const a1 = await s.agents.create({ name: 'Alpha' });
  await s.org.addMember(orgId, { agentId: a1.id, reportsToAgentId: s.writer.id, scopes: [] });
  const writerUnit = (await s.units.ledBy(orgId, s.writer.id))!;
  const writerSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'writer chat' });
  const editorSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.editor.id, name: 'editor chat' });
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  const names = (ss: Awaited<ReturnType<typeof s.runtime.specsFor>>) => ss.map((t) => t.name);
  const leadSpecs = names(await s.runtime.specsFor(writerSession));
  for (const t of ['org_set_goal', 'org_assign', 'org_unit_report', 'org_create_task']) assert.ok(leadSpecs.includes(t), `lead has ${t}`);
  assert.ok(!leadSpecs.includes('org_hire_agent'), 'but not the chief\'s structural tools');
  const memberSpecs = names(await s.runtime.specsFor(editorSession));
  assert.ok(!memberSpecs.includes('org_assign') && !memberSpecs.includes('org_set_goal'), 'a member without reports has no lead tools');
  const chiefSpecs = names(await s.runtime.specsFor(chiefSession));
  for (const t of ['org_set_goal', 'org_unit_report', 'org_assign', 'org_hire_agent']) assert.ok(chiefSpecs.includes(t));
  assert.match((await s.runtime.contextFor(writerSession)) ?? '', /You lead a unit/);

  // scope: assigning to a report works, outside the unit is refused
  const t = await s.tasks.create(orgId, { title: 'Collect sources', createdBy: `agent:${s.writer.id}` });
  assert.equal(t.unitId, writerUnit.id);
  assert.match(await s.runtime.execute(writerSession, 'org_assign', { taskId: t.id.slice(0, 8), agent: 'Alpha' }), /assigned to Alpha/);
  await assert.rejects(s.runtime.execute(writerSession, 'org_assign', { taskId: t.id, agent: 'Editor' }), /outside your unit/);
  await assert.rejects(s.runtime.execute(editorSession, 'org_assign', { taskId: t.id, agent: 'Editor' }), /chief of staff and unit leads/);
  // a task owned by someone outside the unit cannot be pulled in
  const theirs = await s.tasks.create(orgId, { title: 'Style guide', assigneeAgentId: s.editor.id });
  await assert.rejects(s.runtime.execute(writerSession, 'org_assign', { taskId: theirs.id, agent: 'Alpha' }), /not on your unit's board/);
  // org_create_task with assignee: a report yes, an outsider no, a member never
  assert.match(await s.runtime.execute(writerSession, 'org_create_task', { title: 'Outline', outcome: 'An outline', done_when: 'Reviewed', assignee: 'Alpha' }), /assigned to Alpha/);
  await assert.rejects(s.runtime.execute(writerSession, 'org_create_task', { title: 'x', outcome: 'y', done_when: 'z', assignee: 'Editor' }), /outside your unit/);
  await assert.rejects(s.runtime.execute(editorSession, 'org_create_task', { title: 'x', outcome: 'y', done_when: 'z', assignee: 'Alpha' }), /only the chief of staff or a unit lead assigns/);
  const created = (await s.tasks.list(orgId, { unitId: writerUnit.id })).find((x) => x.title === 'Outline')!;
  assert.equal(created.assigneeAgentId, a1.id);
  // goals: the lead's goal lands in its unit; a parent above it is fine, a sibling unit's is not
  const company = await s.units.addGoal(orgId, { title: 'Ship the newsletter' });
  const out = await s.runtime.execute(writerSession, 'org_set_goal', { title: 'Three issues drafted', parentGoalId: company.id.slice(0, 8) });
  assert.match(out, /set for Writer's team \(#writer\) under goal/);
  const mine = (await s.org.goals(orgId, { unitId: writerUnit.id }))[0];
  assert.equal(mine.parentGoalId, company.id); assert.equal(mine.ownerAgentId, s.writer.id);
  await s.org.addMember(orgId, { agentId: (await s.agents.create({ name: 'Omega' })).id, reportsToAgentId: s.editor.id, scopes: [] });
  const editorGoal = await s.units.addGoal(orgId, { title: 'Style guide', unitId: (await s.units.ledBy(orgId, s.editor.id))!.id });
  await assert.rejects(s.runtime.execute(writerSession, 'org_set_goal', { title: 'nope', parentGoalId: editorGoal.id }), /refused: parentGoalId must be a goal of this unit/);
  // the report
  const report = await s.runtime.execute(writerSession, 'org_unit_report', {});
  assert.match(report, /# Writer's team/);
  assert.match(report, /Three issues drafted/);
  assert.match(await s.runtime.execute(chiefSession, 'org_unit_report', { unit: 'writer' }), /# Writer's team/);
  assert.match(await s.runtime.execute(chiefSession, 'org_unit_report', {}), new RegExp(`# ${s.ws.name}`));
  await assert.rejects(s.runtime.execute(writerSession, 'org_hire_agent', { templateOrPack: 'Marketer', title: 'x', why: 'y' }), /chief-of-staff tool/);
  assert.equal(s.runtime.isReadOnly('org_unit_report'), true);
  assert.equal(s.runtime.owns('org_set_goal'), true);
});

// ---- 10. #goal references ----

test('#goal:<id> in a channel message resolves to the goal (full id or an unambiguous prefix) and the goal lists its linked messages', async () => {
  assert.deepEqual(parseGoalRefs('see #goal:abcd1234 and #goal:abcd1234, then #goal:zzzz9999.'), ['abcd1234', 'zzzz9999']);
  assert.deepEqual(parseGoalRefs('no #goal:ab here, nor email#goal:abcd'), []);
  const s = await setup();
  const orgId = await enable(s);
  const g = await s.units.addGoal(orgId, { title: 'Ship the newsletter' });
  const g2 = await s.units.addGoal(orgId, { title: 'Style guide' });
  const general = await s.groupchat!.bySlug(s.ws.id, 'general');
  const m = await s.groupchat!.post(general.id, { text: `Progress on #goal:${g.id.slice(0, 8)} is good; #goal:nope-0000 is unknown`, authorKind: 'human' });
  assert.deepEqual(JSON.parse(m.mentions), [{ kind: 'goal', id: g.id }]);
  const other = await s.groupchat!.post(general.id, { text: `Unrelated #goal:${g2.id}`, authorKind: 'human' });
  const linked = await s.groupchat!.goalMessages(s.ws.id, g.id);
  assert.deepEqual(linked.map((x) => x.id), [m.id]);
  assert.equal(linked[0].slug, 'general');
  assert.deepEqual((await s.groupchat!.goalMessages(s.ws.id, g2.id)).map((x) => x.id), [other.id]);
  // a system line never carries references
  const sys = await s.groupchat!.postSystem(general.id, `#goal:${g.id}`);
  assert.equal(sys.mentions, '[]');
});

// ---- 11. backfill ----

test('the migration backfills an existing organization: root unit + #company (created when missing), a unit per lead with reports and its channel, and unitId on tasks and goals by the default rule', async () => {
  const pg = new PGlite();
  await runPgMigrations(pgliteQueryable(pg), { log: () => {} });
  const db = scopeDb(drizzle(pg, { schema }) as unknown as DrizzleDb);
  // an org built with the group chat unbound: units exist without channels, as a pre-item-17 org would
  const s = await setup({ groupchat: false, db });
  const orgId = await enable(s);
  const a1 = await s.agents.create({ name: 'Alpha' });
  await s.org.addMember(orgId, { agentId: a1.id, reportsToAgentId: s.writer.id, scopes: [] });
  const own = await s.tasks.create(orgId, { title: 'Plan', assigneeAgentId: s.writer.id });
  const forReport = await s.tasks.create(orgId, { title: 'Collect', assigneeAgentId: a1.id });
  const goal = await s.org.addGoal(orgId, { title: 'Ship', ownerAgentId: a1.id });
  const unowned = await s.org.addGoal(orgId, { title: 'Someday' });
  // wipe what item 17 wrote, as an older database looks
  await db.delete(orgUnits);
  await db.update(orgTasks).set({ unitId: null });
  await db.update(orgGoals).set({ unitId: null });
  assert.equal((await db.select().from(channels)).some((c) => c.slug === 'company'), false, 'no #company yet');

  const r = await backfillOrgUnits(pgliteQueryable(pg));
  assert.equal(r.units, 2);
  const units = await db.select().from(orgUnits);
  const root = units.find((u) => u.parentUnitId === null)!;
  assert.equal(root.leadAgentId, s.chief.id); assert.equal(root.slug, 'company'); assert.equal(root.name, s.ws.name);
  const company = (await db.select().from(channels)).find((c) => c.slug === 'company')!;
  assert.ok(company, '#company was created');
  assert.equal(root.channelId, company.id);
  const companyMembers = await db.select().from(channelMembers).where(eq(channelMembers.channelId, company.id));
  assert.deepEqual(companyMembers.filter((m) => m.memberKind === 'agent').map((m) => m.memberId).sort(), [s.chief.id, s.writer.id, s.editor.id, a1.id].sort());
  assert.deepEqual(companyMembers.filter((m) => m.memberKind === 'human').map((m) => m.memberId), ['single']);
  const writerUnit = units.find((u) => u.leadAgentId === s.writer.id)!;
  assert.equal(writerUnit.slug, 'writer'); assert.equal(writerUnit.name, "Writer's team"); assert.equal(writerUnit.parentUnitId, root.id);
  const wm = await db.select().from(channelMembers).where(eq(channelMembers.channelId, writerUnit.channelId!));
  assert.deepEqual(wm.filter((m) => m.memberKind === 'agent').map((m) => m.memberId).sort(), [s.writer.id, a1.id].sort());
  const tasks = await db.select().from(orgTasks);
  assert.equal(tasks.find((t) => t.id === own.id)!.unitId, root.id);
  assert.equal(tasks.find((t) => t.id === forReport.id)!.unitId, writerUnit.id);
  const goals = await db.select().from(orgGoals);
  assert.equal(goals.find((g) => g.id === goal.id)!.unitId, writerUnit.id, 'a goal owned by a report → its lead\'s unit');
  assert.equal(goals.find((g) => g.id === unowned.id)!.unitId, root.id, 'a goal without an owner → the root');
  // running it again changes nothing
  const again = await backfillOrgUnits(pgliteQueryable(pg));
  assert.equal(again.units, 0);
  assert.equal((await db.select().from(orgUnits)).length, 2);
  assert.equal((await db.select().from(channels)).filter((c) => c.slug === 'company').length, 1);
  // and the service, bound later, adopts the backfilled rows
  const s2 = await setup({ db });
  const tree = await s2.units.unitTree(orgId);
  assert.equal(tree[0].id, root.id);
  assert.equal(tree[0].children[0].id, writerUnit.id);
});
