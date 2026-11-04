/** The chief of staff's operating system (docs/chief-of-staff.md;
 *  reports/Chief of staff operating model.md): the profile is the input and
 *  every parameter derives from it (pure, within the tunables' bounds); the
 *  `chief.*` tunables sit on the one registry, and the archetype dial is a
 *  proposal for the CEO while the timers are the chief's to tune; the
 *  operating-system state the chief's heartbeat reads (rituals due, overdue
 *  decisions, stale risks, breached handoffs, function owners); the rich
 *  charter and the Chief of Staff pack. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { orgTasks, orgApprovals, orgGoals } from '../server/src/database/schema';
import { CHIEF_PACK_ID, chiefLoops, deriveOperatingSystem, diagnoseProfile, planValue, prepCron, seedArtifacts } from '../server/src/org/chief-os';
import { CHIEF_TUNABLES, proxyLevelOf } from '../server/src/org/chief-tunables';
import { TUNABLES, checkTunable, describeTunables } from '../server/src/org/org-tunables';
import { ruleFor } from '../server/src/org/boundary';
import { roleById } from '../server/src/org/roles/catalog';
import { defaultChiefCharter } from '../server/src/org/org.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgChiefService, describeState } from '../server/src/org/org-chief.service';
import { AUTHORED_PACKS } from '../server/src/market/authored-packs.generated';
import { setup, enable, sessionOf, inbox } from './org-governance-harness';
import { memStorage } from './helpers';
import { ToolsService } from '../server/src/chats/tools.service';
import { RESTRICT_OWN_SKILLS } from '../server/src/chats/turn-loop.service';
import { BUILTIN_SKILLS } from '../server/src/skills/builtin-skills';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgPredictionsService } from '../server/src/org/org-predictions.service';
import { OrgExperimentsService } from '../server/src/org/org-experiments.service';
import { OrgMeetingRuntime, MEETING_TOOL_NAMES } from '../server/src/org/org-meeting-runtime.service';
import { LESSON_TOOL_NAME } from '../server/src/org/org-memory.service';
import type { RunCtx } from '../server/src/org/org-runtime.service';
import { OrgProjectsService } from '../server/src/org/org-projects.service';
import { OrgProjectsTools } from '../server/src/org/org-projects.tools';
import { OrgProjectTeamsService } from '../server/src/org/org-project-teams.service';
import { OrgDataTools } from '../server/src/org/org-data.tools';
import { OrgProgramService } from '../server/src/org/org-program.service';
import { OrgProgramTools } from '../server/src/org/org-program.tools';

/** The work-tracking tools (docs/work-tracking.md) as the org module wires them. */
function projectTools(s: Awaited<ReturnType<typeof setup>>): OrgProjectsTools {
  const projects = new OrgProjectsService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units);
  const teams = new OrgProjectTeamsService(s.org, s.approvals, s.audit, s.agents, s.tasks, projects, new OrgAnnouncer({ announce: async () => undefined }), s.units, s.decisions);
  return new OrgProjectsTools(s.org, projects, s.tasks, s.agents, s.config, s.runtime, s.turns, teams);
}
/** The program-management tools (docs/work-tracking.md "Program management: the matrix"). */
function programTools(s: Awaited<ReturnType<typeof setup>>): OrgProgramTools {
  const projects = new OrgProjectsService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units);
  const teams = new OrgProjectTeamsService(s.org, s.approvals, s.audit, s.agents, s.tasks, projects, new OrgAnnouncer({ announce: async () => undefined }), s.units, s.decisions);
  const program = new OrgProgramService(s.db, s.org, s.audit, s.agents, s.approvals, s.tasks, projects, teams, s.units, s.decisions);
  return new OrgProgramTools(s.org, program, s.agents, s.config, s.runtime, s.turns);
}
/** The company data tools (docs/agent-data-access.md) as the org module wires them. */
function dataTools(s: Awaited<ReturnType<typeof setup>>): OrgDataTools {
  return new OrgDataTools(s.org, s.units, s.tasks, s.meetings, s.approvals, s.agents, s.config, s.workspaces, s.runtime);
}

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

test('the profile is the input: stage and culture type are read from the words (explicit answers win), and every derived value stays inside its bound', () => {
  const early = deriveOperatingSystem({ values: 'ship fast, experiment boldly, iterate', culture: 'terse, async, scrappy', mission: 'A pre-seed prototype for indie writers', size: 3 });
  assert.equal(early.stage, 'early'); assert.match(early.stageWhy, /pre-seed/);
  assert.equal(early.cultureType, 'adhocracy');
  assert.ok(early.speed && early.writing);
  assert.equal(early.archetype, 'generalist');
  assert.equal(planValue(early, 'chief.proxyLevel'), 0);
  assert.equal(planValue(early, 'planning.objectivesPerVision'), 2);
  assert.equal(planValue(early, 'chief.handoffSlaHours'), 8, 'speed-valuing: hours, not days');
  assert.equal(planValue(early, 'chief.sunsetEmptyCycles'), 2);
  assert.equal(early.rituals.find((r) => r.kind === 'standup')!.cron, '30 9 * * 1-5', 'an adhocracy keeps a short daily huddle');
  assert.equal(early.rituals.find((r) => r.kind === 'board')!.cron, '0 9 1-7 * 1', 'early: the leadership meeting is monthly');

  const big = deriveOperatingSystem({ values: 'compliance, reliability and careful process; every approval written down', culture: 'formal monthly reviews, audit trail', size: 120 });
  assert.equal(big.stage, 'scale'); assert.match(big.stageWhy, /120 member/);
  assert.equal(big.cultureType, 'hierarchy');
  assert.ok(big.rigor);
  assert.equal(big.archetype, 'stand-in', 'never brain extension at onboarding: proxy scope is earned');
  assert.equal(planValue(big, 'chief.riskReviewDays'), 7, 'risk register in the foreground');
  assert.equal(planValue(big, 'chief.preReadHours'), 72);
  assert.equal(planValue(big, 'intent.checkInCadenceDays'), 14);
  assert.equal(planValue(big, 'chief.memoFirst'), 1);
  assert.match(big.decisionProtocol, /RAPID/);
  assert.equal(big.rituals.find((r) => r.kind === 'standup')!.cron, null);

  // explicit answers beat the words; a balanced profile falls back to the size
  const told = diagnoseProfile({ values: 'compliance and process', stage: 'growth', cultureType: 'market' });
  assert.equal(told.stage, 'growth'); assert.equal(told.cultureType, 'market'); assert.equal(told.stageWhy, 'the CEO said so');
  const plain = diagnoseProfile({ size: 20 });
  assert.equal(plain.stage, 'growth'); assert.equal(plain.cultureType, 'balanced');
  assert.deepEqual(diagnoseProfile({ values: 'Honesty; ship weekly. Never guess at numbers' }).values, ['Honesty', 'ship weekly', 'Never guess at numbers']);

  // the fence: every derived value is a known tunable within its bound
  for (const plan of [early, big, deriveOperatingSystem({})]) {
    for (const t of plan.tunables) assert.ok(checkTunable(t.key, t.value).ok, `${t.key}=${t.value}`);
  }
});

