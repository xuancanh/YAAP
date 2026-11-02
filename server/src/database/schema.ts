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
import { pgTable, text, integer, real, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { accountScoped } from '../accounts/account-context';

export const workspaces = pgTable('workspaces', {
  ...accountScoped(),
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
  /** Per-member private profile sections in a shared workspace: JSON
   *  { [memberAccountId]: "- line\n- line" }. Injected only into turns the
   *  member initiates (docs/shared-agents.md §4). */
  profilePrivate: text('profilePrivate').notNull().default('{}'),
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
  /** Organization mode (docs/group-chat.md §5): off | supervised | autonomous.
   *  The workspace *is* the company; the 1:1 `organizations` row holds the
   *  roster, board and budgets. `off` pauses the runtime and hides the panes
   *  but keeps the data. */
  orgMode: text('orgMode').notNull().default('off'),
  /** The chief of staff agent when organization mode is on. */
  chiefOfStaffAgentId: text('chiefOfStaffAgentId'),
  /** The company envelope in USD per month (mirrors organizations.monthlyBudgetUsd);
   *  autonomous allocations must sum to at most this. 0 = none set. */
  orgMonthlyUsd: real('orgMonthlyUsd').notNull().default(0),
  /** Autonomous mode cap on the number of org members (chief included). */
  orgAgentCap: integer('orgAgentCap').notNull().default(12),
  /** Workspace defaults for every agent's heartbeat (chats/heartbeat-config.ts):
   *  JSON { cron?, dailyRunCap?, staleMinutes? }; '{}' = the built-in
   *  defaults. Per-agent overrides sit on the agent's heartbeat loop. */
  heartbeatDefaults: text('heartbeatDefaults').notNull().default('{}'),
  /** The owner's trust ceilings per action class (migration 0040,
   *  docs/actions-and-trust.md §6): JSON { <class>: 0–3 }; '{}' = the
   *  defaults in actions/trust-policy.ts. */
  trustCeilings: text('trustCeilings').notNull().default('{}'),
  createdAt: text('createdAt').notNull(),
});

export const agents = pgTable('agents', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  /** The owning workspace (migration 0038, execution-plan item 26): an agent
   *  belongs to exactly one workspace and is never shared across them —
   *  moving it is an explicit action (AgentsService.move). '' only for a row
   *  whose account had no workspace at backfill time. */
  workspaceId: text('workspaceId').notNull().default(''),
  name: text('name').notNull(),
  /** Avatar emoji + gradient color pair (JSON [from,to]) for the UI. */
  emoji: text('emoji').notNull().default('\u{1F916}'),
  colors: text('colors').notNull().default('["#8b8cf0","#5cc2f2"]'),
  role: text('role').notNull().default(''),
  /** User-written charter: who this agent is and how it should act (FR-11.1). */
  charter: text('charter').notNull().default(''),
  provider: text('provider').notNull().default('anthropic'),
  model: text('model').notNull().default(''),
  /** The agent type (provider, key, base URL) the agent runs on; its model
   *  field picks the model within it. Null = resolve by provider. */
  agentTypeId: text('agentTypeId'),
  /** The agent's home in its workspace's tree (docs/filesystem.md):
   *  `agents/<handle>`, workspace-relative. The handle is the name slugified
   *  and made unique within the workspace at creation, kept on rename. A
   *  row still at the old default `agents/<id>` (or null) has its brain under
   *  the legacy `agents/<id>/` prefix until the boot migration moves it. */
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
  /** The gated heartbeat (docs/triggers.md "Heartbeat", migration 0034):
   *  on by default for every agent; cadence '' and null caps mean "the
   *  workspace's heartbeatDefaults, then the built-in" (heartbeat-config.ts). */
  heartbeatEnabled: integer('heartbeatEnabled').notNull().default(1),
  heartbeatCron: text('heartbeatCron').notNull().default(''),
  heartbeatDailyRunCap: integer('heartbeatDailyRunCap'),
  heartbeatStaleMinutes: integer('heartbeatStaleMinutes'),
  createdAt: text('createdAt').notNull(),
});

/** Per-agent kanban board (§11): the agent's own work queue. Tasks arrive
 *  from the user, from promoted chat turns, or from the agent itself
 *  (add_task) — often during scheduled loops. */
