/**
 * ActionsService — the external-action contract (docs/actions-and-trust.md
 * §2–§5, docs/autonomous-org-first-principles.md C2, execution-plan item 28).
 *
 * The turn loop calls it for every non-read tool call in every session —
 * private chats, channels, loops, heartbeats and org runs alike (the parity
 * rule: the same agent gets the same contract wherever it acts):
 *
 *  - **idempotency**: `action_log` keyed by hash(session, scope, tool,
 *    canonical input), unique per account. A retry of a succeeded outward
 *    call inside `actions.dedupeWindowMinutes` returns the recorded result
 *    and is logged `deduplicated` (neutral in the ledger); a retry of a call
 *    still waiting for a key is told so, never queued twice.
 *  - **outbound rate limits** per workspace: `actions.externalPerHour` per
 *    channel, `actions.irreversiblePerDay`, `actions.moneyPerDay`; over the
 *    limit → refused with the reason, and a signal to the chief in an org.
 *  - **staging**: a held irreversible call with a staging twin runs the twin
 *    (gmail_send → a Gmail draft) and waits for a key to promote it.
 *  - **keys**: the owner's (or CEO's) key on held and staged actions —
 *    `ownerKey`, from the route, or from a `two_key` org approval through
 *    the bridge the org module binds; the agent co-signer — a different
 *    member on a different model family running one bounded, tool-free
 *    verification over the exact call and the company's rules.
 *
 * Model-free except the co-signer call, which the turn loop supplies
 * (`coSignRunner`) because it owns provider context.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { actionLog, agents, organizations } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { actorId, currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { ConnectionsService } from '../connections/connections.service';
import { draftIdFrom } from '../connections/connections.tools';
import { familyOf } from '../org/org-tasks.service';
import {
  channelOf, classOf, EXTERNAL_CLASSES, idempotencyKey, isActionClass, sha256, canonicalJson, stagingOf,
  type ActionClass, type ClassHint,
} from './action-classes';
import { actionsTunable } from './actions-tunables';
import { TrustService } from './trust.service';
import type { TrustLevel } from './trust-policy';

export type ActionRow = typeof actionLog.$inferSelect;
/** `interrupted`: the call was in flight when the server restarted, so
 *  whether it took effect is unknown (docs/actions-and-trust.md §2). */
export type ActionStatus = 'started' | 'succeeded' | 'failed' | 'held' | 'staged' | 'refused' | 'denied' | 'interrupted';

export interface ActionCtx {
  sessionId: string;
  workspaceId: string;
  agentId: string | null;
  origin: 'user' | 'loop' | 'channel';
}

export interface CoSignVerdict { verdict: 'approve' | 'deny'; reason: string; model: string }
export type CoSignRunner = (p: {
  coSignerAgentId: string; actorAgentId: string; workspaceId: string;
  call: { name: string; input: Record<string, unknown> }; cls: ActionClass; rules: string;
}) => Promise<CoSignVerdict>;

/** Hooks the org module binds (OrgTrustBridge); absent = no organization. */
export interface ActionHooks {
  /** Open a signal for the chief (rate-limit refusals). */
  signal?(workspaceId: string, input: { kind: string; severity: 'info' | 'warn' | 'critical'; refId: string; title: string; detail: string }): Promise<void>;
  /** A `two_key` org approval for a held or staged action; returns its id. */
  openApproval?(workspaceId: string, action: ActionRow, summary: string): Promise<string | null>;
  /** Settle that approval when the key came from elsewhere. */
  closeApproval?(workspaceId: string, approvalId: string, approved: boolean, note: string): Promise<void>;
  /** Whether an incident froze this class for the org the agent is a member
   *  of (item 29's `OrgIncidentsService.isFrozen`); false outside an org. */
  frozen?(workspaceId: string, agentId: string, cls: ActionClass): Promise<boolean>;
  /** Open a `revert` incident for an org member's reported revert (item 29);
   *  true when one was opened — its demotion then replaces the revert's own. */
  revertIncident?(row: ActionRow, note: string): Promise<boolean>;
  /** Append to the org's audit chain (co-signer turns, keys, reverts). */
  audit?(workspaceId: string, entry: { actor: string; action: string; refType: string; refId: string; payload: Record<string, unknown> }): Promise<void>;
}

