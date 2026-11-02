/** The workspace filesystem (docs/filesystem.md): path resolution, the
 *  permission table, versions and conflicts, fs_edit / fs_append, revisions
 *  and restore, move, file.changed events, the agent routes mapped onto the
 *  home, agent homes (handles, rename, move, delete) and the boot migration
 *  of the legacy `agents/<id>/` prefix. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { agents as agentsTable } from '../server/src/database/schema';
import { testDb, memStorage, agentKey } from './helpers';
import { WorkspaceFs, resolvePath, FileConflictError, FilePermissionError, REVISIONS_KEPT, type FsActor } from '../server/src/files/workspace-fs.service';
import { migrateLegacyHomes, handleSlugify } from '../server/src/files/agent-home';
import { WorkspaceEventBus, type WorkspaceEvent } from '../server/src/groupchat/workspace-events';
import { ToolsService } from '../server/src/chats/tools.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentsController } from '../server/src/agents/agents.controller';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { WorkspacesController } from '../server/src/workspaces/workspaces.controller';
import type { TranscriptionService } from '../server/src/voice/transcription.service';

async function setup() {
  const db = await testDb();
  const { stub, map } = memStorage();
  const events = new WorkspaceEventBus();
  const fs = new WorkspaceFs(stub, db, events);
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const ws = await workspaces.create({ name: 'Acme' });
  const tools = new ToolsService(stub, fs);
  const seen: WorkspaceEvent[] = [];
  events.subscribe(ws.id, (e) => seen.push(e));
  return { db, stub, map, fs, agents, workspaces, ws, tools, seen };
}

const user: FsActor = { kind: 'user', id: 'u1', name: 'Uma' };

test('paths resolve like a shell whose cwd is the home', () => {
  const root = { home: 'agents/ada', sharedFolder: 'projects/site' };
  assert.equal(resolvePath(root, 'notes.md'), 'agents/ada/notes.md');
  assert.equal(resolvePath(root, '~/notes.md'), 'agents/ada/notes.md');
  assert.equal(resolvePath(root, '~'), 'agents/ada');
  assert.equal(resolvePath(root, '/org/plan.md'), 'org/plan.md');
  assert.equal(resolvePath(root, '/'), '');
  assert.equal(resolvePath(root, 'shared/x.md'), 'projects/site/x.md');
  assert.equal(resolvePath({ home: 'agents/ada' }, 'shared/x.md'), 'agents/ada/shared/x.md', 'no assignment: shared/ is a plain folder');
  assert.equal(resolvePath({ home: '' }, 'notes.md'), 'notes.md', 'a chat with no agent works at /');
  assert.throws(() => resolvePath(root, '../bob/x.md'), /invalid path/);
  assert.throws(() => resolvePath(root, '/agents/../../ws2/x'), /invalid path/);
  assert.throws(() => resolvePath(root, '/.revisions/abc/1'), /invalid path/);
});

test('the permission table: own home yes, another home and .checkpoints no, artifacts for all', () => {
  const ada: FsActor = { kind: 'agent', id: 'a1', name: 'Ada', home: 'agents/ada' };
  const ok = (actor: FsActor, path: string) => assert.doesNotThrow(() => WorkspaceFs.assertCanWrite(actor, path), path);
  const no = (actor: FsActor, path: string) => assert.throws(() => WorkspaceFs.assertCanWrite(actor, path), FilePermissionError, path);
  ok(ada, 'agents/ada/notes.md');
  no(ada, 'agents/ada/.checkpoints/2026-01-01/LESSONS.md');
  no(ada, 'agents/bob/notes.md');
  ok(ada, 'org/plan.md');
  ok(ada, 'channels/general/notes.md');
  ok(user, 'agents/bob/notes.md');
  no(user, 'agents/bob/.checkpoints/x.md');
  no(user, '.revisions/abc/1');
  ok(WorkspaceFs.system, 'agents/bob/.checkpoints/x.md');
});

test('writes keep versions and authors; expectedVersion refuses a stale write; revisions restore', async () => {
  const { fs, ws, seen, map } = await setup();
  const v1 = await fs.write(ws.id, 'org/plan.md', Buffer.from('one'), { by: user });
  assert.equal(v1.version, 1);
  const bob: FsActor = { kind: 'agent', id: 'b1', name: 'Bob', home: 'agents/bob' };
  const v2 = await fs.write(ws.id, 'org/plan.md', Buffer.from('two'), { by: bob, expectedVersion: 1 });
  assert.equal(v2.version, 2);
  assert.deepEqual((await fs.meta(ws.id, 'org/plan.md'))!.updatedBy, { kind: 'agent', id: 'b1', name: 'Bob' });

  // Uma still holds version 1: refused, with who changed it
  await assert.rejects(fs.write(ws.id, 'org/plan.md', Buffer.from('mine'), { by: user, expectedVersion: 1 }), (err: unknown) => {
    assert.ok(err instanceof FileConflictError);
    assert.equal(err.current?.version, 2);
    assert.match(err.message, /version 2.*Bob/);
    return true;
  });
  // 0 = must not exist yet
  await assert.rejects(fs.write(ws.id, 'org/plan.md', Buffer.from('x'), { by: user, expectedVersion: 0 }), FileConflictError);
  // no expectedVersion = unconditional (the editor's Overwrite)
  assert.equal((await fs.write(ws.id, 'org/plan.md', Buffer.from('three'), { by: user })).version, 3);

  const revs = await fs.revisions(ws.id, 'org/plan.md');
  assert.deepEqual(revs.map((r) => r.version), [2, 1]);
  assert.equal(revs[0].updatedBy.name, 'Bob', 'a revision carries the author of that version');
  assert.equal((await fs.revision(ws.id, 'org/plan.md', 1))!.toString(), 'one');
  assert.ok([...map.keys()].some((k) => k.startsWith(`workspaces/${ws.id}/.revisions/`)));
  assert.ok(!(await fs.list(ws.id)).some((f) => f.path.startsWith('.revisions')), 'revisions never list');

  const restored = await fs.restore(ws.id, 'org/plan.md', 1, { by: user });
  assert.equal(restored.version, 4);
  assert.equal((await fs.read(ws.id, 'org/plan.md'))!.body.toString(), 'one');
  assert.deepEqual((await fs.revisions(ws.id, 'org/plan.md')).map((r) => r.version), [3, 2, 1], 'the restore is undoable');

  const changed = seen.filter((e) => e.type === 'file.changed');
  assert.deepEqual(changed.map((e) => e.type === 'file.changed' && e.version), [1, 2, 3, 4]);
  assert.deepEqual(changed[1].type === 'file.changed' && changed[1].by, { kind: 'agent', id: 'b1', name: 'Bob' });
});

test('revisions are pruned to the newest twenty', async () => {
  const { fs, ws } = await setup();
  for (let i = 0; i < REVISIONS_KEPT + 5; i++) await fs.write(ws.id, 'log.md', Buffer.from(`v${i}`), { by: user });
  const revs = await fs.revisions(ws.id, 'log.md');
  assert.equal(revs.length, REVISIONS_KEPT);
  assert.equal(revs.at(-1)!.version, 5);
  assert.equal(await fs.revision(ws.id, 'log.md', 1), null);
});

test('fs tools: version header, fs_edit, fs_append, conflicts, absolute output, permissions', async () => {
  const { tools, agents, ws, map } = await setup();
  const ada = await agents.create({ name: 'Ada', workspaceId: ws.id });
  const bob = await agents.create({ name: 'Bob', workspaceId: ws.id });
  const rootOf = (a: typeof ada) => ({ workspaceId: ws.id, home: a.homeDir!, actor: { kind: 'agent' as const, id: a.id, name: a.name, home: a.homeDir! } });
  const asAda = rootOf(ada);
  const asBob = rootOf(bob);

  assert.match(await tools.execute(asAda, 'fs_write', { path: '/org/plan.md', content: 'Goal: ship\nOwner: tbd\n' }), /wrote \d+ bytes to \/org\/plan\.md \(version 1\)/);
  const read = await tools.execute(asBob, 'fs_read', { path: '/org/plan.md' });
  assert.match(read, /^\[version 1 · last edited by Ada, just now\]\nGoal: ship/);

  assert.match(await tools.execute(asBob, 'fs_edit', { path: '/org/plan.md', old: 'Owner: tbd', new: 'Owner: Bob', expectedVersion: 1 }), /now version 2/);
  assert.equal(map.get(`workspaces/${ws.id}/org/plan.md`)!.toString(), 'Goal: ship\nOwner: Bob\n');
  await assert.rejects(tools.execute(asAda, 'fs_edit', { path: '/org/plan.md', old: 'Goal: ship', new: 'Goal: wait', expectedVersion: 1 }), /version conflict.*version 2.*Bob/);
  await assert.rejects(tools.execute(asAda, 'fs_edit', { path: '/org/plan.md', old: 'nope', new: 'x' }), /not found/);
  await tools.execute(asAda, 'fs_append', { path: '/org/plan.md', content: 'o' });
  await tools.execute(asAda, 'fs_append', { path: '/org/plan.md', content: 'o' });
  await assert.rejects(tools.execute(asAda, 'fs_edit', { path: '/org/plan.md', old: 'o', new: 'x' }), /occurs \d+ times/);
  await tools.execute(asAda, 'fs_append', { path: '/org/log.md', content: 'first' });
  await tools.execute(asBob, 'fs_append', { path: '/org/log.md', content: 'second' });
  assert.equal(map.get(`workspaces/${ws.id}/org/log.md`)!.toString(), 'first\nsecond');

  // relative = home; the home is the agent's own
  await tools.execute(asAda, 'fs_write', { path: 'draft.md', content: 'mine' });
  assert.ok(map.has(agentKey(ada, 'draft.md')));
  await assert.rejects(tools.execute(asBob, 'fs_write', { path: `/${ada.homeDir}/draft.md`, content: 'hijack' }), /another agent's home/);
  await assert.rejects(tools.execute(asBob, 'fs_delete', { path: `/${ada.homeDir}/draft.md` }), /another agent's home/);
  assert.equal(await tools.execute(asBob, 'fs_read', { path: `/${ada.homeDir}/draft.md` }).then((t) => t.split('\n')[1]), 'mine', 'but may read it');
  await assert.rejects(tools.execute(asAda, 'fs_write', { path: '.checkpoints/2026-01-01/LESSONS.md', content: 'tamper' }), /read-only/);

  // listing: home by default, top level collapsed at /
  assert.match(await tools.execute(asAda, 'fs_list', {}), new RegExp(`^/${ada.homeDir}/`, 'm'));
  const top = await tools.execute(asAda, 'fs_list', { prefix: '/' });
  assert.match(top, /^\/agents\/ \(\d+ files\) — your home is inside$/m);
  assert.match(top, /^\/org\/ \(2 files\)$/m);
  assert.match(await tools.execute(asAda, 'fs_list', { prefix: '/org' }), /\/org\/plan\.md \(\d+ bytes\) · v4 · Ada/);
  assert.match(await tools.execute(asAda, 'fs_search', { query: 'second', prefix: '/' }), /\/org\/log\.md:2: second/);
  assert.equal(tools.isReadOnly('fs_edit'), false);
  assert.equal(tools.isReadOnly('fs_append'), false);
});

test('agent homes: unique handles per workspace, stable on rename, seeded, moved and deleted with the agent', async () => {
  const { agents, workspaces, ws, map, db, stub } = await setup();
  assert.equal(handleSlugify('Fieldy, the Scout!'), 'fieldy-the-scout');
  const a = await agents.create({ name: 'Ada', workspaceId: ws.id });
  const b = await agents.create({ name: 'ada', workspaceId: ws.id });
  const c = await agents.create({ name: 'ADA!', workspaceId: ws.id, homeDir: 'elsewhere' });
  assert.deepEqual([a.homeDir, b.homeDir, c.homeDir], ['agents/ada', 'agents/ada-2', 'agents/ada-3']);
  const other = await workspaces.create({ name: 'Other' });
  assert.equal((await agents.create({ name: 'Ada', workspaceId: other.id })).homeDir, 'agents/ada', 'unique per workspace, not globally');
  assert.ok(map.has(agentKey(a, 'LESSONS.md')) && map.has(agentKey(a, 'knowledge/README.md')), 'the brain is seeded in the home');

  await agents.update(a.id, { name: 'Ada Lovelace', homeDir: 'hijack' } as never);
  assert.equal((await agents.get(a.id)).homeDir, 'agents/ada', 'kept on rename; not settable');

  await agents.appendJournal(a.id, 'did a thing');
  assert.match(map.get(agentKey(a, 'JOURNAL.md'))!.toString(), /did a thing/);

  // the move takes the home along (a fresh handle there: ada is taken)
  const fs = new WorkspaceFs(stub, db);
  await fs.write(ws.id, `${a.homeDir}/notes.md`, Buffer.from('n'), { by: user });
  const moved = await agents.move(a.id, other.id);
  assert.equal(moved.homeDir, 'agents/ada-lovelace');
  assert.equal(map.get(agentKey(moved, 'notes.md'))!.toString(), 'n');
  assert.ok(![...map.keys()].some((k) => k.startsWith(`workspaces/${ws.id}/agents/ada/`)), 'nothing left behind');
  assert.equal(await fs.meta(ws.id, 'agents/ada/notes.md'), null, 'metadata of the old home is dropped');

  await agents.remove(moved.id);
  assert.ok(![...map.keys()].some((k) => k.startsWith(`workspaces/${other.id}/agents/ada-lovelace/`)), 'delete removes the home');

  // removing a workspace re-homes its agents' homes too
  await workspaces.remove(ws.id);
  const bAfter = await agents.get(b.id);
  assert.equal(bAfter.workspaceId, other.id);
  assert.ok(map.has(agentKey(bAfter, 'LESSONS.md')), 'the home survived its workspace');
});

test('boot migration moves legacy agents/<id>/ brains into homes, idempotently', async () => {
  const { db, stub, map, ws } = await setup();
  const id = 'legacy-1';
  await db.insert(agentsTable).values({ id, workspaceId: ws.id, name: 'Old Timer', homeDir: `agents/${id}`, createdAt: new Date().toISOString() });
  await db.insert(agentsTable).values({ id: 'legacy-2', workspaceId: ws.id, name: 'Old Timer', homeDir: null, createdAt: new Date().toISOString() });
  await db.insert(agentsTable).values({ id: 'homeless', workspaceId: '', name: 'Nomad', homeDir: null, createdAt: new Date().toISOString() });
  map.set(`agents/${id}/LESSONS.md`, Buffer.from('lessons'));
  map.set(`agents/${id}/apps/app1/state.json`, Buffer.from('{}'));
  map.set('agents/legacy-2/JOURNAL.md', Buffer.from('j'));
  map.set('agents/homeless/LESSONS.md', Buffer.from('stays'));

  const logs: string[] = [];
  const res = await migrateLegacyHomes(db, stub, (m) => logs.push(m));
  assert.deepEqual(res, { agents: 2, files: 3, failed: 0 });
  assert.match(logs[0], /moved 2 agent home/);
  const [one] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  const [two] = await db.select().from(agentsTable).where(eq(agentsTable.id, 'legacy-2'));
  assert.deepEqual([one.homeDir, two.homeDir].sort(), ['agents/old-timer', 'agents/old-timer-2']);
  assert.equal(map.get(agentKey(one, 'LESSONS.md'))!.toString(), 'lessons');
  assert.ok(map.has(agentKey(one, 'apps/app1/state.json')));
  assert.ok(!map.has(`agents/${id}/LESSONS.md`), 'the old prefix is gone');
  assert.equal(map.get('agents/homeless/LESSONS.md')!.toString(), 'stays', 'no workspace, no move');

  assert.deepEqual(await migrateLegacyHomes(db, stub, () => {}), { agents: 0, files: 0, failed: 0 }, 'idempotent');
});

test('routes: workspace writes 409 on conflict, list carries version/owner, move and revisions; agent routes map to the home', async () => {
  const { stub, fs, agents, workspaces, ws, map } = await setup();
  const ctrl = new WorkspacesController(workspaces, stub, {} as TranscriptionService, fs);
  const put = (path: string, text: string, expectedVersion?: number) => ctrl.putFile(ws.id, { path, contentBase64: Buffer.from(text).toString('base64'), expectedVersion });
  assert.equal((await put('/org/a.md', 'one')).version, 1);
  assert.equal((await put('org/a.md', 'two', 1)).version, 2);
  await assert.rejects(put('org/a.md', 'stale', 1), (err: unknown) => {
    assert.ok(err instanceof ConflictException);
    const body = err.getResponse() as { currentVersion: number; updatedBy: { kind: string } };
    assert.equal(body.currentVersion, 2);
    assert.equal(body.updatedBy.kind, 'user');
    return true;
  });
  await put('org/.keep', '');
  const preview = await ctrl.preview(ws.id, 'org/a.md');
  assert.equal(preview.version, 2);
  assert.equal(preview.updatedBy?.kind, 'user');

  const ada = await agents.create({ name: 'Ada', workspaceId: ws.id });
  const list = await ctrl.listFiles(ws.id);
  assert.equal(list.find((f) => f.path === 'org/a.md')?.version, 2);
  assert.deepEqual(list.find((f) => f.path === `${ada.homeDir}/LESSONS.md`)?.owner, { agentId: ada.id });

  assert.deepEqual((await ctrl.revisions(ws.id, 'org/a.md')).map((r) => r.version), [1]);
  assert.equal((await ctrl.revision(ws.id, 'org/a.md', '1')).text, 'one');
  assert.equal((await ctrl.restore(ws.id, { path: 'org/a.md', version: 1 })).version, 3);
  assert.equal((await ctrl.move(ws.id, { from: 'org', to: 'company' })).moved, 2);
  assert.equal(map.get(`workspaces/${ws.id}/company/a.md`)!.toString(), 'one');
  assert.equal((await fs.meta(ws.id, 'company/a.md'))?.version, 3, 'metadata follows the move');
  assert.deepEqual((await fs.revisions(ws.id, 'company/a.md')).map((r) => r.version), [2, 1], 'so do revisions');
  await assert.rejects(ctrl.deleteFile(ws.id, `${ada.homeDir}/.checkpoints/x.md`), ForbiddenException);

  // the agent routes speak home-relative paths onto the same tree
  const actl = new AgentsController(agents, stub, {} as never, {} as never, {} as never, {} as never, fs);
  await actl.putFile(ada.id, { path: 'notes.md', contentBase64: Buffer.from('hi').toString('base64') });
  assert.ok(map.has(agentKey(ada, 'notes.md')));
  const files = await actl.listFiles(ada.id);
  assert.ok(files.some((f) => f.path === 'notes.md' && f.version === 1));
  assert.equal((await actl.preview(ada.id, 'notes.md')).text, 'hi');
  await actl.deleteFile(ada.id, 'notes.md');
  assert.ok(!map.has(agentKey(ada, 'notes.md')));
});
