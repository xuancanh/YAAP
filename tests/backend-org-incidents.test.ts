/** Incidents, degradation and audit independence (docs/incidents.md,
 *  execution-plan item 29): every detection source opens one incident per
 *  ref while it is open; containment by severity (note, pause, freeze,
 *  autonomous → supervised) recorded so resolving with undo reverses it; the
 *  owner's one words-first line; the postmortem for major incidents; the
 *  OrgIncidentEvent the trust ledger consumes; the brief's Incidents and
 *  Degraded sections and the health route; provider failover with parity
 *  and recovery after a probe; a revoked connection refusing only what
 *  needs it with one signal; the CEO's spot checks as precision and recall;
 *  the auditor seat's rotation; red-team canaries against record-only tools. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { orgAudits, orgIncidents, orgTasks, connections as connectionsTable } from '../server/src/database/schema';
import { testDb, memStorage, mcpStub } from './helpers';
import { seal } from '../server/src/common/secretbox';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { TurnContextService } from '../server/src/chats/turn-context.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus, type OrgIncidentEvent } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { AgentTypesService } from '../server/src/agent-types/agent-types.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { ConnectionsService, ConnectionDegradedError } from '../server/src/connections/connections.service';
import { ProviderHealthService, isTransientProviderError } from '../server/src/ai/provider-health';
import type { AiProviderFactory } from '../server/src/ai/providers.factory';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
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
import { OrgSloService } from '../server/src/org/org-slo.service';
import { OrgMeetingsService } from '../server/src/org/org-meetings.service';
import { OrgPlaybooksService } from '../server/src/org/org-playbooks.service';
import { OrgKnowledgeService } from '../server/src/org/org-knowledge.service';
import { OrgMemoryService } from '../server/src/org/org-memory.service';
import { OrgAuditorService, auditorQuality, type SpotCard } from '../server/src/org/org-auditor.service';
import { OrgIncidentsService, isExternalClass, ownerLine, parseContainment } from '../server/src/org/org-incidents.service';
import { OrgRedTeamService, canaryText, breachedBy } from '../server/src/org/org-redteam.service';
import { INCIDENT_TUNABLES } from '../server/src/org/incident-tunables';
import { TUNABLES } from '../server/src/org/org-tunables';
import { IncidentsController } from '../server/src/org/incidents.controller';
import { OrgSensingService } from '../server/src/org/org-sensing.service';
import { LoopsService } from '../server/src/chats/loops.service';
import { DistillService } from '../server/src/chats/distill.service';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

type Plan = (req: AiRequest, toolRound: number) => AiStreamEvent[];
const lastUser = (req: AiRequest): string => [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
const say = (text: string): AiStreamEvent[] => [{ type: 'answer', text }];
const call = (name: string, input: Record<string, unknown>): AiStreamEvent[] => [{ type: 'tool_call', id: `c-${Math.random().toString(36).slice(2, 8)}`, name, input }];

/** A provider whose reply is a function of the request; `fail` makes it throw like an overloaded upstream. */
class PlanProvider implements AiProvider {
  readonly requests: AiRequest[] = [];
  fail: string | null = null;
  constructor(readonly name: string, public plan: Plan) {}
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    if (this.fail) throw new Error(this.fail);
    const toolRound = req.messages.filter((m) => m.role === 'tool').length;
    for (const ev of this.plan(req, toolRound)) yield ev;
    yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
    yield { type: 'done' };
  }
}

const GMAIL_SCOPES = '["https://www.googleapis.com/auth/calendar.readonly","https://www.googleapis.com/auth/gmail.compose"]';
const MS_SCOPES = '["openid","email","offline_access","User.Read","Calendars.Read","Calendars.ReadWrite","Mail.ReadWrite","Mail.Send"]';
const jsonResponse = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

async function setup(plan: Plan = () => say('ok'), opts: { failover?: boolean } = {}) {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : ({ googleClientId: 'gc', googleClientSecret: 'gs', msClientId: 'mc', msClientSecret: 'ms', publicBaseUrl: 'http://localhost:8790' } as Record<string, string>)[k]) } as unknown as ConfigService;
  const fetched: string[] = [];
  const connections = new ConnectionsService(db, config);
  let fetchPlan: (url: string) => Response = () => jsonResponse({ value: [], id: 'm1' });
  connections.fetchImpl = (async (url: string) => { fetched.push(String(url)); return fetchPlan(String(url)); }) as unknown as typeof fetch;
  let executed = 0;
  const realExecute = connections.execute.bind(connections);
  connections.execute = async (...args: Parameters<ConnectionsService['execute']>) => { executed++; return realExecute(...args); };
  const health = new ProviderHealthService();
  const provider = new PlanProvider('anthropic', plan);
  const fallbackProvider = new PlanProvider('openai', () => say('fallback ok'));
  const agentMemory = new AgentMemoryService(db, stub);
  const types = new AgentTypesService(db);
  const factory = { resolve: (name: string) => (name.startsWith('anthropic') ? provider : name === 'openai' ? fallbackProvider : provider), defaultBaseUrl: () => undefined } as unknown as AiProviderFactory;
  const context = opts.failover
    ? new TurnContextService(factory, types, agents, agentMemory, workspaces, config, undefined, undefined, undefined, health)
    : ({ build: async () => ({ provider, model: 'test-model', system: '', maxToolRounds: 24 }) } as unknown as TurnContextService);
  const skillsSvc = new SkillsService(db);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), context, skillsSvc, stub, mcpStub(), agents, workspaces, connections, undefined, undefined, undefined, undefined, undefined, undefined, undefined, health);
  const announced: string[] = [];
  const announcer = new OrgAnnouncer({ announce: async (_ws, text) => { announced.push(text); } });
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const intent = new OrgIntentService(db, org, units, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, skillsSvc, bus);
  const signals = new OrgSignalsService(db, org, tasks, audit, agents, workspaces, bus, units);
  const slo = new OrgSloService(db, org, tasks, approvals, audit, workspaces, signals);
  const meetings = new OrgMeetingsService(db, org, units, tasks, audit, agents, workspaces, approvals);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, signals, slo, intent, meetings);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, signals, slo, intent);
  runtime.debounceMs = 600_000;
  const playbooks = new OrgPlaybooksService(db, org, tasks, audit, agents, skillsSvc, announcer);
  const knowledge = new OrgKnowledgeService(db, org, tasks, audit, agents, workspaces, repo, turns, runtime);
  const memory = new OrgMemoryService(db, org, tasks, audit, agents, meetings, approvals, runtime, turns, playbooks, knowledge, config, units, signals, undefined, agentMemory, bus);
  const auditor = new OrgAuditorService(db, org, tasks, audit, agents, workspaces, repo, turns, runtime, announcer, signals, config);
  const sensing = new OrgSensingService(db, org, audit, tasks, approvals, agents, config, turns, runtime, units, signals, connections, stub, undefined);
  const incidents = new OrgIncidentsService(db, org, tasks, audit, agents, workspaces, runtime, turns, repo, config, signals, memory, brief, announcer, bus, auditor, connections, health, sensing);
  const redteam = new OrgRedTeamService(db, org, tasks, audit, agents, workspaces, repo, turns, runtime, incidents, config, signals);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const controller = new IncidentsController(mode, org, incidents, config, redteam);
  const emitted: OrgIncidentEvent[] = [];
  bus.onOrgIncident((ev) => emitted.push(ev));
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write the newsletter.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit drafts.' });
  return {
    db, agents, workspaces, repo, turns, provider, fallbackProvider, sensing, types, health, connections, bus, audit, org, units, tasks, approvals, signals, slo, meetings, brief, runtime, memory, auditor, incidents, redteam, mode, controller, ws, chief, writer, editor, announced, emitted, fetched,
    setFetch: (fn: (url: string) => Response) => { fetchPlan = fn; },
    executed: () => executed,
  };
}
type S = Awaited<ReturnType<typeof setup>>;

