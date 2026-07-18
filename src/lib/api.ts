/**
 * Typed fetch client for the yaam-chat API. The Vite dev server proxies /api
 * to the NestJS backend (see vite.config.ts).
 */

export interface Workspace {
  id: string;
  name: string;
  color: string;
  memory: string;
  createdAt: string;
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
  dashboard: string;
  loops: string; // JSON array of { name, cron }
  apps: string; // JSON array of AgentApp
  createdAt: string;
}

/** A self-built mini app — rendered only in a network-blocked sandbox. */
export interface AgentApp {
  id: string;
  name: string;
  description: string;
  html: string;
  updatedAt: string;
}

export interface AgentStats {
  chats: number;
  up: number;
  down: number;
  rating: number | null;
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
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  enabled: number;
  tools: string;
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

const get = <T,>(url: string) => fetch(url).then((r) => json<T>(r));
const send = <T,>(url: string, method: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then((r) => json<T>(r));

const enc = encodeURIComponent;

export const api = {
  status: () => get<{ ok: boolean }>('/api/status'),

  // workspaces + workspace files
  workspaces: () => get<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string, color?: string) => send<Workspace>('/api/workspaces', 'POST', { name, color }),
  updateWorkspace: (id: string, patch: Partial<Pick<Workspace, 'name' | 'color' | 'memory'>>) =>
    send<Workspace>(`/api/workspaces/${id}`, 'PATCH', patch),
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
  agentStats: (id: string) => get<AgentStats>(`/api/agents/${id}/stats`),
  agentFiles: (id: string) => get<FileEntry[]>(`/api/agents/${id}/files`),
  agentPreview: (id: string, path: string) => get<FilePreview>(`/api/agents/${id}/preview?path=${enc(path)}`),
  agentExportUrl: (id: string) => `/api/agents/${id}/export`,
  importAgent: (profile: Record<string, unknown>) => send<Agent>('/api/agents/import', 'POST', profile),

  // agent types / providers
  agentTypes: () => get<AgentType[]>('/api/agent-types'),
  createAgentType: (input: { name: string; provider: string; model: string; apiKey?: string; baseUrl?: string; persona?: string }) =>
    send<AgentType>('/api/agent-types', 'POST', input),

  // skills / mcp / market / settings / search
  skills: (workspaceId?: string) => get<Skill[]>(`/api/skills${workspaceId ? `?workspaceId=${enc(workspaceId)}` : ''}`),
  updateSkill: (id: string, patch: { enabled?: boolean; instructions?: string; description?: string }) =>
    send<Skill>(`/api/skills/${id}`, 'PATCH', patch),
  mcp: () => get<McpServer[]>('/api/mcp'),
  createMcp: (name: string, url: string) => send<McpServer>('/api/mcp', 'POST', { name, url }),
  updateMcp: (id: string, patch: { enabled?: boolean }) => send<McpServer>(`/api/mcp/${id}`, 'PATCH', patch),
  discoverMcp: (id: string) => send<{ tools: Array<{ name: string; description?: string }> }>(`/api/mcp/${id}/discover`, 'POST'),
  market: () => get<MarketItem[]>('/api/market'),
  hire: (id: string) => send<{ ok: boolean; agent: Agent }>(`/api/market/${id}/hire`, 'POST'),
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
): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, attachments }),
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
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) onEvent(JSON.parse(line.slice(6)) as TurnEvent);
    }
  }
}
