/** The company's records mirrored as files under /org/ (docs/filesystem.md
 *  "Mirrored company records"): playbooks, experiments with their
 *  predictions, a role's evals, metrics, outcomes; the hooks the persisting
 *  services call; and the boot backfill — idempotent, never throwing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, memStorage } from './helpers';
import { WorkspaceFs } from '../server/src/files/workspace-fs.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { agents as agentsTable, organizations, orgEvalCases, orgEvalRuns, orgExperiments, orgMetricSamples, orgMetricSources, orgPlaybooks, orgPredictions } from '../server/src/database/schema';
import { OrgMirrorService, experimentPath, playbookPath, renderOutcomes, slugify, type OutcomeRow } from '../server/src/org/org-mirror.service';
import { OrgPlaybooksService } from '../server/src/org/org-playbooks.service';
import type { OrgService } from '../server/src/org/org.service';
import type { OrgTasksService } from '../server/src/org/org-tasks.service';
import type { OrgAuditService } from '../server/src/org/org-audit.service';
import type { AgentsService } from '../server/src/agents/agents.service';

const NOW = '2026-10-01T09:00:00.000Z';

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const fs = new WorkspaceFs(stub, db);
  const ws = await new WorkspacesService(db, stub).create({ name: 'Acme' });
  const orgId = 'org-1';
  await db.insert(organizations).values({ id: orgId, workspaceId: ws.id, name: 'Acme', createdAt: NOW });
  await db.insert(agentsTable).values({ id: 'agent-ada', name: 'Ada', workspaceId: ws.id, createdAt: NOW, updatedAt: NOW } as typeof agentsTable.$inferInsert);
  const mirror = new OrgMirrorService(db, fs);
  const text = async (path: string) => (await fs.read(ws.id, path))?.body.toString('utf8') ?? null;
  return { db, fs, ws, orgId, mirror, text };
}

async function seed(db: Awaited<ReturnType<typeof testDb>>, orgId: string) {
  await db.insert(orgPlaybooks).values({ id: 'pb-1', orgId, name: 'weekly-refund-review', title: 'Weekly refund review', body: 'Every Monday, pull refunds over $100 and check the reason codes.', roles: '["support"]', status: 'active', version: 2, why: 'refunds leak margin', outcomes: '{"uses":4,"up":3,"down":1,"successRate":0.75}', createdAt: NOW, updatedAt: NOW });
  await db.insert(orgMetricSources).values({ id: 'src-1', orgId, name: 'Signups', kind: 'webhook', unit: 'users', status: 'ok', lastValue: 42, lastFetchedAt: NOW, createdAt: NOW, secrets: '{"token":"do-not-leak"}' });
  await db.insert(orgMetricSamples).values([
    { id: 's-1', sourceId: 'src-1', value: 40, observedAt: '2026-09-30T09:00:00.000Z', fetchedAt: NOW, createdAt: NOW },
    { id: 's-2', sourceId: 'src-1', value: 42, observedAt: NOW, fetchedAt: NOW, createdAt: NOW },
  ]);
  await db.insert(orgExperiments).values({ id: 'exp12345-aaaa', orgId, title: 'Shorter onboarding email', hypothesis: 'Fewer words, more signups', changeKind: 'tunable', change: '{"apply":{"key":"x","value":1}}', metricSourceId: 'src-1', direction: 'up', expectedEffect: 0.2, status: 'running', startedAt: NOW, endsAt: '2026-10-15T09:00:00.000Z', createdAt: NOW });
  await db.insert(orgPredictions).values({ id: 'pr-1', orgId, agentId: 'agent-ada', subjectKind: 'experiment', subjectId: 'exp12345-aaaa', question: 'Signups after the window', forecast: '{"kind":"number","value":50}', createdAt: NOW });
  await db.insert(orgEvalCases).values({ id: 'case-1', orgId, roleKey: 'support', source: 'check', createdAt: NOW });
  await db.insert(orgEvalRuns).values({ id: 'run-1', orgId, roleKey: 'support', kind: 'candidate', candidate: '{"kind":"charter","ref":"agent-ada"}', passRate: 0.9, baselinePassRate: 0.8, verdict: 'pass', requestedBy: 'gate:charter_change:appr-1', startedAt: NOW, endedAt: NOW, status: 'done' });
}

test('each record renders to its small markdown file under /org/', async () => {
  const { db, orgId, mirror, text } = await setup();
  await seed(db, orgId);

  assert.equal(await mirror.writePlaybook(orgId, 'pb-1'), true);
  const pb = await text('org/playbooks/weekly-refund-review.md');
  assert.match(pb!, /^# Weekly refund review/);
  assert.match(pb!, /Status: \*\*active\*\* · version 2 · offered to support/);
  assert.match(pb!, /pull refunds over \$100/);
  assert.match(pb!, /used 4× · 👍 3 · 👎 1 · success 75%/);

  assert.equal(await mirror.writeExperiment(orgId, 'exp12345-aaaa'), true);
  assert.equal(experimentPath({ id: 'exp12345-aaaa', title: 'Shorter onboarding email' }), 'org/experiments/exp12345-shorter-onboarding-email.md');
  const ex = await text('org/experiments/exp12345-shorter-onboarding-email.md');
  assert.match(ex!, /# Experiment: Shorter onboarding email/);
  assert.match(ex!, /Measured by\*\* Signups — up is better · expected \+20%/);
  assert.match(ex!, /## Predictions\n\n- Ada: Signups after the window → 50 · open/);

  assert.equal(await mirror.writeEvals(orgId, 'support'), true);
  const ev = await text('org/evals/support.md');
  assert.match(ev!, /Golden set: \*\*1\*\* active case\(s\) — 1 from checks/);
  assert.match(ev!, /\| charter agent-ada \| 90% \| 80% \| pass \| rollout gate \(charter_change:appr-1\) \|/);

  assert.equal(await mirror.writeMetrics(orgId), true);
  const mx = await text('org/metrics.md');
  assert.match(mx!, /\| Signups \| webhook \| ok \| 42 users \|/);
  assert.match(mx!, /## Signups\n\n- 2026-10-01 09:00: 42 users\n- 2026-09-30 09:00: 40 users/);
  assert.doesNotMatch(mx!, /do-not-leak/);

  const rows: OutcomeRow[] = [{ objectiveId: 'o1', title: 'Grow signups', unitId: null, valueUsd: 120, spentUsd: 40, roi: 3, keyResults: [{ goalId: 'k1', title: 'Weekly signups', measured: true, movement7d: 2, value: 42, target: 100 }] }];
  assert.equal(await mirror.writeOutcomes(orgId, rows), true);
  const oc = await text('org/outcomes.md');
  assert.match(oc!, /## Grow signups\n\nValue \$120\.00 · spent \$40\.00 · ROI 3×/);
  assert.match(oc!, /- Weekly signups: 42 \/ 100 · 7-day movement \+2 \(measured\)/);
  assert.equal(await mirror.writeOutcomes(orgId, []), false, 'no objectives, no file');
});

test('an unchanged record does not write a new version; a change does', async () => {
  const { db, fs, ws, orgId, mirror } = await setup();
  await seed(db, orgId);
  await mirror.writePlaybook(orgId, 'pb-1');
  assert.equal(await mirror.writePlaybook(orgId, 'pb-1'), false);
  const path = playbookPath({ id: 'pb-1', name: 'weekly-refund-review' });
  assert.equal((await fs.meta(ws.id, path))?.version, 1);
  assert.equal((await fs.meta(ws.id, path))?.updatedBy.kind, 'system');
  await db.update(orgPlaybooks).set({ status: 'retired' });
  assert.equal(await mirror.writePlaybook(orgId, 'pb-1'), true);
  assert.equal((await fs.meta(ws.id, path))?.version, 2);
});

test('the persisting service calls the hook: retiring a playbook refreshes its file', async () => {
  const { db, orgId, mirror, text } = await setup();
  await seed(db, orgId);
  const audit = { append: async () => undefined } as unknown as OrgAuditService;
  const playbooks = new OrgPlaybooksService(db, {} as OrgService, {} as OrgTasksService, audit, {} as AgentsService, undefined, undefined, mirror);
  await playbooks.retire(orgId, 'pb-1', 'user', 'superseded');
  await mirror.idle();
  assert.match((await text('org/playbooks/weekly-refund-review.md'))!, /Status: \*\*retired\*\*/);
});