export const agentTasks = pgTable('agent_tasks', {
  ...accountScoped(),
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
  /** Group chat (docs/group-chat.md §3): the channel message this task was
   *  made from, so status changes post back into its thread. */
  channelId: text('channelId'),
  messageId: text('messageId'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
});

/** The agent inbox (roadmap phase 2): proactive work lands here as
 *  notifications — loop runs, failures, budget stops — so nothing the agent
 *  does unattended is silent. */
export const agentEvents = pgTable('agent_events', {
  ...accountScoped(),
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
  /** Addressed events (docs/shared-agents.md §3): an `approval_request`
   *  routed to the member whose connection the tool would use is visible
   *  to and deliverable for that member only. '' = everyone in the
   *  workspace who may read the inbox. */
  forMemberAccountId: text('forMemberAccountId').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

/** Web Push subscriptions (roadmap phase 4.3): one row per browser that
 *  turned on "Notifications on this device". Endpoint is the push service's
 *  URL (unique); p256dh/auth are the client's RFC 8291 keys. A 404/410 from
 *  the push service deletes the row. */
export const pushSubscriptions = pgTable('push_subscriptions', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('userAgent').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

export const agentTypes = pgTable('agent_types', {
  ...accountScoped(),
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
  ...accountScoped(),
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
  /** tokensIn + tokensOut at the last compaction: the token ceiling counts
   *  only what the chat has used since then, so /compact (or auto-compact)
   *  gives the chat a fresh budget (FR-7.1, FR-7.3). */
  tokensAtCompact: integer('tokensAtCompact').notNull().default(0),
  /** The context the last model call carried (its last round's input +
   *  output, provider-reported). The token ceiling and the chat meter measure
   *  this; auto-compaction keeps it below the ceiling. */
  contextTokens: integer('contextTokens').notNull().default(0),
  /** 'context' (default): tokenCeiling limits one call's context, kept under
   *  by auto-compaction. 'spend': a loop's token budget, cumulative since the
   *  last /clear. */
  ceilingKind: text('ceilingKind').notNull().default('context'),
  /** When this session was last distilled into the agent brain; the idle
   *  sweep skips sessions whose transcript has not changed since. */
  distilledAt: text('distilledAt'),
  /** Shared workspaces (docs/shared-agents.md §5): the member who created
   *  the session ('' = the owner), and whether every member may see it
   *  (1) or only its creator and the owner (0). */
  initiatedBy: text('initiatedBy').notNull().default(''),
  shared: integer('shared').notNull().default(0),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
});

export const chatTurns = pgTable('chat_turns', {
  ...accountScoped(),
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
  /** Degradation (execution-plan item 29): JSON { from, to } when the turn
   *  ran on a fallback provider because its own was degraded; null otherwise. */
  degraded: text('degraded'),
  createdAt: text('createdAt').notNull(),
});

export const skills = pgTable('skills', {
  ...accountScoped(),
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
  ...accountScoped(),
  id: text('id').primaryKey(),
  skillId: text('skillId').notNull(),
  turnId: text('turnId').notNull(),
  /** up | down. */
  rating: text('rating').notNull(),
  note: text('note').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

export const mcpServers = pgTable('mcp_servers', {
  ...accountScoped(),
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
  ...accountScoped(),
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
  ...accountScoped(),
  id: text('id').primaryKey(),
  connectionId: text('connectionId').notNull(),
  agentId: text('agentId').notNull(),
  /** Which service on the connection this grant covers: calendar | gmail.
   *  Grants are per-service so calendar access never implies mail access. */
  service: text('service').notNull().default('calendar'),
  /** read | write. All gmail tools are write-level (draft/send mutate). */
  level: text('level').notNull().default('read'),
  /** Shared workspaces (docs/shared-agents.md): the member whose connection
   *  this grant lets the agent use. '' = the workspace owner's connection
   *  (the default grant); otherwise the member's account id, and the
   *  connection row lives in *that* account. */
  memberAccountId: text('memberAccountId').notNull().default(''),
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
  ...accountScoped(),
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
  /** Who may see it (docs/shared-agents.md §4): 'shared' (every member of
   *  the workspace) or 'private:<memberAccountId>' — learned in that
   *  member's private session or from content that came through their
   *  connection. The digest injects shared rows plus the initiating
   *  member's own, plus whatever a workspace_flow_rules allow row opens. */
  audience: text('audience').notNull().default('shared'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
});

/** Event-trigger state per loop (docs/triggers.md): the poll/dedupe cursor
 *  for mail and calendar triggers, and the timestamps the loop list shows.
 *  Keyed by `agentId:loopName`; a renamed loop starts a fresh cursor. */
export const loopState = pgTable('loop_state', {
  ...accountScoped(),
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

/** The gated heartbeat's state row per agent (docs/triggers.md "Heartbeat",
 *  migration 0034): what the last beat found, when the next is due, and the
 *  day's real-run count that bounds cost. */
export const heartbeatState = pgTable('heartbeat_state', {
  ...accountScoped(),
  agentId: text('agentId').primaryKey(),
  lastBeatAt: text('lastBeatAt'),
  /** The gate's outcome: 'empty', 'quiet', 'cap', 'spend_stop', 'busy', or
   *  the reasons that opened it (newline-joined, bounded). */
  lastReason: text('lastReason').notNull().default(''),
  lastRunAt: text('lastRunAt'),
  nextDueAt: text('nextDueAt'),
  /** Beats that found nothing since the last real run. */
  beatsSkipped: integer('beatsSkipped').notNull().default(0),
  /** UTC day ('YYYY-MM-DD') the run counter belongs to. */
  runsDay: text('runsDay').notNull().default(''),
  runsToday: integer('runsToday').notNull().default(0),
  updatedAt: text('updatedAt').notNull(),
});

/** App-wide key/value settings: defaultPermissionMode, defaultAgentTypeId, … */
export const appSettings = pgTable('app_settings', {
  ...accountScoped(),
  key: text('key').notNull(),
  value: text('value').notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.key] })]);

export const chatMessages = pgTable('chat_messages', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  sessionId: text('sessionId').notNull(),
  turnId: text('turnId').notNull(),
  seq: integer('seq').notNull(),
  /** user | assistant | tool | thinking (FR-5.1). */
  role: text('role').notNull(),
  content: text('content').notNull().default(''),
  toolName: text('toolName'),
  /** The member who wrote a user message ('' = the owner); the UI shows the
   *  name and the model is told it as attribution, never authority. */
  authorAccountId: text('authorAccountId').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

/** Desktop computer control (docs/computer-control.md): the one paired
 *  companion runner. Exactly one row at a time — pairing replaces it, and
 *  Disconnect deletes it, which revokes the token (only its sha256 is here). */
export const computerRunners = pgTable('computer_runners', {
  ...accountScoped(),
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
  ...accountScoped(),
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
  /** A company blueprint install (item 24): the organization it created. */
  orgId: text('orgId'),
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
  /** Intent (docs/company-vision.md §2, item 18): the CEO's standing rules
   *  (the constitution seed) and the chief's latest strategy memo. */
  rules: text('rules').notNull().default(''),
  strategyMemo: text('strategyMemo').notNull().default(''),
  strategyMemoAt: text('strategyMemoAt'),
  /** The operating profile (docs/company-vision.md §1b): values and culture
   *  in the CEO's words, read by every planning prompt; the tunables
   *  column below is read through org-tunables.ts. */
  values: text('values').notNull().default(''),
  culture: text('culture').notNull().default(''),
  /** Assurance (docs/company-vision.md §5): the auditor role — a member on
   *  a different model family where possible — its cadence in days, the USD
   *  cap of one audit run. `tunables` (docs/company-vision.md §1b) is the
   *  JSON { key: number } map of per-org thresholds, SLO targets and pulse
   *  weights over the defaults in org-assurance-tunables.ts (item 18 shares
   *  the column). */
  auditorAgentId: text('auditorAgentId'),
  auditCadenceDays: integer('auditCadenceDays').notNull().default(7),
  auditUsdCap: real('auditUsdCap').notNull().default(2),
  tunables: text('tunables').notNull().default('{}'),
  /** Capital (docs/company-vision.md §7, item 23): model routing by task
   *  class as JSON { classes: { <class>: cheap|standard|strong }, models:
   *  { <tier>: <model id> } }, read through org-routing.ts. */
  routing: text('routing').notNull().default('{}'),
  /** Incidents (execution-plan item 29): JSON array of action classes frozen
   *  workspace-wide by a critical incident's containment, read through
   *  OrgIncidentsService.isFrozen; resolving the incident with undo lifts it. */
  frozenClasses: text('frozenClasses').notNull().default('[]'),
  createdAt: text('createdAt').notNull(),
});

/** A signal (docs/company-vision.md §5.1): a model-free observation about
 *  the company — a stale task, an unowned goal, a burn rate, a breaker trip,
 *  an SLO breach, an auditor finding — addressed to the party that can act
 *  on it. One row per (org, kind, refId, day): it fires once a day and
 *  resolves itself when the condition clears. */
export const orgSignals = pgTable('org_signals', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  unitId: text('unitId'),
  kind: text('kind').notNull(),
  /** info | warn | critical. */
  severity: text('severity').notNull().default('info'),
  refType: text('refType').notNull().default(''),
  refId: text('refId').notNull().default(''),
  title: text('title').notNull(),
  detail: text('detail').notNull().default(''),
  /** owner | lead | chief | ceo — and the agent it reaches (the chief's id
   *  for the CEO, whose inbox is the chief's events). */
  addresseeKind: text('addresseeKind').notNull().default('chief'),
  addresseeId: text('addresseeId').notNull().default(''),
  dayKey: text('dayKey').notNull(),
  /** open | acked | resolved. */
  status: text('status').notNull().default('open'),
  ackNote: text('ackNote').notNull().default(''),
  ackedAt: text('ackedAt'),
  resolvedAt: text('resolvedAt'),
  createdAt: text('createdAt').notNull(),
}, (t) => [uniqueIndex('idx_org_signals_dedup').on(t.orgId, t.kind, t.refId, t.dayKey)]);

/** One SLO sample per org per day (docs/company-vision.md §5.2): the
 *  metrics JSON org-slo.service.ts computes; the pulse's 30-day series. */
export const orgSloSamples = pgTable('org_slo_samples', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  dayKey: text('dayKey').notNull(),
  metrics: text('metrics').notNull().default('{}'),
  createdAt: text('createdAt').notNull(),
}, (t) => [uniqueIndex('idx_org_slo_samples_day').on(t.orgId, t.dayKey)]);

/** An auditor run (docs/company-vision.md §5.3): what it sampled, what it
 *  found, what it cost. Findings are also signals. */
export const orgAudits = pgTable('org_audits', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  auditorAgentId: text('auditorAgentId').notNull(),
  /** cadence | manual. */
  trigger: text('trigger').notNull().default('cadence'),
  startedAt: text('startedAt').notNull(),
  endedAt: text('endedAt'),
  /** JSON { tasks: n, auditRows: n, driftCandidates: n, since }. */
  sampled: text('sampled').notNull().default('{}'),
  /** JSON array of { severity, kind, refType, refId, title, detail }. */
  findings: text('findings').notNull().default('[]'),
  summary: text('summary').notNull().default(''),
  /** 1 when no model family other than the workers' was available. */
  singleModel: integer('singleModel').notNull().default(0),
  model: text('model').notNull().default(''),
  usd: real('usd').notNull().default(0),
  /** running | done | failed | budget_stop. */
  status: text('status').notNull().default('running'),
  /** Audit of the auditor (execution-plan item 29): JSON array of the CEO's
   *  spot-check cards { itemId, kind: finding | pass, refType, refId, title,
   *  agree: boolean | null, note, answeredAt }; precision / recall are the
   *  estimates from every answered card of the org's recent audits, as of the
   *  latest answer on this run (null until one is answered). */
  spotChecks: text('spotChecks').notNull().default('[]'),
  precision: real('precision'),
  recall: real('recall'),
  /** 1 when the auditor seat could not rotate (one eligible candidate). */
  noRotation: integer('noRotation').notNull().default(0),
  createdAt: text('createdAt').notNull(),
});

/** An incident (docs/incidents.md, execution-plan item 29): something went
 *  wrong badly enough to contain — a breaker trip, a failed check after
 *  acceptance, a critical audit finding, a budget hard stop, an external
 *  bounce, a tool-error streak, a degraded provider or connection, a red-team
 *  breach, an owner's complaint. One open row per (org, kind, refId); the
 *  containment steps are recorded so resolving can undo the reversible ones. */
export const orgIncidents = pgTable('org_incidents', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  workspaceId: text('workspaceId').notNull().default(''),
  kind: text('kind').notNull(),
  /** minor | major | critical. */
  severity: text('severity').notNull().default('minor'),
  /** open | contained | resolved. */
  status: text('status').notNull().default('open'),
  title: text('title').notNull(),
  detail: text('detail').notNull().default(''),
  agentId: text('agentId'),
  actionClass: text('actionClass'),
  refType: text('refType').notNull().default(''),
  refId: text('refId').notNull().default(''),
  /** system | auditor | owner | member. */
  detectedBy: text('detectedBy').notNull().default('system'),
  /** JSON array of { action, at, result, reversible, undone? }. */
  containment: text('containment').notNull().default('[]'),
  postmortemMeetingId: text('postmortemMeetingId'),
  openedAt: text('openedAt').notNull(),
  containedAt: text('containedAt'),
  resolvedAt: text('resolvedAt'),
  resolution: text('resolution').notNull().default(''),
}, (t) => [uniqueIndex('idx_org_incidents_open').on(t.orgId, t.kind, t.refId).where(sql`"status" <> 'resolved'`)]);

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
  /** Units (docs/group-chat.md §7): the unit this goal belongs to (null =
   *  the company, i.e. the root unit) and its parent in the goal tree. */
  unitId: text('unitId'),
  parentGoalId: text('parentGoalId'),
  /** Intent (docs/company-vision.md §2, item 18): vision | objective |
   *  key_result. A key result measures `metric` from startValue to
   *  targetValue by dueAt; its owner checks in currentValue and confidence
   *  (0–1, null = never checked in) every checkInCadenceDays. atRisk is set by
   *  the model-free assessment (OrgIntentService.assessRisk) with its reason.
   *  The vision keeps its horizon in dueAt. */
  kind: text('kind').notNull().default('objective'),
  metric: text('metric').notNull().default(''),
  targetValue: real('targetValue'),
  currentValue: real('currentValue'),
  startValue: real('startValue'),
  unitLabel: text('unitLabel').notNull().default(''),
  dueAt: text('dueAt'),
  confidence: real('confidence'),
  atRisk: integer('atRisk').notNull().default(0),
  atRiskReason: text('atRiskReason').notNull().default(''),
  lastCheckInAt: text('lastCheckInAt'),
  checkInCadenceDays: integer('checkInCadenceDays').notNull().default(7),
  /** Sensing (docs/sensing.md, item 27): the metric source a key result reads
   *  its currentValue from — set only from that source's latest sample — and
   *  when it was last measured. Null = self-reported through check-ins. */
  metricSourceId: text('metricSourceId'),
  lastMeasuredAt: text('lastMeasuredAt'),
  /** Value accounting (docs/owners-seat.md §4, item 31): what one unit of
   *  measured movement toward the target is worth in USD, a fixed USD value
   *  realised when the key result is achieved, and the CEO's note. */
  valuePerUnit: real('valuePerUnit'),
  valueOnAchieve: real('valueOnAchieve'),
  valueNote: text('valueNote').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

/** A key result check-in (docs/company-vision.md §2.3): the owner's current
 *  value and confidence at a point in time; the goal row carries the latest. */
export const orgCheckins = pgTable('org_checkins', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  goalId: text('goalId').notNull(),
  /** user | human:<id> | chief | agent:<id>. */
  actor: text('actor').notNull().default('user'),
  currentValue: real('currentValue'),
  confidence: real('confidence'),
  note: text('note').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

/** A unit (docs/group-chat.md §7): every member with at least one direct
 *  report leads one; the root unit is the company (lead = the chief, channel
 *  `#company`). Created and archived automatically with the org chart; one
 *  row per (org, lead) ever, un-archived when the lead gains reports again. */
export const orgUnits = pgTable('org_units', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  leadAgentId: text('leadAgentId').notNull(),
  /** null for the root unit. */
  parentUnitId: text('parentUnitId'),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  /** The unit channel (`#<slug>`); null when the group chat is not bound. */
  channelId: text('channelId'),
  archivedAt: text('archivedAt'),
  createdAt: text('createdAt').notNull(),
}, (t) => [uniqueIndex('idx_org_units_lead').on(t.orgId, t.leadAgentId)]);

/** A meeting (docs/company-vision.md §3, execution-plan item 19): a thread
 *  in a unit channel with a facilitator, an agenda, a round cap, a budget and
 *  the minutes as its required output. `kind` planning | standup |
 *  weekly_review | retro | board | adhoc; `status` scheduled | running | done |
 *  cancelled | postponed. `attendees` is JSON `[{ kind: agent|human, id }]`;
 *  `minutes` is JSON `{ summary, decisions[], actions[], risks[], questions[] }`. */
export const orgMeetings = pgTable('org_meetings', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  unitId: text('unitId'),
  channelId: text('channelId'),
  /** The agenda message: the thread the meeting is. */
  threadRootId: text('threadRootId'),
  kind: text('kind').notNull().default('adhoc'),
  title: text('title').notNull().default(''),
  agenda: text('agenda').notNull().default(''),
  facilitatorAgentId: text('facilitatorAgentId'),
  attendees: text('attendees').notNull().default('[]'),
  status: text('status').notNull().default('scheduled'),
  scheduledFor: text('scheduledFor'),
  startedAt: text('startedAt'),
  endedAt: text('endedAt'),
  rounds: integer('rounds').notNull().default(0),
  usd: real('usd').notNull().default(0),
  minutes: text('minutes').notNull().default(''),
  createdBy: text('createdBy').notNull().default('system'),
  createdAt: text('createdAt').notNull(),
});

/** The decision log (docs/company-vision.md §6): what was decided, the
 *  alternatives, the rationale, who decided, and what it came from
 *  (`refType`/`refId`: meeting, approval, …). Linkable as `#decision:<id>`. */
export const orgDecisions = pgTable('org_decisions', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  unitId: text('unitId'),
  meetingId: text('meetingId'),
  approvalId: text('approvalId'),
  title: text('title').notNull(),
  decision: text('decision').notNull().default(''),
  alternatives: text('alternatives').notNull().default(''),
  rationale: text('rationale').notNull().default(''),
  decidedBy: text('decidedBy').notNull().default(''),
  refType: text('refType').notNull().default(''),
  refId: text('refId').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

/** A ritual's cadence per unit (docs/company-vision.md §3): a five-field
 *  cron (server-local time, like loops), fired by the minute tick. */
export const orgCadences = pgTable('org_cadences', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  unitId: text('unitId').notNull(),
  kind: text('kind').notNull(),
  cron: text('cron').notNull(),
  enabled: integer('enabled').notNull().default(1),
  lastRunAt: text('lastRunAt'),
  nextRunAt: text('nextRunAt'),
  createdAt: text('createdAt').notNull(),
}, (t) => [uniqueIndex('idx_org_cadences_unit_kind').on(t.orgId, t.unitId, t.kind)]);

/** Playbooks (docs/company-vision.md §6, execution-plan item 22): repeatable
 *  procedures agents author for the company as skills (`org-<slug>` in the
 *  org's workspace), reviewed like any task, versioned, offered to roles.
 *  `outcomes` mirrors the skill's item-10 counters for the retro. */
export const orgPlaybooks = pgTable('org_playbooks', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  skillId: text('skillId'),
  name: text('name').notNull(),
  title: text('title').notNull(),
  /** The SKILL.md body of the current (or pending) version. */
  body: text('body').notNull().default(''),
  ownerAgentId: text('ownerAgentId'),
  /** JSON array of titles / role ids it is offered to ('' = everyone). */
  roles: text('roles').notNull().default('[]'),
  /** draft | in_review | active | retired. */
  status: text('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  sourceTaskId: text('sourceTaskId'),
  /** The review task whose acceptance activates this version. */
  reviewTaskId: text('reviewTaskId'),
  /** JSON { uses, up, down, successRate, lastUsedAt, refreshedAt }. */
  outcomes: text('outcomes').notNull().default('{}'),
  why: text('why').notNull().default(''),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
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
  /** Hybrid staff (docs/company-vision.md §4, item 24): a human employee
   *  owning the task; mutually exclusive with assigneeAgentId. */
  assigneeHumanId: text('assigneeHumanId'),
  reviewerHumanId: text('reviewerHumanId'),
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
  /** Group chat (docs/group-chat.md §3): the channel message this task was
   *  made from, so status changes post back into its thread. */
  channelId: text('channelId'),
  messageId: text('messageId'),
  /** Units (docs/group-chat.md §7): the unit board this task sits on. By
   *  default the unit led by the assignee's manager; `unitExplicit = 1` when
   *  a caller named it, so re-assignment does not move it. */
  unitId: text('unitId'),
  unitExplicit: integer('unitExplicit').notNull().default(0),
  /** Capital (docs/company-vision.md §7, item 23): the task class —
   *  triage | research | synthesis | review | ops | general (or another
   *  slug) — set by the creator or derived from the brief by
   *  `deriveTaskClass`; cost roll-ups and model routing read it. */
  class: text('class').notNull().default('general'),
  /** Executable acceptance (docs/sensing.md, item 27): JSON array of
   *  model-free checks (org-checks.ts) that run before review. */
  checks: text('checks').notNull().default('[]'),
  /** How a done task was accepted: '' (not, or set done by hand) | check | review. */
  acceptedBy: text('acceptedBy').notNull().default(''),
  /** Capacity (docs/autonomous-org-first-principles.md C4, item 31): JSON
   *  array of task ids this task waits on (a graph, cycles refused on
   *  write; a task with an unmet dependency is `waiting` and cannot be
   *  claimed) and the deadline the heartbeat ranks urgent work by. */
  dependsOn: text('dependsOn').notNull().default('[]'),
  dueAt: text('dueAt'),
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

/** Capital (docs/company-vision.md §7, item 23): what an envelope buys — an
 *  allocation of USD per month to an objective, with the rationale the
 *  strategy memo states, written alongside the agent/project envelope it
 *  accompanies (`scope`/`refId`). One row per (org, objective). */
export const orgAllocations = pgTable('org_allocations', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  /** The objective. */
  goalId: text('goalId').notNull(),
  unitId: text('unitId'),
  /** The envelope this allocation rides on: company | agent | project, and its id ('' when none). */
  scope: text('scope').notNull().default(''),
  refId: text('refId').notNull().default(''),
  monthlyUsd: real('monthlyUsd').notNull().default(0),
  /** What the money buys (which key results). */
  rationale: text('rationale').notNull().default(''),
  createdBy: text('createdBy').notNull().default('user'),
  createdAt: text('createdAt').notNull(),
}, (t) => [uniqueIndex('idx_org_allocations_goal').on(t.orgId, t.goalId)]);

/** Plan preview with a veto window (docs/company-vision.md §8, §10; item
 *  23): in autonomous mode the structural actions the chief takes during a
 *  planning run or a structure review are collected here instead of
 *  executing; they apply at `applyAt` unless the CEO vetoes. `dry_run` rows
 *  record what the chief would do and apply nothing. */
export const orgPlans = pgTable('org_plans', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  /** vision | objective_assigned | at_risk | manual | sprint | board | daily | dry_run. */
  trigger: text('trigger').notNull().default('manual'),
  summary: text('summary').notNull().default(''),
  /** JSON [{ tool, input, estimateUsd, summary }]. */
  actions: text('actions').notNull().default('[]'),
  estimateUsd: real('estimateUsd').notNull().default(0),
  /** pending | applied | vetoed | expired | dry_run. */
  status: text('status').notNull().default('pending'),
  vetoWindowMinutes: integer('vetoWindowMinutes').notNull().default(30),
  /** JSON [{ tool, ok, output }] once applied (or where it stopped). */
  result: text('result').notNull().default('[]'),
  createdAt: text('createdAt').notNull(),
  applyAt: text('applyAt'),
  appliedAt: text('appliedAt'),
  /** user | human:<id> | system (the tick) | chief. */
  decidedBy: text('decidedBy').notNull().default(''),
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
  /** The human who decided: the account id of the CEO or board member
   *  (docs/autonomous-company.md phase D); '' while pending or when expired. */
  decidedBy: text('decidedBy').notNull().default(''),
  decisionNote: text('decisionNote').notNull().default(''),
  /** Expiry means "not done", never "allowed" (72 h by default). */
  expiresAt: text('expiresAt'),
  /** The decision card (docs/owners-seat.md §1, item 31): the proposer's
   *  recommended answer (approve | deny | modify; `recommendation` is its
   *  one line), alternatives (JSON string[]), reversibility (reversible |
   *  costly | irreversible), confidence 0–1, the deadline and the default
   *  action the tick applies at it ('' = none: the card just expires). */
  recommendedAction: text('recommendedAction').notNull().default(''),
  alternatives: text('alternatives').notNull().default('[]'),
  reversibility: text('reversibility').notNull().default(''),
  confidence: real('confidence'),
  deadline: text('deadline'),
  defaultAction: text('defaultAction').notNull().default(''),
  /** How it was decided: '' (by hand) | default | delegate:<human:id|role:key>. */
  decidedVia: text('decidedVia').notNull().default(''),
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
// ---- shared workspaces (docs/shared-agents.md, execution plan item 8) ----
// Rows belong to the *owning* account (accountId); the member is named by
// memberAccountId — their own account id, which is their identity everywhere.

/** Who may act in a workspace besides its owner, and as what. */
export const workspaceMembers = pgTable('workspace_members', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  memberAccountId: text('memberAccountId').notNull(),
  /** owner | member | viewer. Viewer = read-only; member = chat, tasks,
   *  files; owner = settings, budgets, members, connections of others. */
  role: text('role').notNull().default('member'),
  displayName: text('displayName').notNull().default(''),
  email: text('email').notNull().default(''),
  /** Account id of whoever sent the invite. */
  invitedBy: text('invitedBy').notNull().default(''),
  joinedAt: text('joinedAt').notNull(),
});

/** An outstanding invitation: random token, SHA-256 at rest, 7-day expiry. */
export const workspaceInvites = pgTable('workspace_invites', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  email: text('email').notNull(),
  role: text('role').notNull().default('member'),
  tokenHash: text('tokenHash').notNull(),
  invitedBy: text('invitedBy').notNull().default(''),
  expiresAt: text('expiresAt').notNull(),
  acceptedAt: text('acceptedAt'),
  /** Account that accepted, for the record. */
  acceptedBy: text('acceptedBy').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

/** Information-flow rules (docs/shared-agents.md §4): what one member's
 *  private material may reach another. Default deny; only the owner writes
 *  rows here, through the controller — no agent tool can. */
export const workspaceFlowRules = pgTable('workspace_flow_rules', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  /** Member account id whose material the rule is about. */
  fromMember: text('fromMember').notNull(),
  /** Member account id, or '*' for every member. */
  toMember: text('toMember').notNull().default('*'),
  /** allow | deny (deny rows exist to pin an exception under a '*' allow). */
  effect: text('effect').notNull().default('allow'),
  /** lessons | connections | files. */
  kind: text('kind').notNull(),
  createdAt: text('createdAt').notNull(),
});

/** Per-member channel pairings in a shared workspace: a Telegram chat id or
 *  an email address that means *this member*, so a channel turn belongs to
 *  a person and a routed approval reaches the right phone. */
export const memberChannels = pgTable('member_channels', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  memberAccountId: text('memberAccountId').notNull(),
  /** telegram | email. */
  kind: text('kind').notNull(),
  address: text('address').notNull(),
  createdAt: text('createdAt').notNull(),
});

/** Humans in an organisation (docs/autonomous-company.md phase D). The
 *  workspace owner is the CEO whether or not a row says so; board members
 *  may decide hire | budget_raise | strategy approvals; observers read. */
export const orgHumans = pgTable('org_humans', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  memberAccountId: text('memberAccountId').notNull(),
  /** ceo | board | observer | employee (docs/company-vision.md §4 hybrid staff). */
  role: text('role').notNull().default('observer'),
  /** Employees (item 24): the member they report to — they join that unit's
   *  channel and appear on its chart — and their title. */
  reportsToAgentId: text('reportsToAgentId'),
  title: text('title').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

/** Blueprints (docs/company-vision.md §9, item 24): one row per company
 *  imported from a COMPANY.json, with the two measured milestones a
 *  blueprint is rated by (first key result achieved; first 30 days under the
 *  envelope). `itemId` names the registry item it came from ('' for a file). */
export const orgBlueprintImports = pgTable('org_blueprint_imports', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  workspaceId: text('workspaceId').notNull(),
  itemId: text('itemId').notNull().default(''),
  name: text('name').notNull(),
  /** supervised | autonomous. */
  mode: text('mode').notNull().default('supervised'),
  monthlyUsd: real('monthlyUsd').notNull().default(0),
  /** The `blueprint` approval card the staffing plan waits on (supervised). */
  approvalId: text('approvalId'),
  firstKeyResultAt: text('firstKeyResultAt'),
  envelopeAt: text('envelopeAt'),
  importedAt: text('importedAt').notNull(),
});

/** Anonymous outcome counters on a registry item (item 24): `kind` is
 *  first_key_result | thirty_days_in_envelope; nothing about the company
 *  that reached it travels. Written only when `shareBlueprintOutcomes` is on. */
export const registryOutcomes = pgTable('registry_outcomes', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  itemId: text('itemId').notNull(),
  kind: text('kind').notNull(),
  createdAt: text('createdAt').notNull(),
});

// ---- accounts (docs/accounts.md) ----
// The account infrastructure. `accounts` is the one table without an
// accountId column (its id *is* the account); the other three carry
// `accountId` as a plain foreign key and are read before any account is
// bound, so scoped-db.ts leaves them alone (UNSCOPED_TABLES).

/** One tenant. In AUTH_MODE=single there is exactly one row, id 'single',
 *  created by migration 0023 and owning every pre-tenancy row. */
export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  /** Lowercased, verified by the magic link. '' for the single account. */
  email: text('email').notNull().default(''),
  name: text('name').notNull().default(''),
  /** pending (link requested, never signed in) | active | disabled. */
  status: text('status').notNull().default('pending'),
  /** free | hosted | byo (accounts/plans.ts). */
  plan: text('plan').notNull().default('free'),
  createdAt: text('createdAt').notNull(),
  lastSeenAt: text('lastSeenAt'),
});

