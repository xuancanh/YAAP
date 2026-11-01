/**
 * The rest of the CEO's seat, pure helpers (docs/company-vision.md §6, §7,
 * §8, §9; execution plan items 22–24): how a plan's actions read as a diff,
 * the veto countdown, citation chips in an answer, a replay day grouped by
 * hour, the cost-per-outcome rows and the overspend flag, forecast states,
 * routing tiers and their resolved model, the import plan summary, the graph
 * around a thing as grouped lists, lesson audiences. No fetches, no React —
 * `web-tests/org2.test.ts` pins these.
 */
import type {
  BlueprintImportPlan, Citation, CitationKind, CostReport, EnvelopeForecast, ForecastState, GraphNode, LessonAudience, ModelTier, ObjectiveCost, OrgGraph, OrgPlan,
  OrgRouting, PlanAction, PlanActionResult, PlanStatus, ReplayEntry, ReplayKind,
} from './api';
import { safeJsonParse } from './util';

// ---- plans as a diff (§8) ----

export type PlanGroup = 'hire' | 'reorg' | 'terminate' | 'scope' | 'budget' | 'routing' | 'tune' | 'other';
export const PLAN_GROUP_ORDER: PlanGroup[] = ['hire', 'reorg', 'terminate', 'scope', 'budget', 'routing', 'tune', 'other'];
export const PLAN_GROUP_LABEL: Record<PlanGroup, string> = { hire: 'Hires', reorg: 'Reorganisation', terminate: 'Terminations', scope: 'Scope changes', budget: 'Budget', routing: 'Routing', tune: 'Tunables', other: 'Other actions' };
export const PLAN_GROUP_COLOR: Record<PlanGroup, string> = { hire: 'var(--green)', reorg: 'var(--blue)', terminate: 'var(--red)', scope: 'var(--amber)', budget: 'var(--accent)', routing: 'var(--blue)', tune: 'var(--text-dim)', other: 'var(--border)' };

