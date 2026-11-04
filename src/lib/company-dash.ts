/** The company section dashboards (docs/company-vision.md "On screen"):
 *  the pure summaries each dashboard's cards show — counts, short lists and
 *  the one plain sentence that opens each dashboard. The view is
 *  src/components/CompanyDashboards.tsx. */
import type { OrgAllocation, OrgCadence, OrgIncident, OrgIntentNode, OrgSpend, OrgTask, OrgUnitNode, ProjectSummary } from './api';
import { flattenIntent } from './org';
import { incidentLine, type IncidentCounts } from './org3';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- Direction ----

export interface ObjectiveLine { id: string; title: string; progress: number; atRisk: boolean; reason: string; krs: number }
/** The objectives (top-level goals under the vision), with their key-result counts and risk. */
export function objectivesOf(intent: OrgIntentNode[]): ObjectiveLine[] {
  const all = flattenIntent(intent);
  return all.filter((g) => g.kind === 'objective' && g.status !== 'done' && g.status !== 'cancelled').map((g) => ({
    id: g.id, title: g.title, progress: Math.max(0, Math.min(1, g.progress ?? 0)), atRisk: g.atRisk === 1 || all.some((k) => k.parentGoalId === g.id && k.atRisk === 1),
    reason: g.atRiskReason, krs: all.filter((k) => k.parentGoalId === g.id && k.kind === 'key_result').length,
  }));
}

export function laneCounts(projects: ProjectSummary[]): { now: number; next: number; later: number } {
  const c = { now: 0, next: 0, later: 0 };
  for (const p of projects) if (p.status !== 'done' && p.status !== 'cancelled' && (p.lane === 'now' || p.lane === 'next' || p.lane === 'later')) c[p.lane] += 1;
  return c;
}

/** What waits on the CEO is said once, by the dashboard's Inbox row, not here. */
export function directionLede(objectives: ObjectiveLine[], lanes: { now: number } | null): string {
  const parts: string[] = [];
  if (objectives.length === 0) parts.push('No objectives yet.');
  else {
    const risk = objectives.filter((o) => o.atRisk).length;
    parts.push(`${plural(objectives.length, 'objective')} in play${risk ? `, ${risk} at risk` : ', none at risk'}.`);
  }
  if (lanes) parts.push(lanes.now ? `${plural(lanes.now, 'project')} in Now.` : 'Nothing in Now on the roadmap.');
  return parts.join(' ');
}

// ---- Operations ----

