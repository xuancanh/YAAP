/**
 * Processes, the pure half (docs/processes.md; reports/Process abstractions
 * for agent companies.md, "Process should be a pinned graph whose nodes are
 * ordinary tasks").
 *
 * A process definition is a list of **stages** run in order. A stage is
 * `strict` — a DAG whose edges (with an optional `when` on run variables
 * and a `loopMax` on every edge that closes a loop) the engine walks with
 * no model — or `dynamic` — a set of steps each `available when` its
 * prerequisites are done and its variables are set, from which the
 * performing agent chooses (and may add a logged ad-hoc step). Both kinds
 * carry required checkpoint steps: a strict stage requires every step on
 * the path the run takes; a dynamic stage cannot finish while a `required`
 * step is undone.
 *
 * Steps (`nodes`) are of five kinds: `task` (materialised as an ordinary
 * org task), `approval` (an org_approvals card routed by decision routing),
 * `wait` (a timer), `subprocess` (a child run pinned to that process's
 * active version) and `meeting` (a meeting of a kind, its attendees by lane,
 * its agenda from the step's inputs; it completes when the meeting ends and
 * the minutes' decisions and actions become the step's outputs). A task step
 * carries its step card — why, MUST / SHOULD / MAY items (at most nine),
 * denied tools, outputs and exit checks. A side-effecting step may name a
 * `compensate` step (a node marked `compensation`, outside the walk): when a
 * run fails or is cancelled the engine runs the compensations of its done
 * steps in reverse order (a saga).
 *
 * Everything here is model-free and I/O-free: validation (with the
 * remediation each error needs), the edge expressions, the readiness walk
 * (with dead-path elimination, so a branch not taken never leaves a join
 * waiting), dynamic availability, the step card text and the metrics. The
 * service (org-processes.service.ts) persists and acts on the results.
 */
import { createHash } from 'node:crypto';

export type ProcessMode = 'strict' | 'dynamic';
export const PROCESS_MODES: readonly ProcessMode[] = ['strict', 'dynamic'];
export type StepKind = 'task' | 'approval' | 'wait' | 'subprocess' | 'meeting';
export const STEP_KINDS: readonly StepKind[] = ['task', 'approval', 'wait', 'subprocess', 'meeting'];
/** The meeting kinds a meeting step may hold (org-meetings.service.ts MEETING_KINDS). */
export const MEETING_STEP_KINDS: readonly string[] = ['planning', 'standup', 'weekly_review', 'retro', 'board', 'adhoc'];
/** `operating`: the company running itself (incidents, the chief's sweep,
 *  request intake, review prep) — not gated on goal alignment; `delivery`:
 *  work that serves a goal or project (releases, content, hiring, onboarding). */
export type ProcessCategory = 'operating' | 'delivery';
export const PROCESS_CATEGORIES: readonly ProcessCategory[] = ['operating', 'delivery'];

export const MAX_STAGES = 8;
export const MAX_NODES = 30;
/** Checklist practice: one step, a short list at a pause point. */
export const MAX_ITEMS = 9;
export const SLUG_RE = /^[a-z][a-z0-9-]{1,47}$/;
const NODE_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export interface ProcessStage { id: string; title: string; mode: ProcessMode }

export interface ProcessOutput { name: string; required?: boolean; description?: string }

export interface ProcessNode {
  id: string;
  title: string;
  kind: StepKind;
  /** The stage it belongs to (defaults to the first). */
  stage?: string;
  /** Why the step exists: one line on the step card. */
  why?: string;
  /** Who performs it — a role, never an agent: owner (the process owner),
   *  chief, head (the owning unit's head), initiator, or a title. */
  lane?: string;
  outcome?: string;
  context?: string;
  doneWhen?: string;
  /** Task class (model routing, cost roll-ups). */
  class?: string;
  must?: string[];
  should?: string[];
  may?: string[];
  /** Tools the performer may not call during this step (enforced). */
  deny?: string[];
  outputs?: ProcessOutput[];
  /** Model-free checks (org-checks.ts) that run before review. */
  checks?: unknown[];
  /** A playbook skill the card points to. */
  playbook?: string;
  // dynamic stages
  /** A checkpoint: the stage cannot finish without it. */
  required?: boolean;
  availableWhen?: { after?: string[]; vars?: string[]; equals?: Record<string, string> };
  // approval
  approver?: 'manager' | 'ceo';
  question?: string;
  // wait
  waitHours?: number;
  // subprocess
  process?: string;
  // meeting
  /** planning | standup | weekly_review | retro | board | adhoc (default). */
  meetingKind?: string;
  /** Lanes to invite (owner, chief, head, initiator, a title) or `unit` (the owning unit). */
  attendees?: string[];
  /** The agenda (`${vars}` filled); the inputs of earlier steps are appended. */
  agenda?: string;
  // compensation (saga)
  /** The id of the `compensation` step that undoes this one if the run fails or is cancelled. */
  compensate?: string;
  /** This step only runs to undo another (outside the stage walk). */
  compensation?: boolean;
  // control
  slaHours?: number;
  maxAttempts?: number;
}

export interface ProcessEdge { from: string; to: string; when?: string; loopMax?: number }

export type ProcessTrigger =
  | { kind: 'manual' }
  | { kind: 'cadence'; cron: string; enabled?: boolean }
  | { kind: 'event'; event: ProcessEvent; severity?: 'minor' | 'major' | 'critical'; class?: string; enabled?: boolean }
  /** A request to a service (docs/processes.md "Services"): the hook exists, the catalog comes later. */
  | { kind: 'service_request'; service?: string; enabled?: boolean };
export type ProcessEvent = 'incident_opened' | 'project_now' | 'task_created';
export const PROCESS_EVENTS: readonly ProcessEvent[] = ['incident_opened', 'project_now', 'task_created'];

export interface ProcessDef {
  title: string;
  description?: string;
  category: ProcessCategory;
  /** Who owns runs: head (the owning unit's head) or chief. */
  owner?: 'head' | 'chief';
  triggers: ProcessTrigger[];
  stages: ProcessStage[];
  nodes: ProcessNode[];
  edges: ProcessEdge[];
}

// ---- normalisation and validation ----

