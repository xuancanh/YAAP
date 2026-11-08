/**
 * OrgImprovementsService — improvement proposals, change enablement and
 * admission control on self-generated work (docs/improvements.md).
 *
 * Proposals: a retro, a postmortem, a process review, process discovery
 * or any member raises an `org_improvements` row — a target, its evidence,
 * a hypothesis, the proposed change and the metric it should move — within
 * the company's caps (`improve.maxOpenPerTarget`, `improve.maxOpenPerUnit`,
 * `improve.perMeeting`). The change class is model-free (improvement-model
 * `classify`): a standard change (the target's owner, reversible, controls
 * untouched) applies at once; a normal one is an `improvement` decision card
 * routed by decision routing from the proposer (its manager decides within
 * authority, charters and tunables climb to the CEO); an emergency one (a
 * mitigation or repair while its incident is open) applies at once and the
 * owner reviews it afterwards — a rejected review reverts it. Accepting
 * applies through the target's own versioning: a process edit is a new
 * process version, a policy or standard a revision, a playbook a new
 * version in peer review, a charter, a cadence or a tunable their own
 * writers. A prose-only proposal becomes one task (source `proposal`) for
 * the owner. After `improve.verifyDays` the expected metric is compared with
 * the baseline taken at apply; a miss opens a revert proposal (or reverts at
 * once, `improve.autoRevert`). Every move is in `history`; deadlines live on
 * the row and the sweep resumes them after a restart (the change-record
 * pattern of plugins/changes.service.ts).
 *
 * Retros: the minutes executor hands a retro's actions here
 * (`ImprovementSink`): the top N become proposals, a concrete repair stays
 * a task, the rest are kept in the minutes as not raised.
 *
 * Admission control: every task's origin is classified (improvement-model
 * `originOf`); self-started work — agent initiative, retro and meeting
 * actions outside a project bet — enters only within a per-unit WIP cap and
 * a per-member rate cap (`admission.*`); over the cap it is refused with
 * remediation or parked, never dropped. The attention budget defers wakes a
 * member gets from other agents beyond `attention.agentWakesPerHour`.
 * `workSources` measures it all for the chief, the heads and the UI.
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, gte } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgAudit, orgCadences, orgImprovements, orgIncidents, orgMetricSources } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import type { OrgWakeEvent } from '../chats/trigger-bus';
import { OrgService, type Organization } from './org.service';
import { OrgTasksService, type OrgTask } from './org-tasks.service';
import { OrgApprovalsService, type OrgApproval } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';
import { OrgUnitsService } from './org-units.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgMeetingsService, type ImprovementSink, type MinutesAction, type OrgMeeting } from './org-meetings.service';
import { OrgProcessesService } from './org-processes.service';
import { OrgQualityService } from './org-quality.service';
import { OrgPlaybooksService } from './org-playbooks.service';
import { diffProcess, normalizeProcess, touchesControls, type ProcessDef } from './process-model';
import { processTunable } from './process-tunables';
import { checkTunable, tunable } from './org-tunables';
import { taskRef } from '../common/task-keys';
import { improvementTunable } from './improvement-tunables';
import {
  CATEGORY_WORD, OPEN_STATUSES, SELF_ORIGINS, TARGET_WORD, UNSETTLED_STATUSES, WORK_ORIGINS,
  admissionOf, admissionRefusal, canMove, categoryOf, classify, describeExpected, isCategory, originOf, parseEvidence, parseExpected, parseTargetRef, routeActions, sourceShares, sourcesLine, verdictOf,
  type AdmissionTask, type ChangeClass, type Evidence, type ExpectedChange, type HistoryEntry, type ImprovementCategory, type ImprovementOrigin, type ImprovementStatus, type ImprovementTarget, type SourceRow, type Verification, type WorkOrigin,
} from './improvement-model';

export type OrgImprovement = typeof orgImprovements.$inferSelect;

/** What a caller gives to raise a proposal (the tools, the minutes executor,
 *  process discovery: `createProposal`). */
export interface ProposalInput {
  title: string;
  /** "process:<name>", { kind, ref }, or null (the owner names it on acceptance). */
  target?: string | { kind: string; ref: string } | null;
  evidence: unknown;
  hypothesis: string;
  /** The target-specific change: process { def } (or { rollbackTo }); policy / quality_standard { fields };
   *  playbook { body }; charter { text, mode? }; cadence { cron } | { enabled }; tunable { value }. */
  change?: Record<string, unknown> | null;
  /** Prose lines of the change when it is not structured. */
  diff?: string[] | string;
  expected?: unknown;
  category?: string;
  origin?: ImprovementOrigin;
  originRef?: string;
  incidentId?: string | null;
  unitId?: string | null;
  /** The proposal a revert proposal undoes. */
  revertOf?: string | null;
}

/** A target as resolved: what it is, who owns it, what its change does. */
interface Resolved {
  kind: ImprovementTarget | null; ref: string; label: string; unitId: string | null; owner: string;
  diff: string[]; concrete: boolean; loosens: boolean; touchesControls: boolean; revertData: Record<string, unknown>; change: Record<string, unknown>;
}

const DAY = 86_400_000;
const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { const v = JSON.parse(raw || '') as T; return v ?? fallback; } catch { return fallback; } };
const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);
const agentOf = (holder: string) => (holder.startsWith('agent:') ? holder.slice(6) : null);
const isPerson = (actor: string) => actor === 'user' || actor.startsWith('human:');

