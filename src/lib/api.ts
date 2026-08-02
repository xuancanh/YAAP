/**
 * Typed fetch client for the yaam-chat API. The Vite dev server proxies /api
 * to the NestJS backend (see vite.config.ts).
 */

export interface Workspace {
  id: string;
  name: string;
  color: string;
  memory: string;
  /** Consented user profile: only user-approved lines land here. */
  profile: string;
  /** JSON array of ProfileProposal awaiting review. */
  profilePending: string;
  createdAt: string;
}

export interface ProfileProposal {
  id: string;
  entry: string;
  agentName: string;
  sessionId: string;
  at: string;
}

export interface Agent {
  id: string;
  name: string;
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
  loops: string; // JSON array of { name, cron }
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
  kind: 'loop_run' | 'loop_error' | 'info' | 'action_pending' | 'action_done' | 'action_failed' | 'action_dismissed';
  title: string;
  body: string;
  payload: string;
  sessionId: string | null;
  readAt: string | null;
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
  driveCapable: boolean;
  createdAt: string;
  grants: Array<{ agentId: string; service: string; level: string }>;
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
  kind: 'markdown' | 'html' | 'image' | 'pdf' | 'text' | 'binary';
  size: number;
  contentType: string;
  text?: string;
  truncated?: boolean;
  base64?: string;
}

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

export type TurnEvent =
  | { type: 'turn'; turnId: string }
  | { type: 'answer'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean }
  | { type: 'approval_required'; callId: string; tool: string; input: Record<string, unknown> }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
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

