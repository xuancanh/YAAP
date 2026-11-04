/** Department names (docs/group-chat.md §7 "Department names"): a non-root
 *  unit is named after what it heads ("Head of Engineering" → Engineering),
 *  not its lead ("Ada's team", kept only when nothing better is known); the
 *  CEO and the board rename it through the API, the chief and the unit's
 *  own head through org_rename_unit; a rename moves the channel's name and
 *  slug (the old slug stays an alias), audits, posts one line, and never
 *  moves the task key prefix; the 0090 backfill renames units still on the
 *  old default and leaves hand-set names alone, idempotently. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import * as schema from '../server/src/database/schema';
import { channels, orgUnits } from '../server/src/database/schema';
import { runPgMigrations, backfillDepartmentNames } from '../server/src/database/migrator';
import type { DrizzleDb } from '../server/src/database/database.module';
import { scopeDb } from '../server/src/accounts/scoped-db';
import { runWithViewer } from '../server/src/accounts/account-context';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, pgliteQueryable, ScriptedProvider } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { GroupChatService } from '../server/src/groupchat/groupchat.service';
import { WorkspaceEventBus } from '../server/src/groupchat/workspace-events';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgController } from '../server/src/org/org.controller';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import { departmentName, departmentSlug, normalizeDepartmentName, uniqueDepartmentName } from '../server/src/org/unit-names';
import { checkBoundary } from '../server/src/org/boundary';
import { unitNamesOf, unitsOf, validateBlueprint } from '../server/src/org/blueprints/format';
import { BUILTIN_COMPANIES } from '../server/src/registry/builtin-companies.generated';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

async function setup(opts: { db?: DrizzleDb } = {}) {
  const db = opts.db ?? await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(new ScriptedProvider([])), skillsStub(), stub, mcpStub(), agents, workspaces);
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
  const groupchat = new GroupChatService(db, workspaces, agents, stub, new WorkspaceEventBus(), config, undefined, bus, org, tasks, announcer);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const ada = await agents.create({ name: 'Ada', charter: 'You build.' });
  const bo = await agents.create({ name: 'Bo', charter: 'You sell.' });
  const st = await mode.setMode(ws.id, { mode: 'autonomous', chiefOfStaffAgentId: chief.id, monthlyUsd: 50, agentCap: 10 });
  const orgId = st.orgId!;
  return { db, agents, workspaces, repo, audit, org, units, tasks, runtime, orgs, controller, groupchat, ws, chief, ada, bo, orgId };
}
type S = Awaited<ReturnType<typeof setup>>;

/** Ada heads Engineering (a catalog head's title, reporting to the chief); Bo is a plain member. */
async function withEngineering(s: S) {
  await s.org.updateMember(s.orgId, s.ada.id, { title: 'Head of Engineering' });
  await s.org.updateMember(s.orgId, s.bo.id, { title: 'Writer' });
  const dev = await s.agents.create({ name: 'Dev', charter: 'You code.' });
  await s.org.addMember(s.orgId, { agentId: dev.id, title: 'Software Engineer', reportsToAgentId: s.ada.id, scopes: [] });
  await s.units.syncMembership(s.orgId);
  const eng = (await s.units.units(s.orgId)).find((u) => u.leadAgentId === s.ada.id)!;
  return { eng, dev };
}

const session = (s: S, agentId: string) => s.repo.createSession({ workspaceId: s.ws.id, agentId, name: 'chat' });

// ---- the default naming rules ----

