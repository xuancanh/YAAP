/** The plugin registry and Foundry's Plugins shelf (docs/plugins.md §6.8,
 *  §7, §8; docs/foundry.md §8, §9): first-party sync with the registry's
 *  own conformance per interface version, publishing (dry run first,
 *  semver, immutable versions, pinned digest, namespace → tier, community
 *  floors), the community opt-ins, updates with the permission diff,
 *  recall freezing installs through the registrar, the local folder path
 *  (no scripts, no symlinks, no executable bits, visible to one workspace)
 *  and the Foundry index and kit previews. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { testDb, memStorage, pgliteQueryable } from './helpers';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { PluginAuditService } from '../server/src/plugins/plugin-audit';
import { PluginsService } from '../server/src/plugins/plugins.service';
import { PluginRegistryService } from '../server/src/plugins/plugin-registry.service';
import { FoundryController, SHELVES } from '../server/src/foundry/foundry.controller';
import { KIT_PREVIEWS } from '../server/src/foundry/kits.catalog';
import { interfaceBindings, interfaceProviders, pluginAudit, pluginEffects, pluginInstalls, pluginVersions, registryItems } from '../server/src/database/schema';
import { runWithViewer } from '../server/src/accounts/account-context';
import { runPgMigrations } from '../server/src/database/migrator';

const ciText = readFileSync('plugins/first-party/ci/plugin.json', 'utf8');
const ciSuite = readFileSync('plugins/first-party/ci/conformance/ci/suite.json', 'utf8');

/** A community interface: the ci contract renamed, so no first-party name is claimed. */
function tickIface(version = '1.0.0', patch: (m: Record<string, any>) => void = () => {}) {
  const m = JSON.parse(ciText);
  m.id = 'tick@community';
  m.name = 'Tick (interface)';
  m.version = version;
  m.publisher = { id: 'acme', name: 'Acme' };
  m.interfaces[0].name = 'tick';
  m.interfaces[0].version = version;
  patch(m);
  return { manifest: m, files: { 'conformance/ci/suite.json': ciSuite.replace('"ci@1.0.0"', `"tick@${version}"`) } };
}

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const workspaces = new WorkspacesService(db, stub);
  const audit = new PluginAuditService(db);
  const plugins = new PluginsService(db, audit);
  const registry = new PluginRegistryService(db, plugins, audit);
  const ws = (await workspaces.list())[0];
  return { db, workspaces, audit, plugins, registry, ws };
}
type S = Awaited<ReturnType<typeof setup>>;
const asMember = <T>(s: S, fn: () => T) => runWithViewer('single', { memberAccountId: 'm2', role: 'member', workspaceId: s.ws.id, displayName: 'M' }, fn);

test('first-party packages are on the shelf with their tier, roles and the registry\'s conformance per interface version', async () => {
  const s = await setup();
  const shelf = await s.registry.list(s.ws.id);
  const ids = shelf.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['ci@yaam', 'scm-mock@yaam', 'scm@yaam']);
  for (const i of shelf.items) { assert.equal(i.tier, 'first_party'); assert.equal(i.installable, true); assert.equal(i.installed, null); }
  const mock = shelf.items.find((i) => i.id === 'scm-mock@yaam')!;
  assert.deepEqual(mock.roles, ['provider']);
  assert.deepEqual(mock.conformance.map((c) => `${c.interface}@${c.interfaceVersion}:${c.result}`).sort(), ['ci@1.0.0:pass', 'scm@1.0.0:pass']);
  assert.equal(mock.noEgress, true);
  // Filters: role, interface, tier, search; facets count what the shelf holds.
  assert.deepEqual((await s.registry.list(s.ws.id, { role: 'provider' })).items.map((i) => i.id), ['scm-mock@yaam']);
  assert.deepEqual((await s.registry.list(s.ws.id, { iface: 'ci' })).items.map((i) => i.id).sort(), ['ci@yaam', 'scm-mock@yaam']);
  assert.equal((await s.registry.list(s.ws.id, { tier: 'community' })).items.length, 0);
  assert.deepEqual((await s.registry.list(s.ws.id, { q: 'mock forge' })).items.map((i) => i.id), ['scm-mock@yaam']);
  assert.equal(shelf.facets.tiers.first_party, 3);
  assert.deepEqual(shelf.facets.interfaces.map((f) => `${f.name}:${f.defined}:${f.providers}`), ['ci:true:1', 'scm:true:1']);
  // Detail: operations with their effective classes, versions with the pin, the install source.
  const d = await s.registry.detail(s.ws.id, 'ci@yaam');
  assert.equal(d.capabilities!.defines[0].name, 'ci');
  const rerun = d.capabilities!.defines[0].operations.find((o) => o.op === 'rerun')!;
  assert.equal(rerun.effectiveClass, 'external_reversible');
  assert.equal(d.versions.length, 1);
  assert.match(d.versions[0].digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(d.installSource, { firstParty: 'ci@yaam' });
  assert.ok(d.related.some((r) => r.id === 'scm-mock@yaam'), 'the interface page lists its providers');
  const md = await s.registry.detail(s.ws.id, 'scm-mock@yaam');
  assert.ok(md.capabilities!.provides.every((p) => p.operations.length > 0 && p.missingRequired.length === 0));
});

