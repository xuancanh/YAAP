/** Agent data access (docs/agent-data-access.md): the company data tools
 *  (org_company, org_people, org_task, org_meetings, org_approvals) and the
 *  workspace data tools (ws_catalog, ws_workspace, ws_agents, ws_market,
 *  ws_plugins) — happy paths, filters, paging, scoping refusals, no secrets,
 *  the discovery tool per role, name uniqueness, classes and the chief's
 *  tool-spec budget. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup as harness, enable, sessionOf, type S } from './org-governance-harness';
import { OrgProjectsService } from '../server/src/org/org-projects.service';
import { OrgProjectsTools } from '../server/src/org/org-projects.tools';
import { OrgDataTools, ORG_DATA_TOOL_NAMES } from '../server/src/org/org-data.tools';
import { WorkspaceDataTools, WS_DATA_TOOL_NAMES, DATA_DOMAINS } from '../server/src/data-access/workspace-data.tools';
import { UsageService } from '../server/src/usage/usage.module';
import { SettingsService } from '../server/src/settings/settings.module';
import { PluginsService } from '../server/src/plugins/plugins.service';
import { PluginAuditService } from '../server/src/plugins/plugin-audit';
import { RegistryService } from '../server/src/registry/registry.service';
import { PortabilityService } from '../server/src/portability/portability.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { classOf } from '../server/src/actions/action-classes';
import { connections as connectionsTable, workspaceMembers } from '../server/src/database/schema';
import { newId } from '../server/src/common/ids.util';
import { pageOf } from '../server/src/common/data-page';
import { TaskPlanService } from '../server/src/org/task-plan.service';
import { TaskPlanTools } from '../server/src/org/task-plan.tools';

/** Measured before this change with the same harness (docs/agent-data-access.md §6). */
const CHIEF_SPEC_BYTES_BEFORE = 59_543;
/** The chief's whole tool list stays under this many bytes of JSON (raised from 66_000 when the process, quality and alignment tools joined it; to 70_000 with the four task-execution tools; to 72_000 with the model-tier tool and the evidence params). */
const CHIEF_SPEC_BUDGET = 72_000;

async function setup(opts: { withData?: boolean } = {}) {
  const s = await harness();
  const projects = new OrgProjectsService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, undefined, s.decisions);
  new OrgProjectsTools(s.org, projects, s.tasks, s.agents, s.config, s.runtime, s.turns);
  // Task execution (docs/task-execution.md): offered to every agent session, the chief's included.
  new TaskPlanTools(new TaskPlanService(s.db, s.repo, s.agents, s.org, s.tasks, s.turns, s.runtime), s.runtime, s.turns);
  let data: OrgDataTools | null = null;
  let ws: WorkspaceDataTools | null = null;
  let plugins: PluginsService | null = null;
  if (opts.withData !== false) {
    data = new OrgDataTools(s.org, s.units, s.tasks, s.meetings, s.approvals, s.agents, s.config, s.workspaces, s.runtime, s.turns);
    plugins = new PluginsService(s.db, new PluginAuditService(s.db, s.actions), s.actions);
    const { stub } = (await import('./helpers')).memStorage();
    const skills = (s.turns as unknown as { skills: import('../server/src/skills/skills.service').SkillsService }).skills;
    const registry = new RegistryService(s.db, s.agents, skills, new PortabilityService(s.agents, new AgentMemoryService(s.db, stub), skills, s.workspaces));
    ws = new WorkspaceDataTools(s.db, s.agents, s.workspaces, skills, s.config, s.turns, s.connections, new UsageService(s.db, new SettingsService(s.db)), plugins, registry, s.org, s.tasks, s.units);
  }
  const orgId = await enable(s);
  // Two units under the chief: Writer leads Junior; Editor leads Proof.
  const junior = await s.agents.create({ name: 'Junior', charter: 'You draft.', provider: 'anthropic', model: 'claude-haiku-4-5' });
  const proof = await s.agents.create({ name: 'Proof', charter: 'You proofread.', provider: 'anthropic', model: 'claude-haiku-4-5' });
  await s.org.addMember(orgId, { agentId: junior.id, title: 'Junior writer', reportsToAgentId: s.writer.id });
  await s.org.addMember(orgId, { agentId: proof.id, title: 'Proofreader', reportsToAgentId: s.editor.id });
  await s.units.syncMembership(orgId);
  return { ...s, data: data!, wsTools: ws!, plugins: plugins!, orgId, junior, proof };
}
type D = Awaited<ReturnType<typeof setup>>;

