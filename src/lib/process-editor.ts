/** The process editor, the pure half (docs/processes.md "The editor"): the
 *  edits the canvas makes (add a step, move it to another role or stage,
 *  connect two steps, set a link's condition or round limit, add or change
 *  a stage, delete), the canvas layout (stages stacked, a row per role,
 *  the engine's columns) and its hit test, undo/redo history, and the
 *  live check — the server's own `validateProcess` (imported from the pure
 *  model, so the editor refuses exactly what a save would) with each
 *  problem pinned to its step, link or stage in plain words.
 *  The editor is src/components/ProcessEditor.tsx. */
import type { ProcessDef, ProcessNodeDef, ProcessStepKind } from './api';
import { backEdges, normalizeProcess, parseCondition, validateProcess, type ProcessDef as ModelDef } from '../../server/src/org/process-model';
import { laneOf, laneTitle, stageLayout, stageNodes } from './processes';

export type PaletteKind = ProcessStepKind | 'undo';
export type Mode = 'strict' | 'dynamic';
/** What is selected: a step, a strict link, a dynamic "available after" link, a stage, or nothing (the process). */
export type Sel = { kind: 'node'; id: string } | { kind: 'edge'; from: string; to: string } | { kind: 'link'; from: string; to: string } | { kind: 'stage'; id: string } | null;
export interface OpResult { def: ProcessDef; note?: string; error?: string; select?: Sel }

/** Rows no person sits in: approvals sit with their approver, timers and sub-processes with the engine. */
export const PSEUDO_LANES = ['manager', 'ceo', 'engine'];
/** The roles every company has, offered first in the role menus. */
export const ROLE_LANES = ['owner', 'chief', 'head', 'initiator', 'provider'];
export const DEFAULT_LOOP_MAX = 2;

const copy = (d: ProcessDef): ProcessDef => JSON.parse(JSON.stringify(d)) as ProcessDef;
const stageOf = (def: ProcessDef, n: ProcessNodeDef): string => n.stage ?? def.stages[0]?.id ?? '';
const modeOf = (def: ProcessDef, stageId: string): Mode => (def.stages.find((s) => s.id === stageId)?.mode ?? 'strict');
const asModel = (d: ProcessDef) => d as unknown as ModelDef;

/** A new, empty process: one strict stage, started by hand. */
export function blankProcess(): ProcessDef {
  return { title: '', category: 'delivery', triggers: [{ kind: 'manual' }], stages: [{ id: 'main', title: 'Main', mode: 'strict' }], nodes: [], edges: [] };
}

/** A fresh id the model accepts (`^[a-z][a-z0-9_-]{0,31}$`), unused by any step or stage. */
export function uniqueId(def: ProcessDef, base: string): string {
  const b = (base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '') || 'step').slice(0, 24);
  const taken = new Set([...def.nodes.map((n) => n.id), ...def.stages.map((s) => s.id)]);
  if (!taken.has(b)) return b;
  for (let i = 2; ; i++) if (!taken.has(`${b}_${i}`)) return `${b}_${i}`;
}

/** Whether a role row may hold a step of this kind. */
export function laneFits(n: Pick<ProcessNodeDef, 'kind'>, lane: string): boolean {
  if (n.kind === 'approval') return lane === 'manager' || lane === 'ceo';
  if (n.kind === 'wait' || n.kind === 'subprocess') return lane === 'engine';
  return !PSEUDO_LANES.includes(lane);
}

/** The role rows the canvas shows, in order of first use, then any the author added. */
export function allLanes(def: ProcessDef, extra: string[] = []): string[] {
  const out: string[] = [];
  for (const st of def.stages) for (const col of stageLayout(def, st.id).cols) for (const n of col) { const l = laneOf(n); if (!out.includes(l)) out.push(l); }
  for (const l of extra) if (!out.includes(l)) out.push(l);
  if (!out.some((l) => !PSEUDO_LANES.includes(l))) out.unshift('owner');
  return out;
}

const KIND_TITLE: Record<PaletteKind, string> = { task: 'New step', approval: 'Approve?', wait: 'Wait', meeting: 'Meeting', subprocess: 'Run another process', undo: 'Undo step' };
const KIND_BASE: Record<PaletteKind, string> = { task: 'step', approval: 'approval', wait: 'wait', meeting: 'meeting', subprocess: 'sub', undo: 'undo' };

/** A new step of a kind, valid where it can be (an approval asks a question, a wait waits a day). */
export function newNode(def: ProcessDef, kind: PaletteKind, at: { stage: string; lane?: string }, title?: string): ProcessNodeDef {
  const id = uniqueId(def, KIND_BASE[kind]);
  const lane = at.lane && !PSEUDO_LANES.includes(at.lane) ? at.lane : undefined;
  const base = { id, title: title ?? KIND_TITLE[kind], stage: at.stage };
  switch (kind) {
    case 'approval': return { ...base, kind: 'approval', approver: at.lane === 'ceo' ? 'ceo' : 'manager', question: 'Go ahead?' };
    case 'wait': return { ...base, kind: 'wait', waitHours: 24 };
    case 'subprocess': return { ...base, kind: 'subprocess' };
    case 'meeting': return { ...base, kind: 'meeting', meetingKind: 'adhoc', attendees: ['unit'], ...(lane ? { lane } : {}) };
    case 'undo': return { ...base, kind: 'task', compensation: true, stage: def.stages[0]?.id, ...(lane ? { lane } : {}) };
    default: return { ...base, kind: 'task', lane: lane ?? 'owner' };
  }
}

