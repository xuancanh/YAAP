/** Task keys (docs/tasks-keys.md): Jira-style ENG-12 names — prefix
 *  derivation and uniqueness, sequential numbers (also under concurrent
 *  creates), the boot backfill (creation order, idempotent), the resolver
 *  (key / id / prefix, ambiguity), and keys in tool outputs and follows. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { runPgMigrations } from '../server/src/database/migrator';
import { orgTasks, orgUnits } from '../server/src/database/schema';
import {
  agentPrefixBase, backfillTaskKeys, functionOfTitle, matchTaskRef, normalizePrefix, normalizeTaskKey, prefixFromName, resolveTaskRef, taskRef, uniquePrefix, unitPrefixBase,
} from '../server/src/common/task-keys';
import { pgliteQueryable } from './helpers';
import { setup, enable, sessionOf } from './org-governance-harness';

const brief = { outcome: 'x', done_when: 'y' };

test('prefix derivation: company name, function codes, titles, agent handles; unique with a number', () => {
  assert.equal(prefixFromName('Jong'), 'JONG');
  assert.equal(prefixFromName('Acme Corp, Inc.'), 'ACME');
  assert.equal(prefixFromName('Research'), 'RES');
  assert.equal(prefixFromName('evidence-lead'), 'EVL');
  assert.equal(prefixFromName('Acme Widget Works'), 'AWW');
  assert.equal(prefixFromName('42'), null);
  assert.equal(unitPrefixBase({ root: true, orgName: 'Jong' }), 'JONG');
  assert.equal(unitPrefixBase({ root: true, orgName: '' }), 'CO');
  assert.equal(unitPrefixBase({ root: false, leadTitle: 'engineering-manager' }), 'ENG');
  assert.equal(unitPrefixBase({ root: false, leadTitle: 'cs-manager' }), 'CS');
  assert.equal(unitPrefixBase({ root: false, leadTitle: 'Head of Sales' }), 'SALES');
  assert.equal(unitPrefixBase({ root: false, leadTitle: 'VP Finance' }), 'FIN');
  assert.equal(unitPrefixBase({ root: false, leadTitle: 'Revenue Operations Lead' }), 'REV');
  assert.equal(unitPrefixBase({ root: false, leadTitle: 'Head of Research', leadName: 'Ava' }), 'RES');
  assert.equal(unitPrefixBase({ root: false, leadTitle: '', leadName: 'Ava' }), 'AVA');
  assert.equal(functionOfTitle('People & HR partner'), 'people');
  assert.equal(agentPrefixBase({ name: 'Evidence Lead', homeDir: 'agents/evidence-lead' }), 'EVL');
  assert.equal(agentPrefixBase({ name: 'Atlas', homeDir: null }), 'ATL');
  assert.equal(uniquePrefix('ENG', ['ENG']), 'ENG2');
  assert.equal(uniquePrefix('SALES', ['SALES', 'SALES2']), 'SALES3');
  assert.equal(uniquePrefix('LEGAL1', ['LEGAL1']), 'LEGAL2');
  assert.equal(normalizePrefix('eng'), 'ENG');
  assert.throws(() => normalizePrefix('1AB'), /2–6 letters/);
  assert.throws(() => normalizePrefix('TOOLONGX'), /2–6 letters/);
});

test('resolver: key in any case, #/[] wrapped, full id, id prefix; zero and ambiguous matches throw', () => {
  const rows = [
    { id: 'b4b81f6f-0000-4000-8000-000000000001', key: 'ENG-1', title: 'A' },
    { id: 'b4b81f6f-0000-4000-8000-000000000002', key: 'ENG-12', title: 'B' },
    { id: '91ef6d61-0000-4000-8000-000000000003', key: null, title: 'C' },
  ];
  assert.equal(resolveTaskRef(rows, 'ENG-12').title, 'B');
  assert.equal(resolveTaskRef(rows, 'eng-1').title, 'A', 'ENG-1 is not a prefix match of ENG-12');
  assert.equal(resolveTaskRef(rows, '#ENG-12').title, 'B');
  assert.equal(resolveTaskRef(rows, '[ENG-12]').title, 'B');
  assert.equal(resolveTaskRef(rows, '91ef6d61').title, 'C');
  assert.equal(resolveTaskRef(rows, rows[1].id).title, 'B');
  assert.throws(() => resolveTaskRef(rows, 'b4b81f6f'), /matches 2 tasks \(ENG-1, ENG-12\) — use the full key/);
  assert.throws(() => resolveTaskRef(rows, 'OPS-3'), /matches 0 tasks — refer to a task by its key/);
  assert.equal(matchTaskRef(rows, 'ENG-012').length, 1, 'leading zeros normalise');
  assert.equal(normalizeTaskKey('eng-007'), 'ENG-7');
  assert.equal(taskRef(rows[2]), '91ef6d61');
});

test('org tasks: sequential keys per board, also under concurrent creates; a moved task keeps its key; tools accept and show keys', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const prefix = root.taskKey!;
  assert.match(prefix, /^[A-Z][A-Z0-9]{1,5}$/);
  const a = await s.tasks.create(orgId, { title: 'First', brief });
  const b = await s.tasks.create(orgId, { title: 'Second', brief });
  assert.equal(a.key, `${prefix}-1`);
  assert.equal(b.key, `${prefix}-2`);
  const many = await Promise.all(Array.from({ length: 12 }, (_, i) => s.tasks.create(orgId, { title: `Parallel ${i}`, brief })));
  const nums = many.map((t) => Number(t.key!.split('-')[1])).sort((x, y) => x - y);
  assert.deepEqual(nums, Array.from({ length: 12 }, (_, i) => i + 3), 'no duplicate, no gap');
  // a function unit: Editor leads Engineering, Writer reports to it
  await s.org.updateMember(orgId, s.editor.id, { title: 'engineering-manager' });
  await s.org.updateMember(orgId, s.writer.id, { reportsToAgentId: s.editor.id });
  await s.units.syncMembership(orgId);
  const eng = (await s.units.units(orgId)).find((u) => u.leadAgentId === s.editor.id)!;
  assert.equal(eng.taskKey, 'ENG');
  const e1 = await s.tasks.create(orgId, { title: 'Ship the API', brief, assigneeAgentId: s.writer.id });
  assert.equal(e1.unitId, eng.id);
  assert.equal(e1.key, 'ENG-1');
  // moved to the company board: keeps ENG-1; the company's numbering goes on
  const moved = await s.tasks.update(orgId, e1.id, { unitId: root.id });
  assert.equal(moved.key, 'ENG-1');
  assert.equal((await s.tasks.create(orgId, { title: 'Next', brief })).key, `${prefix}-15`);
  // the resolver through the service and the tools
  assert.equal((await s.tasks.byPrefix(orgId, 'eng-1')).id, e1.id);
  await assert.rejects(s.tasks.byPrefix(orgId, 'ENG-99'), /matches 0 tasks/);
  const chief = await sessionOf(s, s.chief.id);
  const board = await s.runtime.execute(chief, 'org_read_board', {});
  assert.match(board, /ENG-1 \(\w+\) Ship the API/);
  assert.doesNotMatch(board, /\[[0-9a-f]{8}\]/, 'no hex prefixes on the board');
  const out = await s.runtime.execute(chief, 'org_task_comment', { taskId: 'eng-1', text: 'looks good' });
  assert.ok(out.length > 0);
  // dependencies by key
  const dep = await s.tasks.create(orgId, { title: 'After the API', brief, dependsOn: ['ENG-1'] });
  assert.deepEqual(JSON.parse(dep.dependsOn), [e1.id]);
  // the owner renames the prefix: new tasks take it, old keys stay; another board cannot take a held prefix
  await s.units.setTaskKey(orgId, eng.id, 'api');
  await s.org.updateMember(orgId, s.writer.id, { reportsToAgentId: s.editor.id });
  assert.equal((await s.tasks.create(orgId, { title: 'More', brief, unitId: eng.id })).key, 'API-1');
  assert.equal((await s.tasks.get(orgId, e1.id)).key, 'ENG-1');
  await assert.rejects(s.units.setTaskKey(orgId, root.id, 'ENG'), /taken in this workspace/);
  await assert.rejects(s.units.setTaskKey(orgId, root.id, '9X'), /2–6 letters/);
});

test('agent kanban tasks: per-agent prefix from the handle, sequential, numbers never reused; update_task by key', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Evidence Lead', charter: '', provider: 'anthropic', model: 'x' });
  const t1 = await s.agents.addTask(a.id, { title: 'Collect sources' });
  const t2 = await s.agents.addTask(a.id, { title: 'Summarise' });
  assert.equal(t1.key, 'EVL-1');
  assert.equal(t2.key, 'EVL-2');
  await s.agents.deleteTask(a.id, t2.id);
  assert.equal((await s.agents.addTask(a.id, { title: 'Again' })).key, 'EVL-3', 'a deleted number stays spent');
  const updated = await s.agents.updateTaskByPrefix(a.id, 'evl-1', { status: 'doing' });
  assert.equal(updated.id, t1.id);
  assert.match(await s.agents.tasksForModel(a.id), /^EVL-1 \(doing\) Collect sources/m);
  await assert.rejects(s.agents.updateTaskByPrefix(a.id, 'EVL-9', { status: 'done' }), /matches 0 tasks/);
  // a second agent whose handle derives the same base gets a numbered prefix
  const b = await s.agents.create({ name: 'Evidence Lab', charter: '', provider: 'anthropic', model: 'x' });
  assert.equal((await s.agents.addTask(b.id, { title: 'x' })).key, 'EVL2-1');
});

test('backfill: keys in creation order per board, idempotent; the migration indexes keys uniquely', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  await q.query(`INSERT INTO workspaces ("id", "name", "createdAt") VALUES ('ws1', 'Jong', '2026-01-01T00:00:00Z')`);
  await q.query(`INSERT INTO agents ("id", "name", "workspaceId", "homeDir", "createdAt") VALUES ('ag1', 'Evidence Lead', 'ws1', 'agents/evidence-lead', '2026-01-01T00:00:00Z'), ('ag2', 'Chief', 'ws1', 'agents/chief', '2026-01-01T00:00:00Z')`);
  await q.query(`INSERT INTO organizations ("id", "workspaceId", "name", "chiefOfStaffAgentId", "createdAt") VALUES ('o1', 'ws1', 'Jong', 'ag2', '2026-01-01T00:00:00Z')`);
  await q.query(`INSERT INTO org_units ("id", "orgId", "leadAgentId", "parentUnitId", "name", "slug", "createdAt") VALUES ('u1', 'o1', 'ag2', NULL, 'Jong', 'company', '2026-01-01T00:00:00Z')`);
  // created out of id order: the backfill follows createdAt
  for (const [id, at] of [['t-c', '2026-01-03'], ['t-a', '2026-01-01'], ['t-b', '2026-01-02']]) {
    await q.query(`INSERT INTO org_tasks ("id", "orgId", "title", "unitId", "createdAt", "updatedAt") VALUES ($1, 'o1', $1, 'u1', $2, $2)`, [id, `${at}T00:00:00Z`]);
  }
  await q.query(`INSERT INTO agent_tasks ("id", "agentId", "title", "createdAt", "updatedAt") VALUES ('k2', 'ag1', 'second', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'), ('k1', 'ag1', 'first', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  assert.deepEqual(await backfillTaskKeys(q), { org: 3, agent: 2 });
  const keys = async (table: string) => Object.fromEntries(((await q.query(`SELECT "id", "key" FROM ${table}`)).rows as Array<{ id: string; key: string }>).map((r) => [r.id, r.key]));
  assert.deepEqual(await keys('org_tasks'), { 't-a': 'JONG-1', 't-b': 'JONG-2', 't-c': 'JONG-3' });
  assert.deepEqual(await keys('agent_tasks'), { k1: 'EVL-1', k2: 'EVL-2' });
  assert.deepEqual(await backfillTaskKeys(q), { org: 0, agent: 0 }, 'idempotent');
  await runPgMigrations(q, { log: () => {} });
  assert.deepEqual(await keys('org_tasks'), { 't-a': 'JONG-1', 't-b': 'JONG-2', 't-c': 'JONG-3' });
  // a new row without a key continues the counter
  await q.query(`INSERT INTO org_tasks ("id", "orgId", "title", "unitId", "createdAt", "updatedAt") VALUES ('t-d', 'o1', 'd', 'u1', '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z')`);
  await backfillTaskKeys(q);
  assert.equal((await keys('org_tasks'))['t-d'], 'JONG-4');
  await assert.rejects(q.query(`UPDATE org_tasks SET "key" = 'JONG-1' WHERE "id" = 't-d'`), /unique|duplicate/i);
  await pg.close();
});

test('follows and notifications name the task by key', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const t = await s.tasks.create(orgId, { title: 'Draft the brief', brief, assigneeAgentId: s.writer.id });
  const before = await s.db.select().from(orgTasks).where(eq(orgTasks.id, t.id));
  assert.equal(before[0].key, t.key);
  const root = (await s.db.select().from(orgUnits).where(eq(orgUnits.orgId, orgId)))[0];
  assert.ok(t.key!.startsWith(`${root.taskKey}-`));
  const writer = await sessionOf(s, s.writer.id);
  const text = await s.runtime.execute(writer, 'org_task_update', { taskId: t.key!.toLowerCase(), status: 'in_progress' });
  assert.match(text, new RegExp(`Task ${t.key} updated`));
});
