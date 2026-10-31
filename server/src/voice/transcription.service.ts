/**
 * TranscriptionService — voice notes (docs/voice.md). Audio attachments are
 * transcribed on upload through an OpenAI-compatible
 * `POST {baseUrl}/audio/transcriptions` endpoint and the transcript is stored
 * as a `<file>.transcript.txt` sidecar next to the audio, so the turn loop
 * feeds the model text and never raw bytes. The same provider serves
 * optional text-to-speech (`/audio/speech`) for replies.
 *
 * Keys never leave the server: TRANSCRIPTION_API_KEY wins, else the key of
 * the first OpenAI agent type (sealed at rest, opened here at request time).
 * Every failure mode — provider off, no key, timeout, upstream error — is
 * graceful: the attachment still uploads and the model is told the
 * transcription is unavailable.
 */
import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentTypesService } from '../agent-types/agent-types.service';
import { StorageService } from '../storage/storage.service';

/** Injection tokens for the test seams (production uses global fetch / 60s). */
export const VOICE_FETCH = 'VOICE_FETCH';
export const VOICE_TIMEOUT_MS = 'VOICE_TIMEOUT_MS';

/** Accepted audio uploads: what MediaRecorder produces (webm/opus on
 *  Chromium/Firefox, mp4/aac on Safari) plus the common drag-drop formats. */
export const AUDIO_CONTENT_TYPES = new Set([
  'audio/webm', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/mp3',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg',
]);
export const AUDIO_EXTENSIONS: Record<string, string> = {
  webm: 'audio/webm', weba: 'audio/webm', mp4: 'audio/mp4', m4a: 'audio/m4a',
  mp3: 'audio/mpeg', mpga: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
};
/** OpenAI's own ceiling for /audio/transcriptions. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** Transcription is synchronous inside the upload request; this bounds it. */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;
export const TRANSCRIPT_SUFFIX = '.transcript.txt';
/** OpenAI's input ceiling for /audio/speech. */
export const MAX_TTS_CHARS = 4096;

const audioExt = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';
const baseMime = (contentType?: string) => contentType?.split(';')[0].trim().toLowerCase() || '';

/** An upload counts as audio by extension or by declared content type. */
export function isAudioUpload(path: string, contentType?: string): boolean {
  if (audioExt(path) in AUDIO_EXTENSIONS) return true;
  const declared = baseMime(contentType);
  return !!declared && AUDIO_CONTENT_TYPES.has(declared);
}

/** The sidecar key/path for an audio file. */
export const transcriptPathFor = (path: string): string => `${path}${TRANSCRIPT_SUFFIX}`;

export interface TranscriptionResult {
  /** null when transcription is off, unconfigured, timed out or failed. */
  transcript: string | null;
  /** Seconds, from the provider when it reports one, else the client's hint. */
  durationHint: number | null;
}

