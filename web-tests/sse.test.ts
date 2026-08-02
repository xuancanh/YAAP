import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendTurn, type TurnEvent } from '../src/lib/api';

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function mockSseFetch(chunks: string[]) {
  // authHeaders() reads localStorage; no token in tests.
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    body: sseStream(chunks),
    text: async () => '',
  })));
}

async function collect(chunks: string[]): Promise<TurnEvent[]> {
  mockSseFetch(chunks);
  const events: TurnEvent[] = [];
  await sendTurn('chat-1', 'hi', [], (ev) => events.push(ev));
  return events;
}

afterEach(() => vi.unstubAllGlobals());

describe('sendTurn SSE parsing', () => {
  it('delivers one event per SSE block', async () => {
    const events = await collect([
      'data: {"type":"turn","turnId":"t1"}\n\ndata: {"type":"done"}\n\n',
    ]);
    expect(events).toEqual([
      { type: 'turn', turnId: 't1' },
      { type: 'done' },
    ]);
  });

  it('joins multi-line data: payloads with newlines (SSE spec)', async () => {
    const events = await collect([
      'data: {"type":"answer",\ndata: "text":"hello"}\n\n',
    ]);
    expect(events).toEqual([{ type: 'answer', text: 'hello' }]);
  });

  it('assembles events split across network chunks', async () => {
    const events = await collect([
      'data: {"type":"ans',
      'wer","text":"hi"}\n\nda',
      'ta: {"type":"done"}\n\n',
    ]);
    expect(events).toEqual([
      { type: 'answer', text: 'hi' },
      { type: 'done' },
    ]);
  });

  it('skips malformed events without killing the stream', async () => {
    const events = await collect([
      'data: {broken json\n\ndata: {"type":"done"}\n\n',
    ]);
    expect(events).toEqual([{ type: 'done' }]);
  });

  it('throws on a non-OK response', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      body: null,
      text: async () => 'boom',
    })));
    await expect(sendTurn('chat-1', 'hi', [], () => {})).rejects.toThrow('500 boom');
  });
});
