/**
 * The owner's feed (docs/owners-seat.md "Inbox and notifications"): one list
 * the Inbox and the top bar's bell both read, so their contents and counts
 * agree by construction.
 *
 *  GET  /api/workspaces/:id/feed?limit=          FeedPage
 *  POST /api/workspaces/:id/feed/read            { ids } | { all: true } | { section }
 *  GET  /api/workspaces/:id/feed/types           FeedTypeInfo[] — what can be turned off
 *  (GET …/notifications and POST …/notifications/read answer the same.)
 *
 * Mirrored in src/lib/api.ts. Every item is read back from the record that
 * owns it (FeedService); the feed stores nothing but who read what.
 */
import type { HomeNeed } from './home.types';

/** Needs you (something waits on you: it stays until it is resolved), the
 *  mentions and messages addressed to you, and the updates you follow. */
export type FeedSection = 'needs' | 'mentions' | 'updates';

export type FeedType =
  // ---- needs you (actionable; never muted) ----
  /** A decision card (an org approval). */
  | 'decision'
  /** A task escalated to you. */
  | 'escalation'
  /** A held or staged outward action waiting for your key. */
  | 'key'
  /** An autonomous plan inside its veto window. */
  | 'pending_change'
  /** An open incident (a breaker trip, a boundary violation, an error spike). */
  | 'incident'
  /** An assurance signal addressed to you. */
  | 'signal'
  /** A background action an agent queued for your approval. */
  | 'queued_action'
  /** A turn wants to run a tool on your connection; it waits minutes, not days. */
  | 'connection_approval'
  /** A company task assigned to you. */
  | 'task_assigned'
  /** A task waiting for your review. */
  | 'task_review'
  /** A task blocked on you. */
  | 'blocked_on_you'
  /** A thread or task you follow needs you (blocked, review, a comment naming you). */
  | 'follow_attention'
  /** A plugin update that widens what it may do waits for your review. */
  | 'plugin_review'
  // ---- mentions ----
  /** An agent wrote to you directly (message_owner). */
  | 'message'
  /** Someone @mentioned you in a channel, a thread or a task. */
  | 'mention'
  // ---- updates (informational; each can be turned off per workspace) ----
  | 'follow' | 'channel_activity' | 'run_failed' | 'budget' | 'meeting' | 'brief' | 'audit' | 'experiment'
  | 'trust' | 'decided_without_you' | 'hire' | 'project_team' | 'program' | 'project' | 'blocked' | 'goal_at_risk'
  | 'plugin' | 'company' | 'agent_note';

/** What an item can do in place; each maps to the route that already owns it. */
export type FeedAction = 'approve' | 'reject' | 'veto' | 'apply_now' | 'ack' | 'dismiss' | 'allow' | 'deny';

/** Who it is from. */
export interface FeedActor {
  kind: 'agent' | 'person' | 'system';
  id: string | null;
  name: string;
  emoji?: string;
  colors?: string;
}

/** What it is about, for the row's context chips. */
export interface FeedContext {
  taskId?: string;
  taskKey?: string | null;
  taskTitle?: string;
  projectId?: string;
  projectKey?: string | null;
  projectTitle?: string;
  channelId?: string;
  channelSlug?: string;
  meetingId?: string;
  meetingTitle?: string;
  agentId?: string;
}

/** Where an item opens: structured, so the SPA opens it through its own
 *  store actions (openOrgTask, openChannel, openSession, …) and never builds
 *  a URL. `link` is the fallback for an old event that carries only one. */
export type FeedTarget =
  | { kind: 'need'; need: Pick<HomeNeed, 'kind' | 'ref'> }
  | { kind: 'task'; taskId: string }
  | { kind: 'chat'; sessionId: string }
  | { kind: 'channel'; channelId: string; slug: string; messageId: string | null }
  | { kind: 'meeting'; meetingId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'pane'; pane: string; focus: { kind: string; id: string } | null }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'follow'; targetKind: string; targetId: string; link: string }
  | { kind: 'link'; hash: string }
  | { kind: 'inbox' };

export interface FeedItem {
  /** `need:<card>`, `event:<agent event>`, `audit:<row>`, `plugin:<row>`,
   *  `task:<id>:<role>`, `attention:<kind>:<id>:<at>`, `pending:<install>`;
   *  `group:<key>` for a grouped row. */
  id: string;
  type: FeedType;
  section: FeedSection;
  /** One line, plain language. */
  title: string;
  body: string;
  at: string;
  severity: 'critical' | 'high' | 'normal' | 'low';
  read: boolean;
  /** Needs you: it stays until it is resolved; reading it only quiets the count. */
  actionable: boolean;
  /** When a card's default applies (or a request times out); `expiresSoon` within 6 hours. */
  deadline: string | null;
  expiresSoon: boolean;
  actor: FeedActor | null;
  /** The company's name ('' without one). */
  company: string;
  context: FeedContext;
  target: FeedTarget;
  actions: FeedAction[];
  /** Updates about one thing collapse into one row ("3 updates on ENG-12"):
   *  how many, and every member id (marking the row read marks them all). */
  count: number;
  ids: string[];
  /** The Needs-you card it is, for inline decisions. */
  need?: HomeNeed;
  /** The agent event behind it (a queued action, a connection approval, a
   *  message), or the follow it is (opening it marks the follow seen). */
  ref?: { agentId?: string; eventId?: string; sessionId?: string; follow?: { targetKind: string; targetId: string } };
}

export interface FeedCounts {
  /** Open items in Needs you, read or not: the Inbox's nav badge. */
  needsYou: number;
  /** Of those, critical or with a default due within 6 hours. */
  urgent: number;
  /** Unread rows in every section: the bell's count. */
  unread: number;
  /** Unread rows per section (and Needs you's total). */
  sections: Record<FeedSection, { total: number; unread: number }>;
}

export interface FeedPage {
  workspaceId: string;
  generatedAt: string;
  company: string;
  items: FeedItem[];
  counts: FeedCounts;
  /** The bell's count (= counts.unread), kept for the switcher and old callers. */
  unread: number;
}

/** One type the owner can turn off (updates only; Needs you and mentions always arrive). */
export interface FeedTypeInfo {
  type: FeedType;
  label: string;
  description: string;
  /** The tunable that holds it (`notify.<type>`, 0 = off). */
  key: string;
  on: boolean;
  default: boolean;
}
