# Voice notes

Execution-plan item 11. Audio attachments transcribe on upload through a
configurable OpenAI-compatible endpoint; the transcript becomes the
attachment text the model reads; optional text-to-speech on replies sits
behind a setting. Wearables and wake words stay out of scope (docs/roadmap.md §3).

## What ships

- **Record in the composer.** A microphone button (hidden when the browser
  has no `MediaRecorder`/`getUserMedia`) records webm/opus on Chromium and
  Firefox, mp4 on Safari, shows the elapsed time with Discard/Stop, and on
  Stop uploads the file through the ordinary attachment endpoint. The chip
  reads "Voice note · 0:42"; tap or hover for the transcript. Drag-dropped or
  picked audio files (`webm m4a mp4 mp3 wav ogg`) take the same path. A note
  can be sent with no typed text — the transcript is the message.
- **Transcribe on upload.** `POST /api/workspaces/:id/files` and
  `POST /api/agents/:id/files` detect audio by extension or content type,
  enforce the bounds (≤25MB, one of the accepted audio types), store the
  file, then call `POST {TRANSCRIPTION_BASE_URL}/audio/transcriptions`
  (multipart `file` + `model`) synchronously with a 60s timeout. The
  transcript is stored beside the audio as `<file>.transcript.txt` (first
  line `# duration: Ns` when known) and the upload response carries
  `{ transcript, durationHint }`. Any failure — provider off, no key,
  timeout, upstream error — still uploads the audio; `transcript` is `null`.
- **The model reads text, never bytes.** `loadAttachments` in
  `turn-loop.service.ts` renders an audio attachment as
  `[Voice note transcript]: …` from the sidecar, or
  `[Voice note]: audio attached, transcription unavailable.` when there is
  none. Raw audio is never sent to the chat provider.
- **Reply TTS (off by default).** Settings → Chat → "Read replies aloud"
  (`ttsEnabled`, plus `ttsVoice`, default `alloy`) shows a speaker button on
  assistant replies. It calls `POST /api/voice/tts { text, voice? }`, which
  proxies `{base}/audio/speech` and streams the mp3 back; the browser plays
  it from a blob. Replies longer than 4096 characters are cut at the
  provider's ceiling.
- **File previews.** Audio files preview as `<audio controls>` with the
  transcript below (`previewKindFor` → `audio`; FilesView loads the sidecar).

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `TRANSCRIPTION_PROVIDER` | `openai-compatible` | `off` disables transcription and TTS |
| `TRANSCRIPTION_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible base (Groq, local whisper servers, gateways) |
| `TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | Cheaper and more accurate than `whisper-1` on OpenAI; other compatibles want e.g. `whisper-1` or `whisper-large-v3` |
| `TRANSCRIPTION_API_KEY` | *(empty)* | Empty = the stored key of the first OpenAI agent type (sealed at rest, opened server-side; `AgentTypesService.resolveKeyForProvider`) |
| `TTS_MODEL` | `gpt-4o-mini-tts` | Used by `/api/voice/tts` |

Keys never leave the server. `GET /api/voice/status` tells the UI whether
transcription/TTS have a key to call with. The JSON body limit in
`bootstrap.ts` is 40mb so a 25MB note fits base64-encoded.

## Files

`server/src/voice/transcription.service.ts` (+ `voice.module.ts`),
`agent-types.service.ts#resolveKeyForProvider`, `storage/preview.util.ts`,
`workspaces.controller.ts` / `agents.controller.ts` upload hooks,
`chats/turn-loop.service.ts#loadAttachments`, `src/lib/voice.ts`
(`useVoiceRecorder`, `fmtDuration`, `pickAudioMime`),
`src/components/VoiceChip.tsx`, composer/TTS wiring in `ChatView.tsx`,
`FilesView.tsx`, Settings → Chat. Tests: `tests/backend-voice.test.ts`,
`web-tests/voice-chip.test.tsx`.
