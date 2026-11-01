/** Blueprints (docs/company-vision.md §9, §4; docs/blueprints.md; execution-plan
 *  item 24): the role catalog ranked by the operating profile and hired through
 *  `role:<id>` with the meet rule; COMPANY.json v1 export that round-trips
 *  through the dry-run plan and the import (org, agents, units, profile,
 *  vision, tunables, playbooks — and nothing else: no connections, grants,
 *  memory or files); strict validation (size, roles, depth, fan-out, unknown
 *  fields); the one `blueprint` approval card in supervised mode; the registry
 *  kind `company` with publish / review / install; outcome recording only when
 *  opted in; hybrid human employees — assignment with an addressed inbox
 *  event, the task cards, review as an approval-like card, unit channel
 *  membership and lead scoping. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import { agentLessons, connectionGrants, connections, orgBlueprintImports, registryOutcomes } from '../server/src/database/schema';
import type { DrizzleDb } from '../server/src/database/database.module';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { PortabilityService } from '../server/src/portability/portability.service';
import { RegistryService } from '../server/src/registry/registry.service';
import { SettingsService } from '../server/src/settings/settings.module';
import { GroupChatService } from '../server/src/groupchat/groupchat.service';
import { WorkspaceEventBus } from '../server/src/groupchat/workspace-events';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService, DEFAULT_CHIEF_SCOPES } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgIntentService } from '../server/src/org/org-intent.service';
import { OrgRolesService, modelForTier } from '../server/src/org/org-roles.service';
import { OrgBlueprintsService } from '../server/src/org/org-blueprints.service';
import { ROLES, rankRoles, roleById, tierOfModel } from '../server/src/org/roles/catalog';
import { BLUEPRINT_FORMAT, hireOrder, unitsOf, validateBlueprint, type Blueprint } from '../server/src/org/blueprints/format';
import { BlueprintsController } from '../server/src/org/blueprints/blueprints.controller';
import { CompaniesController } from '../server/src/org/blueprints/companies.controller';
import { OrgController } from '../server/src/org/org.controller';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import { setAddressLookup } from '../server/src/common/url-guard';
import { runWithViewer } from '../server/src/accounts/account-context';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

async function setup(opts: { groupchat?: boolean } = {}) {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const memory = new AgentMemoryService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const skills = new SkillsService(db);
  const portability = new PortabilityService(agents, memory, skills, workspaces);
  const registry = new RegistryService(db, agents, skills, portability);
  const settings = new SettingsService(db);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider([]);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer();
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const intent = new OrgIntentService(db, org, units, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus, units, agents);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, skills, bus);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, undefined, undefined, intent);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, undefined, undefined, intent);
  runtime.debounceMs = 15;
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const roles = new OrgRolesService();
  const blueprints = new OrgBlueprintsService(db, org, mode, intent, approvals, units, agents, skills, workspaces, audit, settings, registry);
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config, units, undefined, undefined, undefined, intent);
  const controller = new WorkspaceOrgController(mode, orgs, config);
  const bpController = new BlueprintsController(blueprints, roles, mode, org, intent, config);
  const companies = new CompaniesController(registry, blueprints, mode, config);
  const groupchat = opts.groupchat ? new GroupChatService(db, workspaces, agents, stub, new WorkspaceEventBus(), config, undefined, bus, org, tasks, announcer) : null;
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  return { db, agents, workspaces, skills, registry, settings, repo, bus, audit, org, units, intent, tasks, approvals, runtime, mode, roles, blueprints, orgs, controller, bpController, companies, groupchat, ws, chief };
}
type S = Awaited<ReturnType<typeof setup>>;

async function enable(s: S, modeName: 'supervised' | 'autonomous' = 'autonomous', monthlyUsd = 60) {
  const st = await s.mode.setMode(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, monthlyUsd, agentCap: 20 });
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  return { orgId: st.orgId!, session };
}

const SKILL_MD = (name: string) => `---\nname: ${name}\ndescription: "How we publish an issue"\n---\n1. Draft.\n2. Edit.\n3. Ship on Friday.\n`;

/** A hand-written blueprint: chief → lead → two specialists, a playbook, a vision. */
function sampleBlueprint(over: Partial<Blueprint> = {}): Blueprint {
  return {
    format: BLUEPRINT_FORMAT, name: 'Newsletter Co', description: 'A weekly newsletter about agents.',
    profile: { values: 'Honesty over hype.', culture: 'Terse, async, one weekly review.', rules: 'Never send mail without the CEO.' },
    vision: { title: 'Ship 12 issues with 1,000 readers', description: 'One issue a week.', horizonDays: 90 },
    roles: [
      { roleId: 'chief-of-staff', title: 'Chief of staff', charter: 'You run Newsletter Co.', reportsTo: null, scopes: ['tool:fs_read', 'tool:fs_write', 'tool:web_search', 'tool:web_fetch'], modelTier: 'strong', monthlyUsd: 0 },
      { roleId: 'project-lead', title: 'Editorial lead', charter: 'You lead editorial.', reportsTo: 'Chief of staff', scopes: ['tool:fs_read', 'tool:fs_write', 'tool:web_search'], modelTier: 'standard', monthlyUsd: 10 },
      { roleId: 'writer-editor', title: 'Writer', charter: 'You write the issue.', reportsTo: 'Editorial lead', scopes: ['tool:fs_read', 'tool:fs_write', 'connection:gmail:read'], modelTier: 'standard', monthlyUsd: 8 },
      { roleId: 'researcher', title: 'Researcher', charter: 'You verify every claim.', reportsTo: 'Editorial lead', scopes: ['tool:fs_read', 'tool:web_search', 'tool:run_js'], modelTier: 'cheap', monthlyUsd: 6 },
    ],
    tunables: { 'intent.checkInCadenceDays': 14, 'planning.objectivesPerVision': 99, 'rituals.nothing': 3 },
    playbooks: [{ name: 'publish-issue', skillMd: SKILL_MD('publish-issue') }],
    budget: { monthlyUsd: 40 },
    cards: ['google-gmail'],
    origin: { exportedFrom: 'yaam-chat', at: '2026-11-01T00:00:00.000Z', sourceOrgId: 'abc123' },
    ...over,
  };
}

// ---- 1. the role catalog ----

