/**
 * Action classes — the external-action contract's first half
 * (docs/actions-and-trust.md §1, docs/autonomous-org-first-principles.md C2,
 * execution-plan item 28).
 *
 * Every tool call is classed by reversibility and blast radius, and autonomy
 * is granted per class (principle 3), never per organization:
 *
 *   read                   nothing changes anywhere
 *   internal_write         changes the workspace only (files, boards, org records, the sandbox)
 *   external_reversible    leaves the workspace but can be undone or never reached anyone yet (a draft, an event with no guests, a click)
 *   external_irreversible  reaches another person or system for good (a sent email, an invite, the user's own computer)
 *   money                  moves money
 *
 * One registry, pure and model-free. Exact names first, then families by
 * prefix, then the owner's read-only flag for provider tools (org, channel,
 * meeting); anything left is UNKNOWN and fails safe to `external_reversible`
 * (the boot warning lists them so the registry is kept honest). `classOf` is
 * input-aware where it matters: a calendar event with guests outside the
 * owner's domains is an invitation, which is irreversible.
 */
import { createHash } from 'node:crypto';

export const ACTION_CLASSES = ['read', 'internal_write', 'external_reversible', 'external_irreversible', 'money'] as const;
export type ActionClass = typeof ACTION_CLASSES[number];

export function isActionClass(x: unknown): x is ActionClass {
  return typeof x === 'string' && (ACTION_CLASSES as readonly string[]).includes(x);
}

/** The classes whose calls leave the workspace. */
export const EXTERNAL_CLASSES: readonly ActionClass[] = ['external_reversible', 'external_irreversible', 'money'];
/** The classes that need a second key below level 3 (two-key execution). */
export const TWO_KEY_CLASSES: readonly ActionClass[] = ['external_irreversible', 'money'];

type Classifier = ActionClass | ((input: Record<string, unknown>, ctx: ClassContext) => ActionClass);

export interface ClassContext {
  /** The owner's own mail domains (their connections' addresses): guests on
   *  these domains are colleagues, not an outward invitation. */
  ownDomains?: string[];
}

/** Calendar writes: an event with a guest outside the owner's domains sends
 *  an invitation (irreversible); one without guests stays on the owner's own
 *  calendar and can be deleted (reversible). Today's calendar tools take no
 *  attendees, so they class as reversible until one does. */
function calendarWrite(input: Record<string, unknown>, ctx: ClassContext): ActionClass {
  const raw = input.attendees ?? input.guests ?? input.invitees;
  const list = Array.isArray(raw) ? raw.map((x) => {
    if (typeof x === 'string') return x;
    const email = (x as { email?: unknown } | null)?.email;
    return typeof email === 'string' ? email : '';
  })
    : typeof raw === 'string' ? raw.split(',') : [];
  const own = new Set((ctx.ownDomains ?? []).map((d) => d.toLowerCase()));
  const external = list.map((x) => x.trim().toLowerCase()).filter(Boolean).filter((addr) => {
    const domain = addr.split('@')[1] ?? '';
    return !domain || !own.has(domain);
  });
  return external.length > 0 ? 'external_irreversible' : 'external_reversible';
}

/** Exact tool names. Keep in step with the tool owners (tools.service.ts,
 *  connections.tools.ts, runner, browser, computer, the agent tools in
 *  turn-loop.service.ts); the boot warning names what is missing. */
