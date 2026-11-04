/**
 * Typed fetch client for the yaam-chat API. The Vite dev server proxies /api
 * to the NestJS backend (see vite.config.ts).
 */
import type { z } from 'zod';
import {
  looseParse,
  usageReportSchema,
  chatSessionSchema,
  chatSessionListSchema,
  agentSchema,
  agentListSchema,
  fileEntryListSchema,
  filePreviewSchema,
  fileRevisionListSchema,
  transcriptSchema,
  hireResultSchema,
  followViewSchema,
  homeDataSchema,
} from './schemas';

export interface Workspace {
  id: string;
  name: string;
  color: string;
  memory: string;
  /** Consented user profile: only user-approved lines land here. */
  profile: string;
  /** JSON array of ProfileProposal awaiting review. */
  profilePending: string;
  /** Quiet hours JSON (QuietHours) or '' when off. */
  quietHours: string;
  /** Monthly token budget for the whole workspace; 0 = unlimited. */
  spendBudgetTokens: number;
  /** Running counter: 'YYYY-MM' it belongs to + tokens spent in it. */
  spendMonth: string;
  spendTokens: number;
  /** Organization mode (docs/group-chat.md §5): the workspace is the company. */
  orgMode: OrgMode;
  chiefOfStaffAgentId: string | null;
  /** Company envelope in USD per month; autonomous allocations stay within it. */
  orgMonthlyUsd: number;
  /** Autonomous mode: at most this many members (chief included). */
  orgAgentCap: number;
  /** Heartbeat defaults JSON { cron?, dailyRunCap?, staleMinutes? } (docs/triggers.md "Heartbeat"); '{}' = built-in. */
  heartbeatDefaults?: string;
  createdAt: string;
}

export type OrgMode = 'off' | 'supervised' | 'autonomous';
export const ORG_MODES: OrgMode[] = ['off', 'supervised', 'autonomous'];

export type QuietPolicy = 'queue' | 'silent' | 'allow-urgent';
export interface QuietHours { start: string; end: string; timezone: string; policy: QuietPolicy }

/** This month's spend against the workspace budget (GET /workspaces/:id/spend). */
export interface SpendStatus { month: string; spentTokens: number; budgetTokens: number; over: boolean }

// ---- cost dashboard (GET /agents/:id/usage, /workspaces/:id/usage) ----
export interface UsageDay { day: string; tokensIn: number; tokensOut: number; usd: number }
export interface UsageBucket {
  key: string; label: string; kind: 'chat' | 'loop' | 'channel';
  tokensIn: number; tokensOut: number; usd: number; turns: number; sessionId?: string;
}
export interface UsageReport {
  days: number; from: string; to: string;
  totals: { tokensIn: number; tokensOut: number; usd: number; turns: number };
  series: UsageDay[];
  byKind: UsageBucket[];
  unpricedModels: string[];
}
export interface AgentUsage extends UsageReport { agentId: string }
export interface WorkspaceUsage extends UsageReport {
  workspaceId: string;
  byAgent: Array<{ agentId: string; name: string; tokensIn: number; tokensOut: number; usd: number; turns: number }>;
  budget: SpendStatus;
}
export interface PricingInfo {
  prices: Record<string, { input: number; output: number }>;
  overrides: Record<string, { input: number; output: number }>;
  overridden: string[];
  listed: number;
  note: string;
}

export interface ProfileProposal {
  id: string;
  entry: string;
  agentName: string;
  sessionId: string;
  at: string;
}

export interface EmailStatus {
  configured: boolean;
  domain: string;
  sendProvider: string;
  ownerAddresses: string[];
  digest: 'immediate' | 'daily' | 'off';
  digestHour: number;
  addresses: Array<{ agentId: string; name: string; address: string }>;
}

export interface Agent {
  id: string;
  /** Task key prefix of the agent's own board (docs/tasks-keys.md), e.g. EVL. */
  taskKey?: string | null;
  /** The owning workspace (docs/shared-agents.md "Workspace ownership"); agents are never shared across workspaces. */
  workspaceId?: string;
  name: string;
  /** Local part of the agent's inbound email address (docs/channels.md). */
  emailSlug?: string;
  emoji: string;
  colors: string; // JSON [from, to]
  role: string;
  charter: string;
  provider: string;
  model: string;
  /** The agent type it runs on (provider, key, base URL); null = by provider. */
  agentTypeId?: string | null;
  homeDir: string | null;
  /** Assigned workspace folder, mounted into its chats as shared/. */
  workspaceFolder: string;
  /** Default auto-archive for its new task chats: days; 0 = off; null = the workspace default. */
  chatAutoArchiveDays?: number | null;
  /** Personality id (docs/agent-writing.md): one of GET /api/agents/personalities, or 'none'. */
  personality?: string | null;
  dashboard: string;
  loops: string; // JSON array of LoopDef (src/lib/triggers.ts): { name, cron?, trigger?, … }
  apps: string; // JSON array of AgentApp
  createdAt: string;
}

/** One agent personality from the catalog (docs/agent-writing.md). */
export interface AgentPersonality { id: string; name: string; description: string; prompt: string; example: string }