test('publishing: dry run writes nothing; then a listed community version pinned by digest, mirrored as registry kind plugin', async () => {
  const s = await setup();
  const pkg = tickIface();
  const dry = await s.registry.publish(s.ws.id, { ...pkg, dryRun: true, commitSha: 'a'.repeat(40) });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.tier, 'community');
  assert.deepEqual(dry.blockers, []);
  assert.equal(dry.capabilities.defines[0].name, 'tick');
  assert.equal((await s.db.select().from(pluginVersions).where(eq(pluginVersions.pluginId, 'tick@community'))).length, 0, 'a dry run writes nothing');
  const pub = await s.registry.publish(s.ws.id, { ...pkg, commitSha: 'a'.repeat(40), changelog: 'First.' });
  assert.equal(pub.published, true);
  const [v] = await s.db.select().from(pluginVersions).where(eq(pluginVersions.pluginId, 'tick@community'));
  assert.equal(v.archiveSha256, pub.digest);
  assert.equal(v.commitSha, 'a'.repeat(40));
  assert.equal(v.source, 'community');
  const [item] = await s.db.select().from(registryItems).where(eq(registryItems.kind, 'plugin'));
  assert.equal(item.slug, 'tick-community');
  assert.equal(JSON.parse(item.manifest).digest, pub.digest);
  assert.ok((await s.db.select().from(pluginAudit)).some((a) => a.action === 'plugin_published'));
  const listed = (await s.registry.list(s.ws.id, { tier: 'community' })).items;
  assert.deepEqual(listed.map((i) => i.id), ['tick@community']);
  // Republishing the same bytes is a no-op; the same version with other bytes is refused; versions only go up.
  assert.equal((await s.registry.publish(s.ws.id, pkg)).published, false);
  await assert.rejects(s.registry.publish(s.ws.id, tickIface('1.0.0', (m) => { m.description = 'changed'; })), (e: any) => JSON.stringify(e.response).includes('versions are immutable'));
  await s.registry.publish(s.ws.id, tickIface('1.2.0'));
  await assert.rejects(s.registry.publish(s.ws.id, tickIface('1.1.0')), (e: any) => JSON.stringify(e.response).includes('older than the newest published version 1.2.0'));
  const detail = await s.registry.detail(s.ws.id, 'tick@community');
  assert.deepEqual(detail.versions.map((x) => x.version), ['1.2.0', '1.0.0']);
});

