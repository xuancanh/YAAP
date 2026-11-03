/** The external-action contract and the trust ledger (docs/actions-and-trust.md,
 *  execution-plan item 28): action classes (input-aware, fail-safe for the
 *  unknown), idempotent replay in private chats and org runs, staging a send
 *  as a draft and promoting it on a key, outbound rate limits per class and
 *  channel, two-key execution (owner key, agent co-signer on another model
 *  family, the single-family fallback), the ledger's promotion and demotion
 *  (clean streak, incidents from the bus, rejection streak, reverts),
 *  ceilings and the owner's override, the supervised preset, and parity: the
 *  same agent at the same level gets the same decision in a private chat and
 *  an org run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub } from './helpers';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService, type TurnEvent, type TurnOrigin } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { ConnectionsService } from '../server/src/connections/connections.service';
import { seal } from '../server/src/common/secretbox';
import { actionLog, connectionGrants, connections, orgApprovals, orgAudit, orgIncidents, orgSignals, organizations, trustRecords } from '../server/src/database/schema';
import { ActionsService } from '../server/src/actions/actions.service';
import { TrustService } from '../server/src/actions/trust.service';
import { ActionsController } from '../server/src/actions/actions.controller';
import { channelOf, classOf, idempotencyKey, stagingOf, unclassified } from '../server/src/actions/action-classes';
import { applyIncident, applyOutcome, decide, describeMatrix, effectiveLevel } from '../server/src/actions/trust-policy';
import { TUNABLES } from '../server/src/org/org-tunables';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgSignalsService } from '../server/src/org/org-signals.service';
import { OrgTrustBridge } from '../server/src/org/org-trust-bridge';
import { OrgIncidentsService } from '../server/src/org/org-incidents.service';
import { normalizeActionClass } from '../server/src/actions/action-classes';
import { runWithViewer } from '../server/src/accounts/account-context';

/** A provider whose rounds the test queues before each turn; an empty queue
 *  answers and ends the turn. */
class QueueProvider implements AiProvider {
  readonly name = 'queue';
  readonly requests: AiRequest[] = [];
  readonly queue: AiStreamEvent[][] = [];
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    const events = this.queue.shift() ?? [{ type: 'answer', text: 'ok' } as AiStreamEvent, { type: 'done' } as AiStreamEvent];
    for (const ev of events) yield ev;
  }
  call(name: string, input: Record<string, unknown>, id = `c${Math.random().toString(36).slice(2, 8)}`): void {
    this.queue.push([{ type: 'tool_call', id, name, input }, { type: 'done' }]);
  }
}

const connConfig = { get: (key: string) => ({ googleClientId: 'c', googleClientSecret: 's', publicBaseUrl: 'http://localhost:8790' })[key] } as unknown as ConfigService;
const MAIL = { to: 'ann@client.example', subject: 'Renewal', body: 'Hello Ann' };
const EVENT = { title: 'Sync', start: '2026-11-10' };