const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max: number, each = 300): string[] => (Array.isArray(v) ? v.map((x) => s(x, each)).filter(Boolean).slice(0, max) : []);

/** Coerce an authored definition (an agent's JSON, a template) into shape;
 *  unknown fields are dropped. `validateProcess` then says what is wrong. */
export function normalizeProcess(raw: unknown): ProcessDef {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const stagesRaw = Array.isArray(o.stages) && o.stages.length ? o.stages : [{ id: 'main', title: 'Main', mode: o.mode === 'dynamic' ? 'dynamic' : 'strict' }];
  const stages: ProcessStage[] = stagesRaw.slice(0, MAX_STAGES + 1).map((x, i) => {
    const r = (x ?? {}) as Record<string, unknown>;
    return { id: s(r.id, 32) || `stage${i + 1}`, title: s(r.title, 80) || s(r.id, 32) || `Stage ${i + 1}`, mode: r.mode === 'dynamic' ? 'dynamic' : 'strict' };
  });
  const nodes: ProcessNode[] = (Array.isArray(o.nodes) ? o.nodes : (Array.isArray(o.steps) ? o.steps : [])).slice(0, MAX_NODES + 1).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const kind = (STEP_KINDS as readonly string[]).includes(String(r.kind)) ? r.kind as StepKind : 'task';
    const n: ProcessNode = { id: s(r.id, 32), title: s(r.title, 120), kind, stage: s(r.stage, 32) || stages[0].id };
    for (const k of ['why', 'lane', 'outcome', 'context', 'doneWhen', 'class', 'playbook', 'question', 'process', 'meetingKind', 'agenda', 'compensate'] as const) { const v = s(r[k], k === 'context' || k === 'outcome' || k === 'doneWhen' || k === 'agenda' ? 1_500 : 300); if (v) (n as unknown as Record<string, unknown>)[k] = v; }
    const attendees = list(r.attendees, 12, 40); if (attendees.length) n.attendees = attendees;
    if (r.compensation) n.compensation = true;
    for (const k of ['must', 'should', 'may'] as const) { const v = list(r[k], MAX_ITEMS + 1); if (v.length) n[k] = v; }
    const deny = list(r.deny, 20, 80); if (deny.length) n.deny = deny;
    if (Array.isArray(r.outputs)) {
      const outs = r.outputs.slice(0, 12).map((y) => (typeof y === 'string' ? { name: s(y, 40) } : { name: s((y as Record<string, unknown>)?.name, 40), ...((y as Record<string, unknown>)?.required ? { required: true } : {}), ...(s((y as Record<string, unknown>)?.description, 200) ? { description: s((y as Record<string, unknown>).description, 200) } : {}) })).filter((y) => y.name);
      if (outs.length) n.outputs = outs;
    }
    if (Array.isArray(r.checks) && r.checks.length) n.checks = r.checks.slice(0, 10);
    if (r.required) n.required = true;
    if (r.availableWhen && typeof r.availableWhen === 'object') {
      const a = r.availableWhen as Record<string, unknown>;
      const equals = a.equals && typeof a.equals === 'object' ? Object.fromEntries(Object.entries(a.equals as Record<string, unknown>).slice(0, 8).map(([k, v]) => [s(k, 40), s(v, 120)]).filter(([k]) => k)) : undefined;
      n.availableWhen = { ...(list(a.after, 12, 32).length ? { after: list(a.after, 12, 32) } : {}), ...(list(a.vars, 12, 40).length ? { vars: list(a.vars, 12, 40) } : {}), ...(equals && Object.keys(equals).length ? { equals } : {}) };
    }
    if (r.approver === 'ceo' || r.approver === 'manager') n.approver = r.approver;
    for (const k of ['waitHours', 'slaHours', 'maxAttempts'] as const) { const v = Number(r[k]); if (r[k] !== undefined && r[k] !== null && Number.isFinite(v)) n[k] = v; }
    return n;
  });
  const edges: ProcessEdge[] = (Array.isArray(o.edges) ? o.edges : []).slice(0, 120).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const e: ProcessEdge = { from: s(r.from, 32), to: s(r.to, 32) };
    const when = s(r.when, 200); if (when) e.when = when;
    if (r.loopMax !== undefined && r.loopMax !== null) e.loopMax = Math.round(Number(r.loopMax));
    return e;
  });
  const triggers: ProcessTrigger[] = (Array.isArray(o.triggers) ? o.triggers : [{ kind: 'manual' }]).slice(0, 8).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const enabled = r.enabled === false ? { enabled: false } : {};
    if (r.kind === 'cadence') return { kind: 'cadence', cron: s(r.cron, 60), ...enabled };
    if (r.kind === 'event') return { kind: 'event', event: s(r.event, 32) as ProcessEvent, ...(r.severity ? { severity: s(r.severity, 10) as 'minor' } : {}), ...(r.class ? { class: s(r.class, 24) } : {}), ...enabled };
    if (r.kind === 'service_request') return { kind: 'service_request', ...(r.service ? { service: s(r.service, 60) } : {}), ...enabled };
    return { kind: 'manual' };
  });
  return {
    title: s(o.title, 120), ...(s(o.description, 1_000) ? { description: s(o.description, 1_000) } : {}),
    category: o.category === 'delivery' ? 'delivery' : 'operating', ...(o.owner === 'chief' || o.owner === 'head' ? { owner: o.owner } : {}),
    triggers, stages, nodes, edges,
  };
}

/** One validation problem, with what to do about it. */
export interface ProcessProblem { where: string; problem: string; fix: string }

export interface ValidateOpts {
  /** The ceiling on any loopMax (process.loopMaxCeiling). */
  loopMaxCeiling?: number;
  /** Known process names, for subprocess steps. */
  processNames?: Set<string>;
  /** This process's own name (a subprocess may not call itself). */
  selfName?: string;
  /** Tool names that exist, for `deny` lists (unknown names are refused). */
  toolNames?: Set<string>;
  /** Whether ad-hoc dynamic steps are allowed (shown, not validated). */
  isValidCron?: (cron: string) => boolean;
}

