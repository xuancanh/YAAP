/** Restarts and recovery (docs/architecture.md "Restarts and recovery"): an
 *  abort for a restart is recorded `interrupted`, never `error` — not a
 *  failing agent, a loop_error, a breaker or a run_failed; the graceful
 *  drain gives in-flight turns a grace period; the boot sweep recovers each
 *  kind of thing a dead process leaves (turns, org runs and claims, budget
 *  reservations, meetings, action-log rows, approvals) and re-runs what is
 *  safe to — once, never a call whose outcome nobody knows; a transient
 *  provider reset mid-stream re-asks the round. */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import type { ConfigService } from '@nestjs/config';
import { testDb, memStorage, ctxStub, skillsStub, mcpWriterStub, ScriptedProvider } from './helpers';
import { actionLog, chatTurns, heartbeatState, orgBudgets, orgMeetings, orgRuns } from '../server/src/database/schema';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, type TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { WorkLogService } from '../server/src/chats/work-log.service';
import { WorkRerunService } from '../server/src/chats/work-rerun.service';
import { LoopsService } from '../server/src/chats/loops.service';
import { HeartbeatService } from '../server/src/chats/heartbeat.service';
import { DistillService } from '../server/src/chats/distill.service';
import { RestartRecoveryService } from '../server/src/chats/restart-recovery.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { agentStatuses } from '../server/src/home/agent-status';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgRerunBridge } from '../server/src/org/org-rerun.bridge';
import { OrgRecoveryService } from '../server/src/org/org-recovery.service';
import { classifyAudit } from '../server/src/home/feed-registry';
import { ActionsService } from '../server/src/actions/actions.service';
import type { TrustService } from '../server/src/actions/trust.service';
import { beginDrain, INTERRUPTED_NOTE, isTransientError, resetLifecycle } from '../server/src/common/lifecycle';
import { newId, nowIso } from '../server/src/common/ids.util';
import type { StorageService } from '../server/src/storage/storage.service';
import type { AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';

afterEach(() => resetLifecycle());

const answer = (text: string): AiStreamEvent[] => [{ type: 'answer', text }, { type: 'usage', inputTokens: 3, outputTokens: 2 }, { type: 'done' }];

/** Streams one answer delta, then waits for its signal and throws the way
 *  fetch does on abort ("This operation was aborted"), unless released. */
class HangingProvider extends ScriptedProvider {
  private releaseFn: (() => void) | null = null;
  hanging = 0;
  release() { this.releaseFn?.(); }
  override async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    if (this.hangNext) {
      this.hangNext = false;
      this.hanging++;
      yield { type: 'answer', text: 'Working on' };
      await new Promise<void>((resolve, reject) => {
        this.releaseFn = resolve;
        const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
        if (req.signal?.aborted) abort(); else req.signal?.addEventListener('abort', abort, { once: true });
      });
      yield { type: 'answer', text: ' it. Done.' };
      yield { type: 'done' };
      return;
    }
    yield* super.stream(req);
  }
  hangNext = false;
}

async function setup(rounds: AiStreamEvent[][] = [], opts: { companies?: boolean } = {}) {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const chats = new ChatsService(repo, agents);
  const provider = new HangingProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpWriterStub(stub), agents, workspaces);
  turns.settleMs = 500;
  const config = { get: (k: string) => (k === 'companiesEnabled' ? opts.companies ?? false : undefined) } as unknown as ConfigService;
  const log = new WorkLogService(db, agents);
  const distill = new DistillService(repo, ctxStub(provider), agents, new AgentMemoryService(db, stub as unknown as StorageService));
  const loops = new LoopsService(agents, workspaces, repo, turns, distill, config);
  const heartbeat = new HeartbeatService(db, agents, workspaces, loops, config);
  const reruns = new WorkRerunService(log, chats, repo, turns, heartbeat, loops, agents);
  const recovery = new RestartRecoveryService(db, repo, agents, log, reruns, heartbeat, loops, config);
  const ws = (await workspaces.list())[0];
  const agent = await agents.create({ name: 'Jong', workspaceId: ws.id, loops: [{ name: 'digest', cron: '0 9 * * 1' }] });
  return { db, bus, repo, chats, agents, workspaces, turns, provider, config, log, loops, heartbeat, reruns, recovery, ws, agent };
}
type S = Awaited<ReturnType<typeof setup>>;

