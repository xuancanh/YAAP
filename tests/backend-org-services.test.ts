/** Services (docs/services.md): each department's catalog with SLAs. A
 *  request naming a service is checked against its schema (refused with
 *  what is missing), routed to its department with no model and run
 *  through the process engine's service-request hook; the provider accepts
 *  with a date, declines with a reason or negotiates, every exchange kept;
 *  a missed accept SLA climbs decision routing (the provider's head, the
 *  chief, the CEO); unlisted asks are counted and, repeated, suggested as a
 *  service; the chief only routes asks that name nothing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, enable, sessionOf, inbox, type S } from './org-governance-harness';
import { OrgProcessesService } from '../server/src/org/org-processes.service';
import { OrgServicesService } from '../server/src/org/org-services.service';
import { OrgServicesTools } from '../server/src/org/org-services.tools';
import { checkRequest, computeServiceMetrics, diffService, loosens, needWords, normalizeDate, normalizeFields, sameNeed, slaClock, validateFields, type ServiceShape } from '../server/src/org/service-model';
import { SERVICE_TEMPLATES } from '../server/src/org/service-templates';
import { SERVICE_TUNABLES, deriveServiceTunables } from '../server/src/org/service-tunables';
import { PROCESS_TEMPLATES } from '../server/src/org/process-templates';
import { normalizeProcess, validateProcess } from '../server/src/org/process-model';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { checkBoundary } from '../server/src/org/boundary';
import { parseSteps } from '../server/src/org/work-model';

function wire(s: S) {
  const processes = new OrgProcessesService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, s.runtime, s.bus);
  const services = new OrgServicesService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, processes, s.units, s.runtime);
  const tools = new OrgServicesTools(s.org, services, s.agents, s.config, s.runtime, s.turns, s.units);
  return { processes, services, tools };
}

/** Writer heads Engineering (Editor reports to it); Marketer leads Marketing and asks Engineering for work. */
async function company(s: S) {
  const marketer = await s.agents.create({ name: 'Marketer', charter: 'You market.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  const orgId = await enable(s, 'supervised');
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Engineering' });
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id, title: 'Engineer' });
  await s.org.updateMember(orgId, marketer.id, { title: 'Marketing lead' });
  await s.units.syncMembership(orgId);
  return { orgId, marketer };
}

/** Tick a task's MUST items, hand it to review and accept it. */
async function finishTask(s: S, orgId: string, taskId: string) {
  const t = await s.tasks.get(orgId, taskId);
  for (const x of parseSteps(t.steps).filter((y) => y.from === 'process:must')) await s.tasks.step(orgId, taskId, { done: x.id }, `agent:${t.assigneeAgentId}`);
  const r = await s.tasks.requestReview(orgId, taskId, { fromAgentId: t.assigneeAgentId, note: 'done' });
  await s.tasks.review(orgId, taskId, { verdict: 'accept', byAgentId: r.reviewerAgentId === t.assigneeAgentId ? null : r.reviewerAgentId });
}

const BUG = { summary: 'Signup crashes on Safari', repro: 'Open /signup in Safari 17, press Join', severity: 'high' };

// ---- 1. the pure model ----