/** Every problem with a definition; empty = valid. Pure. */
export function validateProcess(def: ProcessDef, opts: ValidateOpts = {}): ProcessProblem[] {
  const out: ProcessProblem[] = [];
  const add = (where: string, problem: string, fix: string) => out.push({ where, problem, fix });
  if (!def.title) add('title', 'the process has no title', 'give it a short title, e.g. "Release checklist"');
  if (def.stages.length > MAX_STAGES) add('stages', `more than ${MAX_STAGES} stages`, 'merge stages: a process is a few phases, not a project plan');
  const stageIds = new Set<string>();
  for (const st of def.stages) {
    if (!NODE_ID_RE.test(st.id)) add(`stage ${st.id || '?'}`, 'the stage id is not a short lowercase id', 'use ids like "prepare" or "ship"');
    if (stageIds.has(st.id)) add(`stage ${st.id}`, 'two stages share an id', 'give every stage its own id');
    stageIds.add(st.id);
  }
  if (def.nodes.length === 0) add('nodes', 'the process has no steps', 'add at least one step (kind task, approval, wait, subprocess or meeting)');
  if (def.nodes.length > MAX_NODES) add('nodes', `more than ${MAX_NODES} steps`, 'split it into a parent process with subprocess steps');
  const ids = new Set<string>();
  for (const n of def.nodes) {
    const w = `step ${n.id || '?'}`;
    if (!NODE_ID_RE.test(n.id)) add(w, 'the step id is not a short lowercase id', 'use ids like "ci-green" or "draft"');
    if (ids.has(n.id)) add(w, 'two steps share an id', 'give every step its own id');
    ids.add(n.id);
    if (!n.title) add(w, 'the step has no title', 'name what the step does in a few words');
    if (!stageIds.has(n.stage ?? '')) add(w, `stage "${n.stage}" does not exist`, `use one of: ${[...stageIds].join(', ')}`);
    const items = (n.must?.length ?? 0) + (n.should?.length ?? 0) + (n.may?.length ?? 0);
    if (items > MAX_ITEMS) add(w, `${items} MUST/SHOULD/MAY items (at most ${MAX_ITEMS})`, 'keep the step card short: move detail into the playbook it points to, or split the step');
    if (n.kind === 'approval' && !n.question) add(w, 'an approval step has no question', 'write the yes/no question the approver answers');
    if (n.kind === 'wait' && !(Number(n.waitHours) > 0 && Number(n.waitHours) <= 24 * 30)) add(w, 'a wait step needs waitHours between 0 and 720', 'say how many hours the run waits');
    if (n.kind === 'subprocess') {
      if (!n.process) add(w, 'a subprocess step names no process', 'name the process it starts (its name, e.g. "incident-response")');
      else if (opts.selfName && n.process === opts.selfName) add(w, 'a process may not start itself', 'start another process, or loop with an edge and loopMax');
      else if (opts.processNames && !opts.processNames.has(n.process)) add(w, `no process "${n.process}"`, `use one of: ${[...opts.processNames].slice(0, 12).join(', ') || '(none yet)'}`);
    }
    if (n.kind === 'meeting' && n.meetingKind && !MEETING_STEP_KINDS.includes(n.meetingKind)) add(w, `no meeting kind "${n.meetingKind}"`, `use one of: ${MEETING_STEP_KINDS.join(', ')}`);
    if (n.compensate) {
      const c = def.nodes.find((x) => x.id === n.compensate);
      if (!c || c.id === n.id) add(w, `compensate names "${n.compensate}", which is not another step`, 'name a step marked compensation: true that undoes this one');
      else if (!c.compensation) add(w, `compensate names "${c.id}", which is not marked compensation`, `mark step ${c.id} compensation: true (it then runs only to undo)`);
      if (n.compensation) add(w, 'a compensation step cannot itself be compensated', 'drop compensate from it');
    }
    if (n.compensation) {
      if (n.kind !== 'task') add(w, 'a compensation step is a task', 'make it kind task: someone undoes the side effect');
      if (n.required) add(w, 'a compensation step is not a checkpoint', 'drop required from it');
      if (!def.nodes.some((x) => x.compensate === n.id)) add(w, 'no step names this compensation step', `set compensate: "${n.id}" on the step it undoes, or remove it`);
    }
    if (n.slaHours !== undefined && !(n.slaHours > 0 && n.slaHours <= 24 * 60)) add(w, 'slaHours must be between 0 and 1440', 'give the hours the step may take before it escalates, or leave it out');
    if (n.maxAttempts !== undefined && !(n.maxAttempts >= 1 && n.maxAttempts <= 5)) add(w, 'maxAttempts must be 1–5', 'leave it out for one attempt');
    if (opts.toolNames && n.deny) for (const t of n.deny) if (!opts.toolNames.has(t)) add(w, `deny names an unknown tool "${t}"`, 'name a tool the performer is offered, or drop it');
    for (const o of n.outputs ?? []) if (!/^[a-z][a-z0-9_]{0,39}$/.test(o.name)) add(w, `output "${o.name}" is not a variable name`, 'use snake_case names like "release_notes"');
  }
  const compIds = new Set(def.nodes.filter((n) => n.compensation).map((n) => n.id));
  const stageOf = new Map(def.nodes.map((n) => [n.id, n.stage ?? def.stages[0]?.id]));
  const modeOf = new Map(def.stages.map((st) => [st.id, st.mode]));
  for (const e of def.edges) {
    const w = `edge ${e.from}→${e.to}`;
    if (!ids.has(e.from) || !ids.has(e.to)) { add(w, 'an edge names a step that does not exist', 'connect existing step ids'); continue; }
    if (compIds.has(e.from) || compIds.has(e.to)) { add(w, 'an edge touches a compensation step', 'a compensation step runs only when the run fails or is cancelled: remove the edge'); continue; }
    if (stageOf.get(e.from) !== stageOf.get(e.to)) add(w, 'an edge crosses stages', 'stages run in order: connect steps within one stage');
    else if (modeOf.get(stageOf.get(e.from)!) === 'dynamic') add(w, 'a dynamic stage has no edges', 'say when the step is available instead (availableWhen.after)');
    if (e.when && parseCondition(e.when) === null) add(w, `cannot read the condition "${e.when}"`, 'write `var == "value"`, `var != "value"`, `var` or `!var`');
    if (e.loopMax !== undefined && !(e.loopMax >= 1 && e.loopMax <= (opts.loopMaxCeiling ?? 10))) add(w, `loopMax must be 1–${opts.loopMaxCeiling ?? 10}`, 'bound the loop: how many times may it go round before it escalates?');
  }
  for (const st of def.stages) {
    const inStage = def.nodes.filter((n) => !n.compensation && (n.stage ?? def.stages[0].id) === st.id);
    if (inStage.length === 0) { add(`stage ${st.id}`, 'the stage has no steps', 'add steps to it or remove it'); continue; }
    if (st.mode === 'strict') {
      const back = backEdges(def, st.id);
      for (const e of back) if (e.loopMax === undefined) add(`edge ${e.from}→${e.to}`, 'this edge closes a loop without loopMax', 'set loopMax (how many times it may go round) so the loop is bounded');
      if (startNodes(def, st.id).length === 0) add(`stage ${st.id}`, 'no step starts the stage (every step has an incoming edge)', 'leave at least one step without an incoming edge');
    } else {
      for (const n of inStage) for (const a of n.availableWhen?.after ?? []) {
        if (!ids.has(a)) add(`step ${n.id}`, `availableWhen.after names "${a}", which does not exist`, 'name earlier step ids');
        else if (a === n.id) add(`step ${n.id}`, 'a step cannot wait on itself', 'remove it from availableWhen.after');
      }
    }
  }
  for (const t of def.triggers) {
    if (t.kind === 'cadence' && (opts.isValidCron ? !opts.isValidCron(t.cron) : t.cron.split(/\s+/).length !== 5)) add('triggers', `cadence "${t.cron}" is not a five-field cron`, 'write minute hour day-of-month month day-of-week, e.g. "30 7 * * 1-5"');
    if (t.kind === 'event' && !(PROCESS_EVENTS as readonly string[]).includes(t.event)) add('triggers', `unknown event "${t.event}"`, `use one of: ${PROCESS_EVENTS.join(', ')}`);
  }
  return out;
}

