/** The words and the structure of the overviews (docs/mission-control.md):
 *  an agent's status sentence, what a blocker waits on, the next wake, and
 *  the org mission control's filters, hierarchy and waiting chains. Pure. */
import type { AgentOverview, BlockerInfo, HomeAgentState, MissionControl, MissionNode } from './api';
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
export function statusSentence(o: Pick<AgentOverview, 'status' | 'now' | 'blocked' | 'heartbeat' | 'nextLoop'>, now = new Date()): { lead: string; subject: string; tail: string } {
  const s = o.status;
  switch (s.state) {
    case 'error': {
      const loud = s.errors.find((e) => e.kind !== 'provider') ?? s.errors[0];
      return { lead: 'Erroring', subject: '', tail: loud ? loud.message : 'the last run failed' };
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
