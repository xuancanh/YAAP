/** The company briefing (docs/agent-data-access.md §7, docs/agent-memory.md
 *  §11): what every member knows without asking — content per role, the
 *  budget, scoping, cache invalidation, the total prompt size per role,
 *  knowledge/company.md, and the workspace briefing outside a company. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupCompany, systemOf, heartbeatOrgContext, sessionOf, MISSION, type C } from './company-briefing-fixture';
import { setup as harness } from './org-governance-harness';
import { BRIEFING_BUDGET, COMPANY_NOTE, RENDER_TTL_MS, SNAPSHOT_TTL_MS, oneLine, topValues } from '../server/src/org/org-briefing.service';
import { WorkspaceDataTools, WORKSPACE_BRIEFING_BUDGET } from '../server/src/data-access/workspace-data.tools';
import { homeKey } from '../server/src/files/agent-home';
import type { SkillsService } from '../server/src/skills/skills.service';
import { orgApprovals } from '../server/src/database/schema';
import { eq } from 'drizzle-orm';

/** The whole system prompt of a chat turn, measured on this fixture before
 *  the briefing (see the audit in docs/agent-data-access.md §7). */
const CHAT_BEFORE = { chief: 8_610, head: 9_058, specialist: 8_159 };
/** A task run's system prompt before the briefing, same fixture. */
const RUN_BEFORE = { chief: 8_847, head: 8_792, specialist: 8_831 };
/** The heartbeat's org context lines before (the profile, vision and mission moved into the briefing). */
const HEARTBEAT_BEFORE = { chief: 1_623, head: 1_216, specialist: 905 };
/** The prompt may grow by at most this much per turn — under the briefing's own budget. */
const GROWTH_CAP = 1_400;

const ids = (c: C) => ({ chief: c.chief.id, head: c.writer.id, specialist: c.junior.id });

async function noteOf(c: C, agentId: string): Promise<string | null> {
  const agent = await c.agents.get(agentId);
  const body = await c.storage.get(homeKey(await c.agents.home(agent), COMPANY_NOTE));
  return body ? body.toString('utf8') : null;
}

