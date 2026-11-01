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
  transcriptSchema,
  hireResultSchema,
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
  homeDir: string | null;
  /** Assigned workspace folder, mounted into its chats as shared/. */
  workspaceFolder: string;
  dashboard: string;
  loops: string; // JSON array of LoopDef (src/lib/triggers.ts): { name, cron?, trigger?, … }
  apps: string; // JSON array of AgentApp
  createdAt: string;
}

/** One card on an agent's kanban board. */
export interface AgentTask {
  id: string;
  agentId: string;
  title: string;
  note: string;
  status: 'todo' | 'doing' | 'done';
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
export type HumanRole = 'ceo' | 'board' | 'observer';
export interface OrgHuman { id: string; orgId: string; memberAccountId: string; role: HumanRole; createdAt: string }

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
  baseUrl: string | null;
  persona: string;
  enabled: number;
  hasApiKey: boolean;
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
  compactSummary: string;
  compactCutoff: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Shared workspaces: the member who created it ('' = the owner) and
   *  whether every member may see it (1) or only its creator and the owner. */
  initiatedBy?: string;
  shared?: number;
  createdAt: string;
  updatedAt: string;
}

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
  source: 'local' | 'remote';
  remoteUrl: string;
  installed?: boolean;
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
  source: 'local' | 'remote';
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

export interface FileEntry {
  path: string;
  size: number;
  lastModified?: string;
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
}

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
  /** Present on the list route. */
  unread?: number; memberCount?: number;
}
export interface ChannelMember {
  id: string; channelId: string; memberKind: 'agent' | 'human'; memberId: string; role: 'owner' | 'member';
  notify: 'all' | 'mentions' | 'none'; unprompted: number; joinedAt: string; name: string;
}
export interface ChannelDetail extends Channel {
  members: ChannelMember[]; spentToday: number; orgMode: boolean;
  /** Set when this is a unit channel (docs/group-chat.md §7). */
  unit?: { id: string; name: string; slug: string; orgId: string; leadAgentId: string } | null;
}
export interface ChannelMessage {
  id: string; channelId: string; threadRootId: string | null; authorKind: 'agent' | 'human' | 'system'; authorId: string;
  text: string; attachments: string; mentions: string; taskId: string | null; runId: string | null; unprompted: number;
  editedAt: string | null; createdAt: string;
}
export interface ChannelPage { messages: ChannelMessage[]; replies: Record<string, { count: number; lastAt: string }>; hasMore: boolean }
export interface ChannelFile { path: string; name: string; size: number; lastModified?: string }
export type WorkspaceEvent =
  | { type: 'hello'; workspaceId: string }
  | { type: 'channel_message'; workspaceId: string; channelId: string; message: ChannelMessage }
  | { type: 'channel_typing'; workspaceId: string; channelId: string; threadRootId: string | null; agentId: string; liveId: string; on: boolean }
  | { type: 'channel_stream'; workspaceId: string; channelId: string; threadRootId: string | null; agentId: string; liveId: string; delta: string; done?: boolean }
  | { type: 'task_update'; workspaceId: string; channelId: string; taskId: string; status: string; messageId: string | null; title: string }
  | { type: 'channel_update'; workspaceId: string; channelId: string }
  | { type: 'channel_approval'; workspaceId: string; channelId: string; threadRootId: string | null; agentId: string; sessionId: string; callId: string; tool: string; input: Record<string, unknown>; forActor: string; forName: string };

export interface SearchResults {
  /** Group-chat hits (the same FTS extended to channel messages). */
  channelMessages?: Array<{ channelId: string; slug: string; messageId: string; threadRootId: string | null; authorKind: string; authorId: string; snippet: string; createdAt: string }>;
  sessions: Array<{ id: string; name: string; autoTitle: string }>;
  messages: Array<{ sessionId: string; messageId: string; turnId: string; role: string; snippet: string }>;
  files: Array<{ path: string; size: number }>;
}