async function collect(gen: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};

const loopSession = (s: S, name = 'digest') => s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: `Loop · ${name}`, kind: 'work', permissionMode: 'auto' });

test('a shutdown abort mid-stream is interrupted, not an error: no error event, no failing agent, no loop_error', async () => {
  const s = await setup();
  s.provider.hangNext = true;
  const loop = { name: 'digest', cron: '0 9 * * 1' };
  const running = s.loops.runLoop(s.agent.id, s.agent.name, loop);
  await until(() => s.provider.hanging === 1);
  const drained = await s.turns.drain(30); // the grace runs out: the turn is interrupted
  assert.deepEqual(drained, { finished: 0, interrupted: 1 });
  assert.equal(await running, 'interrupted', 'the loop reports the interruption, not a failure');

  const session = (await s.repo.listSessions(s.ws.id)).find((x) => x.name === 'Loop · digest')!;
  const [turn] = await s.repo.listTurns(session.id);
  assert.equal(turn.status, 'interrupted');
  assert.equal(turn.error, INTERRUPTED_NOTE);
  assert.equal(turn.recovery, 'pending', 'the next boot recovers it');
  const events = await s.agents.listEvents(s.agent.id, 50);
  assert.ok(!events.some((e) => e.kind === 'loop_error'), 'no loop_error (so no run_failed in the feed)');

  const [status] = await agentStatuses({ db: s.db, agents: s.agents }, { workspaceId: s.ws.id, org: null, orgOn: false, agents: await s.agents.list(), orgTasks: [], members: [], now: new Date() });
  assert.notEqual(status.state, 'error', 'an interrupted run never turns the agent red');
  assert.equal(status.errors.length, 0);

  const page = await s.log.list(s.agent.id);
  assert.equal(page.runs[0].outcome, 'interrupted');
  assert.equal(page.runs[0].rerunnable, true);
  assert.equal(page.runs[0].recovery, 'pending');
});

test('the owner\'s Stop is stopped — even when the provider throws "This operation was aborted"', async () => {
  const s = await setup();
  s.provider.hangNext = true;
  const chat = await s.chats.create({ workspaceId: s.ws.id });
  const run = collect(s.turns.run(chat.id, { text: 'hi' }));
  await until(() => s.provider.hanging === 1);
  s.turns.stop(chat.id);
  const events = await run;
  assert.ok(!events.some((e) => e.type === 'error'), 'no error event for a stop');
  assert.ok(!events.some((e) => e.type === 'interrupted'), 'a stop is not a restart');
  const [turn] = await s.repo.listTurns(chat.id);
  assert.equal(turn.status, 'stopped');
  assert.equal(turn.error, null);
});

test('graceful drain: a turn that finishes inside the grace period ends done; new turns are refused while draining', async () => {
  const s = await setup();
  s.provider.hangNext = true;
  const chat = await s.chats.create({ workspaceId: s.ws.id });
  const run = collect(s.turns.run(chat.id, { text: 'finish this' }));
  await until(() => s.provider.hanging === 1);
  const draining = s.turns.drain(2_000);
  setTimeout(() => s.provider.release(), 50); // the stream finishes inside the grace
  assert.deepEqual(await draining, { finished: 1, interrupted: 0 });
  const events = await run;
  assert.ok(!events.some((e) => e.type === 'interrupted'));
  const [turn] = await s.repo.listTurns(chat.id);
  assert.equal(turn.status, 'done');
  const msgs = await s.repo.listMessages(chat.id);
  assert.equal(msgs.at(-1)?.content, 'Working on it. Done.');
  // while draining, nothing new starts
  const other = await s.chats.create({ workspaceId: s.ws.id });
  await assert.rejects(collect(s.turns.run(other.id, { text: 'one more' })), /restarting/);
  assert.equal(await s.loops.runLoop(s.agent.id, s.agent.name, { name: 'digest', cron: '0 9 * * 1' }), 'interrupted');
});

