/** The meeting room (docs/meetings.md "During", "Before", "After";
 *  docs/group-chat.md §8): `meeting_pass` and selective rounds; people who
 *  joined are heard at the next turn; the facilitator parks points and moves
 *  the agenda on, items are time-boxed; Extend / Skip item / End; inline
 *  verdicts on proposals and answers to questions; the pre-read, agenda
 *  proposals, the reminder; auto-skip of an empty ritual and its empty
 *  streak; open items first; tokens and USD per meeting; live room events. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { orgCadences } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub } from './helpers';
import { ChatsRepository, type ChatSession } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { GroupChatService, COMPANY_SLUG } from '../server/src/groupchat/groupchat.service';
import { WorkspaceEventBus, type WorkspaceEvent } from '../server/src/groupchat/workspace-events';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgMeetingsService, parseMinutes } from '../server/src/org/org-meetings.service';
import { OrgMeetingRuntime } from '../server/src/org/org-meeting-runtime.service';
import { MeetingsCalendarService } from '../server/src/org/meetings-calendar';
import { agendaItems, agendaIsEmpty, bulletItems, classifyOpenItem, hasOpenThread, parseRoom, OPEN_ITEMS_TITLE } from '../server/src/org/meeting-room';
import { deriveMeetingTunables } from '../server/src/org/meeting-tunables';
import { renderMinutesMarkdown } from '../server/src/org/meeting-minutes.service';
import { currentAccountId } from '../server/src/accounts/account-context';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const whoAmI = (req: AiRequest): string => /You are ([^,]+), in the /.exec(req.system ?? '')?.[1]?.trim() ?? 'agent';
const isClosing = (req: AiRequest): boolean => /closing turn\)/.test(req.system ?? '');
const roundOf = (req: AiRequest): number => Number(/\(round (\d) of/.exec(req.system ?? '')?.[1] ?? 0);
const lastUser = (req: AiRequest): string => [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

type Plan = (me: string, round: number, closing: boolean, req: AiRequest, toolRound: number) => AiStreamEvent[] | Promise<AiStreamEvent[]>;

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

async function setup(plan: Plan = () => say('ok')) {
  const db = await testDb();
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
  const events = new WorkspaceEventBus();
  const groupchat = new GroupChatService(db, workspaces, agents, stub, events, config, undefined, bus, org, tasks, announcer, meetingRuntime);
  const calendar = new MeetingsCalendarService(db, org, units, meetings, agents, workspaces);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit.' });
  const st = await mode.setMode(ws.id, { mode: 'autonomous', chiefOfStaffAgentId: chief.id, monthlyUsd: 50, agentCap: 10 });
  const orgId = st.orgId!;
  const root = await units.rootUnit(orgId);
  const company = await groupchat.bySlug(ws.id, COMPANY_SLUG);
  return { db, agents, workspaces, repo, audit, org, units, tasks, meetings, brief, runtime, meetingRuntime, groupchat, events, calendar, provider, ws, chief, writer, editor, orgId, root, company };
}
type S = Awaited<ReturnType<typeof setup>>;

/** A meeting's stream: its sub-channel (docs/group-chat.md §9) from the agenda
 *  on, without the closing line the sub-channel gets when the meeting ends. */
const thread = async (s: S, m: { channelId: string | null; threadRootId: string | null }) => {
  const all = (await s.groupchat.stream(m.channelId!)).filter((x) => !(x.authorKind === 'system' && /^Closed/.test(x.text)));
  return all.slice(Math.max(0, all.findIndex((x) => x.id === m.threadRootId)));
};
const latest = async (s: S) => (await s.meetings.list(s.orgId))[0];
const owner = () => ({ id: currentAccountId() });

// ---- pure helpers ----

