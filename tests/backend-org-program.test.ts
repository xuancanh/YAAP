/** Program management as a matrix (docs/work-tracking.md "Program
 *  management: the matrix"): Program Managers own goals and projects (the
 *  chief acts as PM when there is none — said so), they ask the heads for
 *  resources and the heads approve, adjust, decline or hire; disputes and
 *  unanswered requests climb through decision routing; each goal and
 *  project keeps its own rhythm within bounds derived from the profile;
 *  members see both managers; stretched members surface to the head and
 *  the PM; next work follows the allocation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, enable, sessionOf, inbox, type S } from './org-governance-harness';
import { OrgProjectsService } from '../server/src/org/org-projects.service';
import { OrgProjectTeamsService } from '../server/src/org/org-project-teams.service';
import { OrgProgramService } from '../server/src/org/org-program.service';
import { OrgProgramTools } from '../server/src/org/org-program.tools';
import { OrgBriefingService, BRIEFING_BUDGET } from '../server/src/org/org-briefing.service';
import { OrgNextWorkService } from '../server/src/org/org-next-work.service';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { PROGRAM_TUNABLES, cronForDays, cronIntervalDays, cadenceBoundsError, deriveProgramTunables } from '../server/src/org/program-tunables';
import { classifyAudit } from '../server/src/home/feed-registry';
import { validateBlueprint } from '../server/src/org/blueprints/format';
import { readFileSync } from 'node:fs';
import type { ConfigService } from '@nestjs/config';

/** A fake channel layer (the group-chat module's seam). */
function fakeChannels(s: S) {
  const channels = new Map<string, { id: string; slug: string; members: Array<{ kind: 'agent' | 'human'; id: string }>; posts: string[] }>();
  let n = 0;
  const impl = {
    announce: async () => undefined,
    companyChannel: async () => { const c = channels.get('company') ?? { id: 'ch-company', slug: 'company', members: [], posts: [] }; channels.set('company', c); return { id: c.id, slug: c.slug }; },
    ensureUnitChannel: async (_ws: string, slug: string, _name: string, opts: { agentIds: string[]; humanIds: string[] }) => {
      const id = `ch-${++n}`;
      channels.set(id, { id, slug, members: [...opts.agentIds.map((a) => ({ kind: 'agent' as const, id: a })), ...opts.humanIds.map((h) => ({ kind: 'human' as const, id: h }))], posts: [] });
      return { id, slug };
    },
    channelMembers: async (id: string) => channels.get(id)?.members ?? [],
    addChannelMember: async (id: string, kind: 'agent' | 'human', who: string) => { channels.get(id)?.members.push({ kind, id: who }); },
    removeChannelMember: async () => undefined,
    updateChannel: async () => undefined,
    postSystem: async (id: string, text: string) => { channels.get(id)?.posts.push(text); },
  };
  (s.runtime as unknown as { announcer: { bind: (x: unknown) => void } }).announcer.bind(impl);
  return channels;
}

function wire(s: S) {
  const projects = new OrgProjectsService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, undefined, s.decisions);
  const announcer = (s.runtime as unknown as { announcer: ConstructorParameters<typeof OrgProjectTeamsService>[6] }).announcer;
  const teams = new OrgProjectTeamsService(s.org, s.approvals, s.audit, s.agents, s.tasks, projects, announcer, s.units, s.decisions);
  const program = new OrgProgramService(s.db, s.org, s.audit, s.agents, s.approvals, s.tasks, projects, teams, s.units, s.decisions, undefined, s.signals, undefined, announcer);
  const tools = new OrgProgramTools(s.org, program, s.agents, s.config, s.runtime, s.turns);
  return { projects, teams, program, tools };
}

const briefingOf = (s: S) => new OrgBriefingService(s.db, s.org, s.audit, s.tasks, s.agents, { get: () => undefined } as unknown as ConfigService, undefined, s.units, s.intent, s.runtime);

/** Writer heads Sales with Editor as its report; returns the org. */
async function company(s: S, mode: 'supervised' | 'autonomous' = 'supervised') {
  const orgId = await enable(s, mode);
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Sales' });
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id, title: 'Account Executive' });
  await s.units.syncMembership(orgId);
  return orgId;
}

