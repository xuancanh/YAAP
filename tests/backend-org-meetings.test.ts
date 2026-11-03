/** Rituals (docs/company-vision.md §3, §1b, §6; docs/group-chat.md §8;
 *  execution-plan item 19): a meeting is a thread in a unit channel — the
 *  facilitator posts the agenda, every agent attendee gets one turn per round
 *  (cap 3), human messages in the thread reach the next round, "stop" ends it,
 *  the closing turn writes the summary and the minutes materialise into tasks,
 *  decision-log rows and questions for the brief; standups are composed from
 *  the board without a model; cadences per unit fire by cron on the tick and
 *  obey the mode; the daily cap, the USD cap and quiet hours bound it; the
 *  `/meeting` command starts one and wakes nobody else; `#decision:` refs
 *  resolve; the chief reshapes cadences within bounds with a reason; the
 *  operating profile reaches the prompt. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { orgCadences, orgDecisions, organizations, workspaces } from '../server/src/database/schema';
import type { DrizzleDb } from '../server/src/database/database.module';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { GroupChatService, COMPANY_SLUG } from '../server/src/groupchat/groupchat.service';
import { ChannelRuntimeService } from '../server/src/groupchat/channel-runtime.service';
import { WorkspaceEventBus } from '../server/src/groupchat/workspace-events';
import { parseDecisionRefs, channelSessionName } from '../server/src/groupchat/mentions';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgMeetingsService, parseMeetingCommand, parseMinutes, nextCronAfter, isValidCron } from '../server/src/org/org-meetings.service';
import { OrgMeetingRuntime } from '../server/src/org/org-meeting-runtime.service';
import { meetingTunable, meetingKinds, operatingProfile } from '../server/src/org/meeting-tunables';
import { TUNABLES, checkTunable } from '../server/src/org/org-tunables';
import { OrgController } from '../server/src/org/org.controller';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import { GroupChatController } from '../server/src/groupchat/groupchat.controller';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

/** Who is speaking, from the meeting context's "You are <name>, in the …" line. */
const whoAmI = (req: AiRequest): string => /You are ([^,]+), in the /.exec(req.system ?? '')?.[1]?.trim() ?? 'agent';
const isClosing = (req: AiRequest): boolean => /closing turn\)/.test(req.system ?? '');
const roundOf = (req: AiRequest): number => Number(/\(round (\d) of/.exec(req.system ?? '')?.[1] ?? 0);
const lastUser = (req: AiRequest): string => [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

type Plan = (me: string, round: number, closing: boolean, req: AiRequest, toolRound: number) => AiStreamEvent[] | Promise<AiStreamEvent[]>;

/** A provider whose reply is a function of who is asked, in which round;
 *  `toolRound` counts the tool results already in the conversation, so a plan
 *  can call a tool first and answer on the next round. */
class MeetingProvider implements AiProvider {
  readonly name = 'scripted';
  readonly requests: AiRequest[] = [];
  usage = { inputTokens: 100, outputTokens: 50 };
  constructor(public plan: Plan) {}
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    const toolRound = req.messages.filter((m) => m.role === 'tool').length;
    for (const ev of await this.plan(whoAmI(req), roundOf(req), isClosing(req), req, toolRound)) yield ev;
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
  const provider = new MeetingProvider(plan);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer();
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const meetings = new OrgMeetingsService(db, org, units, tasks, audit, agents, workspaces, approvals);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, undefined, undefined, undefined, meetings);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units);
  runtime.debounceMs = 15;
  const meetingRuntime = new OrgMeetingRuntime(db, meetings, org, units, audit, agents, workspaces, turns, repo, runtime, config, announcer, approvals);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config, units);
  const controller = new WorkspaceOrgController(mode, orgs, config, meetings, meetingRuntime);
  const events = new WorkspaceEventBus();
  const groupchat = new GroupChatService(db, workspaces, agents, stub, events, config, undefined, bus, org, tasks, announcer, meetingRuntime);
  const channelRuntime = new ChannelRuntimeService(db, groupchat, turns, repo, agents, workspaces, events);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit.' });
  return { db, agents, workspaces, repo, bus, audit, org, units, tasks, approvals, meetings, brief, runtime, meetingRuntime, mode, orgs, controller, groupchat, channelRuntime, events, provider, ws, chief, writer, editor, announcer };
}
type S = Awaited<ReturnType<typeof setup>>;

async function enable(s: S, modeName: 'supervised' | 'autonomous' = 'autonomous') {
  const st = await s.mode.setMode(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: 10 });
  return st.orgId!;
}

/** A meeting's stream: it runs in its own sub-channel (docs/group-chat.md §9),
 *  whose messages from the agenda root on are the meeting. */
const meetingStream = async (s: S, m: { channelId: string | null; threadRootId: string | null }) => {
  const all = await s.groupchat.stream(m.channelId!);
  return all.slice(Math.max(0, all.findIndex((x) => x.id === m.threadRootId)));
};

// ---- 1. a meeting runs rounds and materialises its minutes ----