test('room helpers: bullet agenda items, open items first, proposals last; empty agendas; open threads; open-item states; the profile shapes the tunables', () => {
  assert.deepEqual(bulletItems('Intro\n- Pricing\n* Hiring\n1. Launch date\n2) Risks'), ['Pricing', 'Hiring', 'Launch date', 'Risks']);
  const items = agendaItems('weekly_review', '', 2, [{ text: 'Sponsors', why: '', byKind: 'agent', by: 'a', at: '' }]);
  assert.equal(items[0], OPEN_ITEMS_TITLE);
  assert.equal(items.at(-1), 'Sponsors');
  assert.deepEqual(agendaItems('adhoc', 'Talk about the launch', 0, []), ['Talk about the launch']);
  const zero = { deltas: 0, blocked: 0, checkIns: 0, atRisk: 0 };
  assert.equal(agendaIsEmpty(zero, [], []), true);
  assert.equal(agendaIsEmpty(zero, [{ title: 'x', owner: 'W', taskId: null, state: 'done', status: 'done', due: null }], []), true, 'only done items: nothing open');
  assert.equal(agendaIsEmpty({ ...zero, blocked: 1 }, [], []), false);
  assert.equal(agendaIsEmpty(zero, [{ title: 'x', owner: 'W', taskId: null, state: 'late', status: 'todo', due: null }], []), false);
  assert.equal(classifyOpenItem({ status: 'todo', updatedAt: '2026-01-01T00:00:00Z' }, '2026-01-02T00:00:00Z'), 'late', 'not moved since');
  assert.equal(classifyOpenItem({ status: 'in_progress', updatedAt: '2026-01-03T00:00:00Z' }, '2026-01-02T00:00:00Z'), 'open');
  assert.equal(classifyOpenItem({ status: 'in_progress', updatedAt: '2026-01-03T00:00:00Z', dueAt: '2026-01-04T00:00:00Z' }, '2026-01-02T00:00:00Z', new Date('2026-01-05T00:00:00Z')), 'late', 'past due');
  assert.equal(classifyOpenItem({ status: 'blocked', updatedAt: '' }, ''), 'blocked');
  const minutes = { summary: '', decisions: [], actions: [{ title: 'Draft', owner: 'Writer', done_when: 'x', outcome: '', by: 'ed' }], risks: [], questions: [] };
  const t = [{ authorKind: 'agent', authorId: 'chief', text: 'Editor, can you review?', createdAt: '2026-01-02' }];
  assert.equal(hasOpenThread({ agentId: 'ed', name: 'Editor', since: '2026-01-01', thread: t, minutes, answers: {}, actionsSince: 1 }), true, 'named');
  assert.equal(hasOpenThread({ agentId: 'ed', name: 'Editor', since: '2026-01-03', thread: t, minutes, answers: {}, actionsSince: 1 }), false, 'named before its last turn');
  assert.equal(hasOpenThread({ agentId: 'wr', name: 'Writer', since: '2026-01-03', thread: [], minutes, answers: {}, actionsSince: 0 }), true, 'given an action by someone else');
  assert.equal(hasOpenThread({ agentId: 'wr', name: 'Writer', since: '2026-01-03', thread: [], minutes, answers: {}, actionsSince: 1 }), false);
  assert.equal(parseRoom('nonsense').items.length, 0);
  const fast = deriveMeetingTunables({ stage: 'early', cultureType: 'adhocracy', speed: true, rigor: false, writing: false });
  const formal = deriveMeetingTunables({ stage: 'scale', cultureType: 'hierarchy', speed: false, rigor: true, writing: true });
  const v = (list: typeof fast, k: string) => list.find((x) => x.key === k)!.value;
  assert.equal(v(fast, 'meeting.itemMinutes'), 5); assert.equal(v(formal, 'meeting.itemMinutes'), 15);
  assert.equal(v(fast, 'meeting.extendRounds'), 0); assert.equal(v(formal, 'meeting.autoSkip'), 0);
  assert.equal(v(deriveMeetingTunables({ stage: 'growth', cultureType: 'clan', speed: false, rigor: false, writing: false }), 'meeting.selectiveRounds'), 0);
});

// ---- 1. pass, selective rounds, cost, live events ----