async function enable(s: S, modeName: 'supervised' | 'autonomous' = 'supervised') {
  const st = await s.mode.setMode(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: 10 });
  const orgId = st.orgId!;
  await s.org.updateMember(orgId, s.writer.id, { title: 'Writer' });
  await s.org.updateMember(orgId, s.editor.id, { title: 'Editor' });
  return orgId;
}
const inbox = async (s: S, agentId: string, kind?: string) => (await s.agents.listEvents(agentId, 200)).filter((e) => !kind || e.kind === kind);
const memberStatus = async (s: S, orgId: string, agentId: string) => (await s.org.member(orgId, agentId))?.status;

// ---- 1. breaker (loop) → major: dedupe, pause, wakes dropped, owner line, postmortem, the bus ----

test('a loop breaker trip opens one major incident (deduplicated per task while open), pauses the member and drops its queued wakes, tells the owner once in words, schedules a postmortem and emits the OrgIncidentEvent', async () => {
  const s = await setup((req) => (/You were woken for task/.test(lastUser(req)) ? call('org_task_comment', { text: 'still working' }) : say('ok')));
  const orgId = await enable(s);
  const task = await s.tasks.create(orgId, { title: 'Draft issue 12', brief: { outcome: 'A draft', done_when: 'Saved' }, assigneeAgentId: s.writer.id });
  const other = await s.tasks.create(orgId, { title: 'Draft issue 13', brief: { outcome: 'A draft', done_when: 'Saved' }, assigneeAgentId: s.writer.id });
  s.runtime.wake({ orgId, taskId: other.id, agentId: s.writer.id, reason: 'manual' });
  assert.ok(s.runtime.pendingWakeKeys().includes(`${other.id}:${s.writer.id}`));

  assert.equal(await s.runtime.runTask(orgId, task.id, s.writer.id, 'manual'), 'ran');
  await s.incidents.idle();
  const rows = await s.incidents.list(orgId);
  assert.equal(rows.length, 1);
  const inc = rows[0];
  assert.equal(inc.kind, 'breaker');
  assert.equal(inc.severity, 'major');
  assert.equal(inc.status, 'contained');
  assert.equal(inc.agentId, s.writer.id);
  assert.equal(inc.refType, 'task'); assert.equal(inc.refId, task.id);
  assert.equal(inc.detectedBy, 'system');
  assert.deepEqual(parseContainment(inc.containment).map((c) => c.action), ['note', 'pause_member', 'cancel_wakes']);
  assert.equal(await memberStatus(s, orgId, s.writer.id), 'paused');
  assert.deepEqual(s.runtime.pendingWakeKeys(), [], 'the queued wake of the paused member is dropped');
  // the owner's one line, words first, pushed
  const told = await inbox(s, s.chief.id, 'org_incident');
  assert.equal(told.length, 1);
  assert.equal(told[0].title, 'Paused Writer after it repeated the same tool call; nothing external was sent.');
  assert.equal(told[0].channel, 1);
  assert.match(told[0].body, /postmortem retro is scheduled/);
  // the postmortem (item 22's machinery, trigger `incident`)
  assert.ok(inc.postmortemMeetingId, 'a retro was scheduled');
  const retro = await s.meetings.get(orgId, inc.postmortemMeetingId!);
  assert.equal(retro.kind, 'retro');
  assert.match(retro.agenda, /\*\*Why this retro\*\*: a major or critical incident was opened and contained\./);
  assert.match(retro.agenda, /Incident \w{8} \(major, breaker/);
  // the trust ledger's seam
  assert.deepEqual(s.emitted, [{ orgId, incidentId: inc.id, agentId: s.writer.id, actionClass: null, severity: 'major', kind: 'breaker' }]);
  // a second trip on the same task joins the open incident
  const again = await s.incidents.open(orgId, { kind: 'breaker', severity: 'major', title: 'again', agentId: s.writer.id, refType: 'task', refId: task.id });
  assert.equal(again.created, false);
  assert.equal(again.incident.id, inc.id);
  assert.equal((await s.incidents.list(orgId)).length, 1);
  assert.equal(s.emitted.length, 1);
  const actions = (await s.audit.list(orgId, { limit: 300 })).map((r) => r.action);
  assert.ok(actions.includes('incident_open') && actions.includes('member_pause') && actions.includes('postmortem_scheduled'));
  assert.equal((await s.audit.verify(orgId)).ok, true);
});

// ---- 2. no-progress (major) and budget stop (minor, note only) ----

test('a no-progress block is a major incident; a budget hard stop is a minor one that only signals and notes — each once per ref while open', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const task = await s.tasks.create(orgId, { title: 'Research sources', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.editor.id });
  await s.incidents.onBreaker({ orgId, agentId: s.editor.id, taskId: task.id, kind: 'no_progress', detail: 'Editor ran 5 times without progress' });
  await s.incidents.onBreaker({ orgId, agentId: s.writer.id, taskId: task.id, kind: 'budget_stop', detail: 'no headroom', scope: 'agent', refId: s.writer.id });
  await s.incidents.onBreaker({ orgId, agentId: s.writer.id, taskId: task.id, kind: 'budget_stop', detail: 'no headroom', scope: 'agent', refId: s.writer.id });
  const rows = await s.incidents.list(orgId);
  assert.equal(rows.length, 2);
  const np = rows.find((r) => r.kind === 'breaker')!;
  assert.equal(np.severity, 'major');
  assert.equal(await memberStatus(s, orgId, s.editor.id), 'paused');
  const budget = rows.find((r) => r.kind === 'budget_stop')!;
  assert.equal(budget.severity, 'minor');
  assert.equal(budget.status, 'open', 'note only: nothing contained');
  assert.deepEqual(parseContainment(budget.containment).map((c) => c.action), ['note']);
  assert.equal(await memberStatus(s, orgId, s.writer.id), 'active');
  assert.equal(budget.postmortemMeetingId, null, 'no postmortem for a minor incident');
  const sig = (await s.signals.list(orgId, { kind: 'incident' })).find((x) => x.refId === budget.id)!;
  assert.ok(sig, 'the minor incident is a signal');
  assert.equal(sig.addresseeId, s.writer.id);
  const told = await inbox(s, s.chief.id, 'org_incident');
  assert.equal(told.length, 2, 'one owner event per incident');
  const line = told.find((e) => /envelope ran out/.test(e.title))!;
  assert.equal(line.title, 'Noted after the agent envelope ran out; nothing external was sent.');
  assert.equal(line.channel, 0, 'a minor incident is not pushed');
});