/** Index to insert a step at the end of a stage (after its last step), or at the very end. */
function endOfStage(def: ProcessDef, stage: string): number {
  let at = -1;
  def.nodes.forEach((n, i) => { if (!n.compensation && stageOf(def, n) === stage) at = i; });
  if (at >= 0) return at + 1;
  const si = def.stages.findIndex((s) => s.id === stage);
  let before = def.nodes.length;
  def.nodes.forEach((n, i) => { if (before === def.nodes.length && (n.compensation || def.stages.findIndex((s) => s.id === stageOf(def, n)) > si)) before = i; });
  return before;
}

/**
 * Add a step from the palette. Dropped on a step (`after`), it comes next:
 * linked after it (a strict stage; it takes over a lone unconditional link
 * onward, so A→B becomes A→new→B) or available after it (a dynamic stage).
 * An undo step joins "If a run fails" and, given `undoFor`, undoes that step.
 */
export function addNode(def0: ProcessDef, kind: PaletteKind, at: { stage: string; lane?: string; after?: string; undoFor?: string }): OpResult {
  const def = copy(def0);
  if (kind === 'undo') {
    const target = at.undoFor ? def.nodes.find((n) => n.id === at.undoFor && !n.compensation) : undefined;
    const n = newNode(def, 'undo', { stage: def.stages[0]?.id ?? 'main', lane: target?.lane }, target ? `Undo: ${target.title}` : undefined);
    def.nodes.push(n);
    if (target) target.compensate = n.id;
    return { def, select: { kind: 'node', id: n.id }, ...(target ? {} : { note: 'Pick the step it undoes in the inspector.' }) };
  }
  const after = at.after ? def.nodes.find((n) => n.id === at.after && !n.compensation) : undefined;
  const stage = after ? stageOf(def, after) : at.stage;
  const lane = at.lane ?? (after && !PSEUDO_LANES.includes(laneOf(after)) ? laneOf(after) : undefined);
  const n = newNode(def, kind, { stage, lane });
  const idx = after ? def.nodes.indexOf(after) + 1 : endOfStage(def, stage);
  def.nodes.splice(idx, 0, n);
  if (after) {
    if (modeOf(def, stage) === 'dynamic') n.availableWhen = { after: [after.id] };
    else {
      const loops = backEdges(asModel(def), stage);
      const onward = def.edges.filter((e) => e.from === after.id && !loops.some((b) => b.from === e.from && b.to === e.to));
      if (onward.length === 1 && !onward[0].when) onward[0].from = n.id;
      def.edges.push({ from: after.id, to: n.id });
    }
  }
  return { def, select: { kind: 'node', id: n.id } };
}

/** Drop the links that would cross stages after `id` moved, and its availability on steps elsewhere. */
function unlinkAcrossStages(def: ProcessDef, id: string): number {
  const n = def.nodes.find((x) => x.id === id)!;
  const st = stageOf(def, n);
  const before = def.edges.length;
  def.edges = def.edges.filter((e) => {
    if (e.from !== id && e.to !== id) return true;
    const other = def.nodes.find((x) => x.id === (e.from === id ? e.to : e.from));
    return !!other && stageOf(def, other) === st;
  });
  let dropped = before - def.edges.length;
  for (const x of def.nodes) {
    const a = x.availableWhen?.after;
    if (!a?.length) continue;
    const keep = x.id === id ? a.filter((y) => { const o = def.nodes.find((z) => z.id === y); return !!o && stageOf(def, o) === st; }) : stageOf(def, x) !== st ? a.filter((y) => y !== id) : a;
    if (keep.length !== a.length) { dropped += a.length - keep.length; setAfter(x, keep); }
  }
  return dropped;
}

function setAfter(n: ProcessNodeDef, after: string[]) {
  const a = { ...(n.availableWhen ?? {}) };
  if (after.length) a.after = after; else delete a.after;
  if (Object.keys(a).length) n.availableWhen = a; else delete n.availableWhen;
}

/**
 * Move a step to a stage and a role row; dropped on another step
 * (`before`), it goes just before it in that step's row. Links that would
 * cross stages are removed (stages run in order). A row that cannot hold the
 * step (a task in the approvers' row) keeps its role and only moves stage.
 */
