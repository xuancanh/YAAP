/** Evals and gated rollout (docs/evals.md, execution-plan item 31, C6):
 *  golden cases harvested from work accepted by check or by review on the
 *  first round (capped per role) and added by the CEO; a case replayed in a
 *  record-only sandbox that reaches nothing outside; file checks graded
 *  against the recorded writes and the rest by the rubric grader; the
 *  baseline cached per version; a regression blocks a charter_change card
 *  with the result attached, a pass lets it apply; the run's USD cap. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionLog } from '../server/src/database/schema';
import { setup, enable, sessionOf, call, say, type Plan, type S } from './org-governance-harness';
import { gradeFileCheck, verdictOf } from '../server/src/org/org-evals.service';

/** The member writes issue.md; a charter containing BAD makes it write junk. */
const writerPlan: Plan = (req, round) => {
  if (round > 0) return say('Wrote the issue.');
  if (!/# Evaluation run/.test(req.system ?? '')) return say('ok');
  const bad = /BAD/.test(req.system ?? '');
  return call('fs_write', { path: 'issue.md', content: bad ? 'lorem' : 'Hello subscribers, issue 12.' });
};

async function withCase(s: S, orgId: string) {
  return s.evals.addCase(orgId, { roleKey: 'writer', title: 'Write issue 12', brief: { outcome: 'Issue 12 drafted', done_when: 'issue.md greets subscribers' }, checks: [{ kind: 'file_matches', path: 'issue.md', contains: 'subscribers' }] }, 'user');
}

test('harvest: a task accepted by check, or by review the first time, becomes a golden case of its role; a second-round acceptance does not; the cap per role holds; the CEO adds by hand', async () => {
  const s = await setup();
  const orgId = await enable(s);
  s.tasks.setAcceptanceGate(async () => ({ outcome: 'pass', detail: 'issue.md exists', alsoReview: false }));
  const t1 = await s.tasks.create(orgId, { title: 'Issue 11', brief: { outcome: 'x', done_when: 'issue.md exists' }, assigneeAgentId: s.writer.id, checks: [{ kind: 'file_exists', path: 'issue.md' }] });
  await s.tasks.requestReview(orgId, t1.id, { fromAgentId: s.writer.id });
  const t2 = await s.tasks.create(orgId, { title: 'Issue 10', brief: { outcome: 'x', done_when: 'a clear intro' }, assigneeAgentId: s.writer.id });
  await s.tasks.review(orgId, t2.id, { verdict: 'accept', byAgentId: s.editor.id });
  const t3 = await s.tasks.create(orgId, { title: 'Issue 9', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.writer.id });
  await s.tasks.update(orgId, t3.id, { reviewRounds: 1 });
  await s.tasks.review(orgId, t3.id, { verdict: 'accept', byAgentId: s.editor.id });
  const cases = await s.evals.cases(orgId, { roleKey: 'writer' });
  assert.equal(cases.length, 2);
  const byCheck = cases.find((c) => c.sourceTaskId === t1.id)!;
  assert.equal(byCheck.source, 'check');
  assert.equal(s.evals.view(byCheck).expected!.checks[0].kind, 'file_exists');
  assert.equal(cases.find((c) => c.sourceTaskId === t2.id)!.source, 'review');
  await s.org.setTunable(orgId, 'evals.casesPerRole', 2, { actor: 'user' });
  const t4 = await s.tasks.create(orgId, { title: 'Issue 8', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.writer.id });
  await s.tasks.review(orgId, t4.id, { verdict: 'accept', byAgentId: s.editor.id });
  assert.equal((await s.evals.cases(orgId, { roleKey: 'writer' })).length, 2, 'cap reached');
  const manual = await s.controller.addCase(s.ws.id, { roleKey: 'editor', title: 'Edit issue 7', brief: { outcome: 'x', done_when: 'tight copy' } });
  assert.equal(manual.source, 'manual');
  await assert.rejects(s.evals.addCase(orgId, { roleKey: 'editor', title: 'x', rubric: 'y' }, 'chief'), /never an agent's/);
  const retired = await s.controller.retireCase(s.ws.id, manual.id);
  assert.ok(retired.retiredAt);
});

test('a case replays in a record-only sandbox: the member\'s calls are recorded, nothing external happens, no action is logged and the throwaway session is gone', async () => {
  const s = await setup((req, round) => (round === 0 && /# Evaluation run/.test(req.system ?? '') ? call('gmail_send', { to: 'all@list.example', subject: 'Issue 12', body: 'Hello subscribers' }) : say('done')));
  const orgId = await enable(s);
  await withCase(s, orgId);
  s.evals.gradeFn = async ({ calls }) => ({ pass: calls.some((c) => c.name === 'gmail_send'), detail: 'sent (recorded)' });
  const sessionsBefore = (await s.repo.listSessions(s.ws.id)).length;
  const run = await s.evals.run(orgId, { roleKey: 'writer', candidate: { kind: 'model', ref: '', before: '', after: 'claude-haiku-4-5' } });
  assert.equal(run.status, 'done');
  assert.equal(s.externalCalls(), 0, 'no connection call');
  assert.equal((await s.db.select().from(actionLog)).length, 0, 'no action reached the contract');
  assert.equal((await s.repo.listSessions(s.ws.id)).length, sessionsBefore, 'eval sessions are deleted');
  assert.ok(s.provider.requests.some((r) => /# Evaluation run/.test(r.system ?? '')));
});

test('grading: file checks are graded model-free against the recorded writes; checks without a file and the rubric go to the rubric grader', async () => {
  const pass = gradeFileCheck({ kind: 'file_matches', path: 'issue.md', contains: 'subscribers' }, [{ name: 'fs_write', input: { path: 'drafts/issue.md', content: 'Hi subscribers' } }]);
  assert.equal(pass.pass, true);
  assert.equal(gradeFileCheck({ kind: 'file_exists', path: 'issue.md' }, []).pass, false);
  assert.equal(verdictOf(0.5, 1, 0.1), 'regress');
  assert.equal(verdictOf(0.95, 1, 0.1), 'pass');
  assert.equal(verdictOf(null, 1, 0.1), 'inconclusive');
  const s = await setup(writerPlan);
  const orgId = await enable(s);
  await withCase(s, orgId);
  await s.evals.addCase(orgId, { roleKey: 'writer', title: 'Pick a subject line', brief: { outcome: 'x', done_when: 'a question-form subject line' }, rubric: 'a question-form subject line' }, 'user');
  const graded: string[] = [];
  s.evals.gradeFn = async ({ snapshot }) => { graded.push(snapshot.title); return { pass: true, detail: 'meets the rubric' }; };
  const run = s.evals.viewRun(await s.evals.run(orgId, { roleKey: 'writer', candidate: await s.evals.normalizeCandidate(orgId, 'writer', { kind: 'charter', after: 'You write the newsletter. BAD habits.' }) }));
  const byCheck = run.results.find((r) => r.gradedBy === 'check')!;
  assert.equal(byCheck.pass, false, 'the BAD charter wrote junk');
  assert.match(byCheck.detail, /does not contain "subscribers"/);
  const byRubric = run.results.find((r) => r.gradedBy === 'rubric')!;
  assert.equal(byRubric.pass, true);
  assert.ok(graded.includes('Pick a subject line') && !graded.includes('Write issue 12'), 'the file-check case never reached the grader');
});

test('the baseline (current configuration) is cached per version hash and reused', async () => {
  const s = await setup(writerPlan);
  const orgId = await enable(s);
  await withCase(s, orgId);
  const cand = await s.evals.normalizeCandidate(orgId, 'writer', { kind: 'charter', after: 'You write the newsletter warmly.' });
  const r1 = await s.evals.run(orgId, { roleKey: 'writer', candidate: cand });
  const r2 = await s.evals.run(orgId, { roleKey: 'writer', candidate: { ...cand, after: 'You write the newsletter briefly.' } });
  const baselines = (await s.evals.runs(orgId, { roleKey: 'writer' })).filter((r) => r.kind === 'baseline');
  assert.equal(baselines.length, 1);
  assert.equal(r1.baselineRunId, r2.baselineRunId);
  assert.equal(r1.verdict, 'pass'); assert.equal(r1.passRate, 1); assert.equal(r1.baselinePassRate, 1);
  await s.org.setTunable(orgId, 'evals.baselineCacheDays', 0, { actor: 'user' });
  await s.evals.run(orgId, { roleKey: 'writer', candidate: cand });
  assert.equal((await s.evals.runs(orgId, { roleKey: 'writer' })).filter((r) => r.kind === 'baseline').length, 2, 'cache off: rerun');
});

test('gated rollout: a charter_change that regresses on the golden set is blocked — the card stays pending with the result attached and the charter unchanged', async () => {
  const s = await setup(writerPlan);
  const orgId = await enable(s);
  await withCase(s, orgId);
  const before = (await s.agents.get(s.writer.id)).charter;
  const a = await s.approvals.create(orgId, { kind: 'charter_change', payload: { agentId: s.writer.id, agentName: 'Writer', before, after: 'You write BAD copy.', lesson: 'shorter' }, requestedBy: `agent:${s.editor.id}`, recommendation: 'from the retro' });
  await assert.rejects(s.approvals.decide(orgId, a.id, 'approve'), /blocked by evals: regress on the "writer" golden set: 0% passed vs 100%/);
  const card = await s.approvals.get(orgId, a.id);
  assert.equal(card.status, 'pending');
  assert.equal(JSON.parse(card.payload).eval.verdict, 'regress');
  assert.equal((await s.agents.get(s.writer.id)).charter, before);
  assert.equal((await s.audit.list(orgId, { action: 'eval_blocked' })).length, 1);
  // asked again with the same candidate: blocked without a rerun
  const runs = (await s.evals.runs(orgId)).length;
  await assert.rejects(s.approvals.decide(orgId, a.id, 'approve'), /blocked by evals/);
  assert.equal((await s.evals.runs(orgId)).length, runs);
});

test('gated rollout: a charter_change that holds on the golden set applies through the existing path', async () => {
  const s = await setup(writerPlan);
  const orgId = await enable(s);
  await withCase(s, orgId);
  const before = (await s.agents.get(s.writer.id)).charter;
  const a = await s.approvals.create(orgId, { kind: 'charter_change', payload: { agentId: s.writer.id, agentName: 'Writer', before, after: `${before}\n\nGreet subscribers by name.`, lesson: 'warmer' }, requestedBy: `agent:${s.editor.id}` });
  const { approval } = await s.approvals.decide(orgId, a.id, 'approve');
  assert.equal(approval.status, 'approved');
  assert.match((await s.agents.get(s.writer.id)).charter, /Greet subscribers by name/);
  assert.equal(JSON.parse(approval.payload).eval.verdict, 'pass');
});

test('budget: the run\'s USD cap is reserved and settled; cases past it are skipped; a run refused by the envelope records why', async () => {
  const s = await setup(writerPlan);
  const orgId = await enable(s);
  for (let i = 0; i < 3; i++) await withCase(s, orgId);
  s.provider.usage = { inputTokens: 1_000_000, outputTokens: 0 }; // $3 per call at the fallback price
  await s.org.setTunable(orgId, 'evals.runUsdCap', 0.05, { actor: 'user' });
  const run = s.evals.viewRun(await s.evals.run(orgId, { roleKey: 'writer', candidate: { kind: 'model', ref: '', before: '', after: 'x-model' } }));
  assert.ok(run.results.some((r) => r.gradedBy === 'skipped' && /USD cap/.test(r.detail)), 'later cases skipped');
  const budgets = await s.org.budgets(orgId);
  assert.ok(budgets.every((b) => b.reservedUsd < 1e-6), 'the reservation is settled');
  await s.org.update(orgId, { monthlyBudgetUsd: 0.01 }, 'user');
  await s.org.setBudget(orgId, { scope: 'company', refId: orgId, monthlyUsd: 0.01 });
  await s.workspaces.update(s.ws.id, { orgMonthlyUsd: 0.01 } as never).catch(() => undefined);
  const refused = await s.evals.run(orgId, { roleKey: 'writer', candidate: { kind: 'model', ref: '', before: '', after: 'y-model' } });
  assert.equal(refused.status, 'failed');
  assert.equal(refused.verdict, 'inconclusive');
  assert.equal((await s.audit.list(orgId, { action: 'eval_refused' })).length, 1);
});

test('org_eval_role (chief) replays a role for a candidate and returns the verdict; org_eval_cases reads the golden set; POST …/evals/run is the CEO\'s', async () => {
  const s = await setup(writerPlan);
  const orgId = await enable(s);
  await withCase(s, orgId);
  const chief = await sessionOf(s, s.chief.id);
  const out = await s.tools.execute(chief, 'org_eval_role', { roleKey: 'writer', candidate: { kind: 'charter', ref: 'Writer', after: 'You write BAD things.' } });
  assert.match(out, /regress on the "writer" golden set/);
  assert.match(out, /a gated rollout would block it/);
  assert.match(await s.tools.execute(chief, 'org_eval_cases', { roleKey: 'writer' }), /Write issue 12/);
  await assert.rejects(s.tools.execute(await sessionOf(s, s.writer.id), 'org_eval_role', { roleKey: 'writer', candidate: { kind: 'model', after: 'm' } }), /chief-of-staff tool/);
  const r = await s.controller.run(s.ws.id, { roleKey: 'writer', candidate: { kind: 'model', after: 'claude-haiku-4-5' } });
  assert.equal(r.verdict, 'pass');
  assert.ok((await s.controller.runs(s.ws.id, 'writer')).length >= 3);
});