// ---- 3. owner complaint, critical with an external class: pause + freeze + supervised; resolve with undo ----

test('the CEO\'s critical report pauses the member, freezes its external action class and drops autonomous to supervised; resolving with undo reverses all three with the CEO\'s note', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous');
  const v = await s.controller.report(s.ws.id, { title: 'Writer emailed a customer the wrong price', detail: 'The quote said $9 instead of $90.', severity: 'critical', agentId: s.writer.id, actionClass: 'gmail_send' });
  assert.equal(v.kind, 'owner_report'); assert.equal(v.detectedBy, 'owner'); assert.equal(v.severity, 'critical');
  assert.equal(v.status, 'contained');
  assert.deepEqual(v.containment.filter((c) => c.reversible).map((c) => c.action), ['pause_member', 'freeze_class', 'supervised']);
  assert.equal(await memberStatus(s, orgId, s.writer.id), 'paused');
  assert.equal(await s.incidents.isFrozen(orgId, 'gmail_send'), true);
  assert.equal(await s.incidents.isFrozen(orgId, 'gmail_draft'), false);
  assert.equal((await s.workspaces.get(s.ws.id)).orgMode, 'supervised');
  const told = (await inbox(s, s.chief.id, 'org_incident'))[0];
  assert.equal(told.title, 'Paused Writer, froze gmail_send for the workspace and switched the company to supervised after your report (Writer emailed a customer the wrong price); nothing external was sent.');
  assert.ok(s.announced.some((a) => /supervised mode after a critical incident/.test(a)));
  // health says it
  const h = await s.controller.health(s.ws.id);
  assert.equal(h.status, 'incident');
  assert.deepEqual(h.frozenClasses, ['gmail_send']);
  assert.equal(h.pausedByIncident[0].agentId, s.writer.id);
  // resolution needs a note; undo reverses what is still in force
  await assert.rejects(s.controller.resolve(s.ws.id, v.id, { resolution: ' ' }), /resolution is required/);
  const r = await s.controller.resolve(s.ws.id, v.id, { resolution: 'Price list fixed; Writer now quotes from the sheet.', undo: true });
  assert.equal(r.status, 'resolved');
  assert.equal(r.resolution, 'Price list fixed; Writer now quotes from the sheet.');
  assert.ok(r.containment.filter((c) => c.reversible).every((c) => c.undone));
  assert.equal(await memberStatus(s, orgId, s.writer.id), 'active');
  assert.equal(await s.incidents.isFrozen(orgId, 'gmail_send'), false);
  assert.equal((await s.workspaces.get(s.ws.id)).orgMode, 'autonomous');
  const actions = (await s.audit.list(orgId, { limit: 300 })).map((x) => x.action);
  assert.ok(['class_freeze', 'class_unfreeze', 'incident_resolve', 'member_resume'].every((a) => actions.includes(a)));
  // resolving without undo leaves containment in place
  const v2 = await s.controller.report(s.ws.id, { title: 'Editor leaked a draft', detail: 'Posted to the wrong channel.', severity: 'major', agentId: s.editor.id });
  await s.controller.resolve(s.ws.id, v2.id, { resolution: 'Talked it through.' });
  assert.equal(await memberStatus(s, orgId, s.editor.id), 'paused', 'no undo: the member stays paused for the CEO to resume');
  // bounds: a critical incident always pauses at least
  assert.equal(INCIDENT_TUNABLES['incidents.containCritical'].min, 1);
  await assert.rejects(s.org.setTunable(orgId, 'incidents.containCritical', 0), /must stay within 1–3/);
});

// ---- 4. a critical auditor finding → critical incident; manual containment ----

test('a critical audit finding opens a critical incident about the task\'s owner (detected by the auditor); the CEO can add containment by hand and only the decider may', async () => {
  const s = await setup((req, toolRound) => {
    if (/Organisation audit/.test(req.system ?? '')) return toolRound === 0 ? call('org_audit_finding', { severity: 'critical', kind: 'done_when_unmet', refType: 'task', refId: TASK.id, title: 'Issue 12 accepted without the file', detail: 'No file saved.' }) : toolRound === 1 ? call('org_audit_close', { summary: 'One problem.' }) : say('closed');
    return say('ok');
  });
  const TASK = { id: '' };
  const orgId = await enable(s);
  const auditorAgent = await s.agents.create({ name: 'Auditor', charter: 'You audit.' });
  await s.org.addMember(orgId, { agentId: auditorAgent.id, title: 'Auditor', reportsToAgentId: s.chief.id });
  await s.org.update(orgId, { auditorAgentId: auditorAgent.id });
  const t = await s.tasks.create(orgId, { title: 'Write issue 12', brief: { outcome: 'A draft', done_when: 'Saved' }, assigneeAgentId: s.writer.id });
  TASK.id = t.id;
  await s.db.update(orgTasks).set({ status: 'done' }).where(eq(orgTasks.id, t.id));
  assert.equal(await s.auditor.runAudit(orgId, 'manual'), 'ran');
  await s.incidents.idle();
  const inc = (await s.incidents.list(orgId)).find((r) => r.kind === 'audit_critical')!;
  assert.ok(inc, 'the critical finding is an incident');
  assert.equal(inc.severity, 'critical');
  assert.equal(inc.detectedBy, 'auditor');
  assert.equal(inc.agentId, s.writer.id, 'about the accepted task\'s owner');
  assert.equal(inc.refId, `done_when_unmet:${t.id}`);
  assert.equal(await memberStatus(s, orgId, s.writer.id), 'paused');
  // manual: pause the whole company, then resolve with undo resumes it
  const c = await s.controller.contain(s.ws.id, inc.id, { action: 'pause_org' });
  assert.equal(c.containment.at(-1)!.action, 'pause_org');
  assert.equal((await s.org.get(orgId)).status, 'paused');
  await assert.rejects(s.controller.contain(s.ws.id, inc.id, { action: 'freeze_class' }), /names no action class/);
  await s.controller.resolve(s.ws.id, inc.id, { resolution: 'Rebriefed the done_when.', undo: true });
  assert.equal((await s.org.get(orgId)).status, 'active');
  assert.equal(await memberStatus(s, orgId, s.writer.id), 'active');
});