export function moveNode(def0: ProcessDef, id: string, to: { stage?: string; lane?: string; before?: string }): OpResult {
  const def = copy(def0);
  const n = def.nodes.find((x) => x.id === id);
  if (!n) return { def: def0, error: 'That step is gone.' };
  if (to.before === id) return { def: def0 };
  const target = to.before ? def.nodes.find((x) => x.id === to.before) : undefined;
  if (n.compensation) {
    if (target?.compensation) { def.nodes.splice(def.nodes.indexOf(n), 1); def.nodes.splice(def.nodes.indexOf(target), 0, n); }
    if (to.lane && laneFits(n, to.lane)) n.lane = to.lane;
    return { def };
  }
  if (target?.compensation) return { def: def0, error: 'An undo step only runs when a run fails. Use the Undo step tool, or pick it as the step\'s undo step.' };
  const stage = target ? stageOf(def, target) : to.stage ?? stageOf(def, n);
  const lane = to.lane ?? (target ? laneOf(target) : undefined);
  const notes: string[] = [];
  if (lane && lane !== laneOf(n)) {
    if (laneFits(n, lane)) {
      if (n.kind === 'approval') n.approver = lane === 'ceo' ? 'ceo' : 'manager';
      else if (lane !== 'engine') n.lane = lane;
    } else if (!to.before) notes.push(n.kind === 'approval' ? 'An approval sits with its approver (the owner\'s manager or the CEO): change it in the inspector.' : n.kind === 'wait' || n.kind === 'subprocess' ? 'Timers and sub-processes run by themselves: they stay in the Automatic row.' : 'A task needs a role: drop it in a role\'s row.');
  }
  const moved = stage !== stageOf(def, n);
  n.stage = stage;
  def.nodes.splice(def.nodes.indexOf(n), 1);
  const idx = target && target !== n ? def.nodes.indexOf(target) : endOfStage(def, stage);
  def.nodes.splice(idx, 0, n);
  if (moved) {
    const dropped = unlinkAcrossStages(def, id);
    if (dropped) notes.push(`${dropped} link${dropped === 1 ? '' : 's'} removed: steps connect within a stage.`);
  }
  return { def, ...(notes.length ? { note: notes.join(' ') } : {}) };
}

/** Move a step one place earlier or later among the steps of its stage and row (the keyboard's reorder). */
export function nudgeNode(def0: ProcessDef, id: string, dir: -1 | 1): OpResult {
  const n = def0.nodes.find((x) => x.id === id);
  if (!n) return { def: def0 };
  const peers = def0.nodes.filter((x) => !!x.compensation === !!n.compensation && (n.compensation || (stageOf(def0, x) === stageOf(def0, n) && laneOf(x) === laneOf(n))));
  const i = peers.indexOf(n);
  const other = peers[i + dir];
  if (!other) return { def: def0 };
  const def = copy(def0);
  const a = def.nodes.findIndex((x) => x.id === n.id);
  const b = def.nodes.findIndex((x) => x.id === other.id);
  [def.nodes[a], def.nodes[b]] = [def.nodes[b], def.nodes[a]];
  return { def };
}

/** Delete a step with its links, its place in others' availability and any undo link to it. */
export function deleteNode(def0: ProcessDef, id: string): OpResult {
  const def = copy(def0);
  if (!def.nodes.some((n) => n.id === id)) return { def: def0 };
  def.nodes = def.nodes.filter((n) => n.id !== id);
  def.edges = def.edges.filter((e) => e.from !== id && e.to !== id);
  for (const n of def.nodes) {
    if (n.availableWhen?.after?.includes(id)) setAfter(n, n.availableWhen.after.filter((x) => x !== id));
    if (n.compensate === id) delete n.compensate;
  }
  return { def, select: null };
}

/** Whether `to` already leads (by "available after") to `from` — a new link would deadlock. */
function afterReaches(def: ProcessDef, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(def.nodes.find((n) => n.id === id)?.availableWhen?.after ?? []));
  }
  return false;
}

/**
 * Connect two steps (a drag from one step's handle to another). In a strict
 * stage: a link, and one that closes a loop gets a round limit; in a
 * dynamic stage: the target becomes available after the source; onto an
 * undo step: that step undoes the source.
 */
export function connect(def0: ProcessDef, from: string, to: string, loopMaxCeiling = 5): OpResult {
  const a = def0.nodes.find((n) => n.id === from);
  const b = def0.nodes.find((n) => n.id === to);
  if (!a || !b || from === to) return { def: def0 };
  const def = copy(def0);
  if (b.compensation && !a.compensation) {
    def.nodes.find((n) => n.id === from)!.compensate = to;
    return { def, note: `"${b.title}" now undoes "${a.title}" if a run fails.`, select: { kind: 'node', id: from } };
  }
  if (a.compensation || b.compensation) return { def: def0, error: 'An undo step stands outside the flow: it runs only when a run fails or is cancelled.' };
  const st = stageOf(def, a);
  if (st !== stageOf(def, b)) return { def: def0, error: 'Steps connect within a stage: stages run one after another. Move the step into the same stage first.' };
  if (modeOf(def, st) === 'dynamic') {
    const tb = def.nodes.find((n) => n.id === to)!;
    if (tb.availableWhen?.after?.includes(from)) return { def: def0, error: `"${b.title}" already opens after "${a.title}".` };
    if (afterReaches(def, from, to)) return { def: def0, error: `"${a.title}" already waits on "${b.title}": the two would wait on each other.` };
    setAfter(tb, [...(tb.availableWhen?.after ?? []), from]);
    return { def, select: { kind: 'link', from, to } };
  }
  if (def.edges.some((e) => e.from === from && e.to === to)) return { def: def0, error: `"${a.title}" already leads to "${b.title}".` };
  const before = stageLayout(def0, st).cols;
  def.edges.push({ from, to });
  let isLoop = backEdges(asModel(def), st).some((e) => e.from === from && e.to === to);
  if (!isLoop && closesCycle(def0, st, from, to)) {
    // The engine counts the loop by declaration order: put the stage's steps in
    // their order before this link, so the new link (not an older one) is the loop.
    const rank = new Map(before.flatMap((col, ci) => col.map((n) => [n.id, ci] as const)));
    const inStage = def.nodes.filter((n) => rank.has(n.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    let k = 0;
    def.nodes = def.nodes.map((n) => (rank.has(n.id) ? inStage[k++] : n));
    isLoop = backEdges(asModel(def), st).some((e) => e.from === from && e.to === to);
  }
  if (isLoop) {
    def.edges[def.edges.length - 1].loopMax = Math.max(1, Math.min(DEFAULT_LOOP_MAX, loopMaxCeiling));
    return { def, select: { kind: 'edge', from, to }, note: `This link goes back: a loop. It may go round at most ${def.edges[def.edges.length - 1].loopMax}× before someone decides; set when it goes back in the inspector.` };
  }
  return { def, select: { kind: 'edge', from, to } };
}

/** Whether `to` already leads to `from` over the stage's forward links (a link from→to closes a loop). */
function closesCycle(def: ProcessDef, stage: string, from: string, to: string): boolean {
  const loops = backEdges(asModel(def), stage);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of def.edges) if (e.from === id && !loops.some((b) => b.from === e.from && b.to === e.to)) stack.push(e.to);
  }
  return false;
}