async function hirePm(s: S, orgId: string, name = 'Pat') {
  const a = await s.agents.create({ name, charter: 'You run programs.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  await s.org.addMember(orgId, { agentId: a.id, title: 'Program Manager', reportsToAgentId: s.chief.id });
  return a;
}

// ---- 1. the bounds come from the profile ----

test('program tunables: derived from the profile within their bounds; cron helpers keep a rhythm inside them', () => {
  const fast = deriveOperatingSystem({ values: 'Move fast, ship daily', culture: 'scrappy and async' });
  const formal = deriveOperatingSystem({ values: 'Process, compliance and audit', culture: 'formal approvals' });
  const val = (os: ReturnType<typeof deriveOperatingSystem>, k: string) => os.tunables.find((t) => t.key === k)?.value;
  for (const k of Object.keys(PROGRAM_TUNABLES)) if (k !== 'program.cadenceHour') assert.ok(fast.tunables.some((t) => t.key === k), `derived ${k}`);
  assert.ok(val(fast, 'program.syncDays')! < val(formal, 'program.syncDays')!, 'speed syncs more often');
  assert.ok(val(fast, 'program.requestAnswerHours')! < val(formal, 'program.requestAnswerHours')!, 'a control culture gives heads longer');
  for (const t of deriveProgramTunables({ stage: 'early', cultureType: 'clan', speed: false, rigor: false })) {
    const def = PROGRAM_TUNABLES[t.key];
    assert.ok(t.value >= def.min && t.value <= def.max, `${t.key} within bounds`);
  }
  assert.equal(deriveProgramTunables({ stage: 'growth', cultureType: 'clan', speed: false, rigor: false }).find((t) => t.key === 'program.allocationWarnPct')!.value, 75);
  const from = new Date('2026-11-02T08:00:00');
  assert.equal(cronForDays(1, 10), '0 10 * * 1-5');
  assert.equal(cronForDays(7, 10, 2), '0 10 * * 2');
  assert.equal(cronForDays(14, 10), '0 10 1,15 * *');
  assert.ok(Math.abs(cronIntervalDays('0 10 * * 2', from)! - 7) < 0.01);
  assert.equal(cadenceBoundsError('0 10 * * 2', 7, 31, from), '');
  assert.match(cadenceBoundsError('0 10 * * 1-5', 7, 31, from), /more often than the company allows/);
  assert.match(cadenceBoundsError('0 10 1 * *', 1, 14, from), /fewer than twice|less often/);
});

// ---- 2. who owns goals and projects ----

test('without a Program Manager the chief is the acting PM, said so; a PM joining takes the chief\'s goals and projects, and new company goals go to it', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { program, projects, tools } = wire(s);
  const objective = await s.org.addGoal(orgId, { title: 'First paying cohort', kind: 'objective', ownerAgentId: s.chief.id } as never, 'chief');
  const kr = await s.org.addGoal(orgId, { title: 'Paying learners', kind: 'key_result', parentGoalId: objective.id, ownerAgentId: s.chief.id, targetValue: 20 } as never, 'chief');
  const p = (await projects.create(orgId, { title: 'Price test', goalIds: [kr.id], brief: { problem: 'p' }, ownerAgentId: s.chief.id }, 'user')).project;
  await program.settle();
  let m = await program.matrix(orgId);
  assert.equal(m.chiefActing, true);
  const obj = m.items.find((i) => i.id === objective.id)!;
  assert.equal(obj.owner.role, 'acting_chief', 'explicit: the chief acts as PM');
  assert.ok(obj.cadences.some((c) => c.kind === 'goal_review' && c.enabled && c.nextAt), 'the objective has its own review rhythm');
  assert.match(await program.describeFor(orgId, s.chief.id), /ACTING PM/);
  // a specialist cannot assign
  await assert.rejects(program.assign(orgId, p.key!, s.editor.id, `agent:${s.editor.id}`), /assigned by the chief of staff/);
  // a PM joins: the chief's items go to it
  const pm = await hirePm(s, orgId);
  await program.settle();
  assert.equal((await s.org.goal(orgId, objective.id)).ownerAgentId, pm.id);
  assert.equal((await s.org.goal(orgId, kr.id)).ownerAgentId, pm.id, 'the key result follows its objective');
  assert.equal((await s.org.project(orgId, p.id)).ownerAgentId, pm.id);
  m = await program.matrix(orgId);
  assert.equal(m.chiefActing, false);
  assert.deepEqual(m.pms.map((x) => x.name), ['Pat']);
  assert.equal(m.items.find((i) => i.id === p.id)!.owner.role, 'pm');
  const assigns = (await s.audit.list(orgId, { limit: 200 })).filter((r) => r.action === 'program_assign');
  assert.ok(assigns.length >= 2, 'every hand-over is audited');
  assert.ok((await inbox(s, pm.id, 'info')).some((e) => /You own .* as its Program Manager/.test(e.title)), 'the PM is told');
  // a new company-level objective set by the chief goes to the PM at once
  const next = await s.org.addGoal(orgId, { title: 'A second objective', kind: 'objective', ownerAgentId: s.chief.id } as never, 'chief');
  await program.settle();
  assert.equal((await s.org.goal(orgId, next.id)).ownerAgentId, pm.id);
  // the chief reassigns through the tool; the feed tells the owner
  const pm2 = await hirePm(s, orgId, 'Quinn');
  await program.settle();
  const out = await tools.execute(await sessionOf(s, s.chief.id), 'org_program_assign', { ref: p.key, owner: 'Quinn', why: 'balance the load' });
  assert.match(out, /owned by Quinn \(Program Manager\)/);
  assert.equal((await s.org.project(orgId, p.id)).ownerAgentId, pm2.id);
  const row = (await s.audit.list(orgId, { limit: 200 })).find((r) => r.action === 'program_assign' && r.actor === `agent:${s.chief.id}`)!;
  const look = { agent: (id: string) => (id === pm2.id ? { kind: 'agent', id, name: 'Quinn' } : id === s.chief.id ? { kind: 'agent', id, name: 'Chief' } : null), agentNamed: () => null, project: () => ({ key: p.key, title: p.title }), meeting: () => null, task: () => null, plugin: () => null, channel: () => null, threadChannel: () => null } as never;
  const item = classifyAudit(row as never, look)!;
  assert.equal(item.type, 'program');
  assert.match(item.title, /Quinn now owns/);
});

// ---- 3. resource requests: request → head decision → seat; escalation ----

test('a PM asks a head for resources: the head approves (a seat), adjusts with a reason or declines; the PM escalates to the head\'s manager, who grants it', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { program, projects, teams, tools } = wire(s);
  const pm = await hirePm(s, orgId);
  await program.settle();
  const kr = await s.org.addGoal(orgId, { title: 'Enterprise pilots', kind: 'key_result' } as never);
  const p = (await projects.create(orgId, { title: 'Enterprise pilot', goalIds: [kr.id], brief: { problem: 'p' } }, 'user')).project;
  await program.assign(orgId, p.key!, pm.id, 'user');
  const pmS = await sessionOf(s, pm.id);
  const headS = await sessionOf(s, s.writer.id);
  // the PM asks Writer (head of Sales) for Editor at 40%
  const asked = await tools.execute(pmS, 'org_resource_request', { project: p.key, role: 'account lead', member: 'Editor', allocation: 40, why: 'pilot customers need an owner', endDate: '2027-01-31' });
  assert.match(asked, /with Writer to approve, adjust, decline or hire/);
  let req = (await program.requestRows(orgId))[0];
  assert.equal(req.headAgentId, s.writer.id, 'addressed to the member\'s head');
  assert.equal(req.status, 'open');
  assert.ok((await inbox(s, s.writer.id, 'info')).some((e) => /Resource request for/.test(e.title)), 'the head is told');
  assert.ok((await program.heartbeatReasons(s.writer.id, new Date())).some((r) => /org_resource_decide/.test(r)), 'the head\'s heartbeat carries it');
  // only the head (or above) decides
  await assert.rejects(tools.execute(pmS, 'org_resource_decide', { request: req.id.slice(0, 8), action: 'approve' }), /decided by the head/);
  // the head adjusts: 25%, with the reason → a seat at 25%
  await assert.rejects(tools.execute(headS, 'org_resource_decide', { request: req.id.slice(0, 8), action: 'adjust', allocation: 25 }), /needs the reason/);
  const adj = await tools.execute(headS, 'org_resource_decide', { request: req.id.slice(0, 8), action: 'adjust', allocation: 25, note: 'renewals need Editor this month' });
  assert.match(adj, /Adjusted .* Editor joins as account lead at 25%/);
  req = await program.requestRow(orgId, req.id);
  assert.equal(req.status, 'adjusted');
  const team = await teams.team(orgId, p.id);
  assert.equal(team.members[0].allocation, 25);
  assert.equal(team.members[0].status, 'active', 'the seat is the allocation record');
  assert.ok((await inbox(s, pm.id, 'info')).some((e) => /Adjusted/.test(e.title)), 'the PM is told');
  // the PM escalates the cut: a resource_conflict card held by Writer's manager (the chief)
  const esc = await tools.execute(pmS, 'org_resource_escalate', { request: req.id.slice(0, 8), why: 'the pilot needs 40% to land by January' });
  assert.match(esc, /card [0-9a-f]{8} is with Chief/);
  const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'resource_conflict')!;
  assert.equal(card.holder, `agent:${s.chief.id}`, 'routed as the head raised it: its manager first');
  const held = (await s.decisions.describeFor(orgId, `agent:${s.chief.id}`)).find((d) => d.approval.id === card.id)!;
  assert.ok(held.mayDecide, held.why);
  await s.decisions.act(orgId, card.id, `agent:${s.chief.id}`, 'approve', { reasoning: 'the pilot is the quarter\'s bet' });
  req = await program.requestRow(orgId, req.id);
  assert.equal(req.status, 'approved');
  assert.equal((await teams.team(orgId, p.id)).members[0].allocation, 40, 'granted as asked: the seat resized, not duplicated');
  // a decline needs a reason; a rejected conflict upholds the head
  const r2 = await program.request(orgId, { project: p.key!, role: 'analyst', head: s.writer.id, allocation: 30, why: 'pipeline data' }, `agent:${pm.id}`);
  await assert.rejects(program.decide(orgId, r2.row.id, { action: 'decline' }, `agent:${s.writer.id}`), /needs the reason/);
  await program.decide(orgId, r2.row.id, { action: 'decline', note: 'no analyst in Sales' }, `agent:${s.writer.id}`);
  await program.escalate(orgId, r2.row.id, 'we need the numbers', `agent:${pm.id}`);
  const card2 = (await s.approvals.pending(orgId)).find((a) => a.kind === 'resource_conflict')!;
  await s.decisions.act(orgId, card2.id, `agent:${s.chief.id}`, 'reject', { reasoning: 'ask Data instead' });
  assert.equal((await program.requestRow(orgId, r2.row.id)).status, 'declined', 'the head\'s answer stands');
  // audit trail
  const actions = (await s.audit.list(orgId, { limit: 300 })).map((r) => r.action);
  for (const a of ['resource_request', 'resource_decide', 'resource_escalate']) assert.ok(actions.includes(a), `audited ${a}`);
});

