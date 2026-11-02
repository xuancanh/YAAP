/** The words and the structure of the overviews (docs/mission-control.md):
 *  an agent's status sentence, what a blocker waits on, the next wake, and
 *  the org mission control's filters, hierarchy and waiting chains. Pure. */
import type { AgentOverview, BlockerInfo, HomeActivity, HomeAgentState, MissionControl, MissionNode } from './api';
import { when } from './home';

export const STATE_COLOR: Record<HomeAgentState, string> = { working: 'var(--blue)', idle: 'var(--green)', blocked: 'var(--amber)', paused: 'var(--text-faint)', error: 'var(--red)' };
export const STATE_WORD: Record<HomeAgentState, string> = { working: 'Working', idle: 'Idle', blocked: 'Blocked', paused: 'Paused', error: 'Erroring' };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "35 min", "2 h", "3 d": how long since `iso`. */
export function elapsed(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (mins < 1) return 'just started';
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} d`;
}

/** The next time the agent wakes on its own: its heartbeat or its next loop, whichever is first. */
export function nextWake(o: Pick<AgentOverview, 'heartbeat' | 'nextLoop'>): { what: string; at: string } | null {
  const hb = o.heartbeat?.enabled && o.heartbeat.nextDueAt ? { what: 'heartbeat', at: o.heartbeat.nextDueAt } : null;
  const loop = o.nextLoop ? { what: `${o.nextLoop.name} loop`, at: o.nextLoop.at } : null;
  if (hb && loop) return hb.at <= loop.at ? hb : loop;
  return hb ?? loop;
}

/** "Waiting on you", "Waiting on Writer", "Waiting on “Get the logo”", or ''. */
export function waitsOnWords(w: BlockerInfo['waitsOn']): string {
  if (w.kind === 'ceo') return 'Waiting on you';
  if (w.kind === 'agent') return `Waiting on ${w.name || 'a teammate'}`;
  if (w.kind === 'task') return `Waiting on “${w.name}”`;
  return '';
}

/**
 * The one sentence at the top of an agent's page, in three parts so the page
 * can set the subject apart: "Working on" · "Draft three newsletter issues" ·
 * "2 h in". Precedence follows the state (agent-status.ts).
 */
export function statusSentence(o: Pick<AgentOverview, 'status' | 'now' | 'blocked' | 'heartbeat' | 'nextLoop'> & { cause?: AgentOverview['cause'] }, now = new Date()): { lead: string; subject: string; tail: string } {
  const s = o.status;
  switch (s.state) {
    case 'error': {
      const loud = s.errors.find((e) => e.kind !== 'provider') ?? s.errors[0];
      return { lead: 'Erroring', subject: '', tail: o.cause?.message || loud?.message || 'the last run failed' };
    }
    case 'paused':
      return { lead: 'Paused', subject: '', tail: s.memberStatus === 'paused' ? 'nothing runs until you resume it' : 'the company is paused' };
    case 'blocked': {
      const n = Math.max(s.blockedCount, o.blocked.length, 1);
      return { lead: `Blocked on ${plural(n, 'task')}`, subject: '', tail: s.waitingOnYou > 0 ? `waiting on you for ${s.waitingOnYou}` : '' };
    }
    case 'working': {
      const since = s.doingSince ? `${elapsed(s.doingSince, now)} in` : '';
      if (o.now) return { lead: o.now.status === 'in_review' ? 'Reviewing' : 'Working on', subject: o.now.title, tail: since };
      if (s.doing.startsWith('Reviewing ')) return { lead: 'Reviewing', subject: s.doing.slice('Reviewing '.length).replace(/^"|"$/g, ''), tail: '' };
      if (s.doing) return { lead: 'Working on', subject: s.doing, tail: since };
      if (s.live) return { lead: 'Working', subject: '', tail: s.live.sessionName ? `in ${s.live.sessionName}` : 'a turn is running' };
      return { lead: 'Working', subject: '', tail: '' };
    }
    default: {
      const wake = nextWake(o);
      return { lead: 'Idle', subject: '', tail: wake ? `next ${wake.what} ${when(wake.at, now)}` : 'nothing scheduled' };
    }
  }
}

/** The sentence as plain text (tests, titles, the compact panel). */
export function statusText(o: Parameters<typeof statusSentence>[0], now = new Date()): string {
  const p = statusSentence(o, now);
  const head = p.subject ? `${p.lead} ${p.subject}` : p.lead;
  if (!p.tail) return head;
  return p.subject || p.lead.startsWith('Blocked') || p.lead === 'Working' ? `${head} · ${p.tail}` : `${head}: ${p.tail}`;
}

/** "Idle — next heartbeat in 14 min" style words for a tile's state line. */
export function nodeLine(n: Pick<MissionNode, 'state' | 'doing' | 'liveLabel' | 'waits' | 'errors' | 'memberStatus'>): string {
  if (n.state === 'error') return (n.errors.find((e) => e.kind !== 'provider') ?? n.errors[0])?.message ?? 'The last run failed';
  if (n.state === 'blocked') {
    const w = n.waits[0];
    return w ? `Blocked on “${w.title}”${waitsOnWords(w.waitsOn) ? ` · ${waitsOnWords(w.waitsOn).toLowerCase()}` : ''}` : n.doing || 'Blocked';
  }
  if (n.state === 'paused') return n.memberStatus === 'paused' ? 'Paused' : 'The company is paused';
  if (n.state === 'working') return n.liveLabel ? `${n.doing || 'Running a turn'} · ${n.liveLabel}` : n.doing || 'Running a turn';
  return 'Nothing in progress';
}

// ---- mission control ----

export type MissionOnly = 'all' | 'attention' | 'blocked' | 'error';
export interface MissionFilter { only: MissionOnly; unitId: string | null; q: string }
export const NO_FILTER: MissionFilter = { only: 'all', unitId: null, q: '' };

export interface TreeNode { node: MissionNode; children: TreeNode[] }

/** Every agent under `rootId` (itself included), following reports-to. */
export function subtreeOf(nodes: MissionNode[], rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) if (n.reportsToAgentId && out.has(n.reportsToAgentId) && !out.has(n.agentId)) { out.add(n.agentId); grew = true; }
  }
  return out;
}

/** The agents a filter keeps (matches), before ancestors are added back for context. */
export function matching(mc: Pick<MissionControl, 'nodes' | 'units'>, f: MissionFilter): Set<string> {
  const unit = f.unitId ? mc.units.find((u) => u.id === f.unitId) : null;
  const inUnit = unit && unit.parentUnitId !== null ? subtreeOf(mc.nodes, unit.leadAgentId) : null;
  const q = f.q.trim().toLowerCase();
  const out = new Set<string>();
  for (const n of mc.nodes) {
    if (inUnit && !inUnit.has(n.agentId)) continue;
    if (f.only === 'blocked' && n.state !== 'blocked') continue;
    if (f.only === 'error' && n.state !== 'error') continue;
    if (f.only === 'attention' && n.state !== 'blocked' && n.state !== 'error' && n.waitingOnYou === 0) continue;
    if (q && !`${n.name} ${n.title} ${n.doing}`.toLowerCase().includes(q)) continue;
    out.add(n.agentId);
  }
  return out;
}

/** The hierarchy (reports-to), keeping the kept agents and their managers;
 *  the chief first, then leads (with reports) before members, then by name. */
export function buildForest(nodes: MissionNode[], keep?: Set<string>): TreeNode[] {
  const byId = new Map(nodes.map((n) => [n.agentId, n]));
  let visible = new Set(nodes.map((n) => n.agentId));
  if (keep) {
    visible = new Set<string>();
    for (const id of keep) {
      let cur: string | null | undefined = id;
      const seen = new Set<string>();
      while (cur && byId.has(cur) && !seen.has(cur)) { seen.add(cur); visible.add(cur); cur = byId.get(cur)!.reportsToAgentId; }
    }
  }
  const kids = new Map<string | null, MissionNode[]>();
  for (const n of nodes) {
    if (!visible.has(n.agentId)) continue;
    const parent = n.reportsToAgentId && visible.has(n.reportsToAgentId) ? n.reportsToAgentId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), n]);
  }
  const hasReports = (id: string) => nodes.some((x) => x.reportsToAgentId === id);
  const order = (a: MissionNode, b: MissionNode) => Number(b.isChief) - Number(a.isChief) || Number(hasReports(b.agentId)) - Number(hasReports(a.agentId)) || a.name.localeCompare(b.name);
  const grow = (parent: string | null, depth: number): TreeNode[] => (depth > 40 ? [] : (kids.get(parent) ?? []).slice().sort(order).map((node) => ({ node, children: grow(node.agentId, depth + 1) })));
  return grow(null, 0);
}

/** Depth-first, for the phone list: each node with its depth. */
export function flattenForest(forest: TreeNode[], collapsed: Set<string> = new Set(), depth = 0): Array<{ node: MissionNode; depth: number; childCount: number }> {
  return forest.flatMap((t) => [
    { node: t.node, depth, childCount: t.children.length },
    ...(collapsed.has(t.node.agentId) ? [] : flattenForest(t.children, collapsed, depth + 1)),
  ]);
}

/** Who `agentId` waits on, transitively: [agentId, …, 'ceo'?]. Stops on a cycle. */
export function waitChain(edges: MissionControl['edges'], agentId: string): string[] {
  const chain = [agentId];
  let cur = agentId;
  for (let i = 0; i < 20; i++) {
    const next = edges.find((e) => e.from === cur);
    if (!next || chain.includes(next.to)) break;
    chain.push(next.to);
    if (next.to === 'ceo') break;
    cur = next.to;
  }
  return chain;
}

/** Every agent on any waiting chain that touches `agentId` (waiting on it, or it waiting on). */
export function chainHighlight(edges: MissionControl['edges'], agentId: string | null): Set<string> {
  if (!agentId) return new Set();
  const out = new Set(waitChain(edges, agentId));
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) if (out.has(e.to) && !out.has(e.from)) { out.add(e.from); grew = true; }
  }
  return out.size > 1 ? out : new Set();
}

/** "4 working, 2 blocked, 1 erroring": the non-zero states, in order of attention. */
export function totalsLine(t: MissionControl['totals']): string {
  const parts: string[] = [];
  if (t.error) parts.push(`${t.error} erroring`);
  if (t.blocked) parts.push(`${t.blocked} blocked`);
  if (t.working) parts.push(`${t.working} working`);
  if (t.idle) parts.push(`${t.idle} idle`);
  if (t.paused) parts.push(`${t.paused} paused`);
  return parts.join(', ') || 'No members yet';
}

// ---- the agent page: signals, the work list, the activity ----

export type WorkTab = 'now' | 'blocked' | 'next' | 'reviews' | 'done';
export type SignalLevel = 'ok' | 'warn' | 'bad' | 'quiet';
export interface Signal {
  id: 'doing' | 'blocked' | 'queue' | 'wip' | 'budget' | 'errors';
  label: string;
  value: string;
  note: string;
  level: SignalLevel;
  /** Where a click goes: a work tab, or the health panel. */
  target: WorkTab | 'health';
}

/** Budget: amber from 80% of the cap, red at it. WIP: amber at the limit, red over. */
export const BUDGET_WARN = 0.8;

const money = (n: number) => `$${n.toFixed(2)}`;

/** The strip under the header: a few numbers that turn amber or red when off. Pure. */
export function signals(o: Pick<AgentOverview, 'now' | 'blocked' | 'queue' | 'status' | 'health'>, now = new Date()): Signal[] {
  const out: Signal[] = [];
  const s = o.status;
  out.push({
    id: 'doing', label: 'Doing', value: o.now || s.live ? '1' : '0',
    note: s.live ? 'turn running' : o.now ? (s.doingSince ? `${elapsed(s.doingSince, now)} in` : 'on a task') : 'nothing',
    level: o.now || s.live ? 'ok' : 'quiet', target: 'now',
  });
  const onYou = o.blocked.filter((b) => b.blocker.waitsOn.kind === 'ceo').length;
  out.push({
    id: 'blocked', label: 'Blocked', value: String(o.blocked.length),
    note: onYou ? `${onYou} on you` : o.blocked.length ? 'waiting' : 'none',
    level: onYou ? 'bad' : o.blocked.length ? 'warn' : 'quiet', target: 'blocked',
  });
  out.push({ id: 'queue', label: 'Queue', value: String(o.queue.length), note: o.queue.length ? 'up next' : 'empty', level: 'quiet', target: 'next' });
  const w = o.health.wip;
  if (w) {
    out.push({
      id: 'wip', label: 'WIP', value: `${w.open}/${w.limit}`,
      note: w.open > w.limit ? `${w.open - w.limit} over limit` : w.open === w.limit ? 'at limit' : 'under limit',
      level: w.open > w.limit ? 'bad' : w.open === w.limit ? 'warn' : 'ok', target: 'now',
    });
  }
  const sp = o.health.spend;
  const cap = sp.monthCapUsd ?? 0;
  if (sp.monthUsd !== null && cap > 0) {
    const r = sp.monthUsd / cap;
    out.push({ id: 'budget', label: 'Budget', value: money(sp.monthUsd), note: `of ${money(cap)}`, level: r >= 1 ? 'bad' : r >= BUDGET_WARN ? 'warn' : 'ok', target: 'health' });
  } else if (sp.monthUsd !== null || sp.d30Usd !== null) {
    out.push({ id: 'budget', label: 'Spend', value: money(sp.monthUsd ?? sp.d30Usd ?? 0), note: sp.monthUsd !== null ? 'this month, no cap' : '30 days, no cap', level: 'quiet', target: 'health' });
  }
  const errs = o.health.errors;
  const red = errs.filter((e) => e.kind !== 'provider').length;
  out.push({ id: 'errors', label: 'Errors', value: String(errs.length), note: errs.length ? (red ? 'last 2 days' : 'provider degraded') : 'last 2 days', level: red ? 'bad' : errs.length ? 'warn' : 'ok', target: 'health' });
  return out;
}

/** The work tab the page opens on: what it is doing, else what is stuck, else what is next. */
export function defaultWorkTab(o: Pick<AgentOverview, 'now' | 'blocked' | 'queue' | 'reviews'>): WorkTab {
  if (o.now) return 'now';
  if (o.blocked.length) return 'blocked';
  if (o.queue.length) return 'next';
  if (o.reviews.length) return 'reviews';
  return 'now';
}

export type ActivityFilter = 'all' | 'runs' | 'tasks' | 'files' | 'comments';
export const ACTIVITY_FILTERS: Array<{ id: ActivityFilter; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'runs', label: 'Runs' }, { id: 'tasks', label: 'Tasks' }, { id: 'files', label: 'Files' }, { id: 'comments', label: 'Comments' },
];
/** Rows shown before "Show all". */
export const ACTIVITY_CAP = 10;

/** One timeline: its runs (routine ones collapsed), tasks moved, comments, and the files it wrote. Newest first. Pure. */
export function mergedActivity(o: Pick<AgentOverview, 'recent' | 'files' | 'agent'>): HomeActivity[] {
  const seen = new Set<string>();
  const rows: HomeActivity[] = [
    ...o.recent,
    ...o.files.map((f): HomeActivity => ({ id: `file:${f.path}`, at: f.updatedAt, kind: 'file', title: `Wrote ${f.path}`, detail: f.version > 1 ? `version ${f.version}` : '', actor: o.agent.name, ref: { type: 'file', id: f.path } })),
  ];
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).sort((a, b) => b.at.localeCompare(a.at));
}

export function activityKind(a: HomeActivity): Exclude<ActivityFilter, 'all'> {
  if (a.kind === 'file') return 'files';
  if (a.kind === 'task') return 'tasks';
  if (a.kind === 'decision') return 'comments';
  return 'runs';
}