async function setup(opts: { org?: 'supervised' | 'autonomous'; bobModel?: { provider: string; model: string } } = {}) {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new QueueProvider();
  const conns = new ConnectionsService(db, connConfig);
  const calls: Array<{ url: string; body: string }> = [];
  conns.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? String(init.body) : '' });
    let body: unknown = { id: 'x' };
    if (u.includes('/drafts/send')) body = { id: 'sent1' };
    else if (u.includes('/drafts')) body = { id: 'd1' };
    else if (u.includes('/messages/send')) body = { id: 'm1' };
    else if (u.includes('calendar')) body = { id: 'e1', summary: 'Sync', start: { date: '2026-11-10' }, end: { date: '2026-11-10' } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;
  const trust = new TrustService(db, agents, bus);
  const actions = new ActionsService(db, trust, agents, conns);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces, conns,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, actions);
  const controller = new ActionsController(actions, trust);
  const ws = (await workspaces.list())[0];
  const alice = await agents.create({ name: 'Alice', charter: 'You write to clients.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  const bob = await agents.create({ name: 'Bob', charter: 'You check.', ...(opts.bobModel ?? { provider: 'openai', model: 'gpt-5' }) });
  await db.insert(connections).values({
    id: 'conn1', provider: 'google', accountEmail: 'owner@example.com',
    scopes: '["https://www.googleapis.com/auth/calendar.readonly","https://www.googleapis.com/auth/calendar.events","https://www.googleapis.com/auth/gmail.compose"]',
    accessToken: seal('t'), refreshToken: seal('r'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString(),
  });
  for (const a of [alice, bob]) {
    for (const service of ['calendar', 'gmail']) {
      await db.insert(connectionGrants).values({ id: `${a.id}-${service}`, connectionId: 'conn1', agentId: a.id, service, level: 'write', createdAt: new Date().toISOString() });
    }
  }
  let org: Awaited<ReturnType<typeof orgStack>> | null = null;
  if (opts.org) org = await orgStack({ db, bus, agents, workspaces, repo, turns, actions, trust, wsId: ws.id, mode: opts.org });
  return { db, bus, agents, workspaces, repo, provider, conns, calls, trust, actions, turns, controller, ws, alice, bob, org };
}

async function orgStack(p: { db: Awaited<ReturnType<typeof testDb>>; bus: TriggerBus; agents: AgentsService; workspaces: WorkspacesService; repo: ChatsRepository; turns: TurnLoopService; actions: ActionsService; trust: TrustService; wsId: string; mode: 'supervised' | 'autonomous' }) {
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer({ announce: async () => {} });
  const audit = new OrgAuditService(p.db);
  const org = new OrgService(p.db, p.agents, audit, p.bus);
  const units = new OrgUnitsService(p.db, org, p.agents, audit, announcer);
  const tasks = new OrgTasksService(p.db, org, audit, p.bus, units);
  const approvals = new OrgApprovalsService(p.db, org, tasks, p.agents, audit, undefined, p.bus);
  const signals = new OrgSignalsService(p.db, org, tasks, audit, p.agents, p.workspaces, p.bus, units);
  const brief = new OrgBriefService(p.db, org, tasks, approvals, audit, p.agents, p.workspaces, signals);
  const runtime = new OrgRuntimeService(p.db, org, tasks, approvals, audit, brief, p.turns, p.repo, p.agents, p.workspaces, config, announcer, p.bus, undefined, undefined, undefined, undefined, undefined, units, signals);
  runtime.debounceMs = 60_000;
  const mode = new OrgModeService(org, p.workspaces, p.agents, runtime, approvals, audit, announcer);
  const incidents = new OrgIncidentsService(p.db, org, tasks, audit, p.agents, p.workspaces, runtime, p.turns, p.repo, config, signals, undefined, brief, announcer, p.bus);
  new OrgTrustBridge(p.db, audit, approvals, tasks, p.actions, p.trust, signals, incidents);
  const chief = await p.agents.create({ name: 'Chief', charter: 'You run the company.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  const st = await mode.setMode(p.wsId, { mode: p.mode, chiefOfStaffAgentId: chief.id, monthlyUsd: 50, agentCap: 10 });
  return { audit, org, tasks, approvals, signals, runtime, mode, incidents, chief, orgId: st.orgId! };
}

type S = Awaited<ReturnType<typeof setup>>;

async function run(s: S, sessionId: string, text: string, origin: TurnOrigin = 'user', onApproval?: (ev: Extract<TurnEvent, { type: 'approval_required' }>) => void): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of s.turns.run(sessionId, { text, origin })) {
    out.push(ev);
    if (ev.type === 'approval_required') onApproval?.(ev);
  }
  return out;
}

const resultOf = (events: TurnEvent[]) => events.find((e): e is Extract<TurnEvent, { type: 'tool_result' }> => e.type === 'tool_result');
const rowsOf = (s: S, tool?: string) => s.db.select().from(actionLog).where(tool ? eq(actionLog.tool, tool) : undefined);
const hits = (s: S, part: string) => s.calls.filter((c) => c.url.includes(part)).length;
const settle = () => new Promise((r) => setTimeout(r, 80));

// ---- 1. classes ----

test('action classes: the registry classes every tool family, calendar writes by their guests, MCP by its read-only hint, payments as money; channels and keys are stable', () => {
  assert.equal(classOf('fs_read'), 'read');
  assert.equal(classOf('fs_write'), 'internal_write');
  assert.equal(classOf('run_python'), 'internal_write');
  assert.equal(classOf('org_create_task'), 'internal_write');
  assert.equal(classOf('org_read_board', {}, { readOnly: true }), 'read');
  assert.equal(classOf('gmail_draft'), 'external_reversible');
  assert.equal(classOf('gmail_send'), 'external_irreversible');
  assert.equal(classOf('msmail_send'), 'external_irreversible');
  assert.equal(classOf('drive_export_doc'), 'external_reversible');
  assert.equal(classOf('browser_open'), 'read');
  assert.equal(classOf('browser_act'), 'external_reversible');
  assert.equal(classOf('computer_screenshot'), 'external_irreversible');
  assert.equal(classOf('skill_weekly_review'), 'read');
  assert.equal(classOf('mcp_linear_create_issue'), 'external_reversible');
  assert.equal(classOf('mcp_linear_list_issues', {}, { readOnly: true }), 'read');
  assert.equal(classOf('mcp_stripe_create_payment'), 'money');
  assert.equal(classOf('tool_refund_order'), 'money');
  // input-aware: a guest outside the owner's domains is an invitation
  assert.equal(classOf('gcal_create_event', EVENT), 'external_reversible');
  assert.equal(classOf('gcal_create_event', { ...EVENT, attendees: ['ann@client.example'] }), 'external_irreversible');
  assert.equal(classOf('gcal_create_event', { ...EVENT, attendees: [{ email: 'me@example.com' }] }, {}, { ownDomains: ['example.com'] }), 'external_reversible');
  assert.equal(classOf('mscal_update_event', { eventId: 'e', attendees: 'x@y.co' }), 'external_irreversible');
  assert.equal(channelOf('gmail_send'), 'gmail');
  assert.equal(channelOf('mcp_linear_create_issue'), 'mcp_linear');
  assert.equal(stagingOf('gmail_send')?.twin, 'gmail_draft');
  assert.equal(stagingOf('gcal_create_event')?.implemented, false, 'declared, not implemented');
  const k1 = idempotencyKey({ sessionId: 's', scope: 'a', tool: 'gmail_send', input: { to: 'x', subject: 'y' } });
  const k2 = idempotencyKey({ sessionId: 's', scope: 'a', tool: 'gmail_send', input: { subject: 'y', to: 'x' } });
  assert.equal(k1, k2, 'canonical input: key order does not matter');
  assert.notEqual(k1, idempotencyKey({ sessionId: 's2', scope: 'a', tool: 'gmail_send', input: { to: 'x', subject: 'y' } }));
  for (const key of ['actions.externalPerHour', 'actions.irreversiblePerDay', 'actions.moneyPerDay', 'trust.promoteAfterClean', 'trust.demoteAfterRejections']) assert.ok(TUNABLES[key], key);
  assert.deepEqual([TUNABLES['actions.externalPerHour'].default, TUNABLES['actions.externalPerHour'].min, TUNABLES['actions.externalPerHour'].max], [30, 1, 500]);
});

test('unknown tools fail safe to external_reversible and the boot warning names them', async () => {
  assert.equal(classOf('mystery_tool'), 'external_reversible');
  assert.deepEqual(unclassified(['mystery_tool', 'fs_read', 'org_pulse', 'gmail_send']), ['mystery_tool']);
  const db = await testDb();
  const { stub } = memStorage();
  const tools = new ToolsService(stub);
  const specs = tools.specs.bind(tools);
  tools.specs = () => [...specs(), { name: 'mystery_tool', description: 'x', inputSchema: { type: 'object', properties: {} } }];
  const trust = new TrustService(db);
  const turns = new TurnLoopService(new ChatsRepository(db), new ChatLocks(), tools, ctxStub(new QueueProvider()), skillsStub(), stub, mcpStub(), new AgentsService(db, stub), new WorkspacesService(db, stub),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, new ActionsService(db, trust));
  const warned: string[] = [];
  (turns as unknown as { logger: { warn: (m: string) => void } }).logger.warn = (m: string) => { warned.push(m); };
  turns.onApplicationBootstrap();
  assert.equal(warned.length, 1);
  assert.match(warned[0], /mystery_tool/);
  assert.doesNotMatch(warned[0], /fs_write|gmail_send/);
});

test('the policy matrix: levels × classes, presence, staging; the supervised preset caps outward classes at 1', () => {
  // irreversible and money: 0–1 owner key (ask present, stage or hold unattended), 2 co-signer, 3 act
  assert.equal(decide({ cls: 'external_irreversible', level: 0, humanPresent: true, hasStaging: true }), 'ask');
  assert.equal(decide({ cls: 'external_irreversible', level: 1, humanPresent: false, hasStaging: true }), 'stage');
  assert.equal(decide({ cls: 'money', level: 1, humanPresent: false, hasStaging: false }), 'hold');
  assert.equal(decide({ cls: 'external_irreversible', level: 2, humanPresent: false, hasStaging: true }), 'cosign');
  assert.equal(decide({ cls: 'money', level: 3, humanPresent: false, hasStaging: false }), 'run');
  // reversible and internal: 0 proposes, 1 acts (+ notify unattended), 2–3 act
  assert.equal(decide({ cls: 'external_reversible', level: 0, humanPresent: false, hasStaging: false }), 'hold');
  assert.equal(decide({ cls: 'external_reversible', level: 0, humanPresent: true, hasStaging: false }), 'ask');
  assert.equal(decide({ cls: 'external_reversible', level: 1, humanPresent: false, hasStaging: false }), 'run_notify');
  assert.equal(decide({ cls: 'internal_write', level: 2, humanPresent: false, hasStaging: false }), 'run');
  assert.equal(decide({ cls: 'internal_write', level: 1, humanPresent: false, hasStaging: false }), 'run', 'internal writes at 1 act on the record alone');
  assert.equal(decide({ cls: 'read', level: 0, humanPresent: false, hasStaging: false }), 'run');
  // the preset
  assert.equal(effectiveLevel({ level: 3, ceiling: 3, orgMode: 'supervised', cls: 'external_irreversible' }), 1);
  assert.equal(effectiveLevel({ level: 2, ceiling: 2, orgMode: 'supervised', cls: 'external_reversible' }), 1);
  assert.equal(effectiveLevel({ level: 3, ceiling: 3, orgMode: 'supervised', cls: 'internal_write' }), 3, 'internal work is not capped');
  assert.equal(effectiveLevel({ level: 3, ceiling: 2, orgMode: 'autonomous', cls: 'external_reversible' }), 2, 'the ceiling bounds');
  assert.equal(describeMatrix().length, 5);
  // the arithmetic
  const t = { promoteAfterClean: 3, demoteAfterRejections: 2, calibration: null, calibrationBar: 0.7 };
  let row = { level: 1 as const, ceiling: 2 as const, cleanCount: 0, rejectStreak: 0 } as Parameters<typeof applyOutcome>[0];
  for (let i = 0; i < 2; i++) assert.equal(applyOutcome(row = applyOutcome(row, 'success', t).row, 'deduplicated', t).change, null);
  const promoted = applyOutcome(row, 'success', t);
  assert.deepEqual([promoted.change?.from, promoted.change?.to], [1, 2]);
  assert.equal(applyOutcome({ ...promoted.row, cleanCount: 9 }, 'success', t).change, null, 'never above the ceiling');
  assert.equal(applyOutcome({ level: 1, ceiling: 2, cleanCount: 5, rejectStreak: 0 }, 'success', { ...t, calibration: 0.4 }).change, null, 'below the calibration bar: no promotion');
  assert.equal(applyIncident({ level: 3, ceiling: 3, cleanCount: 4, rejectStreak: 0 }, 'critical', 'x').row.level, 0);
});

// ---- 2. idempotency ----

test('idempotent replay in a private chat: the retry returns the recorded result and does not act twice', async () => {
  const s = await setup();
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'chat', permissionMode: 'auto' });
  s.provider.call('gcal_create_event', EVENT);
  const first = resultOf(await run(s, chat.id, 'book the sync'));
  assert.match(first!.output, /Event created/);
  s.provider.call('gcal_create_event', { start: '2026-11-10', title: 'Sync' }); // same input, other key order
  const second = resultOf(await run(s, chat.id, 'book it again'));
  assert.match(second!.output, /Deduplicated: this exact call already succeeded/);
  assert.match(second!.output, /Event created/, 'the recorded result rides along');
  assert.equal(hits(s, 'calendar'), 1, 'the calendar was called once');
  const [row] = await rowsOf(s, 'gcal_create_event');
  assert.equal(row.status, 'succeeded');
  assert.equal(row.dedupeCount, 1);
  assert.equal(row.class, 'external_reversible');
  assert.equal(row.decision, 'run', 'level 1, a person present in Auto: acts');
  const recs = await s.db.select().from(trustRecords).where(eq(trustRecords.agentId, s.alice.id));
  assert.deepEqual(recs.map((r) => r.outcome).sort(), ['deduplicated', 'success'], 'the retry is neutral');
  // an internal write is logged but never deduplicated
  s.provider.call('fs_write', { path: 'notes.md', content: 'x' });
  s.provider.call('fs_write', { path: 'notes.md', content: 'x' });
  await run(s, chat.id, 'write twice');
  const fsRows = await rowsOf(s, 'fs_write');
  assert.equal(fsRows.length, 1);
  assert.equal(fsRows[0].dedupeCount, 0);
});