/** Browser sessions: the cookie holds a random token, the row its SHA-256. */
export const accountSessions = pgTable('account_sessions', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  tokenHash: text('tokenHash').notNull(),
  expiresAt: text('expiresAt').notNull(),
  userAgent: text('userAgent').notNull().default(''),
  createdAt: text('createdAt').notNull(),
});

/** Magic-link tokens: random, hashed at rest, one use, 15-minute expiry. */
export const accountLoginTokens = pgTable('account_login_tokens', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  email: text('email').notNull(),
  tokenHash: text('tokenHash').notNull(),
  expiresAt: text('expiresAt').notNull(),
  usedAt: text('usedAt'),
  createdAt: text('createdAt').notNull(),
});

/** Monthly rollup per account, written by the turn loop as each turn
 *  settles. Dollars are integer micro-USD so the ceiling comparison is exact.
 *  `hostedUsdMicros` is the part billed to platform keys — the number the
 *  hosted plan's ceiling is checked against. */
export const accountUsage = pgTable('account_usage', {
  accountId: text('accountId').notNull(),
  /** 'YYYY-MM' (UTC). */
  month: text('month').notNull(),
  tokensIn: integer('tokensIn').notNull().default(0),
  tokensOut: integer('tokensOut').notNull().default(0),
  usdMicros: integer('usdMicros').notNull().default(0),
  hostedUsdMicros: integer('hostedUsdMicros').notNull().default(0),
  turns: integer('turns').notNull().default(0),
  updatedAt: text('updatedAt').notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.month] })]);