test('a meeting runs in its own sub-channel: agenda first, one turn per attendee per round (cap 3), a closing turn; the parent gets only the link card and the minutes line; minutes become tasks, decisions and brief questions; audited with the hash', async () => {
  const s = await setup((me, round, closing, _req, toolRound) => {
    if (closing) return toolRound === 0 ? call('meeting_close', { summary: 'We ship issue 1 on Friday; Writer drafts, Editor reviews.' }) : say('Closed.');
    if (toolRound > 0) return say(`${me} done for round ${round}.`);
    if (me === 'Writer' && round === 1) return call('meeting_propose_action', { title: 'Draft issue 1', owner: 'Writer', done_when: 'Editor accepted the draft', outcome: 'A publishable draft' });
    if (me === 'Editor' && round === 1) return call('meeting_propose_decision', { title: 'Weekly cadence', decision: 'Publish every Friday', alternatives: 'Biweekly', rationale: 'Readers expect a rhythm' });
    if (me === 'Editor' && round === 2) return call('meeting_raise_risk', { text: 'Sources are thin for issue 2' });
    if (me === 'Writer' && round === 3) return call('meeting_ask_ceo', { question: 'Do we take sponsors?' });
    if (me === 'Chief') return call('meeting_speak', { text: `Chief speaking in round ${round}.` });
    return say(`${me} has nothing to add in round ${round}.`);
  });
  const orgId = await enable(s);
  await s.org.setTunable(orgId, 'meeting.selectiveRounds', 0); // everyone every round (selective rounds have their own test)
  const root = await s.units.rootUnit(orgId);
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  const m0 = await s.meetingRuntime.start(orgId, { kind: 'planning', unitId: root.id, agenda: 'Plan issue 1.', createdBy: 'user' });
  assert.equal(m0.status, 'scheduled');
  assert.equal(m0.facilitatorAgentId, s.chief.id, 'the unit lead facilitates');
  await s.meetingRuntime.idle();
  const m = await s.meetings.get(orgId, m0.id);
  assert.equal(m.status, 'done');
  assert.equal(m.rounds, 3, 'three rounds, the cap');
  assert.ok(m.threadRootId && m.startedAt && m.endedAt);
  assert.ok(m.usd > 0, 'usage was priced');
  // the sub-channel: meeting-planning-<date> under #company, closed at the end
  assert.equal(m.parentChannelId, company.id, 'the record keeps the channel it was called in');
  assert.notEqual(m.channelId, company.id, 'and points at the sub-channel');
  const sub = await s.groupchat.get(m.channelId!);
  assert.equal(sub.channelKind, 'sub'); assert.equal(sub.parentChannelId, company.id); assert.equal(sub.purpose, 'meeting'); assert.equal(sub.meetingId, m.id);
  assert.match(sub.slug, /^meeting-planning-\d{4}-\d{2}-\d{2}$/);
  assert.equal(sub.status, 'closed', 'a meeting sub-channel closes when the meeting ends');
  assert.equal(sub.folder, 'channels/company/sub/' + sub.slug);
  // the stream: the agenda as the facilitator's message, the turns, the minutes — all at the top level
  const msgs = await meetingStream(s, m);
  assert.ok(msgs.every((x) => x.threadRootId === null), 'no thread inside the sub-channel');
  assert.equal(msgs[0].authorKind, 'agent'); assert.equal(msgs[0].authorId, s.chief.id);
  assert.match(msgs[0].text, /Planning · .*facilitated by Chief\. Attendees: Writer, Editor, Chief/);
  assert.match(msgs[0].text, /Plan issue 1\./);
  const agentTurns = msgs.filter((x) => x.authorKind === 'agent' && x.id !== m.threadRootId);
  assert.equal(agentTurns.length, 9, 'three attendees × three rounds, each exactly one post');
  assert.ok(agentTurns.some((x) => x.authorId === s.chief.id && /Chief speaking in round 3/.test(x.text)));
  assert.ok(agentTurns.some((x) => /Action proposed: Draft issue 1 — owner Writer/.test(x.text)));
  const minutesMsg = msgs.filter((x) => !/^Closed/.test(x.text)).at(-1)!;
  assert.equal(minutesMsg.authorKind, 'system');
  assert.match(minutesMsg.text, /^\*\*Minutes — Planning/);
  assert.match(minutesMsg.text, /We ship issue 1 on Friday/);
  assert.deepEqual(JSON.parse(minutesMsg.attachments), [{ path: `meetings/${m.id}`, kind: 'minutes' }]);
  // the facilitator spoke last in each round
  const order = agentTurns.slice(0, 3).map((x) => x.authorId);
  assert.equal(order[2], s.chief.id);
  // the parent: the link card (ended, with the outcome) and the one minutes line — nothing else of the meeting
  const top = (await s.groupchat.messages(company.id)).messages;
  const card = top.find((x) => x.id === sub.linkMessageId)!;
  assert.match(card.text, /^📅 Meeting: Planning · .* · ended — We ship issue 1 on Friday/);
  assert.deepEqual(JSON.parse(card.attachments), [{ path: `subchannel/${sub.id}`, kind: 'subchannel' }]);
  assert.match(top.at(-1)!.text, /^Minutes of Planning · .*: 1 decision\(s\), 1 action\(s\), 1 risk\(s\), 1 question\(s\) for the CEO · .* · #meeting-planning-/);
  assert.ok(!top.some((x) => x.authorKind === 'agent'), 'no agent turn landed in #company');
  assert.ok(!top.some((x) => /Plan issue 1\./.test(x.text)), 'nor the agenda');
  assert.equal((await s.groupchat.messages(company.id, { thread: card.id })).messages.length, 1, 'the card has no thread of meeting posts');
  // minutes materialised
  const minutes = parseMinutes(m.minutes);
  assert.equal(minutes.summary, 'We ship issue 1 on Friday; Writer drafts, Editor reviews.');
  assert.equal(minutes.endedBy, 'closed');
  assert.equal(minutes.actions.length, 1);
  const task = await s.tasks.get(orgId, minutes.actions[0].taskId!);
  assert.equal(task.title, 'Draft issue 1');
  assert.equal(task.assigneeAgentId, s.writer.id, 'the chief facilitates, so the owner is assigned');
  assert.equal(task.status, 'todo');
  assert.equal(task.unitId, root.id);
  assert.equal(task.channelId, company.id); assert.equal(task.messageId, sub.linkMessageId, 'actions link to the card in the channel the meeting was called in');
  assert.match(JSON.parse(task.brief).done_when, /Editor accepted/);
  assert.match(JSON.parse(task.brief).context, /From the Planning/);
  assert.equal(minutes.decisions.length, 1);
  const decision = await s.meetings.decision(orgId, minutes.decisions[0].decisionId!);
  assert.equal(decision.title, 'Weekly cadence'); assert.equal(decision.meetingId, m.id); assert.equal(decision.decidedBy, `agent:${s.editor.id}`);
  assert.equal(decision.refType, 'meeting');
  assert.deepEqual(minutes.risks.map((r) => r.text), ['Sources are thin for issue 2']);
  assert.deepEqual(minutes.questions.map((q) => q.question), ['Do we take sponsors?']);
  // the brief carries the question
  const b = await s.brief.compose(orgId, { deliver: false });
  assert.match(b.text, /## Questions from meetings\n- Do we take sponsors\? — Writer, Planning/);
  // audit: start, three rounds, end with the hash; a decision_log row; the risk
  const rows = await s.audit.list(orgId, { limit: 200 });
  const actions = rows.map((r) => r.action);
  assert.equal(actions.filter((a) => a === 'meeting_start').length, 1);
  assert.equal(actions.filter((a) => a === 'meeting_round').length, 3);
  assert.ok(actions.includes('decision_log') && actions.includes('meeting_risk'));
  const end = rows.find((r) => r.action === 'meeting_end')!;
  assert.match(JSON.parse(end.payload).hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(end.payload).endedBy, 'closed');
  assert.ok((await s.audit.verify(orgId)).ok);
  // budget reserved and settled per turn
  assert.ok(actions.filter((a) => a === 'spend_reserve').length >= 10);
  // the facilitator's inbox
  const ev = (await s.agents.listEvents(s.chief.id, 50)).find((e) => e.kind === 'meeting')!;
  assert.match(ev.title, /^Minutes: Planning/);
  // transcripts landed in the per-agent per-channel sessions channel wakes use
  const sessions = await s.repo.listSessions(s.ws.id);
  assert.ok(sessions.some((x) => x.name === channelSessionName(sub.slug, 'Writer') && x.agentId === s.writer.id));
  // the API
  assert.equal((await s.controller.meetingList(s.ws.id, undefined, 'done')).length, 1);
  assert.equal((await s.controller.meeting(s.ws.id, m.id)).id, m.id);
  assert.equal((await s.controller.decisions(s.ws.id))[0].id, decision.id);
});

// ---- 2. human injection and the stop word ----

test('a human message in the meeting sub-channel is injected into the next round; "stop" ends the meeting without a closing turn and the minutes say so', async () => {
  let orgId = '';
  const seen: string[] = [];
  // a person speaks in the meeting's sub-channel during Editor's round-1 turn
  const subOf = async () => (await s.meetings.list(orgId))[0].channelId!;
  const s: S = await setup(async (me, round, closing, req) => {
    if (closing) return say('closing');
    seen.push(`${me}:${round}:${lastUser(req).includes('Prefer Thursday') ? 'heard' : '-'}`);
    if (me === 'Editor' && round === 1) await s.groupchat.post(await subOf(), { text: 'Prefer Thursday, not Friday.', authorKind: 'human' });
    return say(`${me} in round ${round}.`);
  });
  orgId = await enable(s);
  await s.org.setTunable(orgId, 'meeting.selectiveRounds', 0); // everyone every round, as before
  const root = await s.units.rootUnit(orgId);
  await s.meetingRuntime.start(orgId, { kind: 'weekly_review', unitId: root.id });
  await s.meetingRuntime.idle();
  assert.ok(seen.includes('Writer:1:-'), 'round 1 before the human spoke');
  assert.ok(seen.includes('Writer:2:heard') && seen.includes('Editor:2:heard') && seen.includes('Chief:2:heard'), `round 2 heard the person: ${seen.join(', ')}`);
  assert.ok(!seen.includes('Writer:3:heard'), 'round 3 does not repeat it');

  // stop: a person says so during round 1 → no round 2, no closing turn
  let orgId2 = '';
  let closings = 0;
  const s2: S = await setup(async (me, round, closing, _req, toolRound) => {
    if (closing) { closings++; return say('closing'); }
    if (me === 'Writer' && round === 1 && toolRound === 0) {
      return call('meeting_propose_action', { title: 'Collect sources', owner: 'Writer', done_when: 'Three sources listed' });
    }
    if (me === 'Editor' && round === 1) await s2.groupchat.post((await s2.meetings.list(orgId2))[0].channelId!, { text: 'stop', authorKind: 'human' });
    return say(`${me} in round ${round}.`);
  });
  orgId2 = await enable(s2);
  await s2.org.setTunable(orgId2, 'meeting.selectiveRounds', 0);
  const m1 = await s2.meetingRuntime.start(orgId2, { kind: 'retro', unitId: (await s2.units.rootUnit(orgId2)).id });
  await s2.meetingRuntime.idle();
  const m = await s2.meetings.get(orgId2, m1.id);
  const root2 = m.threadRootId!;
  assert.equal(m.status, 'done');
  assert.equal(m.rounds, 1);
  assert.equal(closings, 0, 'no closing turn after a stop');
  const minutes = parseMinutes(m.minutes);
  assert.equal(minutes.endedBy, 'stopped');
  assert.match(minutes.summary, /^Ended early by a person\. Actions: Collect sources \(Writer\)\./);
  assert.ok(minutes.actions[0].taskId, 'what was proposed before the stop still materialises');
  const msgs = await meetingStream(s2, m);
  assert.ok(msgs.some((x) => x.authorKind === 'system' && /Meeting ended by a person/.test(x.text)));
  const chiefTurns = msgs.filter((x) => x.authorKind === 'agent' && x.authorId === s2.chief.id && x.id !== root2);
  assert.equal(chiefTurns.length, 0, 'the facilitator never got round 1: the stop came before its turn');
  // the API cancel ends a running meeting at the next turn boundary too
  const m2 = await s2.meetings.create(orgId2, { kind: 'adhoc', unitId: (await s2.units.rootUnit(orgId2)).id });
  await s2.controller.cancelMeeting(s2.ws.id, m2.id);
  assert.equal((await s2.meetings.get(orgId2, m2.id)).status, 'cancelled');
  assert.equal(await s2.meetingRuntime.run(orgId2, m2.id), 'skipped:cancelled');
});

// ---- 3. the standup without a model ----

test('a standup agenda is composed from the board without a model call — per member done / in progress / blocked and open tasks; blocked tasks without an owner go to the lead; one round only', async () => {
  const s = await setup((me) => say(me === 'Writer' ? 'Blocked on the style guide, need Editor today.' : 'nothing to add'));
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  const done = await s.tasks.create(orgId, { title: 'Outline issue 1', assigneeAgentId: s.writer.id });
  await s.tasks.update(orgId, done.id, { status: 'done' });
  const prog = await s.tasks.create(orgId, { title: 'Draft issue 1', assigneeAgentId: s.writer.id });
  await s.tasks.update(orgId, prog.id, { status: 'in_progress' });
  const blockedOwned = await s.tasks.create(orgId, { title: 'Style guide', assigneeAgentId: s.editor.id });
  await s.tasks.update(orgId, blockedOwned.id, { status: 'blocked', blockers: ['waiting for examples'] });
  const orphan = await s.tasks.create(orgId, { title: 'Pick a font', unitId: root.id });
  await s.tasks.update(orgId, orphan.id, { status: 'blocked', blockers: ['nobody owns this'] });
  assert.equal(s.provider.requests.length, 0);
  const m0 = await s.meetingRuntime.start(orgId, { kind: 'standup', unitId: root.id });
  await s.meetingRuntime.idle();
  const m = await s.meetings.get(orgId, m0.id);
  assert.equal(m.status, 'done');
  assert.equal(m.rounds, 1, 'a standup is one round');
  assert.equal(m.parentChannelId, company.id);
  const msgs = await meetingStream(s, m);
  const agenda = msgs[0].text;
  assert.match(agenda, /Standup for .* — since .*Composed from the board/);
  assert.match(agenda, /\*\*Writer\*\*\n- done: [A-Z][A-Z0-9]{1,5}-\d+ Outline issue 1\n- in progress: [A-Z][A-Z0-9]{1,5}-\d+ Draft issue 1\n- blocked: nothing/);
  assert.match(agenda, /\*\*Editor\*\*\n- done: nothing since the last standup\n- in progress: nothing\n- blocked: [A-Z][A-Z0-9]{1,5}-\d+ Style guide — waiting for examples/);
  assert.match(agenda, /\*\*Chief\*\* \(lead\)[\s\S]*- blocked: [A-Z][A-Z0-9]{1,5}-\d+ Pick a font — nobody owns this/);
  assert.match(agenda, new RegExp(`Blocked without an owner → Chief now owns: ${orphan.key}`));
  const reassigned = await s.tasks.get(orgId, orphan.id);
  assert.equal(reassigned.assigneeAgentId, s.chief.id);
  assert.equal(reassigned.status, 'blocked', 'still blocked: it got an owner, not a wake');
  // exactly one model call per attendee, none for the agenda or the minutes
  assert.equal(s.provider.requests.length, 3);
  assert.ok(s.provider.requests.every((r) => /Standup, your one turn/.test(lastUser(r))));
  // and no closing turn with a model: the summary is composed
  const minutes = parseMinutes(m.minutes);
  assert.match(minutes.summary, /^Closed without a facilitator summary\./);
  assert.ok(msgs.some((x) => x.authorId === s.writer.id && /Blocked on the style guide/.test(x.text)), 'a plain answer is posted as the turn');
  assert.ok((await s.audit.list(orgId, { action: 'blocked_owner_assigned' })).length === 1);
  // the standup remembers where it left off
  assert.match((await s.meetings.standupAgenda(orgId, root)).agenda, new RegExp(`since ${m.endedAt!.slice(0, 16).replace('T', ' ')}`));
});

// ---- 4. cadences: defaults per unit, firing by cron, mode gating ----

test('cadence defaults appear with each unit (board for the root only), fire by cron on the tick for active orgs, and obey the mode: supervised runs the conversations but a board meeting needs a human CEO or board seat', async () => {
  const s = await setup(() => say('ok'));
  const orgId = await enable(s, 'supervised');
  await s.org.setTunable(orgId, 'meeting.prepMinutes', 0); await s.org.setTunable(orgId, 'meeting.reminderMinutes', 0); await s.org.setTunable(orgId, 'meeting.autoSkip', 0); // this test is about firing
  const root = await s.units.rootUnit(orgId);
  const defaults = await s.meetings.cadences(orgId);
  assert.deepEqual(defaults.filter((c) => c.unitId === root.id).map((c) => `${c.kind} ${c.cron}`).sort(), ['board 0 9 * * 1', 'retro 30 16 * * 5', 'standup 30 9 * * 1-5', 'weekly_review 0 16 * * 5']);
  assert.ok(defaults.every((c) => c.enabled === 1 && c.nextRunAt));
  // a new unit gets the three unit cadences
  const a1 = await s.agents.create({ name: 'Alpha' });
  await s.org.addMember(orgId, { agentId: a1.id, reportsToAgentId: s.writer.id, scopes: [] });
  const writerUnit = (await s.units.ledBy(orgId, s.writer.id))!;
  const mine = (await s.meetings.cadences(orgId)).filter((c) => c.unitId === writerUnit.id);
  assert.deepEqual(mine.map((c) => c.kind).sort(), ['retro', 'standup', 'weekly_review']);
  assert.equal(await s.meetings.ensureCadenceDefaults(orgId), 0, 'idempotent');
  assert.equal((await s.controller.cadences(s.ws.id)).length, 7);
  // helpers
  assert.ok(isValidCron('30 9 * * 1-5') && !isValidCron('every day') && !isValidCron('* * * *'));
  const monday = new Date(2026, 10, 2, 8, 59); // local time, a Monday
  assert.equal(nextCronAfter('0 9 * * 1', monday)!.getHours(), 9);

  // Monday 09:00: the board cadence is due but supervised mode skips it (no human seat); 09:30 the standups run
  const at0900 = new Date(2026, 10, 2, 9, 0);
  await s.meetingRuntime.tick(at0900);
  await s.meetingRuntime.idle();
  assert.equal((await s.meetings.list(orgId)).length, 0, 'no board meeting');
  const skipped = await s.audit.list(orgId, { action: 'meeting_skipped' });
  assert.equal(skipped.length, 1);
  assert.match(JSON.parse(skipped[0].payload).reason, /needs a human CEO or board member/);
  const boardCadence = (await s.db.select().from(orgCadences).where(eq(orgCadences.id, defaults.find((c) => c.kind === 'board')!.id)))[0];
  assert.equal(boardCadence.lastRunAt, at0900.toISOString(), 'fired (and skipped) once; not retried this minute');
  await s.meetingRuntime.tick(at0900);
  assert.equal((await s.audit.list(orgId, { action: 'meeting_skipped' })).length, 1);
  const at0930 = new Date(2026, 10, 2, 9, 30);
  await s.meetingRuntime.tick(at0930);
  await s.meetingRuntime.idle();
  const standups = (await s.meetings.list(orgId)).filter((m) => m.kind === 'standup');
  assert.equal(standups.length, 2, 'one per unit');
  assert.ok(standups.every((m) => m.status === 'done' && m.createdBy === 'cadence'));
  assert.deepEqual(standups.map((m) => m.unitId).sort(), [root.id, writerUnit.id].sort());
  // a board seat lets the board meeting run in supervised mode
  await s.org.setHuman(orgId, { memberAccountId: 'board-1', role: 'board' });
  const nextMonday = new Date(2026, 10, 9, 9, 0);
  await s.meetingRuntime.tick(nextMonday);
  await s.meetingRuntime.idle();
  const board = (await s.meetings.list(orgId)).find((m) => m.kind === 'board')!;
  assert.ok(board && board.status === 'done');
  assert.equal(board.facilitatorAgentId, s.chief.id);
  // a paused org fires nothing
  await s.runtime.pause(orgId);
  await s.meetingRuntime.tick(new Date(2026, 10, 3, 9, 30));
  await s.meetingRuntime.idle();
  assert.equal((await s.meetings.list(orgId)).filter((m) => m.kind === 'standup').length, 2);
  // the API edits a cadence; a bad cron is refused
  const edited = await s.controller.updateCadence(s.ws.id, mine[0].id, { cron: '0 10 * * 1-5' });
  assert.equal(edited.cron, '0 10 * * 1-5');
  await assert.rejects(s.controller.updateCadence(s.ws.id, mine[0].id, { cron: 'daily' }), /five fields/);
  assert.equal((await s.controller.updateCadence(s.ws.id, mine[0].id, { enabled: false })).enabled, 0);
});

// ---- 5. the daily cap ----

test('the per-unit daily meeting cap (default 4) refuses the fifth meeting of a unit that day, audited and told to the chief', async () => {
  const s = await setup(() => say('ok'));
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  for (let i = 0; i < 4; i++) {
    const m = await s.meetingRuntime.start(orgId, { kind: 'adhoc', unitId: root.id, attendees: [{ kind: 'agent', id: s.chief.id }], agenda: `Meeting ${i + 1}` });
    await s.meetingRuntime.idle();
    assert.equal((await s.meetings.get(orgId, m.id)).status, 'done');
  }
  assert.equal(await s.meetings.countToday(orgId, root.id), 4);
  const fifth = await s.meetingRuntime.start(orgId, { kind: 'adhoc', unitId: root.id, attendees: [{ kind: 'agent', id: s.chief.id }] });
  await s.meetingRuntime.idle();
  const m = await s.meetings.get(orgId, fifth.id);
  assert.equal(m.status, 'cancelled');
  assert.equal(m.threadRootId, null, 'nothing was posted');
  const refused = await s.audit.list(orgId, { action: 'meeting_refused' });
  assert.equal(refused.length, 1);
  assert.equal(JSON.parse(refused[0].payload).reason, 'daily_cap');
  assert.ok((await s.agents.listEvents(s.chief.id, 50)).some((e) => e.kind === 'info' && /Meeting refused/.test(e.title)));
  // the tunables fence: a culture may ask for more, never past the bound
  assert.equal(meetingTunable({ tunables: JSON.stringify({ 'meeting.dailyCap': 2 }) }, 'meeting.dailyCap'), 2);
  assert.equal(meetingTunable({ tunables: JSON.stringify({ 'meeting.dailyCap': 50 }) }, 'meeting.dailyCap'), 12);
  assert.equal(meetingTunable({ tunables: JSON.stringify({ 'meeting.roundCap': 9 }) }, 'meeting.roundCap'), 3);
  assert.equal(meetingTunable({ tunables: JSON.stringify({ 'meeting.usdCap': 0 }) }, 'meeting.usdCap'), 0.05);
  assert.deepEqual(meetingKinds({ tunables: JSON.stringify({ 'meeting.kinds': ['standup', 'nonsense'] }) }), ['standup']);
  assert.equal(meetingKinds({}).length, 6);
  assert.equal(meetingTunable({}, 'meeting.leadsOnly'), 0);
  assert.equal(meetingTunable(undefined, 'meeting.usdCap'), 1);
  // registered on the shared registry (org_tune and PUT …/org/tunables see them)
  assert.equal(TUNABLES['meeting.usdCap'].area, 'rituals');
  assert.deepEqual(checkTunable('meeting.roundCap', 5), { ok: false, reason: 'meeting.roundCap must stay within 1–3 (the safety floor; default 3)' });
  const limits = s.meetings.limitsFor({ ...(await s.org.get(orgId)), tunables: JSON.stringify({ 'meeting.roundCap': 1, 'meeting.usdCap': 0.5, 'meeting.leadsOnly': 1 }) });
  assert.deepEqual([limits.roundCap, limits.usdCap, limits.dailyCap, limits.attendees], [1, 0.5, 4, 'leads']);
  // and the real column drives a meeting: one round, leads only
  await s.db.update(organizations).set({ tunables: JSON.stringify({ 'meeting.roundCap': 1, 'meeting.leadsOnly': 1 }) }).where(eq(organizations.id, orgId));
  const tuned = await s.meetingRuntime.start(orgId, { kind: 'planning', unitId: root.id, agenda: 'Tuned' });
  await s.meetingRuntime.idle();
  const t = await s.meetings.get(orgId, tuned.id);
  assert.equal(t.status, 'cancelled', 'still the fifth meeting today: the daily cap holds');
  await s.db.update(organizations).set({ tunables: JSON.stringify({ 'meeting.roundCap': 1, 'meeting.leadsOnly': 1, 'meeting.dailyCap': 12 }) }).where(eq(organizations.id, orgId));
  const tuned2 = await s.meetingRuntime.start(orgId, { kind: 'planning', unitId: root.id, agenda: 'Tuned' });
  await s.meetingRuntime.idle();
  const t2 = await s.meetings.get(orgId, tuned2.id);
  assert.equal(t2.status, 'done'); assert.equal(t2.rounds, 1);
  assert.deepEqual(JSON.parse(t2.attendees).filter((a: { kind: string }) => a.kind === 'agent').map((a: { id: string }) => a.id), [s.chief.id], 'leads only: no report leads a unit');
});

// ---- 6. the USD cap ----

test('the per-meeting USD cap stops a meeting before the next turn; the minutes say so and what was proposed is kept', async () => {
  const s = await setup((me, _round, _closing, _req, toolRound) => (me === 'Writer' && toolRound === 0 ? call('meeting_raise_risk', { text: 'We are spending too much' }) : say('ok')));
  s.provider.usage = { inputTokens: 60_000, outputTokens: 40_000 }; // ≈ $0.78 on the fallback price per request: the tool round + its answer pass $1
  s.runtime.estimateTokens = { input: 1_000, output: 100 };
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const m0 = await s.meetingRuntime.start(orgId, { kind: 'planning', unitId: root.id });
  await s.meetingRuntime.idle();
  const m = await s.meetings.get(orgId, m0.id);
  assert.equal(m.status, 'done');
  assert.equal(m.rounds, 1);
  assert.ok(m.usd > 1, `spent $${m.usd}`);
  const turns = s.provider.requests.filter((r) => !isClosing(r));
  assert.equal(new Set(turns.map(whoAmI)).size, 1, 'only the first attendee spoke before the cap closed the meeting');
  assert.equal(s.provider.requests.filter(isClosing).length, 0, 'no closing turn either');
  const minutes = parseMinutes(m.minutes);
  assert.equal(minutes.endedBy, 'usd_cap');
  assert.match(minutes.summary, /^Ended at the meeting budget cap\./);
  assert.deepEqual(minutes.risks.map((r) => r.text), ['We are spending too much']);
  assert.equal(JSON.parse((await s.audit.list(orgId, { action: 'meeting_end' }))[0].payload).endedBy, 'usd_cap');
});

// ---- 7. quiet hours ----

test('quiet hours postpone a meeting (status postponed, retried by the tick when the window ends); the kill switch cancels', async () => {
  const s = await setup(() => say('ok'));
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  await s.db.update(workspaces).set({ quietHours: JSON.stringify({ start: '00:00', end: '23:59', timezone: 'UTC', policy: 'queue' }) }).where(eq(workspaces.id, s.ws.id));
  const m0 = await s.meetings.create(orgId, { kind: 'weekly_review', unitId: root.id });
  assert.equal(await s.meetingRuntime.run(orgId, m0.id), 'postponed');
  const m = await s.meetings.get(orgId, m0.id);
  assert.equal(m.status, 'postponed');
  assert.ok(m.scheduledFor && m.scheduledFor > new Date().toISOString(), 'until the window ends');
  assert.equal((await s.audit.list(orgId, { action: 'meeting_postponed' })).length, 1);
  assert.equal(m.threadRootId, null);
  // the tick leaves it alone before its time …
  await s.meetingRuntime.tick(new Date(2026, 10, 3, 3, 3));
  await s.meetingRuntime.idle();
  assert.equal((await s.meetings.get(orgId, m0.id)).status, 'postponed');
  // … and runs it once the window is over
  await s.db.update(workspaces).set({ quietHours: '' }).where(eq(workspaces.id, s.ws.id));
  await s.meetingRuntime.tick(new Date(m.scheduledFor!));
  await s.meetingRuntime.idle();
  assert.equal((await s.meetings.get(orgId, m0.id)).status, 'done');
  // the kill switch
  const m1 = await s.meetings.create(orgId, { kind: 'retro', unitId: root.id });
  await s.runtime.pause(orgId);
  assert.equal(await s.meetingRuntime.run(orgId, m1.id), 'cancelled');
  assert.equal((await s.meetings.get(orgId, m1.id)).status, 'cancelled');
});

// ---- 8. /meeting ----

test('`/meeting <kind> [#unit] [agenda…]` by a person starts a meeting in that channel (or the named unit\'s) and wakes nobody else', async () => {
  assert.deepEqual(parseMeetingCommand('/meeting'), { kind: 'adhoc', unitSlug: null, agenda: '' });
  assert.deepEqual(parseMeetingCommand('/meeting standup #writer'), { kind: 'standup', unitSlug: 'writer', agenda: '' });
  assert.deepEqual(parseMeetingCommand('/meeting weekly-review Numbers first, then risks'), { kind: 'weekly_review', unitSlug: null, agenda: 'Numbers first, then risks' });
  assert.deepEqual(parseMeetingCommand('/meeting Ship plan @Writer'), { kind: 'adhoc', unitSlug: null, agenda: 'Ship plan @Writer' });
  assert.equal(parseMeetingCommand('a /meeting in the text'), null);
  assert.equal(parseMeetingCommand('/meetings'), null);

  const s = await setup((me, _round, _closing, _req, toolRound) => (me === 'Chief' && toolRound === 0 ? call('meeting_speak', { text: 'Chief here.' }) : say(`${me} ok`)));
  const orgId = await enable(s);
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  // a mention in the command would normally wake Writer: it does not
  const cmd = await s.groupchat.post(company.id, { text: '/meeting Ship plan @Writer', authorKind: 'human' });
  assert.ok(JSON.parse(cmd.mentions).some((x: { id: string }) => x.id === s.writer.id), 'the mention is recorded');
  await s.meetingRuntime.idle();
  await s.channelRuntime.idle();
  const replies = (await s.groupchat.messages(company.id, { thread: cmd.id })).messages.slice(1);
  assert.equal(replies.length, 0, 'no channel wake answered the command');
  const m = (await s.meetings.list(orgId))[0];
  assert.equal(m.kind, 'adhoc'); assert.equal(m.agenda, 'Ship plan @Writer'); assert.equal(m.parentChannelId, company.id, 'called in #company, run in its sub-channel');
  assert.equal(m.createdBy, 'human:single'); assert.equal(m.facilitatorAgentId, s.chief.id, 'the unit channel\'s lead facilitates');
  assert.ok(JSON.parse(m.attendees).some((a: { kind: string; id: string }) => a.kind === 'human' && a.id === 'single'), 'the caller attends');
  assert.equal(m.status, 'done');
  const msgs = await meetingStream(s, m);
  assert.match(msgs[0].text, /Ship plan @Writer/);
  assert.ok(msgs.filter((x) => x.authorKind === 'agent').length >= 4);
  // every provider call was a meeting turn, none a channel wake
  assert.ok(s.provider.requests.every((r) => /# Meeting/.test(r.system ?? '')), 'no channel wake ran');
  // a named unit routes the meeting into that unit's channel
  const a1 = await s.agents.create({ name: 'Alpha' });
  await s.org.addMember(orgId, { agentId: a1.id, reportsToAgentId: s.writer.id, scopes: [] });
  const writerUnit = (await s.units.ledBy(orgId, s.writer.id))!;
  const general = await s.groupchat.bySlug(s.ws.id, 'general');
  await s.groupchat.post(general.id, { text: '/meeting standup #writer', authorKind: 'human' });
  await s.meetingRuntime.idle();
  const standup = (await s.meetings.list(orgId)).find((x) => x.kind === 'standup')!;
  assert.equal(standup.parentChannelId, writerUnit.channelId); assert.equal(standup.unitId, writerUnit.id); assert.equal(standup.facilitatorAgentId, s.writer.id);
  assert.equal(standup.status, 'done');
  await s.groupchat.post(general.id, { text: '/meeting standup #nobody', authorKind: 'human' });
  await s.meetingRuntime.idle();
  assert.match((await s.groupchat.messages(general.id)).messages.at(-1)!.text, /Could not start the meeting: no unit #nobody/);
  // POST …/org/meetings starts one too
  const viaApi = await s.controller.startMeeting(s.ws.id, { kind: 'adhoc', unitId: writerUnit.id, agenda: 'Quick sync' });
  await s.meetingRuntime.idle();
  assert.equal((await s.meetings.get(orgId, viaApi.id)).status, 'done');
});

// ---- 9. #decision refs ----

test('#decision:<id> in a channel message resolves to the decision-log row (full id or an unambiguous prefix) and GET …/chat/decisions/:id returns it', async () => {
  assert.deepEqual(parseDecisionRefs('see #decision:abcd1234 and #decision:abcd1234, then #decision:zzzz9999.'), ['abcd1234', 'zzzz9999']);
  assert.deepEqual(parseDecisionRefs('no #decision:ab here, nor x#decision:abcd'), []);
  const s = await setup();
  const orgId = await enable(s);
  const d = await s.meetings.logDecision(orgId, { title: 'Publish on Fridays', decision: 'Weekly, Friday 09:00', decidedBy: 'user' });
  const other = await s.meetings.logDecision(orgId, { title: 'No sponsors yet', decision: 'Revisit in Q1', decidedBy: 'user' });
  const general = await s.groupchat.bySlug(s.ws.id, 'general');
  const m = await s.groupchat.post(general.id, { text: `Per #decision:${d.id.slice(0, 8)} we publish Fridays; #decision:nope-0000 is unknown`, authorKind: 'human' });
  assert.deepEqual(JSON.parse(m.mentions), [{ kind: 'decision', id: d.id }]);
  const m2 = await s.groupchat.post(general.id, { text: `Also #decision:${other.id}`, authorKind: 'human' });
  assert.deepEqual(JSON.parse(m2.mentions), [{ kind: 'decision', id: other.id }]);
  const controller = new GroupChatController(s.groupchat, s.channelRuntime, s.events, s.workspaces);
  assert.equal((await controller.decision(s.ws.id, d.id.slice(0, 8))).title, 'Publish on Fridays');
  await assert.rejects(controller.decision(s.ws.id, 'nope-0000'), /decision nope-0000/);
  assert.equal((await s.audit.list(orgId, { action: 'decision_log' })).length, 2);
  assert.equal((await s.controller.decisions(s.ws.id)).length, 2);
});

// ---- 10. org_set_cadence within and outside the bounds ----

test('org_set_cadence: the chief (any unit) and a lead (its own) change a cadence with a reason — applied within bounds in autonomous mode, audited, logged as a decision and announced; refused outside the bounds; an approval card in supervised mode', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const a1 = await s.agents.create({ name: 'Alpha' });
  await s.org.addMember(orgId, { agentId: a1.id, reportsToAgentId: s.writer.id, scopes: [] });
  const writerUnit = (await s.units.ledBy(orgId, s.writer.id))!;
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  const writerSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'writer chat' });
  const editorSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.editor.id, name: 'editor chat' });
  const names = async (sess: typeof chiefSession) => (await s.meetingRuntime.specsFor(sess)).map((t) => t.name);
  assert.deepEqual(await names(chiefSession), ['org_set_cadence']);
  assert.deepEqual(await names(writerSession), ['org_set_cadence'], 'a lead has it');
  assert.deepEqual(await names(editorSession), [], 'a plain member does not');
  assert.ok(s.meetingRuntime.owns('org_set_cadence') && s.meetingRuntime.isReadOnly('org_set_cadence'));

  // within bounds: applied
  const out = await s.meetingRuntime.execute(chiefSession, 'org_set_cadence', { kind: 'standup', cron: '0 10 * * 1-5', why: 'The team writes in the morning; meet after.' });
  assert.match(out, /Standup of .* is now on "0 10 \* \* 1-5"/);
  const standup = (await s.meetings.cadences(orgId)).find((c) => c.unitId === root.id && c.kind === 'standup')!;
  assert.equal(standup.cron, '0 10 * * 1-5'); assert.equal(standup.enabled, 1);
  const audit = await s.audit.list(orgId, { action: 'cadence_set' });
  assert.equal(audit.length, 1); assert.equal(audit[0].actor, 'chief');
  assert.match(JSON.parse(audit[0].payload).why, /writes in the morning/);
  const decisions = await s.db.select().from(orgDecisions).where(eq(orgDecisions.orgId, orgId));
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].title, /^Standup cadence of .*: 0 10 \* \* 1-5$/);
  assert.equal(decisions[0].refType, 'cadence'); assert.equal(decisions[0].refId, standup.id); assert.equal(decisions[0].decidedBy, 'chief');
  assert.match(decisions[0].alternatives, /Keep "30 9 \* \* 1-5"/);
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  assert.match((await s.groupchat.messages(company.id)).messages.at(-1)!.text, /^Cadence changed: Standup of .* → 0 10 \* \* 1-5 — The team writes in the morning/);
  // the chief names another unit; off switches a cadence off
  await s.meetingRuntime.execute(chiefSession, 'org_set_cadence', { unit: '#writer', kind: 'retro', cron: 'off', why: 'A two-agent team retros in the weekly review.' });
  assert.equal((await s.meetings.cadences(orgId)).find((c) => c.unitId === writerUnit.id && c.kind === 'retro')!.enabled, 0);
  // a lead: its own unit only
  assert.match(await s.meetingRuntime.execute(writerSession, 'org_set_cadence', { kind: 'weekly_review', cron: '0 15 * * 4', why: 'Thursdays suit the drafts.' }), /Weekly review of Writer's team is now on "0 15 \* \* 4"/);
  await assert.rejects(s.meetingRuntime.execute(writerSession, 'org_set_cadence', { unit: 'company', kind: 'standup', cron: 'off', why: 'x' }), /only your own unit/);
  await assert.rejects(s.meetingRuntime.execute(editorSession, 'org_set_cadence', { kind: 'standup', cron: 'off', why: 'x' }), /chief of staff and unit leads/);
  // a new kind for a unit that had none creates the row
  assert.match(await s.meetingRuntime.execute(chiefSession, 'org_set_cadence', { unit: 'writer', kind: 'planning', cron: '0 9 1 * *', why: 'Monthly planning.' }), /Planning of Writer's team is now on/);
  assert.equal((await s.meetings.cadences(orgId)).filter((c) => c.unitId === writerUnit.id).length, 4);

  // outside the bounds: refused with the reason, nothing changes
  await assert.rejects(s.meetingRuntime.execute(chiefSession, 'org_set_cadence', { kind: 'standup', cron: '*/5 * * * *', why: 'More is better.' }), /refused: that cadence fires more than 4 time\(s\) a day/);
  await assert.rejects(s.meetingRuntime.execute(chiefSession, 'org_set_cadence', { kind: 'standup', cron: 'hourly', why: 'x' }), /refused: cron must have five fields/);
  await assert.rejects(s.meetingRuntime.execute(chiefSession, 'org_set_cadence', { kind: 'standup', cron: '0 10 * * 1-5', why: '' }), /why is required/);
  await assert.rejects(s.meetingRuntime.execute(chiefSession, 'org_set_cadence', { kind: 'adhoc', cron: '0 10 * * 1-5', why: 'x' }), /kind must be one of/);
  // crons are server-local (cron.util.ts), so the quiet window is declared in the server's zone
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  await s.db.update(workspaces).set({ quietHours: JSON.stringify({ start: '22:00', end: '07:00', timezone: tz, policy: 'queue' }) }).where(eq(workspaces.id, s.ws.id));
  await assert.rejects(s.meetingRuntime.execute(chiefSession, 'org_set_cadence', { kind: 'standup', cron: '30 23 * * *', why: 'Night owls.' }), /refused: that cadence fires inside the workspace's quiet hours/);
  await s.db.update(workspaces).set({ quietHours: '' }).where(eq(workspaces.id, s.ws.id));
  assert.equal((await s.meetings.cadences(orgId)).find((c) => c.unitId === root.id && c.kind === 'standup')!.cron, '0 10 * * 1-5', 'unchanged by the refusals');
  assert.equal((await s.audit.list(orgId, { action: 'cadence_set' })).length, 4);

  // supervised mode: an approval card; approving applies it through the same bounds
  await s.mode.setMode(s.ws.id, { mode: 'supervised', chiefOfStaffAgentId: s.chief.id });
  const proposed = await s.meetingRuntime.execute(chiefSession, 'org_set_cadence', { kind: 'standup', cron: '0 11 * * 1-5', why: 'Later still.' });
  assert.match(proposed, /Cadence change proposed \(approval \w{8}\)/);
  const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'cadence')!;
  assert.ok(card);
  assert.equal((await s.meetings.cadences(orgId)).find((c) => c.unitId === root.id && c.kind === 'standup')!.cron, '0 10 * * 1-5', 'nothing until the CEO decides');
  const { approval, result } = await s.approvals.decide(orgId, card.id, 'approve');
  assert.equal(approval.status, 'approved');
  assert.equal((result as { cron: string }).cron, '0 11 * * 1-5');
  assert.equal((await s.meetings.cadences(orgId)).find((c) => c.unitId === root.id && c.kind === 'standup')!.cron, '0 11 * * 1-5');
  const last = (await s.db.select().from(orgDecisions).where(eq(orgDecisions.orgId, orgId))).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).at(-1)!;
  assert.equal(last.approvalId, card.id);
  assert.equal(last.decidedBy, 'user');
});

