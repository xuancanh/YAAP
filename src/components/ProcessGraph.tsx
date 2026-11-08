/** A process definition as a readable graph (docs/processes.md §1): stages
 *  stacked in the order they run; inside each, swimlanes by role (a lane is
 *  a role, never an agent) and columns in the order the engine walks them,
 *  with arrows between steps — solid for the graph, dashed when an edge
 *  holds only on a condition, dotted for a dynamic step's "available
 *  after", a loop curving back underneath with its bound. Each step is a
 *  card: its kind, MUST items, checkpoint, timer or SLA, the approval it
 *  asks, the meeting it holds, whether it can be undone. A run can be laid
 *  over it (each step's state). Too narrow for the lanes, it falls back to
 *  a vertical list. Clicking a step opens its detail under the graph.
 *  Pure layout: src/lib/processes.ts (stageLayout, runStates). */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProcessDef, ProcessNodeDef } from '../lib/api';
import { KIND_WORD, MODE_HINT, compensationsOf, conditionWords, edgeWords, hrs, laneOf, laneTitle, meetingWords, stageLayout, STEP_STATE_WORD, type StageLayout, type StepState } from '../lib/processes';
import { I, P } from '../lib/icons';
import { InfoButton } from './CompanyKit';
import '../styles/processes.css';