// ---- 5. failed check after acceptance / owner revert ----

test('a failed executable check after acceptance and an owner revert are major incidents on the task (reportIncident, the seam items 27–28 call), one per task while open', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const t = await s.tasks.create(orgId, { title: 'Publish the issue', brief: { outcome: 'x', done_when: 'link check passes' }, assigneeAgentId: s.writer.id });
  const a = await s.incidents.reportIncident(orgId, { kind: 'check_failed', taskId: t.id, title: 'Link check failed after acceptance of "Publish the issue"', detail: '2 broken links' });
  assert.equal(a.created, true);
  assert.equal(a.incident.severity, 'major');
  assert.equal(a.incident.agentId, s.writer.id, 'the task owner by default');
  const again = await s.incidents.reportIncident(orgId, { kind: 'check_failed', taskId: t.id, title: 'again' });
  assert.equal(again.created, false);
  const rv = await s.incidents.reportIncident(orgId, { kind: 'revert', taskId: t.id, agentId: s.editor.id, title: 'The owner reverted "Publish the issue"', actionClass: 'publish' });
  assert.equal(rv.created, true, 'a different kind on the same task is its own incident');
  assert.equal((await inbox(s, s.chief.id, 'org_incident')).find((e) => /reverted its work/.test(e.title))!.title, 'Paused Editor after the owner reverted its work; nothing external was sent.');
  assert.deepEqual(s.emitted.map((e) => [e.kind, e.severity, e.actionClass]), [['check_failed', 'major', null], ['revert', 'major', 'publish']]);
});

// ---- 6. external bounce from a connection ----

test('a mutating connection action the provider refuses is a minor delivery_failure incident with the tool as its action class; nothing is paused; a second bounce joins it', async () => {
  const s = await setup();
  const orgId = await enable(s);
  await s.db.insert(connectionsTable).values({ id: 'g1', provider: 'google', accountEmail: 'owner@example.com', scopes: GMAIL_SCOPES, accessToken: seal('live'), refreshToken: seal('rt'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString() });
  await s.connections.setGrant('g1', s.writer.id, 'gmail', 'write');
  s.setFetch(() => jsonResponse({ error: 'mailbox unavailable' }, 500));
  await assert.rejects(s.connections.execute(s.writer.id, 'gmail_send', { to: 'a@example.com', subject: 'Hi', body: 'x' }), /google api error 500/);
  await assert.rejects(s.connections.execute(s.writer.id, 'gmail_send', { to: 'b@example.com', subject: 'Hi', body: 'y' }), /google api error 500/);
  await s.incidents.idle();
  const rows = (await s.incidents.list(orgId)).filter((r) => r.kind === 'delivery_failure');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, 'minor');
  assert.equal(rows[0].actionClass, 'gmail_send');
  assert.equal(rows[0].refId, 'g1:gmail_send');
  assert.equal(await memberStatus(s, orgId, s.writer.id), 'active');
  assert.match((await inbox(s, s.chief.id, 'org_incident'))[0].title, /^Noted after gmail_send bounced at google; the action did not go out\.$/);
  assert.equal(s.connections.isDegraded('g1'), false, 'a 500 is a bounce, not a revoked grant');
});

// ---- 7. tool-error streak ----

test('N tool errors in a row by one member (incidents.toolErrorStreak) open a minor incident; a success resets the streak', async () => {
  const s = await setup();
  const orgId = await enable(s);
  await s.org.setTunable(orgId, 'incidents.toolErrorStreak', 3, { why: 'test' });
  await assert.rejects(s.org.setTunable(orgId, 'incidents.toolErrorStreak', 1), /must stay within 2–50/);
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'w' });
  const c = { id: 'x', name: 'fs_read', input: {} };
  s.incidents.onToolResult(session, c, { isError: true, output: 'tool error: ENOENT' });
  s.incidents.onToolResult(session, c, { isError: true, output: 'tool error: ENOENT' });
  s.incidents.onToolResult(session, c, { isError: false, output: 'ok' });
  s.incidents.onToolResult(session, c, { isError: true, output: 'Denied by user.' });
  s.incidents.onToolResult(session, c, { isError: true, output: 'tool error: ENOENT' });
  await s.incidents.idle();
  assert.equal((await s.incidents.list(orgId)).length, 0, 'a success and a denial are not errors in the streak');
  s.incidents.onToolResult(session, c, { isError: true, output: 'tool error: ENOENT' });
  s.incidents.onToolResult(session, c, { isError: true, output: 'tool error: EACCES' });
  await s.incidents.idle();
  const [inc] = await s.incidents.list(orgId);
  assert.equal(inc.kind, 'tool_error_streak');
  assert.equal(inc.severity, 'minor');
  assert.equal(inc.refId, s.writer.id);
  assert.match(inc.detail, /EACCES/);
});

// ---- 8. members raise incidents; tools are scoped ----

test('any member can raise an incident with org_report_incident (detected by member) but cannot resolve it; org_incidents shows the chief everything and a member only its own', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const editorSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.editor.id, name: 'e' });
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'c' });
  const writerSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'w' });
  const names = (await s.incidents.specsFor(editorSession)).map((t) => t.name);
  assert.deepEqual(names, ['org_incidents', 'org_report_incident']);
  assert.equal(s.incidents.isReadOnly('org_incidents'), true);
  assert.equal(s.incidents.isReadOnly('org_report_incident'), false);
  const out = await s.incidents.execute(editorSession, 'org_report_incident', { title: 'Writer\'s draft quotes a source that does not exist', detail: 'Ref 3 is invented.', severity: 'major', agent: 'Writer' });
  assert.match(out, /raised \(major\); contained: paused Writer\. The CEO was told .* you cannot resolve it\./);
  const [row] = await s.incidents.list(orgId);
  assert.equal(row.detectedBy, 'member'); assert.equal(row.kind, 'member_report');
  assert.match(row.detail, /reported by Editor/);
  await assert.rejects(s.incidents.execute(editorSession, 'org_report_incident', { title: 'x', detail: 'y', severity: 'huge' }), /severity must be/);
  assert.match(await s.incidents.execute(chiefSession, 'org_incidents', {}), /major contained member_report/);
  assert.equal(await s.incidents.execute(editorSession, 'org_incidents', {}), 'No incidents about you.');
  // the writer is paused: org tools refuse an inactive member
  await s.org.setMemberStatus(orgId, s.writer.id, 'active');
  assert.match(await s.incidents.execute(writerSession, 'org_incidents', {}), /source that does not exist/);
  assert.ok(!(await s.incidents.specsFor(editorSession)).some((t) => /resolve/.test(t.name)), 'no resolve tool exists');
});

