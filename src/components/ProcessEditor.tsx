/** The visual process editor (docs/processes.md "The editor"), loaded only
 *  when the CEO edits, creates or customises a process. A canvas (pan with
 *  a drag on the background, zoom with the buttons or Ctrl/⌘ + wheel) shows
 *  the stages stacked, a row per role and the engine's columns:
 *  - drag a step to another row (its role) or stage, or onto a step to sit
 *    just before it;
 *  - drag from a step's dot onto another step to link them (a link back is
 *    a loop with a round limit; in a "performer chooses" stage it is an
 *    "available after" link; onto an undo step it becomes the undo);
 *  - drag a kind from the palette onto a row (a new step there) or onto a
 *    step (a new step right after it); click it to add after the selection;
 *  - click a step, link or stage to change it in the inspector (the
 *    keyboard alternative for every drag: role, stage, earlier/later,
 *    "then goes to…").
 *  Undo/redo (Ctrl/⌘+Z, Shift+Ctrl/⌘+Z), Delete removes the selection, Tidy
 *  re-orders the steps by the engine's columns. Every edit is checked live
 *  with the server's own validator (src/lib/process-editor.ts) and again by
 *  the server's read-only check; Save stays off until both pass, asks why,
 *  then writes a new version through the ordinary author path. Narrower
 *  than the canvas needs, the editor becomes a list with the same
 *  inspector. "View JSON" shows the definition as text for an expert. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, type OrgProcessDetail, type ProcessDef, type ProcessNodeDef } from '../lib/api';
import {
  G, addNode, addStage, allLanes, checkProcess, connect, deleteNode, disconnect, hitTest, historyReducer, initHistory, laneFits, layoutEditor, moveNode, nudgeNode, pinProblem, removeStage, tidy,
  type EdLayout, type EdProblem, type Hit, type OpResult, type PaletteKind, type Sel,
} from '../lib/process-editor';
import { KIND_WORD, conditionWords, hrs, laneOf, laneTitle, stageNodes } from '../lib/processes';
import { I, P } from '../lib/icons';
import { useUnits } from './org-ui';
import { PI } from './ProcessGraph';
import { Inspector } from './ProcessInspector';
import '../styles/processes.css';
import '../styles/process-editor.css';

export interface ProcessEditorProps {
  wsId: string;
  /** The definition to start from: the active one, a template's, or a blank one. */
  initial: ProcessDef;
  /** Editing this process (absent: a new one). */
  process?: { id: string; name: string; title: string; version: number };
  /** Creating from this library template ("Customise before adding"). */
  template?: { id: string; title: string };
  ownerName?: string;
  onCancel: () => void;
  onSaved: (d: OrgProcessDetail, outcome: SaveOutcome) => void | Promise<void>;
}
export interface SaveOutcome { kind: 'applied' | 'pending' | 'ramping'; text: string }

/** The name the server gives a new process from its title (a customised template is named by its title, so a second copy does not clash). */
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 1200) : 'failed');
const PALETTE: Array<{ kind: PaletteKind; label: string; hint: string; icon: string[] }> = [
  { kind: 'task', label: 'Task', hint: 'Someone in a role does it', icon: PI.task },
  { kind: 'approval', label: 'Approval', hint: 'A yes/no decision', icon: PI.approval },
  { kind: 'wait', label: 'Wait', hint: 'A timer', icon: PI.timer },
  { kind: 'meeting', label: 'Meeting', hint: 'Its minutes become records', icon: PI.meeting },
  { kind: 'subprocess', label: 'Sub-process', hint: 'Runs another process', icon: PI.sub },
  { kind: 'undo', label: 'Undo step', hint: 'Undoes a step if a run fails', icon: PI.undo },
];
const KIND_ICON: Record<string, string[]> = { task: PI.task, approval: PI.approval, wait: PI.timer, meeting: PI.meeting, subprocess: PI.sub, compensation: PI.undo };
const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
const dur = (h: number): string => (h >= 48 && h % 24 === 0 ? `${h / 24}d` : Number.isInteger(h) ? `${h}h` : hrs(h));

/** One line under a step's title on the canvas. */
function subline(def: ProcessDef, n: ProcessNodeDef): string {
  if (n.compensation) { const u = def.nodes.filter((x) => x.compensate === n.id).map((x) => x.title); return u.length ? `Undoes ${u.join(', ')}` : 'Undoes nothing yet'; }
  if (n.kind === 'approval') return `Asks ${n.approver === 'ceo' ? 'the CEO' : "the owner's manager"}`;
  if (n.kind === 'wait') return `Waits ${dur(n.waitHours ?? 0)}`;
  if (n.kind === 'subprocess') return n.process ? `Runs ${n.process.replace(/-/g, ' ')}` : 'Pick a process';
  const bits: string[] = [];
  const must = n.must?.length ?? 0; const more = (n.should?.length ?? 0) + (n.may?.length ?? 0);
  if (must) bits.push(`${must} must`);
  if (more) bits.push(`+${more}`);
  if (n.outputs?.length) bits.push(`${n.outputs.length} record${n.outputs.length === 1 ? '' : 's'}`);
  if (n.kind === 'meeting') bits.unshift((n.meetingKind ?? 'adhoc') === 'adhoc' ? 'Meeting' : (n.meetingKind ?? '').replace(/_/g, ' '));
  return bits.join(' · ');
}

type Drag =
  | { type: 'move'; id: string; sx: number; sy: number; moved: boolean }
  | { type: 'new'; kind: PaletteKind; sx: number; sy: number; moved: boolean }
  | { type: 'connect'; from: string }
  | { type: 'pan'; sx: number; sy: number; px: number; py: number; moved: boolean };