test('idempotent replay in an org run: a re-run of the task does not book the event twice', async () => {
  const s = await setup({ org: 'autonomous' });
  const o = s.org!;
  const task = await o.tasks.create(o.orgId, { title: 'Book the client sync', assigneeAgentId: s.alice.id });
  o.runtime.cancelWakesFor(o.orgId, s.alice.id);
  s.provider.call('gcal_create_event', EVENT);
  assert.equal(await o.runtime.runTask(o.orgId, task.id, s.alice.id, 'manual'), 'ran');
  s.provider.call('gcal_create_event', EVENT);
  assert.equal(await o.runtime.runTask(o.orgId, task.id, s.alice.id, 'manual'), 'ran');
  assert.equal(hits(s, 'calendar'), 1);
  const [row] = await rowsOf(s, 'gcal_create_event');
  assert.equal(row.orgId, o.orgId);
  assert.equal(row.dedupeCount, 1);
  assert.equal(row.decision, 'run_notify', 'level 1 unattended: acts, the owner hears after');
  const runSession = (await s.repo.listSessions(s.ws.id)).find((x) => x.taskId === task.id)!;
  assert.equal(runSession.kind, 'work', 'an org task run session is work (docs/work-log.md)');
  const events = await s.agents.listEvents(s.alice.id);
  assert.ok(events.some((e) => /Acted \(trust level 1/.test(e.title)), 'owner notified after');
});

// ---- 3. staging ----

test('staging: at low trust an unattended gmail_send becomes a draft; the owner key sends the draft; a retry is told it is waiting', async () => {
  const s = await setup();
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop · follow-ups', permissionMode: 'auto' });
  s.provider.call('gmail_send', MAIL);
  const r = resultOf(await run(s, loop.id, 'send the follow-up', 'loop'));
  assert.match(r!.output, /Staged, not sent/);
  assert.equal(hits(s, '/drafts'), 1);
  assert.equal(hits(s, '/messages/send'), 0, 'nothing was sent');
  const [row] = await rowsOf(s, 'gmail_send');
  assert.equal(row.status, 'staged');
  assert.equal(row.stagedRef, 'd1');
  assert.equal(row.decision, 'stage');
  assert.ok((await s.agents.listEvents(s.alice.id)).some((e) => e.kind === 'action_key' && /Staged, needs your key/.test(e.title)));
  // the retry does not stage a second draft
  s.provider.call('gmail_send', MAIL);
  assert.match(resultOf(await run(s, loop.id, 'send it', 'loop'))!.output, /Already waiting/);
  assert.equal(hits(s, '/drafts'), 1);
  // promotion
  const promoted = await s.controller.key(s.ws.id, row.id, { approve: true });
  assert.equal(promoted.status, 'succeeded');
  const send = s.calls.find((c) => c.url.includes('/drafts/send'))!;
  assert.deepEqual(JSON.parse(send.body), { id: 'd1' });
  const after = (await rowsOf(s, 'gmail_send'))[0];
  assert.equal(after.status, 'succeeded');
  assert.equal((JSON.parse(after.keys) as { owner?: { approve: boolean } }).owner?.approve, true);
  await assert.rejects(s.controller.key(s.ws.id, row.id, { approve: true }), /not waiting for a key/);
});

test('staging in an organization: a two_key approval card; the CEO approving sends, rejecting drops it and counts a rejection', async () => {
  const s = await setup({ org: 'autonomous' });
  const o = s.org!;
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop', permissionMode: 'auto' });
  s.provider.call('gmail_send', MAIL);
  await run(s, loop.id, 'send', 'loop');
  s.provider.call('gmail_send', { ...MAIL, subject: 'Second' });
  await run(s, loop.id, 'send another', 'loop');
  const cards = await s.db.select().from(orgApprovals).where(and(eq(orgApprovals.orgId, o.orgId), eq(orgApprovals.kind, 'two_key')));
  assert.equal(cards.length, 2);
  const [first, second] = cards.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  await o.approvals.decide(o.orgId, first.id, 'approve');
  assert.equal(hits(s, '/drafts/send'), 1);
  await o.approvals.decide(o.orgId, second.id, 'reject', 'wrong tone');
  assert.equal(hits(s, '/drafts/send'), 1, 'rejected: not sent');
  const rows = await rowsOf(s, 'gmail_send');
  assert.deepEqual(rows.map((r) => r.status).sort(), ['denied', 'succeeded']);
  const recs = await s.db.select().from(trustRecords).where(and(eq(trustRecords.agentId, s.alice.id), eq(trustRecords.actionClass, 'external_irreversible')));
  assert.deepEqual(recs.map((r) => r.outcome).sort(), ['rejected', 'success']);
  const chain = await s.db.select().from(orgAudit).where(eq(orgAudit.orgId, o.orgId));
  assert.ok(chain.some((a) => a.action === 'action_staged'));
  assert.ok(chain.some((a) => a.action === 'action_key_approved'));
});

// ---- 4. rate limits ----

test('outbound rate limits per class and channel: refused with the reason, and a signal for the chief in an org', async () => {
  const s = await setup({ org: 'autonomous' });
  const o = s.org!;
  const now = new Date().toISOString();
  const seed = async (n: number, cls: string, channel: string, tool: string) => {
    for (let i = 0; i < n; i++) {
      await s.db.insert(actionLog).values({ id: `${tool}-${i}`, key: `${tool}-${i}`, workspaceId: s.ws.id, agentId: s.alice.id, sessionId: 'x', tool, class: cls, channel, inputHash: 'h', status: 'succeeded', createdAt: now, finishedAt: now });
    }
  };
  await seed(20, 'external_irreversible', 'gmail', 'gmail_send');
  const irr = await s.actions.rateCheck(s.ws.id, 'external_irreversible', 'gmail');
  assert.equal(irr.ok, false);
  assert.match((irr as { reason: string }).reason, /actions\.irreversiblePerDay/);
  const money = await s.actions.rateCheck(s.ws.id, 'money', 'mcp_stripe');
  assert.match((money as { reason: string }).reason, /money-moving actions are off/);
  assert.equal((await s.actions.rateCheck(s.ws.id, 'internal_write', 'fs')).ok, true, 'internal work is not rate-limited');
  // per channel per hour, through a tunable on the org
  await o.org.setTunable(o.orgId, 'actions.externalPerHour', 1);
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop', permissionMode: 'auto' });
  s.provider.call('gcal_create_event', EVENT);
  assert.match(resultOf(await run(s, loop.id, 'book', 'loop'))!.output, /Event created/);
  s.provider.call('gcal_create_event', { ...EVENT, title: 'Another' });
  const refused = resultOf(await run(s, loop.id, 'book another', 'loop'))!;
  assert.equal(refused.isError, true);
  assert.match(refused.output, /Refused: .*on gcal in the last hour — the limit is 1 \(actions\.externalPerHour\)/);
  assert.equal(hits(s, 'calendar'), 1);
  assert.equal((await rowsOf(s, 'gcal_create_event')).find((r) => r.status === 'refused')?.class, 'external_reversible');
  const sig = await s.db.select().from(orgSignals).where(and(eq(orgSignals.orgId, o.orgId), eq(orgSignals.kind, 'action_rate_limit')));
  assert.equal(sig.length, 1);
  assert.equal(sig[0].addresseeKind, 'chief');
});

// ---- 5. two keys ----

test('two-key: the owner key — inline when a person is present, from the actions route when the call was held', async () => {
  const s = await setup();
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'chat', permissionMode: 'auto' });
  s.provider.call('gmail_send', MAIL);
  let asked = 0;
  await run(s, chat.id, 'send it', 'user', (ev) => { asked++; s.turns.resolveApproval(chat.id, ev.callId, 'allow-always'); });
  assert.equal(asked, 1, 'level 0 in Auto with a person present: the person is the second key');
  assert.equal(hits(s, '/messages/send'), 1);
  const [sent] = await rowsOf(s, 'gmail_send');
  assert.equal((JSON.parse(sent.keys) as { owner?: { inline?: boolean } }).owner?.inline, true);
  assert.equal(JSON.parse((await s.repo.getSession(chat.id))!.approvals || '{}').tools?.length ?? 0, 0, 'never remembered for an irreversible class');
  // an invitation (irreversible, staging declared but not built) is held for the owner's key
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop', permissionMode: 'auto' });
  s.provider.call('gcal_create_event', { ...EVENT, attendees: ['ann@client.example'] });
  const heldEv = resultOf(await run(s, loop.id, 'invite ann', 'loop'))!;
  assert.match(heldEv.output, /Held for the owner's key/);
  assert.equal(hits(s, 'calendar'), 0);
  const held = (await rowsOf(s, 'gcal_create_event'))[0];
  assert.deepEqual([held.status, held.class, held.decision], ['held', 'external_irreversible', 'hold']);
  // the live event carries the class, the action_log row and the held state (the SPA's key card), and GET …/actions/:id serves the row
  assert.deepEqual([heldEv.actionClass, heldEv.actionId, heldEv.held], ['external_irreversible', held.id, 'held']);
  assert.equal((await s.controller.one(s.ws.id, held.id)).tool, 'gcal_create_event');
  await assert.rejects(s.controller.one(s.ws.id, 'nope'), /action nope/);
  // only the owner or the CEO holds the key
  await assert.rejects(runWithViewer('single', { memberAccountId: 'member-1', role: 'member', workspaceId: s.ws.id, displayName: 'M' }, () => s.controller.key(s.ws.id, held.id, { approve: true })), /only the owner or the CEO/);
  const done = await s.controller.key(s.ws.id, held.id, { approve: true });
  assert.equal(done.status, 'succeeded');
  assert.equal(hits(s, 'calendar'), 1, 'ran through the turn loop executor on the key');
});

