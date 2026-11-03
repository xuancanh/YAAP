/** Heads staff their own units, the chief delegates the design, Program
 *  Managers own roadmap items, and projects get cross-functional teams
 *  (docs/autonomous-skills-review.md "Why heads don't hire",
 *  docs/work-tracking.md "Project teams", docs/blueprints.md §1b). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, enable, sessionOf, inbox, type S } from './org-governance-harness';
import { headFunction, isHeadMember, isHeadTitle, HEAD_PLAYBOOKS } from '../server/src/org/heads';
import { headHireRefusal } from '../server/src/org/org-runtime.service';
import { ROLES, roleById } from '../server/src/org/roles/catalog';
import { AUTHORED_PACKS } from '../server/src/market/authored-packs.generated';
import { OrgProjectsService } from '../server/src/org/org-projects.service';
import { OrgProjectsTools } from '../server/src/org/org-projects.tools';
import { OrgProjectTeamsService } from '../server/src/org/org-project-teams.service';
import { OrgChiefService } from '../server/src/org/org-chief.service';
import { validateBlueprint, BLUEPRINT_FORMAT } from '../server/src/org/blueprints/format';
import { OrgBlueprintsService } from '../server/src/org/org-blueprints.service';
import { OrgMeetingRuntime } from '../server/src/org/org-meeting-runtime.service';
import { OrgBriefingService } from '../server/src/org/org-briefing.service';
import type { ConfigService } from '@nestjs/config';

/** A fake channel layer (the group-chat module's seam) that records what happens. */
function fakeChannels(s: S) {
  const channels = new Map<string, { id: string; slug: string; members: Array<{ kind: 'agent' | 'human'; id: string }>; posts: string[] }>();
  let n = 0;
  const impl = {
    announce: async () => undefined,
    companyChannel: async () => { const c = channels.get('company') ?? { id: 'ch-company', slug: 'company', members: [], posts: [] }; channels.set('company', c); return { id: c.id, slug: c.slug }; },
    ensureUnitChannel: async (_ws: string, slug: string, _name: string, opts: { agentIds: string[]; humanIds: string[] }) => {
      const id = `ch-${++n}`;
      channels.set(id, { id, slug, members: [...opts.agentIds.map((a) => ({ kind: 'agent' as const, id: a })), ...opts.humanIds.map((h) => ({ kind: 'human' as const, id: h }))], posts: [] });
      return { id, slug };
    },
    channelMembers: async (id: string) => channels.get(id)?.members ?? [],
    addChannelMember: async (id: string, kind: 'agent' | 'human', who: string) => { channels.get(id)?.members.push({ kind, id: who }); },
    removeChannelMember: async (id: string, kind: 'agent' | 'human', who: string) => { const c = channels.get(id); if (c) c.members = c.members.filter((m) => !(m.kind === kind && m.id === who)); },
    updateChannel: async () => undefined,
    postSystem: async (id: string, text: string) => { channels.get(id)?.posts.push(text); },
  };
  (s.runtime as unknown as { announcer: { bind: (x: unknown) => void } }).announcer.bind(impl);
  return channels;
}

function wire(s: S) {
  const projects = new OrgProjectsService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, undefined, s.decisions);
  const announcer = (s.runtime as unknown as { announcer: ConstructorParameters<typeof OrgProjectTeamsService>[6] }).announcer;
  const teams = new OrgProjectTeamsService(s.org, s.approvals, s.audit, s.agents, s.tasks, projects, announcer, s.units, s.decisions);
  const tools = new OrgProjectsTools(s.org, projects, s.tasks, s.agents, s.config, s.runtime, s.turns, teams);
  return { projects, teams, tools };
}

const names = (specs: Array<{ name: string }>) => new Set(specs.map((t) => t.name));

// ---- 1. who is a head ----

