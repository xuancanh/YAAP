/** Plugin contributions beyond tools and kits (docs/plugins.md §3.8,
 *  docs/foundry.md "Shipped as (kits)"): the manifest's skills, guidance and
 *  declarative UI validated and conformance-checked; every first-party
 *  plugin installs, passes conformance and renders its UI from its query;
 *  contributions install, disable, enable and uninstall with the plugin;
 *  UI actions go through the policy stage; guidance is bounded and
 *  attributed; kits plan, install atomically, upgrade, roll back and
 *  uninstall. The chief's Foundry tools are in
 *  tests/backend-org-foundry.test.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { testDb, memStorage } from './helpers';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { ActionsService } from '../server/src/actions/actions.service';
import { TrustService } from '../server/src/actions/trust.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { kitInstalls, kitMembers, pluginAudit, pluginContributions, pluginInstalls, skills } from '../server/src/database/schema';
import { PluginAuditService } from '../server/src/plugins/plugin-audit';
import { PluginsService } from '../server/src/plugins/plugins.service';
import { ChangesService } from '../server/src/plugins/changes.service';
import { InterfaceDispatcher } from '../server/src/plugins/dispatcher';
import { PluginUiService } from '../server/src/plugins/plugin-ui.service';
import { validateManifest, GUIDANCE_NOTE_MAX, type Manifest } from '../server/src/plugins/manifest';
import { loadFirstParty } from '../server/src/plugins/loader';
import { audienceReaches, renderGuidance, renderView, GUIDANCE_BUDGET, type GuidanceNote } from '../server/src/plugins/contributions';
import { KitsService } from '../server/src/foundry/kits.service';
import { validateKit, loadFirstPartyKits } from '../server/src/foundry/kit-manifest';
import { runWithViewer } from '../server/src/accounts/account-context';

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const trust = new TrustService(db, agents, bus);
  const actions = new ActionsService(db, trust, agents);
  const audit = new PluginAuditService(db, actions);
  const skillsSvc = new SkillsService(db);
  const plugins = new PluginsService(db, audit, actions, skillsSvc);
  const changes = new ChangesService(db, audit, actions);
  const dispatcher = new InterfaceDispatcher(db, plugins, changes, audit, actions);
  const ui = new PluginUiService(plugins, dispatcher);
  const kits = new KitsService(db, plugins, audit, skillsSvc);
  const ws = (await workspaces.list())[0];
  return { db, agents, actions, audit, skills: skillsSvc, plugins, dispatcher, ui, kits, ws };
}
type S = Awaited<ReturnType<typeof setup>>;
const asMember = <T>(s: S, fn: () => Promise<T>) => runWithViewer('single', { memberAccountId: 'm2', role: 'member', workspaceId: s.ws.id, displayName: 'M' }, fn);

/** Install an interface and its mock provider, then bind the mock as the workspace default. */
async function withMock(s: S, iface: string, mock = `${iface}-mock`) {
  const live = async (id: string) => { const li = await s.plugins.installOf(s.ws.id, id); return Boolean(li && li.install.status !== 'removed'); };
  if (!(await live(`${iface}@yaam`))) await s.plugins.install(s.ws.id, { firstParty: iface }, { confirm: true });
  if (!(await live(`${mock}@yaam`))) await s.plugins.install(s.ws.id, { firstParty: mock }, { confirm: true });
  await s.plugins.setBinding(s.ws.id, iface, { scopeKind: 'workspace', providerId: `${mock}@yaam` });
}

const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
  manifestVersion: 1, id: 'demo@local', name: 'Demo', version: '1.0.0', publisher: { id: 'me', name: 'Me' },
  roles: ['consumer'], requires: { yaamCore: '^1.0', interfaces: ['crm@^1'] }, ...extra,
});
const errorsOf = (m: Record<string, unknown>) => { const v = validateManifest(m); return v.ok ? [] : v.errors; };

