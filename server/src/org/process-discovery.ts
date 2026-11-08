/**
 * Process discovery from experience, the pure half (docs/processes.md
 * "Discovery"; reports/Process abstractions for agent companies.md, "procedures
 * can be learned from the company's own traces" — Agent Workflow Memory,
 * applied model-free first).
 *
 * Mines the task history and the process event log for work that repeats
 * without a process: the same title stem recurring on several days, the same
 * sequence of tasks (a dependency or the next sibling under one parent)
 * across several chains, the same request made of one department by members
 * of others, and the same ad-hoc step added to a process's dynamic stage run
 * after run. Each pattern seen at least `minRepeats` times becomes a
 * suggestion with its evidence and — for a new process — a drafted
 * definition the owner refines (the engine drafts the skeleton; an agent
 * writes the body through an ordinary task). No model, no I/O.
 */
import { normalizeProcess, validateProcess, type ProcessDef, type ProcessNode } from './process-model';

const STOP = new Set(['the', 'and', 'for', 'from', 'with', 'into', 'about', 'our', 'new', 'this', 'that', 'are', 'per', 'via', 'its', 'all', 'any', 'out']);

/** The significant words of a title: task keys, quoted names, dates,
 *  versions and numbers dropped. Pure. */
export function titleWords(title: string): string[] {
  return (title ?? '')
    .replace(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, ' ')
    .replace(/"[^"]*"|“[^”]*”|'[^']*'/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\bv\d+(?:\.\d+)*\b|\b\d+(?:[.,]\d+)*\b/gi, ' ')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** The stem two titles of the same kind of work share: their first two significant words. */
export function titleStem(title: string): string | null {
  const w = titleWords(title).slice(0, 2);
  return w.length === 2 ? w.join(' ') : null;
}

export interface TaskFact {
  id: string; ref: string; title: string; createdAt: string; class: string | null;
  unitId: string | null; parentTaskId: string | null; dependsOn: string[];
  /** The creating member's unit (null for a person or the system). */
  creatorUnitId: string | null;
  assigneeTitle: string | null; doneWhen: string;
}
export interface AdHocFact { processId: string; runId: string; stage: string; title: string; at: string }

export type PatternKind = 'recurring' | 'sequence' | 'cross_function' | 'adhoc_step';
export interface DiscoveredPattern {
  kind: PatternKind;
  /** Stable dedupe key: the same pattern is suggested once. */
  key: string;
  label: string;
  count: number;
  unitId: string | null;
  processId?: string;
  stage?: string;
  /** Step titles in order (the sequence), else the one kind of work. */
  steps: string[];
  class: string | null;
  lane: string | null;
  doneWhen: string;
  evidence: Array<{ ref: string; title: string; at: string }>;
}

const majority = <T>(xs: T[]): T | null => {
  const m = new Map<T, number>();
  for (const x of xs) if (x !== null && x !== undefined && x !== '') m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/** A readable label: the words every title of the group starts with, else the stem. */
function labelOf(titles: string[], stem: string): string {
  const split = titles.map((t) => t.replace(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, '').split(/\s+/).filter(Boolean));
  const first = split[0] ?? [];
  let n = 0;
  while (n < first.length && split.every((w) => (w[n] ?? '').toLowerCase() === first[n].toLowerCase())) n++;
  const prefix = first.slice(0, n).join(' ').replace(/[\s:–—·,-]+$/, '');
  const words = titleWords(prefix);
  if (words.length >= 2 && words.slice(0, 2).join(' ') === stem) return prefix.slice(0, 80);
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

const evidenceOf = (xs: TaskFact[]) => xs.slice(0, 8).map((t) => ({ ref: t.ref, title: t.title.slice(0, 120), at: t.createdAt }));

export interface MineOpts {
  minRepeats: number;
  /** Stems (and words) an existing process already covers. */
  covered: (stem: string) => boolean;
  /** Departments that already take requests (an intake process). */
  intakeUnits?: Set<string>;
}

/**
 * The patterns in the history. Recurring work needs at least two distinct
 * days (a plan that made four tasks at once is not a routine); a sequence
 * counts distinct chains; a cross-function request counts tasks a member of
 * another department created for this one; an ad-hoc step counts distinct
 * runs of one process. Pure; ordered by count.
 */
export function minePatterns(tasks: TaskFact[], adHoc: AdHocFact[], opts: MineOpts): DiscoveredPattern[] {
  const n = Math.max(2, Math.round(opts.minRepeats));
  const out: DiscoveredPattern[] = [];
  const stemOf = new Map(tasks.map((t) => [t.id, titleStem(t.title)]));
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Sequences: a dependency, or the next sibling under one parent.
  const pairs = new Map<string, Set<string>>();
  const pairTasks = new Map<string, TaskFact[]>();
  const addPair = (a: TaskFact, b: TaskFact, chain: string) => {
    const sa = stemOf.get(a.id); const sb = stemOf.get(b.id);
    if (!sa || !sb || sa === sb) return;
    const k = `${sa}>${sb}`;
    pairs.set(k, (pairs.get(k) ?? new Set()).add(chain));
    pairTasks.set(k, [...(pairTasks.get(k) ?? []), b]);
  };
  for (const t of tasks) for (const d of t.dependsOn) { const dep = byId.get(d); if (dep) addPair(dep, t, `dep:${t.id}`); }
  const byParent = new Map<string, TaskFact[]>();
  for (const t of tasks) if (t.parentTaskId) byParent.set(t.parentTaskId, [...(byParent.get(t.parentTaskId) ?? []), t]);
  for (const [parent, kids] of byParent) {
    const sorted = [...kids].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (let i = 1; i < sorted.length; i++) addPair(sorted[i - 1], sorted[i], `parent:${parent}`);
  }
  const frequent = new Map([...pairs.entries()].filter(([, chains]) => chains.size >= n).map(([k, chains]) => [k, chains.size]));
  const next = new Map<string, Array<{ to: string; n: number }>>();
  for (const [k, c] of frequent) { const [a, b] = k.split('>'); next.set(a, [...(next.get(a) ?? []), { to: b, n: c }].sort((x, y) => y.n - x.n)); }
  const hasIn = new Set([...frequent.keys()].map((k) => k.split('>')[1]));
  const inSequence = new Set<string>();
  for (const start of [...next.keys()].filter((a) => !hasIn.has(a)).concat([...next.keys()].filter((a) => hasIn.has(a)))) {
    if (inSequence.has(start)) continue;
    const chain = [start];
    while (chain.length < 6) { const nx = (next.get(chain[chain.length - 1]) ?? []).find((x) => !chain.includes(x.to)); if (!nx) break; chain.push(nx.to); }
    if (chain.length < 2 || chain.every((x) => inSequence.has(x))) continue;
    for (const x of chain) inSequence.add(x);
    const firstPair = `${chain[0]}>${chain[1]}`;
    const ev = pairTasks.get(firstPair) ?? [];
    const count = Math.min(...chain.slice(1).map((b, i) => frequent.get(`${chain[i]}>${b}`) ?? 0));
    if (chain.every((x) => opts.covered(x))) continue;
    const stepTitles = chain.map((stem) => labelOf(tasks.filter((t) => stemOf.get(t.id) === stem).map((t) => t.title), stem));
    out.push({
      kind: 'sequence', key: `sequence:${chain.join('>')}`, label: stepTitles.join(' → ').slice(0, 120), count, unitId: majority(ev.map((t) => t.unitId)),
      steps: stepTitles, class: majority(ev.map((t) => t.class)), lane: majority(ev.map((t) => t.assigneeTitle)), doneWhen: '', evidence: evidenceOf(ev),
    });
  }

  // Recurring work and cross-function requests.
  const groups = new Map<string, TaskFact[]>();
  for (const t of tasks) { const st = stemOf.get(t.id); if (st) groups.set(st, [...(groups.get(st) ?? []), t]); }
  for (const [stem, xs] of groups) {
    if (inSequence.has(stem) || opts.covered(stem)) continue;
    const cross = xs.filter((t) => t.unitId && t.creatorUnitId && t.creatorUnitId !== t.unitId);
    const target = majority(cross.map((t) => t.unitId));
    const toTarget = cross.filter((t) => t.unitId === target);
    if (target && toTarget.length >= n && !opts.intakeUnits?.has(target)) {
      out.push({
        kind: 'cross_function', key: `cross:${target}:${stem}`, label: labelOf(toTarget.map((t) => t.title), stem), count: toTarget.length, unitId: target,
        steps: [labelOf(toTarget.map((t) => t.title), stem)], class: majority(toTarget.map((t) => t.class)), lane: majority(toTarget.map((t) => t.assigneeTitle)),
        doneWhen: majority(toTarget.map((t) => t.doneWhen)) ?? '', evidence: evidenceOf(toTarget),
      });
      continue;
    }
    const days = new Set(xs.map((t) => t.createdAt.slice(0, 10)));
    if (xs.length < n || days.size < 2) continue;
    out.push({
      kind: 'recurring', key: `recurring:${stem}`, label: labelOf(xs.map((t) => t.title), stem), count: xs.length, unitId: majority(xs.map((t) => t.unitId)),
      steps: [labelOf(xs.map((t) => t.title), stem)], class: majority(xs.map((t) => t.class)), lane: majority(xs.map((t) => t.assigneeTitle)),
      doneWhen: majority(xs.map((t) => t.doneWhen)) ?? '', evidence: evidenceOf(xs),
    });
  }

  // The same ad-hoc step in run after run of one process: a step the definition is missing.
  const adhocGroups = new Map<string, AdHocFact[]>();
  for (const a of adHoc) { const k = `${a.processId}|${titleStem(a.title) ?? a.title.toLowerCase().trim()}`; adhocGroups.set(k, [...(adhocGroups.get(k) ?? []), a]); }
  for (const [k, xs] of adhocGroups) {
    const runs = new Set(xs.map((x) => x.runId));
    if (runs.size < n) continue;
    const [processId, stem] = k.split('|');
    out.push({
      kind: 'adhoc_step', key: `adhoc:${processId}:${stem}`, label: labelOf(xs.map((x) => x.title), stem), count: runs.size, unitId: null, processId, stage: majority(xs.map((x) => x.stage)) ?? undefined,
      steps: [labelOf(xs.map((x) => x.title), stem)], class: null, lane: null, doneWhen: '', evidence: xs.slice(0, 8).map((x) => ({ ref: x.runId, title: x.title.slice(0, 120), at: x.at })),
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

const slugId = (title: string, used: Set<string>): string => {
  const base = (titleWords(title).slice(0, 3).join('-') || 'step').slice(0, 28).replace(/^[^a-z]+/, '') || 'step';
  let id = base; let i = 2;
  while (used.has(id)) id = `${base}-${i++}`;
  used.add(id);
  return id;
};

/**
 * A drafted definition for a new-process pattern (null for an ad-hoc step,
 * which is a revision of an existing process): a strict stage of the steps
 * seen, each in the lane its tasks went to, with the most common exit; a
 * cross-function request becomes an intake with triage and a hand-back,
 * started by a service request. Valid by construction; the owner refines it.
 */
export function draftProcess(p: DiscoveredPattern): ProcessDef | null {
  if (p.kind === 'adhoc_step') return null;
  const used = new Set<string>();
  const lane = p.lane ?? 'owner';
  const evidence = `Drafted from ${p.count} ${p.kind === 'sequence' ? 'chains of tasks' : 'tasks'} (${p.evidence.slice(0, 4).map((e) => e.ref).join(', ')}${p.count > 4 ? ', …' : ''}).`;
  let nodes: ProcessNode[];
  let triggers: ProcessDef['triggers'] = [{ kind: 'manual' }];
  let category: ProcessDef['category'] = 'delivery';
  if (p.kind === 'cross_function') {
    category = 'operating';
    triggers = [{ kind: 'manual' }, { kind: 'service_request', service: titleWords(p.label).slice(0, 3).join('-') || undefined }];
    nodes = [
      { id: 'triage', title: `Triage the request: ${p.label}`.slice(0, 120), kind: 'task', lane: 'head', why: 'requests from other departments are accepted, scoped or declined once, by the owner', must: ['The request has an outcome and a done-when'], outputs: [{ name: 'accepted', required: true }] },
      { id: 'do', title: p.label.slice(0, 120), kind: 'task', lane, doneWhen: p.doneWhen || undefined, why: 'the work the other departments keep asking for' },
      { id: 'handback', title: 'Hand the result back to the requester', kind: 'task', lane: 'initiator', must: ['The requester confirms it meets the request'] },
    ];
    for (const x of nodes) used.add(x.id);
  } else {
    nodes = p.steps.map((title, i) => ({ id: slugId(title, used), title: title.slice(0, 120), kind: 'task' as const, lane: i === 0 || p.kind === 'recurring' ? lane : 'owner', ...(p.doneWhen && p.kind === 'recurring' ? { doneWhen: p.doneWhen.slice(0, 600) } : {}), why: 'a step the company already does by hand, run after run' }));
  }
  const edges = nodes.slice(1).map((x, i) => ({ from: nodes[i].id, to: x.id, ...(p.kind === 'cross_function' && x.id === 'do' ? { when: 'accepted' } : {}) }));
  const def = normalizeProcess({ title: p.label.slice(0, 120), description: evidence, category, owner: p.unitId ? 'head' : 'chief', triggers, stages: [{ id: 'main', title: 'Main', mode: 'strict' }], nodes, edges });
  return validateProcess(def).length ? null : def;
}