test('a transient reset mid-stream re-asks the round: one answer persisted, a retry event, the turn done', async () => {
  class ResetOnce extends ScriptedProvider {
    calls = 0;
    override async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
      this.calls++;
      if (this.calls === 1) {
        yield { type: 'answer', text: 'Half an ans' };
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      yield* super.stream(req);
    }
  }
  const s = await setup();
  const provider = new ResetOnce([answer('The whole answer.')]);
  const turns = new TurnLoopService(s.repo, new ChatLocks(), new ToolsService(memStorage().stub), ctxStub(provider), skillsStub(), memStorage().stub, mcpWriterStub(memStorage().stub), s.agents, s.workspaces);
  const chat = await s.chats.create({ workspaceId: s.ws.id });
  const events = await collect(turns.run(chat.id, { text: 'hello' }));
  assert.equal(provider.calls, 2);
  assert.ok(events.some((e) => e.type === 'retry'), 'the client is told to drop the failed round');
  assert.ok(!events.some((e) => e.type === 'error'));
  const [turn] = await s.repo.listTurns(chat.id);
  assert.equal(turn.status, 'done');
  const assistant = (await s.repo.listMessages(chat.id)).filter((m) => m.role === 'assistant');
  assert.deepEqual(assistant.map((m) => m.content), ['The whole answer.'], 'nothing of the failed round was persisted');
  // what counts as transient
  assert.equal(isTransientError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientError(new Error('anthropic stream error: Overloaded')), true);
  assert.equal(isTransientError(new DOMException('This operation was aborted', 'AbortError')), false);
  assert.equal(isTransientError(new Error('anthropic 400: invalid model')), false);
});

/** A turn left behind by a dead process, as the migrator's boot sweep marks it. */
async function deadTurn(s: S, sessionId: string, input: string, source = 'loop', createdAt = new Date(Date.now() - 60_000).toISOString()) {
  const t = await s.repo.createTurn(sessionId, { text: input, source });
  await s.repo.appendMessage({ sessionId, turnId: t.id, role: 'user', content: input });
  await s.db.update(chatTurns).set({ status: 'interrupted', error: INTERRUPTED_NOTE, recovery: 'pending', createdAt }).where(eq(chatTurns.id, t.id));
  return t;
}

async function startedAction(s: S, sessionId: string, tool: string, cls: string, createdAt = nowIso()) {
  const id = newId();
  await s.db.insert(actionLog).values({ id, key: newId(), workspaceId: s.ws.id, agentId: s.agent.id, sessionId, tool, class: cls, inputHash: 'h', status: 'started', createdAt });
  return id;
}

test('boot recovery: a loop run resumes once (linked as a rerun), a person\'s chat gets a Retry, a mid-action run is held, approvals expire', async () => {
  const s = await setup([answer('Digest sent to the board.')]);
  const loop = await loopSession(s);
  const looped = await deadTurn(s, loop.id, 'Scheduled loop firing: "digest".');
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'Planning', kind: 'chat' });
  const chatted = await deadTurn(s, chat.id, 'draft the plan', 'person');
  const mail = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name: 'Loop · mail', kind: 'work', permissionMode: 'auto' });
  const mailed = await deadTurn(s, mail.id, 'Scheduled loop firing: "mail".');
  const sendId = await startedAction(s, mail.id, 'gmail_send', 'external_irreversible');
  const writeId = await startedAction(s, mail.id, 'fs_write', 'internal_write');
  await s.agents.addEvent(s.agent.id, { kind: 'approval_request', title: 'Jong asks to run gmail_send', sessionId: chat.id, payload: JSON.stringify({ callId: 'c1' }) });

  const report = await s.recovery.recover();
  assert.equal(report.turns.resumed, 1);
  assert.equal(report.turns.retry, 1);
  assert.equal(report.turns.held, 1);
  assert.equal(report.approvalsExpired, 1);

  // the loop re-ran by its trigger, linked to the interrupted run
  await until(async () => (await s.repo.listTurns(loop.id)).length === 2);
  const [old, again] = await s.repo.listTurns(loop.id);
  assert.equal(old.id, looped.id);
  assert.equal(old.recovery, 'resumed');
  assert.equal(again.rerunOf, looped.id);
  await until(async () => (await s.repo.getTurn(again.id))!.status === 'done');
  const run = (await s.log.list(s.agent.id, { sessionId: loop.id })).runs.find((r) => r.id === looped.id)!;
  assert.equal(run.outcome, 'interrupted');
  assert.equal(run.recovery, 'resumed');
  assert.equal(run.resumedBy, again.id);

  // the person's chat is not re-sent: it offers a Retry
  assert.equal((await s.repo.getTurn(chatted.id))!.recovery, 'retry');
  assert.equal((await s.repo.listTurns(chat.id)).length, 1);

  // mid-action: not replayed; the owner is told; the outward call's outcome is unknown, the internal write just failed
  assert.equal((await s.repo.getTurn(mailed.id))!.recovery, 'held');
  assert.equal((await s.repo.listTurns(mail.id)).length, 1, 'nothing re-ran in that session');
  const [send] = await s.db.select().from(actionLog).where(eq(actionLog.id, sendId));
  assert.equal(send.status, 'interrupted');
  const [write] = await s.db.select().from(actionLog).where(eq(actionLog.id, writeId));
  assert.equal(write.status, 'failed');
  const events = await s.agents.listEvents(s.agent.id, 50);
  assert.ok(events.some((e) => e.kind === 'agent_message' && /check whether gmail_send went through/.test(e.title)));
  assert.ok(events.some((e) => e.kind === 'approval_expired'), 'the approval whose turn died is expired, not left decidable forever');
  assert.ok(!events.some((e) => e.kind === 'approval_request'));

  // once: a second recovery finds nothing pending
  const second = await s.recovery.recover();
  assert.deepEqual(second.turns, { resumed: 0, retry: 0, held: 0, none: 0 });
  assert.equal((await s.repo.listTurns(loop.id)).length, 2);
});