test('an unanswered request climbs on its own after program.requestAnswerHours; a granted request without a member goes back to the head to fill', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { program, projects } = wire(s);
  const pm = await hirePm(s, orgId);
  await program.settle();
  const kr = await s.org.addGoal(orgId, { title: 'Pilots', kind: 'key_result' } as never);
  const p = (await projects.create(orgId, { title: 'Pilot', goalIds: [kr.id], brief: { problem: 'p' } }, 'user')).project;
  await program.assign(orgId, p.key!, pm.id, 'user');
  const { row } = await program.request(orgId, { project: p.key!, role: 'engineer', head: s.writer.id, allocation: 50, why: 'integration' }, `agent:${pm.id}`);
  // the PM may not escalate before the head's time is up
  await assert.rejects(program.escalate(orgId, row.id, 'now', `agent:${pm.id}`), /has until/);
  const org = await s.org.get(orgId);
  const later = new Date(Date.now() + 25 * 3_600_000);
  await program.tick(org, later);
  const r = await program.requestRow(orgId, row.id);
  assert.equal(r.status, 'escalated');
  const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'resource_conflict')!;
  assert.equal(card.holder, `agent:${s.chief.id}`);
  await s.decisions.act(orgId, card.id, `agent:${s.chief.id}`, 'approve', { reasoning: 'staff it' });
  assert.equal((await program.requestRow(orgId, row.id)).status, 'granted', 'no member was named: the head fills it');
  assert.ok((await program.heartbeatReasons(s.writer.id, new Date())).some((x) => /granted on escalation: name the member/.test(x)));
  await program.decide(orgId, row.id, { action: 'approve', member: s.editor.id }, `agent:${s.writer.id}`);
  assert.equal((await program.requestRow(orgId, row.id)).status, 'approved');
});