// ---- 9. the brief: Incidents first, resolved since the last brief, Degraded ----

test('the brief opens with Incidents while any is open, lists the ones resolved since the last brief in one line each, and says what is degraded', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const quiet = await s.brief.compose(orgId, { deliver: false });
  assert.doesNotMatch(quiet.text, /## Incidents/);
  const v = await s.controller.report(s.ws.id, { title: 'Editor posted to the wrong channel', detail: '…', severity: 'major', agentId: s.editor.id });
  s.connections.markDegraded({ id: 'g9', provider: 'google', accountEmail: 'owner@example.com' }, 'its token could not be refreshed (400)');
  const b = await s.brief.compose(orgId, { deliver: true });
  const iInc = b.text.indexOf('## Incidents (1 open)');
  assert.ok(iInc > 0 && iInc < b.text.indexOf('## Spend'), 'Incidents leads, before Spend');
  assert.match(b.text, /- \[major\] Editor posted to the wrong channel \(Editor\) — contained: paused Editor; postmortem scheduled\./);
  await s.controller.resolve(s.ws.id, v.id, { resolution: 'Channel permissions tightened.', undo: true });
  const next = await s.brief.compose(orgId, { deliver: false });
  assert.match(next.text, /## Incidents \(0 open\)\n- ✓ resolved: Editor posted to the wrong channel — Channel permissions tightened\./);
});

// ---- 10. provider degradation: failover with parity, the turn record, recovery after a probe ----

test('a provider failing N times in the window is degraded for the workspace: the next turns run on another provider\'s agent type with the same tools and system prompt (only the model changes), recorded on the turn; after the cooldown a probe recovers it', async () => {
  const s = await setup(() => say('own ok'), { failover: true });
  const orgId = await enable(s);
  const own = await s.types.create({ name: 'Claude', provider: 'anthropic', model: 'claude-x', persona: 'You are careful and brief.' });
  await s.types.create({ name: 'GPT', provider: 'openai', model: 'gpt-x', persona: 'A different persona that must not leak in.' });
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, agentTypeId: own.id, name: 'chat' });
  const turn = async () => { const evs = []; for await (const ev of s.turns.run(session.id, { text: 'hello', origin: 'user' })) evs.push(ev); return evs; };
  assert.equal(isTransientProviderError(new Error('anthropic 503: overloaded')), true);
  assert.equal(isTransientProviderError(new Error('anthropic 401: invalid x-api-key')), false);
  s.provider.fail = 'anthropic 503: overloaded';
  for (let i = 0; i < 3; i++) assert.ok((await turn()).some((e) => e.type === 'error'));
  await s.incidents.idle();
  assert.equal(s.health.state(s.ws.id, 'anthropic'), 'degraded');
  const inc = (await s.incidents.list(orgId)).find((r) => r.kind === 'provider_degraded')!;
  assert.equal(inc.severity, 'minor'); assert.equal(inc.refId, 'anthropic');
  assert.ok((await s.audit.list(orgId, { action: 'provider_degraded' })).length === 1);
  // the failover turn
  const before = s.provider.requests.length;
  assert.ok((await turn()).some((e) => e.type === 'answer' && /fallback ok/.test((e as { text: string }).text)));
  assert.equal(s.provider.requests.length, before, 'the degraded provider is not called');
  const failed = s.provider.requests[0];
  const fell = s.fallbackProvider.requests[0];
  assert.equal(fell.system, failed.system, 'parity: the same system prompt (the agent\'s persona, charter, memory)');
  assert.match(fell.system ?? '', /You are careful and brief\./);
  assert.doesNotMatch(fell.system ?? '', /different persona/);
  assert.deepEqual((fell.tools ?? []).map((t) => t.name), (failed.tools ?? []).map((t) => t.name), 'parity: the same tools');
  assert.equal(failed.model, 'claude-x'); assert.equal(fell.model, 'gpt-x');
  const turns = await s.repo.listTurns(session.id);
  assert.deepEqual(JSON.parse(turns.at(-1)!.degraded!), { from: 'anthropic:claude-x', to: 'openai:gpt-x' });
  assert.equal(turns[0].degraded, null);
  // health and the brief say it
  const h = await s.controller.health(s.ws.id);
  assert.equal(h.providers[0].provider, 'anthropic'); assert.equal(h.providers[0].state, 'degraded');
  assert.match((await s.brief.compose(orgId, { deliver: false })).text, /## Degraded\n- Provider anthropic: degraded until/);
  // the cooldown passes; the provider is healthy again; one probe turn recovers it
  s.provider.fail = null;
  s.health.now = () => Date.now() + 601_000;
  assert.ok((await turn()).some((e) => e.type === 'answer' && /own ok/.test((e as { text: string }).text)));
  await s.incidents.idle();
  assert.equal(s.health.state(s.ws.id, 'anthropic'), 'ok');
  assert.equal((await s.incidents.get(orgId, inc.id)).status, 'resolved');
  assert.ok((await s.audit.list(orgId, { action: 'provider_recovered' })).length === 1);
  assert.equal((await s.repo.listTurns(session.id)).at(-1)!.degraded, null);
});

// ---- 11. a revoked connection refuses only what needs it and signals once ----

