/**
 * OrgBoundaryService — the self-modification boundary enforced in one place
 * (docs/boundary.md, execution-plan item 31, C8).
 *
 * The table and the decision are pure (boundary.ts). This service binds the
 * decision into OrgService (`OrgService.gate` / `boundaryDecide`), which
 * every self-change writer and every tool path calls, and adds the side
 * effects:
 *
 *  - an agent attempting a `never` change → a `boundary_violation` audit row,
 *    a critical `audit_finding` signal for the CEO and a minor
 *    `boundary_violation` incident (OrgIncidentsService), once per agent and
 *    rule while the incident is open;
 *  - `experiment` → refused with "propose one with org_propose_experiment"
 *    when OrgExperimentsService (item 30) is present (or a probe is bound
 *    through the ORG_EXPERIMENTS token); without one, an approval card
 *    (`boundary.experimentFallbackCard`);
 *  - every decision is kept in a short in-memory log (`recent`) and told to
 *    listeners, which is how the tests prove each path consults it.
 *
 * Humans are not bound except by the rows that bind everyone (the audit
 * chain). Model-free.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { OrgService } from './org.service';
import { OrgAuditService } from './org-audit.service';
import { OrgSignalsService } from './org-signals.service';
import { OrgIncidentsService } from './org-incidents.service';
import { OrgExperimentsService } from './org-experiments.service';
import { checkBoundary, describeBoundary, type BoundaryDecision, type SelfChange } from './boundary';
import { govTunable } from './governance-tunables';

/** Item 30's experiments service, when present, provides this token. */
export const ORG_EXPERIMENTS = 'ORG_EXPERIMENTS';
export interface ExperimentsProbe { available(orgId?: string): boolean | Promise<boolean> }

export interface BoundaryCheckRecord { orgId: string; change: SelfChange; actor: string; outcome: BoundaryDecision['outcome']; rule: string; at: string }
export type BoundaryListener = (rec: BoundaryCheckRecord) => void;

@Injectable()
export class OrgBoundaryService {
  private readonly log: BoundaryCheckRecord[] = [];
  private readonly listeners: BoundaryListener[] = [];

  constructor(
    private readonly org: OrgService,
    private readonly audit: OrgAuditService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() private readonly incidents?: OrgIncidentsService,
    @Optional() @Inject(ORG_EXPERIMENTS) private experiments?: ExperimentsProbe,
    /** Item 30: when the experiments service is present, `experiment` changes route to it. */
    @Optional() experimentsService?: OrgExperimentsService,
  ) {
    if (!this.experiments && experimentsService) this.experiments = { available: () => true };
    org.bindBoundary((orgId, change, actor) => this.checkBoundary(orgId, change, actor));
  }

  /** Bind (or replace) the experiments probe — item 30's service, or a test. */
  setExperiments(probe: ExperimentsProbe | undefined): void { this.experiments = probe; }

  /** The table (GET …/org/boundary). */
  table() { return describeBoundary(); }

  /** The last decisions (newest last), bounded. */
  recent(orgId?: string): BoundaryCheckRecord[] { return this.log.filter((r) => !orgId || r.orgId === orgId); }

  onCheck(fn: BoundaryListener): () => void {
    this.listeners.push(fn);
    return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); };
  }

  /** The one decision for one self-change by one actor, with its side effects. */
  async checkBoundary(orgId: string, change: SelfChange, actor: string): Promise<BoundaryDecision> {
    const org = await this.org.get(orgId);
    const experiments = this.experiments ? Boolean(await Promise.resolve(this.experiments.available(orgId)).catch(() => false)) : false;
    const d = checkBoundary(change, actor, { experiments, fallbackCard: govTunable(org, 'boundary.experimentFallbackCard') >= 1 });
    const rec: BoundaryCheckRecord = { orgId, change, actor, outcome: d.outcome, rule: d.rule.id, at: new Date().toISOString() };
    this.log.push(rec);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    for (const fn of this.listeners) { try { fn(rec); } catch { /* listeners never break a change */ } }
    if (d.outcome === 'refuse' && d.rule.verdict === 'never' && d.agent) await this.violation(orgId, change, actor, d, org.chiefOfStaffAgentId);
    else if (d.outcome !== 'proceed' && d.agent) {
      await this.audit.append(orgId, { actor, action: 'boundary_route', refType: 'boundary', refId: d.rule.id, payload: { outcome: d.outcome, kind: change.kind, key: change.key ?? null, summary: (change.summary ?? '').slice(0, 200) } });
    }
    return d;
  }

  /** An agent tried a never-change: an audit row, a critical finding for the
   *  CEO and a minor incident (one per agent and rule while it is open). */
  private async violation(orgId: string, change: SelfChange, actor: string, d: BoundaryDecision, chiefId: string | null): Promise<void> {
    const agentId = actor === 'chief' ? chiefId : actor.startsWith('agent:') ? actor.slice('agent:'.length) : null;
    const title = `Boundary violation: ${actor === 'chief' ? 'the chief of staff' : 'a member'} tried to change ${d.rule.match}`;
    const detail = `${change.summary ? `${change.summary}. ` : ''}${d.rule.match} is never an agent's to change (${d.rule.reason}). Refused; nothing changed.`;
    await this.audit.append(orgId, { actor, action: 'boundary_violation', refType: 'boundary', refId: d.rule.id, payload: { kind: change.kind, key: change.key ?? null, agentId, summary: (change.summary ?? '').slice(0, 200) } });
    await this.signals?.open(orgId, { kind: 'audit_finding', severity: 'critical', refType: 'boundary', refId: `${d.rule.id}:${agentId ?? actor}`, title: title.slice(0, 200), detail, addressee: 'ceo' }).catch(() => undefined);
    await this.incidents?.open(orgId, { kind: 'boundary_violation', severity: 'minor', title, detail, cause: `it tried to change ${d.rule.match}, which is never an agent's (refused, nothing changed)`, agentId, refType: 'boundary', refId: `${d.rule.id}:${agentId ?? actor}`, detectedBy: 'system' }).catch(() => undefined);
  }
}