/** The problems as one refusal with remediation (never a bare "no"). */
export function describeProblems(problems: ProcessProblem[]): string {
  return problems.slice(0, 12).map((p, i) => `${i + 1}. ${p.where}: ${p.problem} — ${p.fix}`).join('\n');
}

export function processHash(def: ProcessDef): string {
  return createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 16);
}

// ---- graph helpers ----

/** The steps a stage walks (compensation steps stand outside every stage). */
export function nodesOf(def: ProcessDef, stageId: string): ProcessNode[] {
  return def.nodes.filter((n) => !n.compensation && (n.stage ?? def.stages[0]?.id) === stageId);
}

/** The compensations a failed or cancelled run owes: for each done step
 *  with a `compensate` step, latest completion first (reverse order, a
 *  saga). `done` is each node's latest done attempt. Pure. */
export function compensationPlan(def: ProcessDef, done: Array<{ nodeId: string; startedAt: string; endedAt: string | null }>): Array<{ forward: string; comp: ProcessNode }> {
  const out: Array<{ forward: string; comp: ProcessNode; at: string }> = [];
  for (const d of done) {
    const n = def.nodes.find((x) => x.id === d.nodeId);
    const comp = n?.compensate ? def.nodes.find((x) => x.id === n.compensate && x.compensation) : undefined;
    if (comp) out.push({ forward: d.nodeId, comp, at: d.endedAt ?? d.startedAt });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || b.forward.localeCompare(a.forward)).map(({ forward, comp }) => ({ forward, comp }));
}

/** The edges that close a loop in a strict stage: back edges of a DFS from
 *  the start nodes in declaration order (deterministic). */
export function backEdges(def: ProcessDef, stageId: string): ProcessEdge[] {
  const ids = new Set(nodesOf(def, stageId).map((n) => n.id));
  const edges = def.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const out: ProcessEdge[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of edges.filter((x) => x.from === id)) {
      const st = state.get(e.to) ?? 0;
      if (st === 1) out.push(e);
      else if (st === 0) visit(e.to);
    }
    state.set(id, 2);
  };
  const order = [...nodesOf(def, stageId).map((n) => n.id)];
  // Visit from nodes with no incoming edge first, then anything left (a pure cycle).
  const incoming = new Set(edges.map((e) => e.to));
  for (const id of [...order.filter((x) => !incoming.has(x)), ...order]) if (!state.get(id)) visit(id);
  return out;
}

const isBack = (back: ProcessEdge[], e: ProcessEdge) => back.some((b) => b.from === e.from && b.to === e.to);

/** Steps of a strict stage with no forward incoming edge. */
export function startNodes(def: ProcessDef, stageId: string): string[] {
  const back = backEdges(def, stageId);
  const ids = nodesOf(def, stageId).map((n) => n.id);
  const fwdIn = new Set(def.edges.filter((e) => ids.includes(e.from) && ids.includes(e.to) && !isBack(back, e)).map((e) => e.to));
  return ids.filter((id) => !fwdIn.has(id));
}

/** Nodes reachable from `from` over forward edges (including it). */
export function downstream(def: ProcessDef, stageId: string, from: string): string[] {
  const back = backEdges(def, stageId);
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of def.edges.filter((x) => x.from === id && !isBack(back, x))) if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
  }
  return [...seen];
}

// ---- conditions ----

export type Condition = { op: 'eq' | 'ne'; name: string; value: string } | { op: 'set' | 'unset'; name: string };

/** `var == "x"`, `var != 'x'`, `var == x`, `var`, `!var`. Null when unreadable. */
export function parseCondition(src: string): Condition | null {
  const t = src.trim();
  let m = /^([a-z][a-z0-9_]*)\s*(==|!=)\s*(?:"([^"]*)"|'([^']*)'|([\w.-]+))$/i.exec(t);
  if (m) return { op: m[2] === '==' ? 'eq' : 'ne', name: m[1], value: m[3] ?? m[4] ?? m[5] ?? '' };
  m = /^(!)?\s*([a-z][a-z0-9_]*)$/i.exec(t);
  if (m) return { op: m[1] ? 'unset' : 'set', name: m[2] };
  return null;
}