// ---- 4. per-goal and per-project cadence ----

test('each goal and project keeps its own rhythm: seeded from the tunables, set by its PM within bounds, held as a review it facilitates, skipped when empty', async () => {
  const s = await setup();
  fakeChannels(s);
  const orgId = await company(s);
  const { program, projects, tools } = wire(s);
  const pm = await hirePm(s, orgId);
  await program.settle();
  for (const [k, v] of [['program.reviewDays', 7], ['program.reviewMinDays', 7], ['program.reviewMaxDays', 14]] as const) await s.org.setTunable(orgId, k, v, { actor: 'user', why: 'test', decidedBy: 'user' });
  const objective = await s.org.addGoal(orgId, { title: 'Self-serve revenue', kind: 'objective', ownerAgentId: s.chief.id } as never, 'chief');
  await program.settle();
  assert.equal((await s.org.goal(orgId, objective.id)).ownerAgentId, pm.id);
  const kr = await s.org.addGoal(orgId, { title: 'Trials converted', kind: 'key_result', parentGoalId: objective.id, targetValue: 50 } as never, 'chief');
  await program.settle();
  const p = (await projects.create(orgId, { title: 'Onboarding', goalIds: [kr.id], brief: { problem: 'p' }, milestones: [{ name: 'Beta', date: '2027-01-15' }] }, 'user')).project;
  await program.assign(orgId, p.key!, pm.id, 'user');
  const fresh = await s.org.project(orgId, p.id);
  assert.ok(fresh.standupCron, 'the project sync is seeded from program.syncDays');
  const rows = await program.cadenceRows(orgId);
  assert.ok(rows.some((r) => r.refId === objective.id && r.kind === 'goal_review' && r.enabled === 1));
  assert.ok(rows.some((r) => r.refId === p.id && r.kind === 'milestone_review' && r.enabled === 1));
  // the PM sets a rhythm within the bounds; outside them it is refused
  const pmS = await sessionOf(s, pm.id);
  assert.match(await tools.execute(pmS, 'org_program_cadence', { ref: objective.id.slice(0, 8), kind: 'goal_review', cron: '0 10 * * 3' }), /goal review of "Self-serve revenue": "0 10 \* \* 3"/);
  await assert.rejects(tools.execute(pmS, 'org_program_cadence', { ref: p.key, kind: 'milestone_review', cron: '0 10 * * 1-5' }), /more often than the company allows/);
  await assert.rejects(tools.execute(await sessionOf(s, s.editor.id), 'org_program_cadence', { ref: p.key, kind: 'sync', cron: '0 9 * * 1' }), /only the owner/);
  assert.match(await tools.execute(pmS, 'org_program_cadence', { ref: p.key, kind: 'sync', cron: '0 9 * * 1,4' }), /sync: "0 9 \* \* 1,4"/);
  // due: the goal review is a weekly_review meeting run by the PM with its agenda
  const org = await s.org.get(orgId);
  const goalRow = (await program.cadenceRows(orgId)).find((r) => r.refId === objective.id)!;
  const at = new Date(Date.parse(goalRow.nextAt!) + 60_000);
  const due = await program.dueReviews(org, at);
  const review = due.find((d) => d.title.startsWith('Goal review'))!;
  assert.ok(review, 'the goal review is due');
  assert.equal(review.kind, 'weekly_review');
  assert.equal(review.facilitatorAgentId, pm.id);
  assert.match(review.agenda, /KR "Trials converted"/);
  assert.match(review.agenda, new RegExp(`${p.key} "Onboarding"`));
  assert.match(review.agenda, /org_project_update/);
  assert.ok((await program.cadenceRows(orgId)).find((r) => r.refId === objective.id)!.lastAt, 'marked held');
  // the milestone review of a project with nothing open skips itself (audited)
  await s.org.updateProject(orgId, p.id, { milestones: [] }, 'user');
  const msRow = (await program.cadenceRows(orgId)).find((r) => r.refId === p.id && r.kind === 'milestone_review')!;
  const due2 = await program.dueReviews(org, new Date(Date.parse(msRow.nextAt!) + 60_000));
  assert.ok(!due2.some((d) => d.title.includes('milestone review')));
  assert.ok((await s.audit.list(orgId, { limit: 300 })).some((r) => r.action === 'meeting_skipped' && r.refId === p.id));
  // the matrix shows each rhythm with its next occurrence
  const m = await program.matrix(orgId);
  const item = m.items.find((i) => i.id === p.id)!;
  assert.deepEqual(item.cadences.map((c) => c.kind), ['sync', 'milestone_review', 'status_update']);
  assert.ok(item.cadences.find((c) => c.kind === 'sync')!.nextAt);
});