/** One card on an agent's kanban board. */
export interface AgentTask {
  id: string;
  /** Task key (docs/tasks-keys.md), e.g. EVL-3; null on a task from before keys. */
  key?: string | null;
  agentId: string;
  title: string;
  note: string;
  status: 'todo' | 'doing' | 'blocked' | 'done' | 'abandoned';
  origin: 'user' | 'agent' | 'promote' | 'loop';
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A self-built HTTP tool: inert until user-approved, SSRF-guarded. */
export interface AgentCustomTool {
  id: string;
  name: string;
  slug: string;
  description: string;
  method: 'GET' | 'POST';
  url: string;
  body?: string;
  params: string[];
  enabled: boolean;
  proposedAt: string;
  approvedAt?: string;
}

/** A self-built mini app — rendered only in a network-blocked sandbox. */
export interface AgentApp {
  id: string;
  name: string;
  description: string;
  html: string;
  updatedAt: string;
  /** Capability manifest (docs/miniapp-capabilities.md); approved ⊆ capabilities. */
  capabilities?: string[];
  approved?: string[];
}

/** One thing an agent learned (docs/agent-memory.md). `trusted: 0` means it
 *  came from a mini app or a chat channel and is quarantined until promoted —
 *  an injected lesson is an instruction that outlives every turn. */
export interface AgentLesson {
  id: string;
  agentId: string;
  text: string;
  sourceKind: 'chat' | 'loop' | 'channel' | 'app' | 'feedback' | 'import';
  sourceSessionId: string | null;
  trusted: number;
  pinned: number;
  useCount: number;
  /** 'shared' or 'private:<memberAccountId>' (docs/shared-agents.md §4). */
  audience?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- shared workspaces (docs/shared-agents.md) ----
export type MemberRole = 'owner' | 'member' | 'viewer';
export interface SharedWorkspace { id: string; name: string; color: string; ownerAccountId: string; ownerName: string; role: MemberRole }
export interface WorkspaceMember { id: string; workspaceId: string; memberAccountId: string; role: MemberRole; displayName: string; email: string; invitedBy: string; joinedAt: string }
export interface WorkspaceInvite { id: string; workspaceId: string; email: string; role: MemberRole; invitedBy: string; expiresAt: string; createdAt: string }
export type FlowKind = 'lessons' | 'connections' | 'files';
export interface FlowRule { id: string; workspaceId: string; fromMember: string; toMember: string; effect: 'allow' | 'deny'; kind: FlowKind; createdAt: string }
/** Who the caller is in the workspace on screen, plus display names by actor id. */
export interface WorkspaceMe { actorId: string; role: MemberRole; ownerAccountId: string; names: Record<string, string>; hasMembers: boolean }
export interface MemberGrant { id: string; connectionId: string; agentId: string; service: string; level: string; memberAccountId: string; provider: string; accountEmail: string }
export interface MemberChannel { id: string; workspaceId: string; memberAccountId: string; kind: 'telegram' | 'email'; address: string; createdAt: string }
export type HumanRole = 'ceo' | 'board' | 'observer' | 'employee';
/** A human of the company; employees (item 24) carry a reporting line and a title. */
export interface OrgHuman { id: string; orgId: string; memberAccountId: string; role: HumanRole; reportsToAgentId?: string | null; title?: string; createdAt: string }

export interface AgentStats {
  chats: number;
  up: number;
  down: number;
  rating: number | null;
  tokensIn: number;
  tokensOut: number;
}

/** One entry in the agent's activity feed (proactive work is never silent). */
export interface AgentEvent {
  id: string;
  agentId: string;
  kind: 'loop_run' | 'loop_error' | 'budget_stop' | 'budget_warn' | 'brief' | 'org_run' | 'info' | 'action_pending' | 'action_done' | 'action_failed' | 'action_dismissed'
    | 'approval_request' | 'approval_granted' | 'approval_denied' | 'approval_expired';
  title: string;
  body: string;
  payload: string;
  sessionId: string | null;
  readAt: string | null;
  /** Quiet hours: channels wait until then (null = now); silent = inbox-only. */
  deliverAfter: string | null;
  silent: number;
  origin: string;
  channel: number;
  deliveredAt: string | null;
  /** Addressed to one member (a routed approval, docs/shared-agents.md §3); '' = everyone. */
  forMemberAccountId?: string;
  createdAt: string;
}

export interface AgentType {
  id: string;
  name: string;
  provider: string;
  model: string;
  models: string;
  /** When `models` last came from the provider (null = configured by hand). */
  modelsFetchedAt?: string | null;
  /** JSON { cheap?, standard?, strong? }: designated models per tier. */
  tierModels?: string;
  baseUrl: string | null;
  persona: string;
  enabled: number;
  hasApiKey: boolean;
}

export type ModelTierName = 'cheap' | 'standard' | 'strong';

/** GET /api/agent-types/:id/models (and the refresh result). */
export interface AgentTypeModels {
  id: string; name: string; provider: string;
  default: string;
  models: string[];
  tierModels: Partial<Record<ModelTierName, string>>;
  fetchedAt: string | null;
  discoverable: boolean;
  /** Refresh only. */
  ok?: boolean; error?: string; defaultChanged?: { from: string; to: string };
}

export interface ChatSession {
  id: string;
  workspaceId: string;
  agentId: string | null;
  agentTypeId: string | null;
  name: string;
  autoTitle: string;
  cwd: string | null;
  model: string;
  thinkingEffort: string;
  permissionMode: 'ask' | 'auto';
  pinned: number;
  tags: string;
  archivedAt: string | null;
  draft: string;
  tokenCeiling: number;
  /** tokensIn + tokensOut at the last compaction; the ceiling counts from here. */
  tokensAtCompact?: number;
  /** The context the last model call carried (provider-reported); the ceiling measures this. */
  contextTokens?: number;
  compactSummary: string;
  compactCutoff: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Shared workspaces: the member who created it ('' = the owner) and
   *  whether every member may see it (1) or only its creator and the owner. */
  initiatedBy?: string;
  shared?: number;
  /** Auto-archive (docs/chat-archiving.md): days after the linked task is
   *  finished; 0 = off; null = the workspace default. */
  autoArchiveDays?: number | null;
  /** The task this chat works on: 'org' | 'agent' (kanban) | null. */
  taskKind?: string | null;
  taskId?: string | null;
  /** 'chat' — a conversation with people; 'work' — the agent's own run
   *  (heartbeat, loop, org task, meeting round, channel wake), listed in
   *  the rail's Work subsection and opened in ChatView like a chat, its
   *  timeline in the Work log (docs/work-log.md). Absent = chat. */
  kind?: 'chat' | 'work';
  /** Work sessions (from the rail, the page and GET /chats/:id): what
   *  started them — the heartbeat, a loop, a task (key), a channel — and
   *  whether a run is going now. */
  trigger?: WorkTrigger;
  triggerKey?: string;
  triggerLabel?: string;
  running?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One agent's group in the Home rail (GET /api/chats/rail): `agentId`
 *  null = the workspace's agent-less chats. */
export interface ChatRailGroup {
  agentId: string | null;
  /** Chats in the group (conversations only; the agent's runs are work). */
  total: number;
  items: ChatSession[];
  nextCursor: string | null;
  /** Chats with an approval waiting in the inbox. */
  approvalIds: string[];
  /** The agent's work sessions (docs/work-log.md), the rail's Work
   *  subsection: how many, the loaded page (newest activity first, each
   *  with its trigger), the next cursor, and the ones waiting on an
   *  approval. `items`/`nextCursor` are absent from older servers. */
  work: { total: number; approvalIds: string[]; items?: ChatSession[]; nextCursor?: string | null };
}
export interface ChatRail { groups: ChatRailGroup[]; archivedTotal: number }

// ---- the Work log (docs/work-log.md) ----
export type WorkTrigger = 'heartbeat' | 'loop' | 'task' | 'meeting' | 'channel' | 'org' | 'app' | 'other';
export type WorkOutcome = 'done' | 'blocked' | 'error' | 'stopped' | 'running';
export interface WorkRun {
  id: string; sessionId: string; sessionName: string;
  trigger: WorkTrigger; triggerKey: string; label: string;
  outcome: WorkOutcome; status: string; error: string | null;
  input: string; answer: string;
  tokensIn: number; tokensOut: number; usd: number | null; model: string;
  steps: number; toolCount: number; thinkingCount: number; tools: string[];
  files: Array<{ path: string; op: string }>;
  task: { kind: 'org' | 'agent'; id: string; key: string | null; title: string } | null;
  archived: boolean; createdAt: string;
  /** Who sent it: 'person' (someone typed it), else its origin ('loop',
   *  'user', 'channel', 'app'); '' for old runs (docs/work-log.md). */
  source?: string;
  /** The person behind a 'person' run (an actor id; '' = the owner). */
  by?: string;
  /** The run this one re-runs (Rerun). */
  rerunOf?: string | null;
  /** Failed, stopped or blocked: Rerun applies. */
  rerunnable?: boolean;
}
/** POST …/work-log/runs/:turnId/rerun. */
export interface WorkRerunResult { started: boolean; turnId: string | null; sessionId: string; status: string; error?: string }
/** What GET /api/chats/:id/live streams: the running turn's events (TurnEvent),
 *  framed by `live` and `end`; `idle` when nothing runs there. */
export type SessionWatchEvent = TurnEvent
  | { type: 'live'; turnId: string; source: string; startedAt: string }
  | { type: 'idle'; busy: boolean }
  | { type: 'end' };
export interface WorkRunDetail extends WorkRun {
  messages: Array<{ id: string; seq: number; role: string; content: string; toolName: string | null; createdAt: string }>;
  toolCalls: Array<{ tool: string; input: unknown; result: string; approved: string; isError: boolean; actionClass?: string }>;
}
export interface WorkLogGroup { trigger: WorkTrigger; key: string; label: string; count: number; lastAt: string }
export interface WorkLogPage { runs: WorkRun[]; nextCursor: string | null; groups: WorkLogGroup[] }
export interface WorkLogFilters { trigger?: string; key?: string; outcome?: string; task?: string; session?: string; from?: string; to?: string; q?: string; limit?: number; cursor?: string | null }
export interface ChatPage { items: ChatSession[]; nextCursor: string | null }

export interface ChatMessage {
  id: string;
  sessionId: string;
  turnId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'thinking';
  content: string;
  toolName: string | null;
  /** The member who wrote a user message ('' = the owner). */
  authorAccountId?: string;
  createdAt: string;
}

export interface ChatTurn {
  id: string;
  sessionId: string;
  seq: number;
  input: string;
  attachments: string;
  status: string;
  toolCalls: string;
  tokensIn: number;
  tokensOut: number;
  rating: string | null;
  taskHandoff: string | null;
  /** JSON `{ from, to }` when the turn ran on a fallback model because its
   *  provider was degraded (docs/incidents.md §4); absent otherwise. */
  degraded?: string | null;
  model?: string;
}

export interface Skill {
  id: string;
  workspaceId: string | null;
  name: string;
  description: string;
  instructions: string;
  enabled: number;
  builtin: number;
  /** 1 = agent-drafted, awaiting user approval. */
  draft: number;
  proposedBy: string;
  /** Set = private self-built skill of that agent. */
  agentId: string | null;
  /** JSON SkillScanReport from a SKILL.md import; '' otherwise. */
  scanReport: string;
  /** Outcome aggregates: turns that loaded the skill and how they were rated. */
  useCount: number;
  upCount: number;
  downCount: number;
  lastUsedAt: string | null;
  /** JSON SkillRevision proposed by the agent after a 👎; '' when none. */
  pendingRevision: string;
  /** JSON array of the last 5 { instructions, replacedAt, reason }. */
  history: string;
  createdAt?: string;
}

/** Flags from the SKILL.md scan step (docs/permissions.md "Skills"). */
export interface SkillScanFlag { kind: string; detail: string; severity: 'warn' | 'block' }
export interface SkillScanReport { bytes: number; lines: number; urls: string[]; flags: SkillScanFlag[]; ok: boolean; scannedAt: string }
export interface SkillRevision { instructions: string; reason: string; proposedAt: string; proposedBy: string }

export function parseScanReport(s: Skill): SkillScanReport | null {
  if (!s.scanReport) return null;
  try { return JSON.parse(s.scanReport) as SkillScanReport; } catch { return null; }
}
export function parseRevision(s: Skill): SkillRevision | null {
  if (!s.pendingRevision) return null;
  try { return JSON.parse(s.pendingRevision) as SkillRevision; } catch { return null; }
}

/** AGENT.json v2 sections (formatVersion 2); v1 files have none of these. */
export interface AgentJsonV2 {
  formatVersion?: number;
  name?: string;
  loops?: Array<{ name: string; cron: string }>;
  lessons?: Array<{ text: string; sourceKind: string; trusted: number; pinned: number; useCount: number; createdAt: string }>;
  skills?: Array<{ name: string; description: string; instructions: string; enabled: number; draft: number }>;
  tasks?: Array<{ title: string; note: string; status: string }>;
  profile?: string;
  [key: string]: unknown;
}
export interface AgentImportOptions {
  trustLessons?: boolean; lessons?: boolean; skills?: boolean; tasks?: boolean; profile?: boolean; workspaceId?: string;
}
export interface AgentImportResult {
  agent: Agent;
  formatVersion: number;
  summary: { lessons: { added: number; skipped: number; trusted: boolean }; skills: { added: number; skipped: number }; tasks: { added: number }; profileProposals: number };
}

export type MemoryImportFormat = 'claude-memory' | 'muse' | 'hermes' | 'openclaw';
export interface MemoryImportSummary {
  format: MemoryImportFormat;
  lessons: { added: number; skipped: number; trusted: false };
  profileProposals: { proposed: number; skipped: number; workspaceId: string | null };
  charterSuggestion: { addendum: string; proposed: string } | null;
  files: { used: string[]; ignored: string[] };
}

export interface Connection {
  id: string;
  provider: string;
  accountEmail: string;
  scopes: string[];
  writeCapable: boolean;
  gmailCapable: boolean;
  /** The `mail` loop trigger can poll this connection (docs/triggers.md). */
  mailReadCapable: boolean;
  driveCapable: boolean;
  createdAt: string;
  grants: Array<{ agentId: string; service: string; level: string }>;
}

/** Per-loop trigger state for the schedule tab (GET /api/agents/:id/loops/state). */
export interface LoopState {
  name: string;
  kind: 'mail' | 'calendar' | 'task' | 'webhook' | null;
  lastPolledAt: string | null;
  lastFiredAt: string | null;
  lastErrorAt: string | null;
}

export type ConnectionServiceName = 'calendar' | 'gmail' | 'drive';

/** A connection context card (docs/integrations.md "Context cards and
 *  suggested loops"): the manual for a connection plus ready-made loops. */
export interface SuggestedUse {
  id: string;
  title: string;
  why: string;
  loop: { name: string; cron?: string; trigger?: unknown; prompt?: string };
  grantLevel: 'read' | 'write';
  fits?: string[];
}
export interface ContextCard {
  id: string;
  service: ConnectionServiceName | 'telegram' | 'email' | 'push' | 'browser' | 'computer' | 'mcp';
  provider: 'google' | 'microsoft' | '';
  title: string;
  summary: string;
  capabilities: { read: string[]; write: string[] };
  dataExposed: string;
  risks: string;
  usage: string[];
  suggestedUses: SuggestedUse[];
}

/** The gated heartbeat (docs/triggers.md "Heartbeat"): settings in effect + state. */
export interface HeartbeatView {
  enabled: boolean;
  cron: string;
  dailyRunCap: number;
  staleMinutes: number;
  lastBeatAt: string | null;
  lastReason: string;
  lastRunAt: string | null;
  nextDueAt: string | null;
  beatsSkipped: number;
  runsToday: number;
}
export interface BeatResult { status: string; reasons: string[]; ran: boolean }

export interface ConnectionProvider {
  provider: string;
  configured: boolean;
  redirectUri: string;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  enabled: number;
  tools: string;
  /** 'connected' when the server holds OAuth tokens; 'none' otherwise. */
  authStatus?: 'connected' | 'none';
}

/** Which sandbox backend runs run_js / run_python (docs/code-execution.md). */
// ---- desktop computer control (docs/computer-control.md) ----
export interface ComputerRunner {
  id: string; name: string; platform: string; scopes: string[]; paused: boolean;
  pairedAt: string; lastSeenAt: string | null; online: boolean;
}
export interface ComputerStatus { enabled: boolean; runner: ComputerRunner | null; queued: number; pairCodeActive: boolean }
export interface ComputerAction {
  id: string; runnerId: string; sessionId: string; tool: string; inputSummary: string;
  status: 'queued' | 'ok' | 'error' | 'timeout' | 'refused'; resultSummary: string; screenshotPath: string;
  createdAt: string; completedAt: string | null;
}
/** Computer tools whose approval a chat may remember; the acting ones
 *  (click, type, key, shell, write) ask on every call. Mirrors the server. */
export const REMEMBERABLE_COMPUTER_TOOLS = new Set(['computer_screenshot', 'computer_move', 'computer_scroll', 'computer_list_dir', 'computer_read_file']);
export const isComputerTool = (name: string): boolean => name.startsWith('computer_');

// ---- plugins (docs/plugins.md, Phase 1) ----

export type PluginRole = 'interface' | 'provider' | 'consumer';
export type PluginStatus = 'installed' | 'active' | 'suspended' | 'disabled' | 'frozen' | 'terminating' | 'removed';
export interface PluginProviderRow { id: string; interface: string; range: string; status: string; resources: string[]; conformanceRunId: string | null }
export interface PluginSummary {
  id: string; name: string; version: string; description: string; roles: PluginRole[]; tier: string;
  status: PluginStatus; suspendedReason: string; installId: string; digest: string; installedAt: string;
  pendingUpdate: { version?: string; diff?: PluginDiffEntry[]; failures?: string[] } | null;
  providers: PluginProviderRow[]; interfaces: string[];
  /** Set while the install is frozen because its version was recalled (docs/plugins.md §6.8). */
  recall?: { version: string; notice: string; at: string | null } | null;
}
export interface PluginDiffEntry { path: string; widening: boolean; detail: string }
export interface PluginCaseResult { id: string; ok: boolean; skipped?: boolean; detail?: string }
export interface PluginDetail extends PluginSummary {
  effects: Array<{ id: string; seq: number; kind: string; ref: string; state: string; external: boolean; createdAt: string; unwoundAt: string | null }>;
  conformance: Array<{ id: string; providerId: string; result: string; mode: string; startedAt: string; cases: PluginCaseResult[]; candidate: boolean }>;
  grants: Array<{ agentId: string; level: string; extras: boolean }>;
}
export interface PluginCatalogEntry { id: string; name: string; version: string; description: string; roles: PluginRole[]; tier: string; installed: boolean; installedVersion: string | null; updateAvailable: boolean }
export interface PluginReviewOp {
  op: string; canonical: string; tool: string; semantics: string; declaredClass: string | null; effectiveClass: string;
  floorReasons: string[]; raisedByFloor: boolean; twoKeyByFloor: boolean; reversibility: string; outbound: boolean; movesMoney: boolean;
  change: { kind: string; role: string } | null; untrustedOutput: boolean;
}
export interface PluginReview {
  id: string; name: string; version: string; description: string; publisher: { id: string; name: string; verifiedDomain?: string };
  tier: string; roles: PluginRole[]; requires: { yaamCore: string; interfaces?: string[] }; digest: string; warnings: string[]; noEgress: boolean;
  interfaces: Array<{ name: string; version: string; semantics: string; operations: PluginReviewOp[];
    changeKinds: Array<{ kind: string; reversibility: string; declaredRequirement: string; effectiveRequirement: string; raisedByFloor: boolean; roles: Array<{ op: string; role: string }> }>;
    events: string[]; suiteCases: string[] }>;
  provides: Array<{ interface: string; resources: string[]; installed: boolean; operations: string[]; missingRequired: string[]; conformanceMode: string }>;
  egress: Array<{ host: string; category: string }>; secrets: Array<{ slot: string; inject: string; redLine: boolean; description: string }>;
  dataSharing: Array<{ category: string; to: string; when: string; purpose: string }>; identity: Array<{ header: string; value: string }>;
  budgets: Record<string, number>; requestedPolicies: Array<{ match: Record<string, unknown>; require: string; why: string; status: string }>;
  deferred: string[]; diff: PluginDiffEntry[]; widening: boolean; blockers: string[];
  /** Community tier: the install needs the owner's explicit opt-in (acceptCommunity). */
  communityOptIn?: boolean;
}
export interface InterfaceView {
  name: string; version: string; major: number; pluginId: string; semantics: string;
  operations: Array<{ op: string; canonical: string; tool: string; effectiveClass: string; declaredClass: string | null; floorReasons: string[]; change: { kind: string; role: string } | null }>;
  changeKinds: Array<{ kind: string; reversibility: string; requirement: string }>;
  providers: Array<{ id: string; pluginId: string; status: string; healthy: boolean; resources: string[]; range: string }>;
  bindings: Array<{ id: string; major: number; scopeKind: string; scopeRef: string; providerId: string; pluginId: string | null; setBy: string }>;
}
export interface PluginSource { firstParty?: string; registry?: { id: string; version?: string }; manifest?: unknown; files?: Record<string, string>; path?: string }

// ---- Foundry and the plugin registry (docs/foundry.md §8, docs/plugins.md §7) ----

export type PluginTier = 'first_party' | 'verified' | 'community' | 'local';
export interface PluginConformanceEntry {
  interface: string; range: string; interfaceVersion: string | null; mode: string;
  result: 'pass' | 'fail' | 'error' | 'unverified'; passed: number; failed: number; failures: string[]; ranAt: string;
}
export interface FoundryPlugin {
  id: string; name: string; description: string; tier: PluginTier; source: 'first_party' | 'local' | 'registry';
  publisher: { id: string; name: string; verifiedDomain?: string }; roles: PluginRole[];
  version: string | null; digest: string | null; coreRange: string | null; compatible: boolean;
  defines: string[]; provides: string[]; requires: string[]; noEgress: boolean;
  conformance: Array<{ interface: string; interfaceVersion: string | null; result: string }>;
  installs: number; versionCount: number; recalled: boolean; installable: boolean; publishedAt: string;
  installed: { status: PluginStatus; version: string; notice: string; recalled: boolean } | null;
  updateAvailable: boolean;
}
export interface FoundryPluginList {
  items: FoundryPlugin[];
  facets: { interfaces: Array<{ name: string; defined: boolean; providers: number; consumers: number }>; tiers: Record<PluginTier, number>; roles: Record<PluginRole, number> };
  coreApi: string;
}
export interface FoundryOperation {
  op: string; canonical: string; tool: string; semantics: string; declaredClass: string | null; effectiveClass: string;
  floorReasons: string[]; twoKey: boolean; outbound: boolean; movesMoney: boolean; reversibility: string; required: boolean;
}
export interface FoundryCapabilities {
  roles: PluginRole[];
  defines: Array<{ name: string; version: string; semantics: string; operations: FoundryOperation[]; changeKinds: string[]; events: string[] }>;
  provides: Array<{ interface: string; range: string; resources: string[]; conformanceMode: string; operations: FoundryOperation[]; missingRequired: string[]; resolvedWith: string | null }>;
  requires: string[];
  egress: Array<{ host: string; category: string }>;
  dataSharing: Array<{ category: string; to: string; when: string; purpose: string }>;
  secrets: Array<{ slot: string; description: string; kind: string; inject: string }>;
  identity: Array<{ header: string; value: string }>;
  connections: string[];
  requestedPolicies: Array<{ operation: string | null; changeKind: string | null; require: string; why: string }>;
  budgets: Record<string, number>;
  consumer: { skills: number; rolePacks: number; playbooks: number; verifies: number };
  extras: Array<{ name: string; declaredClass: string | null }>;
  noEgress: boolean;
}
export interface FoundryPluginVersion {
  version: string; digest: string; manifestHash: string; commitSha: string; coreRange: string; compatible: boolean;
  conformance: PluginConformanceEntry[]; publishedAt: string; publishedBy: string; changelog: string;
  recalled: boolean; recalledAt: string | null; recallReason: string; installed: boolean;
}
export interface FoundryPluginDetail extends FoundryPlugin {
  license: string; homepage: string;
  capabilities: FoundryCapabilities | null;
  installSource: PluginSource | null;
  versions: FoundryPluginVersion[];
  related: Array<{ id: string; name: string; tier: PluginTier; roles: PluginRole[]; defines: string[]; provides: string[]; conformance: FoundryPlugin['conformance'] }>;
}
export interface PluginUpdates {
  pluginId: string;
  installed: { version: string; status: PluginStatus; recalled: boolean; notice: string };
  pending: Record<string, unknown> | null;
  updates: Array<{ version: string; digest: string; commitSha: string; coreRange: string; compatible: boolean; changelog: string; conformance: PluginConformanceEntry[]; publishedAt: string; newer: boolean; diff: PluginDiffEntry[]; widening: boolean; source: PluginSource }>;
}
export interface KitPreview {
  id: string; name: string; blurb: string; functions: string[]; companyTypes: string[];
  interfaces: Array<{ name: string; optional?: boolean; planned?: boolean }>; providers: string[]; seats: string[]; cadences: string[]; metrics: string[];
  policies: string; status: 'coming_soon'; installable: false;
}

// ---- coding agents (docs/coding-harnesses.md) ----

export type HarnessId = 'claude_code' | 'codex' | 'pi' | 'deepseek';
export type HarnessMode = 'read_only' | 'edit' | 'full';
/** One harness's settings as the server serves them: never the key, only whether one is stored. */
export interface HarnessConfig {
  enabled: boolean;
  binaryPath: string;
  auth: 'api_key' | 'cli_login';
  hasApiKey: boolean;
  baseUrl: string;
  provider: string;
  model: string;
  maxTurns: number;
  timeoutS: number;
  costCapUsd: number;
  mode: HarnessMode;
  osSandbox: boolean;
  agents: 'all' | string[];
  freeAgents: string[];
}
/** What a settings save may send: the key in clear ('' clears it), never read back. */
export type HarnessPatch = Partial<Omit<HarnessConfig, 'hasApiKey'>> & { apiKey?: string };
export interface HarnessStatus { found: boolean; path: string | null; version: string | null; detail: string; checkedAt: string }
export interface HarnessRow { id: HarnessId; label: string; binary: string; config: HarnessConfig; status: HarnessStatus }
export interface HarnessView { harnesses: HarnessRow[]; osSandbox: 'seatbelt' | 'bwrap' | null }

export interface RunnerStatus {
  backend: 'local' | 'cloudflare' | null;
  languages: Array<'javascript' | 'python'>;
  detail: string;
}

/** Which backend renders browser_open / browser_act (docs/browser-tool.md). */
export interface BrowserStatus {
  backend: 'cloudflare' | 'playwright' | null;
  detail: string;
  /** False on the stateless hosted backend: links and GET forms only. */
  interactive: boolean;
}

/** One screenshot the browser tool produced; the path lives under the chat's
 *  file root (agent or workspace store) and is read via the preview endpoint. */
export interface BrowserStep {
  url: string;
  title: string;
  screenshotPath: string;
  step: number;
}

/** One entry in the curated connectors directory (docs/integrations.md §4a). */
export interface ConnectorEntry {
  id: string;
  name: string;
  vendor: string;
  emoji: string;
  tier: 'verified' | 'community';
  cat: string;
  desc: string;
  kind: 'mcp' | 'native';
  url?: string;
  nativeTier?: 'read' | 'gmail' | 'drive';
  tools: string[];
}

export interface MarketItem {
  id: string;
  name: string;
  emoji: string;
  role: string;
  colors: [string, string];
  author: string;
  verified: boolean;
  stars: string;
  installs: string;
  cat: string;
  price: 'free' | 'metered';
  tagline: string;
  caps: string[];
  capsFull: Array<{ name: string; desc: string; icon: string }>;
  loops: Array<{ name: string; cron: string }>;
  hired: boolean;
  /** Profession packs: skills installed (agent-private) on hire. */
  skills?: Array<{ name: string; description: string }>;
  // The two-layer market (docs/agent-catalog.md "Segments and functions");
  // optional: an item without a segment is personal.
  segment?: 'personal' | 'business';
  /** Business: the job function id (src/lib/market.ts BIZ_FUNCTIONS). */
  function?: string;
  level?: 'head' | 'specialist' | 'leadership';
  /** Business: the pack id of the manager it reports to. */
  reportsTo?: string;
  kpis?: string[];
  cadence?: string;
  /** What "Hire into the company" sends as `templateOrPack` (`role:<id>` or
   *  a pack id); null or absent when the pack has no company hire. */
  orgHire?: string | null;
}

// ---- market registry (docs/registry.md) ----
export type RegistryKind = 'agent' | 'skill' | 'app';
export interface RegistryCapabilities {
  tools: string[];
  connections: string[];
  loops: Array<{ name: string; cron?: string; trigger?: string; enabled: false }>;
  skills: Array<{ name: string; description: string }>;
  apps: Array<{ name: string; capabilities: string[] }>;
  appCapabilities?: { free: string[]; elevated: string[] };
  /** kind=company: the staffing the blueprint describes. */
  company?: { roles: number; depth: number; monthlyUsd: number; playbooks: number; cadences: number; tunables: number; cards: string[] };
}
export interface RegistryItem {
  id: string;
  kind: RegistryKind;
  slug: string;
  name: string;
  description: string;
  version: number;
  publisherName: string;
  capabilities: RegistryCapabilities;
  scanReport: SkillScanReport;
  installs: number;
  ratingUp: number;
  ratingDown: number;
  publishedAt: string;
  updatedAt: string;
  /** `builtin`: a first-party starter blueprint shipped with the server. */
  source: 'local' | 'remote' | 'builtin';
  remoteUrl: string;
  installed?: boolean;
  /** First-party: badged "Official" and listed first. */
  official?: boolean;
}
export interface RegistryList {
  items: RegistryItem[];
  remote: { url: string; ok: boolean; error: string; fetchedAt: string | null };
}
/** The install review: everything shown before `confirm: true`. */
export interface RegistryReview {
  kind: RegistryKind;
  name: string;
  version: number;
  publisherName: string;
  source: 'local' | 'remote' | 'builtin';
  capabilities: RegistryCapabilities;
  loops: RegistryCapabilities['loops'];
  tools: string[];
  connections: string[];
  scanReport: SkillScanReport;
  charter?: string;
  skillBodies: Array<{ name: string; description: string; instructions: string }>;
  appHtml?: string;
  installs: string[];
}
export interface RegistryInstallOptions { workspaceId?: string; agentId?: string; name?: string }
export type RegistryInstallResult =
  | { requiresConfirm: true; review: RegistryReview }
  | { ok: true; agentId?: string; skillId?: string; appId?: string; notes: string[] };
export interface RegistryPublishInput {
  kind: RegistryKind;
  agentId?: string;
  skillId?: string;
  appId?: string;
  name?: string;
  description?: string;
  publisherName?: string;
  dryRun?: boolean;
}
export type RegistryPublishResult =
  | { dryRun: true; kind: RegistryKind; slug: string; name: string; description: string; publisherName: string; capabilities: RegistryCapabilities; scanReport: SkillScanReport }
  | { dryRun: false; item: RegistryItem; pushed: { attempted: boolean; ok: boolean; error?: string } };
export interface RegistryStatus {
  remoteUrl: string;
  publishToken: boolean;
  remote: { fetchedAt: string; items: number; error: string } | null;
}
/** GET /api/security (docs/security.md): the policy headline the hosted
 *  product shows under Settings → Security. */
export interface SecurityPolicy { contact: string; policyUrl: string; summary: string[] }

/** Who last wrote a file (docs/filesystem.md "Collaboration"). */
export interface FileAuthor { kind: 'user' | 'agent' | 'system' | (string & {}); id: string; name: string }

export interface FileEntry {
  path: string;
  size: number;
  lastModified?: string;
  /** Collaboration metadata — absent for objects written outside WorkspaceFs
   *  and on servers older than docs/filesystem.md. */
  version?: number;
  updatedBy?: FileAuthor | null;
  owner?: { agentId: string } | null;
}

/** `html` previews must render inside a sandboxed iframe (FR-13.1). */
export interface FilePreview {
  path: string;
  kind: 'markdown' | 'html' | 'image' | 'pdf' | 'audio' | 'text' | 'binary';
  size: number;
  contentType: string;
  text?: string;
  truncated?: boolean;
  base64?: string;
  version?: number;
  updatedBy?: FileAuthor | null;
  updatedAt?: string;
}

/** GET /api/workspaces/:id/file/revisions — newest first. */
export interface FileRevision { version: number; size: number; updatedBy?: FileAuthor | null; updatedAt: string }

/** A write through POST …/files with the optimistic version check. */
export interface FileWrite { path: string; contentBase64: string; contentType?: string; expectedVersion?: number }

/** Upload result; audio uploads (voice notes, docs/voice.md) also carry the
 *  transcript (null when transcription is off/unavailable) and a duration. */
export interface UploadResult {
  ok: boolean;
  path: string;
  transcript?: string | null;
  durationHint?: number | null;
}

export interface VoiceStatus { transcription: boolean; tts: boolean; model: string }

// ---- group chat (docs/group-chat.md) ----
export interface Channel {
  id: string; workspaceId: string; slug: string; name: string; topic: string; kind: 'public' | 'private';
  createdBy: string; folder: string; dailyTokenBudget: number; archivedAt: string | null; createdAt: string;
  /** Present on the list route. `pastSubs`: closed discussions of a top-level channel. */
  unread?: number; memberCount?: number; pastSubs?: number;
  /** Sub-channels (docs/group-chat.md §9): a discussion or meeting has a
   *  parent, `channelKind: 'sub'`, a purpose and a status; open ones are
   *  listed, closed ones fold into the parent's "Past discussions". */
  parentChannelId?: string | null; channelKind?: 'channel' | 'sub'; purpose?: string; status?: 'open' | 'closed';
  closedAt?: string | null; closedBy?: string | null; outcome?: string; meetingId?: string | null; taskId?: string | null; projectId?: string | null;
  linkMessageId?: string | null; originMessageId?: string | null; lastActivityAt?: string | null;
}
/** A discussion as its parent lists it (GET …/subs). */
export interface SubChannelSummary {
  id: string; slug: string; name: string; purpose: string; status: 'open' | 'closed'; kind: 'public' | 'private';
  memberCount: number; createdAt: string; closedAt: string | null; lastActivityAt: string | null;
  outcome: string; meetingId: string | null; linkMessageId: string | null; createdBy: string;
}
export interface ChannelMember {
  id: string; channelId: string; memberKind: 'agent' | 'human'; memberId: string; role: 'owner' | 'member';
  notify: 'all' | 'mentions' | 'none'; unprompted: number; joinedAt: string; name: string;
}
export interface ChannelDetail extends Channel {
  members: ChannelMember[]; spentToday: number; orgMode: boolean;
  /** Set when this is a unit channel (docs/group-chat.md §7). */
  unit?: { id: string; name: string; slug: string; orgId: string; leadAgentId: string } | null;
  /** A sub-channel's parent (docs/group-chat.md §9). */
  parent?: { id: string; slug: string; name: string; kind: 'public' | 'private' } | null;
  /** A channel's open discussions and how many closed ones it has. */
  subs?: SubChannelSummary[]; pastSubs?: number;
}
export interface ChannelMessage {
  id: string; channelId: string; threadRootId: string | null; authorKind: 'agent' | 'human' | 'system'; authorId: string;
  text: string; attachments: string; mentions: string; taskId: string | null; /** The task's key (docs/tasks-keys.md). */ taskKey?: string | null; runId: string | null; unprompted: number;
  editedAt: string | null; createdAt: string;
}
export interface ChannelPage { messages: ChannelMessage[]; replies: Record<string, { count: number; lastAt: string }>; hasMore: boolean }
export interface ChannelFile { path: string; name: string; size: number; lastModified?: string }

/** Follows (docs/follows.md): a channel thread (root message id), an org
 *  task or an agent kanban task, followed by agents and people. */
export type FollowTargetKind = 'thread' | 'org_task' | 'agent_task' | 'channel';
export interface FollowView {
  following: boolean;
  reason: string | null;
  followers: Array<{ followerKind: 'agent' | 'user'; followerId: string; reason: string; createdAt: string }>;
}
/** The Inbox's History (`GET …/inbox/history`; server/src/home/inbox-history.service.ts):
 *  what used to wait on me, resolved, by whom and how. */
export type HistoryKind = 'approvals' | 'keys' | 'escalations' | 'plans' | 'mytasks' | 'incidents' | 'following';
export type HistoryOutcome = 'approved' | 'rejected' | 'revision_requested' | 'expired' | 'released' | 'failed' | 'denied' | 'refused' | 'applied' | 'vetoed' | 'contained' | 'resolved' | 'done' | 'cancelled' | 'seen';
export interface HistoryItem {
  key: string; kind: HistoryKind; title: string; detail: string; outcome: HistoryOutcome;
  by: { kind: 'you' | 'person' | 'delegate' | 'default' | 'agent' | 'system'; name: string; id?: string };
  withoutYou: boolean; at: string;
  link: { type: 'approval' | 'action' | 'plan' | 'incident' | 'task' | 'thread' | 'agent_task'; id: string; sessionId?: string; href?: string };
  undo?: { kind: 'revoke_delegation'; delegationId: string; label: string } | { kind: 'reopen_task'; taskId: string; label: string };
}
export interface HistoryPage { items: HistoryItem[]; nextCursor: string | null }
export interface HistoryParams { kind?: HistoryKind; q?: string; from?: string; to?: string; cursor?: string; limit?: number; without?: boolean }
/** One of the caller's follows with what is new on it (`GET …/follows/mine`). */
export interface FollowRow {
  id: string; workspaceId: string; followerKind: 'agent' | 'user'; followerId: string; targetKind: FollowTargetKind; targetId: string;
  reason: string; title: string; link: string; createdAt: string; mutedAt: string | null; lastSeenAt: string | null;
  unseenCount: number; lastActivity: string; lastActorName: string; lastActivityAt: string | null;
  attentionAt: string | null; attention: string; closedAt: string | null;
}
export type WorkspaceEvent =
  | { type: 'hello'; workspaceId: string }
  | { type: 'channel_message'; workspaceId: string; channelId: string; message: ChannelMessage }
  | { type: 'channel_typing'; workspaceId: string; channelId: string; threadRootId: string | null; replyRootId?: string; agentId: string; liveId: string; on: boolean }
  | { type: 'channel_stream'; workspaceId: string; channelId: string; threadRootId: string | null; replyRootId?: string; agentId: string; liveId: string; delta: string; done?: boolean }
  | { type: 'task_update'; workspaceId: string; channelId: string; taskId: string; status: string; messageId: string | null; title: string }
  | { type: 'channel_update'; workspaceId: string; channelId: string }
  /** docs/meetings.md "During": a meeting's room changed; refetch it. */
  | { type: 'meeting_update'; workspaceId: string; channelId: string; meetingId: string; threadRootId: string | null; status: string }
  /** docs/filesystem.md "Activity": a write through WorkspaceFs. */
  | { type: 'file.changed' | 'file_changed'; workspaceId?: string; path: string; version?: number; by?: FileAuthor | string | null }
  | { type: 'channel_approval'; workspaceId: string; channelId: string; threadRootId: string | null; agentId: string; sessionId: string; callId: string; tool: string; input: Record<string, unknown>; forActor: string; forName: string }
  /** docs/home.md "Top bar": a turn started (`on`) or ended in the workspace; `running` counts the turns running there now. */
  | { type: 'turn_live'; workspaceId: string; sessionId: string; agentId: string | null; on: boolean; running: number };

export interface SearchResults {
  /** Group-chat hits (the same FTS extended to channel messages). */
  channelMessages?: Array<{ channelId: string; slug: string; messageId: string; threadRootId: string | null; authorKind: string; authorId: string; snippet: string; createdAt: string }>;
  sessions: Array<{ id: string; name: string; autoTitle: string }>;
  messages: Array<{ sessionId: string; messageId: string; turnId: string; role: string; snippet: string }>;
  files: Array<{ path: string; size: number }>;
}

// ---- the company is the workspace (docs/group-chat.md §5, /api/workspaces/:id/org) ----
export type OrgTaskStatus = 'backlog' | 'waiting' | 'todo' | 'claimed' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
export const ORG_TASK_STATUSES: OrgTaskStatus[] = ['backlog', 'waiting', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];

export interface Org {
  id: string; workspaceId: string; name: string; mission: string; ceoUserNote: string;
  chiefOfStaffAgentId: string | null; status: 'active' | 'paused';
  monthlyBudgetUsd: number; maxDepth: number; maxDirectReports: number; briefHour: number;
  lastBriefAt: string | null; lastBrief: string; createdAt: string;
}
export interface OrgMember {
  id: string; orgId: string; agentId: string; title: string; reportsToAgentId: string | null; depth: number;
  sponsor: string; scopes: string; status: 'active' | 'paused' | 'terminated'; charterHash: string; joinedAt: string;
}
export type OrgGoalKind = 'vision' | 'objective' | 'key_result';
export interface OrgGoal {
  id: string; orgId: string; title: string; description: string; status: string; ownerAgentId: string | null; unitId: string | null; parentGoalId: string | null; createdAt: string;
  /** Intent (docs/company-vision.md §2, item 18): the kind and the key-result
   *  fields; `confidence` 0–1 (null = never checked in); `atRisk` is the
   *  model-free assessment with its reason. The vision keeps its horizon in dueAt. */
  kind: OrgGoalKind; metric: string; targetValue: number | null; currentValue: number | null; startValue: number | null; unitLabel: string; dueAt: string | null;
  confidence: number | null; atRisk: number; atRiskReason: string; lastCheckInAt: string | null; checkInCadenceDays: number;
  /** Sensing (item 27): the metric source the value comes from, and when it was last measured. */
  metricSourceId?: string | null; lastMeasuredAt?: string | null;
  /** Value accounting (item 31): USD per unit of movement toward the target, USD on achieving it, the CEO's note. */
  valuePerUnit?: number | null; valueOnAchieve?: number | null; valueNote?: string;
}
/** Units (docs/group-chat.md §7): a board, a channel and a goal tracker per org level. */
export interface OrgUnit {
  id: string; orgId: string; leadAgentId: string; parentUnitId: string | null; name: string; slug: string; channelId: string | null; archivedAt: string | null; createdAt: string;
  /** The board's task key prefix (docs/tasks-keys.md), e.g. ENG. */
  taskKey?: string | null;
}
export interface OrgUnitNode extends OrgUnit { memberAgentIds: string[]; counts: { openTasks: number; tasks: number; goals: number }; children: OrgUnitNode[] }
export interface OrgGoalNode extends OrgGoal { progress: number; tasks: { total: number; done: number }; children: OrgGoalNode[] }
/** A project (docs/work-tracking.md): the middle level, goal / key result → project → task. */
export interface OrgProject {
  id: string; orgId: string; goalId: string | null; title: string; status: string; ownerAgentId: string | null; createdAt: string;
  key?: string | null; goalIds?: string; leadHumanId?: string | null; unitId?: string | null;
  /** project | unsorted | operating (the per-unit system projects). */
  kind?: 'project' | 'unsorted' | 'operating' | string;
  /** JSON { problem, hypothesis, done_when, mvp }; milestones JSON Milestone[]. */
  brief?: string; startDate?: string | null; targetDate?: string | null; milestones?: string;
  appetiteDays?: number; appetiteUsd?: number; lane?: 'now' | 'next' | 'later' | string; rank?: number;
  health?: '' | 'on_track' | 'at_risk' | 'off_track' | string; healthReason?: string; healthAsk?: string; healthAt?: string | null;
  hill?: number | null; updateCadenceDays?: number | null; breakerAt?: string | null; updatedAt?: string | null;
}
export type TaskSource = 'plan' | 'meeting' | 'retro' | 'incident' | 'escalation' | 'agent' | 'ceo' | 'chat';
export type BlockedKind = 'task' | 'person' | 'agent' | 'manager' | 'ceo' | 'external' | 'decision';
/** The one structured blocker (org_tasks.blockedOn, stored as JSON). */
export interface BlockedOn { kind: BlockedKind; ref: string; reason: string; since: string; by?: string }
export interface Milestone { id: string; name: string; date: string | null; done: boolean; doneAt?: string | null }
export interface ProjectBrief { problem: string; hypothesis: string; done_when: string; mvp: string }
export interface ProjectForecast { state: 'range' | 'insufficient' | 'done'; remaining: number; samples: number; p50: string | null; p85: string | null; note: string }
/** One row of the roadmap (server ProjectSummary). */
export interface ProjectSummary {
  id: string; key: string | null; title: string; kind: string; status: string; lane: string; rank: number;
  unitId: string | null; unitName: string | null;
  lead: { kind: 'agent' | 'person' | 'none'; id: string | null; name: string };
  goalIds: string[]; goals: Array<{ id: string; title: string; kind: string; parentGoalId: string | null }>;
  startDate: string | null; targetDate: string | null; milestones: Milestone[];
  progress: { done: number; total: number; pct: number };
  hill: number | null; hillInferred: boolean;
  health: string; healthReason: string; healthAsk: string; healthAt: string | null;
  update: { state: 'none' | 'fresh' | 'due' | 'missing'; dueAt: string | null; cadenceDays: number };
  appetite: { days: number; usd: number; spentUsd: number; usdShare: number | null; daysUsed: number | null; daysShare: number | null; tripped: boolean; breakerAt: string | null };
  blocked: number; late: boolean; overBudget: boolean;
  forecast: ProjectForecast;
  briefOk: boolean;
  createdAt?: string;
}
/** GET /api/workspaces/:id/org/roadmap. */
export interface RoadmapData {
  generatedAt: string; today: string; projects: ProjectSummary[];
  goals: Array<{ id: string; title: string; kind: string; parentGoalId: string | null; status: string; dueAt: string | null }>;
  units: Array<{ id: string; name: string; parentUnitId: string | null }>;
  system: ProjectSummary[];
}
export interface ProjectUpdate { id: string; orgId: string; projectId: string; health: string; reason: string; ask: string; body: string; hill: number | null; diff: string; by: string; createdAt: string }
export interface ProjectPageTask {
  id: string; key: string | null; title: string; status: OrgTaskStatus; assigneeAgentId: string | null; assigneeHumanId: string | null; source: TaskSource | string;
  dueAt: string | null; doneAt: string | null; startedAt: string | null; updatedAt: string; unitId: string | null;
  assigneeName: string; blockedOn: BlockedOn | null; blockedText: string; steps: { done: number; total: number };
}
/** GET /api/workspaces/:id/org/projects/:projectId — the project page. */
/** A project's cross-functional team (docs/work-tracking.md "Project teams"). */
export interface ProjectTeamMember {
  id: string; kind: 'agent' | 'person'; agentId: string | null; humanId: string | null; name: string; title: string;
  role: string; allocation: number; status: 'active' | 'pending' | string;
  homeUnit: { id: string; name: string; slug: string } | null; managerName: string; totalAllocation: number; openTasks: number; approvalId: string | null; joinedAt: string;
}
export interface ProjectTeam {
  projectId: string; key: string | null; title: string; lead: { agentId: string | null; name: string };
  channel: { id: string; slug: string } | null; standup: { cron: string; nextAt: string | null; lastAt: string | null };
  members: ProjectTeamMember[]; units: string[];
}
export interface ProjectPage {
  project: ProjectSummary & { brief: ProjectBrief; createdAt: string; createdBy: string; updateCadenceDays: number | null };
  /** The cross-functional team with its home units (null for a system project). */
  team?: ProjectTeam | null;
  updates: ProjectUpdate[];
  tasks: ProjectPageTask[];
  blockers: Array<{ taskId: string; key: string | null; title: string; kind: string; text: string; since: string }>;
  decisions: Array<{ id: string; kind: string; title: string; status: string; at: string; via: 'card' | 'log' }>;
  files: Array<{ path: string; taskId: string }>;
  burn: Array<{ day: string; usd: number }>;
  throughput: Array<{ week: string; done: number }>;
}
export type PortfolioKind = 'off_track' | 'at_risk' | 'update_missing' | 'over_budget' | 'late' | 'tripped';
/** Home's portfolio (server HomePortfolio): exceptions first, then the digest since the last visit. */
export interface HomePortfolio {
  counts: { now: number; next: number; later: number; atRisk: number; offTrack: number; updateMissing: number; overBudget: number; late: number };
  exceptions: Array<{ projectId: string; key: string | null; title: string; kinds: PortfolioKind[]; detail: string; leadName: string }>;
  digest: Array<{ at: string; projectId: string; key: string | null; title: string; kind: 'health' | 'lane' | 'done' | 'milestone' | 'created' | 'breaker' | 'target'; text: string }>;
  doneByProject: Array<{ projectId: string; key: string | null; title: string; done: number }>;
  /** The projects in Now, in rank order: Home's roadmap snapshot. */
  nowProjects?: HomeNowProject[];
}
export interface HomeNowProject {
  projectId: string; key: string | null; title: string; health: '' | 'on_track' | 'at_risk' | 'off_track';
  progress: { done: number; total: number; pct: number }; targetDate: string | null; late: boolean; blocked: number; leadName: string;
}
export interface TaskTransition { id: string; orgId: string; taskId: string; fromStatus: string; toStatus: string; actor: string; reason: string; backfilled: number; at: string }
export interface ProjectPatch {
  title?: string; lane?: string; rank?: number; status?: string; startDate?: string | null; targetDate?: string | null;
  brief?: Partial<ProjectBrief>; appetiteDays?: number; appetiteUsd?: number; goalIds?: string[]; ownerAgentId?: string | null; updateCadenceDays?: number | null;
}
export interface OrgBudget { id: string; orgId: string; scope: 'company' | 'agent' | 'project'; refId: string; monthlyUsd: number; reservedUsd: number; spentUsd: number; month: string }
export interface OrgGrant { id: string; orgId: string; agentId: string; kind: string; value: string; grantedBy: string; createdAt: string }
export interface OrgDetail extends Org {
  members: OrgMember[]; goals: OrgGoal[]; projects: OrgProject[]; budgets: OrgBudget[]; grants: OrgGrant[];
  charterDrift: Array<{ agentId: string; name: string; recorded: string; live: string }>;
}
export interface OrgTaskBrief { outcome: string; context: string; constraints: string; done_when: string }
export interface OrgTask {
  /** Task key (docs/tasks-keys.md), e.g. ENG-12; null on a task from before keys. */
  key?: string | null;
  id: string; orgId: string; projectId: string | null; parentTaskId: string | null; title: string; brief: string;
  status: OrgTaskStatus; assigneeAgentId: string | null; claimedBy: string | null; claimedAt: string | null;
  reviewerAgentId: string | null; reviewRounds: number; blockers: string; fileScope: string; noProgressCount: number;
  lastRunAt: string | null; createdBy: string; createdAt: string; updatedAt: string;
  /** Units (docs/group-chat.md §7). */
  unitId: string | null; unitExplicit: number;
  /** Capital (item 23): the task class routing reads; hybrid staff (item 24): a human owner / reviewer by account id. */
  class?: string; assigneeHumanId?: string | null; reviewerHumanId?: string | null;
  /** Executable acceptance (item 27, docs/sensing.md §3): the JSON check list,
   *  who accepted it (`check` | `review` | ''), and on board routes how a done
   *  task was verified. */
  checks?: string; acceptedBy?: string; verification?: 'check' | 'review' | 'none' | null;
  /** Capacity (item 31): JSON task ids it waits on, its deadline; on board routes the unmet
   *  dependencies (`waitingOn`) and the expected duration from history. */
  dependsOn?: string; dueAt?: string | null; waitingOn?: string[];
  expected?: { runs: number | null; hours: number | null; samples: number; basis: 'member' | 'class' | 'none' };
  /** Work tracking (docs/work-tracking.md): where it came from, the one
   *  structured blocker (JSON BlockedOn, '' when none), the checklist steps
   *  (JSON), the done event's clocks and a circular-behaviour pause. */
  source?: TaskSource | string; blockedOn?: string; steps?: string;
  startedAt?: string | null; doneAt?: string | null; blockedSeconds?: number; wakesPausedAt?: string | null;
}
export interface OrgRun {
  id: string; orgId: string; taskId: string; agentId: string; sessionId: string | null; wakeReason: string;
  status: string; outcome: string; tokensIn: number; tokensOut: number; usd: number; startedAt: string; endedAt: string | null;
}
export interface OrgMessage {
  id: string; orgId: string; taskId: string | null; fromAgentId: string | null; runId: string | null; text: string; createdAt: string;
  /** Resolved `@mentions` (docs/work-tracking.md "Mentions"): JSON `[{ kind, id }]`. */
  mentions?: string;
  /** The person who wrote it ('' for agents and the system). */
  fromUserId?: string;
}
/** Who may be tagged on a company's tasks (the comment box's @ list). */
export interface OrgMentionable { kind: 'agent' | 'human'; id: string; name: string; status?: string }
export type OrgApprovalKind = 'hire' | 'scope_widen' | 'reorg' | 'budget_raise' | 'strategy' | 'external' | 'terminate' | 'escalation' | 'tune' | 'cadence' | 'routing' | 'charter_change' | 'blueprint' | 'human_review'
  | 'two_key' | 'metric_source' | 'experiment' | 'member_settings' | 'project_now' | 'project_appetite' | 'project_kill' | 'project_allocation' | 'resource_conflict';
export interface OrgApproval {
  id: string; orgId: string; kind: OrgApprovalKind; payload: string; requestedBy: string; recommendation: string;
  status: 'pending' | 'approved' | 'rejected' | 'revision_requested' | 'expired'; decidedAt: string | null; decidedBy?: string; decisionNote: string; expiresAt: string | null; createdAt: string;
  /** The decision card (item 31, docs/owners-seat.md §1): `alternatives` is JSON string[];
   *  `defaultAction` is applied at `deadline` ('' = none); `decidedVia` is '' | default | delegate:<…>. */
  recommendedAction?: 'approve' | 'deny' | 'modify' | ''; alternatives?: string; reversibility?: 'reversible' | 'costly' | 'irreversible' | '';
  confidence?: number | null; deadline?: string | null; defaultAction?: 'approve' | 'deny' | ''; decidedVia?: string;
  /** Decision routing (docs/owners-seat.md §7): who holds it now ('ceo', 'agent:<id>', 'human:<id>'), its hops, why it is CEO-reserved. */
  holder?: string; holderName?: string; hopDeadline?: string | null; reserved?: string; urgency?: 'normal' | 'urgent' | string; chain?: string;
  /** "Writer → Head of Content → Chief → you" and each hop with names (GET …/approvals). */
  chainLine?: string; chainHops?: DecisionHopView[];
  /** It waits on the viewer now (false while a manager above the requester still holds it). */
  forYou?: boolean;
}
export interface DecisionHopView { at: string; action: 'raised' | 'escalated' | 'timed_out' | 'sent_back' | 'decided' | string; by: string; byName: string; from: string; to: string; toName: string; recommendation?: string; reasoning?: string; decision?: string; sameModel?: boolean }
export interface OrgAuditRow { id: string; orgId: string; seq: number; actor: string; action: string; refType: string; refId: string; payload: string; prevHash: string; hash: string; createdAt: string }
export interface OrgBrief { orgId: string; at: string; text: string; items: Array<{ n: number; approvalId: string; kind: string; summary: string }> }
/** GET /api/workspaces/:id/org — mode, caps and the full org detail when enabled. */
export interface WorkspaceOrg {
  workspaceId: string; mode: OrgMode; chiefOfStaffAgentId: string | null; orgMonthlyUsd: number; orgAgentCap: number;
  orgId: string | null; orgStatus: 'active' | 'paused' | null; pendingApprovals: number; org: OrgDetail | null;
  /** The unit tree (docs/group-chat.md §7), empty without an organization. */
  units: OrgUnitNode[];
  enrolled?: string[]; notEnrolled?: Array<{ agentId: string; reason: string }>;
  /** Archived companies of the workspace (docs/owners-seat.md "Archive or delete the company"), newest first. */
  archived?: ArchivedOrg[];
}
/** An archived company: read-only, restorable, deletable. */
export interface ArchivedOrg {
  id: string; name: string; mission: string; archivedAt: string | null; archivedBy: string;
  restoreStatus: 'active' | 'paused'; restoreMode: OrgMode; members: number; deleting: boolean;
}
/** GET …/org/archived/:orgId — the read-only "Archived company" view. */
export interface ArchivedOrgDetail {
  org: { id: string; name: string; mission: string; values: string; culture: string; rules: string; chiefOfStaffAgentId: string | null; monthlyBudgetUsd: number; createdAt: string; archivedAt: string | null; archivedBy: string; restoreStatus: 'active' | 'paused'; restoreMode: OrgMode; deleting: boolean };
  members: Array<{ agentId: string; title: string; status: string; reportsToAgentId: string | null; depth: number; name: string | null; emoji: string | null; exists: boolean }>;
  goals: Array<{ id: string; title: string; kind: string; status: string }>;
  projects: Array<{ id: string; title: string; status: string }>;
  units: Array<{ id: string; name: string; slug: string; leadAgentId: string; parentUnitId: string | null; channelId: string | null }>;
  decisions: Array<{ id: string; title: string; decision: string; decidedBy: string; createdAt: string }>;
  audit: Array<{ seq: number; actor: string; action: string; createdAt: string }>;
  /** Rows per org table. */
  counts: Record<string, number>;
  orgFiles: number;
  liveCompany: { id: string; name: string } | null;
  canRestore: boolean;
}
export interface DeleteOrgBody { orgId?: string; confirmName: string; agents?: 'keep' | 'delete'; files?: 'keep' | 'delete'; channels?: 'archive' | 'keep' | 'delete' }
export interface DeleteOrgReport {
  ok: true; orgId: string; name: string; alreadyDeleted?: boolean; rows: Record<string, number>;
  agents: { choice: 'keep' | 'delete'; deleted: string[]; kept: string[] };
  files: { choice: 'keep' | 'delete'; moved?: number; to?: string; deleted?: number; skipped?: string };
  channels: { choice: 'archive' | 'keep' | 'delete'; archived: number; reopened: number; deleted: number };
}
export interface OrgCaps { maxDepth: number; maxDirectReports: number; defaultAgentCap: number; rules: string[]; /** The default veto window on autonomous plans (minutes), for the wizard. */ vetoWindowMinutes?: number }
// ---- company onboarding (execution plan item 25) ----
/** POST …/org/bootstrap — the whole company setup in one call. */
export interface BootstrapBody {
  mode: 'supervised' | 'autonomous';
  chief: { agentId: string } | { create: { name: string; provider?: string; model?: string } };
  monthlyUsd: number; agentCap?: number;
  vision?: { title: string; description?: string; horizonDays?: number; dueAt?: string | null; rules?: string };
  profile?: { values?: string; culture?: string };
  tunables?: Record<string, number>;
  cadences?: 'profile' | 'default' | 'light' | 'none';
  roles?: string[];
  planNow?: boolean;
}
export interface BootstrapHire { role: string; status: 'proposed' | 'hired' | 'skipped'; note: string; approvalId?: string; agentId?: string }
export interface BootstrapSummary {
  workspaceId: string; orgId: string; mode: 'supervised' | 'autonomous';
  chief: { agentId: string; name: string; created: boolean }; enrolled: number;
  vision: { goalId: string; title: string; dueAt: string | null } | null;
  profile: { values: boolean; culture: boolean };
  tunables: Array<{ key: string; from: number; to: number }>;
  cadences: { mode: 'default' | 'light' | 'none'; disabled: number; total: number };
  hires: BootstrapHire[]; planning: 'queued' | 'not_requested' | 'unavailable'; notes: string[];
}
/** One entry of the role catalog (item 24, `GET …/org/roles?profile=`:
 *  `{ profile, roles: Role[] }`, ranked by the profile text with the matched
 *  `fits` tags). A hire names it as `role:<id>`. */
export interface OrgRole {
  id: string; title: string; charter: string; competencies: string[];
  /** Meet-rule scope strings the role starts with; the chief's holdings cap them. */
  toolScopes: string[];
  modelTier: 'cheap' | 'standard' | 'strong' | string; estMonthlyUsd: number; fits: string[];
  score?: number; matched?: string[];
}
/** `usd` is spent (settled); `reservedUsd` is held for runs in flight, not spent. Tokens and `runs` are task runs'. */
export interface OrgSpendNode { usd: number; tokensIn: number; tokensOut: number; runs: number; monthlyUsd: number; reservedUsd: number }
/** `GET …/org/spend`: the company's spend ledger over `window` (the UTC month to now; server/src/org/spend-ledger.ts).
 *  The company's `usd` is every dollar charged to its envelope — task runs plus meetings, reviews, planning and
 *  audits (`overheadUsd`) — and the members' `usd` add up to it. A project's is its tasks' runs. */
export interface OrgSpend {
  month: string; window?: { from: string; to: string };
  company: OrgSpendNode & { overheadUsd?: number; todayUsd?: number };
  projects: Array<OrgSpendNode & { id: string; title: string }>;
  members: Array<OrgSpendNode & { agentId: string; name: string; title: string; status?: string; overheadUsd?: number; todayUsd?: number }>;
  acceptedTasks: number; costPerAcceptedTask: number | null; series: UsageDay[];
}

// ---- the CEO's seat (docs/company-vision.md §8; execution plan items 18–21) ----
export type Pace = 'onPace' | 'behind' | 'unknown';
/** GET …/org/intent?unitId= — the goal tree with pace, measured progress, confidence, risk and owner. */
export interface OrgIntentNode extends OrgGoal {
  progress: number; tasks: { total: number; done: number };
  pace: Pace; expected: number | null; measured: number | null; ownerName: string | null;
  /** Item 27: the source a key result is measured by, or `selfReported`. */
  measuredBy?: { sourceId: string; name: string; kind: string; lastFetchedAt: string | null; status: string } | null;
  selfReported?: boolean;
  children: OrgIntentNode[];
}
export interface OrgVisionInfo { vision: OrgGoal | null; rules: string; values: string; culture: string }
export interface OrgProfile { values: string; culture: string; rules: string; mission: string }
export type TunableArea = 'intent' | 'planning' | 'rituals' | 'assurance' | 'heartbeat' | 'brief' | 'chat';
/** GET …/org/tunables — every tunable with its default, bound, area and the org's effective/stored value. */
export interface OrgTunable { key: string; default: number; min: number; max: number; description: string; area: TunableArea; value: number; stored: number | null }
export interface OrgCheckin { id: string; orgId: string; goalId: string; actor: string; currentValue: number | null; confidence: number | null; note: string; createdAt: string }
export interface WhyLink { kind: 'task' | 'vision' | 'objective' | 'key_result'; id: string; title: string; status: string }
export interface WhyChain { chain: WhyLink[]; broken: boolean; brokenAt: string | null; linked: boolean }
export type SignalSeverity = 'info' | 'warn' | 'critical';
export interface OrgSignal {
  id: string; orgId: string; unitId: string | null; kind: string; severity: SignalSeverity; refType: string; refId: string; title: string; detail: string;
  addresseeKind: 'owner' | 'lead' | 'chief' | 'ceo'; addresseeId: string; dayKey: string; status: 'open' | 'acked' | 'resolved'; ackNote: string; ackedAt: string | null; resolvedAt: string | null; createdAt: string;
}
export interface SloTargets { cycleTimeHours: number; firstReviewAcceptancePct: number; decisionLatencyHours: number }
export interface SloMetrics {
  dayKey: string; windowDays: number; cycleTimeHours: number | null; cycleTimeByClass: Record<string, number>; firstReviewAcceptancePct: number | null;
  costPerAcceptedTaskUsd: number | null; decisionLatencyHours: number | null; goalsOwnedPct: number | null; goalsAtRiskPct: number | null; spendVsEnvelopePct: number | null;
  acceptedTasks: number; runs: number; decisions: number; openCriticalSignals: number;
}
export interface PulseWeights { cycle: number; acceptance: number; latency: number; health: number; criticalPenalty: number }
/** GET …/org/pulse — the score, today's metrics, targets, breaches and the 30-day series. */
export interface OrgPulse {
  score: number; today: SloMetrics; targets: SloTargets; weights: PulseWeights;
  breaches: Array<{ metric: keyof SloTargets; value: number; target: number; detail: string }>;
  worst: Array<{ metric: keyof SloTargets; value: number | null; target: number; ratio: number }>;
  series: Array<{ day: string; score: number | null; metrics: SloMetrics | null }>;
}
export interface OrgSloInfo { targets: SloTargets; weights: PulseWeights; tunables: Record<string, number>; bounds: Record<string, { default: number; min: number; max: number; doc: string }> }
export interface OrgAuditRun {
  id: string; orgId: string; auditorAgentId: string; trigger: 'cadence' | 'manual' | 'assurance' | 'redteam'; startedAt: string; endedAt: string | null; sampled: string; findings: string; summary: string;
  singleModel: number; model: string; usd: number; status: 'running' | 'done' | 'failed' | 'budget_stop'; createdAt: string;
  /** Audit of the auditor (item 29): JSON SpotCard[]; precision / recall as of the latest answer; 1 when the seat could not rotate. */
  spotChecks?: string; precision?: number | null; recall?: number | null; noRotation?: number;
}
export interface AuditFinding { severity: string; kind: string; refType: string; refId: string; title: string; detail: string }
export type MeetingKind = 'planning' | 'standup' | 'weekly_review' | 'retro' | 'board' | 'adhoc';
export const MEETING_KINDS: MeetingKind[] = ['planning', 'standup', 'weekly_review', 'retro', 'board', 'adhoc'];
export type MeetingStatus = 'scheduled' | 'running' | 'done' | 'cancelled' | 'postponed' | 'skipped';
/** A person's verdict on a proposal in the room (docs/meetings.md "During"). */
export interface ProposalVerdict { verdict?: 'approved' | 'rejected'; verdictBy?: string; verdictName?: string }
export interface MinutesAction extends ProposalVerdict { title: string; owner: string; done_when: string; outcome: string; by: string; taskId?: string; taskKey?: string | null; messageId?: string; due?: string | null }
export interface MinutesDecision extends ProposalVerdict { title: string; decision: string; alternatives: string; rationale: string; by: string; decisionId?: string; messageId?: string }
export interface MinutesQuestion { question: string; by: string; messageId?: string; answer?: string; answeredBy?: string }
/** A retro's lesson (docs/company-vision.md §6, item 22): one sentence with an audience; may carry a proposed charter or playbook change. */
export type LessonAudience = 'member' | 'unit' | 'company';
export interface MinutesLesson { text: string; audience: LessonAudience; by: string; proposedCharterChange?: { agent: string; text: string; mode?: 'append' | 'replace'; approvalId?: string }; proposedPlaybookChange?: { playbookId: string; note: string; taskId?: string } }
export interface Minutes { summary: string; decisions: MinutesDecision[]; actions: MinutesAction[]; risks: Array<{ text: string; by: string }>; questions: MinutesQuestion[]; lessons?: MinutesLesson[]; parked?: Array<{ text: string; by: string; taskId?: string; taskKey?: string | null }>; endedBy?: string }
/** The live room of a meeting (`OrgMeeting.room`, JSON; docs/meetings.md "During"). */
export interface MeetingRoomState {
  items: string[]; current: number; itemStartedAt: string | null; itemMinutes: number; round: number; roundCap: number; extended: number;
  speaking: string | null; attendance: Record<string, 'waiting' | 'speaking' | 'spoke' | 'passed' | 'idle'>; passes: Array<{ agentId: string; round: number; reason: string }>;
  present: string[]; proposals: Array<{ text: string; why: string; byKind: 'agent' | 'human'; by: string; at: string }>; preRead: string;
  openItems: Array<{ title: string; owner: string; taskId: string | null; state: 'done' | 'late' | 'blocked' | 'open' | 'dropped'; status: string; due: string | null }>;
  verdicts: Record<string, { verdict: 'approved' | 'rejected'; by: string; byName: string; at: string; note?: string }>;
  answers: Record<string, { answer: string; by: string; byName: string; at: string }>;
  controls: { extend: number; skip: number; skipped: number; end: { by: string; at: string } | null };
  remindedAt: string | null; preparedAt: string | null; speakers: string[]; skipped: string | null;
  /** The agenda and pre-read file beside the minutes, once written. */
  agendaPath?: string | null;
  /** How each agenda item ended (settled / skipped / its time box ran out) and the minutes it took. */
  itemLog?: Array<{ index: number; how: 'settled' | 'skipped' | 'time'; at: string; minutes: number }>;
}
/** A meeting (docs/group-chat.md §8): a thread in a unit channel; `minutes` is JSON (Minutes). */
export interface OrgMeeting {
  id: string; orgId: string; unitId: string | null; channelId: string | null; threadRootId: string | null; kind: MeetingKind; title: string; agenda: string;
  facilitatorAgentId: string | null; attendees: string; status: MeetingStatus; scheduledFor: string | null; startedAt: string | null; endedAt: string | null;
  rounds: number; usd: number; minutes: string; createdBy: string; createdAt: string;
  /** The minutes document in the workspace tree (docs/meetings.md); null until the meeting ends. */
  minutesPath?: string | null; summary?: string;
  /** The live room (JSON MeetingRoomState) and the tokens it used (migration 0050). */
  room?: string; tokensIn?: number; tokensOut?: number;
  /** The channel it was called in when it runs in a sub-channel (`channelId`) of it (docs/group-chat.md §9). */
  parentChannelId?: string | null;
}
/** One row of GET …/meetings (docs/meetings.md "The calendar"): a meeting
 *  held or scheduled, or an upcoming occurrence of a cadence (`source: 'cadence'`). */
export interface CalendarMeeting {
  id: string; source: 'meeting' | 'cadence'; meetingId: string | null; cadenceId: string | null;
  kind: string; title: string; unitId: string | null; unitName: string | null; channelId: string | null; channelSlug: string | null;
  /** The sub-channel it ran in (docs/group-chat.md §9); `channelId` is then the channel it was called in. */
  subChannelId?: string | null; subChannelSlug?: string | null;
  status: MeetingStatus | 'upcoming'; at: string; endedAt: string | null;
  facilitator: { id: string; name: string } | null; attendees: Array<{ kind: 'agent' | 'human'; id: string; name: string }>;
  minutesPath: string | null; summary: string; cron: string | null; threadRootId: string | null;
  decisions: number; actions: number; rounds: number; usd: number;
  tokensIn?: number; tokensOut?: number;
}
export interface CalendarResponse { from: string; to: string; now: string; hasOrg: boolean; meetings: CalendarMeeting[] }
/** The decision log (docs/company-vision.md §6); referenced as `#decision:<id>`. */
export interface OrgDecision {
  id: string; orgId: string; unitId: string | null; meetingId: string | null; approvalId: string | null; title: string; decision: string; alternatives: string; rationale: string;
  decidedBy: string; refType: string; refId: string; createdAt: string;
}
export interface OrgCadence { id: string; orgId: string; unitId: string; kind: MeetingKind; cron: string; enabled: number; lastRunAt: string | null; nextRunAt: string | null; createdAt: string }

// ---- memory, capital, blueprints (docs/company-vision.md §6, §7, §9; execution plan items 22–24) ----
export type CitationKind = 'task' | 'decision' | 'goal' | 'meeting' | 'audit';
export interface Citation { kind: CitationKind; id: string; title: string }
/** GET …/org/recall?q= — the model-free pack behind an answer. */
export interface RecallPack {
  question: string; keywords: string[];
  goals: Array<{ id: string; kind: string; title: string; status: string; owner: string | null; atRisk: boolean; metric?: string }>;
  tasks: Array<{ id: string; title: string; status: string; owner: string | null; outcome: string; updatedAt: string }>;
  decisions: Array<{ id: string; title: string; decision: string; rationale: string; decidedBy: string; createdAt: string; meetingId: string | null }>;
  meetings: Array<{ id: string; kind: string; title: string; summary: string; endedAt: string | null; decisions: number; actions: number; lessons: number }>;
  signals: Array<{ id: string; kind: string; severity: string; status: string; title: string; refId: string }>;
  audit: Array<{ seq: number; actor: string; action: string; refType: string; refId: string; head: string; createdAt: string }>;
  messages: Array<{ id: string; channel: string; author: string; text: string; createdAt: string }>;
}
/** POST …/org/ask — the chief's read-only answer with its verified citations. */
export interface AskResult { answer: string; citations: Citation[]; stripped: string[]; usd: number; status: 'answered' | 'budget_stop' | 'busy' | 'failed'; pack: RecallPack }
export interface GraphNode { key: string; kind: string; id: string; title: string; status?: string; at?: string }
export interface GraphEdge { from: string; to: string; rel: string }
/** GET …/org/graph?ref=<kind:id>&depth= — the record around one thing. */
export interface OrgGraph { root: string; depth: number; nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }
export type PlaybookStatus = 'draft' | 'in_review' | 'active' | 'retired';
export interface PlaybookOutcomes { uses: number; up: number; down: number; successRate: number | null; lastUsedAt: string | null; refreshedAt: string }
export interface OrgPlaybook {
  id: string; orgId: string; skillId: string | null; name: string; title: string; body: string; ownerAgentId: string | null;
  /** JSON array of titles / role ids ('' = everyone). */
  roles: string; status: PlaybookStatus; version: number; sourceTaskId: string | null; reviewTaskId: string | null;
  /** JSON PlaybookOutcomes. */
  outcomes: string; why: string; createdAt: string; updatedAt: string;
}
export type PlanStatus = 'pending' | 'applied' | 'vetoed' | 'expired' | 'dry_run';
export interface PlanAction { tool: string; input: Record<string, unknown>; estimateUsd: number; summary: string }
export interface PlanActionResult { tool: string; summary: string; ok: boolean; output: string }
/** A plan awaiting the veto window (docs/company-vision.md §8): `actions` and `result` are JSON. */
export interface OrgPlan {
  id: string; orgId: string; trigger: string; summary: string; actions: string; estimateUsd: number; status: PlanStatus; vetoWindowMinutes: number;
  result: string; createdAt: string; applyAt: string | null; appliedAt: string | null; decidedBy: string;
}
export interface DryRunResult { result: string; plan: OrgPlan | null }
export type ForecastState = 'onTrack' | 'warn' | 'stop';
export interface ObjectiveCost {
  goalId: string; title: string; status: string; unitId: string | null; spentUsd: number; runs: number; shareOfSpend: number;
  envelopeUsd: number; envelopeSource: 'allocation' | 'company' | 'none'; envelopePct: number | null; progress: number;
  keyResults: { total: number; achieved: number; measuredPct: number | null }; allocation: { monthlyUsd: number; buys: string } | null; overspend: boolean; byClass: Record<string, number>;
}
/** GET …/org/costs?period= — cost per outcome. */
export interface CostReport {
  period: 'month' | 'all'; from: string | null; totalUsd: number; attributedUsd: number; unlinkedUsd: number; companyEnvelopeUsd: number; margin: number;
  vision: { goalId: string; title: string; spentUsd: number } | null; objectives: ObjectiveCost[]; byClass: Record<string, number>;
  byAgent: Array<{ agentId: string; name: string; usd: number; runs: number }>; costPerAcceptedTaskUsd: number | null;
}
export interface EnvelopeForecast { scope: 'company' | 'agent' | 'project' | 'objective'; refId: string; name: string; capUsd: number; spentUsd: number; dailyBurnUsd: number; projectedUsd: number; projectedPct: number | null; state: ForecastState }
/** GET …/org/forecast — the trailing-window projection per envelope. */
export interface OrgForecast { month: string; day: number; daysInMonth: number; windowDays: number; warnPct: number; criticalPct: number; company: EnvelopeForecast; agents: EnvelopeForecast[]; projects: EnvelopeForecast[]; objectives: EnvelopeForecast[] }
export type ModelTier = 'cheap' | 'standard' | 'strong';
export const MODEL_TIERS: ModelTier[] = ['cheap', 'standard', 'strong'];
export const TASK_CLASSES = ['triage', 'research', 'synthesis', 'review', 'ops', 'general'] as const;
/** GET|PUT …/org/routing — class → tier, and the CEO's pinned model per tier. */
export interface OrgRouting { classes: Record<string, ModelTier>; models: Partial<Record<ModelTier, string>> }
export interface OrgAllocation { id: string; orgId: string; goalId: string; unitId: string | null; scope: string; refId: string; monthlyUsd: number; rationale: string; createdAt?: string; updatedAt?: string }
export type ReplayKind = 'woke' | 'ran' | 'decided' | 'signal' | 'plan' | 'spend' | 'change';
export interface ReplayEntry { at: string; kind: ReplayKind; seq: number | null; title: string; usd: number | null; refType: string; refId: string }
/** GET …/org/replay?day= — one day of the company with the chain check. */
export interface OrgReplay {
  day: string; entries: ReplayEntry[];
  totals: { runs: number; usd: number; decisions: number; signals: number; plans: number; auditRows: number };
  chain: { ok: boolean; rows: number; fromSeq: number | null; toSeq: number | null; brokenAt: number | null; reason?: string };
}
/** COMPANY.json v1 (docs/blueprints.md). */
export interface BlueprintRole { roleId?: string; title: string; charter: string; reportsTo: string | null; scopes: string[]; modelTier: ModelTier; monthlyUsd: number }
export interface Blueprint {
  format: string; name: string; description: string; profile: { values: string; culture: string; rules: string };
  vision?: { title: string; description: string; horizonDays: number }; roles: BlueprintRole[]; units?: Array<{ title: string; parent: string | null }>;
  cadences?: Array<{ unitTitle: string; kind: string; cron: string }>; tunables: Record<string, number>; routing?: Record<string, string>;
  playbooks: Array<{ name: string; skillMd: string }>; budget: { monthlyUsd: number; allocations?: Record<string, number> }; cards?: string[];
  origin: { exportedFrom: string; at: string; sourceOrgId: string };
}
export type ImportMode = 'supervised' | 'autonomous';
export interface PlannedHire { title: string; roleId?: string; reportsTo: string; requestedScopes: string[]; scopes: string[]; dropped: string[]; modelTier: string; model: string; monthlyUsd: number }
/** POST …/org/blueprint/plan — the dry run of an import. */
export interface BlueprintImportPlan {
  ok: boolean; name: string; mode: ImportMode; chief: { title: string; roleId?: string; scopes: string[]; dropped: string[]; modelTier: string; model: string };
  hires: PlannedHire[]; units: Array<{ title: string; parent: string | null }>; budget: { monthlyUsd: number; allocations: Record<string, number>; allocated: number };
  tunables: Array<{ key: string; value: number; applied: number; note?: string }>; profile: { values: boolean; culture: boolean; rules: boolean };
  vision: { title: string; horizonDays: number } | null; playbooks: Array<{ name: string }>; cadences: { count: number; applied: boolean; note: string; list?: Array<{ unitTitle: string; kind: string; cron: string }> };
  recommendedCards: string[]; recommendedConnections: string[]; approval: 'blueprint' | 'none'; notes: string[];
  /** Roadmap items with their lead and cross-functional team, by role title (blueprint v1 `projects`). */
  projects?: Array<{ title: string; lead: string; team: Array<{ title: string; role: string; allocation: number }>; cadence: string | null; krs: string[] }>;
}
export interface BlueprintImportResult { orgId: string; importId: string; mode: ImportMode; chiefAgentId: string; hired: Array<{ agentId: string; title: string }>; projects?: Array<{ projectId: string; key: string | null; title: string }>; approvalId: string | null; playbooks: Array<{ skillId: string; name: string }>; notes: string[] }
export interface CompanyOutcomes { first_key_result: number; thirty_days_in_envelope: number }
/** GET /api/market/companies — published blueprints with their outcome counts. */
export interface CompanyRegistryItem extends RegistryItem { outcomes: CompanyOutcomes }
export type CompanyInstallResult =
  | { requiresConfirm: true; review: RegistryReview; plan: BlueprintImportPlan }
  | ({ ok: true; install: unknown } & BlueprintImportResult);

export const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#d97757', 'anthropic-compatible': '#d97757',
  openai: '#10a37f', deepseek: '#5c6cf2', kimi: '#8b5cf6',
  glm: '#00b894', gemini: '#4285f4', custom: '#94a3b8', echo: '#94a3b8',
};

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'allow-tool' | 'deny';

/** Independent reviewer's verdict on a tool call (docs/permissions.md §6). */
export interface ToolReview { verdict: 'allow' | 'ask' | 'deny'; reason: string; sensitive: string[]; model: string }

export type TurnEvent =
  | { type: 'turn'; turnId: string }
  | { type: 'compacted' }
  | { type: 'answer'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean; review?: ToolReview; actionClass?: string; actionId?: string; held?: 'held' | 'staged' }
  /** A long-running tool's progress line (code_agent's CLI steps). */
  | { type: 'tool_progress'; id: string; name: string; text: string }
  | { type: 'approval_required'; callId: string; tool: string; input: Record<string, unknown>; review?: ToolReview; routedTo?: { memberAccountId: string; name: string } }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  /** The workspace's monthly spend stop is reached; the turn still runs. */
  | { type: 'budget'; month: string; spentTokens: number; budgetTokens: number }
  /** The browser tool rendered a page; show its screenshot live. */
  | ({ type: 'browser'; sessionId: string } & BrowserStep)
  /** A computer_* action settled on the paired companion (docs/computer-control.md). */
  | {
    type: 'computer'; callId: string; tool: string; summary: string; status: 'ok' | 'error';
    workspaceId: string; screenshotPath?: string; width?: number; height?: number; at: string;
  }
  | { type: 'done' }
  | { type: 'error'; message: string };

// ---- accounts (docs/accounts.md) ----
export type AuthMode = 'single' | 'accounts';
export type Plan = 'free' | 'hosted' | 'byo';
export interface PlanLimits { maxAgents: number; maxLoops: number; hostedKeys: boolean; hostedUsd: number }
export interface AccountUsageMonth { month: string; tokensIn: number; tokensOut: number; usd: number; hostedUsd: number; turns: number }
export interface AccountSummary {
  mode: AuthMode; id: string; email: string; name: string; plan: Plan; status: string; isAdmin: boolean;
  limits: PlanLimits; usage: AccountUsageMonth; platformProviders: string[];
  billing: { provider: string; manageUrl: string | null };
}
export interface AccountDetail extends AccountSummary {
  keys: Array<{ provider: string; hasKey: boolean; types: number }>;
}
export type AuthMe =
  | { mode: 'single'; authenticated: true; account: AccountSummary }
  | { mode: 'accounts'; authenticated: true; account: AccountSummary }
  | { mode: 'accounts'; authenticated: false };

/** Tolerant reader of the role catalog: `{ roles: [...] }` (the route) or a
 *  bare array; a row needs an `id` and a `title` (or `name`); list fields
 *  default to empty so the wizard never reads undefined. */
export function normalizeRoles(raw: unknown): OrgRole[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { roles?: unknown }).roles) ? (raw as { roles: unknown[] }).roles : [];
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const out: OrgRole[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const title = typeof r.title === 'string' ? r.title : typeof r.name === 'string' ? r.name : '';
    if (!id || !title) continue;
    out.push({
      id, title, charter: typeof r.charter === 'string' ? r.charter : '', competencies: strs(r.competencies), toolScopes: strs(r.toolScopes),
      modelTier: typeof r.modelTier === 'string' ? r.modelTier : 'standard', estMonthlyUsd: typeof r.estMonthlyUsd === 'number' ? r.estMonthlyUsd : 0, fits: strs(r.fits),
      ...(typeof r.score === 'number' ? { score: r.score } : {}), ...(Array.isArray(r.matched) ? { matched: strs(r.matched) } : {}),
    });
  }
  return out;
}

