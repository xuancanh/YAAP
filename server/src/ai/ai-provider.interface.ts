/**
 * Provider-neutral streaming LLM interface (NFR-1).
 *
 * Every provider (Anthropic, OpenAI, DeepSeek, Kimi, Gemini, GLM, Bedrock,
 * custom endpoints — FR-9.2) adapts to this one shape so the turn loop, the
 * transcript, and the UI never see provider-specific payloads. Streaming is an
 * async generator of events; thinking and answer are separate channels
 * (FR-3.2) and tool calls surface only as complete, parsed requests —
 * adapters must throw on truncated / malformed tool arguments so they are
 * refused rather than executed (FR-3.4).
 */
export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AiImagePart {
  mediaType: string;
  dataBase64: string;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Image inputs on user messages (vision, FR-2.2), or on a tool result
   *  that returned an image (computer_screenshot). */
  images?: AiImagePart[];
  /** Tool calls made by an assistant message (in-turn history). */
  toolCalls?: AiToolCall[];
  /** Set on tool result messages so providers can correlate. */
  toolCallId?: string;
  /** Tool result messages: the execution failed or was denied. */
  isError?: boolean;
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
  /** System prompt (persona + workspace memory + agent charter, FR-3.6/§12). */
  system?: string;
  messages: AiMessage[];
  tools?: AiToolSpec[];
  /** off | low | medium | high — only forwarded to models that support it (FR-9.4). */
  thinkingEffort?: string;
  maxTokens?: number;
  /** Resolved at request time from the chat's agent type; never persisted
   *  into transcripts (FR-13.3). */
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface AiProvider {
  readonly name: string;
  stream(req: AiRequest): AsyncGenerator<AiStreamEvent>;
}