// ---- 5. two managers, stretched members ----

test('a member sees both managers; a stretched member surfaces to its head and to each PM; the briefing stays within its cap', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { program, projects, teams } = wire(s);
  const pm = await hirePm(s, orgId);
  await program.settle();
  const kr = await s.org.addGoal(orgId, { title: 'Pilots', kind: 'key_result' } as never);
  const a = (await projects.create(orgId, { title: 'Pilot A', goalIds: [kr.id], brief: { problem: 'p' } }, 'user')).project;
  const b = (await projects.create(orgId, { title: 'Pilot B', goalIds: [kr.id], brief: { problem: 'p' } }, 'user')).project;
  await program.assign(orgId, a.key!, pm.id, 'user');
  await program.assign(orgId, b.key!, pm.id, 'user');
  await teams.grant(orgId, a.id, { agentId: s.editor.id, role: 'account lead', allocation: 50 }, `agent:${s.writer.id}`);
  await teams.grant(orgId, b.id, { agentId: s.editor.id, role: 'analyst', allocation: 40 }, `agent:${s.writer.id}`);
  const br = await briefingOf(s).briefingFor(s.editor.id);
  assert.match(br ?? '', /reports to Writer \(your line manager/);
  assert.match(br ?? '', new RegExp(`${a.key} \\(account lead 50%, PM Pat`));
  assert.match(br ?? '', /You are stretched: 90%/);
  assert.ok((br ?? '').length <= BRIEFING_BUDGET);
  const pmBrief = await briefingOf(s).briefingFor(pm.id);
  assert.match(pmBrief ?? '', /Program: you own 0 objective\(s\) and 2 project\(s\)/);
  // a request waiting on the head is in its "waiting on you"
  await program.request(orgId, { project: a.key!, role: 'designer', head: s.writer.id, allocation: 10, why: 'deck' }, `agent:${pm.id}`);
  assert.match(await briefingOf(s).briefingFor(s.writer.id) ?? '', /1 resource request\(s\) from Program Managers/);
  // signals: the head (lead) and the PM (owner) each hear of it
  const sig = (await program.signals(await s.org.get(orgId), new Date())).filter((x) => x.kind === 'member_stretched');
  assert.ok(sig.some((x) => x.addressee === 'lead' && x.addresseeId === s.writer.id && x.refId === s.editor.id));
  assert.ok(sig.some((x) => x.addressee === 'owner' && x.addresseeId === pm.id));
  await s.signals.sweep(orgId);
  assert.ok((await inbox(s, s.writer.id, 'org_signal')).some((e) => /stretched/.test(e.title)));
  assert.ok((await inbox(s, pm.id, 'org_signal')).some((e) => /stretched/.test(e.title)));
  const m = await program.matrix(orgId);
  const ed = m.members.find((x) => x.agentId === s.editor.id)!;
  assert.equal(ed.lineManager, 'Writer');
  assert.equal(ed.total, 90);
  assert.ok(ed.stretched);
  assert.deepEqual(ed.assignments.map((x) => `${x.key}:${x.allocation}:${x.pmName}`).sort(), [`${a.key}:50:Pat`, `${b.key}:40:Pat`].sort());
  assert.equal(m.health.stretched, 1);
});

