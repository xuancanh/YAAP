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
  for (const n of ['operating-system-setup', 'annual-planning', 'quarterly-planning', 'weekly-business-review', 'exec-meeting-prep', 'decision-log-hygiene', 'ceo-daily-brief', 'handoff-sla-monitor', 'risk-register', 'values-mechanism-audit', 'ritual-retirement-review', 'investor-update', 'reorg-proposal']) assert.ok(names.includes(n), n);
  for (const s of pack.skills!) assert.ok((s.instructions ?? '').length > 800, `${s.name} is step-by-step`);
  // every org_* / meeting_* tool a skill names is one the server offers
  const s = await setup();
  await enable(s, 'autonomous');
  const offered = new Set<string>();
  for (const spec of await s.runtime.specsFor(await sessionOf(s, s.chief.id))) offered.add(spec.name);
  const known = new Set([...offered, 'org_set_cadence', 'org_decisions', 'org_recall', 'org_playbooks', 'org_write_playbook', 'org_capacity', 'org_eval_role', 'org_metric_sources', 'org_metric_read', 'org_incidents', 'org_propose_experiment', 'org_experiments', 'org_run_checks']);
  const named = new Set(pack.skills!.flatMap((x) => (x.instructions ?? '').match(/\borg_[a-z_]+\b/g) ?? []));
  for (const n of named) assert.ok(known.has(n), `${n} exists`);
  const all = pack.skills!.map((x) => x.instructions).join('\n');
  assert.match(all, /function manager/);
  assert.match(all, /unknown — investigating/);
  assert.match(all, /\/org\/decisions\.md/);
});

test('operating-system state: rituals within the lookahead with their pre-read deadline, overdue decision cards, stale risks, breached cross-unit handoffs, function owners; the heartbeat wakes the chief only for a new breach', async () => {
  const s = await setup();
  const orgId = await enable(s, 'supervised');
  // a unit: the editor reports to the writer, who becomes a lead
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id });
  await s.org.updateMember(orgId, s.writer.id, { title: 'Sales manager' });
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
  assert.ok(st.functionOwners.some((o) => o.name === 'Writer' && o.title === 'Sales manager'));
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
  assert.equal(await chiefSvc.heartbeatContext(s.writer.id, new Date()), null, 'only the chief reads the operating system');
  assert.equal((await chiefSvc.heartbeatReasons(s.chief.id, new Date(), null)).length, 1);
  assert.match((await chiefSvc.heartbeatReasons(s.chief.id, new Date(), null))[0], /handoff-sla-monitor/);
  assert.equal((await chiefSvc.heartbeatReasons(s.chief.id, new Date(), new Date().toISOString())).length, 0, 'already seen at the last beat');
  assert.deepEqual(await chiefSvc.heartbeatReasons(s.writer.id, new Date(), null), []);
  assert.match(describeState({ orgId, orgName: 'X', proxyLevel: 'conductor', rituals: [], overdueDecisions: [], staleRisks: [], breachedHandoffs: [], functionOwners: [] }), /Nothing overdue/);
});