async function atLevel2(s: S) {
  await s.trust.setCeilings(s.ws.id, { external_irreversible: 2 });
  await s.trust.override(s.ws.id, s.alice.id, 'external_irreversible', 2, 'proven sender');
}

test('two-key: an agent co-signer on another model family approves — the send goes out, the co-signer turn is audited', async () => {
  const s = await setup();
  await atLevel2(s);
  const seen: Array<{ coSignerAgentId: string; call: { name: string } }> = [];
  s.actions.coSignFn = async (p) => { seen.push(p); return { verdict: 'approve', reason: 'within the client rules', model: 'gpt-5' }; };
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop', permissionMode: 'auto' });
  s.provider.call('gmail_send', MAIL);
  const r = resultOf(await run(s, loop.id, 'send', 'loop'))!;
  assert.match(r.output, /Email sent/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].coSignerAgentId, s.bob.id, 'a different member on another family');
  assert.equal(seen[0].call.name, 'gmail_send');
  const [row] = await rowsOf(s, 'gmail_send');
  const keys = JSON.parse(row.keys) as { agent?: { agentId: string; verdict: string; family: string } };
  assert.equal(keys.agent?.agentId, s.bob.id);
  assert.equal(keys.agent?.verdict, 'approve');
  assert.match(keys.agent!.family, /^openai:/);
  assert.equal(row.decision, 'cosign');
  assert.ok((await s.agents.listEvents(s.bob.id)).some((e) => /Co-signed \(approved\): gmail_send/.test(e.title)), 'the co-signer turn is on record');
});

