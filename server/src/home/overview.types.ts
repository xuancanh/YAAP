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

export interface AgentOverview {
  agentId: string;
  workspaceId: string;
  generatedAt: string;
  agent: { id: string; name: string; emoji: string; colors: string; title: string; role: string; provider: string; model: string; isChief: boolean; hasReports: boolean };
  /** True when the workspace runs a company and this agent sits in it. */
  inCompany: boolean;
  status: OverviewStatus;
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
    spend: { todayUsd: number | null; d30Usd: number | null; monthUsd: number | null; monthCapUsd: number | null };
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