export const TOOL_CLASSES: Record<string, Classifier> = {
  // core tools (chats/tools.service.ts)
  fs_list: 'read', fs_read: 'read', fs_search: 'read', web_search: 'read', web_fetch: 'read',
  fs_write: 'internal_write', fs_edit: 'internal_write', fs_append: 'internal_write', fs_delete: 'internal_write', fs_restore: 'internal_write', slides_create: 'internal_write',
  // an arbitrary HTTP call can POST anywhere: outward, and nothing says it can be undone
  http_request: 'external_reversible',
  // agent self-maintenance tools (turn-loop.service.ts AGENT_TOOLS)
  list_tasks: 'read', search_history: 'read',
  update_dashboard: 'internal_write', save_app: 'internal_write', add_task: 'read', update_task: 'read',
  delegate_task: 'internal_write', save_tool: 'internal_write', draft_skill: 'internal_write', revise_skill: 'internal_write',
  update_user_profile: 'internal_write',
  // the trust ledger's own read tool
  trust_status: 'read',
  // generic change records (plugins/changes.service.ts, docs/plugins.md §4.8):
  // reading a record, and asking for the apply gate (a record moves to
  // `gated`; nothing outside the workspace changes)
  change_status: 'read', change_list: 'read', change_request_apply: 'internal_write',
  // follows (follows/follows.tools.ts): only the agent's own follow rows change — free, no approval
  follow: 'read', unfollow: 'read', list_follows: 'read',
  // chat auto-archive (chats/chat-archive.service.ts): only the agent's own chats' setting changes — free, no approval
  set_chat_auto_archive: 'read',
  // code runner: a sandbox with no credentials; the workspace is what it writes
  run_js: 'internal_write', run_python: 'internal_write',
  // coding-agent CLIs (harness/harness.service.ts): execute code like run_js, in
  // a temp copy of a workspace folder, syncing back through WorkspaceFs — kept
  // gated (never in FREE_INTERNAL_TOOLS); the owner's per-agent opt-in is the
  // provider's runsFreely, not this registry
  code_agent: 'internal_write',
  // browser (credential-free, incognito per turn): reads read; a click or keystroke can submit a form
  browser_open: 'read', browser_read: 'read', browser_screenshot: 'read', browser_act: 'external_reversible',
  // Google connections (connections.tools.ts)
  gcal_upcoming: 'read', gcal_search: 'read', gcal_freebusy: 'read',
  gcal_create_event: calendarWrite, gcal_update_event: calendarWrite,
  gmail_draft: 'external_reversible', gmail_send: 'external_irreversible',
  drive_search: 'read', drive_read: 'read', drive_export_doc: 'external_reversible', drive_export_sheet: 'external_reversible',
  // Microsoft connections
  mscal_upcoming: 'read', mscal_search: 'read',
  mscal_create_event: calendarWrite, mscal_update_event: calendarWrite,
  msmail_draft: 'external_reversible', msmail_send: 'external_irreversible',
  msdrive_search: 'read', msdrive_read: 'read', msdrive_export_doc: 'external_reversible', msdrive_export_sheet: 'external_reversible',
};

/**
 * Internal, reversible work that runs freely for every agent and every chat
 * (docs/permissions.md §8 "Agent file and workspace operations"): no Ask
 * pause, no trust-ledger ask or hold, no co-signer, no action reviewer. The
 * action log still records each call (decision `free`), the ledger still
 * counts it, and an incident freeze of `internal_write` still holds it.
 *
 * - File writes go through WorkspaceFs, whose permission table is the gate
 *   (own home and shared folders rw; other agents' homes, `.checkpoints/`
 *   and `.revisions/` refused) and whose revisions make every overwrite and
 *   delete restorable.
 * - Agent self-maintenance writes only the agent's own records, or queues a
 *   proposal whose activation is a separate human review (skills, tools,
 *   profile facts, elevated mini-app capabilities).
 * - Work-record tools write the organization's own board, goals, check-ins
 *   and timelines — internal, attributed and audited, undone by the next update.
 *
 * Every name here must class as `internal_write` or `read`; outward,
 * irreversible, money, computer, MCP, browser, code-execution and governance
 * tools (structure, scopes, budgets, routing, tunables, playbooks, evals —
 * boundary.ts) are never in it.
 */