test('role catalog: ranks by the operating profile with a pure string match, ids are unique, the Auditor holds read-only scopes, tiers map to models', async () => {
  const s = await setup();
  assert.equal(new Set(ROLES.map((r) => r.id)).size, ROLES.length);
  const lab = rankRoles('We are a small research lab doing academic analysis of evidence.');
  assert.equal(lab[0].id, 'researcher');
  assert.ok(lab[0].matched.includes('research') && lab[0].matched.includes('academic'));
  const news = s.roles.list('A weekly newsletter: content, writing and marketing to grow the audience.');
  assert.deepEqual(news.slice(0, 2).map((r) => r.id).sort(), ['marketer', 'writer-editor']);
  assert.ok(news.at(-1)!.score === 0, 'unmatched roles sink, in catalog order');
  // no profile: catalog order, every score 0
  assert.deepEqual(s.roles.list('').map((r) => r.id), ROLES.map((r) => r.id));
  // the Auditor role matches the Auditor pack: read-only, nothing written
  const auditor = roleById('auditor')!;
  assert.deepEqual(auditor.toolScopes, ['tool:fs_read', 'tool:web_search', 'tool:web_fetch']);
  assert.ok(!auditor.toolScopes.some((x) => /write|run_/.test(x)));
  assert.equal(roleById('Project lead')!.id, 'project-lead', 'titles resolve too');
  assert.equal(roleById('nope'), undefined);
  assert.throws(() => s.roles.get('nope'), /unknown role/);
  // tiers
  assert.equal(tierOfModel('claude-haiku-5-5'), 'cheap'); assert.equal(tierOfModel('gpt-5-mini'), 'cheap');
  assert.equal(tierOfModel('claude-opus-4-1'), 'strong'); assert.equal(tierOfModel('gpt-5'), 'strong');
  assert.equal(tierOfModel('claude-sonnet-4'), 'standard'); assert.equal(tierOfModel(''), 'standard');
  assert.equal(modelForTier('cheap', 'anthropic'), 'claude-haiku-5-5');
  assert.equal(modelForTier('strong', 'anthropic'), 'claude-opus-4-5', 'one tier table: item 23\'s tierModel');
  assert.equal(modelForTier('standard', 'anthropic'), '', 'standard keeps the default model');
  assert.equal(modelForTier('cheap', 'anthropic', undefined, { classes: {}, models: { cheap: 'pinned-cheap' } }), 'pinned-cheap', 'a CEO-pinned tier model wins');
  // the route: GET …/org/roles?profile= and the org's own profile by default
  const viaQuery = await s.bpController.roles_(s.ws.id, 'support and customers');
  assert.equal(viaQuery.roles[0].id, 'support');
  await enable(s);
  const orgId = (await s.org.byWorkspace(s.ws.id))!.id;
  await s.org.setProfile(orgId, { values: 'Code quality and engineering rigour.' });
  const own = await s.bpController.roles_(s.ws.id);
  assert.equal(own.roles[0].id, 'engineer');
});

test('role hire: org_hire_agent with role:<id> resolves the charter, title, scopes (met with the chief) and model tier; the Auditor role fills the auditor seat; an unknown role is refused', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'autonomous');
  const out = await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:engineer', title: 'Engineer', why: 'the product has no builder' });
  assert.match(out, /^Hired Engineer \(Engineer\) at depth 2/);
  assert.match(out, /dropped because you do not hold them: tool:run_js, tool:run_python/);
  const eng = (await s.agents.list()).find((a) => a.name === 'Engineer')!;
  assert.match(eng.charter, /^You are the Engineer of /);
  assert.match(eng.charter, new RegExp(s.ws.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the charter names the company');
  const m = (await s.org.member(orgId, eng.id))!;
  assert.deepEqual(JSON.parse(m.scopes), DEFAULT_CHIEF_SCOPES.slice().sort(), 'meet(chief, role scopes): run_js and run_python dropped');
  // prepared payload carries the role and the tier; the cheap tier picks the provider's cheapest sibling
  const p = await s.approvals.prepareHire(orgId, { templateOrPack: 'role:support', requestedBy: 'chief' });
  assert.equal(p.roleId, 'support'); assert.equal(p.modelTier, 'cheap'); assert.equal(p.model, 'claude-haiku-5-5'); assert.equal(p.title, 'Support'); assert.equal(p.name, 'Support');
  assert.equal((await s.approvals.prepareHire(orgId, { templateOrPack: 'role:support', title: 'Inbox', requestedBy: 'chief' })).name, 'Inbox', 'named after the title the chief gave');
  assert.deepEqual(p.scopes, ['tool:fs_read', 'tool:web_fetch', 'tool:web_search']);
  // the auditor role takes the empty auditor seat
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:auditor', title: 'Auditor', why: 'assurance' });
  const auditorAgent = (await s.agents.list()).find((a) => a.name === 'Auditor')!;
  assert.equal((await s.org.get(orgId)).auditorAgentId, auditorAgent.id);
  assert.deepEqual(JSON.parse((await s.org.member(orgId, auditorAgent.id))!.scopes), ['tool:fs_read', 'tool:web_fetch', 'tool:web_search']);
  // unknown role: refused with a pointer to the catalog
  await assert.rejects(s.approvals.prepareHire(orgId, { templateOrPack: 'role:wizard', requestedBy: 'chief' }), /not a catalog role/);
  // a pack hire still works untouched
  const pack = await s.approvals.prepareHire(orgId, { templateOrPack: 'Marketer', requestedBy: 'chief' });
  assert.equal(pack.packId !== null, true); assert.equal(pack.roleId, undefined);
});

// ---- 2. the format ----

