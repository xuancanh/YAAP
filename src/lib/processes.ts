/** Processes on screen (docs/processes.md), the pure half: words and tones
 *  for health, run and step states, the strict graph laid out in columns
 *  (each step one column right of the steps it waits on; loop edges drawn
 *  as "back to"), a dynamic step's availability as a sentence, trigger
 *  words and the author of a version. The page is OrgProcessesView.tsx. */
import type { OrgProcess, ProcessDef, ProcessMetrics, ProcessNodeDef, ProcessTriggerDef } from './api';
import type { Tone } from './direction';

export const HEALTH_WORD: Record<ProcessMetrics['health'], string> = { new: 'No runs yet', healthy: 'Healthy', watch: 'Watch', revise: 'Needs revising' };
export const HEALTH_TONE: Record<ProcessMetrics['health'], Tone> = { new: 'muted', healthy: 'ok', watch: 'warn', revise: 'bad' };
export const MODE_WORD: Record<string, string> = { strict: 'Strict', dynamic: 'Dynamic', mixed: 'Mixed' };
export const MODE_HINT: Record<string, string> = {
  strict: 'The engine decides the next step from the graph.',
  dynamic: 'The performer chooses which available step comes next.',
  mixed: 'Some stages follow the graph; in others the performer chooses.',
};

export function runTone(status: string): Tone {
  return status === 'done' ? 'ok' : status === 'failed' ? 'bad' : status === 'blocked' ? 'warn' : status === 'cancelled' ? 'muted' : 'info';
}
export function stepTone(status: string, current = 1): Tone {
  if (!current) return 'muted';
  return status === 'done' ? 'ok' : status === 'failed' ? 'bad' : status === 'skipped' || status === 'cancelled' ? 'muted' : 'info';
}

export const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
export const hrs = (v: number | null): string => (v === null ? '—' : v < 1 ? `${Math.round(v * 60)}m` : v < 48 ? `${v.toFixed(1)}h` : `${(v / 24).toFixed(1)}d`);

export function triggerWords(ts: ProcessTriggerDef[]): string {
  const out = ts.map((t) => {
    const off = 'enabled' in t && t.enabled === false ? ' (off)' : '';
    if (t.kind === 'cadence') return `on a schedule (${t.cron})${off}`;
    if (t.kind === 'event') return `when ${t.event === 'incident_opened' ? `an incident opens${t.severity ? ` (${t.severity} or worse)` : ''}` : t.event === 'project_now' ? 'a project moves to Now' : t.event === 'task_created' ? `a ${t.class ?? ''} task is created` : t.event.replace(/_/g, ' ')}${off}`;
    if (t.kind === 'service_request') return `on a service request${off}`;
    return 'by hand';
  });
  return [...new Set(out)].join(' · ') || 'by hand';
}

/** Who wrote a version, in words. */
export function authorWords(author: string, nameOf: (agentId: string) => string | undefined): string {
  if (author.startsWith('agent:')) return nameOf(author.slice(6)) ?? 'an agent';
  if (author.startsWith('approval:')) return 'an approved card';
  if (author === 'system') return 'the template library';
  if (author === 'chief') return 'the chief of staff';
  return 'a person';
}

/** Edges that close a loop (the same DFS the engine uses). */
export function loopEdges(def: ProcessDef, stageId: string): Array<{ from: string; to: string }> {
  const ids = new Set(def.nodes.filter((n) => (n.stage ?? def.stages[0]?.id) === stageId).map((n) => n.id));
  const edges = def.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const out: Array<{ from: string; to: string }> = [];
  const state = new Map<string, number>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of edges.filter((x) => x.from === id)) {
      const st = state.get(e.to) ?? 0;
      if (st === 1) out.push({ from: e.from, to: e.to });
      else if (st === 0) visit(e.to);
    }
    state.set(id, 2);
  };
  const order = [...ids];
  const incoming = new Set(edges.map((e) => e.to));
  for (const id of [...order.filter((x) => !incoming.has(x)), ...order]) if (!state.get(id)) visit(id);
  return out;
}

/** A strict stage in columns: each step one column right of the latest step it waits on. */
export function layoutStage(def: ProcessDef, stageId: string): ProcessNodeDef[][] {
  const nodes = def.nodes.filter((n) => (n.stage ?? def.stages[0]?.id) === stageId);
  const back = loopEdges(def, stageId);
  const fwd = def.edges.filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to) && !back.some((b) => b.from === e.from && b.to === e.to));
  const level = new Map<string, number>();
  const depth = (id: string, seen: Set<string> = new Set()): number => {
    if (level.has(id)) return level.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const ins = fwd.filter((e) => e.to === id);
    const d = ins.length ? Math.max(...ins.map((e) => depth(e.from, seen) + 1)) : 0;
    level.set(id, d);
    return d;
  };
  for (const n of nodes) depth(n.id);
  const cols: ProcessNodeDef[][] = [];
  for (const n of nodes) { const d = level.get(n.id) ?? 0; (cols[d] ??= []).push(n); }
  return cols.filter(Boolean);
}

/** What a strict step waits on and where it leads, in words. */
export function edgeWords(def: ProcessDef, nodeId: string): { after: string[]; next: string[]; loops: string[] } {
  const title = (id: string) => def.nodes.find((n) => n.id === id)?.title ?? id;
  const stage = def.nodes.find((n) => n.id === nodeId)?.stage ?? def.stages[0]?.id ?? '';
  const back = loopEdges(def, stage);
  const isBack = (e: { from: string; to: string }) => back.some((b) => b.from === e.from && b.to === e.to);
  return {
    after: def.edges.filter((e) => e.to === nodeId && !isBack(e)).map((e) => `${title(e.from)}${e.when ? ` (when ${e.when})` : ''}`),
    next: def.edges.filter((e) => e.from === nodeId && !isBack(e)).map((e) => `${title(e.to)}${e.when ? ` (when ${e.when})` : ''}`),
    loops: def.edges.filter((e) => e.from === nodeId && isBack(e)).map((e) => `back to ${title(e.to)}${e.when ? ` when ${e.when}` : ''}, at most ${e.loopMax ?? '?'}×`),
  };
}

/** A dynamic step's availability as a sentence. */
export function availabilityWords(def: ProcessDef, n: ProcessNodeDef): string {
  const title = (id: string) => def.nodes.find((x) => x.id === id)?.title ?? id;
  const a = n.availableWhen ?? {};
  const parts = [
    ...(a.after ?? []).map((x) => `"${title(x)}" is done`),
    ...(a.vars ?? []).map((v) => `${v} is known`),
    ...Object.entries(a.equals ?? {}).map(([k, v]) => `${k} is ${v}`),
  ];
  return parts.length ? `Available when ${parts.join(' and ')}` : 'Available from the start of the stage';
}

export const KIND_WORD: Record<string, string> = { task: 'Task', approval: 'Approval', wait: 'Wait', subprocess: 'Sub-process', stage: 'Stage' };

/** The list's summary figures. */
export function processSummary(list: OrgProcess[]): { active: number; open: number; revise: number; due: number } {
  const live = list.filter((p) => p.status === 'active');
  return { active: live.length, open: live.reduce((n, p) => n + p.metrics.active, 0), revise: live.filter((p) => p.metrics.health === 'revise').length, due: live.filter((p) => p.reviewDue).length };
}
