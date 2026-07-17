/**
 * Thin typed fetch client for the yaam-chat API. The Vite dev server proxies
 * /api to the NestJS backend (see vite.config.ts).
 */
export interface Workspace {
  id: string;
  name: string;
  color: string;
  memory: string;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  workspaceId: string;
  agentId: string | null;
  agentTypeId: string | null;
  name: string;
  autoTitle: string;
  model: string;
  permissionMode: 'ask' | 'auto';
  thinkingEffort: string;
  pinned: number;
  tags: string;
  draft: string;
  tokenCeiling: number;
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

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  status: () => fetch('/api/status').then((r) => json<{ ok: boolean }>(r)),
  workspaces: () => fetch('/api/workspaces').then((r) => json<Workspace[]>(r)),
  chats: (workspaceId: string) =>
    fetch(`/api/chats?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => json<ChatSession[]>(r)),
  createChat: (workspaceId: string, name?: string) =>
    fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, name }),
    }).then((r) => json<ChatSession>(r)),
  transcript: (chatId: string) =>
    fetch(`/api/chats/${chatId}/transcript`).then((r) =>
      json<{ messages: ChatMessage[]; turns: unknown[] }>(r)),
  stop: (chatId: string) => fetch(`/api/chats/${chatId}/stop`, { method: 'POST' }),
  approve: (chatId: string, callId: string, decision: ApprovalDecision) =>
    fetch(`/api/chats/${chatId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId, decision }),
    }).then((r) => json<{ resolved: boolean }>(r)),
  compact: (chatId: string) =>
    fetch(`/api/chats/${chatId}/compact`, { method: 'POST' }).then((r) =>
      json<{ ok: boolean; reason?: string }>(r)),
  skills: (workspaceId?: string) =>
    fetch(`/api/skills${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`)
      .then((r) => json<Skill[]>(r)),
  search: (workspaceId: string, q: string) =>
    fetch(`/api/search?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(q)}`)
      .then((r) => json<SearchResults>(r)),
  preview: (workspaceId: string, path: string) =>
    fetch(`/api/workspaces/${workspaceId}/preview?path=${encodeURIComponent(path)}`)
      .then((r) => json<FilePreview>(r)),
};

export interface Skill {
  id: string;
  workspaceId: string | null;
  name: string;
  description: string;
  instructions: string;
  enabled: number;
  builtin: number;
}

export interface SearchResults {
  sessions: Array<{ id: string; name: string; autoTitle: string }>;
  messages: Array<{ sessionId: string; messageId: string; turnId: string; role: string; snippet: string }>;
  files: Array<{ path: string; size: number }>;
}

/** Rich preview descriptor. `html` kind must be rendered inside a sandboxed,
 *  network-denied iframe (FR-13.1). */
export interface FilePreview {
  path: string;
  kind: 'markdown' | 'html' | 'image' | 'pdf' | 'text' | 'binary';
  size: number;
  contentType: string;
  text?: string;
  truncated?: boolean;
  base64?: string;
}

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

/** Send a message and consume the SSE turn stream. */
export async function sendTurn(
  chatId: string,
  text: string,
  onEvent: (ev: TurnEvent) => void,
): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
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