test('publishing refuses the first-party and local namespaces, unsigned verified publishers, community floors, a moving source pin, and non-owners', async () => {
  const s = await setup();
  const ns = (id: string) => tickIface('1.0.0', (m) => { m.id = id; });
  const blockersOf = async (input: Parameters<PluginRegistryService['publish']>[1]) => (await s.registry.publish(s.ws.id, { ...input, dryRun: true })).blockers.join(' | ');
  assert.match(await blockersOf(ns('tick@yaam')), /first-party only/);
  assert.match(await blockersOf(ns('tick@local')), /loads in one workspace/);
  assert.match(await blockersOf(ns('tick@acme')), /verified publisher namespace/);
  assert.match(await blockersOf({ ...tickIface(), commitSha: 'main' }), /never a name that can move/);
  const fixtureProvider = JSON.parse(readFileSync('plugins/first-party/scm-mock/plugin.json', 'utf8'));
  fixtureProvider.id = 'forge-mock@community';
  fixtureProvider.publisher = { id: 'acme', name: 'Acme' };
  const files = { 'fixtures/scm.json': readFileSync('plugins/first-party/scm-mock/fixtures/scm.json', 'utf8'), 'fixtures/ci.json': readFileSync('plugins/first-party/scm-mock/fixtures/ci.json', 'utf8') };
  assert.match(await blockersOf({ manifest: fixtureProvider, files }), /fixture implementations are for first-party and local providers only/);
  await assert.rejects(s.registry.publish(s.ws.id, ns('tick@yaam')), (e: any) => JSON.stringify(e.response).includes('publish refused'));
  await assert.rejects(asMember(s, () => s.registry.publish(s.ws.id, tickIface())), /only the workspace owner/);
  // The loader's archive rules hold for published packages too.
  await assert.rejects(s.registry.publish(s.ws.id, { ...tickIface(), files: { ...tickIface().files, 'run.sh': 'echo hi' } }), (e: any) => JSON.stringify(e.response).includes('scripts and binaries are refused'));
});

test('a community plugin installs only with the owner\'s opt-in, and a community interface also needs the workspace opt-in', async () => {
  const s = await setup();
  await s.registry.publish(s.ws.id, tickIface());
  const review = await s.plugins.review(s.ws.id, { registry: { id: 'tick@community' } });
  assert.equal(review.tier, 'community');
  assert.equal(review.communityOptIn, true);
  assert.ok(review.blockers.some((b) => b.includes('community-interface opt-in')), 'the interface needs plugins.allowCommunityInterfaces');
  await assert.rejects(s.plugins.install(s.ws.id, { registry: { id: 'tick@community' } }, { confirm: true, acceptCommunity: true }), (e: any) => JSON.stringify(e.response).includes('community-interface opt-in'));
  await s.plugins.setWorkspaceSettings(s.ws.id, { allowCommunityInterfaces: true });
  await assert.rejects(s.plugins.install(s.ws.id, { registry: { id: 'tick@community' } }, { confirm: true }), (e: any) => JSON.stringify(e.response).includes('explicit opt-in'));
  await assert.rejects(asMember(s, () => s.plugins.install(s.ws.id, { registry: { id: 'tick@community' } }, { confirm: true, acceptCommunity: true })), /only the workspace owner/);
  const r = await s.plugins.install(s.ws.id, { registry: { id: 'tick@community' } }, { confirm: true, acceptCommunity: true });
  assert.equal(r.installed, true);
  const shelf = (await s.registry.list(s.ws.id, { tier: 'community' })).items[0];
  assert.equal(shelf.installs, 1);
  assert.equal(shelf.installed?.version, '1.0.0');
});

test('a registry version installs only when its stored bytes still match the pinned digest', async () => {
  const s = await setup();
  await s.registry.publish(s.ws.id, tickIface());
  await s.plugins.setWorkspaceSettings(s.ws.id, { allowCommunityInterfaces: true });
  const [v] = await s.db.select().from(pluginVersions).where(eq(pluginVersions.pluginId, 'tick@community'));
  const files = JSON.parse(v.files);
  files['conformance/ci/suite.json'] = files['conformance/ci/suite.json'].replace('list-then-read', 'list-then-read-2');
  await s.db.update(pluginVersions).set({ files: JSON.stringify(files) }).where(eq(pluginVersions.id, v.id));
  await assert.rejects(s.plugins.review(s.ws.id, { registry: { id: 'tick@community' } }), /does not match its pinned digest/);
});