test('head detection is not limited to catalog titles: "Head of Tutoring", a lead title under the chief and the explicit flag all make a head; a Program Manager or a specialist does not', () => {
  const org = { chiefOfStaffAgentId: 'chief', auditorAgentId: 'aud' };
  const m = (title: string, over: Record<string, unknown> = {}) => ({ agentId: 'a', title, status: 'active', reportsToAgentId: 'chief', isHead: 0, ...over });
  assert.ok(isHeadTitle('Head of Sales'));
  assert.ok(isHeadTitle('Head of Tutoring'));
  assert.ok(isHeadTitle('Research Lead'));
  assert.ok(isHeadTitle('VP Growth'));
  assert.ok(isHeadTitle('Engineering Manager'));
  for (const t of ['Program Manager', 'Product Manager', 'Founding Engineer', 'Writer', 'Chief of staff', 'Program Coordinator']) assert.ok(!isHeadTitle(t), `${t} is no head title`);
  assert.equal(headFunction('Head of Sales'), 'sales');
  assert.equal(headFunction('VP Growth'), 'marketing');
  assert.equal(headFunction('Head of Customer Support'), 'cs');
  assert.equal(headFunction('Head of Tutoring'), null, 'a function the catalog does not have: a head with no catalog function');
  assert.ok(isHeadMember(m('Head of Tutoring'), org, false));
  assert.ok(!isHeadMember(m('Head of Tutoring', { reportsToAgentId: 'someone' }), org, false), 'a head title below another head is not a head by title alone');
  assert.ok(isHeadMember(m('Tutor', { isHead: 1, reportsToAgentId: 'someone' }), org, false), 'the explicit flag');
  assert.ok(isHeadMember(m('Tutor'), org, true), 'a unit lead');
  assert.ok(!isHeadMember(m('Head of Audit', { agentId: 'aud' }), org, true), 'never the auditor');
  assert.ok(!isHeadMember(m('Head of Ops', { status: 'paused' }), org, false));
  // a head of no catalog function may hire specialists of any function, never a head
  assert.equal(headHireRefusal(null, 'role:engineering-software-engineer'), null);
  assert.match(headHireRefusal(null, 'role:sales-manager') ?? '', /not other heads/);
});

test('why heads did not hire, fixed: a "Head of Tutoring" with no reports is offered the head tools in every session kind, leads a unit from day one, sees a staffing gap in its task runs, chats and heartbeats, and is woken for it once a day', async () => {
  const s = await setup();
  const orgId = await enable(s, 'supervised');
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Tutoring' });
  await s.units.syncMembership(orgId);
  const head = await s.runtime.headOf(orgId, s.writer.id);
  assert.ok(head, 'a non-catalog head title under the chief is a head');
  assert.equal(head!.fn, null);
  assert.ok(head!.unit, 'it leads a unit before its first hire');
  const loop = names(await s.runtime.specsFor(await sessionOf(s, s.writer.id)));
  for (const t of ['org_roles', 'org_hire_agent', 'org_pause_agent', 'org_update_member', 'org_set_goal', 'org_unit_report']) assert.ok(loop.has(t), `offered ${t} outside a task run`);
  // the staffing line: no specialists, open work it carries itself
  await s.tasks.create(orgId, { title: 'Tutor flow v1', createdBy: 'chief', assigneeAgentId: s.writer.id, status: 'todo' });
  const ctx = await s.runtime.contextFor(await sessionOf(s, s.writer.id));
  assert.match(ctx!, /Staffing gap: no specialists; you carry 1 open task\(s\)/);
  assert.match(ctx!, /org_hire_agent "role:<id>" reportsTo you/);
  const now = new Date();
  assert.ok((await s.runtime.heartbeatReasons(s.writer.id, now)).some((r) => /Staffing gap/.test(r)), 'the gap wakes the head');
  assert.ok(!(await s.runtime.heartbeatReasons(s.writer.id, now)).some((r) => /Staffing gap/.test(r)), 'once a day, not every beat');
  // a specialist is told how to get a seat filled, not just refused
  await assert.rejects(s.runtime.execute(await sessionOf(s, s.editor.id), 'org_hire_agent', { templateOrPack: 'role:analyst', title: 'Analyst', why: 'x' }), /You are not a head here.*make_head.*org_create_task/);
});

