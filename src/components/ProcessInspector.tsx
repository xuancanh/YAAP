/** The process editor's side inspector (docs/processes.md "The editor"):
 *  the selected step (what it is, who does it, its checklist, records,
 *  deadline, links, undo step, and the fields of its kind), link (when it
 *  holds, how many rounds a loop may go), stage (its name and how it runs)
 *  or, with nothing selected, the process itself (title, what it is for,
 *  how it starts). Plain words; internal keys stay out of sight. Every
 *  change goes through the editor's history (`onChange`). */
import { useState, type ReactNode } from 'react';
import type { ProcessDef, ProcessNodeDef, ProcessTriggerDef } from '../lib/api';
import {
  addNode, condParts, condText, connect, deleteNode, disconnect, moveNode, moveStage, nudgeNode, removeStage, roleOptions, setEdge, setStageMode, updateNode, updateStage, varName, variablesOf,
  type CondOp, type EdProblem, type OpResult, type Sel,
} from '../lib/process-editor';
import { KIND_WORD, conditionWords, laneTitle, loopEdges, stageNodes } from '../lib/processes';
import { humanCron } from '../lib/org';
import { I, P } from '../lib/icons';
import { PI } from './ProcessGraph';

export interface InspectorProps {
  def: ProcessDef;
  sel: Sel;
  problems: EdProblem[];
  loopMaxCeiling: number;
  processNames: string[];
  extraLanes: string[];
  /** Apply an edit; `key` coalesces typing in one field into one undo step. */
  onChange: (r: OpResult, key?: string) => void;
  onSelect: (s: Sel) => void;
}

const MEETING_KINDS: Array<{ id: string; label: string }> = [
  { id: 'adhoc', label: 'A meeting' }, { id: 'planning', label: 'Planning' }, { id: 'standup', label: 'Standup' }, { id: 'weekly_review', label: 'Weekly review' }, { id: 'retro', label: 'Retro' }, { id: 'board', label: 'Board meeting' },
];
const TIERS: Array<{ id: string; label: string }> = [{ id: '', label: 'Automatic' }, { id: 'cheap', label: 'Light — routine work' }, { id: 'standard', label: 'Standard' }, { id: 'strong', label: 'Strongest — hard judgement' }];
const LEVELS = [{ id: 'must', label: 'Must' }, { id: 'should', label: 'Should' }, { id: 'may', label: 'May' }] as const;
type Level = typeof LEVELS[number]['id'];
const KIND_ICON: Record<string, string[]> = { task: PI.task, approval: PI.approval, wait: PI.timer, meeting: PI.meeting, subprocess: PI.sub, compensation: PI.undo };

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <label className="co-field pe-f"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <section className="pe-sec" aria-label={title}><div className="pe-sec-head"><span>{title}</span>{aside}</div>{children}</section>;
}
const num = (v: string): number | undefined => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