test('model: a request is checked against the schema with each fix; dates, repeat words, loosening and metrics', () => {
  const fields = normalizeFields([{ name: 'summary', label: 'What is broken' }, { name: 'severity', type: 'choice', options: ['low', 'high'] }, { name: 'link', type: 'url', required: false }, { name: 'due', type: 'date', required: false }]);
  const bad = checkRequest(fields, { severity: 'urgent', link: 'not a link', due: 'soon' });
  assert.equal(bad.problems.length, 4);
  assert.ok(bad.problems.some((p) => /missing summary .*give fields\.summary/.test(p)), 'a missing required field names the field and what to give');
  assert.ok(bad.problems.some((p) => /severity .* one of low \| high/.test(p)));
  assert.ok(bad.problems.some((p) => /link .*https/.test(p)));
  const ok = checkRequest(fields, { summary: 'Crash', severity: 'HIGH', extra_note: 'kept' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.values.severity, 'high', 'a choice is matched without case');
  assert.equal(ok.values.extra_note, 'kept', 'an extra field is kept for the provider');
  assert.ok(validateFields(normalizeFields([{ name: 'x', type: 'choice' }, { name: 'x' }])).length >= 2);
  assert.equal(normalizeDate('2026-12-01'), '2026-12-01T23:59:59.000Z');
  assert.equal(normalizeDate('next week'), null);
  assert.ok(sameNeed(needWords('Request for Engineering: export the newsletter list'), needWords('Export newsletter list again')));
  assert.ok(!sameNeed(needWords('Export the newsletter list'), needWords('Fix the billing page')));
  const base: ServiceShape = { title: 'Bug fix', description: '', fields, ownerRole: 'head', processId: null, acceptSlaHours: 8, resolveSlaHours: 72, unitId: 'u' };
  assert.equal(loosens(base, { ...base, acceptSlaHours: 24 }), true, 'a longer SLA loosens the promise');
  assert.equal(loosens(base, { ...base, acceptSlaHours: 4 }), false);
  assert.equal(loosens(base, { ...base, fields: fields.filter((f) => f.name !== 'summary') }), true, 'dropping a required field loosens it');
  assert.ok(diffService(base, { ...base, acceptSlaHours: 4 }).includes('accept SLA 8h → 4h'));
  const t0 = '2026-11-01T00:00:00.000Z';
  const m = computeServiceMetrics([
    { status: 'delivered', createdAt: t0, answeredAt: '2026-11-01T02:00:00.000Z', acceptedAt: '2026-11-01T02:00:00.000Z', resolvedAt: '2026-11-02T00:00:00.000Z', acceptDueAt: null, resolveDueAt: null, acceptBreachedAt: null, resolveBreachedAt: null },
    { status: 'declined', createdAt: t0, answeredAt: '2026-11-01T10:00:00.000Z', acceptedAt: null, resolvedAt: '2026-11-01T10:00:00.000Z', acceptDueAt: null, resolveDueAt: null, acceptBreachedAt: '2026-11-01T08:00:00.000Z', resolveBreachedAt: null },
  ]);
  assert.equal(m.requests, 2);
  assert.equal(m.acceptHoursP50, 6);
  assert.equal(m.resolveHoursP50, 24);
  assert.equal(m.breachRate, 0.5);
  assert.equal(m.declineRate, 0.5);
  assert.equal(slaClock({ status: 'open', createdAt: t0, answeredAt: null, acceptedAt: null, resolvedAt: null, acceptDueAt: '2026-11-01T08:00:00.000Z', resolveDueAt: null, acceptBreachedAt: null, resolveBreachedAt: null }, new Date('2026-11-01T10:00:00.000Z')).breached, true);
  for (const t of SERVICE_TEMPLATES) assert.deepEqual(validateFields(t.fields), [], `template ${t.id} is valid`);
  for (const id of ['service-request', 'cross-function-request']) assert.deepEqual(validateProcess(normalizeProcess(PROCESS_TEMPLATES.find((x) => x.id === id)!.def), { loopMaxCeiling: 10 }), [], `${id} is a valid process`);
});

test('tunables: derived from the profile within bounds; speed answers in hours, a hierarchy approves every edit; the boundary reserves the tunables and another unit\'s catalog', () => {
  const fast = deriveOperatingSystem({ values: 'Move fast, ship daily', culture: 'iterate and explore' });
  const formal = deriveOperatingSystem({ values: 'Process, compliance and audit', culture: 'formal approvals and control' });
  const val = (os: ReturnType<typeof deriveOperatingSystem>, k: string) => os.tunables.find((t) => t.key === k)?.value;
  for (const k of Object.keys(SERVICE_TUNABLES)) assert.ok(fast.tunables.some((t) => t.key === k), `derived ${k}`);
  assert.ok(val(fast, 'service.acceptSlaHours')! < val(formal, 'service.acceptSlaHours')!);
  assert.equal(val(formal, 'service.editApproval'), 2);
  for (const t of deriveServiceTunables({ stage: 'scale', cultureType: 'clan', speed: true, rigor: true })) { const d = SERVICE_TUNABLES[t.key]; assert.ok(t.value >= d.min && t.value <= d.max, t.key); }
  assert.equal(checkBoundary({ kind: 'tunable', key: 'service.acceptSlaHours' }, 'chief').outcome, 'card');
  assert.equal(checkBoundary({ kind: 'service', withinUnit: true }, 'agent:x').outcome, 'proceed');
  assert.equal(checkBoundary({ kind: 'service', withinUnit: false }, 'agent:x').outcome, 'card');
});

// ---- 2. the catalog ----

test('catalog: a head adopts a template with the company\'s SLAs; a looser edit waits for its manager; another member\'s change is a proposal; retire stops new requests', async () => {
  const s = await setup();
  const { orgId, marketer } = await company(s);
  const { services } = wire(s);
  const eng = (await s.units.ledBy(orgId, s.writer.id))!;
  await s.org.setTunable(orgId, 'service.acceptSlaHours', 6, { actor: 'user' });
  const r = await services.author(orgId, { template: 'bug-fix', reason: 'we fix bugs for everyone' }, `agent:${s.writer.id}`);
  assert.equal(r.applied, true);
  assert.equal(r.service.unitId, eng.id, 'a head\'s service lands in its own department');
  assert.equal(r.service.acceptSlaHours, 6, 'the SLA starts from the company\'s tunable');
  const tighter = await services.author(orgId, { service: 'bug-fix', acceptSlaHours: 4, reason: 'we answer faster now' }, `agent:${s.writer.id}`);
  assert.equal(tighter.applied, true, 'a tighter promise applies at once');
  assert.equal(tighter.service.version, 2);
  const looser = await services.author(orgId, { service: 'bug-fix', acceptSlaHours: 12, reason: 'we are swamped' }, `agent:${s.writer.id}`);
  assert.equal(looser.applied, false, 'a looser SLA waits (service.editApproval 1)');
  const card = await s.approvals.get(orgId, looser.approvalId!);
  assert.equal(card.kind, 'service_change');
  assert.equal(card.holder, `agent:${s.chief.id}`, 'routed to the head\'s manager');
  await s.approvals.decide(orgId, card.id, 'approve', 'ok', 'user');
  assert.equal((await services.get(orgId, 'bug-fix')).acceptSlaHours, 12);
  const prop = await services.author(orgId, { service: 'bug-fix', title: 'Bugs', reason: 'shorter' }, `agent:${marketer.id}`);
  assert.equal(prop.applied, false, 'another department\'s service is a proposal');
  assert.match((await s.approvals.get(orgId, prop.approvalId!)).reserved, /boundary reserves/);
  await assert.rejects(services.author(orgId, { template: 'design-mockup', fields: [{ name: 'x', type: 'choice' }], reason: 'r' }, `agent:${s.writer.id}`), /choice field "x" has no options/);
  await assert.rejects(services.author(orgId, { service: 'bug-fix', process: 'release-checklist', reason: 'link it' }, 'user'), /no process|takes no service requests|accept/);
  await services.retire(orgId, 'bug-fix', 'moving to the incident queue', 'user');
  await assert.rejects(services.requestService(orgId, { service: 'bug-fix', title: 'x', why: 'y', fields: BUG }, `agent:${marketer.id}`), /retired/);
});

// ---- 3. a request end to end ----

test('a request: refused with what is missing; routed to the department with no model; negotiate → agree → deliver → confirm; every exchange on the thread; metrics', async () => {
  const s = await setup();
  const { orgId, marketer } = await company(s);
  const { services, processes, tools } = wire(s);
  await services.author(orgId, { template: 'bug-fix', reason: 'starter' }, `agent:${s.writer.id}`);
  const asMarketer = `agent:${marketer.id}`;
  await assert.rejects(services.requestService(orgId, { service: 'bug-fix', title: 'Signup crash', why: 'blocks the launch', fields: { summary: 'crash' } }, asMarketer), (e: Error) => /missing repro/.test(e.message) && /missing severity .* one of low \| medium \| high \| critical/.test(e.message));
  const { request: r, note } = await services.requestService(orgId, { service: 'bug-fix', title: 'Signup crash', why: 'blocks the launch', fields: BUG, neededBy: '2026-12-01' }, asMarketer);
  await services.settle();
  assert.match(note, /SR-1 → Engineering \(Bug fix v1\)/);
  assert.equal(r.status, 'open');
  assert.ok(r.acceptTaskId, 'the accept step is a task');
  const accept = await s.tasks.get(orgId, r.acceptTaskId!);
  assert.equal(accept.assigneeAgentId, s.writer.id, 'the providing department\'s head answers (model-free routing)');
  assert.match(accept.brief, /Signup crashes on Safari/);
  assert.ok(Math.abs(Date.parse(r.acceptDueAt!) - Date.parse(r.createdAt) - r.acceptSlaHours * 3_600_000) < 5_000, 'the accept clock runs from the request');
  await assert.rejects(services.respond(orgId, 'SR-1', { answer: 'accept' }, `agent:${s.writer.id}`), /accept needs the date/);
  await assert.rejects(services.respond(orgId, 'SR-1', { answer: 'accept', due: '2026-12-01' }, asMarketer), /answered by the providing department/);
  await services.respond(orgId, 'SR-1', { answer: 'negotiate', due: '2026-12-05', scope: 'Safari 17 only' }, `agent:${s.writer.id}`);
  assert.equal((await services.request(orgId, 'SR-1')).status, 'negotiating');
  assert.ok((await inbox(s, marketer.id)).some((e) => /proposes for SR-1/.test(e.title)), 'the requester is told of the counter');
  const sess = await sessionOf(s, marketer.id);
  assert.match(await tools.contextFor(sess) ?? '', /SR-1 .*counter-proposal/, 'the requester\'s context names the counter to answer');
  await services.respond(orgId, 'SR-1', { answer: 'agree' }, asMarketer);
  await services.settle();
  let cur = await services.request(orgId, 'SR-1');
  assert.equal(cur.status, 'accepted');
  assert.equal(cur.committedDue?.slice(0, 10), '2026-12-05');
  assert.deepEqual(JSON.parse(cur.thread).map((e: { action: string }) => e.action), ['requested', 'negotiate', 'agreed']);
  assert.equal((await s.tasks.get(orgId, r.acceptTaskId!)).status, 'done', 'the accept step is settled by the answer');
  const steps = await processes.steps(orgId, cur.runId!);
  const doStep = steps.find((x) => x.nodeId === 'do' && x.current)!;
  assert.equal((await s.tasks.get(orgId, doStep.taskId!)).assigneeAgentId, s.writer.id);
  await finishTask(s, orgId, doStep.taskId!);
  await services.settle();
  const deliver = (await processes.steps(orgId, cur.runId!)).find((x) => x.nodeId === 'deliver' && x.current)!;
  assert.equal((await s.tasks.get(orgId, deliver.taskId!)).assigneeAgentId, marketer.id, 'the requester confirms the delivery');
  await finishTask(s, orgId, deliver.taskId!);
  await services.settle();
  await services.tick(await s.org.get(orgId), new Date());
  cur = await services.request(orgId, 'SR-1');
  assert.equal(cur.status, 'delivered');
  const svc = (await services.overview(orgId)).find((x) => x.name === 'bug-fix')!;
  assert.equal(svc.metrics.requests, 1);
  assert.equal(svc.metrics.delivered, 1);
  assert.ok(svc.metrics.acceptHoursP50 !== null);
  assert.match(await tools.execute(await sessionOf(s, s.editor.id), 'org_services', {}), /bug-fix "Bug fix" \(Engineering; answered by Writer\): accept \d+h.*fields: summary\*, repro\*, severity\* \(low\|medium\|high\|critical\), link \(url\)/);
  assert.match(await tools.execute(sess, 'org_services', { request: 'SR-1' }), /SR-1 "Signup crash" — delivered/);
});

test('a decline needs the reason; the run ends without delivery; the requester is told', async () => {
  const s = await setup();
  const { orgId, marketer } = await company(s);
  const { services, processes } = wire(s);
  await services.author(orgId, { template: 'bug-fix', reason: 'starter' }, `agent:${s.writer.id}`);
  await services.requestService(orgId, { service: 'bug-fix', title: 'Crash', why: 'launch', fields: BUG }, `agent:${marketer.id}`);
  await services.settle();
  await assert.rejects(services.respond(orgId, 'SR-1', { answer: 'decline' }, `agent:${s.writer.id}`), /decline needs the reason/);
  await services.respond(orgId, 'SR-1', { answer: 'decline', reason: 'Safari 15 is out of support', alternative: 'upgrade Safari' }, `agent:${s.writer.id}`);
  await services.settle();
  const r = await services.request(orgId, 'SR-1');
  assert.equal(r.status, 'declined');
  assert.match(r.declineReason, /out of support — alternative: upgrade Safari/);
  assert.equal((await processes.run(orgId, r.runId!)).status, 'done', 'the delivery steps are skipped');
  assert.ok((await inbox(s, marketer.id)).some((e) => /declined/.test(e.title)));
});

// ---- 4. breaches climb the line ----

test('a missed accept SLA: a breach card to the provider\'s manager; held to an answer; the next breach climbs to the CEO, whose rejection declines it', async () => {
  const s = await setup();
  const { orgId, marketer } = await company(s);
  const { services } = wire(s);
  await services.author(orgId, { template: 'bug-fix', reason: 'starter' }, `agent:${s.writer.id}`);
  const { request: r } = await services.requestService(orgId, { service: 'bug-fix', title: 'Crash', why: 'launch', fields: BUG }, `agent:${marketer.id}`);
  await services.settle();
  const org = await s.org.get(orgId);
  await services.tick(org, new Date(Date.now() + 30 * 60_000));
  assert.equal((await services.request(orgId, r.id)).acceptBreachedAt, null, 'inside the SLA nothing happens');
  await services.tick(org, new Date(Date.now() + (r.acceptSlaHours + 1) * 3_600_000));
  let cur = await services.request(orgId, r.id);
  assert.ok(cur.acceptBreachedAt);
  const card1 = await s.approvals.get(orgId, cur.breachApprovalId!);
  assert.equal(card1.kind, 'service_breach');
  assert.equal(card1.requestedBy, `agent:${s.writer.id}`, 'raised from the provider\'s performer');
  assert.equal(card1.holder, `agent:${s.chief.id}`, 'decision routing puts it with the performer\'s manager');
  await s.approvals.decide(orgId, card1.id, 'approve', 'answer today', 'user');
  cur = await services.request(orgId, r.id);
  assert.equal(cur.acceptBreachedAt, null, 'held to an answer: a fresh window');
  assert.match((await s.tasks.messages(orgId, { taskId: r.acceptTaskId })).map((m) => m.text).join('\n'), /holds you to an answer on SR-1/);
  await services.tick(org, new Date(Date.now() + (2 * r.acceptSlaHours + 2) * 3_600_000));
  cur = await services.request(orgId, r.id);
  const card2 = await s.approvals.get(orgId, cur.breachApprovalId!);
  assert.equal(card2.requestedBy, `agent:${s.chief.id}`, 'the second breach is raised one level higher');
  assert.equal(card2.holder, 'ceo', 'and reaches the CEO\'s inbox');
  assert.ok((await s.approvals.pendingForOwner(orgId)).some((a) => a.id === card2.id));
  await s.approvals.decide(orgId, card2.id, 'reject', 'we will not do this', 'user');
  await services.settle();
  cur = await services.request(orgId, r.id);
  assert.equal(cur.status, 'declined');
  assert.equal(cur.breaches, 2);
  assert.match(cur.declineReason, /we will not do this/);
});

test('an answer closes the pending breach card; breachAction 0 nudges instead of a card', async () => {
  const s = await setup();
  const { orgId, marketer } = await company(s);
  const { services } = wire(s);
  await services.author(orgId, { template: 'bug-fix', reason: 'starter' }, `agent:${s.writer.id}`);
  const { request: r } = await services.requestService(orgId, { service: 'bug-fix', title: 'Crash', why: 'launch', fields: BUG }, `agent:${marketer.id}`);
  await services.settle();
  await services.tick(await s.org.get(orgId), new Date(Date.now() + (r.acceptSlaHours + 1) * 3_600_000));
  const cardId = (await services.request(orgId, r.id)).breachApprovalId!;
  await services.respond(orgId, r.key, { answer: 'accept', due: '2026-12-10' }, `agent:${s.writer.id}`);
  assert.equal((await s.approvals.get(orgId, cardId)).status, 'expired', 'the card is moot once answered');
  await s.org.setTunable(orgId, 'service.breachAction', 0, { actor: 'user' });
  const { request: r2 } = await services.requestService(orgId, { service: 'bug-fix', title: 'Another crash', why: 'launch', fields: BUG }, `agent:${marketer.id}`);
  await services.settle();
  await services.tick(await s.org.get(orgId), new Date(Date.now() + (r2.acceptSlaHours + 1) * 3_600_000));
  const cur = await services.request(orgId, r2.id);
  assert.ok(cur.acceptBreachedAt);
  assert.equal(cur.breachApprovalId, null, 'a nudge, no card');
  assert.match((await s.tasks.messages(orgId, { taskId: r2.acceptTaskId })).map((m) => m.text).join('\n'), /no answer within its accept SLA/);
});

// ---- 5. unlisted asks: department-routed, chief-triaged, repeats ----

test('unlisted asks: a named department runs the default intake on the handoff SLA; the same ask repeated is suggested as a service; naming nothing goes to the chief, who routes it', async () => {
  const s = await setup();
  const { orgId, marketer } = await company(s);
  const { services, tools } = wire(s);
  await s.org.setTunable(orgId, 'chief.handoffSlaHours', 5, { actor: 'user' });
  const asMarketer = `agent:${marketer.id}`;
  const first = await services.requestService(orgId, { unit: 'Engineering', title: 'Export the newsletter list', why: 'the campaign' }, asMarketer);
  await services.settle();
  assert.equal(first.request.acceptSlaHours, 5, 'an unlisted ask keeps the old handoff SLA');
  assert.equal((await s.tasks.get(orgId, (await services.request(orgId, first.request.id)).acceptTaskId!)).assigneeAgentId, s.writer.id);
  await services.requestService(orgId, { unit: 'Engineering', title: 'Export newsletter list (October)', why: 'the campaign' }, asMarketer);
  assert.ok(!(await inbox(s, s.writer.id)).some((e) => /without a service/.test(e.title)), 'not yet at the threshold');
  await services.requestService(orgId, { unit: 'Engineering', title: 'Newsletter list export', why: 'the campaign' }, asMarketer);
  await services.settle();
  assert.ok((await inbox(s, s.writer.id)).some((e) => /reached Engineering 3 times .*without a service/.test(e.title)), 'the head is asked to define a service at service.suggestAfterRepeats');
  assert.match(await tools.contextFor(await sessionOf(s, s.writer.id)) ?? '', /keeps coming without a service/);
  const t = await services.requestService(orgId, { title: 'Someone to look at our pricing page', why: 'conversion dropped' }, asMarketer);
  await services.settle();
  assert.equal(t.request.status, 'triage');
  assert.match(t.note, /with the chief of staff to route/);
  assert.match(await tools.contextFor(await sessionOf(s, s.chief.id)) ?? '', /SR-4 .*names no service: route it/);
  await assert.rejects(services.respond(orgId, 'SR-4', { answer: 'route', unit: 'Engineering' }, `agent:${s.writer.id}`), /chief of staff routes/);
  await services.respond(orgId, 'SR-4', { answer: 'route', unit: 'Engineering' }, `agent:${s.chief.id}`);
  await services.settle();
  const routed = await services.request(orgId, 'SR-4');
  assert.equal(routed.status, 'open');
  assert.ok(routed.acceptTaskId);
  assert.equal((await s.tasks.get(orgId, routed.acceptTaskId!)).assigneeAgentId, s.writer.id, 'the chief\'s route reaches the department\'s head');
});

// ---- 6. tools and seeding ----

test('tools: request, respond and author through the agent tools; the library; bootstrap seeds the starter catalog by department', async () => {
  const s = await setup();
  const { orgId, marketer } = await company(s);
  const { services, tools } = wire(s);
  const head = await sessionOf(s, s.writer.id);
  assert.match(await tools.execute(head, 'org_services', { library: true }), /bug-fix: Bug fix .*fits Engineering/);
  const seeded = await services.seed(orgId, { source: 'bootstrap' });
  assert.deepEqual(seeded.map((x) => x.name).sort(), ['bug-fix', 'feature-estimate', 'launch-copy'], 'each template whose department the company has (Engineering, Marketing)');
  assert.equal((await services.seed(orgId, { source: 'bootstrap' })).length, 0, 'idempotent');
  assert.match(await tools.execute(head, 'org_service_author', { service: 'feature-estimate', acceptSlaHours: 2, reason: 'estimates are quick' }), /v2: accept SLA/);
  const m = await sessionOf(s, marketer.id);
  await assert.rejects(tools.execute(m, 'org_request_service', { service: 'feature-estimate', title: 'Size dark mode', why: 'roadmap' }), /refused: the request is incomplete:\n- missing feature/);
  assert.match(await tools.execute(m, 'org_request_service', { service: 'feature-estimate', title: 'Size dark mode', why: 'roadmap', fields: { feature: 'dark mode', outcome: 'fewer churn complaints' } }), /SR-1 → Engineering/);
  assert.match(await tools.contextFor(head) ?? '', /SR-1 "Size dark mode" waits for your department's answer \(\d+h left\)/);
  assert.match(await tools.execute(head, 'org_service_respond', { request: 'SR-1', answer: 'accept', due: '2026-12-03' }), /SR-1 accepted, due 2026-12-03\. The delivery is /);
  assert.match(await tools.execute(m, 'org_services', { mine: true }), /SR-1 "Size dark mode" accepted due 2026-12-03/);
});