test('the chief.* tunables register on the one registry with area chief; the archetype dial is a proposal for the CEO (not delegable), the timers are the chief\'s alone', () => {
  for (const key of Object.keys(CHIEF_TUNABLES)) {
    assert.ok(TUNABLES[key], `${key} registered`);
    assert.equal(TUNABLES[key].area, 'chief');
    assert.ok(TUNABLES[key].default >= TUNABLES[key].min && TUNABLES[key].default <= TUNABLES[key].max);
  }
  assert.ok(describeTunables(null).some((t) => t.key === 'chief.handoffSlaHours'));
  const dial = ruleFor({ kind: 'tunable', key: 'chief.proxyLevel' });
  assert.equal(dial.verdict, 'propose'); assert.equal(dial.delegable, false);
  assert.equal(ruleFor({ kind: 'tunable', key: 'chief.handoffSlaHours' }).verdict, 'alone');
  assert.equal(proxyLevelOf({ tunables: JSON.stringify({ 'chief.proxyLevel': 3 }) }), 'brain-extension');
  assert.equal(proxyLevelOf(null), 'conductor');
});

test('org_tune: the chief tunes a timer at once in autonomous mode, but raising its own proxy level is a card for the CEO', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous');
  const chief = await sessionOf(s, s.chief.id);
  assert.match(await s.runtime.execute(chief, 'org_tune', { key: 'chief.handoffSlaHours', value: 12, why: 'the team values speed' }), /chief\.handoffSlaHours set to 12/);
  const card = await s.runtime.execute(chief, 'org_tune', { key: 'chief.proxyLevel', value: 3, why: 'I could do more', recommend: 'approve', alternatives: ['stay a conductor'] });
  assert.match(card, /Not yours to change alone/);
  assert.ok((await s.approvals.pending(orgId)).some((a) => a.kind === 'tune' && JSON.parse(a.payload).key === 'chief.proxyLevel'));
  assert.equal(proxyLevelOf(await s.org.get(orgId)), 'conductor', 'nothing changed');
});