// ---- sensing, actions & trust, incidents, experiments (execution plan items 27–30; SPA item 32) ----
export type MetricSourceKind = 'http_json' | 'webhook' | 'connection' | 'manual_attested';
export type MetricSourceStatus = 'pending_approval' | 'ok' | 'error' | 'stale' | 'rejected';
export type ConnectionQueryName = 'gmail_unread' | 'gmail_matching' | 'calendar_events_week' | 'drive_changed';
/** GET …/org/metrics/sources — secrets are names only; a webhook token is never listed. */
export interface MetricSource {
  id: string; orgId: string; name: string; kind: MetricSourceKind | string; config: Record<string, unknown>; secretNames: string[]; hasToken: boolean;
  unit: string; pollMinutes: number; status: MetricSourceStatus | string; lastValue: number | null; lastFetchedAt: string | null; lastError: string;
  nextPollAt: string | null; approvalId: string | null; activatedAt: string | null; createdBy: string; createdAt: string;
  boundKeyResults: Array<{ id: string; title: string }>;
}
export interface MetricProvenance { kind: string; url?: string; connection?: string; service?: string; query?: string; by?: string; note?: string; responseHash?: string; status?: number }
/** A sample; `provenance` is JSON (MetricProvenance). */
export interface MetricSample { id: string; sourceId: string; value: number; observedAt: string; fetchedAt: string; provenance: string; createdAt: string }
export interface MetricSourceInput { name?: string; kind?: MetricSourceKind; unit?: string; pollMinutes?: number; config?: Record<string, unknown>; secrets?: Record<string, string | null> }
/** A task check (docs/sensing.md §3). */
export type TaskCheck =
  | { kind: 'metric_at_least'; sourceId: string; value: number }
  | { kind: 'metric_increased'; sourceId: string; by: number; sinceTaskStart?: boolean }
  | { kind: 'http_status'; url: string; status?: number }
  | { kind: 'http_json_match'; url: string; selector: string; equals?: string | number | boolean; contains?: string; atLeast?: number }
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_matches'; path: string; contains?: string; regex?: string; jsonSchemaKeys?: string[] }
  | { kind: 'connection_query'; service: ConnectionQueryName; query: string; days: number; atLeast: number };
