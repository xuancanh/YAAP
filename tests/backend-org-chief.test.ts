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
import { setup, enable, sessionOf } from './org-governance-harness';
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
  assert.deepEqual(files.map((f) => f.path), ['org/operating-system.md', 'org/decisions.md', 'org/risks.md', 'org/scorecard.md', 'org/calendar.md', 'org/issues.md', 'org/handoffs.md', 'org/values.md']);
  const byPath = new Map(files.map((f) => [f.path, f.body]));
  assert.match(byPath.get('org/operating-system.md')!, /Stage: \*\*early\*\*/);
  assert.match(byPath.get('org/operating-system.md')!, /chief\.handoffSlaHours` \| 8 \|/);
  assert.match(byPath.get('org/decisions.md')!, /Decider/);
  assert.match(byPath.get('org/scorecard.md')!, /unknown — investigating/);
  assert.match(byPath.get('org/calendar.md')!, /CEO \(the chief keeps the record\)/, 'the chief never owns the ritual');
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
  const known = new Set([...offered, 'org_set_cadence', 'org_decisions', 'org_recall', 'org_playbooks', 'org_write_playbook', 'org_capacity', 'org_eval_role', 'org_metric_sources', 'org_metric_read', 'org_incidents', 'org_propose_experiment', 'org_experiments', 'org_run_checks', 'org_calibration', 'org_eval_cases', 'org_report_incident']);
  const named = new Set(pack.skills!.flatMap((x) => (x.instructions ?? '').match(/\borg_[a-z_]+\b/g) ?? []));
  for (const n of named) assert.ok(known.has(n), `${n} exists`);
  const all = pack.skills!.map((x) => x.instructions).join('\n');
  assert.match(all, /function manager/);
  assert.match(all, /\/org\/<function>\/reports\//, 'the heads\' weekly reports are read');
  assert.match(all, /role:<fn>-<specialist>/, 'the heads\' hire cases are decided through the hire path');
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
  const providers = [s.runtime, s.memory, s.sensing, s.incidents, s.tools, predictions, experiments, meetingRuntime];
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
  const auditSession = await sessionOf(s, auditorAgent.id);
  s.runtime.beginAuxRun(ctxFor(auditSession, auditorAgent.id, { audit: { findings: [], summary: '', closed: false, material: '' } }));
  const auditor = await offered(auditSession);
  s.runtime.endAuxRun(auditSession.id);

  // the boundary the catalog states: a head never gets the chief's structure tools, the auditor never writes
  for (const t of ['org_hire_agent', 'org_pause_agent', 'org_update_member', 'org_report', 'org_audit_finding']) assert.ok(!head.has(t), `a head has no ${t}`);
  for (const t of ['org_task_update', 'org_task_comment', 'org_request_review', 'org_escalate', 'org_set_key_result', 'org_set_cadence']) assert.ok(head.has(t), `a head has ${t} in its loops`);
  for (const t of ['org_task_update', 'org_request_review', 'org_task_comment']) assert.ok(specialist.has(t), `a specialist keeps its task true from the heartbeat (${t})`);
  for (const t of ['org_costs', 'org_set_goal', 'org_assign', 'org_propose_experiment']) assert.ok(!specialist.has(t), `a specialist has no ${t}`);
  for (const t of ['org_audit_finding', 'org_audit_close', 'fs_read', 'org_metric_read', 'org_decisions', 'org_intent']) assert.ok(auditor.has(t), `the auditor reads with ${t}`);
  for (const t of ['fs_write', 'fs_edit', 'org_create_task', 'org_message', 'org_task_comment']) assert.ok(!auditor.has(t), `the auditor's run never offers ${t}`);

  const roleOf = (id: string): { role: string; set: Set<string> } => id === CHIEF_PACK_ID ? { role: 'chief', set: chief } : id === 'pack-auditor' ? { role: 'auditor', set: auditor } : id.endsWith('-manager') ? { role: 'head', set: head } : { role: 'specialist', set: specialist };
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
  // a head escalates from its loops only what is its unit's
  const writerLoop = await sessionOf(s, s.writer.id);
  const ours = await s.tasks.create(orgId, { title: 'Pick the launch date', createdBy: `agent:${s.writer.id}`, assigneeAgentId: s.editor.id });
  assert.match(await s.runtime.execute(writerLoop, 'org_escalate', { taskId: ours.id, reason: 'needs the CEO' }), /escalated to the CEO/);
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
    assert.match(body('kpi-audit'), /Assurance request:/, `${h.id} files assurance requests the auditor can find`);
  }
  const auditor = AUTHORED_PACKS.find((p) => p.id === 'pack-auditor')!;
  assert.ok(auditor.skills!.some((x) => x.name === 'audit-ledger-and-metrics' && /Assurance request:/.test(x.instructions)));
  assert.ok(auditor.skills!.some((x) => x.name === 'audit-values-and-culture'));
  for (const n of ['org-member-workflow', 'org-member-onboarding', 'org-unit-retro']) assert.ok(BUILTIN_SKILLS.some((b) => b.name === n), `builtin ${n}`);
});