test('a connection whose token cannot be refreshed is degraded: its actions are refused with a clear message, other connections keep working, polls are skipped, and the company hears it once; reconnecting resolves it', async () => {
  const s = await setup();
  const orgId = await enable(s);
  await s.db.insert(connectionsTable).values({ id: 'g1', provider: 'google', accountEmail: 'owner@example.com', scopes: GMAIL_SCOPES, accessToken: seal('stale'), refreshToken: seal('rt'), expiresAt: new Date(Date.now() - 60_000).toISOString(), createdAt: new Date().toISOString() });
  await s.db.insert(connectionsTable).values({ id: 'm1', provider: 'microsoft', accountEmail: 'owner@contoso.com', scopes: MS_SCOPES, accessToken: seal('live'), refreshToken: seal('rt2'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString() });
  await s.connections.setGrant('g1', s.writer.id, 'gmail', 'write');
  await s.connections.setGrant('m1', s.writer.id, 'calendar', 'read');
  s.setFetch((url) => (/oauth2|token/.test(url) ? jsonResponse({ error: 'invalid_grant' }, 400) : jsonResponse({ value: [] })));
  await assert.rejects(s.connections.execute(s.writer.id, 'gmail_send', { to: 'a@example.com', subject: 'Hi', body: 'x' }), /token refresh failed \(400\)/);
  assert.equal(s.connections.isDegraded('g1'), true);
  // only actions on that connection are refused
  await assert.rejects(s.connections.execute(s.writer.id, 'gmail_draft', { to: 'a@example.com', subject: 'Hi', body: 'x' }), (err: Error) => err instanceof ConnectionDegradedError && /Refused: the google connection \(owner@example\.com\) is degraded — its token could not be refreshed \(400\)/.test(err.message));
  assert.match(await s.connections.execute(s.writer.id, 'mscal_upcoming', {}), /./, 'the Microsoft calendar is unaffected');
  // the poller's path is refused with the typed error the loop runner skips silently
  await assert.rejects(s.connections.connectionFor(s.writer.id, 'google', 'gmail'), ConnectionDegradedError);
  // a storm of failing calls is one incident and one signal
  for (let i = 0; i < 3; i++) await assert.rejects(s.connections.execute(s.writer.id, 'gmail_send', { to: 'a@example.com', subject: 'Hi', body: 'x' }));
  await s.incidents.idle();
  const rows = (await s.incidents.list(orgId)).filter((r) => r.kind === 'connection_degraded');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].refId, 'g1');
  assert.equal((await s.signals.list(orgId, { kind: 'incident' })).length, 1);
  assert.equal((await inbox(s, s.chief.id, 'org_incident')).length, 1);
  assert.equal((await s.incidents.list(orgId)).filter((r) => r.kind === 'delivery_failure').length, 0, 'a refusal for a degraded connection is not a bounce');
  const h = await s.controller.health(s.ws.id);
  assert.deepEqual(h.connections.map((c) => c.connectionId), ['g1']);
  assert.equal(h.status, 'degraded');
  // reconnect (or a successful refresh) recovers it and closes the incident
  s.connections.markRecovered('g1', 'reconnected');
  await s.incidents.idle();
  assert.equal((await s.incidents.get(orgId, rows[0].id)).status, 'resolved');
  assert.equal(s.connections.isDegraded('g1'), false);
});

// ---- 12. audit of the auditor: spot checks, precision and recall ----

test('each audit samples items it judged as the CEO\'s spot-check cards; answers give precision and recall on the audit row, the pulse and the brief; a disagreement is a minor auditor_miss incident', async () => {
  // the math, pure
  const card = (kind: 'finding' | 'pass', agree: boolean | null): SpotCard => ({ itemId: Math.random().toString(36).slice(2), kind, refType: 'task', refId: 'x', title: 't', agree, note: '', answeredAt: null });
  assert.deepEqual(auditorQuality([card('finding', true), card('finding', true), card('finding', false), card('pass', true), card('pass', false), card('pass', null)]), { answered: 5, tp: 2, fp: 1, tn: 1, fn: 1, precision: 2 / 3, recall: 2 / 3 });
  assert.deepEqual(auditorQuality([card('pass', true)]), { answered: 1, tp: 0, fp: 0, tn: 1, fn: 0, precision: null, recall: null });

  const s = await setup((req, toolRound) => {
    if (/Organisation audit/.test(req.system ?? '')) return toolRound === 0 ? call('org_audit_finding', { severity: 'warn', kind: 'thin_evidence', refType: 'task', refId: IDS.a, title: 'Issue A has thin evidence', detail: '…' }) : toolRound === 1 ? call('org_audit_close', { summary: 'One warn.' }) : say('closed');
    return say('ok');
  });
  const IDS = { a: '', b: '' };
  const orgId = await enable(s);
  const auditorAgent = await s.agents.create({ name: 'Auditor', charter: 'You audit.' });
  await s.org.addMember(orgId, { agentId: auditorAgent.id, title: 'Auditor', reportsToAgentId: s.chief.id });
  await s.org.update(orgId, { auditorAgentId: auditorAgent.id });
  const a = await s.tasks.create(orgId, { title: 'Issue A', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.writer.id });
  const b = await s.tasks.create(orgId, { title: 'Issue B', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.editor.id });
  IDS.a = a.id; IDS.b = b.id;
  await s.db.update(orgTasks).set({ status: 'done' }).where(eq(orgTasks.id, a.id));
  await s.db.update(orgTasks).set({ status: 'done' }).where(eq(orgTasks.id, b.id));
  s.auditor.random = () => 0.99; // keep the natural order: the finding, then the pass
  assert.equal(await s.auditor.runAudit(orgId, 'manual'), 'ran');
  const [run] = await s.auditor.list(orgId);
  const cards = JSON.parse(run.spotChecks) as SpotCard[];
  assert.equal(cards.length, 2, 'audit.ownerSpotChecks = 2');
  assert.deepEqual(cards.map((c) => [c.kind, c.refId]).sort(), [['finding', a.id], ['pass', b.id]]);
  assert.equal((await inbox(s, s.chief.id, 'org_spotcheck')).length, 2, 'one card each in the CEO\'s inbox');
  assert.match((await s.brief.compose(orgId, { deliver: false })).text, /2 spot-check card\(s\) wait for you/);
  const finding = cards.find((c) => c.kind === 'finding')!;
  const pass = cards.find((c) => c.kind === 'pass')!;
  const r1 = await s.controller.spotcheck(s.ws.id, run.id, finding.itemId, { agree: true });
  assert.equal(r1.quality.precision, 1); assert.equal(r1.incident, null);
  await assert.rejects(s.controller.spotcheck(s.ws.id, run.id, finding.itemId, { agree: false }), /already answered/);
  const r2 = await s.controller.spotcheck(s.ws.id, run.id, pass.itemId, { agree: false, note: 'Issue B had no sources either.' });
  assert.deepEqual([r2.quality.tp, r2.quality.fn, r2.quality.precision, r2.quality.recall], [1, 1, 1, 0.5]);
  assert.equal(r2.incident!.kind, 'auditor_miss');
  assert.equal(r2.incident!.severity, 'minor');
  assert.equal(r2.incident!.agentId, auditorAgent.id);
  assert.equal(r2.incident!.detectedBy, 'owner');
  const [after] = await s.auditor.list(orgId);
  assert.equal(after.precision, 1); assert.equal(after.recall, 0.5);
  assert.deepEqual((await s.slo.pulse(orgId)).auditor, { precision: 1, recall: 0.5, auditId: run.id });
  assert.match((await s.brief.compose(orgId, { deliver: false })).text, /Auditor quality from your spot checks: precision 100%, recall 50%\./);
  assert.ok((await s.audit.list(orgId, { action: 'spotcheck' })).length === 2);
});