// ---- group chat (docs/group-chat.md §1, execution-plan item 15) ----

/** A Slack-style channel inside a workspace. `#general` exists in every
 *  workspace; `#company` is created when organization mode is enabled. */
export const channels = pgTable('channels', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  /** URL-safe, unique per workspace (lowercase, [a-z0-9-]). */
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  topic: text('topic').notNull().default(''),
  /** public | private. */
  kind: text('kind').notNull().default('public'),
  /** human:<memberAccountId> | agent:<agentId> | system. */
  createdBy: text('createdBy').notNull().default('system'),
  /** Folder in the workspace store; default channels/<slug>. */
  folder: text('folder').notNull().default(''),
  /** Daily token budget for agent replies in this channel; 0 = the
   *  workspace default setting (channelDailyTokenBudget). */
  dailyTokenBudget: integer('dailyTokenBudget').notNull().default(0),
  archivedAt: text('archivedAt'),
  createdAt: text('createdAt').notNull(),
});

export const channelMembers = pgTable('channel_members', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  channelId: text('channelId').notNull(),
  /** agent | human. */
  memberKind: text('memberKind').notNull(),
  /** The agent id, or the human's actor id (the owner's account id, or a
   *  member's account id). */
  memberId: text('memberId').notNull(),
  /** owner | member. */
  role: text('role').notNull().default('member'),
  /** all | mentions | none — how a human is notified. */
  notify: text('notify').notNull().default('mentions'),
  /** 1 = this agent may reply without being mentioned (§2 step 2). */
  unprompted: integer('unprompted').notNull().default(0),
  joinedAt: text('joinedAt').notNull(),
});

