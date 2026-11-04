/**
 * InboxHistoryService — the Inbox's History (docs/home.md "Inbox"): what used
 * to wait on the owner and is now resolved, newest first, with who resolved
 * it and how. It owns no state: every row is read back from the record that
 * already holds the resolution —
 *
 *  - approvals / escalations: `org_approvals` past `pending` (status,
 *    decidedAt, decidedBy, decidedVia: '' by hand | default | delegate:…);
 *    `two_key` cards are skipped — the action ledger row below is the key;
 *  - keys: `action_log` rows that were held or staged (`keys.why`) and are no
 *    longer — released (succeeded / failed), denied or refused — attributed
 *    through their `two_key` card when one decided it (a default or a
 *    delegate), else through `keys.owner`;
 *  - plans: `org_plans` applied (by the CEO, or by the window closing — the
 *    default), vetoed or expired; the veto time is the audit row's;
 *  - incidents: `org_incidents` contained or resolved; who from the audit row;
 *  - my tasks: org tasks assigned to me or reviewed by me that are done or
 *    cancelled; who from the audit row (or the checks that accepted it);
 *  - following: my follows I marked seen (`lastSeenAt`), by me.
 *
 * Every read goes through the account-scoped handle and is keyed on the
 * workspace (and its one organization); a member of a shared workspace sees
 * the same company records the Inbox already shows them, and only their own
 * tasks and follows. "Decided without you" = a default or a delegate.
 *
 * Pagination: rows are merged across sources and ordered by (at, key) desc;
 * the cursor is the last row's (at, key). Each source reads at most
 * SOURCE_CAP rows inside the window.
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { accounts, actionLog, agents as agentsTable, follows, orgApprovals, orgAudit, orgDelegations, orgIncidents, orgPlans, orgTasks, workspaceMembers, workspaces } from '../database/schema';
import { actorId, currentAccountId, currentViewer } from '../accounts/account-context';
import { OrgService } from '../org/org.service';
import { summarize } from '../org/org-approvals.service';
import { taskLabel } from '../common/task-keys';

export const HISTORY_KINDS = ['approvals', 'keys', 'escalations', 'plans', 'mytasks', 'incidents', 'following'] as const;
export type HistoryKind = typeof HISTORY_KINDS[number];

export type HistoryOutcome =
  | 'approved' | 'rejected' | 'revision_requested' | 'expired'
  | 'released' | 'failed' | 'denied' | 'refused'
  | 'applied' | 'vetoed'
  | 'contained' | 'resolved'
  | 'done' | 'cancelled'
  | 'seen';

/** Who resolved it: you, another person, a delegate (a person or an agent
 *  role), the default at the deadline, an agent, the checks or the system. */
export interface HistoryActor { kind: 'you' | 'person' | 'delegate' | 'default' | 'agent' | 'system'; name: string; id?: string }

export interface HistoryLink {
  type: 'approval' | 'action' | 'plan' | 'incident' | 'task' | 'thread' | 'agent_task';
  id: string;
  /** The conversation a key's action ran in (actions). */
  sessionId?: string;
  /** An SPA link (`/<company>/…`, docs/routes.md; older rows `#/ws/…`) for follows. */
  href?: string;
}

/** An existing route that walks the resolution back (never a new mechanic). */
export type HistoryUndo =
  | { kind: 'revoke_delegation'; delegationId: string; label: string }
  | { kind: 'reopen_task'; taskId: string; label: string };

export interface HistoryItem {
  key: string;
  kind: HistoryKind;
  title: string;
  detail: string;
  outcome: HistoryOutcome;
  by: HistoryActor;
  /** A default or a delegate decided it: listed apart for the owner to audit. */
  withoutYou: boolean;
  at: string;
  link: HistoryLink;
  undo?: HistoryUndo;
}

export interface HistoryPage { items: HistoryItem[]; nextCursor: string | null }

export interface HistoryQuery { kind?: string; q?: string; from?: string; to?: string; cursor?: string; limit?: number | string; without?: boolean | string }

export const HISTORY_PAGE = 30;
export const HISTORY_PAGE_MAX = 100;
/** Rows read per source inside the window. */
export const SOURCE_CAP = 1_000;

