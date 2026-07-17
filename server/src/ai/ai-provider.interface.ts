/**
 * Provider-neutral streaming LLM interface (NFR-1).
 *
 * Every provider (Anthropic, OpenAI, DeepSeek, Kimi, Gemini, GLM, Bedrock,
 * custom endpoints — FR-9.2) adapts to this one shape so the turn loop, the
 * transcript, and the UI never see provider-specific payloads. Streaming is an
 * async generator of events; thinking and answer are separate channels
 * (FR-3.2) and tool calls surface as complete, validated requests (partial /
 * malformed tool arguments must be refused by the adapter — FR-3.4).
 */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on tool result messages so providers can correlate. */
  toolCallId?: string;
}

export interface AiToolSpec {
  name: string;
  description: string;
  /** JSON schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export type AiStreamEvent =
  | { type: 'answer'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done' };

export interface AiRequest {
  model: string;
  messages: AiMessage[];
  tools?: AiToolSpec[];
  /** off | low | medium | high — only forwarded to models that support it (FR-9.4). */
  thinkingEffort?: string;
  signal?: AbortSignal;
}

export interface AiProvider {
  readonly name: string;
  stream(req: AiRequest): AsyncGenerator<AiStreamEvent>;
}

export const AI_PROVIDER = 'AI_PROVIDER';
