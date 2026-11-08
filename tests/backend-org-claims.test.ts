/** Evidence-gated claims (docs/evidence.md): claim classes as data; the
 *  write path of shared state (key-result check-ins, task updates, project
 *  updates, step outputs, decisions) verifies cited refs with the quality
 *  verifier, cross-checks counts against the record, and blocks, flags or
 *  logs per the company's tunables; unverified values do not count; a
 *  reference to nothing is a fabrication — a signal, the trust ledger and,
 *  repeated, an incident; readers and the briefing say what is unverified. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { setup, enable, sessionOf, type S } from './org-governance-harness';
import { memStorage } from './helpers';
import { WorkspaceFs } from '../server/src/files/workspace-fs.service';
import { OrgQualityService } from '../server/src/org/org-quality.service';
import { OrgClaimsService } from '../server/src/org/org-claims.service';
import { OrgProjectsService } from '../server/src/org/org-projects.service';
import { OrgProjectsTools } from '../server/src/org/org-projects.tools';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { CLAIM_TUNABLES, deriveClaimTunables } from '../server/src/org/claims-tunables';
import { CLAIM_CLASSES, carriesClaim, claimStatus, countClaims, countMismatch, factualSentences } from '../server/src/org/claims-model';
import { checkBoundary, ruleFor } from '../server/src/org/boundary';
import { actionLog, orgClaims } from '../server/src/database/schema';

function wire(s: S) {
  const fs = new WorkspaceFs(memStorage().stub as never, s.db);
  const quality = new OrgQualityService(s.db, s.org, s.tasks, s.audit, s.approvals, s.agents, s.config, s.units, s.signals, s.incidents, s.actions, s.trust, fs, undefined, s.workspaces);
  const claims = new OrgClaimsService(s.db, s.org, s.tasks, quality, s.audit, s.agents, s.config, s.signals, s.incidents, s.trust, s.meetings);
  return { fs, quality, claims };
}
const by = { by: { kind: 'system' as const, id: 'system', name: 'system' } };
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

// ---- the pure half ----

test('claims are detected, counted and judged model-free; the classes are data', () => {
  assert.deepEqual(factualSentences('Will email the list tomorrow.'), [], 'a plan is not a claim');
  assert.equal(factualSentences('Sent the launch email to 93 people. Next we plan to follow up.').length, 1);
  assert.equal(factualSentences('Churn is 12% this month').length, 1, 'a factual number');
  assert.equal(carriesClaim(CLAIM_CLASSES.task_update, 'Looking into it'), false);
  assert.equal(carriesClaim(CLAIM_CLASSES.kr_checkin, '', 2000), true, 'a value is a claim by its shape');
  assert.deepEqual(countClaims('Contacted 93 people and sent 40 emails; completed 3 tasks.').map((c) => [c.measure, c.n]), [['outward', 93], ['outward', 40], ['tasks_done', 3]]);
  assert.deepEqual(countClaims('We will contact 50 people next week'), []);
  assert.equal(countMismatch(93, 5, 10), true);
  assert.equal(countMismatch(11, 10, 10), false, 'within the tolerance');
  const kinds = CLAIM_CLASSES.task_update.evidence;
  assert.equal(claimStatus({ refs: [], counts: [], bad: [], kinds }), 'unverified');
  assert.equal(claimStatus({ refs: [{ raw: 'file:/org/a.md', kind: 'file', ok: true, detail: '' }], counts: [], bad: [], kinds }), 'verified');
  assert.equal(claimStatus({ refs: [{ raw: 'file:/org/x.md', kind: 'file', ok: false, detail: 'no file', missing: true }], counts: [], bad: [], kinds }), 'fabricated');
  assert.equal(claimStatus({ refs: [], counts: [{ measure: 'outward', n: 93, phrase: 'contacted 93', measured: 0, mismatch: true }], bad: [], kinds }), 'mismatch');
  assert.equal(claimStatus({ refs: [], counts: [{ measure: 'outward', n: 5, phrase: 'contacted 5', measured: 5, mismatch: false }], bad: [], kinds }), 'verified', 'the record itself is the evidence');
});

test('claim tunables come from the profile within their bounds; the boundary reserves them for the CEO', () => {
  const strict = deriveOperatingSystem({ values: 'Rigour, evidence and compliance', culture: 'formal process and audit' });
  const light = deriveOperatingSystem({ values: 'Move fast, ship daily', culture: 'experiment and iterate' });
  const val = (os: ReturnType<typeof deriveOperatingSystem>, k: string) => os.tunables.find((t) => t.key === k)?.value;
  for (const k of Object.keys(CLAIM_TUNABLES)) assert.ok(strict.tunables.some((t) => t.key === k), `derived ${k}`);
  assert.equal(val(strict, 'claims.krCheckin'), 2);
  assert.equal(val(light, 'claims.krCheckin'), 1);
  assert.ok(val(strict, 'claims.fabricationIncident')! < val(light, 'claims.fabricationIncident')!);
  for (const t of deriveClaimTunables({ stage: 'early', cultureType: 'clan', speed: false, rigor: false })) {
    const d = CLAIM_TUNABLES[t.key];
    assert.ok(t.value >= d.min && t.value <= d.max, t.key);
  }
  assert.equal(ruleFor({ kind: 'tunable', key: 'claims.taskUpdate' }).verdict, 'propose');
  assert.equal(checkBoundary({ kind: 'tunable', key: 'claims.taskUpdate' }, 'chief').outcome, 'card');
});

// ---- the write path ----

test('a key-result value without evidence lands flagged and does not move progress; with a real file it counts; a person can confirm the held one', async () => {
  const s = await setup();
  const { fs, claims } = wire(s);
  const orgId = await enable(s);
  const objective = await s.units.addGoal(orgId, { title: 'Grow the list' });
  const kr = await s.intent.setKeyResult(orgId, { title: 'Subscribers', objectiveId: objective.id, metric: 'subscribers', targetValue: 5000, startValue: 1000, dueAt: iso(60), ownerAgentId: s.writer.id });
  const w = await sessionOf(s, s.writer.id);
  const out = await s.runtime.execute(w, 'org_check_in', { goalId: kr.id, currentValue: 2000, confidence: 0.8, note: 'Launch post landed.' });
  assert.match(out, /held, not counted/);
  assert.match(out, /flagged \[unverified\]/);
  assert.match(out, /Call org_check_in again with evidence/, 'the remediation names the call to make');
  let g = await s.org.goal(orgId, kr.id);
  assert.equal(g.currentValue, null, 'the key result keeps its last verified value (none yet)');
  assert.equal(g.confidence, 0.8, 'the confidence is the owner\'s judgement and lands');
  const [held] = await claims.list(orgId, { refType: 'checkin' });
  assert.equal(held.status, 'unverified');
  assert.equal(held.value, 2000);
  // the briefing line comes from here
  assert.equal((await s.tasks.evidence!.unverified(orgId)).length, 1);
  // a person confirms: the held value is applied
  await claims.confirm(orgId, held.id, 'user', 'matches the ESP dashboard');
  g = await s.org.goal(orgId, kr.id);
  assert.equal(g.currentValue, 2000);
  await assert.rejects(claims.confirm(orgId, held.id, `agent:${s.editor.id}`), /only a person confirms/);
  // with evidence: verified and counted
  await fs.write(s.ws.id, 'org/growth/subscribers.md', Buffer.from('ESP export: 2400 subscribers'), by);
  const ok = await s.runtime.execute(w, 'org_check_in', { goalId: kr.id, currentValue: 2400, evidence: ['file:/org/growth/subscribers.md'] });
  assert.match(ok, /Claim verified by file:\/org\/growth\/subscribers\.md/);
  assert.equal((await s.org.goal(orgId, kr.id)).currentValue, 2400);
});

test('blocking: an unevidenced "sent N" on a task is refused with remediation and nothing is written; a count the record shows verifies it', async () => {
  const s = await setup();
  wire(s);
  const orgId = await enable(s);
  await s.org.setTunable(orgId, 'claims.taskUpdate', 2);
  const t = await s.tasks.create(orgId, { title: 'Outreach to beta list', brief: { outcome: 'Beta invites out', done_when: 'invites sent' }, assigneeAgentId: s.writer.id, status: 'in_progress' });
  const w = await sessionOf(s, s.writer.id);
  await assert.rejects(s.runtime.execute(w, 'org_task_update', { taskId: t.id, note: 'Contacted 93 people from the beta list.' }), (err: Error) => {
    assert.match(err.message, /Refused: task update is contradicted by the record/);
    assert.match(err.message, /the record shows 0 outward actions/);
    assert.match(err.message, /Call org_task_update again with evidence/);
    return true;
  });
  assert.equal((await s.tasks.messages(orgId, { taskId: t.id })).filter((m) => /Contacted 93/.test(m.text)).length, 0, 'nothing was written');
  // the record: three sends, one of them to three recipients → five contacted
  const now = new Date().toISOString();
  for (const [i, to] of [['a@x.test'], ['b@x.test'], ['c@x.test', 'd@x.test', 'e@x.test']].entries()) {
    await s.db.insert(actionLog).values({ id: `send-${i}-aaaaaaaa`, key: `k${i}`, workspaceId: s.ws.id, agentId: s.writer.id, sessionId: w.id, orgId, tool: 'gmail_send', class: 'external_irreversible', inputHash: `h${i}`, input: JSON.stringify({ to: to.join(', ') }), status: 'succeeded', createdAt: now, finishedAt: now });
  }
  const out = await s.runtime.execute(w, 'org_task_update', { taskId: t.id, note: 'Contacted 5 people from the beta list.' });
  assert.match(out, /"Contacted 5" matches the record \(5\)/);
  const rows = await s.db.select().from(orgClaims).where(eq(orgClaims.orgId, orgId));
  assert.deepEqual(rows.map((r) => r.status).sort(), ['mismatch', 'verified'], 'the refused claim is on the record too');
  assert.ok((await s.signals.list(orgId)).some((x) => x.kind === 'claim_mismatch'), 'a contradicted count reaches the chief');
});

test('a reference to nothing is a fabrication: recorded, a signal, a rejection on the trust ledger, and repeated an incident; readers flag it', async () => {
  const s = await setup();
  wire(s);
  const orgId = await enable(s);
  const t = await s.tasks.create(orgId, { title: 'Publish the launch post', brief: { outcome: 'Post live', done_when: 'published' }, assigneeAgentId: s.writer.id, status: 'in_progress' });
  const w = await sessionOf(s, s.writer.id);
  const out = await s.runtime.execute(w, 'org_task_update', { taskId: t.id, note: 'Published the launch post.', evidence: ['file:/org/blog/launch.md', 'action:deadbeef1234'] });
  assert.match(out, /\[fabricated evidence\]/);
  assert.match(out, /These references do not exist: file:\/org\/blog\/launch\.md/);
  const [row] = await s.db.select().from(orgClaims).where(and(eq(orgClaims.orgId, orgId), eq(orgClaims.refType, 'task_comment')));
  assert.equal(row.status, 'fabricated');
  assert.ok((await s.signals.list(orgId)).some((x) => x.kind === 'claim_fabricated'));
  const ledger = await s.trust.recent(s.ws.id, s.writer.id, 50) as unknown as Array<{ refType: string; outcome: string }>;
  assert.ok(ledger.some((r) => r.refType === 'claim' && r.outcome === 'rejected'), 'a fabrication is a rejection on the trust ledger');
  // a second one inside the window (claims.fabricationIncident = 2 by default) opens an incident
  await s.runtime.execute(w, 'org_task_comment', { taskId: t.id, text: 'Shipped the fix to production.', evidence: ['task:NOPE-999'] }).catch(() => '');
  const incidents = await s.incidents.list(orgId);
  assert.ok(incidents.some((i) => i.kind === 'fabrication' && i.agentId === s.writer.id), 'repeated fabrication is an incident');
  // flags for readers
  const flags = await s.tasks.evidence!.flags(orgId, 'task_comment', [row.refId]);
  assert.equal(flags.get(row.refId), 'fabricated');
});

test('a project update that states facts is flagged where it is read; the claim is stored against the update', async () => {
  const s = await setup();
  wire(s);
  const orgId = await enable(s);
  const projects = new OrgProjectsService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, undefined, s.decisions);
  const tools = new OrgProjectsTools(s.org, projects, s.tasks, s.agents, s.config, s.runtime, s.turns);
  const { project } = await projects.create(orgId, { title: 'Ship the store', ownerAgentId: s.writer.id }, 'user');
  const w = await sessionOf(s, s.writer.id);
  const out = await tools.execute(w, 'org_project_update', { project: project.key, health: 'on_track', reason: 'Shipped the checkout and signed 3 customers' });
  assert.match(out, /Health update posted/);
  assert.match(out, /flagged \[unverified\]/);
  assert.match(await tools.execute(w, 'org_project', { project: project.key }), /\[unverified\] — check before building on it/);
  // a plain update carries no claim
  assert.doesNotMatch(await tools.execute(w, 'org_project_update', { project: project.key, health: 'on_track' }), /unverified/);
  assert.doesNotMatch(await tools.execute(w, 'org_project', { project: project.key }), /\[unverified\]/, 'the latest update is what is read');
});

test('people and log-level classes are not gated; text without a claim passes untouched', async () => {
  const s = await setup();
  const { claims } = wire(s);
  const orgId = await enable(s);
  const t = await s.tasks.create(orgId, { title: 'Draft', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.writer.id, status: 'in_progress' });
  const w = await sessionOf(s, s.writer.id);
  assert.doesNotMatch(await s.runtime.execute(w, 'org_task_update', { taskId: t.id, note: 'Looking into the outline now.' }), /claim|unverified/i);
  assert.equal(await s.tasks.evidence!.check(orgId, { cls: 'task_update', actor: 'user', tool: 'x', text: 'Sent 40 emails' }), null, 'a person is not gated');
  await s.org.setTunable(orgId, 'claims.taskUpdate', 0);
  const out = await s.runtime.execute(w, 'org_task_update', { taskId: t.id, note: 'Sent the outline to the editor.' });
  assert.match(out, /Logged as unverified/);
  const rows = await claims.list(orgId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].enforcement, 'log');
  assert.equal((await s.tasks.evidence!.flags(orgId, 'task_comment', [rows[0].refId])).size, 0, 'a logged claim is not flagged');
  const sum = await claims.summary(orgId);
  assert.equal(sum.byAgent[s.writer.id].unverified, 1);
});
