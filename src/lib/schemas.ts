/**
 * Zod schemas for the most failure-prone API responses — the shapes the UI
 * JSON.parses (ChatSession.tags, Agent.colors/loops/apps) or iterates blindly.
 * Validation is deliberately LOOSE: on drift, looseParse logs a warning and
 * returns the raw value, so a backend/frontend mismatch surfaces in the
 * console instead of crashing a render. SSE turn events are not validated
 * (hot path — see sendTurn in api.ts).
 */
import { z } from 'zod';

export const chatSessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string().nullable(),
  agentTypeId: z.string().nullable(),
  name: z.string(),
  autoTitle: z.string(),
  cwd: z.string().nullable(),
  model: z.string(),
  thinkingEffort: z.string(),
  permissionMode: z.enum(['ask', 'auto']),
  pinned: z.number(),
  /** JSON array of tag strings — the UI parses this on every session list. */
  tags: z.string(),
  archivedAt: z.string().nullable(),
  draft: z.string(),
  tokenCeiling: z.number(),
  tokensAtCompact: z.number().optional(),
  contextTokens: z.number().optional(),
  compactSummary: z.string(),
  compactCutoff: z.string().nullable(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const chatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  seq: z.number(),
  role: z.enum(['user', 'assistant', 'tool', 'thinking']),
  content: z.string(),
  toolName: z.string().nullable(),
  createdAt: z.string(),
});

export const chatTurnSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number(),
  input: z.string(),
  /** JSON array of { path, kind } — parsed by the UI. */
  attachments: z.string(),
  status: z.string(),
  toolCalls: z.string(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  rating: z.string().nullable(),
  /** JSON handoff object — parsed when present. */
  taskHandoff: z.string().nullable(),
});

export const agentSchema = z.object({
  id: z.string(),
  workspaceId: z.string().optional(),
  name: z.string(),
  emoji: z.string(),
  colors: z.string(), // JSON [from, to]
  role: z.string(),
  charter: z.string(),
  provider: z.string(),
  model: z.string(),
  agentTypeId: z.string().nullable().optional(),
  homeDir: z.string().nullable(),
  workspaceFolder: z.string(),
  dashboard: z.string(),
  loops: z.string(), // JSON array of { name, cron }
  apps: z.string(), // JSON array of AgentApp
  createdAt: z.string(),
});

export const fileAuthorSchema = z.object({ kind: z.string(), id: z.string(), name: z.string() });

export const fileEntrySchema = z.object({
  path: z.string(),
  size: z.number(),
  lastModified: z.string().optional(),
  version: z.number().optional(),
  updatedBy: fileAuthorSchema.nullable().optional(),
  owner: z.object({ agentId: z.string() }).nullable().optional(),
});

export const filePreviewSchema = z.object({
  path: z.string(),
  kind: z.enum(['markdown', 'html', 'image', 'pdf', 'audio', 'text', 'binary']),
  size: z.number(),
  contentType: z.string(),
  text: z.string().optional(),
  truncated: z.boolean().optional(),
  base64: z.string().optional(),
  version: z.number().optional(),
  updatedBy: fileAuthorSchema.nullable().optional(),
  updatedAt: z.string().optional(),
});

export const fileRevisionSchema = z.object({
  version: z.number(),
  size: z.number(),
  updatedBy: fileAuthorSchema.nullable().optional(),
  updatedAt: z.string(),
});

export const chatSessionListSchema = z.array(chatSessionSchema);
export const agentListSchema = z.array(agentSchema);
export const fileEntryListSchema = z.array(fileEntrySchema);
export const fileRevisionListSchema = z.array(fileRevisionSchema);

export const transcriptSchema = z.object({
  messages: z.array(chatMessageSchema),
  turns: z.array(chatTurnSchema),
});

/** Usage reports are iterated blindly into a chart — drift should warn. */
export const usageReportSchema = z.object({
  days: z.number(),
  totals: z.object({ tokensIn: z.number(), tokensOut: z.number(), usd: z.number(), turns: z.number() }),
  series: z.array(z.object({ day: z.string(), tokensIn: z.number(), tokensOut: z.number(), usd: z.number() })),
  byKind: z.array(z.object({
    key: z.string(), label: z.string(), kind: z.enum(['chat', 'loop', 'channel']),
    tokensIn: z.number(), tokensOut: z.number(), usd: z.number(), turns: z.number(), sessionId: z.string().optional(),
  })),
  unpricedModels: z.array(z.string()),
});

export const hireResultSchema = z.object({
  ok: z.boolean(),
  agent: agentSchema,
});

/** Validate `value` against `schema`; on mismatch warn and keep the raw
 *  value — drift should be visible, never fatal. Returns `value` unchanged
 *  either way (schemas strip unknown keys, so we never hand parsed output
 *  to callers). */
export function looseParse<T>(schema: z.ZodType, value: T, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    console.warn(
      `[api] response drifted from schema at ${label}:`,
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return value;
}