// ---- the company is the workspace (docs/group-chat.md §5, /api/workspaces/:id/org) ----
export type OrgTaskStatus = 'backlog' | 'todo' | 'claimed' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
export const ORG_TASK_STATUSES: OrgTaskStatus[] = ['backlog', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];

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
}
/** Units (docs/group-chat.md §7): a board, a channel and a goal tracker per org level. */
export interface OrgUnit {
  id: string; orgId: string; leadAgentId: string; parentUnitId: string | null; name: string; slug: string; channelId: string | null; archivedAt: string | null; createdAt: string;
}
export interface OrgUnitNode extends OrgUnit { memberAgentIds: string[]; counts: { openTasks: number; tasks: number; goals: number }; children: OrgUnitNode[] }
export interface OrgGoalNode extends OrgGoal { progress: number; tasks: { total: number; done: number }; children: OrgGoalNode[] }
export interface OrgProject { id: string; orgId: string; goalId: string | null; title: string; status: string; ownerAgentId: string | null; createdAt: string }
export interface OrgBudget { id: string; orgId: string; scope: 'company' | 'agent' | 'project'; refId: string; monthlyUsd: number; reservedUsd: number; spentUsd: number; month: string }
export interface OrgGrant { id: string; orgId: string; agentId: string; kind: string; value: string; grantedBy: string; createdAt: string }
export interface OrgDetail extends Org {
  members: OrgMember[]; goals: OrgGoal[]; projects: OrgProject[]; budgets: OrgBudget[]; grants: OrgGrant[];
  charterDrift: Array<{ agentId: string; name: string; recorded: string; live: string }>;
}
export interface OrgTaskBrief { outcome: string; context: string; constraints: string; done_when: string }
export interface OrgTask {
  id: string; orgId: string; projectId: string | null; parentTaskId: string | null; title: string; brief: string;
  status: OrgTaskStatus; assigneeAgentId: string | null; claimedBy: string | null; claimedAt: string | null;
  reviewerAgentId: string | null; reviewRounds: number; blockers: string; fileScope: string; noProgressCount: number;
  lastRunAt: string | null; createdBy: string; createdAt: string; updatedAt: string;
  /** Units (docs/group-chat.md §7). */
  unitId: string | null; unitExplicit: number;
}
export interface OrgRun {
  id: string; orgId: string; taskId: string; agentId: string; sessionId: string | null; wakeReason: string;
  status: string; outcome: string; tokensIn: number; tokensOut: number; usd: number; startedAt: string; endedAt: string | null;
}
export interface OrgMessage { id: string; orgId: string; taskId: string | null; fromAgentId: string | null; runId: string | null; text: string; createdAt: string }
export type OrgApprovalKind = 'hire' | 'scope_widen' | 'reorg' | 'budget_raise' | 'strategy' | 'external' | 'terminate' | 'escalation';
export interface OrgApproval {
  id: string; orgId: string; kind: OrgApprovalKind; payload: string; requestedBy: string; recommendation: string;
  status: 'pending' | 'approved' | 'rejected' | 'revision_requested' | 'expired'; decidedAt: string | null; decidedBy?: string; decisionNote: string; expiresAt: string | null; createdAt: string;
}
export interface OrgAuditRow { id: string; orgId: string; seq: number; actor: string; action: string; refType: string; refId: string; payload: string; prevHash: string; hash: string; createdAt: string }
export interface OrgBrief { orgId: string; at: string; text: string; items: Array<{ n: number; approvalId: string; kind: string; summary: string }> }
/** GET /api/workspaces/:id/org — mode, caps and the full org detail when enabled. */
export interface WorkspaceOrg {
  workspaceId: string; mode: OrgMode; chiefOfStaffAgentId: string | null; orgMonthlyUsd: number; orgAgentCap: number;
  orgId: string | null; orgStatus: 'active' | 'paused' | null; pendingApprovals: number; org: OrgDetail | null;
  /** The unit tree (docs/group-chat.md §7), empty without an organization. */
  units: OrgUnitNode[];
  enrolled?: string[]; notEnrolled?: Array<{ agentId: string; reason: string }>;
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
  cadences?: 'default' | 'light' | 'none';
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
export interface OrgSpendNode { usd: number; tokensIn: number; tokensOut: number; runs: number; monthlyUsd: number; reservedUsd: number }
export interface OrgSpend {
  month: string; company: OrgSpendNode;
  projects: Array<OrgSpendNode & { id: string; title: string }>;
  members: Array<OrgSpendNode & { agentId: string; name: string; title: string }>;
  acceptedTasks: number; costPerAcceptedTask: number | null; series: UsageDay[];
}

// ---- the CEO's seat (docs/company-vision.md §8; execution plan items 18–21) ----
export type Pace = 'onPace' | 'behind' | 'unknown';
/** GET …/org/intent?unitId= — the goal tree with pace, measured progress, confidence, risk and owner. */
export interface OrgIntentNode extends OrgGoal {
  progress: number; tasks: { total: number; done: number };
  pace: Pace; expected: number | null; measured: number | null; ownerName: string | null;
  children: OrgIntentNode[];
}
export interface OrgVisionInfo { vision: OrgGoal | null; rules: string; values: string; culture: string }
export interface OrgProfile { values: string; culture: string; rules: string; mission: string }
export type TunableArea = 'intent' | 'planning' | 'rituals' | 'assurance' | 'heartbeat' | 'brief';
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
  id: string; orgId: string; auditorAgentId: string; trigger: 'cadence' | 'manual'; startedAt: string; endedAt: string | null; sampled: string; findings: string; summary: string;
  singleModel: number; model: string; usd: number; status: 'running' | 'done' | 'failed' | 'budget_stop'; createdAt: string;
}
export interface AuditFinding { severity: string; kind: string; refType: string; refId: string; title: string; detail: string }
export type MeetingKind = 'planning' | 'standup' | 'weekly_review' | 'retro' | 'board' | 'adhoc';
export const MEETING_KINDS: MeetingKind[] = ['planning', 'standup', 'weekly_review', 'retro', 'board', 'adhoc'];
export type MeetingStatus = 'scheduled' | 'running' | 'done' | 'cancelled' | 'postponed';
export interface MinutesAction { title: string; owner: string; done_when: string; outcome: string; by: string; taskId?: string }
export interface MinutesDecision { title: string; decision: string; alternatives: string; rationale: string; by: string; decisionId?: string }
export interface Minutes { summary: string; decisions: MinutesDecision[]; actions: MinutesAction[]; risks: Array<{ text: string; by: string }>; questions: Array<{ question: string; by: string }>; endedBy?: string }
/** A meeting (docs/group-chat.md §8): a thread in a unit channel; `minutes` is JSON (Minutes). */
export interface OrgMeeting {
  id: string; orgId: string; unitId: string | null; channelId: string | null; threadRootId: string | null; kind: MeetingKind; title: string; agenda: string;
  facilitatorAgentId: string | null; attendees: string; status: MeetingStatus; scheduledFor: string | null; startedAt: string | null; endedAt: string | null;
  rounds: number; usd: number; minutes: string; createdBy: string; createdAt: string;
}
/** The decision log (docs/company-vision.md §6); referenced as `#decision:<id>`. */
export interface OrgDecision {
  id: string; orgId: string; unitId: string | null; meetingId: string | null; approvalId: string | null; title: string; decision: string; alternatives: string; rationale: string;
  decidedBy: string; refType: string; refId: string; createdAt: string;
}
export interface OrgCadence { id: string; orgId: string; unitId: string; kind: MeetingKind; cron: string; enabled: number; lastRunAt: string | null; nextRunAt: string | null; createdAt: string }

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
  | { type: 'answer'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean; review?: ToolReview }
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

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
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
const OWN_ACCOUNT_ROUTE = /^\/api\/(auth|account|admin|push)(\/|$)|^\/api\/workspaces(\/shared)?$/;

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

  // chats
  chats: (workspaceId: string) => get<ChatSession[]>(`/api/chats?workspaceId=${enc(workspaceId)}`, chatSessionListSchema),
  chat: (id: string) => get<ChatSession>(`/api/chats/${id}`, chatSessionSchema),
  createChat: (input: { workspaceId: string; name?: string; agentId?: string; agentTypeId?: string; cwd?: string; tokenCeiling?: number }) =>
    send<ChatSession>('/api/chats', 'POST', input, chatSessionSchema),
  updateChat: (id: string, patch: Record<string, unknown>) => send<ChatSession>(`/api/chats/${id}`, 'PATCH', patch, chatSessionSchema),
  deleteChat: (id: string) => send<{ ok: boolean }>(`/api/chats/${id}`, 'DELETE'),
  transcript: (id: string) => get<{ messages: ChatMessage[]; turns: ChatTurn[] }>(`/api/chats/${id}/transcript`, transcriptSchema),
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
  createAgent: (input: { name: string; workspaceId: string; charter?: string; role?: string; emoji?: string; colors?: [string, string]; provider?: string; model?: string }) =>
    send<Agent>('/api/agents', 'POST', input, agentSchema),
  /** Move an agent to another workspace — refused while it sits in an organization. */
  moveAgent: (id: string, workspaceId: string) => send<Agent>(`/api/agents/${id}/move`, 'POST', { workspaceId }, agentSchema),
  updateAgent: (id: string, patch: Record<string, unknown>) => send<Agent>(`/api/agents/${id}`, 'PATCH', patch, agentSchema),
  deleteAgent: (id: string) => send<{ ok: boolean }>(`/api/agents/${id}`, 'DELETE'),
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
  updateAgentTask: (id: string, taskId: string, patch: { title?: string; note?: string; status?: string }) =>
    send<AgentTask>(`/api/agents/${id}/tasks/${taskId}`, 'PATCH', patch),
  deleteAgentTask: (id: string, taskId: string) => send<{ ok: boolean }>(`/api/agents/${id}/tasks/${taskId}`, 'DELETE'),
  agentStats: (id: string) => get<AgentStats>(`/api/agents/${id}/stats`),
  agentFiles: (id: string, workspaceId?: string) =>
    get<FileEntry[]>(`/api/agents/${id}/files${workspaceId ? `?workspaceId=${enc(workspaceId)}` : ''}`, fileEntryListSchema),
  putAgentFile: (id: string, path: string, contentBase64: string, contentType?: string, durationSeconds?: number) =>
    send<UploadResult>(`/api/agents/${id}/files`, 'POST', { path, contentBase64, contentType, durationSeconds }),
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
  orgGoalTree: (wsId: string, unitId?: string | null) => get<OrgGoalNode[]>(unitId ? `/api/workspaces/${wsId}/org/units/${unitId}/goals/tree` : `/api/workspaces/${wsId}/org/goals/tree`),
  goalMessages: (wsId: string, goalId: string) => get<Array<ChannelMessage & { slug: string }>>(`/api/workspaces/${wsId}/chat/goals/${goalId}/messages`),
  addOrgProject: (wsId: string, body: { title: string; goalId?: string | null }) => send<OrgProject>(`/api/workspaces/${wsId}/org/projects`, 'POST', body),
  orgTasks: (wsId: string, opts: { unitId?: string | null; rollUp?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.unitId) q.set('unitId', opts.unitId);
    if (opts.rollUp) q.set('rollUp', 'true');
    const qs = q.toString();
    return get<OrgTask[]>(`/api/workspaces/${wsId}/org/tasks${qs ? `?${qs}` : ''}`);
  },
  addOrgTask: (wsId: string, body: { title: string; brief?: Partial<OrgTaskBrief>; projectId?: string | null; assigneeAgentId?: string | null; unitId?: string }) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks`, 'POST', body),
  updateOrgTask: (wsId: string, taskId: string, patch: { title?: string; brief?: Partial<OrgTaskBrief>; status?: OrgTaskStatus; blockers?: string[] }) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks/${taskId}`, 'PATCH', patch),
  assignOrgTask: (wsId: string, taskId: string, agentId: string) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks/${taskId}/assign`, 'POST', { agentId }),
  commentOrgTask: (wsId: string, taskId: string, text: string) => send<OrgMessage>(`/api/workspaces/${wsId}/org/tasks/${taskId}/comment`, 'POST', { text }),
  orgTaskComments: (wsId: string, taskId: string) => get<OrgMessage[]>(`/api/workspaces/${wsId}/org/tasks/${taskId}/comments`),
  reviewOrgTask: (wsId: string, taskId: string, verdict: 'accept' | 'request_changes' | 'escalate', note?: string) => send<OrgTask>(`/api/workspaces/${wsId}/org/tasks/${taskId}/review`, 'POST', { verdict, note }),
  wakeOrgTask: (wsId: string, taskId: string, now = false) => send<{ queued?: boolean; result?: string }>(`/api/workspaces/${wsId}/org/tasks/${taskId}/wake`, 'POST', { now }),
  orgTaskRuns: (wsId: string, taskId: string) => get<OrgRun[]>(`/api/workspaces/${wsId}/org/tasks/${taskId}/runs`),
  orgRuns: (wsId: string, limit = 100) => get<OrgRun[]>(`/api/workspaces/${wsId}/org/runs?limit=${limit}`),
  orgApprovals: (wsId: string, status?: string) => get<OrgApproval[]>(`/api/workspaces/${wsId}/org/approvals${status ? `?status=${enc(status)}` : ''}`),
  decideOrgApproval: (wsId: string, approvalId: string, decision: 'approve' | 'reject' | 'revise', note?: string) =>
    send<{ approval: OrgApproval; result?: Record<string, unknown> }>(`/api/workspaces/${wsId}/org/approvals/${approvalId}/decide`, 'POST', { decision, note }),
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
  orgMeetings: (wsId: string, opts: { unitId?: string | null; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.unitId) q.set('unitId', opts.unitId);
    if (opts.status) q.set('status', opts.status);
    const qs = q.toString();
    return get<OrgMeeting[]>(`/api/workspaces/${wsId}/org/meetings${qs ? `?${qs}` : ''}`);
  },
  orgMeeting: (wsId: string, meetingId: string) => get<OrgMeeting>(`/api/workspaces/${wsId}/org/meetings/${enc(meetingId)}`),
  startOrgMeeting: (wsId: string, body: { kind: MeetingKind; unitId?: string; channelId?: string; agenda?: string; title?: string }) => send<OrgMeeting>(`/api/workspaces/${wsId}/org/meetings`, 'POST', body),
  cancelOrgMeeting: (wsId: string, meetingId: string) => send<OrgMeeting>(`/api/workspaces/${wsId}/org/meetings/${enc(meetingId)}/cancel`, 'POST'),
  orgDecisions: (wsId: string, unitId?: string | null) => get<OrgDecision[]>(`/api/workspaces/${wsId}/org/decisions${unitId ? `?unitId=${enc(unitId)}` : ''}`),
  /** The decision a `#decision:<id>` chip names (id or unique prefix). */
  chatDecision: (wsId: string, idOrPrefix: string) => get<OrgDecision>(`/api/workspaces/${wsId}/chat/decisions/${enc(idOrPrefix)}`),
  orgCadences: (wsId: string) => get<OrgCadence[]>(`/api/workspaces/${wsId}/org/cadences`),
  updateOrgCadence: (wsId: string, cadenceId: string, patch: { cron?: string; enabled?: boolean }) => send<OrgCadence>(`/api/workspaces/${wsId}/org/cadences/${enc(cadenceId)}`, 'PATCH', patch),
};

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
