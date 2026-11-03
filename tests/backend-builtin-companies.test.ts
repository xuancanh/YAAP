/** First-party starter blueprints (docs/blueprints.md §3a, docs/foundry.md
 *  §10.2): the seven COMPANY.json v1 documents in blueprints/first-party/
 *  validate, fit their envelopes, draw every role from the catalog, carry the
 *  rituals and tunables their own profile derives, and are served as
 *  built-in registry items — listed first in the Companies listing, badged
 *  official, searchable — that install through the same review → plan →
 *  import flow as a published blueprint. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { orgBlueprintImports, registryInstalls } from '../server/src/database/schema';
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
import { BUILTIN_PREFIX, builtinCompanies, RegistryService } from '../server/src/registry/registry.service';
import { BUILTIN_COMPANIES } from '../server/src/registry/builtin-companies.generated';
import { SettingsService } from '../server/src/settings/settings.module';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgIntentService } from '../server/src/org/org-intent.service';
import { OrgBlueprintsService } from '../server/src/org/org-blueprints.service';
import { CompaniesController } from '../server/src/org/blueprints/companies.controller';
import { ROLES, roleById, roleCharter } from '../server/src/org/roles/catalog';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { TUNABLES, checkTunable } from '../server/src/org/org-tunables';
import { MEETING_KINDS } from '../server/src/org/org-meetings.service';
import { meetScopes } from '../server/src/org/scopes';
import { CARDS } from '../server/src/connections/cards';
import { BLUEPRINT_MAX_DEPTH, BLUEPRINT_MAX_FANOUT, BLUEPRINT_MAX_ROLES, hireOrder, rootRole, unitsOf, validateBlueprint, type Blueprint } from '../server/src/org/blueprints/format';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'blueprints/first-party');

/** The starter catalog as docs/foundry.md §10.2 states it: seats incl. the chief, the envelope, the profile diagnosis. */
const CATALOG: Record<string, { name: string; seats: number; envelope: number; stage: string; culture: string; norm?: 'speed' | 'rigor' | 'writing' }> = {
  'saas-startup': { name: 'SaaS startup', seats: 10, envelope: 600, stage: 'early', culture: 'adhocracy', norm: 'speed' },
  agency: { name: 'Agency', seats: 8, envelope: 500, stage: 'growth', culture: 'market' },
  'e-commerce-shop': { name: 'E-commerce shop', seats: 10, envelope: 550, stage: 'early', culture: 'market', norm: 'speed' },
  'open-source-project': { name: 'Open-source project', seats: 6, envelope: 250, stage: 'early', culture: 'clan', norm: 'writing' },
  'research-lab': { name: 'Research lab', seats: 6, envelope: 400, stage: 'early', culture: 'adhocracy', norm: 'rigor' },
  'solo-creator': { name: 'Solo creator', seats: 5, envelope: 150, stage: 'early', culture: 'clan' },
  'professional-services-firm': { name: 'Professional services firm', seats: 11, envelope: 700, stage: 'growth', culture: 'hierarchy', norm: 'rigor' },
};

const files = readdirSync(SRC).filter((f) => f.endsWith('.company.json')).sort();
const docs = files.map((f) => ({ slug: f.slice(0, -'.company.json'.length), raw: JSON.parse(readFileSync(join(SRC, f), 'utf8')) as Record<string, unknown> }));