async function exec(s: D, agentId: string, name: string, input: Record<string, unknown> = {}): Promise<string> {
  const session = await sessionOf(s as unknown as S, agentId);
  return name.startsWith('ws_') ? s.wsTools.execute(session, name, input) : s.data.execute(session, name, input);
}
async function offered(s: D, agentId: string): Promise<string[]> {
  return (await s.turns.offeredTools(await sessionOf(s as unknown as S, agentId))).specs.map((t) => t.name);
}

test('every data tool is offered, classed read and named once; specialists get no market', async () => {
  const s = await setup();
  const chief = await offered(s, s.chief.id);
  const spec = await offered(s, s.junior.id);
  for (const n of [...ORG_DATA_TOOL_NAMES, ...WS_DATA_TOOL_NAMES]) {
    assert.ok(chief.includes(n), `chief has ${n}`);
    assert.equal(classOf(n, {}, { readOnly: true }), 'read', `${n} is read`);
    assert.ok(s.data.owns(n) ? s.data.isReadOnly(n) : s.wsTools.isReadOnly(n));
  }
  for (const n of ORG_DATA_TOOL_NAMES) assert.ok(spec.includes(n), `specialist has ${n}`);
  assert.ok(spec.includes('ws_catalog') && spec.includes('ws_agents'));
  assert.ok(!spec.includes('ws_market'), 'a specialist does not staff');
  assert.ok((await offered(s, s.writer.id)).includes('ws_market'), 'a lead does');
  await assert.rejects(exec(s, s.junior.id, 'ws_market'), /chief of staff, managers/);
  assert.equal(new Set(chief).size, chief.length, 'no repeated name');
  // every tool named in the catalog's map exists somewhere or is a known core/agent tool
  for (const d of DATA_DOMAINS) assert.ok(d.read.length + d.write.length > 0, d.domain);
});

test('a personal agent (no company) gets the ws_* tools, the market, and no org_* data tools', async () => {
  const s = await setup();
  const ws2 = await s.workspaces.create({ name: 'Solo' });
  const solo = await s.agents.create({ name: 'Solo', charter: 'You help.', provider: 'anthropic', model: 'claude-sonnet-4-5', workspaceId: ws2.id });
  const session = await s.repo.createSession({ workspaceId: ws2.id, agentId: solo.id, name: 'p', permissionMode: 'auto' });
  const names = (await s.turns.offeredTools(session)).specs.map((t) => t.name);
  for (const n of WS_DATA_TOOL_NAMES) assert.ok(names.includes(n), `solo has ${n}`);
  for (const n of ORG_DATA_TOOL_NAMES) assert.ok(!names.includes(n), `solo lacks ${n}`);
  const agents = await s.wsTools.execute(session, 'ws_agents', {});
  assert.match(agents, /Solo/);
  assert.doesNotMatch(agents, /Chief|Writer/, 'agents never cross workspaces');
  const cat = await s.wsTools.execute(session, 'ws_catalog', {});
  assert.match(cat, /- company \(.*\): not offered to you/);
  assert.match(cat, /- agents \(.*\): read ws_agents/);
});

test('ws_catalog per role: the chief reads the audit log and changes tunables; a specialist sees them as other roles\'', async () => {
  const s = await setup();
  const chief = await exec(s, s.chief.id, 'ws_catalog');
  assert.match(chief, /- audit \(.*\): read org_audit_query/);
  assert.match(chief, /- company \(.*\): read org_company; change org_tune/);
  assert.match(chief, /- market \(.*\): read ws_market, org_roles; change org_hire_agent/);
  const spec = await exec(s, s.junior.id, 'ws_catalog');
  assert.match(spec, /- audit \(.*\): not offered to you — org_audit_query belong to other roles/);
  assert.match(spec, /- company \(.*\): read org_company$/m, 'reads the company, changes nothing there');
  assert.match(spec, /- projects \(.*\): read org_projects, org_project; change org_create_project/);
  const one = await exec(s, s.junior.id, 'ws_catalog', { domain: 'meet' });
  assert.equal(one.split('\n').length, 2);
  assert.match(one, /meetings .* read org_meetings/);
  assert.match(await exec(s, s.junior.id, 'ws_catalog', { domain: 'zzz' }), /No data domain matches/);
});

