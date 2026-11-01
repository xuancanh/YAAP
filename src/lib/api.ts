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
  createdAt: string;
}

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
  sourceKind: 'chat' | 'loop' | 'channel' | 'app' | 'feedback';
  sourceSessionId: string | null;
  trusted: number;
  pinned: number;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

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
  kind: 'loop_run' | 'loop_error' | 'budget_stop' | 'info' | 'action_pending' | 'action_done' | 'action_failed' | 'action_dismissed';
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

export interface SearchResults {
  sessions: Array<{ id: string; name: string; autoTitle: string }>;
  messages: Array<{ sessionId: string; messageId: string; turnId: string; role: string; snippet: string }>;
  files: Array<{ path: string; size: number }>;
}

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
  | { type: 'approval_required'; callId: string; tool: string; input: Record<string, unknown>; review?: ToolReview }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  /** The workspace's monthly spend stop is reached; the turn still runs. */
  | { type: 'budget'; month: string; spentTokens: number; budgetTokens: number }
  /** The browser tool rendered a page; show its screenshot live. */
  | ({ type: 'browser'; sessionId: string } & BrowserStep)
  | { type: 'done' }
  | { type: 'error'; message: string };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Power-user escape hatch matching YAAM_API_TOKEN on the server: set
 *  localStorage key `yaam_api_token` to attach a bearer token to every call. */
export const authHeaders = (): Record<string, string> => {
  const token = localStorage.getItem('yaam_api_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const get = <T,>(url: string, schema?: z.ZodType) =>
  fetch(url, { headers: authHeaders() })
    .then((r) => json<T>(r))
    .then((v) => (schema ? looseParse(schema, v, `GET ${url}`) : v));
const send = <T,>(url: string, method: string, body?: unknown, schema?: z.ZodType) =>
  fetch(url, {
    method,
    headers: body !== undefined ? { ...authHeaders(), 'Content-Type': 'application/json' } : authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
    .then((r) => json<T>(r))
    .then((v) => (schema ? looseParse(schema, v, `${method} ${url}`) : v));

const enc = encodeURIComponent;

export const api = {
  status: () => get<{ ok: boolean }>('/api/status'),

  // workspaces + workspace files
  workspaces: () => get<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string, color?: string) => send<Workspace>('/api/workspaces', 'POST', { name, color }),
  updateWorkspace: (id: string, patch: Partial<Pick<Workspace, 'name' | 'color' | 'memory' | 'profile' | 'quietHours' | 'spendBudgetTokens'>>) =>
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
  agents: () => get<Agent[]>('/api/agents', agentListSchema),
  createAgent: (input: { name: string; charter?: string; role?: string; emoji?: string; colors?: [string, string]; provider?: string; model?: string }) =>
    send<Agent>('/api/agents', 'POST', input, agentSchema),
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
  patchLesson: (id: string, lessonId: string, patch: { trusted?: boolean; pinned?: boolean }) =>
    send<AgentLesson>(`/api/agents/${id}/lessons/${lessonId}`, 'PATCH', patch),
  deleteLesson: (id: string, lessonId: string) =>
    send<{ ok: boolean }>(`/api/agents/${id}/lessons/${lessonId}`, 'DELETE'),
  agentEvents: (id: string) => get<AgentEvent[]>(`/api/agents/${id}/events`),
  // event triggers (docs/triggers.md): per-loop state, and the one-time webhook secret
  loopStates: (id: string) => get<LoopState[]>(`/api/agents/${id}/loops/state`),
  rotateWebhookSecret: (id: string, loopName: string) =>
    send<{ secret: string; path: string; url: string }>(`/api/agents/${id}/loops/${encodeURIComponent(loopName)}/webhook-secret`, 'POST'),
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
  agentExportUrl: (id: string) => `/api/agents/${id}/export`,
  importAgent: (profile: Record<string, unknown>) => send<Agent>('/api/agents/import', 'POST', profile, agentSchema),

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
  mcp: () => get<McpServer[]>('/api/mcp'),
  createMcp: (name: string, url: string) => send<McpServer>('/api/mcp', 'POST', { name, url }),
  updateMcp: (id: string, patch: { enabled?: boolean }) => send<McpServer>(`/api/mcp/${id}`, 'PATCH', patch),
  discoverMcp: (id: string) => send<{ tools: Array<{ name: string; description?: string }> }>(`/api/mcp/${id}/discover`, 'POST'),
  mcpOauthStart: (id: string) => get<{ url: string }>(`/api/mcp/${id}/oauth/start`),
  marketConnectors: () => get<ConnectorEntry[]>('/api/market/connectors'),
  /** Full bundled-skill text, for the hire review (docs/permissions.md). */
  marketPackSkills: (id: string) => get<Array<{ name: string; description: string; instructions: string }>>(`/api/market/${id}/skills`),
  market: () => get<MarketItem[]>('/api/market'),
  hire: (id: string) => send<{ ok: boolean; agent: Agent }>(`/api/market/${id}/hire`, 'POST', undefined, hireResultSchema),
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
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
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
