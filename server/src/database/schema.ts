/**
 * Drizzle schema — the durable-agent chat data model.
 *
 * Derived from docs/chat-requirements.md:
 *  - workspaces      — scoping partitions + durable workspace chat memory (§12)
 *  - agents          — durable agent identities: charter, defaults, home folder (§11)
 *  - agent_types     — reusable provider/model/persona presets (§9)
 *  - chat_sessions   — one conversation, workspace-scoped, optionally owned by
 *                      a durable agent (§1); carries draft, pin/tags/archive,
 *                      permission mode + remembered approvals (§4), token
 *                      ceiling and compaction summary/cutoff (§7)
 *  - chat_turns      — the structured work record per completed turn (FR-6.6):
 *                      input + attachments, tool calls, status, token usage,
 *                      rating, board handoff
 *  - chat_messages   — the visible transcript (user/assistant/tool/thinking);
 *                      tool + thinking rows are excluded when provider history
 *                      is rebuilt (FR-8.1)
 *
 * Postgres-only. Timestamps are ISO-8601 strings; booleans are 0/1 integers;
 * structured fields are JSON strings — matching the reference app's column
 * conventions.
 */
import { pgTable, text, integer, real } from 'drizzle-orm/pg-core';

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull().default('#F5C451'),
  /** Durable workspace chat memory, injected as shared context (FR-12.1). */
  memory: text('memory').notNull().default(''),
  /** The consented user profile: what agents know about the user. Only the
   *  user writes this directly; agents propose entries into profilePending. */
  profile: text('profile').notNull().default(''),
  /** JSON array of pending profile proposals awaiting user review:
   *  { id, entry, agentName, sessionId, at }. */
  profilePending: text('profilePending').notNull().default('[]'),
  /** Quiet hours + interrupt policy (roadmap phase 2.3), JSON or '' when
   *  off: { start: "22:00", end: "07:00", timezone: "Europe/Berlin",
   *  policy: "queue" | "silent" | "allow-urgent" }. Loops still run inside
   *  the window; only their notifications wait (see quiet-hours.ts). */
  quietHours: text('quietHours').notNull().default(''),
  /** Monthly hard spend stop in tokens (phase 2.5); 0 = unlimited. */
  spendBudgetTokens: integer('spendBudgetTokens').notNull().default(0),
  /** The month ('YYYY-MM', UTC) the running counter belongs to; a turn
   *  landing in a new month resets the counter instead of carrying it. */
  spendMonth: text('spendMonth').notNull().default(''),
  /** tokensIn + tokensOut of every turn completed this month, all agents. */
  spendTokens: integer('spendTokens').notNull().default(0),
  createdAt: text('createdAt').notNull(),
});

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Avatar emoji + gradient color pair (JSON [from,to]) for the UI. */
  emoji: text('emoji').notNull().default('\u{1F916}'),
  colors: text('colors').notNull().default('["#8b8cf0","#5cc2f2"]'),
  role: text('role').notNull().default(''),
  /** User-written charter: who this agent is and how it should act (FR-11.1). */
  charter: text('charter').notNull().default(''),
  provider: text('provider').notNull().default('anthropic'),
  model: text('model').notNull().default(''),
  /** Optional file-brain home folder path (LESSONS.md / JOURNAL.md / knowledge/). */
  homeDir: text('homeDir'),
  /** Markdown home dashboard (FR-11.5). */
  dashboard: text('dashboard').notNull().default(''),
  /** JSON array of scheduled prompt loops (FR-11.6). */
  loops: text('loops').notNull().default('[]'),
  /** JSON array of self-built mini apps: { id, name, description, html,
   *  updatedAt } — rendered only in a network-blocked sandbox (FR-13.1). */
  apps: text('apps').notNull().default('[]'),
  /** Optional workspace folder assignment: a path inside the chat's
   *  workspace store, mounted into agent chats as shared/ alongside the
   *  agent's own working folder. Empty = no shared mount. */
  workspaceFolder: text('workspaceFolder').notNull().default(''),
  /** JSON array of self-built HTTP tools: { id, name, slug, description,
   *  method, url, body, enabled, ... } — proposed by the agent, activated
   *  only by user approval, executed through the SSRF guard. */
  tools: text('tools').notNull().default('[]'),
  /** JSON array of pending 👍/👎 feedback since the agent's last turn (FR-6.5). */
  pendingFeedback: text('pendingFeedback').notNull().default('[]'),
  /** Local part of the agent's inbound address, `<emailSlug>@EMAIL_DOMAIN`
   *  (channels/email.service.ts). Derived from the name once, kept stable on
   *  rename, unique across agents; '' until the email channel assigns it. */
  emailSlug: text('emailSlug').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

