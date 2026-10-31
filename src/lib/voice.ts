/** Voice notes (docs/voice.md): recorder helpers shared by the composer and
 *  the chip. Pure functions live here so they are unit-testable without DOM. */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Matches the server's accepted audio set (voice/transcription.service.ts). */
export const AUDIO_EXT_RE = /\.(webm|weba|mp4|m4a|mp3|mpga|wav|ogg|oga)$/i;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function isAudioFile(file: { name: string; type?: string }): boolean {
  return (file.type ?? '').startsWith('audio/') || AUDIO_EXT_RE.test(file.name);
}

/** "0:42", "12:05", "1:02:03". */
export function fmtDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** Chip label for a voice note: "Voice note · 0:42" (no duration → "Voice note"). */
export function voiceLabel(seconds: number | null | undefined): string {
  return seconds && seconds > 0 ? `Voice note · ${fmtDuration(seconds)}` : 'Voice note';
}

/** The best MediaRecorder container the browser supports: webm/opus on
 *  Chromium and Firefox, mp4 (AAC) on Safari. null when recording is not
 *  possible at all (the composer hides the mic button then). */
export function pickAudioMime(
  isSupported: (mime: string) => boolean = (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
): { mime: string; ext: string } | null {
  const candidates: Array<{ mime: string; ext: string }> = [
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/webm', ext: 'webm' },
    { mime: 'audio/mp4', ext: 'mp4' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  ];
  return candidates.find((c) => { try { return isSupported(c.mime); } catch { return false; } }) ?? null;
}

export function recorderAvailable(): boolean {
  return typeof window !== 'undefined'
    && typeof MediaRecorder !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && pickAudioMime() !== null;
}

export interface VoiceRecording { file: File; durationSeconds: number }

/** Tiny MediaRecorder wrapper: start → elapsed ticks → stop resolves a File
 *  named voice-note-<timestamp>.<ext>. Tracks are released on stop/cancel. */
export function useVoiceRecorder(onError?: (msg: string) => void) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const resolver = useRef<((r: VoiceRecording | null) => void) | null>(null);

  const cleanup = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    rec.current?.stream.getTracks().forEach((t) => t.stop());
    rec.current = null;
    setRecording(false);
  }, []);

  useEffect(() => () => { if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); cleanup(); }, [cleanup]);

  const start = useCallback(async () => {
    if (rec.current) return;
    const pick = pickAudioMime();
    if (!pick) { onError?.('Voice recording is not supported in this browser'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: pick.mime });
      chunks.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      mr.onstop = () => {
        const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt.current) / 1000));
        const blob = new Blob(chunks.current, { type: pick.mime.split(';')[0] });
        const file = new File([blob], `voice-note-${new Date().toISOString().replace(/[:.]/g, '-')}.${pick.ext}`, { type: blob.type });
        cleanup();
        resolver.current?.(blob.size > 0 ? { file, durationSeconds } : null);
        resolver.current = null;
      };
      rec.current = mr;
      startedAt.current = Date.now();
      setElapsed(0);
      timer.current = setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 500);
      mr.start(1000);
      setRecording(true);
    } catch (err) {
      cleanup();
      onError?.(err instanceof Error && err.name === 'NotAllowedError' ? 'Microphone access was denied' : 'Could not start recording');
    }
  }, [cleanup, onError]);

  /** Resolves with the recording (null if empty or cancelled). */
  const stop = useCallback((): Promise<VoiceRecording | null> => new Promise((resolve) => {
    const mr = rec.current;
    if (!mr || mr.state === 'inactive') { cleanup(); resolve(null); return; }
    resolver.current = resolve;
    mr.stop();
  }), [cleanup]);

  const cancel = useCallback(() => {
    const mr = rec.current;
    resolver.current = null;
    if (mr && mr.state !== 'inactive') { mr.onstop = null; mr.stop(); }
    cleanup();
  }, [cleanup]);

  return { recording, elapsed, start, stop, cancel };
}