test('a head\'s hire end to end: supervised, the card goes to its manager (the chief) first; autonomous, it hires within its envelope; a hire into a head role marks the member a head and brings the head playbooks', async () => {
  const s = await setup();
  const orgId = await enable(s, 'supervised');
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Tutoring' });
  await s.units.syncMembership(orgId);
  const head = await sessionOf(s, s.writer.id);
  const out = await s.runtime.execute(head, 'org_hire_agent', { templateOrPack: 'role:writer-editor', title: 'Lesson Writer', why: 'lesson plans wait a week' });
  assert.match(out, /Hire proposed/);
  const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'hire')!;
  assert.equal(card.holder, `agent:${s.chief.id}`, 'decision routing: the head\'s manager holds it first');
  assert.equal(card.requestedBy, `agent:${s.writer.id}`);
  // autonomous: within the envelope, at once
  await s.mode.setMode(s.ws.id, { mode: 'autonomous', chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: 10 });
  const hired = await s.runtime.execute(head, 'org_hire_agent', { templateOrPack: 'role:researcher', title: 'Curriculum Researcher', monthlyBudgetUsd: 3, why: 'the syllabus map is missing' });
  assert.match(hired, /Hired .*reporting to you/);
  // the chief hires a head through a catalog head role: flagged, and the pack's team-design skill is on it
  const chiefS = await sessionOf(s, s.chief.id);
  await s.runtime.execute(chiefS, 'org_hire_agent', { templateOrPack: 'role:engineering-manager', why: 'the product needs an engineering function' });
  const eng = (await s.org.members(orgId)).find((m) => m.title === 'Head of Engineering')!;
  assert.equal(eng.isHead, 1);
  const engSkills = (await s.approvals['skills']!.list(undefined, eng.agentId)).filter((x) => x.agentId === eng.agentId).map((x) => x.name);
  assert.ok(engSkills.includes('engineering-team-design'), 'a role hire brings its pack (its team-design playbook)');
  assert.ok(engSkills.includes('engineering-team-management'));
  // make_head on an enrolled agent with no pack: the flag, a unit, and the generic head playbooks
  await s.runtime.execute(chiefS, 'org_reorg', { changes: [{ op: 'make_head', agent: 'Editor' }], why: 'Editor runs editing as a function' });
  const ed = (await s.org.member(orgId, s.editor.id))!;
  assert.equal(ed.isHead, 1);
  assert.ok(await s.runtime.headOf(orgId, s.editor.id));
  const edSkills = (await s.approvals['skills']!.list(undefined, s.editor.id)).filter((x) => x.agentId === s.editor.id).map((x) => x.name);
  for (const p of HEAD_PLAYBOOKS) assert.ok(edSkills.includes(p.name), `${p.name} installed on the new head`);
  assert.deepEqual(await s.approvals.ensureHeadPlaybooks(orgId, s.editor.id), [], 'idempotent');
});

// ---- 2. the chief delegates ----