/** Per-agent kanban board (§11): the agent's own work queue. Tasks arrive
 *  from the user, from promoted chat turns, or from the agent itself
 *  (add_task) — often during scheduled loops. */
export const agentTasks = pgTable('agent_tasks', {
  id: text('id').primaryKey(),
  agentId: text('agentId').notNull(),
  title: text('title').notNull(),
  note: text('note').notNull().default(''),
  /** todo | doing | done. */
  status: text('status').notNull().default('todo'),
  /** user | agent | promote | loop — where the task came from. */
  origin: text('origin').notNull().default('user'),
  /** Chat session the task was promoted from, when origin = promote. */
  sessionId: text('sessionId'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
});

/** The agent inbox (roadmap phase 2): proactive work lands here as
 *  notifications — loop runs, failures, budget stops — so nothing the agent
 *  does unattended is silent. */
export const agentEvents = pgTable('agent_events', {
  id: text('id').primaryKey(),
  agentId: text('agentId').notNull(),
  /** loop_run | loop_error | budget_stop | info | action_pending |
   *  action_done | action_failed | action_dismissed. */
  kind: text('kind').notNull().default('loop_run'),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  /** JSON {tool, input} for action_pending events — the queued call the
   *  user can approve from the inbox (background turns never mutate
   *  external services silently, docs/integrations.md §5). */
  payload: text('payload').notNull().default(''),
  sessionId: text('sessionId'),
  readAt: text('readAt'),
  /** Quiet hours (policy queue): channels must not push this before then.
   *  null = deliverable now. The inbox shows the event either way. */
  deliverAfter: text('deliverAfter'),
  /** 1 = created under policy silent: inbox-only, never pushed anywhere. */
  silent: integer('silent').notNull().default(0),
  /** user | loop | channel | system — the turn surface that produced it.
   *  Channel-originated events are never pushed back to the channel. */
  origin: text('origin').notNull().default(''),
  /** 1 = push to the paired channel even when this is not its default agent
   *  (urgent kinds: loop_error, budget_stop). */
  channel: integer('channel').notNull().default(0),
  /** When a channel delivered it (two-way Telegram); null = not yet. */
  deliveredAt: text('deliveredAt'),
  /** The same, per channel: the email sweep/digest and the web-push sweep
   *  each own a column so one channel's success never hides the event from
   *  another (channels/email.service.ts, push/push.service.ts). */
  emailDeliveredAt: text('emailDeliveredAt'),
  pushDeliveredAt: text('pushDeliveredAt'),
  createdAt: text('createdAt').notNull(),
});

/** Web Push subscriptions (roadmap phase 4.3): one row per browser that
 *  turned on "Notifications on this device". Endpoint is the push service's
 *  URL (unique); p256dh/auth are the client's RFC 8291 keys. A 404/410 from
 *  the push service deletes the row. */
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('userAgent').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

export const agentTypes = pgTable('agent_types', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  /** JSON array of pickable model ids (FR-9.1). */
  models: text('models').notNull().default('[]'),
  baseUrl: text('baseUrl'),
  /** Provider API key. Resolved at request time, never echoed to clients or
   *  embedded in transcripts (FR-13.3). */
  apiKey: text('apiKey'),
  persona: text('persona').notNull().default(''),
  enabled: integer('enabled').notNull().default(1),
  createdAt: text('createdAt').notNull(),
});