test('meeting_pass posts nothing and shows in the room; rounds after the first hear only the facilitator and attendees with an open thread; a round where everyone passes ends the rounds; tokens and USD are kept per meeting; the reply streams into the room', async () => {
  const s = await setup((me, round, closing, _req, toolRound) => {
    if (closing) return toolRound === 0 ? call('meeting_close', { summary: 'Writer drafts.' }) : say('Closed.');
    if (toolRound > 0) return say('');
    if (round === 1 && me === 'Writer') return call('meeting_pass', { reason: 'nothing yet' });
    if (round === 1 && me === 'Editor') return say('The style guide is ready.');
    if (round === 1 && me === 'Chief') return call('meeting_speak', { text: 'Writer, can you take the first draft?' });
    return call('meeting_pass', {});
  });
  const seen: WorkspaceEvent[] = [];
  s.events.subscribe(s.ws.id, (ev) => seen.push(ev));
  await s.meetingRuntime.start(s.orgId, { kind: 'planning', unitId: s.root.id, agenda: 'Plan issue 1.', createdBy: 'user' });
  await s.meetingRuntime.idle();
  const m = await latest(s);
  assert.equal(m.status, 'done');
  const msgs = await thread(s, m);
  assert.ok(!msgs.some((x) => x.authorKind === 'agent' && x.authorId === s.writer.id), 'a pass is not a message');
  assert.ok(msgs.some((x) => x.authorKind === 'system' && /Everyone passed in round 2/.test(x.text)));
  // round 2: Writer (named by the facilitator) and Chief; Editor had no open thread
  const r2 = s.provider.requests.filter((r) => roundOf(r) === 2 && !isClosing(r)).map(whoAmI);
  assert.deepEqual([...new Set(r2)].sort(), ['Chief', 'Writer']);
  const room = parseRoom(m.room);
  assert.deepEqual(room.passes.map((p) => `${p.round}:${p.agentId === s.writer.id ? 'Writer' : p.agentId === s.chief.id ? 'Chief' : 'Editor'}`), ['1:Writer', '2:Writer', '2:Chief']);
  assert.equal(room.attendance[s.editor.id], 'idle');
  assert.equal(m.rounds, 2);
  assert.equal(parseMinutes(m.minutes).endedBy, 'closed', 'everyone passed → the facilitator still closes');
  // cost: every model call's usage, in tokens and USD
  const calls = s.provider.requests.length;
  assert.equal(m.tokensIn, 100 * calls); assert.equal(m.tokensOut, 50 * calls);
  assert.ok(m.usd > 0);
  const minutesMsg = msgs.at(-1)!;
  assert.match(minutesMsg.text, new RegExp(`${(150 * calls).toLocaleString('en-US')} tokens`));
  const cal = await s.calendar.list(s.ws.id);
  assert.equal(cal.meetings.find((x) => x.meetingId === m.id)!.tokensIn, 100 * calls);
  // live: the speaker's reply streamed into the thread; the room announced its changes
  assert.ok(seen.some((ev) => ev.type === 'channel_stream' && ev.channelId === m.channelId && ev.agentId === s.editor.id && /style guide/.test(ev.delta)));
  assert.ok(seen.some((ev) => ev.type === 'channel_typing' && ev.channelId === m.channelId && ev.on));
  assert.ok(seen.filter((ev) => ev.type === 'meeting_update' && ev.meetingId === m.id).length >= 4);
  const round2 = (await s.audit.list(s.orgId, { action: 'meeting_round' })).map((r) => JSON.parse(r.payload)).find((p) => p.round === 2);
  assert.equal(round2.speakers, 2); assert.equal(round2.passes, 2);
});

// ---- 2. people in the room ----

