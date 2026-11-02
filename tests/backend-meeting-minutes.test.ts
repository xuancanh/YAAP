/** Minutes at the end of every meeting and the meetings calendar
 *  (docs/meetings.md): a markdown document written through WorkspaceFs —
 *  `/org/meetings/<unit>/<yyyy>/<day>-<kind>.md` for a unit's ritual,
 *  `/channels/<slug>/meetings/<day>-<title>.md` for a `/meeting` in an
 *  ordinary channel — authored by the facilitator; the summary is the
 *  facilitator's closing note, else one bounded call on its model, else
 *  composed from the record; the meeting row keeps the path and the summary;
 *  the channel gets a "Minutes: <path>" line. GET …/meetings lists past
 *  meetings and the cadences' upcoming occurrences, by unit, channel and range. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { GroupChatService, COMPANY_SLUG } from '../server/src/groupchat/groupchat.service';
import { WorkspaceEventBus } from '../server/src/groupchat/workspace-events';
import { WorkspaceFs } from '../server/src/files/workspace-fs.service';
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
import { orgPath } from '../server/src/files/layout';
import { OrgMeetingRuntime, adhocTitle } from '../server/src/org/org-meeting-runtime.service';
import { OrgMeetingMinutesService, MINUTES_MAX_TOKENS, localDay, minutesPathFor, parseNarrative, recordDiscussion, withSuffix } from '../server/src/org/meeting-minutes.service';
import { MeetingsCalendarService, WorkspaceMeetingsController, expandCron, retroGap } from '../server/src/org/meetings-calendar';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const whoAmI = (req: AiRequest): string => /You are ([^,]+), in the /.exec(req.system ?? '')?.[1]?.trim() ?? 'agent';
const isClosing = (req: AiRequest): boolean => /closing turn\)/.test(req.system ?? '');
const roundOf = (req: AiRequest): number => Number(/\(round (\d) of/.exec(req.system ?? '')?.[1] ?? 0);
const isMinutesCall = (req: AiRequest): boolean => /^You write the minutes of a meeting/.test(req.system ?? '');

type Plan = (me: string, round: number, closing: boolean, req: AiRequest, toolRound: number) => AiStreamEvent[] | Promise<AiStreamEvent[]>;

class MeetingProvider implements AiProvider {
  readonly name = 'scripted';
  readonly requests: AiRequest[] = [];
  /** What the minutes call answers: text, or throw. */
  minutes: (req: AiRequest) => string = () => JSON.stringify({ summary: 'The model summary: Writer drafts, Editor reviews.', discussion: ['Writer is blocked on the style guide.', 'Editor will unblock today.'] });
  constructor(public plan: Plan) {}
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    if (isMinutesCall(req)) {
      yield { type: 'answer', text: this.minutes(req) };
      yield { type: 'usage', inputTokens: 300, outputTokens: 80 };
      yield { type: 'done' };
      return;
    }
    const toolRound = req.messages.filter((m) => m.role === 'tool').length;
    for (const ev of await this.plan(whoAmI(req), roundOf(req), isClosing(req), req, toolRound)) yield ev;
    yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
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
  const ctx = ctxStub(provider);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctx, skillsStub(), stub, mcpStub(), agents, workspaces);
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
  const events = new WorkspaceEventBus();
  const fs = new WorkspaceFs(stub, db, events);
  const minutesDocs = new OrgMeetingMinutesService(db, meetings, agents, runtime, fs, ctx);
  const meetingRuntime = new OrgMeetingRuntime(db, meetings, org, units, audit, agents, workspaces, turns, repo, runtime, config, announcer, approvals, undefined, undefined, undefined, minutesDocs);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const groupchat = new GroupChatService(db, workspaces, agents, stub, events, config, undefined, bus, org, tasks, announcer, meetingRuntime);
  const calendar = new MeetingsCalendarService(db, org, units, meetings, agents, workspaces);
  const controller = new WorkspaceMeetingsController(config, calendar);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit.' });
  return { db, agents, workspaces, org, units, tasks, meetings, runtime, meetingRuntime, minutesDocs, mode, groupchat, calendar, controller, fs, provider, ws, chief, writer, editor };
}
type S = Awaited<ReturnType<typeof setup>>;