test('two-key: the co-signer denies — nothing is sent and the ledger counts a rejection', async () => {
  const s = await setup();
  await atLevel2(s);
  s.actions.coSignFn = async () => ({ verdict: 'deny', reason: 'the recipient is not a known client', model: 'gpt-5' });
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop', permissionMode: 'auto' });
  s.provider.call('gmail_send', MAIL);
  const r = resultOf(await run(s, loop.id, 'send', 'loop'))!;
  assert.equal(r.isError, true);
  assert.match(r.output, /Denied by the co-signer/);
  assert.equal(hits(s, '/messages/send') + hits(s, '/drafts'), 0);
  const [row] = await rowsOf(s, 'gmail_send');
  assert.equal(row.status, 'denied');
  const recs = await s.db.select().from(trustRecords).where(and(eq(trustRecords.agentId, s.alice.id), eq(trustRecords.actionClass, 'external_irreversible')));
  assert.deepEqual(recs.map((x) => x.outcome), ['rejected']);
});

test('two-key: with no member on another model family the call is flagged single-family and falls back to the owner key (staged)', async () => {
  const s = await setup({ bobModel: { provider: 'anthropic', model: 'claude-sonnet-4-5' } });
  await atLevel2(s);
  let asked = 0;
  s.actions.coSignFn = async () => { asked++; return { verdict: 'approve', reason: 'x', model: 'x' }; };
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop', permissionMode: 'auto' });
  s.provider.call('gmail_send', MAIL);
  assert.match(resultOf(await run(s, loop.id, 'send', 'loop'))!.output, /Staged, not sent/);
  assert.equal(asked, 0, 'a same-family co-signer is no independent key');
  const [row] = await rowsOf(s, 'gmail_send');
  assert.equal((JSON.parse(row.keys) as { singleFamily?: boolean }).singleFamily, true);
  assert.equal(row.status, 'staged');
  assert.equal(hits(s, '/messages/send'), 0);
});

