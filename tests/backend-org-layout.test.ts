/** The workspace tree's one layout (docs/filesystem.md "Layout",
 *  server/src/files/layout.ts): the path helper every writer uses, the
 *  generated indexes under /org/ (README, calendar, rituals, goals, function
 *  READMEs — written only when their text changes, refreshed from the audit
 *  log), the idempotent boot migration of files written under earlier
 *  conventions, and the check that every /org/ path a playbook names fits. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { testDb, memStorage } from './helpers';
import { WorkspaceFs } from '../server/src/files/workspace-fs.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { agents as agentsTable, channelMessages, channels, organizations, orgCadences, orgCheckins, orgGoals, orgMeetings, orgMembers, orgUnits } from '../server/src/database/schema';
import { FUNCTION_IDS, LEDGER_FILES, ORG_ORDER, classifyOrgPath, functionOfRole, legacyTarget, orgPath, quarterLabel, weekLabel, withNumber } from '../server/src/files/layout';
import { cadenceWords } from '../server/src/org/cadence-words';
import { NOTES_MARKER, OrgLayoutService, emptyCycles, partsFor } from '../server/src/org/org-layout.service';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { minutesPathFor } from '../server/src/org/meeting-minutes.service';
import { evalsPath, experimentPath, playbookPath, METRICS_PATH, OUTCOMES_PATH } from '../server/src/org/org-mirror.service';
import { deriveOperatingSystem, seedArtifacts } from '../server/src/org/chief-os';
import { ROLES } from '../server/src/org/roles/catalog';
import { AUTHORED_PACKS } from '../server/src/market/authored-packs.generated';
import { BUILTIN_SKILLS } from '../server/src/skills/builtin-skills';

const NOW = '2026-11-02T09:00:00.000Z';

// ---- the path helper ----

test('the layout helper: one path per kind of file, labels in server-local time, functions named by role id', () => {
  assert.equal(orgPath.minutes('company', '2026-11-02', 'weekly_review'), 'org/meetings/company/2026/2026-11-02-weekly-review.md');
  assert.equal(orgPath.agenda('company', '2026-11-02', 'board'), 'org/meetings/company/2026/2026-11-02-board-agenda.md');
  assert.equal(orgPath.ritual('Ada Lovelace'), 'org/rituals/ada-lovelace.md');
  assert.equal(orgPath.goal({ id: 'abcdef12-3456', title: 'Grow signups!' }), 'org/goals/abcdef12-grow-signups.md');
  assert.equal(orgPath.weeklyReport('2026-11-02'), 'org/reports/2026-W45.md');
  assert.equal(orgPath.monthlyReport('2026-11-02', 'Staffing'), 'org/reports/2026-11-staffing.md');
  assert.equal(orgPath.boardUpdate('2026-11-02'), 'org/reports/2026-11-02-board-update.md');
  assert.equal(orgPath.brief('2026-11-02'), 'org/briefs/2026-11-02.md');
  assert.equal(orgPath.planning('2026-11-02'), 'org/planning/2026-Q4.md');
  assert.equal(orgPath.functionReport('cs', '2026-11-02'), 'org/cs/reports/2026-W45.md');
  assert.equal(orgPath.functionOkrs('ops', '2026-02-10'), 'org/ops/okrs/2026-Q1.md');
  assert.equal(orgPath.functionAudit('finance', '2026-11-02'), 'org/finance/audits/2026-11.md');
  // ISO weeks: the week's year differs from the calendar year around New Year
  assert.equal(weekLabel('2026-01-01'), '2026-W01');
  assert.equal(weekLabel('2027-01-01'), '2026-W53');
  assert.equal(weekLabel('2024-12-30'), '2025-W01');
  assert.equal(quarterLabel('2026-12-31'), '2026-Q4');
  assert.equal(withNumber('org/cs/a.md', 2), 'org/cs/a-2.md');
  // every function folder is a role-id prefix: role, pack and folder agree without a map
  assert.equal(functionOfRole('cs-manager'), 'cs');
  assert.equal(functionOfRole('role:ops-procurement'), 'ops');
  assert.equal(functionOfRole('pack-biz-it-security-manager'), 'it-security');
  assert.equal(functionOfRole('chief-of-staff'), null);
  for (const r of ROLES.filter((x) => x.packId?.startsWith('pack-biz-'))) assert.ok(FUNCTION_IDS.includes(functionOfRole(r.id) ?? ''), `${r.id} has a function folder`);
  // README leads; functions follow the company's own files; mirrors and the archive last
  assert.equal(ORG_ORDER[0], 'README.md');
  assert.ok(ORG_ORDER.indexOf('calendar.md') < ORG_ORDER.indexOf('sales') && ORG_ORDER.indexOf('sales') < ORG_ORDER.indexOf('playbooks'));
});

test('every writer builds its path through the helper: minutes, mirrors, the seeded ledger', () => {
  assert.equal(minutesPathFor({ kind: 'retro', title: 'x', at: '2026-11-02T10:00:00', unitSlug: 'ada' }), orgPath.minutes('ada', new Date('2026-11-02T10:00:00'), 'retro'));
  assert.equal(minutesPathFor({ kind: 'adhoc', title: 'Launch sync', at: '2026-11-02T10:00:00', channelSlug: 'launch' }), 'channels/launch/meetings/2026-11-02-launch-sync.md');
  assert.equal(playbookPath({ id: 'pb-1', name: 'Weekly refund review' }), orgPath.playbook({ id: 'pb-1', name: 'Weekly refund review' }));
  assert.equal(experimentPath({ id: 'exp12345', title: 'X' }), orgPath.experiment({ id: 'exp12345', title: 'X' }));
  assert.equal(evalsPath('support'), orgPath.evals('support'));
  assert.equal(OUTCOMES_PATH, orgPath.outcomes); assert.equal(METRICS_PATH, orgPath.metrics);
  const files = seedArtifacts(deriveOperatingSystem({ values: 'x', size: 2 }), { orgName: 'A', values: {}, owners: [], date: '2026-11-02' });
  assert.deepEqual(files.map((f) => f.path), [...LEDGER_FILES]);
  for (const f of files) assert.ok(classifyOrgPath(f.path), f.path);
});

test('the layout check: placeholders allowed, fixed function subfolders constrained, loose or legacy paths refused', () => {
  for (const ok of ['/org/', '/org/README.md', '/org/calendar.md', '/org/goals/', '/org/rituals/company.md', '/org/meetings/<unit>/<yyyy>/<yyyy-mm-dd>-board-agenda.md',
    '/org/reports/<yyyy>-W<ww>.md', '/org/reports/<yyyy-mm>-staffing.md', '/org/reports/<yyyy-mm-dd>-board-update.md', '/org/briefs/<yyyy-mm-dd>.md', '/org/planning/<yyyy>-Q<n>.md',
    '/org/proposals/<yyyy-mm-dd>-reorg.md', '/org/archive/<yyyy>/<file>.md', '/org/playbooks/', '/org/<function>/reports/', '/org/cs/okrs/<yyyy>-Q<n>.md', '/org/sales/audits/<yyyy-mm>.md',
    '/org/finance/close/<yyyy-mm>/recs/<account>.md', '/org/it-security/access-reviews/<yyyy>-Q<q>/']) assert.ok(classifyOrgPath(ok), ok);
  for (const bad of ['/org/customer/kpis.md', '/org/operations/', '/org/reviews/<date>.md', '/org/meetings/<date>-leadership.md', '/org/staffing/<yyyy-mm>.md',
    '/org/sales/okrs/<cycle>.md', '/org/cs/reports/<date>.md', '/org/plan.md']) assert.equal(classifyOrgPath(bad), null, bad);
  // the migration's mapping is a fixed point on the layout: a moved path never maps again
  for (const placed of ['org/cs/kpis.md', 'org/meetings/company/2026/2026-11-02-standup.md', 'org/reports/2026-W45.md', 'org/README.md', 'org/retro-backlog.md']) assert.equal(legacyTarget(placed, { unitSlugs: ['company'] }), null, placed);
  assert.equal(legacyTarget('org/meetings/2026/2026-11-02-weekly-review-standup.md', { unitSlugs: ['weekly-review'] }), 'org/meetings/weekly-review/2026/2026-11-02-standup.md', 'a known unit slug wins over a kind-shaped name');
  assert.equal(legacyTarget('org/meetings/2026/notes.md'), 'org/meetings/unsorted/2026/notes.md');
});

test('every /org/ path a business playbook or built-in org skill names fits the layout', () => {
  const named = (text: string): string[] => (text.match(/\/org\/[^\s`'"),;*]*/g) ?? []).map((p) => p.replace(/[.:?!]+$/, ''));
  const misfits: string[] = [];
  for (const p of AUTHORED_PACKS) {
    for (const sk of p.skills ?? []) for (const path of named(sk.instructions ?? '')) if (!classifyOrgPath(path)) misfits.push(`${p.id} ${sk.name}: ${path}`);
    for (const l of p.loops ?? []) for (const path of named(l.prompt ?? '')) if (!classifyOrgPath(path)) misfits.push(`${p.id} loop ${l.name}: ${path}`);
    for (const path of named(p.charter ?? '')) if (!classifyOrgPath(path)) misfits.push(`${p.id} charter: ${path}`);
  }
  for (const b of BUILTIN_SKILLS) for (const path of named(b.instructions)) if (!classifyOrgPath(path)) misfits.push(`builtin ${b.name}: ${path}`);
  assert.deepEqual(misfits, []);
  // and the paths are actually used: every function head's playbooks name its own folder
  for (const h of AUTHORED_PACKS.filter((p) => /^pack-biz-.+-manager$/.test(p.id))) {
    const fn = functionOfRole(h.id)!;
    assert.ok((h.skills ?? []).some((s) => s.instructions?.includes(`/org/${fn}/`)), `${h.id} writes under /org/${fn}/`);
  }
});