export const chatSessions = pgTable('chat_sessions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  agentId: text('agentId'),
  agentTypeId: text('agentTypeId'),
  name: text('name').notNull().default(''),
  /** Auto-title derived from the conversation when name is empty (FR-1.3). */
  autoTitle: text('autoTitle').notNull().default(''),
  cwd: text('cwd'),
  model: text('model').notNull().default(''),
  /** off | low | medium | high (FR-9.4). */
  thinkingEffort: text('thinkingEffort').notNull().default('off'),
  /** ask | auto (FR-4.1). */
  permissionMode: text('permissionMode').notNull().default('ask'),
  /** JSON of remembered tool approvals, scoped to this chat (FR-4.5). */
  approvals: text('approvals').notNull().default('{}'),
  /** JSON array of skill source ids (FR-10.1). */
  skillSourceIds: text('skillSourceIds').notNull().default('[]'),
  pinned: integer('pinned').notNull().default(0),
  tags: text('tags').notNull().default('[]'),
  archivedAt: text('archivedAt'),
  /** Unsent composer draft, preserved across restarts (FR-2.1). */
  draft: text('draft').notNull().default(''),
  /** Token ceiling; 0 = unlimited (FR-7.1). */
  tokenCeiling: integer('tokenCeiling').notNull().default(200000),
  /** Compaction summary replacing older private provider history (FR-7.3). */
  compactSummary: text('compactSummary').notNull().default(''),
  /** Message-id cutoff: only messages newer than this rebuild history (FR-7.4). */
  compactCutoff: text('compactCutoff'),
  tokensIn: integer('tokensIn').notNull().default(0),
  tokensOut: integer('tokensOut').notNull().default(0),
  /** When this session was last distilled into the agent brain; the idle
   *  sweep skips sessions whose transcript has not changed since. */
  distilledAt: text('distilledAt'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
});

export const chatTurns = pgTable('chat_turns', {
  id: text('id').primaryKey(),
  sessionId: text('sessionId').notNull(),
  /** Monotonic position within the session. */
  seq: integer('seq').notNull(),
  /** The user's original input text. */
  input: text('input').notNull(),
  /** JSON array of attachment descriptors (FR-2.2). */
  attachments: text('attachments').notNull().default('[]'),
  model: text('model').notNull().default(''),
  /** running | done | stopped | error (FR-5.4). */
  status: text('status').notNull().default('running'),
  /** JSON array of tool calls: { tool, input, result, approved } (FR-6.6). */
  toolCalls: text('toolCalls').notNull().default('[]'),
  tokensIn: integer('tokensIn').notNull().default(0),
  tokensOut: integer('tokensOut').notNull().default(0),
  /** up | down, with an optional note (FR-6.5). */
  rating: text('rating'),
  ratingNote: text('ratingNote'),
  /** Board-task handoff record, if promoted (FR-6.4). */
  taskHandoff: text('taskHandoff'),
  /** JSON array of skill ids whose skill_* tool loaded in this turn, so a
   *  rating on the turn can attach to the skills that shaped it. */
  skillsUsed: text('skillsUsed').notNull().default('[]'),
  error: text('error'),
  createdAt: text('createdAt').notNull(),
});