test('a person who joined is heard by the next speaker in the same round; a person who did not join is heard at the next round', async () => {
  const heard: string[] = [];
  const s: S = await setup(async (me, round, closing, req, toolRound) => {
    if (closing || toolRound > 0) return say('ok');
    const u = lastUser(req);
    heard.push(`${me}:${round}:${u.includes('Joined voice') ? 'J' : ''}${u.includes('Lurker voice') ? 'L' : ''}`);
    if (me === 'Writer' && round === 1) {
      const m = await latest(s);
      // the meeting's sub-channel (docs/group-chat.md §9): people write at its top level
      await s.groupchat.post(m.channelId!, { text: 'Joined voice: ship Thursday.', authorKind: 'human', authorId: currentAccountId() });
      await s.groupchat.post(m.channelId!, { text: 'Lurker voice: or Friday.', authorKind: 'human', authorId: 'lurker-1' });
    }
    return say(`${me} r${round}`);
  });
  await s.org.setTunable(s.orgId, 'meeting.selectiveRounds', 0);
  await s.org.setTunable(s.orgId, 'meeting.roundCap', 2);
  const m0 = await s.meetings.create(s.orgId, { kind: 'weekly_review', unitId: s.root.id, createdBy: 'user' });
  await s.meetingRuntime.join(s.orgId, m0.id, owner());
  assert.deepEqual(parseRoom((await s.meetings.get(s.orgId, m0.id)).room).present, [currentAccountId()]);
  await s.meetingRuntime.run(s.orgId, m0.id);
  assert.ok(heard.includes('Writer:1:'), heard.join(' '));
  assert.ok(heard.includes('Editor:1:J'), `the next speaker hears the present person: ${heard.join(' ')}`);
  assert.ok(heard.includes('Chief:1:J'));
  assert.ok(heard.includes('Writer:2:L') && heard.includes('Editor:2:L'), `the lurker is heard at the next round: ${heard.join(' ')}`);
  assert.ok(!heard.some((h) => h.startsWith('Writer:2') && h.includes('J')), 'the present person is not repeated');
});

// ---- 3. the facilitator's tools, the time box, the controls ----

test('the facilitator parks a point (minutes and a backlog task) and moves the agenda on; Extend adds a round, Skip item moves on, End closes it — only the CEO or the starter steer', async () => {
  let steered = false;
  const s: S = await setup(async (me, round, closing, _req, toolRound) => {
    if (closing) return toolRound === 0 ? call('meeting_close', { summary: 'Done.' }) : say('Closed.');
    if (me === 'Chief' && round === 1) {
      if (toolRound === 0) return call('meeting_park', { text: 'Rebrand the newsletter' });
      if (toolRound === 1) return call('meeting_next_item', { why: 'settled' });
      return say('');
    }
    if (me === 'Writer' && round === 1 && toolRound === 0 && !steered) {
      steered = true;
      const m = await latest(s);
      await assert.rejects(s.meetingRuntime.control(s.orgId, m.id, { id: 'stranger' }, 'extend'), /only the CEO or the person who started/);
      const ext = await s.meetingRuntime.control(s.orgId, m.id, owner(), 'extend');
      assert.equal(parseRoom(ext.room).roundCap, 3);
      await assert.rejects(s.meetingRuntime.control(s.orgId, m.id, owner(), 'extend'), /meeting\.extendRounds is 1/);
    }
    if (me === 'Editor' && round === 2 && toolRound === 0) {
      const m = await latest(s);
      await s.meetingRuntime.control(s.orgId, m.id, owner(), 'end');
    }
    return say(`${me} r${round}`);
  });
  await s.org.setTunable(s.orgId, 'meeting.selectiveRounds', 0);
  await s.org.setTunable(s.orgId, 'meeting.roundCap', 2);
  const m0 = await s.meetingRuntime.start(s.orgId, { kind: 'adhoc', unitId: s.root.id, agenda: '- Pricing\n- Hiring\n- Launch date', createdBy: 'user' });
  await s.meetingRuntime.idle();
  const m = await s.meetings.get(s.orgId, m0.id);
  const room = parseRoom(m.room);
  assert.deepEqual(room.items, ['Pricing', 'Hiring', 'Launch date']);
  assert.equal(room.current, 1, 'the facilitator settled the first item');
  assert.equal(room.extended, 1);
  const minutes = parseMinutes(m.minutes);
  assert.equal(minutes.endedBy, 'closed', 'End lets the facilitator close');
  assert.equal(minutes.parked!.length, 1);
  const parked = await s.tasks.get(s.orgId, minutes.parked![0].taskId!);
  assert.equal(parked.title, 'Parked: Rebrand the newsletter'); assert.equal(parked.status, 'backlog'); assert.equal(parked.assigneeAgentId, null);
  const msgs = await thread(s, m);
  assert.ok(msgs.some((x) => /Settled: "Pricing"\. Now item 2 of 3: Hiring/.test(x.text)));
  assert.ok(msgs.some((x) => /extended the meeting by one round/.test(x.text)));
  assert.ok(msgs.some((x) => /is ending the meeting/.test(x.text)));
  assert.ok(msgs.some((x) => x.authorKind === 'system' && /Meeting ended by/.test(x.text)));
  assert.match(msgs.at(-1)!.text, /Parking lot \(1\)\n- Rebrand the newsletter · backlog/);
  assert.equal(m.rounds, 2, 'ended in round 2 although extended to 3');
  assert.ok((await s.audit.list(s.orgId, { action: 'meeting_control' })).length === 2);
  await assert.rejects(s.meetingRuntime.control(s.orgId, m.id, owner(), 'skip'), /the meeting is done/);
});