export type TaskCheckKind = TaskCheck['kind'];
export type CheckStatus = 'pass' | 'fail' | 'error' | 'pending';
export interface TaskCheckResult { index: number; check: TaskCheck; status: CheckStatus; detail: string; evidence: Record<string, unknown>; ranAt?: string }

export type ActionClass = 'read' | 'internal_write' | 'external_reversible' | 'external_irreversible' | 'money';
export type TrustLevel = 0 | 1 | 2 | 3;
export interface TrustClassRow {
  actionClass: ActionClass; level: TrustLevel; ceiling: TrustLevel; effective: TrustLevel; cleanCount: number; rejectStreak: number;
  lastIncidentAt: string | null; lastChangedAt: string | null; reason: string; counts: Record<string, number>;
}
/** GET /api/workspaces/:id/trust */
export interface TrustOverview {
  workspaceId: string; orgMode: string; ceilings: Record<ActionClass, TrustLevel>;
  matrix: Array<{ cls: ActionClass; levels: Record<string, string> }>;
  agents: Array<{ agentId: string; name: string; classes: TrustClassRow[] }>;
}
export type ActionStatus = 'started' | 'succeeded' | 'failed' | 'held' | 'staged' | 'refused' | 'denied';
/** One action_log row (docs/actions-and-trust.md §2); `input` and `keys` are JSON. */
export interface ActionLogRow {
  id: string; key: string; workspaceId: string; agentId: string | null; sessionId: string; orgId: string | null; tool: string; class: ActionClass | string; channel: string;
  inputHash: string; input: string; status: ActionStatus | string; decision: string; level: number | null; keys: string; stagedRef: string; result: string; resultHash: string;
  dedupeCount: number; revertedAt: string | null; note: string; createdAt: string; finishedAt: string | null;
}

export type IncidentSeverity = 'minor' | 'major' | 'critical';
export type IncidentStatus = 'open' | 'contained' | 'resolved';
export type ManualContainment = 'pause_member' | 'freeze_class' | 'supervised' | 'pause_org';
export interface ContainmentStep { action: 'note' | 'pause_member' | 'cancel_wakes' | 'freeze_class' | 'supervised' | 'pause_org' | string; at: string; result: string; reversible: boolean; undone?: boolean; data?: Record<string, string> }
export interface OrgIncident {
  id: string; orgId: string; workspaceId: string; kind: string; severity: IncidentSeverity; status: IncidentStatus; title: string; detail: string;
  agentId: string | null; actionClass: string | null; refType: string; refId: string; detectedBy: 'system' | 'auditor' | 'owner' | 'member' | string;
  containment: ContainmentStep[]; postmortemMeetingId: string | null; openedAt: string; containedAt: string | null; resolvedAt: string | null; resolution: string;
}
/** GET …/org/health (docs/incidents.md §4). */
export interface OrgHealth {
  status: 'ok' | 'degraded' | 'incident'; orgStatus: string; mode: string | null;
  providers: Array<{ workspaceId?: string; provider: string; state: 'degraded' | 'probing' | string; since?: string; until: string | null; failures: number; lastError: string }>;
  connections: Array<{ connectionId: string; provider: string; accountEmail: string; reason: string; since: string }>;
  frozenClasses: string[]; pausedByIncident: Array<{ agentId: string; name: string; incidentId: string }>;
  openIncidents: Array<{ id: string; kind: string; severity: IncidentSeverity; status: IncidentStatus; title: string; agentId: string | null; openedAt: string }>;
  lines: string[];
}
export interface SpotCard { itemId: string; kind: 'finding' | 'pass'; refType: string; refId: string; title: string; agree: boolean | null; note: string; answeredAt: string | null }
export interface AuditorQuality { precision: number | null; recall: number | null; answered: number; [k: string]: unknown }
export interface RedTeamResult { result: string; auditId: string | null; agentId: string | null; breach: boolean; recorded: string[] }

export type ExperimentStatus = 'proposed' | 'running' | 'extended' | 'kept' | 'reverted' | 'abandoned';
export type ChangeKind = 'tunable' | 'cadence' | 'routing' | 'playbook' | 'charter' | 'structure' | 'other';
export interface ExperimentStats { mean?: number; n?: number; sd?: number; from?: string; to?: string }
export interface ExperimentResult extends ExperimentStats { delta?: number; relative?: number | null; threshold?: number; verdict?: 'improved' | 'worse' | 'inconclusive' | 'harm' | string; expected?: number; met?: boolean; note?: string; revertApprovalId?: string }
export interface OrgExperiment {
  id: string; orgId: string; unitId: string | null; title: string; hypothesis: string; changeKind: ChangeKind | string; change: Record<string, unknown>;
  metricSourceId: string | null; direction: 'up' | 'down'; expectedEffect: number; effectKind: 'relative' | 'absolute'; windowDays: number;
  design: 'before_after' | 'slice'; slice: Record<string, unknown>; baseline: ExperimentStats; result: ExperimentResult; status: ExperimentStatus;
  revertRule: { worseBy?: number; relative?: boolean }; extensions: number; proposedBy: string; approvalId: string | null; changeApprovalId: string | null;
  startedAt: string | null; endsAt: string | null; lastCheckAt: string | null; decidedAt: string | null; decisionId: string | null; createdAt: string;
  predictions?: OrgPrediction[];
}
export interface ExperimentInput {
  title: string; hypothesis: string; changeKind: ChangeKind; change: Record<string, unknown>; metric?: string; keyResult?: string;
  direction: 'up' | 'down'; expectedEffect: number; effectKind?: 'relative' | 'absolute'; windowDays?: number; design?: 'before_after' | 'slice';
  slice?: Record<string, unknown>; revertRule?: { worseBy?: number; relative?: boolean }; unitId?: string;
}
export interface OrgPrediction {
  id: string; orgId: string; agentId: string; subjectKind: string; subjectId: string; question: string;
  forecast: { kind?: string; value?: number | string; low?: number; high?: number; unit?: string }; origin: string; resolvesAt: string | null;
  outcome: Record<string, unknown>; resolvedAt: string | null; score: number | null; status: 'open' | 'resolved' | 'void'; createdAt: string;
}
export interface CalibrationRow { agentId: string; name: string; resolved: number; open: number; brier: number | null; calibration: number | null; bias: number | null; biasLabel: 'over' | 'under' | 'balanced' | null }
export type GapKind = 'overclaim' | 'claimed_number' | 'claim_mismatch' | 'report_drift';
export interface ReconciliationGap { kind: GapKind | string; refType: string; refId: string; title: string; detail: string; claimed?: number | string | null; measured?: number | null }
export interface Reconciliation { at: string | null; gaps: ReconciliationGap[]; checked: { keyResults: number; tasks: number; brief: boolean } }

// ---- the boundary, evals, capacity, the owner's seat (execution plan item 31; SPA item 32 part two) ----
export type BoundaryVerdict = 'alone' | 'experiment' | 'propose' | 'never';
/** GET …/org/boundary → { rules } (docs/boundary.md §2). */
export interface BoundaryRule { id: string; kind: string; match: string; verdict: BoundaryVerdict; reason: string; everyone?: boolean; delegable: boolean }
export type EvalCandidateKind = 'charter' | 'playbook' | 'model' | 'routing';
export interface EvalCase {
  id: string; orgId: string; roleKey: string; sourceTaskId: string | null; source: 'check' | 'review' | 'manual' | string; createdAt: string; retiredAt: string | null;
  taskSnapshot: { title: string; brief: OrgTaskBrief; checks: TaskCheck[]; class: string; inputs: string[] } | null;
  expected: { checks: TaskCheck[]; rubric: string } | null;
}
export interface EvalCaseResult { caseId: string; pass: boolean | null; detail: string; usd: number; gradedBy: 'check' | 'rubric' | 'none' | 'skipped' }
export interface EvalRun {
  id: string; orgId: string; roleKey: string; kind: 'candidate' | 'baseline'; candidate: { kind: EvalCandidateKind; ref: string; before: string | null; after: string } | null;
  versionHash: string; cases: string[]; results: EvalCaseResult[]; passRate: number | null; baselinePassRate: number | null; baselineRunId: string | null;
  verdict: 'pass' | 'regress' | 'inconclusive' | ''; usd: number; requestedBy: string; startedAt: string; endedAt: string | null; status: 'running' | 'done' | 'failed';
}
/** The eval result a gated card carries on its payload (`payload.eval`, docs/evals.md §3). */
export interface CardEval { runId: string | null; verdict: string; passRate: number | null; baselinePassRate: number | null; roleKey?: string; summary?: string }
export interface MemberCapacity { agentId: string; name: string; title: string; open: number; wip: number; atLimit: boolean; expectedHours: number | null; tasks: Array<{ id: string; title: string; status: string; dueAt: string | null }> }
/** GET …/org/capacity */
export interface OrgCapacity { wip: number; members: MemberCapacity[]; byClass: Record<string, { runs: number | null; hours: number | null; samples: number; basis: string }> }
export interface OrgDelegation { id: string; orgId: string; kind: string; maxUsd: number | null; delegateType: 'human' | 'role'; delegateRef: string; createdBy: string; createdAt: string; revokedAt: string | null }
export interface OutcomeRow {
  objectiveId: string; title: string; unitId: string | null; valueUsd: number; spentUsd: number; roi: number | null;
  keyResults: Array<{ goalId: string; title: string; measured: boolean; movement7d: number | null; value: number | null; target: number | null }>;
}
export interface ValueEvent { id: string; orgId: string; goalId: string; objectiveId: string | null; unitId: string | null; kind: 'movement' | 'achieved'; sampleId: string | null; fromValue: number | null; toValue: number | null; delta: number; valueUsd: number; at: string; createdAt: string }

/** A non-2xx response. The message keeps the historical `"<status> <body>"`
 *  shape; `status` lets callers branch (409 = version conflict). */