test('loops and the ledger: loop times follow the brief hour and the pre-read deadline; the seed files carry the derivation and never claim a value has a mechanism it lacks', () => {
  assert.equal(prepCron('0 16 * * 5', 24), '0 16 * * 4');
  assert.equal(prepCron('0 9 * * 1', 48), '0 9 * * 5', 'two days before Monday is the weekend: Friday');
  assert.equal(prepCron('0 9 1-7 * 1', 24), '0 14 * * 4', 'not a simple weekly cron: Thursday afternoon');
  const loops = chiefLoops({ briefHour: 8, weeklyReviewCron: '0 16 * * 5', preReadHours: 24 });
  assert.deepEqual(loops.map((l) => l.cron), ['30 7 * * 1-5', '0 16 * * 4', '0 10 1 * *', '0 10 8 3,6,9,12 *']);
  // the pack carries the same loops by name, so a market hire and an onboarding chief run one rhythm
  const pack = AUTHORED_PACKS.find((p) => p.id === CHIEF_PACK_ID)!;
  assert.deepEqual((pack.loops ?? []).map((l) => l.name), loops.map((l) => l.name));
  const plan = deriveOperatingSystem({ values: 'Honesty; ship weekly', culture: 'async, written', size: 4 });
  const files = seedArtifacts(plan, { orgName: 'Letters', vision: 'Be forwarded', values: { 'chief.handoffSlaHours': 8 }, cadences: [{ unit: 'Letters', root: true, kind: 'weekly_review', cron: '0 16 * * 5', enabled: true }], owners: [{ name: 'Mara', title: 'Sales manager' }], date: '2026-11-02' });
  // the calendar is not seeded: OrgLayoutService generates it from the cadences
  assert.deepEqual(files.map((f) => f.path), ['org/operating-system.md', 'org/decisions.md', 'org/risks.md', 'org/scorecard.md', 'org/issues.md', 'org/handoffs.md', 'org/values.md']);
  const byPath = new Map(files.map((f) => [f.path, f.body]));
  assert.match(byPath.get('org/operating-system.md')!, /Stage: \*\*early\*\*/);
  assert.match(byPath.get('org/operating-system.md')!, /chief\.handoffSlaHours` \| 8 \|/);
  assert.match(byPath.get('org/decisions.md')!, /Decider/);
  assert.match(byPath.get('org/scorecard.md')!, /unknown — investigating/);
  assert.match(byPath.get('org/operating-system.md')!, /## Why the root rituals look like this\n\n- Standup: /);
  assert.match(byPath.get('org/handoffs.md')!, /Mara \| 8 h/);
  assert.match(byPath.get('org/values.md')!, /\| Honesty \| none yet \| — \| drift candidate/);
});

test('the charter: mandate, archetype dial, the three tiers and the five failures with their countermeasures; the onboarding charter builds on it', () => {
  const charter = roleById('chief-of-staff')!.charter;
  for (const re of [/time, information and decisions/, /operating system/, /chief\.proxyLevel/, /What you do alone/, /What you propose/, /What you never do/, /Gatekeeping/, /Second CEO/, /Owner of every ritual/, /unknown — investigating/, /Status theatre/, /manager/]) assert.match(charter, re);
  const full = defaultChiefCharter('Letters', 'A weekly letter', { values: 'honesty' });
  assert.match(full, /chief of staff of Letters/);
  assert.match(full, /Mission: A weekly letter/);
  assert.match(full, /What the company values: honesty/);
  assert.match(full, /Intent flows down as a cascade/);
});

test('the Chief of Staff pack: Business category, deep skills that name only org tools that exist, and function work routed to managers', async () => {
  const pack = OrgApprovalsService.catalogItem(CHIEF_PACK_ID)!;
  assert.ok(pack); assert.equal(pack.cat, 'Business'); assert.equal(pack.role, 'Chief of staff');
  const names = pack.skills!.map((s) => s.name);
  for (const n of ['operating-system-setup', 'annual-planning', 'quarterly-planning', 'weekly-business-review', 'exec-meeting-prep', 'decision-log-hygiene', 'ceo-daily-brief', 'handoff-sla-monitor', 'risk-register', 'values-mechanism-audit', 'ritual-retirement-review', 'investor-update', 'reorg-proposal', 'function-reports-intake']) assert.ok(names.includes(n), n);
  for (const s of pack.skills!) assert.ok((s.instructions ?? '').length > 800, `${s.name} is step-by-step`);
  // every org_* / meeting_* tool a skill names is one the server offers
  const s = await setup();
  await enable(s, 'autonomous');
  const offered = new Set<string>();
  for (const spec of await s.runtime.specsFor(await sessionOf(s, s.chief.id))) offered.add(spec.name);
  for (const spec of await projectTools(s).specsFor(await sessionOf(s, s.chief.id))) offered.add(spec.name);
  for (const spec of await dataTools(s).specsFor(await sessionOf(s, s.chief.id))) offered.add(spec.name);
  for (const spec of await programTools(s).specsFor(await sessionOf(s, s.chief.id))) offered.add(spec.name);
  const known = new Set([...offered, 'org_set_cadence', 'org_decisions', 'org_recall', 'org_playbooks', 'org_write_playbook', 'org_capacity', 'org_eval_role', 'org_metric_sources', 'org_metric_read', 'org_incidents', 'org_propose_experiment', 'org_experiments', 'org_run_checks', 'org_calibration', 'org_eval_cases', 'org_report_incident']);
  const named = new Set(pack.skills!.flatMap((x) => (x.instructions ?? '').match(/\borg_[a-z_]+\b/g) ?? []));
  for (const n of named) assert.ok(known.has(n), `${n} exists`);
  const all = pack.skills!.map((x) => x.instructions).join('\n');
  assert.match(all, /function manager/);
  assert.match(all, /\/org\/<function>\/reports\//, 'the heads\' weekly reports are read');
  assert.match(all, /Review the heads' own staffing; do not redo it/, 'the heads hire into their own units and the chief reviews (decision 1)');
  assert.doesNotMatch(all, /a head never hires/);
  assert.match(all, /unknown — investigating/);
  assert.match(all, /\/org\/decisions\.md/);
});

test('operating-system state: rituals within the lookahead with their pre-read deadline, overdue decision cards, stale risks, breached cross-unit handoffs, function owners; the heartbeat wakes the chief only for a new breach', async () => {
  const s = await setup();
  const orgId = await enable(s, 'supervised');
  // a unit: the editor reports to the writer, who becomes a lead
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id });
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Sales' });
  await s.units.syncMembership(orgId);
  await s.meetings.ensureCadenceDefaults(orgId);
  const chiefSvc = new OrgChiefService(s.org, s.tasks, s.approvals, s.agents, s.units, s.meetings, s.signals);
  const root = await s.units.rootUnit(orgId);
  const sales = (await s.units.units(orgId)).find((u) => u.leadAgentId === s.writer.id)!;
  assert.ok(sales, 'the writer leads a unit');

  // a handoff: the editor (sales) asks for something that sits on the company board
  const t = await s.tasks.create(orgId, { title: 'Price sheet for the launch', brief: { outcome: 'a price sheet', done_when: 'sheet exists' }, status: 'todo', createdBy: `agent:${s.editor.id}`, unitId: root.id });
  await s.db.update(orgTasks).set({ updatedAt: ago(30) }).where(eq(orgTasks.id, t.id));
  // a task inside its own unit is not a handoff
  const own = await s.tasks.create(orgId, { title: 'Call list', status: 'todo', createdBy: `agent:${s.editor.id}`, unitId: sales.id });
  await s.db.update(orgTasks).set({ updatedAt: ago(30) }).where(eq(orgTasks.id, own.id));
  // the head files a hire case for the chief as a backlog task (the business catalog's manage-team playbook)
  const hireCase = await s.tasks.create(orgId, { title: 'Hire case: role:sales-sdr', brief: { outcome: 'decide the hire', done_when: 'decided' }, status: 'backlog', createdBy: `agent:${s.writer.id}` });
  // a card the CEO has not answered for two days
  const card = await s.approvals.create(orgId, { kind: 'escalation', payload: {}, requestedBy: 'chief', recommendation: 'Decide the launch date' });
  await s.db.update(orgApprovals).set({ createdAt: ago(50) }).where(eq(orgApprovals.id, card.id));
  // an at-risk key result nobody checked in on for three weeks
  const objective = await s.org.addGoal(orgId, { title: 'Launch', kind: 'objective' });
  const kr = await s.org.addGoal(orgId, { title: 'Ten paying customers', kind: 'key_result', parentGoalId: objective.id, ownerAgentId: s.writer.id });
  await s.db.update(orgGoals).set({ atRisk: 1, lastCheckInAt: ago(21 * 24), createdAt: ago(30 * 24) }).where(eq(orgGoals.id, kr.id));

  const st = await chiefSvc.state(orgId);
  assert.equal(st.breachedHandoffs.length, 1);
  assert.equal(st.breachedHandoffs[0].taskId, t.id);
  assert.match(st.breachedHandoffs[0].from, /Editor \(.*\)/);
  assert.ok(st.breachedHandoffs[0].waitedHours >= 29);
  assert.deepEqual(st.overdueDecisions.map((d) => d.id), [card.id]);
  assert.ok(st.overdueDecisions[0].waitedHours >= 49);
  assert.ok(st.staleRisks.some((r) => r.ref === `goal:${kr.id}` && r.staleDays >= 20));
  assert.ok(st.functionOwners.some((o) => o.name === 'Writer' && o.title === 'Head of Sales'));
  assert.deepEqual(st.headRequests.map((r) => r.taskId), [hireCase.id], 'the head\'s hire case waits in the chief\'s backlog');
  // rituals: a two-week lookahead holds the weekly ones, each with its pre-read deadline before it
  await s.org.setTunable(orgId, 'chief.ritualLookaheadHours', 336, { actor: 'user' });
  const wide = await chiefSvc.state(orgId);
  assert.ok(wide.rituals.some((r) => r.kind === 'weekly_review') && wide.rituals.some((r) => r.kind === 'board'));
  assert.ok(wide.rituals.every((r) => Date.parse(r.at) - Date.parse(r.preReadDue) === 48 * 3_600_000));
  await s.org.setTunable(orgId, 'chief.preReadHours', 24, { actor: 'user' });
  assert.ok((await chiefSvc.state(orgId)).rituals.every((r) => Date.parse(r.at) - Date.parse(r.preReadDue) === 24 * 3_600_000));

  // the SLA is a tunable: 48 h clears the 30 h wait
  await s.org.setTunable(orgId, 'chief.handoffSlaHours', 48, { actor: 'user' });
  assert.equal((await chiefSvc.state(orgId)).breachedHandoffs.length, 0);
  await s.org.setTunable(orgId, 'chief.handoffSlaHours', 24, { actor: 'user' });

  // the heartbeat: context for the chief only; a reason only for a breach since the last beat
  const ctx = await chiefSvc.heartbeatContext(s.chief.id, new Date());
  assert.match(ctx!, /Operating system of/);
  assert.match(ctx!, /Breached handoffs/);
  assert.match(ctx!, /Decisions waiting on the CEO/);
  assert.match(ctx!, /Function owners/);
  assert.match(ctx!, /Requests from function heads/);
  assert.match(ctx!, /\/org\/<function>\/reports\//);
  assert.equal(await chiefSvc.heartbeatContext(s.writer.id, new Date()), null, 'only the chief reads the operating system');
  assert.equal((await chiefSvc.heartbeatReasons(s.chief.id, new Date(), null)).length, 1);
  assert.match((await chiefSvc.heartbeatReasons(s.chief.id, new Date(), null))[0], /handoff-sla-monitor/);
  assert.equal((await chiefSvc.heartbeatReasons(s.chief.id, new Date(), new Date().toISOString())).length, 0, 'already seen at the last beat');
  assert.deepEqual(await chiefSvc.heartbeatReasons(s.writer.id, new Date(), null), []);
  assert.match(describeState({ orgId, orgName: 'X', proxyLevel: 'conductor', rituals: [], overdueDecisions: [], staleRisks: [], breachedHandoffs: [], functionOwners: [], headRequests: [] }), /Nothing overdue/);
});

/** Every org_* / fs_* / meeting_* tool named in a business skill, offered to
 *  the role that runs it (docs/autonomous-skills-review.md): the chief (any
 *  session), a function head (a unit lead, in its loops and task runs, and
 *  as a reviewer or in a meeting), a specialist (a member: loops, heartbeat,
 *  task and reviewer runs, meetings) and the Auditor (its restricted run). */
test('every tool a business skill names exists and is offered to the role that runs it', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous');
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id });
  await s.units.syncMembership(orgId);
  const auditorAgent = await s.agents.create({ name: 'Auditor', provider: 'openai', model: 'gpt-5' });
  await s.org.addMember(orgId, { agentId: auditorAgent.id, reportsToAgentId: s.chief.id, scopes: [] });
  const announcer = new OrgAnnouncer({ announce: async () => undefined });
  const predictions = new OrgPredictionsService(s.db, s.org, s.audit, s.tasks, s.agents, s.config, s.turns, s.runtime, s.intent, s.units, s.brief);
  const experiments = new OrgExperimentsService(s.db, s.org, s.audit, s.approvals, s.agents, s.workspaces, s.config, s.turns, s.runtime, s.units, s.meetings, s.playbooks, s.capital, s.incidents, s.brief, predictions, undefined, announcer);
  const meetingRuntime = new OrgMeetingRuntime(s.db, s.meetings, s.org, s.units, s.audit, s.agents, s.workspaces, s.turns, s.repo, s.runtime, s.config, announcer, s.approvals);
  const providers = [s.runtime, s.memory, s.sensing, s.incidents, s.tools, predictions, experiments, meetingRuntime, projectTools(s), programTools(s), dataTools(s)];
  const fsTools = new ToolsService(memStorage().stub).specs().map((t) => t.name).filter((n) => n.startsWith('fs_'));
  const offered = async (session: Awaited<ReturnType<typeof sessionOf>>): Promise<Set<string>> => {
    const names = new Set<string>(fsTools);
    for (const p of providers) for (const t of await p.specsFor(session)) names.add(t.name);
    const restrict = await s.runtime.restrictTo(session);
    return restrict ? new Set([...names].filter((n) => restrict.has(n))) : names;
  };
  const ctxFor = (session: { id: string }, agentId: string, extra: Partial<RunCtx>): RunCtx => ({ orgId, taskId: '', agentId, runId: `t-${session.id}`, sessionId: session.id, isChief: false, reviewer: false, progress: false, calls: new Map(), loopDetected: false, ...extra });
  /** The union of what a member is offered across the session kinds it runs in. */
  const across = async (agentId: string): Promise<Set<string>> => {
    const all = new Set<string>([...MEETING_TOOL_NAMES, LESSON_TOOL_NAME]);
    const loop = await sessionOf(s, agentId);
    for (const n of await offered(loop)) all.add(n);
    const review = await sessionOf(s, agentId);
    s.runtime.beginAuxRun(ctxFor(review, agentId, { reviewer: true }));
    for (const n of await offered(review)) all.add(n);
    s.runtime.endAuxRun(review.id);
    return all;
  };
  const chief = await offered(await sessionOf(s, s.chief.id));
  const head = await across(s.writer.id);
  const specialist = await across(s.editor.id);
  // a Program Manager leading a project with an active team (docs/work-tracking.md "Project teams")
  const pmAgent = await s.agents.create({ name: 'Pat', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  await s.org.addMember(orgId, { agentId: pmAgent.id, title: 'Program Manager', reportsToAgentId: s.chief.id, scopes: [] });
  const pmProject = await s.org.addProject(orgId, { title: 'Pilot', ownerAgentId: pmAgent.id, lane: 'now', status: 'active' });
  await s.org.addProjectMember(orgId, { projectId: pmProject.id, agentId: s.editor.id, allocation: 30, status: 'active', addedBy: 'user' });
  const pm = await across(pmAgent.id);
  assert.ok(pm.has('org_assign') && !pm.has('org_hire_agent'), 'a PM assigns its team, hires no one');
  const auditSession = await sessionOf(s, auditorAgent.id);
  s.runtime.beginAuxRun(ctxFor(auditSession, auditorAgent.id, { audit: { findings: [], summary: '', closed: false, material: '' } }));
  const auditor = await offered(auditSession);
  s.runtime.endAuxRun(auditSession.id);

  // the boundary the catalog states: a head staffs its own unit (hire, pause, re-tool its reports) but
  // never gets the chief's other structure tools; the auditor never writes
  for (const t of ['org_terminate_agent', 'org_set_scope', 'org_reorg', 'org_allocate_budget', 'org_set_routing', 'org_report', 'org_audit_finding']) assert.ok(!head.has(t), `a head has no ${t}`);
  for (const t of ['org_hire_agent', 'org_pause_agent', 'org_update_member']) assert.ok(head.has(t), `a head manages its own reports with ${t}`);
  for (const t of ['org_task_update', 'org_task_comment', 'org_request_review', 'org_escalate', 'org_set_key_result', 'org_set_cadence']) assert.ok(head.has(t), `a head has ${t} in its loops`);
  for (const t of ['org_task_update', 'org_request_review', 'org_task_comment', 'org_escalate', 'org_costs', 'org_forecast']) assert.ok(specialist.has(t), `a specialist has ${t} (its task, the chain up, the spend reads)`);
  for (const t of ['org_set_goal', 'org_assign', 'org_propose_experiment', 'org_hire_agent', 'org_pause_agent', 'org_update_member', 'org_allocate_budget', 'org_set_routing']) assert.ok(!specialist.has(t), `a specialist has no ${t}`);
  for (const t of ['org_audit_finding', 'org_audit_close', 'fs_read', 'org_metric_read', 'org_decisions', 'org_intent']) assert.ok(auditor.has(t), `the auditor reads with ${t}`);
  for (const t of ['fs_write', 'fs_edit', 'org_create_task', 'org_message', 'org_task_comment']) assert.ok(!auditor.has(t), `the auditor's run never offers ${t}`);

  const roleOf = (id: string): { role: string; set: Set<string> } => id === CHIEF_PACK_ID ? { role: 'chief', set: chief } : id === 'pack-auditor' ? { role: 'auditor', set: auditor } : id === 'pack-biz-ops-pm' ? { role: 'program manager', set: pm } : id.endsWith('-manager') ? { role: 'head', set: head } : { role: 'specialist', set: specialist };
  // "org_audit_query action meeting_risk" names an audit action, not a tool
  const toolsNamed = (text: string): string[] => [...new Set(text.replace(/\baction\s+[a-z_]+/g, '').match(/\b(?:org|fs|meeting)_[a-z_]+\b/g) ?? [])];
  const packs = AUTHORED_PACKS.filter((p) => p.id.startsWith('pack-biz-') || p.id === CHIEF_PACK_ID || p.id === 'pack-auditor');
  assert.ok(packs.length >= 54, `${packs.length} business packs`);
  const missing: string[] = [];
  for (const p of packs) {
    const { role, set } = roleOf(p.id);
    for (const sk of p.skills ?? []) for (const t of toolsNamed(sk.instructions ?? '')) if (!set.has(t)) missing.push(`${p.id} ${sk.name}: ${t} (${role})`);
    for (const l of p.loops ?? []) for (const t of toolsNamed(l.prompt ?? '')) if (!set.has(t)) missing.push(`${p.id} loop ${l.name}: ${t} (${role})`);
  }
  // the cross-cutting org playbooks every member carries: a head runs all three
  for (const b of BUILTIN_SKILLS.filter((x) => x.name.startsWith('org-'))) for (const t of toolsNamed(b.instructions)) if (!head.has(t)) missing.push(`builtin ${b.name}: ${t}`);
  assert.deepEqual(missing, []);
  // a head escalates from its loops only what is its unit's (to the CEO when it says so)
  const writerLoop = await sessionOf(s, s.writer.id);
  const ours = await s.tasks.create(orgId, { title: 'Pick the launch date', createdBy: `agent:${s.writer.id}`, assigneeAgentId: s.editor.id });
  assert.match(await s.runtime.execute(writerLoop, 'org_escalate', { taskId: ours.id, reason: 'needs the CEO', to: 'ceo' }), /escalated toward the CEO: the card goes to Chief first/);
  const theirs = await s.tasks.create(orgId, { title: 'Company offsite', createdBy: 'chief' });
  await assert.rejects(s.runtime.execute(writerLoop, 'org_escalate', { taskId: theirs.id, reason: 'x' }), /your unit's board/);
  // a head sees its reports' incidents (it runs their postmortems); a member only its own
  await s.incidents.report(orgId, { title: 'Draft sent to the wrong list', detail: 'x', severity: 'minor', agentId: s.editor.id }, { detectedBy: 'owner' });
  assert.match(await s.incidents.execute(writerLoop, 'org_incidents', {}), /Draft sent to the wrong list/);
  assert.match(await s.incidents.execute(await sessionOf(s, auditorAgent.id), 'org_incidents', {}), /No incidents about you\./);
  // the auditor's playbooks load inside its read-only run
  s.runtime.beginAuxRun(ctxFor(auditSession, auditorAgent.id, { audit: { findings: [], summary: '', closed: false, material: '' } }));
  assert.ok((await s.runtime.restrictTo(auditSession))!.has(RESTRICT_OWN_SKILLS));
  s.runtime.endAuxRun(auditSession.id);
});

test('the business skill set closes its loops: the chief sweeps blocks and reviews the workforce, learning and files; heads agree handoffs, onboard hires and file assurance requests; the auditor reconciles the ledger', () => {
  const chief = AUTHORED_PACKS.find((p) => p.id === CHIEF_PACK_ID)!;
  const names = chief.skills!.map((x) => x.name);
  for (const n of ['escalation-and-blocker-sweep', 'member-lifecycle-review', 'learning-loop-review', 'org-files-hygiene']) assert.ok(names.includes(n), n);
  const loops = chiefLoops({ briefHour: 8, weeklyReviewCron: '0 16 * * 5', preReadHours: 24 });
  // every playbook a chief loop names is one the pack carries, and the pack's loops say the same
  for (const l of [...loops, ...(chief.loops ?? [])]) for (const m of l.prompt.match(/\b[a-z]+(?:-[a-z]+)+\b/g) ?? []) if (/-(review|brief|sweep|audit|intake|hygiene|planning|monitor|register|prep)$/.test(m)) assert.ok(names.includes(m), `${l.name} names ${m}`);
  assert.deepEqual((chief.loops ?? []).map((l) => l.prompt), loops.map((l) => l.prompt), 'the pack and onboarding run one rhythm');
  for (const h of AUTHORED_PACKS.filter((p) => /^pack-biz-.+-manager$/.test(p.id))) {
    const fn = h.id.replace(/^pack-biz-/, '').replace(/-manager$/, '');
    const body = (n: string) => h.skills!.find((x) => x.name === `${fn}-${n}`)!.instructions;
    assert.match(body('okr-planning'), /\/org\/handoffs\.md/, `${h.id} agrees its dependencies`);
    assert.match(body('weekly-review'), /\/org\/handoffs\.md/, `${h.id} answers handoffs`);
    assert.match(body('team-management'), /Onboard every new member/, `${h.id} onboards`);
    assert.match(body('team-management'), /Staff the unit yourself.*org_hire_agent.*org_pause_agent.*org_update_member/, `${h.id} hires and pauses in its own unit (decision 1)`);
    assert.doesNotMatch(body('team-management'), /Never call hire or pause tools yourself/);
    assert.match(body('kpi-audit'), /Assurance request:/, `${h.id} files assurance requests the auditor can find`);
  }
  const auditor = AUTHORED_PACKS.find((p) => p.id === 'pack-auditor')!;
  assert.ok(auditor.skills!.some((x) => x.name === 'audit-ledger-and-metrics' && /Assurance request:/.test(x.instructions)));
  assert.ok(auditor.skills!.some((x) => x.name === 'audit-values-and-culture'));
  for (const n of ['org-member-workflow', 'org-member-onboarding', 'org-unit-retro']) assert.ok(BUILTIN_SKILLS.some((b) => b.name === n), `builtin ${n}`);
  // decision 2: FP&A reads spend live; decision 4: the member workflow escalates one step up the chain
  const fpa = AUTHORED_PACKS.find((p) => p.id === 'pack-biz-finance-fpa')!.skills!.map((x) => x.instructions).join('\n');
  assert.match(fpa, /org_costs/); assert.match(fpa, /org_forecast/);
  const workflow = BUILTIN_SKILLS.find((b) => b.name === 'org-member-workflow')!.instructions;
  assert.match(workflow, /A specialist escalates to its head, never past it/);
  assert.match(workflow, /to: "ceo"/);
});

// ---- the CEO's decisions (docs/autonomous-skills-review.md §4) ----

/** A company where Writer heads Sales (title "Head of Sales") with Editor reporting to it. */
async function salesCompany(modeName: 'supervised' | 'autonomous') {
  const s = await setup();
  const orgId = await enable(s, modeName);
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Sales' });
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id });
  await s.units.syncMembership(orgId);
  return { s, orgId, head: await sessionOf(s, s.writer.id), specialist: await sessionOf(s, s.editor.id), chief: await sessionOf(s, s.chief.id) };
}

