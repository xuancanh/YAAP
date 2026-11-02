/** Market profession packs: hire installs the agent plus its bundled skills
 *  as agent-private skills; skill bodies never leave the server in list(). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