const safe = <T,>(raw: string | null | undefined, fallback: T): T => { try { return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const iso = (v: string | undefined, name: string): string | undefined => {
  if (!v) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new BadRequestException(`${name} must be an ISO date`);
  return new Date(t).toISOString();
};

export function encodeCursor(at: string, key: string): string { return Buffer.from(`${at}|${key}`, 'utf8').toString('base64url'); }
export function decodeCursor(c: string): { at: string; key: string } {
  const raw = Buffer.from(c, 'base64url').toString('utf8');
  const i = raw.indexOf('|');
  if (i <= 0 || Number.isNaN(Date.parse(raw.slice(0, i)))) throw new BadRequestException('bad cursor');
  return { at: raw.slice(0, i), key: raw.slice(i + 1) };
}

/** Newest first; ties by key, so the cursor is a total order. */
export const byNewest = (a: HistoryItem, b: HistoryItem): number => (a.at === b.at ? (a.key < b.key ? 1 : a.key > b.key ? -1 : 0) : a.at < b.at ? 1 : -1);

/** The outcome word of a decided card, by kind. Pure. */
export function approvalOutcome(status: string): HistoryOutcome {
  return status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : status === 'revision_requested' ? 'revision_requested' : 'expired';
}

/** The outcome of a key on a held or staged action. Pure. */
export function actionOutcome(status: string): HistoryOutcome | null {
  return status === 'succeeded' ? 'released' : status === 'failed' ? 'failed' : status === 'denied' ? 'denied' : status === 'refused' ? 'refused' : null;
}

interface Ctx {
  workspaceId: string;
  orgId: string | null;
  chiefId: string | null;
  me: string;
  owner: string;
  isCeo: boolean;
  canWrite: boolean;
  agentNames: Map<string, string>;
  humanNames: Map<string, string>;
  from?: string;
  to?: string;
}

@Injectable()
export class InboxHistoryService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly org?: OrgService,
  ) {}

  private companiesEnabled(): boolean { return this.config?.get<boolean>('companiesEnabled') !== false; }

  async history(workspaceId: string, query: HistoryQuery = {}): Promise<HistoryPage> {
    const viewer = currentViewer();
    // A member acts in the workspace they were let into, never another of the owner's.
    if (viewer && viewer.workspaceId && viewer.workspaceId !== workspaceId) throw new NotFoundException(`workspace ${workspaceId}`);
    const ws = (await this.db.select({ id: workspaces.id, orgMode: workspaces.orgMode }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)).at(0);
    if (!ws) throw new NotFoundException(`workspace ${workspaceId}`);
    const kind = query.kind && query.kind !== 'all' ? query.kind : '';
    if (kind && !(HISTORY_KINDS as readonly string[]).includes(kind)) throw new BadRequestException(`kind must be one of ${HISTORY_KINDS.join(', ')}`);
    const limit = Math.max(1, Math.min(HISTORY_PAGE_MAX, Number(query.limit) || HISTORY_PAGE));
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const from = iso(query.from, 'from');
    let to = iso(query.to, 'to');
    if (cursor && (!to || cursor.at < to)) to = cursor.at; // inclusive: ties are cut by key below
    const q = (query.q ?? '').trim().toLowerCase();
    const without = query.without === true || query.without === 'true' || query.without === '1';

    const org = this.companiesEnabled() && this.org ? await this.org.byWorkspace(workspaceId).catch(() => null) : null;
    const me = actorId();
    const owner = currentAccountId();
    const ctx: Ctx = {
      workspaceId, orgId: org?.id ?? null, chiefId: org?.chiefOfStaffAgentId ?? null, me, owner,
      isCeo: org && this.org ? (await this.org.humanRole(org.id, me).catch(() => null)) === 'ceo' : me === owner,
      canWrite: !viewer || viewer.role !== 'viewer',
      agentNames: new Map((await this.db.select({ id: agentsTable.id, name: agentsTable.name }).from(agentsTable)).map((a) => [a.id, a.name])),
      humanNames: await this.humanNames(workspaceId, owner),
      from, to,
    };

    const want = (k: HistoryKind) => !kind || kind === k;
    const parts = await Promise.all([
      want('approvals') || want('escalations') ? this.approvals(ctx) : [],
      want('keys') ? this.keys(ctx) : [],
      want('plans') ? this.plans(ctx) : [],
      want('incidents') ? this.incidents(ctx) : [],
      want('mytasks') ? this.myTasks(ctx) : [],
      want('following') ? this.following(ctx) : [],
    ]);
    let rows = parts.flat().filter((r) => !kind || r.kind === kind);
    rows = rows.filter((r) => (!from || r.at >= from) && (!to || r.at <= to));
    if (cursor) rows = rows.filter((r) => byNewest(r, { at: cursor.at, key: cursor.key } as HistoryItem) > 0);
    if (without) rows = rows.filter((r) => r.withoutYou);
    if (q) rows = rows.filter((r) => `${r.title}\n${r.detail}\n${r.by.name}\n${r.outcome}`.toLowerCase().includes(q));
    rows.sort(byNewest);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.at, last.key) : null };
  }

  // ---- names ----

  private async humanNames(workspaceId: string, owner: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    // `accounts` is account infrastructure: never fenced, keyed by id here.
    const own = (await this.db.select({ name: accounts.name, email: accounts.email }).from(accounts).where(eq(accounts.id, owner)).limit(1).catch(() => [])).at(0);
    out.set(owner, own?.name || own?.email || 'the owner');
    for (const m of await this.db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))) {
      out.set(m.memberAccountId, m.displayName || m.email || m.memberAccountId.slice(0, 8));
    }
    return out;
  }

  /** An actor string (`user`, `human:<id>`, `agent:<id>`, `chief`, `system`,
   *  `check`, or a bare account id) as the person or agent it names. */
  private actor(ctx: Ctx, raw: string): HistoryActor {
    if (!raw || raw === 'system') return { kind: 'system', name: 'the system' };
    if (raw === 'check') return { kind: 'system', name: 'the checks' };
    if (raw === 'user') return ctx.me === ctx.owner ? { kind: 'you', name: 'You', id: ctx.owner } : { kind: 'person', name: ctx.humanNames.get(ctx.owner) ?? 'the owner', id: ctx.owner };
    if (raw === 'chief') return { kind: 'agent', name: (ctx.chiefId && ctx.agentNames.get(ctx.chiefId)) || 'Chief of staff', id: ctx.chiefId ?? undefined };
    if (raw.startsWith('agent:')) { const id = raw.slice(6); return { kind: 'agent', name: ctx.agentNames.get(id) ?? 'an agent', id }; }
    const id = raw.startsWith('human:') ? raw.slice(6) : raw;
    if (id === ctx.me) return { kind: 'you', name: 'You', id };
    if (ctx.agentNames.has(id)) return { kind: 'agent', name: ctx.agentNames.get(id)!, id };
    return { kind: 'person', name: ctx.humanNames.get(id) ?? (id === ctx.owner ? 'the owner' : 'a member'), id };
  }

  /** Who decided a card: the default, a delegate (named), or the person. */
  private cardActor(ctx: Ctx, a: { status: string; decidedBy: string; decidedVia: string }): HistoryActor {
    if (a.decidedVia === 'default') return { kind: 'default', name: 'the default at your deadline' };
    if (a.decidedVia.startsWith('delegate:')) {
      const who = this.actor(ctx, a.decidedBy);
      const [type, ref] = [a.decidedVia.split(':')[1] ?? '', a.decidedVia.split(':').slice(2).join(':')];
      const name = type === 'role' ? `${who.kind === 'agent' ? who.name : 'an agent'} (${ref})` : who.kind === 'you' ? 'You' : who.name;
      return { kind: 'delegate', name, id: who.id };
    }
    if (a.status === 'expired') return { kind: 'system', name: 'nobody — it expired' };
    return this.actor(ctx, a.decidedBy);
  }

  /** An active delegation that decided a card, so the owner can revoke it. */
  private async delegationUndo(ctx: Ctx, cards: Array<{ id: string; kind: string; payload: string; decidedVia: string }>): Promise<Map<string, HistoryUndo>> {
    const out = new Map<string, HistoryUndo>();
    if (!ctx.orgId || !ctx.isCeo || !cards.some((c) => c.decidedVia.startsWith('delegate:'))) return out;
    const live = await this.db.select().from(orgDelegations).where(eq(orgDelegations.orgId, ctx.orgId));
    for (const c of cards) {
      if (!c.decidedVia.startsWith('delegate:')) continue;
      const [, type, ...rest] = c.decidedVia.split(':');
      const ref = rest.join(':');
      const cls = str(safe<Record<string, unknown>>(c.payload, {}).class);
      const d = live.find((x) => !x.revokedAt && x.delegateType === type && x.delegateRef === ref && (x.kind === c.kind || (c.kind === 'two_key' && x.kind === cls)));
      if (d) out.set(c.id, { kind: 'revoke_delegation', delegationId: d.id, label: `Revoke ${d.kind.replace(/_/g, ' ')} delegation` });
    }
    return out;
  }

  /** The latest audit row per ref among `actions`. */
  private async lastAudit(orgId: string, refType: string, ids: string[], actions: string[]): Promise<Map<string, { actor: string; at: string; action: string; payload: string }>> {
    const out = new Map<string, { actor: string; at: string; action: string; payload: string }>();
    if (!ids.length) return out;
    const rows = await this.db.select({ refId: orgAudit.refId, actor: orgAudit.actor, at: orgAudit.createdAt, action: orgAudit.action, payload: orgAudit.payload, seq: orgAudit.seq }).from(orgAudit)
      .where(and(eq(orgAudit.orgId, orgId), eq(orgAudit.refType, refType), inArray(orgAudit.refId, ids), inArray(orgAudit.action, actions)))
      .orderBy(desc(orgAudit.seq));
    for (const r of rows) if (!out.has(r.refId)) out.set(r.refId, r);
    return out;
  }

  /** The [from, to] window on the column that holds the resolution time. */
  private window(col: Parameters<typeof gte>[0], ctx: Ctx): SQL[] {
    const c: SQL[] = [];
    if (ctx.from) c.push(gte(col, ctx.from));
    if (ctx.to) c.push(lte(col, ctx.to));
    return c;
  }

  // ---- the sources ----

  private async approvals(ctx: Ctx): Promise<HistoryItem[]> {
    if (!ctx.orgId) return [];
    const at = sql<string>`coalesce(${orgApprovals.decidedAt}, ${orgApprovals.expiresAt}, ${orgApprovals.createdAt})`;
    const rows = await this.db.select().from(orgApprovals)
      .where(and(eq(orgApprovals.orgId, ctx.orgId), ne(orgApprovals.status, 'pending'), ne(orgApprovals.kind, 'two_key'), ...this.window(at, ctx)))
      .orderBy(desc(at)).limit(SOURCE_CAP);
    const undo = await this.delegationUndo(ctx, rows);
    return rows.map((a): HistoryItem => {
      const p = safe<Record<string, unknown>>(a.payload, {});
      const by = this.cardActor(ctx, a);
      const esc = a.kind === 'escalation';
      const taskId = str(p.taskId);
      const note = a.decisionNote && !/^(approved|denied) by default at your deadline$/.test(a.decisionNote) ? a.decisionNote : '';
      return {
        key: `a:${a.id}`, kind: esc ? 'escalations' : 'approvals',
        title: esc ? `Escalation: ${str(p.title) || 'a task'}` : `${a.kind.replace(/_/g, ' ')}: ${clip(summarize(a.kind, p), 140)}`,
        detail: clip([esc ? str(p.reason) : a.recommendation, note ? `Note: ${note}` : ''].filter(Boolean).join(' · '), 280),
        outcome: approvalOutcome(a.status), by, withoutYou: by.kind === 'default' || by.kind === 'delegate',
        at: a.decidedAt ?? a.expiresAt ?? a.createdAt,
        link: esc && taskId ? { type: 'task', id: taskId } : { type: 'approval', id: a.id },
        ...(undo.has(a.id) ? { undo: undo.get(a.id)! } : {}),
      };
    });
  }

  private async keys(ctx: Ctx): Promise<HistoryItem[]> {
    const at = sql<string>`coalesce(${actionLog.finishedAt}, ${actionLog.createdAt})`;
    const rows = await this.db.select().from(actionLog)
      .where(and(eq(actionLog.workspaceId, ctx.workspaceId), inArray(actionLog.status, ['succeeded', 'failed', 'denied', 'refused']), sql`${actionLog.keys} like '%"why"%'`, ...this.window(at, ctx)))
      .orderBy(desc(at)).limit(SOURCE_CAP);
    const parsed = rows.map((r) => ({ r, keys: safe<{ why?: string; approvalId?: string; owner?: { by?: string; note?: string } }>(r.keys, {}) })).filter((x) => typeof x.keys.why === 'string');
    const cardIds = parsed.map((x) => x.keys.approvalId).filter((x): x is string => typeof x === 'string');
    const cards = ctx.orgId && cardIds.length ? await this.db.select().from(orgApprovals).where(and(eq(orgApprovals.orgId, ctx.orgId), inArray(orgApprovals.id, cardIds))) : [];
    const cardOf = new Map(cards.map((c) => [c.id, c]));
    const undo = await this.delegationUndo(ctx, cards);
    return parsed.flatMap(({ r, keys }): HistoryItem[] => {
      const outcome = actionOutcome(r.status);
      if (!outcome) return [];
      const card = keys.approvalId ? cardOf.get(keys.approvalId) : undefined;
      // The card's attribution wins when a default or a delegate decided it (the key then runs as the account).
      const by: HistoryActor = card && card.status !== 'pending' && (card.decidedVia === 'default' || card.decidedVia.startsWith('delegate:'))
        ? this.cardActor(ctx, card)
        : keys.owner?.by ? this.actor(ctx, keys.owner.by) : outcome === 'refused' ? { kind: 'system', name: 'the rate limit' } : { kind: 'system', name: 'the system' };
      const staged = Boolean(r.stagedRef);
      const agent = r.agentId ? ctx.agentNames.get(r.agentId) : '';
      return [{
        key: `k:${r.id}`, kind: 'keys',
        title: `${staged ? 'Send staged' : 'Run held'} ${r.tool}${agent ? ` (${agent})` : ''}`,
        detail: clip([keys.why ?? '', outcome === 'refused' || outcome === 'failed' ? r.note || r.result : '', keys.owner?.note ? `Note: ${keys.owner.note}` : ''].filter(Boolean).join(' · '), 280),
        outcome, by, withoutYou: by.kind === 'default' || by.kind === 'delegate',
        at: r.finishedAt ?? r.createdAt,
        link: { type: 'action', id: r.id, sessionId: r.sessionId },
        ...(card && undo.has(card.id) ? { undo: undo.get(card.id)! } : {}),
      }];
    });
  }

  private async plans(ctx: Ctx): Promise<HistoryItem[]> {
    if (!ctx.orgId) return [];
    // A veto happens inside the window (before applyAt); its time is the audit row's.
    const upper = sql<string>`coalesce(${orgPlans.appliedAt}, ${orgPlans.applyAt}, ${orgPlans.createdAt})`;
    const conds: SQL[] = [eq(orgPlans.orgId, ctx.orgId), inArray(orgPlans.status, ['applied', 'vetoed', 'expired'])];
    if (ctx.from) conds.push(gte(upper, ctx.from));
    if (ctx.to) conds.push(lte(orgPlans.createdAt, ctx.to));
    const rows = await this.db.select().from(orgPlans).where(and(...conds)).orderBy(desc(upper)).limit(SOURCE_CAP);
    const vetoes = await this.lastAudit(ctx.orgId, 'plan', rows.filter((p) => p.status === 'vetoed').map((p) => p.id), ['plan_vetoed']);
    return rows.map((p): HistoryItem => {
      const n = safe<unknown[]>(p.actions, []).length;
      const results = safe<Array<{ ok?: boolean }>>(p.result, []);
      const outcome: HistoryOutcome = p.status === 'applied' ? 'applied' : p.status === 'vetoed' ? 'vetoed' : 'expired';
      // The tick applying a plan when its window closed is the plan's default.
      const by: HistoryActor = p.decidedBy === 'system' && outcome === 'applied' ? { kind: 'default', name: 'the default when the veto window closed' } : this.actor(ctx, p.decidedBy || 'system');
      const veto = vetoes.get(p.id);
      const note = veto ? str(safe<{ note?: string }>(veto.payload, {}).note) : '';
      return {
        key: `p:${p.id}`, kind: 'plans', title: `Plan: ${clip(p.summary || p.trigger, 160)}`,
        detail: clip([outcome === 'applied' ? `${results.filter((r) => r.ok).length} of ${n} action(s) applied` : `${n} action(s)`, note ? `Note: ${note}` : ''].filter(Boolean).join(' · '), 280),
        outcome, by, withoutYou: by.kind === 'default',
        at: veto?.at ?? p.appliedAt ?? p.applyAt ?? p.createdAt,
        link: { type: 'plan', id: p.id },
      };
    });
  }

  private async incidents(ctx: Ctx): Promise<HistoryItem[]> {
    if (!ctx.orgId) return [];
    const at = sql<string>`coalesce(${orgIncidents.resolvedAt}, ${orgIncidents.containedAt}, ${orgIncidents.openedAt})`;
    const rows = await this.db.select().from(orgIncidents)
      .where(and(eq(orgIncidents.orgId, ctx.orgId), inArray(orgIncidents.status, ['contained', 'resolved']), ...this.window(at, ctx)))
      .orderBy(desc(at)).limit(SOURCE_CAP);
    const audit = await this.lastAudit(ctx.orgId, 'incident', rows.map((i) => i.id), ['incident_resolve', 'incident_contain']);
    return rows.map((i): HistoryItem => {
      const resolved = i.status === 'resolved';
      const a = audit.get(i.id);
      const wanted = resolved ? 'incident_resolve' : 'incident_contain';
      // Contained on open by severity (no audit row of the step) is the system's doing.
      const by = a && a.action === wanted ? this.actor(ctx, a.actor) : { kind: 'system' as const, name: resolved ? 'the system (recovered)' : 'the system (by severity)' };
      return {
        key: `i:${i.id}`, kind: 'incidents', title: i.title,
        detail: clip([`${i.severity} · ${i.kind.replace(/_/g, ' ')}`, resolved && i.resolution ? i.resolution : ''].filter(Boolean).join(' · '), 280),
        outcome: resolved ? 'resolved' : 'contained', by, withoutYou: false,
        at: (resolved ? i.resolvedAt : i.containedAt) ?? i.openedAt,
        link: { type: 'incident', id: i.id },
      };
    });
  }

  private async myTasks(ctx: Ctx): Promise<HistoryItem[]> {
    if (!ctx.orgId) return [];
    const rows = await this.db.select().from(orgTasks)
      .where(and(eq(orgTasks.orgId, ctx.orgId), inArray(orgTasks.status, ['done', 'cancelled']), or(eq(orgTasks.assigneeHumanId, ctx.me), eq(orgTasks.reviewerHumanId, ctx.me)), ...this.window(orgTasks.updatedAt, ctx)))
      .orderBy(desc(orgTasks.updatedAt)).limit(SOURCE_CAP);
    const audit = await this.lastAudit(ctx.orgId, 'task', rows.map((t) => t.id), ['task_update', 'review_accept']);
    return rows.map((t): HistoryItem => {
      const a = audit.get(t.id);
      const by = t.acceptedBy === 'check' ? { kind: 'system' as const, name: 'the checks' } : a ? this.actor(ctx, a.actor) : { kind: 'system' as const, name: 'the system' };
      const mine = t.assigneeHumanId === ctx.me;
      return {
        key: `t:${t.id}`, kind: 'mytasks', title: mine ? taskLabel(t) : `Review: ${taskLabel(t)}`,
        detail: `${mine ? 'assigned to you' : 'you were the reviewer'}${t.acceptedBy ? ` · accepted by ${t.acceptedBy}` : ''}`,
        outcome: t.status === 'done' ? 'done' : 'cancelled', by, withoutYou: false, at: t.updatedAt,
        link: { type: 'task', id: t.id },
        ...(ctx.canWrite ? { undo: { kind: 'reopen_task' as const, taskId: t.id, label: 'Reopen' } } : {}),
      };
    });
  }

  private async following(ctx: Ctx): Promise<HistoryItem[]> {
    const rows = await this.db.select().from(follows)
      .where(and(eq(follows.workspaceId, ctx.workspaceId), eq(follows.followerKind, 'user'), eq(follows.followerId, ctx.me), isNotNull(follows.lastSeenAt), ...this.window(follows.lastSeenAt, ctx)))
      .orderBy(desc(follows.lastSeenAt)).limit(SOURCE_CAP);
    return rows.map((f): HistoryItem => ({
      key: `f:${f.targetKind}:${f.targetId}`, kind: 'following', title: f.title || `A followed ${f.targetKind === 'thread' ? 'thread' : 'task'}`,
      detail: clip(f.lastActivity ? `${f.lastActorName ? `${f.lastActorName}: ` : ''}${f.lastActivity}` : '', 280),
      outcome: 'seen', by: { kind: 'you', name: 'You', id: ctx.me }, withoutYou: false, at: f.lastSeenAt!,
      link: f.targetKind === 'org_task' ? { type: 'task', id: f.targetId } : { type: f.targetKind === 'thread' ? 'thread' : 'agent_task', id: f.targetId, href: f.link },
    }));
  }
}