export const channelMessages = pgTable('channel_messages', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  channelId: text('channelId').notNull(),
  /** null = top level; else the id of the thread's root message. */
  threadRootId: text('threadRootId'),
  /** agent | human | system. */
  authorKind: text('authorKind').notNull(),
  authorId: text('authorId').notNull().default(''),
  text: text('text').notNull().default(''),
  /** JSON array of { path, kind } under the channel folder. */
  attachments: text('attachments').notNull().default('[]'),
  /** JSON array of { kind: 'agent' | 'human', id }. */
  mentions: text('mentions').notNull().default('[]'),
  /** The task this message became or reports on. */
  taskId: text('taskId'),
  /** The chat turn (run) that produced an agent reply. */
  runId: text('runId'),
  /** 1 = an unprompted agent reply (§2: never itself a wake trigger). */
  unprompted: integer('unprompted').notNull().default(0),
  editedAt: text('editedAt'),
  createdAt: text('createdAt').notNull(),
});

export const channelReads = pgTable('channel_reads', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  channelId: text('channelId').notNull(),
  memberAccountId: text('memberAccountId').notNull(),
  lastReadMessageId: text('lastReadMessageId').notNull().default(''),
  lastReadAt: text('lastReadAt').notNull(),
});

/** A metric source (docs/sensing.md, item 27): where a number the company
 *  steers by comes from — an HTTP JSON endpoint, a webhook, a connection
 *  query or a human's attestation. Created `pending_approval` when an agent
 *  proposes it; only the CEO activates it, because it defines what counts as
 *  truth. `secrets` holds sealed header values (secretbox), never returned;
 *  `tokenHash` is the SHA-256 of the webhook token. */