async function enable(s: S) {
  const st = await s.mode.setMode(s.ws.id, { mode: 'autonomous', chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: 10 });
  return st.orgId!;
}
const readFile = async (s: S, path: string) => (await s.fs.read(s.ws.id, path))?.body.toString('utf8') ?? null;
const thread = async (s: S, channelId: string, rootId: string) => (await s.groupchat.messages(channelId, { thread: rootId })).messages;

// ---- pure helpers ----

test('minutes paths, narrative parsing, the model-free discussion and the ad-hoc title', () => {
  const at = new Date(2026, 10, 2, 9, 30).toISOString(); // local 2 Nov 2026 09:30
  assert.equal(minutesPathFor({ kind: 'weekly_review', title: 'x', at, unitSlug: 'company' }), 'org/meetings/company/2026/2026-11-02-weekly-review.md');
  assert.equal(minutesPathFor({ kind: 'adhoc', title: 'Meeting: Launch plan!', at, channelSlug: 'launch' }), 'channels/launch/meetings/2026-11-02-meeting-launch-plan.md');
  assert.equal(minutesPathFor({ kind: 'adhoc', title: 'Sync', at, channelSlug: 'x', channelFolder: 'teams/x/' }), 'teams/x/meetings/2026-11-02-sync.md');
  assert.equal(withSuffix('org/meetings/2026/a.md', '0930'), 'org/meetings/2026/a-0930.md');
  assert.deepEqual(parseNarrative('Sure! {"summary": "S.", "discussion": ["a", 3, ""]}'), { summary: 'S.', discussion: ['a'] });
  assert.equal(parseNarrative('no json'), null);
  assert.equal(parseNarrative('{"summary": ""}'), null);
  const d = recordDiscussion([
    { authorKind: 'agent', authorId: 'w', text: 'I will draft it.\nMore.', createdAt: '' },
    { authorKind: 'system', authorId: '', text: 'noise', createdAt: '' },
    { authorKind: 'agent', authorId: 'e', text: 'Action proposed: x — owner y', createdAt: '' },
    { authorKind: 'human', authorId: 'h', text: 'Thursday please', createdAt: '' },
  ], (k, id) => (k === 'human' ? 'Ann' : id.toUpperCase()));
  assert.deepEqual(d, ['W: I will draft it. More.', 'Ann: Thursday please']);
  assert.equal(adhocTitle('Ship plan @Writer'), 'Meeting: Ship plan');
  assert.equal(adhocTitle(''), 'Meeting');
});

test('expandCron walks days in server-local time like cronMatches; retros keep a two-week gap', () => {
  const from = new Date(2026, 10, 2, 0, 0); // Monday
  const to = new Date(2026, 10, 16, 0, 0);
  const standups = expandCron('30 9 * * 1-5', from, to);
  assert.equal(standups.length, 10);
  assert.ok(standups.every((d) => d.getHours() === 9 && d.getMinutes() === 30 && d.getDay() >= 1 && d.getDay() <= 5));
  assert.equal(expandCron('*/15 * * * *', from, to, 50).length, 50, 'bounded');
  assert.deepEqual(expandCron('bad', from, to), []);
  const fridays = expandCron('30 16 * * 5', from, new Date(2026, 11, 1));
  assert.equal(fridays.length, 4);
  const retros = retroGap(fridays, new Date(2026, 9, 30, 16, 30).toISOString()); // last retro Fri 30 Oct
  assert.deepEqual(retros.map((d) => d.getDate()), [13, 27]);
});

// ---- an org ritual: the facilitator's summary ----

