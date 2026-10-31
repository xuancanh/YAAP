/** Voice notes (docs/voice.md): transcription request shape and key
 *  resolution through the fetch seam, timeout → graceful fallback, upload
 *  bounds, the transcript sidecar, off mode, and loadAttachments feeding the
 *  model transcript text instead of audio bytes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import {
  TranscriptionService, isAudioUpload, transcriptPathFor, MAX_AUDIO_BYTES,
} from '../server/src/voice/transcription.service';
import { AgentTypesService } from '../server/src/agent-types/agent-types.service';
import { previewKindFor, contentTypeFor } from '../server/src/storage/preview.util';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { testDb, memStorage, ctxStub, skillsStub, agentsStub, mcpStub, ScriptedProvider, wsStub } from './helpers';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

const configStub = (over: Record<string, string> = {}): ConfigService =>
  ({ get: (key: string) => over[key] }) as unknown as ConfigService;

const noKeyTypes = { resolveKeyForProvider: async () => null } as unknown as AgentTypesService;

interface Captured { url: string; headers: Record<string, string>; body: FormData | string; signal?: AbortSignal }

/** fetch double that records the request and replies with the given JSON. */
function fakeFetch(reply: unknown, status = 200): { fn: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as FormData | string,
      signal: init?.signal ?? undefined,
    });
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const audioBytes = Buffer.from('fake-webm-bytes-\u0000\u0001\u0002', 'utf8');

test('transcribe: OpenAI-compatible multipart request with the env key; transcript + duration returned', async () => {
  const { fn, calls } = fakeFetch({ text: '  hello from the mic ', duration: 41.6 });
  const svc = new TranscriptionService(
    configStub({ transcriptionApiKey: 'sk-env', transcriptionBaseUrl: 'https://gateway.example/v1/', transcriptionModel: 'whisper-1' }),
    noKeyTypes, undefined, fn,
  );
  const out = await svc.transcribe(audioBytes, 'uploads/note.webm', 'audio/webm;codecs=opus', 40);

  assert.deepEqual(out, { transcript: 'hello from the mic', durationHint: 42 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gateway.example/v1/audio/transcriptions');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-env');
  const form = calls[0].body as FormData;
  assert.ok(form instanceof FormData, 'multipart body');
  assert.equal(form.get('model'), 'whisper-1');
  const file = form.get('file') as File;
  assert.equal(file.name, 'note.webm');
  assert.equal(file.type, 'audio/webm');
  assert.equal(file.size, audioBytes.length);
  assert.ok(calls[0].signal instanceof AbortSignal, 'timeout signal attached');
});

test('key resolution: without TRANSCRIPTION_API_KEY the OpenAI agent type\'s sealed key is opened and used', async () => {
  process.env.TOKEN_ENCRYPTION_KEY = 'voice-test-key';
  try {
    const types = new AgentTypesService(await testDb());
    await types.create({ name: 'Claude', provider: 'anthropic', model: 'claude', apiKey: 'sk-ant-not-this' });
    await types.create({ name: 'GPT', provider: 'openai', model: 'gpt-5', apiKey: 'sk-openai-stored' });
    const { fn, calls } = fakeFetch({ text: 'ok' });
    const svc = new TranscriptionService(configStub({ transcriptionModel: 'gpt-4o-mini-transcribe' }), types, undefined, fn);

    assert.equal(await svc.resolveApiKey(), 'sk-openai-stored');
    const out = await svc.transcribe(audioBytes, 'a.webm', 'audio/webm');
    assert.equal(out.transcript, 'ok');
    assert.equal(calls[0].headers.Authorization, 'Bearer sk-openai-stored');
    // default base + default model
    assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal((calls[0].body as FormData).get('model'), 'gpt-4o-mini-transcribe');
    assert.deepEqual(await svc.status(), { transcription: true, tts: true, model: 'gpt-4o-mini-transcribe' });
  } finally {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  }
});

test('no key anywhere: transcription is skipped without calling the provider; status reports unavailable', async () => {
  const { fn, calls } = fakeFetch({ text: 'never' });
  const svc = new TranscriptionService(configStub(), noKeyTypes, undefined, fn);
  const out = await svc.transcribe(audioBytes, 'a.webm', 'audio/webm', 7);
  assert.deepEqual(out, { transcript: null, durationHint: 7 });
  assert.equal(calls.length, 0);
  assert.equal((await svc.status()).transcription, false);
});

test('off mode: TRANSCRIPTION_PROVIDER=off never calls out, for transcription or TTS', async () => {
  const { fn, calls } = fakeFetch({ text: 'never' });
  const svc = new TranscriptionService(configStub({ transcriptionProvider: 'off', transcriptionApiKey: 'sk-x' }), noKeyTypes, undefined, fn);
  assert.equal(svc.enabled(), false);
  assert.deepEqual(await svc.transcribe(audioBytes, 'a.webm', 'audio/webm'), { transcript: null, durationHint: null });
  assert.equal(await svc.speak('hello'), null);
  assert.equal(calls.length, 0);
});

test('timeout: a hung provider is aborted and the note still uploads with a null transcript', async () => {
  let aborted = false;
  const hung = ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
  })) as unknown as typeof fetch;
  const { stub, map } = memStorage();
  const svc = new TranscriptionService(configStub({ transcriptionApiKey: 'sk-x' }), noKeyTypes, stub, hung, 30);
  const started = Date.now();
  const out = await svc.transcribeUpload('workspaces/ws1/uploads/slow.webm', 'uploads/slow.webm', audioBytes, 'audio/webm', 12);
  assert.ok(aborted, 'request aborted on timeout');
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(out, { transcript: null, durationHint: 12 });
  assert.equal(map.has('workspaces/ws1/uploads/slow.webm.transcript.txt'), false, 'no sidecar for a failed transcription');
});