test('updates list newer versions with the permission diff; widening waits, a no-widening update applies', async () => {
  const s = await setup();
  await s.plugins.setWorkspaceSettings(s.ws.id, { allowCommunityInterfaces: true });
  await s.registry.publish(s.ws.id, tickIface('1.0.0'));
  await s.plugins.install(s.ws.id, { registry: { id: 'tick@community', version: '1.0.0' } }, { confirm: true, acceptCommunity: true });
  assert.deepEqual((await s.registry.updates(s.ws.id, 'tick@community')).updates, []);
  // 1.0.1 only reworded; 1.1.0 adds an operation (widening).
  await s.registry.publish(s.ws.id, tickIface('1.0.1', (m) => { m.description = 'Reworded.'; }));
  await s.registry.publish(s.ws.id, tickIface('1.1.0', (m) => {
    m.interfaces[0].operations.annotate = { ...m.interfaces[0].operations.rerun, required: false, semantics: 'Attach a note to a run.' };
  }));
  const u = await s.registry.updates(s.ws.id, 'tick@community');
  assert.deepEqual(u.updates.map((x) => x.version).sort(), ['1.0.1', '1.1.0']);
  const wide = u.updates.find((x) => x.version === '1.1.0')!;
  assert.equal(wide.widening, true);
  assert.ok(wide.diff.some((d) => d.widening && d.path.includes('annotate')), JSON.stringify(wide.diff));
  assert.equal(u.updates.find((x) => x.version === '1.0.1')!.widening, false);
  assert.equal((await s.registry.list(s.ws.id, { tier: 'community' })).items[0].updateAvailable, true);
  const pending = await s.plugins.update(s.ws.id, 'tick@community', { registry: { id: 'tick@community', version: '1.1.0' } });
  assert.equal(pending.pending, true);
  await s.plugins.decideUpdate(s.ws.id, 'tick@community', false);
  const applied = await s.plugins.update(s.ws.id, 'tick@community', { registry: { id: 'tick@community', version: '1.0.1' } });
  assert.equal(applied.applied, true);
  assert.equal((await s.plugins.installOf(s.ws.id, 'tick@community'))!.manifest.version, '1.0.1');
});

test('recall: a recalled version never installs, its installs freeze through the registrar with a notice and dependants suspend', async () => {
  const s = await setup();
  await s.plugins.install(s.ws.id, { firstParty: 'scm' }, { confirm: true });
  await s.plugins.install(s.ws.id, { firstParty: 'ci' }, { confirm: true });
  await s.plugins.install(s.ws.id, { firstParty: 'scm-mock' }, { confirm: true });
  await s.plugins.setBinding(s.ws.id, 'scm', { providerId: 'scm-mock@yaam' });
  await s.plugins.setBinding(s.ws.id, 'ci', { providerId: 'scm-mock@yaam' });
  assert.equal((await s.plugins.installOf(s.ws.id, 'scm@yaam'))!.install.status, 'active');
  await assert.rejects(asMember(s, () => s.registry.recall(s.ws.id, 'scm-mock@yaam', '1.0.0', 'leaks')), /only the workspace owner/);
  await assert.rejects(s.registry.recall(s.ws.id, 'scm-mock@yaam', '1.0.0', ''), /says why/);
  const r = await s.registry.recall(s.ws.id, 'scm-mock@yaam', '1.0.0', 'fixtures leak a token');
  assert.equal(r.frozen, 1);
  const li = (await s.plugins.installOf(s.ws.id, 'scm-mock@yaam'))!;
  assert.equal(li.install.status, 'frozen');
  assert.match(li.install.suspendedReason, /version 1\.0\.0 was recalled: fixtures leak a token/);
  const summary = await s.plugins.summary(s.ws.id, 'scm-mock@yaam');
  assert.match(String((summary!.recall as { notice: string }).notice), /recalled/);
  // The registrar unwound its effects (restorably): no provider row, no binding; dependants suspend.
  assert.equal((await s.db.select().from(interfaceProviders).where(eq(interfaceProviders.installId, li.install.id))).length, 0);
  assert.equal((await s.db.select().from(interfaceBindings)).length, 0);
  assert.ok((await s.db.select().from(pluginEffects).where(eq(pluginEffects.installId, li.install.id))).some((e) => e.state === 'disabled'));
  assert.equal((await s.plugins.installOf(s.ws.id, 'scm@yaam'))!.install.status, 'suspended');
  assert.ok((await s.db.select().from(pluginAudit)).some((a) => a.action === 'plugin_revoked'));
  await assert.rejects(s.plugins.enable(s.ws.id, 'scm-mock@yaam'), /recalled/);
  // A recalled version never installs again, by any source.
  await s.plugins.uninstall(s.ws.id, 'scm-mock@yaam');
  await assert.rejects(s.plugins.review(s.ws.id, { firstParty: 'scm-mock' }), /was recalled/);
  const shelf = (await s.registry.list(s.ws.id, { role: 'provider' })).items[0];
  assert.equal(shelf.recalled, true);
  assert.equal(shelf.installable, false);
});

