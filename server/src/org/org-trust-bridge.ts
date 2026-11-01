/**
 * OrgTrustBridge — binds the action contract and the trust ledger
 * (docs/actions-and-trust.md, execution-plan item 28) to the organization
 * without the actions module importing the org domain:
 *
 *  - level changes, co-signer turns, keys and reverts land in the org's
 *    hash-chained audit log;
 *  - a rate-limit refusal opens an `action_rate_limit` signal for the chief;
 *  - a held or staged action in an org workspace is also a `two_key`
 *    approval card the CEO decides (approve → the action runs or the draft
 *    is sent through `ActionsService.ownerKey`; reject → denied), and a key
 *    given on the actions route settles that card;
 *  - review verdicts feed the ledger: an accepted task is a clean
 *    `internal_write` outcome for its assignee, changes requested a rejection;
 *  - incidents (item 29): a class an incident froze is held for the owner's
 *    key for every member of the org, whatever its level; an owner's revert
 *    report on a member's action opens a `revert` incident, whose demotion
 *    is the ledger's one change.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgApprovals, orgMembers, organizations } from '../database/schema';
import { currentAccountId } from '../accounts/account-context';
import { nowIso } from '../common/ids.util';
import { ActionsService } from '../actions/actions.service';
import { TrustService } from '../actions/trust.service';
import { OrgAuditService } from './org-audit.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgSignalsService } from './org-signals.service';
import { OrgIncidentsService } from './org-incidents.service';
import { OrgService } from './org.service';

@Injectable()
export class OrgTrustBridge {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly audit: OrgAuditService,
    private readonly approvals: OrgApprovalsService,
    private readonly tasks: OrgTasksService,
    @Optional() private readonly actions?: ActionsService,
    @Optional() private readonly trust?: TrustService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() private readonly incidents?: OrgIncidentsService,
    @Optional() private readonly org?: OrgService,
  ) {
    if (!actions || !trust) return;
    const auditSink = async (workspaceId: string, entry: { actor: string; action: string; refType: string; refId: string; payload: Record<string, unknown> }) => {
      const orgId = await this.orgIdOf(workspaceId);
      if (orgId) await this.audit.append(orgId, entry);
    };
    trust.hooks.audit = auditSink;
    // Trust ceilings are a boundary row (propose for agents; humans pass): one fence for every path.
    trust.hooks.boundary = async (workspaceId, actor, summary) => {
      const orgId = await this.orgIdOf(workspaceId);
      if (orgId) await this.org?.gate(orgId, { kind: 'trust_ceiling', summary }, actor === currentAccountId() ? 'user' : actor.startsWith('agent:') || actor === 'chief' ? actor : `human:${actor}`);
    };
    actions.hooks.audit = auditSink;
    actions.hooks.frozen = async (workspaceId, agentId, cls) => {
      const orgId = await this.orgIdOf(workspaceId);
      if (!orgId || !this.incidents || !(await this.isMember(orgId, agentId))) return false;
      return this.incidents.isFrozen(orgId, cls);
    };
    actions.hooks.revertIncident = async (row, note) => {
      const orgId = await this.orgIdOf(row.workspaceId);
      if (!orgId || !this.incidents || !row.agentId || !(await this.isMember(orgId, row.agentId))) return false;
      await this.incidents.reportIncident(orgId, {
        kind: 'revert', agentId: row.agentId, actionClass: row.class,
        title: `The owner reverted ${row.tool} (action ${row.id.slice(0, 8)})`,
        detail: note || 'Reported through the action log.', detectedBy: 'owner',
      });
      return true;
    };
    actions.hooks.signal = async (workspaceId, input) => {
      const orgId = await this.orgIdOf(workspaceId);
      if (orgId && this.signals) await this.signals.open(orgId, { ...input, refType: 'action', addressee: 'chief' });
    };
    actions.hooks.openApproval = async (workspaceId, action, summary) => {
      const orgId = await this.orgIdOf(workspaceId);
      if (!orgId) return null;
      const a = await this.approvals.create(orgId, {
        kind: 'two_key',
        payload: { actionId: action.id, workspaceId, tool: action.tool, class: action.class, staged: action.status === 'staged', agentId: action.agentId, summary },
        requestedBy: action.agentId ? `agent:${action.agentId}` : 'system',
        recommendation: `The second key for an ${action.class.replace(/_/g, ' ')} action. Approve to ${action.status === 'staged' ? 'send the staged draft' : 'run it'} now; reject to drop it.`,
      });
      return a.id;
    };
    actions.hooks.closeApproval = async (workspaceId, approvalId, approved, note) => {
      const orgId = await this.orgIdOf(workspaceId);
      if (!orgId) return;
      await this.db.update(orgApprovals).set({ status: approved ? 'approved' : 'rejected', decidedAt: nowIso(), decidedBy: currentAccountId(), decisionNote: `decided on the action itself${note ? `: ${note}` : ''}`.slice(0, 2_000) })
        .where(and(eq(orgApprovals.id, approvalId), eq(orgApprovals.status, 'pending')));
    };
    approvals.onApply('two_key', async (orgId, payload, approval, note) => {
      const r = await actions.ownerKey(typeof payload.workspaceId === 'string' ? payload.workspaceId : '', typeof payload.actionId === 'string' ? payload.actionId : '', true, note ?? approval.decisionNote ?? '', undefined, { fromApproval: true });
      return { actionId: payload.actionId, ...r };
    });
    approvals.onDecided(async (ev) => {
      if (ev.approval.kind !== 'two_key' || ev.decision === 'approve') return;
      const payload = JSON.parse(ev.approval.payload || '{}') as { workspaceId?: string; actionId?: string };
      if (payload.workspaceId && payload.actionId) await actions.ownerKey(payload.workspaceId, payload.actionId, false, ev.note, undefined, { fromApproval: true }).catch(() => undefined);
    });
    tasks.onReviewVerdict(async (ev) => {
      if (!ev.assigneeAgentId || ev.verdict === 'escalate') return;
      const org = (await this.db.select({ workspaceId: organizations.workspaceId }).from(organizations).where(eq(organizations.id, ev.orgId))).at(0);
      if (!org) return;
      await trust.record(org.workspaceId, ev.assigneeAgentId, 'internal_write', ev.verdict === 'accept' ? 'success' : 'rejected', { refType: 'task', refId: ev.taskId });
    });
  }

  private async isMember(orgId: string, agentId: string): Promise<boolean> {
    const m = (await this.db.select({ status: orgMembers.status }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.agentId, agentId)))).at(0);
    return Boolean(m && m.status !== 'terminated');
  }

  private async orgIdOf(workspaceId: string): Promise<string | null> {
    const row = (await this.db.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.workspaceId, workspaceId), ne(organizations.status, 'archived')))).at(0);
    return row?.id ?? null;
  }
}