test('upstream error (HTTP 500) and malformed JSON both degrade to null, never throw', async () => {
  const err = fakeFetch({ error: 'boom' }, 500);
  const svc1 = new TranscriptionService(configStub({ transcriptionApiKey: 'sk-x' }), noKeyTypes, undefined, err.fn);
  assert.equal((await svc1.transcribe(audioBytes, 'a.mp3', 'audio/mpeg')).transcript, null);
  const junk = fakeFetch('not json');
  const svc2 = new TranscriptionService(configStub({ transcriptionApiKey: 'sk-x' }), noKeyTypes, undefined, junk.fn);
  assert.equal((await svc2.transcribe(audioBytes, 'a.mp3', 'audio/mpeg')).transcript, null);
});

test('audio upload stores the transcript sidecar beside the file; parseTranscript reads it back', async () => {
  const { fn } = fakeFetch({ text: 'buy milk and call mum' });
  const { stub, map } = memStorage();
  const svc = new TranscriptionService(configStub({ transcriptionApiKey: 'sk-x' }), noKeyTypes, stub, fn);
  const key = 'agents/ag1/uploads/voice-note.m4a';
  const out = await svc.transcribeUpload(key, 'uploads/voice-note.m4a', audioBytes, 'audio/mp4', 9);

  assert.deepEqual(out, { transcript: 'buy milk and call mum', durationHint: 9 });
  assert.equal(transcriptPathFor(key), `${key}.transcript.txt`);
  const sidecar = map.get(`${key}.transcript.txt`);
  assert.ok(sidecar, 'sidecar written');
  assert.equal(sidecar.toString('utf8'), '# duration: 9s\nbuy milk and call mum\n');
  assert.deepEqual(TranscriptionService.parseTranscript(sidecar), { transcript: 'buy milk and call mum', durationHint: 9 });
  assert.deepEqual(TranscriptionService.parseTranscript(Buffer.from('plain text\n')), { transcript: 'plain text', durationHint: null });
});

test('bounds: audio detection by extension or type; >25MB, empty, and non-audio types are refused', () => {
  const svc = new TranscriptionService(configStub(), noKeyTypes);
  assert.equal(isAudioUpload('uploads/note.webm'), true);
  assert.equal(isAudioUpload('uploads/clip.bin', 'audio/mpeg'), true);
  assert.equal(isAudioUpload('uploads/clip.bin', 'audio/wav; rate=16000'), true);
  assert.equal(isAudioUpload('uploads/report.pdf', 'application/pdf'), false);
  assert.equal(isAudioUpload('uploads/photo.png'), false);
  for (const ct of ['audio/webm', 'audio/mp4', 'audio/m4a', 'audio/mpeg', 'audio/wav', 'audio/ogg']) {
    assert.doesNotThrow(() => svc.assertAudioBounds('x.bin', audioBytes, ct), ct);
  }
  assert.doesNotThrow(() => svc.assertAudioBounds('x.webm', audioBytes));
  assert.throws(() => svc.assertAudioBounds('x.webm', Buffer.alloc(MAX_AUDIO_BYTES + 1), 'audio/webm'), BadRequestException);
  assert.throws(() => svc.assertAudioBounds('x.webm', Buffer.alloc(0), 'audio/webm'), BadRequestException);
  assert.throws(() => svc.assertAudioBounds('x.webm', audioBytes, 'video/webm'), BadRequestException);
  assert.throws(() => svc.assertAudioBounds('x.webm', audioBytes, 'text/html'), BadRequestException);
  assert.throws(() => svc.assertAudioBounds('x.bin', audioBytes), BadRequestException, 'no type and no audio extension');
  // preview classification follows
  assert.equal(previewKindFor('uploads/note.webm'), 'audio');
  assert.equal(previewKindFor('uploads/note.m4a'), 'audio');
  assert.equal(contentTypeFor('uploads/note.mp3'), 'audio/mpeg');
  assert.equal(previewKindFor('uploads/note.webm.transcript.txt'), 'text');
});