@Injectable()
export class OrgImprovementsService {
  /** Test seam: the clock. */
  now: () => Date = () => new Date();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly approvals: OrgApprovalsService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly meetings: OrgMeetingsService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() private readonly processes?: OrgProcessesService,
    @Optional() private readonly quality?: OrgQualityService,
    @Optional() private readonly playbooks?: OrgPlaybooksService,
  ) {
    approvals.onApply('improvement', (orgId, payload, a, note) => this.cardApproved(orgId, a, payload, note ?? ''));
    approvals.onDecided(({ orgId, approval, decision, note }) => {
      if (approval.kind !== 'improvement' || decision === 'approve') return;
      return this.cardDeclined(orgId, approval, decision, note).then(() => undefined).catch(() => undefined);
    });
    tasks.setAdmissionGate((orgId, input) => this.admit(orgId, input));
    tasks.onTransition((ev) => { if (ev.to === 'done' || ev.to === 'cancelled') void this.onTaskSettled(ev.orgId, ev.taskId, ev.to).catch(() => undefined); });
    meetings.setImprovementSink(this.sink());
    runtime?.setAttentionGate((ev) => this.attention(ev));
    runtime?.addTicker({ name: 'improvements', everyMinutes: 15, fn: (org) => this.sweep(org.id).then(() => undefined) });
  }

  // ---- reads ----

  async list(orgId: string, opts: { status?: string; unitId?: string | null; limit?: number } = {}): Promise<OrgImprovement[]> {
    const conds = [eq(orgImprovements.orgId, orgId)];
    if (opts.status) conds.push(eq(orgImprovements.status, opts.status));
    if (opts.unitId) conds.push(eq(orgImprovements.unitId, opts.unitId));
    return this.db.select().from(orgImprovements).where(and(...conds)).orderBy(desc(orgImprovements.createdAt)).limit(Math.min(500, opts.limit ?? 200));
  }

  async get(orgId: string, ref: string): Promise<OrgImprovement> {
    const q = (ref ?? '').trim();
    const rows = await this.list(orgId, { limit: 500 });
    const hit = rows.find((r) => r.id === q || r.key.toLowerCase() === q.toLowerCase()) ?? (q.length >= 6 ? rows.find((r) => r.id.startsWith(q)) : undefined);
    if (!hit) throw new NotFoundException(`no improvement "${ref}" — org_improvements lists them`);
    return hit;
  }

  /** A proposal as the API and the UI read it (JSON fields parsed). */
  view(r: OrgImprovement) {
    return {
      ...r, evidence: parse<Evidence[]>(r.evidence, []), change: parse<Record<string, unknown>>(r.change, {}), diff: parse<string[]>(r.diff, []), expected: parse<ExpectedChange | null>(r.expected, null),
      verification: parse<Verification | null>(r.verification, null), history: parse<HistoryEntry[]>(r.history, []), revertData: undefined,
      expectedText: describeExpected(parse<ExpectedChange | null>(r.expected, null)),
    };
  }

  // ---- raising a proposal ----

  /**
   * Raise an improvement proposal (the one entry point: the tools, a retro's
   * minutes, process discovery, a failed verification). Refuses with what to
   * do instead when evidence or a hypothesis is missing or a cap is full.
   * Standard and emergency changes apply at once; a normal one waits for its
   * decision card.
   */
  async createProposal(orgId: string, input: ProposalInput, actor: string): Promise<{ proposal: OrgImprovement; text: string }> {
    const org = await this.org.get(orgId);
    const title = clip(input.title, 200);
    const hypothesis = clip(input.hypothesis, 2_000);
    const evidence = parseEvidence(input.evidence);
    if (!title) throw new BadRequestException('refused: a proposal needs a title');
    if (!hypothesis) throw new BadRequestException('refused: a proposal needs a hypothesis — why this change should fix what the evidence shows');
    if (evidence.length === 0) throw new BadRequestException('refused: a proposal needs evidence — an event-log query, a metric trend, a postmortem, an incident, repeated lessons or deviations (task keys, run keys, metric values)');
    let expected: ExpectedChange | null;
    try { expected = parseExpected(input.expected); } catch (err) { throw new BadRequestException(`refused: ${(err as Error).message}`); }
    const target = input.target ? parseTargetRef(input.target) : null;
    if (input.target && !target) throw new BadRequestException('refused: target must be process:<name> | policy:<key> | quality_standard:<slug> | playbook:<name> | charter:<member> | cadence:<kind> | tunable:<key>');
    const category: ImprovementCategory = isCategory(input.category) ? input.category : categoryOf({ title, outcome: hypothesis });
    const origin: ImprovementOrigin = input.origin ?? (isPerson(actor) ? 'ceo' : 'agent');
    const res = await this.resolve(org, target, input.change ?? null, input.diff);
    const unitId = input.unitId ?? res.unitId ?? (await this.unitOfActor(orgId, actor));
    const capped = !isPerson(actor) && origin !== 'verification';
    if (capped) await this.checkCaps(org, res, unitId);
    const incidentOpen = await this.incidentOpen(orgId, input.incidentId ?? null);
    const proposerAgent = actor === 'chief' ? org.chiefOfStaffAgentId : agentOf(actor);
    const proposerOwns = isPerson(actor) || (proposerAgent !== null && (res.owner === `agent:${proposerAgent}` || proposerAgent === org.chiefOfStaffAgentId));
    const editApproval = res.kind === 'process' ? processTunable(org, 'process.editApproval') : 0;
    const { cls, why } = classify({ target: res.kind, category, incidentOpen, loosens: res.loosens, touchesControls: res.touchesControls || editApproval >= 2, concrete: res.concrete }, { standardScope: improvementTunable(org, 'improve.standardScope'), emergency: improvementTunable(org, 'improve.emergency') });
    const finalCls: ChangeClass = cls === 'standard' && !proposerOwns ? 'normal' : cls;
    const classWhy = cls === 'standard' && !proposerOwns ? 'a change to what another member owns: its owner approves it' : why;
    const now = this.now();
    const row: OrgImprovement = {
      accountId: currentAccountId(), id: newId(), orgId, key: await this.nextKey(orgId), unitId, title,
      targetKind: res.kind ?? '', targetRef: res.ref, targetLabel: res.label,
      evidence: JSON.stringify(evidence), hypothesis, change: JSON.stringify(res.change), diff: JSON.stringify(res.diff.slice(0, 60)), expected: JSON.stringify(expected),
      category, changeClass: finalCls, classWhy, owner: res.owner, proposedBy: actor.slice(0, 80), origin, originRef: clip(input.originRef, 120), incidentId: input.incidentId ?? null,
      status: 'proposed', approvalId: null, reviewPending: 0, appliedRef: '', revertData: JSON.stringify(res.revertData), baseline: null, verifyAt: null,
      verification: 'null', revertOf: input.revertOf ?? null, lastError: '',
      history: JSON.stringify([{ from: '', to: 'proposed', by: actor.slice(0, 80), why: `${CATEGORY_WORD[category]} · ${finalCls} change — ${classWhy}`, at: now.toISOString() }]),
      expiresAt: new Date(now.getTime() + improvementTunable(org, 'improve.expireDays') * DAY).toISOString(), decidedBy: '', decidedAt: null,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    await this.insert(row);
    await this.audit.append(orgId, { actor, action: 'improvement_proposed', refType: 'improvement', refId: row.id, payload: { key: row.key, title, target: res.kind ? `${res.kind}:${res.ref}` : '', category, changeClass: finalCls, origin, evidence: evidence.length, expected: expected ? describeExpected(expected) : null } });
    let p = row;
    let text: string;
    if (isPerson(actor) || finalCls === 'standard' || finalCls === 'emergency') {
      p = await this.accept(orgId, row.id, isPerson(actor) ? actor : 'system', isPerson(actor) ? 'raised by a person' : finalCls === 'standard' ? 'a pre-authorised standard change' : 'an emergency change during an open incident');
      text = `${p.key} ${p.status}: ${finalCls} change — ${classWhy}.${p.appliedRef ? ` Applied: ${p.appliedRef}; verified on ${(p.verifyAt ?? '').slice(0, 10) || 'its task\'s completion'} against ${describeExpected(expected)}.` : ''}${p.lastError ? ` Applying failed: ${p.lastError}` : ''}`;
      if (finalCls === 'emergency' && p.status === 'applied') {
        const card = await this.card(orgId, p, actor, true);
        p = await this.patch(p.id, { reviewPending: 1, approvalId: card.id });
        text += ` The owner reviews it afterwards (card ${card.id.slice(0, 8)}); rejected in review, it is reverted.`;
      }
    } else {
      const card = await this.card(orgId, p, actor, false, res.loosens);
      p = await this.patch(p.id, { approvalId: card.id });
      text = `${p.key} proposed (normal change — ${classWhy}); decision card ${card.id.slice(0, 8)} goes to ${card.holder === 'ceo' ? 'the CEO' : 'your manager'}. Expected: ${describeExpected(expected)}.`;
    }
    const ownerAgent = agentOf(res.owner);
    if (ownerAgent && ownerAgent !== proposerAgent) {
      await this.agents.addEvent(ownerAgent, { kind: 'info', title: `Improvement ${p.key} on your ${res.kind ? TARGET_WORD[res.kind] : 'work'}: ${title}`.slice(0, 200), body: `${hypothesis.slice(0, 400)} — ${p.status} (${finalCls} change).`, payload: JSON.stringify({ orgId, improvementId: p.id }), origin: 'loop' }).catch(() => undefined);
    }
    return { proposal: p, text };
  }

  private async insert(row: OrgImprovement): Promise<void> {
    for (let i = 0; i < 4; i++) {
      try { await this.db.insert(orgImprovements).values(row); return; } catch (err) {
        if (i === 3 || !/unique|duplicate/i.test(String((err as Error).message))) throw err;
        row.key = await this.nextKey(row.orgId, i + 1);
      }
    }
  }

  private async nextKey(orgId: string, bump = 0): Promise<string> {
    const rows = await this.db.select({ key: orgImprovements.key }).from(orgImprovements).where(eq(orgImprovements.orgId, orgId));
    const n = rows.reduce((m, r) => Math.max(m, Number(/^IM-(\d+)$/.exec(r.key)?.[1] ?? 0)), 0);
    return `IM-${n + 1 + bump}`;
  }

  private async unitOfActor(orgId: string, actor: string): Promise<string | null> {
    const agentId = agentOf(actor);
    if (!agentId || !this.units) return null;
    return (await this.units.ledBy(orgId, agentId).catch(() => null))?.id ?? (await this.units.unitForAssignee(orgId, agentId).catch(() => null))?.id ?? null;
  }

  private async incidentOpen(orgId: string, incidentId: string | null): Promise<boolean> {
    if (!incidentId) return false;
    const r = (await this.db.select({ status: orgIncidents.status }).from(orgIncidents).where(and(eq(orgIncidents.orgId, orgId), eq(orgIncidents.id, incidentId))).limit(1)).at(0);
    return Boolean(r && r.status !== 'resolved');
  }

  /** The caps (improve.maxOpenPerTarget, improve.maxOpenPerUnit): throws the refusal. */
  private async checkCaps(org: Organization, res: Resolved, unitId: string | null): Promise<void> {
    const rows = await this.list(org.id, { limit: 500 });
    if (res.kind) {
      const cap = improvementTunable(org, 'improve.maxOpenPerTarget');
      const same = rows.filter((r) => r.targetKind === res.kind && r.targetRef === res.ref && (UNSETTLED_STATUSES as readonly string[]).includes(r.status));
      if (same.length >= cap) throw new BadRequestException(`refused: ${res.label} already has ${same.map((r) => `${r.key} (${r.status})`).join(', ')} open — ${cap} at a time (improve.maxOpenPerTarget), so each change can be measured. Add your evidence to it in a comment, or raise this after it is verified or reverted.`);
    }
    if (unitId) {
      const cap = improvementTunable(org, 'improve.maxOpenPerUnit');
      const open = rows.filter((r) => r.unitId === unitId && (OPEN_STATUSES as readonly string[]).includes(r.status));
      if (open.length >= cap) throw new BadRequestException(`refused: the unit already has ${open.length} of ${cap} improvement proposals open (improve.maxOpenPerUnit): ${open.slice(0, 5).map((r) => r.key).join(', ')}. Wait for them to be decided, or withdraw the weakest.`);
    }
  }

  // ---- targets ----

  /** What a target is, who owns it, and what the change does to it. */
  private async resolve(org: Organization, target: { kind: ImprovementTarget; ref: string } | null, rawChange: Record<string, unknown> | null, prose: string[] | string | undefined): Promise<Resolved> {
    const orgId = org.id;
    const chief = org.chiefOfStaffAgentId ? `agent:${org.chiefOfStaffAgentId}` : 'ceo';
    const proseLines = (Array.isArray(prose) ? prose : typeof prose === 'string' && prose.trim() ? prose.split('\n') : []).map((x) => clip(x, 300)).filter(Boolean).slice(0, 40);
    const change = rawChange && typeof rawChange === 'object' ? rawChange : {};
    const base = (o: Partial<Resolved>): Resolved => ({ kind: null, ref: '', label: 'no target yet', unitId: null, owner: chief, diff: proseLines, concrete: false, loosens: false, touchesControls: false, revertData: {}, change: {}, ...o });
    if (!target) return base({});
    const leadOf = async (unitId: string | null): Promise<string> => {
      if (!unitId || !this.units) return chief;
      const u = await this.units.get(orgId, unitId).catch(() => null);
      return u && u.parentUnitId !== null && u.leadAgentId ? `agent:${u.leadAgentId}` : chief;
    };
    switch (target.kind) {
      case 'process': {
        if (!this.processes) throw new BadRequestException('refused: processes are not available on this server');
        const p = await this.processes.get(orgId, target.ref);
        const prev = await this.processes.activeDef(orgId, p);
        let next: ProcessDef | null = null;
        if (change.def) { try { next = normalizeProcess(change.def); } catch (err) { throw new BadRequestException(`refused: the proposed process definition is not valid: ${(err as Error).message}`); } }
        const rollbackTo = Number(change.rollbackTo ?? 0) || 0;
        return base({
          kind: 'process', ref: p.name, label: `process "${p.title}" v${p.version}`, unitId: p.unitId, owner: await leadOf(p.unitId),
          diff: next ? diffProcess(prev, next) : rollbackTo ? [`roll back to v${rollbackTo}`] : proseLines, concrete: Boolean(next || rollbackTo),
          touchesControls: next ? touchesControls(prev, next) : Boolean(rollbackTo), revertData: { rollbackTo: p.version }, change: next ? { def: next } : rollbackTo ? { rollbackTo } : {},
        });
      }
      case 'policy': {
        if (!this.quality) throw new BadRequestException('refused: policies are not available on this server');
        const p = await this.quality.policy(orgId, target.ref);
        const fields = (change.fields && typeof change.fields === 'object' ? change.fields : {}) as Record<string, unknown>;
        const keys = Object.keys(fields);
        const rank = (v: string, order: string[]) => order.indexOf(v);
        const loosens = fields.status === 'retired' || (typeof fields.enforcement === 'string' && rank(fields.enforcement, ['alert', 'warn', 'block']) < rank(p.enforcement, ['alert', 'warn', 'block']));
        return base({
          kind: 'policy', ref: p.key, label: `policy "${p.key}"`, unitId: p.scopeKind === 'unit' ? p.scopeRef : null, owner: p.scopeKind === 'unit' ? await leadOf(p.scopeRef) : chief,
          diff: keys.length ? keys.map((k) => `${k}: ${clip((p as Record<string, unknown>)[k], 120)} → ${clip(typeof fields[k] === 'string' ? fields[k] : JSON.stringify(fields[k]), 160)}`) : proseLines,
          concrete: keys.length > 0, loosens, revertData: { fields: Object.fromEntries(keys.map((k) => [k, (p as Record<string, unknown>)[k]])) }, change: keys.length ? { fields } : {},
        });
      }
      case 'quality_standard': {
        if (!this.quality) throw new BadRequestException('refused: quality standards are not available on this server');
        const s = await this.quality.standard(orgId, target.ref);
        const fields = (change.fields && typeof change.fields === 'object' ? change.fields : {}) as Record<string, unknown>;
        const keys = Object.keys(fields);
        const loosens = fields.status === 'retired' || (typeof fields.passScore === 'number' && fields.passScore < s.passScore) || fields.requireEvidence === false || (Array.isArray(fields.criteria) && fields.criteria.length < parse<unknown[]>(s.criteria, []).length);
        return base({
          kind: 'quality_standard', ref: s.slug, label: `quality standard "${s.name}"`, unitId: s.unitId, owner: await leadOf(s.unitId),
          diff: keys.length ? keys.map((k) => `${k}: ${clip((s as Record<string, unknown>)[k], 120)} → ${clip(typeof fields[k] === 'string' ? fields[k] : JSON.stringify(fields[k]), 160)}`) : proseLines,
          concrete: keys.length > 0, loosens, revertData: { fields: Object.fromEntries(keys.map((k) => [k, k === 'criteria' ? parse<unknown[]>(s.criteria, []) : k === 'requireEvidence' ? s.requireEvidence === 1 : (s as Record<string, unknown>)[k]])) }, change: keys.length ? { fields } : {},
        });
      }
      case 'playbook': {
        if (!this.playbooks) throw new BadRequestException('refused: playbooks are not available on this server');
        const p = await this.playbooks.byRef(orgId, target.ref);
        const body = typeof change.body === 'string' ? change.body.trim() : '';
        return base({
          kind: 'playbook', ref: p.id, label: `playbook "${p.title}" v${p.version}`, unitId: null, owner: p.ownerAgentId ? `agent:${p.ownerAgentId}` : chief,
          diff: body ? lineDiff(p.body, body) : proseLines, concrete: Boolean(body), revertData: { body: p.body }, change: body ? { body } : {},
        });
      }
      case 'charter': {
        const members = (await this.org.members(orgId)).filter((m) => m.status !== 'terminated');
        const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
        const q = target.ref.toLowerCase();
        const m = members.find((x) => x.agentId === target.ref || (names.get(x.agentId) ?? '').toLowerCase() === q || (q.length >= 6 && x.agentId.startsWith(q)));
        if (!m) throw new BadRequestException(`refused: no member "${target.ref}" for a charter change`);
        const agent = await this.agents.get(m.agentId);
        const text = typeof change.text === 'string' ? change.text.trim() : '';
        const mode = change.mode === 'replace' ? 'replace' : 'append';
        const before = agent.charter ?? '';
        const after = mode === 'replace' ? text : `${before.trimEnd()}\n\n${text}`.trim();
        return base({
          kind: 'charter', ref: m.agentId, label: `charter of ${agent.name}`, unitId: null, owner: 'ceo',
          diff: text ? lineDiff(before, after) : proseLines, concrete: Boolean(text), revertData: { charter: before }, change: text ? { charter: after } : {},
        });
      }
      case 'cadence': {
        const rows = await this.db.select().from(orgCadences).where(eq(orgCadences.orgId, orgId));
        const q = target.ref.toLowerCase();
        const c = rows.find((x) => x.id === target.ref) ?? rows.find((x) => x.kind === q && x.unitId === (change.unitId ?? null)) ?? rows.find((x) => x.kind === q);
        if (!c) throw new BadRequestException(`refused: no cadence "${target.ref}" — name a meeting kind (standup, weekly_review, retro, board, planning)`);
        const cron = typeof change.cron === 'string' ? change.cron.trim() : '';
        const enabled = typeof change.enabled === 'boolean' ? change.enabled : undefined;
        const concrete = Boolean(cron) || enabled !== undefined;
        return base({
          kind: 'cadence', ref: c.id, label: `${c.kind.replace('_', ' ')} cadence`, unitId: c.unitId, owner: await leadOf(c.unitId),
          diff: concrete ? [cron ? `cron: ${c.cron} → ${cron}` : '', enabled !== undefined ? `enabled: ${c.enabled === 1} → ${enabled}` : ''].filter(Boolean) : proseLines, concrete,
          revertData: { cron: c.cron, enabled: c.enabled === 1 }, change: concrete ? { ...(cron ? { cron } : {}), ...(enabled !== undefined ? { enabled } : {}) } : {},
        });
      }
      case 'tunable': {
        const key = target.ref;
        const has = Object.prototype.hasOwnProperty.call(change, 'value');
        if (has) { const c = checkTunable(key, change.value); if (!c.ok) throw new BadRequestException(`refused: ${c.reason}`); }
        else if (!checkTunable(key, 0).ok && !/must stay within/.test((checkTunable(key, 0) as { reason: string }).reason)) throw new BadRequestException(`refused: unknown tunable "${key}"`);
        const from = tunable(org, key);
        return base({
          kind: 'tunable', ref: key, label: `tunable ${key}`, unitId: null, owner: 'ceo',
          diff: has ? [`${key}: ${from} → ${Number(change.value)}`] : proseLines, concrete: has, revertData: { value: from }, change: has ? { value: Number(change.value) } : {},
        });
      }
    }
  }

  // ---- the lifecycle ----

  private async move(id: string, to: ImprovementStatus, by: string, why: string, extra: Partial<OrgImprovement> = {}): Promise<OrgImprovement> {
    const r = (await this.db.select().from(orgImprovements).where(eq(orgImprovements.id, id)).limit(1)).at(0);
    if (!r) throw new NotFoundException(`improvement ${id}`);
    if (!canMove(r.status, to)) throw new BadRequestException(`refused: ${r.key} is ${r.status}; it cannot become ${to}`);
    const history = [...parse<HistoryEntry[]>(r.history, []), { from: r.status, to, by: by.slice(0, 80), why: why.slice(0, 400), at: nowIso() }].slice(-40);
    await this.db.update(orgImprovements).set({ ...extra, status: to, history: JSON.stringify(history), updatedAt: nowIso() }).where(eq(orgImprovements.id, id));
    await this.audit.append(r.orgId, { actor: by, action: `improvement_${to}`, refType: 'improvement', refId: id, payload: { key: r.key, from: r.status, why: why.slice(0, 300) } });
    return { ...r, ...extra, status: to, history: JSON.stringify(history) };
  }

  private async patch(id: string, set: Partial<OrgImprovement>): Promise<OrgImprovement> {
    await this.db.update(orgImprovements).set({ ...set, updatedAt: nowIso() }).where(eq(orgImprovements.id, id));
    return (await this.db.select().from(orgImprovements).where(eq(orgImprovements.id, id)).limit(1)).at(0)!;
  }

  private async note(id: string, by: string, why: string): Promise<void> {
    const r = (await this.db.select().from(orgImprovements).where(eq(orgImprovements.id, id)).limit(1)).at(0);
    if (!r) return;
    const history = [...parse<HistoryEntry[]>(r.history, []), { from: r.status, to: r.status, by: by.slice(0, 80), why: why.slice(0, 400), at: nowIso() }].slice(-40);
    await this.db.update(orgImprovements).set({ history: JSON.stringify(history), updatedAt: nowIso() }).where(eq(orgImprovements.id, id));
  }

  /** The decision card of a normal change (or an emergency change's review). */
  private async card(orgId: string, p: OrgImprovement, requestedBy: string, review: boolean, loosens = false): Promise<OrgApproval> {
    const expected = parse<ExpectedChange | null>(p.expected, null);
    // Charters, tunables and a loosened control are the CEO's (the boundary's propose rows).
    const reserved = !review && (p.targetKind === 'charter' || p.targetKind === 'tunable' || loosens);
    return this.approvals.create(orgId, {
      kind: 'improvement', requestedBy,
      payload: {
        improvementId: p.id, key: p.key, title: p.title, review, target: p.targetKind ? `${p.targetKind}:${p.targetRef}` : '', targetLabel: p.targetLabel, category: p.category, changeClass: p.changeClass,
        hypothesis: p.hypothesis.slice(0, 600), evidence: parse<Evidence[]>(p.evidence, []).slice(0, 6), diff: parse<string[]>(p.diff, []).slice(0, 30), expected: describeExpected(expected),
        agentId: agentOf(p.proposedBy) ?? undefined, ...(reserved ? { boundary: 'propose', boundaryRule: loosens ? 'loosening a control is the CEO\'s' : `${TARGET_WORD[p.targetKind as ImprovementTarget]} changes are the CEO's` } : {}),
      },
      recommendation: `${review ? 'Review the emergency change ' : ''}${p.key}: ${p.hypothesis}`.slice(0, 600), card: { recommendedAction: 'approve' },
    });
  }

  /** Accept (a person, an approved card, a standard or emergency change) and apply. */
  async accept(orgId: string, ref: string, by: string, why: string): Promise<OrgImprovement> {
    const p = await this.get(orgId, ref);
    if (p.status !== 'proposed') return p;
    await this.move(p.id, 'accepted', by, why, { decidedBy: by.slice(0, 80), decidedAt: nowIso() });
    return this.apply(orgId, p.id, by);
  }

  /** Reject a proposal (a person or a declined card). */
  async reject(orgId: string, ref: string, by: string, why: string): Promise<OrgImprovement> {
    const p = await this.get(orgId, ref);
    if (p.status !== 'proposed' && p.status !== 'accepted') throw new BadRequestException(`refused: ${p.key} is ${p.status}`);
    const r = await this.move(p.id, 'rejected', by, why || 'rejected', { decidedBy: by.slice(0, 80), decidedAt: nowIso() });
    if (r.revertOf) await this.revertDeclined(orgId, r.revertOf, by);
    return r;
  }

  /** Apply an accepted proposal through its target's own versioning. */
  private async apply(orgId: string, id: string, by: string): Promise<OrgImprovement> {
    const p = (await this.db.select().from(orgImprovements).where(eq(orgImprovements.id, id)).limit(1)).at(0)!;
    const org = await this.org.get(orgId);
    const change = parse<Record<string, unknown>>(p.change, {});
    const actor = `improvement:${p.key}`;
    const reason = `${p.key}: ${p.hypothesis}`.slice(0, 600);
    try {
      const appliedRef = await this.applyChange(org, p, change, actor, reason);
      if (appliedRef === null) {
        // Prose only: the owner carries it out as one task (source proposal).
        const task = await this.carryOutTask(org, p);
        await this.note(p.id, by, `accepted with no structured change: task ${taskRef(task)} for its owner`);
        return this.patch(p.id, { appliedRef: `task:${task.id}`, lastError: '' });
      }
      return this.markApplied(org, p, appliedRef, by);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      await this.note(p.id, by, `applying failed: ${msg}`);
      await this.audit.append(orgId, { actor: 'system', action: 'improvement_apply_failed', refType: 'improvement', refId: p.id, payload: { key: p.key, error: msg } });
      return this.patch(p.id, { lastError: msg });
    }
  }

  private async markApplied(org: Organization, p: OrgImprovement, appliedRef: string, by: string): Promise<OrgImprovement> {
    const expected = parse<ExpectedChange | null>(p.expected, null);
    const baseline = expected ? await this.measure(org, p, expected).catch(() => null) : null;
    const verifyAt = new Date(this.now().getTime() + improvementTunable(org, 'improve.verifyDays') * DAY).toISOString();
    const r = await this.move(p.id, 'applied', by, `applied (${appliedRef}); verified on ${verifyAt.slice(0, 10)} against ${describeExpected(expected)}${baseline !== null ? ` — baseline ${round(baseline)}` : ''}`, { appliedRef: appliedRef.slice(0, 200), baseline, verifyAt, lastError: '' });
    if (p.revertOf) {
      const orig = (await this.db.select().from(orgImprovements).where(eq(orgImprovements.id, p.revertOf)).limit(1)).at(0);
      if (orig && orig.status === 'applied') await this.move(orig.id, 'reverted', by, `reverted by ${p.key}`);
    }
    return r;
  }

  /** Returns what applying produced (a version id, …), or null for a prose-only proposal. */
  private async applyChange(org: Organization, p: OrgImprovement, change: Record<string, unknown>, actor: string, reason: string): Promise<string | null> {
    const orgId = org.id;
    if (!p.targetKind || Object.keys(change).length === 0) return null;
    switch (p.targetKind as ImprovementTarget) {
      case 'process': {
        if (!this.processes) throw new Error('processes are not available');
        const r = change.rollbackTo ? await this.processes.rollback(orgId, p.targetRef, Number(change.rollbackTo), reason, actor) : await this.processes.author(orgId, { process: p.targetRef, def: change.def, reason }, actor);
        if (!r.applied) throw new Error(r.note);
        return `process version ${r.version.version}`;
      }
      case 'policy': {
        if (!this.quality) throw new Error('policies are not available');
        const r = await this.quality.revisePolicy(orgId, p.targetRef, change.fields as Record<string, unknown>, actor, reason);
        if (!r.applied) throw new Error(`waits on card ${r.approvalId ?? ''}`);
        return `policy ${r.policy.key} v${r.policy.version}`;
      }
      case 'quality_standard': {
        if (!this.quality) throw new Error('quality standards are not available');
        const r = await this.quality.reviseStandard(orgId, p.targetRef, change.fields as Record<string, unknown>, actor, reason);
        if (!r.applied) throw new Error(`waits on card ${r.approvalId ?? ''}`);
        return `quality standard ${r.standard.slug} v${r.standard.version}`;
      }
      case 'playbook': {
        if (!this.playbooks) throw new Error('playbooks are not available');
        const pb = await this.playbooks.get(orgId, p.targetRef);
        const author = agentOf(p.owner) ?? agentOf(p.proposedBy) ?? org.chiefOfStaffAgentId;
        if (!author) throw new Error('nobody to author the playbook revision');
        const r = await this.playbooks.write(orgId, { title: pb.title, body: String(change.body ?? ''), why: reason, authorAgentId: author });
        return `playbook ${pb.name} v${r.playbook.version} in review (${r.task.key ?? r.task.id.slice(0, 8)})`;
      }
      case 'charter': {
        const text = String(change.charter ?? '');
        if (!text.trim()) throw new Error('an empty charter');
        await this.agents.update(p.targetRef, { charter: text });
        await this.org.acceptCharter(orgId, p.targetRef, 'user');
        return `charter of ${p.targetLabel.replace(/^charter of /, '')}`;
      }
      case 'cadence': {
        const c = await this.meetings.updateCadence(orgId, p.targetRef, { ...(typeof change.cron === 'string' ? { cron: change.cron } : {}), ...(typeof change.enabled === 'boolean' ? { enabled: change.enabled } : {}) }, actor);
        return `cadence ${c.kind} ${c.cron}${c.enabled ? '' : ' (off)'}`;
      }
      case 'tunable': {
        const r = await this.org.setTunable(orgId, p.targetRef, change.value, { actor, why: reason, decidedBy: p.decidedBy || actor });
        return `${r.key} ${r.from} → ${r.to}`;
      }
    }
    return null;
  }

  /** The one task an accepted prose-only proposal becomes (source proposal). */
  private async carryOutTask(org: Organization, p: OrgImprovement): Promise<OrgTask> {
    const owner = agentOf(p.owner) ?? org.chiefOfStaffAgentId;
    const member = owner ? await this.org.member(org.id, owner) : null;
    const assignee = member && member.status === 'active' ? owner : null;
    const ev = parse<Evidence[]>(p.evidence, []);
    return this.tasks.create(org.id, {
      title: `Carry out ${p.key}: ${p.title}`.slice(0, 200), assigneeAgentId: assignee, status: assignee ? 'todo' : 'backlog', createdBy: `improvement:${p.id}`, source: 'proposal', unitId: p.unitId ?? undefined,
      brief: {
        outcome: `The accepted improvement ${p.key} is in place: ${p.title}.`,
        context: `Hypothesis: ${p.hypothesis}\nEvidence: ${ev.map((e) => `${e.summary}${e.ref ? ` (${e.ref})` : ''}`).join('; ')}${parse<string[]>(p.diff, []).length ? `\nProposed change:\n${parse<string[]>(p.diff, []).join('\n')}` : ''}`.slice(0, 4_000),
        constraints: `Make the change through the target's own path (a new process version with org_process_author, a policy or standard revision, a playbook version, an approval card) so it is versioned. Expected: ${describeExpected(parse<ExpectedChange | null>(p.expected, null))}.`,
        done_when: `The change is made and named in the handoff; ${p.key} is verified against its metric after the window.`,
      },
    });
  }

  /** A carry-out task settled: done → applied (measured from now); cancelled → rejected. */
  private async onTaskSettled(orgId: string, taskId: string, to: string): Promise<void> {
    const rows = (await this.list(orgId, { status: 'accepted', limit: 500 })).filter((r) => r.appliedRef === `task:${taskId}`);
    for (const p of rows) {
      if (to === 'done') await this.markApplied(await this.org.get(orgId), p, `task:${taskId}`, 'system');
      else await this.move(p.id, 'rejected', 'system', 'its carry-out task was cancelled');
    }
  }

  // ---- decision cards ----

  private async cardApproved(orgId: string, a: OrgApproval, payload: Record<string, unknown>, note: string): Promise<Record<string, unknown>> {
    const id = String(payload.improvementId ?? '');
    const p = await this.get(orgId, id);
    const by = a.holder && a.holder !== 'ceo' ? a.holder : 'user';
    if (payload.review) {
      if (p.reviewPending) { await this.patch(p.id, { reviewPending: 0 }); await this.note(p.id, by, `emergency change reviewed and kept${note ? `: ${note}` : ''}`); }
      return { improvementId: p.id, status: p.status, reviewed: true };
    }
    const r = await this.accept(orgId, p.id, by, note ? `approved: ${note}` : 'approved by the owner');
    return { improvementId: r.id, status: r.status, ...(r.lastError ? { error: r.lastError } : {}) };
  }

  private async cardDeclined(orgId: string, a: OrgApproval, decision: string, note: string): Promise<void> {
    const payload = parse<Record<string, unknown>>(a.payload, {});
    const p = await this.get(orgId, String(payload.improvementId ?? '')).catch(() => null);
    if (!p) return;
    const by = a.holder && a.holder !== 'ceo' ? a.holder : 'user';
    if (payload.review) {
      // An emergency change the owner does not keep is reverted.
      if (p.status === 'applied') await this.revertNow(orgId, p, by, `the owner rejected the emergency change in review${note ? `: ${note}` : ''}`);
      return;
    }
    if (p.status === 'proposed') await this.reject(orgId, p.id, by, `${decision === 'revise' ? 'sent back' : 'rejected'}${note ? `: ${note}` : ''}`);
  }

  // ---- verification and reverts ----

  /** Read the metric a proposal promised to move. Null when it cannot be measured. */
  async measure(org: Organization, p: Pick<OrgImprovement, 'targetKind' | 'targetRef' | 'unitId'>, e: ExpectedChange): Promise<number | null> {
    const days = improvementTunable(org, 'improve.verifyDays');
    if (e.metric.startsWith('process.')) {
      if (!this.processes || p.targetKind !== 'process') return null;
      const proc = await this.processes.get(org.id, p.targetRef);
      const m = await this.processes.metrics(org.id, proc.id);
      const v = ({ 'process.deviationRate': m.deviationRate, 'process.completionRate': m.completionRate, 'process.cycleHours': m.cycleHoursP50, 'process.reworkRate': m.reworkRate, 'process.slaBreaches': m.slaBreaches } as Record<string, number | null>)[e.metric];
      return v ?? null;
    }
    if (e.metric.startsWith('quality.') || e.metric === 'policy.violations') {
      if (!this.quality) return null;
      const m = await this.quality.metrics(org.id, { days });
      if (e.metric === 'policy.violations') {
        if (p.targetKind !== 'policy') return null;
        const pol = await this.quality.policy(org.id, p.targetRef);
        return m.policies.byPolicy[pol.id]?.violations ?? 0;
      }
      const fig = (p.unitId ? m.byUnit[p.unitId] : undefined) ?? m.overall;
      return ({ 'quality.firstPassYield': fig.firstPassYield, 'quality.reworkRate': fig.reworkRate, 'quality.escapes': fig.escapes } as Record<string, number | null>)[e.metric] ?? null;
    }
    if (e.metric.startsWith('work.')) {
      const since = new Date(this.now().getTime() - days * DAY).toISOString();
      const rows = (await this.sourceRows(org, since)).filter((r) => !p.unitId || r.unitId === p.unitId);
      if (e.metric === 'work.blockedHours') {
        const done = (await this.tasks.list(org.id)).filter((t) => t.status === 'done' && (t.doneAt ?? '') >= since && (!p.unitId || t.unitId === p.unitId));
        return done.length ? done.reduce((s, t) => s + (t.blockedSeconds ?? 0), 0) / 3600 / done.length : null;
      }
      const s = sourceShares(rows);
      return e.metric === 'work.selfShare' ? s.selfShare : e.metric === 'work.retroShare' ? s.retroShare : e.metric === 'work.systemShare' ? s.systemShare : null;
    }
    if (e.metric.startsWith('metric:')) {
      const src = (await this.db.select().from(orgMetricSources).where(and(eq(orgMetricSources.orgId, org.id), eq(orgMetricSources.id, e.metric.slice(7)))).limit(1)).at(0);
      return src?.lastValue ?? null;
    }
    return null;
  }

  /** Check an applied proposal against its metric now (the sweep, or a person's "verify now"). */
  async verify(orgId: string, ref: string, by = 'system'): Promise<OrgImprovement> {
    const p = await this.get(orgId, ref);
    if (p.status !== 'applied') throw new BadRequestException(`refused: ${p.key} is ${p.status}; only an applied change is verified`);
    const org = await this.org.get(orgId);
    const expected = parse<ExpectedChange | null>(p.expected, null);
    const value = expected ? await this.measure(org, p, expected).catch(() => null) : null;
    const outcome = verdictOf(expected, p.baseline, value);
    const v: Verification = { outcome, baseline: p.baseline, value, at: nowIso(), detail: outcome === 'unverifiable' ? (expected ? 'the metric could not be read at both ends; kept' : 'no metric was named; kept on the owner\'s word') : `${describeExpected(expected)}: ${round(p.baseline)} → ${round(value)}` };
    if (outcome !== 'fail') return this.move(p.id, 'verified', by, `${outcome === 'pass' ? 'verified' : 'kept (unverifiable)'}: ${v.detail}`, { verification: JSON.stringify(v) });
    await this.patch(p.id, { verification: JSON.stringify(v) });
    if (improvementTunable(org, 'improve.autoRevert') >= 1) return this.revertNow(orgId, p, 'system', `failed verification (${v.detail}); improve.autoRevert reverts at once`);
    const open = (await this.list(orgId, { limit: 500 })).find((r) => r.revertOf === p.id && (OPEN_STATUSES as readonly string[]).includes(r.status));
    if (!open) {
      const revert = await this.createProposal(orgId, {
        title: `Revert ${p.key}: ${p.title}`.slice(0, 200), target: p.targetKind ? { kind: p.targetKind, ref: p.targetRef } : null, evidence: [{ kind: 'metric', ref: p.key, summary: `verification failed: ${v.detail}` }],
        hypothesis: `${p.key} did not move ${describeExpected(expected)}; undoing it restores the previous behaviour.`, change: this.revertChange(p), category: 'repair', origin: 'verification', originRef: `improvement:${p.id}`, unitId: p.unitId, revertOf: p.id,
      }, `agent:${agentOf(p.owner) ?? agentOf(p.proposedBy) ?? ''}`.replace(/^agent:$/, 'system')).catch(() => null);
      if (revert) await this.note(p.id, 'system', `verification failed (${v.detail}); revert proposal ${revert.proposal.key}`);
    }
    return this.get(orgId, p.id);
  }

  /** The change that undoes an applied proposal, in the target's own terms. */
  private revertChange(p: OrgImprovement): Record<string, unknown> {
    const d = parse<Record<string, unknown>>(p.revertData, {});
    switch (p.targetKind) {
      case 'process': return { rollbackTo: d.rollbackTo };
      case 'policy': case 'quality_standard': return { fields: d.fields ?? {} };
      case 'playbook': return { body: d.body };
      case 'charter': return { text: d.charter, mode: 'replace' };
      case 'cadence': return { cron: d.cron, enabled: d.enabled };
      case 'tunable': return { value: d.value };
      default: return {};
    }
  }

  /** Undo an applied change at once (an emergency change rejected in review, improve.autoRevert). */
  private async revertNow(orgId: string, p: OrgImprovement, by: string, why: string): Promise<OrgImprovement> {
    const org = await this.org.get(orgId);
    let change = this.revertChange(p);
    if (p.targetKind === 'charter') change = { charter: change.text };
    try {
      const done = await this.applyChange(org, p, change, `improvement:${p.key}`, `revert ${p.key}: ${why}`.slice(0, 600));
      return this.move(p.id, 'reverted', by, `${why}${done ? ` — ${done}` : ''}`, { reviewPending: 0 });
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      await this.note(p.id, by, `revert failed: ${msg}`);
      return this.patch(p.id, { lastError: `revert failed: ${msg}` });
    }
  }

  /** A revert proposal was rejected: the owner keeps the change. */
  private async revertDeclined(orgId: string, originalId: string, by: string): Promise<void> {
    const orig = (await this.db.select().from(orgImprovements).where(and(eq(orgImprovements.orgId, orgId), eq(orgImprovements.id, originalId))).limit(1)).at(0);
    if (orig && orig.status === 'applied') await this.move(orig.id, 'verified', by, 'kept despite the failed verification: its revert was rejected or expired');
  }

  /** Deadlines from the row (resumable after a restart): expire undecided
   *  proposals, follow their cards, verify applied changes that are due. */
  async sweep(orgId: string): Promise<{ expired: number; verified: number }> {
    const now = this.now();
    let expired = 0; let verified = 0;
    const cards = new Map((await this.approvals.list(orgId)).filter((a) => a.kind === 'improvement').map((a) => [a.id, a]));
    for (const p of await this.list(orgId, { limit: 500 })) {
      if (p.status === 'proposed') {
        const card = p.approvalId ? cards.get(p.approvalId) : undefined;
        if (card && card.status === 'rejected') { await this.reject(orgId, p.id, card.decidedBy || 'user', card.decisionNote || 'rejected').catch(() => undefined); continue; }
        if ((card && card.status === 'expired') || (p.expiresAt && p.expiresAt <= now.toISOString())) {
          await this.move(p.id, 'expired', 'system', 'no decision in time: an unanswered proposal is not a yes').catch(() => undefined);
          if (p.revertOf) await this.revertDeclined(orgId, p.revertOf, 'system');
          expired++; continue;
        }
      }
      if (p.status === 'applied' && p.verifyAt && p.verifyAt <= now.toISOString() && !p.revertOf) {
        const hasRevert = (await this.list(orgId, { limit: 500 })).some((r) => r.revertOf === p.id && (OPEN_STATUSES as readonly string[]).includes(r.status));
        if (!parse<Verification | null>(p.verification, null) || !hasRevert) { await this.verify(orgId, p.id).catch(() => undefined); verified++; }
      } else if (p.status === 'applied' && p.revertOf && p.verifyAt && p.verifyAt <= now.toISOString()) {
        await this.move(p.id, 'verified', 'system', 'a revert is verified by restoring the previous version').catch(() => undefined);
      }
    }
    return { expired, verified };
  }

  // ---- the minutes executor: retro actions → proposals ----

  private sink(): ImprovementSink {
    return {
      route: (orgId, meeting, actions, context) => this.routeRetro(orgId, meeting, actions, context),
      park: (orgId, meeting, action, reason, context) => this.parkAction(orgId, meeting, action, reason, context),
      playbookChange: (orgId, meeting, input) => this.playbookFromLesson(orgId, meeting, input),
    };
  }

  private originOfMeeting(m: OrgMeeting): ImprovementOrigin { return m.createdBy === 'postmortem' ? 'postmortem' : 'retro'; }

  /** A retro's actions: the top N proposals, concrete repairs as tasks, the rest not raised (each says why). */
  private async routeRetro(orgId: string, meeting: OrgMeeting, actions: MinutesAction[], context: string): Promise<void> {
    if (!actions.length) return;
    const org = await this.org.get(orgId);
    const perMeeting = improvementTunable(org, 'improve.perMeeting');
    const plan = routeActions(actions, { perMeeting, repairTasks: improvementTunable(org, 'improve.repairTasks') >= 1 });
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (plan[i] === 'task') { a.disposition = 'task'; continue; }
      if (plan[i] === 'over_cap') { a.disposition = 'over_cap'; a.note = `not raised — this ${meeting.createdBy === 'postmortem' ? 'postmortem' : 'retro'} raises its top ${perMeeting} (improve.perMeeting); bring it back with evidence if it recurs`; continue; }
      if (plan[i] === 'proposal') await this.actionToProposal(orgId, meeting, a, context);
    }
    await this.audit.append(orgId, { actor: 'system', action: 'retro_routed', refType: 'meeting', refId: meeting.id, payload: { proposals: actions.filter((a) => a.proposalId).length, tasks: actions.filter((a) => a.disposition === 'task').length, notRaised: actions.filter((a) => a.disposition === 'over_cap' || (!a.proposalId && a.note)).length } });
  }

  private async actionToProposal(orgId: string, meeting: OrgMeeting, a: MinutesAction, context: string): Promise<void> {
    const evidence = [...parseEvidence(a.evidence), { kind: 'meeting' as const, ref: `meeting:${meeting.id}`, summary: context.slice(0, 300) }];
    let target = a.target ? parseTargetRef(a.target) : null;
    let r: { proposal: OrgImprovement; text: string } | null = null;
    let err = '';
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      r = await this.createProposal(orgId, {
        title: a.title, target, evidence, hypothesis: a.hypothesis || a.outcome || a.title, diff: [a.outcome, a.done_when ? `Done when: ${a.done_when}` : ''].filter(Boolean) as string[],
        expected: a.expected || null, category: a.category, origin: this.originOfMeeting(meeting), originRef: `meeting:${meeting.id}`, unitId: meeting.unitId,
        incidentId: await this.incidentOfMeeting(orgId, meeting),
      }, `agent:${a.by || meeting.facilitatorAgentId || ''}`).catch((e: unknown) => { err = (e instanceof Error ? e.message : String(e)).slice(0, 300); return null; });
      // A bad target or metric should not lose the action: retry as prose.
      if (!r && target && /target|no process|no policy|no member|no cadence|no playbook|no quality|unknown tunable|not valid/i.test(err)) { target = null; continue; }
      if (!r && a.expected && /metric|expected/i.test(err)) { a.expected = undefined; continue; }
      break;
    }
    if (r) { a.proposalId = r.proposal.id; a.proposalKey = r.proposal.key; a.disposition = 'proposal'; a.note = undefined; }
    else { a.disposition = 'over_cap'; a.note = err.replace(/^refused:\s*/, '') || 'not raised'; }
  }

  private async incidentOfMeeting(orgId: string, meeting: OrgMeeting): Promise<string | null> {
    if (meeting.createdBy !== 'postmortem') return null;
    const r = (await this.db.select({ id: orgIncidents.id }).from(orgIncidents).where(and(eq(orgIncidents.orgId, orgId), eq(orgIncidents.postmortemMeetingId, meeting.id))).limit(1)).at(0);
    return r?.id ?? null;
  }

  /** A retro task the admission gate refused: a proposal instead (never dropped). */
  private async parkAction(orgId: string, meeting: OrgMeeting, a: MinutesAction, reason: string, context: string): Promise<void> {
    await this.actionToProposal(orgId, meeting, a, `${context}. Raised as a task first and refused: ${reason}`);
  }

  /** A lesson's playbook change becomes a proposal targeting the playbook. */
  private async playbookFromLesson(orgId: string, meeting: OrgMeeting, input: { playbookId: string; note: string; lesson: string; by: string }): Promise<string | null> {
    const r = await this.createProposal(orgId, {
      title: `Revise the playbook: ${input.note}`.slice(0, 200), target: { kind: 'playbook', ref: input.playbookId },
      evidence: [{ kind: 'lessons', ref: `meeting:${meeting.id}`, summary: input.lesson }], hypothesis: input.note, diff: [input.note], category: 'prevent',
      origin: this.originOfMeeting(meeting), originRef: `meeting:${meeting.id}`, unitId: meeting.unitId,
    }, `agent:${input.by}`).catch(() => null);
    return r?.proposal.id ?? null;
  }

  // ---- admission control ----

  /** The task-creation gate (OrgTasksService.setAdmissionGate): self-started work within the caps. */
  async admit(orgId: string, input: Record<string, unknown> & { title: string; createdBy: string; source: string; class: string; projectId: string | null }): Promise<{ demote?: string } | void> {
    const org = await this.org.get(orgId);
    const kinds = new Map((await this.org.projects(orgId)).map((p) => [p.id, p.kind]));
    const projectKind = input.projectId ? kinds.get(input.projectId) ?? null : null;
    const a = admissionOf({ ...(input as AdmissionTask), projectKind }, org.chiefOfStaffAgentId);
    if (!a.self) return;
    const unitId = typeof input.unitId === 'string' ? input.unitId : null;
    const wipCap = improvementTunable(org, 'admission.selfWip');
    const perDay = improvementTunable(org, 'admission.selfPerDay');
    const all = await this.tasks.list(orgId);
    const self = (t: OrgTask) => admissionOf({ ...t, projectKind: t.projectId ? kinds.get(t.projectId) ?? null : null }, org.chiefOfStaffAgentId).self;
    const open = all.filter((t) => t.unitId === unitId && !['done', 'cancelled'].includes(t.status) && self(t)).length;
    const since = new Date(this.now().getTime() - DAY).toISOString();
    const today = all.filter((t) => t.createdBy === input.createdBy && t.createdAt >= since && self(t)).length;
    const over: 'wip' | 'rate' | null = open >= wipCap ? 'wip' : today >= perDay ? 'rate' : null;
    if (!over) return;
    const unitName = unitId && this.units ? (await this.units.get(orgId, unitId).catch(() => null))?.name ?? 'the unit' : 'the company';
    const parked = improvementTunable(org, 'admission.overCap') >= 1;
    const text = admissionRefusal({ unitName, open, cap: wipCap, today, perDay, over, parked });
    await this.audit.append(orgId, { actor: input.createdBy, action: parked ? 'admission_parked' : 'admission_refused', refType: 'unit', refId: unitId ?? '', payload: { title: input.title.slice(0, 200), origin: a.origin, over, open, cap: wipCap, today, perDay } });
    if (parked) return { demote: text };
    throw new BadRequestException(text);
  }

  // ---- the attention budget ----

  private readonly woken = new Map<string, number[]>();
  private readonly deferredNoted = new Map<string, number>();

  /** Wakes a member gets from other agents, per hour (attention.agentWakesPerHour): ms to wait, 0 to run. */
  async attention(ev: OrgWakeEvent): Promise<number> {
    const by = ev.by ?? '';
    if (!by.startsWith('agent:') || by === `agent:${ev.agentId}`) return 0;
    if (ev.reason !== 'comment' && ev.reason !== 'mention' && ev.reason !== 'assignment') return 0;
    const org = await this.org.get(ev.orgId).catch(() => null);
    if (!org) return 0;
    if (org.chiefOfStaffAgentId && by === `agent:${org.chiefOfStaffAgentId}`) return 0;
    const cap = improvementTunable(org, 'attention.agentWakesPerHour');
    const key = `${ev.orgId}:${ev.agentId}`;
    const now = this.now().getTime();
    const recent = (this.woken.get(key) ?? []).filter((ms) => ms > now - 3_600_000);
    if (recent.length >= cap) {
      this.woken.set(key, recent);
      const wait = Math.max(1_000, recent[0] + 3_600_000 - now + 1_000);
      if ((this.deferredNoted.get(key) ?? 0) < now - 3_600_000) {
        this.deferredNoted.set(key, now);
        await this.audit.append(ev.orgId, { actor: by, action: 'attention_deferred', refType: 'task', refId: ev.taskId, payload: { agentId: ev.agentId, reason: ev.reason, cap, waitMinutes: Math.round(wait / 60_000) } }).catch(() => undefined);
      }
      return wait;
    }
    recent.push(now);
    this.woken.set(key, recent);
    return 0;
  }

  // ---- measurement ----

  private async sourceRows(org: Organization, sinceIso: string): Promise<Array<SourceRow & { taskId: string }>> {
    const kinds = new Map((await this.org.projects(org.id)).map((p) => [p.id, p.kind]));
    return (await this.tasks.list(org.id)).filter((t) => t.createdAt >= sinceIso).map((t) => ({
      taskId: t.id, origin: originOf(t, org.chiefOfStaffAgentId), projectKind: t.projectId ? kinds.get(t.projectId) ?? null : null, createdAt: t.createdAt, status: t.status, unitId: t.unitId,
    }));
  }

  /**
   * Where work comes from (docs/improvements.md "Measure"): the share of new
   * tasks by origin, the share in Operating/Unsorted projects, self-started
   * work per unit against its cap, proposals opened/accepted/applied/verified
   * and deferred wakes, over `days`.
   */
  async workSources(orgId: string, opts: { days?: number; unitIds?: string[] | null } = {}) {
    const org = await this.org.get(orgId);
    const days = Math.max(1, Math.min(90, opts.days ?? 14));
    const since = new Date(this.now().getTime() - days * DAY).toISOString();
    const rows = (await this.sourceRows(org, since)).filter((r) => !opts.unitIds || (r.unitId !== null && opts.unitIds.includes(r.unitId)));
    const shares = sourceShares(rows);
    const kinds = new Map((await this.org.projects(orgId)).map((p) => [p.id, p.kind]));
    const all = await this.tasks.list(orgId);
    const units = this.units ? await this.units.units(orgId).catch(() => []) : [];
    const wipCap = improvementTunable(org, 'admission.selfWip');
    const perUnit = units.filter((u) => !opts.unitIds || opts.unitIds.includes(u.id)).map((u) => ({
      unitId: u.id, name: u.name,
      selfOpen: all.filter((t) => t.unitId === u.id && !['done', 'cancelled'].includes(t.status) && admissionOf({ ...t, projectKind: t.projectId ? kinds.get(t.projectId) ?? null : null }, org.chiefOfStaffAgentId).self).length,
      cap: wipCap,
    }));
    const proposals = (await this.list(orgId, { limit: 500 })).filter((p) => !opts.unitIds || (p.unitId !== null && opts.unitIds.includes(p.unitId)));
    const recent = proposals.filter((p) => p.createdAt >= since);
    const reached = (s: ImprovementStatus) => proposals.filter((p) => parse<HistoryEntry[]>(p.history, []).some((h) => h.to === s && h.at >= since)).length;
    const audits = await this.db.select({ action: orgAudit.action }).from(orgAudit).where(and(eq(orgAudit.orgId, orgId), gte(orgAudit.createdAt, since))).catch(() => [] as Array<{ action: string }>);
    const count = (a: string) => audits.filter((x) => x.action === a).length;
    return {
      days, ...shares, origins: WORK_ORIGINS, selfOrigins: SELF_ORIGINS,
      perUnit,
      caps: {
        selfWip: wipCap, selfPerDay: improvementTunable(org, 'admission.selfPerDay'), overCap: improvementTunable(org, 'admission.overCap') >= 1 ? 'park' : 'refuse',
        agentWakesPerHour: improvementTunable(org, 'attention.agentWakesPerHour'), maxOpenPerTarget: improvementTunable(org, 'improve.maxOpenPerTarget'), maxOpenPerUnit: improvementTunable(org, 'improve.maxOpenPerUnit'), perMeeting: improvementTunable(org, 'improve.perMeeting'),
      },
      admission: { refused: count('admission_refused'), parked: count('admission_parked'), deferredWakes: count('attention_deferred') },
      proposals: {
        opened: recent.length, accepted: reached('accepted'), applied: reached('applied'), verified: reached('verified'), reverted: reached('reverted'), rejected: reached('rejected'), expired: reached('expired'),
        open: proposals.filter((p) => (OPEN_STATUSES as readonly string[]).includes(p.status)).length, waiting: proposals.filter((p) => p.status === 'proposed').length, verifying: proposals.filter((p) => p.status === 'applied').length,
      },
    };
  }

  /** One line for the chief's and a head's context: where work comes from, what waits. */
  async contextLine(orgId: string, agentId: string): Promise<string | null> {
    const org = await this.org.get(orgId);
    const isChief = org.chiefOfStaffAgentId === agentId;
    const led = !isChief && this.units ? await this.units.ledBy(orgId, agentId).catch(() => null) : null;
    if (!isChief && !led) return null;
    const unitIds = led && this.units ? await this.units.subtree(orgId, led.id).catch(() => [led.id]) : null;
    const ws = await this.workSources(orgId, { days: 7, unitIds });
    const line = sourcesLine(ws, { open: ws.proposals.open, waiting: ws.proposals.waiting, applied: ws.proposals.verifying, verified: ws.proposals.verified }, 7);
    if (!line) return null;
    const mine = (await this.list(orgId, { limit: 200 })).filter((p) => p.owner === `agent:${agentId}` && (p.status === 'proposed' || (p.status === 'applied' && p.reviewPending))).slice(0, 4);
    return `${line}${mine.length ? ` On what you own: ${mine.map((p) => `${p.key} ${p.title.slice(0, 60)} (${p.status}${p.reviewPending ? ', review' : ''})`).join('; ')}.` : ''}`;
  }
}

function round(v: number | null | undefined): string { return v === null || v === undefined || !Number.isFinite(v) ? '—' : String(Math.round(v * 1000) / 1000); }

/** A small line diff (removed lines with -, added with +). */
function lineDiff(before: string, after: string): string[] {
  const a = (before ?? '').split('\n'); const b = (after ?? '').split('\n');
  const setA = new Set(a); const setB = new Set(b);
  return [...a.filter((l) => !setB.has(l) && l.trim()).map((l) => `- ${l}`), ...b.filter((l) => !setA.has(l) && l.trim()).map((l) => `+ ${l}`)].slice(0, 60);
}

export type { WorkOrigin };