test('decision 1: a function head hires into its own unit through the boundary (actor = the head, the chief told); outside its line, another function, a head role, the cap and its unit envelope are refused', async () => {
  const { s, orgId, head, specialist } = await salesCompany('autonomous');
  assert.deepEqual(await s.runtime.headOf(orgId, s.writer.id).then((h) => h && { fn: h.fn, lead: Boolean(h.unit) }), { fn: 'sales', lead: true });
  assert.equal(await s.runtime.headOf(orgId, s.editor.id), null, 'a specialist is no head');
  assert.equal(await s.runtime.headOf(orgId, s.chief.id), null, 'the chief has the company set');
  // within its subtree: hired at once, the head is the actor, the boundary was asked, the chief is told
  const out = await s.runtime.execute(head, 'org_hire_agent', { templateOrPack: 'role:sales-sdr', title: 'SDR', why: 'inbound leads wait a day' });
  assert.match(out, /Hired SDR \(SDR\) at depth 3, reporting to you\..*the chief of staff is told/);
  const sdr = (await s.org.members(orgId)).find((m) => m.title === 'SDR')!;
  assert.equal(sdr.reportsToAgentId, s.writer.id);
  const auto = (await s.audit.list(orgId, { action: 'auto_hire' }))[0];
  assert.equal(auto.actor, `agent:${s.writer.id}`);
  assert.ok(s.checks.some((c) => c.change.kind === 'hire' && c.actor === `agent:${s.writer.id}`), 'routed through the boundary as the head');
  assert.ok((await inbox(s, s.chief.id, 'info')).some((e) => /Writer \(head\) — autonomous hire: SDR as SDR/.test(e.title)), 'the chief is told');
  assert.ok((await s.tasks.messages(orgId)).some((m) => m.fromAgentId === s.writer.id && /autonomous hire/.test(m.text)), 'and the group log names it');
  // the head re-tools and pauses its own reports; the chief is told of the pause
  assert.match(await s.runtime.execute(head, 'org_update_member', { agent: 'Editor', emoji: '✍️', why: 'a clearer face' }), /Updated Editor: identity/);
  assert.match(await s.runtime.execute(head, 'org_pause_agent', { agent: 'SDR', why: 'no leads this week' }), /is paused.*the chief of staff is told/);
  assert.ok((await inbox(s, s.chief.id, 'info')).some((e) => /Writer \(head\) paused SDR/.test(e.title)));
  await assert.rejects(s.runtime.execute(head, 'org_pause_agent', { agent: 'Chief' }), /not in your reporting line/);
  // outside its reporting line, another function's role, another head, the auditor
  await assert.rejects(s.runtime.execute(head, 'org_hire_agent', { templateOrPack: 'role:sales-account-executive', title: 'AE', reportsTo: 'Chief', why: 'x' }), /outside your reporting line/);
  await assert.rejects(s.runtime.execute(head, 'org_hire_agent', { templateOrPack: 'role:marketing-content', title: 'Writer 2', why: 'x' }), /belongs to another function.*role:sales-sdr/);
  await assert.rejects(s.runtime.execute(head, 'org_hire_agent', { templateOrPack: 'role:finance-manager', title: 'CFO', why: 'x' }), /not other heads/);
  await assert.rejects(s.runtime.execute(head, 'org_hire_agent', { templateOrPack: 'role:auditor', title: 'Auditor', why: 'x' }), /never by a function it audits/);
  // a specialist cannot hire or pause
  await assert.rejects(s.runtime.execute(specialist, 'org_hire_agent', { templateOrPack: 'role:sales-sdr', title: 'SDR 2', why: 'x' }), /for the chief of staff and function heads/);
  await assert.rejects(s.runtime.execute(specialist, 'org_pause_agent', { agent: 'SDR' }), /for the chief of staff and function heads/);
  // the unit's envelope: the allocations to its objectives bound its agent envelopes
  const unit = (await s.units.isLead(orgId, s.writer.id))!;
  const objective = await s.units.addGoal(orgId, { title: 'Fill the pipeline', unitId: unit.id });
  await s.org.setAllocation(orgId, { goalId: objective.id, monthlyUsd: 5 });
  await assert.rejects(s.runtime.execute(head, 'org_hire_agent', { templateOrPack: 'role:sales-engineer', title: 'SE', monthlyBudgetUsd: 8, why: 'demos' }), /above its envelope of \$5\.00/);
  assert.match(await s.runtime.execute(head, 'org_hire_agent', { templateOrPack: 'role:sales-engineer', title: 'SE', monthlyBudgetUsd: 4, why: 'demos' }), /Hired SE/);
  // the agent cap
  const live = await s.org.liveMemberCount(orgId);
  await s.mode.setMode(s.ws.id, { mode: 'autonomous', chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: live });
  await assert.rejects(s.runtime.execute(head, 'org_hire_agent', { templateOrPack: 'role:sales-account-executive', title: 'AE', why: 'deals' }), /agent cap is \d+/);
});