export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`${status} ${body}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<T>;
}

/** Shared workspaces (docs/shared-agents.md §2): when the workspace on
 *  screen is one shared *with* this account, every call carries
 *  `X-Yaam-Workspace` and the server runs it inside the owner's account as
 *  this member. Own workspaces need no header. Set by the store. */
let sharedWorkspaceHeader: string | null = null;
export function setActiveSharedWorkspace(id: string | null): void { sharedWorkspaceHeader = id; }

/** Routes about *this* account rather than the workspace on screen: never
 *  carry the workspace header, or an owner's data would answer for ours. */
const OWN_ACCOUNT_ROUTE = /^\/api\/(auth|account|admin|push)(\/|$)|^\/api\/workspaces(\/shared)?$|^\/api\/topbar\/workspaces$/;

/** Power-user escape hatch matching YAAM_API_TOKEN on the server: set
 *  localStorage key `yaam_api_token` to attach a bearer token to every call.
 *  Pass the URL so the shared-workspace header can be added where it belongs. */
export const authHeaders = (url?: string): Record<string, string> => {
  const token = localStorage.getItem('yaam_api_token');
  const out: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (sharedWorkspaceHeader && (!url || !OWN_ACCOUNT_ROUTE.test(url.split('?')[0]))) out['X-Yaam-Workspace'] = sharedWorkspaceHeader;
  return out;
};

const get = <T,>(url: string, schema?: z.ZodType) =>
  fetch(url, { headers: authHeaders(url) })
    .then((r) => json<T>(r))
    .then((v) => (schema ? looseParse(schema, v, `GET ${url}`) : v));
const send = <T,>(url: string, method: string, body?: unknown, schema?: z.ZodType) =>
  fetch(url, {
    method,
    headers: body !== undefined ? { ...authHeaders(url), 'Content-Type': 'application/json' } : authHeaders(url),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
    .then((r) => json<T>(r))
    .then((v) => (schema ? looseParse(schema, v, `${method} ${url}`) : v));

const enc = encodeURIComponent;

export const api = {
  status: () => get<{ ok: boolean }>('/api/status'),

  // accounts (docs/accounts.md): the session is an HttpOnly cookie, so these
  // carry no token — the browser does.
  authMe: () => get<AuthMe>('/api/auth/me'),
  requestLink: (email: string) => send<{ ok: true; sent: boolean }>('/api/auth/request-link', 'POST', { email }),
  logout: () => send<{ ok: true }>('/api/auth/logout', 'POST', {}),
  account: () => get<AccountDetail>('/api/account'),
  setAccountKey: (provider: string, apiKey: string) => send<AccountDetail>('/api/account/keys', 'PUT', { provider, apiKey }),
  adminAccounts: () => get<Array<AccountSummary & { usage: AccountUsageMonth }>>('/api/admin/accounts'),
  adminPatchAccount: (id: string, patch: { plan?: Plan; status?: 'active' | 'disabled' }) => send<AccountSummary>(`/api/admin/accounts/${enc(id)}`, 'PATCH', patch),

  // shared workspaces (docs/shared-agents.md)
  sharedWorkspaces: () => get<SharedWorkspace[]>('/api/workspaces/shared'),
  workspaceMe: (id: string) => get<WorkspaceMe>(`/api/workspaces/${id}/me`),
  workspaceMembers: (id: string) => get<WorkspaceMember[]>(`/api/workspaces/${id}/members`),
  setMemberRole: (id: string, memberId: string, role: MemberRole) => send<WorkspaceMember>(`/api/workspaces/${id}/members/${enc(memberId)}`, 'PATCH', { role }),
  removeMember: (id: string, memberId: string) => send<{ ok: true }>(`/api/workspaces/${id}/members/${enc(memberId)}`, 'DELETE'),
  workspaceInvites: (id: string) => get<WorkspaceInvite[]>(`/api/workspaces/${id}/invites`),
  inviteMember: (id: string, email: string, role: 'member' | 'viewer') => send<{ invite: WorkspaceInvite; sent: boolean; token?: string }>(`/api/workspaces/${id}/invites`, 'POST', { email, role }),
  revokeInvite: (id: string, inviteId: string) => send<{ ok: true }>(`/api/workspaces/${id}/invites/${inviteId}`, 'DELETE'),
  flowRules: (id: string) => get<FlowRule[]>(`/api/workspaces/${id}/flow-rules`),
  addFlowRule: (id: string, rule: { fromMember: string; toMember?: string; effect?: 'allow' | 'deny'; kind: FlowKind }) => send<FlowRule>(`/api/workspaces/${id}/flow-rules`, 'POST', rule),
  removeFlowRule: (id: string, ruleId: string) => send<{ ok: true }>(`/api/workspaces/${id}/flow-rules/${ruleId}`, 'DELETE'),
  myConnections: (id: string) => get<Connection[]>(`/api/workspaces/${id}/my-connections`),
  memberGrants: (id: string) => get<MemberGrant[]>(`/api/workspaces/${id}/member-grants`),
  setMemberGrant: (id: string, body: { connectionId: string; agentId: string; service: string; level: 'read' | 'write' }) => send<{ ok: boolean }>(`/api/workspaces/${id}/member-grants`, 'POST', body),
  removeMemberGrant: (id: string, grantId: string) => send<{ ok: boolean }>(`/api/workspaces/${id}/member-grants/${grantId}`, 'DELETE'),
  workspaceChannels: (id: string) => get<MemberChannel[]>(`/api/workspaces/${id}/channels`),
  unpairWorkspaceChannel: (id: string, kind: 'telegram' | 'email') => send<{ ok: true }>(`/api/workspaces/${id}/channels/${kind}`, 'DELETE'),
  /** The addressee of a routed approval answers it from the inbox. */
  decideAgentEvent: (id: string, eventId: string, decision: 'allow' | 'deny') =>
    send<{ resolved: boolean; decision: string }>(`/api/agents/${id}/events/${eventId}/decide`, 'POST', { decision }),

  // group chat (docs/group-chat.md)
  channels: (wsId: string, archived = false) => get<Channel[]>(`/api/workspaces/${wsId}/chat/channels${archived ? '?archived=true' : ''}`),
  createChannel: (wsId: string, body: { name: string; slug?: string; topic?: string; kind?: 'public' | 'private'; agentIds?: string[]; humanIds?: string[] }) =>
    send<Channel>(`/api/workspaces/${wsId}/chat/channels`, 'POST', body),
  channel: (wsId: string, slug: string) => get<ChannelDetail>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}`),
  updateChannel: (wsId: string, slug: string, patch: { name?: string; topic?: string; kind?: 'public' | 'private'; dailyTokenBudget?: number }) =>
    send<Channel>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}`, 'PATCH', patch),
  archiveChannel: (wsId: string, slug: string, archived = true) => send<Channel>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/${archived ? 'archive' : 'unarchive'}`, 'POST'),
  // sub-channels (docs/group-chat.md §9)
  channelSubs: (wsId: string, slug: string, status: 'open' | 'closed' | 'all' = 'open') => get<SubChannelSummary[]>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/subs?status=${status}`),
  startDiscussion: (wsId: string, slug: string, body: { title: string; reason?: string; members?: Array<{ kind: 'agent' | 'human'; id: string }>; originMessageId?: string; purpose?: 'discussion' | 'project' }) =>
    send<Channel>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/subs`, 'POST', body),
  closeDiscussion: (wsId: string, slug: string, outcome?: string) => send<Channel>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/close`, 'POST', { outcome }),
  reopenDiscussion: (wsId: string, slug: string) => send<Channel>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/reopen`, 'POST'),
  addChannelMember: (wsId: string, slug: string, body: { kind: 'agent' | 'human'; id: string; notify?: string; unprompted?: boolean }) =>
    send<ChannelMember>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/members`, 'POST', body),
  updateChannelMember: (wsId: string, slug: string, kind: 'agent' | 'human', id: string, patch: { role?: 'owner' | 'member'; notify?: string; unprompted?: boolean }) =>
    send<ChannelMember>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/members/${kind}/${enc(id)}`, 'PATCH', patch),
  removeChannelMember: (wsId: string, slug: string, kind: 'agent' | 'human', id: string) =>
    send<{ ok: true }>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/members/${kind}/${enc(id)}`, 'DELETE'),
  channelMessages: (wsId: string, slug: string, opts: { thread?: string | null; before?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.thread) q.set('thread', opts.thread);
    if (opts.before) q.set('before', opts.before);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return get<ChannelPage>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/messages${qs ? `?${qs}` : ''}`);
  },
  postChannelMessage: (wsId: string, slug: string, body: { text: string; threadRootId?: string | null; attachments?: Array<{ path: string; kind: string }> }) =>
    send<ChannelMessage>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/messages`, 'POST', body),
  makeChannelTask: (wsId: string, slug: string, messageId: string, body: { title?: string; assigneeAgentId?: string } = {}) =>
    send<{ kind: 'org' | 'agent'; task: { id: string; title: string; status: string }; message: ChannelMessage }>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/messages/${messageId}/task`, 'POST', body),
  markChannelRead: (wsId: string, slug: string, messageId?: string) =>
    send<{ ok: true }>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/read`, 'POST', { messageId }),
  channelFiles: (wsId: string, slug: string) => get<ChannelFile[]>(`/api/workspaces/${wsId}/chat/channels/${enc(slug)}/files`),

  // follows (docs/follows.md): the caller follows, unfollows, marks seen
  follows: (wsId: string, targetKind: FollowTargetKind, targetId: string) =>
    get<FollowView>(`/api/workspaces/${wsId}/follows?targetKind=${targetKind}&targetId=${enc(targetId)}`, followViewSchema),
  follow: (wsId: string, targetKind: FollowTargetKind, targetId: string) =>
    send<FollowView>(`/api/workspaces/${wsId}/follows`, 'POST', { targetKind, targetId }, followViewSchema),
  unfollow: (wsId: string, targetKind: FollowTargetKind, targetId: string) =>
    send<FollowView>(`/api/workspaces/${wsId}/follows/unfollow`, 'POST', { targetKind, targetId }, followViewSchema),
  followsMine: (wsId: string) => get<FollowRow[]>(`/api/workspaces/${wsId}/follows/mine`),
  /** Messages from your team (docs/agent-messages.md): what agents sent the owner, unread first. */
  inboxMessages: (wsId: string) => get<{ items: AgentMessage[]; unread: number }>(`/api/workspaces/${wsId}/inbox/messages`),
  /** Read the messages of one direct chat (by the message's inbox event, or the chat). */
  markMessagesRead: (wsId: string, ref: { eventId?: string; sessionId?: string }) => send<{ ok: true; marked: number }>(`/api/workspaces/${wsId}/inbox/messages/read`, 'POST', ref),
  /** The Inbox's History: resolved items, newest first, a page at a time. */
  inboxHistory: (wsId: string, p: HistoryParams = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '' && v !== false) qs.set(k, v === true ? '1' : String(v));
    const s = qs.toString();
    return get<HistoryPage>(`/api/workspaces/${wsId}/inbox/history${s ? `?${s}` : ''}`);
  },
  markFollowSeen: (wsId: string, targetKind: FollowTargetKind, targetId: string) =>
    send<{ ok: true }>(`/api/workspaces/${wsId}/follows/seen`, 'POST', { targetKind, targetId }),

  // workspaces + workspace files
  workspaces: () => get<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string, color?: string) => send<Workspace>('/api/workspaces', 'POST', { name, color }),
  updateWorkspace: (id: string, patch: Partial<Pick<Workspace, 'name' | 'color' | 'memory' | 'profile' | 'quietHours' | 'spendBudgetTokens' | 'heartbeatDefaults'>>) =>
    send<Workspace>(`/api/workspaces/${id}`, 'PATCH', patch),
  workspaceSpend: (id: string) => get<SpendStatus>(`/api/workspaces/${id}/spend`),
  workspaceUsage: (id: string, days = 30) => get<WorkspaceUsage>(`/api/workspaces/${id}/usage?days=${days}`, usageReportSchema),
  agentUsage: (id: string, days = 30) => get<AgentUsage>(`/api/agents/${id}/usage?days=${days}`, usageReportSchema),
  pricing: () => get<PricingInfo>('/api/usage/pricing'),
  resolveProfileProposal: (id: string, proposalId: string, approve: boolean) =>
    send<Workspace>(`/api/workspaces/${id}/profile/${approve ? 'approve' : 'reject'}`, 'POST', { proposalId }),
  wsFiles: (id: string) => get<FileEntry[]>(`/api/workspaces/${id}/files`, fileEntryListSchema),
  wsPreview: (id: string, path: string) =>
    get<FilePreview>(`/api/workspaces/${id}/preview?path=${enc(path)}`, filePreviewSchema),
  wsPutFile: (id: string, path: string, contentBase64: string, contentType?: string, durationSeconds?: number) =>
    send<UploadResult>(`/api/workspaces/${id}/files`, 'POST', { path, contentBase64, contentType, durationSeconds }),
  /** Write with the version check (docs/filesystem.md): 409 when the file moved on. */
  wsWriteFile: (id: string, w: FileWrite) => send<UploadResult & { version?: number }>(`/api/workspaces/${id}/files`, 'POST', w),
  wsFileRevisions: (id: string, path: string) =>
    get<FileRevision[]>(`/api/workspaces/${id}/file/revisions?path=${enc(path)}`, fileRevisionListSchema),
  wsFileRevision: (id: string, path: string, version: number) =>
    get<FilePreview>(`/api/workspaces/${id}/file/revision?path=${enc(path)}&version=${version}`, filePreviewSchema),
  wsRestoreFile: (id: string, path: string, version: number) =>
    send<{ ok: boolean; version?: number }>(`/api/workspaces/${id}/file/restore`, 'POST', { path, version }),
  wsMoveFile: (id: string, from: string, to: string) => send<{ ok: boolean }>(`/api/workspaces/${id}/file/move`, 'POST', { from, to }),
  wsDeleteFile: (id: string, path: string) => send<{ ok: boolean }>(`/api/workspaces/${id}/file?path=${enc(path)}`, 'DELETE'),

  // chats
  chats: (workspaceId: string) => get<ChatSession[]>(`/api/chats?workspaceId=${enc(workspaceId)}`, chatSessionListSchema),
  chat: (id: string) => get<ChatSession>(`/api/chats/${id}`, chatSessionSchema),
  /** The Home rail: per agent the first page of chats and of work sessions, and the approvals.
   *  `kind` narrows a search to chats or work. */
  chatRail: (workspaceId: string, opts: { limits?: Record<string, number>; workLimits?: Record<string, number>; q?: string; perAgent?: number; kind?: 'chat' | 'work' | 'all' } = {}) => {
    const pairs = (m?: Record<string, number>) => Object.entries(m ?? {}).map(([k, n]) => `${k}:${n}`).join(',');
    const limits = pairs(opts.limits);
    const workLimits = pairs(opts.workLimits);
    return get<ChatRail>(`/api/chats/rail?workspaceId=${enc(workspaceId)}${limits ? `&limits=${enc(limits)}` : ''}${workLimits ? `&workLimits=${enc(workLimits)}` : ''}${opts.q ? `&q=${enc(opts.q)}` : ''}${opts.perAgent ? `&perAgent=${opts.perAgent}` : ''}${opts.kind && opts.kind !== 'all' ? `&kind=${opts.kind}` : ''}`);
  },
  /** One page of the rail: an agent's chats ('none' = agent-less), its work sessions (`kind: 'work'`), or the archive. */
  chatPage: (workspaceId: string, opts: { agentId?: string | null; archived?: boolean; q?: string; limit?: number; cursor?: string | null; kind?: 'chat' | 'work' } = {}) => {
    const p = new URLSearchParams({ workspaceId });
    if (opts.agentId !== undefined) p.set('agentId', opts.agentId === null ? 'none' : opts.agentId);
    if (opts.kind === 'work') p.set('kind', 'work');
    if (opts.archived) p.set('archived', 'true');
    if (opts.q) p.set('q', opts.q);
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.cursor) p.set('cursor', opts.cursor);
    return get<ChatPage>(`/api/chats/page?${p.toString()}`);
  },
  createChat: (input: { workspaceId: string; name?: string; agentId?: string; agentTypeId?: string; model?: string; cwd?: string; tokenCeiling?: number }) =>
    send<ChatSession>('/api/chats', 'POST', input, chatSessionSchema),
  updateChat: (id: string, patch: Record<string, unknown>) => send<ChatSession>(`/api/chats/${id}`, 'PATCH', patch, chatSessionSchema),
  deleteChat: (id: string) => send<{ ok: boolean }>(`/api/chats/${id}`, 'DELETE'),
  transcript: (id: string) => get<{ messages: ChatMessage[]; turns: ChatTurn[] }>(`/api/chats/${id}/transcript`, transcriptSchema),
  /** An agent's Work log (docs/work-log.md): one page of runs plus the trigger groups. */
  workLog: (agentId: string, f: WorkLogFilters = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    const qs = p.toString();
    return get<WorkLogPage>(`/api/agents/${enc(agentId)}/work-log${qs ? `?${qs}` : ''}`);
  },
  workRun: (agentId: string, turnId: string) => get<WorkRunDetail>(`/api/agents/${enc(agentId)}/work-log/runs/${enc(turnId)}`),
  /** Run a failed or stopped run again, by its trigger, in its session. */
  rerunWorkRun: (agentId: string, turnId: string) => send<WorkRerunResult>(`/api/agents/${enc(agentId)}/work-log/runs/${enc(turnId)}/rerun`, 'POST'),
  latestWorkRun: (agentId: string, sessionId: string) => get<{ turnId: string | null }>(`/api/agents/${enc(agentId)}/work-log/sessions/${enc(sessionId)}/latest`),
  clear: (id: string) => send<{ ok: boolean }>(`/api/chats/${id}/clear`, 'POST'),
  compact: (id: string) => send<{ ok: boolean; reason?: string }>(`/api/chats/${id}/compact`, 'POST'),
  stop: (id: string) => send<{ stopped: boolean }>(`/api/chats/${id}/stop`, 'POST'),
  approve: (id: string, callId: string, decision: ApprovalDecision) =>
    send<{ resolved: boolean }>(`/api/chats/${id}/approve`, 'POST', { callId, decision }),
  fork: (id: string, turnId?: string) => send<ChatSession>(`/api/chats/${id}/fork`, 'POST', { turnId }, chatSessionSchema),
  truncate: (id: string, turnId: string) => send<{ ok: boolean; input: string }>(`/api/chats/${id}/truncate`, 'POST', { turnId }),
  promote: (id: string, turnId: string) => send<{ task: string }>(`/api/chats/${id}/turns/${turnId}/promote`, 'POST'),
  rate: (id: string, turnId: string, rating: 'up' | 'down', note?: string) =>
    send<{ ok: boolean }>(`/api/chats/${id}/turns/${turnId}/rate`, 'POST', { rating, note }),
  distill: (id: string) => send<{ ok: boolean; journal?: string; lesson?: string }>(`/api/chats/${id}/distill`, 'POST'),
  exportUrl: (id: string) => `/api/chats/${id}/export`,

  // agents
  /** The workspace's agents (every agent belongs to exactly one workspace). */
  agents: (workspaceId?: string) => get<Agent[]>(`/api/agents${workspaceId ? `?workspaceId=${enc(workspaceId)}` : ''}`, agentListSchema),
  createAgent: (input: { name: string; workspaceId: string; charter?: string; role?: string; emoji?: string; colors?: [string, string]; provider?: string; model?: string; agentTypeId?: string; customModel?: boolean }) =>
    send<Agent>('/api/agents', 'POST', input, agentSchema),
  /** Move an agent to another workspace — refused while it sits in an organization. */
  moveAgent: (id: string, workspaceId: string) => send<Agent>(`/api/agents/${id}/move`, 'POST', { workspaceId }, agentSchema),
  updateAgent: (id: string, patch: Record<string, unknown>) => send<Agent>(`/api/agents/${id}`, 'PATCH', patch, agentSchema),
  deleteAgent: (id: string) => send<{ ok: boolean }>(`/api/agents/${id}`, 'DELETE'),
  /** The personality catalog for the agent settings picker. */
  agentPersonalities: () => get<AgentPersonality[]>('/api/agents/personalities'),
  deleteAgentApp: (id: string, appId: string) => send<{ ok: boolean }>(`/api/agents/${id}/apps/${appId}`, 'DELETE'),
  // mini-app capability bridge (docs/miniapp-capabilities.md)
  approveAppCaps: (id: string, appId: string, capabilities: string[]) =>
    send<AgentApp>(`/api/agents/${id}/apps/${appId}/approve`, 'POST', { capabilities }),
  appStorageGet: (id: string, appId: string) => get<{ state: unknown }>(`/api/agents/${id}/apps/${appId}/storage`),
  appStoragePut: (id: string, appId: string, state: unknown) =>
    send<{ ok: boolean }>(`/api/agents/${id}/apps/${appId}/storage`, 'PUT', { state }),
  appFilesList: (id: string, appId: string, prefix: string, workspaceId?: string) =>
    get<Array<{ path: string; size: number; lastModified?: string }>>(
      `/api/agents/${id}/apps/${appId}/files?prefix=${encodeURIComponent(prefix)}${workspaceId ? `&workspaceId=${workspaceId}` : ''}`),
  appFileRead: (id: string, appId: string, path: string, workspaceId?: string, offset?: number) =>
    get<{ path: string; kind: string; size: number; text?: string; base64?: string; offset?: number; eof?: boolean }>(
      `/api/agents/${id}/apps/${appId}/file?path=${encodeURIComponent(path)}${workspaceId ? `&workspaceId=${workspaceId}` : ''}${offset ? `&offset=${offset}` : ''}`),
  appFilePropose: (id: string, appId: string, path: string, content: string) =>
    send<{ ok: boolean; path: string }>(`/api/agents/${id}/apps/${appId}/files/propose`, 'POST', { path, content }),
  appFilesWatch: (id: string, appId: string, prefix: string, since?: string, workspaceId?: string) =>
    get<{ latest: string; changed: boolean; count: number }>(
      `/api/agents/${id}/apps/${appId}/files/watch?prefix=${encodeURIComponent(prefix)}${since ? `&since=${encodeURIComponent(since)}` : ''}${workspaceId ? `&workspaceId=${workspaceId}` : ''}`),
  appFileWrite: (id: string, appId: string, path: string, content: string) =>
    send<{ ok: boolean; path: string }>(`/api/agents/${id}/apps/${appId}/files`, 'PUT', { path, content }),
  appTasksList: (id: string, appId: string) => get<AgentTask[]>(`/api/agents/${id}/apps/${appId}/tasks`),
  appTaskAdd: (id: string, appId: string, title: string, note?: string) =>
    send<AgentTask>(`/api/agents/${id}/apps/${appId}/tasks`, 'POST', { title, note }),
  appTaskMove: (id: string, appId: string, taskId: string, status: string) =>
    send<AgentTask>(`/api/agents/${id}/apps/${appId}/tasks/${taskId}`, 'PATCH', { status }),
  appAsk: (id: string, appId: string, prompt: string, workspaceId?: string) =>
    send<{ answer: string; denied: string[]; remainingToday: number; sessionId: string }>(
      `/api/agents/${id}/apps/${appId}/ask`, 'POST', { prompt, workspaceId }),
  appLlmComplete: (id: string, appId: string, prompt: string, schema?: unknown, maxTokens?: number) =>
    send<AppLlmResult>(`/api/agents/${id}/apps/${appId}/llm`, 'POST', { prompt, schema, maxTokens }),
  appDataPut: (id: string, appId: string, collection: string, row: unknown) =>
    send<{ ok: boolean; id: string; rows: number }>(`/api/agents/${id}/apps/${appId}/data/${collection}`, 'POST', { row }),
  appDataQuery: (id: string, appId: string, collection: string, q: unknown) =>
    send<{ rows: Array<Record<string, unknown>>; total: number; offset: number }>(
      `/api/agents/${id}/apps/${appId}/data/${collection}/query`, 'POST', q),
  appDataDelete: (id: string, appId: string, collection: string, rowId: string) =>
    send<{ ok: boolean; rows: number }>(`/api/agents/${id}/apps/${appId}/data/${collection}/${rowId}`, 'DELETE'),
  appSqlEngine: (id: string, appId: string) =>
    get<{ js: string; wasmBase64: string }>(`/api/agents/${id}/apps/${appId}/sql-engine`),
  appConnections: (id: string, appId: string) =>
    get<Array<{ provider: string; service: string; level: string; ops: string[] }>>(
      `/api/agents/${id}/apps/${appId}/connections`),
  appConnRead: (id: string, appId: string, provider: string, op: string, params: unknown) =>
    send<{ op: string; provider: string; text: string }>(
      `/api/agents/${id}/apps/${appId}/connections/read`, 'POST', { provider, op, params }),
  appConnPropose: (id: string, appId: string, provider: string, op: string, payload: unknown) =>
    send<{ op: string; provider: string; text: string }>(
      `/api/agents/${id}/apps/${appId}/connections/propose`, 'POST', { provider, op, payload }),
  /** Which languages this server's runner offers — they differ by backend
   *  (the local sandbox has python only if a python binary exists; Cloudflare
   *  always has both), so apps feature-detect before offering a button. */
  appComputeStatus: (id: string, appId: string) =>
    get<RunnerStatus>(`/api/agents/${id}/apps/${appId}/compute`),
  appComputeRun: (id: string, appId: string, language: string, code: string, stdin?: string, timeoutSeconds?: number) =>
    send<{ language: string; output: string }>(
      `/api/agents/${id}/apps/${appId}/compute`, 'POST', { language, code, stdin, timeoutSeconds }),
  agentLessons: (id: string) => get<AgentLesson[]>(`/api/agents/${id}/lessons`),
  patchLesson: (id: string, lessonId: string, patch: { trusted?: boolean; pinned?: boolean; audience?: string }) =>
    send<AgentLesson>(`/api/agents/${id}/lessons/${lessonId}`, 'PATCH', patch),
  deleteLesson: (id: string, lessonId: string) =>
    send<{ ok: boolean }>(`/api/agents/${id}/lessons/${lessonId}`, 'DELETE'),
  agentEvents: (id: string) => get<AgentEvent[]>(`/api/agents/${id}/events`),
  // event triggers (docs/triggers.md): per-loop state, and the one-time webhook secret
  loopStates: (id: string) => get<LoopState[]>(`/api/agents/${id}/loops/state`),
  rotateWebhookSecret: (id: string, loopName: string) =>
    send<{ secret: string; path: string; url: string }>(`/api/agents/${id}/loops/${encodeURIComponent(loopName)}/webhook-secret`, 'POST'),
  // context cards and suggested loops (docs/integrations.md)
  connectionCards: (profile?: string) => get<ContextCard[]>(`/api/connections/cards${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`),
  installSuggestedLoop: (id: string, cardId: string, useId: string) =>
    send<{ loop: { name: string }; loops: unknown[] }>(`/api/agents/${id}/loops/install`, 'POST', { cardId, useId }),
  // the gated heartbeat (docs/triggers.md "Heartbeat")
  heartbeat: (id: string) => get<HeartbeatView>(`/api/agents/${id}/heartbeat`),
  beatNow: (id: string) => send<BeatResult>(`/api/agents/${id}/heartbeat/beat`, 'POST'),
  updateHeartbeat: (id: string, body: { enabled?: boolean; cron?: string | null; dailyRunCap?: number | null; staleMinutes?: number | null }) =>
    send<HeartbeatView>(`/api/agents/${id}/heartbeat`, 'PATCH', body),
  markAgentEventsRead: (id: string) => send<{ ok: boolean }>(`/api/agents/${id}/events/read`, 'POST'),
  actOnAgentEvent: (id: string, eventId: string, decision: 'approve' | 'dismiss') =>
    send<{ ok: boolean; status: string; result?: string; error?: string }>(`/api/agents/${id}/events/${eventId}/act`, 'POST', { decision }),
  unreadAgentEvents: () => get<Record<string, number>>('/api/agents/events/unread'),
  agentCustomTools: (id: string) => get<AgentCustomTool[]>(`/api/agents/${id}/tools`),
  approveAgentTool: (id: string, toolId: string) => send<{ ok: boolean }>(`/api/agents/${id}/tools/${toolId}/approve`, 'POST'),
  deleteAgentTool: (id: string, toolId: string) => send<{ ok: boolean }>(`/api/agents/${id}/tools/${toolId}`, 'DELETE'),
  agentTasks: (id: string) => get<AgentTask[]>(`/api/agents/${id}/tasks`),
  addAgentTask: (id: string, input: { title: string; note?: string }) => send<AgentTask>(`/api/agents/${id}/tasks`, 'POST', input),
  updateAgentTask: (id: string, taskId: string, patch: { title?: string; note?: string; status?: string; reason?: string }) =>
    send<AgentTask>(`/api/agents/${id}/tasks/${taskId}`, 'PATCH', patch),
  deleteAgentTask: (id: string, taskId: string) => send<{ ok: boolean }>(`/api/agents/${id}/tasks/${taskId}`, 'DELETE'),
  agentStats: (id: string) => get<AgentStats>(`/api/agents/${id}/stats`),
  agentFiles: (id: string, workspaceId?: string) =>
    get<FileEntry[]>(`/api/agents/${id}/files${workspaceId ? `?workspaceId=${enc(workspaceId)}` : ''}`, fileEntryListSchema),
  putAgentFile: (id: string, path: string, contentBase64: string, contentType?: string, durationSeconds?: number) =>
    send<UploadResult>(`/api/agents/${id}/files`, 'POST', { path, contentBase64, contentType, durationSeconds }),
  /** The agent route maps onto its home; it may or may not honour expectedVersion. */
  agentWriteFile: (id: string, w: FileWrite) => send<UploadResult & { version?: number }>(`/api/agents/${id}/files`, 'POST', w),
  agentPreview: (id: string, path: string, workspaceId?: string) =>
    get<FilePreview>(`/api/agents/${id}/preview?path=${enc(path)}${workspaceId ? `&workspaceId=${enc(workspaceId)}` : ''}`, filePreviewSchema),
  agentExportUrl: (id: string, opts: { includeProfile?: boolean; workspaceId?: string } = {}) =>
    `/api/agents/${id}/export${opts.includeProfile ? `?includeProfile=1${opts.workspaceId ? `&workspaceId=${enc(opts.workspaceId)}` : ''}` : ''}`,
  /** AGENT.json v1/v2 → new agent; `options` are the review modal's ticks. */
  importAgent: (profile: Record<string, unknown>, options: AgentImportOptions = {}) =>
    send<AgentImportResult>('/api/agents/import', 'POST', { ...profile, options }),
  /** Another assistant's memory → quarantined lessons / profile proposals / charter diff. */
  importAgentMemory: (id: string, format: MemoryImportFormat, content: string | Record<string, string>, workspaceId?: string) =>
    send<MemoryImportSummary>(`/api/agents/${id}/import/memory`, 'POST', { format, content, workspaceId }),

  // agent types / providers
  agentTypes: () => get<AgentType[]>('/api/agent-types'),
  createAgentType: (input: { name: string; provider: string; model: string; apiKey?: string; baseUrl?: string; persona?: string }) =>
    send<AgentType>('/api/agent-types', 'POST', input),
  updateAgentType: (id: string, patch: { model?: string; models?: string[]; tierModels?: Partial<Record<ModelTierName, string | null>>; enabled?: boolean; name?: string }) =>
    send<AgentType>(`/api/agent-types/${enc(id)}`, 'PATCH', patch),
  agentTypeModels: (id: string) => get<AgentTypeModels>(`/api/agent-types/${enc(id)}/models`),
  refreshAgentTypeModels: (id: string) => send<AgentTypeModels>(`/api/agent-types/${enc(id)}/models/refresh`, 'POST', {}),

  // skills / mcp / market / settings / search
  skills: (workspaceId?: string, agentId?: string) =>
    get<Skill[]>(`/api/skills?${workspaceId ? `workspaceId=${enc(workspaceId)}` : ''}${agentId ? `&agentId=${enc(agentId)}` : ''}`),
  updateSkill: (id: string, patch: { enabled?: boolean; instructions?: string; description?: string }) =>
    send<Skill>(`/api/skills/${id}`, 'PATCH', patch),
  resolveSkillDraft: (id: string, approve: boolean) =>
    send<Skill | { ok: boolean }>(`/api/skills/${id}/${approve ? 'approve' : 'reject'}`, 'POST'),
  promoteSkill: (id: string, workspaceId?: string) =>
    send<Skill>(`/api/skills/${id}/promote`, 'POST', workspaceId ? { workspaceId } : {}),
  /** agentskills.io SKILL.md → scanned draft. */
  importSkillMd: (content: string, scope: { workspaceId?: string; agentId?: string } = {}) =>
    send<{ skill: Skill; scan: SkillScanReport }>('/api/skills/import', 'POST', { content, ...scope }),
  skillMdUrl: (id: string) => `/api/skills/${id}/skill.md`,
  resolveSkillRevision: (id: string, accept: boolean) =>
    send<Skill>(`/api/skills/${id}/revision/${accept ? 'accept' : 'reject'}`, 'POST'),
  // external service connections (docs/integrations.md)
  connections: () => get<Connection[]>('/api/connections'),
  connectionProviders: () => get<ConnectionProvider[]>('/api/connections/providers'),
  connectionTools: () => get<Array<{ name: string; description: string; provider: string; service: string; level: string }>>('/api/connections/tools'),
  connectStart: (provider: string, tier: 'read' | 'write' | 'gmail' | 'mailread' | 'drive' = 'read') => get<{ url: string }>(`/api/connections/${provider}/start?tier=${tier}`),
  removeConnection: (id: string) => send<{ ok: boolean }>(`/api/connections/${id}`, 'DELETE'),
  grantConnection: (id: string, agentId: string, service: ConnectionServiceName, level: 'read' | 'write' = 'read') =>
    send<{ ok: boolean }>(`/api/connections/${id}/grants`, 'POST', { agentId, service, level }),
  revokeConnectionGrant: (id: string, agentId: string, service?: ConnectionServiceName) =>
    send<{ ok: boolean }>(`/api/connections/${id}/grants/${agentId}${service ? `?service=${service}` : ''}`, 'DELETE'),
  // code runner (docs/code-execution.md) — read-only: the backend is env-configured
  runnerStatus: () => get<RunnerStatus>('/api/runner/status'),
  // plugins (docs/plugins.md, Phase 1): members read; the owner installs, binds and grants
  pluginCatalog: (ws: string) => get<PluginCatalogEntry[]>(`/api/workspaces/${enc(ws)}/plugins/catalog`),
  plugins: (ws: string) => get<PluginSummary[]>(`/api/workspaces/${enc(ws)}/plugins`),
  plugin: (ws: string, id: string) => get<PluginDetail>(`/api/workspaces/${enc(ws)}/plugins/${enc(id)}`),
  reviewPlugin: (ws: string, source: PluginSource) => send<PluginReview>(`/api/workspaces/${enc(ws)}/plugins/review`, 'POST', { source }),
  installPlugin: (ws: string, source: PluginSource, opts: { acceptCommunity?: boolean } = {}) => send<{ installed: boolean; review: PluginReview }>(`/api/workspaces/${enc(ws)}/plugins/install`, 'POST', { source, confirm: true, ...(opts.acceptCommunity ? { acceptCommunity: true } : {}) }),
  updatePlugin: (ws: string, id: string, source: PluginSource) => send<{ applied: boolean; pending?: boolean; widening?: boolean; failures?: string[]; diff?: PluginDiffEntry[] }>(`/api/workspaces/${enc(ws)}/plugins/${enc(id)}/update`, 'POST', { source }),
  pluginUpdates: (ws: string, id: string) => get<PluginUpdates>(`/api/workspaces/${enc(ws)}/plugins/${enc(id)}/updates`),
  // Foundry (docs/foundry.md): the Plugins shelf and the Kits previews
  foundryPlugins: (ws: string, f: { q?: string; role?: string; iface?: string; tier?: string } = {}) => {
    const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as Array<[string, string]>).toString();
    return get<FoundryPluginList>(`/api/workspaces/${enc(ws)}/foundry/plugins${p ? `?${p}` : ''}`);
  },
  foundryPlugin: (ws: string, id: string) => get<FoundryPluginDetail>(`/api/workspaces/${enc(ws)}/foundry/plugins/${enc(id)}`),
  publishPlugin: (ws: string, body: { manifest?: unknown; files?: Record<string, string>; commitSha?: string; changelog?: string; dryRun?: boolean }) => send<Record<string, unknown>>(`/api/workspaces/${enc(ws)}/foundry/plugins/publish`, 'POST', body),
  recallPlugin: (ws: string, id: string, version: string, reason: string) => send<{ recalled: boolean; frozen: number; withdrawn: number }>(`/api/workspaces/${enc(ws)}/foundry/plugins/${enc(id)}/versions/${enc(version)}/recall`, 'POST', { reason }),
  foundryKits: () => get<KitPreview[]>('/api/foundry/kits'),
  pluginAction: (ws: string, id: string, action: 'disable' | 'enable' | 'conformance') => send<unknown>(`/api/workspaces/${enc(ws)}/plugins/${enc(id)}/${action}`, 'POST'),
  uninstallPlugin: (ws: string, id: string) => send<unknown>(`/api/workspaces/${enc(ws)}/plugins/${enc(id)}`, 'DELETE'),
  decidePluginUpdate: (ws: string, id: string, approve: boolean) => send<unknown>(`/api/workspaces/${enc(ws)}/plugins/${enc(id)}/updates/decide`, 'POST', { approve }),
  setPluginGrant: (ws: string, id: string, agentId: string, level: 'read' | 'write' | null) => send<unknown>(`/api/workspaces/${enc(ws)}/plugins/${enc(id)}/grants/${enc(agentId)}`, 'PUT', { level }),
  interfaces: (ws: string) => get<InterfaceView[]>(`/api/workspaces/${enc(ws)}/interfaces`),
  setBinding: (ws: string, iface: string, body: { major?: number; scopeKind: string; scopeRef?: string; providerId: string | null }) => send<unknown>(`/api/workspaces/${enc(ws)}/interfaces/${enc(iface)}/bindings`, 'PUT', body),
  // coding agents (docs/coding-harnesses.md): owner-only writes; the key is write-only
  harnesses: () => get<HarnessView>('/api/harness'),
  updateHarness: (id: HarnessId, patch: HarnessPatch) => send<HarnessView>(`/api/harness/${id}`, 'PUT', patch),
  detectHarness: (id: HarnessId) => send<HarnessStatus>(`/api/harness/${id}/detect`, 'POST'),
  // browser tool (docs/browser-tool.md) — read-only: the backend is env-configured
  browserStatus: () => get<BrowserStatus>('/api/browser/status'),
  // desktop computer control (docs/computer-control.md)
  computerStatus: () => get<ComputerStatus>('/api/computer/status'),
  computerPairCode: () => send<{ code: string; expiresInSeconds: number }>('/api/computer/pair-code', 'POST'),
  computerPause: () => send<ComputerStatus>('/api/computer/pause', 'POST'),
  computerResume: () => send<ComputerStatus>('/api/computer/resume', 'POST'),
  computerDisconnect: () => send<ComputerStatus>('/api/computer/disconnect', 'POST'),
  computerNarrowScopes: (scopes: string[]) => send<ComputerStatus>('/api/computer/scopes', 'POST', { scopes }),
  computerActions: (limit = 50) => get<ComputerAction[]>(`/api/computer/actions?limit=${limit}`),
  mcp: () => get<McpServer[]>('/api/mcp'),
  createMcp: (name: string, url: string) => send<McpServer>('/api/mcp', 'POST', { name, url }),
  updateMcp: (id: string, patch: { enabled?: boolean }) => send<McpServer>(`/api/mcp/${id}`, 'PATCH', patch),
  discoverMcp: (id: string) => send<{ tools: Array<{ name: string; description?: string }> }>(`/api/mcp/${id}/discover`, 'POST'),
  mcpOauthStart: (id: string) => get<{ url: string }>(`/api/mcp/${id}/oauth/start`),
  marketConnectors: () => get<ConnectorEntry[]>('/api/market/connectors'),
  /** Full bundled-skill text, for the hire review (docs/permissions.md). */
  marketPackSkills: (id: string) => get<Array<{ name: string; description: string; instructions: string }>>(`/api/market/${id}/skills`),
  /** `hired` is per workspace: a pack hired in one workspace is free in another. */
  market: (workspaceId?: string) => get<MarketItem[]>(`/api/market${workspaceId ? `?workspaceId=${enc(workspaceId)}` : ''}`),
  hire: (id: string, workspaceId?: string) => send<{ ok: boolean; agent: Agent }>(`/api/market/${id}/hire`, 'POST', workspaceId ? { workspaceId } : undefined, hireResultSchema),
  // market registry (docs/registry.md)
  registry: (kind?: RegistryKind | '', q?: string) =>
    get<RegistryList>(`/api/registry?${kind ? `kind=${enc(kind)}` : ''}${q ? `&q=${enc(q)}` : ''}`),
  registryStatus: () => get<RegistryStatus>('/api/registry/status'),
  registryItem: (id: string) => get<RegistryItem & { manifest: Record<string, unknown> }>(`/api/registry/${enc(id)}`),
  /** Two-step: without `confirm` the server answers with the review only. */
  registryInstall: (id: string, confirm: boolean, options: RegistryInstallOptions = {}) =>
    send<RegistryInstallResult>(`/api/registry/${enc(id)}/install`, 'POST', confirm ? { confirm: true, options } : { options }),
  registryPublish: (input: RegistryPublishInput) => send<RegistryPublishResult>('/api/registry/publish', 'POST', input),
  registryRate: (id: string, rating: 'up' | 'down', note?: string) =>
    send<{ ok: boolean; up: number; down: number }>(`/api/registry/${enc(id)}/rate`, 'POST', { rating, note }),
  // threat model (docs/security.md) — public route
  security: () => get<SecurityPolicy>('/api/security'),
  // channels (phase 4)
  telegramStatus: () => get<{ configured: boolean; paired: boolean; defaultAgentId: string }>('/api/channels/telegram/status'),
  telegramPairCode: () => send<{ code: string; expiresInSeconds: number }>('/api/channels/telegram/pair-code', 'POST'),
  telegramUnpair: () => send<{ ok: boolean }>('/api/channels/telegram/unpair', 'POST'),
  // email channel + web push (docs/channels.md)
  emailStatus: () => get<EmailStatus>('/api/channels/email/status'),
  emailPairCode: () => send<{ code: string; expiresInSeconds: number }>('/api/channels/email/pair-code', 'POST'),
  emailUnpair: (address?: string) => send<{ ok: boolean; ownerAddresses: string[] }>('/api/channels/email/unpair', 'POST', address ? { address } : {}),
  pushPublicKey: () => get<{ enabled: boolean; publicKey: string; subscriptions: number }>('/api/push/vapid-public-key'),
  pushSubscribe: (sub: unknown, userAgent: string) => send<{ ok: boolean; id: string }>('/api/push/subscribe', 'POST', { ...(sub as object), userAgent }),
  pushUnsubscribe: (endpoint: string) => send<{ ok: boolean; removed: number }>('/api/push/subscribe', 'DELETE', { endpoint }),
  settings: () => get<Record<string, string>>('/api/settings'),
  putSettings: (patch: Record<string, string>) => send<Record<string, string>>('/api/settings', 'PUT', patch),
  // voice notes (docs/voice.md)
  voiceStatus: () => get<VoiceStatus>('/api/voice/status'),
  /** Reply TTS: resolves to an audio Blob (mp3) or throws when unavailable. */
  tts: async (text: string, voice?: string): Promise<Blob> => {
    const r = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voice || undefined }),
    });
    if (!r.ok) throw new Error(`tts ${r.status}`);
    return r.blob();
  },
  search: (workspaceId: string, q: string) =>
    get<SearchResults>(`/api/search?workspaceId=${enc(workspaceId)}&q=${enc(q)}`),

  // ---- autonomous company ----
  orgsStatus: () => get<{ enabled: boolean }>('/api/orgs/status'),
  // Organization mode lives on the workspace; every company call below takes
  // the workspace id and resolves to its one organization server-side.
  workspaceOrg: (wsId: string) => get<WorkspaceOrg>(`/api/workspaces/${wsId}/org`),
  setWorkspaceOrg: (wsId: string, body: { mode: OrgMode; chiefOfStaffAgentId?: string; monthlyUsd?: number; agentCap?: number }) => send<WorkspaceOrg>(`/api/workspaces/${wsId}/org`, 'PUT', body),
  orgCaps: (wsId: string) => get<OrgCaps>(`/api/workspaces/${wsId}/org/caps`),
  bootstrapOrg: (wsId: string, body: BootstrapBody) => send<BootstrapSummary>(`/api/workspaces/${wsId}/org/bootstrap`, 'POST', body),
  /** The role catalog (item 24) ranked by `profile` (the org's own when absent). Null when the route is absent (404) or fails: the wizard hides the step. */
  orgRoles: async (wsId: string, profile?: string): Promise<OrgRole[] | null> => {
    const url = `/api/workspaces/${wsId}/org/roles${profile ? `?profile=${encodeURIComponent(profile.slice(0, 2_000))}` : ''}`;
    const res = await fetch(url, { headers: authHeaders(url) }).catch(() => null);
    if (!res || !res.ok) return null;
    const raw = await res.json().catch(() => null) as unknown;
    return normalizeRoles(raw);
  },
  pauseOrg: (wsId: string) => send<WorkspaceOrg>(`/api/workspaces/${wsId}/org/pause`, 'POST'),
  resumeOrg: (wsId: string) => send<WorkspaceOrg>(`/api/workspaces/${wsId}/org/resume`, 'POST'),
  // Archive, restore, delete the company (docs/owners-seat.md "Archive or delete the company"; owner only).
  archiveOrg: (wsId: string) => send<{ archived: ArchivedOrg; status: WorkspaceOrg }>(`/api/workspaces/${wsId}/org/archive`, 'POST'),
  restoreOrg: (wsId: string, orgId?: string) => send<{ restored: { orgId: string; status: 'active' | 'paused'; mode: OrgMode }; status: WorkspaceOrg }>(`/api/workspaces/${wsId}/org/restore`, 'POST', { orgId }),
  deleteOrg: (wsId: string, body: DeleteOrgBody) => send<DeleteOrgReport>(`/api/workspaces/${wsId}/org`, 'DELETE', body),
  archivedOrg: (wsId: string, orgId: string) => get<ArchivedOrgDetail>(`/api/workspaces/${wsId}/org/archived/${orgId}`),
  archivedOrgBlueprint: (wsId: string, orgId: string) => get<Blueprint>(`/api/workspaces/${wsId}/org/archived/${orgId}/blueprint`),
  reviewOrgStructure: (wsId: string) => send<{ result: string }>(`/api/workspaces/${wsId}/org/review`, 'POST'),
  org: (wsId: string) => get<OrgDetail>(`/api/workspaces/${wsId}/org/detail`),
  updateOrg: (wsId: string, patch: Partial<Pick<Org, 'name' | 'mission' | 'ceoUserNote' | 'briefHour' | 'monthlyBudgetUsd'>>) => send<Org>(`/api/workspaces/${wsId}/org/detail`, 'PATCH', patch),
  addOrgMember: (wsId: string, body: { agentId: string; title?: string; reportsToAgentId?: string; scopes?: string[] }) => send<OrgMember>(`/api/workspaces/${wsId}/org/members`, 'POST', body),
  updateOrgMember: (wsId: string, agentId: string, patch: { title?: string; reportsToAgentId?: string | null }) => send<OrgMember>(`/api/workspaces/${wsId}/org/members/${agentId}`, 'PATCH', patch),
  terminateOrgMember: (wsId: string, agentId: string) => send<{ ok: true }>(`/api/workspaces/${wsId}/org/members/${agentId}`, 'DELETE'),
  setOrgMemberScopes: (wsId: string, agentId: string, scopes: string[]) => send<{ applied: boolean; scopes: string[] }>(`/api/workspaces/${wsId}/org/members/${agentId}/scopes`, 'POST', { scopes }),
  pauseOrgMember: (wsId: string, agentId: string) => send<OrgMember>(`/api/workspaces/${wsId}/org/members/${agentId}/pause`, 'POST'),
  resumeOrgMember: (wsId: string, agentId: string) => send<OrgMember>(`/api/workspaces/${wsId}/org/members/${agentId}/resume`, 'POST'),
  acceptOrgCharter: (wsId: string, agentId: string) => send<OrgMember>(`/api/workspaces/${wsId}/org/members/${agentId}/charter/accept`, 'POST'),
  addOrgGoal: (wsId: string, body: { title: string; description?: string; unitId?: string | null; parentGoalId?: string | null; ownerAgentId?: string | null }) => send<OrgGoal>(`/api/workspaces/${wsId}/org/goals`, 'POST', body),
  updateOrgGoal: (wsId: string, goalId: string, patch: { title?: string; description?: string; status?: string; parentGoalId?: string | null; unitId?: string | null; ownerAgentId?: string | null }) => send<OrgGoal>(`/api/workspaces/${wsId}/org/goals/${goalId}`, 'PATCH', patch),
  // units (docs/group-chat.md §7)
  orgUnits: (wsId: string) => get<OrgUnitNode[]>(`/api/workspaces/${wsId}/org/units`),
  renameOrgUnit: (wsId: string, unitId: string, name: string) => send<OrgUnit>(`/api/workspaces/${wsId}/org/units/${unitId}`, 'PATCH', { name }),
  /** The board's task key prefix (docs/tasks-keys.md): new tasks take it, existing keys stay. */
  setOrgUnitTaskKey: (wsId: string, unitId: string, taskKey: string) => send<OrgUnit>(`/api/workspaces/${wsId}/org/units/${unitId}`, 'PATCH', { taskKey }),
  orgGoalTree: (wsId: string, unitId?: string | null) => get<OrgGoalNode[]>(unitId ? `/api/workspaces/${wsId}/org/units/${unitId}/goals/tree` : `/api/workspaces/${wsId}/org/goals/tree`),
  goalMessages: (wsId: string, goalId: string) => get<Array<ChannelMessage & { slug: string }>>(`/api/workspaces/${wsId}/chat/goals/${goalId}/messages`),
  addOrgProject: (wsId: string, body: { title: string; goalId?: string | null }) => send<OrgProject>(`/api/workspaces/${wsId}/org/projects`, 'POST', body),
  // work tracking (docs/work-tracking.md): the roadmap, projects, health, milestones, appetite
  orgRoadmap: (wsId: string) => get<RoadmapData>(`/api/workspaces/${wsId}/org/roadmap`),
  orgPortfolio: (wsId: string, since?: string) => get<HomePortfolio & { generatedAt: string }>(`/api/workspaces/${wsId}/org/portfolio${since ? `?since=${enc(since)}` : ''}`),
  orgProject: (wsId: string, projectId: string) => get<ProjectPage>(`/api/workspaces/${wsId}/org/projects/${enc(projectId)}`),
  createOrgProject: (wsId: string, body: ProjectPatch & { title: string }) => send<OrgProject>(`/api/workspaces/${wsId}/org/projects`, 'POST', body),
  updateOrgProject: (wsId: string, projectId: string, patch: ProjectPatch) => send<OrgProject>(`/api/workspaces/${wsId}/org/projects/${enc(projectId)}`, 'PATCH', patch),
  postProjectUpdate: (wsId: string, projectId: string, body: { health: string; reason?: string; ask?: string; body?: string; hill?: number | null }) => send<ProjectUpdate>(`/api/workspaces/${wsId}/org/projects/${enc(projectId)}/updates`, 'POST', body),
  addProjectMilestone: (wsId: string, projectId: string, body: { name: string; date?: string | null }) => send<OrgProject>(`/api/workspaces/${wsId}/org/projects/${enc(projectId)}/milestones`, 'POST', body),
  setProjectMilestone: (wsId: string, projectId: string, milestoneId: string, patch: { name?: string; date?: string | null; done?: boolean }) => send<OrgProject>(`/api/workspaces/${wsId}/org/projects/${enc(projectId)}/milestones/${enc(milestoneId)}`, 'PATCH', patch),
  decideProjectAppetite: (wsId: string, projectId: string, body: { decision: 'extend' | 'cut_scope' | 'kill'; extendDays?: number; extendUsd?: number; note?: string }) => send<OrgProject>(`/api/workspaces/${wsId}/org/projects/${enc(projectId)}/appetite`, 'POST', body),
  projectTeam: (wsId: string, projectId: string) => get<ProjectTeam>(`/api/workspaces/${wsId}/org/projects/${enc(projectId)}/team`),
  addProjectMember: (wsId: string, projectId: string, body: { agentId: string; role?: string; allocation: number }) => send<ProjectTeam>(`/api/workspaces/${wsId}/org/projects/${enc(projectId)}/team`, 'POST', body),
  removeProjectMember: (wsId: string, projectId: string, agentId: string) => send<ProjectTeam>(`/api/workspaces/${wsId}/org/projects/${enc(projectId)}/team/${enc(agentId)}`, 'DELETE'),
  setProjectStandup: (wsId: string, projectId: string, cron: string | null) => send<ProjectTeam>(`/api/workspaces/${wsId}/org/projects/${enc(projectId)}/standup`, 'POST', { cron }),
  linkTaskToProject: (wsId: string, projectId: string, taskId: string) => send<OrgTask>(`/api/workspaces/${wsId}/org/projects/${enc(projectId)}/tasks`, 'POST', { taskId }),
  taskTransitions: (wsId: string, taskId: string) => get<TaskTransition[]>(`/api/workspaces/${wsId}/org/tasks/${enc(taskId)}/transitions`),
  taskSteps: (wsId: string, taskId: string, op: { add?: string; done?: string; undo?: string; drop?: string }) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks/${enc(taskId)}/steps`, 'POST', op),
  setTaskBlockedOn: (wsId: string, taskId: string, body: { kind?: BlockedKind; ref?: string; reason?: string; clear?: boolean }) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks/${enc(taskId)}/blocked-on`, 'POST', body),
  orgTasks: (wsId: string, opts: { unitId?: string | null; rollUp?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.unitId) q.set('unitId', opts.unitId);
    if (opts.rollUp) q.set('rollUp', 'true');
    const qs = q.toString();
    return get<OrgTask[]>(`/api/workspaces/${wsId}/org/tasks${qs ? `?${qs}` : ''}`);
  },
  /** One task by id or short prefix, whatever its status or unit (the task deep link). */
  orgTask: (wsId: string, taskId: string) => get<OrgTask>(`/api/workspaces/${wsId}/org/tasks/${enc(taskId)}`),
  addOrgTask: (wsId: string, body: { title: string; brief?: Partial<OrgTaskBrief>; projectId?: string | null; assigneeAgentId?: string | null; unitId?: string; checks?: TaskCheck[]; dependsOn?: string[]; dueAt?: string | null }) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks`, 'POST', body),
  updateOrgTask: (wsId: string, taskId: string, patch: { title?: string; brief?: Partial<OrgTaskBrief>; status?: OrgTaskStatus; blockers?: string[]; dependsOn?: string[]; dueAt?: string | null }) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks/${taskId}`, 'PATCH', patch),
  assignOrgTask: (wsId: string, taskId: string, agentId: string) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks/${taskId}/assign`, 'POST', { agentId }),
  commentOrgTask: (wsId: string, taskId: string, text: string, notify?: string[]) => send<OrgMessage>(`/api/workspaces/${wsId}/org/tasks/${taskId}/comment`, 'POST', notify?.length ? { text, notify } : { text }),
  orgMentionables: (wsId: string) => get<OrgMentionable[]>(`/api/workspaces/${wsId}/org/mentionables`),
  orgTaskComments: (wsId: string, taskId: string) => get<OrgMessage[]>(`/api/workspaces/${wsId}/org/tasks/${taskId}/comments`),
  reviewOrgTask: (wsId: string, taskId: string, verdict: 'accept' | 'request_changes' | 'escalate', note?: string) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks/${taskId}/review`, 'POST', { verdict, note }),
  wakeOrgTask: (wsId: string, taskId: string, now = false) => send<{ queued?: boolean; result?: string }>(`/api/workspaces/${wsId}/org/tasks/${taskId}/wake`, 'POST', { now }),
  orgTaskRuns: (wsId: string, taskId: string) => get<OrgRun[]>(`/api/workspaces/${wsId}/org/tasks/${taskId}/runs`),
  orgRuns: (wsId: string, limit = 100) => get<OrgRun[]>(`/api/workspaces/${wsId}/org/runs?limit=${limit}`),
  orgApprovals: (wsId: string, status?: string) => get<OrgApproval[]>(`/api/workspaces/${wsId}/org/approvals${status ? `?status=${enc(status)}` : ''}`),
  decideOrgApproval: (wsId: string, approvalId: string, decision: 'approve' | 'reject' | 'revise', note?: string) =>
    send<{ approval: OrgApproval; result?: Record<string, unknown> }>(`/api/workspaces/${wsId}/org/approvals/${approvalId}/decide`, 'POST', { decision, note }),
  /** A person holding a routed card (docs/owners-seat.md §7): decide, send back or escalate with a recommendation. */
  actOnOrgDecision: (wsId: string, approvalId: string, decision: 'approve' | 'reject' | 'send_back' | 'escalate', note?: string, recommendation?: 'approve' | 'deny' | 'modify') =>
    send<{ approval: OrgApproval; message?: string }>(`/api/workspaces/${wsId}/org/approvals/${approvalId}/decide`, 'POST', { decision, note, recommendation }),
  orgDecisionAuthority: (wsId: string) => get<Array<{ kind: string; manager: 'decide' | 'decide_if' | 'recommend'; when: string }>>(`/api/workspaces/${wsId}/org/decisions/authority`),
  orgAudit: (wsId: string, limit = 100) => get<OrgAuditRow[]>(`/api/workspaces/${wsId}/org/audit?limit=${limit}`),
  verifyOrgAudit: (wsId: string) => get<{ ok: boolean; length: number; brokenAt: number | null; reason?: string }>(`/api/workspaces/${wsId}/org/audit/verify`),
  orgBrief: (wsId: string) => get<OrgBrief | null>(`/api/workspaces/${wsId}/org/brief`),
  composeOrgBrief: (wsId: string) => send<OrgBrief>(`/api/workspaces/${wsId}/org/brief`, 'POST'),
  replyOrgBrief: (wsId: string, text: string) => send<{ decisions: Array<{ n: number; decision: string; status: string }>; unresolved: string[] }>(`/api/workspaces/${wsId}/org/brief/reply`, 'POST', { text }),
  orgSpend: (wsId: string) => get<OrgSpend>(`/api/workspaces/${wsId}/org/spend`),
  setOrgBudget: (wsId: string, body: { scope: 'company' | 'agent' | 'project'; refId?: string; monthlyUsd: number }) => send<OrgBudget>(`/api/workspaces/${wsId}/org/budgets`, 'PUT', body),
  orgHumans: (wsId: string) => get<{ ceoAccountId: string; me: { actorId: string; role: HumanRole | null }; humans: OrgHuman[] }>(`/api/workspaces/${wsId}/org/humans`),
  setOrgHuman: (wsId: string, memberAccountId: string, role: HumanRole) => send<OrgHuman>(`/api/workspaces/${wsId}/org/humans`, 'POST', { memberAccountId, role }),
  removeOrgHuman: (wsId: string, memberAccountId: string) => send<{ ok: true }>(`/api/workspaces/${wsId}/org/humans/${enc(memberAccountId)}`, 'DELETE'),

  // the CEO's seat (docs/company-vision.md §8): intent (item 18), rituals (19), assurance (20)
  orgVision: (wsId: string) => get<OrgVisionInfo>(`/api/workspaces/${wsId}/org/vision`),
  setOrgVision: (wsId: string, body: { title: string; description?: string; dueAt?: string | null; rules?: string; monthlyUsd?: number }) => send<{ vision: OrgGoal; org: Org }>(`/api/workspaces/${wsId}/org/vision`, 'PUT', body),
  orgProfile: (wsId: string) => get<OrgProfile>(`/api/workspaces/${wsId}/org/profile`),
  setOrgProfile: (wsId: string, body: { values?: string; culture?: string }) => send<OrgProfile>(`/api/workspaces/${wsId}/org/profile`, 'PUT', body),
  orgTunables: (wsId: string) => get<OrgTunable[]>(`/api/workspaces/${wsId}/org/tunables`),
  setOrgTunable: (wsId: string, body: { key: string; value: number; why?: string }) => send<Org>(`/api/workspaces/${wsId}/org/tunables`, 'PUT', body),
  orgIntent: (wsId: string, unitId?: string | null) => get<OrgIntentNode[]>(`/api/workspaces/${wsId}/org/intent${unitId ? `?unitId=${enc(unitId)}` : ''}`),
  orgCheckIn: (wsId: string, goalId: string, body: { currentValue?: number | null; confidence?: number | null; note?: string }) => send<{ goal: OrgGoal; checkin: OrgCheckin }>(`/api/workspaces/${wsId}/org/goals/${goalId}/checkin`, 'POST', body),
  orgCheckIns: (wsId: string, goalId: string) => get<OrgCheckin[]>(`/api/workspaces/${wsId}/org/goals/${goalId}/checkins`),
  orgWhy: (wsId: string, ref: { taskId?: string; goalId?: string }) => get<WhyChain>(`/api/workspaces/${wsId}/org/why?${ref.taskId ? `taskId=${enc(ref.taskId)}` : `goalId=${enc(ref.goalId ?? '')}`}`),
  orgPlanNow: (wsId: string, body: { unitId?: string; reason?: string } = {}) => send<{ result: string }>(`/api/workspaces/${wsId}/org/plan`, 'POST', body),
  orgStrategy: (wsId: string) => get<{ memo: string; at: string | null }>(`/api/workspaces/${wsId}/org/strategy`),
  orgSignals: (wsId: string, opts: { status?: string; severity?: string; unitId?: string | null; kind?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.severity) q.set('severity', opts.severity);
    if (opts.unitId) q.set('unitId', opts.unitId);
    if (opts.kind) q.set('kind', opts.kind);
    const qs = q.toString();
    return get<OrgSignal[]>(`/api/workspaces/${wsId}/org/signals${qs ? `?${qs}` : ''}`);
  },
  ackOrgSignal: (wsId: string, signalId: string, note?: string) => send<OrgSignal>(`/api/workspaces/${wsId}/org/signals/${signalId}/ack`, 'POST', { note }),
  resolveOrgSignal: (wsId: string, signalId: string) => send<OrgSignal>(`/api/workspaces/${wsId}/org/signals/${signalId}/resolve`, 'POST'),
  orgPulse: (wsId: string) => get<OrgPulse>(`/api/workspaces/${wsId}/org/pulse`),
  orgSlo: (wsId: string) => get<OrgSloInfo>(`/api/workspaces/${wsId}/org/slo`),
  setOrgSlo: (wsId: string, body: Partial<SloTargets> & { tunables?: Record<string, number | null> }) => send<SloTargets>(`/api/workspaces/${wsId}/org/slo`, 'PATCH', body),
  orgAudits: (wsId: string, limit = 20) => get<OrgAuditRun[]>(`/api/workspaces/${wsId}/org/audits?limit=${limit}`),
  runOrgAudit: (wsId: string) => send<{ result: string }>(`/api/workspaces/${wsId}/org/audit/run`, 'POST'),
  /** `channelId`: the meetings held in that channel or run in a sub-channel of it, looked up by id (not a page of the newest). */
  orgMeetings: (wsId: string, opts: { unitId?: string | null; status?: string; channelId?: string | null } = {}) => {
    const q = new URLSearchParams();
    if (opts.unitId) q.set('unitId', opts.unitId);
    if (opts.channelId) q.set('channelId', opts.channelId);
    if (opts.status) q.set('status', opts.status);
    const qs = q.toString();
    return get<OrgMeeting[]>(`/api/workspaces/${wsId}/org/meetings${qs ? `?${qs}` : ''}`);
  },
  /** The meetings list and calendar (docs/meetings.md): past meetings and upcoming cadence occurrences. */
  meetings: (wsId: string, opts: { unitId?: string | null; channel?: string | null; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.unitId) q.set('unitId', opts.unitId);
    if (opts.channel) q.set('channel', opts.channel);
    if (opts.from) q.set('from', opts.from);
    if (opts.to) q.set('to', opts.to);
    const qs = q.toString();
    return get<CalendarResponse>(`/api/workspaces/${wsId}/meetings${qs ? `?${qs}` : ''}`);
  },
  orgMeeting: (wsId: string, meetingId: string) => get<OrgMeeting>(`/api/workspaces/${wsId}/org/meetings/${enc(meetingId)}`),
  startOrgMeeting: (wsId: string, body: { kind: MeetingKind; unitId?: string; channelId?: string; agenda?: string; title?: string; attendees?: Array<{ kind: 'agent' | 'human'; id: string }> }) => send<OrgMeeting>(`/api/workspaces/${wsId}/org/meetings`, 'POST', body),
  /** The room (docs/meetings.md "During"): join, steer, rule on proposals, answer, propose agenda items. */
  joinMeeting: (wsId: string, meetingId: string) => send<OrgMeeting>(`/api/workspaces/${wsId}/org/meetings/${enc(meetingId)}/join`, 'POST', {}),
  controlMeeting: (wsId: string, meetingId: string, action: 'extend' | 'skip' | 'end') => send<OrgMeeting>(`/api/workspaces/${wsId}/org/meetings/${enc(meetingId)}/control`, 'POST', { action }),
  meetingVerdict: (wsId: string, meetingId: string, body: { kind: 'decision' | 'action'; index: number; verdict: 'approve' | 'reject'; note?: string }) => send<OrgMeeting>(`/api/workspaces/${wsId}/org/meetings/${enc(meetingId)}/verdict`, 'POST', body),
  meetingAnswer: (wsId: string, meetingId: string, index: number, answer: string) => send<OrgMeeting>(`/api/workspaces/${wsId}/org/meetings/${enc(meetingId)}/answer`, 'POST', { index, answer }),
  proposeMeetingAgenda: (wsId: string, meetingId: string, text: string, why?: string) => send<OrgMeeting>(`/api/workspaces/${wsId}/org/meetings/${enc(meetingId)}/agenda`, 'POST', { text, why }),
  cancelOrgMeeting: (wsId: string, meetingId: string) => send<OrgMeeting>(`/api/workspaces/${wsId}/org/meetings/${enc(meetingId)}/cancel`, 'POST'),
  orgDecisions: (wsId: string, unitId?: string | null) => get<OrgDecision[]>(`/api/workspaces/${wsId}/org/decisions${unitId ? `?unitId=${enc(unitId)}` : ''}`),
  /** The decision a `#decision:<id>` chip names (id or unique prefix). */
  chatDecision: (wsId: string, idOrPrefix: string) => get<OrgDecision>(`/api/workspaces/${wsId}/chat/decisions/${enc(idOrPrefix)}`),
  orgCadences: (wsId: string) => get<OrgCadence[]>(`/api/workspaces/${wsId}/org/cadences`),
  updateOrgCadence: (wsId: string, cadenceId: string, patch: { cron?: string; enabled?: boolean }) => send<OrgCadence>(`/api/workspaces/${wsId}/org/cadences/${enc(cadenceId)}`, 'PATCH', patch),

  // memory, capital, blueprints, hybrid staff (docs/company-vision.md §6, §7, §9; items 22–24)
  orgAsk: (wsId: string, question: string) => send<AskResult>(`/api/workspaces/${wsId}/org/ask`, 'POST', { question }),
  orgRecall: (wsId: string, q: string) => get<RecallPack>(`/api/workspaces/${wsId}/org/recall?q=${enc(q)}`),
  orgSearchDecisions: (wsId: string, q: string, unitId?: string | null, limit = 50) => get<OrgDecision[]>(`/api/workspaces/${wsId}/org/decisions/search?q=${enc(q)}${unitId ? `&unitId=${enc(unitId)}` : ''}&limit=${limit}`),
  orgGraph: (wsId: string, ref: string, depth: 1 | 2 = 1) => get<OrgGraph>(`/api/workspaces/${wsId}/org/graph?ref=${enc(ref)}&depth=${depth}`),
  orgPlaybooks: (wsId: string, opts: { role?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.role) q.set('role', opts.role);
    if (opts.status) q.set('status', opts.status);
    const qs = q.toString();
    return get<OrgPlaybook[]>(`/api/workspaces/${wsId}/org/playbooks${qs ? `?${qs}` : ''}`);
  },
  retireOrgPlaybook: (wsId: string, playbookId: string, why = '') => send<OrgPlaybook>(`/api/workspaces/${wsId}/org/playbooks/${playbookId}/retire`, 'POST', { why }),
  orgCosts: (wsId: string, period: 'month' | 'all' = 'month', unitId?: string | null) => get<CostReport>(`/api/workspaces/${wsId}/org/costs?period=${period}${unitId ? `&unitId=${enc(unitId)}` : ''}`),
  orgForecast: (wsId: string) => get<OrgForecast>(`/api/workspaces/${wsId}/org/forecast`),
  orgRouting: (wsId: string) => get<OrgRouting>(`/api/workspaces/${wsId}/org/routing`),
  setOrgRouting: (wsId: string, patch: { classes?: Record<string, string | null>; models?: Record<string, string | null>; why?: string }) => send<OrgRouting>(`/api/workspaces/${wsId}/org/routing`, 'PUT', patch),
  orgAllocations: (wsId: string) => get<OrgAllocation[]>(`/api/workspaces/${wsId}/org/allocations`),
  setOrgAllocation: (wsId: string, body: { goalId: string; monthlyUsd: number; buys?: string }) => send<OrgAllocation>(`/api/workspaces/${wsId}/org/allocations`, 'PUT', body),
  orgPlans: (wsId: string, status?: string) => get<OrgPlan[]>(`/api/workspaces/${wsId}/org/plans${status ? `?status=${enc(status)}` : ''}`),
  orgPlan: (wsId: string, planId: string) => get<OrgPlan>(`/api/workspaces/${wsId}/org/plans/${enc(planId)}`),
  vetoOrgPlan: (wsId: string, planId: string, note?: string) => send<OrgPlan>(`/api/workspaces/${wsId}/org/plans/${enc(planId)}/veto`, 'POST', { note }),
  applyOrgPlanNow: (wsId: string, planId: string) => send<OrgPlan>(`/api/workspaces/${wsId}/org/plans/${enc(planId)}/apply-now`, 'POST'),
  orgDryRun: (wsId: string, body: { prompt?: string; assume?: { monthlyUsd?: number } }) => send<DryRunResult>(`/api/workspaces/${wsId}/org/plan/dry-run`, 'POST', body),
  orgReplay: (wsId: string, day: string) => get<OrgReplay>(`/api/workspaces/${wsId}/org/replay?day=${enc(day)}`),
  orgBlueprint: (wsId: string) => get<Blueprint>(`/api/workspaces/${wsId}/org/blueprint`),
  orgBlueprintPlan: (wsId: string, blueprint: Record<string, unknown>, opts: { mode?: ImportMode; monthlyUsd?: number } = {}) => send<BlueprintImportPlan>(`/api/workspaces/${wsId}/org/blueprint/plan`, 'POST', { blueprint, ...opts }),
  orgBlueprintImport: (wsId: string, blueprint: Record<string, unknown>, mode: ImportMode, monthlyUsd?: number) => send<BlueprintImportResult>(`/api/workspaces/${wsId}/org/blueprint/import`, 'POST', { blueprint, mode, monthlyUsd }),
  marketCompanies: (q = '') => get<{ items: CompanyRegistryItem[]; remote: RegistryList['remote'] }>(`/api/market/companies${q ? `?q=${enc(q)}` : ''}`),
  publishCompany: (body: { workspaceId: string; name?: string; description?: string; publisherName?: string; dryRun?: boolean }) => send<RegistryPublishResult>('/api/market/companies', 'POST', body),
  installCompany: (id: string, body: { workspaceId: string; mode: ImportMode; monthlyUsd?: number; confirm?: boolean }) => send<CompanyInstallResult>(`/api/market/companies/${enc(id)}/install`, 'POST', body),
  setOrgEmployee: (wsId: string, body: { memberAccountId: string; role: HumanRole; reportsToAgentId?: string | null; title?: string }) => send<OrgHuman>(`/api/workspaces/${wsId}/org/humans`, 'POST', body),
  assignOrgTaskHuman: (wsId: string, taskId: string, humanId: string) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks/${taskId}/assign`, 'POST', { humanId }),
  requestOrgTaskReview: (wsId: string, taskId: string, body: { text?: string; reviewerHumanId?: string }) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks/${taskId}/request-review`, 'POST', body),
  orgMyTasks: (wsId: string) => get<{ assigned: OrgTask[]; reviewing: OrgTask[] }>(`/api/workspaces/${wsId}/org/humans/me/tasks`),
  proposeOrgApproval: (wsId: string, body: { kind: OrgApprovalKind; payload: Record<string, unknown>; recommendation?: string }) => send<OrgApproval>(`/api/workspaces/${wsId}/org/approvals`, 'POST', body),
  // sensing (item 27, docs/sensing.md §5)
  orgMetricSources: (wsId: string) => get<MetricSource[]>(`/api/workspaces/${wsId}/org/metrics/sources`),
  createOrgMetricSource: (wsId: string, body: MetricSourceInput) => send<{ source: MetricSource; token?: string }>(`/api/workspaces/${wsId}/org/metrics/sources`, 'POST', body),
  updateOrgMetricSource: (wsId: string, sourceId: string, patch: MetricSourceInput) => send<MetricSource>(`/api/workspaces/${wsId}/org/metrics/sources/${enc(sourceId)}`, 'PATCH', patch),
  deleteOrgMetricSource: (wsId: string, sourceId: string) => send<unknown>(`/api/workspaces/${wsId}/org/metrics/sources/${enc(sourceId)}`, 'DELETE'),
  pollOrgMetricSource: (wsId: string, sourceId: string) => send<{ ok: boolean; value?: number; error?: string }>(`/api/workspaces/${wsId}/org/metrics/sources/${enc(sourceId)}/poll`, 'POST'),
  rotateOrgMetricToken: (wsId: string, sourceId: string) => send<{ token: string; url: string }>(`/api/workspaces/${wsId}/org/metrics/sources/${enc(sourceId)}/token`, 'POST'),
  orgMetricSamples: (wsId: string, sourceId: string, since?: string) => get<MetricSample[]>(`/api/workspaces/${wsId}/org/metrics/sources/${enc(sourceId)}/samples${since ? `?since=${enc(since)}` : ''}`),
  attestOrgMetric: (wsId: string, sourceId: string, body: { value: number; note: string; observedAt?: string }) => send<MetricSample>(`/api/workspaces/${wsId}/org/metrics/sources/${enc(sourceId)}/attest`, 'POST', body),
  bindOrgGoalSource: (wsId: string, goalId: string, sourceId: string | null) => send<OrgGoal>(`/api/workspaces/${wsId}/org/goals/${enc(goalId)}/source`, 'POST', { sourceId }),
  orgTaskChecks: (wsId: string, taskId: string) => get<TaskCheckResult[]>(`/api/workspaces/${wsId}/org/tasks/${enc(taskId)}/checks`),
  runOrgTaskChecks: (wsId: string, taskId: string) => send<{ outcome: 'none' | 'pass' | 'fail' | 'error'; results: TaskCheckResult[] }>(`/api/workspaces/${wsId}/org/tasks/${enc(taskId)}/checks/run`, 'POST'),
  // the action contract and the trust ledger (item 28, docs/actions-and-trust.md §8)
  workspaceTrust: (wsId: string) => get<TrustOverview>(`/api/workspaces/${wsId}/trust`),
  setTrustCeilings: (wsId: string, ceilings: Partial<Record<ActionClass, number>>) => send<{ ceilings: Record<ActionClass, TrustLevel> }>(`/api/workspaces/${wsId}/trust/ceilings`, 'PUT', { ceilings }),
  overrideTrust: (wsId: string, agentId: string, cls: ActionClass, level: number, reason: string) => send<unknown>(`/api/workspaces/${wsId}/trust/${enc(agentId)}/${enc(cls)}`, 'POST', { level, reason }),
  workspaceActions: (wsId: string, q: { agentId?: string; cls?: string; status?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.agentId) p.set('agentId', q.agentId);
    if (q.cls) p.set('class', q.cls);
    if (q.status) p.set('status', q.status);
    if (q.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return get<ActionLogRow[]>(`/api/workspaces/${wsId}/actions${qs ? `?${qs}` : ''}`);
  },
  reportActionRevert: (wsId: string, actionId: string, note: string) => send<ActionLogRow>(`/api/workspaces/${wsId}/actions/${enc(actionId)}/revert-report`, 'POST', { note }),
  workspaceAction: (wsId: string, actionId: string) => get<ActionLogRow>(`/api/workspaces/${wsId}/actions/${enc(actionId)}`),
  giveActionKey: (wsId: string, actionId: string, approve: boolean, note?: string) => send<{ status: ActionStatus; result: string }>(`/api/workspaces/${wsId}/actions/${enc(actionId)}/keys`, 'POST', { approve, note }),
  // incidents, health, audit independence (item 29, docs/incidents.md §6)
  orgIncidents: (wsId: string, status?: IncidentStatus) => get<OrgIncident[]>(`/api/workspaces/${wsId}/org/incidents${status ? `?status=${status}` : ''}`),
  orgIncident: (wsId: string, incidentId: string) => get<OrgIncident>(`/api/workspaces/${wsId}/org/incidents/${enc(incidentId)}`),
  reportOrgIncident: (wsId: string, body: { title: string; detail: string; severity: IncidentSeverity; agentId?: string; actionClass?: string }) => send<OrgIncident>(`/api/workspaces/${wsId}/org/incidents`, 'POST', body),
  containOrgIncident: (wsId: string, incidentId: string, body: { action: ManualContainment; agentId?: string; actionClass?: string }) => send<OrgIncident>(`/api/workspaces/${wsId}/org/incidents/${enc(incidentId)}/contain`, 'POST', body),
  resolveOrgIncident: (wsId: string, incidentId: string, body: { resolution: string; undo?: boolean }) => send<OrgIncident>(`/api/workspaces/${wsId}/org/incidents/${enc(incidentId)}/resolve`, 'POST', body),
  orgHealth: (wsId: string) => get<OrgHealth>(`/api/workspaces/${wsId}/org/health`),
  answerSpotCheck: (wsId: string, auditId: string, itemId: string, body: { agree: boolean; note?: string }) => send<{ card: SpotCard; quality: AuditorQuality; incident: OrgIncident | null }>(`/api/workspaces/${wsId}/org/audits/${enc(auditId)}/spotcheck/${enc(itemId)}`, 'POST', body),
  runOrgRedTeam: (wsId: string, agentId?: string) => send<RedTeamResult>(`/api/workspaces/${wsId}/org/redteam/run`, 'POST', agentId ? { agentId } : {}),
  // experiments, predictions, reconciliation (item 30, docs/experiments.md §6)
  orgExperiments: (wsId: string, status?: ExperimentStatus) => get<OrgExperiment[]>(`/api/workspaces/${wsId}/org/experiments${status ? `?status=${status}` : ''}`),
  orgExperiment: (wsId: string, expId: string) => get<OrgExperiment>(`/api/workspaces/${wsId}/org/experiments/${enc(expId)}`),
  proposeOrgExperiment: (wsId: string, body: ExperimentInput) => send<OrgExperiment>(`/api/workspaces/${wsId}/org/experiments`, 'POST', body),
  orgExperimentAction: (wsId: string, expId: string, action: 'start' | 'stop' | 'keep' | 'revert', note?: string) => send<OrgExperiment>(`/api/workspaces/${wsId}/org/experiments/${enc(expId)}/${action}`, 'POST', action === 'stop' ? { note: note ?? '' } : undefined),
  orgPredictions: (wsId: string, q: { agentId?: string; status?: string } = {}) => get<OrgPrediction[]>(`/api/workspaces/${wsId}/org/predictions?${new URLSearchParams(Object.entries(q).filter(([, v]) => Boolean(v)) as Array<[string, string]>).toString()}`),
  orgCalibration: (wsId: string) => get<{ bar: number; members: CalibrationRow[] }>(`/api/workspaces/${wsId}/org/calibration`),
  orgReconciliation: (wsId: string) => get<Reconciliation>(`/api/workspaces/${wsId}/org/reconciliation`),
  runOrgReconciliation: (wsId: string) => send<Reconciliation>(`/api/workspaces/${wsId}/org/reconciliation/run`, 'POST'),
  // the boundary, evals, capacity, the owner's seat (item 31; docs/boundary.md, docs/evals.md, docs/owners-seat.md)
  orgBoundary: (wsId: string) => get<{ rules: BoundaryRule[] }>(`/api/workspaces/${wsId}/org/boundary`),
  orgEvalCases: (wsId: string, roleKey?: string) => get<EvalCase[]>(`/api/workspaces/${wsId}/org/evals/cases${roleKey ? `?roleKey=${enc(roleKey)}` : ''}`),
  addOrgEvalCase: (wsId: string, body: { roleKey?: string; taskId?: string; title?: string; brief?: Partial<OrgTaskBrief>; checks?: TaskCheck[]; rubric?: string }) => send<EvalCase>(`/api/workspaces/${wsId}/org/evals/cases`, 'POST', body),
  retireOrgEvalCase: (wsId: string, caseId: string) => send<EvalCase>(`/api/workspaces/${wsId}/org/evals/cases/${enc(caseId)}`, 'DELETE'),
  runOrgEval: (wsId: string, body: { roleKey: string; candidate: { kind: EvalCandidateKind; ref?: string; after: string } }) => send<EvalRun>(`/api/workspaces/${wsId}/org/evals/run`, 'POST', body),
  orgEvalRuns: (wsId: string, roleKey?: string) => get<EvalRun[]>(`/api/workspaces/${wsId}/org/evals/runs${roleKey ? `?roleKey=${enc(roleKey)}` : ''}`),
  orgCapacity: (wsId: string) => get<OrgCapacity>(`/api/workspaces/${wsId}/org/capacity`),
  orgDelegations: (wsId: string) => get<OrgDelegation[]>(`/api/workspaces/${wsId}/org/delegations`),
  addOrgDelegation: (wsId: string, body: { kind: string; maxUsd?: number | null; delegateType: 'human' | 'role'; delegateRef: string }) => send<OrgDelegation>(`/api/workspaces/${wsId}/org/delegations`, 'POST', body),
  revokeOrgDelegation: (wsId: string, delegationId: string) => send<OrgDelegation>(`/api/workspaces/${wsId}/org/delegations/${enc(delegationId)}`, 'DELETE'),
  orgOutcomes: (wsId: string) => get<OutcomeRow[]>(`/api/workspaces/${wsId}/org/outcomes`),
  orgValueEvents: (wsId: string, since?: string) => get<ValueEvent[]>(`/api/workspaces/${wsId}/org/value-events${since ? `?since=${enc(since)}` : ''}`),
  setOrgGoalValue: (wsId: string, goalId: string, body: { valuePerUnit?: number | null; valueOnAchieve?: number | null; valueNote?: string }) => send<OrgGoal>(`/api/workspaces/${wsId}/org/goals/${enc(goalId)}/value`, 'PUT', body),
  /** Home (docs/home.md): the owner's mission control in one request. Without `since` the server records the visit. */
  home: (wsId: string, since?: string) => get<HomeData>(`/api/workspaces/${wsId}/home${since ? `?since=${enc(since)}` : ''}`, homeDataSchema),
  /** An agent's Dashboard (docs/mission-control.md): what it is doing, blocked on, next, done; its team and health. */
  agentOverview: (agentId: string) => get<AgentOverview>(`/api/agents/${enc(agentId)}/overview`),
  /** The org chart's mission control (docs/mission-control.md). */
  missionControl: (wsId: string) => get<MissionControl>(`/api/workspaces/${wsId}/org/mission-control`),
  /** The top bar (docs/home.md "Top bar"): the company at a glance. */
  workspaceStatus: (wsId: string) => get<WorkspaceStatus>(`/api/workspaces/${wsId}/status`),
  /** The switcher's rows: each own workspace's company state, Needs you and unread notifications. */
  workspaceGlance: () => get<WorkspaceGlanceRow[]>('/api/topbar/workspaces'),
  /** The owner's feed (docs/owners-seat.md "Inbox and notifications"): the Inbox and the bell read the same page. */
  feed: (wsId: string, limit?: number) => get<FeedPage>(`/api/workspaces/${wsId}/feed${limit ? `?limit=${limit}` : ''}`),
  /** Mark feed rows read: some ids (a row's `ids`), a section, or everything. */
  markFeedRead: (wsId: string, body: { ids: string[] } | { section: FeedSection } | { all: true }) => send<{ ok: true; marked: number }>(`/api/workspaces/${wsId}/feed/read`, 'POST', body),
  /** The update types this workspace can turn off (`notify.<type>` tunables; set them with setOrgTunable). */
  feedTypes: (wsId: string) => get<FeedTypeInfo[]>(`/api/workspaces/${wsId}/feed/types`),
};