/** The plugin-call columns of a row (docs/plugins.md §5.6); null for every other call. */
export interface PluginCallFields {
  operation: string | null; interfaceVersion: string | null; providerId: string | null; bindingScope: string | null;
  pluginVersion: string | null; packageDigest: string | null; definitionHash: string | null; credentialRef: string | null;
  changeId: string | null; tainted: number | null; approvalRequestId: string | null; approvalAskedAt: string | null;
  approvalDecidedAt: string | null; approvalOutcome: string | null; costUsd: number | null; costState: string | null;
}
const EMPTY_PLUGIN_FIELDS: PluginCallFields = {
  operation: null, interfaceVersion: null, providerId: null, bindingScope: null, pluginVersion: null, packageDigest: null,
  definitionHash: null, credentialRef: null, changeId: null, tainted: null, approvalRequestId: null, approvalAskedAt: null,
  approvalDecidedAt: null, approvalOutcome: null, costUsd: null, costState: null,
};
/** The closed approval vocabulary of plugin calls (docs/plugins.md §4.3). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** What the turn loop runs a held action with on the owner's key. */
export type HeldExecutor = (sessionId: string, tool: string, input: Record<string, unknown>) => Promise<string>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

@Injectable()
export class ActionsService {
  private readonly logger = new Logger(ActionsService.name);
  hooks: ActionHooks = {};
  /** Bound by the turn loop: runs a held call when the owner's key arrives. */
  private executor?: HeldExecutor;
  /** Bound by the turn loop: the production co-signer (provider context). */
  coSignRunner?: CoSignRunner;
  /** Test seam: replaces the co-signer call (keeps selection and audit). */
  coSignFn?: CoSignRunner;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    readonly trust: TrustService,
    @Optional() private readonly agentsSvc?: AgentsService,
    @Optional() private readonly connections?: ConnectionsService,
  ) {}

  bindExecutor(fn: HeldExecutor): void { this.executor = fn; }

  classify(name: string, input: Record<string, unknown>, hint: ClassHint = {}): ActionClass {
    return classOf(name, input, hint);
  }

  keyFor(ctx: ActionCtx, name: string, input: Record<string, unknown>): string {
    return idempotencyKey({ sessionId: ctx.sessionId, scope: ctx.agentId ?? '', tool: name, input });
  }

  async byKey(key: string): Promise<ActionRow | null> {
    return (await this.db.select().from(actionLog).where(eq(actionLog.key, key))).at(0) ?? null;
  }

  async get(workspaceId: string, id: string): Promise<ActionRow> {
    const row = (await this.db.select().from(actionLog).where(and(eq(actionLog.id, id), eq(actionLog.workspaceId, workspaceId)))).at(0);
    if (!row) throw new NotFoundException(`action ${id}`);
    return row;
  }

  /**
   * What a prior row with the same key means for this call:
   *  - `replay`: it succeeded inside the dedupe window → answer from the record;
   *  - `waiting`: it is held or staged for a key → say so, do nothing;
   *  - `unknown`: it was in flight when the server restarted → say so once,
   *    do nothing; the row then reads as failed, so a deliberate retry runs;
   *  - null: act (a failed, refused, denied or stale attempt is retried).
   * Only outward classes deduplicate; an internal write may repeat.
   */
  async priorOutcome(prior: ActionRow | null, cls: ActionClass): Promise<{ kind: 'replay' | 'waiting' | 'unknown'; row: ActionRow } | null> {
    if (!prior || !EXTERNAL_CLASSES.includes(cls)) return null;
    if (prior.status === 'held' || prior.status === 'staged') return { kind: 'waiting', row: prior };
    if (prior.status === 'interrupted') {
      await this.db.update(actionLog).set({ status: 'failed', note: `${prior.note ? `${prior.note} ` : ''}The agent was told the outcome is unknown.`.slice(0, 1_000) }).where(eq(actionLog.id, prior.id));
      return { kind: 'unknown', row: prior };
    }
    if (prior.status !== 'succeeded' || !prior.finishedAt) return null;
    const org = await this.trust.orgOf(prior.workspaceId);
    const windowMs = actionsTunable(org, 'actions.dedupeWindowMinutes') * 60_000;
    if (Date.now() - Date.parse(prior.finishedAt) > windowMs) return null;
    return { kind: 'replay', row: prior };
  }

  /** Answer a retry from the record: count it, log it neutral in the ledger. */
  async replay(row: ActionRow): Promise<string> {
    await this.db.update(actionLog).set({ dedupeCount: row.dedupeCount + 1 }).where(eq(actionLog.id, row.id));
    if (row.agentId && isActionClass(row.class)) await this.trust.record(row.workspaceId, row.agentId, row.class, 'deduplicated', { refType: 'action', refId: row.id });
    return `Deduplicated: this exact call already succeeded at ${(row.finishedAt ?? row.createdAt).slice(0, 16).replace('T', ' ')} UTC (action ${row.id.slice(0, 8)}); nothing was done again. The recorded result follows.\n${row.result}`;
  }

  /** What the model hears for a call a restart cut off mid-flight. */
  unknownText(row: ActionRow): string {
    return `Not run again: this exact ${row.tool} call (action ${row.id.slice(0, 8)}) was in flight when the server restarted at ${(row.finishedAt ?? row.createdAt).slice(0, 16).replace('T', ' ')} UTC, so whether it took effect is unknown. Check first (read back what it would have changed, e.g. the sent folder or the record it writes). Only if it clearly did not happen, call it again; if you cannot tell, tell the owner instead of repeating it.`;
  }

  waitingText(row: ActionRow): string {
    return `Already waiting: this exact ${row.tool} call is ${row.status === 'staged' ? 'staged' : 'held'} for a key (action ${row.id.slice(0, 8)}); nothing was done again. Do not retry — tell the user it is waiting for their approval.`;
  }

  /** Open (or reopen) the row for this call. One row per key: a retry of a
   *  failed or stale attempt reuses it. */
  async start(ctx: ActionCtx, p: { key: string; tool: string; input: Record<string, unknown>; cls: ActionClass; decision: string; level: TrustLevel | null; prior: ActionRow | null; plugin?: PluginCallFields | null }): Promise<ActionRow> {
    const org = await this.trust.orgOf(ctx.workspaceId);
    const now = nowIso();
    const fields = {
      workspaceId: ctx.workspaceId, agentId: ctx.agentId ?? '', sessionId: ctx.sessionId, orgId: org?.id ?? null,
      tool: p.tool, class: p.cls, channel: channelOf(p.tool),
      inputHash: sha256(canonicalJson(p.input)), input: JSON.stringify(p.input).slice(0, 20_000),
      status: 'started', decision: p.decision, level: p.level, keys: '{}', stagedRef: '',
      result: '', resultHash: '', note: '', createdAt: now, finishedAt: null, revertedAt: null,
      ...EMPTY_PLUGIN_FIELDS, ...(p.plugin ?? {}),
    };
    if (p.prior) {
      await this.db.update(actionLog).set(fields).where(eq(actionLog.id, p.prior.id));
      return { ...p.prior, ...fields };
    }
    const row = { accountId: currentAccountId(), id: newId(), key: p.key, dedupeCount: 0, ...fields };
    try {
      await this.db.insert(actionLog).values(row);
      return row;
    } catch {
      // The same key landed concurrently: take it over.
      const again = await this.byKey(p.key);
      if (!again) throw new Error('action log row could not be written');
      await this.db.update(actionLog).set(fields).where(eq(actionLog.id, again.id));
      return { ...again, ...fields };
    }
  }

  async setDecision(id: string, decision: string, keys?: Record<string, unknown>): Promise<void> {
    await this.db.update(actionLog).set({ decision, ...(keys ? { keys: JSON.stringify(keys) } : {}) }).where(eq(actionLog.id, id));
  }

  /** The `asked` half of the approval pair (plugin calls): a fresh request id. */
  async markAsked(row: ActionRow, why: string): Promise<string> {
    const requestId = newId();
    const at = nowIso();
    await this.db.update(actionLog).set({ approvalRequestId: requestId, approvalAskedAt: at, approvalOutcome: null, approvalDecidedAt: null }).where(eq(actionLog.id, row.id));
    row.approvalRequestId = requestId;
    this.onApproval?.(row, 'asked', null, why, requestId);
    return requestId;
  }

  /** The `decided` half: one of the four outcomes, with the key holder for allowed-once. */
  async markDecided(row: ActionRow, outcome: ApprovalOutcome, by: string, requestId?: string): Promise<void> {
    const id = requestId ?? row.approvalRequestId ?? (await this.db.select({ r: actionLog.approvalRequestId }).from(actionLog).where(eq(actionLog.id, row.id))).at(0)?.r ?? newId();
    await this.db.update(actionLog).set({ approvalRequestId: id, approvalDecidedAt: nowIso(), approvalOutcome: outcome }).where(eq(actionLog.id, row.id));
    this.onApproval?.(row, 'decided', outcome, by, id);
  }

  /** Told of each half of an approval pair on a plugin call (the plugin
   *  audit chain listens; it mirrors to org_audit). `by` is the reason for
   *  `asked` and the key holder for `decided`. */
  onApproval?: (row: ActionRow, half: 'asked' | 'decided', outcome: ApprovalOutcome | null, by: string, requestId: string) => void;

  /** Settle the row and feed the ledger (success counts as clean). */
  async finish(row: ActionRow, p: { status: ActionStatus; result?: string; note?: string; keys?: Record<string, unknown> }): Promise<void> {
    const result = (p.result ?? '').slice(0, 8_000);
    // Keys combine over what the row already records (never lose a co-signer's verdict).
    const keys = p.keys ? { ...parseKeys((await this.db.select({ keys: actionLog.keys }).from(actionLog).where(eq(actionLog.id, row.id))).at(0)?.keys), ...p.keys } : null;
    await this.db.update(actionLog).set({
      status: p.status, result, resultHash: result ? sha256(result) : '', finishedAt: nowIso(),
      ...(p.note !== undefined ? { note: p.note.slice(0, 1_000) } : {}),
      ...(keys ? { keys: JSON.stringify(keys) } : {}),
    }).where(eq(actionLog.id, row.id));
    if (p.status === 'succeeded' && row.agentId && isActionClass(row.class)) {
      await this.trust.record(row.workspaceId, row.agentId, row.class, 'success', { refType: 'action', refId: row.id }).catch(() => null);
    }
  }

  // ---- outbound rate limits ----

  /** Whether one more call of this class on this channel fits the workspace's limits now. */
  async rateCheck(workspaceId: string, cls: ActionClass, channel: string, excludeId?: string): Promise<{ ok: true } | { ok: false; reason: string; limit: string }> {
    if (!EXTERNAL_CLASSES.includes(cls)) return { ok: true };
    const org = await this.trust.orgOf(workspaceId);
    const now = Date.now();
    const counted = ['succeeded', 'started', 'staged'];
    const rows = await this.db.select({ id: actionLog.id, class: actionLog.class, channel: actionLog.channel, status: actionLog.status, createdAt: actionLog.createdAt })
      .from(actionLog)
      .where(and(eq(actionLog.workspaceId, workspaceId), inArray(actionLog.class, [...EXTERNAL_CLASSES]), gte(actionLog.createdAt, new Date(now - DAY).toISOString())));
    const live = rows.filter((r) => r.id !== excludeId && counted.includes(r.status));
    if (cls === 'money') {
      const cap = actionsTunable(org, 'actions.moneyPerDay');
      const n = live.filter((r) => r.class === 'money' && r.status !== 'staged').length;
      if (n >= cap) return { ok: false, limit: 'actions.moneyPerDay', reason: cap === 0 ? 'money-moving actions are off in this workspace (actions.moneyPerDay = 0)' : `${n} money-moving action(s) in the last 24 h — the limit is ${cap} (actions.moneyPerDay)` };
    }
    if (cls === 'external_irreversible') {
      const cap = actionsTunable(org, 'actions.irreversiblePerDay');
      const n = live.filter((r) => r.class === 'external_irreversible' && r.status !== 'staged').length;
      if (n >= cap) return { ok: false, limit: 'actions.irreversiblePerDay', reason: `${n} irreversible outward action(s) in the last 24 h — the limit is ${cap} (actions.irreversiblePerDay)` };
    }
    const cap = actionsTunable(org, 'actions.externalPerHour');
    const n = live.filter((r) => r.channel === channel && Date.parse(r.createdAt) >= now - HOUR).length;
    if (n >= cap) return { ok: false, limit: 'actions.externalPerHour', reason: `${n} outward action(s) on ${channel} in the last hour — the limit is ${cap} (actions.externalPerHour)` };
    return { ok: true };
  }

  /** Refuse on a limit: the row, the reason for the model, a signal to the chief. */
  async refuseRate(row: ActionRow, reason: string, limit: string): Promise<string> {
    await this.finish(row, { status: 'refused', note: reason });
    await this.hooks.signal?.(row.workspaceId, {
      kind: 'action_rate_limit', severity: 'warn', refId: `${limit}:${row.channel}`,
      title: `Outbound limit reached: ${row.tool} refused`,
      detail: `${reason}. Raise ${limit} with org_tune or PUT …/org/tunables if the volume is intended; otherwise find out why the agent is sending this much.`,
    }).catch(() => undefined);
    return `Refused: ${reason}. Nothing was sent. Do not retry now — tell the user what you wanted to do; the limit resets on its own.`;
  }

  // ---- keys: hold, stage, owner, co-signer ----

  /** Park the action for a key: the agent's inbox event and, in an org, a `two_key` approval. */
  async hold(row: ActionRow, p: { level: TrustLevel | null; staged?: { twin: string; ref: string; output: string }; why: string; keys?: Record<string, unknown> }): Promise<string> {
    const status: ActionStatus = p.staged ? 'staged' : 'held';
    const summary = `${row.tool}${p.staged ? ` (staged as ${p.staged.twin})` : ''}: ${summarizeInput(row.input)}`;
    // Keep what the row already knows (a co-signer's verdict, the single-family flag).
    const stored = parseKeys((await this.db.select({ keys: actionLog.keys }).from(actionLog).where(eq(actionLog.id, row.id))).at(0)?.keys);
    const keys: Record<string, unknown> = { ...stored, ...(p.keys ?? {}), why: p.why };
    const approvalId = await this.hooks.openApproval?.(row.workspaceId, { ...row, status }, summary).catch(() => null) ?? null;
    if (approvalId) keys.approvalId = approvalId;
    await this.db.update(actionLog).set({ status, stagedRef: p.staged?.ref ?? '', keys: JSON.stringify(keys), ...(p.staged ? { note: p.staged.output.slice(0, 1_000) } : {}) }).where(eq(actionLog.id, row.id));
    if (row.agentId) {
      await this.agentsSvc?.addEvent(row.agentId, {
        kind: 'action_key',
        title: `${p.staged ? 'Staged, needs your key to send' : 'Needs your key'}: ${row.tool} (${row.class.replace(/_/g, ' ')})`,
        body: `${p.why}\n${summarizeInput(row.input)}`,
        sessionId: row.sessionId,
        payload: JSON.stringify({ actionId: row.id, workspaceId: row.workspaceId, tool: row.tool, class: row.class, staged: Boolean(p.staged), approvalId }),
        origin: 'loop', channel: true,
      }).catch(() => undefined);
    }
    await this.hooks.audit?.(row.workspaceId, { actor: row.agentId ? `agent:${row.agentId}` : 'system', action: p.staged ? 'action_staged' : 'action_held', refType: 'action', refId: row.id, payload: { tool: row.tool, class: row.class, level: p.level, why: p.why, approvalId } }).catch(() => undefined);
    if (p.staged) {
      return `Staged, not sent: ${row.tool} is an ${row.class.replace(/_/g, ' ')} action and ${p.why}. It was prepared as ${p.staged.twin} (${p.staged.output.replace(/\s+/g, ' ').slice(0, 200)}) and will be sent only when the owner approves (action ${row.id.slice(0, 8)}). Do not retry — tell the user what you prepared.`;
    }
    return `Held for the owner's key: ${row.tool} is an ${row.class.replace(/_/g, ' ')} action and ${p.why}. It was recorded (action ${row.id.slice(0, 8)}) and runs only if the owner approves. Do not retry — tell the user what you prepared and why.`;
  }

  /** Run the staging twin for a held irreversible call. Null when the medium
   *  has no implemented twin or the twin's result names no draft. */
  async stage(row: ActionRow, run: (twin: string) => Promise<string>): Promise<{ twin: string; ref: string; output: string } | null> {
    const twin = stagingOf(row.tool);
    if (!twin?.implemented) return null;
    const output = await run(twin.twin);
    const ref = draftIdFrom(output);
    if (!ref) throw new Error(`the staging twin ${twin.twin} returned no draft id`);
    return { twin: twin.twin, ref, output };
  }

  /**
   * The owner's (or CEO's) key on a held or staged action. Approve → run it
   * (a staged draft is sent; a held call runs through the turn loop's
   * executor) under the rate limits; deny → `denied`, and the ledger counts a
   * rejection. `fromApproval` = the key came from the org approval itself.
   */
  async ownerKey(workspaceId: string, actionId: string, approve: boolean, note = '', actor = actorId(), opts: { fromApproval?: boolean } = {}): Promise<{ status: ActionStatus; result: string }> {
    if (!(await this.trust.isOwnerOrCeo(workspaceId, actor))) throw new ForbiddenException('only the owner or the CEO holds this key');
    const row = await this.get(workspaceId, actionId);
    if (row.status !== 'held' && row.status !== 'staged') throw new BadRequestException(`action is ${row.status}, not waiting for a key`);
    const keys = parseKeys(row.keys);
    keys.owner = { by: actor, approve, note: note.slice(0, 300), at: nowIso() };
    const approvalId = typeof keys.approvalId === 'string' ? keys.approvalId : null;
    const cls = isActionClass(row.class) ? row.class : 'external_reversible';
    if (row.operation) await this.markDecided(row, approve ? 'allowed-once' : 'rejected', actor);
    if (!approve) {
      await this.finish(row, { status: 'denied', note: note || 'the owner said no', keys });
      if (row.agentId) await this.trust.record(workspaceId, row.agentId, cls, 'rejected', { refType: 'action', refId: row.id });
      if (approvalId && !opts.fromApproval) await this.hooks.closeApproval?.(workspaceId, approvalId, false, note).catch(() => undefined);
      await this.hooks.audit?.(workspaceId, { actor, action: 'action_key_denied', refType: 'action', refId: row.id, payload: { tool: row.tool, class: row.class, note } }).catch(() => undefined);
      return { status: 'denied', result: row.status === 'staged' ? 'Not sent. The draft stays in the Drafts folder for the owner to edit or delete.' : 'Not run.' };
    }
    const rate = await this.rateCheck(workspaceId, cls, row.channel, row.id);
    if (!rate.ok) {
      await this.refuseRate(row, rate.reason, rate.limit);
      return { status: 'refused', result: rate.reason };
    }
    let result: string;
    let status: ActionStatus = 'succeeded';
    try {
      const input = JSON.parse(row.input || '{}') as Record<string, unknown>;
      if (row.status === 'staged') {
        if (!this.connections || !row.agentId) throw new Error('connections are not available to send the draft');
        const twin = stagingOf(row.tool);
        result = await this.connections.sendDraft(row.agentId, twin?.twin ?? '', row.stagedRef);
      } else {
        if (!this.executor) throw new Error('no executor is bound to run the held action');
        result = await this.executor(row.sessionId, row.tool, input);
      }
    } catch (err) {
      result = `failed: ${err instanceof Error ? err.message : String(err)}`;
      status = 'failed';
    }
    await this.finish(row, { status, result, keys });
    if (approvalId && !opts.fromApproval) await this.hooks.closeApproval?.(workspaceId, approvalId, true, note).catch(() => undefined);
    await this.hooks.audit?.(workspaceId, { actor, action: status === 'succeeded' ? 'action_key_approved' : 'action_key_failed', refType: 'action', refId: row.id, payload: { tool: row.tool, class: row.class, staged: row.status === 'staged', result: result.slice(0, 200) } }).catch(() => undefined);
    if (row.agentId) {
      await this.agentsSvc?.addEvent(row.agentId, {
        kind: status === 'succeeded' ? 'action_done' : 'action_failed',
        title: `${status === 'succeeded' ? 'Done on your key' : 'Failed on your key'}: ${row.tool}`,
        body: result.slice(0, 500), sessionId: row.sessionId,
        payload: JSON.stringify({ actionId: row.id, workspaceId }), origin: 'user',
      }).catch(() => undefined);
    }
    return { status, result };
  }

  /**
   * The independent agent co-signer: a different member of the workspace on
   * a different model family (the reviewer selection of OrgTasksService,
   * `familyOf`), preferring the org's auditor, then the chief. None on
   * another family → `singleFamily`, and the second key must be the owner's.
   */
  async pickCoSigner(workspaceId: string, actorAgentId: string): Promise<{ agentId: string; family: string } | { agentId: null; singleFamily: true }> {
    const roster = await this.db.select({ id: agents.id, provider: agents.provider, model: agents.model }).from(agents).where(and(eq(agents.workspaceId, workspaceId), ne(agents.id, actorAgentId)));
    const me = (await this.db.select({ provider: agents.provider, model: agents.model }).from(agents).where(eq(agents.id, actorAgentId))).at(0);
    const mine = me ? familyOf(me) : '';
    const others = roster.filter((a) => familyOf(a) !== mine);
    if (others.length === 0) return { agentId: null, singleFamily: true };
    const org = await this.trust.orgOf(workspaceId);
    const auditor = org ? await this.auditorOf(org.id) : null;
    const pick = others.find((a) => a.id === auditor) ?? others.find((a) => a.id === org?.chiefOfStaffAgentId) ?? others[0];
    return { agentId: pick.id, family: familyOf(pick) };
  }

  private async auditorOf(orgId: string): Promise<string | null> {
    const row = (await this.db.select({ auditorAgentId: organizations.auditorAgentId }).from(organizations).where(eq(organizations.id, orgId))).at(0);
    return row?.auditorAgentId ?? null;
  }

  /**
   * Ask the co-signer. Returns null when no independent key is available
   * (single family, no runner): the caller falls back to the owner's key.
   * Every co-signer turn is audited (the row's keys, the co-signer's inbox,
   * the org audit chain).
   */
  async coSign(row: ActionRow, call: { name: string; input: Record<string, unknown> }): Promise<{ result: CoSignVerdict & { coSignerAgentId: string; family: string } | null; keys: Record<string, unknown> }> {
    const keys = parseKeys(row.keys);
    if (!row.agentId) return { result: null, keys };
    const pick = await this.pickCoSigner(row.workspaceId, row.agentId);
    if (pick.agentId === null) {
      keys.singleFamily = true;
      await this.setDecision(row.id, 'cosign', keys);
      return { result: null, keys };
    }
    const runner = this.coSignFn ?? this.coSignRunner;
    if (!runner) return { result: null, keys };
    const org = await this.trust.orgOf(row.workspaceId);
    const rules = [org?.rules ? `Standing rules: ${org.rules}` : '', org?.values ? `Values: ${org.values}` : ''].filter(Boolean).join('\n');
    let verdict: CoSignVerdict;
    try {
      verdict = await runner({ coSignerAgentId: pick.agentId, actorAgentId: row.agentId, workspaceId: row.workspaceId, call, cls: row.class as ActionClass, rules });
    } catch (err) {
      verdict = { verdict: 'deny', reason: `the co-signer could not answer (${err instanceof Error ? err.message : String(err)}) — failing closed`, model: 'none' };
    }
    keys.agent = { agentId: pick.agentId, family: pick.family, verdict: verdict.verdict, reason: verdict.reason.slice(0, 300), model: verdict.model, at: nowIso() };
    await this.setDecision(row.id, 'cosign', keys);
    await this.agentsSvc?.addEvent(pick.agentId, {
      kind: 'info',
      title: `Co-signed ${verdict.verdict === 'approve' ? '(approved)' : '(denied)'}: ${row.tool}`,
      body: `${verdict.reason}\n${summarizeInput(row.input)}`.slice(0, 1_000), sessionId: row.sessionId,
      payload: JSON.stringify({ actionId: row.id, workspaceId: row.workspaceId, actorAgentId: row.agentId, verdict: verdict.verdict, model: verdict.model }),
      origin: 'loop',
    }).catch(() => undefined);
    await this.hooks.audit?.(row.workspaceId, { actor: `agent:${pick.agentId}`, action: 'action_cosign', refType: 'action', refId: row.id, payload: { tool: row.tool, class: row.class, actorAgentId: row.agentId, verdict: verdict.verdict, reason: verdict.reason.slice(0, 300), model: verdict.model, family: pick.family } }).catch(() => undefined);
    return { result: { ...verdict, coSignerAgentId: pick.agentId, family: pick.family }, keys };
  }

  // ---- reads and the owner's revert report ----

  async list(workspaceId: string, q: { agentId?: string; cls?: string; status?: string; limit?: number } = {}): Promise<ActionRow[]> {
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 100));
    const conds = [eq(actionLog.workspaceId, workspaceId)];
    if (q.agentId) conds.push(eq(actionLog.agentId, q.agentId));
    if (q.cls) {
      if (!isActionClass(q.cls)) throw new BadRequestException(`unknown action class "${q.cls}"`);
      conds.push(eq(actionLog.class, q.cls));
    }
    if (q.status) conds.push(eq(actionLog.status, q.status));
    return this.db.select().from(actionLog).where(and(...conds)).orderBy(desc(actionLog.createdAt)).limit(limit);
  }

  /** Whether an incident froze this class for the agent's organization. */
  async isFrozen(workspaceId: string, agentId: string | null, cls: ActionClass): Promise<boolean> {
    if (!agentId || !this.hooks.frozen) return false;
    return this.hooks.frozen(workspaceId, agentId, cls).catch(() => false);
  }

  /** POST …/actions/:id/revert-report: the owner says this action had to be
   *  undone. The row is marked; for an org member a `revert` incident opens
   *  (item 29) and its demotion is the ledger's one change; otherwise the
   *  ledger counts a revert itself (one level down). Never both. */
  async revertReport(workspaceId: string, actionId: string, note: string, actor = actorId()): Promise<ActionRow> {
    if (!(await this.trust.isOwnerOrCeo(workspaceId, actor))) throw new ForbiddenException('only the owner or the CEO reports a revert');
    const row = await this.get(workspaceId, actionId);
    if (row.status !== 'succeeded') throw new BadRequestException(`only a succeeded action can be reported reverted (this one is ${row.status})`);
    if (row.revertedAt) throw new BadRequestException('this action was already reported reverted');
    await this.db.update(actionLog).set({ revertedAt: nowIso(), note: `reverted: ${note}`.slice(0, 1_000) }).where(eq(actionLog.id, row.id));
    const viaIncident = row.agentId ? await this.hooks.revertIncident?.(row, note).catch(() => false) ?? false : false;
    if (!viaIncident && row.agentId && isActionClass(row.class)) await this.trust.record(workspaceId, row.agentId, row.class, 'reverted', { refType: 'action', refId: row.id });
    await this.hooks.audit?.(workspaceId, { actor, action: 'action_reverted', refType: 'action', refId: row.id, payload: { tool: row.tool, class: row.class, note: note.slice(0, 300) } }).catch(() => undefined);
    return this.get(workspaceId, actionId);
  }

  /** Notify the owner after a level-1 action ran with nobody at the keyboard. */
  async notifyAfter(row: ActionRow, output: string): Promise<void> {
    if (!row.agentId) return;
    await this.agentsSvc?.addEvent(row.agentId, {
      kind: 'info',
      title: `Acted (trust level 1, you hear after): ${row.tool}`,
      body: `${summarizeInput(row.input)}\n→ ${output.replace(/\s+/g, ' ').slice(0, 300)}`,
      sessionId: row.sessionId,
      // `feed`: the owner's feed lists it as an agent note (feed-registry.ts).
      payload: JSON.stringify({ actionId: row.id, workspaceId: row.workspaceId, class: row.class, feed: 'agent_note' }),
      origin: 'loop',
    }).catch(() => undefined);
  }
}

export function parseKeys(raw: string | null | undefined): Record<string, unknown> {
  try { const v = JSON.parse(raw || '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}

function summarizeInput(raw: string): string {
  try {
    const v = JSON.parse(raw || '{}') as Record<string, unknown>;
    const parts = ['to', 'subject', 'title', 'start', 'url', 'path'].filter((k) => v[k] !== undefined).map((k) => `${k}: ${String(v[k]).slice(0, 80)}`);
    return (parts.length ? parts.join(' · ') : raw).slice(0, 280);
  } catch { return raw.slice(0, 280); }
}