test('decision 1, supervised: a head\'s hire is a card for the CEO requested by the head, its scopes met with the head\'s own holdings', async () => {
  const { s, orgId, head } = await salesCompany('supervised');
  await s.org.setScopes(orgId, s.writer.id, ['tool:fs_read'], { actor: 'user', force: true });
  const out = await s.runtime.execute(head, 'org_hire_agent', { templateOrPack: 'role:sales-sdr', title: 'SDR', scopes: ['tool:fs_read', 'tool:fs_write'], why: 'inbound leads wait' });
  assert.match(out, /Hire proposed \(approval [0-9a-f]{8}\).*the chief of staff is told/);
  const [card] = (await s.approvals.pending(orgId)).filter((a) => a.kind === 'hire');
  assert.equal(card.requestedBy, `agent:${s.writer.id}`);
  const payload = JSON.parse(card.payload) as { grantorAgentId?: string; scopes: string[]; reportsToAgentId: string };
  assert.equal(payload.grantorAgentId, s.writer.id);
  assert.equal(payload.reportsToAgentId, s.writer.id);
  assert.ok(!payload.scopes.includes('tool:fs_write'), 'a head never grants what it does not hold');
  assert.ok((await s.tasks.messages(orgId)).some((m) => m.fromAgentId === s.writer.id && /proposed a hire/.test(m.text)), 'the chief sees it in the group log (and the card in its inbox)');
  const { result } = await s.approvals.decide(orgId, card.id, 'approve', 'go');
  const hired = (await s.org.member(orgId, String(result!.agentId)))!;
  assert.equal(hired.reportsToAgentId, s.writer.id);
  assert.ok(!s.org.scopesOf(hired).includes('tool:fs_write'));
});