// ---- 6. the ledger ----

test('ledger: promotion after N clean outcomes, never above the ceiling; the owner hears of an outward promotion', async () => {
  const s = await setup();
  const before = await s.trust.effective(s.ws.id, s.alice.id, 'external_reversible');
  assert.deepEqual([before.level, before.ceiling], [1, 2], 'start level 1 under the default ceiling 2');
  for (let i = 0; i < 9; i++) assert.equal(await s.trust.record(s.ws.id, s.alice.id, 'external_reversible', 'success', { refType: 'action', refId: `a${i}` }), null);
  assert.equal(await s.trust.record(s.ws.id, s.alice.id, 'external_reversible', 'deduplicated', { refType: 'action', refId: 'dup' }), null, 'neutral');
  const change = await s.trust.record(s.ws.id, s.alice.id, 'external_reversible', 'success', { refType: 'action', refId: 'a9' });
  assert.deepEqual([change?.from, change?.to], [1, 2]);
  for (let i = 0; i < 12; i++) await s.trust.record(s.ws.id, s.alice.id, 'external_reversible', 'success', { refType: 'action', refId: `b${i}` });
  assert.equal((await s.trust.effective(s.ws.id, s.alice.id, 'external_reversible')).level, 2, 'capped at the ceiling');
  const ev = (await s.agents.listEvents(s.alice.id)).find((e) => e.kind === 'trust_change');
  assert.match(ev!.title, /Trust raised for external reversible: level 1 → 2/);
  // a new agent starts at min(ceiling, start) for every class
  const view = await s.controller.overview(s.ws.id);
  const bob = view.agents.find((a) => a.agentId === s.bob.id)!;
  assert.deepEqual(bob.classes.map((c) => [c.actionClass, c.level, c.ceiling]), [['read', 3, 3], ['internal_write', 2, 3], ['external_reversible', 1, 2], ['external_irreversible', 0, 1], ['money', 0, 0]]);
  assert.equal(view.agents.find((a) => a.agentId === s.alice.id)!.classes.find((c) => c.actionClass === 'external_reversible')!.counts.success, 22);
});

test('ledger: incidents from the bus demote at once — minor and major one level, critical to 0, no class = every class', async () => {
  const s = await setup({ org: 'autonomous' });
  const o = s.org!;
  await s.trust.setCeilings(s.ws.id, { external_reversible: 3 });
  await s.trust.override(s.ws.id, s.alice.id, 'external_reversible', 3, 'trusted');
  const emit = async (severity: 'minor' | 'major' | 'critical', actionClass: string | null, id: string) => {
    s.bus.emitOrgIncident({ orgId: o.orgId, incidentId: id, agentId: s.alice.id, actionClass, severity, kind: 'bounce' });
    await settle();
  };
  await emit('minor', 'external_reversible', 'i1');
  assert.equal((await s.trust.row(s.ws.id, s.alice.id, 'external_reversible')).level, 2);
  await emit('major', 'external_reversible', 'i2');
  const row = await s.trust.row(s.ws.id, s.alice.id, 'external_reversible');
  assert.equal(row.level, 1);
  assert.ok(row.lastIncidentAt);
  await emit('critical', null, 'i3');
  for (const cls of ['internal_write', 'external_reversible', 'external_irreversible', 'money'] as const) assert.equal((await s.trust.row(s.ws.id, s.alice.id, cls)).level, 0, cls);
  assert.equal((await s.trust.row(s.ws.id, s.alice.id, 'read')).level, 3, 'reads are untouched');
  const chain = await s.db.select().from(orgAudit).where(and(eq(orgAudit.orgId, o.orgId), eq(orgAudit.action, 'trust_change')));
  assert.ok(chain.length >= 4, 'level changes are on the audit chain');
  s.bus.emitOrgIncident({ orgId: o.orgId, incidentId: 'i4', agentId: null, actionClass: null, severity: 'critical', kind: 'outage' });
  await settle();
  assert.equal((await s.trust.row(s.ws.id, s.bob.id, 'internal_write')).level, 2, 'an incident with no actor changes no one');
});