/** Remove a strict link or an "available after" link. */
export function disconnect(def0: ProcessDef, sel: Sel): OpResult {
  if (!sel || (sel.kind !== 'edge' && sel.kind !== 'link')) return { def: def0 };
  const def = copy(def0);
  if (sel.kind === 'edge') def.edges = def.edges.filter((e) => !(e.from === sel.from && e.to === sel.to));
  else { const n = def.nodes.find((x) => x.id === sel.to); if (n) setAfter(n, (n.availableWhen?.after ?? []).filter((x) => x !== sel.from)); }
  return { def, select: null };
}

/** Set a link's condition (`null` = always) or round limit. */
export function setEdge(def0: ProcessDef, from: string, to: string, patch: { when?: string | null; loopMax?: number | null }): OpResult {
  const def = copy(def0);
  const e = def.edges.find((x) => x.from === from && x.to === to);
  if (!e) return { def: def0 };
  if (patch.when !== undefined) { if (patch.when && patch.when.trim()) e.when = patch.when.trim(); else delete e.when; }
  if (patch.loopMax !== undefined) { if (patch.loopMax === null) delete e.loopMax; else e.loopMax = patch.loopMax; }
  return { def };
}

/** Change fields of a step; `undefined` (or an empty list or string) removes a field. */
export function updateNode(def0: ProcessDef, id: string, patch: Partial<ProcessNodeDef>): OpResult {
  const def = copy(def0);
  const n = def.nodes.find((x) => x.id === id) as unknown as Record<string, unknown> | undefined;
  if (!n) return { def: def0 };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0)) delete n[k];
    else n[k] = v;
  }
  if (patch.kind) {
    const node = n as unknown as ProcessNodeDef;
    if (node.kind !== 'approval') { delete node.approver; delete node.question; } else { node.approver ??= 'manager'; node.question ??= 'Go ahead?'; delete node.lane; }
    if (node.kind !== 'wait') delete node.waitHours; else { node.waitHours ??= 24; delete node.lane; }
    if (node.kind !== 'subprocess') delete node.process; else delete node.lane;
    if (node.kind !== 'meeting') { delete node.meetingKind; delete node.attendees; delete node.agenda; } else { node.meetingKind ??= 'adhoc'; node.attendees ??= ['unit']; }
    if ((node.kind === 'task' || node.kind === 'meeting') && !node.lane) node.lane = 'owner';
  }
  return { def };
}

/** Make a step undo another (or nothing). */
export function setUndo(def0: ProcessDef, id: string, undoId: string | null): OpResult {
  return updateNode(def0, id, { compensate: undoId ?? undefined });
}

export function addStage(def0: ProcessDef, mode: Mode, after?: string): OpResult {
  const def = copy(def0);
  const id = uniqueId(def, 'stage');
  const i = after ? def.stages.findIndex((s) => s.id === after) + 1 : def.stages.length;
  def.stages.splice(i || def.stages.length, 0, { id, title: `Stage ${def.stages.length + 1}`, mode });
  return { def, select: { kind: 'stage', id } };
}

export function updateStage(def0: ProcessDef, id: string, patch: { title?: string }): OpResult {
  const def = copy(def0);
  const s = def.stages.find((x) => x.id === id);
  if (!s) return { def: def0 };
  if (patch.title !== undefined) s.title = patch.title;
  return { def };
}

/**
 * Switch a stage between "follows the graph" and "performer chooses": the
 * links become "available after" links and back (a loop has no meaning in
 * a dynamic stage and is dropped; conditions are dropped with a note).
 */