// ---- the top bar (docs/home.md "Top bar"; server/src/home/topbar.types.ts) ----
export interface WorkspaceCompanyGlance { name: string; mode: 'supervised' | 'autonomous'; status: 'active' | 'paused' }
export interface LiveRun { sessionId: string; agentId: string | null; agentName: string; origin: string; sessionName: string; startedAt: string; toolLabel: string }
export interface WorkspaceStatus {
  workspaceId: string; generatedAt: string;
  company: WorkspaceCompanyGlance | null;
  /** needsYou: open items in the feed's Needs you (the Inbox badge); unread: unread feed rows (the bell). */
  needsYou: number; urgent: number; unread: number;
  spend: Pick<HomeSpend, 'todayUsd' | 'monthUsd' | 'monthCapUsd' | 'projectedUsd' | 'forecastState'> | null;
  agents: { total: number; working: number; failing: number; faces: Array<{ id: string; name: string; emoji: string; colors: string; state: 'working' | 'error' }> };
  live: LiveRun[];
  nextMeeting: { id: string; title: string; at: string; meetingId: string | null } | null;
  partial: string[];
}
export interface WorkspaceGlanceRow { workspaceId: string; company: WorkspaceCompanyGlance | null; needsYou: number; unread: number }

// ---- the owner's feed (docs/owners-seat.md "Inbox and notifications"; server/src/home/feed.types.ts) ----
export type FeedSection = 'needs' | 'mentions' | 'updates';
export type FeedType =
  | 'decision' | 'escalation' | 'key' | 'pending_change' | 'incident' | 'signal' | 'queued_action' | 'connection_approval'
  | 'task_assigned' | 'task_review' | 'blocked_on_you' | 'follow_attention' | 'plugin_review'
  | 'message' | 'mention'
  | 'follow' | 'channel_activity' | 'run_failed' | 'budget' | 'meeting' | 'brief' | 'audit' | 'experiment'
  | 'trust' | 'decided_without_you' | 'hire' | 'project_team' | 'program' | 'project' | 'blocked' | 'goal_at_risk'
  | 'plugin' | 'company' | 'agent_note';