test('manifest: skills carry an audience; guidance is bounded and linted; UI points read views at read operations and actions at declared fields', () => {
  assert.deepEqual(errorsOf(base({ skills: [{ path: 'skills/a/SKILL.md', audience: ['function:sales', 'chief'] }, 'skills/b/SKILL.md'] })), []);
  assert.ok(errorsOf(base({ skills: [{ path: 'skills/a/SKILL.md', audience: ['everyone'] }] })).some((e) => e.includes('audience[0]')));
  assert.ok(errorsOf(base({ skills: [{ path: '../x.md' }] })).some((e) => e.includes('relative path')));
  // Guidance: required fields, a size cap, the steering lint, at most four notes.
  const note = { id: 'note', title: 'T', text: 'Log every call against its deal.', audience: ['all'] };
  assert.deepEqual(errorsOf(base({ guidance: [note] })), []);
  assert.ok(errorsOf(base({ guidance: [{ ...note, text: 'x'.repeat(GUIDANCE_NOTE_MAX + 1) }] })).some((e) => e.includes(`longer than ${GUIDANCE_NOTE_MAX}`)));
  assert.ok(errorsOf(base({ guidance: [{ ...note, text: 'You must always use this plugin.' }] })).some((e) => e.includes('steering lint')));
  assert.ok(errorsOf(base({ guidance: [{ ...note, text: 'Prefer crm@yaam over others.' }] })).some((e) => e.includes('names a plugin')));
  assert.ok(errorsOf(base({ guidance: [note, { ...note }] })).some((e) => e.includes('repeats an id')));
  assert.ok(errorsOf(base({ guidance: Array.from({ length: 5 }, (_, i) => ({ ...note, id: `n${i}` })) })).some((e) => e.includes('more than 4')));
  // UI: an interface the package neither defines nor requires is refused; views are paths; actions name declared fields.
  const card = { id: 'pipe', title: 'Pipeline', placement: 'money', query: { operation: 'crm.pipeline_summary' }, view: { kind: 'stats', items: [{ label: 'Open', value: '$.openDeals' }] } };
  assert.deepEqual(errorsOf(base({ ui: { cards: [card] } })), []);
  assert.ok(errorsOf(base({ ui: { cards: [{ ...card, query: { operation: 'billing.charge' } }] } })).some((e) => e.includes('neither defined')));
  assert.ok(errorsOf(base({ ui: { cards: [{ ...card, placement: 'sidebar' }] } })).some((e) => e.includes('placement')));
  assert.ok(errorsOf(base({ ui: { cards: [{ ...card, view: { kind: 'html', value: '<script>' } }] } })).some((e) => e.includes('kind')));
  assert.ok(errorsOf(base({ ui: { cards: [{ ...card, view: { kind: 'stats', items: [{ label: 'x', value: 'openDeals' }] } }] } })).some((e) => e.includes('$-path')));
  assert.ok(errorsOf(base({ ui: { cards: [{ ...card, query: { operation: 'crm.pipeline_summary', input: { q: '{{context.taskTitle}}' } } }] } })).some((e) => e.includes('not provided here')), 'a section card has no task context');
  assert.ok(errorsOf(base({ ui: { cards: [{ ...card, query: { operation: 'crm.pipeline_summary', input: { q: '{{input.x | eval}}' } } }] } })).some((e) => e.includes('a template is exactly one')));
  const action = { id: 'log', title: 'Log', operation: 'crm.log_activity', input: { dealId: '{{field.dealId}}' }, fields: [{ key: 'dealId', label: 'Deal', type: 'text' }] };
  assert.deepEqual(errorsOf(base({ ui: { actions: [action], cards: [{ ...card, actions: ['log'] }] } })), []);
  assert.ok(errorsOf(base({ ui: { actions: [{ ...action, input: { dealId: '{{field.other}}' } }] } })).some((e) => e.includes('not a declared field')));
  assert.ok(errorsOf(base({ ui: { cards: [{ ...card, actions: ['nope'] }] } })).some((e) => e.includes('names no declared action')));
  // Own interfaces are checked at validation: a query on a write operation, an action that applies a change.
  const own = {
    roles: ['interface', 'consumer'], requires: { yaamCore: '^1.0' },
    interfaces: [{ name: 'demo', version: '1.0.0', semantics: 'Demo things.', resources: { scheme: 'demo', pattern: 'demo://{x}', schema: { type: 'string' } }, conformance: 'conformance/demo/suite.json',
      changeKinds: { thing: { semantics: 'A thing.', reversibility: 'reversible', bind: { id: { type: 'string' } } } },
      operations: {
        get: { required: true, semantics: 'Get.', input: { type: 'object' }, output: { type: 'object' }, class: 'read', reversibility: 'none', outbound: false, idempotent: true, untrustedOutput: false },
        put: { required: true, semantics: 'Put.', input: { type: 'object' }, output: { type: 'object' }, class: 'internal_write', reversibility: 'reversible', outbound: false, idempotent: true, untrustedOutput: false },
        apply: { required: true, semantics: 'Apply.', input: { type: 'object' }, output: { type: 'object' }, class: 'external_reversible', reversibility: 'reversible', outbound: false, idempotent: true, untrustedOutput: false, change: { kind: 'thing', role: 'apply' } },
      } }],
  };
  assert.ok(errorsOf(base({ ...own, ui: { cards: [{ ...card, query: { operation: 'demo.put' } }] } })).some((e) => e.includes('not a read operation')));
  assert.ok(errorsOf(base({ ...own, ui: { actions: [{ id: 'a', title: 'Apply', operation: 'demo.apply' }] } })).some((e) => e.includes('UI actions may not')));
  assert.ok(errorsOf(base({ ...own, ui: { cards: [{ ...card, query: { operation: 'demo.nope' } }] } })).some((e) => e.includes('has no operation')));
});