test('a hook failure is logged, never thrown', async () => {
  const { orgId, mirror } = await setup();
  mirror.experimentChanged(orgId, 'missing');
  mirror.outcomesChanged(orgId); // no outcomes source registered
  (mirror as unknown as { writeMetrics: () => Promise<boolean> }).writeMetrics = async () => { throw new Error('bucket down'); };
  mirror.metricsChanged(orgId);
  await mirror.idle();
});

test('the boot backfill mirrors existing rows once and is idempotent', async () => {
  const { db, fs, ws, orgId, mirror } = await setup();
  await seed(db, orgId);
  mirror.setOutcomesSource(async () => renderOutcomesRows());
  assert.equal(await mirror.backfillAll(), 5);
  const paths = (await fs.list(ws.id, 'org/')).map((f) => f.path).sort();
  assert.deepEqual(paths, ['org/evals/support.md', 'org/experiments/exp12345-shorter-onboarding-email.md', 'org/metrics.md', 'org/outcomes.md', 'org/playbooks/weekly-refund-review.md']);
  assert.equal(await mirror.backfillAll(), 0, 'a second boot writes nothing');
  for (const p of paths) assert.equal((await fs.meta(ws.id, p))?.version, 1, p);
  // A broken record does not stop the rest, and nothing throws.
  await db.insert(orgPlaybooks).values({ id: 'pb-2', orgId, name: 'Second one!', title: 'Second', body: 'x'.repeat(30), createdAt: NOW, updatedAt: NOW });
  const original = mirror.writeExperiment.bind(mirror);
  mirror.writeExperiment = async () => { throw new Error('boom'); };
  assert.equal(await mirror.backfill(), 1);
  mirror.writeExperiment = original;
  assert.ok(await fs.read(ws.id, 'org/playbooks/second-one.md'));
});

test('slugs are file-name safe', () => {
  assert.equal(slugify('  Ünïcode & Friends: Q3 / plan!  '), 'unicode-friends-q3-plan');
  assert.equal(slugify('???', 'fallback'), 'fallback');
  assert.ok(renderOutcomes([]).includes('No active objectives yet.'));
});

function renderOutcomesRows(): OutcomeRow[] {
  return [{ objectiveId: 'o1', title: 'Grow signups', unitId: null, valueUsd: 0, spentUsd: 0, roi: null, keyResults: [] }];
}
