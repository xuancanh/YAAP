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
  /** Estimated provider-input tokens that trigger auto-compaction (FR-7.3). */
  compactionThresholdTokens: parseInt(process.env.COMPACTION_THRESHOLD_TOKENS || '120000', 10),
});