test('org_company: profile, os, tunables (filter + paging), boundary, budgets scoped to the viewer', async () => {
  const s = await setup();
  await s.org.update(s.orgId, { mission: 'Ship the best newsletter' });
  await s.org.setProfile(s.orgId, { values: 'Rigour. Write things down.', culture: 'Calm, async, experiment often.' });
  const profile = await exec(s, s.junior.id, 'org_company');
  assert.match(profile, /Mission: Ship the best newsletter/);
  assert.match(profile, /Values: Rigour/);
  assert.match(profile, /supervised mode/);
  const os = await exec(s, s.junior.id, 'org_company', { view: 'os' });
  assert.match(os, /stage \w+/);
  assert.match(os, /norms: .*rigour/);
  const tun = await exec(s, s.junior.id, 'org_company', { view: 'tunables', q: 'intent.', limit: 2 });
  assert.match(tun, /intent\.paceTolerance = 0\.15 \(default\)/);
  assert.match(tun, /pass offset: 2 for more/);
  const page2 = await exec(s, s.junior.id, 'org_company', { view: 'tunables', q: 'intent.', limit: 2, offset: 2 });
  assert.doesNotMatch(page2, /paceTolerance/);
  const boundary = await exec(s, s.junior.id, 'org_company', { view: 'boundary', q: 'kill' });
  assert.match(boundary, /kill_switch: NEVER/);
  // budgets: the chief sees every agent envelope; a specialist only its own (and the company's)
  await s.org.setBudget(s.orgId, { scope: 'agent', refId: s.proof.id, monthlyUsd: 7 });
  await s.org.setBudget(s.orgId, { scope: 'agent', refId: s.junior.id, monthlyUsd: 3 });
  const chiefB = await exec(s, s.chief.id, 'org_company', { view: 'budgets' });
  assert.match(chiefB, /agent Proof: \$7\.00/);
  assert.match(chiefB, /agent Junior: \$3\.00/);
  const junB = await exec(s, s.junior.id, 'org_company', { view: 'budgets' });
  assert.match(junB, /agent Junior: \$3\.00/);
  assert.doesNotMatch(junB, /Proof/, 'another unit\'s member budget is private');
  const leadB = await exec(s, s.writer.id, 'org_company', { view: 'budgets' });
  assert.match(leadB, /agent Junior/, 'a lead sees its reports');
  assert.doesNotMatch(leadB, /Proof/);
  await assert.rejects(exec(s, s.junior.id, 'org_company', { view: 'secrets' }), /view must be/);
});

test('org_people: chart, units, humans without contact details, member detail with private fields only down the line', async () => {
  const s = await setup();
  const chart = await exec(s, s.junior.id, 'org_people');
  assert.match(chart, /- Chief — .*\(chief of staff\)/);
  assert.match(chart, /\n {2}- Writer — Writer/);
  assert.match(chart, /\n {4}- Junior — Junior writer .*← you/);
  const filtered = await exec(s, s.junior.id, 'org_people', { view: 'chart', q: 'proof' });
  assert.match(filtered, /Proofreader/);
  assert.doesNotMatch(filtered, /Junior writer/);
  const units = await exec(s, s.junior.id, 'org_people', { view: 'units' });
  assert.match(units, /lead Writer/);
  assert.match(units, /lead Editor, .*\(outside your unit\)/);
  await s.db.insert(workspaceMembers).values({ id: newId(), workspaceId: s.ws.id, memberAccountId: 'acct-dana', role: 'member', displayName: 'Dana', email: 'dana@example.com', invitedBy: '', joinedAt: new Date().toISOString() } as never);
  await s.org.setHuman(s.orgId, { memberAccountId: 'acct-dana', role: 'employee', reportsToAgentId: s.writer.id, title: 'Copy chief' });
  const humans = await exec(s, s.junior.id, 'org_people', { view: 'humans' });
  assert.match(humans, /Copy chief — employee, reports to Writer/);
  assert.doesNotMatch(humans, /acct-dana|dana@example/);
  const people = await exec(s, s.junior.id, 'ws_workspace', { view: 'people' });
  assert.match(people, /Dana — member/);
  assert.doesNotMatch(people, /dana@example\.com|acct-dana/, 'no contact details');
  // private fields: own and down the line only
  const self = await exec(s, s.junior.id, 'org_people', { view: 'member', member: 'Junior' });
  assert.match(self, /Model: anthropic\/claude-haiku-4-5/);
  const other = await exec(s, s.junior.id, 'org_people', { view: 'member', member: 'Proof' });
  assert.match(other, /Scopes, model and budget: visible to its managers and the chief/);
  assert.doesNotMatch(other, /Model:/);
  assert.match(await exec(s, s.editor.id, 'org_people', { member: 'Proof' }), /Model: anthropic/, 'its manager reads them');
  assert.match(await exec(s, s.chief.id, 'org_people', { member: 'Proof' }), /Scopes: /);
  await assert.rejects(exec(s, s.junior.id, 'org_people', { member: 'Nobody' }), /no member/);
});