export const WORKSPACE_FILE_WRITES: ReadonlySet<string> = new Set(['fs_write', 'fs_edit', 'fs_append', 'fs_delete', 'fs_restore', 'slides_create']);
export const FREE_INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  ...WORKSPACE_FILE_WRITES,
  // agent self-maintenance and proposals (turn-loop.service.ts AGENT_TOOLS)
  'update_dashboard', 'save_app', 'delegate_task', 'add_task', 'update_task',
  'draft_skill', 'revise_skill', 'save_tool', 'update_user_profile', 'set_chat_auto_archive',
  // the organization's work record (board, goals, check-ins, timelines, reviews)
  'org_message', 'org_create_task', 'org_assign', 'org_task_update', 'org_task_comment',
  'org_request_review', 'org_review', 'org_escalate', 'org_check_in', 'org_set_goal', 'org_set_key_result',
  'org_ack_signal', 'org_report', 'org_strategy_memo', 'org_report_incident', 'org_forecast_outcome',
  // group chat: a task from a channel message
  'channel_make_task',
]);

/** Whether a call is internal, reversible work that runs without a gate. */
export function runsFreely(toolName: string): boolean {
  return FREE_INTERNAL_TOOLS.has(toolName);
}

/** Tool families by prefix, after exact names. The computer acts on the
 *  user's own machine: every computer tool is irreversible (and refused
 *  outright from loop and channel turns before any class is consulted). */
const FAMILIES: Array<{ prefix: string; cls: ActionClass }> = [
  { prefix: 'computer_', cls: 'external_irreversible' },
  // skills only load instructions
  { prefix: 'skill_', cls: 'read' },
  // the agent's own HTTP tools: an outward call to a literal host
  { prefix: 'tool_', cls: 'external_reversible' },
];

/** Families whose owner's read-only flag decides read vs internal_write
 *  (org, channel and meeting tools change only the workspace's records). */
const INTERNAL_FAMILIES = ['org_', 'channel_', 'meeting_', 'meetings'];

export const MCP_PREFIX = 'mcp_';
/** Payment-like tool names (none ship today; an MCP or custom tool named like
 *  this is classed as money whatever its family). */
const MONEY_RE = /(?:^|_)(pay|payment|payout|charge|refund|transfer|invoice_send|purchase|buy|checkout|stripe_charge)(?:_|$)/;

/** Whether a name reads like a money-moving action (the generic money floor). */
export function isMoneyName(name: string): boolean {
  return MONEY_RE.test(name);
}

export interface ClassHint {
  /** The owning provider's read-only flag (org/channel/meeting tools, MCP annotations). */
  readOnly?: boolean;
}

/**
 * Interface operations (docs/plugins.md §4.3): the plugin mechanism
 * registers one lookup from a model-facing operation name to its static
 * effective class — the maximum of the core's generic floors, the
 * interface's class and the provider's raise — built from the installed
 * interface versions. Unknown names answer null. Owner policies are
 * per-workspace and raise the call further in the policy stage.
 */
export type OperationClassLookup = (toolName: string, input: Record<string, unknown>) => ActionClass | null;
const OPERATION_LOOKUPS: OperationClassLookup[] = [];

export function registerOperationClasses(fn: OperationClassLookup): () => void {
  OPERATION_LOOKUPS.push(fn);
  return () => { const i = OPERATION_LOOKUPS.indexOf(fn); if (i >= 0) OPERATION_LOOKUPS.splice(i, 1); };
}

/** The strictest class any registered lookup gives the name; null when none knows it. */
function operationClass(toolName: string, input: Record<string, unknown>): ActionClass | null {
  let best: ActionClass | null = null;
  for (const fn of OPERATION_LOOKUPS) {
    let c: ActionClass | null;
    try { c = fn(toolName, input); } catch { c = 'external_reversible'; }
    if (c && (best === null || ACTION_CLASSES.indexOf(c) > ACTION_CLASSES.indexOf(best))) best = c;
  }
  if (best && MONEY_RE.test(toolName)) return 'money';
  return best;
}

/**
 * The class of one call. `hint.readOnly` is the owner's own flag where the
 * registry defers to it (provider families) or where the server declared it
 * (an MCP tool annotated `readOnlyHint`).
 */