test('the seven starters ship, and the committed generated catalog is what the build emits from blueprints/first-party', () => {
  assert.deepEqual(docs.map((d) => d.slug).sort(), Object.keys(CATALOG).sort());
  const dir = mkdtempSync(join(tmpdir(), 'blueprints-out-'));
  try {
    const out = join(dir, 'out.ts');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/build-builtin-companies.mjs')], { env: { ...process.env, BLUEPRINTS_OUT: out }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, 'utf8'), readFileSync(join(ROOT, 'server/src/registry/builtin-companies.generated.ts'), 'utf8'), 'regenerate with node scripts/build-builtin-companies.mjs');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(BUILTIN_COMPANIES.map((b) => b.slug), Object.keys(CATALOG), 'served in the starter catalog order');
});

test('every starter validates as COMPANY.json v1 within the structural caps, with one chief-of-staff root and first-party origin', () => {
  for (const { slug, raw } of docs) {
    const bp = validateBlueprint(raw);
    assert.deepEqual(bp, raw, `${slug}: the file is already in normal form (no field dropped or defaulted)`);
    assert.equal(bp.name, CATALOG[slug].name);
    assert.ok(bp.description.length >= 40 && bp.description.length <= 300, `${slug}: a mission the listing shows whole`);
    assert.ok(bp.profile.values && bp.profile.culture && bp.profile.rules, `${slug}: values, culture and rules`);
    assert.ok(bp.vision && bp.vision.title && bp.vision.horizonDays >= 30, `${slug}: a vision template with a relative horizon`);
    assert.ok(bp.roles.length <= BLUEPRINT_MAX_ROLES);
    const root = rootRole(bp);
    assert.equal(root.roleId, 'chief-of-staff', `${slug}: the root is the chief of staff`);
    assert.equal(hireOrder(bp).length, bp.roles.length - 1, `${slug}: every role is reachable from the chief`);
    for (const r of bp.roles) {
      let d = 1; let cur = r;
      while (cur.reportsTo) { d++; cur = bp.roles.find((x) => x.title === cur.reportsTo)!; }
      assert.ok(d <= BLUEPRINT_MAX_DEPTH, `${slug}: ${r.title} depth ${d}`);
      assert.ok(bp.roles.filter((x) => x.reportsTo === r.title).length <= BLUEPRINT_MAX_FANOUT, `${slug}: ${r.title} fan-out`);
    }
    assert.deepEqual(bp.playbooks, [], `${slug}: no playbook — none exists as a shared skill to carry`);
    assert.equal(bp.origin.exportedFrom, 'yaam first-party'); assert.equal(bp.origin.sourceOrgId, 'first-party');
    for (const c of bp.cards ?? []) assert.ok(CARDS.some((k) => k.id === c), `${slug}: card ${c} exists`);
  }
});

test('every starter uses existing catalog roles, its seats match the starter catalog, and it fits its envelope', () => {
  for (const { slug, raw } of docs) {
    const bp = raw as unknown as Blueprint;
    assert.equal(bp.roles.length, CATALOG[slug].seats, `${slug}: seats incl. the chief`);
    assert.equal(bp.budget.monthlyUsd, CATALOG[slug].envelope, `${slug}: the starting envelope`);
    for (const r of bp.roles) {
      const role = roleById(r.roleId ?? '');
      assert.ok(role && role.id === r.roleId, `${slug}: ${r.title} names catalog role "${r.roleId}"`);
      // The charter is the role's, for any company name, plus this company type's focus.
      assert.ok(r.charter.startsWith(roleCharter(role, 'the company')), `${slug}: ${r.title} charter is drawn from role:${role.id}`);
      assert.ok(r.charter.length > roleCharter(role, 'the company').length, `${slug}: ${r.title} carries a company-type focus`);
      assert.ok(role.toolScopes.every((s) => r.scopes.includes(s)), `${slug}: ${r.title} holds the role's tool scopes`);
      assert.ok(r.monthlyUsd > 0, `${slug}: ${r.title} has an envelope`);
    }
    const total = bp.roles.reduce((n, r) => n + r.monthlyUsd, 0);
    assert.ok(total <= bp.budget.monthlyUsd, `${slug}: $${total} of seats within the $${bp.budget.monthlyUsd} envelope`);
    const hires = bp.roles.filter((r) => r.reportsTo !== null);
    assert.deepEqual(bp.budget.allocations, Object.fromEntries(hires.map((r) => [r.title, r.monthlyUsd])), `${slug}: allocations are the per-seat envelopes`);
    // The chief holds what its reports need, so the meet rule drops nothing on import.
    const chief = rootRole(bp);
    for (const r of hires) {
      const want = r.scopes.filter((s) => !s.startsWith('connection:'));
      assert.deepEqual(meetScopes(chief.scopes, want), [...want].sort(), `${slug}: ${r.title} keeps its scopes at the meet`);
    }
  }
  assert.ok(ROLES.length > 0);
});

test('every starter\'s rituals and tunables are derived from its own profile; unit cadences belong to units that exist', () => {
  for (const { slug, raw } of docs) {
    const bp = raw as unknown as Blueprint;
    const os = deriveOperatingSystem({ values: bp.profile.values, culture: bp.profile.culture, mission: bp.description, vision: bp.vision?.title, size: bp.roles.length });
    const want = CATALOG[slug];
    assert.equal(os.stage, want.stage, `${slug}: stage`);
    assert.equal(os.cultureType, want.culture, `${slug}: culture`);
    if (want.norm) assert.equal(os[want.norm], true, `${slug}: ${want.norm}`);
    const cadences = bp.cadences ?? [];
    assert.deepEqual(cadences.filter((c) => c.unitTitle === 'root'), os.rituals.filter((r) => r.cron).map((r) => ({ unitTitle: 'root', kind: r.kind, cron: r.cron })), `${slug}: the root's rituals are the profile's`);
    const leads = new Set(unitsOf(bp).map((u) => u.title));
    for (const c of cadences.filter((x) => x.unitTitle !== 'root')) {
      assert.ok(leads.has(c.unitTitle), `${slug}: ${c.unitTitle} leads a unit`);
      assert.ok((MEETING_KINDS as readonly string[]).includes(c.kind), `${slug}: ${c.kind} is a meeting kind`);
    }
    assert.ok(cadences.some((c) => c.unitTitle !== 'root'), `${slug}: at least one unit rhythm`);
    const derived = Object.fromEntries(os.tunables.filter((t) => TUNABLES[t.key] && TUNABLES[t.key].default !== t.value).map((t) => [t.key, t.value]));
    assert.deepEqual(bp.tunables, derived, `${slug}: tunables are the profile's derivation, nothing pinned by hand`);
    for (const [k, v] of Object.entries(bp.tunables)) assert.equal(checkTunable(k, v).ok, true, `${slug}: ${k} within its bound`);
  }
});

async function setup() {
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
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(new ScriptedProvider([])), skillsStub(), stub, mcpStub(), agents, workspaces);
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
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const blueprints = new OrgBlueprintsService(db, org, mode, intent, approvals, units, agents, skills, workspaces, audit, settings, registry);
  const companies = new CompaniesController(registry, blueprints, mode, config);
  return { db, agents, workspaces, registry, org, units, approvals, blueprints, companies };
}