test('naming rules: a catalog head names its function, a head- or manager-shaped title what it heads, a function word its function; "<lead>\'s team" only when nothing better is known', () => {
  const n = (title: string) => departmentName({ title, leadName: 'Ada' });
  assert.equal(n('Head of Engineering'), 'Engineering');
  assert.equal(n('Head of Marketing'), 'Marketing');
  assert.equal(n('Head of Customer'), 'Customer Success', 'the catalog head names its function, not its title\'s tail');
  assert.equal(n('General Counsel'), 'Legal');
  assert.equal(n('Head of Growth'), 'Growth');
  assert.equal(n('VP of Sales'), 'Sales');
  assert.equal(n('Director of Operations'), 'Operations');
  assert.equal(n('Support Lead'), 'Support', 'a non-head manager: its role');
  assert.equal(n('Design Manager'), 'Design');
  assert.equal(n('Senior Designer'), 'Design');
  assert.equal(n('Chief Technology Officer'), 'Engineering');
  assert.equal(n('Editor-in-chief'), 'Editorial');
  assert.equal(n('Program Manager'), "Ada's team", 'a coordinator names a role, not a department');
  assert.equal(n('Researcher'), "Ada's team");
  assert.equal(n(''), "Ada's team");
  assert.equal(departmentName({ root: true, orgName: 'Acme', leadName: 'Chief' }), 'Acme', 'the root is the company');
  assert.equal(uniqueDepartmentName('Engineering', 'Ada', ['engineering']), 'Engineering (Ada)');
  assert.equal(uniqueDepartmentName('Engineering', 'Ada', ['Engineering', 'Engineering (Ada)']), 'Engineering 2');
  assert.equal(departmentSlug('IT & Security', 'Ada'), 'it-security');
  assert.equal(departmentSlug("Ada's team", 'Ada'), 'ada', 'the fallback keeps its lead\'s slug');
  assert.equal(normalizeDepartmentName('  Platform   Engineering '), 'Platform Engineering');
  assert.throws(() => normalizeDepartmentName('   '), /cannot be empty/);
  assert.throws(() => normalizeDepartmentName('!!!'), /letter or digit/);
  assert.equal(checkBoundary({ kind: 'unit_name' }, 'agent:x').outcome, 'proceed', 'presentation only: an agent renames alone');
});

test('a new unit takes its department name: #engineering, ENG-n keys; a lead nothing is known about keeps "<lead>\'s team" and #<lead>', async () => {
  const s = await setup();
  const { eng } = await withEngineering(s);
  assert.equal(eng.name, 'Engineering');
  assert.equal(eng.nameSource, 'derived');
  assert.equal(eng.slug, 'engineering');
  const ch = await s.groupchat.get(eng.channelId!);
  assert.equal(ch.slug, 'engineering'); assert.equal(ch.name, 'Engineering');
  assert.match(ch.topic, /^Department channel of Engineering: Ada and its reports/);
  assert.equal(eng.taskKey, 'ENG');
  // Bo (title "Writer") gains a report: nothing better is known
  const intern = await s.agents.create({ name: 'Intern', charter: 'You help.' });
  await s.org.addMember(s.orgId, { agentId: intern.id, title: 'Intern', reportsToAgentId: s.bo.id, scopes: [] });
  await s.units.syncMembership(s.orgId);
  const bos = (await s.units.units(s.orgId)).find((u) => u.leadAgentId === s.bo.id)!;
  assert.equal(bos.name, "Bo's team"); assert.equal(bos.slug, 'bo');
});

// ---- renames: the API ----