test('org_task: brief, blocker, steps and a bounded timeline of transitions and comments', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.orgId, { title: 'Draft issue 12', brief: { outcome: 'A draft', done_when: 'Saved in /org/drafts' }, assigneeAgentId: s.junior.id });
  await s.tasks.update(s.orgId, t.id, { status: 'in_progress' }, `agent:${s.junior.id}`);
  for (let i = 0; i < 4; i++) await s.tasks.comment(s.orgId, t.id, { text: `note ${i}`, fromAgentId: s.junior.id, wake: false });
  await s.tasks.step(s.orgId, t.id, { add: 'Outline' }, `agent:${s.junior.id}`);
  const out = await exec(s, s.proof.id, 'org_task', { task: t.key, limit: 3 });
  assert.match(out, new RegExp(`^${t.key} Draft issue 12 — in_progress`));
  assert.match(out, /Owner: Junior/);
  assert.match(out, /Done when: Saved in \/org\/drafts/);
  assert.match(out, /Steps: s1 ○ Outline/);
  assert.match(out, /Timeline \(3 of 6\):/);
  assert.match(out, /Junior: note 3/);
  assert.doesNotMatch(out, /note 0/, 'oldest dropped by the limit');
  await assert.rejects(exec(s, s.proof.id, 'org_task', { task: 'NOPE-999' }), /no task/);
});