/** Which group a captured tool call falls into, by its tool name. */
export function planGroupOf(tool: string): PlanGroup {
  const t = tool.toLowerCase();
  if (/hire/.test(t)) return 'hire';
  if (/terminat|fire|dismiss/.test(t)) return 'terminate';
  if (/reorg|reports_to|move|unit/.test(t)) return 'reorg';
  if (/scope/.test(t)) return 'scope';
  if (/budget|allocat|envelope/.test(t)) return 'budget';
  if (/rout/.test(t)) return 'routing';
  if (/tune|tunable/.test(t)) return 'tune';
  return 'other';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** A plan action in words from its tool and input — the captured call's own
 *  summary when the runtime wrote one, otherwise built from the input. */
export function humanizePlanAction(a: Pick<PlanAction, 'tool' | 'input' | 'summary'>, nameOf: (agentId: string) => string | undefined = () => undefined): string {
  if (a.summary && a.summary.trim()) return a.summary.trim();
  const i = a.input ?? {};
  const who = (k: string) => { const id = str(i[k]); return id ? nameOf(id) ?? id.slice(0, 8) : ''; };
  switch (planGroupOf(a.tool)) {
    case 'hire': return `Hire ${str(i.name) || 'a member'}${i.title ? ` as ${str(i.title)}` : ''}${i.templateOrPack || i.template || i.pack ? ` from ${str(i.templateOrPack ?? i.template ?? i.pack)}` : ''}${i.reportsToAgentId ? ` reporting to ${who('reportsToAgentId')}` : ''}`;
    case 'terminate': return `Terminate ${who('agentId') || 'a member'}${i.reason ? ` — ${str(i.reason)}` : ''}`;
    case 'reorg': return `Move ${who('agentId') || 'a member'}${i.reportsToAgentId ? ` under ${who('reportsToAgentId')}` : ''}${i.title ? ` as ${str(i.title)}` : ''}`;
    case 'scope': return `Widen ${who('agentId') || 'a member'} with ${list(i.scopes ?? i.add ?? i.widen).join(', ') || 'new scopes'}`;
    case 'budget': return i.objectiveId || i.goalId
      ? `Allocate $${Number(i.monthlyUsd ?? 0).toFixed(2)}/month to objective ${str(i.objectiveId ?? i.goalId).slice(0, 8)}${i.buys ? ` — ${str(i.buys)}` : ''}`
      : `Raise the ${str(i.scope) || 'company'} envelope${i.refId ? ` (${who('refId')})` : ''} to $${Number(i.monthlyUsd ?? 0).toFixed(2)}/month`;
    case 'routing': return `Route ${str(i.class) || 'a class'} → ${str(i.tier) || '?'}${i.model ? ` (${str(i.model)})` : ''}`;
    case 'tune': return `Tune ${str(i.key)} → ${str(i.value)}${i.why ? ` — ${str(i.why)}` : ''}`;
    default: return `${a.tool}${Object.keys(i).length ? ` ${JSON.stringify(i).slice(0, 120)}` : ''}`;
  }
}

export interface PlanRow extends PlanAction { index: number; group: PlanGroup; text: string; result: PlanActionResult | null }

/** The plan's JSON columns parsed defensively. */
export function parsePlanActions(raw: string | null | undefined): PlanAction[] {
  return safeJsonParse<unknown[]>(raw ?? '[]', []).filter((x): x is PlanAction => typeof x === 'object' && x !== null && typeof (x as PlanAction).tool === 'string')
    .map((a) => ({ tool: a.tool, input: (a.input ?? {}) as Record<string, unknown>, estimateUsd: Number(a.estimateUsd ?? 0) || 0, summary: str(a.summary) }));
}
export function parsePlanResults(raw: string | null | undefined): PlanActionResult[] {
  return safeJsonParse<unknown[]>(raw ?? '[]', []).filter((x): x is PlanActionResult => typeof x === 'object' && x !== null && typeof (x as PlanActionResult).tool === 'string')
    .map((r) => ({ tool: r.tool, summary: str(r.summary), ok: Boolean(r.ok), output: str(r.output) }));
}

/** Actions grouped for the diff view, in a fixed order, with their results
 *  (applied plans record one row per action until the one that failed). */
export function groupPlanActions(actions: PlanAction[], results: PlanActionResult[] = [], nameOf?: (id: string) => string | undefined): Array<{ group: PlanGroup; rows: PlanRow[]; estimateUsd: number }> {
  const rows: PlanRow[] = actions.map((a, index) => ({ ...a, index, group: planGroupOf(a.tool), text: humanizePlanAction(a, nameOf), result: results[index] ?? null }));
  return PLAN_GROUP_ORDER.map((group) => { const g = rows.filter((r) => r.group === group); return { group, rows: g, estimateUsd: g.reduce((n, r) => n + (r.estimateUsd || 0), 0) }; }).filter((g) => g.rows.length > 0);
}

/** Where an applied plan stopped: the index of the first refused action, or null when every action applied (or none ran). */
export function planStoppedAt(results: PlanActionResult[]): number | null {
  const i = results.findIndex((r) => !r.ok);
  return i === -1 ? null : i;
}

export const PLAN_STATUS_COLOR: Record<PlanStatus, string> = { pending: 'var(--amber)', applied: 'var(--green)', vetoed: 'var(--red)', expired: 'var(--text-faint)', dry_run: 'var(--blue)' };
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = { pending: 'awaiting your veto', applied: 'applied', vetoed: 'vetoed', expired: 'expired', dry_run: 'dry run' };

/** "applies in 12m", "applies in 1h 05m", "applying now" — the veto window. */
export function countdownLabel(applyAt: string | null | undefined, now = new Date()): string {
  if (!applyAt) return 'no window';
  const ms = Date.parse(applyAt) - now.getTime();
  if (!Number.isFinite(ms)) return 'no window';
  if (ms <= 0) return 'applying now';
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `applies in ${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `applies in ${h}h${rest ? ` ${String(rest).padStart(2, '0')}m` : ''}`;
}

/** The plan's trigger in words. */
export function planTriggerLabel(trigger: string): string {
  const T: Record<string, string> = { vision: 'the vision changed', objective_assigned: 'an objective was assigned', at_risk: 'a key result went at risk', manual: 'asked for by the CEO', sprint: 'the sprint planning', board: 'a board event', daily: 'the daily review', dry_run: 'a dry run', review: 'the structure review' };
  return T[trigger] ?? trigger.replace(/_/g, ' ');
}

export function planIsPending(p: Pick<OrgPlan, 'status'>): boolean { return p.status === 'pending'; }

// ---- citations (§6) ----

export const CITATION_RE = /\[(task|decision|goal|meeting|audit):([A-Za-z0-9_-]+)\]/g;

/** Every `[kind:id]` in an answer, deduplicated in order of appearance. */
export function parseCitations(text: string): Array<{ kind: CitationKind; id: string }> {
  const seen = new Set<string>();
  const out: Array<{ kind: CitationKind; id: string }> = [];
  for (const m of text.matchAll(CITATION_RE)) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: m[1] as CitationKind, id: m[2] });
  }
  return out;
}

/** The answer with `[kind:id]` turned into the `#kind:id` chips the Markdown
 *  renderer draws; verified citations keep their title for the chip label. */
export function citationsToChips(text: string): string {
  return text.replace(CITATION_RE, '#$1:$2');
}

/** The label of a citation chip: the verified title, else the kind and a short id. */
export function citationLabel(kind: CitationKind, id: string, citations: Citation[]): string {
  const c = citations.find((x) => x.kind === kind && (x.id === id || (id.length >= 6 && x.id.startsWith(id))));
  if (c?.title) return c.title.length > 48 ? `${c.title.slice(0, 47)}…` : c.title;
  return kind === 'audit' ? `audit #${id}` : `${kind} ${id.slice(0, 8)}`;
}

export const ASK_STATUS_COPY: Record<'answered' | 'budget_stop' | 'busy' | 'failed', string> = {
  answered: 'answered', budget_stop: 'stopped at the ask budget (memory.askUsdCap) — the recall pack below is what the chief would have read', busy: 'the chief is busy; try again in a moment', failed: 'the chief could not answer',
};

// ---- replay (§8) ----

export const REPLAY_KIND_LABEL: Record<ReplayKind, string> = { woke: 'woke', ran: 'ran', decided: 'decided', signal: 'signal', plan: 'plan', spend: 'spend', change: 'change' };
export const REPLAY_KIND_COLOR: Record<ReplayKind, string> = { woke: 'var(--blue)', ran: 'var(--green)', decided: 'var(--accent)', signal: 'var(--amber)', plan: 'var(--accent-hi)', spend: 'var(--text-dim)', change: 'var(--text-faint)' };

/** Entries by hour (local time), earliest first, each hour's USD summed. */
export function groupReplayByHour(entries: ReplayEntry[]): Array<{ hour: string; rows: ReplayEntry[]; usd: number }> {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at) || (a.seq ?? 0) - (b.seq ?? 0));
  const map = new Map<string, ReplayEntry[]>();
  for (const e of sorted) {
    const d = new Date(e.at);
    const hour = Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:00` : '—';
    map.set(hour, [...(map.get(hour) ?? []), e]);
  }
  return [...map.entries()].map(([hour, rows]) => ({ hour, rows, usd: rows.reduce((n, r) => n + (r.usd ?? 0), 0) }));
}

/** Today's `YYYY-MM-DD` in local time, and the day shifted by `delta`. */
export function dayKey(d = new Date()): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + delta));
}

// ---- costs and forecast (§7) ----

export interface CostRow { goalId: string; title: string; status: string; spentUsd: number; sharePct: number; envelopeUsd: number; envelopePct: number | null; envelopeSource: ObjectiveCost['envelopeSource']; progressPct: number; measuredPct: number | null; overspend: boolean; buys: string; color: string; note: string }

/** One row of the cost-per-outcome table: share of spend, envelope use,
 *  measured progress and the overspend flag (spend share ahead of progress by
 *  more than the margin), with the colour and the sentence behind the flag. */
export function costRows(report: Pick<CostReport, 'objectives' | 'margin'>): CostRow[] {
  return report.objectives.map((o) => {
    const sharePct = Math.round(o.shareOfSpend * 100);
    const progressPct = Math.round(o.progress * 100);
    const measuredPct = o.keyResults.measuredPct === null ? null : Math.round(o.keyResults.measuredPct);
    const envelopePct = o.envelopePct === null ? null : Math.round(o.envelopePct);
    const color = o.overspend ? 'var(--red)' : envelopePct !== null && envelopePct >= 80 ? 'var(--amber)' : 'var(--green)';
    const note = o.overspend
      ? `${sharePct}% of spend for ${progressPct}% progress — more than the ${Math.round(report.margin * 100)}-point margin allows`
      : envelopePct !== null && envelopePct >= 100 ? 'the envelope is spent' : envelopePct !== null && envelopePct >= 80 ? 'near its envelope' : 'in proportion';
    return { goalId: o.goalId, title: o.title, status: o.status, spentUsd: o.spentUsd, sharePct, envelopeUsd: o.envelopeUsd, envelopePct, envelopeSource: o.envelopeSource, progressPct, measuredPct, overspend: o.overspend, buys: o.allocation?.buys ?? '', color, note };
  }).sort((a, b) => Number(b.overspend) - Number(a.overspend) || b.spentUsd - a.spentUsd);
}

/** Spend by class as sorted rows with their share. */
export function classRows(byClass: Record<string, number>): Array<{ cls: string; usd: number; pct: number }> {
  const total = Object.values(byClass).reduce((n, v) => n + v, 0);
  return Object.entries(byClass).map(([cls, usd]) => ({ cls, usd, pct: total > 0 ? Math.round((usd / total) * 100) : 0 })).sort((a, b) => b.usd - a.usd);
}

export const FORECAST_LABEL: Record<ForecastState, string> = { onTrack: 'on track', warn: 'will warn', stop: 'will stop' };
export const FORECAST_COLOR: Record<ForecastState, string> = { onTrack: 'var(--green)', warn: 'var(--amber)', stop: 'var(--red)' };

/** "on track · $12.40 of $50.00 projected (25%)" for an envelope. */
export function forecastLine(f: EnvelopeForecast): string {
  const cap = f.capUsd > 0 ? ` of $${f.capUsd.toFixed(2)}` : ' (no cap)';
  const pct = f.projectedPct === null ? '' : ` (${Math.round(f.projectedPct)}%)`;
  return `${FORECAST_LABEL[f.state]} · $${f.projectedUsd.toFixed(2)}${cap} projected${pct} · $${f.dailyBurnUsd.toFixed(2)}/day`;
}

/** Every envelope of a forecast, worst state first. */
export function forecastRows(f: { company: EnvelopeForecast; agents: EnvelopeForecast[]; projects: EnvelopeForecast[]; objectives: EnvelopeForecast[] }): EnvelopeForecast[] {
  const rank: Record<ForecastState, number> = { stop: 0, warn: 1, onTrack: 2 };
  return [f.company, ...f.objectives, ...f.projects, ...f.agents].sort((a, b) => rank[a.state] - rank[b.state] || (b.projectedPct ?? 0) - (a.projectedPct ?? 0));
}

// ---- routing (§7) ----

/** The strong tier per provider family when the CEO pinned none — a mirror of the server table (org-routing.ts). */
const STRONG_MODELS: Array<[RegExp, string]> = [[/^anthropic$/, 'claude-opus-4-5'], [/openai/, 'gpt-5.1'], [/deepseek/, 'deepseek-reasoner'], [/google|gemini/, 'gemini-2.5-pro']];

export const TIER_LABEL: Record<ModelTier, string> = { cheap: 'cheap', standard: 'standard', strong: 'strong' };
export const TIER_HINT: Record<ModelTier, string> = { cheap: "the provider's cheapest model", standard: "the agent's own model", strong: "the provider's strong model" };

/** The model a tier resolves to for the chief's provider: the pinned model
 *  wins; `standard` is the agent's own; `strong` the provider table; `cheap`
 *  is resolved server-side from the price list, so it reads as such. */
export function tierModelLabel(routing: OrgRouting, tier: ModelTier, agent: { provider: string; model: string } | null): { model: string; pinned: boolean } {
  const pinned = routing.models[tier];
  if (pinned) return { model: pinned, pinned: true };
  if (!agent) return { model: TIER_HINT[tier], pinned: false };
  if (tier === 'standard') return { model: agent.model || TIER_HINT.standard, pinned: false };
  if (tier === 'strong') return { model: STRONG_MODELS.find(([re]) => re.test(agent.provider))?.[1] ?? (agent.model || TIER_HINT.strong), pinned: false };
  return { model: `cheapest ${agent.provider} model`, pinned: false };
}

/** The routing table rows: the six named classes plus any other the org routes. */
export function routingRows(routing: OrgRouting, classes: readonly string[]): Array<{ cls: string; tier: ModelTier | null }> {
  const all = [...classes, ...Object.keys(routing.classes).filter((c) => !classes.includes(c))];
  return all.map((cls) => ({ cls, tier: routing.classes[cls] ?? null }));
}

// ---- blueprints (§9) ----

/** The one-paragraph summary of an import plan the confirm step shows. */
export function blueprintPlanSummary(p: BlueprintImportPlan): string {
  const parts = [
    `${p.hires.length} hire${p.hires.length === 1 ? '' : 's'} under a ${p.chief.title || 'chief of staff'}`,
    p.units.length ? `${p.units.length} unit${p.units.length === 1 ? '' : 's'}` : '',
    `$${p.budget.monthlyUsd.toFixed(2)}/month${p.budget.allocated > 0 ? ` ($${p.budget.allocated.toFixed(2)} allocated to objectives)` : ''}`,
    p.playbooks.length ? `${p.playbooks.length} playbook${p.playbooks.length === 1 ? '' : 's'} as drafts` : '',
    p.tunables.length ? `${p.tunables.length} tunable${p.tunables.length === 1 ? '' : 's'}` : '',
    p.vision ? `the vision "${p.vision.title}"` : '',
  ].filter(Boolean);
  const dropped = p.hires.reduce((n, h) => n + h.dropped.length, 0) + p.chief.dropped.length;
  const tail = p.approval === 'blueprint' ? 'The hires wait on one approval card.' : 'The hires are made at once.';
  return `${parts.join(', ')}. ${dropped ? `${dropped} requested scope${dropped === 1 ? '' : 's'} dropped (outside what the chief holds). ` : ''}${tail}`;
}

/** Hires of an import plan grouped by role id (or title for template hires). */
export function hiresByRole(hires: BlueprintImportPlan['hires']): Array<{ role: string; rows: BlueprintImportPlan['hires'] }> {
  const map = new Map<string, BlueprintImportPlan['hires']>();
  for (const h of hires) { const k = h.roleId ?? h.title; map.set(k, [...(map.get(k) ?? []), h]); }
  return [...map.entries()].map(([role, rows]) => ({ role, rows }));
}

/** A COMPANY.json file name for the download. */
export function blueprintFileName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${slug || 'company'}.COMPANY.json`;
}

// ---- the graph (§6) ----

export const GRAPH_KIND_LABEL: Record<string, string> = { goal: 'Goals', task: 'Tasks', decision: 'Decisions', meeting: 'Meetings', signal: 'Signals', approval: 'Approvals', agent: 'Members', member: 'Members', unit: 'Units', playbook: 'Playbooks', project: 'Projects', audit: 'Audit rows', human: 'People' };
const GRAPH_ORDER = ['goal', 'task', 'decision', 'meeting', 'signal', 'approval', 'playbook', 'project', 'agent', 'member', 'unit', 'human', 'audit'];

/** Neighbours of the root grouped by kind, each with the relation that links
 *  it (nodes two hops away carry the hop they came through); the root itself left out. */
export function groupGraph(g: OrgGraph): Array<{ kind: string; label: string; rows: Array<GraphNode & { rel: string; hops: number }> }> {
  const byKey = new Map(g.nodes.map((n) => [n.key, n]));
  const hops = new Map<string, number>([[g.root, 0]]);
  const rel = new Map<string, string>();
  let frontier = [g.root];
  for (let d = 1; d <= Math.max(1, g.depth) && frontier.length; d++) {
    const next: string[] = [];
    for (const k of frontier) for (const e of g.edges) {
      const other = e.from === k ? e.to : e.to === k ? e.from : null;
      if (!other || hops.has(other)) continue;
      hops.set(other, d); rel.set(other, e.rel); next.push(other);
    }
    frontier = next;
  }
  const rows = g.nodes.filter((n) => n.key !== g.root).map((n) => ({ ...n, rel: rel.get(n.key) ?? '', hops: hops.get(n.key) ?? g.depth }));
  const kinds = [...new Set(rows.map((r) => r.kind))].sort((a, b) => (GRAPH_ORDER.indexOf(a) === -1 ? 99 : GRAPH_ORDER.indexOf(a)) - (GRAPH_ORDER.indexOf(b) === -1 ? 99 : GRAPH_ORDER.indexOf(b)));
  return kinds.map((kind) => ({ kind, label: GRAPH_KIND_LABEL[kind] ?? `${kind}s`, rows: rows.filter((r) => r.kind === kind).sort((a, b) => a.hops - b.hops || a.title.localeCompare(b.title)) })).filter((k) => byKey.size > 0 && k.rows.length > 0);
}

// ---- lessons (§6) ----

export const AUDIENCE_LABEL: Record<LessonAudience, string> = { member: 'for the member', unit: 'for the unit', company: 'for everyone' };
export const AUDIENCE_COLOR: Record<LessonAudience, string> = { member: 'var(--text-dim)', unit: 'var(--blue)', company: 'var(--accent)' };
export function audienceLabel(a: string): string { return AUDIENCE_LABEL[a as LessonAudience] ?? a; }

// ---- playbooks (§6) ----

export const PLAYBOOK_STATUS_COLOR: Record<string, string> = { draft: 'var(--text-faint)', in_review: 'var(--amber)', active: 'var(--green)', retired: 'var(--text-faint)' };

/** "3 uses · 67% success" from the outcomes JSON. */
export function playbookOutcomeLine(raw: string | null | undefined): string {
  const o = safeJsonParse<Partial<{ uses: number; up: number; down: number; successRate: number | null }>>(raw ?? '{}', {});
  const uses = o.uses ?? 0;
  if (!uses) return 'not used yet';
  const rate = typeof o.successRate === 'number' ? ` · ${Math.round(o.successRate * 100)}% success` : '';
  return `${uses} use${uses === 1 ? '' : 's'}${rate}`;
}

/** The roles a playbook is offered to, '' meaning everyone. */
export function playbookRoles(raw: string | null | undefined): string[] {
  const r = safeJsonParse<unknown[]>(raw ?? '[]', []).map(String).filter(Boolean);
  return r.length ? r : ['everyone'];
}
