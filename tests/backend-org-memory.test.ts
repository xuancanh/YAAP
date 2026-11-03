/** Memory (docs/company-vision.md §6, execution-plan item 22): playbooks as
 *  agent-authored skills that go through review and are offered to roles,
 *  with skill outcomes feeding the retro; postmortem retros scheduled from
 *  the record (abandoned goal, escalation after the review rounds, repeated
 *  breaker trips, a critical audit finding) with a model-free agenda and a
 *  cooldown per ref; lessons from a retro landing in the lessons store per
 *  audience, charter changes as CEO cards with the diff, playbook changes as
 *  revise tasks; decision-log rows for every approval and autonomous action;
 *  the decision search; ask-the-company with verified citations, budget and
 *  audit; the knowledge graph; the chief's recall pack. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { agentLessons, orgDecisions, skills } from '../server/src/database/schema';
import type { DrizzleDb } from '../server/src/database/database.module';
import { testDb, memStorage, ctxStub, mcpStub } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { GroupChatService, COMPANY_SLUG } from '../server/src/groupchat/groupchat.service';
import { WorkspaceEventBus } from '../server/src/groupchat/workspace-events';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgIntentService } from '../server/src/org/org-intent.service';
import { OrgSignalsService } from '../server/src/org/org-signals.service';
import { OrgMeetingsService, parseMinutes } from '../server/src/org/org-meetings.service';
import { OrgMeetingRuntime } from '../server/src/org/org-meeting-runtime.service';
import { OrgPlaybooksService, playbookSlug, offeredToRole, parseOutcomes } from '../server/src/org/org-playbooks.service';
import { OrgKnowledgeService, keywordsOf, ASK_TOOLS } from '../server/src/org/org-knowledge.service';
import { OrgMemoryService, lineDiff } from '../server/src/org/org-memory.service';
import { MEMORY_TUNABLES, POSTMORTEM_TRIGGERS } from '../server/src/org/memory-tunables';
import { TUNABLES } from '../server/src/org/org-tunables';
import { OrgController } from '../server/src/org/org.controller';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const whoAmI = (req: AiRequest): string => /You are ([^,]+), in the /.exec(req.system ?? '')?.[1]?.trim() ?? '';
const roundOf = (req: AiRequest): number => Number(/\(round (\d) of/.exec(req.system ?? '')?.[1] ?? 0);
const lastUser = (req: AiRequest): string => [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
type Plan = (req: AiRequest, toolRound: number) => AiStreamEvent[] | Promise<AiStreamEvent[]>;

/** A provider whose reply is a function of the request (meeting turn, review
 *  wake, ask-the-company); `toolRound` counts the tool results so far. */
class MemoryProvider implements AiProvider {
  readonly name = 'scripted';
  readonly requests: AiRequest[] = [];
  usage = { inputTokens: 100, outputTokens: 50 };
  constructor(public plan: Plan) {}
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    const toolRound = req.messages.filter((m) => m.role === 'tool').length;
    for (const ev of await this.plan(req, toolRound)) yield ev;
    yield { type: 'usage', ...this.usage };
    yield { type: 'done' };
  }
}
const say = (text: string): AiStreamEvent[] => [{ type: 'answer', text }];
const call = (name: string, input: Record<string, unknown>): AiStreamEvent[] => [{ type: 'tool_call', id: `c-${Math.random().toString(36).slice(2, 8)}`, name, input }];

async function setup(plan: Plan = () => say('ok'), opts: { db?: DrizzleDb } = {}) {
  const db = opts.db ?? await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new MemoryProvider(plan);
  const skillsSvc = new SkillsService(db);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsSvc, stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer();
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const intent = new OrgIntentService(db, org, units, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, skillsSvc, bus);
  const signals = new OrgSignalsService(db, org, tasks, audit, agents, workspaces, bus, units);
  const meetings = new OrgMeetingsService(db, org, units, tasks, audit, agents, workspaces, approvals);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, undefined, undefined, intent, meetings);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, signals, undefined, intent);
  runtime.debounceMs = 15;
  const meetingRuntime = new OrgMeetingRuntime(db, meetings, org, units, audit, agents, workspaces, turns, repo, runtime, config, announcer, approvals, undefined, intent);
  const playbooks = new OrgPlaybooksService(db, org, tasks, audit, agents, skillsSvc, announcer);
  const knowledge = new OrgKnowledgeService(db, org, tasks, audit, agents, workspaces, repo, turns, runtime);
  const agentMemory = new AgentMemoryService(db, stub);
  const memory = new OrgMemoryService(db, org, tasks, audit, agents, meetings, approvals, runtime, turns, playbooks, knowledge, config, units, signals, meetingRuntime, agentMemory, bus);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config, units, signals, undefined, undefined, intent);
  const controller = new WorkspaceOrgController(mode, orgs, config, meetings, meetingRuntime, memory, knowledge, playbooks, org);
  const groupchat = new GroupChatService(db, workspaces, agents, stub, new WorkspaceEventBus(), config, undefined, bus, org, tasks, announcer, meetingRuntime);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write the newsletter.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit.' });
  return { db, agents, workspaces, repo, bus, audit, org, units, intent, tasks, approvals, signals, meetings, brief, runtime, meetingRuntime, playbooks, knowledge, memory, agentMemory, skills: skillsSvc, mode, orgs, controller, groupchat, provider, ws, chief, writer, editor, announcer };
}
type S = Awaited<ReturnType<typeof setup>>;

async function enable(s: S, modeName: 'supervised' | 'autonomous' = 'supervised') {
  const st = await s.mode.setMode(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: 10 });
  const orgId = st.orgId!;
  await s.org.updateMember(orgId, s.writer.id, { title: 'Writer' });
  await s.org.updateMember(orgId, s.editor.id, { title: 'Editor' });
  return orgId;
}
const session = (s: S, agentId: string, name: string) => s.repo.createSession({ workspaceId: s.ws.id, agentId, name });
// A meeting runs in its own sub-channel: its stream from the agenda message on.
const thread = async (s: S, channelId: string, rootId: string) => {
  const all = await s.groupchat.stream(channelId);
  return all.slice(Math.max(0, all.findIndex((x) => x.id === rootId)));
};

const PLAYBOOK = `---\nname: publish-an-issue\n---\nUse this when an issue is ready to go out.\n\n1. Run the link check.\n2. Ask the editor for the final read.\n3. Schedule for Friday 09:00.`;

// ---- 1. playbooks: write → review → active → offered to the role ----

