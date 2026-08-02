/** Anthropic adapter: SSE parsing, tool-use JSON accumulation, history
 *  mapping, and the malformed-arguments refusal (FR-3.4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAiProvider, toAnthropicMessages } from '../server/src/ai/anthropic-ai.provider';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })) as unknown as typeof fetch;
}

async function collect(gen: AsyncGenerator<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const out: AiStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test('parses text, thinking, tool_use and usage from the SSE stream', async () => {
  const stream = sse([
    { type: 'message_start', message: { usage: { input_tokens: 12 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'fs_read' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'th":"a.md"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: {}, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ]);
  const provider = new AnthropicAiProvider(fakeFetch(stream));
  const events = await collect(provider.stream({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }));

  const answer = events.filter((e) => e.type === 'answer').map((e) => (e as { text: string }).text).join('');
  assert.equal(answer, 'Hello');
  assert.ok(events.some((e) => e.type === 'thinking' && e.text === 'pondering'));
  const call = events.find((e) => e.type === 'tool_call');
  assert.deepEqual(call, { type: 'tool_call', id: 'tu_1', name: 'fs_read', input: { path: 'a.md' } });
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 12, outputTokens: 9 });
  assert.equal(events.at(-1)?.type, 'done');
});

test('malformed tool arguments are refused, not executed (FR-3.4)', async () => {
  const stream = sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'fs_write' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path": "a.md", "conte' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]);
  const provider = new AnthropicAiProvider(fakeFetch(stream));
  await assert.rejects(
    collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })),
    /malformed tool arguments/,
  );
});

test('non-2xx responses throw with the API error text', async () => {
  const provider = new AnthropicAiProvider(fakeFetch('{"error":{"message":"invalid api key"}}', 401));
  await assert.rejects(
    collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })),
    /anthropic 401/,
  );
});

test('history mapping: tool calls and merged tool results', () => {
  const mapped = toAnthropicMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do two things' },
    {
      role: 'assistant', content: 'working on it',
      toolCalls: [
        { id: 'a', name: 'fs_read', input: { path: '1' } },
        { id: 'b', name: 'fs_read', input: { path: '2' } },
      ],
    },
    { role: 'tool', content: 'one', toolCallId: 'a' },
    { role: 'tool', content: 'boom', toolCallId: 'b', isError: true },
    { role: 'assistant', content: 'done' },
  ]);

  assert.equal(mapped.length, 4); // system dropped; two tool results merged
  const assistant = mapped[1];
  assert.equal(assistant.role, 'assistant');
  const blocks = assistant.content as Array<{ type: string }>;
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'tool_use', 'tool_use']);
  const results = mapped[2];
  assert.equal(results.role, 'user');
  const resultBlocks = results.content as Array<{ type: string; tool_use_id: string; is_error?: boolean }>;
  assert.deepEqual(resultBlocks.map((b) => b.tool_use_id), ['a', 'b']);
  assert.equal(resultBlocks[1].is_error, true);
});

test('user images map to base64 image blocks (vision, FR-2.2)', () => {
  const mapped = toAnthropicMessages([
    { role: 'user', content: 'what is this?', images: [{ mediaType: 'image/png', dataBase64: 'aGk=' }] },
  ]);
  const blocks = mapped[0].content as Array<{ type: string; source?: { media_type: string; data: string } }>;
  assert.deepEqual(blocks.map((b) => b.type), ['image', 'text']);
  assert.equal(blocks[0].source?.media_type, 'image/png');
  assert.equal(blocks[0].source?.data, 'aGk=');
});

function scriptedFetch(steps: Array<{ status: number; body: string } | { error: Error }>): { fn: typeof fetch; calls: number[] } {
  const calls: number[] = [];
  const fn = (async () => {
    calls.push(1);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if ('error' in step) throw step.error;
    return new Response(step.body, { status: step.status, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('transient 429 is retried once, then the stream succeeds (events yielded once)', async () => {
  const stream = sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]);
  const { fn, calls } = scriptedFetch([{ status: 429, body: '{"error":{"message":"slow down"}}' }, { status: 200, body: stream }]);
  const provider = new AnthropicAiProvider(fn);
  const events = await collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(calls.length, 2);
  assert.deepEqual(events.filter((e) => e.type === 'answer'), [{ type: 'answer', text: 'ok' }]);
  assert.equal(events.at(-1)?.type, 'done');
});

test('transient network drop is retried, then the stream succeeds', async () => {
  const stream = sse([
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'message_stop' },
  ]);
  const { fn, calls } = scriptedFetch([{ error: new TypeError('fetch failed') }, { status: 200, body: stream }]);
  const provider = new AnthropicAiProvider(fn);
  const events = await collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(calls.length, 2);
  assert.equal(events.at(-1)?.type, 'done');
});

test('persistent 429 fails after the retries are exhausted', async () => {
  const { fn, calls } = scriptedFetch([{ status: 429, body: '{"error":{"message":"slow down"}}' }]);
  const provider = new AnthropicAiProvider(fn);
  await assert.rejects(
    collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })),
    /anthropic 429/,
  );
  assert.equal(calls.length, 3); // initial attempt + 2 retries
});

test('a 400 is permanent: no retry', async () => {
  const { fn, calls } = scriptedFetch([{ status: 400, body: '{"error":{"message":"bad request"}}' }]);
  const provider = new AnthropicAiProvider(fn);
  await assert.rejects(
    collect(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })),
    /anthropic 400/,
  );
  assert.equal(calls.length, 1);
});

test('an abort during retry backoff stops the turn promptly', async () => {
  const { fn, calls } = scriptedFetch([{ status: 429, body: '{"error":{"message":"slow down"}}' }]);
  const provider = new AnthropicAiProvider(fn);
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
