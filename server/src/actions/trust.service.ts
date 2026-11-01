/**
 * TrustService — the trust ledger (docs/actions-and-trust.md §6,
 * docs/autonomous-org-first-principles.md C10, execution-plan item 28).
 *
 * One level 0–3 per (workspace, agent, action class), under the owner's
 * ceiling, created lazily at min(ceiling, the class's start level). The
 * evidence is `trust_records`; the arithmetic is trust-policy.ts (pure).
 * Every level change writes the row's reason, an `agent_events` row on the
 * agent (`trust_change`; a promotion of an outward class is pushed to the
 * owner's channels) and — in a workspace with an organization — a row in
 * the org's hash-chained audit log through the `audit` hook the org module
 * binds (this module never imports the org domain).
 *
 * Incidents arrive on the TriggerBus (`onOrgIncident`, emitted by item 29):
 * minor and major drop one level at once, critical drops to 0.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents, organizations, orgHumans, trustLevels, trustRecords, workspaces } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { actorId, currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { TriggerBus, type OrgIncidentEvent } from '../chats/trigger-bus';
import { ACTION_CLASSES, EXTERNAL_CLASSES, isActionClass, normalizeActionClass, type ActionClass } from './action-classes';
import {
  applyIncident, applyOutcome, clampLevel, DEFAULT_CEILINGS, DEFAULT_START, describeMatrix, effectiveLevel,
  type LedgerChange, type LedgerRow, type TrustLevel, type TrustOutcome,
} from './trust-policy';
import { actionsTunable } from './actions-tunables';
// The prediction ledger's calibration (item 30) through a dependency-free registry: no org-domain import.
import { calibrationOf as registeredCalibration } from '../org/calibration-registry';

export type TrustLevelRow = typeof trustLevels.$inferSelect;

/** Hooks the org module binds (OrgTrustBridge); absent = no organization. */
export interface TrustHooks {
  /** Append to the workspace's organization audit chain (no-op without one). */
  audit?(workspaceId: string, entry: { actor: string; action: string; refType: string; refId: string; payload: Record<string, unknown> }): Promise<void>;
}

export interface OrgContext { id: string; tunables: string; chiefOfStaffAgentId: string | null; rules: string; values: string }