export function holds(when: string | undefined, vars: Record<string, string>): boolean {
  if (!when) return true;
  const c = parseCondition(when);
  if (!c) return false;
  const v = vars[c.name];
  const present = v !== undefined && v !== '' && v !== 'false' && v !== 'no';
  switch (c.op) {
    case 'eq': return (v ?? '').toLowerCase() === c.value.toLowerCase();
    case 'ne': return (v ?? '').toLowerCase() !== c.value.toLowerCase();
    case 'set': return present;
    case 'unset': return !present;
  }
}

// ---- the walk ----

/** A step's current state as the walk sees it. */
export type StepState = 'active' | 'done' | 'skipped' | 'failed' | 'cancelled';

/**
 * Readiness in a strict stage (token semantics with dead-path elimination):
 * a step with no current row is `ready` when every forward incoming edge's
 * source is resolved (done or skipped) and at least one of them fired (its
 * source done and its `when` holds), `skip` when all are resolved and none
 * fired. A start step is ready at once. Repeats until nothing changes, so
 * skips propagate. Pure.
 */
export function strictWalk(def: ProcessDef, stageId: string, current: Map<string, StepState>, vars: Record<string, string>): { ready: string[]; skip: string[] } {
  const back = backEdges(def, stageId);
  const nodes = nodesOf(def, stageId).map((n) => n.id);
  const state = new Map(current);
  const ready: string[] = [];
  const skip: string[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const id of nodes) {
      if (state.has(id)) continue;
      const inc = def.edges.filter((e) => e.to === id && nodes.includes(e.from) && !isBack(back, e));
      if (inc.length === 0) { ready.push(id); state.set(id, 'active'); changed = true; continue; }
      const resolved = inc.every((e) => state.get(e.from) === 'done' || state.get(e.from) === 'skipped');
      if (!resolved) continue;
      if (inc.some((e) => state.get(e.from) === 'done' && holds(e.when, vars))) { ready.push(id); state.set(id, 'active'); }
      else { skip.push(id); state.set(id, 'skipped'); }
      changed = true;
    }
  }
  return { ready, skip };
}

/** Whether a strict stage is finished: every step done or skipped. */
export function strictStageDone(def: ProcessDef, stageId: string, current: Map<string, StepState>): boolean {
  return nodesOf(def, stageId).every((n) => current.get(n.id) === 'done' || current.get(n.id) === 'skipped');
}

/** Steps of a dynamic stage the performer may choose now: not done and not
 *  active, prerequisites done, variables set. Pure. */
export function dynamicAvailable(def: ProcessDef, stageId: string, current: Map<string, StepState>, vars: Record<string, string>): ProcessNode[] {
  return nodesOf(def, stageId).filter((n) => {
    const st = current.get(n.id);
    if (st === 'done' || st === 'active') return false;
    const a = n.availableWhen ?? {};
    if ((a.after ?? []).some((x) => current.get(x) !== 'done')) return false;
    if ((a.vars ?? []).some((v) => !vars[v])) return false;
    if (Object.entries(a.equals ?? {}).some(([k, v]) => (vars[k] ?? '').toLowerCase() !== v.toLowerCase())) return false;
    return true;
  });
}

/** Required checkpoints of a dynamic stage still undone (waived ones excepted). */
export function missingCheckpoints(def: ProcessDef, stageId: string, current: Map<string, StepState>, waived: Set<string> = new Set()): ProcessNode[] {
  return nodesOf(def, stageId).filter((n) => n.required && current.get(n.id) !== 'done' && !waived.has(n.id));
}

/** Replace `${name}` with run variables (unknown names stay visible as ${name}). */
export function fill(text: string | undefined, vars: Record<string, string>): string {
  return (text ?? '').replace(/\$\{([a-z][a-z0-9_]*)\}/gi, (m, k: string) => (vars[k] !== undefined && vars[k] !== '' ? vars[k].slice(0, 500) : m));
}

/** Whether moving a dynamic run to a newer version is safe: the stage it is
 *  in still exists (and is dynamic), and every step it has a row for still
 *  exists. Pure. */
export function canAdopt(next: ProcessDef, stageId: string, stepIds: string[]): boolean {
  const st = next.stages.find((x) => x.id === stageId);
  if (!st || st.mode !== 'dynamic') return false;
  const ids = new Set(next.nodes.map((n) => n.id));
  return stepIds.every((id) => id.startsWith('adhoc-') || id.startsWith('@') || ids.has(id));
}

/** Whether an edit changes what a run must do: MUST items, checkpoints,
 *  approval steps, the strict edges, or denied tools. Pure. */
export function touchesControls(prev: ProcessDef | null, next: ProcessDef): boolean {
  if (!prev) return true;
  const sig = (d: ProcessDef) => JSON.stringify({
    stages: d.stages.map((x) => [x.id, x.mode]),
    nodes: d.nodes.map((n) => [n.id, n.kind, n.stage, n.must ?? [], n.required ?? false, n.deny ?? [], n.approver ?? '', (n.outputs ?? []).filter((o) => o.required).map((o) => o.name), n.compensate ?? '', n.compensation ?? false]).sort(),
    edges: d.edges.map((e) => [e.from, e.to, e.when ?? '', e.loopMax ?? 0]).sort(),
  });
  return sig(prev) !== sig(next);
}