export const orgMetricSources = pgTable('org_metric_sources', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  name: text('name').notNull(),
  /** http_json | webhook | connection | manual_attested. */
  kind: text('kind').notNull(),
  config: text('config').notNull().default('{}'),
  secrets: text('secrets').notNull().default('{}'),
  tokenHash: text('tokenHash').notNull().default(''),
  unit: text('unit').notNull().default(''),
  pollMinutes: integer('pollMinutes').notNull().default(60),
  /** pending_approval | ok | error | stale | rejected. */
  status: text('status').notNull().default('pending_approval'),
  lastValue: real('lastValue'),
  lastFetchedAt: text('lastFetchedAt'),
  lastError: text('lastError').notNull().default(''),
  /** Consecutive poll failures (error backoff). */
  failures: integer('failures').notNull().default(0),
  nextPollAt: text('nextPollAt'),
  approvalId: text('approvalId'),
  /** When the CEO (or the approval) made it live; the stale clock starts here. */
  activatedAt: text('activatedAt'),
  /** user | human:<id> | chief | agent:<id>. */
  createdBy: text('createdBy').notNull().default('user'),
  createdAt: text('createdAt').notNull(),
});

/** One reading of a metric source with its provenance (JSON { kind, url |
 *  connection + service + query | by, responseHash, status }). */
export const orgMetricSamples = pgTable('org_metric_samples', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  sourceId: text('sourceId').notNull(),
  value: real('value').notNull(),
  observedAt: text('observedAt').notNull(),
  fetchedAt: text('fetchedAt').notNull(),
  provenance: text('provenance').notNull().default('{}'),
  createdAt: text('createdAt').notNull(),
});

/** The latest result of each check of a task (docs/sensing.md §3). */
export const orgTaskChecks = pgTable('org_task_checks', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  taskId: text('taskId').notNull(),
  checkIndex: integer('checkIndex').notNull(),
  /** pass | fail | error | pending. */
  status: text('status').notNull().default('pending'),
  detail: text('detail').notNull().default(''),
  evidence: text('evidence').notNull().default('{}'),
  ranAt: text('ranAt').notNull(),
});

/** The external-action contract (migration 0040, docs/actions-and-trust.md
 *  §2, execution-plan item 28): one row per non-read tool call, in every
 *  session (private chats, channels, loops, heartbeats, org runs). `key` is
 *  the idempotency key, hash(session, scope, tool, canonical input), unique
 *  per account: a retry of a succeeded outward call inside the dedupe window
 *  returns `result` instead of acting twice. */