export function setStageMode(def0: ProcessDef, id: string, mode: Mode): OpResult {
  const st = def0.stages.find((s) => s.id === id);
  if (!st || st.mode === mode) return { def: def0 };
  const def = copy(def0);
  def.stages.find((s) => s.id === id)!.mode = mode;
  const ids = new Set(stageNodes(def0, id).map((n) => n.id));
  const notes: string[] = [];
  if (mode === 'dynamic') {
    const loops = backEdges(asModel(def0), id);
    const inStage = def.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    let lost = 0;
    for (const e of inStage) {
      if (loops.some((b) => b.from === e.from && b.to === e.to)) { lost++; continue; }
      if (e.when) lost++;
      const n = def.nodes.find((x) => x.id === e.to)!;
      if (!n.availableWhen?.after?.includes(e.from)) setAfter(n, [...(n.availableWhen?.after ?? []), e.from]);
    }
    def.edges = def.edges.filter((e) => !(ids.has(e.from) && ids.has(e.to)));
    if (lost) notes.push(`${lost} loop${lost === 1 ? '' : 's'} or condition${lost === 1 ? '' : 's'} dropped: the performer chooses in this stage.`);
  } else {
    for (const n of def.nodes.filter((x) => ids.has(x.id))) {
      for (const a of n.availableWhen?.after ?? []) if (ids.has(a) && !def.edges.some((e) => e.from === a && e.to === n.id)) def.edges.push({ from: a, to: n.id });
      setAfter(n, (n.availableWhen?.after ?? []).filter((a) => !ids.has(a)));
    }
  }
  return { def, ...(notes.length ? { note: notes.join(' ') } : {}) };
}

export function moveStage(def0: ProcessDef, id: string, dir: -1 | 1): OpResult {
  const i = def0.stages.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= def0.stages.length) return { def: def0 };
  const def = copy(def0);
  [def.stages[i], def.stages[j]] = [def.stages[j], def.stages[i]];
  return { def };
}

/** Remove a stage with its steps (undo brings them back); the last stage stays. */
export function removeStage(def0: ProcessDef, id: string): OpResult {
  if (def0.stages.length <= 1) return { def: def0, error: 'A process has at least one stage.' };
  let def = copy(def0);
  for (const n of stageNodes(def0, id)) def = deleteNode(def, n.id).def;
  const first = def.stages[0]?.id === id ? def.stages[1].id : def.stages[0].id;
  for (const n of def.nodes) if (n.compensation && n.stage === id) n.stage = first;
  def.stages = def.stages.filter((s) => s.id !== id);
  return { def, select: null };
}

/**
 * Tidy the canvas: steps ordered by the engine's column, then by the row
 * of the steps they follow (fewer crossings), stages in order, undo steps
 * last. The order never changes which link counts as the loop (checked;
 * kept as it was otherwise).
 */
export function tidy(def0: ProcessDef): OpResult {
  const def = copy(def0);
  const out: ProcessNodeDef[] = [];
  const lanes = allLanes(def0);
  for (const st of def.stages) {
    const cols = stageLayout(def0, st.id).cols;
    const rank = new Map<string, number>();
    cols.forEach((col, ci) => {
      const sorted = [...col].sort((a, b) => {
        const bary = (n: ProcessNodeDef) => {
          const ins = [...def0.edges.filter((e) => e.to === n.id).map((e) => e.from), ...(n.availableWhen?.after ?? [])].map((x) => rank.get(x)).filter((x): x is number => x !== undefined);
          return ins.length ? ins.reduce((s, x) => s + x, 0) / ins.length : Number.MAX_SAFE_INTEGER;
        };
        return lanes.indexOf(laneOf(a)) - lanes.indexOf(laneOf(b)) || bary(a) - bary(b);
      });
      sorted.forEach((n, k) => rank.set(n.id, ci * 100 + k));
      out.push(...sorted.map((n) => def.nodes.find((x) => x.id === n.id)!));
    });
  }
  for (const n of def.nodes) if (!out.includes(n)) out.push(n);
  const next = { ...def, nodes: out };
  const same = def0.stages.every((st) => JSON.stringify(backEdges(asModel(def0), st.id)) === JSON.stringify(backEdges(asModel(next), st.id)));
  return same ? { def: next } : { def: def0, note: 'Kept the order: a different one would change which link is the loop.' };
}

// ---- the canvas layout ----

export const G = { LANE_W: 116, COL_W: 206, CARD_W: 180, CARD_H: 84, VGAP: 12, PAD: 14, EMPTY_H: 58, HEAD: 46, STAGE_GAP: 26, LOOP: 34 };

export interface NodeBox { id: string; x: number; y: number; w: number; h: number; stage: string; lane: string; col: number }
export interface LaneBox { lane: string; y: number; h: number }
export interface StageBox { id: string; title: string; mode: Mode; index: number; y: number; h: number; lanes: LaneBox[]; cols: number }
export interface EdgePath { key: string; kind: 'edge' | 'link'; from: string; to: string; d: string; loop: boolean; conditional: boolean; label?: { x: number; y: number; text: string } }
export interface EdLayout { w: number; h: number; stages: StageBox[]; nodes: Map<string, NodeBox>; edges: EdgePath[]; undo: { y: number; h: number } | null }