test('ledger: a review rejection streak demotes one level; an accepted review counts clean; a reported revert demotes', async () => {
  const s = await setup({ org: 'autonomous' });
  const o = s.org!;
  const task = await o.tasks.create(o.orgId, { title: 'Draft the brief', assigneeAgentId: s.alice.id });
  for (let i = 0; i < 2; i++) await o.tasks.review(o.orgId, task.id, { verdict: 'request_changes', note: 'thin', byAgentId: s.bob.id });
  assert.equal((await s.trust.row(s.ws.id, s.alice.id, 'internal_write')).level, 2);
  await o.tasks.review(o.orgId, task.id, { verdict: 'request_changes', note: 'still thin', byAgentId: s.bob.id });
  const r = await s.trust.row(s.ws.id, s.alice.id, 'internal_write');
  assert.equal(r.level, 1, `three in a row (trust.demoteAfterRejections) → one down: ${r.reason}`);
  assert.match(r.reason, /3 rejection/);
  await o.tasks.review(o.orgId, task.id, { verdict: 'accept', byAgentId: s.bob.id });
  assert.equal((await s.trust.row(s.ws.id, s.alice.id, 'internal_write')).cleanCount, 1);
  // revert report on a succeeded outward action
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'chat', permissionMode: 'auto' });
  s.provider.call('gcal_create_event', EVENT);
  await run(s, chat.id, 'book');
  const [row] = await rowsOf(s, 'gcal_create_event');
  const reverted = await s.controller.revert(s.ws.id, row.id, { note: 'wrong day' });
  assert.ok(reverted.revertedAt);
  await settle();
  assert.equal((await s.trust.row(s.ws.id, s.alice.id, 'external_reversible')).level, 0, 'a revert is one level down at once');
  // an org member's revert opens item 29's `revert` incident; its demotion is the only one
  const inc = await s.db.select().from(orgIncidents).where(and(eq(orgIncidents.orgId, o.orgId), eq(orgIncidents.kind, 'revert')));
  assert.equal(inc.length, 1);
  assert.equal(inc[0].agentId, s.alice.id);
  assert.equal(inc[0].actionClass, 'external_reversible');
  const evidence = await s.db.select().from(trustRecords).where(and(eq(trustRecords.agentId, s.alice.id), eq(trustRecords.actionClass, 'external_reversible')));
  assert.deepEqual(evidence.map((r) => r.outcome).filter((x) => x !== 'success'), ['incident'], 'no double demotion: the incident, not a separate revert record');
  await assert.rejects(s.controller.revert(s.ws.id, row.id, { note: 'again' }), /already reported/);
  const listed = await s.controller.list(s.ws.id, s.alice.id, 'external_reversible');
  assert.equal(listed.length, 1);
  await assert.rejects(s.controller.list(s.ws.id, undefined, 'nonsense'), /unknown action class/);
});

test('ceilings and the owner override are bounded: lowering a ceiling lowers levels; overrides need a reason, stay ≤ ceiling and are owner-only', async () => {
  const s = await setup();
  await s.trust.override(s.ws.id, s.alice.id, 'external_reversible', 2, 'good month');
  const set = await s.controller.ceilings(s.ws.id, { ceilings: { external_reversible: 1 } });
  assert.equal(set.ceilings.external_reversible, 1);
  const r = await s.trust.row(s.ws.id, s.alice.id, 'external_reversible');
  assert.deepEqual([r.level, r.ceiling], [1, 1]);
  await assert.rejects(s.controller.override(s.ws.id, s.alice.id, 'external_reversible', { level: 2, reason: 'x' }), /above the external_reversible ceiling/);
  await assert.rejects(s.trust.override(s.ws.id, s.alice.id, 'external_reversible', 1, ' '), /reason is required/);
  await assert.rejects(s.trust.override(s.ws.id, s.alice.id, 'bogus', 1, 'x'), /unknown action class/);
  await assert.rejects(s.controller.ceilings(s.ws.id, { money: 4 }), /integer 0–3/);
  const member = { memberAccountId: 'member-1', role: 'member' as const, workspaceId: s.ws.id, displayName: 'M' };
  await assert.rejects(runWithViewer('single', member, () => s.controller.ceilings(s.ws.id, { money: 1 })), /only the owner or the CEO/);
  await assert.rejects(runWithViewer('single', member, () => s.trust.override(s.ws.id, s.alice.id, 'external_reversible', 0, 'x')), /only the owner or the CEO/);
  const ok = await s.controller.override(s.ws.id, s.alice.id, 'external_reversible', { level: 0, reason: 'pause outward work' });
  assert.equal(ok.level, 0);
  assert.match(ok.reason, /owner: pause outward work/);
});

test('the supervised preset caps outward classes at 1 whatever the ledger says; autonomous uses the ceilings', async () => {
  const s = await setup({ org: 'supervised' });
  await s.trust.setCeilings(s.ws.id, { external_irreversible: 3 });
  await s.trust.override(s.ws.id, s.alice.id, 'external_irreversible', 3, 'x');
  await s.trust.override(s.ws.id, s.alice.id, 'external_reversible', 2, 'x');
  const e = await s.trust.effective(s.ws.id, s.alice.id, 'external_irreversible');
  assert.deepEqual([e.level, e.effective, e.orgMode], [3, 1, 'supervised']);
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop', permissionMode: 'auto' });
  s.provider.call('gmail_send', MAIL);
  assert.match(resultOf(await run(s, loop.id, 'send', 'loop'))!.output, /Staged, not sent/, 'level 3 earned, capped at 1 by the preset');
  s.provider.call('gcal_create_event', EVENT);
  await run(s, loop.id, 'book', 'loop');
  assert.equal((await rowsOf(s, 'gcal_create_event'))[0].decision, 'run_notify', 'reversible capped at 1: act and notify');
  await s.org!.mode.setMode(s.ws.id, { mode: 'autonomous', chiefOfStaffAgentId: s.org!.chief.id, monthlyUsd: 50, agentCap: 10 });
  assert.equal((await s.trust.effective(s.ws.id, s.alice.id, 'external_irreversible')).effective, 3);
});