export const skills = pgTable('skills', {
  id: text('id').primaryKey(),
  /** null = global skill visible to every workspace (FR-10.1). */
  workspaceId: text('workspaceId'),
  /** Slug, also the slash-command / tool suffix: skill_<name> (FR-2.4/10.2). */
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** The instruction body loaded into the model when the skill is invoked. */
  instructions: text('instructions').notNull().default(''),
  enabled: integer('enabled').notNull().default(1),
  /** Seeded built-ins are recreated on boot if deleted; user edits stick. */
  builtin: integer('builtin').notNull().default(0),
  /** 1 = drafted by an agent from experience, awaiting user approval
   *  (roadmap phase 3). Drafts are never offered as tools. */
  draft: integer('draft').notNull().default(0),
  /** Name of the agent that drafted this skill, for provenance. */
  proposedBy: text('proposedBy').notNull().default(''),
  /** Set = private to this agent (its self-built skills); null = shared. */
  agentId: text('agentId'),
  /** JSON ScanReport from a SKILL.md import ('' when not imported): size,
   *  URLs, instruction smells, foreign allowed-tools. Shown on the draft
   *  card before the user can enable the skill (docs/permissions.md). */
  scanReport: text('scanReport').notNull().default(''),
  /** Outcome aggregates (execution-plan item 10): turns that loaded the
   *  skill, and how those turns were rated. */
  useCount: integer('useCount').notNull().default(0),
  upCount: integer('upCount').notNull().default(0),
  downCount: integer('downCount').notNull().default(0),
  lastUsedAt: text('lastUsedAt'),
  /** JSON { instructions, reason, proposedAt, proposedBy } — a revision the
   *  agent proposed after a 👎 (revise_skill); '' when none. Accepting
   *  replaces `instructions`; the previous text goes to `history`. */
  pendingRevision: text('pendingRevision').notNull().default(''),
  /** JSON array of the last 5 { instructions, replacedAt, reason }. */
  history: text('history').notNull().default('[]'),
  createdAt: text('createdAt').notNull(),
});

/** One rating that landed on a turn which had loaded a skill: the raw rows
 *  behind the aggregate counters on `skills`, one per (skill, turn). */
