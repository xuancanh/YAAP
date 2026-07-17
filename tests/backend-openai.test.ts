/** OpenAI-compatible adapter: SSE parsing, tool-call accumulation, history
 *  mapping, reasoning channel, and the malformed-arguments refusal. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatProvider, toOpenAiMessages, OPENAI_COMPAT_BASE_URLS } from '../server/src/ai/openai-ai.provider';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

function sse(chunks: Array<Record<string, unknown> | string>): string {
  return chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
}

function fakeFetch(body: string, status = 200): { fn: typeof fetch; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function collect(gen: AsyncGenerator<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const out: AiStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test('parses content, reasoning, streamed tool calls and usage', async () => {
  const stream = sse([
    { choices: [{ delta: { reasoning_content: 'hm ' } }] },
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fs_read', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.md"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 11 } },
    '[DONE]',
  ]);
  const { fn, calls } = fakeFetch(stream);
  const provider = new OpenAiCompatProvider(fn);
  const events = await collect(provider.stream({
    model: 'gpt-5', system: 'be nice',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'fs_read', description: 'read', inputSchema: { type: 'object' } }],
    apiKey: 'sk-x', baseUrl: OPENAI_COMPAT_BASE_URLS.deepseek,
  }));

  assert.ok(events.some((e) => e.type === 'thinking' && e.text === 'hm '));
  const answer = events.filter((e) => e.type === 'answer').map((e) => (e as { text: string }).text).join('');
  assert.equal(answer, 'Hello');
  assert.deepEqual(events.find((e) => e.type === 'tool_call'), { type: 'tool_call', id: 'call_1', name: 'fs_read', input: { path: 'a.md' } });
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 20, outputTokens: 11 });
  assert.equal(events.at(-1)?.type, 'done');

  // request shape
  assert.match(calls[0].url, /api\.deepseek\.com\/v1\/chat\/completions$/);
  const body = calls[0].body;
  assert.equal((body.messages as Array<{ role: string }>)[0].role, 'system');
  assert.equal((body.tools as Array<{ type: string }>)[0].type, 'function');
});

test('malformed streamed tool arguments are refused (FR-3.4)', async () => {
  const stream = sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'fs_write', arguments: '{"path": bro' } }] } }] },
    '[DONE]',
  ]);
  const provider = new OpenAiCompatProvider(fakeFetch(stream).fn);
  await assert.rejects(
    collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })),
    /malformed tool arguments/,
  );
});

test('non-2xx responses throw with the API error text', async () => {
  const provider = new OpenAiCompatProvider(fakeFetch('{"error":"bad key"}', 401).fn);
  await assert.rejects(
    collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })),
    /openai-compatible 401/,
  );
});

test('history mapping: system folding, assistant tool_calls, tool results', () => {
  const mapped = toOpenAiMessages('persona', [
    { role: 'system', content: 'summary' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'on it', toolCalls: [{ id: 'c1', name: 'fs_list', input: {} }] },
    { role: 'tool', content: 'files…', toolCallId: 'c1' },
    { role: 'assistant', content: 'done' },
  ]);
  assert.equal(mapped[0].role, 'system');
  assert.match((mapped[0] as { content: string }).content, /persona[\s\S]*summary/);
  const assistant = mapped[2] as { role: string; tool_calls?: Array<{ id: string; function: { name: string } }> };
  assert.equal(assistant.tool_calls?.[0].id, 'c1');
  assert.equal(assistant.tool_calls?.[0].function.name, 'fs_list');
  const toolMsg = mapped[3] as { role: string; tool_call_id: string };
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'c1');
});