test('every first-party plugin loads, installs, passes conformance against its mock, and every UI contribution renders from its query', async () => {
  const s = await setup();
  const cat = await loadFirstParty('plugins/first-party');
  const ifaces = [...cat.values()].filter((p) => p.manifest.roles.includes('interface')).map((p) => p.manifest.interfaces![0].name);
  assert.ok(ifaces.length >= 12, `${ifaces.length} interfaces`);
  // Interfaces first (a provider runs conformance against the interfaces installed when it lands), then each mock, bound.
  for (const iface of ifaces) await s.plugins.install(s.ws.id, { firstParty: iface }, { confirm: true });
  for (const iface of ifaces) await withMock(s, iface, iface === 'scm' || iface === 'ci' ? 'scm-mock' : `${iface}-mock`);
  for (const p of cat.values()) if (p.manifest.roles.includes('consumer')) await s.plugins.install(s.ws.id, { firstParty: p.manifest.id }, { confirm: true });
  // Every provider passed conformance and every install is active.
  const installs = await s.plugins.list(s.ws.id);
  assert.equal(installs.length, cat.size);
  for (const i of installs) {
    assert.equal(i.status, 'active', `${String(i.id)}: ${String(i.status)} ${String(i.suspendedReason)}`);
    for (const p of i.providers as Array<{ interface: string; status: string }>) assert.equal(p.status, 'conformant', `${String(i.id)} ${p.interface}`);
  }
  // Every UI contribution is ready and renders.
  const { items, actions } = await s.ui.list(s.ws.id);
  assert.ok(items.length >= 12, `${items.length} UI contributions`);
  const kinds = new Set(items.map((i) => i.kind));
  for (const k of ['card', 'panel', 'page']) assert.ok(kinds.has(k), k);
  const placements = new Set(items.map((i) => String(i.spec.placement)));
  for (const p of ['operations', 'money', 'direction', 'people', 'oversight', 'task']) assert.ok(placements.has(p), p);
  for (const it of items) {
    assert.equal(it.ready, true, `${it.pluginId}#${it.key} waits on ${it.waitingOn.join(', ')}`);
    const sections = it.kind === 'page' ? (it.spec.sections as unknown[]).length : 1;
    for (let i = 0; i < sections; i++) {
      const r = await s.ui.data(s.ws.id, it.id, { section: i, context: { taskTitle: 'Export invoices', taskKey: 'ENG-1' } });
      assert.ok(['stats', 'table', 'list', 'checklist', 'text'].includes(r.view.kind), `${it.key}: ${r.view.kind}`);
      if (r.view.kind === 'stats') assert.ok(r.view.items.every((x) => x.value !== ''), `${it.key}: every stat has a value`);
      if (r.view.kind === 'table') assert.ok(r.view.rows.length > 0, `${it.key}: rows`);
      if (r.view.kind === 'list') assert.ok(r.view.items.length > 0 && r.view.items.every((x) => x.title), `${it.key}: items`);
    }
  }
  assert.ok(actions.length >= 6, 'cards and pages name their actions');
  // Skills from every plugin are workspace skills with their source and audience; first-party ones are live.
  const contributed = (await s.db.select().from(skills)).filter((x) => x.source.startsWith('plugin:'));
  assert.ok(contributed.length >= 10, `${contributed.length} skills`);
  assert.ok(contributed.every((x) => x.enabled === 1 && x.draft === 0 && x.workspaceId === s.ws.id));
  assert.ok(contributed.some((x) => x.name === 'crm-deal-review' && JSON.parse(x.audience).includes('function:sales')));
});