test('decision 4: the escalation chain — a specialist raises to its head (a board task, no CEO card), a head to the chief by default or to the CEO when it says so', async () => {
  const { s, orgId, head, specialist } = await salesCompany('autonomous');
  const cards = async () => (await s.db.select().from(orgApprovals).where(eq(orgApprovals.orgId, orgId))).filter((a) => a.kind === 'escalation').length;
  const mine = await s.tasks.create(orgId, { title: 'Quote for Acme', createdBy: `agent:${s.writer.id}`, assigneeAgentId: s.editor.id });
  const out = await s.runtime.execute(specialist, 'org_escalate', { taskId: mine.id, reason: 'Acme asks for 30% off — above my authority' });
  assert.match(out, /escalated to your head, Writer: escalation task [A-Z][A-Z0-9]{1,5}-\d+ is on its board/);
  assert.equal((await s.tasks.get(orgId, mine.id)).status, 'blocked');
  const [esc] = (await s.tasks.list(orgId)).filter((t) => t.parentTaskId === mine.id);
  assert.equal(esc.assigneeAgentId, s.writer.id);
  assert.match(esc.title, /^Escalation: [A-Z][A-Z0-9]{1,5}-\d+ Quote for Acme/);
  assert.equal(await cards(), 0, 'no card for the CEO');
  // a repeat joins the open escalation
  assert.match(await s.runtime.execute(specialist, 'org_escalate', { taskId: mine.id, reason: 'still waiting' }), /added to its open escalation/);
  assert.equal((await s.tasks.list(orgId)).filter((t) => t.parentTaskId === mine.id).length, 1);
  // a specialist cannot skip its head
  await assert.rejects(s.runtime.execute(specialist, 'org_escalate', { taskId: mine.id, reason: 'x', to: 'ceo' }), /escalates to its head/);
  // the head: to the chief by default …
  const theirs = await s.tasks.create(orgId, { title: 'Discount policy', createdBy: `agent:${s.writer.id}`, assigneeAgentId: s.writer.id });
  assert.match(await s.runtime.execute(head, 'org_escalate', { taskId: theirs.id, reason: 'we need a discount policy' }), /escalated to the chief of staff \(Chief\)/);
  const [toChief] = (await s.tasks.list(orgId)).filter((t) => t.parentTaskId === theirs.id);
  assert.equal(toChief.assigneeAgentId, s.chief.id);
  assert.equal(await cards(), 0);
  // … or to the CEO, a decision card
  assert.match(await s.runtime.execute(head, 'org_escalate', { taskId: theirs.id, reason: 'a 30% discount commits the company', to: 'ceo' }), /escalated toward the CEO: the card goes to Chief first/);
  assert.equal(await cards(), 1);
  // decision routing (docs/owners-seat.md §7): the card is with the chief first, CEO-reserved
  const [card] = (await s.db.select().from(orgApprovals).where(eq(orgApprovals.orgId, orgId))).filter((a) => a.kind === 'escalation');
  assert.equal(card.holder, `agent:${s.chief.id}`);
  assert.match(card.reserved, /only the CEO/);
  await assert.rejects(s.runtime.execute(head, 'org_escalate', { taskId: theirs.id, reason: 'x', to: 'board' }), /to must be "chief" or "ceo"/);
});