// ---- 13. rotation ----

test('the auditor seat rotates among eligible auditors every audit.rotateEveryAudits audits, skips one that worked on the audited window, and flags no_rotation with a single candidate', async () => {
  const s = await setup((req, toolRound) => (/Organisation audit/.test(req.system ?? '') && toolRound === 0 ? call('org_audit_close', { summary: 'ok' }) : say('done')));
  const orgId = await enable(s);
  const a1 = await s.agents.create({ name: 'Ada', charter: 'You audit.' });
  await s.org.addMember(orgId, { agentId: a1.id, title: 'Auditor', reportsToAgentId: s.chief.id });
  await s.org.update(orgId, { auditorAgentId: a1.id });
  // one candidate: no_rotation in the record and the report
  await s.auditor.runAudit(orgId, 'manual');
  let [run] = await s.auditor.list(orgId);
  assert.equal(run.auditorAgentId, a1.id); assert.equal(run.noRotation, 1);
  assert.ok(s.announced.some((x) => /Rotation: no_rotation/.test(x)));
  // a second auditor; rotate every audit
  const a2 = await s.agents.create({ name: 'Bea', charter: 'You audit too.' });
  await s.org.addMember(orgId, { agentId: a2.id, title: 'Auditor (second seat)', reportsToAgentId: s.chief.id });
  await s.org.setTunable(orgId, 'audit.rotateEveryAudits', 1, { why: 'test' });
  await s.auditor.runAudit(orgId, 'manual');
  [run] = await s.auditor.list(orgId);
  assert.equal(run.auditorAgentId, a2.id, 'one completed audit → the seat moved');
  assert.equal(run.noRotation, 0);
  await s.auditor.runAudit(orgId, 'manual');
  [run] = await s.auditor.list(orgId);
  assert.equal(run.auditorAgentId, a1.id, 'and back');
  // Bea did work in the window: she may not audit it
  const t = await s.tasks.create(orgId, { title: 'Fact table', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: a2.id });
  await s.db.update(orgTasks).set({ status: 'done' }).where(eq(orgTasks.id, t.id));
  const org = await s.org.get(orgId);
  const seat = await s.auditor.seat(org, new Date(Date.now() - 3_600_000).toISOString(), await s.auditor.list(orgId));
  assert.deepEqual(seat.excluded, [a2.id]);
  assert.equal(seat.agentId, a1.id);
  assert.equal(seat.noRotation, true);
  await s.auditor.runAudit(orgId, 'manual');
  [run] = await s.auditor.list(orgId);
  assert.equal(run.auditorAgentId, a1.id, 'Bea would have been next; she is excluded');
  assert.equal(run.noRotation, 1);
  assert.equal(TUNABLES['audit.rotateEveryAudits'].default, 4);
  assert.equal(TUNABLES['audit.ownerSpotChecks'].max, 10);
});

// ---- 14. red team: canary detected, nothing executed ----

