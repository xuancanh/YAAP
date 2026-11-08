/**
 * OrgAlignmentService — CEO alignment gates (docs/alignment.md).
 *
 * Product direction (the vision), the strategy memo, the OKRs (objectives
 * and key results) and the project bets an agent proposes are aligned before
 * the company builds on them. Each carries a row of `org_alignments`: draft →
 * in_alignment → aligned, `realign` after a material change, `rejected`.
 *
 *  - **Rows**: an item a person writes is aligned by being written; an item
 *    an agent writes starts as a draft, unless its class is auto-aligned
 *    here (`alignment.required.<class>` = 0 in an autonomous company), when
 *    the grant is logged for the CEO to review after the fact. Items that
 *    predate the gate have no row and are not gated until an agent changes
 *    them materially.
 *  - **The request**: the owner prepares a brief (what, why, options,
 *    trade-offs, measures, cost, what it unlocks) and calls
 *    org_request_alignment. The aligner is the CEO (an `alignment` decision
 *    card in the Inbox: approve, approve with changes, send back with
 *    comments, reject), the chief of staff (a task for the chief, decided with
 *    org_align) or nobody (auto-granted, logged). An objective is aligned
 *    with its key results in one request.
 *  - **The discussion**: the CEO and the owner exchange comments on the
 *    item's thread; a comment or a send-back reaches the owner's inbox and
 *    queues its unit's planning run.
 *  - **Material change**: an agent's edit to an aligned item that moves its
 *    scope, target, metric or timeline beyond the tolerances re-opens it
 *    (`realign`); a cosmetic edit does not; the CEO's own edit re-baselines.
 *  - **The gate** (bound into OrgTasksService.create and task moves): an
 *    agent's task under a project or goal chain with an item that is not
 *    aligned is refused with the remediation, except a capped amount of
 *    discovery work and operating work (`isAlignmentExempt`). Work that
 *    serves nothing (a unit's Unsorted) is capped while alignment is
 *    required: over the cap it waits as an unassigned proposal.
 *  - **Cadence**: an aligned item is due again after
 *    `alignment.cadenceDays.<class>` (the quarterly OKR alignment); the
 *    hourly sweep tells the owner and the chief, and returns expired cards
 *    to draft.
 *
 * Nothing here calls a model.
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgAlignments } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { AgentMemoryService } from '../agents/agent-memory.service';
import { OrgService, type OrgGoal, type OrgProject, type Organization } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgApprovalsService, type OrgApproval, type ApprovalDecision } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';
import { OrgIntentService } from './org-intent.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgUnitsService } from './org-units.service';
import { tunable } from './org-tunables';
import { parseIdList } from './work-model';
import {
  ALIGNMENT_CLASSES, CLASS_LABEL, CLEARED_STATES, ESCALATION_HINTS, ITEM_LABEL, alignerFor, assessCriteria, floorRequired, isAlignmentClass, parseCriteria, briefGaps, cadenceDaysOf, classOf, describeBrief, gateActive, gateRefusal, isAgentish, isAlignmentExempt,
  isAlignmentItemType, isDiscovery, isOperatingClass, materialChanges, parseAlignmentBrief, snapshotOfGoal, snapshotOfProject, snapshotOfStrategy,
  tolerancesOf, type Aligner, type AlignmentBrief, type AlignmentCriteria, type AlignmentClass, type AlignmentItemType, type AlignmentState, type AlignSnapshot, type GateTask,
} from './alignment';

export type OrgAlignment = typeof orgAlignments.$inferSelect;

/** One entry of an item's discussion. */
export interface ThreadEntry { at: string; by: string; kind: 'request' | 'comment' | 'aligned' | 'send_back' | 'rejected' | 'reopened' | 'system' | 'acknowledged' | 'classified' | 'pulled_in' | 'not_needed'; text: string; version?: number }

/** The owning agent's classification of an item. */
export interface Classification { needs: boolean; class: string; reasoning: string; criteria: AlignmentCriteria; assessed: { needs: boolean; reasons: string[]; suggestedClass: string | null }; by: string; at: string }

/** A spot-check finding (docs/alignment.md "Spot-checks"). */
export interface EscalationFinding { alignmentId: string; kind: 'under' | 'over'; title: string; label: string; owner: string | null; why: string }

/** What the Direction section and the tools read. */
export interface AlignmentView {
  id: string;
  itemType: AlignmentItemType;
  itemId: string;
  itemClass: AlignmentClass;
  label: string;
  title: string;
  state: AlignmentState;
  version: number;
  alignedVersion: number | null;
  alignedBy: string;
  alignedVia: string;
  alignedAt: string | null;
  conditions: string;
  ownerAgentId: string | null;
  brief: AlignmentBrief;
  thread: ThreadEntry[];
  approvalId: string | null;
  bundleOf: string | null;
  requestedBy: string;
  requestedAt: string | null;
  reopenReasons: string[];
  reviewDueAt: string | null;
  reviewDue: boolean;
  /** Who aligns it here now. */
  aligner: Aligner;
  /** Waiting on the CEO (a pending card, or a draft the CEO may align directly). */
  awaitingCeo: boolean;
  /** Aligned by the chief or auto-granted, not yet reviewed by the CEO. */
  needsCeoReview: boolean;
  /** The parent item (an objective for a key result, the vision for an objective). */
  parentId: string | null;
  /** The owner's call: true needs alignment, false not escalated, null not classified. */
  needsAlignment: boolean | null;
  classification: Classification | null;
  /** In a supervised company this class always goes to the CEO (the floor). */
  floor: boolean;
  pulledInAt: string | null;
  updatedAt: string;
}