// ---- 11. the operating profile reaches the prompt ----

test('the organization\'s operating profile (values, culture, vision) is read defensively and reaches every meeting prompt; a company without one gets no section', async () => {
  assert.equal(operatingProfile({ name: 'x' }), '');
  assert.equal(operatingProfile(null), '');
  assert.match(operatingProfile({ mission: 'A newsletter people pay for.', culture: 'Terse. Decide fast, review strictly.' }), /^Operating profile \(run this meeting in the company's style\):\nMission: A newsletter people pay for\.\nCulture: Terse\. Decide fast, review strictly\.$/);
  assert.match(operatingProfile({ mission: 'M', values: 'Honesty' }, { title: 'V' }), /Vision: V\nValues: Honesty/);
  const s = await setup();
  const orgId = await enable(s);
  await s.db.update(organizations).set({ values: 'Readers first; never pad.', culture: 'Terse meetings; one risk per person.' }).where(eq(organizations.id, orgId));
  const root = await s.units.rootUnit(orgId);
  const m0 = await s.meetingRuntime.start(orgId, { kind: 'weekly_review', unitId: root.id });
  await s.meetingRuntime.idle();
  assert.equal((await s.meetings.get(orgId, m0.id)).status, 'done');
  assert.ok(s.provider.requests.length >= 4);
  for (const r of s.provider.requests) {
    assert.match(r.system ?? '', /# Meeting[\s\S]*Operating profile \(run this meeting in the company's style\):\nValues: Readers first; never pad\.\nCulture: Terse meetings; one risk per person\.\n\nAgenda:/);
  }
  // with a vision (item 18) the profile leads with it
  assert.match(operatingProfile({ mission: 'M', culture: 'C' }, { title: 'A newsletter 10k people pay for', dueAt: '2027-06-30' }), /^Operating profile[^\n]*\nVision: A newsletter 10k people pay for \(by 2027-06-30\)\nCulture: C$/);
  // without a profile: no section
  const s2 = await setup();
  const orgId2 = await enable(s2);
  await s2.meetingRuntime.start(orgId2, { kind: 'adhoc', unitId: (await s2.units.rootUnit(orgId2)).id, attendees: [{ kind: 'agent', id: s2.chief.id }] });
  await s2.meetingRuntime.idle();
  assert.ok(s2.provider.requests.length > 0);
  assert.ok(s2.provider.requests.every((r) => !/Operating profile/.test(r.system ?? '')));
});