test('cadences in words, server time: the calendar reads like Home', () => {
  assert.equal(cadenceWords('0 16 * * 5'), 'Fridays at 16:00');
  assert.equal(cadenceWords('30 9 * * 1-5'), 'every weekday at 09:30');
  assert.equal(cadenceWords('0 9 1-7 * 1'), 'first Monday of each month at 09:00');
  assert.equal(cadenceWords('0 8 1 * *'), '1st of each month at 08:00');
  assert.equal(cadenceWords('0 */2 * * *'), 'every 2 hours');
  assert.equal(cadenceWords('0 9 * 3 *'), '0 9 * 3 *');
  assert.equal(emptyCycles([{ minutes: '{"decisions":[],"actions":[]}' }, { minutes: '' }, { minutes: '{"decisions":[{"title":"x"}],"actions":[]}' }, { minutes: '' }]), 2);
  assert.deepEqual(partsFor('cadence_update'), ['rhythm']);
  assert.deepEqual(partsFor('goal_checkin'), ['goals']);
  assert.deepEqual(partsFor('member_add'), ['index', 'rhythm', 'goals']);
  assert.deepEqual(partsFor('task_update'), []);
});

// ---- the generated indexes ----

async function company() {
  const db = await testDb();
  const { stub } = memStorage();
  const fs = new WorkspaceFs(stub, db);
  const ws = await new WorkspacesService(db, stub).create({ name: 'Acme' });
  const orgId = 'org-1';
  await db.insert(organizations).values({ id: orgId, workspaceId: ws.id, name: 'Acme', chiefOfStaffAgentId: 'a-chief', createdAt: NOW });
  for (const [id, name] of [['a-chief', 'Atlas'], ['a-mara', 'Mara'], ['a-sam', 'Sam']]) await db.insert(agentsTable).values({ id, name, workspaceId: ws.id, createdAt: NOW, updatedAt: NOW } as typeof agentsTable.$inferInsert);
  await db.insert(orgMembers).values([
    { id: 'm1', orgId, agentId: 'a-chief', title: 'Chief of staff', joinedAt: NOW },
    { id: 'm2', orgId, agentId: 'a-mara', title: 'Head of Customer', reportsToAgentId: 'a-chief', joinedAt: NOW },
    { id: 'm3', orgId, agentId: 'a-sam', title: 'Customer Success Manager', reportsToAgentId: 'a-mara', joinedAt: NOW },
  ] as Array<typeof orgMembers.$inferInsert>);
  await db.insert(orgUnits).values([
    { id: 'u-root', orgId, leadAgentId: 'a-chief', parentUnitId: null, name: 'Acme', slug: 'company', createdAt: NOW },
    { id: 'u-mara', orgId, leadAgentId: 'a-mara', parentUnitId: 'u-root', name: "Mara's team", slug: 'mara', createdAt: NOW },
  ]);
  await db.insert(orgCadences).values([
    { id: 'c1', orgId, unitId: 'u-root', kind: 'weekly_review', cron: '0 16 * * 5', createdAt: NOW },
    { id: 'c2', orgId, unitId: 'u-root', kind: 'standup', cron: '30 9 * * 1-5', enabled: 0, createdAt: NOW },
    { id: 'c3', orgId, unitId: 'u-mara', kind: 'standup', cron: '30 9 * * 1-5', createdAt: NOW },
  ]);
  await db.insert(orgMeetings).values([
    { id: 'mt1', orgId, unitId: 'u-root', kind: 'weekly_review', title: 'Weekly review · Acme', status: 'done', startedAt: '2026-10-30T16:00:00.000Z', createdAt: '2026-10-30T16:00:00.000Z', minutes: '{"decisions":[],"actions":[]}', minutesPath: 'org/meetings/company/2026/2026-10-30-weekly-review.md', summary: 'Nothing moved.' },
    { id: 'mt0', orgId, unitId: 'u-root', kind: 'weekly_review', title: 'Weekly review · Acme', status: 'done', startedAt: '2026-10-23T16:00:00.000Z', createdAt: '2026-10-23T16:00:00.000Z', minutes: '{"decisions":[{"title":"Ship"}],"actions":[]}' },
  ] as Array<typeof orgMeetings.$inferInsert>);
  await db.insert(orgGoals).values([
    { id: 'g-vision', orgId, kind: 'vision', title: 'Be the friendliest helpdesk', createdAt: NOW },
    { id: 'g-obj12345', orgId, kind: 'objective', title: 'Keep customers', unitId: 'u-mara', ownerAgentId: 'a-mara', createdAt: NOW },
    { id: 'g-kr1', orgId, kind: 'key_result', parentGoalId: 'g-obj12345', title: 'Churn under 2%', metric: 'monthly churn', startValue: 5, currentValue: 3.5, targetValue: 2, unitLabel: '%', confidence: 0.6, createdAt: NOW },
  ] as Array<typeof orgGoals.$inferInsert>);
  await db.insert(orgCheckins).values({ id: 'ck1', orgId, goalId: 'g-kr1', actor: 'agent:a-mara', currentValue: 3.5, confidence: 0.6, note: 'two saves this week', createdAt: NOW });
  const audit = new OrgAuditService(db);
  const layout = new OrgLayoutService(db, fs, undefined, audit);
  layout.debounceMs = 0;
  const text = async (path: string) => (await fs.read(ws.id, path))?.body.toString('utf8') ?? null;
  return { db, fs, ws, orgId, audit, layout, text };
}