/** Positions for every stage, row, step and link: a pure function of the definition and the rows shown. */
export function layoutEditor(def: ProcessDef, lanes: string[], conditionWords: (w?: string) => string = (w) => w ?? ''): EdLayout {
  const nodes = new Map<string, NodeBox>();
  const stages: StageBox[] = [];
  const edges: EdgePath[] = [];
  const widest = Math.max(1, ...def.stages.map((s) => stageLayout(def, s.id).cols.length));
  const w = G.LANE_W + (widest + 0.4) * G.COL_W;
  let y = 0;
  def.stages.forEach((st, index) => {
    const lay = stageLayout(def, st.id);
    const top = y + G.HEAD;
    let ly = top;
    const laneBoxes: LaneBox[] = [];
    for (const lane of lanes) {
      const counts = lay.cols.map((col) => col.filter((n) => laneOf(n) === lane).length);
      const most = Math.max(0, ...counts);
      const h = most ? most * (G.CARD_H + G.VGAP) - G.VGAP + 2 * G.PAD : G.EMPTY_H;
      lay.cols.forEach((col, ci) => {
        const here = col.filter((n) => laneOf(n) === lane);
        const off = (h - (here.length * (G.CARD_H + G.VGAP) - G.VGAP)) / 2;
        here.forEach((n, k) => nodes.set(n.id, { id: n.id, x: G.LANE_W + ci * G.COL_W + (G.COL_W - G.CARD_W) / 2, y: ly + off + k * (G.CARD_H + G.VGAP), w: G.CARD_W, h: G.CARD_H, stage: st.id, lane, col: ci }));
      });
      laneBoxes.push({ lane, y: ly, h });
      ly += h;
    }
    const hasLoop = lay.edges.some((e) => e.loop);
    const floor = ly + (hasLoop ? G.LOOP : 0);
    for (const e of lay.edges) {
      const a = nodes.get(e.from); const b = nodes.get(e.to);
      if (!a || !b) continue;
      const kind = st.mode === 'dynamic' ? 'link' : 'edge';
      const key = `${kind}:${e.from}>${e.to}`;
      if (e.loop) {
        const x1 = a.x + a.w / 2 + 12; const x2 = b.x + b.w / 2 - 12; const fy = ly + G.LOOP - 12;
        edges.push({ key, kind, from: e.from, to: e.to, loop: true, conditional: !!e.label, d: `M${x1} ${a.y + a.h} C${x1} ${fy} ${x2} ${fy} ${x2} ${b.y + b.h + 4}`, label: { x: (x1 + x2) / 2, y: fy - 2, text: `↺ ${e.label ? `${e.label}, ` : ''}up to ${e.loopMax ?? '?'}×` } });
        continue;
      }
      let d: string; let mx: number; let my: number;
      if (b.x > a.x + a.w) {
        const x1 = a.x + a.w; const y1 = a.y + a.h / 2; const x2 = b.x - 4; const y2 = b.y + b.h / 2; const dx = Math.max(18, (x2 - x1) / 2);
        d = `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`; mx = (x1 + x2) / 2; my = (y1 + y2) / 2;
      } else {
        const down = b.y > a.y;
        const x1 = a.x + a.w / 2; const y1 = down ? a.y + a.h : a.y; const x2 = b.x + b.w / 2; const y2 = down ? b.y - 4 : b.y + b.h + 4;
        d = `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`; mx = (x1 + x2) / 2; my = (y1 + y2) / 2;
      }
      const text = st.mode === 'dynamic' ? '' : conditionWords(def.edges.find((x) => x.from === e.from && x.to === e.to)?.when);
      edges.push({ key, kind, from: e.from, to: e.to, loop: false, conditional: !!text, d, ...(text ? { label: { x: mx, y: my, text } } : {}) });
    }
    stages.push({ id: st.id, title: st.title, mode: st.mode, index, y, h: floor - y, lanes: laneBoxes, cols: lay.cols.length });
    y = floor + G.STAGE_GAP;
  });
  const comps = def.nodes.filter((n) => n.compensation);
  let undo: EdLayout['undo'] = null;
  if (comps.length) {
    const top = y + G.HEAD;
    comps.forEach((n, i) => nodes.set(n.id, { id: n.id, x: G.LANE_W + i * G.COL_W + (G.COL_W - G.CARD_W) / 2, y: top + G.PAD, w: G.CARD_W, h: G.CARD_H, stage: '', lane: '', col: i }));
    undo = { y, h: G.HEAD + G.CARD_H + 2 * G.PAD };
    y += undo.h + G.STAGE_GAP;
  }
  return { w: Math.max(w, G.LANE_W + (comps.length + 1) * G.COL_W), h: Math.max(0, y - G.STAGE_GAP), stages, nodes, edges, undo };
}

export type Hit = { kind: 'node'; id: string } | { kind: 'lane'; stage: string; lane: string } | { kind: 'stage'; stage: string } | { kind: 'undo' } | null;

/** What lies under a point of the canvas (canvas coordinates). */
export function hitTest(l: EdLayout, x: number, y: number): Hit {
  for (const b of l.nodes.values()) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { kind: 'node', id: b.id };
  if (x < 0 || x > l.w) return null;
  for (const s of l.stages) {
    if (y < s.y || y > s.y + s.h) continue;
    for (const ln of s.lanes) if (y >= ln.y && y < ln.y + ln.h) return { kind: 'lane', stage: s.id, lane: ln.lane };
    return { kind: 'stage', stage: s.id };
  }
  if (l.undo && y >= l.undo.y && y <= l.undo.y + l.undo.h) return { kind: 'undo' };
  return null;
}

// ---- history ----