test('rename through the API (the CEO): the channel name and slug follow, the old slug still resolves, task keys stay, audited and announced; employees may not', async () => {
  const s = await setup();
  const { eng, dev } = await withEngineering(s);
  const before = await s.tasks.create(s.orgId, { title: 'Fix the build', assigneeAgentId: dev.id });
  assert.match(before.key ?? '', /^ENG-\d+$/);
  const u = await s.controller.renameUnit(s.ws.id, eng.id, { name: '  Platform  ' });
  assert.equal(u.id, eng.id, 'the id is the identity');
  assert.equal(u.name, 'Platform'); assert.equal(u.slug, 'platform'); assert.equal(u.nameSource, 'custom');
  assert.equal(u.taskKey, 'ENG', 'the prefix does not move');
  const ch = await s.groupchat.get(eng.channelId!);
  assert.equal(ch.slug, 'platform'); assert.equal(ch.name, 'Platform');
  assert.match(ch.topic, /^Department channel of Platform/);
  assert.deepEqual(ch.formerSlugs.split(' '), ['engineering']);
  assert.equal((await s.groupchat.bySlug(s.ws.id, 'engineering')).id, ch.id, 'an old link resolves');
  assert.equal((await s.groupchat.open(s.ws.id, 'engineering')).slug, 'platform');
  await assert.rejects(s.groupchat.bySlug(s.ws.id, 'engineering', { exact: true }), /channel #engineering/);
  // keys: the old one resolves, a new task takes the same prefix
  assert.equal((await s.tasks.byPrefix(s.orgId, before.key!)).id, before.id);
  const after = await s.tasks.create(s.orgId, { title: 'Ship it', assigneeAgentId: dev.id });
  assert.match(after.key ?? '', /^ENG-\d+$/);
  // audit and one line in the channel
  const rows = await s.audit.list(s.orgId, { action: 'unit_rename' });
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...JSON.parse(rows[0].payload) }, { name: 'Platform', previous: 'Engineering', slug: 'platform', previousSlug: 'engineering', taskKey: 'ENG' });
  const last = (await s.groupchat.messages(ch.id)).messages.at(-1)!;
  assert.match(last.text, /^Department renamed by the CEO: Engineering → Platform \(#platform; #engineering still links here\)\. Task keys stay ENG-n\.$/);
  // the unit's channel lookup still finds its unit
  assert.equal((await s.groupchat.unitOf(ch.id))?.name, 'Platform');
  // renaming back reuses the slug; no duplicate alias
  await s.controller.renameUnit(s.ws.id, eng.id, { name: 'Engineering' });
  const back = await s.groupchat.get(ch.id);
  assert.equal(back.slug, 'engineering'); assert.deepEqual(back.formerSlugs.split(' '), ['platform']);
  // the same name is a no-op
  await s.controller.renameUnit(s.ws.id, eng.id, { name: 'Engineering' });
  assert.equal((await s.audit.list(s.orgId, { action: 'unit_rename' })).length, 2);
  await assert.rejects(s.controller.renameUnit(s.ws.id, eng.id, { name: '  ' }), /cannot be empty/);
  // an employee may not; a board member may
  await s.org.setHuman(s.orgId, { memberAccountId: 'emp-1', role: 'employee' });
  await s.org.setHuman(s.orgId, { memberAccountId: 'board-1', role: 'board' });
  const as = (id: string) => ({ memberAccountId: id, role: 'member' as const, workspaceId: s.ws.id, displayName: id });
  await assert.rejects(runWithViewer('single', as('emp-1'), () => s.controller.renameUnit(s.ws.id, eng.id, { name: 'Nope' })), /only the CEO and the board rename departments/);
  await assert.rejects(runWithViewer('single', as('stranger'), () => s.controller.renameUnit(s.ws.id, eng.id, { name: 'Nope' })), /no standing/);
  const byBoard = await runWithViewer('single', as('board-1'), () => s.controller.renameUnit(s.ws.id, eng.id, { name: 'Core' }));
  assert.equal(byBoard.name, 'Core');
  assert.equal((await s.audit.list(s.orgId, { action: 'unit_rename' })).at(0)!.actor, 'human:board-1');
});

test('a slug taken by another channel (or its former slug) is not stolen: the rename takes slug-2', async () => {
  const s = await setup();
  const { eng } = await withEngineering(s);
  await s.groupchat.create(s.ws.id, { name: 'Platform' });
  const u = await s.units.rename(s.orgId, eng.id, 'Platform');
  assert.equal(u.slug, 'platform-2');
  assert.equal((await s.groupchat.bySlug(s.ws.id, 'platform')).id !== eng.channelId, true, 'the other #platform keeps its slug');
  await assert.rejects(s.groupchat.create(s.ws.id, { name: 'Engineering' }), /#engineering already exists/, 'an alias is reserved for its links');
});

// ---- renames: the tool ----

test('org_rename_unit: the head renames its own department, not another; a plain member may not; the chief renames any department but not the company', async () => {
  const s = await setup();
  const { eng } = await withEngineering(s);
  const intern = await s.agents.create({ name: 'Intern', charter: 'You help.' });
  await s.org.addMember(s.orgId, { agentId: intern.id, title: 'Intern', reportsToAgentId: s.bo.id, scopes: [] });
  await s.units.syncMembership(s.orgId);
  const bos = (await s.units.units(s.orgId)).find((u) => u.leadAgentId === s.bo.id)!;
  const adaS = await session(s, s.ada.id);
  assert.ok((await s.runtime.specsFor(adaS)).some((t) => t.name === 'org_rename_unit'), 'a head is offered the tool');
  const out = await s.runtime.execute(adaS, 'org_rename_unit', { name: 'Platform Engineering', why: 'we own the platform now' });
  assert.match(out, /Renamed Engineering → Platform Engineering \(#platform-engineering; #engineering still links there\)\. Task keys stay ENG-n/);
  const renamed = await s.units.get(s.orgId, eng.id);
  assert.equal(renamed.name, 'Platform Engineering'); assert.equal(renamed.taskKey, 'ENG');
  assert.equal((await s.audit.list(s.orgId, { action: 'unit_rename' }))[0].actor, `agent:${s.ada.id}`);
  await assert.rejects(s.runtime.execute(adaS, 'org_rename_unit', { unit: '#bo', name: 'Sales', why: 'x' }), /only your own department/);
  await assert.rejects(s.runtime.execute(adaS, 'org_rename_unit', { name: 'X' }), /why is required/);
  const internS = await session(s, intern.id);
  assert.ok(!(await s.runtime.specsFor(internS)).some((t) => t.name === 'org_rename_unit'), 'a plain member is not offered it');
  await assert.rejects(s.runtime.execute(internS, 'org_rename_unit', { unit: '#bo', name: 'X', why: 'x' }), /for the chief of staff and function heads/);
  const chiefS = await session(s, s.chief.id);
  const byChief = await s.runtime.execute(chiefS, 'org_rename_unit', { unit: "Bo's team", name: 'Content', why: 'it writes the newsletter' });
  assert.match(byChief, /Renamed Bo's team → Content \(#content; #bo still links there\)/);
  assert.equal((await s.units.get(s.orgId, bos.id)).name, 'Content');
  await assert.rejects(s.runtime.execute(chiefS, 'org_rename_unit', { unit: '#company', name: 'Acme', why: 'x' }), /company's name is the CEO's/);
  await assert.rejects(s.runtime.execute(chiefS, 'org_rename_unit', { unit: '#nope', name: 'X', why: 'x' }), /no department "#nope"/);
});

// ---- the backfill ----

test('the 0090 backfill renames units still on "<lead>\'s team" to their department name and reslugs their channel; hand-set names stay; idempotent', async () => {
  const pg = new PGlite();
  await runPgMigrations(pgliteQueryable(pg), { log: () => {} });
  const db = scopeDb(drizzle(pg, { schema }) as unknown as DrizzleDb);
  const s = await setup({ db });
  const { eng } = await withEngineering(s);
  const intern = await s.agents.create({ name: 'Intern', charter: 'You help.' });
  await s.org.addMember(s.orgId, { agentId: intern.id, title: 'Intern', reportsToAgentId: s.bo.id, scopes: [] });
  await s.units.syncMembership(s.orgId);
  const bos = (await s.units.units(s.orgId)).find((u) => u.leadAgentId === s.bo.id)!;
  await s.org.updateMember(s.orgId, s.bo.id, { title: 'Head of Sales' });
  // as a pre-0090 database looks: lead-named units and channels, no nameSource
  const q = pgliteQueryable(pg);
  await q.query(`ALTER TABLE org_units ALTER COLUMN "nameSource" DROP NOT NULL`);
  await db.update(orgUnits).set({ name: "Ada's team", slug: 'ada', nameSource: null as unknown as string }).where(eq(orgUnits.id, eng.id));
  await db.update(channels).set({ slug: 'ada', name: 'ada', topic: "Unit channel of Ada's team: Ada and its reports.", formerSlugs: '' }).where(eq(channels.id, eng.channelId!));
  await db.update(orgUnits).set({ name: 'Revenue squad', nameSource: null as unknown as string }).where(eq(orgUnits.id, bos.id));
  const first = await backfillDepartmentNames(q);
  assert.deepEqual(first, { renamed: 1, custom: 1 });
  const e = await s.units.get(s.orgId, eng.id);
  assert.equal(e.name, 'Engineering'); assert.equal(e.slug, 'engineering'); assert.equal(e.nameSource, 'derived'); assert.equal(e.taskKey, 'ENG');
  const ch = await s.groupchat.get(eng.channelId!);
  assert.equal(ch.slug, 'engineering'); assert.equal(ch.name, 'Engineering'); assert.equal(ch.formerSlugs, 'ada');
  assert.match(ch.topic, /^Department channel of Engineering/);
  assert.equal((await s.groupchat.bySlug(s.ws.id, 'ada')).id, ch.id, '/channels/ada still opens it');
  const b = await s.units.get(s.orgId, bos.id);
  assert.equal(b.name, 'Revenue squad', 'a hand-set name is kept'); assert.equal(b.nameSource, 'custom');
  const root = (await s.units.units(s.orgId)).find((u) => u.parentUnitId === null)!;
  assert.equal(root.nameSource, 'derived'); assert.equal(root.slug, 'company');
  assert.deepEqual(await backfillDepartmentNames(q), { renamed: 0, custom: 0 }, 'idempotent');
  assert.equal((await s.groupchat.get(eng.channelId!)).formerSlugs, 'ada');
});

// ---- blueprints ----

test('blueprints carry department names: units[].name validates, rides through unitsOf, the root never carries one; every starter names its departments', () => {
  const doc = {
    format: 'yaam-company/1', name: 'Co', description: 'A company.', profile: { values: '', culture: '', rules: '' },
    roles: [
      { title: 'Chief of staff', charter: 'Run it.', reportsTo: null, scopes: [], modelTier: 'standard', monthlyUsd: 0 },
      { title: 'Head of Engineering', charter: 'Build.', reportsTo: 'Chief of staff', scopes: [], modelTier: 'standard', monthlyUsd: 0 },
      { title: 'Engineer', charter: 'Code.', reportsTo: 'Head of Engineering', scopes: [], modelTier: 'standard', monthlyUsd: 0 },
    ],
    units: [{ title: 'Chief of staff', parent: null, name: 'Ignored' }, { title: 'Head of Engineering', parent: 'Chief of staff', name: 'Platform' }],
    tunables: {}, playbooks: [], budget: { monthlyUsd: 10 }, origin: { exportedFrom: 'x', at: '2026-11-04T00:00:00Z', sourceOrgId: '0123456789abcdef' },
  };
  const bp = validateBlueprint(doc);
  assert.deepEqual(unitsOf(bp), [{ title: 'Chief of staff', parent: null }, { title: 'Head of Engineering', parent: 'Chief of staff', name: 'Platform' }]);
  assert.deepEqual(unitNamesOf(bp), { 'head of engineering': 'Platform' });
  assert.throws(() => validateBlueprint({ ...doc, units: [{ title: 'Head of Engineering', parent: null, label: 'x' }] }), /label/);
  for (const c of BUILTIN_COMPANIES) {
    const b = validateBlueprint(c.manifest);
    const named = Object.values(unitNamesOf(b));
    assert.ok(named.length >= 1, `${c.slug} names its departments`);
    for (const n of named) assert.doesNotMatch(n, /'s team$/, `${c.slug}: ${n}`);
  }
});