test('validateBlueprint: strict shape; refuses oversize, > 20 roles, depth > 3, fan-out > 5, unknown fields, two roots, cycles, bad scopes and non-SKILL.md playbooks; hire order and units derive from the chart', () => {
  const ok = validateBlueprint(sampleBlueprint());
  assert.equal(ok.roles.length, 4);
  assert.deepEqual(hireOrder(ok).map((r) => r.title), ['Editorial lead', 'Writer', 'Researcher']);
  assert.deepEqual(unitsOf(ok), [{ title: 'Chief of staff', parent: null }, { title: 'Editorial lead', parent: 'Chief of staff' }]);
  const bad = (over: Record<string, unknown>, re: RegExp) => assert.throws(() => validateBlueprint({ ...sampleBlueprint(), ...over }), re);
  bad({ format: 'yaam-company/2' }, /format must be/);
  bad({ extra: 1 }, /unknown field "extra"/);
  bad({ name: '' }, /name is required/);
  bad({ roles: [] }, /non-empty/);
  bad({ roles: Array.from({ length: 21 }, (_, i) => ({ title: `R${i}`, charter: '', reportsTo: i ? 'R0' : null, scopes: [], modelTier: 'cheap', monthlyUsd: 0 })) }, /21 roles exceeds the cap of 20/);
  const chain = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `L${i}`, charter: '', reportsTo: i ? `L${i - 1}` : null, scopes: [], modelTier: 'standard', monthlyUsd: 0 }));
  validateBlueprint({ ...sampleBlueprint(), roles: chain(3) });
  bad({ roles: chain(4) }, /depth 4; the cap is 3/);
  const fan = (n: number) => [{ title: 'C', charter: '', reportsTo: null, scopes: [], modelTier: 'standard', monthlyUsd: 0 }, ...Array.from({ length: n }, (_, i) => ({ title: `S${i}`, charter: '', reportsTo: 'C', scopes: [], modelTier: 'standard', monthlyUsd: 0 }))];
  validateBlueprint({ ...sampleBlueprint(), roles: fan(5) });
  bad({ roles: fan(6) }, /6 direct reports; the cap is 5/);
  bad({ roles: [{ title: 'A', charter: '', reportsTo: null, scopes: [], modelTier: 'standard', monthlyUsd: 0 }, { title: 'B', charter: '', reportsTo: null, scopes: [], modelTier: 'standard', monthlyUsd: 0 }] }, /exactly one role reports to nobody/);
  bad({ roles: [{ title: 'A', charter: '', reportsTo: null, scopes: [], modelTier: 'standard', monthlyUsd: 0 }, { title: 'B', charter: '', reportsTo: 'C', scopes: [], modelTier: 'standard', monthlyUsd: 0 }, { title: 'C', charter: '', reportsTo: 'B', scopes: [], modelTier: 'standard', monthlyUsd: 0 }] }, /cycle/);
  bad({ roles: [{ title: 'A', charter: '', reportsTo: null, scopes: ['connection:gmail'], modelTier: 'standard', monthlyUsd: 0 }] }, /needs a level/);
  bad({ roles: [{ title: 'A', charter: '', reportsTo: null, scopes: [], modelTier: 'huge', monthlyUsd: 0 }] }, /modelTier must be one of/);
  bad({ roles: [{ title: 'A', charter: '', reportsTo: null, scopes: [], modelTier: 'cheap', monthlyUsd: 0, run: 'rm -rf' }] }, /unknown field "run"/);
  bad({ playbooks: [{ name: 'x', skillMd: 'not a skill' }] }, /must be a SKILL.md/);
  bad({ playbooks: [{ name: 'x', skillMd: SKILL_MD('x'), script: 'node evil.js' }] }, /unknown field "script"/);
  bad({ budget: { monthlyUsd: 10, allocations: { Nobody: 5 } } }, /unknown role "Nobody"/);
  bad({ cadences: [{ unitTitle: 'root', kind: 'standup', cron: 'every day' }] }, /five-field cron/);
  bad({ tunables: { 'intent.paceTolerance': 'lots' } }, /must be a number/);
  bad({ name: 'Zero​width' }, /invisible unicode/);
  const big = sampleBlueprint({ roles: [{ title: 'Chief of staff', charter: 'x'.repeat(20_000), reportsTo: null, scopes: [], modelTier: 'standard', monthlyUsd: 0 }], playbooks: Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, skillMd: `${SKILL_MD(`p${i}`)}${'y'.repeat(60_000)}` })) });
  assert.throws(() => validateBlueprint(big), /exceeds the 262144 byte cap/);
});

// ---- 3. export → plan → import ----

test('export renders the live company as COMPANY.json v1 — roles by title with reporting lines, scopes, tiers and envelopes, the profile, vision, tunables, playbooks and budget — and nothing of its history', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'autonomous', 60);
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:project-lead', title: 'Editorial lead', monthlyBudgetUsd: 10, why: 'a unit' });
  const lead = (await s.agents.list()).find((a) => a.name === 'Editorial lead')!;
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:writer-editor', title: 'Writer', reportsTo: 'Editorial lead', model: 'claude-haiku-5-5', why: 'words' });
  await s.org.setProfile(orgId, { values: 'Honesty.', culture: 'Terse.' });
  await s.intent.setVision(orgId, { title: 'Ship 12 issues', description: 'Weekly.', dueAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), rules: 'No mail without the CEO.' });
  await s.org.setTunable(orgId, 'intent.checkInCadenceDays', 14);
  await s.skills.create({ name: 'publish-issue', description: 'How we publish', instructions: '1. Draft.\n2. Ship.', workspaceId: s.ws.id });
  await s.skills.create({ name: 'secret-draft', description: 'd', instructions: 'draft only', workspaceId: s.ws.id, draft: true });
  // history that must not travel
  await s.agents.addEvent(s.chief.id, { kind: 'info', title: 'PRIVATE-EVENT' });
  await s.tasks.create(orgId, { title: 'PRIVATE-TASK', createdBy: 'user' });

  const bp = await s.bpController.exportBlueprint(s.ws.id);
  assert.equal(bp.format, 'yaam-company/1');
  assert.equal(bp.name, s.ws.name);
  assert.deepEqual(bp.roles.map((r) => [r.title, r.reportsTo]), [['Chief of staff', null], ['Editorial lead', 'Chief of staff'], ['Writer', 'Editorial lead']]);
  assert.equal(bp.roles[0].roleId, 'chief-of-staff'); assert.equal(bp.roles[1].roleId, 'project-lead');
  assert.equal(bp.roles[1].monthlyUsd, 10); assert.equal(bp.roles[2].modelTier, 'cheap');
  assert.deepEqual(bp.roles[0].scopes, DEFAULT_CHIEF_SCOPES.slice().sort());
  assert.deepEqual(bp.units, [{ title: 'Chief of staff', parent: null }, { title: 'Editorial lead', parent: 'Chief of staff' }]);
  assert.deepEqual(bp.profile, { values: 'Honesty.', culture: 'Terse.', rules: 'No mail without the CEO.' });
  assert.equal(bp.vision!.title, 'Ship 12 issues'); assert.equal(bp.vision!.horizonDays, 90);
  assert.deepEqual(bp.tunables, { 'intent.checkInCadenceDays': 14 });
  assert.deepEqual(bp.playbooks.map((p) => p.name), ['publish-issue'], 'drafts do not travel');
  assert.match(bp.playbooks[0].skillMd, /^---\nname: publish-issue/);
  assert.equal(bp.budget.monthlyUsd, 60); assert.deepEqual(bp.budget.allocations, { 'Editorial lead': 10 });
  const seeded = bp.cadences ?? [];
  assert.equal(bp.origin.exportedFrom, 'yaam-chat'); assert.equal(bp.origin.sourceOrgId.length, 16); assert.notEqual(bp.origin.sourceOrgId, orgId);
  const text = JSON.stringify(bp);
  for (const leak of ['PRIVATE-EVENT', 'PRIVATE-TASK', orgId, s.chief.id, lead.id, 'apiKey', 'token']) assert.ok(!text.includes(leak), `blueprint must not carry ${leak}`);
  // the rituals table (item 19) is read defensively: enabled rows with a sane kind and cron, by unit title
  const root = await s.units.rootUnit(orgId);
  const leadUnit = (await s.units.ledBy(orgId, lead.id))!;
  const now = new Date().toISOString();
  await (s.db as DrizzleDb).execute(sql`INSERT INTO org_cadences ("id", "orgId", "unitId", "kind", "cron", "enabled", "createdAt") VALUES ('c1', ${orgId}, ${root.id}, 'board_meeting_x', '0 9 * * 1', 1, ${now}), ('c2', ${orgId}, ${leadUnit.id}, 'standup_x', '0 9 * * 1-5', 1, ${now}), ('c3', ${orgId}, ${root.id}, 'bad kind!', 'x', 1, ${now}), ('c4', ${orgId}, ${root.id}, 'retro_x', '0 9 * * 5', 0, ${now})`);
  const withCadences = await s.blueprints.export(orgId);
  const added = (withCadences.cadences ?? []).filter((c) => !seeded.some((x) => x.kind === c.kind && x.unitTitle === c.unitTitle));
  assert.deepEqual(added, [{ unitTitle: 'root', kind: 'board_meeting_x', cron: '0 9 * * 1' }, { unitTitle: 'Editorial lead', kind: 'standup_x', cron: '0 9 * * 1-5' }]);
});