/** A short, line-based diff between two versions for the reviewer and the UI. */
export function diffProcess(prev: ProcessDef | null, next: ProcessDef): string[] {
  if (!prev) return [`new process "${next.title}" with ${next.nodes.length} step(s) in ${next.stages.length} stage(s)`];
  const out: string[] = [];
  if (prev.title !== next.title) out.push(`title: "${prev.title}" → "${next.title}"`);
  if (prev.category !== next.category) out.push(`category: ${prev.category} → ${next.category}`);
  if ((prev.description ?? '') !== (next.description ?? '')) out.push('description changed');
  const trig = (d: ProcessDef) => d.triggers.map((t) => JSON.stringify(t)).sort().join('|');
  if (trig(prev) !== trig(next)) out.push(`triggers: ${describeTriggers(prev.triggers)} → ${describeTriggers(next.triggers)}`);
  for (const st of next.stages) { const p = prev.stages.find((x) => x.id === st.id); if (!p) out.push(`+ stage ${st.id} (${st.mode})`); else if (p.mode !== st.mode) out.push(`stage ${st.id}: ${p.mode} → ${st.mode}`); }
  for (const st of prev.stages) if (!next.stages.some((x) => x.id === st.id)) out.push(`- stage ${st.id}`);
  for (const n of next.nodes) {
    const p = prev.nodes.find((x) => x.id === n.id);
    if (!p) { out.push(`+ step ${n.id} "${n.title}" (${n.kind})`); continue; }
    const fields: Array<keyof ProcessNode> = ['title', 'kind', 'stage', 'lane', 'why', 'outcome', 'doneWhen', 'must', 'should', 'may', 'deny', 'outputs', 'required', 'availableWhen', 'approver', 'question', 'waitHours', 'process', 'meetingKind', 'attendees', 'agenda', 'compensate', 'compensation', 'slaHours', 'maxAttempts', 'checks', 'playbook', 'class'];
    const changed = fields.filter((f) => JSON.stringify(p[f] ?? null) !== JSON.stringify(n[f] ?? null));
    for (const f of changed) {
      if (f === 'must' || f === 'should' || f === 'may') {
        const a = new Set(p[f] ?? []); const b = new Set(n[f] ?? []);
        for (const x of b) if (!a.has(x)) out.push(`step ${n.id} + ${f.toUpperCase()}: ${x}`);
        for (const x of a) if (!b.has(x)) out.push(`step ${n.id} − ${f.toUpperCase()}: ${x}`);
      } else out.push(`step ${n.id} ${String(f)}: ${short(p[f])} → ${short(n[f])}`);
    }
  }
  for (const n of prev.nodes) if (!next.nodes.some((x) => x.id === n.id)) out.push(`- step ${n.id} "${n.title}"`);
  const ek = (e: ProcessEdge) => `${e.from}→${e.to}${e.when ? ` when ${e.when}` : ''}${e.loopMax ? ` (loop ≤${e.loopMax})` : ''}`;
  const pe = new Set(prev.edges.map(ek)); const ne = new Set(next.edges.map(ek));
  for (const x of ne) if (!pe.has(x)) out.push(`+ edge ${x}`);
  for (const x of pe) if (!ne.has(x)) out.push(`- edge ${x}`);
  return out.length ? out : ['no change'];
}
const short = (v: unknown): string => { const t = v === undefined || v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v); return t.length > 80 ? `${t.slice(0, 77)}…` : t; };

export function describeTriggers(ts: ProcessTrigger[]): string {
  return ts.map((t) => {
    const off = 'enabled' in t && t.enabled === false ? ' (off)' : '';
    if (t.kind === 'cadence') return `cadence ${t.cron}${off}`;
    if (t.kind === 'event') return `on ${t.event.replace(/_/g, ' ')}${t.severity ? ` (${t.severity}+)` : ''}${t.class ? ` (class ${t.class})` : ''}${off}`;
    if (t.kind === 'service_request') return `service request${t.service ? ` ${t.service}` : ''}${off}`;
    return 'manual';
  }).join(', ') || 'manual';
}

/** The process's overall mode for the list: strict, dynamic or mixed. */
export function modeOf(def: ProcessDef): ProcessMode | 'mixed' {
  const modes = new Set(def.stages.map((x) => x.mode));
  return modes.size > 1 ? 'mixed' : (def.stages[0]?.mode ?? 'strict');
}

// ---- the step card ----

export interface CardItem { id: string; text: string; level: 'must' | 'should' | 'may'; done: boolean; waived?: boolean }

export interface StepCardInput {
  processTitle: string; version: number; runKey: string; runTitle: string;
  stage: ProcessStage; stageIndex: number; stageCount: number;
  node: ProcessNode; stepNumber: number; stepCount: number;
  inputs: Array<{ name: string; value: string; from: string }>;
  items: CardItem[];
  outputs: Array<{ name: string; required: boolean; value?: string; description?: string }>;
  mustBlocks: boolean;
}

/** The step card the performer sees (docs/processes.md "The step card"). */
export function stepCard(i: StepCardInput): string {
  const lines = [
    `## Process step — ${i.processTitle} v${i.version} · run ${i.runKey}${i.runTitle && i.runTitle !== i.processTitle ? ` "${i.runTitle}"` : ''}`,
    `Stage ${i.stageIndex + 1}/${i.stageCount} "${i.stage.title}" (${i.stage.mode}) · step ${i.stepNumber} of ${i.stepCount}: **${i.node.title}**`,
    i.node.why ? `Why: ${i.node.why}` : '',
    i.inputs.length ? `Inputs from earlier steps:\n${i.inputs.slice(0, 12).map((x) => `- ${x.name} = ${x.value.slice(0, 300)} (from "${x.from}")`).join('\n')}` : '',
  ];
  const by = (lvl: CardItem['level']) => i.items.filter((x) => x.level === lvl);
  const row = (x: CardItem) => `- [${x.done ? 'x' : x.waived ? '~' : ' '}] ${x.id}. ${x.text}${x.waived ? ' (waived)' : ''}`;
  if (by('must').length) lines.push(`MUST — ${i.mustBlocks ? 'review is refused while one is open' : 'an open one is logged as a deviation'}; tick each with org_task_steps done=<id> once it is true, or ask to waive it with org_process_deviate level=must:\n${by('must').map(row).join('\n')}`);
  if (by('should').length) lines.push(`SHOULD — do them; to skip one call org_process_deviate level=should with the reason and what you did instead:\n${by('should').map(row).join('\n')}`);
  if (by('may').length) lines.push(`MAY — options, use your judgment:\n${by('may').map(row).join('\n')}`);
  if (i.node.deny?.length) lines.push(`Not in this step: ${i.node.deny.join(', ')} (refused if called).`);
  if (i.outputs.length) lines.push(`Outputs — record each with org_step_output {name, value}${i.outputs.some((o) => o.required) ? '; required ones are checked at review' : ''}:\n${i.outputs.map((o) => `- ${o.name}${o.required ? ' (required)' : ''}${o.description ? `: ${o.description}` : ''}${o.value ? ` — recorded: ${o.value.slice(0, 120)}` : ''}`).join('\n')}`);
  if (i.node.playbook) lines.push(`Playbook: load the "${i.node.playbook}" skill for the detail of how.`);
  lines.push(`Exit: ${i.node.doneWhen || 'the outcome above is true'}. Finish with org_request_review, with evidence for each MUST item in the note.`);
  return lines.filter(Boolean).join('\n');
}