test('the Companies listing serves the starters first as official built-in items, searchable; the community listing does not', async () => {
  const s = await setup();
  assert.equal(builtinCompanies().length, 7, 'every embedded starter passes normalizeManifest');
  const { items } = await s.companies.list();
  assert.deepEqual(items.slice(0, 7).map((i) => i.id), Object.keys(CATALOG).map((k) => `${BUILTIN_PREFIX}${k}`));
  for (const i of items) {
    assert.equal(i.official, true); assert.equal(i.source, 'builtin'); assert.equal(i.kind, 'company'); assert.equal(i.publisherName, 'yaam');
    assert.equal(i.scanReport.ok, true, `${i.slug}: the scan passes`);
    assert.equal(i.capabilities.company!.roles, CATALOG[i.slug].seats);
    assert.equal(i.capabilities.company!.monthlyUsd, CATALOG[i.slug].envelope);
    assert.deepEqual(i.outcomes, { first_key_result: 0, thirty_days_in_envelope: 0 });
  }
  assert.deepEqual((await s.companies.list('lab')).items.map((i) => i.slug), ['research-lab']);
  assert.deepEqual((await s.companies.list('SHOP')).items.map((i) => i.slug), ['e-commerce-shop']);
  assert.equal((await s.companies.list('official')).items.length, 7);
  assert.equal((await s.companies.list('no such company')).items.length, 0);
  assert.equal((await s.registry.list()).items.length, 0, 'the community listing (no kind) shows only what people published');
  assert.equal((await s.registry.list({ kind: 'company' })).items.length, 7);
  const detail = await s.registry.get('builtin:research-lab');
  assert.equal(detail.manifest.format, 'yaam-company/1'); assert.equal(detail.manifest.name, 'Research lab');
  await assert.rejects(s.registry.get('builtin:nope'), /registry item builtin:nope/);
});