export type FeedAction = HomeNeedAction | 'allow' | 'deny';
export interface FeedActor { kind: 'agent' | 'person' | 'system'; id: string | null; name: string; emoji?: string; colors?: string }
export interface FeedContext {
  taskId?: string; taskKey?: string | null; taskTitle?: string;
  projectId?: string; projectKey?: string | null; projectTitle?: string;
  channelId?: string; channelSlug?: string; meetingId?: string; meetingTitle?: string; agentId?: string;
}
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
  id: string; type: FeedType; section: FeedSection; title: string; body: string; at: string;
  severity: 'critical' | 'high' | 'normal' | 'low'; read: boolean; actionable: boolean;
  deadline: string | null; expiresSoon: boolean; actor: FeedActor | null; company: string;
  context: FeedContext; target: FeedTarget; actions: FeedAction[];
  /** Updates about one thing collapse into one row: how many, and every member id. */
  count: number; ids: string[];
  need?: HomeNeed;
  ref?: { agentId?: string; eventId?: string; sessionId?: string; follow?: { targetKind: string; targetId: string } };
}
export interface FeedCounts { needsYou: number; urgent: number; unread: number; sections: Record<FeedSection, { total: number; unread: number }> }
export interface FeedPage { workspaceId: string; generatedAt: string; company: string; items: FeedItem[]; counts: FeedCounts; unread: number }
export interface FeedTypeInfo { type: FeedType; label: string; description: string; key: string; on: boolean; default: boolean }

