/**
 * The top bar (docs/home.md "Top bar"): the shapes of
 *
 *  GET  /api/workspaces/:id/status          WorkspaceStatus — the company at a glance
 *  GET  /api/topbar/workspaces              WorkspaceGlanceRow[] — the switcher's rows
 *  GET  /api/workspaces/:id/notifications   NotificationsPage — the bell
 *  POST /api/workspaces/:id/notifications/read
 *
 * Mirrored in src/lib/api.ts. Every fact comes from the service that owns it
 * (HomeService's needs, spend, team and coming up; the live-turn registry;
 * the agent inbox events): the bar adds no state but the bell's read marks
 * for cards that have none of their own.
 */
import type { HomeNeed, HomeSpend } from './home.types';

export interface WorkspaceCompanyGlance {
  name: string;
  mode: 'supervised' | 'autonomous';
  status: 'active' | 'paused';
}

/** One turn running now (docs/mission-control.md "Live"). */
export interface LiveRun {
  sessionId: string;
  agentId: string | null;
  agentName: string;
  /** user | loop | channel | org | … */
  origin: string;
  sessionName: string;
  startedAt: string;
  /** The tool call in progress, in words ("writing reports/weekly.md"); '' before the first. */
  toolLabel: string;
}

export interface WorkspaceStatus {
  workspaceId: string;
  generatedAt: string;
  /** Null without a company (organization mode off, or companies disabled). */
  company: WorkspaceCompanyGlance | null;
  /** The owner's count: Home's Needs you, the same cards. */
  needsYou: number;
  /** Of those, critical or with a default due within 6 hours. */
  urgent: number;
  /** Company mode only; null otherwise. */
  spend: Pick<HomeSpend, 'todayUsd' | 'monthUsd' | 'monthCapUsd' | 'projectedUsd' | 'forecastState'> | null;
  agents: {
    total: number; working: number; failing: number;
    /** The faces for the avatar stack: failing first, then working. At most five. */
    faces: Array<{ id: string; name: string; emoji: string; colors: string; state: 'working' | 'error' }>;
  };
  live: LiveRun[];
  /** The next meeting or ritual within a day; null when none. */
  nextMeeting: { id: string; title: string; at: string; meetingId: string | null } | null;
  /** Sections that failed to load; the rest is still right. */
  partial: string[];
}

/** One row of the workspace switcher. */
export interface WorkspaceGlanceRow {
  workspaceId: string;
  company: WorkspaceCompanyGlance | null;
  needsYou: number;
  /** Unread notifications (the bell's count). */
  unread: number;
}

export type NotificationKind =
  /** Waiting on you (Home's Needs you): a decision card, an escalation, a key, a pending change, an incident, a signal, a queued action. */
  | 'decision' | 'escalation' | 'key' | 'plan' | 'incident' | 'signal' | 'queued_action'
  /** Inbox events: a message from an agent, a mention in a channel, a followed thread or task that changed, a failed run, a budget stop, other news. */
  | 'message' | 'mention' | 'follow' | 'run_failed' | 'budget_stop' | 'activity';

/** Where a notification opens. */
export type NotificationTarget =
  | { to: 'need'; need: Pick<HomeNeed, 'kind' | 'ref'> }
  | { to: 'chat'; sessionId: string }
  | { to: 'agent'; agentId: string }
  /** An in-app link: a path (`/<company>/…`, docs/routes.md) or an older `#/…` hash. */
  | { to: 'hash'; hash: string }
  | { to: 'inbox' };

export interface TopNotification {
  /** `need:<card id>` or `event:<agent event id>`. */
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  at: string;
  severity: 'critical' | 'high' | 'normal' | 'low';
  read: boolean;
  /** Something waits on you: it stays until it is resolved (reading it only quiets the count). */
  waiting: boolean;
  /** When a card's default applies; `expiresSoon` when that is within 6 hours. */
  deadline: string | null;
  expiresSoon: boolean;
  /** Who it is from: an agent, a channel, "Following", the system. */
  from: string;
  agentId: string | null;
  target: NotificationTarget;
}

export interface NotificationsPage {
  generatedAt: string;
  items: TopNotification[];
  unread: number;
}