test('import plan (dry run) says what will be created — chief and hires with scopes after the meet rule, connection scopes recommended not granted, budget within the envelope, tunables within bounds, playbooks, skipped cadences — and refuses a workspace that already has a company', async () => {
  const s = await setup();
  const plan = await s.bpController.plan(s.ws.id, { blueprint: sampleBlueprint() as unknown as Record<string, unknown>, mode: 'supervised' });
  assert.equal(plan.ok, true); assert.equal(plan.mode, 'supervised'); assert.equal(plan.approval, 'blueprint');
  assert.equal(plan.chief.title, 'Chief of staff'); assert.deepEqual(plan.chief.scopes, ['tool:fs_read', 'tool:fs_write', 'tool:web_fetch', 'tool:web_search']);
  assert.deepEqual(plan.hires.map((h) => h.title), ['Editorial lead', 'Writer', 'Researcher']);
  const writer = plan.hires[1];
  assert.deepEqual(writer.scopes, ['tool:fs_read', 'tool:fs_write'], 'connection:gmail:read is not imported');
  assert.deepEqual(writer.dropped, ['connection:gmail:read']);
  assert.deepEqual(plan.hires[2].scopes, ['tool:fs_read', 'tool:web_search'], 'run_js is outside the chief\'s holdings');
  assert.equal(plan.hires[2].model, 'claude-haiku-5-5');
  assert.deepEqual(plan.recommendedConnections, ['gmail']); assert.deepEqual(plan.recommendedCards, ['google-gmail']);
  assert.deepEqual(plan.budget, { monthlyUsd: 40, allocations: { 'Editorial lead': 10, Writer: 8, Researcher: 6 }, allocated: 24 });
  assert.deepEqual(plan.tunables, [
    { key: 'intent.checkInCadenceDays', value: 14, applied: 14 },
    { key: 'planning.objectivesPerVision', value: 99, applied: 8, note: 'clamped to the bound 1–8' },
    { key: 'rituals.nothing', value: 3, applied: 3, note: 'skipped: unknown tunable on this server' },
  ]);
  assert.deepEqual(plan.playbooks, [{ name: 'publish-issue' }]);
  assert.equal(plan.vision!.title, 'Ship 12 issues with 1,000 readers');
  assert.match(plan.cadences.note, /none/);
  assert.ok(plan.notes.some((n) => /no connections, grants, memory, lessons, tokens or files/.test(n)));
  // a smaller envelope cuts allocations in order, noted
  const tight = await s.blueprints.importPlan(s.ws.id, sampleBlueprint(), { monthlyUsd: 15 });
  assert.deepEqual(tight.budget.allocations, { 'Editorial lead': 10, Writer: 5 });
  assert.ok(tight.notes.some((n) => /allocation for "Writer" cut/.test(n)) && tight.notes.some((n) => /allocation for "Researcher" cut/.test(n)));
  // the body may be the blueprint itself
  assert.equal((await s.bpController.plan(s.ws.id, sampleBlueprint() as unknown as Record<string, unknown>)).mode, 'supervised');
  // an invalid blueprint is a 400
  await assert.rejects(s.blueprints.importPlan(s.ws.id, { format: 'nope' }), /format must be/);
  // a workspace with a company already: not ok, and import refuses
  await enable(s);
  const taken = await s.blueprints.importPlan(s.ws.id, sampleBlueprint());
  assert.equal(taken.ok, false);
  await assert.rejects(s.blueprints.import(s.ws.id, sampleBlueprint(), { mode: 'autonomous' }), /already has an organization/);
});