export default function ProcessEditor({ wsId, initial, process, template, ownerName, onCancel, onSaved }: ProcessEditorProps) {
  const [hist, dispatch] = useReducer(historyReducer, initial, initHistory);
  const def = hist.present;
  const [sel, setSel] = useState<Sel>(null);
  const [extraLanes, setExtraLanes] = useState<string[]>([]);
  const [status, setStatus] = useState<{ text: string; bad?: boolean } | null>(null);
  const [json, setJson] = useState(false);
  const [saving, setSaving] = useState(false);
  const [srv, setSrv] = useState<{ for: string; problems: EdProblem[]; ceiling: number; names: string[]; selfName: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // jsdom has no layout (width 0): the canvas there, so tests drive the same editor.
  const canvasMode = width === 0 || width >= 720;
  const wide = width === 0 || width >= 1080;

  const say = useCallback((text: string, bad?: boolean) => setStatus({ text, bad }), []);
  useEffect(() => { if (!status) return; const t = setTimeout(() => setStatus(null), 7_000); return () => clearTimeout(t); }, [status]);

  /** Apply an edit result: the new definition into the history, its selection, its note or refusal. */
  const apply = useCallback((r: OpResult, key?: string) => {
    if (r.error) { say(r.error, true); return; }
    if (r.def !== def) dispatch({ type: 'set', def: r.def, key });
    if (r.select !== undefined) setSel(r.select);
    if (r.note) say(r.note);
  }, [def, say]);

  // ---- the live check: the model here at once, the server's own check after a pause ----
  const ceiling = srv?.ceiling ?? 5;
  const local = useMemo(() => checkProcess(def, srv ? { loopMaxCeiling: srv.ceiling, processNames: srv.names, selfName: srv.selfName } : {}), [def, srv]);
  const defJson = useMemo(() => JSON.stringify(def), [def]);
  useEffect(() => {
    let live = true;
    setChecking(true);
    const t = setTimeout(() => {
      api.validateOrgProcess(wsId, { def, ...(process ? { process: process.id } : {}), ...(template ? { template: template.id, name: slug(def.title) || template.id } : {}) })
        .then((r) => { if (live) setSrv({ for: defJson, problems: r.problems.map((p) => pinProblem(def, p)), ceiling: r.loopMaxCeiling, names: r.processNames, selfName: r.name }); })
        .catch(() => { if (live) setSrv((s) => (s ? { ...s, for: defJson, problems: [] } : null)); })
        .finally(() => { if (live) setChecking(false); });
    }, 450);
    return () => { live = false; clearTimeout(t); };
  }, [defJson]); // eslint-disable-line react-hooks/exhaustive-deps
  const problems = useMemo(() => {
    const out = [...local];
    if (srv && srv.for === defJson) for (const p of srv.problems) if (!out.some((x) => x.where === p.where && x.text === p.text)) out.push(p);
    return out;
  }, [local, srv, defJson]);
  const changed = defJson !== JSON.stringify(initial) || !process;
  const canSave = changed && problems.length === 0 && !(checking && (!srv || srv.for !== defJson));

  // ---- keyboard: undo/redo, delete, escape ----
  const removeSel = useCallback(() => {
    if (sel?.kind === 'node') apply(deleteNode(def, sel.id));
    else if (sel?.kind === 'edge' || sel?.kind === 'link') apply(disconnect(def, sel));
    else if (sel?.kind === 'stage' && stageNodes(def, sel.id).length === 0) apply(removeStage(def, sel.id));
  }, [sel, def, apply]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !isField(e.target)) { e.preventDefault(); dispatch({ type: e.shiftKey ? 'redo' : 'undo' }); return; }
    if (mod && e.key.toLowerCase() === 'y' && !isField(e.target)) { e.preventDefault(); dispatch({ type: 'redo' }); return; }
    if (isField(e.target)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (sel) { e.preventDefault(); removeSel(); } return; }
    if (e.key === 'Escape' && sel) { e.stopPropagation(); setSel(null); return; }
    if (e.altKey && sel?.kind === 'node' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); apply(nudgeNode(def, sel.id, e.key === 'ArrowUp' ? -1 : 1)); }
  };

  /** Click a palette kind: a new step after the selected one, else at the end of the selected (or last) stage. */
  const addFromPalette = (kind: PaletteKind) => {
    const selNode = sel?.kind === 'node' ? def.nodes.find((n) => n.id === sel.id) : undefined;
    if (kind === 'undo') { apply(addNode(def, 'undo', { stage: def.stages[0].id, undoFor: selNode && !selNode.compensation ? selNode.id : undefined })); return; }
    const stage = sel?.kind === 'stage' ? sel.id : selNode && !selNode.compensation ? selNode.stage ?? def.stages[0].id : def.stages[def.stages.length - 1].id;
    apply(addNode(def, kind, { stage, after: selNode && !selNode.compensation ? selNode.id : undefined }));
  };

  const inspector = <Inspector def={def} sel={sel} problems={problems} loopMaxCeiling={ceiling} processNames={srv?.names ?? []} extraLanes={extraLanes} onChange={apply} onSelect={setSel} />;
  const title = process ? `Edit ${process.title}` : template ? `Customise ${template.title}` : 'New process';
  const lanes = useMemo(() => allLanes(def, extraLanes), [def, extraLanes]);
  return (
    <div className="pe" ref={root} data-testid="process-editor" onKeyDown={onKeyDown} data-mode={canvasMode ? 'canvas' : 'list'}>
      <div className="pe-bar" role="toolbar" aria-label="Editor">
        <div className="pe-bar-title"><b>{title}</b>{process && <span className="co-faint">saving makes v{process.version + 1}; v{process.version} stays and can be rolled back to</span>}</div>
        <div className="pe-bar-tools">
          <button type="button" className="co-iconbtn" onClick={() => dispatch({ type: 'undo' })} disabled={!hist.past.length} aria-label="Undo" title="Undo (Ctrl/⌘+Z)"><I d={PI.undo} size={14} /></button>
          <button type="button" className="co-iconbtn" onClick={() => dispatch({ type: 'redo' })} disabled={!hist.future.length} aria-label="Redo" title="Redo (Shift+Ctrl/⌘+Z)"><I d={PI.undo} size={14} style={{ transform: 'scaleX(-1)' }} /></button>
          <span className="pe-sep" aria-hidden />
          <button type="button" className="co-btn small ghost" onClick={() => apply(tidy(def))} title="Order the steps by the engine's columns, fewer crossings">Tidy</button>
          <button type="button" className={`co-btn small ghost${json ? ' on' : ''}`} onClick={() => setJson(!json)} aria-pressed={json}>View JSON</button>
        </div>
        <span style={{ flex: 1 }} />
        <ProblemsPill problems={problems} checking={checking} open={showProblems} onToggle={() => setShowProblems(!showProblems)} />
        <button type="button" className="co-btn ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="co-btn primary" disabled={!canSave} onClick={() => setSaving(true)} data-testid="editor-save"
          title={!changed ? 'Nothing changed yet' : problems.length ? 'Fix the problems first' : undefined}>{process ? 'Save…' : 'Add the process…'}</button>
      </div>
      {showProblems && problems.length > 0 && (
        <ul className="pe-problist" data-testid="editor-problems">
          {problems.map((p, i) => (
            <li key={i}><button type="button" onClick={() => setSel(p.target.kind === 'node' ? { kind: 'node', id: p.target.id } : p.target.kind === 'edge' ? { kind: def.stages.find((s) => s.id === def.nodes.find((n) => n.id === (p.target as { from: string }).from)?.stage)?.mode === 'dynamic' ? 'link' : 'edge', from: p.target.from, to: p.target.to } : p.target.kind === 'stage' ? { kind: 'stage', id: p.target.id } : null)}>
              <b>{p.where}</b>: {p.text}{p.fix ? <span className="co-faint"> — {p.fix}</span> : null}
            </button></li>
          ))}
        </ul>
      )}
      {saving && <SaveForm wsId={wsId} def={def} process={process} template={template} onCancel={() => setSaving(false)} onSaved={onSaved} />}
      {status && <div className={`pe-status${status.bad ? ' bad' : ''}`} role="status" aria-live="polite" data-testid="editor-status">{status.text}</div>}
      {json && <JsonPanel def={def} onChange={(d) => dispatch({ type: 'set', def: d, key: 'json' })} />}
      <div className={`pe-body${wide ? ' wide' : ''}${canvasMode ? '' : ' narrow'}`}>
        {canvasMode && <Palette onAdd={addFromPalette} onAddStage={(m) => apply(addStage(def, m, sel?.kind === 'stage' ? sel.id : undefined))} onAddRole={(r) => { setExtraLanes((x) => [...x, r]); say(`Added the row “${r}”: drag a step into it.`); }} />}
        {canvasMode
          ? <Canvas def={def} lanes={lanes} sel={sel} problems={problems} ownerName={ownerName} ceiling={ceiling} onSelect={setSel} apply={apply} say={say} />
          : <ListEditor def={def} sel={sel} problems={problems} onSelect={setSel} apply={apply} onAdd={addFromPalette} inspector={inspector} />}
        {(canvasMode || !sel) && <aside className="pe-side" aria-label="Inspector">{inspector}</aside>}
      </div>
    </div>
  );
}