test('the generated indexes: README, calendar and rituals from the cadences, goals from the intent tree, function READMEs once', async () => {
  const { orgId, layout, text, fs, ws } = await company();
  const written = await layout.refresh(orgId);
  assert.deepEqual(written.sort(), ['org/README.md', 'org/calendar.md', 'org/cs/README.md', 'org/goals/README.md', 'org/goals/gobj123-keep-customers.md', 'org/rituals/company.md', 'org/rituals/mara.md']);

  const readme = (await text('org/README.md'))!;
  assert.match(readme, /^# Acme — the company folder/);
  assert.match(readme, /\| \/org\/cs\/ \| Customer Success & Support \| Mara \(Head of Customer\) \| Mara's team \(#mara\) \|/);
  assert.match(readme, /\| Acme \(#company\) \| Atlas \| \/org\/rituals\/company\.md \| \/org\/meetings\/company\/ \|/);
  assert.ok(readme.includes(NOTES_MARKER));

  const cal = (await text('org/calendar.md'))!;
  assert.match(cal, /\| Weekly review \| Acme \(#company\) \| Fridays at 16:00 \(`0 16 \* \* 5`\) \| inspect: the scorecard, exceptions only \| CEO \(the chief keeps the record\) \| issues list, follow-ups \| \[2026-10-30\]\(\/org\/meetings\/company\/2026\/2026-10-30-weekly-review\.md\) \| 1 \|/);
  assert.match(cal, /\| Standup \| Acme \(#company\) \| off \|/);
  assert.match(cal, /\| Standup \| Mara's team \(#mara\) \| every weekday at 09:30 .*\| lead of Mara's team \(Mara\) \|.*\| — \| — \|/);

  const rit = (await text('org/rituals/mara.md'))!;
  assert.match(rit, /Attendees: Mara \(lead\), Sam \(Customer Success Manager\), and the people in #mara\./);
  assert.match((await text('org/rituals/company.md'))!, /## Recent minutes\n\n- \[2026-10-30 · Weekly review · Acme\]\(\/org\/meetings\/company\/2026\/2026-10-30-weekly-review\.md\) — Nothing moved\./);

  assert.match((await text('org/goals/README.md'))!, /\*\*Vision\.\*\* Be the friendliest helpdesk/);
  assert.match((await text('org/goals/README.md'))!, /\| Keep customers \| Mara's team \| Mara \| active \| 1 \| 50% \| — \| \[open\]\(\/org\/goals\/gobj123-keep-customers\.md\) \|/);
  const goal = (await text('org/goals/gobj123-keep-customers.md'))!;
  assert.match(goal, /\| Churn under 2% \| monthly churn \| 5 % \| 3\.5 % \| 2 % \| 50% \| 60% \| — \| check-ins \|/);
  assert.match(goal, /### Churn under 2%\n\n- 2026-11-02: 3\.5 % · confidence 60% · Mara — two saves this week/);
  assert.match((await text('org/cs/README.md'))!, /# Customer Success & Support — \/org\/cs\/[\s\S]*Head: Mara \(Head of Customer\)/);

  // nothing changed: nothing is written, versions stay
  assert.deepEqual(await layout.refresh(orgId), []);
  assert.equal((await fs.meta(ws.id, 'org/calendar.md'))?.version, 1);
  assert.equal((await fs.meta(ws.id, 'org/calendar.md'))?.updatedBy.kind, 'system');
});

test('notes below the marker survive a regeneration; a function README is the function\'s once written; a renamed objective leaves no stale file', async () => {
  const { db, orgId, layout, text, fs, ws } = await company();
  // a calendar from before the layout keeps its hand-kept text under the Notes
  await fs.write(ws.id, 'org/calendar.md', Buffer.from('# Review calendar — Acme\n\nPlanning inputs due 1 Dec.\n'), { by: { kind: 'agent', id: 'a-chief', name: 'Atlas' } });
  await layout.refresh(orgId);
  const cal = (await text('org/calendar.md'))!;
  assert.match(cal, /## Notes[\s\S]*### Kept from before this file was generated\n\n#### Review calendar — Acme\n\nPlanning inputs due 1 Dec\./);
  // the chief appends a note; a cadence change regenerates the table and keeps the note
  await fs.append(ws.id, 'org/calendar.md', '- CEO away 10–14 Nov.\n', { by: { kind: 'agent', id: 'a-chief', name: 'Atlas' } });
  await fs.write(ws.id, 'org/cs/README.md', Buffer.from('# Ours\n'), { by: { kind: 'agent', id: 'a-mara', name: 'Mara', home: 'agents/mara' } });
  await db.update(orgCadences).set({ cron: '0 10 * * 3' }).where(eq(orgCadences.id, 'c1'));
  await db.update(orgGoals).set({ title: 'Keep every customer' }).where(eq(orgGoals.id, 'g-obj12345'));
  const again = await layout.refresh(orgId);
  assert.ok(again.includes('org/calendar.md') && again.includes('org/goals/gobj123-keep-every-customer.md'));
  const cal2 = (await text('org/calendar.md'))!;
  assert.match(cal2, /Wednesdays at 10:00/);
  assert.match(cal2, /- CEO away 10–14 Nov\.\n$/);
  assert.equal(await text('org/cs/README.md'), '# Ours\n', 'never over the function\'s own file');
  assert.equal(await text('org/goals/gobj123-keep-customers.md'), null, 'the old title\'s file is gone (kept as a revision)');
});

test('the audit log drives the refresh: a cadence change rewrites the calendar, an unrelated action writes nothing', async () => {
  const { db, orgId, audit, layout, text } = await company();
  await layout.refresh(orgId);
  await audit.append(orgId, { actor: 'system', action: 'task_update', refType: 'task', refId: 't1' });
  await db.update(orgCadences).set({ enabled: 0 }).where(eq(orgCadences.id, 'c3'));
  await layout.idle();
  assert.match((await text('org/calendar.md'))!, /\| Standup \| Mara's team \(#mara\) \| every weekday/, 'not refreshed by an unrelated action');
  await audit.append(orgId, { actor: 'user', action: 'cadence_update', refType: 'cadence', refId: 'c3' });
  await new Promise((r) => setTimeout(r, 5));
  await layout.idle();
  assert.match((await text('org/calendar.md'))!, /\| Standup \| Mara's team \(#mara\) \| off \|/);
});

// ---- the migration ----

test('the boot migration: legacy folders and minutes move with their history, never over a file; stored links follow; a second run moves nothing', async () => {
  const { db, orgId, layout, text, fs, ws } = await company();
  const user = { kind: 'user' as const, id: 'u1', name: 'Owner' };
  const put = (p: string, body: string, by = user) => fs.write(ws.id, p, Buffer.from(body), { by });
  await put('org/customer/kpis.md', 'v1');
  await put('org/customer/kpis.md', 'v2');
  await put('org/operations/sops/refunds.md', 'sop');
  await put('org/meetings/2026/2026-10-30-company-weekly-review.md', 'minutes A');
  await put('org/meetings/2026/2026-10-30-mara-standup-0930.md', 'minutes B');
  await put('org/meetings/2026/2026-10-29-ghost-retro.md', 'minutes C');
  await put('org/meetings/2026-11-03-leadership.md', 'agenda');
  await put('org/reviews/2026-10-30.md', 'pack');
  await put('org/staffing/2026-10.md', 'staffing');
  await put('org/board/2026-10-01-update.md', 'board');
  // a file already at a target: the moved one takes a suffix, the existing one stays
  await put('org/meetings/company/2026/2026-10-30-weekly-review.md', 'already here');
  await put('org/retro-backlog.md', 'loose, not ours to move');
  await db.update(orgMeetings).set({ minutesPath: 'org/meetings/2026/2026-10-30-company-weekly-review.md' }).where(eq(orgMeetings.id, 'mt1'));
  await db.insert(channels).values({ id: 'ch1', workspaceId: ws.id, slug: 'company', name: 'company', createdAt: NOW } as typeof channels.$inferInsert);
  await db.insert(channelMessages).values({ id: 'msg1', channelId: 'ch1', authorKind: 'system', attachments: JSON.stringify([{ path: 'org/meetings/2026/2026-10-30-company-weekly-review.md', kind: 'file' }]), createdAt: NOW });

  const r = await layout.migrate(orgId);
  assert.equal(r.failed, 0);
  assert.deepEqual(Object.fromEntries(r.moved), {
    'org/customer/kpis.md': 'org/cs/kpis.md',
    'org/operations/sops/refunds.md': 'org/ops/sops/refunds.md',
    'org/meetings/2026/2026-10-30-company-weekly-review.md': 'org/meetings/company/2026/2026-10-30-weekly-review-2.md',
    'org/meetings/2026/2026-10-30-mara-standup-0930.md': 'org/meetings/mara/2026/2026-10-30-standup-0930.md',
    'org/meetings/2026/2026-10-29-ghost-retro.md': 'org/meetings/ghost/2026/2026-10-29-retro.md',
    'org/meetings/2026-11-03-leadership.md': 'org/meetings/company/2026/2026-11-03-board-agenda.md',
    'org/reviews/2026-10-30.md': 'org/reports/2026-W44.md',
    'org/staffing/2026-10.md': 'org/reports/2026-10-staffing.md',
    'org/board/2026-10-01-update.md': 'org/reports/2026-10-01-board-update.md',
  });
  // nothing left behind; nothing overwritten; the loose file stays
  assert.equal((await fs.list(ws.id, 'org/customer')).length, 0);
  assert.equal((await fs.list(ws.id, 'org/operations')).length, 0);
  assert.equal(await text('org/meetings/company/2026/2026-10-30-weekly-review.md'), 'already here');
  assert.equal(await text('org/meetings/company/2026/2026-10-30-weekly-review-2.md'), 'minutes A');
  assert.equal(await text('org/retro-backlog.md'), 'loose, not ours to move');
  // metadata and revisions follow the file
  const meta = await fs.meta(ws.id, 'org/cs/kpis.md');
  assert.equal(meta?.version, 2);
  assert.deepEqual((await fs.revisions(ws.id, 'org/cs/kpis.md')).map((x) => x.version), [1]);
  assert.equal((await fs.revision(ws.id, 'org/cs/kpis.md', 1))?.toString(), 'v1');
  // the links the server stored follow
  assert.equal((await db.select().from(orgMeetings).where(eq(orgMeetings.id, 'mt1')))[0].minutesPath, 'org/meetings/company/2026/2026-10-30-weekly-review-2.md');
  assert.deepEqual(JSON.parse((await db.select().from(channelMessages).where(eq(channelMessages.id, 'msg1')))[0].attachments), [{ path: 'org/meetings/company/2026/2026-10-30-weekly-review-2.md', kind: 'file' }]);
  // idempotent
  assert.deepEqual(await layout.migrate(orgId), { moved: [], failed: 0 });
  // and the boot job runs both steps, never throwing
  const boot = await layout.bootAll();
  assert.equal(boot.moved, 0);
  assert.ok(boot.written > 0);
});
