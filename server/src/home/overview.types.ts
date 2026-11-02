/**
 * The agent overview (`GET /api/agents/:id/overview`) and the org mission
 * control (`GET /api/workspaces/:id/org/mission-control`), docs/mission-control.md.
 * Both are built on the shared per-agent status (agent-status.ts). The SPA
 * mirrors these shapes in src/lib/api.ts.
 */
import type { HomeActivity, HomeAgent, HomeAgentState } from './home.types';
import type { BlockerInfo } from './agent-status';

export type { BlockerInfo };

/** A running turn, as the overviews show it. */
export interface OverviewLive {
  sessionId: string; sessionName: string; origin: string; startedAt: string;
  tool: string | null; toolLabel: string; toolAt: string | null; calls: number;
}

/** The shared status, as both overviews carry it. */
export interface OverviewStatus extends HomeAgent {
  live: OverviewLive | null;
  doingSince: string | null;
  waitingOnYou: number;
  blockedCount: number;
  open: number;
  lastRunAt: string | null;
  memberStatus: string | null;
}

/** A task on the agent's page: an org task card, or one from its own board. */
export interface OverviewTask {
  id: string;
  /** The task key (docs/tasks-keys.md), e.g. ENG-12; null on a row from before keys. */
  key?: string | null;
  /** `org` opens with app.openOrgTask; `agent` is on the agent's Tasks tab. */
  source: 'org' | 'agent';
  title: string;
  status: string;
  outcome: string;
  doneWhen: string;
  startedAt: string | null;
  updatedAt: string;
  createdAt: string;
  dueAt: string | null;
  lastComment: { at: string; from: string; text: string } | null;
  /** Paths the task may write, and files this agent wrote while on it. */
  files: string[];
  /** Done tasks: how it was accepted ('' | check | review). */
  acceptedBy: string;
  /** Reviews: whose task it is. */
  assigneeName: string;
}

export interface OverviewBlocked extends OverviewTask { blocker: BlockerInfo }

export interface OverviewFollow {
  id: string; targetKind: string; targetId: string; title: string;
  attention: string; unseen: number; lastActivityAt: string | null; lastActorName: string;
}

export interface OverviewGoal {
  id: string; kind: string; title: string; progress: number; confidence: number | null;
  rag: 'red' | 'amber' | 'green' | 'grey'; atRisk: boolean; atRiskReason: string;
  currentValue: number | null; targetValue: number | null; unitLabel: string; dueAt: string | null;
}

/** A teammate's tile (a report, or the manager). */
export interface TeamTile {
  id: string; name: string; emoji: string; colors: string; title: string;
  state: HomeAgentState; doing: string; taskId: string | null; lastBeatAt: string | null; open: number; liveLabel: string;
}

/** Why the agent is erroring, in one place: the loudest error, where it
 *  happened (the failing run's conversation, the task) and how to fix it. */
export interface OverviewCause {
  kind: HomeAgent['errors'][number]['kind'];
  message: string;
  at: string;
  /** The conversation of the failing run (opens it). */
  sessionId: string | null;
  /** The task it failed on (a breaker trip). */
  taskId: string | null;
  /** What to do, when the message makes it obvious; `tab` is an agent-page tab ('Settings:General'). */
  fix: { text: string; tab: string | null } | null;
}

/** Something waiting on the owner: a background action it queued, a
 *  connection it asks to use, an escalation or an approval it asked for. */
export interface NeedsYouItem {
  id: string;
  kind: 'action' | 'connection' | 'escalation' | 'approval';
  title: string;
  detail: string;
  at: string;
  /** action / connection: the agent event to act on. */
  eventId: string | null;
  /** escalation / approval: the org approval card. */
  approvalId: string | null;
  taskId: string | null;
  sessionId: string | null;
}

export interface AgentOverview {
  agentId: string;
  workspaceId: string;
  generatedAt: string;
  agent: { id: string; name: string; emoji: string; colors: string; title: string; role: string; provider: string; model: string; isChief: boolean; hasReports: boolean };
  /** True when the workspace runs a company and this agent sits in it. */
  inCompany: boolean;
  status: OverviewStatus;
  /** Set while it is erroring (or has errors): the cause, its run and a fix. */
  cause: OverviewCause | null;
  /** What waits on you, oldest first: the page puts it at the top. */
  needsYou: NeedsYouItem[];
  heartbeat: {
    enabled: boolean; cron: string; nextDueAt: string | null; lastBeatAt: string | null; lastRunAt: string | null;
    lastReason: string; runsToday: number; dailyRunCap: number;
  } | null;
  /** The agent's next scheduled loop (not the heartbeat), within a week. */
  nextLoop: { name: string; at: string; cron: string } | null;
  now: OverviewTask | null;
  blocked: OverviewBlocked[];
  queue: OverviewTask[];
  reviews: OverviewTask[];
  follows: OverviewFollow[];
  done: OverviewTask[];
  files: Array<{ path: string; version: number; updatedAt: string }>;
  /** Loop runs (routine ones collapsed, as on Home), its own messages and outcomes, newest first. */
  recent: HomeActivity[];
  goals: OverviewGoal[];
  team: { manager: TeamTile | null; reports: TeamTile[]; humans: Array<{ memberAccountId: string; title: string }>; unit: { id: string; name: string; slug: string } | null };
  health: {
    errors: HomeAgent['errors'];
    /** `series`: the chat ledger per day over 30 days (the spend sparkline). */
    spend: { todayUsd: number | null; d30Usd: number | null; monthUsd: number | null; monthCapUsd: number | null; series: Array<{ day: string; usd: number }> };
    trust: Array<{ actionClass: string; effective: number; ceiling: number }>;
    wip: { open: number; limit: number } | null;
  };
  /** The agent's own notes (update_dashboard), markdown. */
  dashboard: string;
  partial: string[];
}

// ---- mission control ----

export interface MissionNode extends OverviewStatus {
  agentId: string;
  reportsToAgentId: string | null;
  /** The unit this agent leads, if any. */
  leadsUnitId: string | null;
  wip: { open: number; limit: number };
  spend: { todayUsd: number; monthUsd: number; monthCapUsd: number };
  /** Who or what each blocked task waits on. */
  waits: Array<{ taskId: string; title: string; waitsOn: BlockerInfo['waitsOn']; reason: string; since: string }>;
  liveLabel: string;
}

export interface MissionControl {
  workspaceId: string;
  orgId: string;
  generatedAt: string;
  company: { name: string; status: string; mode: string; chiefAgentId: string | null };
  totals: {
    working: number; blocked: number; idle: number; paused: number; error: number;
    tasksInFlight: number; waitingOnYou: number;
    spendTodayUsd: number | null; monthUsd: number | null; monthCapUsd: number | null;
  };
  units: Array<{ id: string; name: string; slug: string; leadAgentId: string; parentUnitId: string | null; openTasks: number }>;
  nodes: MissionNode[];
  /** Human employees, under the member they report to. */
  humans: Array<{ id: string; memberAccountId: string; title: string; reportsToAgentId: string | null }>;
  /** The waiting chains: `from` waits on `to` ('ceo' = you) for `taskId`. */
  edges: Array<{ from: string; to: string; taskId: string; title: string }>;
  partial: string[];
}
