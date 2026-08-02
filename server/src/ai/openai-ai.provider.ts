/**
 * OpenAiCompatProvider — streaming adapter for the OpenAI chat/completions
 * API shape, which OpenAI, DeepSeek, Kimi (Moonshot), GLM (Zhipu), and most
 * custom gateways all speak. Implemented over fetch + SSE with an injectable
 * fetch for tests, like the Anthropic adapter.
 *
 * Streaming tool-call arguments accumulate across delta chunks and are parsed
 * once the stream finishes; unparseable arguments throw so the call is
 * refused, never executed (FR-3.4). DeepSeek-style `reasoning_content`
 * deltas map to the thinking channel (FR-3.2).
 */
import { Injectable } from '@nestjs/common';
import { AiMessage, AiProvider, AiRequest, AiStreamEvent } from './ai-provider.interface';
import { streamSignal } from './provider-timeout';
import { fetchWithRetry } from './provider-retry';

/** Default endpoints per provider name; an agent type's baseUrl overrides. */
export const OPENAI_COMPAT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  kimi: 'https://api.moonshot.ai/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  custom: '',
};

interface OaiToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

type OaiUserPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OaiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OaiUserPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Map neutral history to OpenAI messages. Exported for tests. */
export function toOpenAiMessages(system: string | undefined, messages: AiMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [];
  const sys = [system ?? '', ...messages.filter((m) => m.role === 'system').map((m) => m.content)].filter(Boolean).join('\n\n');
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (m.images?.length) {
        const parts: OaiUserPart[] = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` } });
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant') {
      const calls = (m.toolCalls ?? []).map((c) => ({
        id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) },
      }));
      if (m.content || calls.length > 0) {
        out.push({ role: 'assistant', content: m.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
      }
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
    }
  }
  return out;
}

@Injectable()
export class OpenAiCompatProvider implements AiProvider {
  readonly name = 'openai-compatible';

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    const base = (req.baseUrl || OPENAI_COMPAT_BASE_URLS.openai).replace(/\/+$/, '');
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAiMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    // Reasoning effort maps only for models/gateways that accept it; harmless
    // extras are rejected loudly by strict providers, so send only when set.
    if (req.thinkingEffort && req.thinkingEffort !== 'off') body.reasoning_effort = req.thinkingEffort;

    const signal = streamSignal(req.signal);
    // Retried pre-first-event only: on transient 429/5xx/network failures the
    // request is re-issued (fetchWithRetry); once events stream, no retry.
    const res = await fetchWithRetry(this.fetchFn, `${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey ?? ''}`,
      },
      body: JSON.stringify(body),
      signal,
    }, signal);
    if (!res.ok || !res.body) {
      throw new Error(`openai-compatible ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    let inputTokens = 0;
    let outputTokens = 0;
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        if (signal.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const data = line.startsWith('data:') ? line.slice(5).trim() : '';
          if (!data || data === '[DONE]') continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          const usage = ev.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
          if (usage) {
            inputTokens = usage.prompt_tokens ?? inputTokens;
            outputTokens = usage.completion_tokens ?? outputTokens;
          }
          const choice = (ev.choices as Array<{ delta?: Record<string, unknown> }> | undefined)?.[0];
          const delta = choice?.delta;
          if (!delta) continue;
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            yield { type: 'thinking', text: delta.reasoning_content };
          }
          if (typeof delta.content === 'string' && delta.content) {
            yield { type: 'answer', text: delta.content };
          }
          for (const tc of (delta.tool_calls as OaiToolCallDelta[] | undefined) ?? []) {
            const acc = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolCalls.set(tc.index, acc);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    for (const [, acc] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
      let input: Record<string, unknown>;
      try {
        input = acc.args.trim() === '' ? {} : (JSON.parse(acc.args) as Record<string, unknown>);
      } catch {
        throw new Error(`malformed tool arguments for ${acc.name}; call refused`);
      }
      yield { type: 'tool_call', id: acc.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: acc.name, input };
    }
    yield { type: 'usage', inputTokens, outputTokens };
    yield { type: 'done' };
  }
}
