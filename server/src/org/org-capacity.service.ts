/**
 * OrgCapacityService — the capacity model (docs/autonomous-org-first-principles.md
 * C4, execution-plan item 31). Model-free.
 *
 *  - **WIP.** `capacity.wipPerMember` open tasks per member: OrgTasksService
 *    refuses an assignment beyond it (`checkWip`, the chief may override with
 *    a reason, audited) and a run does not claim a todo task while the member
 *    already has that many active ones (`claimBlocker`).
 *  - **Expected duration.** Per task class and member, the median number of
 *    runs and the median wall time from creation to done over the last
 *    `capacity.historyDays`, falling back to the class across members. The
 *    board API shows it per task (`expected`); the chief's planning prompt
 *    reads it with each member's load.
 *  - **Dependencies.** A graph on `org_tasks.dependsOn` (cycles refused on
 *    write, `waiting` until the last one is done, then todo and a wake) —
 *    held by OrgTasksService.
 *  - **Deadlines.** `org_tasks.dueAt`: the heartbeat ranks overdue, then due
 *    within `capacity.dueSoonHours`, ahead of the rest (`urgencyOf`); an
 *    overdue task is a `task_overdue` signal to its owner, and after
 *    `capacity.overdueEscalateHours` a `task_overdue_lead` signal to the lead
 *    of its unit. Both resolve when the task is done or its deadline moves.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { OrgService } from './org.service';
import { OrgTasksService, type OrgTask } from './org-tasks.service';
import { OrgSignalsService } from './org-signals.service';
import { OrgUnitsService } from './org-units.service';
import { AgentsService } from '../agents/agents.service';
import { OrgRuntimeService } from './org-runtime.service';
import { govTunable } from './governance-tunables';

export interface Expectation { runs: number | null; hours: number | null; samples: number; basis: 'member' | 'class' | 'none' }
export interface MemberCapacity { agentId: string; name: string; title: string; open: number; wip: number; atLimit: boolean; expectedHours: number | null; tasks: Array<{ id: string; title: string; status: string; dueAt: string | null }> }

/** 0 overdue, 1 due soon, 2 the rest (lower is more urgent). Pure. */
export function urgencyOf(t: Pick<OrgTask, 'dueAt'>, now: Date, dueSoonHours: number): 0 | 1 | 2 {
  if (!t.dueAt) return 2;
  const ms = Date.parse(t.dueAt) - now.getTime();
  if (ms < 0) return 0;
  return ms <= dueSoonHours * 3_600_000 ? 1 : 2;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const OVERDUE_KINDS = ['task_overdue', 'task_overdue_lead'];

@Injectable()
export class OrgCapacityService {
  private readonly logger = new Logger(OrgCapacityService.name);

  constructor(
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly agents: AgentsService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() runtime?: OrgRuntimeService,
  ) {
    runtime?.addTicker({ name: 'capacity', everyMinutes: 5, fn: (org, now) => this.sweepDue(org.id, now).then(() => undefined) });
    runtime?.addPlanningNotes(async (org, _unit, isChief) => (isChief ? ['## Capacity (plan within it)', await this.describe(org.id)] : []));
    tasks.setBoardAnnotator(async (orgId, rows) => {
      const exp = await this.expectations(orgId);
      return new Map(rows.map((t) => [t.id, { expected: this.expectedFor(exp, t) }]));
    });
  }

  /** Medians per `agentId|class` and per `*|class` from finished tasks. */
  async expectations(orgId: string, now = new Date()): Promise<Map<string, Expectation>> {
    const org = await this.org.get(orgId);
    const since = new Date(now.getTime() - govTunable(org, 'capacity.historyDays') * 86_400_000).toISOString();
    const done = (await this.tasks.list(orgId)).filter((t) => t.status === 'done' && t.assigneeAgentId && t.updatedAt >= since);
    const runs = await this.tasks.runs(orgId, { limit: 500 });
    const groups = new Map<string, { runs: number[]; hours: number[] }>();
    const push = (key: string, r: number, h: number) => { const g = groups.get(key) ?? { runs: [], hours: [] }; g.runs.push(r); g.hours.push(h); groups.set(key, g); };
    for (const t of done) {
      const n = runs.filter((r) => r.taskId === t.id && r.agentId === t.assigneeAgentId && r.status !== 'refused').length;
      const h = Math.max(0, (Date.parse(t.updatedAt) - Date.parse(t.createdAt)) / 3_600_000);
      push(`${t.assigneeAgentId}|${t.class}`, n, h);
      push(`*|${t.class}`, n, h);
    }
    const out = new Map<string, Expectation>();
    for (const [k, g] of groups) out.set(k, { runs: median(g.runs), hours: round(median(g.hours)), samples: g.runs.length, basis: k.startsWith('*|') ? 'class' : 'member' });
    return out;
  }

  expectedFor(exp: Map<string, Expectation>, t: Pick<OrgTask, 'assigneeAgentId' | 'class'>): Expectation {
    return (t.assigneeAgentId ? exp.get(`${t.assigneeAgentId}|${t.class}`) : undefined) ?? exp.get(`*|${t.class}`) ?? { runs: null, hours: null, samples: 0, basis: 'none' };
  }

  /** Every active member's open work against the WIP limit, with the expected load. */
  async overview(orgId: string): Promise<{ wip: number; members: MemberCapacity[] }> {
    const org = await this.org.get(orgId);
    const wip = govTunable(org, 'capacity.wipPerMember');
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const exp = await this.expectations(orgId);
    const all = await this.tasks.list(orgId);
    const members = (await this.org.members(orgId)).filter((m) => m.status === 'active');
    return {
      wip,
      members: members.map((m) => {
        const open = all.filter((t) => t.assigneeAgentId === m.agentId && ['todo', 'claimed', 'in_progress', 'blocked'].includes(t.status));
        const hours = open.map((t) => this.expectedFor(exp, t).hours).filter((h): h is number => h !== null);
        return { agentId: m.agentId, name: names.get(m.agentId) ?? m.agentId.slice(0, 8), title: m.title, open: open.length, wip, atLimit: open.length >= wip, expectedHours: hours.length ? round(hours.reduce((a, b) => a + b, 0)) : null, tasks: open.map((t) => ({ id: t.id, title: t.title, status: t.status, dueAt: t.dueAt })) };
      }),
    };
  }

  /** The capacity block of the chief's planning prompt and of org_capacity. */
  async describe(orgId: string): Promise<string> {
    const o = await this.overview(orgId);
    const exp = await this.expectations(orgId);
    const classes = [...exp.entries()].filter(([k]) => k.startsWith('*|')).map(([k, v]) => `${k.slice(2)} ≈ ${v.runs ?? '?'} run(s), ${v.hours ?? '?'}h (n=${v.samples})`);
    return [
      `WIP limit ${o.wip} open task(s) per member (capacity.wipPerMember).`,
      ...o.members.map((m) => `- ${m.name}${m.title ? ` (${m.title})` : ''}: ${m.open}/${m.wip} open${m.atLimit ? ' — AT LIMIT' : ''}${m.expectedHours !== null ? `, ≈${m.expectedHours}h expected` : ''}`),
      classes.length ? `Expected duration by class (median of finished work): ${classes.join('; ')}.` : 'No finished work yet to estimate durations from.',
    ].join('\n');
  }

  /** Overdue tasks → a signal to the owner, then to the lead; resolve the cleared ones. */
  async sweepDue(orgId: string, now = new Date()): Promise<{ owner: number; lead: number; resolved: number }> {
    if (!this.signals) return { owner: 0, lead: 0, resolved: 0 };
    const org = await this.org.get(orgId);
    const escalateMs = govTunable(org, 'capacity.overdueEscalateHours') * 3_600_000;
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const tasks = await this.tasks.list(orgId);
    let owner = 0; let lead = 0;
    const live = new Set<string>();
    for (const t of tasks.filter((x) => x.dueAt && !['done', 'cancelled'].includes(x.status) && Date.parse(x.dueAt) < now.getTime())) {
      const late = now.getTime() - Date.parse(t.dueAt!);
      const hrs = Math.round(late / 3_600_000);
      live.add(`task_overdue:${t.id}`);
      const r = await this.signals.open(orgId, { kind: 'task_overdue', severity: 'warn', refType: 'task', refId: t.id, title: `Overdue: "${t.title}" was due ${t.dueAt!.slice(0, 16).replace('T', ' ')}`, detail: `Owner ${t.assigneeAgentId ? names.get(t.assigneeAgentId) ?? t.assigneeAgentId.slice(0, 8) : 'nobody'}, ${hrs}h late. Finish it, move the deadline with a reason, or hand it back.`, addressee: t.assigneeAgentId ? 'owner' : 'chief', addresseeId: t.assigneeAgentId ?? undefined, unitId: t.unitId }, now).catch(() => null);
      if (r?.created) owner++;
      if (late >= escalateMs) {
        live.add(`task_overdue_lead:${t.id}`);
        const unit = this.units ? await this.units.unitForAssignee(orgId, t.assigneeAgentId).catch(() => null) : null;
        const leadId = unit && unit.leadAgentId !== t.assigneeAgentId ? unit.leadAgentId : org.chiefOfStaffAgentId ?? undefined;
        const r2 = await this.signals.open(orgId, { kind: 'task_overdue_lead', severity: 'warn', refType: 'task', refId: t.id, title: `Overdue ${hrs}h with its owner: "${t.title}"`, detail: `Still open ${hrs}h past its deadline. Reassign, rebrief, re-plan the deadline or cancel it.`, addressee: 'lead', addresseeId: leadId, unitId: t.unitId }, now).catch(() => null);
        if (r2?.created) lead++;
      }
    }
    let resolved = 0;
    for (const s of (await this.signals.list(orgId)).filter((x) => x.status !== 'resolved' && OVERDUE_KINDS.includes(x.kind))) {
      if (live.has(`${s.kind}:${s.refId}`)) continue;
      await this.signals.resolve(orgId, s.id, 'system').catch(() => undefined);
      resolved++;
    }
    return { owner, lead, resolved };
  }
}

function round(v: number | null): number | null { return v === null ? null : Math.round(v * 10) / 10; }