export const PI = {
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  flag: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  approval: ['M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z', 'm9 12 2 2 4-4'],
  meeting: ['M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1', 'M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6', 'M21 19v-1a4 4 0 0 0-3-3.9', 'M16 4.1a3 3 0 0 1 0 5.8'],
  task: ['M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'm8.5 12 2.5 2.5 4.5-5'],
  sub: ['M4 4h7v7H4z', 'M13 13h7v7h-7z', 'M7.5 11v4.5H13'],
  timer: ['M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16', 'M12 9v4l2.5 1.5', 'M9.5 2h5'],
};
const KIND_ICON: Record<string, string[]> = { task: PI.task, approval: PI.approval, wait: PI.timer, meeting: PI.meeting, subprocess: PI.sub, compensation: PI.undo };

export interface StepOverlay { state: StepState; rounds: number; who?: string; note?: string }

interface Props {
  def: ProcessDef;
  /** How often runs deviate at each step (the outcomes' per-step figures). */
  deviation?: Map<string, number>;
  /** A run laid over the graph: each step's state. */
  overlay?: Map<string, StepOverlay> | null;
  /** The owner's name, shown beside the Owner lane. */
  ownerName?: string;
  /** Extra detail for a selected step (the run's task, its deviations). */
  stepExtra?: (nodeId: string) => ReactNode;
  /** A smaller graph without the detail panel (the library preview, the editor's preview). */
  compact?: boolean;
  testid?: string;
}

const LANE_W = 116;
const COL_MIN = 160;
const COL_MAX = 250;
const GAP = 38;

export function ProcessGraph({ def, deviation, overlay, ownerName, stepExtra, compact, testid = 'process-graph' }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layouts = useMemo(() => def.stages.map((s) => ({ stage: s, layout: stageLayout(def, s.id) })), [def]);
  const comps = useMemo(() => compensationsOf(def), [def]);
  const widest = Math.max(1, ...layouts.map((l) => l.layout.cols.length));
  // jsdom has no layout (width 0): the lanes there, so tests read the same graph.
  const lanes = width === 0 || width >= LANE_W + widest * COL_MIN + (widest - 1) * GAP;
  const selected = sel ? def.nodes.find((n) => n.id === sel) ?? null : null;
  const toggle = useCallback((id: string) => setSel((s) => (s === id ? null : id)), []);
  return (
    <div className={`pg${compact ? ' compact' : ''}${overlay ? ' overlay' : ''}`} ref={box} data-testid={testid} data-layout={lanes ? 'lanes' : 'list'}>
      {layouts.map(({ stage, layout }, i) => (
        <section key={stage.id} className="pg-stage" aria-label={`Stage ${i + 1}: ${stage.title}`}>
          <header className="pg-stage-head">
            <span className="pg-stage-n" aria-hidden>{i + 1}</span>
            <span className="pg-stage-title">{stage.title}</span>
            <span className={`pg-mode ${stage.mode}`} title={MODE_HINT[stage.mode]}>{stage.mode === 'strict' ? 'Follows the graph' : 'Performer chooses'}</span>
            {stage.mode === 'dynamic' && !compact && <span className="pg-stage-hint">Steps open up as their prerequisites finish; <I d={PI.flag} size={11} /> checkpoints must be done to finish the stage.</span>}
          </header>
          {layout.cols.length === 0
            ? <div className="pg-empty">No steps in this stage.</div>
            : lanes
              ? <Lanes roomy={width === 0 || width >= LANE_W + widest * (COL_MAX + GAP)} def={def} layout={layout} ownerName={ownerName} deviation={deviation} overlay={overlay} sel={sel} onSel={toggle} />
              : <ListStage def={def} layout={layout} dynamic={stage.mode === 'dynamic'} deviation={deviation} overlay={overlay} sel={sel} onSel={toggle} ownerName={ownerName} />}
          {!compact && selected && (selected.stage ?? def.stages[0]?.id) === stage.id && !selected.compensation && (
            <StepDetail def={def} n={selected} ownerName={ownerName} extra={stepExtra?.(selected.id)} onClose={() => setSel(null)} />
          )}
          {i < layouts.length - 1 && <div className="pg-then" aria-hidden><span>then</span></div>}
        </section>
      ))}
      {comps.length > 0 && (
        <section className="pg-stage pg-undo" aria-label="If a run fails or is cancelled" data-testid="process-compensations">
          <header className="pg-stage-head">
            <span className="pg-stage-n undo" aria-hidden><I d={PI.undo} size={12} /></span>
            <span className="pg-stage-title">If a run fails or is cancelled</span>
            {!compact && <span className="pg-stage-hint">What was done is undone, latest first, each by its own task.</span>}
          </header>
          <div className="pg-undo-rows">
            {comps.map(({ comp, undoes }) => {
              const o = overlay?.get(comp.id);
              return (
                <div key={comp.id} className="pg-undo-row" data-testid="process-compensation">
                  <span className="pg-undo-from">{undoes.map((u) => u.title).join(', ') || '—'}</span>
                  <span className="pg-undo-arrow" aria-label="is undone by"><I d={PI.undo} size={13} /></span>
                  <button type="button" className={`pg-undo-card${sel === comp.id ? ' on' : ''}`} data-state={o?.state} onClick={() => toggle(comp.id)} aria-pressed={sel === comp.id}>
                    <b>{comp.title}</b>
                    <span>{laneTitle(laneOf(comp))}{comp.must?.length ? ` · ${comp.must.length} MUST` : ''}{o ? ` · ${STEP_STATE_WORD[o.state]}` : ''}</span>
                  </button>
                </div>
              );
            })}
          </div>
          {!compact && selected?.compensation && <StepDetail def={def} n={selected} ownerName={ownerName} extra={stepExtra?.(selected.id)} onClose={() => setSel(null)} />}
        </section>
      )}
    </div>
  );
}

/** How to read the graph, behind an (i). */
export function GraphLegend() {
  return (
    <InfoButton label="How to read the graph">
      <span className="pg-legend">
        <span><span className="pg-tag must">2 MUST</span> items the performer cannot skip without a waiver</span>
        <span><span className="pg-tag flag"><I d={PI.flag} size={10} />Checkpoint</span> the stage cannot finish without it</span>
        <span><span className="pg-tag"><I d={PI.timer} size={10} />4h</span> a timer, or the step's deadline (SLA)</span>
        <span><span className="pg-tag undo"><I d={PI.undo} size={10} />Undoable</span> undone if a run fails</span>
        <span><svg width="34" height="8" aria-hidden><path d="M0 4h34" stroke="currentColor" strokeWidth="1.6" strokeDasharray="5 4" /></svg> only on a condition; <svg width="34" height="8" aria-hidden><path d="M0 4h34" stroke="currentColor" strokeWidth="1.6" strokeDasharray="1.5 4" strokeLinecap="round" /></svg> available after</span>
        <span>Rows are roles, not people: the process outlives hires and reorgs.</span>
      </span>
    </InfoButton>
  );
}

// ---- the swimlane grid ----

interface Path { d: string; dash?: string; loop: boolean; label?: { x: number; y: number; text: string }; state?: 'done' | 'live' }

function Lanes({ roomy, def, layout, ownerName, deviation, overlay, sel, onSel }: { def: ProcessDef; layout: StageLayout; ownerName?: string; deviation?: Map<string, number>; overlay?: Map<string, StepOverlay> | null; sel: string | null; onSel: (id: string) => void; roomy: boolean }) {
  const grid = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<Path[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const hasLoop = layout.edges.some((e) => e.loop);
  const measure = useCallback(() => {
    const g = grid.current;
    if (!g) return;
    const base = g.getBoundingClientRect();
    if (!base.width) return;
    const r = (id: string) => { const el = refs.current.get(id); if (!el) return null; const b = el.getBoundingClientRect(); return { l: b.left - base.left, r: b.right - base.left, t: b.top - base.top, b: b.bottom - base.top, cx: b.left - base.left + b.width / 2, cy: b.top - base.top + b.height / 2 }; };
    const out: Path[] = [];
    const floor = Math.max(0, ...[...refs.current.keys()].map((id) => r(id)?.b ?? 0));
    for (const e of layout.edges) {
      const a = r(e.from); const b = r(e.to);
      if (!a || !b) continue;
      const sa = overlay?.get(e.from)?.state; const sb = overlay?.get(e.to)?.state;
      const state = sa === 'done' && sb && sb !== 'pending' ? (sb === 'active' ? 'live' : 'done') : undefined;
      if (e.loop) {
        const y = floor + 22;
        const x1 = a.cx; const x2 = b.cx + 10;
        out.push({ d: `M${x1} ${a.b} C${x1} ${y} ${x2} ${y} ${x2} ${b.b + 6}`, dash: '5 4', loop: true, label: { x: (x1 + x2) / 2, y: floor + 17, text: e.loopMax ? `up to ${e.loopMax}×` : 'loop' } });
        continue;
      }
      const x1 = a.r; const x2 = b.l - 6;
      if (x2 <= x1) { out.push({ d: `M${a.cx} ${a.b} L${b.cx} ${b.t - 6}`, dash: e.dotted ? '1.5 4' : e.label ? '5 4' : undefined, loop: false, state }); continue; }
      const dx = Math.max(16, (x2 - x1) / 2);
      out.push({ d: `M${x1} ${a.cy} C${x1 + dx} ${a.cy} ${x2 - dx} ${b.cy} ${x2} ${b.cy}`, dash: e.dotted ? '1.5 4' : e.label ? '5 4' : undefined, loop: false, state });
    }
    setPaths(out);
    setSize({ w: g.scrollWidth, h: g.scrollHeight });
  }, [layout, overlay]);
  useLayoutEffect(() => {
    measure();
    const g = grid.current;
    if (!g || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(g);
    return () => ro.disconnect();
  }, [measure]);
  const setRef = (id: string) => (el: HTMLElement | null) => { if (el) refs.current.set(id, el); else refs.current.delete(id); };
  const n = layout.cols.length;
  return (
    <div className={`pg-swim${hasLoop ? ' loops' : ''}`} ref={grid} style={{ gridTemplateColumns: roomy ? `${LANE_W}px repeat(${n}, ${COL_MAX}px) minmax(0, 1fr)` : `${LANE_W}px repeat(${n}, minmax(${COL_MIN}px, 1fr))`, columnGap: GAP }}>
      {layout.lanes.map((lane, li) => (
        <div key={lane} className="pg-lane-bg" style={{ gridRow: li + 1, gridColumn: '1 / -1' }} aria-hidden />
      ))}
      {layout.lanes.map((lane, li) => (
        <div key={`l-${lane}`} className="pg-lane" style={{ gridRow: li + 1, gridColumn: 1 }}>
          <span className="pg-lane-name">{laneTitle(lane)}</span>
          {lane === 'owner' && ownerName && <span className="pg-lane-who">{ownerName}</span>}
          {lane === 'engine' && <span className="pg-lane-who">no one acts</span>}
        </div>
      ))}
      <svg className="pg-edges" width={size.w} height={size.h} aria-hidden>
        <defs>
          <marker id="pg-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 8 4 0 8z" fill="currentColor" /></marker>
        </defs>
        {paths.map((p, i) => <path key={i} d={p.d} className={`pg-edge${p.loop ? ' loop' : ''}${p.state ? ` ${p.state}` : ''}`} strokeDasharray={p.dash} markerEnd="url(#pg-arrow)" />)}
      </svg>
      {paths.filter((p) => p.label).map((p, i) => <span key={`lb${i}`} className="pg-loop-label" style={{ left: p.label!.x, top: p.label!.y }}>↺ {p.label!.text}</span>)}
      {layout.lanes.flatMap((lane, li) => layout.cols.map((col, ci) => {
        const here = col.filter((x) => laneOf(x) === lane);
        if (!here.length) return null;
        return (
          <div key={`${lane}-${ci}`} className="pg-cell" style={{ gridRow: li + 1, gridColumn: ci + 2 }}>
            {here.map((x) => <StepCard key={x.id} innerRef={setRef(x.id)} def={def} n={x} deviation={deviation?.get(x.id)} o={overlay?.get(x.id)} on={sel === x.id} onClick={() => onSel(x.id)} />)}
          </div>
        );
      }))}
    </div>
  );
}

// ---- the narrow fallback: a vertical list ----

function ListStage({ def, layout, dynamic, deviation, overlay, sel, onSel, ownerName }: { def: ProcessDef; layout: StageLayout; dynamic: boolean; deviation?: Map<string, number>; overlay?: Map<string, StepOverlay> | null; sel: string | null; onSel: (id: string) => void; ownerName?: string }) {
  return (
    <ol className="pg-list">
      {layout.cols.map((col, ci) => (
        <li key={ci} className="pg-list-group">
          {col.length > 1 && <span className="pg-list-note">{dynamic ? 'In any order' : 'In parallel'}</span>}
          {col.map((x) => <StepCard key={x.id} def={def} n={x} deviation={deviation?.get(x.id)} o={overlay?.get(x.id)} on={sel === x.id} onClick={() => onSel(x.id)} lane={laneTitle(laneOf(x)) + (laneOf(x) === 'owner' && ownerName ? ` · ${ownerName}` : '')} />)}
        </li>
      ))}
    </ol>
  );
}

// ---- one step ----

/** A duration in plain words: "4h", "2.5h", "7d". */
const dur = (h: number): string => (h >= 48 && h % 24 === 0 ? `${h / 24}d` : Number.isInteger(h) ? `${h}h` : hrs(h));

function subline(n: ProcessNodeDef): string {
  if (n.kind === 'approval') return `Asks ${n.approver === 'ceo' ? 'the CEO' : 'the owner\'s manager'}`;
  if (n.kind === 'wait') return `Waits ${dur(n.waitHours ?? 0)}`;
  if (n.kind === 'subprocess') return `Runs the process ${n.process ?? ''}`;
  if (n.kind === 'meeting') { const w = meetingWords(n); return w.charAt(0).toUpperCase() + w.slice(1); }
  return '';
}

function StepCard({ def, n, deviation, o, on, onClick, lane, innerRef }: { def: ProcessDef; n: ProcessNodeDef; deviation?: number; o?: StepOverlay; on: boolean; onClick: () => void; lane?: string; innerRef?: (el: HTMLElement | null) => void }) {
  const must = n.must?.length ?? 0;
  const more = (n.should?.length ?? 0) + (n.may?.length ?? 0);
  const conds = def.edges.filter((e) => e.to === n.id && e.when && e.loopMax === undefined).map((e) => conditionWords(e.when));
  const sub = subline(n);
  const time = n.kind === 'wait' ? null : n.slaHours ? dur(n.slaHours) : null;
  const e = edgeWords(def, n.id);
  return (
    <button type="button" ref={innerRef} className={`pg-step${on ? ' on' : ''}`} data-kind={n.kind} data-state={o?.state} aria-pressed={on} onClick={onClick} data-testid="process-step"
      aria-label={`${n.title}, ${KIND_WORD[n.kind] ?? n.kind}${o ? `, ${STEP_STATE_WORD[o.state]}` : ''}`}>
      <span className="pg-step-top">
        <span className="pg-kind"><I d={KIND_ICON[n.kind] ?? PI.task} size={12} />{KIND_WORD[n.kind] ?? n.kind}</span>
        <span style={{ flex: 1 }} />
        {n.kind === 'wait' && <span className="pg-tag time" title="A timer"><I d={PI.timer} size={10} />{dur(n.waitHours ?? 0)}</span>}
        {time && <span className="pg-tag time" title={`Due within ${time} (SLA)`}><I d={PI.timer} size={10} />{time}</span>}
        {n.required && <span className="pg-tag flag" title="The stage cannot finish without it"><I d={PI.flag} size={10} />Checkpoint</span>}
      </span>
      <span className="pg-step-title">{n.title}</span>
      {lane && <span className="pg-step-sub">{lane}</span>}
      {sub && <span className="pg-step-sub">{sub}</span>}
      {conds.length > 0 && <span className="pg-step-cond">Only {conds.join(' or ')}</span>}
      {e.loops.length > 0 && <span className="pg-step-cond">↺ {e.loops.join('; ').replace(/ when ([^,]+)/, (_m, w: string) => ` ${conditionWords(w)}`)}</span>}
      {(must > 0 || more > 0 || n.compensate || (deviation ?? 0) > 0 || (n.outputs?.length ?? 0) > 0) && (
        <span className="pg-step-tags">
          {must > 0 && <span className="pg-tag must">{must} MUST</span>}
          {more > 0 && <span className="pg-tag">+{more} {more === 1 ? 'item' : 'items'}</span>}
          {(n.outputs?.length ?? 0) > 0 && <span className="pg-tag" title={`Records ${n.outputs!.map((x) => x.name).join(', ')}`}>{n.outputs!.length} output{n.outputs!.length === 1 ? '' : 's'}</span>}
          {n.compensate && <span className="pg-tag undo" title={`Undone by "${def.nodes.find((x) => x.id === n.compensate)?.title ?? n.compensate}" if the run fails`}><I d={PI.undo} size={10} />Undoable</span>}
          {(deviation ?? 0) > 0 && <span className="pg-tag warn" title="Share of runs that deviated at this step">deviated {Math.round(deviation! * 100)}%</span>}
        </span>
      )}
      {o && (
        <span className="pg-step-state" data-state={o.state}>
          <span className="pg-dot" aria-hidden />{STEP_STATE_WORD[o.state]}{o.rounds > 1 ? ` · round ${o.rounds}` : ''}{o.who ? ` · ${o.who}` : ''}
        </span>
      )}
    </button>
  );
}

function StepDetail({ def, n, ownerName, extra, onClose }: { def: ProcessDef; n: ProcessNodeDef; ownerName?: string; extra?: ReactNode; onClose: () => void }) {
  const e = edgeWords(def, n.id);
  const undo = n.compensate ? def.nodes.find((x) => x.id === n.compensate) : null;
  const undoes = n.compensation ? def.nodes.filter((x) => x.compensate === n.id) : [];
  const lane = laneOf(n);
  const items = (['must', 'should', 'may'] as const).filter((l) => n[l]?.length);
  const levelWord = { must: 'Must', should: 'Should', may: 'May' };
  return (
    <div className="pg-detail" role="region" aria-label={`Step: ${n.title}`} data-testid="process-step-detail">
      <div className="pg-detail-head">
        <span className="pg-kind" data-kind={n.kind}><I d={KIND_ICON[n.compensation ? 'compensation' : n.kind] ?? PI.task} size={12} />{n.compensation ? KIND_WORD.compensation : KIND_WORD[n.kind]}</span>
        <b>{n.title}</b>
        <span style={{ flex: 1 }} />
        <button type="button" className="co-iconbtn" onClick={onClose} aria-label="Close the step"><I d={P.x} size={13} /></button>
      </div>
      <dl className="co-dl">
        <dt>Who</dt><dd>{laneTitle(lane)}{lane === 'owner' && ownerName ? ` (${ownerName} today)` : ''}</dd>
        {n.why && <><dt>Why</dt><dd>{n.why}</dd></>}
        {n.kind === 'approval' && n.question && <><dt>Asks</dt><dd>{n.question}</dd></>}
        {n.kind === 'meeting' && <><dt>Meeting</dt><dd>{subline(n)}{n.agenda ? `. Agenda: ${n.agenda}` : ''}. Its accepted decisions and actions become the step's outputs.</dd></>}
        {n.kind === 'wait' && <><dt>Timer</dt><dd>Waits {dur(n.waitHours ?? 0)}, then the run goes on by itself.</dd></>}
        {n.outcome && <><dt>Outcome</dt><dd>{n.outcome}</dd></>}
        {n.doneWhen && <><dt>Done when</dt><dd>{n.doneWhen}</dd></>}
        {items.length > 0 && <><dt>Checklist</dt><dd>
          <ul className="pg-items">
            {items.flatMap((l) => n[l]!.map((x, i) => <li key={`${l}${i}`}><span className={`pg-tag${l === 'must' ? ' must' : ''}`}>{levelWord[l]}</span>{x}</li>))}
          </ul>
        </dd></>}
        {n.outputs?.length ? <><dt>Records</dt><dd>{n.outputs.map((o) => `${o.name}${o.required ? ' (required)' : ''}`).join(', ')}</dd></> : null}
        {n.slaHours ? <><dt>Deadline</dt><dd>Within {dur(n.slaHours)}, or it is escalated</dd></> : null}
        {n.deny?.length ? <><dt>Not allowed</dt><dd>{n.deny.join(', ')}</dd></> : null}
        {n.playbook && <><dt>Playbook</dt><dd>{n.playbook}</dd></>}
        {e.after.length > 0 && <><dt>After</dt><dd>{e.after.map((x) => x.replace(/\(when ([^)]+)\)/, (_m, w: string) => `(${conditionWords(w)})`)).join(', ')}</dd></>}
        {e.next.length > 0 && <><dt>Then</dt><dd>{e.next.map((x) => x.replace(/\(when ([^)]+)\)/, (_m, w: string) => `(${conditionWords(w)})`)).join(', ')}</dd></>}
        {n.availableWhen && <><dt>Available</dt><dd>{[...(n.availableWhen.after ?? []).map((x) => `after “${def.nodes.find((y) => y.id === x)?.title ?? x}”`), ...(n.availableWhen.vars ?? []).map((v) => `once ${v.replace(/_/g, ' ')} is known`)].join(' and ') || 'from the start of the stage'}</dd></>}
        {undo && <><dt>If the run fails</dt><dd>Undone by “{undo.title}”</dd></>}
        {undoes.length > 0 && <><dt>Undoes</dt><dd>{undoes.map((x) => x.title).join(', ')}</dd></>}
      </dl>
      {extra}
    </div>
  );
}
