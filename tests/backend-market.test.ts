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