test('catch-up: a heartbeat and a loop that fell due while the server was down run once, not once per missed tick', async () => {
  const s = await setup([answer('Checked.')]);
  const now = new Date();
  // the digest loop ran a week ago; its cron (every minute) fell due many times since
  await s.agents.update(s.agent.id, { loops: JSON.stringify([{ name: 'digest', cron: '* * * * *' }]) });
  const loop = await loopSession(s);
  const old = await s.repo.createTurn(loop.id, { text: 'last week', source: 'loop' });
  await s.db.update(chatTurns).set({ status: 'done', createdAt: new Date(now.getTime() - 3 * 60 * 60_000).toISOString() }).where(eq(chatTurns.id, old.id));
  const ran = await s.loops.catchUp(now, { lookbackMs: 24 * 60 * 60_000 });
  assert.deepEqual(ran, [`${s.agent.id}:digest`]);
  assert.equal((await s.repo.listTurns(loop.id)).length, 2, 'one catch-up run');
  assert.deepEqual(await s.loops.catchUp(now, { lookbackMs: 24 * 60 * 60_000 }), [], 'and only one');

  // the heartbeat: due 10 minutes ago, never beaten since → one beat (an empty gate costs nothing)
  await s.heartbeat.beat(s.agent.id, new Date(now.getTime() - 20 * 60_000));
  await s.db.update(heartbeatState).set({ nextDueAt: new Date(now.getTime() - 10 * 60_000).toISOString() }).where(eq(heartbeatState.agentId, s.agent.id));
  assert.deepEqual(await s.heartbeat.catchUp(now, { lookbackMs: 24 * 60 * 60_000 }), [s.agent.id]);
  assert.deepEqual(await s.heartbeat.catchUp(now, { lookbackMs: 24 * 60 * 60_000 }), [], 'beaten once');
});

async function orgSetup() {
  const s = await setup([answer('Draft written.')], { companies: true });
  const audit = new OrgAuditService(s.db);
  const org = new OrgService(s.db, s.agents, audit);
  const tasks = new OrgTasksService(s.db, org, audit, s.bus);
  const approvals = new OrgApprovalsService(s.db, org, tasks, s.agents, audit, undefined, s.bus);
  const brief = new OrgBriefService(s.db, org, tasks, approvals, audit, s.agents, s.workspaces);
  const runtime = new OrgRuntimeService(s.db, org, tasks, approvals, audit, brief, s.turns, s.repo, s.agents, s.workspaces, s.config, new OrgAnnouncer(), s.bus);
  runtime.debounceMs = 15;
  new OrgRerunBridge(s.db, s.reruns, runtime).onModuleInit();
  const orgRecovery = new OrgRecoveryService(s.db, s.recovery, tasks, runtime, audit, s.config);
  orgRecovery.onModuleInit();
  const o = await org.create({ workspaceId: s.ws.id, name: 'Acme', mission: 'Ship.', chief: { name: 'Chief', charter: 'You run Acme.' } });
  const writer = await s.agents.create({ name: 'Writer', charter: 'You write.', workspaceId: s.ws.id });
  await org.addMember(o.id, { agentId: writer.id, title: 'Writer', reportsToAgentId: o.chiefOfStaffAgentId, scopes: ['tool:fs_read', 'tool:fs_write'] });
  return { ...s, audit, org, tasks, runtime, o, writer };
}