function ProblemsPill({ problems, checking, open, onToggle }: { problems: EdProblem[]; checking: boolean; open: boolean; onToggle: () => void }) {
  if (!problems.length) return <span className={`pe-ok${checking ? ' checking' : ''}`} data-testid="editor-valid" role="status">{checking ? 'Checking…' : <><I d={P.check} size={12} />Ready to save</>}</span>;
  return (
    <button type="button" className="pe-bad" onClick={onToggle} aria-expanded={open} data-testid="editor-problem-count">
      <I d={P.warn} size={12} />{problems.length} problem{problems.length === 1 ? '' : 's'}
    </button>
  );
}

// ---- the palette ----

function Palette({ onAdd, onAddStage, onAddRole }: { onAdd: (k: PaletteKind) => void; onAddStage: (m: 'strict' | 'dynamic') => void; onAddRole: (r: string) => void }) {
  const [role, setRole] = useState<string | null>(null);
  return (
    <div className="pe-palette" role="group" aria-label="Add">
      <div className="pe-pal-k">Steps <span className="co-faint">drag or click</span></div>
      {PALETTE.map((p) => (
        <button key={p.kind} type="button" className="pe-pal" data-kind={p.kind} data-testid={`palette-${p.kind}`} title={`${p.hint}. Drag onto a row or a step, or click to add after the selected step.`}
          onPointerDown={(e) => paletteDrag.start?.(e, p.kind)} onClick={(e) => { if (paletteDrag.justDropped) { paletteDrag.justDropped = false; e.preventDefault(); return; } onAdd(p.kind); }}>
          <I d={p.icon} size={13} /><span>{p.label}</span>
        </button>
      ))}
      <div className="pe-pal-k">Add a stage</div>
      <button type="button" className="pe-pal" onClick={() => onAddStage('strict')} data-testid="palette-stage-strict" title="A stage that follows the graph: the engine decides the next step from the links"><I d={P.plus} size={12} /><span>Follows the graph</span></button>
      <button type="button" className="pe-pal" onClick={() => onAddStage('dynamic')} data-testid="palette-stage-dynamic" title="A stage where the performer chooses among the open steps"><I d={P.plus} size={12} /><span>Performer chooses</span></button>
      {role === null
        ? <button type="button" className="pe-pal" onClick={() => setRole('')} title="A row for a role no step has yet"><I d={P.plus} size={12} /><span>Role</span></button>
        : (
          <form className="pe-pal-role" onSubmit={(e) => { e.preventDefault(); if (role.trim()) { onAddRole(role.trim()); setRole(null); } }}>
            <input className="co-input" autoFocus value={role} onChange={(e) => setRole(e.target.value)} placeholder="a title" aria-label="New role" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRole(null); } }} />
            <button type="submit" className="co-btn small" disabled={!role.trim()}>Add</button>
          </form>
        )}
    </div>
  );
}

