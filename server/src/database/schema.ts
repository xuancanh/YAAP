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
  createdAt: text('createdAt').notNull(),
});

export const agents = pgTable('agents', {
  ...accountScoped(),
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
  /** Units (docs/group-chat.md §7): the unit this goal belongs to (null =
   *  the company, i.e. the root unit) and its parent in the goal tree. */
  unitId: text('unitId'),
  parentGoalId: text('parentGoalId'),
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
  /** Group chat (docs/group-chat.md §3): the channel message this task was
   *  made from, so status changes post back into its thread. */
  channelId: text('channelId'),
  messageId: text('messageId'),
  /** Units (docs/group-chat.md §7): the unit board this task sits on. By
   *  default the unit led by the assignee's manager; `unitExplicit = 1` when
   *  a caller named it, so re-assignment does not move it. */
  unitId: text('unitId'),
  unitExplicit: integer('unitExplicit').notNull().default(0),
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
  /** The human who decided: the account id of the CEO or board member
   *  (docs/autonomous-company.md phase D); '' while pending or when expired. */
  decidedBy: text('decidedBy').notNull().default(''),
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
  /** ceo | board | observer. */
  role: text('role').notNull().default('observer'),
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
