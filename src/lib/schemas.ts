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
  /** chat (a conversation) | work (the agent's own run; docs/work-log.md). */
  kind: z.enum(['chat', 'work']).optional(),
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

/** Follows (docs/follows.md): the follower avatars render from this list. */
export const followViewSchema = z.object({
  following: z.boolean(),
  reason: z.string().nullable(),
  followers: z.array(z.object({ followerKind: z.enum(['agent', 'user']), followerId: z.string(), reason: z.string(), createdAt: z.string() })),
});

/** Home (docs/home.md): one aggregate the page iterates section by section —
 *  drift in any list should warn, never blank the page. */
const homeRefSchema = z.object({ type: z.string(), id: z.string() }).nullable();
export const homeDataSchema = z.object({
  workspaceId: z.string(),
  generatedAt: z.string(),
  since: z.string(),
  firstVisit: z.boolean(),
  company: z.object({
    orgId: z.string(), name: z.string(), mode: z.enum(['off', 'supervised', 'autonomous']), status: z.enum(['active', 'paused']),
    chiefAgentId: z.string().nullable(), chiefName: z.string().nullable(), memberCount: z.number(),
  }).nullable(),
  headline: z.object({ tasksDone: z.number(), needsYou: z.number(), todayUsd: z.number().nullable(), monthUsd: z.number().nullable(), monthCapUsd: z.number().nullable() }),
  needs: z.array(z.object({
    id: z.string(), kind: z.enum(['approval', 'escalation', 'held_action', 'plan', 'incident', 'signal', 'queued_action']), subkind: z.string(),
    title: z.string(), detail: z.string(), severity: z.enum(['critical', 'high', 'normal']), createdAt: z.string(),
    deadline: z.string().nullable(), defaultAction: z.enum(['approve', 'deny', 'apply', '']), recommendation: z.string(), recommendedAction: z.string(),
    reversibility: z.string(), confidence: z.number().nullable(), requestedBy: z.string(), ref: z.record(z.string(), z.string()),
    actions: z.array(z.enum(['approve', 'reject', 'veto', 'apply_now', 'ack', 'dismiss'])),
  })),
  recap: z.object({
    tasksDone: z.number(), tasksBlocked: z.number(), decisionsCount: z.number(), artifactsChanged: z.number(),
    decisions: z.array(z.object({ at: z.string(), kind: z.string(), title: z.string(), detail: z.string(), ref: homeRefSchema })),
    people: z.array(z.object({ at: z.string(), kind: z.string(), title: z.string(), detail: z.string(), ref: homeRefSchema })),
    brief: z.object({ at: z.string(), text: z.string() }).nullable(),
    pulse: z.object({ score: z.number(), breaches: z.number() }).nullable(),
  }),
  goals: z.array(z.object({
    id: z.string(), title: z.string(), progress: z.number(), rag: z.enum(['red', 'amber', 'green', 'grey']), atRisk: z.boolean(),
    keyResults: z.array(z.object({ id: z.string(), title: z.string(), progress: z.number(), rag: z.enum(['red', 'amber', 'green', 'grey']) })),
  })),
  team: z.array(z.object({
    id: z.string(), name: z.string(), emoji: z.string(), colors: z.string(), state: z.enum(['working', 'idle', 'blocked', 'paused', 'error']), doing: z.string(),
    errors: z.array(z.object({ kind: z.string(), message: z.string(), at: z.string() })),
  })),
  activity: z.array(z.object({ id: z.string(), at: z.string(), kind: z.string(), title: z.string(), detail: z.string(), actor: z.string(), ref: homeRefSchema })),
  spend: z.object({ todayUsd: z.number().nullable(), monthUsd: z.number().nullable(), monthCapUsd: z.number().nullable(), projectedUsd: z.number().nullable() }),
  health: z.object({ status: z.enum(['ok', 'degraded', 'incident']), openIncidents: z.array(z.object({ id: z.string(), title: z.string() })), providers: z.array(z.object({ provider: z.string() })) }),
  upcoming: z.array(z.object({ id: z.string(), at: z.string(), kind: z.string(), title: z.string(), ref: homeRefSchema })),
  artifacts: z.array(z.object({ path: z.string(), version: z.number(), updatedAt: z.string() })),
  messages: z.object({
    unread: z.number(),
    items: z.array(z.object({ id: z.string(), agentId: z.string(), agentName: z.string(), text: z.string(), urgency: z.enum(['fyi', 'normal', 'urgent']), sessionId: z.string(), createdAt: z.string(), read: z.boolean() })),
  }).optional(),
  partial: z.array(z.string()),
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