test('round trip: export from one workspace, import into another (autonomous) creates the org, the agents by role, the units, the profile, vision, tunables and playbook drafts — and nothing else (no connections, grants, lessons, loops)', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'autonomous', 60);
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:project-lead', title: 'Editorial lead', monthlyBudgetUsd: 10, why: 'a unit' });
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:writer-editor', title: 'Writer', reportsTo: 'Editorial lead', why: 'words' });
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:auditor', title: 'Auditor', why: 'assurance' });
  await s.org.setProfile(orgId, { values: 'Honesty.', culture: 'Terse.' });
  await s.intent.setVision(orgId, { title: 'Ship 12 issues', description: 'Weekly.', dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), rules: 'No mail.' });
  await s.org.setTunable(orgId, 'intent.confidenceDrops', 3);
  await s.skills.create({ name: 'publish-issue', description: 'How we publish', instructions: '1. Draft.\n2. Ship.', workspaceId: s.ws.id });
  const bp = await s.blueprints.export(orgId);

  const target = await s.workspaces.create({ name: 'Clone' });
  const plan = await s.blueprints.importPlan(target.id, bp, { mode: 'autonomous' });
  assert.equal(plan.ok, true); assert.equal(plan.approval, 'none');
  const agentsBefore = (await s.agents.list()).length;
  const res = await s.bpController.importBlueprint(target.id, { blueprint: bp as unknown as Record<string, unknown>, mode: 'autonomous' });
  assert.equal(res.mode, 'autonomous'); assert.equal(res.approvalId, null);
  assert.deepEqual(res.hired.map((h) => h.title), ['Editorial lead', 'Auditor', 'Writer'].sort((a, b) => plan.hires.findIndex((h) => h.title === a) - plan.hires.findIndex((h) => h.title === b)));
  assert.equal((await s.agents.list()).length, agentsBefore + 4, 'the chief and three hires');

  const org2 = (await s.org.byWorkspace(target.id))!;
  assert.notEqual(org2.id, orgId);
  assert.equal(org2.name, bp.name); assert.equal(org2.chiefOfStaffAgentId, res.chiefAgentId);
  assert.equal((await s.workspaces.get(target.id)).orgMode, 'autonomous');
  assert.equal(org2.values, 'Honesty.'); assert.equal(org2.culture, 'Terse.'); assert.equal(org2.rules, 'No mail.');
  assert.equal(org2.monthlyBudgetUsd, 60);
  assert.equal(JSON.parse(org2.tunables)['intent.confidenceDrops'], 3);
  const vision = await s.intent.vision(org2.id);
  assert.equal(vision!.title, 'Ship 12 issues'); assert.ok(vision!.dueAt);
  // the chart: the same shape, by title, with scopes met against the new chief
  const members = await s.org.members(org2.id);
  const byTitle = new Map(members.map((m) => [m.title, m]));
  assert.equal(byTitle.get('Chief of staff')!.depth, 1);
  assert.equal(byTitle.get('Editorial lead')!.reportsToAgentId, res.chiefAgentId);
  assert.equal(byTitle.get('Writer')!.reportsToAgentId, byTitle.get('Editorial lead')!.agentId);
  assert.deepEqual(JSON.parse(byTitle.get('Writer')!.scopes), ['tool:fs_read', 'tool:fs_write', 'tool:web_fetch', 'tool:web_search']);
  assert.equal((await s.org.budget(org2.id, 'agent', byTitle.get('Editorial lead')!.agentId))!.monthlyUsd, 10);
  assert.equal(org2.auditorAgentId, byTitle.get('Auditor')!.agentId, 'the auditor role takes the seat');
  const chief2 = await s.agents.get(res.chiefAgentId);
  assert.equal(chief2.charter, (await s.agents.get(s.chief.id)).charter);
  const tree = await s.units.unitTree(org2.id);
  assert.equal(tree.length, 1); assert.equal(tree[0].children.length, 1); assert.equal(tree[0].children[0].memberAgentIds.length, 2);
  // playbooks as drafts in the target workspace
  assert.deepEqual(res.playbooks.map((p) => p.name), ['publish-issue']);
  const skill = await s.skills.get(res.playbooks[0].skillId);
  assert.equal(skill.draft, 1); assert.equal(skill.workspaceId, target.id); assert.equal(skill.proposedBy, `blueprint: ${bp.name}`);
  // nothing else
  const db = s.db as DrizzleDb;
  assert.equal((await db.select().from(connections)).length, 0);
  assert.equal((await db.select().from(connectionGrants)).length, 0);
  assert.equal((await db.select().from(agentLessons)).length, 0);
  for (const m of members) assert.equal((await s.agents.get(m.agentId)).loops, '[]');
  assert.equal((await s.tasks.list(org2.id)).length, 0, 'no tasks copied');
  const row = (await db.select().from(orgBlueprintImports).where(eq(orgBlueprintImports.orgId, org2.id)))[0];
  assert.equal(row.mode, 'autonomous'); assert.equal(row.itemId, ''); assert.equal(row.approvalId, null);
  assert.ok((await s.audit.list(org2.id, { action: 'blueprint_import' })).length === 1);
  // re-exporting the clone gives the same structure
  const again = await s.blueprints.export(org2.id);
  assert.deepEqual(again.roles.map((r) => [r.title, r.reportsTo, r.scopes]), bp.roles.map((r) => [r.title, r.reportsTo, r.scopes]));
  assert.deepEqual(again.playbooks, [], 'drafts stay drafts until approved, so they do not re-export yet');
});

test('supervised import stages the whole staffing plan as one `blueprint` approval card: no agent exists until the CEO approves; approval hires in order with reporting lines resolved', async () => {
  const s = await setup();
  const target = await s.workspaces.create({ name: 'Staffed later' });
  const before = (await s.agents.list()).length;
  const res = await s.blueprints.import(target.id, sampleBlueprint(), { mode: 'supervised', monthlyUsd: 40 });
  assert.equal((await s.agents.list()).length, before + 1, 'only the chief exists');
  assert.deepEqual(res.hired, []); assert.ok(res.approvalId);
  const pending = await s.approvals.pending(res.orgId);
  assert.equal(pending.length, 1); assert.equal(pending[0].kind, 'blueprint'); assert.equal(pending[0].id, res.approvalId);
  const payload = JSON.parse(pending[0].payload) as { hires: Array<{ title: string; reportsToTitle: string; scopes: string[] }> };
  assert.deepEqual(payload.hires.map((h) => [h.title, h.reportsToTitle]), [['Editorial lead', 'Chief of staff'], ['Writer', 'Editorial lead'], ['Researcher', 'Editorial lead']]);
  assert.match(pending[0].recommendation, /Staff "Newsletter Co" from its blueprint/);
  assert.equal((await s.workspaces.get(target.id)).orgMode, 'supervised');
  // the card is the CEO's (not a board member's)
  await assert.rejects(runWithViewer('single', { memberAccountId: 'board-1', role: 'member', workspaceId: target.id, displayName: 'B' }, async () => {
    await s.org.setHuman(res.orgId, { memberAccountId: 'board-1', role: 'board' });
    return s.orgs.decide(res.orgId, res.approvalId!, { decision: 'approve' });
  }), /CEO/);
  const decided = await s.orgs.decide(res.orgId, res.approvalId!, { decision: 'approve', note: 'go' });
  const result = decided.result as { hired: Array<{ title: string }>; failed: string[] };
  assert.deepEqual(result.hired.map((h) => h.title), ['Editorial lead', 'Writer', 'Researcher']); assert.deepEqual(result.failed, []);
  const members = await s.org.members(res.orgId);
  assert.equal(members.length, 4);
  const lead = members.find((m) => m.title === 'Editorial lead')!;
  assert.equal(members.find((m) => m.title === 'Writer')!.reportsToAgentId, lead.agentId);
  assert.equal(members.find((m) => m.title === 'Researcher')!.depth, 3);
  assert.equal((await s.org.budget(res.orgId, 'agent', lead.agentId))!.monthlyUsd, 10);
  assert.equal((await s.units.unitTree(res.orgId))[0].children.length, 1, 'the lead\'s unit exists');
  // the hires carry the approval as grantor
  const add = await s.audit.list(res.orgId, { action: 'member_add', refId: lead.agentId });
  assert.equal(JSON.parse(add[0].payload).scopes.length, 3);
});