test('Skip item and the per-item time box move the agenda on; when the agenda is done the rounds end and the facilitator closes', async () => {
  let skipped = false;
  const s: S = await setup(async (me, round, closing, _req, toolRound) => {
    if (closing) return toolRound === 0 ? call('meeting_close', { summary: 'Done.' }) : say('Closed.');
    if (me === 'Writer' && round === 1 && !skipped) {
      skipped = true;
      await s.meetingRuntime.control(s.orgId, (await latest(s)).id, owner(), 'skip');
    }
    return say(`${me} r${round}`);
  });
  await s.org.setTunable(s.orgId, 'meeting.selectiveRounds', 0);
  await s.org.setTunable(s.orgId, 'meeting.itemMinutes', 2);
  let t = Date.now();
  s.meetingRuntime.now = () => new Date((t += 30_000));
  await s.meetingRuntime.start(s.orgId, { kind: 'adhoc', unitId: s.root.id, agenda: '- One\n- Two\n- Three', createdBy: 'user' });
  await s.meetingRuntime.idle();
  const m = await latest(s);
  const msgs = await thread(s, m);
  assert.ok(msgs.some((x) => /Skipped: "One"/.test(x.text)), 'Skip item');
  assert.ok(msgs.some((x) => /Time is up \(2 min\)/.test(x.text)), 'the time box');
  assert.ok(msgs.some((x) => /The agenda is done\./.test(x.text)));
  const room = parseRoom(m.room);
  assert.equal(room.current, 3);
  assert.equal(parseMinutes(m.minutes).endedBy, 'closed');
  assert.ok(m.rounds < 3, `the agenda ran out before the rounds: ${m.rounds}`);
});

// ---- 4. inline verdicts and answers ----

