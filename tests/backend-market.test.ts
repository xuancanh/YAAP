/** Market profession packs: hire installs the agent plus its bundled skills
 *  as agent-private skills; skill bodies never leave the server in list().
 *  The two-layer market: the build scripts' segment, function and level
 *  fields, and the service's grouping and counts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIZ_FUNCTIONS, PERSONAL_CATS, orgHireRef, segmentSummary } from '../server/src/market/segments';
import { ROLES } from '../server/src/org/roles/catalog';
import { MarketService } from '../server/src/market/market.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { PROFESSION_PACKS } from '../server/src/market/profession-packs.generated';
import { AUTHORED_PACKS } from '../server/src/market/authored-packs.generated';
import { testDb, memStorage } from './helpers';

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const skills = new SkillsService(db);
  return { market: new MarketService(agents, skills), agents, skills };
}

test('the catalog carries the profession packs, with skill bodies stripped from list()', async () => {
  const { market } = await setup();
  const items = await market.list();
  const marketer = items.find((m) => m.id === 'pro-marketing')!;
  assert.ok(marketer, 'marketing pack listed');
  assert.equal(marketer.hired, false);
  assert.ok(marketer.skills!.length >= 5);
  for (const s of marketer.skills!) {
    assert.ok(s.name && s.description !== undefined);
    assert.ok(!('instructions' in s), 'instructions must not ship to the client');
  }
  // every generated pack has at least one skill and a charter
  for (const p of [...PROFESSION_PACKS, ...AUTHORED_PACKS]) {
    assert.ok(p.skills!.length > 0, `${p.id} has skills`);
    assert.ok(p.charter.length > 100, `${p.id} has a charter`);
  }
  // ids and names stay unique across both generated catalogs
  const all = [...PROFESSION_PACKS, ...AUTHORED_PACKS];
  assert.equal(new Set(all.map((p) => p.id)).size, all.length, 'unique ids');
  assert.equal(new Set(all.map((p) => p.name)).size, all.length, 'unique names');
});

test('the business catalog: function heads and specialists carry the business tail, Business category and the head playbooks', () => {
  const biz = AUTHORED_PACKS.filter((p) => p.id.startsWith('pack-biz-'));
  const heads = biz.filter((p) => p.id.endsWith('-manager'));
  assert.ok(heads.length >= 13 && biz.length >= heads.length * 3, `${heads.length} heads, ${biz.length} packs`);
  for (const p of biz) {
    assert.equal(p.cat, 'Business', p.id);
    assert.match(p.charter, /You work as a member of a company of agents/, `${p.id} has the business tail`);
    assert.doesNotMatch(p.charter, /Ask for missing personal context/, `${p.id} has no personal tail`);
    assert.ok(p.skills!.length >= 3 && p.skills!.length <= 10, `${p.id}: ${p.skills!.length} skills`);
    assert.ok(p.caps.includes('org'), `${p.id} shows the org capability`);
  }
  for (const h of heads) {
    const fn = h.id.replace(/^pack-biz-/, '').replace(/-manager$/, '');
    const names = h.skills!.map((s) => s.name);
    for (const core of ['okr-planning', 'weekly-review', 'kpi-audit', 'report', 'team-management']) assert.ok(names.includes(`${fn}-${core}`), `${h.id} has ${fn}-${core}`);
    assert.ok(h.loops.length >= 2, `${h.id} has cadence loops`);
    // mechanisms adapt: planning reads the operating profile instead of hard-coding the cadence
    assert.match(h.skills!.find((s) => s.name === `${fn}-okr-planning`)!.instructions, /org_intent/);
  }
  // the personal packs keep their tail
  assert.match(AUTHORED_PACKS.find((p) => p.id === 'pack-trip-planner')!.charter, /Ask for missing personal context/);
  assert.doesNotMatch(AUTHORED_PACKS.find((p) => p.id === 'pack-auditor')!.charter, /You work as a member of a company of agents/);
});

test('hiring an authored casual pack installs its skills and loops', async () => {
  const { market, skills } = await setup();
  const { agent } = await market.hire('pack-trip-planner');
  assert.equal(agent.name, 'Trip Planner');
  const own = (await skills.list(undefined, agent.id)).filter((s) => s.agentId === agent.id);
  const names = own.map((s) => s.name);
  assert.ok(names.includes('itinerary-builder') && names.includes('packing-list'), `installed: ${names.join(',')}`);

  const { agent: lifeAdmin } = await market.hire('pack-life-admin');
  const loops = JSON.parse(lifeAdmin.loops) as Array<{ name: string; cron: string; prompt?: string }>;
  assert.equal(loops.length, 2);
  assert.match(loops[0].prompt ?? '', /daily-briefing/);
});

test('hiring a pack installs its skills private to the hired agent', async () => {
  const { market, skills } = await setup();
  const { agent } = await market.hire('pro-marketing');
  assert.equal(agent.name, 'Marketer');

  const own = await skills.list(undefined, agent.id);
  const names = own.filter((s) => s.agentId === agent.id).map((s) => s.name);
  assert.ok(names.includes('brand-review') && names.includes('campaign-plan'), `installed: ${names.join(',')}`);
  const brand = own.find((s) => s.name === 'brand-review')!;
  assert.equal(brand.enabled, 1);
  assert.equal(brand.draft, 0);
  assert.ok(brand.instructions.length > 500, 'full playbook body installed');

  // invisible outside the agent
  const shared = await skills.list();
  assert.ok(!shared.some((s) => s.name === 'brand-review'), 'pack skills are not workspace-shared');

  // a second hire of the same pack conflicts
  await assert.rejects(market.hire('pro-marketing'), /already hired/);
  assert.equal((await market.list()).find((m) => m.id === 'pro-marketing')!.hired, true);
});

test('pack loops install with their prompts and enable on hire', async () => {
  const { market } = await setup();
  const { agent } = await market.hire('pro-sales');
  const loops = JSON.parse(agent.loops) as Array<{ name: string; cron: string; prompt?: string }>;
  assert.equal(loops.length, 1);
  assert.equal(loops[0].cron, '0 8 * * 1-5');
  assert.match(loops[0].prompt ?? '', /daily-briefing/);
});

test('the hire review can read the real skill bodies, not just their names', async () => {
  const { market } = await setup();
  // list() still strips bodies (they would bloat every catalog fetch)…
  const listed = (await market.list()).find((m) => m.id === 'pro-marketing')!;
  assert.ok(!('instructions' in listed.skills![0]));
  // …and the review endpoint serves them in full, so the gate shows the real
  // artifact (docs/permissions.md) rather than a summary.
  const bodies = market.packSkills('pro-marketing');
  assert.equal(bodies.length, listed.skills!.length);
  for (const s of bodies) {
    assert.ok(s.name && s.description !== undefined);
    assert.ok(s.instructions.length > 200, `${s.name} body served in full`);
  }
  const brand = bodies.find((s) => s.name === 'brand-review')!;
  assert.ok(brand, 'named skill present');
  assert.throws(() => market.packSkills('no-such-pack'), /market item/);
});

// ---- the two-layer market (docs/agent-catalog.md "Segments and functions") ----

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FN_IDS = BIZ_FUNCTIONS.map((f) => f.id);

/** Run the authored-pack build against `src`, writing to a scratch file. */
function buildAuthored(src: string) {
  const dir = mkdtempSync(join(tmpdir(), 'packs-out-'));
  const out = join(dir, 'out.ts');
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/build-authored-packs.mjs')], { env: { ...process.env, PACKS_SRC: src, PACKS_OUT: out }, encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, out: r.status === 0 ? readFileSync(out, 'utf8') : '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('build script: the committed authored packs are what the build emits from packs/*.md', () => {
  const r = buildAuthored(join(ROOT, 'packs'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out, readFileSync(join(ROOT, 'server/src/market/authored-packs.generated.ts'), 'utf8'), 'regenerate with node scripts/build-authored-packs.mjs');
});

test('build script: every business pack carries segment, function and level; personal packs default to personal', () => {
  const biz = AUTHORED_PACKS.filter((p) => p.cat === 'Business');
  assert.equal(biz.length, 54, 'the 52 function packs, the chief of staff and the auditor');
  for (const p of biz) {
    assert.equal(p.segment, 'business', p.id);
    assert.ok(FN_IDS.includes(p.function!), `${p.id}: ${p.function}`);
    assert.ok(['head', 'specialist', 'leadership'].includes(p.level!), `${p.id}: ${p.level}`);
  }
  for (const id of ['pack-chief-of-staff', 'pack-auditor']) {
    const p = AUTHORED_PACKS.find((x) => x.id === id)!;
    assert.equal(p.function, 'leadership'); assert.equal(p.level, 'leadership'); assert.equal(p.reportsTo, undefined);
  }
  const heads = biz.filter((p) => p.level === 'head');
  assert.equal(heads.length, 13, 'one head per function');
  assert.deepEqual(new Set(heads.map((h) => h.function)), new Set(FN_IDS.filter((f) => f !== 'leadership')));
  for (const h of heads) {
    assert.match(h.id, /-manager$/); assert.equal(h.reportsTo, 'pack-chief-of-staff');
    assert.ok(h.kpis!.length >= 3 && h.cadence, `${h.id} shows its KPIs and cadence`);
  }
  for (const s of biz.filter((p) => p.level === 'specialist')) {
    const boss = AUTHORED_PACKS.find((p) => p.id === s.reportsTo)!;
    assert.ok(boss, `${s.id} reports to a pack`);
    assert.equal(boss.level, 'head'); assert.equal(boss.function, s.function, `${s.id} reports inside its function`);
    assert.ok(s.kpis!.length >= 1, `${s.id} has KPIs`);
  }
  for (const p of AUTHORED_PACKS.filter((x) => x.cat !== 'Business')) {
    assert.equal(p.segment, 'personal', p.id);
    assert.equal(p.function, undefined); assert.equal(p.level, undefined);
    assert.ok(PERSONAL_CATS.includes(p.cat), `${p.id}: ${p.cat} is a known personal category`);
  }
});

test('build script: profession packs are classified by the build (function toolkits are business, solo packs personal)', () => {
  const by = Object.fromEntries(PROFESSION_PACKS.map((p) => [p.id, p]));
  const expected: Record<string, string> = {
    'pro-marketing': 'marketing', 'pro-sales': 'sales', 'pro-support': 'customer', 'pro-finance': 'finance', 'pro-legal': 'legal',
    'pro-hr': 'people', 'pro-operations': 'operations', 'pro-product': 'product', 'pro-design': 'design', 'pro-data': 'data', 'pro-engineering': 'engineering',
  };
  for (const [id, fn] of Object.entries(expected)) {
    assert.equal(by[id].segment, 'business', id); assert.equal(by[id].function, fn, id); assert.equal(by[id].level, 'specialist', id);
    assert.equal(by[id].reportsTo, undefined, `${id} is a generalist: no reporting line`);
  }
  for (const id of ['pro-smb', 'pro-research']) { assert.equal(by[id].segment, 'personal', id); assert.equal(by[id].function, undefined); }
  assert.equal(PROFESSION_PACKS.length, 13);
  // the script carries the classification (the generated file is never hand-edited)
  const script = readFileSync(join(ROOT, 'scripts/build-profession-packs.mjs'), 'utf8');
  assert.match(script, /id: 'pro-finance'.*\n.*segment: 'business', function: 'finance', level: 'specialist'/);
  assert.match(script, /--meta-only/);
});

test('build script: bad segment metadata is refused', () => {
  const src = mkdtempSync(join(tmpdir(), 'packs-src-'));
  try {
    for (const f of ['chief-of-staff.md', 'biz-finance-manager.md', 'biz-finance-fpa.md', 'trip-planner.md']) cpSync(join(ROOT, 'packs', f), join(src, f));
    assert.equal(buildAuthored(src).status, 0, 'the sample builds');
    const fpa = join(src, 'biz-finance-fpa.md');
    const good = readFileSync(fpa, 'utf8');
    writeFileSync(fpa, good.replace('"function": "finance"', '"function": "astrology"'));
    assert.match(buildAuthored(src).stderr, /unknown function astrology/);
    writeFileSync(fpa, good.replace('"reportsTo": "pack-biz-finance-manager"', '"reportsTo": "pack-chief-of-staff"'));
    assert.match(buildAuthored(src).stderr, /reports to its function's head/);
    writeFileSync(fpa, good.replace('"segment": "business"', '"segment": "personal"'));
    assert.match(buildAuthored(src).stderr, /business-tail pack must be in the business segment/);
    writeFileSync(fpa, good);
    const trip = join(src, 'trip-planner.md');
    writeFileSync(trip, readFileSync(trip, 'utf8').replace(/"cat": "([^"]+)",/, '"cat": "$1", "level": "head",'));
    assert.match(buildAuthored(src).stderr, /level is for business packs only/);
  } finally { rmSync(src, { recursive: true, force: true }); }
  assert.ok(readdirSync(join(ROOT, 'packs')).length > 100, 'the real packs are untouched');
});

test('market service: list() carries the segment and the company hire ref; segments() groups and counts', async () => {
  const { market } = await setup();
  const items = await market.list();
  for (const m of items) assert.ok(m.segment === 'personal' || m.segment === 'business', m.id);
  const ref = (id: string) => items.find((m) => m.id === id)!.orgHire;
  assert.equal(ref('pack-biz-finance-manager'), 'role:finance-manager');
  assert.equal(ref('pack-biz-cs-csm'), 'role:cs-csm');
  assert.equal(ref('pack-auditor'), 'pack-auditor', 'no role names the auditor pack: a pack hire');
  assert.equal(ref('pro-finance'), 'pro-finance');
  assert.equal(ref('pack-chief-of-staff'), null, 'the chief seat is set when the company starts');
  assert.equal(ref('pack-trip-planner'), null);
  // every function pack resolves through its catalog role (Role.packId)
  for (const m of items.filter((x) => x.id.startsWith('pack-biz-'))) {
    const role = ROLES.find((r) => `role:${r.id}` === m.orgHire);
    assert.equal(role?.packId, m.id, m.id);
  }
  assert.equal(orgHireRef({ id: 'x', segment: undefined }), null, 'registry items without a segment are personal');

  const seg = market.segments();
  assert.equal(seg.personal.total + seg.business.total, items.length);
  assert.equal(seg.business.total, 54 + 11);
  assert.deepEqual(seg.business.functions.map((f) => f.id), FN_IDS, 'all fourteen, in rail order');
  const fin = seg.business.functions.find((f) => f.id === 'finance')!;
  assert.equal(fin.label, 'Finance'); assert.equal(fin.count, 5, 'head, three specialists and Bookkeeper'); assert.equal(fin.headId, 'pack-biz-finance-manager');
  const lead = seg.business.functions.find((f) => f.id === 'leadership')!;
  assert.equal(lead.count, 2); assert.equal(lead.headId, null);
  assert.ok(!seg.personal.cats.some((c) => c.cat === 'Business'), 'Business is a segment, not a category');
  assert.ok(!seg.personal.cats.some((c) => c.cat === 'Product & Engineering'), 'its four packs moved to business functions');
  assert.equal(seg.personal.cats[0].cat, 'Workplace');
  assert.equal(seg.personal.cats.reduce((n, c) => n + c.count, 0), seg.personal.total);
  // an unknown function still counts, after the known ones
  const extra = segmentSummary([{ id: 'a', cat: 'X', segment: 'business', function: 'astro', level: 'specialist' }]);
  assert.deepEqual(extra.business.functions.map((f) => f.id), ['astro']);
});