test('an interrupted task run is not a failure: no breaker, no no-progress count, no run_failed', async () => {
  const s = await orgSetup();
  const t = await s.tasks.create(s.o.id, { title: 'Draft issue 12', brief: { outcome: 'A draft', done_when: 'Draft in shared/' }, assigneeAgentId: s.writer.id });
  s.provider.hangNext = true;
  const running = s.runtime.runTask(s.o.id, t.id, s.writer.id, 'assignment');
  await until(() => s.provider.hanging === 1);
  await s.turns.drain(20);
  assert.equal(await running, 'ran');
  const [r] = await s.db.select().from(orgRuns).where(eq(orgRuns.taskId, t.id));
  assert.equal(r.status, 'interrupted');
  assert.equal(r.outcome, 'interrupted');
  const after = await s.tasks.get(s.o.id, t.id);
  assert.equal(after.noProgressCount, 0, 'no no-progress count');
  assert.equal(after.failSig, '', 'no circular signature');
  assert.equal(after.claimedBy, null, 'the claim is released');
  assert.equal(s.runtime.scheduledRewakes().length, 0, 'no back-off re-wake');
  const end = (await s.audit.list(s.o.id, { action: 'run_end', limit: 5 }))[0];
  assert.equal(JSON.parse(end.payload).status, 'interrupted');
  assert.equal(classifyAudit(end as never, { agent: () => null } as never), null, 'run_end interrupted is no run_failed in the feed');
});

test('boot recovery for a company: a dead run ends, its claim and the reservation no run holds are released, the task is re-queued once, a stuck meeting closes', async () => {
  const s = await orgSetup();
  await s.org.setBudget(s.o.id, { scope: 'company', refId: s.o.id, monthlyUsd: 10 });
  const t = await s.tasks.create(s.o.id, { title: 'Draft issue 12', brief: { outcome: 'A draft', done_when: 'Draft in shared/' }, assigneeAgentId: s.writer.id });
  s.runtime.cancelWakesFor(s.o.id, s.writer.id); // the assignment wake belongs to the dead process too
  // the dead process: a run still `running` that claimed the task (it died before its turn began) and a reservation it held
  const run = await s.tasks.startRun(s.o.id, { taskId: t.id, agentId: s.writer.id, wakeReason: 'assignment' });
  assert.ok(await s.tasks.claim(s.o.id, t.id, s.writer.id, run.id));
  await s.db.update(orgBudgets).set({ reservedUsd: 0.17 }).where(eq(orgBudgets.orgId, s.o.id));
  const meetingId = newId();
  await s.db.insert(orgMeetings).values({ id: meetingId, orgId: s.o.id, status: 'running', createdAt: nowIso(), startedAt: nowIso() });
  // while it is `running`, the one-run-per-task guard skips the task as busy
  assert.equal(await s.runtime.runTask(s.o.id, t.id, s.writer.id, 'manual'), 'skipped:busy');

  await s.recovery.recover();
  const [dead] = await s.db.select().from(orgRuns).where(eq(orgRuns.id, run.id));
  assert.equal(dead.status, 'interrupted');
  assert.equal(dead.outcome, 'resumed');
  const [budget] = await s.db.select().from(orgBudgets).where(eq(orgBudgets.orgId, s.o.id));
  assert.equal(budget.reservedUsd, 0, 'the $0.17 nobody held is released');
  assert.ok((await s.audit.list(s.o.id, { action: 'spend_release', limit: 5 })).length === 1);
  const [m] = await s.db.select().from(orgMeetings).where(eq(orgMeetings.id, meetingId));
  assert.equal(m.status, 'cancelled', 'the meeting stuck in progress is closed');
  // re-queued for its assignee: the wake fires and a new run claims and works the task
  assert.deepEqual(s.runtime.pendingWakeKeys(), [`${t.id}:${s.writer.id}`]);
  await s.runtime.flushAll();
  const runs = await s.db.select().from(orgRuns).where(eq(orgRuns.taskId, t.id));
  assert.equal(runs.length, 2);
  assert.ok(runs.some((x) => x.id !== run.id && x.status === 'done'));
  assert.ok((await s.audit.list(s.o.id, { action: 'run_resumed', limit: 5 })).some((a) => JSON.parse(a.payload).note === 'resumed after a restart'));
  // once per interruption: another boot re-queues nothing
  await s.recovery.recover();
  assert.deepEqual(s.runtime.pendingWakeKeys(), []);
});