// ---- Home (docs/home.md; server/src/home/home.types.ts) ----
export type HomeNeedAction = 'approve' | 'reject' | 'veto' | 'apply_now' | 'ack' | 'dismiss';
export type HomeNeedKind = 'approval' | 'escalation' | 'held_action' | 'plan' | 'incident' | 'signal' | 'queued_action';
export interface HomeNeed {
  id: string; kind: HomeNeedKind; subkind: string; title: string; detail: string; severity: 'critical' | 'high' | 'normal'; createdAt: string;
  deadline: string | null; defaultAction: 'approve' | 'deny' | 'apply' | ''; recommendation: string; recommendedAction: string; reversibility: string;
  confidence: number | null; requestedBy: string;
  ref: { approvalId?: string; actionId?: string; planId?: string; incidentId?: string; signalId?: string; agentId?: string; eventId?: string; taskId?: string; sessionId?: string };
  actions: HomeNeedAction[];
  /** The route a card climbed to reach you (docs/owners-seat.md §7). */
  chain?: { line: string; hops: Array<{ at: string; action: string; by: string; recommendation: string; reasoning: string }>; reserved: string };
  /** A card about one task (an escalation, a review): its key and title. */
  task?: { key: string | null; title: string };
}
export interface HomeRef { type: string; id: string }
export interface HomeRecapItem { at: string; kind: 'auto' | 'default' | 'delegate' | 'decision' | 'hire' | 'pause' | 'terminate'; title: string; detail: string; ref: HomeRef | null }
export interface HomeRecap {
  tasksDone: number; tasksBlocked: number; decisions: HomeRecapItem[]; decisionsCount: number; people: HomeRecapItem[]; artifactsChanged: number;
  brief: { at: string; text: string } | null; pulse: { score: number; breaches: number } | null;
  /** Tasks done per day, the last 14 days, oldest first. */
  doneSeries?: Array<{ day: string; done: number }>;
}
export type HomeRag = 'red' | 'amber' | 'green' | 'grey';
export interface HomeKeyResult { id: string; title: string; currentValue: number | null; targetValue: number | null; unitLabel: string; progress: number; confidence: number | null; atRisk: boolean; atRiskReason: string; rag: HomeRag; dueAt: string | null;
  /** The worst owner-written health of the projects that move it (docs/work-tracking.md); shown beside the RAG, never averaged in. */
  projectHealth?: '' | 'on_track' | 'at_risk' | 'off_track' }
export interface HomeGoal { id: string; title: string; ownerName: string | null; progress: number; confidence: number | null; atRisk: boolean; atRiskReason: string; rag: HomeRag; dueAt: string | null; keyResults: HomeKeyResult[] }
export type HomeAgentState = 'working' | 'idle' | 'blocked' | 'paused' | 'error';
export interface HomeAgent {
  id: string; name: string; emoji: string; colors: string; title: string; state: HomeAgentState; doing: string; taskId: string | null;
  lastActiveAt: string | null; lastBeatAt: string | null; isChief: boolean;
  errors: Array<{ kind: 'turn' | 'loop' | 'breaker' | 'provider' | 'budget'; message: string; at: string; sessionId?: string | null; taskId?: string | null }>;
}
export type HomeActivityKind = 'task' | 'hire' | 'decision' | 'meeting' | 'incident' | 'file' | 'agent';
/** One agent loop run (a heartbeat beat), raw. */
export interface HomeRun { id: string; at: string; title: string; detail: string }
export interface HomeActivity {
  id: string; at: string; kind: HomeActivityKind; title: string; detail: string; actor: string; ref: HomeRef | null;
  /** A loop run that did something notable: the loop's name. */
  loop?: string;
  /** Routine loop runs of one agent in one day, collapsed into this row. */
  runs?: { count: number; loops: string[]; from: string; items: HomeRun[] };
}
export interface HomeSpend {
  todayUsd: number | null; monthUsd: number | null; monthCapUsd: number | null; projectedUsd: number | null;
  forecastState: 'onTrack' | 'warn' | 'stop' | null; tokens: { spent: number; budget: number; over: boolean } | null;
  /** Spend per day, the last 14 days, oldest first. */
  series?: Array<{ day: string; usd: number }>;
}
export interface HomeHealth {
  status: 'ok' | 'degraded' | 'incident';
  openIncidents: Array<{ id: string; title: string; severity: string; status: string; openedAt: string }>;
  providers: Array<{ provider: string; state: string; lastError: string }>;
  audit: { id: string; at: string; status: string; findings: number; top: Array<{ severity: string; title: string }>; summary: string } | null;
}
export interface HomeUpcoming {
  id: string; at: string; kind: 'meeting' | 'ritual' | 'deadline' | 'decision' | 'loop' | 'plan'; title: string; detail: string; ref: HomeRef | null;
  /** Rituals and loops: the five-field cron (server-local), put in words by the page. */
  cron?: string;
  /** Rituals: the units holding it at this time. */
  units?: string[];
}
/** One message an agent sent the owner with message_owner (docs/agent-messages.md); it opens the agent's direct chat. */
export interface AgentMessage {
  id: string; eventId: string | null; agentId: string; agentName: string; emoji: string; colors: string;
  text: string; urgency: 'fyi' | 'normal' | 'urgent'; refs: string[]; sessionId: string; createdAt: string; read: boolean;
}
export interface HomeArtifact { path: string; version: number; size: number; updatedAt: string; updatedBy: { kind: string; id: string; name: string } }
export interface HomeCompany { orgId: string; name: string; mode: OrgMode; status: 'active' | 'paused'; chiefAgentId: string | null; chiefName: string | null; memberCount: number }
/** GET /api/workspaces/:id/home. */
export interface HomeData {
  workspaceId: string; generatedAt: string; since: string; firstVisit: boolean;
  company: HomeCompany | null;
  headline: { tasksDone: number; needsYou: number; todayUsd: number | null; monthUsd: number | null; monthCapUsd: number | null };
  needs: HomeNeed[]; recap: HomeRecap; goals: HomeGoal[]; team: HomeAgent[]; activity: HomeActivity[];
  spend: HomeSpend; health: HomeHealth; upcoming: HomeUpcoming[]; artifacts: HomeArtifact[];
  /** Messages from your team (docs/agent-messages.md); absent from an older server. */
  messages?: { items: AgentMessage[]; unread: number };
  /** Work tracking: the CEO's portfolio of projects and the digest since the last visit (null without a company). */
  portfolio?: HomePortfolio | null;
  /** Sections that failed to load on the server. */
  partial: string[];
}

// ---- the overviews (docs/mission-control.md; server/src/home/overview.types.ts) ----
export interface BlockerInfo {
  reason: string;
  waitsOn: { kind: 'ceo' | 'agent' | 'task' | 'unknown'; id: string | null; name: string; taskId: string | null };
  since: string;
}
export interface OverviewLive { sessionId: string; sessionName: string; origin: string; startedAt: string; tool: string | null; toolLabel: string; toolAt: string | null; calls: number }
export interface OverviewStatus extends HomeAgent {
  live: OverviewLive | null; doingSince: string | null; waitingOnYou: number; blockedCount: number; open: number; lastRunAt: string | null; memberStatus: string | null;
}
export interface OverviewTask {
  /** The task key (docs/tasks-keys.md), e.g. ENG-12; null on a row from before keys. */
  key?: string | null;
  id: string; source: 'org' | 'agent'; title: string; status: string; outcome: string; doneWhen: string;
  startedAt: string | null; updatedAt: string; createdAt: string; dueAt: string | null;
  lastComment: { at: string; from: string; text: string } | null; files: string[]; acceptedBy: string; assigneeName: string;
}
export interface OverviewBlocked extends OverviewTask { blocker: BlockerInfo }
export interface OverviewFollow { id: string; targetKind: string; targetId: string; title: string; attention: string; unseen: number; lastActivityAt: string | null; lastActorName: string }
export interface OverviewGoal {
  id: string; kind: string; title: string; progress: number; confidence: number | null; rag: HomeRag; atRisk: boolean; atRiskReason: string;
  currentValue: number | null; targetValue: number | null; unitLabel: string; dueAt: string | null;
}
export interface TeamTile { id: string; name: string; emoji: string; colors: string; title: string; state: HomeAgentState; doing: string; taskId: string | null; lastBeatAt: string | null; open: number; liveLabel: string }
/** Why the agent is erroring: the loudest error, its run, a fix (`tab` is an agent-page tab, 'Settings:General'). */
export interface OverviewCause {
  kind: HomeAgent['errors'][number]['kind']; message: string; at: string;
  sessionId: string | null; taskId: string | null; fix: { text: string; tab: string | null } | null;
  /** The failing run when it can run again (docs/work-log.md "Rerun"). */
  rerunTurnId?: string | null;
}
/** Something waiting on the owner. */
export interface NeedsYouItem {
  id: string; kind: 'action' | 'connection' | 'escalation' | 'approval'; title: string; detail: string; at: string;
  eventId: string | null; approvalId: string | null; taskId: string | null; sessionId: string | null;
}
/** GET /api/agents/:id/overview. */
export interface AgentOverview {
  agentId: string; workspaceId: string; generatedAt: string;
  agent: { id: string; name: string; emoji: string; colors: string; title: string; role: string; provider: string; model: string; isChief: boolean; hasReports: boolean };
  inCompany: boolean;
  status: OverviewStatus;
  cause: OverviewCause | null;
  needsYou: NeedsYouItem[];
  heartbeat: { enabled: boolean; cron: string; nextDueAt: string | null; lastBeatAt: string | null; lastRunAt: string | null; lastReason: string; runsToday: number; dailyRunCap: number } | null;
  nextLoop: { name: string; at: string; cron: string } | null;
  now: OverviewTask | null; blocked: OverviewBlocked[]; queue: OverviewTask[]; reviews: OverviewTask[]; follows: OverviewFollow[]; done: OverviewTask[];
  files: Array<{ path: string; version: number; updatedAt: string }>;
  recent: HomeActivity[];
  goals: OverviewGoal[];
  team: { manager: TeamTile | null; reports: TeamTile[]; humans: Array<{ memberAccountId: string; title: string }>; unit: { id: string; name: string; slug: string } | null };
  health: {
    errors: HomeAgent['errors'];
    spend: { todayUsd: number | null; d30Usd: number | null; monthUsd: number | null; monthCapUsd: number | null; series: Array<{ day: string; usd: number }> };
    trust: Array<{ actionClass: string; effective: number; ceiling: number }>;
    wip: { open: number; limit: number } | null;
  };
  dashboard: string;
  partial: string[];
  /** Decisions for it as a manager (docs/owners-seat.md §7). */
  decisions?: OverviewDecision[];
}
export interface OverviewDecision { approvalId: string; kind: string; title: string; from: string; chainLine: string; reserved: string; urgency: string; hopDeadline: string | null; createdAt: string }
export interface MissionNode extends OverviewStatus {
  agentId: string; reportsToAgentId: string | null; leadsUnitId: string | null;
  wip: { open: number; limit: number };
  spend: { todayUsd: number; monthUsd: number; monthCapUsd: number };
  waits: Array<{ taskId: string; title: string; waitsOn: BlockerInfo['waitsOn']; reason: string; since: string }>;
  liveLabel: string;
}
/** GET /api/workspaces/:id/org/mission-control. */
export interface MissionControl {
  workspaceId: string; orgId: string; generatedAt: string;
  company: { name: string; status: string; mode: string; chiefAgentId: string | null };
  totals: { working: number; blocked: number; idle: number; paused: number; error: number; tasksInFlight: number; waitingOnYou: number; spendTodayUsd: number | null; monthUsd: number | null; monthCapUsd: number | null };
  units: Array<{ id: string; name: string; slug: string; leadAgentId: string; parentUnitId: string | null; openTasks: number }>;
  nodes: MissionNode[];
  humans: Array<{ id: string; memberAccountId: string; title: string; reportsToAgentId: string | null }>;
  edges: Array<{ from: string; to: string; taskId: string; title: string }>;
  partial: string[];
}

export interface AppLlmResult {
  text: string;
  data?: unknown;
  parseError?: string;
  remainingTokensToday: number;
}

/** Stream a mini app's model call, relaying chunks as they arrive. The frame
 *  has no network of its own — the host page runs this and forwards. */
export async function appLlmStream(
  agentId: string,
  appId: string,
  prompt: string,
  onChunk: (text: string) => void,
  maxTokens?: number,
): Promise<AppLlmResult> {
  const res = await fetch(`/api/agents/${agentId}/apps/${appId}/llm/stream`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, maxTokens }),
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AppLlmResult = { text: '', remainingTokensToday: 0 };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const chunk of events) {
      const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!data) continue;
      try {
        const ev = JSON.parse(data) as
          { type: 'chunk'; text: string } | { type: 'done'; result: AppLlmResult } | { type: 'error'; message: string };
        if (ev.type === 'chunk') onChunk(ev.text);
        else if (ev.type === 'done') result = ev.result;
        else throw new Error(ev.message);
      } catch (err) {
        if (err instanceof SyntaxError) continue; // one bad frame must not kill the stream
        throw err;
      }
    }
  }
  return result;
}

/** Send a message and consume the SSE turn stream. */
export async function sendTurn(
  chatId: string,
  text: string,
  attachments: Array<{ path: string; kind: string }>,
  onEvent: (ev: TurnEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}/turns`, {
    method: 'POST',
    headers: { ...authHeaders(`/api/chats/${chatId}/turns`), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, attachments }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const chunk of events) {
      // an event's payload may span several data: lines (SSE spec)
      const data = chunk.split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as TurnEvent);
      } catch {
        // one malformed event must not kill the whole stream
      }
    }
  }
}

/** Watch the turn running in a session, whoever started it (docs/work-log.md
 *  "Intervening"): the same fetch-based SSE reader as sendTurn. Resolves
 *  when the turn ends, nothing runs (`idle`), or `signal` aborts. */
export async function watchSession(
  chatId: string,
  onEvent: (ev: SessionWatchEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `/api/chats/${chatId}/live`;
  const res = await fetch(url, { headers: authHeaders(url), signal });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const chunk of events) {
      const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!data) continue;
      try { onEvent(JSON.parse(data) as SessionWatchEvent); } catch { /* one malformed event must not kill the stream */ }
    }
  }
}

/** The workspace event stream (docs/group-chat.md §4): the same fetch-based
 *  SSE reader as sendTurn, so the bearer token and the shared-workspace
 *  header travel with it. Resolves when the server closes or `signal` aborts. */
export async function subscribeWorkspaceEvents(
  workspaceId: string,
  onEvent: (ev: WorkspaceEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `/api/workspaces/${workspaceId}/events`;
  const res = await fetch(url, { headers: authHeaders(url), signal });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const chunk of events) {
      const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!data) continue;
      try { onEvent(JSON.parse(data) as WorkspaceEvent); } catch { /* one malformed event must not kill the stream */ }
    }
  }
}