const get = <T,>(url: string) => fetch(url, { headers: authHeaders() }).then((r) => json<T>(r));
const send = <T,>(url: string, method: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: body !== undefined ? { ...authHeaders(), 'Content-Type': 'application/json' } : authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then((r) => json<T>(r));

const enc = encodeURIComponent;

export const api = {
  status: () => get<{ ok: boolean }>('/api/status'),

  // workspaces + workspace files
  workspaces: () => get<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string, color?: string) => send<Workspace>('/api/workspaces', 'POST', { name, color }),
  updateWorkspace: (id: string, patch: Partial<Pick<Workspace, 'name' | 'color' | 'memory' | 'profile'>>) =>
    send<Workspace>(`/api/workspaces/${id}`, 'PATCH', patch),
  resolveProfileProposal: (id: string, proposalId: string, approve: boolean) =>
    send<Workspace>(`/api/workspaces/${id}/profile/${approve ? 'approve' : 'reject'}`, 'POST', { proposalId }),
  wsFiles: (id: string) => get<FileEntry[]>(`/api/workspaces/${id}/files`),
  wsPreview: (id: string, path: string) => get<FilePreview>(`/api/workspaces/${id}/preview?path=${enc(path)}`),
  wsPutFile: (id: string, path: string, contentBase64: string, contentType?: string) =>
    send<{ ok: boolean }>(`/api/workspaces/${id}/files`, 'POST', { path, contentBase64, contentType }),

  // chats
  chats: (workspaceId: string) => get<ChatSession[]>(`/api/chats?workspaceId=${enc(workspaceId)}`),
  chat: (id: string) => get<ChatSession>(`/api/chats/${id}`),
  createChat: (input: { workspaceId: string; name?: string; agentId?: string; agentTypeId?: string; cwd?: string; tokenCeiling?: number }) =>
    send<ChatSession>('/api/chats', 'POST', input),
  updateChat: (id: string, patch: Record<string, unknown>) => send<ChatSession>(`/api/chats/${id}`, 'PATCH', patch),
  deleteChat: (id: string) => send<{ ok: boolean }>(`/api/chats/${id}`, 'DELETE'),
  transcript: (id: string) => get<{ messages: ChatMessage[]; turns: ChatTurn[] }>(`/api/chats/${id}/transcript`),
  clear: (id: string) => send<{ ok: boolean }>(`/api/chats/${id}/clear`, 'POST'),
  compact: (id: string) => send<{ ok: boolean; reason?: string }>(`/api/chats/${id}/compact`, 'POST'),
  stop: (id: string) => send<{ stopped: boolean }>(`/api/chats/${id}/stop`, 'POST'),
  approve: (id: string, callId: string, decision: ApprovalDecision) =>
    send<{ resolved: boolean }>(`/api/chats/${id}/approve`, 'POST', { callId, decision }),
  fork: (id: string, turnId?: string) => send<ChatSession>(`/api/chats/${id}/fork`, 'POST', { turnId }),
  truncate: (id: string, turnId: string) => send<{ ok: boolean; input: string }>(`/api/chats/${id}/truncate`, 'POST', { turnId }),
  promote: (id: string, turnId: string) => send<{ task: string }>(`/api/chats/${id}/turns/${turnId}/promote`, 'POST'),
  rate: (id: string, turnId: string, rating: 'up' | 'down', note?: string) =>
    send<{ ok: boolean }>(`/api/chats/${id}/turns/${turnId}/rate`, 'POST', { rating, note }),
  distill: (id: string) => send<{ ok: boolean; journal?: string; lesson?: string }>(`/api/chats/${id}/distill`, 'POST'),
  exportUrl: (id: string) => `/api/chats/${id}/export`,

  // agents
  agents: () => get<Agent[]>('/api/agents'),
  createAgent: (input: { name: string; charter?: string; role?: string; emoji?: string; colors?: [string, string]; provider?: string; model?: string }) =>
    send<Agent>('/api/agents', 'POST', input),
  updateAgent: (id: string, patch: Record<string, unknown>) => send<Agent>(`/api/agents/${id}`, 'PATCH', patch),
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
  appFileRead: (id: string, appId: string, path: string, workspaceId?: string) =>
    get<{ path: string; kind: string; size: number; text?: string; base64?: string }>(
      `/api/agents/${id}/apps/${appId}/file?path=${encodeURIComponent(path)}${workspaceId ? `&workspaceId=${workspaceId}` : ''}`),
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
  agentEvents: (id: string) => get<AgentEvent[]>(`/api/agents/${id}/events`),
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
    get<FileEntry[]>(`/api/agents/${id}/files${workspaceId ? `?workspaceId=${enc(workspaceId)}` : ''}`),
  putAgentFile: (id: string, path: string, contentBase64: string, contentType?: string) =>
    send<{ ok: boolean }>(`/api/agents/${id}/files`, 'POST', { path, contentBase64, contentType }),
  agentPreview: (id: string, path: string, workspaceId?: string) =>
    get<FilePreview>(`/api/agents/${id}/preview?path=${enc(path)}${workspaceId ? `&workspaceId=${enc(workspaceId)}` : ''}`),
  agentExportUrl: (id: string) => `/api/agents/${id}/export`,
  importAgent: (profile: Record<string, unknown>) => send<Agent>('/api/agents/import', 'POST', profile),

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
  connectionTools: () => get<Array<{ name: string; description: string; service: string; level: string }>>('/api/connections/tools'),
  connectStart: (provider: string, tier: 'read' | 'write' | 'gmail' | 'drive' = 'read') => get<{ url: string }>(`/api/connections/${provider}/start?tier=${tier}`),
  removeConnection: (id: string) => send<{ ok: boolean }>(`/api/connections/${id}`, 'DELETE'),
  grantConnection: (id: string, agentId: string, service: ConnectionServiceName, level: 'read' | 'write' = 'read') =>
    send<{ ok: boolean }>(`/api/connections/${id}/grants`, 'POST', { agentId, service, level }),
  revokeConnectionGrant: (id: string, agentId: string, service?: ConnectionServiceName) =>
    send<{ ok: boolean }>(`/api/connections/${id}/grants/${agentId}${service ? `?service=${service}` : ''}`, 'DELETE'),
  mcp: () => get<McpServer[]>('/api/mcp'),
  createMcp: (name: string, url: string) => send<McpServer>('/api/mcp', 'POST', { name, url }),
  updateMcp: (id: string, patch: { enabled?: boolean }) => send<McpServer>(`/api/mcp/${id}`, 'PATCH', patch),
  discoverMcp: (id: string) => send<{ tools: Array<{ name: string; description?: string }> }>(`/api/mcp/${id}/discover`, 'POST'),
  mcpOauthStart: (id: string) => get<{ url: string }>(`/api/mcp/${id}/oauth/start`),
  marketConnectors: () => get<ConnectorEntry[]>('/api/market/connectors'),
  market: () => get<MarketItem[]>('/api/market'),
  hire: (id: string) => send<{ ok: boolean; agent: Agent }>(`/api/market/${id}/hire`, 'POST'),
  // channels (phase 4)
  telegramStatus: () => get<{ configured: boolean; paired: boolean; defaultAgentId: string }>('/api/channels/telegram/status'),
  telegramPairCode: () => send<{ code: string; expiresInSeconds: number }>('/api/channels/telegram/pair-code', 'POST'),
  telegramUnpair: () => send<{ ok: boolean }>('/api/channels/telegram/unpair', 'POST'),
  settings: () => get<Record<string, string>>('/api/settings'),
  putSettings: (patch: Record<string, string>) => send<Record<string, string>>('/api/settings', 'PUT', patch),
  search: (workspaceId: string, q: string) =>
    get<SearchResults>(`/api/search?workspaceId=${enc(workspaceId)}&q=${enc(q)}`),
};

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