test('a task run interrupted mid-action is not replayed: the task is blocked on the CEO to check it', async () => {
  const s = await orgSetup();
  const t = await s.tasks.create(s.o.id, { title: 'Send the invoice', brief: { outcome: 'Invoice sent', done_when: 'Sent' }, assigneeAgentId: s.writer.id });
  s.runtime.cancelWakesFor(s.o.id, s.writer.id);
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'Org · Acme · Send the invoice', kind: 'work', permissionMode: 'auto', taskKind: 'org', taskId: t.id });
  const run = await s.tasks.startRun(s.o.id, { taskId: t.id, agentId: s.writer.id, wakeReason: 'assignment', sessionId: session.id });
  await s.tasks.claim(s.o.id, t.id, s.writer.id, run.id);
  await s.db.update(orgRuns).set({ startedAt: new Date(Date.now() - 120_000).toISOString() }).where(eq(orgRuns.id, run.id));
  const turn = await deadTurn(s as unknown as S, session.id, 'Work on the invoice');
  const id = newId();
  await s.db.insert(actionLog).values({ id, key: newId(), workspaceId: s.ws.id, agentId: s.writer.id, sessionId: session.id, tool: 'stripe_charge', class: 'money', inputHash: 'h', status: 'started', createdAt: nowIso() });

  const report = await s.recovery.recover();
  assert.equal(report.turns.held, 1);
  assert.equal((await s.repo.getTurn(turn.id))!.recovery, 'held');
  const task = await s.tasks.get(s.o.id, t.id);
  assert.equal(task.status, 'blocked');
  assert.match(task.blockedOn, /"kind":"ceo"/);
  assert.match(task.blockedOn, /stripe_charge/);
  assert.deepEqual(s.runtime.pendingWakeKeys(), [], 'not re-queued');
  assert.equal((await s.repo.listTurns(session.id)).length, 1, 'not replayed');
  const [r] = await s.db.select().from(orgRuns).where(eq(orgRuns.id, run.id));
  assert.equal(r.outcome, 'held');
  const [a] = await s.db.select().from(actionLog).where(eq(actionLog.id, id));
  assert.equal(a.status, 'interrupted');
});

test('a later identical outward call after an interruption is told the outcome is unknown, once — never blindly replayed', async () => {
  const s = await setup();
  const actions = new ActionsService(s.db, {} as TrustService);
  const sessionId = newId();
  const id = await startedAction(s, sessionId, 'gmail_send', 'external_irreversible');
  await s.db.update(actionLog).set({ status: 'interrupted' }).where(eq(actionLog.id, id));
  const [row] = await s.db.select().from(actionLog).where(eq(actionLog.id, id));
  const seen = await actions.priorOutcome(row, 'external_irreversible');
  assert.equal(seen?.kind, 'unknown');
  assert.match(actions.unknownText(seen!.row), /whether it took effect is unknown/);
  const [after] = await s.db.select().from(actionLog).where(eq(actionLog.id, id));
  assert.equal(after.status, 'failed', 'told once: a deliberate retry after checking runs');
  assert.equal(await actions.priorOutcome(after, 'external_irreversible'), null);
});

test('the drain pauses the org runtime: a wake while draining starts no run', async () => {
  const s = await orgSetup();
  const t = await s.tasks.create(s.o.id, { title: 'Later', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.writer.id });
  beginDrain();
  assert.equal(await s.runtime.runTask(s.o.id, t.id, s.writer.id, 'assignment'), 'skipped:restarting');
  assert.equal((await s.db.select().from(orgRuns).where(eq(orgRuns.taskId, t.id))).length, 0);
});
