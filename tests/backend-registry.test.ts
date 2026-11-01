/** The market registry (execution-plan item 12, docs/registry.md). The
 *  invariant under test: nothing installs without a confirmed review, and
 *  what installs is inert — loops disabled, skills as drafts, elevated app
 *  capabilities parked; the public feed never carries lessons, tasks or a
 *  profile; the remote merge runs through the SSRF guard. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { PortabilityService } from '../server/src/portability/portability.service';
import { RegistryService, normalizeManifest, slugify } from '../server/src/registry/registry.service';
import { scanAppHtml } from '../server/src/registry/app-scan';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { setAddressLookup } from '../server/src/common/url-guard';
import { testDb, memStorage } from './helpers';
import type { StorageService } from '../server/src/storage/storage.service';
import type { LoopDef } from '../server/src/chats/loop-def';

async function setup() {
  const db = await testDb();
  const storage = memStorage().stub as unknown as StorageService;
  const agents = new AgentsService(db, storage);
  const memory = new AgentMemoryService(db, storage);
  const skills = new SkillsService(db);
  const workspaces = new WorkspacesService(db, storage);
  const portability = new PortabilityService(agents, memory, skills, workspaces);
  const registry = new RegistryService(db, agents, skills, portability);
  const repo = new ChatsRepository(db);
  const chats = new ChatsService(repo, agents, skills, registry);
  const [ws] = await workspaces.list();
  return { db, agents, memory, skills, workspaces, portability, registry, repo, chats, ws };
}

const APP_HTML = '<!doctype html><html><body><h1>Tracker</h1><script>const s = window.yaam; fetch("https://evil.example/x");</script></body></html>';

test('publish an agent: AGENT.json without lessons/tasks/profile, loops disabled, scan report recorded; re-publish bumps the version and keeps installs', async () => {
  const { agents, memory, skills, workspaces, registry, ws } = await setup();
  await workspaces.update(ws.id, { profile: '- Lives in Berlin' });
  const a = await agents.create({ name: 'Atlas', role: 'Bookkeeper', charter: 'Keep the books. Use calendar_list and fs_write. See https://docs.example/ledger.', loops: [{ name: 'daily', cron: '0 8 * * *', prompt: 'Reconcile.' }] });
  await memory.record(a.id, 'Private lesson about the user.', { source: 'chat' });
  await agents.addTask(a.id, { title: 'Open task' });
  await skills.create({ name: 'close-month', description: 'Close the books', instructions: '1. Reconcile.\n2. Report with gmail_send.', agentId: a.id });
  await agents.saveApp(a.id, { name: 'Tracker', description: 'A tracker', html: APP_HTML, capabilities: ['storage', 'tasks.write'] });

  // dry run: scan + summary, nothing written
  const dry = await registry.publish({ kind: 'agent', agentId: a.id, publisherName: 'Dana', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal((await registry.list()).items.length, 0);
  assert.deepEqual(dry.capabilities.tools, ['calendar_list', 'fs_write', 'gmail_send']);
  assert.deepEqual(dry.capabilities.connections, ['calendar', 'mail']);
  assert.deepEqual(dry.capabilities.loops, [{ name: 'daily', cron: '0 8 * * *', enabled: false }]);
  assert.deepEqual(dry.capabilities.apps, [{ name: 'Tracker', capabilities: ['storage', 'tasks.write'] }]);
  const kinds = new Set(dry.scanReport.flags.map((f) => f.kind));
  assert.ok(kinds.has('urls') && kinds.has('network') && kinds.has('capabilities'), `flags: ${dry.scanReport.flags.map((f) => f.detail).join(' | ')}`);
  assert.ok(dry.scanReport.flags.some((f) => f.detail.startsWith('app "Tracker": uses fetch(')));
  assert.equal(dry.scanReport.ok, true, 'warnings do not block');

  const pub = await registry.publish({ kind: 'agent', agentId: a.id, publisherName: 'Dana', description: 'Keeps the books.' });
  assert.equal(pub.dryRun, false);
  if (pub.dryRun) throw new Error('unreachable');
  assert.equal(pub.item.version, 1);
  assert.equal(pub.item.slug, 'atlas');
  assert.equal(pub.item.publisherName, 'Dana');
  assert.equal(pub.pushed.attempted, false, 'no REGISTRY_URL: nothing pushed');

  // the stored manifest: identity, charter, loops (disabled), dashboard, apps, skills — and nothing personal
  const detail = await registry.get(pub.item.id);
  const m = detail.manifest;
  assert.equal(m.formatVersion, 2);
  assert.equal(m.name, 'Atlas');
  assert.equal(m.charter, (await agents.get(a.id)).charter);
  assert.equal('lessons' in m, false, 'lessons never publish');
  assert.equal('tasks' in m, false, 'tasks never publish');
  assert.equal('profile' in m, false, 'the profile never publishes');
  assert.deepEqual((m.loops as LoopDef[]).map((l) => l.enabled), [false]);
  assert.equal((m.skills as unknown[]).length, 1);
  assert.deepEqual((m.apps as Array<{ capabilities: string[] }>)[0].capabilities, ['storage', 'tasks.write']);

  // re-publish: version bumps, installs persist
  await registry.install(pub.item.id, { confirm: true, options: { name: 'Atlas Copy' } });
  await agents.update(a.id, { charter: 'Keep the books, carefully.' });
  const again = await registry.publish({ kind: 'agent', agentId: a.id, publisherName: 'Dana' });
  if (again.dryRun) throw new Error('unreachable');
  assert.equal(again.item.id, pub.item.id, 'same (kind, slug) → same item');
  assert.equal(again.item.version, 2);
  assert.equal(again.item.installs, 1, 'installs survive a re-publish');
  assert.match((await registry.get(pub.item.id)).manifest.charter as string, /carefully/);
  assert.equal((await registry.list()).items.length, 1);
});

test('publish a skill and an app; blocking flags refuse the publish', async () => {
  const { agents, skills, registry, ws } = await setup();
  const s = await skills.create({ name: 'weekly-audit', description: 'Audit deps weekly.', instructions: 'Run the audit with run_js.\nFile a task per critical.', workspaceId: ws.id, proposedBy: 'Dana' });
  const pub = await registry.publish({ kind: 'skill', skillId: s.id, publisherName: 'Dana' });
  if (pub.dryRun) throw new Error('unreachable');
  assert.equal(pub.item.kind, 'skill');
  assert.equal(pub.item.slug, 'weekly-audit');
  assert.deepEqual(pub.item.capabilities.tools, ['run_js']);
  assert.match((await registry.get(pub.item.id)).manifest.skillMd as string, /^---\nname: weekly-audit\n/);
  assert.equal(pub.item.scanReport.flags.length, 0);

  // a draft cannot be published
  const draft = await skills.create({ name: 'half-baked', instructions: 'x', workspaceId: ws.id, draft: true });
  await assert.rejects(registry.publish({ kind: 'skill', skillId: draft.id }), /approve the draft/);

  const a = await agents.create({ name: 'Atlas' });
  await agents.saveApp(a.id, { name: 'Tracker', description: 'A tracker', html: APP_HTML, capabilities: ['storage', 'compute'] });
  const app = (await agents.listApps(a.id))[0];
  const appPub = await registry.publish({ kind: 'app', agentId: a.id, appId: app.id, publisherName: 'Dana' });
  if (appPub.dryRun) throw new Error('unreachable');
  assert.equal(appPub.item.kind, 'app');
  assert.deepEqual(appPub.item.capabilities.appCapabilities, { free: ['storage'], elevated: ['compute'] });
  const flagKinds = appPub.item.scanReport.flags.map((f) => f.kind);
  assert.ok(flagKinds.includes('network') && flagKinds.includes('urls') && flagKinds.includes('capabilities'));
  assert.deepEqual(appPub.item.scanReport.urls, ['https://evil.example/x']);

  // blocking: invisible unicode in an app, unknown capability names
  const hidden = scanAppHtml({ html: '<p>hi\u200B</p>' });
  assert.equal(hidden.ok, false);
  assert.equal(scanAppHtml({ html: '<p>ok</p>', capabilities: ['root'] }).ok, false);
  assert.equal(scanAppHtml({ html: '<p>plain</p>', capabilities: ['storage'] }).flags.length, 0, 'a plain app with free caps has no flags');
  await agents.saveApp(a.id, { name: 'Hidden', html: '<p>hi\u200B</p>' });
  const hiddenApp = (await agents.listApps(a.id)).find((x) => x.name === 'Hidden')!;
  await assert.rejects(registry.publish({ kind: 'app', agentId: a.id, appId: hiddenApp.id }), /publish refused.*invisible/);

  assert.equal(slugify('  Hello, World!! '), 'hello-world');
  assert.throws(() => normalizeManifest('skill', { skillMd: 'no frontmatter' }), /frontmatter/);
});

test('install is refused without confirm, returns the review first, then imports inert: skills as drafts, loops disabled, app capabilities parked; installs count', async () => {
  const { agents, skills, registry, ws } = await setup();
  const a = await agents.create({ name: 'Atlas', charter: 'Keep the books.', loops: [{ name: 'daily', cron: '0 8 * * *', prompt: 'Reconcile.' }] });
  await skills.create({ name: 'close-month', description: 'Close', instructions: '1. Reconcile.', agentId: a.id });
  await agents.saveApp(a.id, { name: 'Tracker', html: '<p>t</p>', capabilities: ['storage', 'tasks.write'] });
  const pub = await registry.publish({ kind: 'agent', agentId: a.id, publisherName: 'Dana' });
  if (pub.dryRun) throw new Error('unreachable');
  const before = (await agents.list()).length;

  // no confirm → review only, nothing created
  const first = await registry.install(pub.item.id);
  assert.ok('requiresConfirm' in first && first.requiresConfirm === true);
  assert.equal(first.review.kind, 'agent');
  assert.deepEqual(first.review.loops, [{ name: 'daily', cron: '0 8 * * *', enabled: false }]);
  assert.equal(first.review.skillBodies[0].instructions, '1. Reconcile.', 'the real skill text is in the review');
  assert.equal(first.review.charter, 'Keep the books.');
  assert.ok(first.review.installs.some((l) => /disabled/.test(l)) && first.review.installs.some((l) => /drafts/.test(l)));
  assert.equal((await agents.list()).length, before, 'nothing installed');
  // confirm must be the boolean true
  const falsy = await registry.install(pub.item.id, { confirm: 'yes' });
  assert.ok('requiresConfirm' in falsy);
  assert.equal((await agents.list()).length, before);

  const res = await registry.install(pub.item.id, { confirm: true, options: { workspaceId: ws.id } });
  if ('requiresConfirm' in res) throw new Error('expected an install');
  assert.ok(res.agentId);
  const copy = await agents.get(res.agentId!);
  assert.equal(copy.name, 'Atlas (2)', 'name conflict resolved');
  assert.deepEqual((JSON.parse(copy.loops) as LoopDef[]).map((l) => l.enabled), [false], 'loops install disabled');
  const copySkills = (await skills.list(ws.id, copy.id)).filter((s) => s.agentId === copy.id);
  assert.equal(copySkills.length, 1);
  assert.equal(copySkills[0].draft, 1);
  assert.equal(copySkills[0].enabled, 0);
  const apps = await agents.listApps(copy.id);
  assert.deepEqual(apps[0].capabilities, ['storage', 'tasks.write']);
  assert.deepEqual(apps[0].approved, ['storage'], 'elevated capability parked, free one granted');
  assert.ok(res.notes.some((n) => /parked: tasks\.write/.test(n)));
  assert.equal((await registry.get(pub.item.id)).installs, 1);
  assert.equal((await registry.list()).items[0].installed, true);

  // skill install → draft, workspace-shared by default
  const sk = await skills.create({ name: 'audit', description: 'Audit', instructions: 'Audit things.', workspaceId: ws.id });
  const skPub = await registry.publish({ kind: 'skill', skillId: sk.id });
  if (skPub.dryRun) throw new Error('unreachable');
  const other = await setup(); // a second instance: install the same manifest there
  const otherDetail = await registry.get(skPub.item.id);
  const mirrored = await other.registry.acceptRemotePublish({ kind: 'skill', manifest: otherDetail.manifest, publisherName: 'Dana' }, 'Bearer tok').catch((e: Error) => e);
  assert.match((mirrored as Error).message, /does not accept/);
  other.registry.configure({ registryPublishToken: 'tok' });
  await assert.rejects(other.registry.acceptRemotePublish({ kind: 'skill', manifest: otherDetail.manifest }, 'Bearer wrong'), /invalid publish token/);
  const accepted = await other.registry.acceptRemotePublish({ kind: 'skill', manifest: otherDetail.manifest, publisherName: 'Dana' }, 'Bearer tok');
  assert.equal(accepted.slug, 'audit');
  const skRes = await other.registry.install(accepted.id, { confirm: true, options: { workspaceId: other.ws.id } });
  if ('requiresConfirm' in skRes) throw new Error('expected an install');
  const installed = await other.skills.get(skRes.skillId!);
  assert.equal(installed.draft, 1);
  assert.equal(installed.proposedBy, 'registry: Dana');
  assert.equal((await other.skills.toolSpecs(other.ws.id)).some((t) => t.name === 'skill_audit'), false, 'not callable until approved');

  // app install needs a target agent; capabilities park
  await agents.saveApp(a.id, { name: 'Board', html: '<p>b</p>', capabilities: ['storage', 'compute'] });
  const board = (await agents.listApps(a.id)).find((x) => x.name === 'Board')!;
  const appPub = await registry.publish({ kind: 'app', agentId: a.id, appId: board.id });
  if (appPub.dryRun) throw new Error('unreachable');
  await assert.rejects(registry.install(appPub.item.id, { confirm: true }), /agentId is required/);
  const target = await agents.create({ name: 'Target' });
  const appRes = await registry.install(appPub.item.id, { confirm: true, options: { agentId: target.id } });
  if ('requiresConfirm' in appRes) throw new Error('expected an install');
  const tApp = (await agents.listApps(target.id)).find((x) => x.id === appRes.appId)!;
  assert.deepEqual(tApp.approved, ['storage']);
  assert.deepEqual(tApp.capabilities, ['storage', 'compute']);
});

test('ratings roll up: a rated turn on an installed agent or skill reaches the item; explicit rate for apps; re-rating replaces', async () => {
  const { agents, skills, registry, repo, chats, ws } = await setup();
  const a = await agents.create({ name: 'Atlas', charter: 'c' });
  const pub = await registry.publish({ kind: 'agent', agentId: a.id });
  if (pub.dryRun) throw new Error('unreachable');
  const inst = await registry.install(pub.item.id, { confirm: true });
  if ('requiresConfirm' in inst) throw new Error('expected an install');
  const sk = await skills.create({ name: 'audit', instructions: 'Audit.', agentId: a.id });
  const skPub = await registry.publish({ kind: 'skill', skillId: sk.id });
  if (skPub.dryRun) throw new Error('unreachable');
  const skInst = await registry.install(skPub.item.id, { confirm: true, options: { workspaceId: ws.id } });
  if ('requiresConfirm' in skInst) throw new Error('expected an install');
  await skills.resolveDraft(skInst.skillId!, true);

  const session = await chats.create({ workspaceId: ws.id, agentId: inst.agentId! });
  const turn = await repo.createTurn(session.id, { text: 'hi', model: 'm' });
  await repo.updateTurn(turn.id, { status: 'done', skillsUsed: JSON.stringify([skInst.skillId]) });

  await chats.rateTurn(session.id, turn.id, 'up');
  assert.equal((await registry.get(pub.item.id)).ratingUp, 1, 'the agent item got the 👍');
  assert.equal((await registry.get(skPub.item.id)).ratingUp, 1, 'the skill item got it too');
  // re-rating replaces, never doubles
  await chats.rateTurn(session.id, turn.id, 'down', 'meh');
  const agentItem = await registry.get(pub.item.id);
  assert.equal(agentItem.ratingUp, 0);
  assert.equal(agentItem.ratingDown, 1);
  await chats.rateTurn(session.id, turn.id, 'down');
  assert.equal((await registry.get(pub.item.id)).ratingDown, 1);
  // an unrelated agent's turn touches nothing
  const other = await agents.create({ name: 'Other' });
  const s2 = await chats.create({ workspaceId: ws.id, agentId: other.id });
  const t2 = await repo.createTurn(s2.id, { text: 'x', model: 'm' });
  await chats.rateTurn(s2.id, t2.id, 'up');
  assert.equal((await registry.get(pub.item.id)).ratingUp, 0);

  // explicit rating (apps have no turns): needs an install, replaces on repeat
  await agents.saveApp(a.id, { name: 'Tracker', html: '<p>t</p>' });
  const app = (await agents.listApps(a.id))[0];
  const appPub = await registry.publish({ kind: 'app', agentId: a.id, appId: app.id });
  if (appPub.dryRun) throw new Error('unreachable');
  await assert.rejects(registry.rate(appPub.item.id, { rating: 'up' }), /install the item/);
  await registry.install(appPub.item.id, { confirm: true, options: { agentId: other.id } });
  assert.deepEqual(await registry.rate(appPub.item.id, { rating: 'up' }), { ok: true, up: 1, down: 0 });
  assert.deepEqual(await registry.rate(appPub.item.id, { rating: 'down', note: 'broke' }), { ok: true, up: 0, down: 1 });
  assert.equal((await registry.get(appPub.item.id)).ratingDown, 1);
});

test('public feed: published items only, projection without manifest, the manifest endpoint carries no lessons/tasks/profile; counters bump anonymously', async () => {
  const { agents, memory, registry } = await setup();
  const a = await agents.create({ name: 'Atlas', charter: 'c' });
  await memory.record(a.id, 'secret lesson', { source: 'chat' });
  await agents.addTask(a.id, { title: 'secret task' });
  const pub = await registry.publish({ kind: 'agent', agentId: a.id, publisherName: 'Dana' });
  if (pub.dryRun) throw new Error('unreachable');

  const feed = await registry.listPublic();
  assert.equal(feed.length, 1);
  assert.equal('manifest' in feed[0], false, 'the listing is a projection');
  assert.deepEqual(Object.keys(feed[0]).sort(), ['capabilities', 'description', 'id', 'installs', 'kind', 'name', 'publishedAt', 'publisherName', 'ratingDown', 'ratingUp', 'remoteUrl', 'scanReport', 'slug', 'source', 'updatedAt', 'version']);
  const item = await registry.getPublic(pub.item.id);
  const text = JSON.stringify(item);
  assert.doesNotMatch(text, /secret lesson|secret task/);
  assert.equal('lessons' in item.manifest, false);
  assert.equal('tasks' in item.manifest, false);
  assert.equal('profile' in item.manifest, false);
  await assert.rejects(registry.getPublic('nope'), /registry item/);

  assert.deepEqual(await registry.bumpPublicInstall(pub.item.id), { ok: true, installs: 1 });
  await registry.bumpPublicRating(pub.item.id, 'up');
  await assert.rejects(registry.bumpPublicRating(pub.item.id, 'meh'), /up or down/);
  const after = await registry.getPublic(pub.item.id);
  assert.equal(after.installs, 1);
  assert.equal(after.ratingUp, 1);
});

test('remote registry: merged with a 10-minute cache through a fake fetch; a remote item installs after a local re-scan; a private REGISTRY_URL is refused by the SSRF guard', async (t) => {
  const { agents, skills, registry, ws } = await setup();
  setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
  t.after(() => setAddressLookup(null));

  // the remote's feed, as another instance would serve it
  const remoteSkillMd = '---\nname: remote-audit\ndescription: "Audit from afar."\n---\n\nAudit with run_js and report to https://example.com/report.\n';
  const remoteItem = {
    id: 'r1', kind: 'skill', slug: 'remote-audit', name: 'remote-audit', description: 'Audit from afar.', version: 3, publisherName: 'Remote Dana',
    capabilities: { tools: ['run_js'], connections: [], loops: [], skills: [{ name: 'remote-audit', description: 'Audit from afar.' }], apps: [] },
    scanReport: { bytes: 1, lines: 1, urls: [], flags: [], ok: true, scannedAt: 'x' }, // the remote claims a clean scan…
    installs: 12, ratingUp: 5, ratingDown: 1, publishedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
  };
  const calls: string[] = [];
  registry.fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? 'GET'} ${u}`);
    if (u === 'https://registry.example/api/registry/public') return new Response(JSON.stringify([remoteItem, { id: 'bad', kind: 'nope' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u === 'https://registry.example/api/registry/public/r1') return new Response(JSON.stringify({ ...remoteItem, manifest: { skillMd: remoteSkillMd } }), { status: 200 });
    if (u.endsWith('/r1/installed')) return new Response('{"ok":true}', { status: 200 });
    if (init?.method === 'POST' && u === 'https://registry.example/api/registry/public') return new Response(JSON.stringify({ id: 'r2' }), { status: 201 });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  registry.configure({ registryUrl: 'https://registry.example/' });

  const list = await registry.list();
  assert.equal(list.remote.url, 'https://registry.example');
  assert.equal(list.remote.ok, true);
  assert.equal(list.items.length, 1, 'the malformed row is dropped');
  const r = list.items[0];
  assert.equal(r.id, 'remote:r1');
  assert.equal(r.source, 'remote');
  assert.equal(r.installs, 12);
  assert.equal(r.installed, false);
  await registry.list({ q: 'afar' });
  assert.equal(calls.filter((c) => c.endsWith('/api/registry/public')).length, 1, 'second listing is served from the cache');
  assert.deepEqual((await registry.list({ kind: 'agent' })).items, []);
  assert.equal((await registry.list({ q: 'AFAR' })).items.length, 1);

  // the review re-scans locally: the remote's "clean" report is not what gates
  const review = await registry.install('remote:r1');
  assert.ok('requiresConfirm' in review);
  assert.equal(review.review.source, 'remote');
  assert.ok(review.review.scanReport.flags.some((f) => f.kind === 'urls'), 'our scan found the URL the remote report omitted');
  assert.equal(review.review.skillBodies[0].instructions.startsWith('Audit with run_js'), true);

  const res = await registry.install('remote:r1', { confirm: true, options: { workspaceId: ws.id } });
  if ('requiresConfirm' in res) throw new Error('expected an install');
  const installed = await skills.get(res.skillId!);
  assert.equal(installed.name, 'remote-audit');
  assert.equal(installed.draft, 1);
  assert.equal(installed.proposedBy, 'registry: Remote Dana');
  assert.ok(calls.some((c) => c === 'POST https://registry.example/api/registry/public/r1/installed'), 'the remote counter is bumped');
  assert.equal((await registry.list()).items[0].installed, true);
  // a rating on the remote install stays local-row + remote notify, no local counters to corrupt
  await registry.rate('remote:r1', { rating: 'up' });
  assert.ok(calls.some((c) => c === 'POST https://registry.example/api/registry/public/r1/rate'));

  // publish pushes upstream when the token is set
  registry.configure({ registryUrl: 'https://registry.example', registryPublishToken: 'tok' });
  const a = await agents.create({ name: 'Atlas', charter: 'c' });
  const pub = await registry.publish({ kind: 'agent', agentId: a.id });
  if (pub.dryRun) throw new Error('unreachable');
  assert.deepEqual(pub.pushed, { attempted: true, ok: true });
  assert.equal(registry.status().publishToken, true);
  assert.equal(registry.status().remoteUrl, 'https://registry.example');

  // a remote that fails leaves the local items and reports the error
  registry.fetchFn = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  registry.configure({ registryUrl: 'https://registry.example' });
  const broken = await registry.list();
  assert.equal(broken.items.length, 1, 'local items still listed');
  assert.match(broken.remote.error, /500/);
  assert.equal(broken.remote.ok, false);

  // SSRF: a private REGISTRY_URL never gets a request
  const sentinel: string[] = [];
  registry.fetchFn = (async (url: string | URL | Request) => { sentinel.push(String(url)); return new Response('[]'); }) as typeof fetch;
  registry.configure({ registryUrl: 'http://127.0.0.1:8790' });
  const priv = await registry.list();
  assert.match(priv.remote.error, /private\/internal/);
  assert.equal(sentinel.length, 0, 'no request left the process');
  await assert.rejects(registry.get('remote:r1'), /private\/internal/);
  registry.configure({ registryUrl: 'http://169.254.169.254' });
  assert.match((await registry.list()).remote.error, /private\/internal/);
  assert.equal(sentinel.length, 0);
});
