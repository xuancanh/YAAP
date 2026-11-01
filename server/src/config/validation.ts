/**
 * Fail-fast environment validation, wired via ConfigModule.forRoot's
 * `validate` hook. Boot aborts with one aggregated error listing every
 * invalid/missing variable instead of silently misbehaving later.
 *
 * Dev keeps the docker-compose.dev.yml defaults applied in configuration.ts;
 * production must set DATABASE_URL and the S3_* vars explicitly — no silent
 * fallback to dev credentials.
 */
import { z } from 'zod';

/** Integer-valued env var (arrives as a string; must be all digits). */
const intVar = (name: string) =>
  z.string().regex(/^\d+$/, `${name} must be a non-negative integer`).optional();

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
    PORT: intVar('PORT'),
    DATABASE_URL: z.string().min(1).optional(),
    S3_ENDPOINT: z.string().min(1).optional(),
    S3_REGION: z.string().min(1).optional(),
    S3_BUCKET: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),
    DEFAULT_TOKEN_CEILING: intVar('DEFAULT_TOKEN_CEILING'),
    MAX_TOOL_ROUNDS: intVar('MAX_TOOL_ROUNDS'),
    COMPACTION_THRESHOLD_TOKENS: intVar('COMPACTION_THRESHOLD_TOKENS'),
    LOOPS_ENABLED: z.enum(['true', 'false']).optional(),
    COMPANIES_ENABLED: z.enum(['true', 'false']).optional(),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    PUBLIC_APP_URL: z.string().optional(),
    SECURITY_CONTACT: z.string().optional(),
    TOKEN_ENCRYPTION_KEY: z.string().optional(),
    YAAM_API_TOKEN: z.string().optional(),
    YAAM_CORS_ORIGINS: z.string().optional(),
    PUBLIC_BASE_URL: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    MS_CLIENT_ID: z.string().optional(),
    MS_CLIENT_SECRET: z.string().optional(),
    RUNNER_BACKEND: z.enum(['auto', 'local', 'cloudflare', 'off']).optional(),
    RUNNER_CF_URL: z.string().optional(),
    RUNNER_CF_TOKEN: z.string().optional(),
    TRANSCRIPTION_PROVIDER: z.enum(['openai-compatible', 'off']).optional(),
    TRANSCRIPTION_BASE_URL: z.string().optional(),
    TRANSCRIPTION_MODEL: z.string().optional(),
    TRANSCRIPTION_API_KEY: z.string().optional(),
    TTS_MODEL: z.string().optional(),
    EMAIL_DOMAIN: z.string().regex(/^$|^[a-z0-9.-]+\.[a-z]{2,}$/i, 'EMAIL_DOMAIN must be a bare domain like agents.example.com').optional(),
    EMAIL_INBOUND_SECRET: z.string().optional(),
    EMAIL_SEND_PROVIDER: z.enum(['cloudflare', 'resend', 'off']).optional(),
    EMAIL_SEND_TOKEN: z.string().optional(),
    EMAIL_CF_ACCOUNT_ID: z.string().optional(),
    EMAIL_FROM_NAME: z.string().optional(),
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().regex(/^$|^(mailto:|https:)/, 'VAPID_SUBJECT must be a mailto: or https: URL').optional(),
    BROWSER_BACKEND: z.enum(['auto', 'cloudflare', 'playwright', 'off']).optional(),
    BROWSER_CF_ACCOUNT_ID: z.string().optional(),
    BROWSER_CF_TOKEN: z.string().optional(),
    BROWSER_CHROMIUM_PATH: z.string().optional(),
    COMPUTER_CONTROL_ENABLED: z.enum(['true', 'false']).optional(),
    REGISTRY_URL: z.string().regex(/^$|^https?:\/\//, 'REGISTRY_URL must be an http(s) URL').optional(),
    REGISTRY_PUBLISH_TOKEN: z.string().optional(),
    AUTH_MODE: z.enum(['single', 'accounts']).optional(),
    ACCOUNTS_DEFAULT_PLAN: z.enum(['free', 'hosted', 'byo']).optional(),
    ADMIN_EMAILS: z.string().optional(),
    AUTH_FROM_ADDRESS: z.string().optional(),
    HOSTED_PLAN_USD: z.string().regex(/^\d+(\.\d+)?$/, 'HOSTED_PLAN_USD must be a non-negative number').optional(),
    PLATFORM_ANTHROPIC_KEY: z.string().optional(),
    PLATFORM_OPENAI_KEY: z.string().optional(),
    PLATFORM_GEMINI_KEY: z.string().optional(),
    PLATFORM_DEEPSEEK_KEY: z.string().optional(),
    SUITE_ACCOUNTS_URL: z.string().optional(),
    SUITE_ACCOUNTS_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.SUITE_ACCOUNTS_URL) !== Boolean(env.SUITE_ACCOUNTS_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['SUITE_ACCOUNTS_SECRET'], message: 'SUITE_ACCOUNTS_URL and SUITE_ACCOUNTS_SECRET must be set together' });
    }
    if (env.SUITE_ACCOUNTS_URL && env.AUTH_MODE !== 'accounts') {
      ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'SUITE_ACCOUNTS_URL requires AUTH_MODE=accounts' });
    }
    if (env.AUTH_MODE === 'accounts' && env.NODE_ENV === 'production' && !env.TOKEN_ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', path: ['TOKEN_ENCRYPTION_KEY'], message: 'TOKEN_ENCRYPTION_KEY is required when AUTH_MODE=accounts in production (per-account provider keys are sealed with it)' });
    }
    // Selecting the cloudflare backend without its endpoint is a boot-time
    // mistake, not a runtime surprise: the runner would silently vanish.
    if (env.RUNNER_BACKEND === 'cloudflare' && !(env.RUNNER_CF_URL && env.RUNNER_CF_TOKEN)) {
      ctx.addIssue({
        code: 'custom',
        path: ['RUNNER_CF_URL'],
        message: 'RUNNER_CF_URL and RUNNER_CF_TOKEN are required when RUNNER_BACKEND=cloudflare',
      });
    }
    if (env.EMAIL_DOMAIN && !env.EMAIL_INBOUND_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_INBOUND_SECRET'], message: 'EMAIL_INBOUND_SECRET is required when EMAIL_DOMAIN is set (the inbound webhook must be signed)' });
    }
    if (env.EMAIL_SEND_PROVIDER && env.EMAIL_SEND_PROVIDER !== 'off' && !env.EMAIL_SEND_TOKEN) {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_SEND_TOKEN'], message: `EMAIL_SEND_TOKEN is required when EMAIL_SEND_PROVIDER=${env.EMAIL_SEND_PROVIDER}` });
    }
    if (env.EMAIL_SEND_PROVIDER === 'cloudflare' && !env.EMAIL_CF_ACCOUNT_ID) {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_CF_ACCOUNT_ID'], message: 'EMAIL_CF_ACCOUNT_ID is required when EMAIL_SEND_PROVIDER=cloudflare' });
    }
    if (Boolean(env.VAPID_PUBLIC_KEY) !== Boolean(env.VAPID_PRIVATE_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['VAPID_PRIVATE_KEY'], message: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together (npm run push:keys)' });
    }
    if (env.BROWSER_BACKEND === 'cloudflare' && !(env.BROWSER_CF_ACCOUNT_ID && env.BROWSER_CF_TOKEN)) {
      ctx.addIssue({
        code: 'custom',
        path: ['BROWSER_CF_ACCOUNT_ID'],
        message: 'BROWSER_CF_ACCOUNT_ID and BROWSER_CF_TOKEN are required when BROWSER_BACKEND=cloudflare',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    const required = [
      'DATABASE_URL',
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ] as const;
    for (const name of required) {
      if (!env[name]) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} is required when NODE_ENV=production (no dev-credential fallback)`,
        });
      }
    }
  });

/** ConfigModule `validate` hook: returns the raw env untouched on success
 *  (defaults live in configuration.ts), throws an aggregated error on failure. */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return config;
}