test('parity: the same agent at the same level gets the same decision in a private chat and an org run', async () => {
  const s = await setup({ org: 'autonomous' });
  const o = s.org!;
  await s.trust.override(s.ws.id, s.alice.id, 'external_reversible', 2, 'x');
  // level 2 reversible: a private Auto chat and an org run both act
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'chat', permissionMode: 'auto' });
  s.provider.call('gcal_create_event', { ...EVENT, title: 'Private' });
  await run(s, chat.id, 'book');
  const task = await o.tasks.create(o.orgId, { title: 'Book', assigneeAgentId: s.alice.id });
  o.runtime.cancelWakesFor(o.orgId, s.alice.id);
  s.provider.call('gcal_create_event', { ...EVENT, title: 'Org' });
  await o.runtime.runTask(o.orgId, task.id, s.alice.id, 'manual');
  const cal = await rowsOf(s, 'gcal_create_event');
  assert.equal(cal.length, 2);
  assert.deepEqual(cal.map((r) => [r.decision, r.level, r.status]), [['run', 2, 'succeeded'], ['run', 2, 'succeeded']]);
  // level 0 irreversible, nobody at the keyboard: a private loop and an org run both stage
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop', permissionMode: 'auto' });
  s.provider.call('gmail_send', { ...MAIL, subject: 'Private' });
  await run(s, loop.id, 'send', 'loop');
  s.provider.call('gmail_send', { ...MAIL, subject: 'Org' });
  await o.runtime.runTask(o.orgId, task.id, s.alice.id, 'manual');
  const mail = await rowsOf(s, 'gmail_send');
  assert.deepEqual(mail.map((r) => [r.decision, r.level, r.status]), [['stage', 0, 'staged'], ['stage', 0, 'staged']]);
  assert.deepEqual(mail.map((r) => Boolean(r.orgId)), [true, true], 'both rows know the org; the decision does not depend on it');
});

// ---- 7. incidents (item 29) meet the ledger ----

test('incidents naming a tool demote its class; a freeze stores the class and holds every member\'s call of it whatever the level, in every kind of session', async () => {
  assert.equal(normalizeActionClass('gmail_send'), 'external_irreversible');
  assert.equal(normalizeActionClass('external_reversible'), 'external_reversible');
  assert.equal(normalizeActionClass(null), null);
  const s = await setup({ org: 'autonomous' });
  const o = s.org!;
  await s.trust.override(s.ws.id, s.alice.id, 'external_reversible', 2, 'x');
  // a connection incident writes the tool name; the ledger maps it to its class
  s.bus.emitOrgIncident({ orgId: o.orgId, incidentId: 'b1', agentId: s.alice.id, actionClass: 'gmail_draft', severity: 'minor', kind: 'delivery_failure' });
  await settle();
  assert.equal((await s.trust.row(s.ws.id, s.alice.id, 'external_reversible')).level, 1, 'gmail_draft → external_reversible, one down');
  assert.equal((await s.trust.row(s.ws.id, s.alice.id, 'internal_write')).level, 2, 'other classes untouched');
  // the CEO's critical report freezes the class; containment stores the class name, not the tool
  await s.trust.setCeilings(s.ws.id, { external_irreversible: 3 });
  await s.trust.override(s.ws.id, s.bob.id, 'external_irreversible', 3, 'trusted sender');
  await o.incidents.report(o.orgId, { title: 'Alice mailed the wrong price', detail: 'x', severity: 'critical', agentId: s.alice.id, actionClass: 'gmail_send' }, { detectedBy: 'owner' });
  await settle();
  const org = (await s.db.select().from(organizations).where(eq(organizations.id, o.orgId)))[0];
  assert.deepEqual(JSON.parse(org.frozenClasses), ['external_irreversible']);
  assert.equal(await o.incidents.isFrozen(o.orgId, 'gmail_send'), true, 'a tool name asks about its class');
  assert.equal(await o.incidents.isFrozen(o.orgId, 'gmail_draft'), false);
  // the critical report also dropped autonomous to supervised; go back so only the freeze bites
  await o.mode.setMode(s.ws.id, { mode: 'autonomous', chiefOfStaffAgentId: o.chief.id, monthlyUsd: 50, agentCap: 10 });
  assert.equal((await s.trust.effective(s.ws.id, s.bob.id, 'external_irreversible')).effective, 3);
  // Bob — level 3, unattended: held, not sent
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.bob.id, name: 'Loop', permissionMode: 'auto' });
  s.provider.call('gmail_send', MAIL);
  const held = resultOf(await run(s, loop.id, 'send', 'loop'))!;
  assert.match(held.output, /Held for the owner's key: .*an incident froze external irreversible actions/);
  // Bob in an Ask-mode chat with a person present: held too, nobody is asked inline
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.bob.id, name: 'chat', permissionMode: 'ask' });
  s.provider.call('gmail_send', { ...MAIL, subject: 'Other' });
  let asked = 0;
  const r2 = resultOf(await run(s, chat.id, 'send', 'user', () => { asked++; }))!;
  assert.equal(asked, 0);
  assert.match(r2.output, /Held for the owner's key/);
  assert.equal(hits(s, '/messages/send') + hits(s, '/drafts'), 0, 'nothing reached Gmail');
  const rows = await rowsOf(s, 'gmail_send');
  assert.deepEqual(rows.map((r) => [r.decision, r.status]), [['frozen', 'held'], ['frozen', 'held']]);
  // an unfrozen class is unaffected
  s.provider.call('gcal_create_event', EVENT);
  assert.match(resultOf(await run(s, loop.id, 'book', 'loop'))!.output, /Event created/);
  // the owner's key still runs a held call
  await s.controller.key(s.ws.id, rows[0].id, { approve: true });
  assert.equal(hits(s, '/messages/send'), 1);
});