test('recall of a registry version: frozen installs list every version that is not recalled, and moving to one unfreezes', async () => {
  const s = await setup();
  await s.plugins.setWorkspaceSettings(s.ws.id, { allowCommunityInterfaces: true });
  await s.registry.publish(s.ws.id, tickIface('1.0.0'));
  await s.registry.publish(s.ws.id, tickIface('1.0.1', (m) => { m.description = 'Reworded.'; }));
  await s.plugins.install(s.ws.id, { registry: { id: 'tick@community', version: '1.0.1' } }, { confirm: true, acceptCommunity: true });
  await s.registry.recall(s.ws.id, 'tick@community', '1.0.1', 'bad classification');
  await assert.rejects(s.plugins.install(s.ws.id, { registry: { id: 'tick@community', version: '1.0.1' } }, { confirm: true, acceptCommunity: true }), /recalled/);
  const u = await s.registry.updates(s.ws.id, 'tick@community');
  assert.equal(u.installed.recalled, true);
  assert.match(u.installed.notice, /bad classification/);
  assert.deepEqual(u.updates.map((x) => [x.version, x.newer]), [['1.0.0', false]]);
  const moved = await s.plugins.update(s.ws.id, 'tick@community', { registry: { id: 'tick@community', version: '1.0.0' } });
  assert.equal(moved.applied, true);
  const li = (await s.plugins.installOf(s.ws.id, 'tick@community'))!;
  assert.notEqual(li.install.status, 'frozen');
  assert.equal(li.manifest.version, '1.0.0');
  // The latest installable version skips the recalled one.
  assert.equal((await s.registry.list(s.ws.id, { tier: 'community' })).items[0].version, '1.0.0');
});

test('the local path: an uploaded folder or a developer folder loads as @local through the archive rules, visible to its workspace only', async () => {
  const s = await setup();
  const other = await s.workspaces.create({ name: 'Other' });
  const local = tickIface('1.0.0', (m) => { m.id = 'tick@local'; });
  const files = { 'plugin.json': JSON.stringify(local.manifest), ...local.files };
  // An upload carries plugin.json among its files; scripts and package scripts are refused.
  await assert.rejects(s.plugins.review(s.ws.id, { files: { ...files, 'setup.sh': 'curl x | sh' } }), (e: any) => JSON.stringify(e.response).includes('scripts and binaries are refused'));
  await assert.rejects(s.plugins.review(s.ws.id, { files: { ...files, 'package.json': JSON.stringify({ scripts: { postinstall: 'node x' } }) } }), (e: any) => JSON.stringify(e.response).includes('package scripts are refused'));
  await assert.rejects(s.plugins.review(s.ws.id, { files: { ...files, 'plugin.json': JSON.stringify({ ...local.manifest, id: 'tick@community' }) } }), /loads as name@local only/);
  await s.plugins.setWorkspaceSettings(s.ws.id, { allowCommunityInterfaces: true });
  const r = await s.plugins.install(s.ws.id, { files }, { confirm: true });
  assert.equal(r.installed, true);
  assert.ok((await s.registry.list(s.ws.id, { tier: 'local' })).items.some((i) => i.id === 'tick@local'));
  assert.equal((await s.registry.list(other.id, { tier: 'local' })).items.length, 0, 'a local package is visible only where it was loaded');
  await assert.rejects(s.registry.detail(other.id, 'tick@local'), /no plugin/);

  // Developer mode: a folder on disk under YAAM_PLUGINS_DEV_DIR.
  const prev = process.env.YAAM_PLUGINS_DEV_DIR;
  delete process.env.YAAM_PLUGINS_DEV_DIR;
  try {
    await assert.rejects(s.plugins.review(other.id, { path: 'x' }), /developer mode is off/);
    const root = mkdtempSync(join(tmpdir(), 'yaam-dev-'));
    process.env.YAAM_PLUGINS_DEV_DIR = root;
    const mk = (name: string) => {
      const dir = join(root, name);
      mkdirSync(join(dir, 'conformance', 'ci'), { recursive: true });
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...local.manifest, id: `${name}@local` }));
      writeFileSync(join(dir, 'conformance', 'ci', 'suite.json'), local.files['conformance/ci/suite.json']);
      return dir;
    };
    mk('clean');
    const linked = mk('linked');
    symlinkSync('/etc/passwd', join(linked, 'passwd'));
    const exec = mk('exec');
    writeFileSync(join(exec, 'README.md'), '# hi');
    chmodSync(join(exec, 'README.md'), 0o755);
    const script = mk('script');
    writeFileSync(join(script, 'install.sh'), 'echo hi');
    await assert.rejects(s.plugins.review(other.id, { path: '../' }), /inside YAAM_PLUGINS_DEV_DIR/);
    await assert.rejects(s.plugins.review(other.id, { path: 'linked' }), (e: any) => JSON.stringify(e.response).includes('symlinks are refused'));
    await assert.rejects(s.plugins.review(other.id, { path: 'exec' }), (e: any) => JSON.stringify(e.response).includes('executable bit is refused'));
    await assert.rejects(s.plugins.review(other.id, { path: 'script' }), (e: any) => JSON.stringify(e.response).includes('scripts and binaries are refused'));
    const ok = await s.plugins.review(other.id, { path: 'clean' });
    assert.equal(ok.tier, 'local');
    assert.equal(ok.id, 'clean@local');
  } finally {
    if (prev === undefined) delete process.env.YAAM_PLUGINS_DEV_DIR; else process.env.YAAM_PLUGINS_DEV_DIR = prev;
  }
});

