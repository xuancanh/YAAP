/**
 * The top bar (docs/home.md "Top bar"): the shapes of
 *
 *  GET  /api/workspaces/:id/status          WorkspaceStatus — the company at a glance
 *  GET  /api/topbar/workspaces              WorkspaceGlanceRow[] — the switcher's rows
 *  GET  /api/workspaces/:id/notifications   FeedPage — the bell (the owner's feed, feed.types.ts)
 *  POST /api/workspaces/:id/notifications/read
 *
 * Mirrored in src/lib/api.ts. Every fact comes from the service that owns it
 * (HomeService's spend, team and coming up; the live-turn registry; the
 * feed's Needs you and unread counts): the bar adds no state.
 */
import type { HomeSpend } from './home.types';

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
  /** Open items in the feed's Needs you: the Inbox's badge. */
  needsYou: number;
  /** Of those, critical or with a default due within 6 hours. */
  urgent: number;
  /** Unread rows in the feed: the bell's count. */
  unread: number;
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