test('contributions install, disable, enable and uninstall with the plugin: skills archived never deleted, guidance and UI rows unwound and restored', async () => {
  const s = await setup();
  await withMock(s, 'crm');
  const li = (await s.plugins.installOf(s.ws.id, 'crm@yaam'))!;
  const rows = () => s.db.select().from(pluginContributions).where(eq(pluginContributions.installId, li.install.id));
  const skill = async () => (await s.db.select().from(skills).where(eq(skills.name, 'crm-deal-review'))).at(0);
  assert.deepEqual((await rows()).map((r) => `${r.kind}:${r.key}`).sort(), ['action:log-call', 'card:pipeline', 'guidance:pipeline-hygiene', 'page:deals']);
  assert.equal((await skill())!.enabled, 1);
  assert.equal((await skill())!.source, 'plugin:crm@yaam');
  const effects = (await s.plugins.effects(li.install.id)).map((e) => e.kind);
  for (const k of ['skill', 'guidance', 'card', 'page', 'action']) assert.ok(effects.includes(k), k);
  // The review shows the real text and every extension point.
  const review = await s.plugins.review(s.ws.id, { firstParty: 'crm' }) as { contributions: { skills: Array<{ name: string; text: string }>; guidance: Array<{ text: string }>; ui: { cards: Array<{ placement: string }> } } };
  assert.ok(review.contributions.skills[0].text.length > 100);
  assert.match(review.contributions.guidance[0].text, /Money dashboard/);
  assert.equal(review.contributions.ui.cards[0].placement, 'money');
  // Disable: everything leaves; enable: everything returns exactly.
  await s.plugins.disable(s.ws.id, 'crm-mock@yaam');
  await s.plugins.disable(s.ws.id, 'crm@yaam');
  assert.equal((await rows()).length, 0);
  assert.equal((await skill())!.enabled, 0);
  assert.equal((await s.ui.list(s.ws.id)).items.length, 0);
  await s.plugins.enable(s.ws.id, 'crm@yaam');
  assert.equal((await rows()).length, 4);
  assert.equal((await skill())!.enabled, 1);
  // Without a bound provider the contributions wait, named.
  const waiting = (await s.ui.list(s.ws.id, 'money')).items;
  assert.ok(waiting.length > 0 && waiting.every((w) => !w.ready && w.waitingOn.includes('crm')));
  await s.plugins.enable(s.ws.id, 'crm-mock@yaam');
  await s.plugins.setBinding(s.ws.id, 'crm', { scopeKind: 'workspace', providerId: 'crm-mock@yaam' }).catch(() => undefined);
  assert.ok((await s.ui.list(s.ws.id, 'money')).items.every((w) => w.ready));
  // Uninstall leaves no contribution behind; the skill row stays, archived.
  await s.plugins.uninstall(s.ws.id, 'crm-mock@yaam');
  await s.plugins.uninstall(s.ws.id, 'crm@yaam');
  assert.equal((await s.db.select().from(pluginContributions)).length, 0);
  assert.equal((await skill())!.enabled, 0, 'archived, never deleted');
  // Reinstall brings the same skill back live (same source), not a duplicate.
  await withMock(s, 'crm');
  assert.equal((await s.db.select().from(skills).where(eq(skills.name, 'crm-deal-review'))).length, 1);
  assert.equal((await skill())!.enabled, 1);
});