const OPEN = new Set(['backlog', 'waiting', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked']);
const THREAD_CAP = 100;

interface ItemRef { itemType: AlignmentItemType; itemId: string; title: string; ownerAgentId: string | null; unitId: string | null; parentId: string | null; snapshot: AlignSnapshot }

@Injectable()
export class OrgAlignmentService {
  private readonly logger = new Logger(OrgAlignmentService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly approvals: OrgApprovalsService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    @Optional() private readonly intent?: OrgIntentService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() private readonly units?: OrgUnitsService,
    /** Optional: the spot-checks' feedback becomes a lesson of the owner (docs/agent-memory.md §12). */
    @Optional() private readonly memory?: AgentMemoryService,
  ) {
    tasks.setCreateGate((orgId, input) => this.gate(orgId, input));
    org.onGoalChange((goal, before, actor) => this.onGoal(goal, before, actor ?? 'user'));
    org.onProjectChange((project, before, actor) => this.onProject(project, before, actor));
    intent?.onStrategyMemo((ev) => this.onStrategy(ev.orgId, ev.before, ev.actor));
    approvals.onApply('alignment', (orgId, payload, approval, note) => this.applyCard(orgId, payload, approval, note ?? ''));
    approvals.onDecided((ev) => this.onDecided(ev.orgId, ev.approval, ev.decision, ev.note));
    runtime?.addTicker({ name: 'alignment', everyMinutes: 60, fn: (o, now) => this.sweep(o.id, now).then(() => undefined) });
    runtime?.addPlanningNotes((o, unitId, isChief) => this.planningNotes(o, unitId, isChief));
  }

  // ---- reads ----

  async rows(orgId: string): Promise<OrgAlignment[]> {
    return this.db.select().from(orgAlignments).where(eq(orgAlignments.orgId, orgId));
  }

  async row(orgId: string, id: string): Promise<OrgAlignment> {
    const r = (await this.db.select().from(orgAlignments).where(and(eq(orgAlignments.orgId, orgId), eq(orgAlignments.id, id))).limit(1)).at(0);
    if (!r) throw new NotFoundException(`alignment ${id}`);
    return r;
  }

  async rowFor(orgId: string, itemType: string, itemId: string): Promise<OrgAlignment | null> {
    return (await this.db.select().from(orgAlignments).where(and(eq(orgAlignments.orgId, orgId), eq(orgAlignments.itemType, itemType), eq(orgAlignments.itemId, itemId))).limit(1)).at(0) ?? null;
  }

  async modeOf(org: Organization): Promise<string> {
    return (await this.workspaces.get(org.workspaceId).catch(() => null))?.orgMode ?? 'off';
  }

  /** Every gated item with its state, newest first; the strategy and the vision lead. */
  async list(orgId: string, now: Date = new Date()): Promise<AlignmentView[]> {
    const org = await this.org.get(orgId);
    const mode = await this.modeOf(org);
    const goals = new Map((await this.org.goals(orgId)).map((g) => [g.id, g]));
    const projects = new Map((await this.org.projects(orgId)).map((p) => [p.id, p]));
    const pending = new Map((await this.approvals.pending(orgId)).map((a) => [a.id, a]));
    const out: AlignmentView[] = [];
    for (const r of await this.rows(orgId)) {
      const g = goals.get(r.itemId); const p = projects.get(r.itemId);
      if (r.itemType !== 'strategy' && !g && !p) continue;
      if (g && g.status === 'abandoned') continue;
      if (p && (p.status === 'cancelled' || p.status === 'done')) continue;
      out.push(this.view(r, org, mode, { title: r.itemType === 'strategy' ? firstLine(org.strategyMemo) || 'Strategy memo' : g?.title ?? p?.title ?? '', parentId: g?.parentGoalId ?? null, pending, now }));
    }
    const order: Record<string, number> = { strategy: 0, vision: 1, objective: 2, key_result: 3, project: 4 };
    return out.sort((a, b) => (order[a.itemType] ?? 9) - (order[b.itemType] ?? 9) || (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async get(orgId: string, id: string): Promise<AlignmentView> {
    const hit = (await this.list(orgId)).find((v) => v.id === id);
    if (!hit) throw new NotFoundException(`alignment ${id}`);
    return hit;
  }

  private view(r: OrgAlignment, org: Organization, mode: string, x: { title: string; parentId: string | null; pending: Map<string, OrgApproval>; now: Date }): AlignmentView {
    const cls = r.itemClass as AlignmentClass;
    const aligner = alignerFor(org, mode, cls);
    const card = r.approvalId ? x.pending.get(r.approvalId) : undefined;
    return {
      id: r.id, itemType: r.itemType as AlignmentItemType, itemId: r.itemId, itemClass: cls, label: ITEM_LABEL[r.itemType as AlignmentItemType] ?? r.itemType, title: x.title,
      state: r.state as AlignmentState, version: r.version, alignedVersion: r.alignedVersion, alignedBy: r.alignedBy, alignedVia: r.alignedVia, alignedAt: r.alignedAt,
      conditions: r.conditions, ownerAgentId: r.ownerAgentId, brief: parseAlignmentBrief(r.brief), thread: parseThread(r.thread), approvalId: card ? r.approvalId : null, bundleOf: r.bundleOf,
      requestedBy: r.requestedBy, requestedAt: r.requestedAt, reopenReasons: parseList(r.reopenReasons), reviewDueAt: r.reviewDueAt,
      reviewDue: r.state === 'aligned' && Boolean(r.reviewDueAt && r.reviewDueAt <= x.now.toISOString()),
      aligner, awaitingCeo: r.state === 'in_alignment' && aligner === 'ceo' && !r.bundleOf,
      needsCeoReview: r.state === 'aligned' && (r.alignedVia === 'auto' || r.alignedVia === 'chief') && !r.ceoReviewedAt,
      parentId: x.parentId, needsAlignment: r.needsAlignment === null || r.needsAlignment === undefined ? null : r.needsAlignment === 1,
      classification: parseClassification(r.classification), floor: floorRequired(org, mode, cls), pulledInAt: r.pulledInAt, updatedAt: r.updatedAt,
    };
  }

  // ---- the items ----

  private async item(orgId: string, itemType: string, itemId: string): Promise<ItemRef | null> {
    if (itemType === 'strategy') {
      const org = await this.org.get(orgId);
      return { itemType: 'strategy', itemId: orgId, title: firstLine(org.strategyMemo) || 'Strategy memo', ownerAgentId: org.chiefOfStaffAgentId, unitId: null, parentId: null, snapshot: snapshotOfStrategy(org.strategyMemo) };
    }
    if (itemType === 'project') {
      const p = await this.org.project(orgId, itemId).catch(() => null);
      return p ? { itemType: 'project', itemId: p.id, title: p.title, ownerAgentId: p.ownerAgentId, unitId: p.unitId, parentId: null, snapshot: snapshotOfProject(p) } : null;
    }
    const g = await this.org.goal(orgId, itemId).catch(() => null);
    if (!g || !isAlignmentItemType(g.kind)) return null;
    return { itemType: g.kind, itemId: g.id, title: g.title, ownerAgentId: g.ownerAgentId, unitId: g.unitId, parentId: g.parentGoalId, snapshot: snapshotOfGoal(g) };
  }

  /** An item by an agent's or the CEO's reference: vision / direction, strategy, a project key, a goal id, prefix or title, an alignment id. */
  async resolve(orgId: string, ref: string): Promise<ItemRef> {
    const q = (ref ?? '').trim();
    if (!q) throw new BadRequestException('item is required: "vision", "strategy", a project key (P-3) or a goal id from org_intent');
    const lower = q.toLowerCase();
    if (lower === 'strategy' || lower === 'strategy memo') return (await this.item(orgId, 'strategy', orgId))!;
    const goals = (await this.org.goals(orgId)).filter((g) => g.status !== 'abandoned');
    if (lower === 'vision' || lower === 'direction' || lower === 'product direction') {
      const v = goals.find((g) => g.kind === 'vision' && g.status === 'active') ?? goals.find((g) => g.kind === 'vision');
      if (!v) throw new BadRequestException('the company has no vision yet');
      return (await this.item(orgId, 'vision', v.id))!;
    }
    const projects = await this.org.projects(orgId);
    const p = projects.find((x) => x.kind === 'project' && ((x.key ?? '').toLowerCase() === lower || x.id === q || (q.length >= 6 && x.id.startsWith(q))));
    if (p) return (await this.item(orgId, 'project', p.id))!;
    const g = goals.filter((x) => x.id === q || (q.length >= 6 && x.id.startsWith(q)) || x.title.toLowerCase() === lower);
    if (g.length === 1) return (await this.item(orgId, g[0].kind, g[0].id))!;
    if (g.length > 1) throw new BadRequestException(`"${q}" matches ${g.length} goals — use the id from org_intent`);
    if (q.length >= 6) {
      const a = (await this.rows(orgId)).filter((r) => r.id.startsWith(q));
      if (a.length === 1) { const it = await this.item(orgId, a[0].itemType, a[0].itemId); if (it) return it; }
    }
    const pt = projects.filter((x) => x.kind === 'project' && x.title.toLowerCase() === lower);
    if (pt.length === 1) return (await this.item(orgId, 'project', pt[0].id))!;
    throw new BadRequestException(`no item "${q}" — name "vision", "strategy", a project key (P-3) or a goal id from org_intent`);
  }

  private async insert(orgId: string, it: ItemRef, input: { state: AlignmentState; via?: string; by: string; createdBy: string; thread?: ThreadEntry[]; needs?: number | null }): Promise<OrgAlignment> {
    const org = await this.org.get(orgId);
    const now = nowIso();
    const aligned = input.state === 'aligned';
    const cls = classOf(it.itemType);
    const row: OrgAlignment = {
      accountId: currentAccountId(), id: newId(), orgId, itemType: it.itemType, itemId: it.itemId, itemClass: cls,
      state: input.state, version: 1, alignedVersion: aligned ? 1 : null, alignedSnapshot: aligned ? JSON.stringify(it.snapshot) : '{}',
      alignedBy: aligned ? input.by.slice(0, 80) : '', alignedVia: aligned ? input.via ?? 'human' : '', alignedAt: aligned ? now : null, conditions: '', bundleOf: null,
      ownerAgentId: it.ownerAgentId ?? (input.createdBy.startsWith('agent:') ? input.createdBy.slice('agent:'.length) : input.createdBy === 'chief' ? org.chiefOfStaffAgentId : null),
      brief: '{}', thread: JSON.stringify(input.thread ?? []), approvalId: null, requestedBy: '', requestedAt: null, reopenReasons: '[]',
      reviewDueAt: aligned ? dueAfter(cadenceDaysOf(org, cls), now) : null, ceoReviewedAt: aligned && input.via !== 'auto' && input.via !== 'chief' ? now : null,
      needsAlignment: input.needs ?? null, classification: '{}', pulledInAt: null, feedback: '[]',
      createdBy: input.createdBy.slice(0, 80), createdAt: now, updatedAt: now,
    };
    await this.db.insert(orgAlignments).values(row).onConflictDoNothing();
    return (await this.rowFor(orgId, it.itemType, it.itemId)) ?? row;
  }

  private async patch(id: string, set: Partial<OrgAlignment>): Promise<void> {
    await this.db.update(orgAlignments).set({ ...set, updatedAt: nowIso() }).where(eq(orgAlignments.id, id));
  }

  private async pushThread(r: OrgAlignment, e: Omit<ThreadEntry, 'at'>): Promise<ThreadEntry[]> {
    const fresh = (await this.db.select().from(orgAlignments).where(eq(orgAlignments.id, r.id)).limit(1)).at(0) ?? r;
    const thread = [...parseThread(fresh.thread), { at: nowIso(), ...e, text: e.text.slice(0, 2_000) }].slice(-THREAD_CAP);
    await this.patch(r.id, { thread: JSON.stringify(thread) });
    return thread;
  }

  // ---- rows follow the items ----

  /** A new item: aligned when a person wrote it; else a draft, or auto-aligned (logged). */
  private async created(org: Organization, it: ItemRef, actor: string): Promise<void> {
    const mode = await this.modeOf(org);
    if (mode === 'off') return;
    if (!isAgentish(actor)) { await this.insert(org.id, it, { state: 'aligned', via: 'human', by: actor, createdBy: actor }); return; }
    const cls = classOf(it.itemType);
    const aligner = alignerFor(org, mode, cls);
    if (aligner === 'auto') {
      const r = await this.insert(org.id, it, { state: 'aligned', via: 'auto', by: 'auto', createdBy: actor, thread: [{ at: nowIso(), by: 'system', kind: 'aligned', text: `Auto-aligned: this company runs ${CLASS_LABEL[cls] ?? cls} items without review (alignment.required.${cls}). The CEO can review and override it.`, version: 1 }] });
      await this.audit.append(org.id, { actor: 'system', action: 'alignment_auto', refType: 'alignment', refId: r.id, payload: { itemType: it.itemType, itemId: it.itemId, title: it.title.slice(0, 120), by: actor } });
      return;
    }
    // The floor (supervised, alignment.floor.<class> = 1) needs no classification; otherwise the owner classifies it.
    await this.insert(org.id, it, { state: 'draft', by: actor, createdBy: actor, needs: floorRequired(org, mode, classOf(it.itemType)) ? 1 : null });
  }

  /** An edit: an agent's material change to an aligned item re-opens it; a person's edit re-baselines it. */
  private async edited(org: Organization, it: ItemRef, before: AlignSnapshot, actor: string): Promise<void> {
    const mode = await this.modeOf(org);
    if (mode === 'off') return;
    let r = await this.rowFor(org.id, it.itemType, it.itemId);
    const tol = tolerancesOf(org);
    if (!r) {
      // Predates the gate: tracked from the first material agent edit, with the old version as the aligned baseline.
      if (!isAgentish(actor) || materialChanges(before, it.snapshot, tol).length === 0) return;
      r = await this.insert(org.id, { ...it, snapshot: before }, { state: 'aligned', via: 'legacy', by: 'legacy', createdBy: actor });
    }
    if (r.state === 'not_required' && isAgentish(actor)) {
      // The owner's "does not need the CEO" covered the item as classified; a material change asks the question again.
      const reasons = materialChanges(parseSnap(r.alignedSnapshot), it.snapshot, tol);
      if (reasons.length) {
        await this.patch(r.id, { state: 'draft', needsAlignment: null, version: r.version + 1, reopenReasons: JSON.stringify(reasons) });
        await this.pushThread(r, { by: 'system', kind: 'reopened', text: `Changed materially (${reasons.join('; ')}): classify it again.`, version: r.version + 1 });
      }
      return;
    }
    if (r.state !== 'aligned') return;
    const aligned = parseSnap(r.alignedSnapshot);
    if (!isAgentish(actor)) {
      if (JSON.stringify(aligned) === JSON.stringify(it.snapshot)) return;
      await this.patch(r.id, { alignedSnapshot: JSON.stringify(it.snapshot), version: r.version + 1, alignedVersion: r.version + 1, alignedBy: actor.slice(0, 80), alignedVia: 'human', alignedAt: nowIso(), ceoReviewedAt: nowIso() });
      return;
    }
    const reasons = materialChanges(aligned, it.snapshot, tol);
    if (reasons.length === 0) return;
    const version = r.version + 1;
    const aligner = alignerFor(org, mode, r.itemClass as AlignmentClass);
    if (aligner === 'auto') {
      await this.patch(r.id, { version, alignedVersion: version, alignedSnapshot: JSON.stringify(it.snapshot), alignedBy: 'auto', alignedVia: 'auto', alignedAt: nowIso(), ceoReviewedAt: null, reopenReasons: JSON.stringify(reasons) });
      await this.pushThread(r, { by: 'system', kind: 'aligned', text: `Changed materially (${reasons.join('; ')}) and auto-aligned again at v${version}.`, version });
      await this.audit.append(org.id, { actor: 'system', action: 'alignment_auto', refType: 'alignment', refId: r.id, payload: { itemType: r.itemType, itemId: r.itemId, version, reasons, by: actor } });
      return;
    }
    await this.patch(r.id, { state: 'realign', version, reopenReasons: JSON.stringify(reasons) });
    await this.pushThread(r, { by: 'system', kind: 'reopened', text: `Re-opened by ${actor}: ${reasons.join('; ')}. New tasks under it wait until it is aligned again.`, version });
    await this.audit.append(org.id, { actor, action: 'alignment_reopened', refType: 'alignment', refId: r.id, payload: { itemType: r.itemType, itemId: r.itemId, version, reasons } });
    await this.notifyOwner(org, { ...r, version }, `Re-align ${ITEM_LABEL[r.itemType as AlignmentItemType]} "${clip(it.title, 80)}": it changed materially`, `${reasons.join('; ')}. Prepare a brief and call org_request_alignment.`);
  }

  private async onGoal(goal: OrgGoal, before: OrgGoal | null, actor: string): Promise<void> {
    if (!isAlignmentItemType(goal.kind) || goal.kind === 'strategy' || goal.kind === 'project') return;
    try {
      const org = await this.org.get(goal.orgId);
      const it = (await this.item(goal.orgId, goal.kind, goal.id))!;
      if (!before) { if (!(await this.rowFor(goal.orgId, goal.kind, goal.id))) await this.created(org, it, actor); return; }
      await this.edited(org, it, snapshotOfGoal(before), actor);
    } catch (err) { this.logger.warn(`alignment for goal ${goal.id}: ${err instanceof Error ? err.message : err}`); }
  }

  private async onProject(p: OrgProject, before: OrgProject | null, actor: string): Promise<void> {
    if (p.kind !== 'project') return;
    try {
      const org = await this.org.get(p.orgId);
      const it = (await this.item(p.orgId, 'project', p.id))!;
      if (!before) { if (!(await this.rowFor(p.orgId, 'project', p.id))) await this.created(org, it, actor); return; }
      // The CEO's bet (moving it to Now, by the card or by hand) aligns it.
      const r = await this.rowFor(p.orgId, 'project', p.id);
      if (r && r.state !== 'aligned' && !isAgentish(actor) && before.lane !== 'now' && p.lane === 'now') {
        await this.grant(org, r, { via: 'ceo', by: actor, conditions: '', note: 'the CEO moved it to Now (the bet)' });
        return;
      }
      await this.edited(org, it, snapshotOfProject(before), actor);
    } catch (err) { this.logger.warn(`alignment for project ${p.id}: ${err instanceof Error ? err.message : err}`); }
  }

  private async onStrategy(orgId: string, before: string, actor: string): Promise<void> {
    try {
      const org = await this.org.get(orgId);
      const it = (await this.item(orgId, 'strategy', orgId))!;
      const r = await this.rowFor(orgId, 'strategy', orgId);
      if (!r && !before.trim()) { await this.created(org, it, actor); return; }
      await this.edited(org, it, snapshotOfStrategy(before), actor);
    } catch (err) { this.logger.warn(`alignment for the strategy of ${orgId}: ${err instanceof Error ? err.message : err}`); }
  }

  // ---- the gate ----

  /** The items a task under `project` serves, nearest first: the project, its goals, their ancestors. */
  private async chainOf(orgId: string, project: OrgProject | null, cache?: { goals: Map<string, OrgGoal>; rows: OrgAlignment[] }): Promise<Array<{ row: OrgAlignment; title: string }>> {
    if (!project) return [];
    const goals = cache?.goals ?? new Map((await this.org.goals(orgId)).map((g) => [g.id, g]));
    const rows = cache?.rows ?? await this.rows(orgId);
    const byItem = new Map(rows.map((r) => [`${r.itemType}:${r.itemId}`, r]));
    const out: Array<{ row: OrgAlignment; title: string }> = [];
    const seen = new Set<string>();
    if (project.kind === 'project') { const r = byItem.get(`project:${project.id}`); if (r) out.push({ row: r, title: project.title }); }
    for (const gid of parseIdList(project.goalIds)) {
      let g = goals.get(gid);
      for (let i = 0; g && i < 10 && !seen.has(g.id); i++) {
        seen.add(g.id);
        const r = byItem.get(`${g.kind}:${g.id}`);
        if (r && g.status !== 'abandoned') out.push({ row: r, title: g.title });
        g = g.parentGoalId ? goals.get(g.parentGoalId) : undefined;
      }
    }
    return out;
  }

  /** Open discovery tasks under an item (in any project whose chain includes it). */
  private async openDiscovery(orgId: string, rowId: string): Promise<number> {
    const goals = new Map((await this.org.goals(orgId)).map((g) => [g.id, g]));
    const rows = await this.rows(orgId);
    const projects = await this.org.projects(orgId);
    const serving = new Set<string>();
    for (const p of projects) if ((await this.chainOf(orgId, p, { goals, rows })).some((c) => c.row.id === rowId)) serving.add(p.id);
    return (await this.tasks.list(orgId)).filter((t) => t.projectId && serving.has(t.projectId) && OPEN.has(t.status) && isDiscovery(t)).length;
  }

  /**
   * The task gate (OrgTasksService.create and task moves). Humans pass;
   * operating work passes; an agent's task under an item that is not aligned
   * is refused unless it is discovery within the cap; loose work in a
   * unit's Unsorted is capped while alignment is required.
   */
  async gate(orgId: string, input: Record<string, unknown> & { title: string; createdBy: string; source: string; class: string; projectId: string | null; move?: boolean }): Promise<{ demote?: string } | void> {
    if (!isAgentish(input.createdBy)) return;
    const org = await this.org.get(orgId);
    const mode = await this.modeOf(org);
    if (mode === 'off') return;
    const project = input.projectId ? await this.org.project(orgId, input.projectId).catch(() => null) : null;
    const gt: GateTask = { ...input, projectKind: project?.kind ?? null };
    if (isAlignmentExempt(gt)) return;
    const blocking: Array<{ row: OrgAlignment; title: string; aligner: Aligner }> = [];
    for (const c of await this.chainOf(orgId, project)) {
      if ((CLEARED_STATES as readonly string[]).includes(c.row.state)) continue;
      const aligner = alignerFor(org, mode, c.row.itemClass as AlignmentClass);
      // The company runs this class without review now (a mode switch, a lowered tunable): grant it, logged.
      if (aligner === 'auto') { await this.grant(org, c.row, { via: 'auto', by: 'auto', conditions: '', note: 'auto-aligned when work was created under it' }); continue; }
      blocking.push({ ...c, aligner });
    }
    if (blocking.length) {
      const first = blocking[0];
      const cap = tunable(org, 'alignment.discoveryCap');
      const open = await this.openDiscovery(orgId, first.row.id);
      if (isDiscovery(gt) && !input.move && open < cap) return;
      await this.audit.append(orgId, { actor: input.createdBy, action: 'alignment_gate_refused', refType: 'alignment', refId: first.row.id, payload: { title: String(input.title).slice(0, 120), projectId: input.projectId, discovery: isDiscovery(gt), move: Boolean(input.move) } }).catch(() => undefined);
      const unclassified = first.row.needsAlignment === null && !floorRequired(org, mode, first.row.itemClass);
      throw new BadRequestException(gateRefusal({ label: ITEM_LABEL[first.row.itemType as AlignmentItemType] ?? first.row.itemType, title: first.title, state: first.row.state as AlignmentState, aligner: first.aligner, unclassified }, { open, cap })
        + (isDiscovery(gt) && open >= cap ? ' The discovery cap is reached: finish the brief from what you have.' : ''));
    }
    if (!input.move && project?.kind === 'unsorted' && gateActive(org, mode) && !isOperatingClass(gt) && !isDiscovery(gt)) {
      const cap = tunable(org, 'alignment.unsortedCap');
      const open = (await this.tasks.list(orgId, { projectId: project.id })).filter((t) => OPEN.has(t.status) && isAgentish(t.createdBy) && !isOperatingClass(t) && !isAlignmentExempt({ ...t, projectKind: 'unsorted' }) && t.assigneeAgentId).length;
      if (open >= cap) return { demote: `Unsorted holds ${open} open task(s) that serve no aligned goal, its cap is ${cap} (alignment.unsortedCap): this one waits as a proposal — place work under the aligned project it serves` };
    }
  }

  // ---- the request ----

  /**
   * The owner asks for alignment with a brief. The aligner here decides the
   * path: auto (granted, logged), the chief (granted when the chief asks;
   * otherwise a task for the chief, decided with org_align), or the CEO (an
   * `alignment` card). With `includeChildren`, the item's descendants that are
   * not aligned go with it (an objective with its key results).
   */
  async request(orgId: string, ref: string, input: { brief: unknown; includeChildren?: boolean }, actor: string): Promise<{ row: OrgAlignment; outcome: 'aligned' | 'card' | 'chief' | 'already' | 'updated'; card?: OrgApproval; bundle: number; text: string }> {
    const org = await this.org.get(orgId);
    const mode = await this.modeOf(org);
    const it = await this.resolve(orgId, ref);
    const label = ITEM_LABEL[it.itemType];
    let r = await this.rowFor(orgId, it.itemType, it.itemId) ?? await this.insert(orgId, it, { state: 'draft', by: actor, createdBy: actor });
    const now = new Date();
    const due = r.state === 'aligned' && Boolean(r.reviewDueAt && r.reviewDueAt <= now.toISOString());
    if (r.state === 'aligned' && !due) return { row: r, outcome: 'already', bundle: 0, text: `${label} "${it.title}" is aligned (v${r.alignedVersion}${r.alignedAt ? `, ${r.alignedAt.slice(0, 10)}` : ''}, by ${r.alignedVia}). Build on it; a material change re-opens it.` };
    const brief = parseAlignmentBrief(input.brief);
    const gaps = briefGaps(brief);
    if (gaps.length) throw new BadRequestException(`refused: the alignment brief is missing ${gaps.join('; ')}. A brief says what, why, the options you considered, the trade-offs, how success is measured, what it costs and what work it unlocks.`);
    // A revised brief on a card that is still pending replaces the brief on the card.
    const pending = r.approvalId ? (await this.approvals.pending(orgId)).find((a) => a.id === r!.approvalId) : undefined;
    if (r.state === 'in_alignment' && pending) {
      await this.approvals.attach(orgId, pending.id, flatBrief(brief));
      await this.patch(r.id, { brief: JSON.stringify(brief) });
      await this.pushThread(r, { by: actor, kind: 'request', text: `Revised brief: ${brief.what}`, version: r.version });
      return { row: await this.row(orgId, r.id), outcome: 'updated', card: pending, bundle: 0, text: `Brief revised on the pending card ${pending.id.slice(0, 8)} for ${label} "${it.title}".` };
    }
    const bundle = input.includeChildren === false ? [] : await this.bundleOf(orgId, it);
    const cls = r.itemClass;
    const aligner = alignerFor(org, mode, cls);
    const d = await this.org.boundaryDecide(orgId, { kind: 'alignment', key: aligner, summary: `align ${label} "${clip(it.title, 80)}"` }, actor);
    if (d.outcome === 'refuse') throw new BadRequestException(d.reason);
    await this.patch(r.id, { needsAlignment: 1, brief: JSON.stringify(brief), requestedBy: actor.slice(0, 80), requestedAt: nowIso(), ownerAgentId: r.ownerAgentId ?? it.ownerAgentId ?? agentOf(actor, org) });
    await this.pushThread(r, { by: actor, kind: 'request', text: `Asked for alignment (v${r.version}): ${brief.what}${bundle.length ? ` — with ${bundle.length} child item(s)` : ''}`, version: r.version });
    for (const b of bundle) await this.patch(b.id, { state: 'in_alignment', bundleOf: r.id, requestedBy: actor.slice(0, 80), requestedAt: nowIso() });
    r = await this.row(orgId, r.id);
    if (aligner === 'auto') {
      await this.grant(org, r, { via: 'auto', by: 'auto', conditions: '', note: 'auto-aligned on request' });
      return { row: await this.row(orgId, r.id), outcome: 'aligned', bundle: bundle.length, text: `${label} "${it.title}" auto-aligned (this company runs ${CLASS_LABEL[cls] ?? cls} items without review; logged for the CEO). Decompose it into projects and tasks now.` };
    }
    const chiefId = org.chiefOfStaffAgentId;
    if (aligner === 'chief') {
      if (agentOf(actor, org) === chiefId) {
        await this.grant(org, r, { via: 'chief', by: 'chief', conditions: '', note: 'aligned by the chief of staff' });
        return { row: await this.row(orgId, r.id), outcome: 'aligned', bundle: bundle.length, text: `${label} "${it.title}" aligned by you as chief of staff (alignment.required.${cls} = chief; logged for the CEO, who can override it). Decompose it now.` };
      }
      await this.patch(r.id, { state: 'in_alignment', approvalId: null });
      if (chiefId) {
        await this.tasks.create(orgId, {
          title: `Align: ${label} "${clip(it.title, 120)}"`.slice(0, 200), assigneeAgentId: chiefId, status: 'todo', createdBy: `alignment:${r.id}`, source: 'escalation', class: 'discovery',
          brief: { outcome: `An alignment decision on ${label} "${it.title}": approve, send back with comments, or reject.`, context: describeBrief(brief), constraints: 'You align this class for the company (alignment.required). Decide with org_align; comments reach the owner.', done_when: 'org_align was called for this item.' },
        }).catch(() => undefined);
      }
      return { row: await this.row(orgId, r.id), outcome: 'chief', bundle: bundle.length, text: `Alignment requested from the chief of staff for ${label} "${it.title}". Tasks under it wait until it is aligned; discovery work stays open.` };
    }
    const card = await this.approvals.create(orgId, {
      kind: 'alignment', requestedBy: actor,
      recommendation: brief.why.slice(0, 600),
      payload: { alignmentId: r.id, itemType: it.itemType, itemId: it.itemId, itemClass: cls, classLabel: CLASS_LABEL[cls] ?? cls, label, title: it.title.slice(0, 200), version: r.version, ...flatBrief(brief), bundle: bundle.map((b) => b.id), bundleTitles: await this.titles(orgId, bundle), ...classificationFacts(parseClassification(r.classification)), boundary: d.verdict, boundaryRule: d.rule.id },
      card: { recommendedAction: 'approve', alternatives: brief.options.length ? brief.options : undefined },
    });
    await this.patch(r.id, { state: 'in_alignment', approvalId: card.id });
    return { row: await this.row(orgId, r.id), outcome: 'card', card, bundle: bundle.length, text: `Alignment requested from the CEO for ${label} "${it.title}" (card ${card.id.slice(0, 8)}${bundle.length ? `, with ${bundle.length} child item(s)` : ''}). Tasks under it wait until it is aligned; answer the CEO's comments with org_alignment_comment; discovery work stays open.` };
  }

  /** The descendants of an item (goals under it) that are not aligned yet. */
  private async bundleOf(orgId: string, it: ItemRef): Promise<OrgAlignment[]> {
    if (it.itemType === 'project' || it.itemType === 'strategy') return [];
    const goals = (await this.org.goals(orgId)).filter((g) => g.status !== 'abandoned');
    const rows = await this.rows(orgId);
    const out: OrgAlignment[] = [];
    const walk = (parent: string, depth: number) => {
      if (depth > 4) return;
      for (const g of goals.filter((x) => x.parentGoalId === parent)) {
        const r = rows.find((x) => x.itemType === g.kind && x.itemId === g.id);
        if (r && r.state !== 'aligned' && !(r.state === 'in_alignment' && r.approvalId)) out.push(r);
        walk(g.id, depth + 1);
      }
    };
    walk(it.itemId, 0);
    return out.slice(0, 20);
  }

  private async titles(orgId: string, rows: OrgAlignment[]): Promise<string[]> {
    const out: string[] = [];
    for (const r of rows) { const it = await this.item(orgId, r.itemType, r.itemId); if (it) out.push(`${ITEM_LABEL[it.itemType]}: ${clip(it.title, 100)}`); }
    return out;
  }

  // ---- decisions ----

  /** Grant alignment: the item and its bundle are aligned at their current version. */
  async grant(org: Organization, r: OrgAlignment, g: { via: string; by: string; conditions: string; note: string; quiet?: boolean }): Promise<void> {
    const it = await this.item(org.id, r.itemType, r.itemId);
    if (!it) return;
    const now = nowIso();
    const cls = r.itemClass as AlignmentClass;
    await this.patch(r.id, {
      state: 'aligned', alignedVersion: r.version, alignedSnapshot: JSON.stringify(it.snapshot), alignedBy: g.by.slice(0, 80), alignedVia: g.via, alignedAt: now,
      conditions: g.conditions.slice(0, 2_000), approvalId: null, reopenReasons: '[]', reviewDueAt: dueAfter(cadenceDaysOf(org, cls), now),
      ceoReviewedAt: g.via === 'auto' || g.via === 'chief' ? null : now,
    });
    await this.pushThread(r, { by: g.by, kind: 'aligned', text: g.conditions ? `Aligned with conditions: ${g.conditions}` : `Aligned (${g.note}).`, version: r.version });
    await this.audit.append(org.id, { actor: g.by === 'auto' ? 'system' : g.by, action: 'alignment_granted', refType: 'alignment', refId: r.id, payload: { itemType: r.itemType, itemId: r.itemId, title: it.title.slice(0, 120), version: r.version, via: g.via, conditions: g.conditions.slice(0, 300) } });
    for (const b of (await this.rows(org.id)).filter((x) => x.bundleOf === r.id && x.state === 'in_alignment')) await this.grant(org, b, { ...g, quiet: true, note: `with ${ITEM_LABEL[r.itemType as AlignmentItemType]} "${clip(it.title, 60)}"` });
    if (!g.quiet) {
      if (g.via !== 'auto' || r.requestedBy) await this.notifyOwner(org, r, `Aligned: ${ITEM_LABEL[r.itemType as AlignmentItemType]} "${clip(it.title, 80)}"${g.conditions ? ' (with conditions)' : ''}`, `${g.conditions ? `Conditions: ${g.conditions}\n` : ''}Decompose it into projects and tasks now.`);
      this.queuePlan(org, it, `${ITEM_LABEL[it.itemType]} "${clip(it.title, 80)}" is aligned${g.conditions ? ` with conditions: ${clip(g.conditions, 160)}` : ''} — decompose it into projects and tasks`);
    }
    // The chief's alignment task closes with the decision.
    await this.closeChiefTask(org, r.id);
  }

  private async closeChiefTask(org: Organization, rowId: string): Promise<void> {
    for (const t of (await this.tasks.list(org.id)).filter((x) => x.createdBy === `alignment:${rowId}` && OPEN.has(x.status))) await this.tasks.update(org.id, t.id, { status: 'done' }, 'system').catch(() => undefined);
  }

  /** The `alignment` card's applier: the CEO (or a delegate) approved it; the note is the conditions. */
  private async applyCard(orgId: string, payload: Record<string, unknown>, approval: OrgApproval, note: string): Promise<Record<string, unknown>> {
    const r = await this.row(orgId, String(payload.alignmentId ?? ''));
    const org = await this.org.get(orgId);
    await this.grant(org, { ...r, version: Number(payload.version ?? r.version) > r.version ? Number(payload.version) : r.version }, { via: 'ceo', by: 'ceo', conditions: note.trim(), note: `approved on card ${approval.id.slice(0, 8)}` });
    return { alignmentId: r.id, state: 'aligned', version: r.version, conditions: note.trim() };
  }

  /** A sent-back or rejected card: the CEO's comments go to the owner, who revises. */
  private async onDecided(orgId: string, approval: OrgApproval, decision: ApprovalDecision, note: string): Promise<void> {
    if (approval.kind !== 'alignment' || decision === 'approve') return;
    const payload = JSON.parse(approval.payload || '{}') as Record<string, unknown>;
    const r = await this.row(orgId, String(payload.alignmentId ?? '')).catch(() => null);
    if (!r) return;
    await this.backToOwner(await this.org.get(orgId), r, decision === 'reject' ? 'rejected' : 'send_back', note, 'ceo');
  }

  private async backToOwner(org: Organization, r: OrgAlignment, how: 'rejected' | 'send_back', note: string, by: string): Promise<void> {
    const state: AlignmentState = how === 'rejected' ? 'rejected' : r.alignedVersion ? 'realign' : 'draft';
    await this.patch(r.id, { state, approvalId: null });
    for (const b of (await this.rows(org.id)).filter((x) => x.bundleOf === r.id && x.state === 'in_alignment')) await this.patch(b.id, { state: b.alignedVersion ? 'realign' : 'draft', bundleOf: null });
    await this.pushThread(r, { by, kind: how, text: note || (how === 'rejected' ? 'Rejected.' : 'Sent back for revision.'), version: r.version });
    await this.audit.append(org.id, { actor: by, action: how === 'rejected' ? 'alignment_rejected' : 'alignment_sent_back', refType: 'alignment', refId: r.id, payload: { itemType: r.itemType, itemId: r.itemId, version: r.version, note: note.slice(0, 300) } });
    const it = await this.item(org.id, r.itemType, r.itemId);
    const title = it?.title ?? '';
    const who = by === 'ceo' ? 'The CEO' : 'The chief of staff';
    await this.notifyOwner(org, r, `${who} ${how === 'rejected' ? 'rejected' : 'sent back'} ${ITEM_LABEL[r.itemType as AlignmentItemType]} "${clip(title, 80)}"`, `${note ? `Comments: ${note}\n` : ''}${how === 'rejected' ? 'Rework it (a different option) or abandon it; do not build on it.' : 'Revise the item and the brief with these comments, then call org_request_alignment again; ask with org_alignment_comment where something is unclear.'}`);
    if (it) this.queuePlan(org, it, `${who} ${how === 'rejected' ? 'rejected' : 'sent back'} the alignment of ${ITEM_LABEL[it.itemType]} "${clip(title, 60)}"${note ? `: ${clip(note, 200)}` : ''} — revise and re-request`);
    await this.closeChiefTask(org, r.id);
  }

  /** The chief decides an item this company delegates to it (org_align). */
  async chiefDecide(orgId: string, ref: string, decision: 'approve' | 'send_back' | 'reject', note: string, actor: string): Promise<string> {
    const org = await this.org.get(orgId);
    if (agentOf(actor, org) !== org.chiefOfStaffAgentId) throw new BadRequestException('only the chief of staff aligns on the CEO\'s behalf');
    const mode = await this.modeOf(org);
    const it = await this.resolve(orgId, ref);
    const r = await this.rowFor(orgId, it.itemType, it.itemId);
    if (!r || r.state !== 'in_alignment') throw new BadRequestException(`${ITEM_LABEL[it.itemType]} "${it.title}" is not awaiting alignment${r ? ` (it is ${r.state})` : ''}`);
    const aligner = alignerFor(org, mode, r.itemClass as AlignmentClass);
    if (aligner !== 'chief') throw new BadRequestException(`refused: ${CLASS_LABEL[r.itemClass as AlignmentClass]} items here are aligned by ${aligner === 'ceo' ? 'the CEO — recommend on the card, or comment with org_alignment_comment' : 'nobody (auto)'}`);
    if (decision === 'approve') { await this.grant(org, r, { via: 'chief', by: 'chief', conditions: note.trim(), note: 'aligned by the chief of staff' }); return `Aligned ${ITEM_LABEL[it.itemType]} "${it.title}" (v${r.version}) on the CEO's behalf; logged for the CEO to review.`; }
    await this.backToOwner(org, r, decision === 'reject' ? 'rejected' : 'send_back', note, 'chief');
    return `${decision === 'reject' ? 'Rejected' : 'Sent back'} ${ITEM_LABEL[it.itemType]} "${it.title}" with your comments; the owner revises.`;
  }

  /**
   * The CEO acts from the Direction section on an item without a pending
   * card: align a draft directly, acknowledge (or condition) an alignment
   * granted without them, or override it — re-open (send back) or reject.
   * A pending card is decided through the approvals path (the controller).
   */
  async ceoAct(orgId: string, id: string, decision: 'approve' | 'approve_with_changes' | 'send_back' | 'reject' | 'pull_in' | 'not_needed', note: string, actor: string): Promise<AlignmentView> {
    const org = await this.org.get(orgId);
    const r = await this.row(orgId, id);
    const text = (note ?? '').trim();
    if (decision === 'pull_in') return this.pullIn(org, r, text, actor);
    if (decision === 'not_needed') return this.notNeeded(org, r, text, actor);
    if (decision === 'approve_with_changes' && !text) throw new BadRequestException('approve with changes needs the changes (the note)');
    if (decision === 'send_back' && !text) throw new BadRequestException('send back needs your comments');
    if (decision === 'approve' || decision === 'approve_with_changes') {
      if (r.state === 'aligned') {
        await this.patch(r.id, { ceoReviewedAt: nowIso(), ...(text ? { conditions: [r.conditions, text].filter(Boolean).join('\n').slice(0, 2_000) } : {}) });
        await this.pushThread(r, { by: actor, kind: 'acknowledged', text: text ? `Reviewed by the CEO, with conditions: ${text}` : 'Reviewed by the CEO.', version: r.version });
        await this.audit.append(orgId, { actor, action: 'alignment_reviewed', refType: 'alignment', refId: r.id, payload: { version: r.version, note: text.slice(0, 300) } });
        if (text) await this.notifyOwner(org, r, 'The CEO added conditions to an aligned item', text);
      } else await this.grant(org, r, { via: 'ceo', by: actor, conditions: text, note: 'aligned by the CEO' });
    } else if (r.state === 'aligned') {
      // An override after the fact: the alignment the chief or auto granted is withdrawn.
      await this.patch(r.id, { state: decision === 'reject' ? 'rejected' : 'realign', ceoReviewedAt: nowIso(), reopenReasons: JSON.stringify([`the CEO ${decision === 'reject' ? 'rejected' : 're-opened'} it: ${text || 'no reason given'}`]) });
      await this.pushThread(r, { by: actor, kind: decision === 'reject' ? 'rejected' : 'reopened', text: text || (decision === 'reject' ? 'Rejected by the CEO.' : 'Re-opened by the CEO.'), version: r.version });
      await this.audit.append(orgId, { actor, action: 'alignment_overridden', refType: 'alignment', refId: r.id, payload: { decision, version: r.version, via: r.alignedVia, note: text.slice(0, 300) } });
      const it = await this.item(orgId, r.itemType, r.itemId);
      await this.notifyOwner(org, r, `The CEO ${decision === 'reject' ? 'rejected' : 're-opened'} ${ITEM_LABEL[r.itemType as AlignmentItemType]} "${clip(it?.title ?? '', 80)}"`, `${text ? `Comments: ${text}\n` : ''}New tasks under it wait until it is aligned again. Revise and call org_request_alignment.`);
      if (it) this.queuePlan(org, it, `the CEO ${decision === 'reject' ? 'rejected' : 're-opened'} ${ITEM_LABEL[it.itemType]} "${clip(it.title, 60)}": ${clip(text, 200)}`);
    } else await this.backToOwner(org, r, decision === 'reject' ? 'rejected' : 'send_back', text, actor === 'user' ? 'ceo' : actor);
    return this.get(orgId, r.id);
  }

  /** A comment on the item's thread; a person's reaches the owner, an agent's the CEO's view. */
  async comment(orgId: string, id: string, text: string, actor: string): Promise<AlignmentView> {
    const body = (text ?? '').trim();
    if (!body) throw new BadRequestException('the comment needs text');
    const org = await this.org.get(orgId);
    const r = await this.row(orgId, id);
    await this.pushThread(r, { by: actor, kind: 'comment', text: body, version: r.version });
    await this.audit.append(orgId, { actor, action: 'alignment_comment', refType: 'alignment', refId: r.id, payload: { chars: body.length } });
    if (!isAgentish(actor)) {
      const it = await this.item(orgId, r.itemType, r.itemId);
      await this.notifyOwner(org, r, `The CEO commented on ${ITEM_LABEL[r.itemType as AlignmentItemType]} "${clip(it?.title ?? '', 80)}"`, `${body}\n\nReply with org_alignment_comment; revise the brief with org_request_alignment.`);
    } else if (r.approvalId) {
      // The CEO reads the agent's reply on the card's reading pane too.
      await this.approvals.attach(orgId, r.approvalId, { lastReply: body.slice(0, 600) }).catch(() => undefined);
    }
    return this.get(orgId, r.id);
  }


  // ---- who decides it needs the CEO: the owner's classification ----

  /**
   * The owning agent decides whether an item needs alignment, against the
   * criteria (docs/alignment.md). Refused, model-free, when the class is the
   * supervised floor and it says no, or when its own criteria say the item
   * needs alignment and it says no. "No" marks the item not_required (work
   * may start; the CEO sees it under "Not escalated" and can pull it in);
   * "yes" keeps it a draft awaiting the brief.
   */
  async classify(orgId: string, ref: string, input: { needsAlignment: unknown; class?: unknown; reasoning?: unknown; criteria?: unknown }, actor: string): Promise<{ row: OrgAlignment; text: string }> {
    const org = await this.org.get(orgId);
    const mode = await this.modeOf(org);
    const it = await this.resolve(orgId, ref);
    const label = ITEM_LABEL[it.itemType];
    const needs = input.needsAlignment === true || input.needsAlignment === 'true' || input.needsAlignment === 'yes';
    const no = input.needsAlignment === false || input.needsAlignment === 'false' || input.needsAlignment === 'no';
    if (!needs && !no) throw new BadRequestException('needsAlignment is required: true (it needs alignment) or false (it does not)');
    const reasoning = String(input.reasoning ?? '').trim();
    if (reasoning.length < 20) throw new BadRequestException('reasoning is required: say why, against the criteria (reversibility, blast radius, cost share, external commitment, novelty, conflicts)');
    const cls = input.class === undefined || input.class === null || input.class === '' ? classOf(it.itemType) : String(input.class);
    if (!isAlignmentClass(cls)) throw new BadRequestException(`class must be one of ${ALIGNMENT_CLASSES.join(', ')}`);
    const criteria = parseCriteria(input.criteria);
    const assessed = assessCriteria(criteria, tunable(org, 'alignment.costShare'));
    if (no && floorRequired(org, mode, cls)) throw new BadRequestException(`refused: ${CLASS_LABEL[cls]} items always need the CEO's alignment in this company (alignment.floor.${cls}) — prepare the brief and call org_request_alignment`);
    if (no && assessed.needs) throw new BadRequestException(`refused: your own criteria say it needs alignment — ${assessed.reasons.join('; ')}. Answer needsAlignment true (class ${assessed.suggestedClass ?? cls}), or correct the criteria if they are wrong.`);
    let r = await this.rowFor(orgId, it.itemType, it.itemId) ?? await this.insert(orgId, it, { state: 'draft', by: actor, createdBy: actor });
    const c: Classification = { needs, class: cls, reasoning: reasoning.slice(0, 1_500), criteria, assessed, by: actor, at: nowIso() };
    const aligned = r.state === 'aligned';
    const set: Partial<OrgAlignment> = { needsAlignment: needs ? 1 : 0, classification: JSON.stringify(c), itemClass: cls };
    if (!aligned && r.state !== 'in_alignment') {
      if (no) Object.assign(set, { state: 'not_required', alignedSnapshot: JSON.stringify(it.snapshot) });
      else if (r.state === 'not_required') set.state = 'draft';
    }
    await this.patch(r.id, set);
    await this.pushThread(r, { by: actor, kind: 'classified', text: `${needs ? 'Needs' : 'Does not need'} alignment (${CLASS_LABEL[cls]}): ${reasoning}`, version: r.version });
    await this.audit.append(orgId, { actor, action: 'alignment_classified', refType: 'alignment', refId: r.id, payload: { itemType: it.itemType, itemId: it.itemId, needs, class: cls, criteria, assessed: assessed.reasons } });
    r = await this.row(orgId, r.id);
    if (aligned) return { row: r, text: `${label} "${it.title}" is already aligned; your classification is recorded.` };
    if (no) return { row: r, text: `${label} "${it.title}" does not need alignment (recorded with your reasoning; the CEO sees it under "Not escalated" and can pull it in, and the chief and the auditor spot-check it). Work may start under it.` };
    // It needs alignment, and the company runs this class without review: granted now, logged.
    if (alignerFor(org, mode, cls) === 'auto' && r.state !== 'in_alignment') {
      await this.grant(org, r, { via: 'auto', by: 'auto', conditions: '', note: 'auto-aligned on classification' });
      return { row: await this.row(orgId, r.id), text: `${label} "${it.title}" needs alignment (${CLASS_LABEL[cls]}); this company runs that class without review, so it is auto-aligned and logged.` };
    }
    return { row: r, text: `${label} "${it.title}" needs alignment (${CLASS_LABEL[cls]}). Prepare the brief and call org_request_alignment.` };
  }

  /** The CEO pulls in an item the owner did not escalate: it needs alignment now, and the owner learns why. */
  private async pullIn(org: Organization, r: OrgAlignment, text: string, actor: string): Promise<AlignmentView> {
    if (r.state === 'in_alignment') throw new BadRequestException('it is already awaiting alignment');
    await this.patch(r.id, { state: r.alignedVersion ? 'realign' : 'draft', needsAlignment: 1, pulledInAt: nowIso() });
    await this.pushThread(r, { by: actor, kind: 'pulled_in', text: text || 'The CEO wants to align on this before more work starts.', version: r.version });
    await this.audit.append(org.id, { actor, action: 'alignment_pulled_in', refType: 'alignment', refId: r.id, payload: { itemType: r.itemType, itemId: r.itemId, wasState: r.state, note: text.slice(0, 300) } });
    const it = await this.item(org.id, r.itemType, r.itemId);
    await this.notifyOwner(org, r, `The CEO pulled in ${ITEM_LABEL[r.itemType as AlignmentItemType]} "${clip(it?.title ?? '', 80)}" for alignment`, `${text ? `${text}\n` : ''}New tasks under it wait until it is aligned. Prepare the brief and call org_request_alignment.`);
    await this.feedback(org, r, 'under', text || 'the CEO pulled it in', it?.title ?? '');
    if (it) this.queuePlan(org, it, `the CEO pulled in ${ITEM_LABEL[it.itemType]} "${clip(it.title, 60)}" for alignment${text ? `: ${clip(text, 160)}` : ''}`);
    return this.get(org.id, r.id);
  }

  /** The CEO says an escalation did not need them: it is cleared, and the owner learns to decide such items itself. */
  private async notNeeded(org: Organization, r: OrgAlignment, text: string, actor: string): Promise<AlignmentView> {
    const pending = r.approvalId ? (await this.approvals.pending(org.id)).find((a) => a.id === r.approvalId) : undefined;
    const it = await this.item(org.id, r.itemType, r.itemId);
    if (pending) await this.approvals.decide(org.id, pending.id, 'approve', '', actor === 'ceo' ? 'user' : actor).catch(() => undefined);
    else if (r.state !== 'aligned') await this.patch(r.id, { state: 'not_required', needsAlignment: 0, approvalId: null, alignedSnapshot: JSON.stringify(it?.snapshot ?? {}) });
    await this.pushThread(r, { by: actor, kind: 'not_needed', text: text || 'The CEO did not need to align on this: decide items like it yourself.', version: r.version });
    await this.audit.append(org.id, { actor, action: 'alignment_not_needed', refType: 'alignment', refId: r.id, payload: { itemType: r.itemType, itemId: r.itemId, note: text.slice(0, 300) } });
    await this.feedback(org, r, 'over', text || 'the CEO did not need to align on it', it?.title ?? '');
    return this.get(org.id, r.id);
  }

  /** Feed a spot-check or a CEO call back to the owner: a lesson and a line for the chief (once per item and kind). */
  private async feedback(org: Organization, r: OrgAlignment, kind: 'under' | 'over', why: string, title: string): Promise<boolean> {
    const fresh = await this.row(org.id, r.id);
    const done = parseList(fresh.feedback);
    if (done.includes(kind)) return false;
    await this.patch(r.id, { feedback: JSON.stringify([...done, kind]) });
    const cls = CLASS_LABEL[fresh.itemClass] ?? fresh.itemClass;
    const rule = kind === 'under'
      ? `When an item is like "${clip(title, 80)}" (${cls}), classify it as needing CEO alignment: ${clip(why, 200)}.`
      : `When an item is like "${clip(title, 80)}" (${cls}), decide it yourself — it did not need the CEO: ${clip(why, 200)}.`;
    const owner = fresh.ownerAgentId;
    if (owner) await this.memory?.record(owner, rule, { source: 'feedback', cause: 'decision', context: `alignment ${kind}-escalation`, evidence: [`alignment:${fresh.id.slice(0, 8)}`], tags: 'alignment escalation ceo' }).catch(() => undefined);
    await this.audit.append(org.id, { actor: 'system', action: kind === 'under' ? 'alignment_under_escalation' : 'alignment_over_escalation', refType: 'alignment', refId: fresh.id, payload: { title: title.slice(0, 120), why: why.slice(0, 300), owner } });
    if (org.chiefOfStaffAgentId && org.chiefOfStaffAgentId !== owner) {
      await this.agents.addEvent(org.chiefOfStaffAgentId, { kind: 'info', title: `${kind === 'under' ? 'Under' : 'Over'}-escalation: "${clip(title, 80)}"`, body: why.slice(0, 600), payload: JSON.stringify({ orgId: org.id, alignmentId: fresh.id, kind }), origin: 'org' }).catch(() => undefined);
    }
    return true;
  }

  /**
   * Spot-checks, model-free: under-escalation — an item the owner marked as
   * not needing alignment whose signals say otherwise (a floor class, an
   * appetite that is a material share of the envelope, goals across units,
   * words of an external commitment or a one-way door); over-escalation — an
   * item that went to the CEO although its own criteria cleared it and that
   * the CEO approved without a word. The chief's and the auditor's tool reads
   * them; the hourly sweep feeds new under-escalations back once.
   */
  async spotCheck(orgId: string): Promise<EscalationFinding[]> {
    const org = await this.org.get(orgId);
    const mode = await this.modeOf(org);
    const envelope = (await this.workspaces.get(org.workspaceId).catch(() => null))?.orgMonthlyUsd || org.monthlyBudgetUsd || 0;
    const threshold = tunable(org, 'alignment.costShare');
    const goals = new Map((await this.org.goals(orgId)).map((g) => [g.id, g]));
    const projects = new Map((await this.org.projects(orgId)).map((p) => [p.id, p]));
    const out: EscalationFinding[] = [];
    for (const v of await this.list(orgId)) {
      if (v.state === 'not_required') {
        const why: string[] = [];
        if (floorRequired(org, mode, v.itemClass)) why.push(`${CLASS_LABEL[v.itemClass]} is always the CEO's here`);
        const p = v.itemType === 'project' ? projects.get(v.itemId) : undefined;
        if (p && envelope > 0 && (p.appetiteUsd ?? 0) >= threshold * envelope) why.push(`its appetite ($${p.appetiteUsd}) is ${Math.round(((p.appetiteUsd ?? 0) / envelope) * 100)}% of the monthly envelope`);
        if (p) { const units = new Set(parseIdList(p.goalIds).map((g) => goals.get(g)?.unitId ?? 'root')); if (units.size >= 2) why.push(`it serves goals of ${units.size} units`); }
        const hit = ESCALATION_HINTS.exec(`${v.title} ${p?.brief ?? ''} ${goals.get(v.itemId)?.description ?? ''}`);
        if (hit) why.push(`it mentions "${hit[0]}" (an external commitment or a one-way door?)`);
        if (why.length) out.push({ alignmentId: v.id, kind: 'under', title: v.title, label: v.label, owner: v.ownerAgentId, why: why.join('; ') });
      } else if (v.state === 'aligned' && v.alignedVia === 'ceo' && v.classification && !v.classification.assessed.needs && !v.conditions && !floorRequired(org, mode, v.itemClass)) {
        out.push({ alignmentId: v.id, kind: 'over', title: v.title, label: v.label, owner: v.ownerAgentId, why: 'its own criteria cleared it and the CEO approved it without a comment' });
      }
    }
    return out;
  }

  describeFindings(f: EscalationFinding[]): string {
    if (f.length === 0) return 'No escalation findings: every item not escalated looks like the owner\'s to decide, and nothing reached the CEO that its criteria cleared.';
    return f.map((x) => `${x.kind === 'under' ? 'UNDER' : 'OVER'} ${x.alignmentId.slice(0, 8)} ${x.label} "${clip(x.title, 80)}" — ${x.why}`).join('\n');
  }

  // ---- notifications, planning, cadence ----

  private async notifyOwner(org: Organization, r: Pick<OrgAlignment, 'id' | 'ownerAgentId' | 'itemType' | 'itemId' | 'version'>, title: string, body: string): Promise<void> {
    const ids = new Set([r.ownerAgentId, org.chiefOfStaffAgentId].filter((x): x is string => Boolean(x)));
    for (const agentId of ids) {
      await this.agents.addEvent(agentId, { kind: 'info', title: title.slice(0, 200), body: body.slice(0, 1_500), payload: JSON.stringify({ orgId: org.id, alignmentId: r.id, itemType: r.itemType, itemId: r.itemId, version: r.version }), origin: 'org' }).catch(() => undefined);
    }
  }

  private queuePlan(org: Organization, it: ItemRef, reason: string): void {
    if (!this.runtime || !this.units || org.status !== 'active') return;
    void (async () => {
      const unitId = it.unitId ?? (await this.units!.rootUnit(org.id).catch(() => null))?.id;
      if (unitId) this.runtime!.queuePlanning(org.id, unitId, 'objective_assigned', reason);
    })().catch(() => undefined);
  }

  /** Hourly: a card that expired returns its item to draft; an aligned item past its cadence is due again (told once). */
  async sweep(orgId: string, now: Date = new Date()): Promise<{ expired: number; due: number }> {
    const org = await this.org.get(orgId);
    const rows = await this.rows(orgId);
    let expired = 0; let due = 0;
    const approvals = new Map((await this.approvals.list(orgId)).map((a) => [a.id, a]));
    for (const r of rows) {
      if (r.state === 'in_alignment' && r.approvalId) {
        const a = approvals.get(r.approvalId);
        if (a && (a.status === 'expired' || a.status === 'rejected' || a.status === 'revision_requested')) {
          if (a.status === 'expired') {
            await this.patch(r.id, { state: r.alignedVersion ? 'realign' : 'draft', approvalId: null });
            await this.pushThread(r, { by: 'system', kind: 'system', text: 'The card expired unanswered; ask again when the brief is current.', version: r.version });
            await this.notifyOwner(org, r, 'An alignment card expired unanswered', 'Re-request alignment with org_request_alignment (the brief may need refreshing).');
            expired++;
          }
        }
      }
      if (r.state === 'aligned' && r.reviewDueAt && r.reviewDueAt <= now.toISOString()) {
        const thread = parseThread(r.thread);
        if (!thread.some((e) => e.kind === 'system' && e.text.startsWith(`Re-alignment due since ${r.reviewDueAt!.slice(0, 10)}`))) {
          await this.pushThread(r, { by: 'system', kind: 'system', text: `Re-alignment due since ${r.reviewDueAt.slice(0, 10)} (alignment.cadenceDays.${r.itemClass}): bring a fresh brief to the CEO.`, version: r.version });
          const it = await this.item(orgId, r.itemType, r.itemId);
          await this.notifyOwner(org, r, `Re-alignment due: ${ITEM_LABEL[r.itemType as AlignmentItemType]} "${clip(it?.title ?? '', 80)}"`, `It was aligned ${r.alignedAt?.slice(0, 10) ?? ''}; the company re-aligns ${CLASS_LABEL[r.itemClass as AlignmentClass]} items every ${cadenceDaysOf(org, r.itemClass as AlignmentClass)} days. Grade it, prepare a brief and call org_request_alignment.`);
          due++;
        }
      }
    }
    for (const f of await this.spotCheck(orgId).catch(() => [] as EscalationFinding[])) {
      const r = rows.find((x) => x.id === f.alignmentId);
      if (r && f.kind === 'under' && !parseList(r.feedback).includes('under')) await this.feedback(org, r, 'under', f.why, f.title);
    }
    return { expired, due };
  }

  /** The planning prompt's alignment section: alignment is the first stage of planning. */
  async planningNotes(org: Organization, unitId: string, isChief: boolean): Promise<string[]> {
    const mode = await this.modeOf(org);
    if (mode === 'off') return [];
    const who = (cls: AlignmentClass) => ({ ceo: 'the CEO', chief: 'the chief of staff', auto: 'auto (logged)' }[alignerFor(org, mode, cls)]);
    const all = await this.list(org.id);
    const goals = new Map((await this.org.goals(org.id)).map((g) => [g.id, g]));
    const projects = new Map((await this.org.projects(org.id)).map((p) => [p.id, p]));
    const mine = all.filter((v) => isChief || (v.itemType === 'project' ? projects.get(v.itemId)?.unitId === unitId : goals.get(v.itemId)?.unitId === unitId));
    const open = mine.filter((v) => v.state !== 'aligned' && !v.bundleOf);
    const dueRows = mine.filter((v) => v.reviewDue);
    if (!gateActive(org, mode) && open.length === 0 && dueRows.length === 0) return [];
    const lines = [
      '## Alignment first (docs/alignment.md)',
      `What the company builds toward is aligned before work is created under it. Who aligns here: direction ${who('direction')}, strategy ${who('strategy')}, OKRs ${who('okr')}, project bets ${who('projectBet')}.`,
      `Order: ${isChief ? 'draft the direction (the vision) → the strategy (org_strategy_memo) → the objectives and key results' : 'draft your key results under the objectives handed to you'}, then for each item prepare a brief — what, why, the options you considered, the trade-offs, the success measures, what it costs, what work it unlocks — and request alignment with org_request_alignment (an objective goes with its key results in one request). Only after an item is aligned decompose it into projects and tasks. Tasks under an item that is not aligned are refused; shaping work you need for the brief is allowed as class discovery (at most ${tunable(org, 'alignment.discoveryCap')} open per item). Do not route around it through Unsorted: work that serves no aligned goal is capped (alignment.unsortedCap).`,
    ];
    if (open.length) lines.push(`Not aligned yet:\n${open.slice(0, 12).map((v) => `- ${v.label} "${clip(v.title, 90)}" — ${stateLine(v)}`).join('\n')}`);
    if (dueRows.length) lines.push(`Due for re-alignment:\n${dueRows.slice(0, 8).map((v) => `- ${v.label} "${clip(v.title, 90)}" (aligned ${v.alignedAt?.slice(0, 10) ?? '?'})`).join('\n')}`);
    return [lines.join('\n')];
  }

  /** One line per item for an agent (the tools' list view). */
  describe(views: AlignmentView[]): string {
    if (views.length === 0) return 'No alignment-gated items yet. Items an agent drafts (the vision, the strategy memo, objectives, key results, project bets) start as drafts when the company requires alignment.';
    return views.map((v) => `${v.id.slice(0, 8)} ${v.label} "${clip(v.title, 90)}" — ${stateLine(v)}${v.bundleOf ? ' (in a bundle)' : ''}`).join('\n');
  }

  describeOne(v: AlignmentView): string {
    return [
      `${v.label} "${v.title}" — ${stateLine(v)} (version ${v.version}${v.alignedVersion ? `, aligned v${v.alignedVersion}` : ''}; aligner here: ${v.aligner})`,
      v.conditions ? `Conditions: ${v.conditions}` : '',
      v.reopenReasons.length ? `Re-opened because: ${v.reopenReasons.join('; ')}` : '',
      v.brief.what ? `Brief:\n${describeBrief(v.brief)}` : 'Brief: none yet.',
      v.thread.length ? `Thread:\n${v.thread.slice(-12).map((e) => `- ${e.at.slice(0, 16).replace('T', ' ')} ${e.by} (${e.kind}): ${clip(e.text, 400)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
  }
}

function stateLine(v: AlignmentView): string {
  switch (v.state) {
    case 'aligned': return `aligned${v.alignedAt ? ` ${v.alignedAt.slice(0, 10)}` : ''} by ${v.alignedVia === 'human' ? 'the CEO (authored)' : v.alignedVia}${v.reviewDue ? ', re-alignment due' : ''}`;
    case 'in_alignment': return v.aligner === 'ceo' ? 'awaiting the CEO' : v.aligner === 'chief' ? 'awaiting the chief of staff' : 'in alignment';
    case 'realign': return `needs re-alignment${v.reopenReasons.length ? ` (${clip(v.reopenReasons.join('; '), 140)})` : ''}`;
    case 'rejected': { const last = [...v.thread].reverse().find((e) => e.kind === 'rejected'); return `rejected${last ? `: ${clip(last.text, 140)}` : ''}`; }
    default: { const last = [...v.thread].reverse().find((e) => e.kind === 'send_back'); return last ? `sent back: ${clip(last.text, 140)}` : 'draft — prepare a brief and call org_request_alignment'; }
  }
}

function flatBrief(b: AlignmentBrief): Record<string, unknown> {
  return { what: b.what, why: b.why, options: b.options, tradeoffs: b.tradeoffs, measures: b.measures, cost: b.cost, unlocks: b.unlocks };
}

function agentOf(actor: string, org: Organization): string | null {
  if (actor === 'chief') return org.chiefOfStaffAgentId;
  return actor.startsWith('agent:') ? actor.slice('agent:'.length) : null;
}

function dueAfter(days: number, from: string): string | null {
  if (!days || days <= 0) return null;
  return new Date(Date.parse(from) + days * 86_400_000).toISOString();
}

function firstLine(s: string): string { return clip((s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? '', 120); }
function clip(s: string, n: number): string { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; }
function parseThread(raw: string | null | undefined): ThreadEntry[] { try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v as ThreadEntry[] : []; } catch { return []; } }
function parseList(raw: string | null | undefined): string[] { try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } }
function parseSnap(raw: string | null | undefined): AlignSnapshot { try { return JSON.parse(raw || '{}') as AlignSnapshot; } catch { return {}; } }

function parseClassification(raw: string | null | undefined): Classification | null {
  try { const v = JSON.parse(raw || '{}') as Partial<Classification>; return v && typeof v.needs === 'boolean' ? v as Classification : null; } catch { return null; }
}

/** The classification as flat card facts (the Inbox reading pane shows them). */
function classificationFacts(c: Classification | null): Record<string, unknown> {
  if (!c) return {};
  return { classifiedNeeds: c.needs, classifiedReasoning: c.reasoning.slice(0, 600), criteriaReasons: c.assessed.reasons };
}
