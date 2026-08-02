/**
 * AnthropicAiProvider — streaming adapter for the Anthropic Messages API
 * (and Anthropic-compatible endpoints via baseUrl).
 *
 * Implemented directly over fetch + SSE so the server has no SDK dependency
 * and the fetch function can be injected for tests. Answer and thinking
 * stream as separate channels (FR-3.2). Tool-use input JSON is accumulated
 * across input_json_delta events and parsed at content_block_stop; if it does
 * not parse, the adapter throws — a truncated/malformed tool call must be
 * refused, never executed (FR-3.4).
 *
 * Extended thinking is only requested when no tools are offered: with tools,
 * Anthropic requires signed thinking blocks to be replayed in history, which
 * this scaffold does not carry yet (follow-up work).
 */
import { Injectable } from '@nestjs/common';
import { AiMessage, AiProvider, AiRequest, AiStreamEvent } from './ai-provider.interface';
import { streamSignal } from './provider-timeout';
import { fetchWithRetry } from './provider-retry';

const EFFORT_BUDGET: Record<string, number> = { low: 2048, medium: 8192, high: 16384 };

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

/** Map neutral history to Anthropic messages. System rows are folded into the
 *  system prompt by the caller; consecutive tool results merge into one user
 *  message (API requirement). Exported for tests. */
export function toAnthropicMessages(messages: AiMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (m.images?.length) {
        const content: AnthropicContentBlock[] = m.images.map((img) => ({
          type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.dataBase64 },
        }));
        if (m.content) content.push({ type: 'text', text: m.content });
        out.push({ role: 'user', content });
      } else {
        out.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      if (content.length > 0) out.push({ role: 'assistant', content });
    } else {
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      const last = out.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}

@Injectable()
export class AnthropicAiProvider implements AiProvider {
  readonly name = 'anthropic';

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    const base = (req.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    const system = [req.system ?? '', ...req.messages.filter((m) => m.role === 'system').map((m) => m.content)]
      .filter(Boolean).join('\n\n');

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      stream: true,
      messages: toAnthropicMessages(req.messages),
    };
    if (system) body.system = system;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    }
    const budget = EFFORT_BUDGET[req.thinkingEffort ?? ''];
    if (budget && !req.tools?.length) {
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.max_tokens = Math.max(req.maxTokens ?? 8192, budget + 4096);
    }

    const signal = streamSignal(req.signal);
    // Retried pre-first-event only: on transient 429/5xx/network failures the
    // request is re-issued (fetchWithRetry); once events stream, no retry.
    const res = await fetchWithRetry(this.fetchFn, `${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': req.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    }, signal);
    if (!res.ok || !res.body) {
      throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    let inputTokens = 0;
    let outputTokens = 0;
    // Per-index accumulator for streamed tool_use input JSON.
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const data of sseData(res.body, signal)) {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'message_start': {
          const usage = (ev.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
          inputTokens = usage?.input_tokens ?? 0;
          break;
        }
        case 'content_block_start': {
          const block = ev.content_block as { type: string; id?: string; name?: string };
          if (block?.type === 'tool_use') {
            toolBlocks.set(ev.index as number, { id: block.id ?? '', name: block.name ?? '', json: '' });
          }
          break;
        }
        case 'content_block_delta': {
          const delta = ev.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
          if (delta.type === 'text_delta' && delta.text) yield { type: 'answer', text: delta.text };
          else if (delta.type === 'thinking_delta' && delta.thinking) yield { type: 'thinking', text: delta.thinking };
          else if (delta.type === 'input_json_delta') {
            const acc = toolBlocks.get(ev.index as number);
            if (acc) acc.json += delta.partial_json ?? '';
          }
          break;
        }
        case 'content_block_stop': {
          const acc = toolBlocks.get(ev.index as number);
          if (acc) {
            toolBlocks.delete(ev.index as number);
            let input: Record<string, unknown>;
            try {
              input = acc.json.trim() === '' ? {} : (JSON.parse(acc.json) as Record<string, unknown>);
            } catch {
              throw new Error(`malformed tool arguments for ${acc.name}; call refused`);
            }
            yield { type: 'tool_call', id: acc.id, name: acc.name, input };
          }
          break;
        }
        case 'message_delta': {
          const usage = (ev.usage as { output_tokens?: number } | undefined);
          if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
          break;
        }
        case 'error': {
          const err = ev.error as { message?: string } | undefined;
          throw new Error(`anthropic stream error: ${err?.message ?? 'unknown'}`);
        }
      }
    }
    if (toolBlocks.size > 0) {
      throw new Error('stream ended with an unterminated tool call; call refused');
    }
    yield { type: 'usage', inputTokens, outputTokens };
    yield { type: 'done' };
  }
}

/** Yield the `data:` payload of each SSE event in the stream. */
async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const data = chunk.split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