// ---- 4. the registry ----

test('registry: a company publishes as kind `company` through the scan and lists under /api/market/companies; install is two-step (review + plan, then import) and the generic install route refuses companies', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'autonomous', 50);
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:researcher', title: 'Researcher', why: 'facts' });
  await s.org.setProfile(orgId, { values: 'See https://example.org/values for our values.' });
  await s.skills.create({ name: 'publish-issue', description: 'How we publish', instructions: '1. Draft.\n2. Ship.', workspaceId: s.ws.id });
  // dry run writes nothing
  const dry = await s.companies.publish({ workspaceId: s.ws.id, publisherName: 'Dana', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal((await s.companies.list()).items.length, 0);
  assert.deepEqual(dry.capabilities.company, { roles: 2, depth: 2, monthlyUsd: 50, playbooks: 1, cadences: 0, tunables: 0, cards: [] });
  assert.deepEqual(dry.capabilities.tools.filter((t) => t.startsWith('fs_') || t.startsWith('web_')), ['fs_read', 'fs_write', 'web_fetch', 'web_search']);
  assert.deepEqual(dry.capabilities.skills, [{ name: 'publish-issue', description: 'How we publish' }]);
  const pub = await s.companies.publish({ workspaceId: s.ws.id, publisherName: 'Dana', name: 'Research Desk Co', description: 'A two-agent research shop.' });
  if (pub.dryRun) throw new Error('unreachable');
  assert.equal(pub.item.kind, 'company'); assert.equal(pub.item.slug, 'research-desk-co'); assert.equal(pub.item.version, 1);
  const listed = await s.companies.list();
  assert.equal(listed.items.length, 1); assert.deepEqual(listed.items[0].outcomes, { first_key_result: 0, thirty_days_in_envelope: 0 });
  assert.equal((await s.registry.list({ kind: 'agent' })).items.length, 0, 'kinds filter');
  const detail = await s.registry.get(pub.item.id);
  assert.equal(detail.manifest.format, 'yaam-company/1'); assert.equal(detail.manifest.name, 'Research Desk Co');
  // the review shows the real artifacts: roles with charters, playbook bodies
  const { review } = await s.registry.review(pub.item.id);
  assert.equal(review.kind, 'company'); assert.equal(review.blueprint!.roles.length, 2);
  assert.equal(review.skillBodies[0].name, 'publish-issue'); assert.match(review.skillBodies[0].instructions, /Draft/);
  assert.ok(review.installs.some((l) => /no connection, memory, lesson, token or file/.test(l)));
  // the generic install refuses a company; the companies route plans first
  await assert.rejects(s.registry.install(pub.item.id, { confirm: true }), /installs through POST \/api\/market\/companies/);
  const target = await s.workspaces.create({ name: 'Buyer' });
  const first = await s.companies.install(pub.item.id, { workspaceId: target.id, mode: 'supervised' });
  assert.equal(first.requiresConfirm, true);
  if (!('plan' in first)) throw new Error('unreachable');
  assert.equal(first.plan.hires.length, 1); assert.equal(first.plan.hires[0].title, 'Researcher');
  assert.equal((await s.org.byWorkspace(target.id)), null, 'nothing installed yet');
  await assert.rejects(s.companies.install(pub.item.id, { workspaceId: target.id, mode: 'supervised', confirm: 'yes' as unknown as boolean }).then((r) => { if ('requiresConfirm' in r) throw new Error('requiresConfirm'); }), /requiresConfirm/);
  const done = await s.companies.install(pub.item.id, { workspaceId: target.id, mode: 'autonomous', monthlyUsd: 30, confirm: true });
  if (!('ok' in done)) throw new Error('unreachable');
  assert.equal(done.install.orgId, done.orgId); assert.equal(done.install.itemId, pub.item.id);
  assert.equal((await s.org.byWorkspace(target.id))!.id, done.orgId);
  assert.equal((await s.org.byWorkspace(target.id))!.monthlyBudgetUsd, 30);
  assert.equal(done.hired.length, 1);
  assert.equal((await s.registry.get(pub.item.id)).installs, 1);
  const row = (await (s.db as DrizzleDb).select().from(orgBlueprintImports).where(eq(orgBlueprintImports.orgId, done.orgId)))[0];
  assert.equal(row.itemId, pub.item.id);
  // a blocking scan flag refuses a publish: a playbook that is not a SKILL.md cannot pass validation, an oversize charter cannot either; a tampered manifest with a bad shape is refused on the remote door too
  await assert.rejects(s.registry.publish({ kind: 'company', manifest: { ...(detail.manifest as object), roles: [] } as Record<string, unknown> }), /roles must be a non-empty array/);
  await assert.rejects(s.registry.publish({ kind: 'company' }), /manifest .* is required/);
  // installing a non-company through the companies route is refused
  const a = await s.agents.create({ name: 'Solo', charter: 'alone' });
  const agentItem = await s.registry.publish({ kind: 'agent', agentId: a.id });
  if (agentItem.dryRun) throw new Error('unreachable');
  await assert.rejects(s.companies.install(agentItem.item.id, { workspaceId: target.id, mode: 'supervised' }), /is a agent, not a company/);
});