/** Card items from a node, with stable ids that match the task's checklist (m1, s1, y1). */
export function itemsOf(node: ProcessNode): Array<{ id: string; text: string; level: CardItem['level'] }> {
  return [
    ...(node.must ?? []).map((t, k) => ({ id: `m${k + 1}`, text: t, level: 'must' as const })),
    ...(node.should ?? []).map((t, k) => ({ id: `s${k + 1}`, text: t, level: 'should' as const })),
    ...(node.may ?? []).map((t, k) => ({ id: `y${k + 1}`, text: t, level: 'may' as const })),
  ];
}

// ---- metrics ----

export interface RunFacts { status: string; startedAt: string; endedAt: string | null }
export interface StepFacts { nodeId: string; status: string; attempt: number; deviations: number; reviewRounds: number; slaBreached: boolean; startedAt: string; endedAt: string | null }

export interface ProcessMetrics {
  runs: number; active: number; done: number; failed: number; cancelled: number;
  completionRate: number | null;
  cycleHoursP50: number | null;
  deviationRate: number | null;
  reworkRate: number | null;
  slaBreaches: number;
  steps: Array<{ nodeId: string; executions: number; deviations: number; deviationRate: number; rework: number; failures: number; hoursP50: number | null }>;
  health: 'new' | 'healthy' | 'watch' | 'revise';
  why: string;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const hours = (a: string, b: string | null) => (b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 3_600_000) : NaN);

/** Runs, completion rate, cycle time, deviation rate per step, rework and a
 *  health verdict against the company's revise threshold. Pure. */
export function computeMetrics(runs: RunFacts[], steps: StepFacts[], opts: { reviseDeviationRate: number; minSample?: number }): ProcessMetrics {
  const min = opts.minSample ?? 3;
  const done = runs.filter((r) => r.status === 'done');
  const failed = runs.filter((r) => r.status === 'failed').length;
  const cancelled = runs.filter((r) => r.status === 'cancelled').length;
  const finished = done.length + failed + cancelled;
  const executed = steps.filter((x) => x.status === 'done' || x.status === 'failed');
  const byNode = new Map<string, StepFacts[]>();
  for (const x of executed) byNode.set(x.nodeId, [...(byNode.get(x.nodeId) ?? []), x]);
  const perStep = [...byNode.entries()].map(([nodeId, xs]) => {
    const deviations = xs.filter((x) => x.deviations > 0).length;
    return {
      nodeId, executions: xs.length, deviations, deviationRate: xs.length ? deviations / xs.length : 0,
      rework: xs.filter((x) => x.attempt > 1 || x.reviewRounds > 0).length, failures: xs.filter((x) => x.status === 'failed').length,
      hoursP50: median(xs.map((x) => hours(x.startedAt, x.endedAt)).filter(Number.isFinite)),
    };
  });
  const completionRate = finished ? done.length / finished : null;
  const deviationRate = executed.length ? executed.filter((x) => x.deviations > 0).length / executed.length : null;
  const reworkRate = executed.length ? executed.filter((x) => x.attempt > 1 || x.reviewRounds > 0).length / executed.length : null;
  const slaBreaches = steps.filter((x) => x.slaBreached).length;
  const hot = perStep.filter((x) => x.executions >= min && x.deviationRate >= opts.reviseDeviationRate);
  let health: ProcessMetrics['health'] = 'healthy';
  let why = 'runs complete and steps are followed';
  if (runs.length === 0) { health = 'new'; why = 'no runs yet'; }
  else if (hot.length) { health = 'revise'; why = `step ${hot.map((x) => `${x.nodeId} deviates in ${Math.round(x.deviationRate * 100)}% of runs`).join(', ')} — the standard may be wrong, not the performers`; }
  else if (finished >= min && completionRate !== null && completionRate < 0.5) { health = 'revise'; why = `only ${Math.round(completionRate * 100)}% of finished runs completed`; }
  else if (failed > 0 || slaBreaches > 0 || (reworkRate ?? 0) >= 0.5) { health = 'watch'; why = [failed ? `${failed} failed run(s)` : '', slaBreaches ? `${slaBreaches} SLA breach(es)` : '', (reworkRate ?? 0) >= 0.5 ? 'half the steps were reworked' : ''].filter(Boolean).join(', '); }
  return {
    runs: runs.length, active: runs.filter((r) => r.status === 'running' || r.status === 'blocked').length, done: done.length, failed, cancelled,
    completionRate, cycleHoursP50: median(done.map((r) => hours(r.startedAt, r.endedAt)).filter(Number.isFinite)), deviationRate, reworkRate, slaBreaches,
    steps: perStep.sort((a, b) => b.deviationRate - a.deviationRate), health, why,
  };
}

// ---- ramped rollout: two cohorts compared ----

/** A run's bucket 0–99 for a ramp (deterministic per key). Pure. */
export function rampBucket(key: string): number {
  return parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) % 100;
}

export type RampVerdict = 'collecting' | 'promote' | 'rollback';
export interface CohortRow { metric: 'completion' | 'cycle' | 'deviation' | 'rework'; stable: number | null; candidate: number | null; worse: boolean }
export interface CohortComparison { verdict: RampVerdict; why: string; rows: CohortRow[]; stableFinished: number; candidateFinished: number }

const finishedOf = (m: ProcessMetrics) => m.done + m.failed + m.cancelled;

/**
 * Compare a candidate version's runs with the stable version's: completion
 * rate, median cycle time, deviation rate and rework. `collecting` until the
 * candidate has `minRuns` finished runs; then `rollback` when any measure is
 * worse than the stable one by more than `tolerance` (a share for the rates,
 * a fraction of the stable cycle time), else `promote`. Pure.
 */
