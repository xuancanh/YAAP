/**
 * OrgChiefService — the state of the company's operating system, as the
 * chief of staff's heartbeat reads it (docs/chief-of-staff.md §5;
 * docs/company-vision.md §13).
 *
 * The chief's real work is the upstream pipeline of each ritual: deadlines,
 * pre-reads, timers and logs (reports/Chief of staff operating model.md,
 * "The cadence is a nested pipeline"). This service computes, with no
 * model, what that pipeline looks like right now:
 *
 *  - the rituals coming up within `chief.ritualLookaheadHours`, with the
 *    pre-read deadline `chief.preReadHours` before each;
 *  - decision cards that have waited for the CEO longer than
 *    `chief.decisionOverdueHours`;
 *  - stale risks: at-risk key results and objectives with no check-in, and
 *    open warn or critical signals nobody acknowledged, for
 *    `chief.riskReviewDays`;
 *  - breached handoffs: a task one unit's member asked for that sits on
 *    another unit's board and has not moved for `chief.handoffSlaHours`;
 *  - the function owners (unit leads and members titled "… manager") the
 *    chief routes function-level work to.
 *
 * It registers on the gated heartbeat next to the runtime's `org` providers:
 * the state is context for the chief only, and a handoff that breached since
 * the chief's last beat is a reason to wake. Nothing here acts; the chief's
 * playbooks (packs/chief-of-staff.md) decide what to do with it.
 */
import { Injectable, Optional } from '@nestjs/common';
import { OrgService, type Organization, type OrgMember } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgUnitsService, type OrgUnit } from './org-units.service';
import { OrgMeetingsService, KIND_TITLES, type MeetingKind } from './org-meetings.service';
import { OrgSignalsService } from './org-signals.service';
import { AgentsService } from '../agents/agents.service';
import { HeartbeatService } from '../chats/heartbeat.service';
import { chiefTunable, proxyLevelOf } from './chief-tunables';

/** Statuses in which a handed-off task waits on its receiving side. */
const HANDOFF_WAITING = new Set(['backlog', 'todo', 'blocked', 'waiting', 'in_review']);
const H = 3_600_000;

export interface OperatingSystemState {
  orgId: string;
  orgName: string;
  proxyLevel: string;
  rituals: Array<{ kind: string; title: string; unit: string; at: string; preReadDue: string }>;
  overdueDecisions: Array<{ id: string; kind: string; summary: string; waitedHours: number; deadline: string | null }>;
  staleRisks: Array<{ ref: string; title: string; source: 'key_result' | 'objective' | 'signal'; staleDays: number }>;
  breachedHandoffs: Array<{ taskId: string; title: string; from: string; to: string; status: string; waitedHours: number; breachedAt: string }>;
  functionOwners: Array<{ name: string; title: string; unit: string }>;
}

@Injectable()
export class OrgChiefService {
  constructor(
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly approvals: OrgApprovalsService,
    private readonly agents: AgentsService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly meetings?: OrgMeetingsService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() heartbeat?: HeartbeatService,
  ) {
    heartbeat?.addReasonProvider({ name: 'chief', reasons: (agentId, ctx) => this.heartbeatReasons(agentId, ctx.now, ctx.lastRunAt) });
    heartbeat?.addContextProvider({ name: 'chief', context: (agentId, ctx) => this.heartbeatContext(agentId, ctx.now) });
  }

  /** The organizations this agent is the active chief of. */
  private async chiefOf(agentId: string): Promise<Organization[]> {
    const out: Organization[] = [];
    for (const m of (await this.org.membershipsOf(agentId)).filter((x) => x.status === 'active')) {
      const org = await this.org.get(m.orgId).catch(() => null);
      if (org && org.status === 'active' && org.chiefOfStaffAgentId === agentId) out.push(org);
    }
    return out;
  }