test('a skill from another source with the same name is not taken over; a non-first-party skill lands as a draft', async () => {
  const s = await setup();
  await s.skills.create({ name: 'crm-deal-review', instructions: 'mine', workspaceId: s.ws.id });
  await assert.rejects(s.plugins.install(s.ws.id, { firstParty: 'crm' }, { confirm: true }), /already exists and was not contributed/);
  const d = await s.skills.contribute({ workspaceId: s.ws.id, name: 'local-x', description: 'x', instructions: 'y', audience: ['all'], source: 'plugin:x@local', draft: true });
  assert.equal(d.draft, 1);
  assert.equal(d.enabled, 0);
});

test('UI actions go through the policy stage: a member reads but never acts, the owner confirms, two-key never runs from a button, an owner deny refuses', async () => {
  const s = await setup();
  await withMock(s, 'crm');
  await withMock(s, 'campaigns');
  const { items, actions } = await s.ui.list(s.ws.id);
  const id = (key: string) => [...items, ...actions].find((x) => x.key === key)!.id;
  // A member may read a card.
  const card = await asMember(s, () => s.ui.data(s.ws.id, id('pipeline'), {}));
  assert.equal(card.view.kind, 'stats');
  // An action that writes outside: the member is refused; the owner is asked first.
  await assert.rejects(asMember(s, () => s.ui.invoke(s.ws.id, id('log-call'), { fields: { dealId: 'D-7', note: 'hi' }, confirm: true })), /only the workspace owner/);
  await assert.rejects(s.ui.invoke(s.ws.id, id('log-call'), { fields: { dealId: 'D-7' } }), /What was said is required/);
  const ask = await s.ui.invoke(s.ws.id, id('log-call'), { fields: { dealId: 'D-7', note: 'Discussed renewal' } });
  assert.equal(ask.status, 'confirm');
  assert.equal(ask.class, 'external_reversible');
  const done = await s.ui.invoke(s.ws.id, id('log-call'), { fields: { dealId: 'D-7', note: 'Discussed renewal' }, confirm: true });
  assert.equal(done.status, 'done');
  assert.deepEqual(done.output, { id: 'act-1', dealId: 'D-7', kind: 'call' });
  assert.ok((await s.db.select().from(pluginAudit)).some((a) => a.action === 'plugin_ui_call' && a.refId === 'crm.log_activity' && JSON.parse(a.payload).outcome === 'ok'));
  // Sending a campaign is irreversible and outbound: two keys, never a button.
  await assert.rejects(s.ui.invoke(s.ws.id, id('send-campaign'), { fields: { id: 'C-22' }, confirm: true }), /needs two keys/);
  // An owner policy that denies an operation refuses it here as everywhere.
  await s.plugins.putPolicy(s.ws.id, 'deny-log', { operation: 'crm.log_activity', require: 'deny', why: 'frozen pipeline' });
  await assert.rejects(s.ui.invoke(s.ws.id, id('log-call'), { fields: { dealId: 'D-7', note: 'x' }, confirm: true }), /policy denies/);
});

test('guidance: attributed, whole notes only, within the budget; audiences reach the right members', () => {
  const note = (i: number, ownerId = 'crm@yaam'): GuidanceNote => ({ ownerKind: 'plugin', ownerId, version: '1.0.0', id: `n${i}`, title: `Note ${i}`, text: 'x'.repeat(400), audience: ['all'] });
  const out = renderGuidance([note(1), note(2), note(3), note(4), note(5)]);
  assert.ok(out.text.length <= GUIDANCE_BUDGET, `${out.text.length}`);
  assert.ok(out.included.length >= 1 && out.omitted.length >= 1);
  assert.match(out.text, /\[crm@yaam 1\.0\.0\]/, 'attributed');
  assert.match(out.text, /more note\(s\) not shown/);
  assert.equal(renderGuidance([]).text, '');
  const kitFirst = renderGuidance([note(1), { ...note(2, 'revenue@yaam'), ownerKind: 'kit' }]);
  assert.ok(kitFirst.text.indexOf('revenue@yaam') < kitFirst.text.indexOf('crm@yaam'), 'kit notes first');
  const chief = { member: true, chief: true, head: false, functions: [] };
  const salesHead = { member: true, chief: false, head: true, functions: ['sales'] };
  const writer = { member: true, chief: false, head: false, functions: [] };
  const outsider = { member: false, chief: false, head: false, functions: [] };
  assert.equal(audienceReaches(['all'], outsider), true);
  assert.equal(audienceReaches(['members'], outsider), false);
  assert.equal(audienceReaches(['heads'], chief), true);
  assert.equal(audienceReaches(['function:sales'], salesHead), true);
  assert.equal(audienceReaches(['function:sales', 'chief'], writer), false);
  assert.equal(audienceReaches(['chief'], salesHead), false);
});