export const actionLog = pgTable('action_log', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  key: text('key').notNull(),
  workspaceId: text('workspaceId').notNull(),
  /** '' for a session with no durable agent. */
  agentId: text('agentId').notNull().default(''),
  sessionId: text('sessionId').notNull(),
  orgId: text('orgId'),
  tool: text('tool').notNull(),
  /** read | internal_write | external_reversible | external_irreversible | money. */
  class: text('class').notNull(),
  /** The outbound channel for the rate limit (gmail, gcal, browser, mcp_<server>, …). */
  channel: text('channel').notNull().default(''),
  inputHash: text('inputHash').notNull(),
  /** The call's input (JSON, bounded) — what a held action runs on the owner's key. */
  input: text('input').notNull().default('{}'),
  /** started | succeeded | failed | held | staged | refused | denied. */
  status: text('status').notNull().default('started'),
  /** The policy decision (trust-policy.ts TrustDecision) or the legacy verdict. */
  decision: text('decision').notNull().default(''),
  /** The effective trust level the decision was made at; null = no ledger (no agent). */
  level: integer('level'),
  /** JSON { owner?: {by, approve, at}, agent?: {agentId, family, verdict, reason, model}, singleFamily? }. */
  keys: text('keys').notNull().default('{}'),
  /** The staged twin's reference (a draft id) while status = staged. */
  stagedRef: text('stagedRef').notNull().default(''),
  result: text('result').notNull().default(''),
  resultHash: text('resultHash').notNull().default(''),
  /** Retries answered from the record instead of re-executing. */
  dedupeCount: integer('dedupeCount').notNull().default(0),
  /** The owner reported this action reverted (POST …/actions/:id/revert-report). */
  revertedAt: text('revertedAt'),
  note: text('note').notNull().default(''),
  createdAt: text('createdAt').notNull(),
  finishedAt: text('finishedAt'),
}, (t) => [uniqueIndex('idx_action_log_key').on(t.accountId, t.key)]);

/** The trust ledger's evidence (C10): one row per outcome that counts for a
 *  member in an action class. Append-only. */
export const trustRecords = pgTable('trust_records', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  agentId: text('agentId').notNull(),
  actionClass: text('actionClass').notNull(),
  /** success | reverted | rejected | incident | deduplicated. */
  outcome: text('outcome').notNull(),
  /** action | task | incident | override. */
  refType: text('refType').notNull().default(''),
  refId: text('refId').notNull().default(''),
  at: text('at').notNull(),
});

/** The trust ledger's state: one level per (workspace, agent, class), 0–3,
 *  under the owner's ceiling. */
export const trustLevels = pgTable('trust_levels', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  agentId: text('agentId').notNull(),
  actionClass: text('actionClass').notNull(),
  level: integer('level').notNull().default(0),
  ceiling: integer('ceiling').notNull().default(0),
  /** Clean outcomes since the last level change (promotion counter). */
  cleanCount: integer('cleanCount').notNull().default(0),
  /** Rejections in a row (demotion counter). */
  rejectStreak: integer('rejectStreak').notNull().default(0),
  lastIncidentAt: text('lastIncidentAt'),
  lastChangedAt: text('lastChangedAt'),
  reason: text('reason').notNull().default(''),
  createdAt: text('createdAt').notNull(),
}, (t) => [uniqueIndex('idx_trust_levels_unique').on(t.workspaceId, t.agentId, t.actionClass)]);

/** An experiment (docs/experiments.md §1, execution-plan item 30; C5 of
 *  docs/autonomous-org-first-principles.md): a change declared as a
 *  hypothesis with a measured metric (a metric source), a direction and an
 *  expected effect, a window and a revert rule. `change` is JSON
 *  `{ apply, revert }` — what the system applies at start and the recipe it
 *  executes to undo it (snapshotted at start). `baseline` and `result` are
 *  computed from samples only: `{ mean, n, sd?, from, to }` and
 *  `{ mean, n, delta, relative, threshold, verdict }`. */
export const orgExperiments = pgTable('org_experiments', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  unitId: text('unitId'),
  title: text('title').notNull(),
  hypothesis: text('hypothesis').notNull().default(''),
  /** tunable | cadence | routing | playbook | charter | structure | other. */
  changeKind: text('changeKind').notNull(),
  change: text('change').notNull().default('{}'),
  /** Required for every kind but `other`; a key result's source qualifies. */
  metricSourceId: text('metricSourceId'),
  /** up | down: which way is better. */
  direction: text('direction').notNull().default('up'),
  expectedEffect: real('expectedEffect').notNull().default(0),
  /** relative (0.2 = +20 %) | absolute (in the metric's unit). */
  effectKind: text('effectKind').notNull().default('relative'),
  windowDays: integer('windowDays').notNull().default(14),
  /** before_after | slice. */
  design: text('design').notNull().default('before_after'),
  slice: text('slice').notNull().default('{}'),
  baseline: text('baseline').notNull().default('{}'),
  result: text('result').notNull().default('{}'),
  /** proposed | running | extended | kept | reverted | abandoned. */
  status: text('status').notNull().default('proposed'),
  /** JSON { worseBy, relative }: worse than baseline by more than this → revert at once. */
  revertRule: text('revertRule').notNull().default('{}'),
  extensions: integer('extensions').notNull().default(0),
  /** user | human:<id> | chief | agent:<id>. */
  proposedBy: text('proposedBy').notNull().default('user'),
  /** The `experiment` card that let it start (supervised mode). */
  approvalId: text('approvalId'),
  /** A charter / structure experiment's change card (the existing approval path). */
  changeApprovalId: text('changeApprovalId'),
  startedAt: text('startedAt'),
  endsAt: text('endsAt'),
  /** The last daily early-stop check. */
  lastCheckAt: text('lastCheckAt'),
  decidedAt: text('decidedAt'),
  decisionId: text('decisionId'),
  createdAt: text('createdAt').notNull(),
});

/** A forecast in the prediction ledger (docs/experiments.md §2, C7):
 *  `forecast` JSON `{ kind: number | probability | duration_runs | date,
 *  value, low?, high?, unit? }`, resolved model-free into `outcome` and a
 *  `score` — a loss in 0–1 (Brier for probabilities, normalized absolute
 *  error otherwise). */
export const orgPredictions = pgTable('org_predictions', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  agentId: text('agentId').notNull(),
  /** task | key_result | experiment | hire | other. */
  subjectKind: text('subjectKind').notNull(),
  subjectId: text('subjectId').notNull().default(''),
  question: text('question').notNull().default(''),
  forecast: text('forecast').notNull().default('{}'),
  /** tool | checkin | experiment. */
  origin: text('origin').notNull().default('tool'),
  resolvesAt: text('resolvesAt'),
  outcome: text('outcome').notNull().default('{}'),
  resolvedAt: text('resolvedAt'),
  score: real('score'),
  /** open | resolved | void. */
  status: text('status').notNull().default('open'),
  createdAt: text('createdAt').notNull(),
});

/** A golden-set case (docs/evals.md, execution-plan item 31, C6): a past
 *  task with a known-good outcome for one role, harvested from work
 *  accepted by check or accepted by review on the first round, or added by
 *  the CEO. `taskSnapshot` is JSON { title, brief, checks, class, inputs };
 *  `expected` is JSON { checks: Check[], rubric }. */