  /** The operating system's state for one organization at `now`. */
  async state(orgId: string, now = new Date()): Promise<OperatingSystemState> {
    const org = await this.org.get(orgId);
    const nowMs = now.getTime();
    const members = (await this.org.members(orgId)).filter((m) => m.status !== 'terminated');
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const units = this.units ? await this.units.units(orgId).catch(() => [] as OrgUnit[]) : [];
    const unitName = new Map(units.map((u) => [u.id, u.name]));

    // Rituals within the lookahead, with their pre-read deadline.
    const rituals: OperatingSystemState['rituals'] = [];
    if (this.meetings) {
      const horizon = nowMs + chiefTunable(org, 'chief.ritualLookaheadHours') * H;
      const preRead = chiefTunable(org, 'chief.preReadHours') * H;
      const kinds = new Set<string>(this.meetings.limitsFor(org).kinds);
      for (const c of await this.meetings.cadences(orgId)) {
        if (!c.enabled || !c.nextRunAt || !kinds.has(c.kind)) continue;
        const at = Date.parse(c.nextRunAt);
        if (!Number.isFinite(at) || at < nowMs || at > horizon) continue;
        rituals.push({ kind: c.kind, title: KIND_TITLES[c.kind as MeetingKind] ?? c.kind, unit: unitName.get(c.unitId) ?? 'the company', at: c.nextRunAt, preReadDue: new Date(at - preRead).toISOString() });
      }
      rituals.sort((a, b) => (a.at < b.at ? -1 : 1));
    }

    // Decision cards waiting on the CEO past the overdue window.
    const overdueMs = chiefTunable(org, 'chief.decisionOverdueHours') * H;
    const overdueDecisions = (await this.approvals.pending(orgId))
      .map((a) => ({ a, waited: nowMs - Date.parse(a.createdAt) }))
      .filter((x) => Number.isFinite(x.waited) && x.waited >= overdueMs)
      .map(({ a, waited }) => ({ id: a.id, kind: a.kind, summary: (a.recommendation || a.kind).slice(0, 160), waitedHours: Math.floor(waited / H), deadline: a.deadline ?? null }));

    // Stale risks: at-risk goals with no check-in, unacknowledged warnings.
    const staleMs = chiefTunable(org, 'chief.riskReviewDays') * 24 * H;
    const staleRisks: OperatingSystemState['staleRisks'] = [];
    for (const g of await this.org.goals(orgId)) {
      if (g.status !== 'active' || !g.atRisk || (g.kind !== 'key_result' && g.kind !== 'objective')) continue;
      const last = Date.parse(g.lastCheckInAt ?? g.createdAt);
      if (Number.isFinite(last) && nowMs - last >= staleMs) staleRisks.push({ ref: `goal:${g.id}`, title: g.title, source: g.kind, staleDays: Math.floor((nowMs - last) / (24 * H)) });
    }
    if (this.signals) {
      for (const s of await this.signals.list(orgId, { status: 'open' }).catch(() => [])) {
        if (s.severity === 'info') continue;
        const age = nowMs - Date.parse(s.createdAt);
        if (Number.isFinite(age) && age >= staleMs) staleRisks.push({ ref: `signal:${s.id}`, title: s.title, source: 'signal', staleDays: Math.floor(age / (24 * H)) });
      }
    }

    // Breached handoffs between units.
    const breachedHandoffs: OperatingSystemState['breachedHandoffs'] = [];
    if (units.length > 0) {
      const slaMs = chiefTunable(org, 'chief.handoffSlaHours') * H;
      const homeUnits = homeUnitsOf(members, units);
      for (const t of await this.tasks.list(orgId)) {
        if (!HANDOFF_WAITING.has(t.status) || !t.unitId || !t.createdBy.startsWith('agent:')) continue;
        const requester = t.createdBy.slice('agent:'.length);
        if (requester === org.chiefOfStaffAgentId) continue;
        const home = homeUnits(requester);
        if (home.size === 0 || home.has(t.unitId)) continue;
        const since = Date.parse(t.updatedAt);
        if (!Number.isFinite(since) || nowMs - since < slaMs) continue;
        const from = [...home].map((u) => unitName.get(u) ?? u).join(' / ');
        breachedHandoffs.push({ taskId: t.id, title: t.title, from: `${names.get(requester) ?? requester.slice(0, 8)} (${from})`, to: unitName.get(t.unitId) ?? t.unitId, status: t.status, waitedHours: Math.floor((nowMs - since) / H), breachedAt: new Date(since + slaMs).toISOString() });
      }
      breachedHandoffs.sort((a, b) => b.waitedHours - a.waitedHours);
    }

    // Function owners: unit leads and members titled "… manager".
    const leads = new Map(units.filter((u) => u.leadAgentId).map((u) => [u.leadAgentId, u]));
    const functionOwners = members
      .filter((m) => m.agentId !== org.chiefOfStaffAgentId && m.status === 'active' && (leads.has(m.agentId) || /\bmanager\b/i.test(m.title)))
      .map((m) => ({ name: names.get(m.agentId) ?? m.agentId.slice(0, 8), title: m.title || 'lead', unit: leads.get(m.agentId)?.name ?? '' }));

    return { orgId, orgName: org.name, proxyLevel: proxyLevelOf(org), rituals, overdueDecisions, staleRisks, breachedHandoffs, functionOwners };
  }