test('the chief delegates org design: its pack carries delegate-org-design and points its planning at the heads; its heartbeat lists heads with a staffing gap; head packs carry team-design and no longer say hiring is the chief\'s call', async () => {
  const chief = AUTHORED_PACKS.find((p) => p.id === 'pack-chief-of-staff')!;
  const skill = chief.skills!.find((x) => x.name === 'delegate-org-design');
  assert.ok(skill, 'the chief has delegate-org-design');
  assert.match(skill!.instructions, /mandate.*envelope/s);
  assert.match(skill!.instructions, /Never rewrite a head's design yourself; never hire a head's specialists for it/);
  assert.match(chief.skills!.find((x) => x.name === 'operating-system-setup')!.instructions, /delegate-org-design/);
  assert.match(chief.skills!.find((x) => x.name === 'quarterly-planning')!.instructions, /team design/);
  assert.match(chief.charter!, /Program Manager/);
  for (const h of AUTHORED_PACKS.filter((p) => p.level === 'head')) {
    assert.ok(h.skills!.some((x) => x.name.endsWith('-team-design')), `${h.id} has a team-design playbook`);
    assert.doesNotMatch(h.charter!, /chief's call/, `${h.id}'s charter no longer contradicts its team-management playbook`);
    assert.match(h.charter!, /You staff your own unit/);
  }
  // the chief's heartbeat: a head with no specialists is a gap to delegate
  const s = await setup();
  const orgId = await enable(s, 'supervised');
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Tutoring' });
  await s.units.syncMembership(orgId);
  const chiefSvc = new OrgChiefService(s.org, s.tasks, s.approvals, s.agents, s.units, s.meetings, s.signals);
  const st = await chiefSvc.state(orgId);
  assert.deepEqual(st.staffingGaps?.map((g) => g.name), ['Writer']);
  assert.match(await chiefSvc.heartbeatContext(s.chief.id, new Date()) ?? '', /Heads with a staffing gap — delegate the team design to them/);
});

// ---- 3. Program Managers ----

test('the Program Manager role and pack: operations, a pack with the project rituals, and projects default their lead to a PM when the company has one', async () => {
  const role = roleById('ops-pm')!;
  assert.equal(role.title, 'Program Manager');
  assert.equal(role.packId, 'pack-biz-ops-pm');
  assert.ok(!isHeadTitle(role.title), 'a PM is not a head');
  assert.equal(new Set(ROLES.map((r) => r.id)).size, ROLES.length);
  const pack = AUTHORED_PACKS.find((p) => p.id === 'pack-biz-ops-pm')!;
  assert.equal(pack.function, 'operations');
  for (const k of ['program-kickoff', 'program-health-update', 'program-milestones', 'program-dependencies', 'program-appetite-breaker', 'program-standup', 'program-team', 'program-close']) assert.ok(pack.skills!.some((x) => x.name === k), `PM pack has ${k}`);
  const s = await setup();
  const orgId = await enable(s, 'supervised');
  const { projects } = wire(s);
  const kr = await s.org.addGoal(orgId, { title: 'Paying learners', kind: 'key_result' } as never);
  const before = await projects.create(orgId, { title: 'No PM yet', goalIds: [kr.id], brief: { problem: 'p' } }, `agent:${s.writer.id}`);
  assert.equal(before.project.ownerAgentId, s.writer.id, 'without a PM the proposer leads');
  await s.org.updateMember(orgId, s.editor.id, { title: 'Program Manager' });
  const after = await projects.create(orgId, { title: 'Checkout', goalIds: [kr.id], brief: { problem: 'p' } }, `agent:${s.writer.id}`);
  assert.equal(after.project.ownerAgentId, s.editor.id, 'a roadmap item is owned by the Program Manager');
});

// ---- 4. cross-functional teams ----

test('project teams: the lead proposes a member from another unit, the member\'s own head approves the allocation, the team gets a channel and can be assigned the project\'s tasks; the 100% cap holds', async () => {
  const s = await setup();
  const channels = fakeChannels(s);
  const orgId = await enable(s, 'autonomous');
  // Writer heads Sales with Editor as its report; a PM (a fresh agent) reports to the chief.
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Sales' });
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id, title: 'Account Executive' });
  const pmAgent = await s.agents.create({ name: 'Pat', charter: 'You run programs.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  await s.org.addMember(orgId, { agentId: pmAgent.id, title: 'Program Manager', reportsToAgentId: s.chief.id });
  await s.units.syncMembership(orgId);
  const { projects, teams, tools } = wire(s);
  const kr = await s.org.addGoal(orgId, { title: 'Enterprise pilots', kind: 'key_result' } as never);
  const { project } = await projects.create(orgId, { title: 'Enterprise pilot', goalIds: [kr.id], brief: { problem: 'p', done_when: 'two pilots live' }, appetiteDays: 30 }, `agent:${s.chief.id}`);
  assert.equal(project.ownerAgentId, pmAgent.id);
  const pm = await sessionOf(s, pmAgent.id);
  const pmTools = names(await tools.specsFor(pm));
  for (const t of ['org_project_team', 'org_project_add_member', 'org_project_remove_member', 'org_project_standup']) assert.ok(pmTools.has(t));
  // the PM proposes Editor (Sales) at 60%: a card held by Editor's head, Writer — not the PM's manager
  const out = await tools.execute(pm, 'org_project_add_member', { project: project.key, agent: 'Editor', role: 'account lead', allocation: 60, why: 'pilot customers' });
  assert.match(out, /allocation card [0-9a-f]{8} is with Writer/);
  const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'project_allocation')!;
  assert.equal(card.holder, `agent:${s.writer.id}`, 'routed to the member\'s manager');
  assert.equal((await teams.team(orgId, project.id)).members[0].status, 'pending');
  // the cap counts pending allocations: 60 + 50 > 100
  const other = (await projects.create(orgId, { title: 'Renewals push', goalIds: [kr.id], brief: { problem: 'q' } }, `agent:${s.chief.id}`)).project;
  await assert.rejects(teams.propose(orgId, other.id, { agentId: s.editor.id, allocation: 50 }, `agent:${pmAgent.id}`), /already allocated 60% across projects; 50% more would exceed 100%/);
  // the head decides it as the manager (within its authority in any mode)
  const queue = await s.decisions.describeFor(orgId, `agent:${s.writer.id}`);
  const held = queue.find((d) => d.approval.id === card.id)!;
  assert.ok(held.mayDecide, held.why);
  const writerS = await sessionOf(s, s.writer.id);
  await s.runtime.execute(writerS, 'org_decide', { approvalId: card.id, action: 'approve', reasoning: 'pilots are this quarter\'s bet' });
  const team = await teams.team(orgId, project.id);
  assert.equal(team.members[0].status, 'active');
  assert.equal(team.members[0].homeUnit?.name, "Writer's team", 'the team shows each member\'s home unit');
  assert.ok(team.channel, 'the project channel opened');
  assert.equal(team.channel!.slug, `p-${project.key!.toLowerCase()}`);
  const ch = channels.get(team.channel!.id)!;
  assert.ok(ch.members.some((m) => m.id === s.editor.id) && ch.members.some((m) => m.id === pmAgent.id), 'lead and team are channel members');
  assert.ok((await inbox(s, s.editor.id, 'info')).some((e) => /You joined project/.test(e.title)));
  // the company briefing tells the member its seat and its allocation
  const briefing = new OrgBriefingService(s.db, s.org, s.audit, s.tasks, s.agents, { get: () => undefined } as unknown as ConfigService, undefined, s.units, s.intent, s.runtime);
  const b = await briefing.briefingFor(s.editor.id);
  assert.match(b ?? '', new RegExp(`${project.key} \\(account lead 60%`));
  assert.match(b ?? '', /60% of your time is allocated to project teams/);
  // the PM is offered org_assign and assigns the project's task across units; not a task outside the project, not a non-member
  assert.ok(names(await s.runtime.specsFor(pm)).has('org_assign'));
  const task = await s.tasks.create(orgId, { title: 'Pilot SOW for Acme', createdBy: `agent:${pmAgent.id}`, projectId: project.id });
  assert.match(await s.runtime.execute(pm, 'org_assign', { taskId: task.id, agent: 'Editor' }), /assigned to Editor/);
  const created = await s.runtime.execute(pm, 'org_create_task', { title: 'Pilot kickoff deck', outcome: 'a deck', projectId: project.key, assignee: 'Editor' });
  assert.match(created, /assigned to Editor/);
  const loose = await s.tasks.create(orgId, { title: 'Not a project task', createdBy: 'chief' });
  await assert.rejects(s.runtime.execute(pm, 'org_assign', { taskId: loose.id, agent: 'Editor' }), /for the chief of staff and unit leads/);
  await assert.rejects(s.runtime.execute(pm, 'org_create_task', { title: 'x', outcome: 'x', projectId: project.key, assignee: 'Writer' }), /project's lead \(for its team\)/);
  // standup cadence through the meetings machinery: due → one standup in the project channel with the team
  await teams.setStandup(orgId, project.id, '0 9 * * 1-5', `agent:${pmAgent.id}`);
  const p2 = await s.org.project(orgId, project.id);
  assert.equal(p2.standupCron, '0 9 * * 1-5');
  const due = await teams.dueStandups(await s.org.get(orgId), new Date(Date.parse(p2.standupNextAt!) + 1_000));
  assert.equal(due.length, 1);
  assert.equal(due[0].channelId, team.channel!.id);
  assert.equal(due[0].facilitatorAgentId, pmAgent.id);
  assert.deepEqual(new Set(due[0].attendees.map((a) => a.id)), new Set([pmAgent.id, s.editor.id]));
  assert.match(due[0].agenda, /Editor: .*Pilot SOW for Acme/);
  assert.deepEqual(await teams.dueStandups(await s.org.get(orgId), new Date(Date.parse(p2.standupNextAt!) + 1_000)), [], 'fired once; the next is scheduled');
  // the head releases its report
  assert.match((await teams.remove(orgId, project.id, s.editor.id, `agent:${s.writer.id}`, 'needed back on quota')).note, /left/);
  assert.equal((await teams.team(orgId, project.id)).members.length, 0);
  assert.equal(await teams.allocationOf(orgId, s.editor.id), 0);
});

test('project teams: the member\'s manager adding its own report applies at once; a rejected allocation drops the pending row; only stewards staff a team', async () => {
  const s = await setup();
  const orgId = await enable(s, 'supervised');
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id });
  await s.units.syncMembership(orgId);
  const { projects, teams } = wire(s);
  const kr = await s.org.addGoal(orgId, { title: 'KR', kind: 'key_result' } as never);
  const { project } = await projects.create(orgId, { title: 'Docs revamp', goalIds: [kr.id], brief: { problem: 'p' } }, `agent:${s.writer.id}`);
  const r = await teams.propose(orgId, project.id, { agentId: s.editor.id, role: 'editor', allocation: 40 }, `agent:${s.writer.id}`);
  assert.equal(r.approvalId, null, 'the lead is the member\'s manager: no card');
  assert.equal(r.row.status, 'active');
  // the chief proposes Writer for a project the chief leads: Writer's manager is the chief → at once
  const other = (await projects.create(orgId, { title: 'Brand refresh', goalIds: [kr.id], brief: { problem: 'q' } }, `agent:${s.chief.id}`)).project;
  // Editor proposes itself onto a project it does not lead: refused
  await assert.rejects(teams.propose(orgId, other.id, { agentId: s.editor.id, allocation: 10 }, `agent:${s.editor.id}`), /only the lead of/);
  // a card that is rejected leaves no pending row
  const third = (await projects.create(orgId, { title: 'Pricing page', goalIds: [kr.id], brief: { problem: 'r' } }, `agent:${s.chief.id}`)).project;
  await s.org.updateProject(orgId, third.id, { ownerAgentId: s.chief.id });
  const pmA = await s.agents.create({ name: 'Pia', charter: 'Programs.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  await s.org.addMember(orgId, { agentId: pmA.id, title: 'Program Manager', reportsToAgentId: s.chief.id });
  await s.org.updateProject(orgId, third.id, { ownerAgentId: pmA.id });
  const pend = await teams.propose(orgId, third.id, { agentId: s.editor.id, allocation: 30 }, `agent:${pmA.id}`);
  assert.ok(pend.approvalId);
  await s.approvals.decide(orgId, pend.approvalId!, 'reject', 'Editor is on the docs revamp');
  assert.equal((await teams.team(orgId, third.id)).members.length, 0);
  assert.equal(await teams.allocationOf(orgId, s.editor.id), 40);
});

// ---- 5. blueprints carry projects with teams ----

const BP = {
  format: BLUEPRINT_FORMAT, name: 'Tutor Co', description: 'IELTS tutoring',
  profile: { values: 'learners first', culture: 'async', rules: '' },
  roles: [
    { title: 'Chief of staff', charter: 'You run it.', reportsTo: null, scopes: ['tool:fs_read'], modelTier: 'strong', monthlyUsd: 0 },
    { roleId: 'engineering-manager', title: 'Head of Engineering', charter: '', reportsTo: 'Chief of staff', scopes: ['tool:fs_read'], modelTier: 'strong', monthlyUsd: 0 },
    { roleId: 'engineering-software-engineer', title: 'Software Engineer', charter: '', reportsTo: 'Head of Engineering', scopes: ['tool:fs_read'], modelTier: 'standard', monthlyUsd: 0 },
    { roleId: 'design-manager', title: 'Head of Design', charter: '', reportsTo: 'Chief of staff', scopes: ['tool:fs_read'], modelTier: 'strong', monthlyUsd: 0 },
    { roleId: 'ops-pm', title: 'Program Manager', charter: '', reportsTo: 'Chief of staff', scopes: ['tool:fs_read'], modelTier: 'standard', monthlyUsd: 0 },
  ],
  tunables: {}, playbooks: [], budget: { monthlyUsd: 50 },
  projects: [{
    title: 'Essay feedback MVP', brief: { problem: 'Learners wait days for feedback', hypothesis: 'instant rubric feedback lifts practice', done_when: '100 essays scored', mvp: 'one task type' },
    lead: 'Program Manager', team: [{ title: 'Software Engineer', role: 'engineer', allocation: 60 }, { title: 'Head of Design', role: 'designer', allocation: 30 }],
    krs: ['essays scored per week'], cadence: '0 9 * * 1-5', appetiteDays: 21,
  }],
  origin: { exportedFrom: 'test', at: '', sourceOrgId: '' },
};

test('blueprints: projects with cross-functional teams validate (unknown roles, over-allocation and bad crons refused), plan, and import as Next projects led by the PM with the team allocated', async () => {
  const ok = validateBlueprint(BP);
  assert.equal(ok.projects?.[0].team.length, 2);
  assert.throws(() => validateBlueprint({ ...BP, projects: [{ ...BP.projects[0], lead: 'Nobody' }] }), /unknown role "Nobody"/);
  assert.throws(() => validateBlueprint({ ...BP, projects: [BP.projects[0], { ...BP.projects[0], title: 'Second', team: [{ title: 'Software Engineer', allocation: 50 }] }] }), /more than 100% across the projects/);
  assert.throws(() => validateBlueprint({ ...BP, projects: [{ ...BP.projects[0], cadence: 'daily' }] }), /five-field cron/);
  assert.throws(() => validateBlueprint({ ...BP, projects: [{ ...BP.projects[0], owner: 'x' }] }), /unknown field "owner"/);
  const { projects: noProjects, ...v1 } = BP; void noProjects;
  assert.equal(validateBlueprint(v1).projects, undefined, 'a blueprint without projects is unchanged (backward compatible)');

  const s = await setup();
  const other = await s.workspaces.create({ name: 'Tutor Co' });
  const { projects, teams } = wire(s);
  const blueprints = new OrgBlueprintsService(s.db, s.org, s.mode, s.intent, s.approvals, s.units, s.agents, s.approvals['skills']!, s.workspaces, s.audit, undefined, undefined, projects, teams);
  const plan = await blueprints.importPlan(other.id, BP, { mode: 'autonomous' });
  assert.deepEqual(plan.projects.map((p) => ({ title: p.title, lead: p.lead, team: p.team.length })), [{ title: 'Essay feedback MVP', lead: 'Program Manager', team: 2 }]);
  const res = await blueprints.import(other.id, BP, { mode: 'autonomous' });
  assert.equal(res.projects.length, 1);
  const p = await s.org.project(res.orgId, res.projects[0].projectId);
  assert.equal(p.lane, 'next', 'the CEO bets Now');
  assert.equal(p.status, 'shaped');
  assert.match(p.brief, /Key results to set: essays scored per week/);
  const team = await teams.team(res.orgId, p.id);
  const pmId = (await s.org.members(res.orgId)).find((m) => m.title === 'Program Manager')!.agentId;
  assert.equal(p.ownerAgentId, pmId);
  assert.deepEqual(team.members.map((m) => [m.title, m.role, m.allocation, m.status]).sort(), [['Head of Design', 'designer', 30, 'active'], ['Software Engineer', 'engineer', 60, 'active']]);
  assert.equal(p.standupCron, '0 9 * * 1-5');
  // export carries it back
  const exported = await blueprints.export(res.orgId);
  assert.equal(exported.projects?.[0].lead, 'Program Manager');
  assert.equal(exported.projects?.[0].team.length, 2);
});

test('blueprints, supervised: the projects wait on the staffing card and are created when it is approved', async () => {
  const s = await setup();
  const other = await s.workspaces.create({ name: 'Tutor Co 2' });
  const { projects, teams } = wire(s);
  const blueprints = new OrgBlueprintsService(s.db, s.org, s.mode, s.intent, s.approvals, s.units, s.agents, s.approvals['skills']!, s.workspaces, s.audit, undefined, undefined, projects, teams);
  const res = await blueprints.import(other.id, BP, { mode: 'supervised' });
  assert.equal(res.projects.length, 0);
  assert.equal((await projects.list(res.orgId)).length, 0);
  await s.approvals.decide(res.orgId, res.approvalId!, 'approve', 'go');
  const list = await projects.list(res.orgId);
  assert.deepEqual(list.map((p) => p.title), ['Essay feedback MVP']);
  assert.equal((await teams.team(res.orgId, list[0].id)).members.length, 2);
});

test('the meetings machinery starts a module\'s due meetings: a project standup is asked for on the tick', () => {
  assert.equal(typeof OrgMeetingRuntime.prototype.addDueMeetings, 'function');
});