/** The palette's drag hands over to the canvas (one editor on screen at a time). */
const paletteDrag: { start?: (e: RPointerEvent, kind: PaletteKind) => void; justDropped: boolean } = { justDropped: false };

// ---- the canvas ----

interface CanvasProps { def: ProcessDef; lanes: string[]; sel: Sel; problems: EdProblem[]; ownerName?: string; ceiling: number; onSelect: (s: Sel) => void; apply: (r: OpResult, key?: string) => void; say: (t: string, bad?: boolean) => void }

function Canvas({ def, lanes, sel, problems, ownerName, ceiling, onSelect, apply, say }: CanvasProps) {
  const L: EdLayout = useMemo(() => layoutEditor(def, lanes, conditionWords), [def, lanes]);
  const view = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [pan, setPan] = useState({ x: 16, y: 16 });
  const [zoom, setZoom] = useState(1);
  const drag = useRef<Drag | null>(null);
  const [hover, setHover] = useState<Hit>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string; hint: string; ok: boolean } | null>(null);
  const [wire, setWire] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const fitted = useRef(false);
  useLayoutEffect(() => {
    const el = view.current;
    if (!el) return;
    const m = () => setVp({ w: el.clientWidth, h: el.clientHeight });
    m();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = useCallback(() => {
    if (!vp.w || !L.w) return;
    // Fit the width (readable cards); a tall process scrolls with the wheel or a drag.
    const z = Math.max(0.6, Math.min(1, (vp.w - 32) / L.w));
    setZoom(z);
    setPan({ x: Math.max(16, (vp.w - L.w * z) / 2), y: 16 });
  }, [vp, L]);
  // Fitted on open, and again as the process grows — until the author pans or zooms by hand.
  const touched = useRef(false);
  useEffect(() => { if (vp.w && (!fitted.current || !touched.current)) { fitted.current = true; fit(); } }, [vp.w, L.w]); // eslint-disable-line react-hooks/exhaustive-deps
  // A newly selected step off screen (just added, or picked in the inspector) is panned into view.
  const selId = sel?.kind === 'node' ? sel.id : null;
  useEffect(() => {
    const b = selId ? L.nodes.get(selId) : undefined;
    if (!b || !vp.w || drag.current) return;
    setPan((p) => {
      const x1 = p.x + b.x * zoom; const x2 = p.x + (b.x + b.w) * zoom; const y1 = p.y + b.y * zoom; const y2 = p.y + (b.y + b.h) * zoom;
      let { x, y } = p;
      if (x2 > vp.w - 16) x -= x2 - (vp.w - 16); if (x1 + (x - p.x) < 16) x += 16 - (x1 + (x - p.x));
      if (y2 > vp.h - 16) y -= y2 - (vp.h - 16); if (y1 + (y - p.y) < 16) y += 16 - (y1 + (y - p.y));
      return x === p.x && y === p.y ? p : { x, y };
    });
  }, [selId, L]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoomBy = (f: number, cx = vp.w / 2, cy = vp.h / 2) => {
    touched.current = true;
    setZoom((z) => {
      const nz = Math.max(0.35, Math.min(1.6, z * f));
      setPan((p) => ({ x: cx - ((cx - p.x) / z) * nz, y: cy - ((cy - p.y) / z) * nz }));
      return nz;
    });
  };
  // Ctrl/⌘ + wheel zooms; a plain wheel pans when the canvas overflows (else the page scrolls).
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top); return; }
      const over = L.w * zoom > vp.w + 1 || L.h * zoom > vp.h + 1;
      if (!over) return;
      e.preventDefault();
      touched.current = true;
      setPan((p) => ({ x: p.x - (e.shiftKey ? e.deltaY : e.deltaX), y: p.y - (e.shiftKey ? 0 : e.deltaY) }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  const toCanvas = (cx: number, cy: number) => {
    const r = view.current!.getBoundingClientRect();
    return { x: (cx - r.left - pan.x) / zoom, y: (cy - r.top - pan.y) / zoom, inside: cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom };
  };
  const nodeOf = (id: string) => def.nodes.find((n) => n.id === id);

  /** What a drop here would do, in words (and whether it can). */
  const describe = (d: Drag, h: Hit): { hint: string; ok: boolean } => {
    if (!h) return { hint: 'Drop on a row or a step', ok: false };
    if (d.type === 'new') {
      if (d.kind === 'undo') return h.kind === 'node' && !nodeOf(h.id)?.compensation ? { hint: `Undoes “${nodeOf(h.id)?.title}”`, ok: true } : { hint: 'Drop on the step it undoes', ok: h.kind !== 'node' };
      if (h.kind === 'node') return nodeOf(h.id)?.compensation ? { hint: 'Not into the undo steps', ok: false } : { hint: `After “${nodeOf(h.id)?.title}”`, ok: true };
      if (h.kind === 'lane') return { hint: `${laneTitle(h.lane)} · ${def.stages.find((s) => s.id === h.stage)?.title}`, ok: true };
      if (h.kind === 'stage') return { hint: `Into ${def.stages.find((s) => s.id === h.stage)?.title}`, ok: true };
      return { hint: 'Drop on a row or a step', ok: false };
    }
    if (d.type === 'move') {
      const n = nodeOf(d.id);
      if (!n) return { hint: '', ok: false };
      if (h.kind === 'node') { if (h.id === d.id) return { hint: 'Its place', ok: false }; const t = nodeOf(h.id); return !!t?.compensation !== !!n.compensation ? { hint: 'Not here', ok: false } : { hint: `Before “${t?.title}”`, ok: true }; }
      if (n.compensation) return { hint: 'Undo steps stay in “If a run fails”', ok: h.kind === 'undo' };
      if (h.kind === 'lane') return laneFits(n, h.lane) || h.stage !== (n.stage ?? def.stages[0].id) ? { hint: laneFits(n, h.lane) ? `${laneTitle(h.lane)} · ${def.stages.find((s) => s.id === h.stage)?.title}` : `Into ${def.stages.find((s) => s.id === h.stage)?.title} (keeps its row)`, ok: true } : { hint: n.kind === 'approval' ? 'An approval sits with its approver' : n.kind === 'task' || n.kind === 'meeting' ? 'A task needs a role\'s row' : 'Runs by itself: the Automatic row', ok: false };
      if (h.kind === 'stage') return { hint: `Into ${def.stages.find((s) => s.id === h.stage)?.title}`, ok: true };
      return { hint: 'Drop on a row or a step', ok: false };
    }
    return { hint: '', ok: false };
  };

  const begin = (e: RPointerEvent, d: Drag) => {
    if (e.button !== 0) return;
    drag.current = d;
    const move = (ev: PointerEvent) => onMove(ev);
    const up = (ev: PointerEvent) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); onUp(ev); };
    const cancel = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); drag.current = null; setGhost(null); setWire(null); setHover(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };
  // The palette (outside the canvas) starts its drags here.
  paletteDrag.start = (e, kind) => { begin(e, { type: 'new', kind, sx: e.clientX, sy: e.clientY, moved: false }); };
  useEffect(() => () => { paletteDrag.start = undefined; }, []);

  const onMove = (ev: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.type === 'pan') {
      if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 3) return;
      d.moved = true;
      touched.current = true;
      setPan({ x: d.px + ev.clientX - d.sx, y: d.py + ev.clientY - d.sy });
      return;
    }
    const c = toCanvas(ev.clientX, ev.clientY);
    if (d.type === 'connect') {
      const a = L.nodes.get(d.from)!;
      setWire({ x1: a.x + a.w, y1: a.y + a.h / 2, x2: c.x, y2: c.y });
      setHover(c.inside ? hitTest(L, c.x, c.y) : null);
      return;
    }
    if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 5) return;
    d.moved = true;
    const h = c.inside ? hitTest(L, c.x, c.y) : null;
    setHover(h);
    const label = d.type === 'new' ? PALETTE.find((p) => p.kind === d.kind)!.label : nodeOf(d.id)?.title ?? '';
    setGhost({ x: ev.clientX, y: ev.clientY, label, ...describe(d, h) });
  };

  const onUp = (ev: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setGhost(null); setWire(null); setHover(null);
    if (!d) return;
    if (d.type === 'pan') { if (!d.moved) onSelect(null); return; }
    const c = toCanvas(ev.clientX, ev.clientY);
    const h = c.inside ? hitTest(L, c.x, c.y) : null;
    if (d.type === 'connect') {
      if (h?.kind === 'node' && h.id !== d.from) apply(connect(def, d.from, h.id, ceiling));
      else if (h) say('Drop the link on another step.', true);
      return;
    }
    if (d.type === 'move') {
      if (!d.moved) { onSelect({ kind: 'node', id: d.id }); return; }
      if (!describe(d, h).ok || !h) { if (h) say(describe(d, h).hint, true); return; }
      if (h.kind === 'node') apply({ ...moveNode(def, d.id, { before: h.id }), select: { kind: 'node', id: d.id } });
      else if (h.kind === 'lane') apply({ ...moveNode(def, d.id, { stage: h.stage, lane: h.lane }), select: { kind: 'node', id: d.id } });
      else if (h.kind === 'stage') apply({ ...moveNode(def, d.id, { stage: h.stage }), select: { kind: 'node', id: d.id } });
      return;
    }
    if (d.type === 'new') {
      if (!d.moved) return; // a click: the button's onClick adds it
      paletteDrag.justDropped = true;
      setTimeout(() => { paletteDrag.justDropped = false; }, 0);
      if (!h || !describe(d, h).ok) { say(h ? describe(d, h).hint : 'Dropped outside the canvas: nothing added.', !!h); return; }
      if (d.kind === 'undo') { apply(addNode(def, 'undo', { stage: def.stages[0].id, undoFor: h.kind === 'node' ? h.id : undefined })); return; }
      if (h.kind === 'node') apply(addNode(def, d.kind, { stage: '', after: h.id }));
      else if (h.kind === 'lane') apply(addNode(def, d.kind, { stage: h.stage, lane: h.lane }));
      else if (h.kind === 'stage') apply(addNode(def, d.kind, { stage: h.stage }));
    }
  };

  const probsOf = (t: (p: EdProblem) => boolean) => problems.filter(t);
  const nodeProbs = (id: string) => probsOf((p) => p.target.kind === 'node' && p.target.id === id);
  const edgeBad = (from: string, to: string) => problems.some((p) => p.target.kind === 'edge' && p.target.from === from && p.target.to === to);
  const stageBad = (id: string) => problems.some((p) => p.target.kind === 'stage' && p.target.id === id);
  const dragging = drag.current?.type === 'move' ? drag.current.id : null;
  const empty = def.nodes.length === 0;

  return (
    <div className="pe-canvas-wrap">
      <div className="pe-canvas" ref={view} data-testid="editor-canvas" style={{ height: Math.round(Math.max(380, Math.min(L.h * zoom + 64, typeof window === 'undefined' ? 760 : Math.max(560, window.innerHeight * 0.82)))) }} onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.bg) begin(e, { type: 'pan', sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, moved: false }); }}>
        <div className="pe-world" style={{ width: L.w, height: Math.max(L.h, 120), transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} data-bg="1">
          {L.stages.map((s) => {
            const st = def.stages[s.index];
            const on = sel?.kind === 'stage' && sel.id === s.id;
            return (
              <div key={s.id} className={`pe-stage${on ? ' on' : ''}${stageBad(s.id) ? ' bad' : ''}${hover && hover.kind !== 'node' && 'stage' in hover && hover.stage === s.id ? ' drop' : ''}`} style={{ top: s.y, height: s.h, width: L.w }} data-bg="1" data-testid="editor-stage">
                <button type="button" className="pe-stage-head" onClick={() => onSelect({ kind: 'stage', id: s.id })} aria-pressed={on}>
                  <span className="pg-stage-n" aria-hidden>{s.index + 1}</span>
                  <span className="pg-stage-title">{st.title || 'Untitled stage'}</span>
                  <span className={`pg-mode ${st.mode}`}>{st.mode === 'strict' ? 'Follows the graph' : 'Performer chooses'}</span>
                  {stageBad(s.id) && <span className="pe-badge" aria-label="Has a problem">!</span>}
                </button>
                {s.lanes.map((ln) => (
                  <div key={ln.lane} className={`pe-lane${hover?.kind === 'lane' && hover.stage === s.id && hover.lane === ln.lane ? ' drop' : ''}`} style={{ top: ln.y - s.y, height: ln.h }} data-bg="1" data-testid="editor-lane" data-lane={ln.lane}>
                    <span className="pe-lane-name" data-bg="1">{laneTitle(ln.lane)}{ln.lane === 'owner' && ownerName && <small>{ownerName}</small>}{ln.lane === 'engine' && <small>no one acts</small>}</span>
                  </div>
                ))}
              </div>
            );
          })}
          {L.undo && (
            <div className={`pe-stage undo${hover?.kind === 'undo' ? ' drop' : ''}`} style={{ top: L.undo.y, height: L.undo.h, width: L.w }} data-bg="1">
              <div className="pe-stage-head static"><span className="pg-stage-n undo" aria-hidden><I d={PI.undo} size={12} /></span><span className="pg-stage-title">If a run fails or is cancelled</span><span className="co-faint" style={{ fontSize: 12 }}>undone latest first, each by its own task</span></div>
            </div>
          )}
          <svg className="pe-edges" width={L.w} height={Math.max(L.h, 120)} aria-hidden>
            <defs>
              {(['', 'loop', 'on', 'bad'] as const).map((k) => <marker key={k} id={`pe-arrow${k ? `-${k}` : ''}`} className={`pe-arrow ${k}`} viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 8 4 0 8z" /></marker>)}
            </defs>
            {L.edges.map((e) => {
              const on = !!sel && (sel.kind === 'edge' || sel.kind === 'link') && sel.from === e.from && sel.to === e.to;
              const s: Sel = { kind: e.kind, from: e.from, to: e.to };
              return (
                <g key={e.key} className={`pe-edge${e.loop ? ' loop' : ''}${e.kind === 'link' ? ' link' : ''}${on ? ' on' : ''}${edgeBad(e.from, e.to) ? ' bad' : ''}`} data-testid="editor-edge" data-from={e.from} data-to={e.to}>
                  <path d={e.d} className="pe-edge-line" strokeDasharray={e.kind === 'link' ? '1.5 4' : e.conditional || e.loop ? '5 4' : undefined} markerEnd={`url(#pe-arrow${edgeBad(e.from, e.to) ? '-bad' : on ? '-on' : e.loop ? '-loop' : ''})`} />
                  <path d={e.d} className="pe-edge-hit" onPointerDown={(ev) => { ev.stopPropagation(); onSelect(s); }} />
                </g>
              );
            })}
            {wire && <path className="pe-wire" d={`M${wire.x1} ${wire.y1} C${wire.x1 + 40} ${wire.y1} ${wire.x2 - 40} ${wire.y2} ${wire.x2} ${wire.y2}`} markerEnd="url(#pe-arrow-on)" />}
          </svg>
          {L.edges.filter((e) => e.label).map((e) => (
            <button key={`l-${e.key}`} type="button" className={`pe-edge-label${e.loop ? ' loop' : ''}${sel && (sel.kind === 'edge') && sel.from === e.from && sel.to === e.to ? ' on' : ''}`} style={{ left: e.label!.x, top: e.label!.y }} onClick={() => onSelect({ kind: e.kind, from: e.from, to: e.to })} tabIndex={-1}>{e.label!.text}</button>
          ))}
          {[...L.nodes.values()].map((b) => {
            const n = nodeOf(b.id)!;
            const on = sel?.kind === 'node' && sel.id === b.id;
            const bad = nodeProbs(b.id);
            const drop = hover?.kind === 'node' && hover.id === b.id && (drag.current?.type !== 'move' || drag.current.id !== b.id);
            const time = n.kind !== 'wait' && n.slaHours ? dur(n.slaHours) : null;
            return (
              <div key={b.id} role="button" tabIndex={0} className={`pe-node${on ? ' on' : ''}${bad.length ? ' bad' : ''}${drop ? ' drop' : ''}${dragging === b.id ? ' lifted' : ''}`} data-kind={n.compensation ? 'compensation' : n.kind}
                style={{ left: b.x, top: b.y, width: b.w, height: b.h }} data-testid="editor-node" data-id={b.id} aria-pressed={on}
                aria-label={`${n.title || 'Untitled step'}, ${n.compensation ? 'undo step' : KIND_WORD[n.kind]}, ${laneTitle(laneOf(n))}${bad.length ? `, ${bad.length} problem${bad.length === 1 ? '' : 's'}` : ''}`}
                onPointerDown={(e) => { if ((e.target as HTMLElement).closest('.pe-handle')) return; e.stopPropagation(); begin(e, { type: 'move', id: b.id, sx: e.clientX, sy: e.clientY, moved: false }); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect({ kind: 'node', id: b.id }); } }}
                title={bad.map((p) => `${p.text} — ${p.fix}`).join('\n') || undefined}>
                <span className="pe-node-top">
                  <span className="pg-kind"><I d={KIND_ICON[n.compensation ? 'compensation' : n.kind] ?? PI.task} size={11} />{n.compensation ? 'Undo' : KIND_WORD[n.kind]}</span>
                  <span style={{ flex: 1 }} />
                  {time && <span className="pg-tag time"><I d={PI.timer} size={9} />{time}</span>}
                  {n.required && <span className="pg-tag flag" title="Checkpoint"><I d={PI.flag} size={9} /></span>}
                  {n.compensate && <span className="pg-tag undo" title="Undone if a run fails"><I d={PI.undo} size={9} /></span>}
                  {bad.length > 0 && <span className="pe-badge" aria-hidden>{bad.length}</span>}
                </span>
                <span className="pe-node-title">{n.title || <i className="co-faint">Untitled step</i>}</span>
                <span className="pe-node-sub">{subline(def, n)}</span>
                {!n.compensation && <span className="pe-handle" title="Drag to another step to link them" aria-hidden onPointerDown={(e) => { e.stopPropagation(); onSelect({ kind: 'node', id: b.id }); begin(e, { type: 'connect', from: b.id }); }} data-testid="editor-handle" />}
              </div>
            );
          })}
          {empty && <div className="pe-empty" style={{ top: (L.stages[0]?.y ?? 0) + G.HEAD + 4, left: G.LANE_W + 12 }}>Drag a <b>Task</b> from the bar above into a row — or click it — to add the first step.</div>}
        </div>
      </div>
      <div className="pe-zoom" role="group" aria-label="Zoom">
        <button type="button" className="co-iconbtn" onClick={() => zoomBy(1 / 1.15)} aria-label="Zoom out">−</button>
        <span className="pe-zoom-n">{Math.round(zoom * 100)}%</span>
        <button type="button" className="co-iconbtn" onClick={() => zoomBy(1.15)} aria-label="Zoom in">+</button>
        <button type="button" className="co-btn small ghost" onClick={() => { touched.current = false; fit(); }}>Fit</button>
      </div>
      {ghost && createPortal(<div className={`pe-ghost${ghost.ok ? '' : ' no'}`} style={{ left: ghost.x + 12, top: ghost.y + 10 }} aria-hidden><b>{ghost.label}</b><span>{ghost.hint}</span></div>, document.body)}
    </div>
  );
}