test('a unit ritual ends with minutes at /org/meetings/<unit>/<yyyy>/<day>-<kind>.md, authored by the facilitator; the row keeps path and summary; the thread and the channel link it', async () => {
  const s = await setup((me, round, closing, _req, toolRound) => {
    if (closing) return toolRound === 0 ? call('meeting_close', { summary: 'We ship issue 1 on Friday.' }) : say('Closed.');
    if (toolRound > 0) return say(`${me} done.`);
    if (me === 'Writer' && round === 1) return call('meeting_propose_action', { title: 'Draft issue 1', owner: 'Writer', done_when: 'Editor accepted the draft' });
    if (me === 'Editor' && round === 1) return call('meeting_propose_decision', { title: 'Weekly cadence', decision: 'Publish every Friday', rationale: 'Readers expect a rhythm' });
    if (me === 'Editor' && round === 2) return call('meeting_raise_risk', { text: 'Sources are thin' });
    if (me === 'Writer' && round === 2) return call('meeting_ask_ceo', { question: 'Do we take sponsors?' });
    return say(`${me} speaking in round ${round}.`);
  });
  const orgId = await enable(s);
  await s.org.setTunable(orgId, 'meeting.selectiveRounds', 0);
  const root = await s.units.rootUnit(orgId);
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  const m0 = await s.meetingRuntime.start(orgId, { kind: 'planning', unitId: root.id, agenda: 'Plan issue 1.', createdBy: 'user' });
  await s.meetingRuntime.idle();
  const m = await s.meetings.get(orgId, m0.id);
  assert.equal(m.status, 'done');
  const day = localDay(new Date(m.startedAt!));
  assert.equal(m.minutesPath, `org/meetings/${root.slug}/${day.slice(0, 4)}/${day}-planning.md`);
  assert.equal(m.summary, 'We ship issue 1 on Friday.');
  assert.equal(s.provider.requests.filter(isMinutesCall).length, 0, 'the facilitator wrote the summary: no extra call');
  const md = (await readFile(s, m.minutesPath!))!;
  assert.match(md, /^# Minutes — Planning · /);
  assert.match(md, /\| When \| \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}–\d{2}:\d{2} \(server time\) \|/);
  assert.match(md, new RegExp(`\\| Meeting \\| Planning · Company \\(#${root.slug}\\) \\|`));
  assert.match(md, /\| Facilitator \| Chief \|/);
  assert.match(md, /\| Attendees \| .*Writer.*Editor.*\(agents\); .*\(people\) \|/);
  assert.match(md, /## Agenda\n\nPlan issue 1\./);
  assert.match(md, /## Summary\n\nWe ship issue 1 on Friday\./);
  assert.match(md, /## Discussion\n\n- Chief: Chief speaking in round 1\./);
  const minutes = parseMinutes(m.minutes);
  assert.match(md, new RegExp(`- \\*\\*Weekly cadence\\*\\* — Publish every Friday\\n  - Decided by Editor · decision log \`#decision:${minutes.decisions[0].decisionId!.slice(0, 8)}\`\\n  - Why: Readers expect a rhythm`));
  assert.match(md, new RegExp(`\\| Draft issue 1 \\| Writer \\| — \\| Editor accepted the draft \\| \\[${minutes.actions[0].taskKey}\\]\\(#/ws/${s.ws.id}/org/board\\?task=${minutes.actions[0].taskId}\\) \\|`));
  assert.match(md, /- Question for the CEO: Do we take sponsors\? \(Writer\)\n- Risk: Sources are thin \(Editor\)/);
  assert.match(md, /## Next meeting\n\n_None scheduled/, 'no planning cadence');
  assert.match(md, /the summary is Chief's closing note/);
  // authored by the facilitator, versioned
  const meta = await s.fs.meta(s.ws.id, m.minutesPath!);
  assert.equal(meta?.updatedBy.kind, 'agent'); assert.equal(meta?.updatedBy.id, s.chief.id); assert.equal(meta?.version, 1);
  // the thread's minutes message links the file; the channel line says where
  const msgs = await thread(s, company.id, m.threadRootId!);
  assert.deepEqual(JSON.parse(msgs.at(-1)!.attachments), [{ path: `meetings/${m.id}`, kind: 'minutes' }, { path: m.minutesPath, kind: 'file' }]);
  const top = (await s.groupchat.messages(company.id)).messages.at(-1)!;
  assert.match(top.text, new RegExp(`^Minutes of Planning · .* · Minutes: /${m.minutesPath!.replace(/[.]/g, '\\.')}$`));
  assert.deepEqual(JSON.parse(top.attachments), [{ path: m.minutesPath, kind: 'file' }]);

  // a second planning the same day does not overwrite the first
  const m1 = await s.meetingRuntime.start(orgId, { kind: 'planning', unitId: root.id, agenda: 'Again.', createdBy: 'user' });
  await s.meetingRuntime.idle();
  const again = await s.meetings.get(orgId, m1.id);
  assert.notEqual(again.minutesPath, m.minutesPath);
  assert.match(again.minutesPath!, /-planning-\d{4}\.md$/);
  assert.match((await readFile(s, m.minutesPath!))!, /Plan issue 1\./, 'the first minutes are intact');
});

// ---- a standup: the model path and the model-free fallback ----

test('without a closing summary (a standup) one bounded call on the facilitator\'s model writes the summary; when it fails the minutes are composed from the record', async () => {
  const s = await setup((me) => say(me === 'Writer' ? 'Blocked on the style guide.' : 'nothing to add'));
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const m0 = await s.meetingRuntime.start(orgId, { kind: 'standup', unitId: root.id });
  await s.meetingRuntime.idle();
  const m = await s.meetings.get(orgId, m0.id);
  const calls = s.provider.requests.filter(isMinutesCall);
  assert.equal(calls.length, 1, 'one minutes call');
  assert.equal(calls[0].maxTokens, MINUTES_MAX_TOKENS);
  assert.match(calls[0].messages[0].content as string, /<meeting-thread>\n[\s\S]*Writer: Blocked on the style guide\./);
  assert.equal(m.summary, 'The model summary: Writer drafts, Editor reviews.');
  assert.equal(parseMinutes(m.minutes).summary, m.summary, 'the stored (hashed) minutes carry the model summary');
  const md = (await readFile(s, m.minutesPath!))!;
  assert.match(m.minutesPath!, new RegExp(`^org/meetings/${root.slug}/\\d{4}/\\d{4}-\\d{2}-\\d{2}-standup\\.md$`));
  assert.match(md, /## Discussion\n\n- Writer is blocked on the style guide\.\n- Editor will unblock today\./);
  assert.match(md, /written by Chief's model from the thread/);
  assert.match(md, /## Next meeting\n\nStandup: \w{3} \d{4}-\d{2}-\d{2} 09:30 \(server time, cadence `30 9 \* \* 1-5`\)/);
  // the call was priced and settled against the org budget
  const audit = await s.meetings['audit'].list(orgId, { limit: 300 });
  assert.equal(JSON.parse(audit.find((r) => r.action === 'meeting_end')!.payload).minutesBy, 'model');

  // fallback: the model answers garbage → composed from the record
  s.provider.minutes = () => 'I cannot do that.';
  const m1 = await s.meetingRuntime.start(orgId, { kind: 'standup', unitId: root.id });
  await s.meetingRuntime.idle();
  const r1 = await s.meetings.get(orgId, m1.id);
  assert.match(r1.summary, /^Held without a facilitator summary\. Nothing was proposed for the minutes\./);
  const md1 = (await readFile(s, r1.minutesPath!))!;
  assert.match(md1, /## Discussion\n\n- (Writer|Editor|Chief): /);
  assert.match(md1, /composed from the meeting record without a model/);

  // fallback: the model call throws → still minutes
  s.provider.minutes = () => { throw new Error('provider down'); };
  const m2 = await s.meetingRuntime.start(orgId, { kind: 'standup', unitId: root.id });
  await s.meetingRuntime.idle();
  const r2 = await s.meetings.get(orgId, m2.id);
  assert.equal(r2.status, 'done');
  assert.ok(r2.minutesPath && (await readFile(s, r2.minutesPath)));
  assert.match(r2.summary, /^Held without a facilitator summary/);
});

test('no headroom under the meeting\'s USD cap: the minutes call is skipped and the record writes them', async () => {
  const s = await setup((me) => say(`${me} ok`));
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  s.runtime.estimateUsd = async () => 50; // every call would bust a $1 cap
  const m0 = await s.meetingRuntime.start(orgId, { kind: 'standup', unitId: root.id });
  await s.meetingRuntime.idle();
  const m = await s.meetings.get(orgId, m0.id);
  assert.equal(s.provider.requests.filter(isMinutesCall).length, 0);
  assert.ok(m.minutesPath);
  assert.match(m.summary, /^Ended at the meeting budget cap\./);
});

// ---- a channel meeting via /meeting ----

test('`/meeting` in an ordinary channel writes its minutes to /channels/<slug>/meetings/<day>-<title>.md and posts the link there', async () => {
  const s = await setup((me, _round, closing, _req, toolRound) => {
    if (closing) return toolRound === 0 ? call('meeting_close', { summary: 'Launch on Monday.' }) : say('ok');
    return say(`${me}: ready to launch.`);
  });
  await enable(s);
  const launch = await s.groupchat.create(s.ws.id, { name: 'Launch', agentIds: [s.chief.id, s.writer.id] });
  await s.groupchat.post(launch.id, { text: '/meeting Launch checklist @Writer', authorKind: 'human' });
  await s.meetingRuntime.idle();
  const orgId = (await s.org.byWorkspace(s.ws.id))!.id;
  const m = (await s.meetings.list(orgId)).find((x) => x.channelId === launch.id)!;
  assert.equal(m.status, 'done');
  assert.equal(m.unitId, null);
  assert.equal(m.title, 'Meeting: Launch checklist');
  const day = localDay(new Date(m.startedAt!));
  assert.equal(m.minutesPath, `channels/${launch.slug}/meetings/${day}-meeting-launch-checklist.md`);
  const md = (await readFile(s, m.minutesPath!))!;
  assert.match(md, /^# Minutes — Meeting: Launch checklist/);
  assert.match(md, new RegExp(`\\| Meeting \\| Meeting · #${launch.slug} \\|`));
  assert.match(md, /\| Attendees \| Chief, Writer \(agents\); .* \(people\) \|/);
  assert.match(md, /## Summary\n\nLaunch on Monday\./);
  // the channel's Files tab lists it
  assert.ok((await s.groupchat.files(launch.id)).some((f) => f.path.endsWith('meeting-launch-checklist.md')));
  const top = (await s.groupchat.messages(launch.id)).messages.at(-1)!;
  assert.match(top.text, /Minutes: \/channels\/launch\/meetings\//);
});

// ---- cancelled after it started ----

test('a meeting cancelled mid-way still gets minutes, marked not executed; nothing materialises', async () => {
  let orgId = ''; let id = '';
  const s: S = await setup(async (me, _round, _closing, _req, toolRound) => {
    if (me === 'Writer' && toolRound === 0) {
      await s.meetings.cancel(orgId, id, 'user');
      return call('meeting_propose_action', { title: 'Draft', owner: 'Writer', done_when: 'done' });
    }
    return say(`${me} ok`);
  });
  orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const m0 = await s.meetings.create(orgId, { kind: 'weekly_review', unitId: root.id });
  id = m0.id;
  assert.equal(await s.meetingRuntime.run(orgId, m0.id), 'cancelled');
  const m = await s.meetings.get(orgId, id);
  assert.equal(m.status, 'cancelled');
  assert.ok(m.minutesPath, 'minutes written');
  assert.match(m.summary, /^Cancelled before the end; nothing was executed\./);
  const md = (await readFile(s, m.minutesPath!))!;
  assert.match(md, /cancelled before the end — nothing in these minutes was executed/);
  assert.match(md, /## Action items \(proposed, not executed\)\n\n\| Action[\s\S]*\| Draft \| Writer \| — \| done \| — \|/);
  assert.equal((await s.tasks.list(orgId)).filter((t) => t.title === 'Draft').length, 0, 'no task');
});

// ---- the calendar API ----

test('GET …/meetings: past meetings with minutes, upcoming occurrences from the cadences (named by unit), filters by unit, channel and range', async () => {
  const s = await setup((me) => say(`${me} ok`));
  // no organization yet: an empty answer, not an error
  assert.deepEqual((await s.controller.list(s.ws.id)).meetings, []);
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  // a second unit: Writer leads Alpha
  const alpha = await s.agents.create({ name: 'Alpha' });
  await s.org.addMember(orgId, { agentId: alpha.id, reportsToAgentId: s.writer.id, scopes: [] });
  const writerUnit = (await s.units.ledBy(orgId, s.writer.id))!;
  await s.meetings.ensureCadenceDefaults(orgId);
  const m0 = await s.meetingRuntime.start(orgId, { kind: 'standup', unitId: root.id });
  await s.meetingRuntime.idle();

  const now = new Date();
  const from = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const to = new Date(now.getTime() + 14 * 24 * 3600_000).toISOString();
  const all = await s.controller.list(s.ws.id, undefined, undefined, from, to);
  assert.equal(all.hasOrg, true);
  const past = all.meetings.find((x) => x.meetingId === m0.id)!;
  assert.equal(past.source, 'meeting'); assert.equal(past.status, 'done');
  assert.ok(past.minutesPath?.startsWith('org/meetings/'));
  assert.ok(past.summary);
  assert.equal(past.unitName, 'Company'); assert.equal(past.channelSlug, COMPANY_SLUG);
  assert.ok(past.attendees.some((a) => a.kind === 'agent' && a.name === 'Writer'));
  const upcoming = all.meetings.filter((x) => x.source === 'cadence');
  assert.ok(upcoming.length > 0);
  assert.ok(upcoming.every((x) => x.status === 'upcoming' && x.at >= all.now && x.at < to));
  // the two units' standups at the same time are told apart by name
  const standups = upcoming.filter((x) => x.kind === 'standup');
  const company = standups.filter((x) => x.unitId === root.id);
  const writers = standups.filter((x) => x.unitId === writerUnit.id);
  assert.ok(company.length >= 9 && writers.length === company.length);
  assert.equal(company[0].title, 'Standup · Company'); assert.equal(writers[0].title, `Standup · ${writerUnit.name}`);
  assert.equal(company[0].cron, '30 9 * * 1-5');
  assert.equal(company[0].facilitator?.name, 'Chief'); assert.equal(writers[0].facilitator?.name, 'Writer');
  assert.ok(writers[0].attendees.some((a) => a.name === 'Alpha'));
  assert.ok(upcoming.filter((x) => x.kind === 'board').every((x) => x.unitId === root.id), 'the board meets for the root only');
  const retros = upcoming.filter((x) => x.kind === 'retro' && x.unitId === root.id);
  assert.ok(retros.length <= 1, 'retros are every second Friday');
  // sorted by time
  assert.deepEqual(all.meetings.map((x) => x.at), [...all.meetings.map((x) => x.at)].sort());
  // by unit
  const byUnit = await s.controller.list(s.ws.id, writerUnit.id, undefined, from, to);
  assert.ok(byUnit.meetings.length > 0 && byUnit.meetings.every((x) => x.unitId === writerUnit.id));
  // by channel (slug or id): the unit channel's cadences and meetings
  const wslug = (await s.groupchat.get(writerUnit.channelId!)).slug;
  const byChannel = await s.controller.list(s.ws.id, undefined, wslug, from, to);
  assert.ok(byChannel.meetings.length > 0 && byChannel.meetings.every((x) => x.channelId === writerUnit.channelId));
  assert.deepEqual((await s.controller.list(s.ws.id, undefined, writerUnit.channelId!, from, to)).meetings.map((x) => x.id), byChannel.meetings.map((x) => x.id));
  const companyOnly = await s.controller.list(s.ws.id, undefined, COMPANY_SLUG, from, to);
  assert.ok(companyOnly.meetings.some((x) => x.meetingId === m0.id));
  // range: the past only → no upcoming
  const yesterday = await s.controller.list(s.ws.id, undefined, undefined, new Date(now.getTime() - 3 * 24 * 3600_000).toISOString(), new Date(now.getTime() - 1000).toISOString());
  assert.equal(yesterday.meetings.filter((x) => x.source === 'cadence').length, 0);
  // a date-only "to" includes that day; bad input is refused
  const day = await s.controller.list(s.ws.id, undefined, undefined, localDay(now), localDay(now));
  assert.ok(day.meetings.some((x) => x.meetingId === m0.id));
  await assert.rejects(() => s.controller.list(s.ws.id, undefined, undefined, 'nope'), /from must be a date/);
  await assert.rejects(() => s.controller.list(s.ws.id, undefined, undefined, '2026-01-01', '2026-12-31'), /at most 93 days/);
  await assert.rejects(() => s.controller.list(s.ws.id, undefined, 'no-such-channel'), /no channel/);
  // a disabled cadence disappears
  const c = (await s.meetings.cadences(orgId)).find((x) => x.unitId === writerUnit.id && x.kind === 'standup')!;
  await s.meetings.updateCadence(orgId, c.id, { enabled: false });
  assert.equal((await s.controller.list(s.ws.id, writerUnit.id, undefined, from, to)).meetings.filter((x) => x.kind === 'standup').length, 0);
});

test('a unit meeting\'s agenda and pre-read are written beside its minutes (orgPath.agenda), with the proposals, and the room keeps the path', async () => {
  const s = await setup(() => say('ok'));
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const m0 = await s.meetings.create(orgId, { kind: 'weekly_review', unitId: root.id, createdBy: 'user', scheduledFor: new Date(Date.now() + 3600_000).toISOString() });
  await s.meetingRuntime.proposeAgenda(orgId, m0.id, { kind: 'agent', id: s.writer.id }, { text: 'Sponsorship policy', why: 'two offers' });
  const path = orgPath.agenda(root.slug, new Date(m0.scheduledFor!), 'weekly_review');
  assert.match(path, /-weekly-review-agenda\.md$/);
  assert.match((await readFile(s, path))!, /## Proposed by attendees\n\n- Sponsorship policy — two offers \(Writer\)/);
  await s.meetingRuntime.run(orgId, m0.id);
  const m = await s.meetings.get(orgId, m0.id);
  const room = JSON.parse(m.room) as { agendaPath: string };
  const doc = (await readFile(s, room.agendaPath))!;
  assert.match(doc, /^# Agenda — Weekly review/);
  assert.match(doc, /## Items\n\n1\. Scorecard[\s\S]*Sponsorship policy/);
  assert.match(doc, /## Pre-read\n\n\*\*Pre-read\*\*/);
  assert.ok(m.minutesPath && room.agendaPath.replace(/-agenda\.md$/, '.md').split('/').slice(0, -1).join('/') === m.minutesPath.split('/').slice(0, -1).join('/'), 'beside the minutes');
});