test('views render by selection only: links are http(s) or dropped, cells are bounded text', () => {
  const v = renderView({ kind: 'list', items: '$.items', title: '$.t', link: '$.u' }, { items: [{ t: 'a', u: 'javascript:alert(1)' }, { t: 'b', u: 'https://x.example/1' }, { t: { nested: true }, u: 'https://ok.example' }] });
  assert.equal(v.kind, 'list');
  if (v.kind !== 'list') return;
  assert.equal(v.items[0].link, undefined);
  assert.equal(v.items[1].link, 'https://x.example/1');
  assert.equal(v.items[2].title, '{"nested":true}');
  const t = renderView({ kind: 'table', rows: '$.r', columns: [{ label: 'A', value: '$.a' }], max: 1 }, { r: [{ a: 'x'.repeat(500) }, { a: 1 }] });
  assert.ok(t.kind === 'table' && t.rows[0][0].length === 200 && t.more === 1);
  const st = renderView({ kind: 'stats', items: [{ label: 'Over', value: '$.n', toneWhen: { path: '$.n', gt: 0, tone: 'bad' } }] }, { n: 3 });
  assert.ok(st.kind === 'stats' && st.items[0].tone === 'bad' && st.items[0].value === '3');
});

// ---- kits ----

test('kit manifests: strict, no security fields, playbooks must parse; every first-party kit loads', async () => {
  const kits = await loadFirstPartyKits();
  assert.equal(kits.size, 7);
  for (const k of kits.values()) assert.ok(k.manifest.playbooks!.length > 0 && Object.keys(k.files).length === k.manifest.playbooks!.length, k.manifest.id);
  const good = JSON.parse(readFileSync('kits/first-party/revenue/kit.json', 'utf8')) as Record<string, unknown>;
  assert.equal(validateKit(good).ok, true);
  const bad = (patch: Record<string, unknown>) => { const v = validateKit({ ...good, ...patch }); return v.ok ? [] : v.errors; };
  assert.ok(bad({ egress: [{ host: 'evil.example', category: 'vendor_api' }] }).some((e) => e.includes('security fields')));
  assert.ok(bad({ tools: [] }).some((e) => e.includes('security fields')));
  assert.ok(bad({ cadence: [] }).some((e) => e.includes('unknown field')));
  assert.ok(bad({ policies: [{ id: 'p', match: { operation: 'billing.charge' }, require: 'two_key', why: 'x' }] }).some((e) => e.includes('does not require')));
  assert.ok(bad({ roles: [{ key: 'a', role: 'sales-manager', title: 'A', reportsTo: 'zzz', hire: 'required' }] }).some((e) => e.includes('reportsTo')));
  assert.ok(bad({ guidance: [{ id: 'g', title: 'G', text: 'Always do this.', audience: ['all'] }] }).some((e) => e.includes('steering lint')));
});