interface VoiceConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  ttsModel: string;
}

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly agentTypes: AgentTypesService,
    @Optional() private readonly storage?: StorageService,
    @Optional() @Inject(VOICE_FETCH) fetchFn?: typeof fetch,
    @Optional() @Inject(VOICE_TIMEOUT_MS) timeoutMs?: number,
  ) {
    this.fetchFn = fetchFn ?? fetch;
    this.timeoutMs = timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
  }

  private cfg(): VoiceConfig {
    return {
      provider: this.config.get<string>('transcriptionProvider') ?? 'openai-compatible',
      baseUrl: (this.config.get<string>('transcriptionBaseUrl') || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: this.config.get<string>('transcriptionModel') || 'gpt-4o-mini-transcribe',
      apiKey: this.config.get<string>('transcriptionApiKey') ?? '',
      ttsModel: this.config.get<string>('ttsModel') || 'gpt-4o-mini-tts',
    };
  }

  /** TRANSCRIPTION_PROVIDER !== off. Availability additionally needs a key. */
  enabled(): boolean {
    return this.cfg().provider !== 'off';
  }

  /** The bearer used for both endpoints: env override, else the stored key of
   *  the OpenAI agent type (sealed at rest; opened server-side only). */
  async resolveApiKey(): Promise<string | null> {
    const env = this.cfg().apiKey.trim();
    if (env) return env;
    return this.agentTypes.resolveKeyForProvider('openai');
  }

  /** For the UI: whether the mic / speaker buttons have something to call. */
  async status(): Promise<{ transcription: boolean; tts: boolean; model: string }> {
    const on = this.enabled() && !!(await this.resolveApiKey());
    return { transcription: on, tts: on, model: this.cfg().model };
  }

  /** Audio uploads are bounded before they touch storage: size (OpenAI's
   *  25MB ceiling) and declared type (one of the accepted audio types). */
  assertAudioBounds(path: string, body: Buffer, contentType?: string): void {
    if (body.length > MAX_AUDIO_BYTES) {
      throw new BadRequestException(`audio upload exceeds ${MAX_AUDIO_BYTES / (1024 * 1024)}MB`);
    }
    if (body.length === 0) throw new BadRequestException('audio upload is empty');
    const declared = baseMime(contentType);
    if (declared && !AUDIO_CONTENT_TYPES.has(declared)) {
      throw new BadRequestException(`unsupported audio type ${declared}`);
    }
    if (!declared && !(audioExt(path) in AUDIO_EXTENSIONS)) {
      throw new BadRequestException('unsupported audio type');
    }
  }

  /** Effective content type for the multipart part: declared, else by extension. */
  private mimeFor(path: string, contentType?: string): string {
    const declared = baseMime(contentType);
    if (declared && AUDIO_CONTENT_TYPES.has(declared)) return declared;
    return AUDIO_EXTENSIONS[audioExt(path)] ?? 'application/octet-stream';
  }

  /** Transcribe one audio buffer. Never throws: null transcript on any failure. */
  async transcribe(body: Buffer, filename: string, contentType?: string, durationSeconds?: number): Promise<TranscriptionResult> {
    const hint = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.round(durationSeconds) : null;
    const cfg = this.cfg();
    if (cfg.provider === 'off') return { transcript: null, durationHint: hint };
    const apiKey = await this.resolveApiKey();
    if (!apiKey) {
      this.logger.warn('transcription skipped: no TRANSCRIPTION_API_KEY and no OpenAI agent type with a key');
      return { transcript: null, durationHint: hint };
    }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(body)], { type: this.mimeFor(filename, contentType) }), filename.split('/').pop() || 'audio');
    form.append('model', cfg.model);
    form.append('response_format', 'json');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${cfg.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.logger.warn(`transcription failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
        return { transcript: null, durationHint: hint };
      }
      const data = await res.json().catch(() => null) as { text?: unknown; duration?: unknown } | null;
      const text = typeof data?.text === 'string' ? data.text.trim() : '';
      const duration = typeof data?.duration === 'number' && data.duration > 0 ? Math.round(data.duration) : hint;
      return { transcript: text || null, durationHint: duration };
    } catch (err) {
      const why = ctrl.signal.aborted ? `timed out after ${this.timeoutMs}ms` : (err instanceof Error ? err.message : String(err));
      this.logger.warn(`transcription failed: ${why}`);
      return { transcript: null, durationHint: hint };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Upload hook shared by the workspace and agent file endpoints: transcribe
   *  and store the sidecar at `<key>.transcript.txt` beside the audio. */
  async transcribeUpload(key: string, path: string, body: Buffer, contentType?: string, durationSeconds?: number): Promise<TranscriptionResult> {
    const result = await this.transcribe(body, path, contentType, durationSeconds);
    if (result.transcript && this.storage) {
      const header = result.durationHint ? `# duration: ${result.durationHint}s\n` : '';
      await this.storage.put(transcriptPathFor(key), Buffer.from(`${header}${result.transcript}\n`, 'utf8'), 'text/plain');
    }
    return result;
  }

  /** Read a stored sidecar back as plain transcript text (header stripped). */
  static parseTranscript(sidecar: Buffer): { transcript: string; durationHint: number | null } {
    const raw = sidecar.toString('utf8');
    const m = /^# duration: (\d+)s\n/.exec(raw);
    return { transcript: (m ? raw.slice(m[0].length) : raw).trim(), durationHint: m ? parseInt(m[1], 10) : null };
  }

  /** Text-to-speech through `/audio/speech`; returns the upstream Response
   *  (streamed through by the controller) or null when unavailable. */
  async speak(text: string, voice?: string): Promise<Response | null> {
    const cfg = this.cfg();
    if (cfg.provider === 'off') return null;
    const apiKey = await this.resolveApiKey();
    if (!apiKey) return null;
    const input = text.trim().slice(0, MAX_TTS_CHARS);
    if (!input) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${cfg.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.ttsModel, voice: (voice || 'alloy').slice(0, 40), input, response_format: 'mp3' }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.logger.warn(`tts failed: HTTP ${res.status}`);
        return null;
      }
      return res;
    } catch (err) {
      this.logger.warn(`tts failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      // The body streams after this returns; the abort only guards the headers phase.
      clearTimeout(timer);
    }
  }
}