test('the briefing per role: company, position, goals, projects, work, decisions, waiting — within the budget', async () => {
  const c = await setupCompany();
  const chief = (await c.briefing.briefingFor(c.chief.id))!;
  const head = (await c.briefing.briefingFor(c.writer.id))!;
  const spec = (await c.briefing.briefingFor(c.junior.id))!;
  for (const b of [chief, head, spec]) {
    assert.ok(b.length <= BRIEFING_BUDGET, `within ${BRIEFING_BUDGET} chars (got ${b.length})`);
    assert.match(b, /^# Company briefing: "Default"/);
    assert.match(b, new RegExp(`Mission: ${oneLine(MISSION).slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(b, /Vision: 10,000 paying readers by the end of 2027 \(by 2027-12-31\)/);
    assert.match(b, /Values: Readers first · Candour · Ship weekly\./);
    assert.match(b, /Key results \(3; red 0, amber 0\):\n- \[(green|grey|amber|red)\] /);
    assert.match(b, /Waiting on you: /);
    assert.match(b, /More: org_company .*org_project <key>.*ws_catalog.*~\/knowledge\/company\.md\.$/);
    assert.doesNotMatch(b, /\$\d/, 'no money in a briefing');
  }
  // chief: the portfolio and the exceptions
  assert.match(chief, /You: the chief of staff; reports to the CEO; direct reports: Writer, Editor\./);
  assert.match(chief, /Portfolio: 2 Now project\(s\) — 0 on track, 1 at risk, 0 off track, 1 without an update/);
  assert.match(chief, /- P-1 "Weekly issue pipeline" — at risk; lead Writer; next milestone "Template v2" 2026-11-20; target 2026-12-15/);
  assert.match(chief, /Exceptions: 1 blocked task\(s\), .*card\(s\) waiting on the CEO/);
  // head: its unit, staffing, the review waiting on it, the KR it owns
  assert.match(head, /You: Writer, head of Writer's team; reports to Chief; direct reports: Junior; on P-1 \(lead\)\./);
  assert.match(head, /Your unit's projects \(1\):\n- P-1 "Weekly issue pipeline" — at risk; lead you/);
  assert.match(head, /Staffing: 1 report\(s\), none idle; 1 unassigned task\(s\) in your unit; 1 blocked\./);
  assert.match(head, /Waiting on you: 1 review\(s\): WRI-\d+\./);
  assert.match(head, /Paid subscribers: 120\/1000 \(12%\), due 2026-12-31, yours/);
  assert.doesNotMatch(head, /House style guide/, 'another unit\'s project is not a head\'s unit list');
  // specialist: its work and its project
  assert.match(spec, /You: Junior writer, in Writer's team; reports to Writer; on P-1 \(contributor, 4\/5 open tasks yours\)\./);
  assert.match(spec, /Your open tasks: 4 \(1 blocked\) — WRI-\d+ blocked, WRI-\d+ doing, WRI-\d+ in review, …\./);
  assert.match(spec, /Your projects:\n- P-1 "Weekly issue pipeline" — at risk; lead Writer; next milestone "Template v2" 2026-11-20; target 2026-12-15; 5 open task\(s\)/);
  assert.doesNotMatch(spec, /Portfolio|Staffing|Exceptions/);
  // a card held by the head shows up as waiting on it
  const card = await c.approvals.create(c.orgId, { kind: 'hire', payload: { name: 'X' }, requestedBy: `agent:${c.junior.id}` });
  await c.db.update(orgApprovals).set({ holder: `agent:${c.writer.id}`, status: 'pending' }).where(eq(orgApprovals.id, card.id));
  c.briefing.invalidate(c.orgId);
  assert.match((await c.briefing.briefingFor(c.writer.id))!, /Waiting on you: 1 decision card\(s\) \(org_decision_queue\); 1 review/);
});

test('scoping: a unit\'s decisions stay in its units and no budget leaks; the chief sees every unit', async () => {
  const c = await setupCompany();
  const spec = (await c.briefing.briefingFor(c.junior.id))!;
  const head = (await c.briefing.briefingFor(c.writer.id))!;
  const editor = (await c.briefing.briefingFor(c.editor.id))!;
  const chief = (await c.briefing.briefingFor(c.chief.id))!;
  for (const b of [spec, head]) {
    assert.doesNotMatch(b, /secret-sauce-42/, 'another unit\'s decision is not in the writing unit\'s briefing');
    assert.doesNotMatch(b, /77\.77|appetite|envelope/, 'another unit\'s project budget never appears');
    assert.match(b, /"Publish every Friday at 8:00"/, 'company-level decisions are everyone\'s');
  }
  assert.match(spec, /"Lead stories stay under 900 words"/, 'its own unit\'s decision');
  assert.match(editor, /secret-sauce-42/, 'the editing head sees its unit\'s decision');
  assert.doesNotMatch(editor, /900 words/);
  assert.match(chief, /secret-sauce-42/);
  assert.match(chief, /900 words/);
  // nothing from another agent's memory: lessons stay in their own prompt
  await c.memory.record(c.writer.id, 'Writer private lesson: the CEO hates puns.', { source: 'chat' });
  c.briefing.invalidate(c.orgId);
  assert.doesNotMatch((await c.briefing.briefingFor(c.junior.id))!, /hates puns/);
  // an audit run and an aux run carry their own framing: no briefing
  const s1 = await sessionOf(c as never, c.chief.id);
  c.runtime.beginAuxRun({ orgId: c.orgId, taskId: '', agentId: c.chief.id, runId: 'r', sessionId: s1.id, isChief: true, reviewer: false, progress: false, calls: new Map(), loopDetected: false, aux: { kind: 'ask', context: 'ask' } });
  assert.equal(await c.briefing.contextFor(s1), null);
  c.runtime.endAuxRun(s1.id);
  assert.ok(await c.briefing.contextFor(s1));
});

test('bounds hold for a big company: the lowest-priority lines go first, the essentials stay', async () => {
  const c = await setupCompany();
  const long = 'An unusually long and descriptive title that keeps going well past what fits on one line of a briefing';
  for (let i = 0; i < 20; i++) {
    await c.org.addGoal(c.orgId, { title: `${long} KR ${i}`, kind: 'key_result', parentGoalId: c.objective.id, metric: 'm', startValue: 0, currentValue: i, targetValue: 100, dueAt: '2026-12-31', ownerAgentId: c.junior.id });
    const p = await c.org.addProject(c.orgId, { title: `${long} project ${i}`, ownerAgentId: i % 2 ? c.junior.id : c.writer.id, unitId: c.writerUnit.id, milestones: [{ name: long, date: '2026-12-01' }], targetDate: '2027-01-01', status: 'active', lane: 'now' });
    await c.tasks.create(c.orgId, { title: `${long} ${i}`, projectId: p.id, assigneeAgentId: c.junior.id, createdBy: 'chief' });
    await c.meetings.logDecision(c.orgId, { title: `${long} decision ${i}`, decision: 'x', decidedBy: 'CEO' });
  }
  c.briefing.invalidate(c.orgId);
  for (const id of Object.values(ids(c))) {
    const b = (await c.briefing.briefingFor(id))!;
    assert.ok(b.length <= BRIEFING_BUDGET, `${b.length} ≤ ${BRIEFING_BUDGET}`);
    for (const essential of [/^# Company briefing/, /\nMission: /, /\nYou: /, /\nYour open tasks: /, /\nWaiting on you: /, /\nMore: /]) assert.match(b, essential);
  }
});

test('the cache: one snapshot per org, rebuilt on a project or goal change and after the TTL', async () => {
  const c = await setupCompany();
  const t0 = new Date();
  await c.briefing.briefingFor(c.junior.id, t0);
  const builds = c.briefing.builds;
  await c.briefing.briefingFor(c.junior.id, t0);
  await c.briefing.briefingFor(c.writer.id, t0);
  assert.equal(c.briefing.builds, builds, 'two members, one snapshot');
  // a project change is audited → the snapshot is stale
  await c.org.updateProject(c.orgId, c.pWriting.id, { health: 'off_track', healthReason: 'lost the designer' });
  const after = (await c.briefing.briefingFor(c.junior.id, t0))!;
  assert.equal(c.briefing.builds, builds + 1);
  assert.match(after, /P-1 "Weekly issue pipeline" — off track/);
  // a goal change too
  await c.org.updateGoal(c.orgId, c.krSubs.id, { atRisk: 1, atRiskReason: 'behind' });
  assert.match((await c.briefing.briefingFor(c.junior.id, t0))!, /- \[red\] Paid subscribers/);
  assert.match((await c.briefing.briefingFor(c.chief.id, t0))!, /Key results \(3; red 1, amber 0\)/);
  // the TTLs: a render lives a minute, a snapshot five
  const b2 = c.briefing.builds;
  await c.briefing.briefingFor(c.junior.id, new Date(t0.getTime() + RENDER_TTL_MS + 1));
  assert.equal(c.briefing.builds, b2, 'a render past its TTL re-renders from the same snapshot');
  await c.briefing.briefingFor(c.junior.id, new Date(t0.getTime() + SNAPSHOT_TTL_MS + 1));
  assert.equal(c.briefing.builds, b2 + 1, 'past the snapshot TTL it rebuilds');
});

test('prompt size per role: the briefing replaces copies, so every session kind grows by less than its budget', async () => {
  const c = await setupCompany();
  for (const [role, id] of Object.entries(ids(c)) as Array<['chief' | 'head' | 'specialist', string]>) {
    const chat = await systemOf(c, id);
    assert.ok(chat.length <= CHAT_BEFORE[role] + GROWTH_CAP, `${role} chat: ${chat.length} ≤ ${CHAT_BEFORE[role]} + ${GROWTH_CAP}`);
    assert.equal(chat.split('# Company briefing').length - 1, 1, 'one briefing');
    assert.equal(chat.split(oneLine(MISSION).slice(0, 50)).length - 1, 1, `${role}: the mission once, not once per block`);
    const hb = await heartbeatOrgContext(c, id);
    assert.ok(chat.length + hb.length <= CHAT_BEFORE[role] + HEARTBEAT_BEFORE[role] + GROWTH_CAP / 2, `${role} heartbeat: ${chat.length + hb.length} grows by under ${GROWTH_CAP / 2}`);
    assert.doesNotMatch(hb, /Operating profile —|mission: /, 'the heartbeat no longer repeats the profile');
    // a task run
    const task = (await c.tasks.list(c.orgId)).find((t) => t.assigneeAgentId === id) ?? (await c.tasks.list(c.orgId))[0];
    const sess = await sessionOf(c as never, id);
    c.runtime.beginAuxRun({ orgId: c.orgId, taskId: task.id, agentId: id, runId: 'r', sessionId: sess.id, isChief: role === 'chief', reviewer: false, progress: false, calls: new Map(), loopDetected: false });
    const run = await systemOf(c, id, sess);
    c.runtime.endAuxRun(sess.id);
    assert.match(run, /# Organisation run[\s\S]*# Company briefing|# Company briefing[\s\S]*# Organisation run/);
    assert.doesNotMatch(run, /Operating profile —/, 'the run no longer carries the full values and culture');
    assert.equal(run.split(oneLine(MISSION).slice(0, 50)).length - 1, 1, `${role} run: the mission once`);
    assert.ok(run.length <= RUN_BEFORE[role] + GROWTH_CAP, `${role} run: ${run.length} ≤ ${RUN_BEFORE[role]} + ${GROWTH_CAP}`);
  }
});

test('knowledge/company.md: written with the standing context, rewritten only when it changes — a hire, a project, a promotion', async () => {
  const c = await setupCompany();
  await c.briefing.briefingFor(c.junior.id);
  const note = (await noteOf(c, c.junior.id))!;
  assert.match(note, /^# Default — my standing context/);
  assert.match(note, /- Mission: Help independent publishers/);
  assert.match(note, /- Values: Readers first; Candour; Ship weekly; Own the outcome; Frugality/);
  assert.match(note, /- Junior writer\n- Department: Writer's team \(#writer\), led by Writer\n- I report to Writer\n- No direct reports/);
  assert.match(note, /- P-1 "Weekly issue pipeline" — I work on it/);
  assert.doesNotMatch(note, /\d{4}-\d{2}-\d{2}T/, 'no timestamp, so an unchanged standing never rewrites');
  // unchanged → nothing written
  assert.ok(!(await c.briefing.refreshStanding(c.orgId)).includes(c.junior.id), 'its note is current');
  assert.deepEqual(await c.briefing.refreshStanding(c.orgId), [], 'unchanged → nothing rewritten');
  // a project lead change: Junior now leads P-2
  await c.org.updateProject(c.orgId, c.pEditing.id, { ownerAgentId: c.junior.id });
  const written = await c.briefing.refreshStanding(c.orgId);
  assert.ok(written.includes(c.junior.id), 'its projects changed');
  assert.ok(written.includes(c.editor.id), 'the old lead\'s too');
  assert.ok(!written.includes(c.proof.id), 'nobody else\'s');
  assert.match((await noteOf(c, c.junior.id))!, /- P-2 "House style guide" — I lead it/);
  // a hire: the new member gets its note on the next refresh
  const scout = await c.agents.create({ name: 'Scout', charter: 'You research.', provider: 'anthropic', model: 'claude-haiku-4-5' });
  await c.org.addMember(c.orgId, { agentId: scout.id, title: 'Researcher', reportsToAgentId: c.writer.id });
  assert.ok((await c.briefing.refreshStanding(c.orgId)).includes(scout.id));
  assert.match((await noteOf(c, scout.id))!, /- Researcher\n- Department: Writer's team \(#writer\), led by Writer\n- I report to Writer/);
  assert.match((await noteOf(c, c.writer.id))!, /- My direct reports: Junior \(Junior writer\), Scout \(Researcher\)/, 'the manager\'s reports changed');
  // a promotion to head: Junior moves up to the chief and leads a unit once it has a report
  await c.org.updateMember(c.orgId, c.junior.id, { reportsToAgentId: c.chief.id, title: 'Head of Research' });
  const intern = await c.agents.create({ name: 'Intern', charter: 'You help.', provider: 'anthropic', model: 'claude-haiku-4-5' });
  await c.org.addMember(c.orgId, { agentId: intern.id, title: 'Intern', reportsToAgentId: c.junior.id });
  await c.units.syncMembership(c.orgId);
  assert.ok((await c.briefing.refreshStanding(c.orgId)).includes(c.junior.id));
  assert.match((await noteOf(c, c.junior.id))!, /- Head of Research \(function head\)\n- I lead the Research department \(#research\)\n- I report to Chief\n- My direct reports: Intern \(Intern\)/);
  assert.match((await c.briefing.briefingFor(c.junior.id))!, /You: Head of Research, head of [^;]+; reports to Chief; direct reports: Intern/);
});

test('the standing note refreshes on its own after a structural audit entry (debounced)', async () => {
  const c = await setupCompany();
  c.briefing.standingDebounceMs = 20;
  const scout = await c.agents.create({ name: 'Scout', charter: 'You research.', provider: 'anthropic', model: 'claude-haiku-4-5' });
  await c.org.addMember(c.orgId, { agentId: scout.id, title: 'Researcher', reportsToAgentId: c.editor.id });
  for (let i = 0; i < 50 && !(await noteOf(c, scout.id)); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match((await noteOf(c, scout.id)) ?? '', /- I report to Editor/);
});

test('outside a company: a small workspace briefing (tasks, loops); a member gets the company one instead', async () => {
  const s = await harness();
  const skills = (s.turns as unknown as { skills: SkillsService }).skills;
  const solo = await s.agents.create({ name: 'Solo', charter: 'You help.', provider: 'anthropic', model: 'x', loops: [{ name: 'Morning digest', cron: '0 8 * * *', prompt: 'digest' }, { name: 'Off', cron: '0 9 * * *', prompt: 'x', enabled: false }] });
  await s.agents.addTask(solo.id, { title: 'Book the venue' });
  const wsTools = new WorkspaceDataTools(s.db, s.agents, s.workspaces, skills, s.config, undefined, undefined, undefined, undefined, undefined, s.org, s.tasks, s.units);
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: solo.id, name: 'x', permissionMode: 'auto' });
  const block = (await wsTools.contextFor(session))!;
  assert.ok(block.length <= WORKSPACE_BRIEFING_BUDGET);
  assert.match(block, /^# Workspace briefing: "Default"\nYour open tasks: 1 — [A-Z]+-1\.\nYour loops: "Morning digest" \(0 8 \* \* \*\)\.\nMore: ws_workspace/);
  assert.doesNotMatch(block, /"Off"/, 'a disabled loop is not listed');
  // the company briefing is null for it; a member of a company gets no workspace block
  const c = await setupCompany();
  const memberTools = new WorkspaceDataTools(c.db, c.agents, c.workspaces, (c.turns as unknown as { skills: SkillsService }).skills, c.config, undefined, undefined, undefined, undefined, undefined, c.org, c.tasks, c.units);
  const memberSession = await sessionOf(c as never, c.junior.id);
  assert.equal(await memberTools.contextFor(memberSession), null);
  const outsider = await c.agents.create({ name: 'Outsider', charter: 'x', provider: 'anthropic', model: 'x' });
  assert.equal(await c.briefing.briefingFor(outsider.id), null);
});

test('mission and values compress to one line', () => {
  assert.equal(oneLine('Ship it. Then more words.'), 'Ship it.');
  assert.deepEqual(topValues('1. Candour: say it\n- Speed — ship\nThrift'), ['Candour', 'Speed', 'Thrift']);
  assert.deepEqual(topValues('Quality over speed; never spam.'), ['Quality over speed', 'never spam']);
});
