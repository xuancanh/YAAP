/** Processes on screen (docs/processes.md), the pure half: words and tones
 *  for health, run and step states, the strict graph laid out in columns
 *  (each step one column right of the steps it waits on; loop edges drawn
 *  as "back to"), a dynamic step's availability as a sentence, trigger
 *  words and the author of a version; a meeting step and the compensations
 *  in words, a ramp's comparison as rows, conformance and suggestion words.
 *  The page is OrgProcessesView.tsx. */
import type { OrgProcess, ProcessConformance, ProcessDef, ProcessMetrics, ProcessNodeDef, ProcessRollout, ProcessSuggestion, ProcessTriggerDef } from './api';
import type { Tone } from './direction';
import { humanCron } from './org';

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
    if (t.kind === 'cadence') { const h = humanCron(t.cron); return `${h === t.cron ? `on a schedule (${t.cron})` : h}${off}`; }
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

/** The steps a stage walks (compensation steps stand outside every stage). */
export const stageNodes = (def: ProcessDef, stageId: string): ProcessNodeDef[] => def.nodes.filter((n) => !n.compensation && (n.stage ?? def.stages[0]?.id) === stageId);

/** Edges that close a loop (the same DFS the engine uses). */
export function loopEdges(def: ProcessDef, stageId: string): Array<{ from: string; to: string }> {
  const ids = new Set(stageNodes(def, stageId).map((n) => n.id));
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
  const nodes = stageNodes(def, stageId);
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

export const KIND_WORD: Record<string, string> = { task: 'Task', approval: 'Approval', wait: 'Wait', subprocess: 'Sub-process', stage: 'Stage', meeting: 'Meeting', compensation: 'Undo' };

const MEETING_KIND_WORD: Record<string, string> = { planning: 'planning meeting', standup: 'standup', weekly_review: 'weekly review', retro: 'retro', board: 'board meeting', adhoc: 'meeting' };
const laneWord = (l: string) => (l === 'unit' ? 'the department' : l === 'owner' ? 'the owner' : l === 'chief' ? 'the chief' : l === 'head' ? 'the head' : l === 'initiator' ? 'the initiator' : l);

/** A meeting step in words: what it holds and who comes. */
export function meetingWords(n: ProcessNodeDef): string {
  const who = (n.attendees?.length ? n.attendees : ['unit']).map(laneWord);
  return `holds a ${MEETING_KIND_WORD[n.meetingKind ?? 'adhoc'] ?? 'meeting'} with ${who.join(', ')}`;
}

/** The compensation steps and the steps each undoes, for "if a run fails". */
export function compensationsOf(def: ProcessDef): Array<{ comp: ProcessNodeDef; undoes: ProcessNodeDef[] }> {
  return def.nodes.filter((n) => n.compensation).map((comp) => ({ comp, undoes: def.nodes.filter((x) => x.compensate === comp.id) }));
}

export const RAMP_WORD: Record<ProcessRollout['verdict'], string> = { collecting: 'Collecting runs', promote: 'Ready to promote', rollback: 'Worse — roll back' };
export const RAMP_TONE: Record<ProcessRollout['verdict'], Tone> = { collecting: 'info', promote: 'ok', rollback: 'bad' };
export const CONFORMANCE_WORD: Record<ProcessConformance['verdict'], string> = { new: 'Too few runs', conforms: 'Followed', drifting: 'Drifting' };
export const CONFORMANCE_TONE: Record<ProcessConformance['verdict'], Tone> = { new: 'muted', conforms: 'ok', drifting: 'warn' };
export const SUGGESTION_WORD: Record<ProcessSuggestion['kind'], string> = { recurring: 'Recurring work', sequence: 'Repeated sequence', cross_function: 'Repeated requests', adhoc_step: 'Missing step', revise: 'Revise a step' };

/** A ramp's comparison as rows: the measure, both values in words, and whether the candidate is worse. */
export function cohortRows(r: ProcessRollout): Array<{ label: string; stable: string; candidate: string; worse: boolean }> {
  const label: Record<ProcessRollout['rows'][number]['metric'], string> = { completion: 'Completed', cycle: 'Cycle time (median)', deviation: 'Steps deviated', rework: 'Rework' };
  return r.rows.map((x) => ({ label: label[x.metric], stable: x.metric === 'cycle' ? hrs(x.stable) : pct(x.stable), candidate: x.metric === 'cycle' ? hrs(x.candidate) : pct(x.candidate), worse: x.worse }));
}

/** The list's summary figures. */
export function processSummary(list: OrgProcess[]): { active: number; open: number; revise: number; due: number } {
  const live = list.filter((p) => p.status === 'active');
  return { active: live.length, open: live.reduce((n, p) => n + p.metrics.active, 0), revise: live.filter((p) => p.metrics.health === 'revise').length, due: live.filter((p) => p.reviewDue).length };
}

// ---- the graph on screen: lanes, conditions, a run laid over it ----

/** A lane (a role, never an agent) as a heading: "Owner", "Chief of staff", a member title. */
export function laneTitle(lane: string): string {
  const w: Record<string, string> = { owner: 'Owner', chief: 'Chief of staff', head: 'Head', initiator: 'Requester', provider: 'Provider', unit: 'The department', manager: "Owner's manager", ceo: 'CEO', engine: 'Automatic' };
  return w[lane] ?? lane.charAt(0).toUpperCase() + lane.slice(1);
}

/** Which lane a step sits in: approvals with their approver, timers and sub-processes with the engine. */
export function laneOf(n: ProcessNodeDef): string {
  if (n.kind === 'approval') return n.approver === 'ceo' ? 'ceo' : 'manager';
  if (n.kind === 'wait' || n.kind === 'subprocess') return 'engine';
  return n.lane ?? 'owner';
}

/** An edge condition in words: `verdict == revise` → "if verdict is revise". */
export function conditionWords(when: string | undefined): string {
  if (!when) return '';
  const v = (s: string) => s.trim().replace(/_/g, ' ');
  const m = /^\s*([\w.]+)\s*(==|!=)\s*(.+)$/.exec(when);
  if (m) return `if ${v(m[1])} ${m[2] === '==' ? 'is' : 'is not'} ${v(m[3])}`;
  if (when.trim().startsWith('!')) return `unless ${v(when.trim().slice(1))}`;
  return `if ${v(when)} is set`;
}

export interface GraphEdge { from: string; to: string; label: string; loop: boolean; dotted: boolean; loopMax?: number }
export interface StageLayout { cols: ProcessNodeDef[][]; lanes: string[]; edges: GraphEdge[] }

/** A stage as a swimlane grid: columns in the engine's order (a dynamic
 *  stage by its "available after" steps), one lane per role in order of
 *  first appearance, and the edges to draw — strict edges (loops apart),
 *  availability dotted. */
export function stageLayout(def: ProcessDef, stageId: string): StageLayout {
  const stage = def.stages.find((s) => s.id === stageId);
  const nodes = stageNodes(def, stageId);
  const ids = new Set(nodes.map((n) => n.id));
  let cols: ProcessNodeDef[][];
  let edges: GraphEdge[];
  if (stage?.mode === 'dynamic') {
    const level = new Map<string, number>();
    const depth = (n: ProcessNodeDef, seen: Set<string> = new Set()): number => {
      if (level.has(n.id)) return level.get(n.id)!;
      if (seen.has(n.id)) return 0;
      seen.add(n.id);
      const ins = (n.availableWhen?.after ?? []).filter((x) => ids.has(x)).map((x) => nodes.find((y) => y.id === x)!);
      const d = ins.length ? Math.max(...ins.map((x) => depth(x, seen) + 1)) : 0;
      level.set(n.id, d);
      return d;
    };
    for (const n of nodes) depth(n);
    cols = [];
    for (const n of nodes) (cols[level.get(n.id) ?? 0] ??= []).push(n);
    cols = cols.filter(Boolean);
    edges = nodes.flatMap((n) => (n.availableWhen?.after ?? []).filter((x) => ids.has(x)).map((x) => ({ from: x, to: n.id, label: '', loop: false, dotted: true })));
  } else {
    cols = layoutStage(def, stageId);
    const back = loopEdges(def, stageId);
    edges = def.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => {
      const loop = back.some((b) => b.from === e.from && b.to === e.to);
      return { from: e.from, to: e.to, label: conditionWords(e.when), loop, dotted: false, ...(loop ? { loopMax: e.loopMax } : {}) };
    });
  }
  const lanes: string[] = [];
  for (const col of cols) for (const n of col) { const l = laneOf(n); if (!lanes.includes(l)) lanes.push(l); }
  return { cols, lanes, edges };
}