const OPEN = new Set(['backlog', 'waiting', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked']);
export interface BoardCounts { open: number; inProgress: number; inReview: number; blocked: number; todo: number; doneThisWeek: number }
export function boardCounts(tasks: OrgTask[], now = new Date()): BoardCounts {
  const week = now.getTime() - 7 * 86_400_000;
  const c: BoardCounts = { open: 0, inProgress: 0, inReview: 0, blocked: 0, todo: 0, doneThisWeek: 0 };
  for (const t of tasks) {
    if (OPEN.has(t.status)) c.open += 1;
    if (t.status === 'in_progress' || t.status === 'claimed') c.inProgress += 1;
    else if (t.status === 'in_review') c.inReview += 1;
    else if (t.status === 'blocked') c.blocked += 1;
    else if (t.status === 'todo' || t.status === 'backlog' || t.status === 'waiting') c.todo += 1;
    else if (t.status === 'done' && new Date(t.updatedAt).getTime() >= week) c.doneThisWeek += 1;
  }
  return c;
}

export interface RitualLine { id: string; kind: string; unitName: string; at: string }
/** The next ritual occurrences, soonest first (cadences that are on and scheduled). */
export function nextRituals(cadences: OrgCadence[], units: OrgUnitNode[], limit = 4): RitualLine[] {
  const names = new Map(flatUnits(units).map((u) => [u.id, u.parentUnitId === null ? 'Company' : u.name]));
  return cadences.filter((c) => c.enabled === 1 && c.nextRunAt).sort((a, b) => (a.nextRunAt! < b.nextRunAt! ? -1 : 1)).slice(0, limit)
    .map((c) => ({ id: c.id, kind: c.kind, unitName: names.get(c.unitId) ?? 'Company', at: c.nextRunAt! }));
}

export function operationsLede(board: BoardCounts | null, incidents: IncidentCounts, pulse: number | null): string {
  const parts: string[] = [];
  if (board) parts.push(board.open ? `${plural(board.open, 'open task')}${board.blocked ? `, ${board.blocked} blocked` : ''}.` : 'The board is clear.');
  if (pulse !== null) parts.push(`Pulse ${Math.round(pulse)}.`);
  parts.push(`${incidentLine(incidents)}.`);
  return parts.join(' ');
}

// ---- People ----

export function flatUnits(nodes: OrgUnitNode[]): OrgUnitNode[] {
  return nodes.flatMap((n) => [n, ...flatUnits(n.children)]);
}

/** Members that run nothing: a paused seat, or every member while the company
 *  is paused. The same set the org chart's "paused" counts (the server's
 *  `deriveState` puts paused before an error), so the two never disagree. */
export function pausedMembers(members: ReadonlyArray<{ status: string }>, orgStatus: string | null | undefined): number {
  const live = members.filter((m) => m.status !== 'terminated');
  return orgStatus === 'paused' ? live.length : live.filter((m) => m.status === 'paused').length;
}

export function peopleLede(members: number, units: number, atLimit: number): string {
  const parts = [`${plural(members, 'member')} in ${plural(units, 'team')}.`];
  parts.push(atLimit ? `${plural(atLimit, 'member')} at their work-in-progress limit.` : 'Nobody is at their limit.');
  return parts.join(' ');
}

// ---- Money ----

export interface BudgetLine { key: string; label: string; usd: number; cap: number; pct: number }
/** Agents and projects with an envelope, most used first. */
export function budgetLines(spend: OrgSpend, limit = 5): BudgetLine[] {
  const rows: BudgetLine[] = [
    ...spend.projects.map((p) => ({ key: `p:${p.id}`, label: p.title, usd: p.usd + p.reservedUsd, cap: p.monthlyUsd })),
    ...spend.members.map((m) => ({ key: `a:${m.agentId}`, label: m.name, usd: m.usd + m.reservedUsd, cap: m.monthlyUsd })),
  ].filter((r) => r.cap > 0).map((r) => ({ ...r, pct: r.usd / r.cap }));
  return rows.sort((a, b) => b.pct - a.pct).slice(0, limit);
}

export interface CapitalLine { goalId: string; title: string; monthlyUsd: number }
/** Capital allocated per goal, largest first. */
export function capitalByGoal(allocations: OrgAllocation[], titleOf: (goalId: string) => string | undefined): CapitalLine[] {
  const by = new Map<string, number>();
  for (const a of allocations) by.set(a.goalId, (by.get(a.goalId) ?? 0) + a.monthlyUsd);
  return [...by.entries()].map(([goalId, monthlyUsd]) => ({ goalId, title: titleOf(goalId) ?? 'A goal', monthlyUsd })).sort((a, b) => b.monthlyUsd - a.monthlyUsd);
}

export function moneyLede(spentUsd: number, capUsd: number, projectedUsd: number | null, fmt: (n: number) => string): string {
  const parts = [capUsd > 0 ? `${fmt(spentUsd)} of ${fmt(capUsd)} spent this month.` : `${fmt(spentUsd)} spent this month, with no company envelope.`];
  if (projectedUsd !== null) parts.push(capUsd > 0 && projectedUsd > capUsd ? `On pace for ${fmt(projectedUsd)}, past the envelope.` : `On pace for ${fmt(projectedUsd)} by month end.`);
  return parts.join(' ');
}

// ---- Oversight ----

export function incidentHistory(incidents: OrgIncident[], now = new Date(), days = 30): { opened: number; resolved: number; open: number; recent: OrgIncident[] } {
  const from = now.getTime() - days * 86_400_000;
  const inWindow = incidents.filter((i) => new Date(i.openedAt).getTime() >= from);
  return {
    opened: inWindow.length,
    resolved: inWindow.filter((i) => i.status === 'resolved').length,
    open: incidents.filter((i) => i.status !== 'resolved').length,
    recent: [...incidents].filter((i) => i.status !== 'open').sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1)).slice(0, 3),
  };
}

export function oversightLede(chainOk: boolean | null, findings: number | null): string {
  const parts: string[] = [];
  parts.push(chainOk === null ? 'The audit chain has not been checked yet.' : chainOk ? 'The audit chain is intact.' : 'The audit chain is broken.');
  if (findings !== null) parts.push(findings ? `The last audit raised ${plural(findings, 'finding')}.` : 'The last audit found nothing.');
  return parts.join(' ');
}

/** The auditor's findings in a run (JSON AuditFinding[]); 0 when unreadable. */
export function findingsCount(raw: string | null | undefined): number {
  try { const v = JSON.parse(raw ?? '[]') as unknown; return Array.isArray(v) ? v.length : 0; } catch { return 0; }
}

/** Yesterday's day key (YYYY-MM-DD, local), the Replay's usual first look. */
export function yesterdayKey(now = new Date()): string {
  const d = new Date(now.getTime() - 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