test('org_roles: the chief and a function head search the role catalog instead of a dumped list; specialists do not get it', async () => {
  const { s, head, specialist, chief } = await salesCompany('autonomous');
  const names = async (sess: Awaited<ReturnType<typeof sessionOf>>) => new Set((await s.runtime.specsFor(sess)).map((t) => t.name));
  assert.ok((await names(chief)).has('org_roles'), 'the chief searches the catalog');
  assert.ok((await names(head)).has('org_roles'), 'a head hires too');
  assert.ok(!(await names(specialist)).has('org_roles'), 'a specialist does not hire');
  const finance = await s.runtime.execute(chief, 'org_roles', { q: 'finance' });
  assert.match(finance, /role:finance-manager/);
  assert.doesNotMatch(finance, /role:sales-sdr/);
  const heads = await s.runtime.execute(chief, 'org_roles', { managers: true, limit: 40 });
  for (const line of heads.split('\n').filter((l) => l.startsWith('- role:'))) assert.match(line, /^- role:[a-z-]+-manager /);
  assert.match(await s.runtime.execute(chief, 'org_roles', { reportsTo: 'sales-manager' }), /role:sales-/);
  assert.match(await s.runtime.execute(chief, 'org_roles', { q: 'zzzz-nothing' }), /No role matches/);
});