test('outcomes: milestones of an imported company are recorded on the import row always, and on the registry item only when shareBlueprintOutcomes is on', async () => {
  const s = await setup();
  const { orgId } = await enable(s, 'autonomous', 50);
  const pub = await s.companies.publish({ workspaceId: s.ws.id, publisherName: 'Dana' });
  if (pub.dryRun) throw new Error('unreachable');
  const target = await s.workspaces.create({ name: 'Buyer' });
  const done = await s.companies.install(pub.item.id, { workspaceId: target.id, mode: 'autonomous', confirm: true });
  if (!('ok' in done)) throw new Error('unreachable');
  void orgId;
  // nothing yet
  assert.deepEqual(await s.blueprints.sweepOutcomes(), []);
  // first key result achieved, sharing off (the default): recorded locally, not on the item
  const vision = await s.intent.setVision(done.orgId, { title: 'V', dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
  const kr = await s.intent.setKeyResult(done.orgId, { title: 'Readers', objectiveId: vision.vision.id, targetValue: 10, dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ownerAgentId: null });
  await s.org.updateGoal(done.orgId, kr.id, { status: 'achieved' });
  assert.equal(await s.blueprints.sharingOutcomes(), false);
  const first = await s.blueprints.sweepOutcomes();
  assert.deepEqual(first, [{ importId: done.importId, kind: 'first_key_result', shared: false }]);
  assert.ok((await s.blueprints.imports(done.orgId))[0].firstKeyResultAt);
  assert.equal((await (s.db as DrizzleDb).select().from(registryOutcomes)).length, 0);
  assert.deepEqual(await s.blueprints.sweepOutcomes(), [], 'once per import');
  // opt in; thirty days later under the envelope: shared
  await s.settings.put({ shareBlueprintOutcomes: 'on' });
  const later = new Date(Date.now() + 31 * 86_400_000);
  const second = await s.blueprints.sweepOutcomes(later);
  assert.deepEqual(second, [{ importId: done.importId, kind: 'thirty_days_in_envelope', shared: true }]);
  const outcomes = (await s.companies.list()).items[0].outcomes;
  assert.deepEqual(outcomes, { first_key_result: 0, thirty_days_in_envelope: 1 }, 'the earlier milestone was not back-reported');
  const audit = await s.audit.list(done.orgId, { action: 'blueprint_outcome' });
  assert.equal(audit.length, 2);
  assert.equal(JSON.parse(audit[0].payload).shared, true);
  // the anonymous feed counter accepts only the two kinds
  await assert.rejects(s.registry.bumpPublicOutcome(pub.item.id, 'rich'), /outcome kind must be one of/);
  await s.registry.bumpPublicOutcome(pub.item.id, 'first_key_result');
  assert.deepEqual((await s.registry.outcomesOf([pub.item.id])).get(pub.item.id), { first_key_result: 1, thirty_days_in_envelope: 1 });
  // a company over its envelope does not earn the milestone
  const other = await s.workspaces.create({ name: 'Over' });
  const over = await s.companies.install(pub.item.id, { workspaceId: other.id, mode: 'autonomous', monthlyUsd: 5, confirm: true });
  if (!('ok' in over)) throw new Error('unreachable');
  await s.org.setBudget(over.orgId, { scope: 'company', refId: over.orgId, monthlyUsd: 5 });
  await (s.db as DrizzleDb).execute(sql`UPDATE org_budgets SET "spentUsd" = 9 WHERE "orgId" = ${over.orgId} AND "scope" = 'company'`);
  assert.deepEqual(await s.blueprints.sweepOutcomes(new Date(Date.now() + 31 * 86_400_000)), []);
  assert.match((await s.blueprints.imports(over.orgId))[0].envelopeAt ?? '', /^missed:/);
});

// ---- 5. hybrid human roles ----

test('human employee: joins with a reporting line, appears on the unit chart, can be assigned a task (addressed inbox event, task cards, status through the usual route) and asked to review (an approval-like card only they or the CEO decide)', async () => {
  const s = await setup();
  const { orgId, session } = await enable(s, 'autonomous', 50);
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:project-lead', title: 'Lead', why: 'a unit' });
  const lead = (await s.agents.list()).find((a) => a.name === 'Lead')!;
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:writer-editor', title: 'Writer', reportsTo: 'Lead', why: 'words' });
  // roles: employee needs a live manager; defaults to the chief
  await assert.rejects(s.org.setHuman(orgId, { memberAccountId: 'ann', role: 'employee', reportsToAgentId: 'nobody' }), /active member/);
  const ann = await s.orgs.setHuman(orgId, { memberAccountId: 'ann', role: 'employee', reportsToAgentId: lead.id, title: 'Fact checker' });
  assert.equal(ann.role, 'employee'); assert.equal(ann.reportsToAgentId, lead.id); assert.equal(ann.title, 'Fact checker');
  const bob = await s.org.setHuman(orgId, { memberAccountId: 'bob', role: 'employee' });
  assert.equal(bob.reportsToAgentId, s.chief.id);
  const board = await s.org.setHuman(orgId, { memberAccountId: 'cat', role: 'board' });
  assert.equal(board.reportsToAgentId, null);
  assert.equal(await s.org.humanRole(orgId, 'ann'), 'employee');
  // the chart: ann under Lead's unit, bob under the root
  const tree = await s.units.unitTree(orgId);
  assert.deepEqual(tree[0].memberHumanIds, ['bob']);
  assert.deepEqual(tree[0].children[0].memberHumanIds, ['ann']);
  // assignment: mutually exclusive with an agent, lands on the manager's board, notifies the human (addressed)
  const t = await s.tasks.create(orgId, { title: 'Check the sources', brief: { outcome: 'Every claim verified' }, assigneeAgentId: lead.id, createdBy: 'user' });
  const assigned = await s.orgs.assign(orgId, t.id, { humanId: 'ann' });
  assert.equal(assigned.assigneeHumanId, 'ann'); assert.equal(assigned.assigneeAgentId, null); assert.equal(assigned.status, 'todo');
  assert.equal(assigned.unitId, (await s.units.ledBy(orgId, lead.id))!.id, 'the board follows the manager');
  const events = await (s.db as DrizzleDb).execute(sql`SELECT "kind", "title", "forMemberAccountId" FROM agent_events WHERE "agentId" = ${s.chief.id} AND "kind" = 'org_task'`);
  const ev = ((events as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0];
  assert.ok(ev, 'an inbox event for the assignment'); assert.equal(ev.forMemberAccountId, 'ann'); assert.match(String(ev.title), /Task assigned to you: Check the sources/);
  assert.ok(!(await s.agents.listEvents(s.chief.id)).some((e) => e.kind === 'org_task'), 'addressed: invisible to the owner');
  await assert.rejects(s.orgs.assign(orgId, t.id, { humanId: 'cat' }), /human employee/);
  await assert.rejects(s.orgs.assign(orgId, t.id, {}), /agentId or humanId/);
  // task cards: theirs, and theirs alone
  const cards = await runWithViewer('single', { memberAccountId: 'ann', role: 'member', workspaceId: s.ws.id, displayName: 'Ann' }, () => s.orgs.myTasks(orgId));
  assert.deepEqual(cards.assigned.map((x) => x.id), [t.id]); assert.deepEqual(cards.reviewing, []);
  assert.deepEqual((await s.orgs.humanTasks(orgId, 'bob')).assigned, []);
  assert.match(await s.tasks.boardForModel(orgId, new Map()), /owner: human ann/);
  // they update through the existing routes
  await s.orgs.updateTask(orgId, t.id, { status: 'in_progress' });
  await s.orgs.comment(orgId, t.id, { text: 'Two claims unverified.' });
  assert.equal((await s.tasks.get(orgId, t.id)).status, 'in_progress');
  // re-assigning to an agent clears the human
  const back = await s.orgs.assign(orgId, t.id, { agentId: lead.id });
  assert.equal(back.assigneeHumanId, null); assert.equal(back.assigneeAgentId, lead.id);
  // review by a human: an approval-like card; ann (or the CEO) decides; a stranger cannot
  const reviewed = await s.orgs.requestReview(orgId, t.id, { text: 'Please check', reviewerHumanId: 'ann' });
  assert.equal(reviewed.status, 'in_review'); assert.equal(reviewed.reviewerHumanId, 'ann'); assert.equal(reviewed.reviewerAgentId, null);
  const pending = (await s.approvals.pending(orgId)).filter((a) => a.kind === 'human_review');
  assert.equal(pending.length, 1);
  assert.deepEqual((await s.orgs.humanTasks(orgId, 'ann')).reviewing.map((x) => x.id), [t.id]);
  await assert.rejects(runWithViewer('single', { memberAccountId: 'zed', role: 'member', workspaceId: s.ws.id, displayName: 'Z' }, () => s.orgs.decide(orgId, pending[0].id, { decision: 'approve' })), /no standing/);
  const decided = await runWithViewer('single', { memberAccountId: 'ann', role: 'member', workspaceId: s.ws.id, displayName: 'Ann' }, () => s.orgs.decide(orgId, pending[0].id, { decision: 'approve', note: 'All verified.' }));
  assert.equal(decided.approval.status, 'approved'); assert.equal(decided.approval.decidedBy, 'ann');
  assert.equal((await s.tasks.get(orgId, t.id)).status, 'done');
  // a rejection is a request for changes
  const t2 = await s.tasks.create(orgId, { title: 'Second', assigneeAgentId: lead.id, createdBy: 'user' });
  await s.tasks.requestReview(orgId, t2.id, { reviewerHumanId: 'ann' });
  const p2 = (await s.approvals.pending(orgId)).find((a) => a.kind === 'human_review')!;
  await s.orgs.decide(orgId, p2.id, { decision: 'reject', note: 'Missing a source.' });
  const after = await s.tasks.get(orgId, t2.id);
  assert.equal(after.status, 'todo'); assert.equal(after.reviewRounds, 1);
  assert.ok((await s.tasks.messages(orgId, { taskId: t2.id })).some((m) => /Changes requested .*Missing a source/.test(m.text)));
  // removing the employee re-syncs the chart
  await s.org.removeHuman(orgId, 'ann');
  assert.deepEqual((await s.units.unitTree(orgId))[0].children[0].memberHumanIds, []);
});

test('human employee in channels and tools: joins the unit channel of their manager and #company (not other units); a lead\'s org_assign may target only humans in its unit, the chief anywhere', async () => {
  const s = await setup({ groupchat: true });
  const { orgId, session } = await enable(s, 'autonomous', 50);
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:project-lead', title: 'Lead A', why: 'unit a' });
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:project-lead', title: 'Lead B', why: 'unit b' });
  const leadA = (await s.agents.list()).find((a) => a.name === 'Lead A')!;
  const leadB = (await s.agents.list()).find((a) => a.name === 'Lead B')!;
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:writer-editor', title: 'Writer A', reportsTo: 'Lead A', why: 'a' });
  await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:researcher', title: 'Researcher B', reportsTo: 'Lead B', why: 'b' });
  await s.org.setHuman(orgId, { memberAccountId: 'ann', role: 'employee', reportsToAgentId: leadA.id, title: 'Fact checker' });
  const humansIn = async (channelId: string) => (await s.groupchat!.members(channelId)).filter((m) => m.memberKind === 'human').map((m) => m.memberId).sort();
  const unitA = (await s.units.ledBy(orgId, leadA.id))!;
  const unitB = (await s.units.ledBy(orgId, leadB.id))!;
  const root = await s.units.rootUnit(orgId);
  assert.deepEqual(await humansIn(unitA.channelId!), ['ann', 'single']);
  assert.deepEqual(await humansIn(unitB.channelId!), ['single']);
  assert.deepEqual(await humansIn(root.channelId!), ['ann', 'single']);
  // the tools: Lead B cannot assign ann; Lead A can; the chief can assign anyone by title
  const t = await s.tasks.create(orgId, { title: 'Verify', assigneeAgentId: leadB.id, createdBy: 'user' });
  const sessionB = await s.repo.createSession({ workspaceId: s.ws.id, agentId: leadB.id, name: 'b' });
  await assert.rejects(s.runtime.execute(sessionB, 'org_assign', { taskId: t.id, human: 'ann' }), /outside your unit/);
  await assert.rejects(s.runtime.execute(sessionB, 'org_assign', { taskId: t.id, human: 'nobody' }), /no human employee/);
  const sessionA = await s.repo.createSession({ workspaceId: s.ws.id, agentId: leadA.id, name: 'a' });
  const tA = await s.tasks.create(orgId, { title: 'Check A', assigneeAgentId: leadA.id, createdBy: 'user' });
  assert.match(await s.runtime.execute(sessionA, 'org_assign', { taskId: tA.id, human: 'ann' }), /assigned to Fact checker; they were notified/);
  assert.equal((await s.tasks.get(orgId, tA.id)).assigneeHumanId, 'ann');
  assert.match(await s.runtime.execute(session, 'org_assign', { taskId: t.id, human: 'Fact checker' }), /assigned to Fact checker/);
  const audit = await s.audit.list(orgId, { action: 'task_assign_human' });
  assert.equal(audit.length, 2); assert.equal(audit[0].actor, 'chief');
  // a member without a unit cannot use the tool at all
  const writer = (await s.agents.list()).find((a) => a.name === 'Writer A')!;
  const sessionW = await s.repo.createSession({ workspaceId: s.ws.id, agentId: writer.id, name: 'w' });
  await assert.rejects(s.runtime.execute(sessionW, 'org_assign', { taskId: t.id, human: 'ann' }), /chief of staff and unit leads/);
  // moving the manager moves the human's channel membership along
  await s.org.setHuman(orgId, { memberAccountId: 'ann', role: 'employee', reportsToAgentId: leadB.id });
  assert.deepEqual(await humansIn(unitB.channelId!), ['ann', 'single']);
});