// ---- the narrow fallback: a list with buttons ----

function ListEditor({ def, sel, problems, onSelect, apply, onAdd, inspector }: { def: ProcessDef; sel: Sel; problems: EdProblem[]; onSelect: (s: Sel) => void; apply: (r: OpResult) => void; onAdd: (k: PaletteKind) => void; inspector: React.ReactNode }) {
  const comps = def.nodes.filter((n) => n.compensation);
  const row = (n: ProcessNodeDef) => {
    const on = sel?.kind === 'node' && sel.id === n.id;
    const bad = problems.filter((p) => p.target.kind === 'node' && p.target.id === n.id).length;
    return (
      <li key={n.id} className={`pe-li${on ? ' on' : ''}${bad ? ' bad' : ''}`} data-testid="editor-node" data-id={n.id}>
        <button type="button" className="pe-li-main" onClick={() => onSelect(on ? null : { kind: 'node', id: n.id })} aria-pressed={on}>
          <span className="pg-kind" data-kind={n.kind}><I d={KIND_ICON[n.compensation ? 'compensation' : n.kind] ?? PI.task} size={11} />{n.compensation ? 'Undo' : KIND_WORD[n.kind]}</span>
          <b>{n.title || 'Untitled step'}</b>
          <span className="co-faint">{laneTitle(laneOf(n))}{subline(def, n) ? ` · ${subline(def, n)}` : ''}</span>
          {bad > 0 && <span className="pe-badge">{bad}</span>}
        </button>
        <span className="pe-li-btns">
          <button type="button" className="co-iconbtn" onClick={() => apply(nudgeInStage(def, n.id, -1))} aria-label={`Move “${n.title}” up`}><I d={P.chevD} size={12} style={{ transform: 'rotate(180deg)' }} /></button>
          <button type="button" className="co-iconbtn" onClick={() => apply(nudgeInStage(def, n.id, 1))} aria-label={`Move “${n.title}” down`}><I d={P.chevD} size={12} /></button>
        </span>
        {(on || ((sel?.kind === 'edge' || sel?.kind === 'link') && sel.from === n.id)) && <div className="pe-li-insp">{inspector}</div>}
      </li>
    );
  };
  return (
    <div className="pe-list" data-testid="editor-list">
      {def.stages.map((s, i) => (
        <section key={s.id} className="pe-list-stage" aria-label={`Stage ${i + 1}: ${s.title}`}>
          <button type="button" className={`pe-stage-head${sel?.kind === 'stage' && sel.id === s.id ? ' on' : ''}`} onClick={() => onSelect({ kind: 'stage', id: s.id })}>
            <span className="pg-stage-n" aria-hidden>{i + 1}</span><span className="pg-stage-title">{s.title}</span><span className={`pg-mode ${s.mode}`}>{s.mode === 'strict' ? 'Follows the graph' : 'Performer chooses'}</span>
          </button>
          {sel?.kind === 'stage' && sel.id === s.id && <div className="pe-li-insp">{inspector}</div>}
          <ol className="pe-ol">{def.nodes.filter((n) => !n.compensation && (n.stage ?? def.stages[0].id) === s.id).map(row)}</ol>
        </section>
      ))}
      {comps.length > 0 && <section className="pe-list-stage"><div className="pe-stage-head static"><span className="pg-stage-title">If a run fails or is cancelled</span></div><ol className="pe-ol">{comps.map(row)}</ol></section>}
      <div className="pe-list-add" role="group" aria-label="Add a step">
        <span className="co-faint">Add {sel?.kind === 'node' ? 'after the selected step' : 'to the end'}:</span>
        {PALETTE.map((p) => <button key={p.kind} type="button" className="co-chip" onClick={() => onAdd(p.kind)}><I d={p.icon} size={12} />{p.label}</button>)}
        <button type="button" className="co-chip" onClick={() => apply(addStage(def, 'strict'))}><I d={P.plus} size={11} />Stage</button>
      </div>
    </div>
  );
}

