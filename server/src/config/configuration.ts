/**
 * Typed configuration factory (loaded once by @nestjs/config).
 *
 * All runtime knobs come from the environment. Defaults target the local dev
 * stack in docker-compose.dev.yml (Postgres + MinIO), so `docker compose -f
 * docker-compose.dev.yml up -d && npm run dev` works with zero further setup.
 */
export default () => ({
  port: parseInt(process.env.PORT || '8790', 10),
  /** Postgres connection string (the only supported database). */
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://yaamchat:yaamchat@localhost:5433/yaamchat',
  /** S3-compatible object storage for workspace files (MinIO in dev). */
  s3: {
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9100',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'yaam-chat',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || 'yaamchat',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'yaamchat-secret',
    /** Path-style URLs; required by MinIO and most S3-compatibles. */
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  },
  /** Default per-chat token ceiling (FR-7.1). 0 = unlimited. */
  defaultTokenCeiling: parseInt(process.env.DEFAULT_TOKEN_CEILING || '200000', 10),
  /** Max tool rounds inside a single turn (FR-3.1). */
  maxToolRounds: parseInt(process.env.MAX_TOOL_ROUNDS || '24', 10),
  /** Scheduled agent loops master switch (FR-11.6). */
  loopsEnabled: (process.env.LOOPS_ENABLED || 'true') === 'true',
  /** Telegram bot token (phase 4). Empty = channel disabled. */
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  /** Where the SPA is reachable from a phone — channel notifications deep-link
   *  to <publicAppUrl>/#/chat/<sessionId>. Dev default is the Vite port. */
  publicAppUrl: process.env.PUBLIC_APP_URL || 'http://localhost:5175',
  /** AES-256-GCM key for sealing tokens at rest (common/secretbox.ts).
   *  Empty = tokens stored as "plain:" — AppModule logs a loud boot warning. */
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
  /** Optional bearer token required on every /api route except GET /api/status
   *  (common/auth.guard.ts). Empty = unauthenticated (single-user localhost
   *  default) — AppModule logs a loud boot warning. */
  apiToken: process.env.YAAM_API_TOKEN || '',
  /** Comma-separated CORS origin allowlist (bootstrap.ts). Requests without
   *  an Origin header (curl, server-to-server, same-origin) always pass;
   *  production serves the SPA same-origin so no CORS is needed there. */
  corsOrigins: process.env.YAAM_CORS_ORIGINS || 'http://localhost:5175,http://127.0.0.1:5175',
  /** Where the API is reachable from a browser — the OAuth redirect base
   *  (register <publicBaseUrl>/api/connections/google/callback in the
   *  Google client). Dev default is the API port, not the Vite port. */
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:8790',
  /** Google OAuth client (docs/integrations.md §3a — BYO client for
   *  self-hosted). Empty = the google provider shows as unconfigured. */
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  msClientId: process.env.MS_CLIENT_ID || '',
  msClientSecret: process.env.MS_CLIENT_SECRET || '',
  /** Code runner backend (docs/code-execution.md §5-6): 'auto' picks
   *  cloudflare when RUNNER_CF_* are set, else the local OS sandbox
   *  (Seatbelt/bubblewrap), else the run tools do not exist. 'off' disables. */
  runnerBackend: process.env.RUNNER_BACKEND || 'auto',
  /** Base URL of the deployed cloudflare/runner-worker (paid tier). */
  runnerCfUrl: process.env.RUNNER_CF_URL || '',
  /** Shared bearer token the worker requires on every request. */
  runnerCfToken: process.env.RUNNER_CF_TOKEN || '',
  /** Vulnerability-disclosure address shown by GET /api/security and Settings
   *  (docs/security.md §j). Empty = the UI shows the policy without a contact. */
  securityContact: process.env.SECURITY_CONTACT || '',
  /** Voice notes (docs/voice.md): audio attachments transcribe on upload
   *  through an OpenAI-compatible /audio/transcriptions endpoint; the same
   *  base serves optional TTS via /audio/speech. 'off' disables both. */
  transcriptionProvider: process.env.TRANSCRIPTION_PROVIDER || 'openai-compatible',
  transcriptionBaseUrl: process.env.TRANSCRIPTION_BASE_URL || 'https://api.openai.com/v1',
  /** gpt-4o-mini-transcribe: cheaper and more accurate than whisper-1 on
   *  OpenAI; set whisper-1 (or e.g. whisper-large-v3 on Groq) for other
   *  compatibles. */
  transcriptionModel: process.env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
  /** Empty = borrow the stored key of the OpenAI agent type (sealed at rest). */
  transcriptionApiKey: process.env.TRANSCRIPTION_API_KEY || '',
  ttsModel: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
  /** Estimated provider-input tokens that trigger auto-compaction (FR-7.3). */
  compactionThresholdTokens: parseInt(process.env.COMPACTION_THRESHOLD_TOKENS || '120000', 10),
});