test('kit plan is the review: interfaces with their provider choice, the new plugins with their classes and contributions, playbooks and guidance in full; writes nothing', async () => {
  const s = await setup();
  const plan = await s.kits.plan(s.ws.id, 'ship-software') as Record<string, unknown>;
  assert.deepEqual((plan.blockers as string[]), []);
  const ifaces = plan.interfaces as Array<{ name: string; choice: string; optional: boolean; options: Array<{ id: string; available: boolean }> }>;
  assert.deepEqual(ifaces.map((i) => `${i.name}:${i.choice}`), ['scm:scm-mock@yaam', 'ci:scm-mock@yaam', 'observability:observability-mock@yaam', 'flags:later']);
  assert.equal(ifaces.find((i) => i.name === 'scm')!.options.find((o) => o.id === 'github@yaam')!.available, false, 'a recommended provider not shipped yet is shown, not chosen');
  const newPlugins = (plan.plugins as Array<{ id: string; state: string; review: { operations: Array<{ op: string; effectiveClass: string }> } | null }>);
  assert.deepEqual(newPlugins.map((p) => p.id).sort(), ['ci@yaam', 'dev-workflow@yaam', 'observability-mock@yaam', 'observability@yaam', 'scm-mock@yaam', 'scm@yaam']);
  assert.ok(newPlugins.find((p) => p.id === 'scm@yaam')!.review!.operations.some((o) => o.op === 'scm.merge' && o.effectiveClass === 'external_irreversible'));
  assert.ok((plan.playbooks as Array<{ text: string }>).every((p) => p.text.length > 100));
  assert.equal(plan.company, false);
  assert.equal((await s.plugins.list(s.ws.id)).length, 0, 'the plan installs nothing');
  // Choosing flags adds its plugins; "later" for a required interface makes the outcome partial.
  const withFlags = await s.kits.plan(s.ws.id, 'ship-software', { providers: { flags: 'flags-mock@yaam', observability: 'later' } }) as Record<string, unknown>;
  assert.ok((withFlags.plugins as Array<{ id: string }>).some((p) => p.id === 'flags-mock@yaam'));
  assert.match(String(withFlags.outcome), /partial: no observability provider/);
  await assert.rejects(s.kits.plan(s.ws.id, 'ship-software', { providers: { scm: 'crm-mock@yaam' } }), /does not provide scm/);
});

test('kit install: plugins, bindings, policies, playbooks and guidance applied through the core; installing twice is a no-op; uninstall removes what it brought and keeps what was there', async () => {
  const s = await setup();
  // The owner already had crm installed: the kit reuses it and never removes it.
  await withMock(s, 'crm');
  const r = await s.kits.install(s.ws.id, 'revenue', { providers: { accounting: 'accounting-mock@yaam' } }, { confirm: true });
  assert.equal(r.installed, true);
  const view = r.install as { status: string; statusReason: string; members: Array<{ kind: string; key: string; owned: boolean; state: string }> };
  // No company here: seats cannot be hired, so the kit is partial and says why.
  assert.equal(view.status, 'partial');
  assert.match(view.statusReason, /not hired: .*company/);
  const m = (k: string, key: string) => view.members.find((x) => x.kind === k && x.key === key);
  assert.equal(m('plugin', 'crm@yaam')!.owned, false, 'reused');
  assert.equal(m('plugin', 'accounting@yaam')!.owned, true);
  assert.equal(m('binding', 'crm')!.owned, false, 'a kit never replaces a binding');
  assert.equal(m('binding', 'accounting')!.owned, true);
  assert.ok(m('skill', 'revenue-pipeline-review') && m('guidance', 'revenue'));
  assert.equal((await s.plugins.installOf(s.ws.id, 'accounting-mock@yaam'))!.install.status, 'active');
  assert.ok((await s.db.select().from(pluginContributions)).some((c) => c.ownerKind === 'kit' && c.key === 'revenue'));
  const again = await s.kits.install(s.ws.id, 'revenue', {}, { confirm: true });
  assert.equal(again.already, true);
  // Uninstall: what the kit brought leaves (owned plugins, guidance; playbooks archived); what was here stays.
  const plan = await s.kits.uninstallPlan(s.ws.id, 'revenue') as { items: Array<{ kind: string; key: string; outcome: string }> };
  assert.match(plan.items.find((i) => i.key === 'crm@yaam')!.outcome, /was here before/);
  await s.kits.uninstall(s.ws.id, 'revenue');
  assert.equal((await s.plugins.installOf(s.ws.id, 'accounting@yaam'))!.install.status, 'removed');
  assert.equal((await s.plugins.installOf(s.ws.id, 'crm@yaam'))!.install.status, 'active');
  assert.equal((await s.db.select().from(pluginContributions)).filter((c) => c.ownerKind === 'kit').length, 0);
  assert.equal((await s.db.select().from(skills).where(eq(skills.name, 'revenue-pipeline-review')))[0].enabled, 0);
  assert.equal((await s.db.select().from(kitInstalls))[0].status, 'removed');
});