export interface History { past: ProcessDef[]; present: ProcessDef; future: ProcessDef[]; key: string | null; at: number }
export type HistoryAction = { type: 'set'; def: ProcessDef; key?: string; now?: number } | { type: 'undo' } | { type: 'redo' } | { type: 'reset'; def: ProcessDef };
const HISTORY_MAX = 100;

export function initHistory(def: ProcessDef): History { return { past: [], present: def, future: [], key: null, at: 0 }; }

/** Every edit is a step back; typing in one field within a second is one step. */
export function historyReducer(h: History, a: HistoryAction): History {
  switch (a.type) {
    case 'set': {
      if (a.def === h.present) return h;
      const now = a.now ?? Date.now();
      if (a.key && a.key === h.key && now - h.at < 1_000) return { ...h, present: a.def, future: [], at: now };
      return { past: [...h.past, h.present].slice(-HISTORY_MAX), present: a.def, future: [], key: a.key ?? null, at: now };
    }
    case 'undo': return h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], key: null, at: 0 } : h;
    case 'redo': return h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), key: null, at: 0 } : h;
    case 'reset': return initHistory(a.def);
  }
}

// ---- the live check ----

export type ProblemTarget = { kind: 'node'; id: string } | { kind: 'edge'; from: string; to: string } | { kind: 'stage'; id: string } | { kind: 'process' };
export interface EdProblem { target: ProblemTarget; where: string; text: string; fix: string }
export interface CheckOpts { loopMaxCeiling?: number; processNames?: string[]; selfName?: string }

const PLAIN: Array<[RegExp, string]> = [
  [/availableWhen\.after names "([^"]+)", which does not exist/, 'it opens after a step that does not exist'],
  [/availableWhen\.after/g, '"available after"'],
  [/this edge closes a loop without loopMax/, 'this link goes back (a loop) with no round limit'],
  [/set loopMax \(how many times it may go round\) so the loop is bounded/, 'set how many rounds it may go before someone decides'],
  [/loopMax must be 1–(\d+)/, 'a loop may go round 1–$1 times in this company'],
  [/bound the loop: how many times may it go round before it escalates\?/, 'lower the round limit'],
  [/a wait step needs waitHours between 0 and 720/, 'a wait needs between 1 and 720 hours'],
  [/say how many hours the run waits/, 'say how many hours the run waits'],
  [/slaHours must be between 0 and 1440/, 'the deadline must be between 1 and 1440 hours'],
  [/give the hours the step may take before it escalates, or leave it out/, 'give the hours it may take, or clear it'],
  [/maxAttempts must be 1–5/, 'attempts must be 1–5'],
  [/leave it out for one attempt/, 'clear it for one attempt'],
  [/compensate names "([^"]+)", which is not another step/, 'its undo step is missing'],
  [/compensate names "([^"]+)", which is not marked compensation/, 'its undo step is not an undo step'],
  [/mark step \S+ compensation: true \(it then runs only to undo\)/, 'pick an undo step instead'],
  [/name a step marked compensation: true that undoes this one/, 'pick an undo step, or clear it'],
  [/a compensation step cannot itself be compensated/, 'an undo step cannot have its own undo step'],
  [/drop compensate from it/, 'clear its undo step'],
  [/a compensation step is not a checkpoint/, 'an undo step cannot be a checkpoint'],
  [/drop required from it/, 'untick Checkpoint'],
  [/a compensation step is a task/, 'an undo step is a task'],
  [/make it kind task: someone undoes the side effect/, 'make it a task: someone undoes the side effect'],
  [/no step names this compensation step/, 'no step is undone by it'],
  [/set compensate: "[^"]+" on the step it undoes, or remove it/, 'pick it as the undo step of the step it undoes, or delete it'],
  [/an edge touches a compensation step/, 'a link touches an undo step'],
  [/a compensation step runs only when the run fails or is cancelled: remove the edge/, 'undo steps run only when a run fails: delete the link'],
  [/an edge crosses stages/, 'a link crosses stages'],
  [/stages run in order: connect steps within one stage/, 'stages run in order: connect steps within one stage'],
  [/a dynamic stage has no edges/, 'in a "performer chooses" stage steps are not linked in order'],
  [/say when the step is available instead \("available after"\)/, 'use an "available after" link instead'],
  [/an edge names a step that does not exist/, 'a link names a step that does not exist'],
  [/connect existing step ids/, 'delete the link'],
  [/cannot read the condition "([^"]+)"/, 'cannot read the condition "$1"'],
  [/write `var == "value"`, `var != "value"`, `var` or `!var`/, 'pick what it depends on and the value in the inspector'],
  [/a subprocess step names no process/, 'a sub-process step names no process'],
  [/name the process it starts \(its name, e\.g\. "incident-response"\)/, 'pick the process it runs'],
  [/^use one of: .*$/s, 'pick one that exists'],
  [/a process may not start itself/, 'a process cannot run itself'],
  [/start another process, or loop with an edge and loopMax/, 'pick another process, or loop back with a link'],
  [/add at least one step \(kind task, approval, wait, subprocess or meeting\)/, 'drag a step in from the bar above'],
  [/no step starts the stage \(every step has an incoming edge\)/, 'no step starts the stage: every step waits on another'],
  [/leave at least one step without an incoming edge/, 'remove a link into the first step'],
  [/deny names an unknown tool "([^"]+)"/, '"$1" is not a tool the performer has'],
  [/output "([^"]+)" is not a variable name/, 'the record name "$1" is not usable'],
  [/use snake_case names like "release_notes"/, 'use lowercase words with underscores, like release_notes'],
  [/(\d+) MUST\/SHOULD\/MAY items \(at most (\d+)\)/, '$1 checklist items (at most $2)'],
  [/the stage has no steps/, 'the stage has no steps'],
  [/add steps to it or remove it/, 'drag steps into it, or delete it'],
  [/the step id is not a short lowercase id/, 'the step\'s id is not usable'],
  [/two steps share an id/, 'two steps share an id'],
];