export const skillOutcomes = pgTable('skill_outcomes', {
  id: text('id').primaryKey(),
  skillId: text('skillId').notNull(),
  turnId: text('turnId').notNull(),
  /** up | down. */
  rating: text('rating').notNull(),
  note: text('note').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

export const mcpServers = pgTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  enabled: integer('enabled').notNull().default(1),
  /** JSON array of tool names (informational until the MCP client lands). */
  tools: text('tools').notNull().default('[]'),
  /** OAuth 2.1 state (MCP authorization spec): tokens sealed via secretbox;
   *  endpoints + client credentials cached from RFC 9728/8414 discovery so
   *  refresh never rediscovers. Empty = server needs no auth (or not yet
   *  connected). */
  authAccessToken: text('authAccessToken').notNull().default(''),
  authRefreshToken: text('authRefreshToken').notNull().default(''),
  authExpiresAt: text('authExpiresAt').notNull().default(''),
  authTokenUrl: text('authTokenUrl').notNull().default(''),
  authClientId: text('authClientId').notNull().default(''),
  authClientSecret: text('authClientSecret').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

/** External service connections (docs/integrations.md): user-level OAuth
 *  links to providers (google first). Tokens are sealed via secretbox and
 *  never leave the server. */
export const connections = pgTable('connections', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  accountEmail: text('accountEmail').notNull().default(''),
  /** JSON array of granted OAuth scopes (grows via incremental auth). */
  scopes: text('scopes').notNull().default('[]'),
  accessToken: text('accessToken').notNull().default(''),
  refreshToken: text('refreshToken').notNull().default(''),
  /** ISO expiry of the current access token. */
  expiresAt: text('expiresAt').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

/** Per-agent activation grants for a connection: the connection is creation;
 *  a grant is explicit activation (three-gate model, docs/permissions.md). */
export const connectionGrants = pgTable('connection_grants', {
  id: text('id').primaryKey(),
  connectionId: text('connectionId').notNull(),
  agentId: text('agentId').notNull(),
  /** Which service on the connection this grant covers: calendar | gmail.
   *  Grants are per-service so calendar access never implies mail access. */
  service: text('service').notNull().default('calendar'),
  /** read | write. All gmail tools are write-level (draft/send mutate). */
  level: text('level').notNull().default('read'),
  createdAt: text('createdAt').notNull(),
});

/**
 * Durable agent lessons (docs/agent-memory.md): what distillation learned,
 * as rows rather than prose in a file. LESSONS.md is regenerated from this
 * table so the transparent file brain stays readable and editable, while the
 * machine-readable side gains dedup, ranking, usage counts, and — the point
 * of the exercise — provenance.
 *
 * `trusted` is derived from where the lesson came from, never from its text.
 * App- and channel-originated sessions are untrusted surfaces by design, so
 * what they teach is quarantined until a human promotes it: an injected
 * lesson is an instruction that outlives every turn, which makes this the
 * highest-value injection target in the product.
 */
export const agentLessons = pgTable('agent_lessons', {
  id: text('id').primaryKey(),
  agentId: text('agentId').notNull(),
  text: text('text').notNull(),
  /** chat | loop | channel | app | feedback | import — the surface it was
   *  learned on. `import` rows arrive from another assistant's memory export
   *  and are quarantined like app/channel ones. */
  sourceKind: text('sourceKind').notNull().default('chat'),
  sourceSessionId: text('sourceSessionId'),
  /** 0 = quarantined; never injected until the user promotes it. */
  trusted: integer('trusted').notNull().default(1),
  /** Pinned lessons rank first and never decay. */
  pinned: integer('pinned').notNull().default(0),
  /** Bumped when a duplicate is learned again — the recurrence signal that
   *  makes "value" measurable instead of guessed. */
  useCount: integer('useCount').notNull().default(1),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
});

/** Event-trigger state per loop (docs/triggers.md): the poll/dedupe cursor
 *  for mail and calendar triggers, and the timestamps the loop list shows.
 *  Keyed by `agentId:loopName`; a renamed loop starts a fresh cursor. */
export const loopState = pgTable('loop_state', {
  loopKey: text('loopKey').primaryKey(),
  agentId: text('agentId').notNull(),
  loopName: text('loopName').notNull(),
  /** JSON cursor: mail { ids, baselined }, calendar { events, started, baselined }. */
  cursor: text('cursor').notNull().default('{}'),
  lastPolledAt: text('lastPolledAt'),
  lastFiredAt: text('lastFiredAt'),
  /** When the last poll failure was journaled — one loop_error per hour. */
  lastErrorAt: text('lastErrorAt'),
  updatedAt: text('updatedAt').notNull(),
});

/** App-wide key/value settings: defaultPermissionMode, defaultAgentTypeId, … */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey(),
  sessionId: text('sessionId').notNull(),
  turnId: text('turnId').notNull(),
  seq: integer('seq').notNull(),
  /** user | assistant | tool | thinking (FR-5.1). */
  role: text('role').notNull(),
  content: text('content').notNull().default(''),
  toolName: text('toolName'),
  createdAt: text('createdAt').notNull(),
});

/** Desktop computer control (docs/computer-control.md): the one paired
 *  companion runner. Exactly one row at a time — pairing replaces it, and
 *  Disconnect deletes it, which revokes the token (only its sha256 is here). */
export const computerRunners = pgTable('computer_runners', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** darwin | linux | win32 as the companion reports it. */
  platform: text('platform').notNull().default(''),
  /** JSON string[] of scopes: screen, input, shell, files:<abs dir>. Chosen
   *  on the companion at pair time; the server may only narrow it. */
  scopes: text('scopes').notNull().default('[]'),
  /** sha256 hex of the companion bearer token. */
  tokenHash: text('tokenHash').notNull(),
  /** 1 = paused: pairing kept, every action refused. */
  paused: integer('paused').notNull().default(0),
  pairedAt: text('pairedAt').notNull(),
  lastSeenAt: text('lastSeenAt'),
});

/** Audit row per computer action — the record of everything an agent did
 *  on the user's machine. Written when queued, updated when it settles. */