export function classOf(toolName: string, input: Record<string, unknown> = {}, hint: ClassHint = {}, ctx: ClassContext = {}): ActionClass {
  const exact = TOOL_CLASSES[toolName];
  if (exact) return typeof exact === 'function' ? exact(input, ctx) : exact;
  const op = operationClass(toolName, input);
  if (op) return op;
  if (MONEY_RE.test(toolName)) return 'money';
  for (const f of FAMILIES) if (toolName.startsWith(f.prefix)) return f.cls;
  if (toolName.startsWith(MCP_PREFIX)) return hint.readOnly === true ? 'read' : 'external_reversible';
  if (INTERNAL_FAMILIES.some((p) => toolName.startsWith(p))) return hint.readOnly === true ? 'read' : 'internal_write';
  return 'external_reversible';
}

/** An action class from what an emitter put in an incident or a freeze:
 *  a class name passes through; a tool name (`gmail_send`, as connection
 *  incidents write it) maps through `classOf`; an empty value is null. */
export function normalizeActionClass(x: string | null | undefined): ActionClass | null {
  if (!x) return null;
  if (isActionClass(x)) return x;
  return classOf(x);
}

/** Whether the registry knows the name (exact or by family). */
export function isClassified(toolName: string): boolean {
  if (TOOL_CLASSES[toolName]) return true;
  if (operationClass(toolName, {})) return true;
  if (MONEY_RE.test(toolName)) return true;
  return [...FAMILIES.map((f) => f.prefix), MCP_PREFIX, ...INTERNAL_FAMILIES].some((p) => toolName.startsWith(p));
}

/** The names among `names` that fall through to the fail-safe default. */
export function unclassified(names: Iterable<string>): string[] {
  return [...new Set(names)].filter((n) => !isClassified(n)).sort();
}

/** The outbound channel a call spends, for the per-channel rate limit: the
 *  tool's family (gmail, gcal, drive, msmail, …, browser, the MCP server). */
export function channelOf(toolName: string): string {
  if (toolName.startsWith(MCP_PREFIX)) return toolName.split('_').slice(0, 2).join('_');
  if (toolName.startsWith('tool_')) return toolName;
  const head = toolName.split('_')[0];
  return head || toolName;
}

/**
 * Staging twins (docs/actions-and-trust.md §3): the outward action prepared
 * where the medium allows it, for an owner (or a higher trust level) to
 * promote. `implemented` twins convert and promote end to end today; the
 * others are declared so the policy knows a stage exists, and fall back to an
 * owner key until their promotion path is built.
 */
export interface StagingTwin { twin: string; implemented: boolean; note: string }

export const STAGING: Record<string, StagingTwin> = {
  gmail_send: { twin: 'gmail_draft', implemented: true, note: 'saved as a Gmail draft; promotion sends the draft' },
  msmail_send: { twin: 'msmail_draft', implemented: true, note: 'saved as an Outlook draft; promotion sends the draft' },
  gcal_create_event: { twin: 'gcal_create_event', implemented: false, note: 'an event without sending invitations (sendUpdates=none), declared until the calendar tools take guests' },
  mscal_create_event: { twin: 'mscal_create_event', implemented: false, note: 'an event without sending invitations, declared until the calendar tools take guests' },
};

export function stagingOf(toolName: string): StagingTwin | null {
  return STAGING[toolName] ?? null;
}

/** JSON with sorted keys, so two inputs that mean the same hash the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * The idempotency key of a call: hash(session, scope, tool, canonical input).
 * The scope is the acting agent (so a shared session's two agents never
 * collide); the dedupe window bounds it in time. A retry of the same call —
 * the next round, the next run of the same org task, a re-woken loop —
 * lands on the same key.
 */
export function idempotencyKey(p: { sessionId: string; scope: string; tool: string; input: Record<string, unknown> }): string {
  return sha256(`${p.sessionId}\u0000${p.scope}\u0000${p.tool}\u0000${canonicalJson(p.input)}`);
}