export function compareCohorts(stable: ProcessMetrics, candidate: ProcessMetrics, opts: { minRuns: number; tolerance: number }): CohortComparison {
  const tol = opts.tolerance;
  const both = (a: number | null, b: number | null) => a !== null && b !== null;
  const rows: CohortRow[] = [
    { metric: 'completion', stable: stable.completionRate, candidate: candidate.completionRate, worse: both(stable.completionRate, candidate.completionRate) && candidate.completionRate! < stable.completionRate! - tol },
    { metric: 'cycle', stable: stable.cycleHoursP50, candidate: candidate.cycleHoursP50, worse: both(stable.cycleHoursP50, candidate.cycleHoursP50) && candidate.cycleHoursP50! > stable.cycleHoursP50! * (1 + tol) },
    { metric: 'deviation', stable: stable.deviationRate, candidate: candidate.deviationRate, worse: both(stable.deviationRate, candidate.deviationRate) && candidate.deviationRate! > stable.deviationRate! + tol },
    { metric: 'rework', stable: stable.reworkRate, candidate: candidate.reworkRate, worse: both(stable.reworkRate, candidate.reworkRate) && candidate.reworkRate! > stable.reworkRate! + tol },
  ];
  const sf = finishedOf(stable); const cf = finishedOf(candidate);
  const base = { rows, stableFinished: sf, candidateFinished: cf };
  if (cf < opts.minRuns) return { ...base, verdict: 'collecting', why: `${cf} of ${opts.minRuns} candidate run(s) finished` };
  // Nothing to compare against: judge the candidate on its own.
  if (sf === 0) {
    const ok = (candidate.completionRate ?? 0) >= 0.5 && candidate.health !== 'revise';
    return { ...base, verdict: ok ? 'promote' : 'rollback', why: ok ? 'the stable version has no finished runs; the candidate completes' : `the candidate ${candidate.health === 'revise' ? candidate.why : 'completes under half its runs'}` };
  }
  const label: Record<CohortRow['metric'], string> = { completion: 'completion', cycle: 'cycle time', deviation: 'deviation', rework: 'rework' };
  const worse = rows.filter((r) => r.worse);
  if (worse.length) return { ...base, verdict: 'rollback', why: `the candidate is worse on ${worse.map((r) => label[r.metric]).join(', ')}` };
  return { ...base, verdict: 'promote', why: `the candidate is no worse on completion, cycle time, deviation or rework (tolerance ${Math.round(tol * 100)}%)` };
}

// ---- conformance: did runs follow the definition ----

export interface ConformanceFacts {
  runId: string; nodeId: string; strict: boolean; adHoc: boolean; status: string;
  deviations: Array<{ level: string; status: string }>;
  /** A strict step that started before a step it waits on finished. */
  outOfOrder: boolean;
}

export interface ProcessConformance {
  runs: number; conformantRuns: number; fitness: number | null;
  checked: number; conformant: number; rate: number | null;
  mustOpen: number; waivers: number; waiversPending: number; shouldSkips: number; adHoc: number; outOfOrder: number;
  steps: Array<{ nodeId: string; checked: number; mustOpen: number; waivers: number; shouldSkips: number; adHoc: number; outOfOrder: number; rate: number }>;
  verdict: 'new' | 'conforms' | 'drifting';
  why: string;
}

/**
 * Conformance, separate from outcomes: of the steps the runs executed, how
 * many followed the definition. Against it count MUST items handed to review
 * open (logged where `process.mustEnforcement` is 0), SHOULD skips, ad-hoc
 * steps in dynamic stages and out-of-order steps in strict stages; MUST
 * waivers are sanctioned exceptions, counted but not against it. A run
 * conforms when every step it executed did. Pure.
 */
export function computeConformance(facts: ConformanceFacts[], opts: { alertBelow: number; minSample?: number }): ProcessConformance {
  const executed = facts.filter((f) => f.status === 'done' || f.status === 'failed' || f.status === 'active');
  const off = (f: ConformanceFacts) => f.adHoc || f.outOfOrder || f.deviations.some((d) => (d.level === 'must' && d.status === 'logged') || d.level === 'should');
  const count = (xs: ConformanceFacts[]) => ({
    mustOpen: xs.reduce((n, f) => n + f.deviations.filter((d) => d.level === 'must' && d.status === 'logged').length, 0),
    waivers: xs.reduce((n, f) => n + f.deviations.filter((d) => d.level === 'must' && d.status === 'approved').length, 0),
    waiversPending: xs.reduce((n, f) => n + f.deviations.filter((d) => d.level === 'must' && d.status === 'pending').length, 0),
    shouldSkips: xs.reduce((n, f) => n + f.deviations.filter((d) => d.level === 'should').length, 0),
    adHoc: xs.filter((f) => f.adHoc).length,
    outOfOrder: xs.filter((f) => f.outOfOrder).length,
  });
  const byNode = new Map<string, ConformanceFacts[]>();
  for (const f of executed) { const k = f.adHoc ? 'ad-hoc' : f.nodeId; byNode.set(k, [...(byNode.get(k) ?? []), f]); }
  const steps = [...byNode.entries()].map(([nodeId, xs]) => { const c = count(xs); return { nodeId, checked: xs.length, mustOpen: c.mustOpen, waivers: c.waivers, shouldSkips: c.shouldSkips, adHoc: c.adHoc, outOfOrder: c.outOfOrder, rate: xs.filter((f) => !off(f)).length / xs.length }; })
    .sort((a, b) => a.rate - b.rate || b.checked - a.checked);
  const runIds = [...new Set(executed.map((f) => f.runId))];
  const conformantRuns = runIds.filter((r) => executed.filter((f) => f.runId === r).every((f) => !off(f))).length;
  const conformant = executed.filter((f) => !off(f)).length;
  const rate = executed.length ? conformant / executed.length : null;
  const c = count(executed);
  let verdict: ProcessConformance['verdict'] = 'conforms';
  let why = 'runs follow the definition';
  if (executed.length < (opts.minSample ?? 3)) { verdict = 'new'; why = 'too few steps executed to judge'; }
  else if (rate !== null && rate < opts.alertBelow) {
    verdict = 'drifting';
    const worst = steps.filter((x) => x.rate < opts.alertBelow).slice(0, 3);
    why = `${Math.round(rate * 100)}% of steps followed the definition (alert below ${Math.round(opts.alertBelow * 100)}%)${worst.length ? ` — ${worst.map((x) => `${x.nodeId} ${Math.round(x.rate * 100)}%`).join(', ')}` : ''}`;
  }
  return { runs: runIds.length, conformantRuns, fitness: runIds.length ? conformantRuns / runIds.length : null, checked: executed.length, conformant, rate, ...c, steps, verdict, why };
}