/** The list's up/down: swap with the neighbour in the stage, whatever its row. */
function nudgeInStage(def: ProcessDef, id: string, dir: -1 | 1): OpResult {
  const n = def.nodes.find((x) => x.id === id);
  if (!n) return { def };
  const peers = def.nodes.filter((x) => !!x.compensation === !!n.compensation && (n.compensation || (x.stage ?? def.stages[0].id) === (n.stage ?? def.stages[0].id)));
  const other = peers[peers.indexOf(n) + dir];
  if (!other) return { def };
  const nodes = [...def.nodes];
  const a = nodes.indexOf(n); const b = nodes.indexOf(other);
  [nodes[a], nodes[b]] = [nodes[b], nodes[a]];
  return { def: { ...def, nodes } };
}

// ---- JSON, for an expert ----

function JsonPanel({ def, onChange }: { def: ProcessDef; onChange: (d: ProcessDef) => void }) {
  const [text, setText] = useState(() => JSON.stringify(def, null, 2));
  const [err, setErr] = useState<string | null>(null);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) { setText(JSON.stringify(def, null, 2)); setErr(null); } }, [def]);
  return (
    <div className="pe-json">
      <label className="co-field"><span>The definition as JSON <small className="co-faint">— edits here apply when the text is valid</small></span>
        <textarea className="co-input pr-code" rows={16} value={text} spellCheck={false} data-testid="editor-json" onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }}
          onChange={(e) => {
            setText(e.target.value);
            try {
              const x = JSON.parse(e.target.value) as ProcessDef;
              if (!x || !Array.isArray(x.stages) || !x.stages.length || !Array.isArray(x.nodes) || !Array.isArray(x.edges)) { setErr('A definition needs stages (at least one), nodes and edges.'); return; }
              setErr(null); onChange({ ...x, triggers: Array.isArray(x.triggers) ? x.triggers : [{ kind: 'manual' }] });
            } catch (ex) { setErr(`Not valid JSON yet: ${errText(ex)}`); }
          }} />
      </label>
      {err && <div className="co-note warn" role="status">{err}</div>}
    </div>
  );
}

