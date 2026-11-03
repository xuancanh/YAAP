/** A shared harness for the item-31 tests (boundary, evals, capacity, the
 *  owner's seat): the org stack over PGlite with a scripted provider whose
 *  usage per call is settable, and the governance services wired the way
 *  OrgModule wires them. Not a test file itself. */
import { ConfigService } from '@nestjs/config';
import { testDb, memStorage, mcpStub } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import type { TurnContextService } from '../server/src/chats/turn-context.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { ConnectionsService } from '../server/src/connections/connections.service';
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
import { OrgCapitalService } from '../server/src/org/org-capital.service';
import { OrgSensingService } from '../server/src/org/org-sensing.service';
import { OrgIncidentsService } from '../server/src/org/org-incidents.service';
import { OrgBoundaryService } from '../server/src/org/org-boundary.service';
import { OrgEvalsService } from '../server/src/org/org-evals.service';
import { OrgCapacityService } from '../server/src/org/org-capacity.service';
import { OrgSeatService } from '../server/src/org/org-seat.service';
import { OrgDecisionsService } from '../server/src/org/org-decisions.service';
import { OrgGovernanceTools } from '../server/src/org/org-governance.tools';
import { GovernanceController } from '../server/src/org/governance.controller';
import { OrgTrustBridge } from '../server/src/org/org-trust-bridge';
import { TrustService } from '../server/src/actions/trust.service';
import { ActionsService } from '../server/src/actions/actions.service';
import type { BoundaryCheckRecord } from '../server/src/org/org-boundary.service';

export type Plan = (req: AiRequest, toolRound: number) => AiStreamEvent[];
export const lastUser = (req: AiRequest): string => [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
export const say = (text: string): AiStreamEvent[] => [{ type: 'answer', text }];
export const call = (name: string, input: Record<string, unknown>): AiStreamEvent[] => [{ type: 'tool_call', id: `c-${Math.random().toString(36).slice(2, 8)}`, name, input }];

/** A provider whose reply is a function of the request; `usage` tokens per call. */
export class PlanProvider implements AiProvider {
  readonly requests: AiRequest[] = [];
  usage = { inputTokens: 100, outputTokens: 50 };
  constructor(readonly name: string, public plan: Plan) {}
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    const toolRound = req.messages.filter((m) => m.role === 'tool').length;
    for (const ev of this.plan(req, toolRound)) yield ev;
    yield { type: 'usage', ...this.usage };
    yield { type: 'done' };
  }
}

export async function setup(plan: Plan = () => say('ok')) {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const connections = new ConnectionsService(db, config);
  let externalCalls = 0;
  connections.fetchImpl = (async () => { externalCalls++; return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; }) as unknown as typeof fetch;
  const provider = new PlanProvider('anthropic', plan);
  const context = { build: async () => ({ provider, model: 'test-model', system: '', maxToolRounds: 6 }) } as unknown as TurnContextService;
  const skillsSvc = new SkillsService(db);
  const trust = new TrustService(db, agents, bus);
  const actions = new ActionsService(db, trust, agents, connections);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), context, skillsSvc, stub, mcpStub(), agents, workspaces, connections, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, actions);
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
  const capital = new OrgCapitalService(db, org, tasks, audit, agents, workspaces, intent, units, signals);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, signals, slo, intent, meetings, capital);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, signals, slo, intent, undefined, capital);
  runtime.debounceMs = 600_000;
  const playbooks = new OrgPlaybooksService(db, org, tasks, audit, agents, skillsSvc, announcer);
  const knowledge = new OrgKnowledgeService(db, org, tasks, audit, agents, workspaces, repo, turns, runtime);
  const memory = new OrgMemoryService(db, org, tasks, audit, agents, meetings, approvals, runtime, turns, playbooks, knowledge, config, units, signals, undefined, new AgentMemoryService(db, stub), bus);
  const sensing = new OrgSensingService(db, org, audit, tasks, approvals, agents, config, turns, runtime, units, signals, connections, stub, undefined);
  const incidents = new OrgIncidentsService(db, org, tasks, audit, agents, workspaces, runtime, turns, repo, config, signals, memory, brief, announcer, bus);
  new OrgTrustBridge(db, audit, approvals, tasks, actions, trust, signals, incidents, org);
  const boundary = new OrgBoundaryService(org, audit, signals, incidents);
  const evals = new OrgEvalsService(db, org, tasks, audit, agents, repo, turns, runtime, approvals, playbooks);
  const capacity = new OrgCapacityService(org, tasks, agents, signals, units, runtime);
  const seat = new OrgSeatService(db, org, approvals, audit, agents, runtime, brief, signals, units, capital);
  // Decision routing (docs/owners-seat.md §7), wired as OrgModule wires it.
  const decisions = new OrgDecisionsService(db, org, approvals, tasks, audit, agents, workspaces, runtime, units, trust, undefined, bus);
  const tools = new OrgGovernanceTools(org, runtime, capacity, evals, config, units, turns);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const controller = new GovernanceController(mode, org, boundary, evals, capacity, seat, config);
  const checks: BoundaryCheckRecord[] = [];
  boundary.onCheck((r) => checks.push(r));
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write the newsletter.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit drafts.', provider: 'openai', model: 'gpt-5' });
  return {
    db, bus, agents, workspaces, repo, turns, provider, connections, trust, actions, audit, org, units, intent, tasks, approvals, signals, slo, meetings, capital, brief, runtime,
    playbooks, memory, sensing, incidents, boundary, evals, capacity, seat, decisions, tools, mode, controller, checks, ws, chief, writer, editor, announced, config,
    externalCalls: () => externalCalls,
  };
}
export type S = Awaited<ReturnType<typeof setup>>;

export async function enable(s: S, modeName: 'supervised' | 'autonomous' = 'supervised'): Promise<string> {
  const st = await s.mode.setMode(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: 10 });
  const orgId = st.orgId!;
  await s.org.updateMember(orgId, s.writer.id, { title: 'Writer' });
  await s.org.updateMember(orgId, s.editor.id, { title: 'Editor' });
  return orgId;
}

/** A session of an agent for direct tool execution. */
export async function sessionOf(s: S, agentId: string) {
  return s.repo.createSession({ workspaceId: s.ws.id, agentId, name: `t-${Math.random().toString(36).slice(2, 6)}`, permissionMode: 'auto' });
}
export const inbox = async (s: S, agentId: string, kind?: string) => (await s.agents.listEvents(agentId, 200)).filter((e) => !kind || e.kind === kind);