@Injectable()
export class TrustService {
  private readonly logger = new Logger(TrustService.name);
  hooks: TrustHooks = {};
  /** The calibration hook (C7): the prediction ledger's score (item 30,
   *  docs/experiments.md §2.3) from the calibration registry — 0–1, or null
   *  with too few resolved forecasts, which never blocks a promotion. A
   *  score below `trust.calibrationBar` holds promotion back. */
  calibrationOf: (workspaceId: string, agentId: string) => Promise<number | null> = registeredCalibration;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Optional() private readonly agentsSvc?: AgentsService,
    @Optional() bus?: TriggerBus,
  ) {
    bus?.onOrgIncident((ev) => { void this.incident(ev).catch((err) => this.logger.warn(`incident ${ev.incidentId} not applied to the ledger: ${err instanceof Error ? err.message : err}`)); });
  }

  // ---- context ----

  /** The live organization of a workspace, or null. */
  async orgOf(workspaceId: string): Promise<OrgContext | null> {
    const row = (await this.db.select().from(organizations)
      .where(and(eq(organizations.workspaceId, workspaceId), ne(organizations.status, 'archived')))).at(0);
    return row ? { id: row.id, tunables: row.tunables, chiefOfStaffAgentId: row.chiefOfStaffAgentId, rules: row.rules, values: row.values } : null;
  }

  async workspaceRow(workspaceId: string): Promise<{ orgMode: string; trustCeilings: string; chiefOfStaffAgentId: string | null } | null> {
    const row = (await this.db.select({ orgMode: workspaces.orgMode, trustCeilings: workspaces.trustCeilings, chiefOfStaffAgentId: workspaces.chiefOfStaffAgentId })
      .from(workspaces).where(eq(workspaces.id, workspaceId))).at(0);
    return row ?? null;
  }

  /** The owner's ceilings per class (stored over the defaults). */
  async ceilings(workspaceId: string): Promise<Record<ActionClass, TrustLevel>> {
    const ws = await this.workspaceRow(workspaceId);
    return parseCeilings(ws?.trustCeilings);
  }

  /** The owner of the account, or the organization's CEO (org_humans). */
  async isOwnerOrCeo(workspaceId: string, actor = actorId()): Promise<boolean> {
    if (actor === currentAccountId()) return true;
    const org = await this.orgOf(workspaceId);
    if (!org) return false;
    const h = (await this.db.select().from(orgHumans).where(and(eq(orgHumans.orgId, org.id), eq(orgHumans.memberAccountId, actor)))).at(0);
    return h?.role === 'ceo';
  }

  // ---- levels ----

  /** The row for (workspace, agent, class), created at min(ceiling, start). */
  async row(workspaceId: string, agentId: string, cls: ActionClass): Promise<TrustLevelRow> {
    const existing = (await this.db.select().from(trustLevels)
      .where(and(eq(trustLevels.workspaceId, workspaceId), eq(trustLevels.agentId, agentId), eq(trustLevels.actionClass, cls)))).at(0);
    if (existing) return existing;
    const ceiling = (await this.ceilings(workspaceId))[cls];
    const row: TrustLevelRow = {
      accountId: currentAccountId(), id: newId(), workspaceId, agentId, actionClass: cls,
      level: Math.min(ceiling, DEFAULT_START[cls]), ceiling, cleanCount: 0, rejectStreak: 0,
      lastIncidentAt: null, lastChangedAt: null, reason: 'start level', createdAt: nowIso(),
    };
    try {
      await this.db.insert(trustLevels).values(row);
      return row;
    } catch {
      // A concurrent first call created it: read it back.
      const again = (await this.db.select().from(trustLevels)
        .where(and(eq(trustLevels.workspaceId, workspaceId), eq(trustLevels.agentId, agentId), eq(trustLevels.actionClass, cls)))).at(0);
      if (!again) throw new Error('trust level row could not be created');
      return again;
    }
  }

  /** The level that governs a call now: earned level, owner ceiling, org preset. */
  async effective(workspaceId: string, agentId: string, cls: ActionClass): Promise<{ level: TrustLevel; ceiling: TrustLevel; effective: TrustLevel; orgMode: string }> {
    const r = await this.row(workspaceId, agentId, cls);
    const ws = await this.workspaceRow(workspaceId);
    const orgMode = ws?.orgMode ?? 'off';
    return { level: clampLevel(r.level), ceiling: clampLevel(r.ceiling), effective: effectiveLevel({ level: r.level, ceiling: r.ceiling, orgMode, cls }), orgMode };
  }

  // ---- evidence ----

  /** One outcome for (agent, class): the record, then the arithmetic. */
  async record(workspaceId: string, agentId: string, cls: ActionClass, outcome: TrustOutcome, ref: { refType: string; refId: string }): Promise<LedgerChange | null> {
    if (!agentId || cls === 'read') return null;
    await this.db.insert(trustRecords).values({ id: newId(), workspaceId, agentId, actionClass: cls, outcome, refType: ref.refType, refId: ref.refId, at: nowIso() });
    const r = await this.row(workspaceId, agentId, cls);
    const org = await this.orgOf(workspaceId);
    const calibration = outcome === 'success' ? await this.calibrationOf(workspaceId, agentId).catch(() => null) : null;
    const { row, change } = applyOutcome(toLedger(r), outcome, {
      promoteAfterClean: actionsTunable(org, 'trust.promoteAfterClean'),
      demoteAfterRejections: actionsTunable(org, 'trust.demoteAfterRejections'),
      calibration,
      calibrationBar: actionsTunable(org, 'trust.calibrationBar'),
    });
    await this.persist(r, row, change, outcome === 'reverted' || outcome === 'incident', outcome === 'reverted' ? 'revert' : outcome === 'incident' ? 'incident' : 'ledger');
    return change;
  }

  /** An incident from the bus (item 29): demote at once. */
  async incident(ev: OrgIncidentEvent): Promise<Array<{ cls: ActionClass; change: LedgerChange | null }>> {
    if (!ev.agentId) return [];
    const org = (await this.db.select().from(organizations).where(eq(organizations.id, ev.orgId))).at(0);
    if (!org) return [];
    // A tool name (connection incidents write `gmail_send`) maps to its class.
    const named = normalizeActionClass(ev.actionClass);
    const classes: ActionClass[] = named && named !== 'read'
      ? [named]
      : ACTION_CLASSES.filter((c) => c !== 'read');
    const out: Array<{ cls: ActionClass; change: LedgerChange | null }> = [];
    for (const cls of classes) {
      await this.db.insert(trustRecords).values({ id: newId(), workspaceId: org.workspaceId, agentId: ev.agentId, actionClass: cls, outcome: 'incident', refType: 'incident', refId: ev.incidentId, at: nowIso() });
      const r = await this.row(org.workspaceId, ev.agentId, cls);
      const { row, change } = applyIncident(toLedger(r), ev.severity, `incident ${ev.kind}`);
      await this.persist(r, row, change, true, 'incident');
      out.push({ cls, change });
    }
    return out;
  }

  private async persist(before: TrustLevelRow, row: LedgerRow, change: LedgerChange | null, incident: boolean, source: string): Promise<void> {
    const now = nowIso();
    await this.db.update(trustLevels).set({
      level: row.level, cleanCount: row.cleanCount, rejectStreak: row.rejectStreak,
      ...(incident ? { lastIncidentAt: now } : {}),
      ...(change ? { lastChangedAt: now, reason: change.reason.slice(0, 300) } : {}),
    }).where(eq(trustLevels.id, before.id));
    if (change) await this.announce(before, change, source, 'system');
  }

  /** Audit + inbox for one level change. */
  private async announce(r: Pick<TrustLevelRow, 'workspaceId' | 'agentId' | 'actionClass'>, change: LedgerChange, source: string, actor: string): Promise<void> {
    const cls = r.actionClass as ActionClass;
    const up = change.to > change.from;
    const outward = EXTERNAL_CLASSES.includes(cls);
    await this.agentsSvc?.addEvent(r.agentId, {
      kind: 'trust_change',
      title: `Trust ${up ? 'raised' : 'lowered'} for ${cls.replace(/_/g, ' ')}: level ${change.from} → ${change.to}`,
      body: `${change.reason}. ${levelMeaning(change.to)}`,
      payload: JSON.stringify({ workspaceId: r.workspaceId, actionClass: cls, from: change.from, to: change.to, source }),
      origin: 'loop',
      // The owner hears at once when an agent may now do more outside the workspace.
      ...(up && outward ? { channel: true } : {}),
    }).catch(() => undefined);
    await this.hooks.audit?.(r.workspaceId, { actor, action: 'trust_change', refType: 'agent', refId: r.agentId, payload: { actionClass: cls, from: change.from, to: change.to, reason: change.reason, source } }).catch(() => undefined);
  }

  // ---- the owner's levers ----

  /** PUT …/trust/ceilings: per-class ceilings; levels above a lowered ceiling drop to it. */
  async setCeilings(workspaceId: string, patch: Record<string, unknown>, actor = actorId()): Promise<Record<ActionClass, TrustLevel>> {
    if (!(await this.isOwnerOrCeo(workspaceId, actor))) throw new ForbiddenException('only the owner or the CEO sets trust ceilings');
    const ws = await this.workspaceRow(workspaceId);
    if (!ws) throw new NotFoundException(`workspace ${workspaceId}`);
    const next = parseCeilings(ws.trustCeilings);
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!isActionClass(k)) throw new BadRequestException(`unknown action class "${k}" — known: ${ACTION_CLASSES.join(', ')}`);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 3) throw new BadRequestException(`ceiling for ${k} must be an integer 0–3`);
      next[k] = n as TrustLevel;
    }
    await this.db.update(workspaces).set({ trustCeilings: JSON.stringify(next) }).where(eq(workspaces.id, workspaceId));
    for (const cls of ACTION_CLASSES) {
      const rows = await this.db.select().from(trustLevels).where(and(eq(trustLevels.workspaceId, workspaceId), eq(trustLevels.actionClass, cls)));
      for (const r of rows) {
        const ceiling = next[cls];
        if (r.ceiling === ceiling && r.level <= ceiling) continue;
        const level = Math.min(r.level, ceiling);
        await this.db.update(trustLevels).set({ ceiling, level, ...(level !== r.level ? { lastChangedAt: nowIso(), reason: `owner ceiling ${ceiling}`, cleanCount: 0 } : {}) }).where(eq(trustLevels.id, r.id));
        if (level !== r.level) await this.announce(r, { from: clampLevel(r.level), to: clampLevel(level), reason: `the owner lowered the ${cls} ceiling to ${ceiling}` }, 'ceiling', actor);
      }
    }
    await this.hooks.audit?.(workspaceId, { actor, action: 'trust_ceilings_set', refType: 'workspace', refId: workspaceId, payload: { ceilings: next } }).catch(() => undefined);
    return next;
  }

  /** POST …/trust/:agentId/:class {level, reason}: the owner's override, ≤ ceiling, audited. */
  async override(workspaceId: string, agentId: string, cls: string, level: unknown, reason: string, actor = actorId()): Promise<TrustLevelRow> {
    if (!(await this.isOwnerOrCeo(workspaceId, actor))) throw new ForbiddenException('only the owner or the CEO overrides a trust level');
    if (!isActionClass(cls)) throw new BadRequestException(`unknown action class "${cls}" — known: ${ACTION_CLASSES.join(', ')}`);
    const n = Number(level);
    if (!Number.isInteger(n) || n < 0 || n > 3) throw new BadRequestException('level must be an integer 0–3');
    if (!reason || !reason.trim()) throw new BadRequestException('a reason is required — it is the audit row');
    const agent = (await this.db.select({ id: agents.id, workspaceId: agents.workspaceId }).from(agents).where(eq(agents.id, agentId))).at(0);
    if (!agent) throw new NotFoundException(`agent ${agentId}`);
    if (agent.workspaceId && agent.workspaceId !== workspaceId) throw new BadRequestException('that agent belongs to another workspace');
    const r = await this.row(workspaceId, agentId, cls);
    if (n > r.ceiling) throw new BadRequestException(`level ${n} is above the ${cls} ceiling (${r.ceiling}) — raise the ceiling first`);
    await this.db.update(trustLevels).set({ level: n, cleanCount: 0, rejectStreak: 0, lastChangedAt: nowIso(), reason: `owner: ${reason.trim()}`.slice(0, 300) }).where(eq(trustLevels.id, r.id));
    if (n !== r.level) await this.announce(r, { from: clampLevel(r.level), to: clampLevel(n), reason: `owner override: ${reason.trim()}` }, 'override', actor);
    else await this.hooks.audit?.(workspaceId, { actor, action: 'trust_override', refType: 'agent', refId: agentId, payload: { actionClass: cls, level: n, reason } }).catch(() => undefined);
    return this.row(workspaceId, agentId, cls);
  }

  // ---- reads ----

  /** GET …/trust: every agent of the workspace × class, with counts. */
  async overview(workspaceId: string): Promise<{
    workspaceId: string; orgMode: string; ceilings: Record<ActionClass, TrustLevel>; matrix: ReturnType<typeof describeMatrix>;
    agents: Array<{ agentId: string; name: string; classes: Array<{ actionClass: ActionClass; level: TrustLevel; ceiling: TrustLevel; effective: TrustLevel; cleanCount: number; rejectStreak: number; lastIncidentAt: string | null; lastChangedAt: string | null; reason: string; counts: Record<string, number> }> }>;
  }> {
    const ws = await this.workspaceRow(workspaceId);
    if (!ws) throw new NotFoundException(`workspace ${workspaceId}`);
    const roster = await this.db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.workspaceId, workspaceId));
    const ids = roster.map((a) => a.id);
    const records = ids.length ? await this.db.select().from(trustRecords).where(and(eq(trustRecords.workspaceId, workspaceId), inArray(trustRecords.agentId, ids))) : [];
    const out = [];
    for (const a of roster) {
      const classes = [];
      for (const cls of ACTION_CLASSES) {
        const r = await this.row(workspaceId, a.id, cls);
        const counts: Record<string, number> = {};
        for (const rec of records) if (rec.agentId === a.id && rec.actionClass === cls) counts[rec.outcome] = (counts[rec.outcome] ?? 0) + 1;
        classes.push({
          actionClass: cls, level: clampLevel(r.level), ceiling: clampLevel(r.ceiling),
          effective: effectiveLevel({ level: r.level, ceiling: r.ceiling, orgMode: ws.orgMode, cls }),
          cleanCount: r.cleanCount, rejectStreak: r.rejectStreak, lastIncidentAt: r.lastIncidentAt, lastChangedAt: r.lastChangedAt, reason: r.reason, counts,
        });
      }
      out.push({ agentId: a.id, name: a.name, classes });
    }
    return { workspaceId, orgMode: ws.orgMode, ceilings: parseCeilings(ws.trustCeilings), matrix: describeMatrix(), agents: out };
  }

  /** The `trust_status` tool: the caller's own levels; the chief sees everyone's. */
  async statusText(workspaceId: string, agentId: string): Promise<string> {
    const ws = await this.workspaceRow(workspaceId);
    const all = ws?.chiefOfStaffAgentId === agentId;
    const view = await this.overview(workspaceId);
    const rows = view.agents.filter((a) => all || a.agentId === agentId);
    const lines = rows.map((a) => `${a.name}${a.agentId === agentId ? ' (you)' : ''}: ${a.classes.filter((c) => c.actionClass !== 'read').map((c) => `${c.actionClass} ${c.effective}${c.effective !== c.level ? ` (earned ${c.level})` : ''}/${c.ceiling} · ${c.cleanCount} clean`).join(' · ')}`);
    return [
      `Trust levels (effective/ceiling; organization mode ${view.orgMode}). 0 proposes only, 1 acts and the owner hears after, 2 acts with a peer check (a second agent key for irreversible and money), 3 acts with auditor sampling only.`,
      ...lines,
      'Levels rise after clean outcomes and fall at once on an incident or a rejection streak. Prefer staging (drafts) where your level for irreversible actions is below 2.',
    ].join('\n');
  }

  async recent(workspaceId: string, agentId: string, limit = 20) {
    return this.db.select().from(trustRecords).where(and(eq(trustRecords.workspaceId, workspaceId), eq(trustRecords.agentId, agentId))).orderBy(desc(trustRecords.at)).limit(limit);
  }
}

export function parseCeilings(raw: string | null | undefined): Record<ActionClass, TrustLevel> {
  const out = { ...DEFAULT_CEILINGS };
  try {
    const v = JSON.parse(raw || '{}') as Record<string, unknown>;
    for (const [k, x] of Object.entries(v ?? {})) if (isActionClass(k) && Number.isFinite(Number(x))) out[k] = clampLevel(x);
  } catch { /* defaults */ }
  return out;
}

function toLedger(r: TrustLevelRow): LedgerRow {
  return { level: clampLevel(r.level), ceiling: clampLevel(r.ceiling), cleanCount: r.cleanCount, rejectStreak: r.rejectStreak };
}

function levelMeaning(l: TrustLevel): string {
  return [
    'Level 0: proposes only; the owner decides.',
    'Level 1: acts; the owner is notified after.',
    'Level 2: acts with a peer check (a second agent key for irreversible and money).',
    'Level 3: acts; only the auditor samples.',
  ][l];
}