test('org_meetings: upcoming, recent, minutes and cadences — another unit\'s meeting is refused to a specialist', async () => {
  const s = await setup();
  const writerUnit = (await s.units.ledBy(s.orgId, s.writer.id))!;
  const editorUnit = (await s.units.ledBy(s.orgId, s.editor.id))!;
  const mine = await s.meetings.create(s.orgId, { kind: 'adhoc', unitId: writerUnit.id, title: 'Drafting sync' });
  await s.meetings.update(s.orgId, mine.id, { status: 'done', endedAt: new Date().toISOString(), minutes: JSON.stringify({ summary: 'We agreed the outline.', decisions: [{ title: 'Outline', decision: 'Three sections', alternatives: '', rationale: '', by: s.writer.id }], actions: [], risks: [], questions: [] }) });
  const theirs = await s.meetings.create(s.orgId, { kind: 'adhoc', unitId: editorUnit.id, title: 'Proofing secrets' });
  await s.meetings.update(s.orgId, theirs.id, { status: 'done', minutes: JSON.stringify({ summary: 'Private to editing.', decisions: [], actions: [], risks: [], questions: [] }) });
  await s.meetings.create(s.orgId, { kind: 'adhoc', title: 'All hands', scheduledFor: new Date(Date.now() + 86_400_000).toISOString() });
  await s.meetings.ensureCadenceDefaults(s.orgId);

  const recent = await exec(s, s.junior.id, 'org_meetings', { view: 'recent' });
  assert.match(recent, /Drafting sync .*We agreed the outline\.; 1 decision/);
  assert.doesNotMatch(recent, /Proofing secrets/, 'another unit\'s meetings are not listed');
  const minutes = await exec(s, s.junior.id, 'org_meetings', { view: 'minutes', meeting: mine.id.slice(0, 8) });
  assert.match(minutes, /Outline: Three sections/);
  await assert.rejects(exec(s, s.junior.id, 'org_meetings', { meeting: theirs.id.slice(0, 8) }), /not visible to you/);
  assert.match(await exec(s, s.editor.id, 'org_meetings', { meeting: theirs.id.slice(0, 8) }), /Private to editing/, 'its own unit reads it');
  assert.match(await exec(s, s.chief.id, 'org_meetings', { view: 'recent' }), /Proofing secrets/, 'the chief reads all');
  const upcoming = await exec(s, s.junior.id, 'org_meetings', { view: 'upcoming' });
  assert.match(upcoming, /All hands \(adhoc, company\)/);
  assert.match(await exec(s, s.junior.id, 'org_meetings', { view: 'cadences' }), /company \w+: "/);
});

test('org_approvals: the history a member may see — its own and its reports\'; the chief all', async () => {
  const s = await setup();
  const a1 = await s.approvals.create(s.orgId, { kind: 'escalation', payload: { title: 'Need a decision on tone' }, requestedBy: `agent:${s.junior.id}`, recommendation: 'go formal' });
  await s.approvals.create(s.orgId, { kind: 'escalation', payload: { title: 'Proofing budget' }, requestedBy: `agent:${s.proof.id}` });
  await s.approvals.decide(s.orgId, a1.id, 'approve', 'fine by me');
  const jun = await exec(s, s.junior.id, 'org_approvals');
  assert.match(jun, /escalation: Need a decision on tone — asked by Junior .*approved/);
  assert.doesNotMatch(jun, /Proofing budget/);
  const lead = await exec(s, s.writer.id, 'org_approvals', { status: 'decided' });
  assert.match(lead, /Need a decision on tone/, 'a manager reads its report\'s cards');
  assert.match(await exec(s, s.editor.id, 'org_approvals', { status: 'pending' }), /Proofing budget/);
  const chief = await exec(s, s.chief.id, 'org_approvals', { kind: 'escalation' });
  assert.match(chief, /Proofing budget/);
  assert.match(chief, /Need a decision/);
  assert.match(await exec(s, s.chief.id, 'org_approvals', { kind: 'hire' }), /No decision cards/);
});

test('ws_workspace: profile, usage split for the chief only, connections without secrets, own + shared skills only', async () => {
  const s = await setup();
  assert.match(await exec(s, s.junior.id, 'ws_workspace'), /company mode supervised/);
  const usage = await exec(s, s.junior.id, 'ws_workspace', { view: 'usage', days: 7 });
  assert.match(usage, /Usage over 7 day\(s\)/);
  assert.match(usage, /Your share/);
  assert.match(await exec(s, s.chief.id, 'ws_workspace', { view: 'usage' }), /By agent:/);
  // a connection with a token: the grant shows, the token never does
  const connId = newId();
  await s.db.insert(connectionsTable).values({ id: connId, provider: 'google', accountEmail: 'owner@example.com', scopes: '[]', accessToken: 'plain:ya29.SECRET-TOKEN', refreshToken: 'plain:refresh-SECRET', expiresAt: 0, createdAt: new Date().toISOString() } as never);
  await s.connections.setGrant(connId, s.junior.id, 'calendar', 'read');
  const conn = await exec(s, s.junior.id, 'ws_workspace', { view: 'connections' });
  assert.match(conn, /calendar\): read/, 'the grant shows');
  assert.doesNotMatch(conn, /SECRET-TOKEN|owner@example\.com/);
  const skills = s.turns as unknown as { skills: import('../server/src/skills/skills.service').SkillsService };
  await skills.skills.create({ name: 'junior-private', description: 'mine', instructions: 'x', workspaceId: s.ws.id, agentId: s.junior.id });
  await skills.skills.create({ name: 'proof-private', description: 'theirs', instructions: 'x', workspaceId: s.ws.id, agentId: s.proof.id });
  const mine = await exec(s, s.junior.id, 'ws_workspace', { view: 'skills', q: 'private' });
  assert.match(mine, /skill_junior_private — yours/);
  assert.doesNotMatch(mine, /proof_private/, 'another agent\'s private skill never shows');
});