test('people approve or reject proposed decisions and actions in the room and answer questions where they were asked: a rejected decision is not logged, an approved action becomes a task, an answered question skips the brief and reopens its asker\'s thread', async () => {
  let ruled = false;
  const s: S = await setup(async (me, round, closing, _req, toolRound) => {
    if (closing) return toolRound === 0 ? call('meeting_close', { summary: 'Done.' }) : say('Closed.');
    if (toolRound > 0) return say('');
    if (me === 'Editor' && round === 1) return [...call('meeting_propose_decision', { title: 'Biweekly', decision: 'Publish every other week' }), ...call('meeting_propose_action', { title: 'Collect sources', owner: 'Writer', done_when: 'Three sources', due: '2026-12-01' })];
    if (me === 'Writer' && round === 1) return call('meeting_ask_ceo', { question: 'Do we take sponsors?' });
    if (me === 'Chief' && round === 1 && !ruled) {
      ruled = true;
      const m = await latest(s);
      const live = parseMinutes(m.minutes);
      const msgs = await thread(s, m);
      assert.equal(msgs.find((x) => /^Decision proposed: Biweekly/.test(x.text))!.id, live.decisions[0].messageId, 'proposals carry their message for the inline buttons');
      await assert.rejects(s.meetingRuntime.verdict(s.orgId, m.id, { id: 'stranger' }, { kind: 'decision', index: 0, verdict: 'reject' }), /rule on its proposals/);
      await s.meetingRuntime.verdict(s.orgId, m.id, owner(), { kind: 'decision', index: 0, verdict: 'reject', note: 'weekly stays' });
      await s.meetingRuntime.verdict(s.orgId, m.id, owner(), { kind: 'action', index: 0, verdict: 'approve' });
      await assert.rejects(s.meetingRuntime.verdict(s.orgId, m.id, owner(), { kind: 'action', index: 5, verdict: 'approve' }), /no proposed action #5/);
      await s.meetingRuntime.answer(s.orgId, m.id, owner(), { index: 0, answer: 'Not this year.' });
    }
    return say(`${me} r${round}`);
  });
  await s.meetingRuntime.start(s.orgId, { kind: 'planning', unitId: s.root.id, agenda: 'Plan.', createdBy: 'user' });
  await s.meetingRuntime.idle();
  const m = await latest(s);
  const minutes = parseMinutes(m.minutes);
  assert.equal(minutes.decisions[0].verdict, 'rejected');
  assert.equal(minutes.decisions[0].decisionId, undefined, 'a rejected decision is not logged');
  assert.equal((await s.meetings.decisions(s.orgId)).filter((d) => d.meetingId === m.id).length, 0);
  assert.equal(minutes.actions[0].verdict, 'approved');
  const task = await s.tasks.get(s.orgId, minutes.actions[0].taskId!);
  assert.equal(task.title, 'Collect sources');
  assert.equal(task.dueAt, new Date('2026-12-01').toISOString(), 'the due date reaches the task');
  assert.equal(minutes.questions[0].answer, 'Not this year.');
  assert.equal((await s.meetings.openQuestions(s.orgId)).length, 0, 'answered: not for the brief');
  const msgs = await thread(s, m);
  assert.ok(msgs.some((x) => x.authorKind === 'human' && /^Answer to "Do we take sponsors\?": Not this year\./.test(x.text)));
  assert.ok(msgs.some((x) => x.authorKind === 'system' && /rejected the decision "Biweekly" — weekly stays/.test(x.text)));
  assert.match(msgs.at(-1)!.text, /Biweekly: Publish every other week · rejected by/);
  // the asker had an open thread in round 2 (its question was answered); the decision's proposer did not
  const r2 = new Set(s.provider.requests.filter((r) => roundOf(r) === 2 && !isClosing(r)).map(whoAmI));
  assert.ok(r2.has('Writer') && r2.has('Chief'));
  assert.ok(!r2.has('Editor'));
  await assert.rejects(s.meetingRuntime.verdict(s.orgId, m.id, owner(), { kind: 'action', index: 0, verdict: 'reject' }), /already executed/);
  // the minutes document shows the verdicts and the due date
  const md = renderMinutesMarkdown({
    meeting: { ...m, tokensIn: m.tokensIn, tokensOut: m.tokensOut }, minutes, unit: null, channelSlug: 'company', facilitator: 'Chief', agents: [], people: [], discussion: [], nextMeeting: null, source: 'record', workspaceId: s.ws.id, names: () => 'X',
  });
  assert.match(md, /\| Collect sources \(approved by .*\) \| Writer \| 2026-12-01 \|/);
  assert.match(md, /Biweekly\*\* — Publish every other week _\(rejected — not logged\)_/);
  assert.match(md, /answered: Not this year\./);
  assert.match(md, /tokens \(\d[\d,]* in, \d[\d,]* out\)/);
});

// ---- 5. before: preparation, proposals, reminder; auto-skip and the empty streak ----

test('a ritual is prepared ahead (pre-read, open for agenda proposals by attendees and people), people get a "starts in N min · Join" reminder, the proposals make the agenda; an empty ritual skips itself without a model call and its empty streak reaches the chief', async () => {
  const s = await setup(() => say('ok'));
  // only the company's weekly review, Fridays 16:00
  const cadences = await s.meetings.cadences(s.orgId);
  for (const c of cadences) if (!(c.kind === 'weekly_review' && c.unitId === s.root.id)) await s.meetings.updateCadence(s.orgId, c.id, { enabled: false });
  const weekly = cadences.find((c) => c.kind === 'weekly_review' && c.unitId === s.root.id)!;
  const F = new Date(2026, 10, 6, 16, 0); // Friday 16:00, server-local
  await s.db.update(orgCadences).set({ nextRunAt: F.toISOString() }).where(eq(orgCadences.id, weekly.id));
  await s.org.setTunable(s.orgId, 'chief.sunsetEmptyCycles', 2);
  const at = (d: Date) => { s.meetingRuntime.now = () => d; return d; };

  // T−60 min: prepared
  await s.meetingRuntime.tick(at(new Date(F.getTime() - 60 * 60_000)));
  const prepared = await latest(s);
  assert.equal(prepared.status, 'scheduled'); assert.equal(prepared.createdBy, 'cadence'); assert.equal(prepared.scheduledFor, F.toISOString());
  assert.match(parseRoom(prepared.room).preRead, /^\*\*Pre-read\*\*/);
  assert.equal((await s.audit.list(s.orgId, { action: 'meeting_prepared' })).length, 1);
  const cal = await s.calendar.list(s.ws.id, { from: new Date(F.getTime() - 86_400_000).toISOString(), to: new Date(F.getTime() + 86_400_000).toISOString() });
  assert.equal(cal.meetings.filter((x) => x.kind === 'weekly_review').length, 1, 'the prepared meeting stands for the cadence occurrence');
  // an attendee proposes an item (its tool appears only while the window is open), a person too
  const session = { id: 'sess-w', agentId: s.writer.id } as unknown as ChatSession;
  assert.ok((await s.meetingRuntime.specsFor(session)).some((t) => t.name === 'meeting_propose_agenda'));
  assert.match((await s.meetingRuntime.contextFor(session))!, /Meetings open for agenda proposals/);
  assert.match(await s.meetingRuntime.execute(session, 'meeting_propose_agenda', { item: 'Sponsorship policy', why: 'two offers came in' }), /Proposed for the agenda/);
  await s.meetingRuntime.proposeAgenda(s.orgId, prepared.id, { kind: 'human', id: currentAccountId() }, { text: 'Hiring an illustrator' });
  await assert.rejects(s.meetingRuntime.proposeAgenda(s.orgId, prepared.id, { kind: 'human', id: currentAccountId() }, { text: 'hiring an illustrator' }), /already proposed/);
  // T−5 min: the reminder, once
  await s.meetingRuntime.tick(at(new Date(F.getTime() - 5 * 60_000)));
  await s.meetingRuntime.tick(at(new Date(F.getTime() - 4 * 60_000)));
  const reminders = (await s.agents.listEvents(`channel:${s.company.id}`, 50)).filter((e) => e.kind === 'meeting' && /starts in \d+ min · Join/.test(e.title));
  assert.equal(reminders.length, 1);
  assert.equal(JSON.parse(reminders[0].payload).action, 'join');
  // T: it runs with the proposals on the agenda
  await s.meetingRuntime.tick(at(F));
  await s.meetingRuntime.idle();
  const held = await s.meetings.get(s.orgId, prepared.id);
  assert.equal(held.status, 'done');
  const root = (await thread(s, held))[0].text;
  assert.match(root, /\*\*Proposed by attendees:\*\*\n- Sponsorship policy — two offers came in \(Writer\)\n- Hiring an illustrator/);
  assert.match(root, /\*\*Pre-read\*\*/);
  assert.deepEqual(parseRoom(held.room).items.slice(-2), ['Sponsorship policy', 'Hiring an illustrator']);
  await assert.rejects(s.meetingRuntime.proposeAgenda(s.orgId, held.id, { kind: 'human', id: currentAccountId() }, { text: 'Late item' }), /close when the meeting starts/);

  // the next two Fridays: nothing moved, nothing open, nothing proposed → skipped, no model call
  const calls = s.provider.requests.length;
  for (const week of [1, 2]) {
    const Fw = new Date(F.getTime() + week * 7 * 86_400_000);
    await s.db.update(orgCadences).set({ nextRunAt: Fw.toISOString() }).where(eq(orgCadences.id, weekly.id));
    await s.meetingRuntime.tick(at(new Date(Fw.getTime() - 30 * 60_000)));
    await s.meetingRuntime.tick(at(Fw));
    await s.meetingRuntime.idle();
  }
  assert.equal(s.provider.requests.length, calls, 'no model spend on a skipped ritual');
  const skipped = (await s.meetings.list(s.orgId)).filter((x) => x.status === 'skipped');
  assert.equal(skipped.length, 2);
  assert.equal(parseMinutes(skipped[0].minutes).endedBy, 'skipped');
  const lines = (await s.groupchat.messages(s.company.id)).messages.filter((x) => /skipped itself/.test(x.text));
  assert.equal(lines.length, 2);
  // the meeting held first produced no decision or action either: it counts
  assert.match(lines[0].text, /2 empty cycles in a row — up for the ritual-retirement review/);
  assert.match(lines[1].text, /3 empty cycles in a row/);
  assert.equal(await s.meetings.emptyStreak(s.orgId, s.root.id, 'weekly_review'), 3);
  const chiefInfo = (await s.agents.listEvents(s.chief.id, 50)).find((e) => /Ritual up for retirement review/.test(e.title));
  assert.ok(chiefInfo);
  assert.equal((await s.audit.list(s.orgId, { action: 'meeting_auto_skipped' })).length, 2);
});

// ---- 6. after: open items first ----

test('each ritual opens with the previous meeting\'s action items — done, late (past due or not moved), blocked, open — from the board tasks they became', async () => {
  const s = await setup((me, round, closing, _req, toolRound) => {
    if (closing || toolRound > 0 || round > 1) return say('ok');
    if (me === 'Writer') return [...call('meeting_propose_action', { title: 'Draft issue 1', owner: 'Writer', done_when: 'Accepted', due: '2026-01-01' }), ...call('meeting_propose_action', { title: 'Collect sources', owner: 'Writer', done_when: 'Three' })];
    if (me === 'Editor') return call('meeting_propose_action', { title: 'Style guide', owner: 'Editor', done_when: 'Published' });
    return say('ok');
  });
  await s.org.setTunable(s.orgId, 'meeting.roundCap', 1);
  await s.meetingRuntime.start(s.orgId, { kind: 'weekly_review', unitId: s.root.id, createdBy: 'user' });
  await s.meetingRuntime.idle();
  const first = await latest(s);
  const acts = parseMinutes(first.minutes).actions;
  assert.equal(acts.length, 3);
  await s.tasks.update(s.orgId, acts[1].taskId!, { status: 'done' });
  await s.tasks.update(s.orgId, acts[2].taskId!, { status: 'blocked', blockers: ['no examples'] });
  s.provider.plan = () => say('ok');
  await s.meetingRuntime.start(s.orgId, { kind: 'weekly_review', unitId: s.root.id, createdBy: 'user' });
  await s.meetingRuntime.idle();
  const second = (await s.meetings.list(s.orgId)).find((x) => x.id !== first.id)!;
  const room = parseRoom(second.room);
  assert.deepEqual(room.openItems.map((i) => `${i.title}:${i.state}`), ['Draft issue 1:late', 'Collect sources:done', 'Style guide:blocked']);
  assert.equal(room.openItems[0].due, new Date('2026-01-01').toISOString());
  assert.equal(room.items[0], OPEN_ITEMS_TITLE);
  const root = (await thread(s, second))[0].text;
  const agendaStart = root.indexOf('**Open items from the last meeting**');
  assert.ok(agendaStart > 0 && agendaStart < root.indexOf('Weekly review for'), 'open items come before the agenda');
  assert.match(root, /- Style guide — Editor: blocked[\s\S]*- Draft issue 1 — Writer: late \(due 2026-01-01\)[\s\S]*- Collect sources — Writer: done/);
});