  /** Wake the chief for a handoff that breached since its last beat (a
   *  breach already seen stays in the context, not in the reasons). */
  async heartbeatReasons(agentId: string, now: Date, lastRunAt: string | null): Promise<string[]> {
    const out: string[] = [];
    const since = lastRunAt ? Date.parse(lastRunAt) : 0;
    for (const org of await this.chiefOf(agentId)) {
      const st = await this.state(org.id, now);
      for (const h of st.breachedHandoffs.filter((x) => Date.parse(x.breachedAt) > since).slice(0, 3)) {
        out.push(`handoff breached: task [${h.taskId.slice(0, 8)}] "${h.title}" from ${h.from} has waited ${h.waitedHours}h in ${h.to} (chief.handoffSlaHours ${chiefTunable(org, 'chief.handoffSlaHours')}h) — run your handoff-sla-monitor playbook; route it, don't resolve it`);
      }
    }
    return out;
  }

  /** The operating-system block of the chief's heartbeat prompt (data). */
  async heartbeatContext(agentId: string, now: Date): Promise<string | null> {
    const blocks: string[] = [];
    for (const org of await this.chiefOf(agentId)) blocks.push(describeState(await this.state(org.id, now)));
    return blocks.length ? blocks.join('\n\n') : null;
  }
}

/** A member's home units: the unit it leads and the unit it sits in. */
function homeUnitsOf(members: OrgMember[], units: OrgUnit[]): (agentId: string) => Set<string> {
  const byAgent = new Map(members.map((m) => [m.agentId, m]));
  const root = units.find((u) => u.parentUnitId === null) ?? null;
  return (agentId: string) => {
    const out = new Set<string>();
    for (const u of units) if (u.leadAgentId === agentId) out.add(u.id);
    let cur = byAgent.get(agentId)?.reportsToAgentId ?? null;
    for (let i = 0; cur && i < 10; i++) {
      const u = units.find((x) => x.leadAgentId === cur);
      if (u) { out.add(u.id); return out; }
      cur = byAgent.get(cur)?.reportsToAgentId ?? null;
    }
    if (root && byAgent.has(agentId)) out.add(root.id);
    return out;
  };
}

const at = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** The state as prompt lines: only the sections with something in them. */
export function describeState(st: OperatingSystemState): string {
  const lines = [`## Operating system of "${st.orgName}" (you are its chief of staff; archetype: ${st.proxyLevel})`];
  if (st.rituals.length) lines.push('Rituals coming up (their owners run them; you own the pre-reads):', ...st.rituals.slice(0, 6).map((r) => `- ${r.title} of ${r.unit} at ${at(r.at)}; pre-reads due ${at(r.preReadDue)}`));
  if (st.overdueDecisions.length) lines.push('Decisions waiting on the CEO past the overdue window (put them first in the brief; never decide them yourself):', ...st.overdueDecisions.slice(0, 6).map((d) => `- [${d.id.slice(0, 8)}] ${d.kind}: ${d.summary} — waited ${d.waitedHours}h${d.deadline ? `, default at ${at(d.deadline)}` : ''}`));
  if (st.staleRisks.length) lines.push('Stale risks (no check-in or acknowledgement within chief.riskReviewDays; ask the owner to re-score, do not re-score for them):', ...st.staleRisks.slice(0, 6).map((r) => `- [${r.ref.slice(0, r.ref.indexOf(':') + 9)}] ${r.source.replace('_', ' ')} "${r.title}" — ${r.staleDays} day(s)`));
  if (st.breachedHandoffs.length) lines.push('Breached handoffs (route to the owner, then the shared manager or /org/issues.md):', ...st.breachedHandoffs.slice(0, 6).map((h) => `- [${h.taskId.slice(0, 8)}] "${h.title}" from ${h.from} → ${h.to}, ${h.status.replace('_', ' ')} for ${h.waitedHours}h`));
  if (st.functionOwners.length) lines.push(`Function owners (route function-level work to them): ${st.functionOwners.map((o) => `${o.name} (${o.title}${o.unit ? `, ${o.unit}` : ''})`).join('; ')}.`);
  if (lines.length === 1) lines.push('Nothing overdue: no ritual in the lookahead, no decision past due, no stale risk, no breached handoff.');
  lines.push('The ledger lives under /org/ (operating-system.md, scorecard.md, issues.md, decisions.md, calendar.md, risks.md, handoffs.md, values.md).');
  return lines.join('\n');
}