/** A list of short words (tools, variables, attendees) as removable chips with an input. */
function Chips({ values, onChange, placeholder, label, suggest }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; label: string; suggest?: Array<{ id: string; label: string }> }) {
  const [text, setText] = useState('');
  const add = (v: string) => { const t = v.trim(); if (t && !values.includes(t)) onChange([...values, t]); setText(''); };
  const name = (v: string) => suggest?.find((s) => s.id === v)?.label ?? v;
  return (
    <div className="pe-chips" role="group" aria-label={label}>
      {values.map((v) => <span key={v} className="pe-chip">{name(v)}<button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${name(v)}`}><I d={P.x} size={10} /></button></span>)}
      {suggest
        ? <select className="co-input pe-chip-add" value="" onChange={(e) => add(e.target.value)} aria-label={`Add to ${label}`}><option value="">{placeholder}</option>{suggest.filter((s) => !values.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
        : <input className="co-input pe-chip-add" value={text} placeholder={placeholder} aria-label={`Add to ${label}`} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text); } }} onBlur={() => text && add(text)} />}
    </div>
  );
}

function Problems({ list }: { list: EdProblem[] }) {
  if (!list.length) return null;
  return (
    <div className="pe-probs" role="alert" data-testid="inspector-problems">
      {list.map((p, i) => <div key={i}><b>{p.text.charAt(0).toUpperCase() + p.text.slice(1)}</b>{p.fix && <span> — {p.fix}</span>}</div>)}
    </div>
  );
}

export function Inspector(props: InspectorProps) {
  const { def, sel } = props;
  if (sel?.kind === 'node') { const n = def.nodes.find((x) => x.id === sel.id); if (n) return <StepInspector {...props} n={n} />; }
  if (sel?.kind === 'edge') { const e = def.edges.find((x) => x.from === sel.from && x.to === sel.to); if (e) return <EdgeInspector {...props} e={e} />; }
  if (sel?.kind === 'link') return <LinkInspector {...props} from={sel.from} to={sel.to} />;
  if (sel?.kind === 'stage') { const s = def.stages.find((x) => x.id === sel.id); if (s) return <StageInspector {...props} stageId={s.id} />; }
  return <ProcessInspector {...props} />;
}

// ---- a step ----

function StepInspector({ def, n, problems, processNames, extraLanes, onChange, onSelect, loopMaxCeiling }: InspectorProps & { n: ProcessNodeDef }) {
  const set = (patch: Partial<ProcessNodeDef>, field?: string) => onChange(updateNode(def, n.id, patch), field ? `${n.id}.${field}` : undefined);
  const stage = def.stages.find((s) => s.id === (n.stage ?? def.stages[0]?.id));
  const dynamic = stage?.mode === 'dynamic';
  const peers = n.compensation ? [] : stageNodes(def, stage?.id ?? '').filter((x) => x.id !== n.id);
  const mine = problems.filter((p) => p.target.kind === 'node' && p.target.id === n.id);
  const roles = roleOptions(def, extraLanes);
  const title = (id: string) => def.nodes.find((x) => x.id === id)?.title ?? id;
  const loops = stage ? loopEdges(def, stage.id) : [];
  const isLoop = (e: { from: string; to: string }) => loops.some((b) => b.from === e.from && b.to === e.to);
  const out = def.edges.filter((e) => e.from === n.id);
  const inc = def.edges.filter((e) => e.to === n.id);
  const comps = def.nodes.filter((x) => x.compensation);
  const kindWord = n.compensation ? 'Undo step' : KIND_WORD[n.kind] ?? n.kind;
  return (
    <div className="pe-insp" data-testid="step-inspector" aria-label={`Step: ${n.title}`}>
      <div className="pe-insp-head">
        <span className="pg-kind" data-kind={n.kind}><I d={KIND_ICON[n.compensation ? 'compensation' : n.kind] ?? PI.task} size={12} />{kindWord}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="co-iconbtn" onClick={() => onSelect(null)} aria-label="Close the step"><I d={P.x} size={13} /></button>
      </div>
      <Problems list={mine} />
      <Field label="Title"><input className="co-input" value={n.title} onChange={(e) => set({ title: e.target.value }, 'title')} placeholder="What the step does, in a few words" data-testid="step-title" /></Field>
      {!n.compensation && (
        <Field label="Kind">
          <select className="co-input" value={n.kind} onChange={(e) => set({ kind: e.target.value as ProcessNodeDef['kind'] })} aria-label="Kind of step">
            <option value="task">Task — someone does it</option><option value="approval">Approval — a yes/no decision</option><option value="wait">Wait — a timer</option><option value="meeting">Meeting</option><option value="subprocess">Sub-process — runs another process</option>
          </select>
        </Field>
      )}
      <Field label="Why it exists" hint="One line on the step card."><input className="co-input" value={n.why ?? ''} onChange={(e) => set({ why: e.target.value }, 'why')} placeholder="e.g. a release with a red build broke production twice" /></Field>

      {(n.kind === 'task' || n.kind === 'meeting') && (
        <RolePicker label={n.kind === 'meeting' ? 'Runs it' : 'Who does it'} value={n.lane ?? 'owner'} roles={roles} onChange={(lane) => onChange(moveNode(def, n.id, { lane }))} />
      )}
      {n.kind === 'approval' && (
        <>
          <Field label="Who approves">
            <div className="co-seg" role="radiogroup" aria-label="Who approves">
              {(['manager', 'ceo'] as const).map((a) => <button key={a} type="button" role="radio" aria-checked={(n.approver ?? 'manager') === a} aria-pressed={(n.approver ?? 'manager') === a} onClick={() => set({ approver: a })}>{a === 'ceo' ? 'The CEO' : "The owner's manager"}</button>)}
            </div>
          </Field>
          <Field label="The question" hint="Yes/no. The answer (approved or rejected) can decide which way the run goes."><input className="co-input" value={n.question ?? ''} onChange={(e) => set({ question: e.target.value }, 'question')} placeholder="e.g. Ship this release?" /></Field>
        </>
      )}
      {n.kind === 'wait' && (
        <Field label="Wait for (hours)" hint="Then the run goes on by itself. Up to 720 hours (30 days).">
          <input className="co-input" inputMode="decimal" value={n.waitHours ?? ''} onChange={(e) => set({ waitHours: num(e.target.value) }, 'waitHours')} aria-label="Hours to wait" />
        </Field>
      )}
      {n.kind === 'subprocess' && (
        <Field label="Runs the process" hint="It starts on that process's active version; its records flow back.">
          {processNames.length
            ? <select className="co-input" value={n.process ?? ''} onChange={(e) => set({ process: e.target.value || undefined })} aria-label="Process to run"><option value="">Pick a process…</option>{processNames.map((p) => <option key={p} value={p}>{p.replace(/-/g, ' ')}</option>)}</select>
            : <input className="co-input" value={n.process ?? ''} onChange={(e) => set({ process: e.target.value }, 'process')} placeholder="its name, e.g. incident-response" aria-label="Process to run" />}
        </Field>
      )}
      {n.kind === 'meeting' && (
        <>
          <Field label="Meeting"><select className="co-input" value={n.meetingKind ?? 'adhoc'} onChange={(e) => set({ meetingKind: e.target.value })} aria-label="Kind of meeting">{MEETING_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></Field>
          <div className="co-field pe-f"><span>Who comes</span><Chips label="Who comes" values={n.attendees ?? []} onChange={(v) => set({ attendees: v })} placeholder="Add a role…" suggest={[{ id: 'unit', label: 'The department' }, ...roles]} /></div>
          <Field label="Agenda" hint="The records of earlier steps are added to it."><textarea className="co-input" rows={3} value={n.agenda ?? ''} onChange={(e) => set({ agenda: e.target.value }, 'agenda')} /></Field>
        </>
      )}

      {(n.kind === 'task' || n.kind === 'meeting') && <Checklist n={n} set={set} />}
      {n.kind !== 'wait' && n.kind !== 'approval' && <Outputs n={n} set={set} />}

      {!n.compensation && (dynamic
        ? (
          <Section title="When it opens">
            <label className="pe-check"><input type="checkbox" checked={!!n.required} onChange={(e) => set({ required: e.target.checked })} /><span><b>Checkpoint</b> — the stage cannot finish without it</span></label>
            <div className="co-field pe-f"><span>Available after</span>
              <Chips label="Available after" values={n.availableWhen?.after ?? []} placeholder="Add a step…" suggest={peers.map((x) => ({ id: x.id, label: x.title }))}
                onChange={(v) => {
                  const added = v.find((x) => !(n.availableWhen?.after ?? []).includes(x));
                  if (added) { const r = connect(def, added, n.id, loopMaxCeiling); onChange({ ...r, select: { kind: 'node', id: n.id } }); return; }
                  const gone = (n.availableWhen?.after ?? []).find((x) => !v.includes(x));
                  if (gone) onChange({ ...disconnect(def, { kind: 'link', from: gone, to: n.id }), select: { kind: 'node', id: n.id } });
                }} />
              <small>{(n.availableWhen?.after ?? []).length ? 'It opens once these are done.' : 'Open from the start of the stage.'}</small>
            </div>
            <div className="co-field pe-f"><span>Also needs to be known</span><Chips label="Also needs to be known" values={n.availableWhen?.vars ?? []} placeholder="a record, e.g. customer_plan" onChange={(v) => set({ availableWhen: { ...(n.availableWhen ?? {}), vars: v.map(varName).filter(Boolean) } })} /></div>
          </Section>
        )
        : (
          <Section title="Links">
            {inc.length > 0 && <div className="pe-links"><span className="pe-links-k">Comes after</span>{inc.map((e) => <LinkChip key={`${e.from}>${e.to}`} text={`${title(e.from)}${isLoop(e) ? ' (loop back)' : ''}${e.when ? ` · ${conditionWords(e.when)}` : ''}`} onOpen={() => onSelect({ kind: 'edge', from: e.from, to: e.to })} onRemove={() => onChange({ ...disconnect(def, { kind: 'edge', from: e.from, to: e.to }), select: { kind: 'node', id: n.id } })} />)}</div>}
            {out.length > 0 && <div className="pe-links"><span className="pe-links-k">Leads to</span>{out.map((e) => <LinkChip key={`${e.from}>${e.to}`} text={`${isLoop(e) ? '↺ back to ' : ''}${title(e.to)}${e.when ? ` · ${conditionWords(e.when)}` : ''}`} onOpen={() => onSelect({ kind: 'edge', from: e.from, to: e.to })} onRemove={() => onChange({ ...disconnect(def, { kind: 'edge', from: e.from, to: e.to }), select: { kind: 'node', id: n.id } })} />)}</div>}
            {!inc.length && !out.length && <div className="co-faint pe-hint">Not linked. Drag from the dot on its right edge to another step, or pick one here.</div>}
            <select className="co-input" value="" onChange={(e) => e.target.value && onChange(connect(def, n.id, e.target.value, loopMaxCeiling))} aria-label="Add a next step">
              <option value="">Then goes to…</option>
              {peers.filter((x) => !out.some((e) => e.to === x.id)).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </Section>
        ))}

      {n.compensation
        ? (
          <Section title="Undoes">
            <Chips label="Steps it undoes" values={def.nodes.filter((x) => x.compensate === n.id).map((x) => x.id)} placeholder="Add a step it undoes…" suggest={def.nodes.filter((x) => !x.compensation).map((x) => ({ id: x.id, label: x.title }))}
              onChange={(v) => {
                let d = def;
                for (const x of def.nodes) { const want = v.includes(x.id); if (want && x.compensate !== n.id) d = updateNode(d, x.id, { compensate: n.id }).def; else if (!want && x.compensate === n.id) d = updateNode(d, x.id, { compensate: undefined }).def; }
                onChange({ def: d });
              }} />
            <small className="co-faint">If a run fails or is cancelled, what these did is undone by this task, latest first.</small>
          </Section>
        )
        : n.kind !== 'wait' && (
          <Field label="If a run fails or is cancelled" hint="For a step with an outside effect (a deploy, an email): the task that undoes it.">
            <select className="co-input" value={n.compensate ?? ''} aria-label="Undo step" onChange={(e) => {
              if (e.target.value === '__new') onChange(addNode(def, 'undo', { stage: n.stage ?? def.stages[0].id, undoFor: n.id }));
              else set({ compensate: e.target.value || undefined });
            }}>
              <option value="">Nothing to undo</option>
              {comps.map((c) => <option key={c.id} value={c.id}>Undone by “{c.title}”</option>)}
              <option value="__new">+ A new undo step</option>
            </select>
          </Field>
        )}

      {(n.kind === 'task' || n.kind === 'meeting') && (
        <div className="co-form-row pe-row2">
          <Field label="Deadline (hours)" hint="Escalated when late."><input className="co-input" inputMode="decimal" value={n.slaHours ?? ''} onChange={(e) => set({ slaHours: num(e.target.value) }, 'slaHours')} placeholder="company default" aria-label="Deadline in hours" /></Field>
          {n.kind === 'task' && <Field label="Model"><select className="co-input" value={n.tier ?? ''} onChange={(e) => set({ tier: (e.target.value || undefined) as ProcessNodeDef['tier'] })} aria-label="Model tier">{TIERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>}
        </div>
      )}
      {n.kind === 'task' && <div className="co-field pe-f"><span>Not allowed during this step</span><Chips label="Tools not allowed" values={n.deny ?? []} onChange={(v) => set({ deny: v })} placeholder="a tool name, then Enter" /><small>The performer is refused these tools while it works the step.</small></div>}

      {n.kind === 'task' && (
        <details className="pe-more">
          <summary>More details</summary>
          <div className="pe-more-body">
            <Field label="Outcome"><textarea className="co-input" rows={2} value={n.outcome ?? ''} onChange={(e) => set({ outcome: e.target.value }, 'outcome')} /></Field>
            <Field label="Done when"><textarea className="co-input" rows={2} value={n.doneWhen ?? ''} onChange={(e) => set({ doneWhen: e.target.value }, 'doneWhen')} /></Field>
            <Field label="Context for the performer"><textarea className="co-input" rows={3} value={n.context ?? ''} onChange={(e) => set({ context: e.target.value }, 'context')} /></Field>
            <div className="co-form-row pe-row2">
              <Field label="Playbook to load"><input className="co-input" value={n.playbook ?? ''} onChange={(e) => set({ playbook: e.target.value }, 'playbook')} /></Field>
              <Field label="Attempts" hint="1–5"><input className="co-input" inputMode="numeric" value={n.maxAttempts ?? ''} onChange={(e) => set({ maxAttempts: num(e.target.value) }, 'maxAttempts')} placeholder="1" /></Field>
            </div>
          </div>
        </details>
      )}

      <Section title="Place">
        {!n.compensation && (
          <Field label="Stage">
            <select className="co-input" value={n.stage ?? def.stages[0]?.id} onChange={(e) => onChange({ ...moveNode(def, n.id, { stage: e.target.value }), select: { kind: 'node', id: n.id } })} aria-label="Move to stage">
              {def.stages.map((s, i) => <option key={s.id} value={s.id}>{i + 1}. {s.title}</option>)}
            </select>
          </Field>
        )}
        <div className="pe-btnrow">
          <button type="button" className="co-btn small" onClick={() => onChange(nudgeNode(def, n.id, -1))} aria-label="Move earlier"><I d={P.chevL} size={11} style={{ transform: 'rotate(90deg)' }} />Earlier</button>
          <button type="button" className="co-btn small" onClick={() => onChange(nudgeNode(def, n.id, 1))} aria-label="Move later"><I d={P.chevD} size={11} />Later</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="co-btn small pe-danger" onClick={() => onChange(deleteNode(def, n.id))} data-testid="delete-step"><I d={P.x} size={11} />Delete step</button>
        </div>
      </Section>
    </div>
  );
}

function RolePicker({ label, value, roles, onChange }: { label: string; value: string; roles: Array<{ id: string; label: string }>; onChange: (lane: string) => void }) {
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  return (
    <Field label={label} hint="A role, never a person: the process outlives hires and reorgs. A title matches the members who hold it.">
      {other
        ? (
          <span className="pe-inline">
            <input className="co-input" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="a title, e.g. Release manager" aria-label="Role title" onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { e.preventDefault(); onChange(text.trim()); setOther(false); setText(''); } if (e.key === 'Escape') { e.stopPropagation(); setOther(false); } }} />
            <button type="button" className="co-btn small" disabled={!text.trim()} onClick={() => { onChange(text.trim()); setOther(false); setText(''); }}>Set</button>
          </span>
        )
        : (
          <select className="co-input" value={value} onChange={(e) => (e.target.value === '__other' ? setOther(true) : onChange(e.target.value))} aria-label={label} data-testid="step-role">
            {!roles.some((r) => r.id === value) && <option value={value}>{laneTitle(value)}</option>}
            {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            <option value="__other">Another role…</option>
          </select>
        )}
    </Field>
  );
}

function LinkChip({ text, onOpen, onRemove }: { text: string; onOpen: () => void; onRemove: () => void }) {
  return <span className="pe-chip link"><button type="button" className="pe-chip-open" onClick={onOpen}>{text}</button><button type="button" onClick={onRemove} aria-label={`Remove the link ${text}`}><I d={P.x} size={10} /></button></span>;
}

function Checklist({ n, set }: { n: ProcessNodeDef; set: (p: Partial<ProcessNodeDef>, field?: string) => void }) {
  const [text, setText] = useState('');
  const [level, setLevel] = useState<Level>('must');
  const total = (n.must?.length ?? 0) + (n.should?.length ?? 0) + (n.may?.length ?? 0);
  const put = (l: Level, items: string[], field?: string) => set({ [l]: items } as Partial<ProcessNodeDef>, field);
  const add = () => { if (!text.trim()) return; put(level, [...(n[level] ?? []), text.trim()]); setText(''); };
  return (
    <Section title="Checklist" aside={<span className={`pe-count${total > 9 ? ' over' : ''}`} title="At most nine: a short list at a pause point">{total} / 9</span>}>
      <small className="co-faint pe-hint"><b>Must</b> items cannot be skipped without a waiver; <b>should</b> items are skipped only with a reason; <b>may</b> items are suggestions.</small>
      <ol className="pe-items" data-testid="step-checklist">
        {LEVELS.flatMap(({ id: l }) => (n[l] ?? []).map((item, i, arr) => (
          <li key={`${l}${i}`}>
            <select className={`co-input pe-level ${l}`} value={l} aria-label={`Level of item ${i + 1}`} onChange={(e) => { const to = e.target.value as Level; set({ [l]: arr.filter((_, j) => j !== i), [to]: [...(n[to] ?? []), item] } as Partial<ProcessNodeDef>); }}>
              {LEVELS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            <input className="co-input" value={item} aria-label={`${l} item ${i + 1}`} onChange={(e) => put(l, arr.map((x, j) => (j === i ? e.target.value : x)), `${l}${i}`)} />
            <button type="button" className="co-iconbtn" disabled={i === 0} onClick={() => { const a = [...arr]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; put(l, a); }} aria-label={`Move “${item}” up`}><I d={P.chevD} size={11} style={{ transform: 'rotate(180deg)' }} /></button>
            <button type="button" className="co-iconbtn" disabled={i === arr.length - 1} onClick={() => { const a = [...arr]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; put(l, a); }} aria-label={`Move “${item}” down`}><I d={P.chevD} size={11} /></button>
            <button type="button" className="co-iconbtn" onClick={() => put(l, arr.filter((_, j) => j !== i))} aria-label={`Remove “${item}”`}><I d={P.x} size={11} /></button>
          </li>
        )))}
      </ol>
      <div className="pe-additem">
        <select className={`co-input pe-level ${level}`} value={level} onChange={(e) => setLevel(e.target.value as Level)} aria-label="Level of the new item">{LEVELS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
        <input className="co-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add an item, e.g. CI is green on the release commit" aria-label="New checklist item" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="co-btn small" onClick={add} disabled={!text.trim()}>Add</button>
      </div>
    </Section>
  );
}

function Outputs({ n, set }: { n: ProcessNodeDef; set: (p: Partial<ProcessNodeDef>, field?: string) => void }) {
  const [text, setText] = useState('');
  const outs = n.outputs ?? [];
  const add = () => { const name = varName(text); if (!name || outs.some((o) => o.name === name)) return; set({ outputs: [...outs, { name }] }); setText(''); };
  return (
    <Section title="Records" aside={<span className="co-faint">what the step leaves for later steps</span>}>
      {outs.length > 0 && (
        <ul className="pe-outs">
          {outs.map((o, i) => (
            <li key={i}>
              <input className="co-input" value={o.name} aria-label={`Record ${i + 1} name`} onChange={(e) => set({ outputs: outs.map((x, j) => (j === i ? { ...x, name: varName(e.target.value) || e.target.value.toLowerCase() } : x)) }, `out${i}`)} />
              <label className="pe-check small"><input type="checkbox" checked={!!o.required} onChange={(e) => set({ outputs: outs.map((x, j) => (j === i ? { ...x, required: e.target.checked || undefined } : x)) })} />required</label>
              <button type="button" className="co-iconbtn" onClick={() => set({ outputs: outs.filter((_, j) => j !== i) })} aria-label={`Remove record ${o.name}`}><I d={P.x} size={11} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="pe-additem">
        <input className="co-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. release notes" aria-label="New record" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="co-btn small" onClick={add} disabled={!varName(text)}>Add</button>
      </div>
      {text && varName(text) && varName(text) !== text && <small className="co-faint">Saved as {varName(text)}</small>}
    </Section>
  );
}

// ---- a link ----

function EdgeInspector({ def, e, problems, loopMaxCeiling, onChange, onSelect }: InspectorProps & { e: ProcessDef['edges'][number] }) {
  const title = (id: string) => def.nodes.find((x) => x.id === id)?.title ?? id;
  const stage = def.nodes.find((x) => x.id === e.from)?.stage ?? def.stages[0]?.id;
  const loop = loopEdges(def, stage ?? '').some((b) => b.from === e.from && b.to === e.to);
  const parts = condParts(e.when);
  const unreadable = !!e.when && !parts;
  const vars = variablesOf(def);
  const c = parts ?? { name: '', op: 'eq' as CondOp, value: '' };
  const put = (next: Partial<typeof c>, key?: string) => onChange(setEdge(def, e.from, e.to, { when: condText({ ...c, ...next }) || null }), key ? `edge:${e.from}>${e.to}:${key}` : undefined);
  const mine = problems.filter((p) => p.target.kind === 'edge' && p.target.from === e.from && p.target.to === e.to);
  const known = vars.find((v) => v.name === c.name);
  return (
    <div className="pe-insp" data-testid="edge-inspector" aria-label="Link">
      <div className="pe-insp-head">
        <span className="pg-kind">{loop ? '↺ Loop back' : 'Link'}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="co-iconbtn" onClick={() => onSelect(null)} aria-label="Close the link"><I d={P.x} size={13} /></button>
      </div>
      <Problems list={mine} />
      <div className="pe-edge-ends"><button type="button" className="co-link" onClick={() => onSelect({ kind: 'node', id: e.from })}>{title(e.from)}</button><span aria-hidden>→</span><button type="button" className="co-link" onClick={() => onSelect({ kind: 'node', id: e.to })}>{title(e.to)}</button></div>
      <Field label="Goes this way">
        <div className="co-seg" role="radiogroup" aria-label="When the link holds">
          <button type="button" role="radio" aria-checked={!e.when} aria-pressed={!e.when} onClick={() => onChange(setEdge(def, e.from, e.to, { when: null }))}>{loop ? 'Every round' : 'Always'}</button>
          <button type="button" role="radio" aria-checked={!!e.when} aria-pressed={!!e.when} onClick={() => !e.when && put({ name: vars[0]?.name ?? 'answer', op: vars[0]?.values ? 'eq' : 'set', value: vars[0]?.values?.[0] ?? '' })} data-testid="edge-conditional">Only if…</button>
        </div>
      </Field>
      {unreadable && <div className="co-note warn">The condition “{e.when}” cannot be read. <button type="button" className="co-link" onClick={() => onChange(setEdge(def, e.from, e.to, { when: null }))}>Clear it</button></div>}
      {!!e.when && !unreadable && (
        <div className="pe-cond" data-testid="edge-condition">
          <Field label="Depends on">
            <select className="co-input" value={known ? c.name : '__other'} onChange={(ev) => ev.target.value !== '__other' && put({ name: ev.target.value, value: vars.find((v) => v.name === ev.target.value)?.values?.[0] ?? c.value })} aria-label="Depends on">
              {vars.map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}
              <option value="__other">{known ? 'Another value…' : `${c.name.replace(/_/g, ' ')} (typed)`}</option>
            </select>
          </Field>
          {!known && <Field label="Name"><input className="co-input" value={c.name} onChange={(ev) => put({ name: varName(ev.target.value) }, 'name')} aria-label="Value name" /></Field>}
          <div className="co-form-row pe-row2">
            <Field label="Is">
              <select className="co-input" value={c.op} onChange={(ev) => put({ op: ev.target.value as CondOp })} aria-label="Comparison">
                <option value="eq">is</option><option value="ne">is not</option><option value="set">is known</option><option value="unset">is not known</option>
              </select>
            </Field>
            {(c.op === 'eq' || c.op === 'ne') && (
              <Field label="Value">
                <input className="co-input" list={`pe-vals-${e.from}-${e.to}`} value={c.value} onChange={(ev) => put({ value: ev.target.value }, 'value')} aria-label="Value" />
                <datalist id={`pe-vals-${e.from}-${e.to}`}>{(known?.values ?? []).map((v) => <option key={v} value={v} />)}</datalist>
              </Field>
            )}
          </div>
          <small className="co-faint">Reads: {conditionWords(e.when)}. A branch not taken is skipped, so a join after it never waits.</small>
        </div>
      )}
      {loop && (
        <Field label="Goes round at most" hint={`Then the run waits for a decision: one more round, or stop. Up to ${loopMaxCeiling} in this company.`}>
          <span className="pe-inline"><input className="co-input" style={{ maxWidth: 90 }} inputMode="numeric" value={e.loopMax ?? ''} onChange={(ev) => onChange(setEdge(def, e.from, e.to, { loopMax: num(ev.target.value) ?? null }), `edge:${e.from}>${e.to}:loop`)} aria-label="Rounds at most" data-testid="edge-loopmax" /><span className="co-faint">times</span></span>
        </Field>
      )}
      <div className="pe-btnrow"><span style={{ flex: 1 }} /><button type="button" className="co-btn small pe-danger" onClick={() => onChange(disconnect(def, { kind: 'edge', from: e.from, to: e.to }))} data-testid="delete-link"><I d={P.x} size={11} />Delete link</button></div>
    </div>
  );
}

function LinkInspector({ def, from, to, onChange, onSelect }: InspectorProps & { from: string; to: string }) {
  const title = (id: string) => def.nodes.find((x) => x.id === id)?.title ?? id;
  return (
    <div className="pe-insp" data-testid="link-inspector" aria-label="Available after">
      <div className="pe-insp-head"><span className="pg-kind">Available after</span><span style={{ flex: 1 }} /><button type="button" className="co-iconbtn" onClick={() => onSelect(null)} aria-label="Close"><I d={P.x} size={13} /></button></div>
      <div className="co-dim" style={{ fontSize: 13, lineHeight: 1.5 }}>“{title(to)}” opens for the performer once “{title(from)}” is done. In this stage the performer chooses what to do next among the steps that are open.</div>
      <div className="pe-btnrow"><button type="button" className="co-btn small" onClick={() => onSelect({ kind: 'node', id: to })}>Open “{title(to)}”</button><span style={{ flex: 1 }} /><button type="button" className="co-btn small pe-danger" onClick={() => onChange(disconnect(def, { kind: 'link', from, to }))} data-testid="delete-link"><I d={P.x} size={11} />Remove</button></div>
    </div>
  );
}

// ---- a stage ----

function StageInspector({ def, stageId, problems, onChange, onSelect }: InspectorProps & { stageId: string }) {
  const i = def.stages.findIndex((s) => s.id === stageId);
  const s = def.stages[i];
  const steps = stageNodes(def, s.id);
  const mine = problems.filter((p) => p.target.kind === 'stage' && p.target.id === s.id);
  return (
    <div className="pe-insp" data-testid="stage-inspector" aria-label={`Stage: ${s.title}`}>
      <div className="pe-insp-head"><span className="pg-kind">Stage {i + 1} of {def.stages.length}</span><span style={{ flex: 1 }} /><button type="button" className="co-iconbtn" onClick={() => onSelect(null)} aria-label="Close the stage"><I d={P.x} size={13} /></button></div>
      <Problems list={mine} />
      <Field label="Name"><input className="co-input" value={s.title} onChange={(e) => onChange(updateStage(def, s.id, { title: e.target.value }), `stage:${s.id}:title`)} data-testid="stage-title" /></Field>
      <Field label="How it runs">
        <div className="co-seg" role="radiogroup" aria-label="How the stage runs">
          <button type="button" role="radio" aria-checked={s.mode === 'strict'} aria-pressed={s.mode === 'strict'} onClick={() => onChange(setStageMode(def, s.id, 'strict'))}>Follows the graph</button>
          <button type="button" role="radio" aria-checked={s.mode === 'dynamic'} aria-pressed={s.mode === 'dynamic'} onClick={() => onChange(setStageMode(def, s.id, 'dynamic'))}>Performer chooses</button>
        </div>
      </Field>
      <small className="co-faint pe-hint">{s.mode === 'strict' ? 'The engine starts each step when the steps before it are done; links may hold on a condition, and a link back is a bounded loop.' : 'The performer picks the next step among the open ones; a step opens after the steps it is available after. Checkpoints must be done to finish the stage.'} Switching turns links into “available after” and back.</small>
      <div className="co-faint" style={{ fontSize: 12.5 }}>{steps.length} step{steps.length === 1 ? '' : 's'}</div>
      <div className="pe-btnrow">
        <button type="button" className="co-btn small" disabled={i === 0} onClick={() => onChange(moveStage(def, s.id, -1))}>Move earlier</button>
        <button type="button" className="co-btn small" disabled={i === def.stages.length - 1} onClick={() => onChange(moveStage(def, s.id, 1))}>Move later</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="co-btn small pe-danger" disabled={def.stages.length <= 1} title={def.stages.length <= 1 ? 'A process has at least one stage' : undefined} onClick={() => onChange(removeStage(def, s.id))} data-testid="delete-stage"><I d={P.x} size={11} />Delete{steps.length ? ` with ${steps.length} step${steps.length === 1 ? '' : 's'}` : ''}</button>
      </div>
    </div>
  );
}

// ---- the process ----

const TRIGGER_KINDS: Array<{ id: ProcessTriggerDef['kind']; label: string }> = [{ id: 'manual', label: 'By hand' }, { id: 'cadence', label: 'On a schedule' }, { id: 'event', label: 'When something happens' }, { id: 'service_request', label: 'On a service request' }];
const EVENTS: Array<{ id: string; label: string }> = [{ id: 'incident_opened', label: 'An incident opens' }, { id: 'project_now', label: 'A project moves to Now' }, { id: 'task_created', label: 'A task of a class is created' }];

function ProcessInspector({ def, problems, onChange }: InspectorProps) {
  const set = (patch: Partial<ProcessDef>, key?: string) => onChange({ def: { ...def, ...patch } }, key);
  const mine = problems.filter((p) => p.target.kind === 'process');
  const setTrigger = (i: number, t: ProcessTriggerDef | null, key?: string) => set({ triggers: t ? def.triggers.map((x, j) => (j === i ? t : x)) : def.triggers.filter((_, j) => j !== i) }, key);
  return (
    <div className="pe-insp" data-testid="process-inspector" aria-label="The process">
      <div className="pe-insp-head"><span className="pg-kind">The process</span></div>
      <Problems list={mine} />
      <Field label="Title"><input className="co-input" value={def.title} onChange={(e) => set({ title: e.target.value }, 'title')} placeholder="e.g. Release checklist" data-testid="process-title" /></Field>
      <Field label="What it is for"><textarea className="co-input" rows={2} value={def.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined }, 'description')} placeholder="One or two sentences" /></Field>
      <Field label="Kind of work">
        <div className="co-seg" role="radiogroup" aria-label="Kind of work">
          <button type="button" role="radio" aria-checked={def.category === 'delivery'} aria-pressed={def.category === 'delivery'} onClick={() => set({ category: 'delivery' })}>Delivers work</button>
          <button type="button" role="radio" aria-checked={def.category === 'operating'} aria-pressed={def.category === 'operating'} onClick={() => set({ category: 'operating' })}>Runs the company</button>
        </div>
      </Field>
      <Field label="Its runs are owned by"><select className="co-input" value={def.owner ?? 'head'} onChange={(e) => set({ owner: e.target.value as 'head' | 'chief' })} aria-label="Run owner"><option value="head">The department's head</option><option value="chief">The chief of staff</option></select></Field>
      <Section title="Starts">
        <ul className="pe-triggers">
          {def.triggers.map((t, i) => (
            <li key={i}>
              <select className="co-input" value={t.kind} aria-label={`Trigger ${i + 1}`} onChange={(e) => {
                const k = e.target.value as ProcessTriggerDef['kind'];
                setTrigger(i, k === 'cadence' ? { kind: 'cadence', cron: '0 9 * * 1' } : k === 'event' ? { kind: 'event', event: 'incident_opened' } : k === 'service_request' ? { kind: 'service_request' } : { kind: 'manual' });
              }}>{TRIGGER_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
              {t.kind === 'cadence' && <span className="pe-trig-sub"><input className="co-input" value={t.cron} onChange={(e) => setTrigger(i, { ...t, cron: e.target.value }, `trig${i}`)} aria-label="Schedule (cron)" placeholder="30 7 * * 1-5" /><small className="co-faint">{humanCron(t.cron) !== t.cron ? humanCron(t.cron) : 'minute hour day month weekday'}</small></span>}
              {t.kind === 'event' && <span className="pe-trig-sub">
                <select className="co-input" value={t.event} onChange={(e) => setTrigger(i, { kind: 'event', event: e.target.value, enabled: t.enabled })} aria-label="Event">{EVENTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
                {t.event === 'incident_opened' && <select className="co-input" value={t.severity ?? ''} onChange={(e) => setTrigger(i, { ...t, severity: e.target.value || undefined })} aria-label="Severity"><option value="">Any severity</option><option value="minor">Minor or worse</option><option value="major">Major or worse</option><option value="critical">Critical</option></select>}
                {t.event === 'task_created' && <input className="co-input" value={t.class ?? ''} onChange={(e) => setTrigger(i, { ...t, class: e.target.value || undefined }, `trig${i}`)} placeholder="task class, e.g. release" aria-label="Task class" />}
              </span>}
              {t.kind !== 'manual' && <label className="pe-check small"><input type="checkbox" checked={t.enabled !== false} onChange={(e) => setTrigger(i, { ...t, enabled: e.target.checked ? undefined : false } as ProcessTriggerDef)} />on</label>}
              {def.triggers.length > 1 && <button type="button" className="co-iconbtn" onClick={() => setTrigger(i, null)} aria-label={`Remove trigger ${i + 1}`}><I d={P.x} size={11} /></button>}
            </li>
          ))}
        </ul>
        <button type="button" className="co-link" onClick={() => set({ triggers: [...def.triggers, { kind: 'cadence', cron: '0 9 * * 1' }] })}>+ Another way it starts</button>
      </Section>
      <div className="co-note pe-hint">Select a step, a link or a stage on the canvas to change it. Drag steps between rows and stages; drag from a step's dot to another step to link them.</div>
    </div>
  );
}