// ---- saving: why, then the author path ----

function SaveForm({ wsId, def, process, template, onCancel, onSaved }: { wsId: string; def: ProcessDef; process?: ProcessEditorProps['process']; template?: ProcessEditorProps['template']; onCancel: () => void; onSaved: ProcessEditorProps['onSaved'] }) {
  const { units } = useUnits();
  const [reason, setReason] = useState('');
  const [ramp, setRamp] = useState('');
  const [unit, setUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const go = async () => {
    if (!reason.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      if (process) {
        const pctRamp = ramp.trim() === '' ? undefined : Math.max(0, Math.min(90, Math.round(Number(ramp))));
        const d = await api.editOrgProcess(wsId, process.id, { def, reason: reason.trim(), ...(pctRamp !== undefined && Number.isFinite(pctRamp) ? { ramp: pctRamp } : {}) });
        const ramping = !!d.rollout && d.rollout.candidateVersion > process.version && d.process.version === process.version;
        const outcome: SaveOutcome = d.process.pendingVersion
          ? { kind: 'pending', text: `v${d.process.pendingVersion} waits for approval in the Inbox; v${d.process.version} keeps running until then.` }
          : ramping ? { kind: 'ramping', text: `v${d.rollout!.candidateVersion} runs on ${d.rollout!.percent}% of new runs while it is compared with v${d.process.version}.` }
            : { kind: 'applied', text: `v${d.process.version} is active: new runs start on it.` };
        await onSaved(d, outcome);
      } else {
        const d = await api.createOrgProcess(wsId, { def, ...(template ? { template: template.id, name: slug(def.title) || template.id } : {}), unitId: unit || null, reason: reason.trim() });
        await onSaved(d, d.process.status === 'active' ? { kind: 'applied', text: `${d.process.title} is active.` } : { kind: 'pending', text: `${d.process.title} waits for approval in the Inbox.` });
      }
    } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  return (
    <form className="pe-save" data-testid="editor-save-form" onSubmit={(e) => { e.preventDefault(); void go(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <div className="co-form-row">
        <label className="co-field"><span>Why {process ? 'this change' : 'this process'}?</span><input ref={ref} className="co-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={process ? 'e.g. the security scan was skipped in two runs' : 'e.g. releases keep missing the changelog'} aria-label="Reason" data-testid="editor-reason" /></label>
        {process
          ? <label className="co-field" style={{ maxWidth: 260 }}><span>Try it on (% of new runs)</span><input className="co-input" inputMode="numeric" value={ramp} onChange={(e) => setRamp(e.target.value.replace(/[^\d]/g, ''))} placeholder="company default" aria-label="Ramp percent" /><small>0 = every new run at once. Used when the process has a track record.</small></label>
          : (
            <label className="co-field" style={{ maxWidth: 320 }}><span>Owned by</span>
              <select className="co-input" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Owning department">
                <option value="">The company (the chief of staff)</option>
                {units.filter((u) => u.parentUnitId !== null).map((u) => <option key={u.id} value={u.id}>{u.name} (its head)</option>)}
              </select>
            </label>
          )}
      </div>
      {err && <div className="co-alert" role="alert" style={{ whiteSpace: 'pre-wrap' }}>{err}</div>}
      <div className="co-form-foot">
        <button type="button" className="co-btn ghost" onClick={onCancel}>Back to editing</button>
        <button type="submit" className="co-btn primary" disabled={!reason.trim() || busy} data-testid="editor-confirm">{busy ? 'Saving…' : process ? `Save as v${process.version + 1}` : 'Add the process'}</button>
      </div>
    </form>
  );
}