/** The `${name}` inputs a definition's text uses that no step produces (what a run is started with). */
export function varsOf(def: ProcessDef | null): string[] {
  if (!def) return [];
  const produced = new Set(def.nodes.flatMap((n) => (n.outputs ?? []).map((o) => o.name)));
  const out = new Set<string>();
  for (const m of JSON.stringify(def).matchAll(/\$\{([a-z][a-z0-9_]*)\}/gi)) if (!produced.has(m[1]) && !/^(request|request_key|requester_agent)$/.test(m[1])) out.add(m[1]);
  return [...out];
}

export type StepState = 'done' | 'active' | 'failed' | 'skipped' | 'cancelled' | 'pending';
export interface RunStepLike { nodeId: string; status: string; current: number; attempt: number }

/** A run laid over the graph: each step's latest state and how many rounds
 *  it took. A compensation (`undo:<step>`) lands on its undo step. */
export function runStates<T extends RunStepLike>(def: ProcessDef, steps: T[]): Map<string, { state: StepState; step: T; rounds: number }> {
  const out = new Map<string, { state: StepState; step: T; rounds: number }>();
  for (const s of steps) {
    let id = s.nodeId;
    if (id.startsWith('undo:')) id = def.nodes.find((n) => n.id === id.slice(5))?.compensate ?? id;
    const prev = out.get(id);
    const rounds = Math.max(prev?.rounds ?? 1, s.attempt);
    if (prev && (prev.step.attempt > s.attempt || (prev.step.attempt === s.attempt && prev.step.current && !s.current))) { prev.rounds = rounds; continue; }
    const state: StepState = (['done', 'active', 'failed', 'skipped', 'cancelled'] as string[]).includes(s.status) ? s.status as StepState : 'pending';
    out.set(id, { state, step: s, rounds });
  }
  return out;
}

