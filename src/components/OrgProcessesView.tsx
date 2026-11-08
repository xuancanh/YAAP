/** Operations › Processes (docs/processes.md): the company's standing
 *  procedures. The list shows each process's mode, owner, version, runs and
 *  health, the runs open now, and — for the CEO — the template library. A
 *  process's page (`/<company>/processes/<id>`) shows its stages as a
 *  readable graph (strict: columns in the order the engine walks them, with
 *  loops as "back to"; dynamic: each step with when it is available), every
 *  version with its author, reason and diff (roll back to one), the runs
 *  with each step's state, and the CEO's edit, start and retire. Lib:
 *  src/lib/processes.ts. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgDetail, type OrgProcess, type OrgProcessDetail, type OrgProcessRunRow, type ProcessDef, type ProcessNodeDef, type ProcessTemplate } from '../lib/api';
import {
  HEALTH_TONE, HEALTH_WORD, KIND_WORD, MODE_HINT, MODE_WORD, authorWords, availabilityWords, edgeWords, hrs, layoutStage, pct, processSummary, runTone, stepTone, triggerWords,
} from '../lib/processes';
import { I, P } from '../lib/icons';
import { ago, useAgentNames, useUnits } from './org-ui';
import { useOrgRole } from './OrgSensingView';
import { Card, Empty, Metric, Owner, PageHeader, Pill, SkeletonRows } from './CompanyKit';

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 600) : 'failed');

export function ProcessesPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const decider = role === 'ceo' || role === 'board';
  const names = useAgentNames();
  const [data, setData] = useState<{ processes: OrgProcess[]; runs: OrgProcessRunRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [library, setLibrary] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const load = useCallback(async () => {
    try { setData(await api.orgProcesses(wsId)); setErr(null); } catch (e) { setErr(errText(e)); }
  }, [wsId]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 30_000); return () => clearInterval(t); }, [load]);

  const open = app.routeProcess;
  if (open) return <ProcessPage wsId={wsId} processId={open} decider={decider} onBack={() => { app.setRouteProcess(null); void load(); }} />;
  const live = (data?.processes ?? []).filter((p) => p.status !== 'retired');
  const retired = (data?.processes ?? []).filter((p) => p.status === 'retired');
  const sum = processSummary(data?.processes ?? []);
  const byId = new Map((data?.processes ?? []).map((p) => [p.id, p]));
  return (
    <div className="co-page" data-testid="processes-page">
      <PageHeader title="Processes" purpose="The company's standing procedures: how recurring, handoff-heavy or risky work is done. Each run is pinned to a version; each step an agent performs is an ordinary task with a step card. Strict stages follow the graph; in dynamic stages the performer chooses. The chief changes any process and the heads their own, from what the runs show."
        actions={decider ? <button className="co-btn primary" onClick={() => setLibrary(!library)} aria-expanded={library}>{library ? 'Close library' : 'Add from library'}</button> : undefined} />
      {err && <div className="co-alert" role="alert">{err}</div>}
      {data && (
        <div className="co-metrics" style={{ margin: '4px 0 14px' }} data-testid="process-counts">
          <Metric n={sum.active} label="processes" />
          <Metric n={sum.open} label="open runs" tone={sum.open ? 'info' : undefined} />
          <Metric n={sum.revise} label="need revising" tone={sum.revise ? 'bad' : undefined} title="A step most runs deviate from, or runs that rarely complete" />
          <Metric n={sum.due} label="review due" tone={sum.due ? 'warn' : undefined} title="The owner has not reviewed its runs within the company's review cadence" />
        </div>
      )}
      {library && <Library wsId={wsId} have={new Set((data?.processes ?? []).map((p) => p.templateId).filter(Boolean))} onAdded={async (id) => { setLibrary(false); await load(); app.setRouteProcess(id); }} />}
      {!data && !err && <SkeletonRows rows={4} label="Loading processes" />}
      {data && live.length === 0 && <div className="co-card"><Empty title="No processes yet">Add one from the library; the chief of staff and the heads also add them as work recurs.</Empty></div>}
      {live.length > 0 && (
        <Card title="All processes" aside={`${live.length}`} flush>
          <div className="co-rows" data-testid="process-list">
            {live.map((p) => <ProcessRow key={p.id} p={p} owner={p.ownerAgentId ? names.get(p.ownerAgentId) : undefined} onOpen={() => app.setRouteProcess(p.id)} />)}
          </div>
        </Card>
      )}
      {data && data.runs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Card title="Open runs" aside={`${data.runs.length}`} flush>
            <div className="co-rows">
              {data.runs.map((r) => (
                <button key={r.id} className="co-row" onClick={() => app.setRouteProcess(r.processId)}>
                  <span className="co-row-main">
                    <span className="co-row-title">{r.key} · {r.title || byId.get(r.processId)?.title}</span>
                    <span className="co-row-meta">{byId.get(r.processId)?.title ?? 'process'} v{r.version} · stage {r.stage} · started {ago(r.startedAt)}{r.note ? ` · ${r.note}` : ''}</span>
                  </span>
                  <span className="co-row-end"><Pill tone={runTone(r.status)}>{r.status}</Pill></span>
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}
      {retired.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <button className="co-link" onClick={() => setShowRetired(!showRetired)} aria-expanded={showRetired}>{showRetired ? 'Hide' : 'Show'} retired ({retired.length})</button>
          {showRetired && <div className="co-card" style={{ marginTop: 8 }}><div className="co-rows">{retired.map((p) => <ProcessRow key={p.id} p={p} owner={p.ownerAgentId ? names.get(p.ownerAgentId) : undefined} onOpen={() => app.setRouteProcess(p.id)} />)}</div></div>}
        </div>
      )}
    </div>
  );
}

function ProcessRow({ p, owner, onOpen }: { p: OrgProcess; owner?: ReturnType<ReturnType<typeof useAgentNames>['get']>; onOpen: () => void }) {
  const m = p.metrics;
  return (
    <button className="co-row" onClick={onOpen} aria-label={`Open process ${p.title}`} data-testid="process-row">
      <span className="co-row-main">
        <span className="co-row-title">{p.title} <span style={{ color: 'var(--text-faint)', fontWeight: 500 }}>v{p.version}</span></span>
        <span className="co-row-meta">
          {MODE_WORD[p.mode] ?? p.mode} · {p.category} · {p.unitName} · {owner?.name ?? p.ownerName} · {triggerWords(p.triggers)}
          {m.runs > 0 ? ` · ${m.runs} run${m.runs === 1 ? '' : 's'}, ${pct(m.completionRate)} completed, cycle ${hrs(m.cycleHoursP50)}` : ''}
        </span>
      </span>
      <span className="co-row-end">
        {p.pendingVersion && <Pill tone="warn" title="A change waits for approval">v{p.pendingVersion} pending</Pill>}
        {p.reviewDue && <Pill tone="warn" plain>review due</Pill>}
        {p.status !== 'active' ? <Pill tone="muted">{p.status}</Pill> : <Pill tone={HEALTH_TONE[m.health]} title={m.why}>{HEALTH_WORD[m.health]}</Pill>}
      </span>
    </button>
  );
}

function Library({ wsId, have, onAdded }: { wsId: string; have: Set<string>; onAdded: (processId: string) => Promise<void> }) {
  const app = useApp();
  const { units } = useUnits();
  const [list, setList] = useState<ProcessTemplate[] | null>(null);
  const [unit, setUnit] = useState('');
  useEffect(() => { void api.orgProcessTemplates(wsId).then(setList).catch(() => setList([])); }, [wsId]);
  const add = async (t: ProcessTemplate) => {
    try { const d = await api.createOrgProcess(wsId, { template: t.id, unitId: unit || null, reason: `added from the library by the CEO` }); app.showToast(`${t.title} added`); await onAdded(d.process.id); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <Card title="Template library" aside="instantiate, then it is yours to change" action={
        <label className="co-field" style={{ minWidth: 200 }}><span className="sr-only">Owning department</span>
          <select className="co-input" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Owning department">
            <option value="">Owned by the company (the chief)</option>
            {units.filter((u) => u.parentUnitId !== null).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>}>
        {!list && <SkeletonRows rows={3} label="Loading templates" />}
        <div className="co-rows" data-testid="process-library">
          {(list ?? []).map((t) => (
            <div key={t.id} className="co-row static">
              <span className="co-row-main">
                <span className="co-row-title">{t.title}</span>
                <span className="co-row-meta" style={{ whiteSpace: 'normal' }}>{t.summary} · {MODE_WORD[t.mode] ?? t.mode} · {t.steps} steps · {t.triggers}</span>
              </span>
              <span className="co-row-end">{have.has(t.id) ? <Pill tone="ok" plain>added</Pill> : <button className="co-btn small" onClick={() => void add(t)}>Add</button>}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ---- one process ----

function ProcessPage({ wsId, processId, decider, onBack }: { wsId: string; processId: string; decider: boolean; onBack: () => void }) {
  const app = useApp();
  const names = useAgentNames();
  const [d, setD] = useState<OrgProcessDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState(false);
  const load = useCallback(async () => {
    try { setD(await api.orgProcess(wsId, processId)); setErr(null); } catch (e) { setErr(errText(e)); }
  }, [wsId, processId]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 20_000); return () => clearInterval(t); }, [load]);
  const nameOf = useCallback((id: string) => names.get(id)?.name, [names]);
  if (err && !d) return <div className="co-page"><button className="co-link" onClick={onBack}>← Processes</button><div className="co-alert" role="alert" style={{ marginTop: 10 }}>{err}</div></div>;
  if (!d) return <div className="co-page"><SkeletonRows rows={5} label="Loading the process" /></div>;
  const p = d.process;
  const m = p.metrics;
  const retire = async () => {
    const reason = prompt(p.status === 'retired' ? 'Why bring it back?' : 'Why retire it? Open runs finish on their version.');
    if (!reason) return;
    try { setD(await api.retireOrgProcess(wsId, p.id, { reason, restore: p.status === 'retired' })); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div className="co-page" data-testid="process-page">
      <button className="co-link" onClick={onBack} style={{ marginBottom: 8 }}>← Processes</button>
      <PageHeader title={<>{p.title} <span style={{ color: 'var(--text-faint)', fontWeight: 500 }}>v{p.version}</span></>}
        purpose={<>{p.description || 'A standing procedure of the company.'} {MODE_HINT[p.mode] ?? ''}</>}
        actions={decider ? <>
          {p.status === 'active' && <button className="co-btn primary" onClick={() => setStarting(!starting)} aria-expanded={starting}>Start a run</button>}
          {d.def && <button className="co-btn" onClick={() => setEditing(!editing)} aria-expanded={editing}>{editing ? 'Close editor' : 'Edit'}</button>}
          <button className="co-btn ghost" onClick={() => void retire()}>{p.status === 'retired' ? 'Restore' : 'Retire'}</button>
        </> : undefined} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '-6px 0 12px' }}>
        <Pill tone={p.status === 'active' ? HEALTH_TONE[m.health] : 'muted'} title={m.why}>{p.status === 'active' ? HEALTH_WORD[m.health] : p.status}</Pill>
        <Pill plain>{MODE_WORD[p.mode] ?? p.mode}</Pill>
        <Pill plain>{p.category}</Pill>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{p.unitName} · owner</span>
        <Owner agent={p.ownerAgentId ? names.get(p.ownerAgentId) : undefined} name={p.ownerName} compact />
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>· starts {triggerWords(p.triggers)}</span>
        {p.pendingVersion && <Pill tone="warn">v{p.pendingVersion} waits for approval (Inbox)</Pill>}
      </div>
      {m.health !== 'healthy' && m.health !== 'new' && <div className="co-alert" role="status" style={{ marginBottom: 12 }}>{m.why}</div>}
      <div className="co-metrics" style={{ margin: '0 0 14px' }} data-testid="process-metrics">
        <Metric n={m.runs} label="runs" />
        <Metric n={pct(m.completionRate)} label="completed" tone={m.completionRate !== null && m.completionRate < 0.5 ? 'bad' : undefined} />
        <Metric n={hrs(m.cycleHoursP50)} label="cycle time (median)" />
        <Metric n={pct(m.deviationRate)} label="steps deviated" tone={m.health === 'revise' ? 'bad' : undefined} />
        <Metric n={pct(m.reworkRate)} label="rework" />
        <Metric n={m.slaBreaches} label="SLA breaches" tone={m.slaBreaches ? 'warn' : undefined} />
      </div>
      {starting && <StartForm wsId={wsId} p={p} onDone={async () => { setStarting(false); await load(); }} />}
      {editing && d.def && <Editor wsId={wsId} p={p} def={d.def} onDone={async (next) => { setEditing(false); if (next) setD(next); else await load(); }} />}
      <div className="co-stack">
        {d.def ? <Graph def={d.def} metrics={m} /> : <div className="co-card"><Empty compact title="No active version">Its first version waits for approval.</Empty></div>}
        <Runs wsId={wsId} d={d} decider={decider} onChanged={load} />
        <Versions wsId={wsId} d={d} decider={decider} nameOf={nameOf} onChanged={(x) => setD(x)} />
      </div>
    </div>
  );
}

function StartForm({ wsId, p, onDone }: { wsId: string; p: OrgProcess; onDone: () => Promise<void> }) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const [vars, setVars] = useState('');
  const go = async () => {
    const parsed: Record<string, string> = {};
    for (const line of vars.split('\n')) { const m = /^\s*([a-z][a-z0-9_]*)\s*[:=]\s*(.+)$/i.exec(line); if (m) parsed[m[1]] = m[2].trim(); }
    try { const r = await api.startOrgProcessRun(wsId, p.id, { title: title.trim() || undefined, vars: parsed }); app.showToast(`${r.key} started`); await onDone(); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div className="co-card" style={{ padding: 14, marginBottom: 14 }} role="form" aria-label={`Start a run of ${p.title}`}>
      <div className="co-form">
        <div className="co-form-row">
          <label className="co-field"><span>What this run is for</span><input className="co-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${p.title}: …`} /></label>
          <label className="co-field"><span>Inputs (one per line, name: value)</span><textarea className="co-input" rows={2} value={vars} onChange={(e) => setVars(e.target.value)} placeholder="release: v2.3" /><small>The steps' briefs name them as ${'{'}name{'}'}.</small></label>
        </div>
        <div className="co-form-foot"><button className="co-btn primary" onClick={() => void go()}>Start</button></div>
      </div>
    </div>
  );
}

function Editor({ wsId, p, def, onDone }: { wsId: string; p: OrgProcess; def: ProcessDef; onDone: (d: OrgProcessDetail | null) => Promise<void> }) {
  const app = useApp();
  const [text, setText] = useState(() => JSON.stringify(def, null, 2));
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    let parsed: ProcessDef;
    try { parsed = JSON.parse(text) as ProcessDef; } catch (e) { setProblem(`Not valid JSON: ${errText(e)}`); return; }
    try { const d = await api.editOrgProcess(wsId, p.id, { def: parsed, reason: reason.trim() }); app.showToast(`${p.title} v${d.process.version} is active`); await onDone(d); } catch (e) { setProblem(errText(e)); }
  };
  return (
    <div className="co-card" style={{ padding: 14, marginBottom: 14 }} role="form" aria-label={`Edit ${p.title}`}>
      <div className="co-form">
        <label className="co-field"><span>Definition</span>
          <textarea className="co-input" rows={18} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} style={{ fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 12 }} />
          <small>Stages (strict or dynamic), steps (task, approval, wait, subprocess) with MUST / SHOULD / MAY items (at most nine), and edges in strict stages; an edge that closes a loop needs loopMax. Saving makes a new version; the old one stays and can be rolled back to.</small>
        </label>
        <label className="co-field"><span>Why (what the runs showed)</span><input className="co-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="the security scan was skipped in two runs" /></label>
        {problem && <div className="co-alert" role="alert" style={{ whiteSpace: 'pre-wrap' }}>{problem}</div>}
        <div className="co-form-foot">
          <button className="co-btn ghost" onClick={() => void onDone(null)}>Cancel</button>
          <button className="co-btn primary" disabled={!reason.trim()} onClick={() => void save()}>Save as a new version</button>
        </div>
      </div>
    </div>
  );
}

// ---- the graph ----

function Graph({ def, metrics }: { def: ProcessDef; metrics: OrgProcess['metrics'] }) {
  const [open, setOpen] = useState<string | null>(null);
  const dev = new Map(metrics.steps.map((s) => [s.nodeId, s]));
  return (
    <Card title="How it runs" aside={`${def.stages.length} stage${def.stages.length === 1 ? '' : 's'} · ${def.nodes.length} steps`}>
      <div style={{ display: 'grid', gap: 14 }} data-testid="process-graph">
        {def.stages.map((st, i) => (
          <section key={st.id} aria-label={`Stage ${st.title}`}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--text-dim)' }}>Stage {i + 1} · {st.title}</span>
              <Pill tone={st.mode === 'strict' ? 'info' : 'accent'} plain>{st.mode}</Pill>
              <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{MODE_HINT[st.mode]}</span>
            </div>
            {st.mode === 'strict'
              ? <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4, alignItems: 'flex-start' }}>
                  {layoutStage(def, st.id).map((col, c) => (
                    <div key={c} style={{ display: 'grid', gap: 8, minWidth: 200, flex: '0 0 auto' }}>
                      {col.map((n) => <StepBox key={n.id} def={def} n={n} strict open={open === n.id} onToggle={() => setOpen(open === n.id ? null : n.id)} stat={dev.get(n.id)} />)}
                    </div>
                  ))}
                </div>
              : <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))' }}>
                  {def.nodes.filter((n) => (n.stage ?? def.stages[0].id) === st.id).map((n) => <StepBox key={n.id} def={def} n={n} open={open === n.id} onToggle={() => setOpen(open === n.id ? null : n.id)} stat={dev.get(n.id)} />)}
                </div>}
          </section>
        ))}
      </div>
    </Card>
  );
}

function StepBox({ def, n, strict, open, onToggle, stat }: { def: ProcessDef; n: ProcessNodeDef; strict?: boolean; open: boolean; onToggle: () => void; stat?: OrgProcess['metrics']['steps'][number] }) {
  const e = strict ? edgeWords(def, n.id) : null;
  const items = (n.must?.length ?? 0) + (n.should?.length ?? 0) + (n.may?.length ?? 0);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel-2)', padding: '8px 10px', minWidth: 0 }} data-testid="process-step">
      <button onClick={onToggle} aria-expanded={open} style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{n.title}</span>
          {n.kind !== 'task' && <Pill plain tone="info">{KIND_WORD[n.kind]}</Pill>}
          {n.required && <Pill tone="warn" plain title="The stage cannot finish without it">checkpoint</Pill>}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2 }}>
          {n.kind === 'approval' ? `asks ${n.approver === 'ceo' ? 'the CEO' : 'the manager'}` : n.kind === 'wait' ? `waits ${n.waitHours}h` : n.kind === 'subprocess' ? `runs ${n.process}` : `lane: ${n.lane ?? 'owner'}`}
          {n.must?.length ? ` · ${n.must.length} MUST` : ''}{items > (n.must?.length ?? 0) ? ` · ${items - (n.must?.length ?? 0)} more` : ''}{n.slaHours ? ` · SLA ${n.slaHours}h` : ''}
          {stat && stat.deviations > 0 ? <span style={{ color: 'var(--warn-text)' }}> · deviated {Math.round(stat.deviationRate * 100)}%</span> : null}
        </div>
        {e && (e.after.length > 0 || e.loops.length > 0) && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>{e.after.length ? `after ${e.after.join(', ')}` : ''}{e.loops.length ? `${e.after.length ? ' · ' : ''}↺ ${e.loops.join('; ')}` : ''}</div>}
        {!strict && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>{availabilityWords(def, n)}</div>}
      </button>
      {open && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8, display: 'grid', gap: 6 }}>
          {n.why && <div><b>Why:</b> {n.why}</div>}
          {n.question && <div><b>Question:</b> {n.question}</div>}
          {n.doneWhen && <div><b>Exit:</b> {n.doneWhen}</div>}
          {(['must', 'should', 'may'] as const).map((lvl) => (n[lvl]?.length ? <div key={lvl}><b>{lvl.toUpperCase()}</b><ul style={{ margin: '2px 0 0 16px', padding: 0 }}>{n[lvl]!.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null))}
          {n.outputs?.length ? <div><b>Outputs:</b> {n.outputs.map((o) => `${o.name}${o.required ? ' (required)' : ''}`).join(', ')}</div> : null}
          {n.deny?.length ? <div><b>Not in this step:</b> {n.deny.join(', ')}</div> : null}
          {n.playbook && <div><b>Playbook:</b> {n.playbook}</div>}
          {e?.next.length ? <div><b>Then:</b> {e.next.join(', ')}</div> : null}
        </div>
      )}
    </div>
  );
}

// ---- runs and versions ----

function Runs({ wsId, d, decider, onChanged }: { wsId: string; d: OrgProcessDetail; decider: boolean; onChanged: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [open, setOpen] = useState<string | null>(() => d.runs.find((r) => r.status === 'running' || r.status === 'blocked')?.id ?? null);
  const cancel = async (id: string) => {
    const reason = prompt('Why cancel this run? Its open step tasks are cancelled.');
    if (!reason) return;
    try { await api.cancelOrgProcessRun(wsId, id, reason); await onChanged(); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <Card title="Runs" aside={`${d.runs.length}`} flush>
      {d.runs.length === 0 && <div style={{ padding: '4px 10px 8px' }}><Empty compact title="No runs yet">A trigger starts one, or start it by hand.</Empty></div>}
      <div className="co-rows" data-testid="process-runs">
        {d.runs.map((r) => (
          <div key={r.id}>
            <button className="co-row" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
              <span className="co-row-main">
                <span className="co-row-title">{r.key}{r.title ? ` · ${r.title}` : ''}</span>
                <span className="co-row-meta">v{r.version} · {r.trigger.kind ?? 'manual'}{r.trigger.event ? ` (${r.trigger.event.replace(/_/g, ' ')})` : ''} · started {ago(r.startedAt)}{r.endedAt ? ` · ended ${ago(r.endedAt)}` : ` · stage ${r.stage}`}{r.note ? ` · ${r.note}` : ''}</span>
              </span>
              <span className="co-row-end"><Pill tone={runTone(r.status)}>{r.status}</Pill><I d={open === r.id ? P.chevD : P.chevR} size={12} /></span>
            </button>
            {open === r.id && (
              <div style={{ padding: '2px 12px 10px 22px', display: 'grid', gap: 4 }}>
                {r.steps.map((s) => (
                  <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, opacity: s.current ? 1 : 0.6 }}>
                    <Pill tone={stepTone(s.status, s.current)} plain>{s.current ? s.status : 'sent back'}</Pill>
                    <span style={{ fontWeight: 600 }}>{s.title}{s.attempt > 1 ? ` (round ${s.attempt})` : ''}</span>
                    {s.kind !== 'task' && <span style={{ color: 'var(--text-faint)' }}>{KIND_WORD[s.kind] ?? s.kind}</span>}
                    {s.taskKey && s.taskId && <button className="co-link" onClick={() => app.openOrgTask(s.taskId!)}>{s.taskKey}</button>}
                    {s.assigneeAgentId && <span style={{ color: 'var(--text-dim)' }}>{names.get(s.assigneeAgentId)?.name}</span>}
                    {s.outcome && s.outcome !== s.status && <span style={{ color: 'var(--text-dim)' }}>→ {s.outcome}</span>}
                    {s.deviations.length > 0 && <span style={{ color: 'var(--warn-text)' }} title={s.deviations.map((x) => `${x.level} ${x.item}: ${x.reason} (${x.status})`).join('\n')}>{s.deviations.length} deviation{s.deviations.length === 1 ? '' : 's'}</span>}
                    {s.slaBreachedAt && <span style={{ color: 'var(--warn-text)' }}>past SLA</span>}
                  </div>
                ))}
                {Object.keys(r.vars).length > 0 && <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>Variables: {Object.entries(r.vars).map(([k, v]) => `${k} = ${String(v).slice(0, 60)}`).join(' · ')}</div>}
                {decider && (r.status === 'running' || r.status === 'blocked') && <div><button className="co-btn small ghost" onClick={() => void cancel(r.id)}>Cancel run</button></div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Versions({ wsId, d, decider, nameOf, onChanged }: { wsId: string; d: OrgProcessDetail; decider: boolean; nameOf: (id: string) => string | undefined; onChanged: (d: OrgProcessDetail) => void }) {
  const app = useApp();
  const [open, setOpen] = useState<number | null>(null);
  const rollback = async (version: number) => {
    const reason = prompt(`Roll back to v${version}? This writes a new version with v${version}'s definition. Why?`);
    if (!reason) return;
    try { onChanged(await api.rollbackOrgProcess(wsId, d.process.id, { version, reason })); app.showToast('Rolled back'); } catch (e) { app.showToast(errText(e)); }
  };
  const tone = useMemo(() => ({ active: 'ok', superseded: 'muted', pending: 'warn', rejected: 'bad' } as const), []);
  return (
    <Card title="Versions" aside={`${d.versions.length}`} flush>
      <div className="co-rows" data-testid="process-versions">
        {d.versions.map((v) => (
          <div key={v.id}>
            <button className="co-row" onClick={() => setOpen(open === v.version ? null : v.version)} aria-expanded={open === v.version}>
              <span className="co-row-main">
                <span className="co-row-title">v{v.version} · {v.reason}</span>
                <span className="co-row-meta">by {authorWords(v.author, nameOf)} · {ago(v.createdAt)}{v.diff.length ? ` · ${v.diff.length} change${v.diff.length === 1 ? '' : 's'}` : ''}</span>
              </span>
              <span className="co-row-end"><Pill tone={tone[v.status]}>{v.status}</Pill></span>
            </button>
            {open === v.version && (
              <div style={{ padding: '2px 12px 10px 22px' }}>
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--text-dim)', display: 'grid', gap: 2 }} data-testid="process-diff">
                  {v.diff.map((l, i) => <li key={i} style={{ color: l.startsWith('+') || / \+ /.test(l) ? 'var(--ok-text)' : l.startsWith('-') || / − /.test(l) ? 'var(--red-text)' : undefined }}>{l}</li>)}
                </ul>
                {decider && v.status === 'superseded' && <button className="co-btn small" style={{ marginTop: 8 }} onClick={() => void rollback(v.version)}>Roll back to v{v.version}</button>}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
