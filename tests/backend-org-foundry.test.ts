/** Foundry for the chief of staff and the heads (docs/foundry.md §4.7,
 *  docs/plugins.md §3.8): org_foundry_search / _detail / _installed read;
 *  org_foundry_propose writes a CEO card and installs nothing; approving
 *  the card installs the kit (plugins, bindings, seats hired through the
 *  org's own hire path with their grants); the trust policy may let the
 *  chief apply first-party installs in an autonomous company; guidance
 *  reaches agents by audience, attributed and logged; contributed skills
 *  reach their audience only; the briefing names what is installed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { setup as harness, enable, sessionOf, type S as H } from './org-governance-harness';
import { SkillsService } from '../server/src/skills/skills.service';
import { PluginAuditService } from '../server/src/plugins/plugin-audit';
import { PluginsService } from '../server/src/plugins/plugins.service';
import { KitsService } from '../server/src/foundry/kits.service';
import { OrgFoundryTools } from '../server/src/org/org-foundry.tools';
import { OrgBriefingService } from '../server/src/org/org-briefing.service';
import { GUIDANCE_BUDGET } from '../server/src/plugins/contributions';
import { contextProvenance, orgApprovals, pluginGrants } from '../server/src/database/schema';

async function setup() {
  const s = await harness();
  const skills = new SkillsService(s.db);
  const audit = new PluginAuditService(s.db, s.actions);
  const plugins = new PluginsService(s.db, audit, s.actions, skills);
  const kits = new KitsService(s.db, plugins, audit, skills);
  const briefing = new OrgBriefingService(s.db, s.org, s.audit, s.tasks, s.agents, s.config, undefined, s.units, s.intent, s.runtime);
  const foundry = new OrgFoundryTools(s.db, s.org, s.runtime, s.approvals, plugins, kits, s.agents, s.config, skills, briefing, s.turns);
  return { ...s, skills, plugins, kits, foundry, briefing };
}
type S = Awaited<ReturnType<typeof setup>>;
const call = async (s: S | H & { foundry: OrgFoundryTools }, agentId: string, name: string, input: Record<string, unknown> = {}) => (s as S).foundry.execute(await sessionOf(s as H, agentId), name, input);

test('the chief and the heads get the Foundry tools; a specialist does not; names are unique', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const names = async (id: string) => (await s.foundry.specsFor(await sessionOf(s, id))).map((t) => t.name).sort();
  assert.deepEqual(await names(s.chief.id), ['org_foundry_detail', 'org_foundry_installed', 'org_foundry_propose', 'org_foundry_search']);
  assert.deepEqual(await names(s.writer.id), []);
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Sales' });
  assert.deepEqual(await names(s.writer.id), ['org_foundry_detail', 'org_foundry_installed', 'org_foundry_propose', 'org_foundry_search']);
  // The tools are this provider's alone (tests/backend-tool-names.test.ts checks every org file).
  for (const n of await names(s.chief.id)) assert.equal(s.foundry.owns(n), true);
  assert.equal(s.runtime.owns('org_foundry_search'), false);
});

test('the chief browses kits and plugins, reads one in detail, and sees what is installed', async () => {
  const s = await setup();
  await enable(s);
  const found = await call(s, s.chief.id, 'org_foundry_search', { q: 'crm' });
  assert.match(found, /\[kit\] Revenue \(revenue@yaam 1\.0\.0\)/);
  assert.match(found, /\[plugin\] CRM \(interface\) \(crm@yaam/);
  assert.match(await call(s, s.chief.id, 'org_foundry_search', { shelf: 'kits', fn: 'finance' }), /Finance Close/);
  const plugin = await call(s, s.chief.id, 'org_foundry_detail', { id: 'crm@yaam' });
  assert.match(plugin, /crm\.log_activity=external_reversible/);
  assert.match(plugin, /Skills: crm-deal-review/);
  assert.match(plugin, /card "Pipeline" on money \(crm\.pipeline_summary\)/);
  const kit = await call(s, s.chief.id, 'org_foundry_detail', { id: 'revenue' });
  assert.match(kit, /Seats: Head of Sales \[sales-head, role:sales-manager, required\]/);
  assert.match(kit, /Not installed here/);
  assert.match(await call(s, s.chief.id, 'org_foundry_installed'), /Kits \(0\):\n- none\nPlugins \(0\)/);
});

test('a proposal is a CEO card and installs nothing; approving it installs the kit, hires its seats with their grants, and the chief sees it installed', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const out = await call(s, s.chief.id, 'org_foundry_propose', { kind: 'kit', id: 'revenue', action: 'install', why: 'The sales key result has no pipeline to measure.', recommend: 'approve', alternatives: ['do nothing: keep the spreadsheet'], confidence: 0.7, seats: { ae: false } });
  assert.match(out, /Card [0-9a-f]{8} waits on the CEO; nothing is installed/);
  assert.equal((await s.plugins.list(s.ws.id)).length, 0);
  const card = (await s.db.select().from(orgApprovals).where(eq(orgApprovals.orgId, orgId))).find((a) => a.kind === 'kit_change')!;
  assert.equal(card.status, 'pending');
  const payload = JSON.parse(card.payload) as { plan: { newPlugins: string[]; seats: string[] } };
  assert.ok(payload.plan.newPlugins.includes('crm@yaam') && payload.plan.newPlugins.includes('crm-mock@yaam'));
  assert.deepEqual(payload.plan.seats, ['Head of Sales']);
  // The CEO approves: the kit installs through the core, the head is hired and granted.
  const { result } = await s.approvals.decide(orgId, card.id, 'approve');
  assert.equal(result!.status, 'active');
  const head = (await s.org.members(orgId)).find((m) => m.title === 'Head of Sales')!;
  assert.ok(head, 'the seat was hired');
  const crmMock = (await s.plugins.installOf(s.ws.id, 'crm-mock@yaam'))!;
  assert.equal((await s.db.select().from(pluginGrants).where(eq(pluginGrants.agentId, head.agentId))).find((g) => g.installId === crmMock.install.id)!.level, 'write');
  const installed = await call(s, s.chief.id, 'org_foundry_installed');
  assert.match(installed, /Revenue 1\.0\.0: active; crm → crm-mock@yaam/);
  // A second install proposal is refused with the reason; a removal is a card too.
  await assert.rejects(call(s, s.chief.id, 'org_foundry_propose', { kind: 'kit', id: 'revenue', action: 'install', why: 'x', recommend: 'approve', alternatives: [] }), /already installed/);
  assert.match(await call(s, s.chief.id, 'org_foundry_propose', { kind: 'kit', id: 'revenue', action: 'remove', why: 'unused', recommend: 'approve', alternatives: ['keep it'] }), /waits on the CEO/);
  // Guidance from the kit and its plugins reaches the sales head, attributed and logged, within the budget.
  const ctx = (await s.foundry.contextFor(await sessionOf(s, head.agentId)))!;
  assert.match(ctx, /# Plugin guidance/);
  assert.match(ctx, /How sales works here \[revenue@yaam 1\.0\.0\]/);
  assert.match(ctx, /Pipeline hygiene \[crm@yaam 1\.0\.0\]/);
  assert.ok(ctx.length <= GUIDANCE_BUDGET);
  assert.ok((await s.db.select().from(contextProvenance)).some((p) => p.sourceKind === 'guidance' && p.contributionId === 'crm@yaam#pipeline-hygiene'));
  // The editor is not in sales: no sales note.
  const other = await s.foundry.contextFor(await sessionOf(s, s.editor.id));
  assert.ok(!other || !/Pipeline hygiene/.test(other));
  // Skills reach their audience only.
  const headSkills = (await s.skills.toolSpecs(s.ws.id, head.agentId)).map((t) => t.name);
  const editorSkills = (await s.skills.toolSpecs(s.ws.id, s.editor.id)).map((t) => t.name);
  assert.ok(headSkills.includes('skill_crm_deal_review'));
  assert.ok(!editorSkills.includes('skill_crm_deal_review'));
  assert.equal(await s.skills.resolveTool(s.ws.id, 'skill_crm_deal_review', s.editor.id), undefined);
  // The briefing names what is installed for the chief and heads.
  s.briefing.invalidate(orgId);
  assert.match((await s.briefing.briefingFor(s.chief.id))!, /Installed: kits Revenue; plugins/);
});

test('a plugin proposal binds an unbound interface it provides on approval; the trust policy lets the chief apply first-party installs in an autonomous company', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous');
  await s.plugins.install(s.ws.id, { firstParty: 'kb' }, { confirm: true });
  await call(s, s.chief.id, 'org_foundry_propose', { kind: 'plugin', id: 'kb-mock', action: 'install', why: 'Answers need the docs.', recommend: 'approve', alternatives: ['none'] });
  const card = (await s.db.select().from(orgApprovals).where(eq(orgApprovals.orgId, orgId))).find((a) => a.kind === 'plugin_change')!;
  const { result } = await s.approvals.decide(orgId, card.id, 'approve');
  assert.deepEqual(result!.bound, ['kb']);
  // With the owner's trust policy, the chief's first-party install applies at once (removals stay cards).
  await s.plugins.setWorkspaceSettings(s.ws.id, { agentInstalls: 'first_party' });
  const out = await call(s, s.chief.id, 'org_foundry_propose', { kind: 'kit', id: 'hiring', action: 'install', why: 'We hire humans next quarter.', recommend: 'approve', alternatives: ['none'] });
  assert.match(out, /Applied at once under the workspace's trust policy/);
  assert.equal((await s.kits.list(s.ws.id))[0].kitId, 'hiring@yaam');
  assert.match(await call(s, s.chief.id, 'org_foundry_propose', { kind: 'kit', id: 'hiring', action: 'remove', why: 'x', recommend: 'approve', alternatives: [] }), /waits on the CEO/);
});