/** How far a run has come: steps settled of the steps its stages walk. */
export function runProgress(def: ProcessDef | null, steps: RunStepLike[]): { done: number; total: number } {
  if (!def) return { done: 0, total: 0 };
  const walk = def.nodes.filter((n) => !n.compensation);
  const st = runStates(def, steps);
  return { done: walk.filter((n) => { const s = st.get(n.id)?.state; return s === 'done' || s === 'skipped'; }).length, total: walk.length };
}

export const STEP_STATE_WORD: Record<StepState, string> = { done: 'Done', active: 'In progress', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled', pending: 'Not reached' };
export const RUN_STATUS_WORD: Record<string, string> = { running: 'Running', blocked: 'Blocked', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

/** What a process asks of its owner or the CEO, most pressing first. */
export function processAttention(p: OrgProcess, extra: { blockedRuns?: number; suggestions?: number } = {}): Array<{ id: string; tone: Tone; title: string; why: string }> {
  const out: Array<{ id: string; tone: Tone; title: string; why: string }> = [];
  if (p.status !== 'active') return out;
  if (p.metrics.health === 'revise') out.push({ id: `${p.id}:revise`, tone: 'bad', title: 'Needs revising', why: p.metrics.why });
  if (p.rollout && p.rollout.verdict !== 'collecting') out.push({ id: `${p.id}:ramp`, tone: p.rollout.verdict === 'rollback' ? 'bad' : 'info', title: `v${p.rollout.candidateVersion} ${p.rollout.verdict === 'rollback' ? 'is worse than the stable version' : 'is ready to promote'}`, why: `It runs on ${p.rollout.percent}% of new runs while it is compared.` });
  if (p.pendingVersion) out.push({ id: `${p.id}:pending`, tone: 'warn', title: `v${p.pendingVersion} waits for approval`, why: 'It changes what runs must do; it applies once approved in the Inbox.' });
  if (extra.blockedRuns) out.push({ id: `${p.id}:blocked`, tone: 'warn', title: `${extra.blockedRuns} run${extra.blockedRuns === 1 ? '' : 's'} blocked`, why: 'A review loop ran out of rounds, or a step needs a decision.' });
  if (p.conformance?.verdict === 'drifting') out.push({ id: `${p.id}:drift`, tone: 'warn', title: 'Drifting from its definition', why: p.conformance.why });
  if (p.metrics.health === 'watch') out.push({ id: `${p.id}:watch`, tone: 'warn', title: 'Worth watching', why: p.metrics.why });
  if (extra.suggestions) out.push({ id: `${p.id}:suggest`, tone: 'info', title: 'A revision is suggested', why: 'From the deviations its runs logged.' });
  if (p.reviewDue) out.push({ id: `${p.id}:review`, tone: 'info', title: "The owner's review is due", why: 'Its runs have not been reviewed within the company\'s review cadence.' });
  return out;
}

/** The Operations dashboard's Processes card: what needs attention first,
 *  then the busiest; each with one word for its state and its open runs. */
export function processCardRows(list: OrgProcess[], runs: Array<{ processId: string; status: string }>): Array<{ p: OrgProcess; flag: string; tone: Tone; open: number }> {
  const word = (id: string): string => ({ revise: 'revise', ramp: 'ramp', pending: 'approval', blocked: 'blocked', drift: 'drifting', watch: 'watch' } as Record<string, string>)[id.slice(id.lastIndexOf(':') + 1)] ?? '';
  return list.filter((p) => p.status === 'active').map((p) => {
    const blocked = runs.filter((r) => r.processId === p.id && r.status === 'blocked').length;
    const first = processAttention(p, { blockedRuns: blocked }).find((a) => !a.id.endsWith(':review'));
    const open = runs.filter((r) => r.processId === p.id).length;
    return { p, flag: first ? word(first.id) : open ? 'running' : 'idle', tone: first ? first.tone : open ? 'info' as Tone : 'muted' as Tone, open, rank: first ? (first.tone === 'bad' ? 0 : 1) : open ? 2 : 3 };
  }).sort((a, b) => a.rank - b.rank || b.open - a.open || a.p.title.localeCompare(b.p.title)).map(({ p, flag, tone, open }) => ({ p, flag, tone, open }));
}