export const orgEvalCases = pgTable('org_eval_cases', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  /** The member title slug (or a role id) the case belongs to. */
  roleKey: text('roleKey').notNull(),
  taskSnapshot: text('taskSnapshot').notNull().default('{}'),
  expected: text('expected').notNull().default('{}'),
  sourceTaskId: text('sourceTaskId'),
  /** check | review | manual. */
  source: text('source').notNull().default('manual'),
  createdAt: text('createdAt').notNull(),
  retiredAt: text('retiredAt'),
});

/** One replay of a role's golden set against a candidate (or the current
 *  configuration, `kind = baseline`, cached per `versionHash`). */
export const orgEvalRuns = pgTable('org_eval_runs', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  roleKey: text('roleKey').notNull(),
  /** candidate | baseline. */
  kind: text('kind').notNull().default('candidate'),
  /** JSON { kind: charter|playbook|model|routing, ref, before, after }. */
  candidate: text('candidate').notNull().default('{}'),
  versionHash: text('versionHash').notNull().default(''),
  /** JSON array of case ids. */
  cases: text('cases').notNull().default('[]'),
  /** JSON [{ caseId, pass, detail, usd, gradedBy }]. */
  results: text('results').notNull().default('[]'),
  passRate: real('passRate'),
  baselinePassRate: real('baselinePassRate'),
  baselineRunId: text('baselineRunId'),
  /** pass | regress | inconclusive ('' while running). */
  verdict: text('verdict').notNull().default(''),
  usd: real('usd').notNull().default(0),
  /** What asked for it: user | chief | gate:<kind>:<ref>. */
  requestedBy: text('requestedBy').notNull().default('user'),
  startedAt: text('startedAt').notNull(),
  endedAt: text('endedAt'),
  /** running | done | failed. */
  status: text('status').notNull().default('running'),
});

/** A delegated approval (docs/owners-seat.md §2): cards of `kind` (an
 *  approval kind or an action class), optionally up to `maxUsd`, may be
 *  decided by a human member or an agent role instead of the CEO. */
export const orgDelegations = pgTable('org_delegations', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  kind: text('kind').notNull(),
  maxUsd: real('maxUsd'),
  /** human | role. */
  delegateType: text('delegateType').notNull(),
  /** A member account id (human) or a role key / member title (role). */
  delegateRef: text('delegateRef').notNull(),
  createdBy: text('createdBy').notNull().default('user'),
  createdAt: text('createdAt').notNull(),
  revokedAt: text('revokedAt'),
});

/** Value realised (docs/owners-seat.md §4): one row per measured movement of
 *  a valued key result (from a metric sample) or per achievement. */
export const orgValueEvents = pgTable('org_value_events', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  goalId: text('goalId').notNull(),
  objectiveId: text('objectiveId'),
  unitId: text('unitId'),
  /** movement | achieved. */
  kind: text('kind').notNull().default('movement'),
  sampleId: text('sampleId'),
  fromValue: real('fromValue'),
  toValue: real('toValue'),
  /** Movement toward the target (signed). */
  delta: real('delta').notNull().default(0),
  valueUsd: real('valueUsd').notNull().default(0),
  at: text('at').notNull(),
  createdAt: text('createdAt').notNull(),
}, (t) => [uniqueIndex('idx_org_value_events_ref').on(t.goalId, t.kind, t.sampleId)]);

/** File metadata for the workspace filesystem (docs/filesystem.md
 *  "Collaboration", migration 0047): one row per file written through
 *  WorkspaceFs. `version` starts at 1 and bumps on every write — the
 *  optimistic-concurrency token fs_write/fs_edit and the editor send back as
 *  `expectedVersion`. Objects written outside WorkspaceFs have no row. */
export const workspaceFiles = pgTable('workspace_files', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  /** Workspace-relative, no leading slash. */
  path: text('path').notNull(),
  version: integer('version').notNull().default(1),
  size: integer('size').notNull().default(0),
  contentType: text('contentType').notNull().default(''),
  /** user | agent | system. */
  updatedByKind: text('updatedByKind').notNull().default('system'),
  updatedById: text('updatedById').notNull().default(''),
  updatedByName: text('updatedByName').notNull().default(''),
  updatedAt: text('updatedAt').notNull(),
  createdByKind: text('createdByKind').notNull().default('system'),
  createdById: text('createdById').notNull().default(''),
  createdAt: text('createdAt').notNull(),
}, (t) => [uniqueIndex('idx_workspace_files_path').on(t.workspaceId, t.path)]);

/** A kept previous body of a file (docs/filesystem.md "Revisions"): the
 *  bytes live at `workspaces/<ws>/.revisions/<sha1(path)>/<version>`; the
 *  author fields are whoever wrote that version. The newest 20 per file. */
export const workspaceFileRevisions = pgTable('workspace_file_revisions', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  path: text('path').notNull(),
  version: integer('version').notNull(),
  size: integer('size').notNull().default(0),
  updatedByKind: text('updatedByKind').notNull().default('system'),
  updatedById: text('updatedById').notNull().default(''),
  updatedByName: text('updatedByName').notNull().default(''),
  updatedAt: text('updatedAt').notNull(),
}, (t) => [uniqueIndex('idx_workspace_file_revisions_version').on(t.workspaceId, t.path, t.version)]);

/** Follows (docs/follows.md, migration 0048): an agent or a person follows a
 *  channel thread (`targetId` = the root message id), an org task or an
 *  agent kanban task. Auto-follow writes `reason` (started, commented, owner,
 *  assignee, reviewer, mentioned); a manual follow writes `manual`. An
 *  unfollow sets `mutedAt` and keeps the row, so auto-follow never
 *  resubscribes. The activity columns are the follower's compact "new since
 *  you last looked": how many updates (`unseenCount`), the latest one and
 *  who made it, and `attentionAt` when one of them needs the follower
 *  (blocked, review requested, reopened, a comment naming it) — the
 *  heartbeat's follow reason reads that, debounced through `wokeAt`.
 *  `closedAt` is when the target closed (done / cancelled / abandoned). */
export const follows = pgTable('follows', {
  ...accountScoped(),
  id: text('id').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  /** agent | user. */
  followerKind: text('followerKind').notNull(),
  followerId: text('followerId').notNull(),
  /** thread | org_task | agent_task. */
  targetKind: text('targetKind').notNull(),
  targetId: text('targetId').notNull(),
  /** started | commented | owner | assignee | reviewer | mentioned | manual. */
  reason: text('reason').notNull().default('manual'),
  title: text('title').notNull().default(''),
  /** SPA deep link (`#/ws/…`) for notifications. */
  link: text('link').notNull().default(''),
  createdAt: text('createdAt').notNull(),
  mutedAt: text('mutedAt'),
  lastSeenAt: text('lastSeenAt'),
  unseenCount: integer('unseenCount').notNull().default(0),
  lastActivityAt: text('lastActivityAt'),
  lastActivity: text('lastActivity').notNull().default(''),
  lastActorName: text('lastActorName').notNull().default(''),
  attentionAt: text('attentionAt'),
  attention: text('attention').notNull().default(''),
  wokeAt: text('wokeAt'),
  closedAt: text('closedAt'),
}, (t) => [uniqueIndex('idx_follows_unique').on(t.followerKind, t.followerId, t.targetKind, t.targetId)]);