export const computerActions = pgTable('computer_actions', {
  id: text('id').primaryKey(),
  runnerId: text('runnerId').notNull(),
  sessionId: text('sessionId').notNull().default(''),
  tool: text('tool').notNull(),
  /** One line: the target, never typed text or file content. */
  inputSummary: text('inputSummary').notNull().default(''),
  /** queued | ok | error | timeout | refused */
  status: text('status').notNull().default('queued'),
  /** Bounded first lines of the result or the error message. */
  resultSummary: text('resultSummary').notNull().default(''),
  /** Workspace file path of the screenshot, when one was taken. */
  screenshotPath: text('screenshotPath').notNull().default(''),
  createdAt: text('createdAt').notNull(),
  completedAt: text('completedAt'),
});

/**
 * The market registry (execution-plan item 12, docs/registry.md): published
 * agents, skills and mini apps. `manifest` is the portable artifact itself
 * (AGENT.json v2 minus lessons/tasks/profile, a SKILL.md text, or an app
 * {name, description, html, capabilities}); `capabilities` is the static
 * summary the install review shows and `scanReport` the item-9 scan that ran
 * at publish time. Remote items (pulled from REGISTRY_URL) are never stored
 * here — they live in an in-memory cache — so `source`/`remoteUrl` only
 * record where a locally mirrored item came from.
 */
export const registryItems = pgTable('registry_items', {
  id: text('id').primaryKey(),
  /** Tenancy (item 7): 'single' until accounts exist. */
  accountId: text('accountId').notNull().default('single'),
  /** agent | skill | app. */
  kind: text('kind').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** Bumps on every re-publish of the same (kind, slug). */
  version: integer('version').notNull().default(1),
  publisherName: text('publisherName').notNull().default(''),
  manifest: text('manifest').notNull().default('{}'),
  capabilities: text('capabilities').notNull().default('{}'),
  scanReport: text('scanReport').notNull().default('{}'),
  installs: integer('installs').notNull().default(0),
  ratingUp: integer('ratingUp').notNull().default(0),
  ratingDown: integer('ratingDown').notNull().default(0),
  /** 1 = listed by GET /api/registry/public; 0 = unlisted (kept for installs). */
  published: integer('published').notNull().default(1),
  /** local | remote. */
  source: text('source').notNull().default('local'),
  remoteUrl: text('remoteUrl').notNull().default(''),
  /** The agent/skill/app id this item was published from, for re-publish. */
  sourceRef: text('sourceRef').notNull().default(''),
  publishedAt: text('publishedAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
});

/** One row per install: what was created locally from which item version,
 *  so a rating on the installed agent/skill can roll back up to the item. */
export const registryInstalls = pgTable('registry_installs', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  /** Local item id, or `remote:<id>` for an item pulled from REGISTRY_URL. */
  itemId: text('itemId').notNull(),
  version: integer('version').notNull().default(1),
  agentId: text('agentId'),
  skillId: text('skillId'),
  appId: text('appId'),
  installedAt: text('installedAt').notNull(),
});

/** Ratings: rolled up from turn ratings (turnId set, one per install × turn)
 *  or explicit (POST /api/registry/:id/rate, turnId ''). */