test('kit install is atomic: a failing step unwinds everything the run created', async () => {
  const s = await setup();
  const realBind = s.plugins.setBinding.bind(s.plugins);
  s.plugins.setBinding = async (ws, iface, body) => { if (iface === 'observability' && body.providerId) throw new Error('binding refused (test)'); return realBind(ws, iface, body); };
  await assert.rejects(s.kits.install(s.ws.id, 'ship-software', {}, { confirm: true }), /nothing was left half-done: binding refused/);
  const left = (await s.db.select().from(pluginInstalls)).filter((i) => i.status !== 'removed');
  assert.deepEqual(left.map((i) => i.pluginId), [], 'no plugin of the kit stays installed');
  assert.equal((await s.db.select().from(pluginContributions)).length, 0);
  assert.ok((await s.db.select().from(kitMembers)).every((x) => x.state === 'removed'));
  assert.equal((await s.db.select().from(kitInstalls))[0].status, 'failed');
  // Retrying once the cause is gone works.
  s.plugins.setBinding = realBind;
  const r = await s.kits.install(s.ws.id, 'ship-software', { seats: { swe: false } }, { confirm: true });
  assert.equal((r.install as { health: Array<{ healthy: boolean }> }).health.every((h) => h.healthy), true);
});

test('kit upgrade writes a revision and adds the new version\'s members; rollback returns to the pinned previous version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kits-'));
  cpSync('kits/first-party/hiring', join(dir, 'hiring'), { recursive: true });
  const prev = process.env.YAAM_KITS_DIR;
  process.env.YAAM_KITS_DIR = dir;
  try {
    const s = await setup();
    await s.kits.install(s.ws.id, 'hiring', {}, { confirm: true });
    // Version 1.1.0 adds a playbook and a guidance note.
    const k = JSON.parse(readFileSync(join(dir, 'hiring', 'kit.json'), 'utf8')) as Record<string, unknown> & { playbooks: string[]; guidance: unknown[] };
    k.version = '1.1.0';
    k.playbooks = [...k.playbooks, 'playbooks/offer-prep.md'];
    k.guidance = [...k.guidance, { id: 'offers', title: 'Offers', audience: ['function:people'], text: 'Offers go to the owner with the scorecard evidence attached.' }];
    k.changelog = 'Adds offer preparation.';
    writeFileSync(join(dir, 'hiring', 'kit.json'), JSON.stringify(k));
    mkdirSync(join(dir, 'hiring', 'playbooks'), { recursive: true });
    writeFileSync(join(dir, 'hiring', 'playbooks', 'offer-prep.md'), '---\nname: offer-prep\ndescription: Prepare an offer for the owner.\n---\n\n1. Gather the scorecard evidence.\n2. Draft the offer terms.\n');
    s.kits.resetCatalog();
    const list = await s.kits.list(s.ws.id);
    assert.equal((list[0].update as { version: string }).version, '1.1.0');
    const up = await s.kits.upgrade(s.ws.id, 'hiring');
    assert.equal(up.applied, true);
    assert.ok((up.created as string[]).includes('skill:hiring-offer-prep'));
    assert.ok((await s.db.select().from(pluginContributions)).some((c) => c.key === 'offers'));
    const rb = await s.kits.rollback(s.ws.id, 'hiring');
    assert.equal(rb.to, '1.0.0');
    assert.deepEqual((rb.removed as string[]).sort(), ['guidance:offers', 'skill:hiring-offer-prep']);
    assert.equal((await s.db.select().from(skills).where(eq(skills.name, 'hiring-offer-prep')))[0].enabled, 0);
    assert.equal((await s.kits.list(s.ws.id))[0].version, '1.0.0');
    assert.ok(readdirSync(dir).includes('hiring'));
  } finally {
    if (prev === undefined) delete process.env.YAAM_KITS_DIR; else process.env.YAAM_KITS_DIR = prev;
  }
});

test('only the owner installs kits', async () => {
  const s = await setup();
  await assert.rejects(asMember(s, () => s.kits.install(s.ws.id, 'hiring', {}, { confirm: true })), /only the workspace owner/);
  const p = await asMember(s, () => s.kits.plan(s.ws.id, 'hiring'));
  assert.ok(p, 'members may read the plan');
});

void ({} as Manifest);