test('a starter installs through review → plan → import into an empty workspace; the plan lists roles, cost and cadences; installs and outcomes count against the built-in id', async () => {
  const s = await setup();
  const target = await s.workspaces.create({ name: 'My SaaS' });
  const id = 'builtin:saas-startup';
  const first = await s.companies.install(id, { workspaceId: target.id, mode: 'supervised' });
  if (!('requiresConfirm' in first)) throw new Error('expected the review and the plan');
  assert.equal(first.review!.source, 'builtin'); assert.equal(first.review!.blueprint!.roles.length, 10);
  assert.equal(first.plan!.ok, true);
  assert.equal(first.plan!.chief.roleId, 'chief-of-staff');
  assert.equal(first.plan!.hires.length, 9);
  assert.ok(first.plan!.hires.every((h) => h.dropped.every((d) => d.startsWith('connection:'))), 'only connection scopes drop (recommended, never granted)');
  assert.equal(first.plan!.budget.monthlyUsd, 600); assert.equal(first.plan!.budget.allocated, 515);
  assert.deepEqual(first.plan!.projects.map((p) => [p.title, p.lead, p.team.length]), [['Self-serve onboarding', 'Program Manager', 4]], 'a roadmap item owned by the Program Manager with a cross-functional team');
  assert.ok(first.plan!.cadences.list.some((c) => c.unitTitle === 'Head of Engineering' && c.kind === 'planning'));
  assert.equal(first.plan!.cadences.list.length, first.plan!.cadences.count);
  assert.deepEqual(first.plan!.recommendedConnections, ['calendar', 'gmail']);
  assert.equal(await s.org.byWorkspace(target.id), null, 'the review writes nothing');
  const done = await s.companies.install(id, { workspaceId: target.id, mode: 'supervised', confirm: true });
  if (!('ok' in done)) throw new Error('expected the install');
  assert.equal(done.install.itemId, id);
  assert.ok(done.approvalId, 'supervised: one blueprint approval card for the staffing');
  const org = (await s.org.byWorkspace(target.id))!;
  assert.equal(org.name, 'SaaS startup'); assert.equal(org.monthlyBudgetUsd, 600);
  const row = (await (s.db as DrizzleDb).select().from(orgBlueprintImports).where(eq(orgBlueprintImports.orgId, done.orgId)))[0];
  assert.equal(row.itemId, id);
  assert.equal((await (s.db as DrizzleDb).select().from(registryInstalls).where(eq(registryInstalls.itemId, id))).length, 1);
  const listed = (await s.companies.list()).items.find((i) => i.id === id)!;
  assert.equal(listed.installs, 1); assert.equal(listed.installed, true);
  // a workspace that already runs a company is refused at the plan
  const again = await s.companies.install(id, { workspaceId: target.id, mode: 'autonomous' });
  if (!('requiresConfirm' in again)) throw new Error('expected the plan');
  assert.equal(again.plan!.ok, false);
  // outcomes attach to the built-in id
  await s.registry.recordOutcome(id, 'first_key_result');
  assert.deepEqual((await s.companies.list()).items.find((i) => i.id === id)!.outcomes, { first_key_result: 1, thirty_days_in_envelope: 0 });
  await assert.rejects(s.registry.recordOutcome('builtin:nope', 'first_key_result'), /registry item builtin:nope/);
});

test('every starter plans cleanly (autonomous) into an empty workspace and the smallest imports end to end', async () => {
  const s = await setup();
  for (const b of builtinCompanies()) {
    const ws = await s.workspaces.create({ name: `ws ${b.item.slug}` });
    const r = await s.companies.install(b.item.id, { workspaceId: ws.id, mode: 'autonomous' });
    if (!('requiresConfirm' in r)) throw new Error('expected the plan');
    assert.equal(r.plan!.ok, true, b.item.slug);
    assert.equal(r.plan!.hires.length, CATALOG[b.item.slug].seats - 1);
    assert.ok(r.plan!.budget.allocated <= r.plan!.budget.monthlyUsd);
    assert.ok(!r.plan!.notes.some((n) => /cut from/.test(n)), `${b.item.slug}: no allocation cut`);
  }
  const ws = await s.workspaces.create({ name: 'Solo' });
  const done = await s.companies.install('builtin:solo-creator', { workspaceId: ws.id, mode: 'autonomous', confirm: true });
  if (!('ok' in done)) throw new Error('expected the install');
  assert.equal(done.hired.length, 4);
  const members = await s.org.members(done.orgId);
  assert.equal(members.length, 5);
  const units = await s.units.units(done.orgId);
  assert.ok(units.length >= 2, 'the company and the Editor-in-chief unit');
});