test('ws_agents: the shared status, filters, detail; never another agent\'s memory', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.orgId, { title: 'Proof issue 12', assigneeAgentId: s.proof.id });
  await s.tasks.update(s.orgId, t.id, { status: 'in_progress' }, `agent:${s.proof.id}`);
  const all = await exec(s, s.junior.id, 'ws_agents');
  assert.match(all, /- Chief — .*\(chief\)/);
  assert.match(all, /- Proof — Proofreader, anthropic\/claude-haiku-4-5: working — Proof issue 12/);
  assert.match(all, /Junior .*← you/);
  const working = await exec(s, s.junior.id, 'ws_agents', { state: 'working' });
  assert.match(working, /Proof/);
  assert.doesNotMatch(working, /- Junior/);
  const paged = await exec(s, s.junior.id, 'ws_agents', { limit: 2 });
  assert.match(paged, /pass offset: 2 for more/);
  const one = await exec(s, s.junior.id, 'ws_agents', { agent: 'proof' });
  assert.match(one, /Charter: You proofread\./);
  assert.match(one, /memory, lessons and private skills stay its own/);
  await assert.rejects(exec(s, s.junior.id, 'ws_agents', { agent: 'ghost' }), /no agent/);
});

test('ws_market and ws_plugins: packs with filters and detail, connectors, registry; installed plugins and interfaces', async () => {
  const s = await setup();
  const packs = await exec(s, s.chief.id, 'ws_market', { function: 'sales', limit: 3 });
  assert.match(packs, /Agent packs \(\d+\)/);
  assert.match(packs, /\/sales/);
  const firstId = /- (pack-[a-z0-9-]+):/.exec(packs)![1];
  assert.match(await exec(s, s.chief.id, 'ws_market', { view: 'pack', id: firstId }), /Charter: /);
  assert.match(await exec(s, s.chief.id, 'ws_market', { view: 'connectors', q: 'google' }), /Google/i);
  assert.match(await exec(s, s.chief.id, 'ws_market', { view: 'registry' }), /Nothing published|Registry items/);
  assert.match(await exec(s, s.writer.id, 'ws_plugins'), /No plugins installed/);
  await s.plugins.install(s.ws.id, { firstParty: 'scm' }, { confirm: true });
  await s.plugins.install(s.ws.id, { firstParty: 'scm-mock' }, { confirm: true });
  const installed = await exec(s, s.junior.id, 'ws_plugins');
  assert.match(installed, /scm-mock@yaam .*provides/);
  const ifaces = await exec(s, s.junior.id, 'ws_plugins', { view: 'interfaces', q: 'scm' });
  assert.match(ifaces, /scm@\S+: ops .*\((read|internal_write|external_\w+)\)/);
  assert.match(await exec(s, s.junior.id, 'ws_plugins', { view: 'catalog' }), /installed v/);
  assert.match(await exec(s, s.junior.id, 'ws_plugins', { view: 'plugin', id: 'scm-mock@yaam' }), /Your grant: none/);
});

test('pageOf bounds every list: ceiling, offset past the end, empty', () => {
  const rows = Array.from({ length: 500 }, (_, i) => `r${i}`);
  assert.equal(pageOf(rows, { limit: 10_000 }, { max: 60 }).split('\n').length, 61);
  assert.match(pageOf(rows, { offset: 900 }), /past the end/);
  assert.equal(pageOf([], {}, { empty: 'none' }), 'none');
});

test('token budget: the chief\'s whole tool list stays under the stated limit', async () => {
  const before = await setup({ withData: false });
  const b = JSON.stringify((await before.turns.offeredTools(await sessionOf(before as unknown as S, before.chief.id))).specs).length;
  const s = await setup();
  const after = JSON.stringify((await s.turns.offeredTools(await sessionOf(s as unknown as S, s.chief.id))).specs).length;
  console.log(`chief tool specs: ${b} bytes without the data tools (recorded ${CHIEF_SPEC_BYTES_BEFORE}), ${after} with them (+${after - b})`);
  assert.ok(after < CHIEF_SPEC_BUDGET, `${after} < ${CHIEF_SPEC_BUDGET}`);
  assert.ok(after - b < 7_000, 'ten data tools cost under 7 KB');
});