// ---- 6. next work follows the allocation ----

test('task wakes respect allocation: a member lent 80% to a project picks its project task over equally urgent unit work, and its unit work once the project has had its share', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { program, projects, teams } = wire(s);
  (s.tasks as unknown as { agents: unknown }).agents = s.agents;
  const pm = await hirePm(s, orgId);
  await program.settle();
  const kr = await s.org.addGoal(orgId, { title: 'Pilots', kind: 'key_result' } as never);
  const p = (await projects.create(orgId, { title: 'Pilot', goalIds: [kr.id], brief: { problem: 'p' } }, 'user')).project;
  await program.assign(orgId, p.key!, pm.id, 'user');
  await teams.grant(orgId, p.id, { agentId: s.editor.id, role: 'account lead', allocation: 80 }, `agent:${s.writer.id}`);
  const next = new OrgNextWorkService(s.org, s.tasks, s.runtime, s.audit, s.agents, s.workspaces, s.units);
  const brief = { outcome: 'x', done_when: 'y' };
  const unitTask = await s.tasks.create(orgId, { title: 'Renewal call notes', brief, assigneeAgentId: s.editor.id });
  const projTask = await s.tasks.create(orgId, { title: 'Pilot SOW', brief, assigneeAgentId: s.editor.id, projectId: p.id });
  // both Now-lane-equivalent? the unit task sits in Unsorted (lane 0); move it to a Now project of the unit for a fair race
  const home = (await projects.create(orgId, { title: 'Renewals', goalIds: [kr.id], brief: { problem: 'p' } }, 'user')).project;
  await projects.linkTask(orgId, unitTask.id, home.id, 'user');
  const org = await s.org.get(orgId);
  let order = (await next.candidates(org, s.editor.id, new Date())).filter((c) => c.kind === 'todo').map((c) => c.task.id);
  assert.deepEqual(order, [projTask.id, unitTask.id], 'nothing worked yet: the 80% seat goes first');
  // the member has worked only on the project lately: its unit's share is now furthest behind
  for (let i = 0; i < 3; i++) {
    const t = await s.tasks.create(orgId, { title: `Pilot step ${i}`, brief, assigneeAgentId: s.editor.id, projectId: p.id });
    await s.tasks.claim(orgId, t.id, s.editor.id, `run-${i}`);
  }
  order = (await next.candidates(org, s.editor.id, new Date())).filter((c) => c.kind === 'todo').map((c) => c.task.id);
  assert.deepEqual(order, [unitTask.id, projTask.id], 'the unit\'s 20% is owed now');
});

// ---- 7. starters ----

test('starters with projects give them a Program Manager owner and a milestone review rhythm; a bad review cron is refused', () => {
  for (const slug of ['saas-startup', 'e-commerce-shop']) {
    const raw = JSON.parse(readFileSync(`blueprints/first-party/${slug}.company.json`, 'utf8')) as Record<string, unknown>;
    const bp = validateBlueprint(raw);
    assert.ok(bp.roles.some((r) => r.roleId === 'ops-pm'), `${slug} hires a Program Manager`);
    for (const p of bp.projects ?? []) {
      assert.equal(p.lead, 'Program Manager', `${slug}: ${p.title} is owned by the PM`);
      assert.match(p.review ?? '', /^\S+ \S+ \S+ \S+ \S+$/);
    }
    const bad = JSON.parse(JSON.stringify(raw)) as { projects: Array<Record<string, unknown>> };
    bad.projects[0].review = 'weekly';
    assert.throws(() => validateBlueprint(bad), /review must be a five-field cron/);
  }
});