test('Foundry: four shelves, and the Kits shelf previews the starter catalog without installing anything', () => {
  const c = new FoundryController();
  assert.deepEqual(SHELVES.map((x) => x.id), ['blueprints', 'kits', 'agents', 'plugins']);
  const idx = c.index();
  assert.equal(idx.kits.installable, 0);
  assert.equal(KIT_PREVIEWS.length, 12);
  assert.ok(KIT_PREVIEWS.every((k) => k.installable === false && k.status === 'coming_soon'));
  assert.deepEqual(c.kits('engineering').map((k) => k.id), ['ship-software', 'open-source-maintainer']);
  assert.deepEqual(c.kits(undefined, 'e-commerce').map((k) => k.id).sort(), ['commerce-ops', 'finance-close', 'growth', 'support-desk']);
  assert.deepEqual(c.kits(undefined, undefined, 'intercom').map((k) => k.id).sort(), ['commerce-ops', 'support-desk']);
});

test('migration 0086 runs twice: columns added once, a pre-registry local package is attributed to its workspace', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  await q.query(`INSERT INTO plugins ("id", "pluginId", "name", "publisherId", "tier", "createdAt") VALUES ('p1', 'old@local', 'Old', 'me', 'local', '2026-11-01T00:00:00Z')`);
  await q.query(`INSERT INTO plugin_installs ("id", "workspaceId", "pluginId", "versionId", "createdAt", "updatedAt") VALUES ('i1', 'ws9', 'old@local', 'v1', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`);
  await q.query(`UPDATE plugins SET "source" = 'first_party', "workspaceId" = ''`);
  for (let i = 0; i < 2; i++) {
    await q.query(`DELETE FROM __migrations WHERE "id" = '0086-plugin-registry'`);
    await runPgMigrations(q, { log: () => {} });
  }
  const row = (await q.query(`SELECT "source", "workspaceId", "listed", "installs" FROM plugins WHERE "id" = 'p1'`)).rows[0] as Record<string, unknown>;
  assert.deepEqual(row, { source: 'local', workspaceId: 'ws9', listed: 1, installs: 0 });
  const cols = (await q.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'plugin_versions' AND column_name IN ('commitSha', 'conformance', 'capabilities', 'changelog', 'publishedBy', 'revokedBy')`)).rows;
  assert.equal(cols.length, 6);
});