export function plainWords(text: string): string {
  let t = text;
  for (const [re, w] of PLAIN) t = t.replace(re, w);
  return t.trim();
}

/** A problem from the model (or the server's check), pinned to what it is about, in plain words. */
export function pinProblem(def: ProcessDef, p: { where: string; problem: string; fix: string }): EdProblem {
  const title = (id: string) => def.nodes.find((n) => n.id === id)?.title || 'a step';
  let target: ProblemTarget = { kind: 'process' };
  let where = 'The process';
  let m: RegExpExecArray | null;
  if ((m = /^step (.+)$/.exec(p.where))) { target = { kind: 'node', id: m[1] }; where = `“${title(m[1])}”`; }
  else if ((m = /^edge (.+)→(.+)$/.exec(p.where))) { target = { kind: 'edge', from: m[1], to: m[2] }; where = `The link “${title(m[1])}” → “${title(m[2])}”`; }
  else if ((m = /^stage (.+)$/.exec(p.where))) { target = { kind: 'stage', id: m[1] }; where = `Stage “${def.stages.find((s) => s.id === m![1])?.title ?? m[1]}”`; }
  else if (p.where === 'triggers') where = 'How it starts';
  else if (p.where === 'title') where = 'The title';
  else if (p.where === 'nodes') where = 'The steps';
  return { target, where, text: plainWords(p.problem), fix: plainWords(p.fix) };
}

/** The live check: the server's own normalisation and validation, pinned and in plain words. */
export function checkProcess(def: ProcessDef, opts: CheckOpts = {}): EdProblem[] {
  const model = normalizeProcess(def);
  const problems = validateProcess(model, { loopMaxCeiling: opts.loopMaxCeiling, processNames: opts.processNames ? new Set([...opts.processNames, ...(opts.selfName ? [opts.selfName] : [])]) : undefined, selfName: opts.selfName });
  return problems.map((p) => pinProblem(def, p));
}

export const sameTarget = (a: ProblemTarget, sel: Sel): boolean => !!sel && (
  (a.kind === 'node' && sel.kind === 'node' && a.id === sel.id)
  || (a.kind === 'edge' && (sel.kind === 'edge' || sel.kind === 'link') && a.from === sel.from && a.to === sel.to)
  || (a.kind === 'stage' && sel.kind === 'stage' && a.id === sel.id));

// ---- conditions, in the inspector's words ----

export type CondOp = 'eq' | 'ne' | 'set' | 'unset';
export interface CondParts { name: string; op: CondOp; value: string }

export function condParts(when: string | undefined): CondParts | null {
  if (!when) return null;
  const c = parseCondition(when);
  if (!c) return null;
  return { name: c.name, op: c.op, value: 'value' in c ? c.value : '' };
}

export function condText(c: CondParts): string {
  if (!c.name) return '';
  if (c.op === 'set') return c.name;
  if (c.op === 'unset') return `!${c.name}`;
  return `${c.name} ${c.op === 'eq' ? '==' : '!='} ${/^[\w.-]+$/.test(c.value) ? c.value : JSON.stringify(c.value)}`;
}

/** What a condition may depend on: each step's records, an approval's answer, a meeting's minutes. */
export function variablesOf(def: ProcessDef): Array<{ name: string; label: string; values?: string[] }> {
  const out: Array<{ name: string; label: string; values?: string[] }> = [];
  for (const n of def.nodes) {
    if (n.compensation) continue;
    const key = n.id.replace(/-/g, '_');
    if (n.kind === 'approval') out.push({ name: key, label: `${n.title}: the answer`, values: ['approved', 'rejected'] });
    else if (n.kind === 'meeting') out.push({ name: `${key}_decisions`, label: `${n.title}: decisions` }, { name: `${key}_actions`, label: `${n.title}: actions` });
    for (const o of n.outputs ?? []) out.push({ name: o.name, label: `${n.title}: ${o.name.replace(/_/g, ' ')}` });
  }
  return out.filter((v, i) => out.findIndex((x) => x.name === v.name) === i);
}

/** A role in the inspector's menus: the company's roles first, then the titles in use. */
export function roleOptions(def: ProcessDef, extra: string[] = []): Array<{ id: string; label: string }> {
  const used = def.nodes.flatMap((n) => [n.lane, ...(n.attendees ?? [])]).filter((x): x is string => !!x);
  const all = [...ROLE_LANES, ...used, ...extra].filter((l, i, a) => a.indexOf(l) === i && !PSEUDO_LANES.includes(l) && l !== 'unit');
  return all.map((id) => ({ id, label: laneTitle(id) }));
}

/** An output name the model accepts: lowercase words with underscores. */
export const varName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '').slice(0, 40);
