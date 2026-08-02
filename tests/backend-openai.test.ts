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

test('user images map to data-URI image_url parts (vision, FR-2.2)', () => {
  const mapped = toOpenAiMessages(undefined, [
    { role: 'user', content: 'describe', images: [{ mediaType: 'image/jpeg', dataBase64: 'aGk=' }] },
  ]);
  const parts = (mapped[0] as { content: Array<{ type: string; image_url?: { url: string } }> }).content;
  assert.deepEqual(parts.map((p) => p.type), ['text', 'image_url']);
  assert.equal(parts[1].image_url?.url, 'data:image/jpeg;base64,aGk=');
});

function scriptedFetch(steps: Array<{ status: number; body: string } | { error: Error }>): { fn: typeof fetch; calls: number[] } {
  const calls: number[] = [];
  const fn = (async () => {
    calls.push(1);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if ('error' in step) throw step.error;
    return new Response(step.body, { status: step.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('transient 429 is retried once, then the stream succeeds (events yielded once)', async () => {
  const stream = sse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']);
  const { fn, calls } = scriptedFetch([{ status: 429, body: '{"error":"slow down"}' }, { status: 200, body: stream }]);
  const provider = new OpenAiCompatProvider(fn);
  const events = await collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(calls.length, 2);
  assert.deepEqual(events.filter((e) => e.type === 'answer'), [{ type: 'answer', text: 'ok' }]);
  assert.equal(events.at(-1)?.type, 'done');
});

test('transient 5xx is retried, then the stream succeeds', async () => {
  const stream = sse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']);
  const { fn, calls } = scriptedFetch([{ status: 503, body: '{"error":"overloaded"}' }, { status: 200, body: stream }]);
  const provider = new OpenAiCompatProvider(fn);
  const events = await collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(calls.length, 2);
  assert.equal(events.at(-1)?.type, 'done');
});

test('persistent 429 fails after the retries are exhausted', async () => {
  const { fn, calls } = scriptedFetch([{ status: 429, body: '{"error":"slow down"}' }]);
  const provider = new OpenAiCompatProvider(fn);
  await assert.rejects(
    collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })),
    /openai-compatible 429/,
  );
  assert.equal(calls.length, 3); // initial attempt + 2 retries
});

test('a 400 is permanent: no retry', async () => {
  const { fn, calls } = scriptedFetch([{ status: 400, body: '{"error":"bad request"}' }]);
  const provider = new OpenAiCompatProvider(fn);
  await assert.rejects(
    collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })),
    /openai-compatible 400/,
  );
  assert.equal(calls.length, 1);
});

test('an abort during retry backoff stops the turn promptly', async () => {
  const { fn, calls } = scriptedFetch([{ status: 429, body: '{"error":"slow down"}' }]);
  const provider = new OpenAiCompatProvider(fn);
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }], signal: controller.signal })),
    (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
  );
  assert.equal(calls.length, 1, 'no retry was issued after the abort');
  assert.ok(Date.now() - started < 1_000, 'did not linger in the backoff sleep');
});
