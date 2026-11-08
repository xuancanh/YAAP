/** Company onboarding (execution plan item 25; docs/group-chat.md §5
 *  "Onboarding", docs/company-vision.md §1b, item 24's role catalog): `POST
 *  /api/workspaces/:id/org/bootstrap` does the whole setup in order — the
 *  chief (created or existing), the mode, the vision, the operating profile,
 *  the tunables within their fence, the ritual cadences, the first hires
 *  through the existing hire path and the first planning session — audited,
 *  refused for a workspace that already has a company, tolerant of roles the
 *  catalog does not know. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { organizations } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
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
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgIntentService } from '../server/src/org/org-intent.service';
import { OrgMeetingsService } from '../server/src/org/org-meetings.service';
import { OrgBootstrapService } from '../server/src/org/org-bootstrap.service';
import { OrgRolesService } from '../server/src/org/org-roles.service';
import { roleById } from '../server/src/org/roles/catalog';
import { DEFAULT_CHIEF_SCOPES } from '../server/src/org/org.service';
import { OrgController } from '../server/src/org/org.controller';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import { TUNABLES, tunable } from '../server/src/org/org-tunables';
import { setAddressLookup } from '../server/src/common/url-guard';
import { SkillsService } from '../server/src/skills/skills.service';
import { WorkspaceFs } from '../server/src/files/workspace-fs.service';
import { workspaceFileKey } from '../server/src/storage/storage.keys';
import { OrgLayoutService } from '../server/src/org/org-layout.service';
import { CHIEF_PACK_ID } from '../server/src/org/chief-os';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

async function setup() {
  const db = await testDb();
  const { stub, map } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider([]);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announced: string[] = [];
  const announcer = new OrgAnnouncer({ announce: async (_ws, text) => { announced.push(text); } });
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const intent = new OrgIntentService(db, org, units, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const meetings = new OrgMeetingsService(db, org, units, tasks, audit, agents, workspaces, approvals);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, undefined, undefined, intent, meetings);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, undefined, undefined, intent);
  runtime.debounceMs = 15;
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config, units, undefined, undefined, undefined, intent);
  const roles = new OrgRolesService();
  const skills = new SkillsService(db);
  const fs = new WorkspaceFs(stub, db);
  const bootstrap = new OrgBootstrapService(org, workspaces, agents, mode, approvals, runtime, audit, intent, units, meetings, roles, skills, stub, fs, new OrgLayoutService(db, fs));
  const controller = new WorkspaceOrgController(mode, orgs, config, meetings, undefined, undefined, undefined, undefined, undefined, bootstrap);
  const ws = (await workspaces.list())[0];
  return { db, agents, workspaces, audit, org, units, intent, approvals, meetings, runtime, mode, bootstrap, controller, ws, announced, skills, storage: stub, files: map };
}

const PROFILE = { values: 'ship weekly, never guess at numbers', culture: 'terse, async; never contact customers without approval' };

test('full happy path: creates the chief with the profile in its charter, enables supervised mode, writes vision + profile + tunables, quiets light cadences, proposes the first hire, queues planning and audits one org_bootstrap row', async () => {
  const s = await setup();
  const before = Date.now();
  const r = await s.controller.bootstrap(s.ws.id, {
    mode: 'supervised', chief: { create: { name: 'Nova' } }, monthlyUsd: 40, agentCap: 8,
    vision: { title: 'Be the newsletter people forward', description: 'A weekly letter on climate finance that busy people actually read.', horizonDays: 90, rules: 'No paid promotion.' },
    profile: PROFILE,
    tunables: { 'planning.objectivesPerVision': 2, 'intent.checkInCadenceDays': 14 },
    cadences: 'light', roles: ['role:marketer'], planNow: true,
  });
  assert.equal(r.mode, 'supervised');
  assert.equal(r.chief.created, true); assert.equal(r.chief.name, 'Nova');
  const chief = await s.agents.get(r.chief.agentId);
  assert.equal(chief.role, 'Chief of staff');
  assert.match(chief.charter, /chief of staff of Default/);
  assert.match(chief.charter, /ship weekly, never guess at numbers/);
  assert.match(chief.charter, /never contact customers without approval/);
  assert.match(chief.charter, /Mission: A weekly letter on climate finance/);
  // the mode
  const st = await s.controller.status(s.ws.id);
  assert.equal(st.mode, 'supervised'); assert.equal(st.chiefOfStaffAgentId, chief.id); assert.equal(st.orgMonthlyUsd, 40); assert.equal(st.orgAgentCap, 8); assert.equal(st.orgId, r.orgId);
  // the vision with its horizon (~90 days) and the rules
  assert.ok(r.vision); assert.equal(r.vision!.title, 'Be the newsletter people forward');
  const due = Date.parse(r.vision!.dueAt!); assert.ok(due > before + 89 * 86_400_000 && due < before + 91 * 86_400_000);
  const row = (await s.db.select().from(organizations).where(eq(organizations.id, r.orgId)))[0];
  assert.equal(row.rules, 'No paid promotion.'); assert.equal(row.values, PROFILE.values); assert.equal(row.culture, PROFILE.culture);
  assert.match(row.mission, /climate finance/);
  assert.deepEqual(r.profile, { values: true, culture: true });
  // the tunables, within the fence
  assert.equal(tunable(row, 'planning.objectivesPerVision'), 2); assert.equal(tunable(row, 'intent.checkInCadenceDays'), 14);
  assert.deepEqual(r.tunables.map((t) => t.key).sort(), ['intent.checkInCadenceDays', 'planning.objectivesPerVision']);
  // light rituals: the standup and the retro are off on the root, the review and the board stay
  const cadences = await s.meetings.cadences(r.orgId);
  assert.equal(r.cadences.mode, 'light'); assert.equal(r.cadences.disabled, 2);
  assert.deepEqual(cadences.filter((c) => c.enabled === 0).map((c) => c.kind).sort(), ['retro', 'standup']);
  assert.ok(cadences.some((c) => c.kind === 'weekly_review' && c.enabled === 1));
  assert.ok(cadences.some((c) => c.kind === 'board' && c.enabled === 1));
  // the first hire is an approval card (supervised): nothing exists yet
  assert.equal(r.hires.length, 1); assert.equal(r.hires[0].status, 'proposed'); assert.ok(r.hires[0].approvalId);
  const pending = await s.approvals.pending(r.orgId);
  assert.equal(pending.length, 1); assert.equal(pending[0].kind, 'hire');
  assert.equal((JSON.parse(pending[0].payload) as { roleId?: string }).roleId, 'marketer');
  assert.ok(!(await s.agents.list()).some((a) => a.name === 'Marketer'));
  // planning queued, announced, audited
  assert.equal(r.planning, 'queued');
  assert.ok(s.announced.some((t) => /Organization mode is on \(supervised\)/.test(t)));
  const rows = await s.audit.list(r.orgId, { action: 'org_bootstrap' });
  assert.equal(rows.length, 1);
  const payload = JSON.parse(rows[0].payload);
  assert.equal(payload.chief.created, true); assert.equal(payload.planning, 'queued'); assert.equal(payload.cadences.mode, 'light');
  assert.ok((await s.audit.list(r.orgId, { action: 'vision_set' })).length === 1);
  assert.ok((await s.audit.list(r.orgId, { action: 'profile_set' })).length === 1);
  // the two chosen tunables, plus what the operating system derived from the profile (the chosen keys win)
  assert.ok(!r.operatingSystem.tunables.some((t) => t.key === 'planning.objectivesPerVision' || t.key === 'intent.checkInCadenceDays'));
  assert.equal((await s.audit.list(r.orgId, { action: 'tunable_set', limit: 500 })).length, 2 + r.operatingSystem.tunables.length);
  assert.equal(payload.operatingSystem.stage, r.operatingSystem.stage);
  await new Promise((res) => setTimeout(res, 60));
});

test('an existing agent becomes the chief (nothing is created) and the other agents of the account are enrolled under it', async () => {
  const s = await setup();
  const chief = await s.agents.create({ name: 'Atlas', charter: 'You run things.' });
  await s.agents.create({ name: 'Writer', charter: 'You write.' });
  const n = (await s.agents.list()).length;
  const r = await s.bootstrap.bootstrap(s.ws.id, { mode: 'autonomous', chief: { agentId: chief.id }, monthlyUsd: 10, vision: { title: 'Write well' } });
  assert.equal(r.chief.created, false); assert.equal(r.chief.agentId, chief.id); assert.equal(r.chief.name, 'Atlas');
  assert.equal((await s.agents.list()).length, n);
  assert.equal(r.enrolled, 1);
  const members = await s.org.members(r.orgId);
  assert.equal(members.find((m) => m.agentId === chief.id)!.depth, 1);
  assert.equal((await s.workspaces.get(s.ws.id)).orgMode, 'autonomous');
  assert.deepEqual(r.profile, { values: false, culture: false });
  assert.equal(r.planning, 'not_requested');
  // an unknown chief id is refused before anything exists
  await assert.rejects(() => s.bootstrap.bootstrap(s.ws.id, { mode: 'supervised', chief: { agentId: 'nope' }, monthlyUsd: 0 }), /already has a company/);
});

test('cadence modes: none disables every ritual, default leaves them all on', async () => {
  const a = await setup();
  const ra = await a.bootstrap.bootstrap(a.ws.id, { mode: 'supervised', chief: { create: { name: 'Quiet' } }, monthlyUsd: 0, cadences: 'none' });
  const none = await a.meetings.cadences(ra.orgId);
  assert.ok(none.length >= 4);
  assert.equal(ra.cadences.total, none.length); assert.equal(ra.cadences.disabled, none.length);
  assert.ok(none.every((c) => c.enabled === 0));
  assert.equal((await a.audit.list(ra.orgId, { action: 'cadence_update' })).length, none.length);

  const b = await setup();
  const rb = await b.bootstrap.bootstrap(b.ws.id, { mode: 'supervised', chief: { create: { name: 'Loud' } }, monthlyUsd: 0, cadences: 'default' });
  const all = await b.meetings.cadences(rb.orgId);
  assert.equal(rb.cadences.mode, 'default'); assert.equal(rb.cadences.disabled, 0);
  assert.ok(all.length >= 4 && all.every((c) => c.enabled === 1));
});

test('a tunable outside its bound refuses the whole call with the fence, before any agent or organization exists', async () => {
  const s = await setup();
  const n = (await s.agents.list()).length;
  const def = TUNABLES['planning.objectivesPerVision'];
  await assert.rejects(
    () => s.bootstrap.bootstrap(s.ws.id, { mode: 'supervised', chief: { create: { name: 'Nova' } }, monthlyUsd: 0, tunables: { 'planning.objectivesPerVision': def.max + 1 } }),
    (err: Error) => /must stay within/.test(err.message) && err.message.includes(`${def.min}–${def.max}`),
  );
  await assert.rejects(() => s.bootstrap.bootstrap(s.ws.id, { mode: 'supervised', chief: { create: { name: 'Nova' } }, monthlyUsd: 0, tunables: { 'nope.key': 1 } }), /unknown tunable/);
  assert.equal((await s.agents.list()).length, n, 'no chief was created');
  assert.equal(await s.org.byWorkspace(s.ws.id), null);
  assert.equal((await s.workspaces.get(s.ws.id)).orgMode, 'off');
  // other refusals name the field
  await assert.rejects(() => s.bootstrap.bootstrap(s.ws.id, { mode: 'supervised', chief: { create: { name: 'Nova' } }, monthlyUsd: -1 }), /monthlyUsd/);
  await assert.rejects(() => s.bootstrap.bootstrap(s.ws.id, { mode: 'supervised', chief: { create: { name: 'Nova' } }, monthlyUsd: 0, agentCap: 99 }), /agentCap/);
  await assert.rejects(() => s.bootstrap.bootstrap(s.ws.id, { mode: 'supervised', chief: { create: { name: 'Nova' } }, monthlyUsd: 0, vision: { title: '   ' } }), /vision needs a title/);
  await assert.rejects(() => s.bootstrap.bootstrap(s.ws.id, { mode: 'supervised', chief: {} as never, monthlyUsd: 0 }), /chief must be/);
  assert.equal(await s.org.byWorkspace(s.ws.id), null);
});

test('a workspace that already has a company is refused with a clear 400 and nothing changes', async () => {
  const s = await setup();
  const first = await s.bootstrap.bootstrap(s.ws.id, { mode: 'supervised', chief: { create: { name: 'Nova' } }, monthlyUsd: 5, vision: { title: 'One' } });
  const n = (await s.agents.list()).length;
  await assert.rejects(() => s.bootstrap.bootstrap(s.ws.id, { mode: 'autonomous', chief: { create: { name: 'Second' } }, monthlyUsd: 50 }), (err: Error & { status?: number }) => err.status === 400 && /already has a company/.test(err.message) && /Settings/.test(err.message));
  assert.equal((await s.agents.list()).length, n);
  const st = await s.controller.status(s.ws.id);
  assert.equal(st.mode, 'supervised'); assert.equal(st.orgMonthlyUsd, 5); assert.equal(st.orgId, first.orgId);
  assert.equal((await s.audit.list(first.orgId, { action: 'org_bootstrap' })).length, 1);
  // a second workspace onboards on its own
  const ws2 = await s.workspaces.create({ name: 'Lab' });
  const r2 = await s.bootstrap.bootstrap(ws2.id, { mode: 'supervised', chief: { create: { name: 'Lab chief' } }, monthlyUsd: 0 });
  assert.notEqual(r2.orgId, first.orgId);
  assert.equal((await s.org.get(r2.orgId)).name, 'Lab');
});

test('first hires come from the item 24 role catalog (role:<id>, a bare id or a title) with market packs as the fallback; unknown roles are skipped with a note; in autonomous mode they are seated at once within the agent cap with the meet-rule scopes', async () => {
  const s = await setup();
  const r = await s.bootstrap.bootstrap(s.ws.id, {
    mode: 'autonomous', chief: { create: { name: 'Nova' } }, monthlyUsd: 20, agentCap: 4,
    vision: { title: 'Grow' }, roles: ['role-from-nowhere', 'role:engineer', 'Researcher', 'pro-support', 'role:support'],
  });
  assert.equal(r.hires.length, 5);
  assert.equal(r.hires[0].status, 'skipped'); assert.match(r.hires[0].note, /not in the role catalog/);
  // role:engineer — the role's charter, title and scopes, met with the chief's holdings: run_js/run_python are dropped and named
  assert.equal(r.hires[1].status, 'hired');
  const engineer = await s.agents.get(r.hires[1].agentId!);
  assert.equal(engineer.name, 'Engineer'); assert.equal(engineer.role, 'Engineer');
  assert.match(engineer.charter, /Engineer of Default/);
  const em = (await s.org.member(r.orgId, engineer.id))!;
  assert.equal(em.reportsToAgentId, r.chief.agentId); assert.equal(em.depth, 2);
  const granted = JSON.parse(em.scopes) as string[];
  assert.deepEqual([...granted].sort(), [...DEFAULT_CHIEF_SCOPES].sort(), 'meet(chief holdings, role scopes)');
  assert.ok(roleById('engineer')!.toolScopes.includes('tool:run_js'));
  assert.ok(!granted.includes('tool:run_js'));
  assert.match(r.hires[1].note, /dropped \(outside the chief's holdings\): tool:run_js, tool:run_python/);
  // a bare title resolves through the catalog too
  assert.equal(r.hires[2].status, 'hired');
  assert.equal((await s.agents.get(r.hires[2].agentId!)).name, 'Researcher');
  // the cap (4: chief + three) stops the fourth with the reason; the pack fallback is reached first
  assert.equal(r.hires[3].status, 'hired'); assert.equal((await s.agents.get(r.hires[3].agentId!)).name, 'Support Desk');
  assert.equal(r.hires[4].status, 'skipped'); assert.match(r.hires[4].note, /agent cap \(4\)/);
  assert.equal(await s.org.liveMemberCount(r.orgId), 4);
  assert.equal((await s.approvals.pending(r.orgId)).length, 0, 'autonomous mode leaves no cards');
  const payload = JSON.parse((await s.audit.list(r.orgId, { action: 'org_bootstrap' }))[0].payload);
  assert.deepEqual(payload.hires.map((h: { status: string }) => h.status), ['skipped', 'hired', 'hired', 'hired', 'skipped']);
  // the resolver itself: role first, pack second, the chief role never a report
  assert.equal(s.bootstrap.resolveRole('role:analyst')!.templateOrPack, 'role:analyst');
  assert.equal(s.bootstrap.resolveRole('Analyst')!.templateOrPack, 'role:analyst');
  assert.equal(s.bootstrap.resolveRole('Marketer')!.templateOrPack, 'role:marketer');
  assert.equal(s.bootstrap.resolveRole('pro-marketing')!.kind, 'pack');
  assert.equal(s.bootstrap.resolveRole('role:chief-of-staff'), null);
  assert.equal(s.bootstrap.resolveRole('role:nope'), null);
});

test('planNow without a vision reports planning as unavailable with the reason; the caps route carries the default veto window for the wizard', async () => {
  const s = await setup();
  const r = await s.bootstrap.bootstrap(s.ws.id, { mode: 'autonomous', chief: { create: { name: 'Nova' } }, monthlyUsd: 0, planNow: true });
  assert.equal(r.planning, 'unavailable');
  assert.ok(r.notes.some((n) => /no vision/.test(n)));
  const caps = s.controller.caps();
  assert.equal(caps.vetoWindowMinutes, TUNABLES['capital.vetoWindowMinutes'].default);
  assert.equal(caps.maxDepth, 3);
});

test('the chief and every first hire belong to the bootstrapped workspace; a chief from another workspace is refused (item 26)', async () => {
  const s = await setup();
  const target = await s.workspaces.create({ name: 'Venture' });
  const elsewhere = await s.agents.create({ name: 'Elsewhere', workspaceId: s.ws.id });
  await assert.rejects(() => s.bootstrap.bootstrap(target.id, { mode: 'supervised', chief: { agentId: elsewhere.id }, monthlyUsd: 0 }), /not an agent of this workspace/);
  const r = await s.bootstrap.bootstrap(target.id, {
    mode: 'autonomous', chief: { create: { name: 'Nova' } }, monthlyUsd: 20, agentCap: 4,
    vision: { title: 'Grow' }, roles: ['role:engineer', 'Researcher'],
  });
  assert.equal(r.chief.created, true);
  assert.equal((await s.agents.get(r.chief.agentId)).workspaceId, target.id, 'the chief lives in the target workspace');
  const hired = r.hires.filter((h) => h.status === 'hired');
  assert.ok(hired.length >= 1, 'at least one role hire was seated');
  for (const h of hired) assert.equal((await s.agents.get(h.agentId!)).workspaceId, target.id, `${h.role} lives in the target workspace`);
  assert.equal((await s.agents.list({ workspaceId: s.ws.id })).map((a) => a.id).join(), elsewhere.id, 'the default workspace gained nothing');
});

test('the chief of staff\'s operating system: derived from the profile, written as tunables within their bounds, the root rituals fitted to it (the default cadence mode), the pack\'s skills and loops on the chief and the ledger seeded under /org/ without clobbering', async () => {
  const s = await setup();
  // a file the CEO already wrote is kept
  await s.storage.put(workspaceFileKey(s.ws.id, 'org/decisions.md'), Buffer.from('# Ours'));
  const r = await s.bootstrap.bootstrap(s.ws.id, {
    mode: 'supervised', chief: { create: { name: 'Nova' } }, monthlyUsd: 10,
    vision: { title: 'Be forwarded', description: 'A pre-seed newsletter for climate finance people.' },
    profile: { values: 'move fast; experiment boldly; never guess at numbers', culture: 'terse, async, written updates' },
  });
  assert.equal(r.cadences.mode, 'profile');
  assert.equal(r.operatingSystem.stage, 'early');
  assert.equal(r.operatingSystem.cultureType, 'adhocracy');
  assert.equal(r.operatingSystem.archetype, 'generalist');
  const row = await s.org.get(r.orgId);
  assert.equal(tunable(row, 'chief.proxyLevel'), 0);
  assert.equal(tunable(row, 'chief.handoffSlaHours'), 8);
  assert.equal(tunable(row, 'planning.objectivesPerVision'), 2);
  assert.ok(r.operatingSystem.tunables.length >= 5);
  const why = (await s.audit.list(r.orgId, { action: 'tunable_set' })).map((a) => JSON.parse(a.payload).rationale as string);
  assert.ok(why.every((w) => /derived from the operating profile/.test(w)));
  // the root unit's rituals as derived: the standup stays (adhocracy), the leadership meeting is monthly, the retro stays
  const root = await s.units.rootUnit(r.orgId);
  const cad = (await s.meetings.cadences(r.orgId)).filter((c) => c.unitId === root.id);
  assert.equal(cad.find((c) => c.kind === 'board')!.cron, '0 9 1-7 * 1');
  assert.equal(cad.find((c) => c.kind === 'standup')!.enabled, 1);
  assert.equal(r.cadences.retimed, 1);
  // the chief's kit: every pack skill, private to it, and the four loops
  const pack = OrgApprovalsService.catalogItem(CHIEF_PACK_ID)!;
  const own = (await s.skills.list(undefined, r.chief.agentId)).filter((x) => x.agentId === r.chief.agentId).map((x) => x.name);
  assert.equal(r.operatingSystem.skills, pack.skills!.length);
  for (const sk of pack.skills!) assert.ok(own.includes(sk.name), sk.name);
  const loops = JSON.parse((await s.agents.get(r.chief.agentId)).loops) as Array<{ name: string; cron: string }>;
  assert.deepEqual(loops.map((l) => l.name), ['Operating-system sweep', 'Weekly business review pack', 'Monthly operating review', 'Quarterly planning kickoff']);
  assert.equal(loops[0].cron, '30 7 * * 1-5', 'an hour before the 8:00 brief');
  assert.equal(tunable(row, 'chief.preReadHours'), 48, 'never guessing at numbers is rigour: pre-reads two days ahead');
  assert.equal(loops[1].cron, '0 16 * * 3', 'the pre-read deadline before the Friday weekly review');
  // the charter is the rich one
  assert.match((await s.agents.get(r.chief.agentId)).charter, /What you never do/);
  // the ledger, never over an existing file
  assert.ok(r.operatingSystem.artifacts.includes('/org/operating-system.md'));
  assert.ok(!r.operatingSystem.artifacts.includes('/org/decisions.md'));
  assert.equal(s.files.get(workspaceFileKey(s.ws.id, 'org/decisions.md'))!.toString(), '# Ours');
  const os = s.files.get(workspaceFileKey(s.ws.id, 'org/operating-system.md'))!.toString();
  assert.match(os, /Stage: \*\*early\*\*/); assert.match(os, /Culture type: \*\*adhocracy\*\*/);
  assert.match(s.files.get(workspaceFileKey(s.ws.id, 'org/values.md'))!.toString(), /never guess at numbers \| none yet/);
  // the generated indexes follow the ledger: the calendar from the cadences, in words, the README, the root's rituals
  assert.match(s.files.get(workspaceFileKey(s.ws.id, 'org/calendar.md'))!.toString(), /\| Board meeting \| [^|]+\(#company\) \| first Monday of each month at 09:00 \(`0 9 1-7 \* 1`\) \|/);
  assert.ok(r.operatingSystem.artifacts.includes('/org/calendar.md') && r.operatingSystem.artifacts.includes('/org/README.md') && r.operatingSystem.artifacts.includes('/org/rituals/company.md'), r.operatingSystem.artifacts.join(', '));
  assert.match(os, /## Why the root rituals look like this/);

  // an existing agent as chief keeps its own charter but gains the playbooks; explicit answers win; a bad answer refuses the call
  const b = await setup();
  const atlas = await b.agents.create({ name: 'Atlas', charter: 'You run things.', workspaceId: b.ws.id });
  await assert.rejects(() => b.bootstrap.bootstrap(b.ws.id, { mode: 'supervised', chief: { agentId: atlas.id }, monthlyUsd: 0, profile: { stage: 'huge' as never } }), /profile\.stage/);
  const rb = await b.bootstrap.bootstrap(b.ws.id, { mode: 'autonomous', chief: { agentId: atlas.id }, monthlyUsd: 0, profile: { values: 'compliance', stage: 'scale', cultureType: 'market' } });
  assert.equal(rb.operatingSystem.stage, 'scale'); assert.equal(rb.operatingSystem.cultureType, 'market'); assert.equal(rb.operatingSystem.archetype, 'stand-in');
  assert.equal((await b.agents.get(atlas.id)).charter, 'You run things.');
  assert.ok(rb.operatingSystem.skills > 0);
  assert.equal(tunable(await b.org.get(rb.orgId), 'chief.proxyLevel'), 2);
});