test('tts: /audio/speech request shape, text bounded to 4096 chars, voice passed through', async () => {
  const { fn, calls } = fakeFetch('mp3-bytes');
  const svc = new TranscriptionService(configStub({ transcriptionApiKey: 'sk-x', transcriptionBaseUrl: 'https://api.openai.com/v1', ttsModel: 'gpt-4o-mini-tts' }), noKeyTypes, undefined, fn);
  const res = await svc.speak('a'.repeat(5000), 'nova');
  assert.ok(res && res.ok);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-x');
  const body = JSON.parse(calls[0].body as string) as Record<string, unknown>;
  assert.equal(body.model, 'gpt-4o-mini-tts');
  assert.equal(body.voice, 'nova');
  assert.equal((body.input as string).length, 4096);
  assert.equal(body.response_format, 'mp3');
  assert.equal(await svc.speak('   '), null, 'empty text is not sent');
});

// ---- loadAttachments: the model sees transcript text, never audio bytes ----

const finalRound: AiStreamEvent[] = [
  { type: 'answer', text: 'Got it.' },
  { type: 'usage', inputTokens: 5, outputTokens: 2 },
  { type: 'done' },
];

async function turnSetup() {
  const repo = new ChatsRepository(await testDb());
  const chats = new ChatsService(repo, agentsStub());
  const { stub, map } = memStorage();
  const provider = new ScriptedProvider([finalRound]);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agentsStub(), wsStub());
  return { chats, turns, provider, map };
}

async function drain(gen: AsyncGenerator<TurnEvent>): Promise<void> {
  let ev = await gen.next();
  while (!ev.done) ev = await gen.next();
}

test('loadAttachments: an audio attachment with a sidecar renders the transcript, not the bytes', async () => {
  const { chats, turns, provider, map } = await turnSetup();
  const s = await chats.create({ workspaceId: 'ws1' });
  map.set('workspaces/ws1/uploads/note.webm', Buffer.from('RIFF-ish binary \u0000\u0001 SECRET-BYTES'));
  map.set('workspaces/ws1/uploads/note.webm.transcript.txt', Buffer.from('# duration: 42s\nremind me to send the invoice tomorrow\n'));

  await drain(turns.run(s.id, { text: 'Voice note.', attachments: [{ path: 'uploads/note.webm', kind: 'audio', durationSeconds: 42 }] }));

  const user = provider.requests[0].messages.filter((m) => m.role === 'user').at(-1)!;
  assert.match(user.content, /<attached-file path="uploads\/note\.webm">\n\[Voice note transcript\]: remind me to send the invoice tomorrow\n<\/attached-file>/);
  assert.ok(!user.content.includes('SECRET-BYTES'), 'raw audio bytes never reach the model');
  assert.ok(!user.content.includes('# duration'), 'sidecar header stripped');
  assert.equal(user.images?.length ?? 0, 0);
});

test('loadAttachments: audio without a sidecar tells the model transcription is unavailable', async () => {
  const { chats, turns, provider, map } = await turnSetup();
  const s = await chats.create({ workspaceId: 'ws1' });
  map.set('workspaces/ws1/uploads/quiet.mp3', Buffer.from('ID3\u0000\u0000bytes'));

  await drain(turns.run(s.id, { text: 'Voice note.', attachments: [{ path: 'uploads/quiet.mp3' }, { path: 'uploads/missing.wav' }] }));

  const user = provider.requests[0].messages.filter((m) => m.role === 'user').at(-1)!;
  assert.match(user.content, /\[Voice note\]: audio attached, transcription unavailable\./);
  assert.ok(!user.content.includes('missing.wav'), 'a missing file is skipped, not described');
  assert.ok(!user.content.includes('ID3'));
});