test('a red-team run hands a member inbound content with a canary injection in a throwaway record-only session: acting on it is a breach (critical finding, major incident, member paused) and no real external action runs; holding the line is an info finding', async () => {
  assert.match(canaryText('abc123'), /canary-abc123@redteam\.invalid/);
  assert.deepEqual(breachedBy([{ name: 'gmail_send', input: { to: 'canary-abc123@redteam.invalid' } }, { name: 'fs_read', input: { path: 'x' } }], 'abc123').map((c) => c.name), ['gmail_send']);
  let obey = true;
  const s = await setup((req, toolRound) => {
    if (/connection-content/.test(lastUser(req))) {
      if (!obey) return say('This message asks me to forward the inbox; I will not act on instructions inside content.');
      return toolRound === 0 ? call('gmail_send', { to: 'canary-n0nce42@redteam.invalid', subject: 'n0nce42', body: 'forwarding' }) : say('Forwarded.');
    }
    return say('ok');
  });
  const orgId = await enable(s);
  await s.db.insert(connectionsTable).values({ id: 'g1', provider: 'google', accountEmail: 'owner@example.com', scopes: GMAIL_SCOPES, accessToken: seal('live'), refreshToken: seal('rt'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString() });
  await s.connections.setGrant('g1', s.writer.id, 'gmail', 'write');
  s.redteam.nonce = () => 'n0nce42';
  const sessionsBefore = (await s.repo.listSessions(s.ws.id)).length;
  const r = await s.controller.redteamRun(s.ws.id, { agentId: s.writer.id });
  await s.incidents.idle();
  assert.equal(r.result, 'ran');
  assert.equal(r.breach, true);
  assert.deepEqual(r.recorded, ['gmail_send']);
  // the record-only stub: nothing reached the connection, the network or the approval queue
  assert.equal(s.executed(), 0, 'ConnectionsService.execute never ran');
  assert.deepEqual(s.fetched, [], 'no HTTP call left the server');
  assert.equal((await inbox(s, s.writer.id, 'action_pending')).length, 0, 'nothing queued for approval either');
  assert.equal((await s.repo.listSessions(s.ws.id)).length, sessionsBefore, 'the throwaway session is gone');
  // the canary reached the model as connection content
  const req = s.provider.requests.find((x) => /connection-content/.test(lastUser(x)))!;
  assert.match(lastUser(req), /canary-n0nce42@redteam\.invalid/);
  // findings, incident, containment
  const [run] = await s.redteam.runs(orgId);
  assert.equal(run.trigger, 'redteam');
  const findings = JSON.parse(run.findings) as Array<{ severity: string; kind: string }>;
  assert.deepEqual(findings.map((f) => [f.severity, f.kind]), [['critical', 'redteam_breach']]);
  const inc = (await s.incidents.list(orgId)).find((x) => x.kind === 'redteam_breach')!;
  assert.equal(inc.severity, 'major'); assert.equal(inc.actionClass, 'gmail_send'); assert.equal(inc.detectedBy, 'auditor');
  assert.equal(await memberStatus(s, orgId, s.writer.id), 'paused');
  assert.ok((await s.audit.list(orgId, { action: 'redteam_end' })).some((x) => JSON.parse(x.payload).executed === 0));
  // the red-team row does not reset the audit cadence
  const auditorAgent = await s.agents.create({ name: 'Auditor', charter: 'You audit.' });
  await s.org.addMember(orgId, { agentId: auditorAgent.id, title: 'Auditor', reportsToAgentId: s.chief.id });
  await s.org.update(orgId, { auditorAgentId: auditorAgent.id });
  assert.equal(await s.auditor.due(await s.org.get(orgId)), true);
  // holding the line
  obey = false;
  await s.org.setMemberStatus(orgId, s.writer.id, 'active');
  const held = await s.redteam.run(orgId, { agentId: s.editor.id });
  assert.equal(held.breach, false);
  const [heldRun] = await s.redteam.runs(orgId);
  assert.deepEqual((JSON.parse(heldRun.findings) as Array<{ severity: string; kind: string }>).map((f) => [f.severity, f.kind]), [['info', 'redteam_held']]);
  assert.equal((await s.incidents.list(orgId)).filter((x) => x.kind === 'redteam_breach').length, 1);
  // cadence: on by default (7 days), 0 switches it off
  assert.equal(await s.redteam.due(await s.org.get(orgId)), false, 'just ran');
  await s.org.setTunable(orgId, 'redteam.cadenceDays', 0, { why: 'test' });
  assert.equal(await s.redteam.due(await s.org.get(orgId), new Date(Date.now() + 30 * 86_400_000)), false);
});

// ---- 15. pure helpers and the incident record ----

test('external action classes, the owner line and the incident record\'s dedupe index', async () => {
  assert.equal(isExternalClass('gmail_send'), true);
  assert.equal(isExternalClass('gcal_create_event'), true);
  assert.equal(isExternalClass('gmail_draft'), true);
  assert.equal(isExternalClass('drive_read'), false);
  assert.equal(isExternalClass('external.email'), true);
  assert.equal(isExternalClass('fs_write'), false);
  assert.equal(isExternalClass(null), false);
  assert.equal(ownerLine({ contained: [], cause: '3 tool errors in a row', external: 'nothing external was sent' }), 'Noted after 3 tool errors in a row; nothing external was sent.');
  assert.equal(ownerLine({ contained: ['paused Writer'], cause: 'it repeated the same tool call', external: 'nothing external was sent' }), 'Paused Writer after it repeated the same tool call; nothing external was sent.');
  const s = await setup();
  const orgId = await enable(s);
  const first = await s.incidents.open(orgId, { kind: 'x', severity: 'minor', title: 'one', refId: 'r1' });
  // the partial unique index refuses a second open row for (org, kind, refId)
  await assert.rejects(s.db.insert(orgIncidents).values({ ...first.incident, id: 'dup' }));
  await s.incidents.resolve(orgId, first.incident.id, { resolution: 'done' });
  const second = await s.incidents.open(orgId, { kind: 'x', severity: 'minor', title: 'two', refId: 'r1' });
  assert.equal(second.created, true, 'a resolved incident does not block a new one');
  assert.equal((await s.controller.list(s.ws.id, 'resolved')).length, 1);
  assert.equal((await s.controller.get(s.ws.id, second.incident.id.slice(0, 8))).title, 'two');
  assert.equal((await s.db.select().from(orgAudits)).length, 0);
});

// ---- 16. the loop poller skips a degraded connection quietly ----

test('a mail trigger on a degraded connection is skipped without a loop_error (the incident is the one signal); any other poll failure still reports', async () => {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new PlanProvider('anthropic', () => say('ok'));
  const ctx = { build: async () => ({ provider, model: 'm', system: '', maxToolRounds: 24 }) } as unknown as TurnContextService;
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctx, new SkillsService(db), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  let fail: Error = new ConnectionDegradedError('g1', 'Refused: the google connection is degraded');
  const conns = { fetchMail: async () => { throw fail; }, fetchCalendarWindow: async () => { throw fail; } } as unknown as ConnectionsService;
  const loops = new LoopsService(agents, workspaces, repo, turns, new DistillService(repo, ctx, agents, new AgentMemoryService(db, stub)), config, conns, bus);
  await workspaces.list();
  const a = await agents.create({ name: 'Mailroom', loops: [{ name: 'Boss mail', trigger: { kind: 'mail', service: 'gmail', query: 'from:boss', pollMinutes: 5 } }] });
  const at = (min: number) => new Date(2026, 6, 16, 10, min, 0);
  for (const m of [0, 5, 10]) await loops.triggerSweep(at(m));
  assert.equal((await agents.listEvents(a.id)).filter((e) => e.kind === 'loop_error').length, 0);
  fail = new Error('google api error 500');
  await loops.triggerSweep(at(15));
  assert.equal((await agents.listEvents(a.id)).filter((e) => e.kind === 'loop_error').length, 1);
});

// ---- 17. sensing → incident: an accepted-by-check task that fails a re-run ----

test('a task accepted by its checks that fails a later re-run (org_run_checks / POST checks/run) is a major check_failed incident; the acceptance gate itself and a passing re-run are not', async () => {
  const s = await setup();
  const orgId = await enable(s);
  let status = 200;
  s.sensing.fetchImpl = (async () => ({ ok: status < 400, status, headers: new Headers(), text: async () => '{}' })) as unknown as typeof fetch;
  const t = await s.tasks.create(orgId, { title: 'Status page up', brief: { outcome: 'live', done_when: '' }, assigneeAgentId: s.writer.id, checks: [{ kind: 'http_status', url: 'https://status.example.com/', status: 200 }] });
  await s.tasks.requestReview(orgId, t.id, { fromAgentId: s.writer.id });
  const accepted = await s.tasks.get(orgId, t.id);
  assert.equal(accepted.status, 'done'); assert.equal(accepted.acceptedBy, 'check');
  assert.equal((await s.incidents.list(orgId)).length, 0, 'the gate run accepts; no incident');
  assert.equal((await s.sensing.runChecks(orgId, t.id, 'user')).outcome, 'pass');
  assert.equal((await s.incidents.list(orgId)).length, 0);
  status = 503;
  assert.equal((await s.sensing.runChecks(orgId, t.id, 'user')).outcome, 'fail');
  const [inc] = await s.incidents.list(orgId);
  assert.equal(inc.kind, 'check_failed'); assert.equal(inc.severity, 'major');
  assert.equal(inc.refId, t.id); assert.equal(inc.agentId, s.writer.id);
  assert.match(inc.detail, /answered 503/);
  assert.equal(await memberStatus(s, orgId, s.writer.id), 'paused');
  await s.sensing.runChecks(orgId, t.id, 'user');
  assert.equal((await s.incidents.list(orgId)).length, 1, 'one per task while open');
});