export const registryRatings = pgTable('registry_ratings', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  itemId: text('itemId').notNull(),
  installId: text('installId').notNull().default(''),
  turnId: text('turnId').notNull().default(''),
  /** up | down. */
  rating: text('rating').notNull(),
  note: text('note').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

// ---- autonomous company (docs/autonomous-company.md, execution plan item 14) ----
// Every org table carries accountId ('single' until item 7 lands) so tenancy
// can backfill without a second migration. Scopes and briefs are JSON strings.

/** An organisation: a workspace-scoped container with one human CEO (the
 *  user), one chief-of-staff agent and a roster joined through org_members. */
export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  workspaceId: text('workspaceId').notNull(),
  name: text('name').notNull(),
  mission: text('mission').notNull().default(''),
  /** The CEO's standing note to the company, injected into every org run. */
  ceoUserNote: text('ceoUserNote').notNull().default(''),
  chiefOfStaffAgentId: text('chiefOfStaffAgentId'),
  /** active | paused — paused is the kill switch: no wakes, no runs. */
  status: text('status').notNull().default('active'),
  /** Company envelope in USD per month; 0 = no company-level cap. */
  monthlyBudgetUsd: real('monthlyBudgetUsd').notNull().default(0),
  maxDepth: integer('maxDepth').notNull().default(3),
  maxDirectReports: integer('maxDirectReports').notNull().default(5),
  /** Local hour (workspace timezone) the daily brief is written. */
  briefHour: integer('briefHour').notNull().default(8),
  lastBriefAt: text('lastBriefAt'),
  /** JSON of the latest brief: { text, items: [{ n, approvalId }] }. */
  lastBrief: text('lastBrief').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

export const orgMembers = pgTable('org_members', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  orgId: text('orgId').notNull(),
  agentId: text('agentId').notNull(),
  title: text('title').notNull().default(''),
  /** null only for the chief of staff (depth 1). */
  reportsToAgentId: text('reportsToAgentId'),
  depth: integer('depth').notNull().default(1),
  /** The accountable human; never an agent. */
  sponsor: text('sponsor').notNull().default('user'),
  /** JSON array of scope strings (tool:<name>, connection:<service>:<level>,
   *  skill:<name>, folder:<path>). A hire's scopes are the meet of the
   *  chief's holdings and the request; they can only narrow without approval. */
  scopes: text('scopes').notNull().default('[]'),
  /** active | paused | terminated. */
  status: text('status').notNull().default('active'),
  /** SHA-256 of the agent charter when it was last approved through the
   *  org path; a different live hash is charter drift (docs/security.md). */
  charterHash: text('charterHash').notNull().default(''),
  joinedAt: text('joinedAt').notNull(),
});

export const orgGoals = pgTable('org_goals', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  orgId: text('orgId').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  /** draft | active | achieved | abandoned — set by the CEO, never computed. */
  status: text('status').notNull().default('active'),
  ownerAgentId: text('ownerAgentId'),
  createdAt: text('createdAt').notNull(),
});

export const orgProjects = pgTable('org_projects', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  orgId: text('orgId').notNull(),
  goalId: text('goalId'),
  title: text('title').notNull(),
  /** active | done | cancelled. */
  status: text('status').notNull().default('active'),
  ownerAgentId: text('ownerAgentId'),
  createdAt: text('createdAt').notNull(),
});

/** The shared board. One owner per task; the claim is atomic (org-tasks.service). */
export const orgTasks = pgTable('org_tasks', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  orgId: text('orgId').notNull(),
  projectId: text('projectId'),
  parentTaskId: text('parentTaskId'),
  title: text('title').notNull(),
  /** JSON { outcome, context, constraints, done_when } — the four-field brief. */
  brief: text('brief').notNull().default('{}'),
  /** backlog | todo | claimed | in_progress | in_review | blocked | done | cancelled. */
  status: text('status').notNull().default('backlog'),
  assigneeAgentId: text('assigneeAgentId'),
  /** The run id holding the claim; null = unclaimed. */
  claimedBy: text('claimedBy'),
  claimedAt: text('claimedAt'),
  reviewerAgentId: text('reviewerAgentId'),
  reviewRounds: integer('reviewRounds').notNull().default(0),
  /** JSON array of blocker strings or task ids. */
  blockers: text('blockers').notNull().default('[]'),
  /** JSON array of path prefixes the task may write. */
  fileScope: text('fileScope').notNull().default('[]'),
  noProgressCount: integer('noProgressCount').notNull().default(0),
  lastRunAt: text('lastRunAt'),
  /** user | chief | agent:<id> | trigger | approval. */
  createdBy: text('createdBy').notNull().default('user'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
});