test('org_write_playbook parks a skill and opens a review task with a reviewer other than the author; the reviewer\'s accept activates it; it is offered to its roles in their org context and callable as a skill; writing again is a new version', async () => {
  const s = await setup((req, toolRound) => {
    if (/You were woken as the REVIEWER/.test(lastUser(req))) return toolRound === 0 ? call('org_review', { verdict: 'accept', note: 'Clear and safe.' }) : say('Accepted.');
    return say('ok');
  });
  const orgId = await enable(s);
  const writerSession = await session(s, s.writer.id, 'writer chat');
  const editorSession = await session(s, s.editor.id, 'editor chat');
  const chiefSession = await session(s, s.chief.id, 'chief chat');
  // the tools: members get write/list/decisions, the chief also recall
  assert.deepEqual((await s.memory.specsFor(writerSession)).map((t) => t.name), ['org_write_playbook', 'org_playbooks', 'org_decisions']);
  assert.ok((await s.memory.specsFor(chiefSession)).some((t) => t.name === 'org_recall'));
  assert.ok(s.memory.owns('org_write_playbook') && s.memory.isReadOnly('org_write_playbook'));
  assert.equal(playbookSlug('Publish an issue!'), 'org-publish-an-issue');
  // write
  await assert.rejects(s.memory.execute(writerSession, 'org_write_playbook', { title: 'Publish an issue', body: PLAYBOOK, roles: ['Writer'] }), /why is required/);
  const out = await s.memory.execute(writerSession, 'org_write_playbook', { title: 'Publish an issue', body: PLAYBOOK, roles: ['Writer'], why: 'We ship every Friday the same way.' });
  assert.match(out, /Playbook "Publish an issue" v1 written \(org-publish-an-issue; new\) and sent to review: task [A-Z][A-Z0-9]{1,5}-\d+, reviewer (Chief|Editor)/);
  const [pb] = await s.playbooks.list(orgId);
  assert.equal(pb.status, 'in_review'); assert.equal(pb.version, 1); assert.equal(pb.ownerAgentId, s.writer.id);
  assert.deepEqual(JSON.parse(pb.roles), ['Writer']);
  const skill = await s.skills.get(pb.skillId!);
  assert.equal(skill.name, 'org-publish-an-issue'); assert.equal(skill.draft, 1); assert.equal(skill.enabled, 0, 'parked until the review accepts');
  assert.equal(skill.workspaceId, s.ws.id);
  assert.ok(!(await s.skills.toolSpecs(s.ws.id, s.writer.id)).some((t) => t.name === 'skill_org_publish_an_issue'), 'not callable yet');
  const task = await s.tasks.get(orgId, pb.reviewTaskId!);
  assert.equal(task.status, 'in_review'); assert.equal(task.assigneeAgentId, s.writer.id);
  assert.ok(task.reviewerAgentId && task.reviewerAgentId !== s.writer.id, 'reviewer ≠ author');
  assert.match(JSON.parse(task.brief).context, /--- SKILL\.md ---/);
  // nothing offered while in review
  assert.equal(await s.memory.contextFor(writerSession), null);
  // the reviewer is woken and accepts (the org_request_review path)
  assert.ok(s.runtime.pendingWakeKeys().some((k) => k.startsWith(task.id)));
  await s.runtime.flushAll();
  assert.equal((await s.tasks.get(orgId, task.id)).status, 'done');
  // the sweep (or any read) activates it
  const synced = await s.playbooks.syncReviews(orgId);
  assert.deepEqual(synced, [{ id: pb.id, status: 'active' }]);
  const active = await s.playbooks.get(orgId, pb.id);
  assert.equal(active.status, 'active');
  const live = await s.skills.get(pb.skillId!);
  assert.equal(live.enabled, 1); assert.equal(live.draft, 0); assert.match(live.instructions, /Run the link check/);
  assert.ok((await s.skills.toolSpecs(s.ws.id, s.writer.id)).some((t) => t.name === 'skill_org_publish_an_issue'), 'callable through the skill path');
  assert.match(s.skills.invocation(live), /Skill "org-publish-an-issue" loaded/);
  // offered to the role, not to others
  assert.match((await s.memory.contextFor(writerSession))!, /## Playbooks for your role[\s\S]*- skill_org_publish_an_issue \(v1\): Publish an issue — Use this when an issue is ready to go out\./);
  assert.equal(await s.memory.contextFor(editorSession), null, 'an Editor is not offered a Writer playbook');
  assert.ok(offeredToRole([], { title: 'Anyone', agentId: 'x' }) && !offeredToRole(['Writer'], { title: 'Editor', agentId: 'x' }));
  assert.match(await s.memory.execute(editorSession, 'org_playbooks', {}), /skill_org_publish_an_issue v1 \(active\) "Publish an issue" — for Writer; owner Writer/);
  assert.match(await s.memory.execute(editorSession, 'org_playbooks', { role: 'Editor' }), /No active playbooks for Editor/);
  assert.equal((await s.controller.playbookList(s.ws.id, 'writer')).length, 1);
  // audit, announcement, inbox
  const actions = (await s.audit.list(orgId, { limit: 200 })).map((r) => r.action);
  assert.ok(actions.includes('playbook_write') && actions.includes('playbook_activate'));
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  assert.ok((await s.groupchat.messages(company.id)).messages.some((m) => /Playbook active: "Publish an issue" v1/.test(m.text)));
  assert.ok((await s.agents.listEvents(s.writer.id, 20)).some((e) => /Playbook "Publish an issue" v1 is active/.test(e.title)));
  // a new version
  const v2 = await s.memory.execute(writerSession, 'org_write_playbook', { title: 'Publish an issue', body: `${PLAYBOOK}\n4. Post the link in #company.`, why: 'We forgot the announcement twice.' });
  assert.match(v2, /v2 written \(org-publish-an-issue; a new version\)/);
  const again = await s.playbooks.get(orgId, pb.id);
  assert.equal(again.version, 2); assert.equal(again.status, 'in_review');
  assert.match((await s.skills.get(pb.skillId!)).instructions, /Schedule for Friday 09:00\.$/, 'the live skill keeps v1 until v2 is accepted');
  await assert.rejects(s.memory.execute(writerSession, 'org_write_playbook', { title: 'Publish an issue', body: PLAYBOOK, why: 'x' }), /already in review/);
});

// ---- 2. outcomes feed the retro ----

test('skill outcomes (item 10) land on org_playbooks.outcomes; the retro agenda lists every playbook with its uses and rating and calls out the unloved', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const writerSession = await session(s, s.writer.id, 'writer chat');
  await s.memory.execute(writerSession, 'org_write_playbook', { title: 'Publish an issue', body: PLAYBOOK, why: 'Repeatable.' });
  const [pb] = await s.playbooks.list(orgId);
  await s.tasks.review(orgId, pb.reviewTaskId!, { verdict: 'accept', byAgentId: s.editor.id });
  await s.playbooks.syncReviews(orgId);
  await s.skills.recordUse([pb.skillId!, pb.skillId!, pb.skillId!]);
  await s.skills.recordUse([pb.skillId!]);
  await s.skills.recordOutcome([pb.skillId!], 'turn-1', 'down', 'wrong day');
  await s.skills.recordOutcome([pb.skillId!], 'turn-2', 'down');
  await s.skills.recordOutcome([pb.skillId!], 'turn-3', 'up');
  assert.equal(await s.playbooks.refreshOutcomes(orgId), 1);
  const o = parseOutcomes((await s.playbooks.get(orgId, pb.id)).outcomes)!;
  assert.equal(o.uses, 2); assert.equal(o.up, 1); assert.equal(o.down, 2); assert.ok(Math.abs(o.successRate! - 1 / 3) < 1e-9);
  const summary = (await s.playbooks.outcomesSummary(orgId))!;
  assert.match(summary, /## Playbooks and how they fared/);
  assert.match(summary, /Publish an issue v1 \(active; owner Writer; for everyone\): 2 use\(s\), 1 👍 \/ 2 👎 — RATED POORLY — revise or retire/);
  // a retro's agenda carries it (no model composes the agenda)
  const root = await s.units.rootUnit(orgId);
  const m0 = await s.meetingRuntime.start(orgId, { kind: 'retro', unitId: root.id });
  await s.meetingRuntime.idle();
  const m = await s.meetings.get(orgId, m0.id);
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  const msgs = await thread(s, m.channelId ?? company.id, m.threadRootId!);
  assert.match(msgs[0].text, /Retro for .*what worked[\s\S]*## Playbooks and how they fared[\s\S]*RATED POORLY/);
  assert.match(m.agenda, /## Playbooks and how they fared/);
  // the member's context shows the stats too
  assert.match((await s.memory.contextFor(writerSession))!, /2 use\(s\), 33% rated well/);
});

// ---- 3. postmortem triggers ----

test('each postmortem trigger schedules one retro for the owning unit with an agenda built from the record (timeline, cost, signals, decisions) and no model; the same ref is not retried inside the cooldown; triggers are a tunable bit set', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  assert.equal(TUNABLES['memory.postmortemTriggers'].default, 31);
  assert.ok(MEMORY_TUNABLES['memory.postmortemCooldownDays'].min >= 1);
  const retros = async () => (await s.meetings.list(orgId)).filter((m) => m.kind === 'retro' && m.createdBy === 'postmortem');

  // (a) an abandoned objective, event-driven
  const objective = await s.org.addGoal(orgId, { title: 'Reach 5,000 subscribers', description: 'Grow the list.' });
  const project = await s.org.addProject(orgId, { title: 'Growth', goalId: objective.id });
  const t1 = await s.tasks.create(orgId, { title: 'Run the referral campaign', projectId: project.id, assigneeAgentId: s.writer.id });
  const run = await s.tasks.startRun(orgId, { taskId: t1.id, agentId: s.writer.id, wakeReason: 'assignment' });
  await s.tasks.endRun(run.id, { status: 'done', outcome: 'progressed', tokensIn: 1000, tokensOut: 500, usd: 0.25 });
  await s.meetings.logDecision(orgId, { title: 'Referral bonus', decision: 'Offer a free month per referral for the subscribers campaign', rationale: 'Cheapest growth lever', decidedBy: 'chief', refType: 'goal', refId: objective.id });
  const before = s.provider.requests.length;
  await s.org.updateGoal(orgId, objective.id, { status: 'abandoned' });
  await s.memory.idle();
  assert.equal(s.provider.requests.length, before, 'no model composed the agenda');
  await s.meetingRuntime.idle();
  let list = await retros();
  assert.equal(list.length, 1);
  const retroA = list[0];
  assert.equal(retroA.unitId, root.id); assert.equal(retroA.title, 'Postmortem · Reach 5,000 subscribers');
  assert.match(retroA.agenda, /\*\*Why this retro\*\*: an objective or key result was abandoned\./);
  assert.match(retroA.agenda, /## What happened\nobjective \[\w{8}\] "Reach 5,000 subscribers" — status abandoned, owner nobody/);
  assert.match(retroA.agenda, /1 task\(s\) under it\./);
  assert.match(retroA.agenda, /## Timeline \(\d+ audit row\(s\)\)[\s\S]*\[audit:\d+\] .* user goal_create/);
  assert.match(retroA.agenda, /goal_update \{"status":"abandoned"\}/);
  assert.match(retroA.agenda, /## Cost\n1 run\(s\), \$0\.25, 1500 tokens — outcomes: progressed ×1\./);
  assert.match(retroA.agenda, /## Decisions touching it \(1\)\n- #decision:\w{8} .* "Referral bonus"/);
  assert.match(retroA.agenda, /## What this retro produces/);
  assert.equal((await s.meetings.get(orgId, retroA.id)).status, 'done', 'the retro ran');
  assert.match((await (async () => { const r = await s.meetings.get(orgId, retroA.id); return thread(s, r.channelId ?? company.id, r.threadRootId!); })())[0].text, /Postmortem · Reach 5,000 subscribers/);
  // dedupe: the sweep sees the abandoned goal again and schedules nothing new
  const swept = await s.memory.sweep(orgId);
  assert.ok(swept.some((x) => x.refId === objective.id && x.meetingId === null && /cooldown/.test(x.reason ?? '')));
  assert.equal((await retros()).length, 1);
  assert.equal((await s.audit.list(orgId, { action: 'postmortem_scheduled' })).length, 1);
  assert.ok((await s.agents.listEvents(s.chief.id, 50)).some((e) => /Postmortem scheduled: Postmortem · Reach 5,000/.test(e.title)));

  // (b) a task escalated after the review rounds, event-driven
  const t2 = await s.tasks.create(orgId, { title: 'Write the sponsor deck', assigneeAgentId: s.writer.id });
  await s.tasks.update(orgId, t2.id, { reviewRounds: 3 });
  await s.tasks.requestReview(orgId, t2.id, { fromAgentId: s.writer.id });
  await s.tasks.review(orgId, t2.id, { verdict: 'request_changes', note: 'still thin', byAgentId: s.editor.id });
  await s.memory.idle(); await s.meetingRuntime.idle();
  list = await retros();
  assert.equal(list.length, 2);
  const retroB = list.find((m) => m.title === 'Postmortem · Write the sponsor deck')!;
  assert.match(retroB.agenda, /a task escalated to the CEO after 3 review rounds/);
  assert.match(retroB.agenda, /Task [A-Z][A-Z0-9]{1,5}-\d+ "Write the sponsor deck" — status blocked, owner Writer, 3 review round\(s\), blockers: escalated: review round cap/);
  assert.match(retroB.agenda, /task_escalate/);
  // a plain escalation (round 1) does not
  const t3 = await s.tasks.create(orgId, { title: 'Pick a font', assigneeAgentId: s.writer.id });
  await s.tasks.escalate(orgId, t3.id, 'needs the CEO', 'chief');
  await s.memory.idle();
  assert.equal((await retros()).length, 2);

  // (c) a breaker tripped twice on one task — the sweep
  const t4 = await s.tasks.create(orgId, { title: 'Scrape the archive', assigneeAgentId: s.editor.id });
  for (const outcome of ['no_progress', 'loop']) { const r = await s.tasks.startRun(orgId, { taskId: t4.id, agentId: s.editor.id, wakeReason: 'rewake' }); await s.tasks.endRun(r.id, { status: outcome === 'loop' ? 'loop' : 'done', outcome, usd: 0.1 }); }
  const t5 = await s.tasks.create(orgId, { title: 'One trip only', assigneeAgentId: s.editor.id });
  { const r = await s.tasks.startRun(orgId, { taskId: t5.id, agentId: s.editor.id, wakeReason: 'rewake' }); await s.tasks.endRun(r.id, { status: 'done', outcome: 'no_progress' }); }
  const swept2 = await s.memory.sweep(orgId);
  await s.meetingRuntime.idle();
  assert.ok(swept2.some((x) => x.trigger === 'breaker' && x.refId === t4.id && x.meetingId));
  assert.ok(!swept2.some((x) => x.refId === t5.id), 'one trip is below memory.breakerTrips');
  const retroC = (await retros()).find((m) => m.title === 'Postmortem · Scrape the archive')!;
  assert.match(retroC.agenda, /a circuit breaker tripped repeatedly/);
  assert.match(retroC.agenda, /## Cost\n2 run\(s\), \$0\.20, 0 tokens — outcomes: (loop ×1, no_progress ×1|no_progress ×1, loop ×1)\./);

  // (d) a critical audit finding — the sweep
  await s.signals.open(orgId, { kind: 'audit_finding', severity: 'critical', refType: 'task', refId: `done_when_unmet:${t1.id}`, title: 'Audit: accepted without the campaign running', detail: 'The final comment shows no campaign.', addressee: 'ceo' });
  const swept3 = await s.memory.sweep(orgId);
  await s.meetingRuntime.idle();
  const d = swept3.find((x) => x.trigger === 'audit_critical')!;
  assert.ok(d.meetingId);
  const retroD = await s.meetings.get(orgId, d.meetingId!);
  assert.equal(retroD.title, 'Postmortem · accepted without the campaign running');
  assert.match(retroD.agenda, /the auditor recorded a critical finding/);
  assert.match(retroD.agenda, /Audit finding \(signal \w{8}, critical, open\): Audit: accepted without the campaign running\nThe final comment shows no campaign\./);
  assert.match(retroD.agenda, /## Signals \(1\)\n- critical audit_finding \(open\)/);
  assert.equal((await retros()).length, 4);
  // again: everything is inside its cooldown
  assert.ok((await s.memory.sweep(orgId)).every((x) => x.meetingId === null));
  assert.equal((await retros()).length, 4);

  // the bit set: switch escalations off and abandon another goal with the goal bit off too
  await s.org.setTunable(orgId, 'memory.postmortemTriggers', POSTMORTEM_TRIGGERS.breaker | POSTMORTEM_TRIGGERS.audit_critical, { why: 'Retros only for machinery failures.' });
  const g2 = await s.org.addGoal(orgId, { title: 'Second objective' });
  await s.org.updateGoal(orgId, g2.id, { status: 'abandoned' });
  await s.memory.idle();
  assert.equal((await retros()).length, 4, 'goal_abandoned is off');
  assert.match((await s.memory.considerPostmortem(orgId, 'goal_abandoned', 'goal', g2.id)).reason!, /trigger goal_abandoned is off/);
  await assert.rejects(s.org.setTunable(orgId, 'memory.postmortemTriggers', 99), /must stay within 0–31/);
  // every retro ran with the operating path of item 19: created by 'postmortem', in a sub-channel of the unit channel
  for (const m of await retros()) {
    assert.equal(m.createdBy, 'postmortem');
    assert.equal((await s.groupchat.get(m.channelId!)).parentChannelId, company.id);
  }
});

// ---- 4. lessons, charter cards, playbook revisions ----

test('meeting_propose_lesson in a retro: lessons land in the lessons store per audience (member | unit | company), a charter change becomes a charter_change card with the diff that the CEO approves into the charter (hash re-accepted), a playbook change becomes a revise task for its owner; approving writes a decision-log row', async () => {
  const s = await setup((req, toolRound) => {
    const me = whoAmI(req);
    if (/closing turn\)/.test(req.system ?? '')) return toolRound === 0 ? call('meeting_close', { summary: 'We learned three things.' }) : say('closed');
    if (roundOf(req) !== 1 || toolRound > 0) return say(`${me || 'agent'} has nothing to add.`);
    if (me === 'Writer') return call('meeting_propose_lesson', { text: 'Check the link checker before publishing.', audience: 'member' });
    if (me === 'Editor') return call('meeting_propose_lesson', { text: 'Sponsors need a week of notice.', audience: 'unit', proposedCharterChange: { agent: 'Writer', text: 'Tell sponsors a week before an issue mentions them.' } });
    if (me === 'Chief') return call('meeting_propose_lesson', { text: 'Never publish on a holiday.', audience: 'company', proposedPlaybookChange: { playbookId: 'Publish an issue', note: 'Add a holiday check before step 3.' } });
    return say(`${me || 'agent'} has nothing to add.`);
  });
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  // an active playbook owned by Writer
  const writerSession = await session(s, s.writer.id, 'writer chat');
  await s.memory.execute(writerSession, 'org_write_playbook', { title: 'Publish an issue', body: PLAYBOOK, why: 'Repeatable.' });
  const [pb] = await s.playbooks.list(orgId);
  await s.tasks.review(orgId, pb.reviewTaskId!, { verdict: 'accept', byAgentId: s.editor.id });
  await s.playbooks.syncReviews(orgId);
  // the lesson tool is offered in a retro only
  const m0 = await s.meetingRuntime.start(orgId, { kind: 'retro', unitId: root.id, agenda: 'Issue 7 went out late.' });
  await s.meetingRuntime.idle();
  const m = await s.meetings.get(orgId, m0.id);
  assert.equal(m.status, 'done');
  const minutes = parseMinutes(m.minutes);
  assert.equal(minutes.lessons!.length, 3);
  const byAudience = Object.fromEntries(minutes.lessons!.map((l) => [l.audience, l]));
  assert.ok(byAudience.member && byAudience.unit && byAudience.company);
  // the lessons store: member → Writer only; unit → the root unit (everyone here); company → everyone
  const lessonsOf = async (agentId: string) => (await s.db.select().from(agentLessons).where(eq(agentLessons.agentId, agentId))).map((l) => l.text);
  const w = await lessonsOf(s.writer.id); const e = await lessonsOf(s.editor.id); const c = await lessonsOf(s.chief.id);
  assert.ok(w.some((x) => /Check the link checker/.test(x)) && !e.some((x) => /Check the link checker/.test(x)) && !c.some((x) => /Check the link checker/.test(x)), 'a member lesson is the proposer\'s alone');
  assert.ok([w, e, c].every((xs) => xs.some((x) => /Sponsors need a week/.test(x))), 'a unit lesson reaches the unit');
  assert.ok([w, e, c].every((xs) => xs.some((x) => /Never publish on a holiday/.test(x))), 'a company lesson reaches everyone');
  assert.equal(byAudience.member.lessonIds!.length, 1); assert.equal(byAudience.company.lessonIds!.length, 3);
  const row = (await s.db.select().from(agentLessons).where(eq(agentLessons.agentId, s.editor.id)))[0];
  assert.equal(row.sourceKind, 'loop'); assert.equal(row.trusted, 1); assert.equal(row.audience, 'shared');
  assert.match(row.text, /^Retro lesson \(unit, "Retro · /);
  // the charter card
  const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'charter_change')!;
  assert.ok(card, 'a charter_change approval exists');
  assert.equal(byAudience.unit.proposedCharterChange!.approvalId, card.id);
  const payload = JSON.parse(card.payload) as { agentId: string; agentName: string; before: string; after: string; diff: string; mode: string; lesson: string; meetingId: string };
  assert.equal(payload.agentId, s.writer.id); assert.equal(payload.agentName, 'Writer'); assert.equal(payload.mode, 'append');
  assert.equal(payload.before, 'You write the newsletter.');
  assert.equal(payload.after, 'You write the newsletter.\n\nTell sponsors a week before an issue mentions them.');
  assert.equal(payload.diff, '  You write the newsletter.\n+ \n+ Tell sponsors a week before an issue mentions them.');
  assert.equal(payload.meetingId, m.id);
  assert.equal(lineDiff('a\nb', 'a\nc'), '- b\n  a\n+ c');
  assert.equal((await s.agents.get(s.writer.id)).charter, 'You write the newsletter.', 'nothing until the CEO decides');
  // the minutes and the thread show it
  assert.match(s.meetings.renderMinutes(m, minutes, new Map([[s.writer.id, 'Writer'], [s.editor.id, 'Editor'], [s.chief.id, 'Chief']])), /Lessons \(3\)\n- \[member\] Check the link checker before publishing\. \(Writer\)\n- \[unit\] Sponsors need a week of notice\. · charter change for Writer \(approval \w{8}\) \(Editor\)\n- \[company\] Never publish on a holiday\. · playbook \w{8} → task \[\w{8}\] \(Chief\)/);
  const msgs = await thread(s, m.channelId ?? company.id, m.threadRootId!);
  assert.ok(msgs.some((x) => x.authorId === s.editor.id && /Lesson \(unit\): Sponsors need a week of notice\. · proposes a charter change for Writer/.test(x.text)));
  // approve: the charter changes and its hash is re-accepted (no drift)
  const { approval, result } = await s.approvals.decide(orgId, card.id, 'approve', 'Agreed.');
  assert.equal(approval.status, 'approved');
  assert.equal((result as { agentId: string }).agentId, s.writer.id);
  assert.equal((await s.agents.get(s.writer.id)).charter, payload.after);
  assert.deepEqual(await s.org.checkCharters(orgId), [], 'the hash was re-accepted');
  const actions = (await s.audit.list(orgId, { limit: 300 })).map((r) => r.action);
  assert.ok(actions.includes('charter_change_proposed') && actions.includes('charter_change_applied') && actions.includes('charter_accept') && actions.includes('lesson_recorded'));
  assert.ok((await s.agents.listEvents(s.writer.id, 20)).some((ev) => ev.title === 'Your charter changed'));
  // the decision log got the approval
  const decision = (await s.db.select().from(orgDecisions).where(and(eq(orgDecisions.orgId, orgId), eq(orgDecisions.approvalId, card.id))))[0];
  assert.ok(decision);
  assert.match(decision.title, /^charter change: charter of Writer: Sponsors need a week of notice\./);
  assert.match(decision.decision, /^Approved: charter of Writer/);
  assert.match(decision.rationale, /Proposed because: From the retro .* Decision note: Agreed\./);
  assert.equal(decision.decidedBy, 'user');
  // the playbook revise task for its owner
  const tid = byAudience.company.proposedPlaybookChange!.taskId!;
  const revise = await s.tasks.get(orgId, tid);
  assert.equal(revise.assigneeAgentId, s.writer.id); assert.equal(revise.status, 'todo');
  assert.equal(revise.title, 'Revise playbook "Publish an issue" (v1)');
  assert.match(JSON.parse(revise.brief).context, /Never publish on a holiday\. — Add a holiday check before step 3\./);
  assert.match(JSON.parse(revise.brief).done_when, /v2/);
  assert.ok(actions.includes('playbook_revise_requested'));
  // a weekly review does not offer the lesson tool; the retro does
  const retroCtx = s.provider.requests.find((r) => whoAmI(r) === 'Writer')!;
  assert.ok(retroCtx.tools?.some((t) => t.name === 'meeting_propose_lesson'));
  const s2 = await setup(); const orgId2 = await enable(s2);
  await s2.meetingRuntime.start(orgId2, { kind: 'weekly_review', unitId: (await s2.units.rootUnit(orgId2)).id });
  await s2.meetingRuntime.idle();
  assert.ok(s2.provider.requests.every((r) => !r.tools?.some((t) => t.name === 'meeting_propose_lesson')));
});

// ---- 5. the decision log: approvals and autonomous actions ----

test('every applied approval and every autonomous structural action writes an org_decisions row with alternatives and rationale from the why; kinds that already log (cadence) are not duplicated; rejections are logged too', async () => {
  const s = await setup();
  const orgId = await enable(s, 'supervised');
  const chiefSession = await session(s, s.chief.id, 'chief chat');
  const rows = () => s.db.select().from(orgDecisions).where(eq(orgDecisions.orgId, orgId));
  assert.equal((await rows()).length, 0);
  // supervised: a hire card approved → one decision
  await s.runtime.execute(chiefSession, 'org_hire_agent', { templateOrPack: 'Academic Researcher', title: 'Researcher', why: 'Nobody digs up sources.' });
  const hire = (await s.approvals.pending(orgId)).find((a) => a.kind === 'hire')!;
  await s.approvals.decide(orgId, hire.id, 'approve', 'Go.');
  let all = await rows();
  assert.equal(all.length, 1);
  assert.equal(all[0].approvalId, hire.id); assert.equal(all[0].refType, 'approval');
  assert.match(all[0].title, /^hire: Academic Researcher as Researcher/);
  assert.match(all[0].decision, /^Approved: Academic Researcher as Researcher/);
  assert.equal(all[0].alternatives, 'Reject it, or ask for a revision.');
  assert.match(all[0].rationale, /Proposed because: Nobody digs up sources\. Decision note: Go\./);
  // a rejected tune → logged as rejected
  await s.runtime.execute(chiefSession, 'org_tune', { key: 'intent.paceTolerance', value: 0.3, why: 'Research is slow.' });
  const tune = (await s.approvals.pending(orgId)).find((a) => a.kind === 'tune')!;
  await s.approvals.decide(orgId, tune.id, 'reject', 'Keep the pressure.');
  all = await rows();
  assert.equal(all.length, 2);
  const rejected = all.find((d) => d.approvalId === tune.id)!;
  assert.match(rejected.decision, /^Rejected: tune intent\.paceTolerance 0\.15 → 0\.3/);
  assert.equal(rejected.alternatives, 'Approve it as proposed.');
  // a revision request is not a decision
  await s.runtime.execute(chiefSession, 'org_tune', { key: 'intent.paceTolerance', value: 0.25, why: 'Try less.' });
  const tune2 = (await s.approvals.pending(orgId)).find((a) => a.kind === 'tune')!;
  await s.approvals.decide(orgId, tune2.id, 'revise', 'Lower.');
  assert.equal((await rows()).length, 2);
  // a cadence card: the meetings module logs it itself — exactly one row
  const root = await s.units.rootUnit(orgId);
  await s.meetingRuntime.execute(chiefSession, 'org_set_cadence', { kind: 'standup', cron: '0 11 * * 1-5', why: 'Later.' });
  const cad = (await s.approvals.pending(orgId)).find((a) => a.kind === 'cadence')!;
  await s.approvals.decide(orgId, cad.id, 'approve');
  all = await rows();
  assert.equal(all.filter((d) => d.approvalId === cad.id).length, 1, 'not duplicated');
  assert.equal(all.filter((d) => d.approvalId === cad.id)[0].refType, 'cadence');
  void root;
  // autonomous: hire, budget, tune act at once and each is a decision
  await s.mode.setMode(s.ws.id, { mode: 'autonomous', chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: 10 });
  const n = (await rows()).length;
  await s.runtime.execute(chiefSession, 'org_hire_agent', { templateOrPack: 'Marketer', title: 'Marketer', why: 'Growth has no owner.' });
  await s.runtime.execute(chiefSession, 'org_allocate_budget', { scope: 'agent', agent: 'Writer', monthlyUsd: 5, why: 'The writer runs most.' });
  await s.runtime.execute(chiefSession, 'org_tune', { key: 'intent.confidenceDrops', value: 3, why: 'Writers are moody.' });
  all = (await rows()).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  assert.equal(all.length, n + 3);
  const auto = all.slice(n);
  assert.match(auto[0].title, /^Autonomous hire: Marketer as Marketer/);
  assert.equal(auto[0].rationale, 'Growth has no owner.'); assert.equal(auto[0].decidedBy, 'chief'); assert.equal(auto[0].refType, 'org'); assert.equal(auto[0].refId, orgId);
  assert.match(auto[0].alternatives, /Leave the structure as it was/);
  assert.match(auto[1].title, /^Autonomous budget: agent Writer: \$0\.00 → \$5\.00\/month/);
  assert.match(auto[2].title, /^Autonomous tune: intent\.confidenceDrops: 2 → 3/);
  assert.equal(auto[2].alternatives, 'Keep intent.confidenceDrops at 2.'); assert.equal(auto[2].refType, 'tunable'); assert.equal(auto[2].refId, 'intent.confidenceDrops');
  // every row is also an audit decision_log row
  assert.equal((await s.audit.list(orgId, { action: 'decision_log', limit: 100 })).length, all.length);
});

// ---- 6. decision search ----

test('GET …/org/decisions/search?q= is ILIKE over title, decision and rationale; org_decisions is the same read for any member, narrowed by unit', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  await s.meetings.logDecision(orgId, { title: 'Pricing tier', decision: 'Launch a $5 PRO tier in March', alternatives: 'Stay free', rationale: 'Covers the model bill', decidedBy: 'chief', unitId: root.id });
  await s.meetings.logDecision(orgId, { title: 'Weekly cadence', decision: 'Publish every Friday', rationale: 'Readers expect a rhythm; pricing is unaffected', decidedBy: 'chief' });
  await s.meetings.logDecision(orgId, { title: 'Hire a designer', decision: 'Not now', rationale: 'Budget', decidedBy: 'user' });
  const hits = await s.controller.searchDecisions(s.ws.id, 'pricing');
  assert.deepEqual(hits.map((d) => d.title).sort(), ['Pricing tier', 'Weekly cadence']);
  assert.deepEqual((await s.controller.searchDecisions(s.ws.id, 'pro TIER')).map((d) => d.title), ['Pricing tier'], 'case-insensitive, over the decision text');
  assert.deepEqual((await s.controller.searchDecisions(s.ws.id, 'budget')).map((d) => d.title), ['Hire a designer'], 'over the rationale');
  assert.equal((await s.controller.searchDecisions(s.ws.id, 'pricing', root.id)).length, 1, 'narrowed by unit');
  assert.equal((await s.controller.searchDecisions(s.ws.id, '')).length, 3, 'no q lists the log');
  assert.equal((await s.knowledge.searchDecisions(orgId, '100%_x')).length, 0, 'wildcards are escaped');
  const editorSession = await session(s, s.editor.id, 'editor chat');
  const out = await s.memory.execute(editorSession, 'org_decisions', { q: 'pricing' });
  assert.match(out, /\[decision:[\w-]+\] .* "Pricing tier": Launch a \$5 PRO tier in March · alternatives: Stay free · because: Covers the model bill — chief/);
  assert.match(out, /"Weekly cadence"/);
  assert.match(await s.memory.execute(editorSession, 'org_decisions', { q: 'pricing', unit: 'company' }), /Pricing tier/);
  assert.doesNotMatch(await s.memory.execute(editorSession, 'org_decisions', { q: 'pricing', unit: 'company' }), /Weekly cadence/);
  assert.match(await s.memory.execute(editorSession, 'org_decisions', { q: 'zebra' }), /No decision matches "zebra"/);
  await assert.rejects(s.memory.execute(editorSession, 'org_decisions', { unit: 'nope' }), /no unit "nope"/);
});

// ---- 7. ask the company ----

test('POST …/org/ask runs one chief turn over the model-free recall pack with read-only tools only (anything else is refused), verifies every citation and strips unknown ones, reserves and settles budget, audits ask_company', async () => {
  let ids = { task: '', decision: '', goal: '', meeting: '' };
  const s = await setup((req, toolRound) => {
    if (!/# Ask the company/.test(req.system ?? '')) return say('ok');
    if (toolRound === 0) return [...call('org_decisions', { q: 'pricing' }), ...call('org_hire_agent', { templateOrPack: 'Researcher', title: 'Researcher', why: 'sneaky' })];
    return say(`We decided to launch a $5 PRO tier [decision:${ids.decision}] to fund the model bill, in service of [goal:${ids.goal}]. The launch task [task:${ids.task}] is in progress; see the planning minutes [meeting:${ids.meeting}] and the audit row [audit:1]. Unrelated: [task:deadbeef0000] [decision:nope123456] [audit:99999] [goal:${ids.goal.slice(0, 3)}].`);
  });
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const goal = await s.org.addGoal(orgId, { title: 'Sustainable pricing', description: 'The newsletter pays for its own models.' });
  const project = await s.org.addProject(orgId, { title: 'PRO tier', goalId: goal.id });
  const task = await s.tasks.create(orgId, { title: 'Launch the PRO tier page', projectId: project.id, assigneeAgentId: s.writer.id, brief: { outcome: 'A pricing page live', done_when: 'Stripe link works' } });
  const decision = await s.meetings.logDecision(orgId, { title: 'Pricing tier', decision: 'Launch a $5 PRO tier in March', alternatives: 'Stay free', rationale: 'Covers the model bill', decidedBy: 'chief' });
  const meeting = await s.meetings.create(orgId, { kind: 'planning', unitId: root.id, agenda: 'Pricing' });
  await s.meetings.update(orgId, meeting.id, { status: 'done', minutes: JSON.stringify({ summary: 'Pricing agreed: PRO tier.', decisions: [], actions: [], risks: [], questions: [] }), endedAt: new Date().toISOString() });
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  await s.groupchat.post(company.id, { text: 'Pricing page draft is up for review.', authorKind: 'human' });
  ids = { task: task.id, decision: decision.id, goal: goal.id, meeting: meeting.id };
  // the pack
  const pack = await s.knowledge.recall(orgId, 'What did we decide about pricing and what happened after?');
  assert.deepEqual(pack.keywords, ['pricing', 'pric']);
  assert.deepEqual(pack.decisions.map((d) => d.id), [decision.id]);
  assert.deepEqual(pack.goals.map((g) => g.id), [goal.id]);
  assert.deepEqual(pack.tasks.map((t) => t.id), [task.id], 'matched through the brief');
  assert.deepEqual(pack.meetings.map((m) => m.id), [meeting.id]);
  assert.equal(pack.messages.length, 1); assert.equal(pack.messages[0].channel, 'company');
  assert.ok(pack.audit.length > 0);
  const text = s.knowledge.renderPack(pack);
  assert.match(text, new RegExp(`\\[decision:${decision.id}\\] .* "Pricing tier": Launch a \\$5 PRO tier in March — because Covers the model bill`));
  assert.match(text, new RegExp(`\\[task:${task.id}\\] "Launch the PRO tier page" \\(todo, Writer`));
  // ask
  const before = (await s.audit.list(orgId, { limit: 200 })).length;
  const r = await s.controller.ask(s.ws.id, { question: 'What did we decide about pricing and what happened after?' });
  assert.equal(r.status, 'answered');
  assert.deepEqual(r.citations.map((c) => `${c.kind}:${c.id}`), [`decision:${decision.id}`, `goal:${goal.id}`, `task:${task.id}`, `meeting:${meeting.id}`, 'audit:1']);
  assert.equal(r.citations.find((c) => c.kind === 'audit')!.title.slice(0, 10), 'org_create');
  assert.deepEqual(r.stripped, ['[task:deadbeef0000]', '[decision:nope123456]', '[audit:99999]', `[goal:${goal.id.slice(0, 3)}]`]);
  assert.match(r.answer, new RegExp(`\\[decision:${decision.id}\\] to fund the model bill, in service of \\[goal:${goal.id}\\]`));
  assert.match(r.answer, /Unrelated:\.$/, 'unknown citations are gone');
  assert.ok(r.usd > 0);
  // the turn: read-only tools only; the hire call was refused, not executed
  const askReq = s.provider.requests.find((x) => /# Ask the company/.test(x.system ?? ''))!;
  assert.ok(askReq.tools!.length > 0 && askReq.tools!.every((t) => ASK_TOOLS.has(t.name)), `offered: ${askReq.tools!.map((t) => t.name).join(', ')}`);
  assert.match(askReq.system!, /## The record[\s\S]*Pricing tier/);
  assert.match(lastUser(askReq), /^Question: What did we decide about pricing/);
  const second = s.provider.requests.filter((x) => /# Ask the company/.test(x.system ?? ''))[1]!;
  const toolMsgs = second.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.ok(toolMsgs.some((c) => /Pricing tier/.test(c)), 'org_decisions ran');
  assert.ok(toolMsgs.some((c) => /Refused: org_hire_agent is not available in this run/.test(c)), 'org_hire_agent was refused');
  assert.equal((await s.approvals.pending(orgId)).length, 0, 'no hire card');
  // budget and audit
  const rows = await s.audit.list(orgId, { limit: 300 });
  const actions = rows.slice(0, rows.length - before).map((x) => x.action);
  assert.ok(actions.includes('spend_reserve') && actions.includes('spend_commit') && actions.includes('ask_company_start'));
  const asked = rows.find((x) => x.action === 'ask_company')!;
  assert.equal(asked.actor, 'user');
  const p = JSON.parse(asked.payload) as { status: string; citations: string[]; stripped: string[]; usd: number };
  assert.equal(p.status, 'answered'); assert.equal(p.citations.length, 5); assert.equal(p.stripped.length, 4); assert.ok(p.usd > 0);
  assert.ok((await s.agents.listEvents(s.chief.id, 20)).some((e) => /^Asked: What did we decide about pricing/.test(e.title)));
  assert.ok((await s.repo.listSessions(s.ws.id)).some((x) => x.agentId === s.chief.id && / · Ask$/.test(x.name)));
  // the envelope: a company cap with no headroom refuses with budget_stop and audits it
  await s.org.setBudget(orgId, { scope: 'company', refId: orgId, monthlyUsd: 0.000001 });
  const refused = await s.memory.ask(orgId, 'Anything?', 'user');
  assert.equal(refused.status, 'budget_stop');
  assert.ok((await s.audit.list(orgId, { action: 'ask_company_refused' })).length === 1);
  await assert.rejects(s.controller.ask(s.ws.id, { question: 'x' }), /a question is required/);
});

// ---- 8. the knowledge graph ----

test('GET …/org/graph?ref=&depth= walks goal ↔ project ↔ task ↔ comment, decision ↔ meeting ↔ approval and message ↔ task through the link columns, depth 1 or 2, without a model', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const goal = await s.org.addGoal(orgId, { title: 'Sustainable pricing', unitId: root.id });
  const kr = await s.intent.setKeyResult(orgId, { title: 'Paying readers', objectiveId: goal.id, metric: 'subscribers', targetValue: 100, dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ownerAgentId: s.writer.id });
  const project = await s.org.addProject(orgId, { title: 'PRO tier', goalId: goal.id });
  const task = await s.tasks.create(orgId, { title: 'Launch the PRO tier page', projectId: project.id, assigneeAgentId: s.writer.id });
  await s.tasks.comment(orgId, task.id, { text: 'Draft is up.', fromAgentId: s.writer.id });
  const meeting = await s.meetings.create(orgId, { kind: 'planning', unitId: root.id });
  const decision = await s.meetings.logDecision(orgId, { title: 'Pricing tier', decision: 'Launch a $5 PRO tier', decidedBy: 'chief', meetingId: meeting.id, refType: 'goal', refId: goal.id });
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  const msg = await s.groupchat.post(company.id, { text: `We settled it: #decision:${decision.id.slice(0, 8)} serves #goal:${goal.id.slice(0, 8)}.`, authorKind: 'human' });
  const before = s.provider.requests.length;
  // depth 1 from the goal
  const g1 = await s.controller.graph(s.ws.id, `goal:${goal.id}`, '1');
  assert.equal(g1.root, `goal:${goal.id}`); assert.equal(g1.depth, 1);
  const kinds1 = (g: typeof g1) => g.nodes.map((n) => n.key).sort();
  assert.deepEqual(kinds1(g1), [`decision:${decision.id}`, `goal:${goal.id}`, `goal:${kr.id}`, `message:${msg.id}`, `project:${project.id}`, `unit:${root.id}`].sort());
  assert.ok(g1.edges.some((e) => e.from === `goal:${goal.id}` && e.to === `goal:${kr.id}` && e.rel === 'child'));
  assert.ok(g1.edges.some((e) => e.to === `message:${msg.id}` && e.rel === 'mention'));
  assert.ok(g1.edges.some((e) => e.to === `decision:${decision.id}` && e.rel === 'decision'));
  assert.ok(!g1.nodes.some((n) => n.kind === 'task'), 'the task is two hops away');
  // depth 2 reaches the task through the project, the meeting through the decision, and the owner
  const g2 = await s.controller.graph(s.ws.id, `goal:${goal.id.slice(0, 8)}`, '2');
  const keys2 = new Set(g2.nodes.map((n) => n.key));
  assert.ok(keys2.has(`task:${task.id}`) && keys2.has(`meeting:${meeting.id}`) && keys2.has(`agent:${s.writer.id}`));
  assert.ok(g2.edges.some((e) => e.from === `project:${project.id}` && e.to === `task:${task.id}` && e.rel === 'task'));
  assert.ok(g2.edges.some((e) => e.from === `decision:${decision.id}` && e.to === `meeting:${meeting.id}` && e.rel === 'meeting'));
  assert.ok(!g2.nodes.some((n) => n.kind === 'comment'), 'the comment is three hops away');
  assert.equal(g2.truncated, false);
  assert.ok(g2.nodes.find((n) => n.key === `task:${task.id}`)!.title === 'Launch the PRO tier page');
  // from the task: comment, project, owner, unit
  const g3 = await s.controller.graph(s.ws.id, `task:${task.id}`, '1');
  assert.ok(g3.nodes.some((n) => n.kind === 'comment' && /Writer: Draft is up\./.test(n.title)));
  assert.ok(g3.edges.some((e) => e.to === `project:${project.id}` && e.rel === 'project') && g3.edges.some((e) => e.to === `agent:${s.writer.id}` && e.rel === 'owner'));
  // from the message: the mentions resolve
  const g4 = await s.controller.graph(s.ws.id, `message:${msg.id}`, '1');
  assert.deepEqual(g4.nodes.map((n) => n.kind).sort(), ['decision', 'goal', 'message']);
  // from the decision: the meeting, what it is about, the message that cites it
  const g5 = await s.knowledge.graph(orgId, `decision:${decision.id}`, 1);
  assert.deepEqual(g5.nodes.map((n) => n.kind).sort(), ['decision', 'goal', 'meeting', 'message']);
  assert.ok(g5.edges.some((e) => e.to === `goal:${goal.id}` && e.rel === 'about'));
  assert.equal(s.provider.requests.length, before, 'no model');
  await assert.rejects(s.controller.graph(s.ws.id, 'goal', '1'), /ref must be <kind>:<id>/);
  await assert.rejects(s.controller.graph(s.ws.id, 'task:nothere', '1'), /no task "nothere"/);
});

// ---- 9. org_recall ----

test('org_recall gives the chief the model-free pack with citation ids inside a run (no second model); members do not have it; keywordsOf drops stop words', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const t = await s.tasks.create(orgId, { title: 'Design the pricing page', assigneeAgentId: s.writer.id });
  await s.meetings.logDecision(orgId, { title: 'Pricing tier', decision: 'Launch a $5 PRO tier', decidedBy: 'chief' });
  const chiefSession = await session(s, s.chief.id, 'chief chat');
  const writerSession = await session(s, s.writer.id, 'writer chat');
  const before = s.provider.requests.length;
  const out = await s.memory.execute(chiefSession, 'org_recall', { question: 'What happened with pricing?' });
  assert.match(out, /^Recall for: "What happened with pricing\?" \(keywords: pricing, pric\)/);
  assert.match(out, new RegExp(`## Tasks \\(1\\)\\n- \\[task:${t.id}\\] "Design the pricing page" \\(todo, Writer`));
  assert.match(out, /## Decisions \(1\)\n- \[decision:[\w-]+\] .* "Pricing tier": Launch a \$5 PRO tier/);
  assert.match(out, /## Channel messages \(0\)\n- none matched/);
  assert.equal(s.provider.requests.length, before, 'retrieval only');
  await assert.rejects(s.memory.execute(writerSession, 'org_recall', { question: 'x' }), /chief-of-staff tool/);
  await assert.rejects(s.memory.execute(chiefSession, 'org_recall', {}), /question is required/);
  assert.ok((await s.audit.list(orgId, { action: 'recall' })).length === 1);
  assert.deepEqual(keywordsOf('What did we decide about the Sponsors and pricing?'), ['sponsors', 'sponsor', 'pricing', 'pric']);
  assert.deepEqual(keywordsOf('why'), []);
  // the route
  assert.equal((await s.controller.recall(s.ws.id, 'pricing')).tasks.length, 1);
  // with no keywords the goals fall back to the most recent few, tasks to none
  const empty = await s.knowledge.recall(orgId, '???');
  assert.equal(empty.tasks.length, 0); assert.equal(empty.keywords.length, 0);
});

// ---- 10. the memory tick and the tunables ----

test('the memory tick sweeps every active org (playbook reviews synced, postmortems considered) and the memory tunables sit on the shared registry with their bounds', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const writerSession = await session(s, s.writer.id, 'writer chat');
  await s.memory.execute(writerSession, 'org_write_playbook', { title: 'Triage the inbox', body: PLAYBOOK, roles: ['Editor'], why: 'Mornings are chaos.' });
  const [pb] = await s.playbooks.list(orgId);
  await s.tasks.review(orgId, pb.reviewTaskId!, { verdict: 'accept', byAgentId: s.chief.id });
  assert.equal((await s.playbooks.get(orgId, pb.id)).status, 'in_review');
  await s.memory.tick(new Date());
  assert.equal((await s.playbooks.get(orgId, pb.id)).status, 'active');
  // a paused org is left alone
  await s.runtime.pause(orgId);
  assert.deepEqual(await s.memory.sweep(orgId), []);
  await s.runtime.resume(orgId);
  // the tunables
  for (const k of Object.keys(MEMORY_TUNABLES)) { assert.ok(TUNABLES[k], k); assert.equal(TUNABLES[k].area, 'memory'); }
  const org = await s.org.get(orgId);
  assert.equal(TUNABLES['memory.recallCap'].default, 12);
  await s.org.setTunable(orgId, 'memory.recallCap', 3, { why: 'Small company.' });
  await s.tasks.create(orgId, { title: 'Pricing A' }); await s.tasks.create(orgId, { title: 'Pricing B' }); await s.tasks.create(orgId, { title: 'Pricing C' }); await s.tasks.create(orgId, { title: 'Pricing D' });
  assert.equal((await s.knowledge.recall(orgId, 'pricing')).tasks.length, 3, 'the cap is the tunable');
  await assert.rejects(s.org.setTunable(orgId, 'memory.askUsdCap', 50), /must stay within 0\.05–5/);
  void org;
  // retire: the skill is disabled, the playbook no longer offered
  const editorSession = await session(s, s.editor.id, 'editor chat');
  assert.match((await s.memory.contextFor(editorSession))!, /Triage the inbox/);
  await s.playbooks.retire(orgId, pb.id, 'user', 'Inbox is automated now.');
  assert.equal(await s.memory.contextFor(editorSession), null);
  assert.equal((await s.db.select().from(skills).where(eq(skills.id, pb.skillId!)))[0].enabled, 0);
  assert.equal((await s.controller.playbookList(s.ws.id, undefined, 'retired')).length, 1);
});