/** One row per wake that became a run. */
export const orgRuns = pgTable('org_runs', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  orgId: text('orgId').notNull(),
  taskId: text('taskId').notNull(),
  agentId: text('agentId').notNull(),
  sessionId: text('sessionId'),
  /** assignment | comment | approval | trigger | manual | review | rewake. */
  wakeReason: text('wakeReason').notNull().default('manual'),
  /** running | done | failed | budget_stop | loop | killed | refused. */
  status: text('status').notNull().default('running'),
  /** progressed | no_progress | blocked | done | '' while running. */
  outcome: text('outcome').notNull().default(''),
  tokensIn: integer('tokensIn').notNull().default(0),
  tokensOut: integer('tokensOut').notNull().default(0),
  usd: real('usd').notNull().default(0),
  reservedUsd: real('reservedUsd').notNull().default(0),
  startedAt: text('startedAt').notNull(),
  endedAt: text('endedAt'),
});

/** Nested monthly envelopes: company → project → agent, USD. */
export const orgBudgets = pgTable('org_budgets', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  orgId: text('orgId').notNull(),
  /** company | agent | project. */
  scope: text('scope').notNull(),
  refId: text('refId').notNull(),
  monthlyUsd: real('monthlyUsd').notNull().default(0),
  reservedUsd: real('reservedUsd').notNull().default(0),
  spentUsd: real('spentUsd').notNull().default(0),
  /** 'YYYY-MM' the counters belong to; a new month resets them. */
  month: text('month').notNull().default(''),
  /** When the 80% warning was last written (one per scope per day). */
  warnedAt: text('warnedAt'),
});

/** Provenance rows behind org_members.scopes: one per scope string in force. */
export const orgGrants = pgTable('org_grants', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  orgId: text('orgId').notNull(),
  agentId: text('agentId').notNull(),
  /** tool | connection | skill | folder. */
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  /** user | chief | approval:<id>. */
  grantedBy: text('grantedBy').notNull().default('user'),
  createdAt: text('createdAt').notNull(),
});

/** Proposals only the user can resolve (controller path, never a tool). */
export const orgApprovals = pgTable('org_approvals', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  orgId: text('orgId').notNull(),
  /** hire | scope_widen | reorg | budget_raise | strategy | external | terminate | escalation. */
  kind: text('kind').notNull(),
  payload: text('payload').notNull().default('{}'),
  /** chief | agent:<id> | user | system. */
  requestedBy: text('requestedBy').notNull().default(''),
  recommendation: text('recommendation').notNull().default(''),
  /** pending | approved | rejected | revision_requested | expired. */
  status: text('status').notNull().default('pending'),
  decidedAt: text('decidedAt'),
  decisionNote: text('decisionNote').notNull().default(''),
  /** Expiry means "not done", never "allowed" (72 h by default). */
  expiresAt: text('expiresAt'),
  createdAt: text('createdAt').notNull(),
});

/** Append-only, SHA-256 hash-chained per org (org-audit.service.ts). */
export const orgAudit = pgTable('org_audit', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  orgId: text('orgId').notNull(),
  seq: integer('seq').notNull(),
  /** user | system | chief | agent:<id>. */
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  refType: text('refType').notNull().default(''),
  refId: text('refId').notNull().default(''),
  payload: text('payload').notNull().default('{}'),
  prevHash: text('prevHash').notNull().default(''),
  hash: text('hash').notNull(),
  createdAt: text('createdAt').notNull(),
});

/** The group session log. Attributed, human-visible, and never a wake. */
export const orgMessages = pgTable('org_messages', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull().default('single'),
  orgId: text('orgId').notNull(),
  /** Set when the message is a task comment (the task timeline). */
  taskId: text('taskId'),
  /** null = the user (CEO). */
  fromAgentId: text('fromAgentId'),
  runId: text('runId'),
  text: text('text').notNull(),
  createdAt: text('createdAt').notNull(),
});
