/** Operations › Processes (docs/processes.md): the company's standing
 *  procedures. The list leads with what needs the CEO (a process to revise,
 *  a ramp with a verdict, a change waiting for approval, blocked runs), then
 *  every process by department with its owner, runs and health, the runs
 *  open now, what the engine suggests from repeated work, and the template
 *  library (a dialog with a preview of each template's graph).
 *
 *  A process's page (`/<company>/processes/<id>`) shows what needs attention,
 *  the ramp's comparison (promote / roll back), the graph (ProcessGraph.tsx:
 *  stages, swimlanes by role, MUST items, approvals, timers, meetings, the
 *  undo steps) with a run laid over it, the runs as step timelines, the
 *  measures (Outcomes / Conformance) and the versions with their diffs and
 *  rollback. The CEO starts a run (a field per input the steps use), edits
 *  the definition in the visual editor in place of the graph
 *  (ProcessEditor.tsx, loaded on demand), and retires it; every decision
 *  asks why inline. A new process starts blank or from a library template
 *  ("Customise before adding") in the same editor. Lib: src/lib/processes.ts. */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../store';
import { api, type OrgDetail, type OrgProcess, type OrgProcessDetail, type OrgProcessRunRow, type ProcessConformance, type ProcessDef, type ProcessRollout, type ProcessSuggestion, type ProcessTemplate } from '../lib/api';
import {
  CONFORMANCE_TONE, CONFORMANCE_WORD, HEALTH_TONE, HEALTH_WORD, MODE_HINT, MODE_WORD, RAMP_TONE, RAMP_WORD, RUN_STATUS_WORD, STEP_STATE_WORD, SUGGESTION_WORD, authorWords, cohortRows,
  hrs, laneTitle, pct, processAttention, runProgress, runStates, runTone, triggerWords, varsOf, type StepState,
} from '../lib/processes';
import { I, P } from '../lib/icons';
import { MEETING_EVENT, type MeetingEventDetail } from '../lib/routes';
import { ago, useAgentNames, useUnits } from './org-ui';
import { useOrgRole } from './OrgSensingView';
import { AttentionList, Avatar, Bar, Card, Empty, Menu, Metric, Owner, PageHeader, Pill, Segmented, SkeletonRows, type AttentionRow } from './CompanyKit';
import { GraphLegend, ProcessGraph, type StepOverlay } from './ProcessGraph';
import type { SaveOutcome } from './ProcessEditor';
import '../styles/processes.css';

/** The visual editor loads only when someone edits (its own chunk). */
const ProcessEditor = lazy(() => import('./ProcessEditor'));

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 600) : 'failed');
const CATEGORY_WORD: Record<string, string> = { operating: 'Runs the company', delivery: 'Delivers work' };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const TONE_RANK: Record<string, number> = { bad: 0, warn: 1, info: 2, ok: 3, muted: 4 };
/** A new process: one strict stage, started by hand (the editor's blank page). */
const blankProcess = (): ProcessDef => ({ title: '', category: 'delivery', triggers: [{ kind: 'manual' }], stages: [{ id: 'main', title: 'Main', mode: 'strict' }], nodes: [], edges: [] });
const OUTCOME_TONE: Record<SaveOutcome['kind'], 'ok' | 'warn' | 'info'> = { applied: 'ok', pending: 'warn', ramping: 'info' };
const OUTCOME_WORD: Record<SaveOutcome['kind'], string> = { applied: 'Saved', pending: 'Waiting for approval', ramping: 'Ramping' };

type RunDetail = OrgProcessDetail['runs'][number];

/** Ask why before a decision, inline (never a browser prompt): the question, a reason, confirm or cancel. */
export function ReasonForm({ question, placeholder = 'Why?', confirm, danger, initial = '', onConfirm, onCancel, testid }: { question: ReactNode; placeholder?: string; confirm: string; danger?: boolean; initial?: string; onConfirm: (reason: string) => Promise<void>; onCancel: () => void; testid?: string }) {
  const [reason, setReason] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const go = async () => {
    if (!reason.trim() || busy) return;
    setBusy(true); setErr(null);
    try { await onConfirm(reason.trim()); } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  return (
    <form className="pr-reason" data-testid={testid ?? 'reason-form'} onSubmit={(e) => { e.preventDefault(); void go(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <div className="pr-reason-q">{question}</div>
      <div className="pr-reason-row">
        <input ref={ref} className="co-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} aria-label="Reason" />
        <button type="submit" className={`co-btn small${danger ? '' : ' primary'}`} style={danger ? { color: 'var(--red-text)', borderColor: 'var(--red-line)' } : undefined} disabled={!reason.trim() || busy}>{busy ? 'Working…' : confirm}</button>
        <button type="button" className="co-btn small ghost" onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="co-alert" role="alert">{err}</div>}
    </form>
  );
}

// ---- the list ----

export function ProcessesPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const decider = role === 'ceo' || role === 'board';
  const names = useAgentNames();
  const [data, setData] = useState<{ processes: OrgProcess[]; runs: OrgProcessRunRow[]; suggestions?: ProcessSuggestion[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [library, setLibrary] = useState<false | { pick: string | null }>(false);
  const [showRetired, setShowRetired] = useState(false);
  const [creating, setCreating] = useState<null | { def: ProcessDef; template?: { id: string; title: string } }>(null);
  const load = useCallback(async () => {
    try { setData(await api.orgProcesses(wsId)); setErr(null); } catch (e) { setErr(errText(e)); }
  }, [wsId]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 30_000); return () => clearInterval(t); }, [load]);

  const open = app.routeProcess;
  if (creating && !open) {
    return (
      <div className="co-page" data-testid="process-create">
        <button className="co-link pr-back" onClick={() => setCreating(null)}><I d={P.chevL} size={12} />Processes</button>
        <Suspense fallback={<SkeletonRows rows={6} label="Loading the editor" />}>
          <ProcessEditor wsId={wsId} initial={creating.def} template={creating.template} onCancel={() => setCreating(null)}
            onSaved={async (d, outcome) => { app.showToast(outcome.text); setCreating(null); await load(); app.setRouteProcess(d.process.id); }} />
        </Suspense>
      </div>
    );
  }
  if (open) return <ProcessPage wsId={wsId} processId={open} decider={decider} onBack={() => { app.setRouteProcess(null); void load(); }} />;
  const all = data?.processes ?? [];
  const live = all.filter((p) => p.status !== 'retired');
  const retired = all.filter((p) => p.status === 'retired');
  const byId = new Map(all.map((p) => [p.id, p]));
  const runs = data?.runs ?? [];
  const revise = live.filter((p) => p.status === 'active' && p.metrics.health === 'revise').length;
  const attention: AttentionRow[] = live.flatMap((p) => processAttention(p, { blockedRuns: runs.filter((r) => r.processId === p.id && r.status === 'blocked').length })
    .filter((a) => !a.id.endsWith(':review') && !a.id.endsWith(':watch'))
    .map((a) => ({ ...a, title: `${p.title}: ${a.title.charAt(0).toLowerCase()}${a.title.slice(1)}`, go: 'Open', onOpen: () => app.setRouteProcess(p.id) }))).sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
  const due = live.filter((p) => p.reviewDue).length;
  const groups = groupByUnit(live);
  const openLibrary = (pick: string | null = null) => setLibrary({ pick });
  return (
    <div className="co-page" data-testid="processes-page">
      <PageHeader title="Processes"
        purpose={<>The company's standing procedures: how recurring, hand-off-heavy or risky work is done. Each run is pinned to a version, and each step an agent performs is an ordinary task with a step card. In a strict stage the engine follows the graph; in a dynamic stage the performer chooses. The chief of staff changes any process, and the heads their own, from what the runs show.</>}
        actions={decider ? <>
          <button className="co-btn" onClick={() => setCreating({ def: blankProcess() })} data-testid="process-new"><I d={P.edit} size={12} />New process</button>
          <button className="co-btn primary" onClick={() => openLibrary()}><I d={P.plus} size={13} />Add from library</button>
        </> : undefined} />
      {err && <div className="co-alert" role="alert" style={{ marginBottom: 12 }}>{err}</div>}
      {!data && !err && <SkeletonRows rows={4} label="Loading processes" />}
      {data && live.length === 0 && (
        <div className="co-card" style={{ marginBottom: 14 }}>
          <Empty title="No processes yet" icon={P.rows} action={decider ? <button className="co-btn primary" onClick={() => openLibrary()}>Browse the library</button> : undefined}>
            A process turns work that repeats — a release, an incident, a hire — into steps the agents follow and the company can improve. Start from a template; the chief of staff and the heads also add them as work recurs.
          </Empty>
          {decider && <div style={{ padding: '0 16px 16px' }}><div className="co-sub" style={{ marginTop: 0 }}>Common starting points</div><LibraryGrid wsId={wsId} have={new Set()} onPick={(t) => openLibrary(t.id)} limit={3} /></div>}
        </div>
      )}
      {data && live.length > 0 && (
        <>
          <div className="co-metrics" style={{ margin: '0 0 14px' }} data-testid="process-counts">
            <Metric n={live.filter((p) => p.status === 'active').length} label="processes" />
            <Metric n={runs.length} label="runs open now" tone={runs.length ? 'info' : undefined} />
            <Metric n={revise} label="need revising" tone={revise ? 'bad' : undefined} title="A step most runs deviate from, or runs that rarely complete" />
            <Metric n={due} label="review due" tone={due ? 'warn' : undefined} title="The owner has not reviewed its runs within the company's review cadence" />
          </div>
          {attention.length > 0 && <div style={{ marginBottom: 14 }}><Card title="Needs attention" aside={`${attention.length}`} flush><AttentionList items={attention} limit={5} testid="process-attention" /></Card></div>}
          <div className="co-stack">
            <Card title="All processes" aside={`${live.length}`} flush>
              <div className="co-rows pr-list" data-testid="process-list">
                {groups.map(([unit, list]) => (
                  <div key={unit} role="group" aria-label={unit}>
                    {groups.length > 1 && <div className="pr-group">{unit}</div>}
                    {list.map((p) => <ProcessRow key={p.id} p={p} openRuns={runs.filter((r) => r.processId === p.id).length} owner={p.ownerAgentId ? names.get(p.ownerAgentId) : undefined} onOpen={() => app.setRouteProcess(p.id)} />)}
                  </div>
                ))}
              </div>
            </Card>
            {runs.length > 0 && (
              <Card title="Runs open now" aside={`${runs.length}`} flush>
                <div className="co-rows" data-testid="process-open-runs">
                  {runs.map((r) => {
                    const p = byId.get(r.processId);
                    return (
                      <button key={r.id} className="co-row" onClick={() => app.setRouteProcess(r.processId)}>
                        <span className="co-row-main">
                          <span className="co-row-title"><span className="co-key">{r.key}</span>{r.title || p?.title}</span>
                          <span className="co-row-meta">{p?.title ?? 'A process'} · stage {r.stage.replace(/[-_]/g, ' ')} · started {ago(r.startedAt)}{r.note ? ` · ${r.note}` : ''}</span>
                        </span>
                        <span className="co-row-end">{r.ownerAgentId && <Avatar a={names.get(r.ownerAgentId)} size={18} />}<Pill tone={runTone(r.status)}>{RUN_STATUS_WORD[r.status] ?? r.status}</Pill></span>
                      </button>
                    );
                  })}
                </div>
              </Card>
            )}
          </div>
        </>
      )}
      {data && (data.suggestions?.length ?? 0) > 0 && <Suggestions wsId={wsId} list={data.suggestions!} decider={decider} onChanged={load} />}
      {retired.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <button className="co-link" onClick={() => setShowRetired(!showRetired)} aria-expanded={showRetired}>{showRetired ? 'Hide' : 'Show'} retired ({retired.length})</button>
          {showRetired && <div className="co-card" style={{ marginTop: 8 }}><div className="co-rows pr-list">{retired.map((p) => <ProcessRow key={p.id} p={p} openRuns={0} owner={p.ownerAgentId ? names.get(p.ownerAgentId) : undefined} onOpen={() => app.setRouteProcess(p.id)} />)}</div></div>}
        </div>
      )}
      {library && <LibraryDialog wsId={wsId} initial={library.pick} have={new Set(all.map((p) => p.templateId).filter(Boolean))} onClose={() => setLibrary(false)} onAdded={async (id) => { setLibrary(false); await load(); app.setRouteProcess(id); }}
        onCustomise={(t) => { setLibrary(false); setCreating({ def: JSON.parse(JSON.stringify(t.def)) as ProcessDef, template: { id: t.id, title: t.title } }); }} />}
    </div>
  );
}

/** The company's own processes first, then each department's, by name. */
function groupByUnit(list: OrgProcess[]): Array<[string, OrgProcess[]]> {
  const m = new Map<string, OrgProcess[]>();
  for (const p of list) { const k = p.unitId ? p.unitName : 'Company-wide'; m.set(k, [...(m.get(k) ?? []), p]); }
  return [...m.entries()].sort((a, b) => (a[0] === 'Company-wide' ? -1 : b[0] === 'Company-wide' ? 1 : a[0].localeCompare(b[0])));
}

function ProcessRow({ p, owner, openRuns, onOpen }: { p: OrgProcess; owner?: ReturnType<ReturnType<typeof useAgentNames>['get']>; openRuns: number; onOpen: () => void }) {
  const m = p.metrics;
  const flags = [
    p.pendingVersion ? <Pill key="pv" tone="warn" plain title="A change waits for approval in the Inbox">v{p.pendingVersion} waits for approval</Pill> : null,
    p.rollout ? <Pill key="ro" tone={RAMP_TONE[p.rollout.verdict as ProcessRollout['verdict']] ?? 'info'} plain title={RAMP_WORD[p.rollout.verdict as ProcessRollout['verdict']]}>v{p.rollout.candidateVersion} on {p.rollout.percent}% of runs</Pill> : null,
    p.conformance?.verdict === 'drifting' ? <Pill key="dr" tone="warn" plain title={p.conformance.why}>drifting</Pill> : null,
    p.reviewDue ? <Pill key="rd" plain title="The owner has not reviewed its runs within the review cadence">review due</Pill> : null,
  ].filter(Boolean);
  return (
    <button className="co-row" onClick={onOpen} aria-label={`Open process ${p.title}`} data-testid="process-row">
      <span className="co-row-main">
        <span className="co-row-title">{p.title} <span className="co-faint" style={{ fontWeight: 500 }}>v{p.version}</span></span>
        <span className="co-row-meta">{MODE_WORD[p.mode] ?? p.mode} · starts {triggerWords(p.triggers)}{m.runs > 0 ? ` · ${pct(m.completionRate)} of runs complete, median ${hrs(m.cycleHoursP50)}` : ''}</span>
        {flags.length > 0 && <span className="pr-row-flags">{flags}</span>}
      </span>
      <span className="pr-row-end">
        <Owner agent={owner} name={p.ownerName} />
        <span className="pr-runs-n" title={`${m.runs} runs in the window`}>{m.runs === 0 && !openRuns ? '—' : `${openRuns ? `${openRuns} open · ` : ''}${plural(m.runs, 'run')}`}</span>
        {p.status !== 'active' ? <Pill tone="muted">{p.status}</Pill> : <Pill tone={HEALTH_TONE[m.health]} title={m.why}>{HEALTH_WORD[m.health]}</Pill>}
      </span>
    </button>
  );
}

/** A drafted chain of steps in a line: "Collect → Write → Review", with who does each. */
function Chain({ def }: { def: ProcessDef }) {
  const nodes = def.nodes.filter((n) => !n.compensation);
  return (
    <span className="pr-chain">
      {nodes.map((n, i) => (
        <span key={n.id} style={{ display: 'contents' }}>
          {i > 0 && <span className="pr-chain-arrow" aria-hidden>→</span>}
          <Pill plain>{n.title} <span className="co-faint" style={{ fontWeight: 500 }}>· {laneTitle(n.lane ?? 'owner')}</span></Pill>
        </span>
      ))}
    </span>
  );
}

/** What the engine suggests from repeated work: a drafted process for its owner, or a revision. */
function Suggestions({ wsId, list, decider, onChanged }: { wsId: string; list: ProcessSuggestion[]; decider: boolean; onChanged: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [open, setOpen] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const decide = async (sg: ProcessSuggestion, action: 'accept' | 'dismiss', reason: string) => {
    await api.decideProcessSuggestion(wsId, sg.id, { action, reason });
    app.showToast(action === 'accept' ? 'Process created from the draft' : 'Suggestion dismissed');
    setDismissing(null);
    await onChanged();
  };
  return (
    <div style={{ marginTop: 14 }}>
      <Card title="Suggested from repeated work" aside={`${list.length}`} flush>
        <div className="co-rows" data-testid="process-suggestions">
          {list.map((sg) => (
            <div key={sg.id}>
              <button className="co-row" onClick={() => setOpen(open === sg.id ? null : sg.id)} aria-expanded={open === sg.id}>
                <span className="co-row-main">
                  <span className="co-row-title">{sg.title.replace(/^Draft process: /, '')}</span>
                  <span className="co-row-meta">{SUGGESTION_WORD[sg.kind] ?? sg.kind} · seen {sg.count}× · for {sg.ownerAgentId ? names.get(sg.ownerAgentId)?.name ?? 'a member' : 'the chief'}</span>
                </span>
                <span className="co-row-end"><Pill tone={sg.kind === 'revise' || sg.kind === 'adhoc_step' ? 'warn' : 'accent'} plain>{sg.kind === 'revise' || sg.kind === 'adhoc_step' ? 'revision' : 'new process'}</Pill><I d={open === sg.id ? P.chevD : P.chevR} size={12} /></span>
              </button>
              {open === sg.id && (
                <div style={{ padding: '2px 12px 12px 12px', display: 'grid', gap: 10, fontSize: 12.5 }}>
                  <div className="co-dim" style={{ lineHeight: 1.5 }}>{sg.summary}</div>
                  {sg.evidence.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="co-faint">Seen in</span>
                      {sg.evidence.map((e) => <button key={e.ref} className="co-chip" onClick={() => app.openOrgTask(e.ref)} title={e.title}><span className="co-key" style={{ margin: 0 }}>{e.ref}</span>{e.title.length > 36 ? `${e.title.slice(0, 36)}…` : e.title}</button>)}
                    </div>
                  )}
                  {sg.draft && <div style={{ display: 'grid', gap: 6 }}><span className="co-faint">Drafted steps</span><Chain def={sg.draft} /></div>}
                  {dismissing === sg.id
                    ? <ReasonForm question="Why not? The owner's draft task is cancelled with it." placeholder="e.g. a one-off, not worth a process" confirm="Dismiss" danger onConfirm={(r) => decide(sg, 'dismiss', r)} onCancel={() => setDismissing(null)} />
                    : (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {decider && sg.draft && <button className="co-btn small primary" onClick={() => void decide(sg, 'accept', 'created from the draft by the CEO').catch((e) => app.showToast(errText(e)))}>Create from the draft</button>}
                        {sg.taskId && <button className="co-btn small" onClick={() => app.openOrgTask(sg.taskId!)}>Open the owner's task</button>}
                        {decider && <button className="co-btn small ghost" onClick={() => setDismissing(sg.id)}>Dismiss</button>}
                      </div>
                    )}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ---- the library ----

function useTemplates(wsId: string) {
  const [list, setList] = useState<ProcessTemplate[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void api.orgProcessTemplates(wsId).then(setList).catch((e) => { setErr(errText(e)); setList([]); }); }, [wsId]);
  return { list, err };
}

function TemplateCard({ t, added, on, onClick }: { t: ProcessTemplate; added: boolean; on?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="pr-tpl" aria-pressed={on} onClick={onClick} data-testid="process-template">
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><b style={{ flex: 1 }}>{t.title}</b>{added && <Pill tone="ok" plain>added</Pill>}</span>
      <p>{t.summary}</p>
      <span className="pr-tpl-meta"><span>{MODE_WORD[t.mode] ?? t.mode}</span>·<span>{plural(t.steps, 'step')}</span>·<span>{CATEGORY_WORD[t.category] ?? t.category}</span></span>
    </button>
  );
}

/** A few templates as cards (the empty state's teaser). */
function LibraryGrid({ wsId, have, onPick, limit }: { wsId: string; have: Set<string>; onPick: (t: ProcessTemplate) => void; limit?: number }) {
  const { list } = useTemplates(wsId);
  if (!list) return <SkeletonRows rows={2} label="Loading templates" />;
  return <div className="pr-lib" data-testid="process-library">{list.slice(0, limit ?? list.length).map((t) => <TemplateCard key={t.id} t={t} added={have.has(t.id)} onClick={() => onPick(t)} />)}</div>;
}

function LibraryDialog({ wsId, initial, have, onClose, onAdded, onCustomise }: { wsId: string; initial: string | null; have: Set<string>; onClose: () => void; onAdded: (processId: string) => Promise<void>; onCustomise: (t: ProcessTemplate & { def: ProcessDef }) => void }) {
  const app = useApp();
  const { units } = useUnits();
  const { list, err } = useTemplates(wsId);
  const [pick, setPick] = useState<string | null>(initial);
  const [unit, setUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const dlg = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dlg.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('keydown', esc); prev?.focus?.(); };
  }, [onClose]);
  const t = list?.find((x) => x.id === pick) ?? null;
  const add = async () => {
    if (!t) return;
    setBusy(true);
    try { const d = await api.createOrgProcess(wsId, { template: t.id, unitId: unit || null, reason: 'added from the library by the CEO' }); app.showToast(`${t.title} added`); await onAdded(d.process.id); } catch (e) { app.showToast(errText(e)); setBusy(false); }
  };
  return (
    <div className="pr-dialog-scrim" onClick={onClose}>
      <div className="pr-dialog" role="dialog" aria-modal="true" aria-label="Add a process from the library" ref={dlg} tabIndex={-1} onClick={(e) => e.stopPropagation()} data-testid="process-library-dialog">
        <div className="pr-dialog-head">
          {t && <button className="co-iconbtn" onClick={() => setPick(null)} aria-label="Back to the library"><I d={P.chevL} size={14} /></button>}
          <h3>{t ? t.title : 'Add a process from the library'}</h3>
          <button className="co-iconbtn" onClick={onClose} aria-label="Close"><I d={P.x} size={14} /></button>
        </div>
        <div className="pr-dialog-body">
          {err && <div className="co-alert" role="alert">{err}</div>}
          {!list && <SkeletonRows rows={3} label="Loading templates" />}
          {list && !t && (
            <>
              <div className="co-dim" style={{ fontSize: 12.5 }}>Pick a template to see how it runs. Once added it is the company's own: the owner changes it from what its runs show.</div>
              <div className="pr-lib" data-testid="process-library">{list.map((x) => <TemplateCard key={x.id} t={x} added={have.has(x.id)} onClick={() => setPick(x.id)} />)}</div>
            </>
          )}
          {t && (
            <>
              <div className="co-dim" style={{ fontSize: 13, lineHeight: 1.5 }}>{t.summary}</div>
              <div className="pr-tpl-meta"><Pill plain>{MODE_WORD[t.mode] ?? t.mode}</Pill><Pill plain>{plural(t.steps, 'step')}</Pill><Pill plain>{CATEGORY_WORD[t.category] ?? t.category}</Pill><span>starts {t.triggers}</span></div>
              {t.def ? <ProcessGraph def={t.def} compact testid="process-template-graph" /> : <Empty compact title="No preview">This server does not send the template's steps.</Empty>}
            </>
          )}
        </div>
        {t && (
          <div className="pr-dialog-foot">
            <label className="co-field" style={{ flex: '1 1 220px', maxWidth: 320 }}><span>Owned by</span>
              <select className="co-input" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Owning department">
                <option value="">The company (the chief of staff)</option>
                {units.filter((u) => u.parentUnitId !== null).map((u) => <option key={u.id} value={u.id}>{u.name} (its head)</option>)}
              </select>
            </label>
            <span style={{ flex: 1 }} />
            <button className="co-btn ghost" onClick={() => setPick(null)}>Back</button>
            {t.def && <button className="co-btn" onClick={() => onCustomise({ ...t, def: t.def! })} data-testid="process-customise"><I d={P.edit} size={12} />Customise before adding</button>}
            <button className="co-btn primary" onClick={() => void add()} disabled={busy}>{have.has(t.id) ? 'Add another copy' : 'Add this process'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- one process ----

function ProcessPage({ wsId, processId, decider, onBack }: { wsId: string; processId: string; decider: boolean; onBack: () => void }) {
  const app = useApp();
  const names = useAgentNames();
  const [d, setD] = useState<OrgProcessDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | 'start' | 'edit' | 'retire'>(null);
  const [overlayRun, setOverlayRun] = useState<string | null | undefined>(undefined);
  const [notice, setNotice] = useState<SaveOutcome | null>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    try { setD(await api.orgProcess(wsId, processId)); setErr(null); } catch (e) { setErr(errText(e)); }
  }, [wsId, processId]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 20_000); return () => clearInterval(t); }, [load]);
  const nameOf = useCallback((id: string) => names.get(id)?.name, [names]);
  // The graph shows the newest open run until the CEO picks another (or none).
  const runId = overlayRun === undefined ? d?.runs.find((r) => r.status === 'running' || r.status === 'blocked')?.id ?? null : overlayRun;
  const run = d?.runs.find((r) => r.id === runId) ?? null;
  const overlay = useMemo(() => {
    if (!d?.def || !run) return null;
    const m = new Map<string, StepOverlay>();
    for (const [id, x] of runStates(d.def, run.steps)) m.set(id, { state: x.state, rounds: x.rounds, who: x.step.assigneeAgentId ? names.get(x.step.assigneeAgentId)?.name : undefined });
    return m;
  }, [d, run, names]);
  if (err && !d) return <div className="co-page"><button className="co-link pr-back" onClick={onBack}>← Processes</button><div className="co-alert" role="alert">{err}</div></div>;
  if (!d) return <div className="co-page"><SkeletonRows rows={5} label="Loading the process" /></div>;
  const p = d.process;
  const m = p.metrics;
  const blocked = d.runs.filter((r) => r.status === 'blocked');
  const openSuggestions = (d.suggestions ?? []).filter((x) => x.status === 'open');
  const attention: AttentionRow[] = [
    ...processAttention(p, { blockedRuns: blocked.length }).filter((a) => !a.id.endsWith(':ramp') && !a.id.endsWith(':suggest')).map((a): AttentionRow => ({
      ...a,
      ...(a.id.endsWith(':pending') ? { go: 'Inbox', onOpen: () => { app.go('inbox'); app.setInboxFilter('approvals'); } } : a.id.endsWith(':blocked') ? { go: 'See runs', onOpen: () => { setOverlayRun(blocked[0].id); graphRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } : {}),
    })),
    ...openSuggestions.map((sg): AttentionRow => ({ id: sg.id, tone: 'warn', title: sg.title.replace(/^Revise process: [^—]+— /, 'Suggested revision: '), why: sg.summary, ...(sg.taskId ? { go: "Owner's task", onOpen: () => app.openOrgTask(sg.taskId!) } : {}) })),
  ].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
  const stepExtra = (nodeId: string) => {
    if (!run || !d.def) return null;
    const x = runStates(d.def, run.steps).get(nodeId);
    if (!x) return <div className="co-faint">Not reached in {run.key}.</div>;
    return <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}><div className="co-faint" style={{ marginBottom: 6 }}>In {run.key}{run.title ? ` · ${run.title}` : ''}</div><StepLine s={x.step} state={x.state} /></div>;
  };
  return (
    <div className="co-page" data-testid="process-page">
      <button className="co-link pr-back" onClick={onBack}><I d={P.chevL} size={12} />Processes</button>
      <PageHeader title={<>{p.title} <span className="co-faint" style={{ fontWeight: 500, fontSize: 15 }}>v{p.version}</span></>}
        purpose={<>{p.description || 'A standing procedure of the company.'} {MODE_HINT[p.mode] ?? ''}</>}
        actions={decider ? <>
          {p.status === 'active' && <button className="co-btn primary" onClick={() => setPanel(panel === 'start' ? null : 'start')} aria-expanded={panel === 'start'}><I d={P.play} size={12} />Start a run</button>}
          {d.def && panel !== 'edit' && <button className="co-btn" onClick={() => { setPanel('edit'); setNotice(null); }} data-testid="process-edit"><I d={P.edit} size={12} />Edit</button>}
          <Menu label="More actions" trigger={<I d={P.dots} size={15} fill="currentColor" />} triggerClass="co-iconbtn" items={[{ id: 'retire', label: p.status === 'retired' ? 'Restore the process' : 'Retire the process', onSelect: () => setPanel('retire') }]} />
        </> : undefined} />
      <div className="pr-meta">
        <Pill tone={p.status === 'active' ? HEALTH_TONE[m.health] : 'muted'} title={m.why}>{p.status === 'active' ? HEALTH_WORD[m.health] : p.status}</Pill>
        <span>{MODE_WORD[p.mode] ?? p.mode}</span><span className="sep">·</span>
        <span>{CATEGORY_WORD[p.category] ?? p.category}</span><span className="sep">·</span>
        <Owner agent={p.ownerAgentId ? names.get(p.ownerAgentId) : undefined} name={p.ownerName} /><span>owns it for {p.unitId ? p.unitName : 'the company'}</span><span className="sep">·</span>
        <span>Starts {triggerWords(p.triggers)}</span>
      </div>
      {panel === 'retire' && (
        <div style={{ marginBottom: 14 }}>
          <ReasonForm question={p.status === 'retired' ? 'Bring it back? New runs can start again.' : 'Retire it? No new runs start; open runs finish on their version.'} confirm={p.status === 'retired' ? 'Restore' : 'Retire'} danger={p.status !== 'retired'}
            onConfirm={async (reason) => { setD(await api.retireOrgProcess(wsId, p.id, { reason, restore: p.status === 'retired' })); setPanel(null); app.showToast(p.status === 'retired' ? 'Restored' : 'Retired'); }} onCancel={() => setPanel(null)} />
        </div>
      )}
      {panel === 'start' && <StartForm wsId={wsId} p={p} def={d.def} onCancel={() => setPanel(null)} onDone={async () => { setPanel(null); setOverlayRun(undefined); await load(); }} />}
      {attention.length > 0 && <div style={{ marginBottom: 14 }}><Card title="Needs attention" aside={`${attention.length}`} flush><AttentionList items={attention} limit={3} testid="process-attention" /></Card></div>}
      {d.rollout && d.rollout.verdict !== 'collecting' && <Rollout wsId={wsId} processId={p.id} r={d.rollout} decider={decider} onChanged={(x) => setD(x)} />}
      <div className="co-stack">
        <div ref={graphRef} style={{ scrollMarginTop: 12 }}>
          {notice && (
            <div className="co-note" role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }} data-testid="process-save-outcome">
              <Pill tone={OUTCOME_TONE[notice.kind]}>{OUTCOME_WORD[notice.kind]}</Pill><span style={{ flex: 1 }}>{notice.text}</span>
              {notice.kind === 'pending' && <button className="co-link" onClick={() => { app.go('inbox'); app.setInboxFilter('approvals'); }}>Open the Inbox</button>}
              <button className="co-iconbtn" onClick={() => setNotice(null)} aria-label="Dismiss"><I d={P.x} size={12} /></button>
            </div>
          )}
          {panel === 'edit' && d.def
            ? (
              <Suspense fallback={<div className="co-card" style={{ padding: 14 }}><SkeletonRows rows={6} label="Loading the editor" /></div>}>
                <ProcessEditor wsId={wsId} initial={d.def} process={{ id: p.id, name: p.name, title: p.title, version: p.version }} ownerName={p.ownerAgentId ? names.get(p.ownerAgentId)?.name ?? p.ownerName : p.ownerName}
                  onCancel={() => setPanel(null)} onSaved={(next, outcome) => { setPanel(null); setD(next); setNotice(outcome); app.showToast(outcome.text); }} />
              </Suspense>
            )
            : d.def
            ? (
              <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>How it runs<GraphLegend /></span>}
                action={d.runs.length > 0 ? (
                  <label className="co-field" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="co-faint" style={{ fontWeight: 500 }}>Show</span>
                    <select className="co-input" style={{ width: 'auto', maxWidth: 240, padding: '4px 8px', fontSize: 12.5 }} value={runId ?? ''} onChange={(e) => setOverlayRun(e.target.value || null)} aria-label="Show a run on the graph" data-testid="process-overlay-select">
                      <option value="">The definition only</option>
                      {d.runs.slice(0, 20).map((r) => <option key={r.id} value={r.id}>{r.key}{r.title ? ` · ${r.title}` : ''} ({(RUN_STATUS_WORD[r.status] ?? r.status).toLowerCase()})</option>)}
                    </select>
                  </label>
                ) : undefined}>
                {run && <RunBanner run={run} def={d.def} onClear={() => setOverlayRun(null)} />}
                <ProcessGraph def={d.def} ownerName={p.ownerAgentId ? names.get(p.ownerAgentId)?.name ?? p.ownerName : p.ownerName} deviation={new Map(m.steps.map((s) => [s.nodeId, s.deviationRate]))} overlay={overlay} stepExtra={stepExtra} />
              </Card>
            )
            : <div className="co-card"><Empty compact title="No active version">Its first version waits for approval.</Empty></div>}
        </div>
        {d.rollout && d.rollout.verdict === 'collecting' && <Rollout wsId={wsId} processId={p.id} r={d.rollout} decider={decider} onChanged={(x) => setD(x)} />}
        <div className="pr-lower">
          <Runs wsId={wsId} d={d} decider={decider} shown={runId} onShow={(id) => { setOverlayRun(id); graphRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} onChanged={load} />
          <div className="co-stack">
            <Measures p={p} def={d.def} />
            <Versions wsId={wsId} d={d} decider={decider} nameOf={nameOf} onChanged={(x) => setD(x)} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Which run the graph shows, and how far it has come. */
function RunBanner({ run, def, onClear }: { run: RunDetail; def: ProcessDef; onClear: () => void }) {
  const prog = runProgress(def, run.steps);
  return (
    <div className="co-note" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }} data-testid="process-run-banner">
      <Pill tone={runTone(run.status)}>{RUN_STATUS_WORD[run.status] ?? run.status}</Pill>
      <span style={{ color: 'var(--text)', fontWeight: 600 }}>{run.key}{run.title ? ` · ${run.title}` : ''}</span>
      <span className="pr-run-progress"><Bar value={prog.total ? prog.done / prog.total : 0} tone={run.status === 'failed' ? 'bad' : run.status === 'done' ? 'ok' : undefined} label={`${prog.done} of ${prog.total} steps`} width={90} /><span className="co-num">{prog.done}/{prog.total} steps</span></span>
      {run.note && <span style={{ color: run.status === 'blocked' || run.status === 'failed' ? 'var(--warn-text)' : undefined }}>{run.note}</span>}
      <span style={{ flex: 1 }} />
      <button className="co-link" onClick={onClear}>Hide the run</button>
    </div>
  );
}

/** Outcomes (did runs get there) and conformance (did they follow the definition), side by side as a toggle. */
function Measures({ p, def }: { p: OrgProcess; def: ProcessDef | null }) {
  const [tab, setTab] = useState<'outcomes' | 'conformance'>('outcomes');
  const m = p.metrics;
  return (
    <Card title="Measures" aside={m.runs ? `last ${plural(m.runs, 'run')}` : undefined} action={<Segmented label="Measures" value={tab} onChange={setTab} options={[{ id: 'outcomes', label: 'Outcomes' }, { id: 'conformance', label: 'Conformance' }]} />}>
      {tab === 'outcomes'
        ? m.runs === 0
          ? <Empty compact title="No runs yet">Completion, cycle time and deviations show once runs finish.</Empty>
          : (
            <div style={{ display: 'grid', gap: 10 }}>
              {m.health !== 'healthy' && m.health !== 'new' && <div className={`co-note${m.health === 'watch' || m.health === 'revise' ? ' warn' : ''}`}>{m.why}</div>}
              <div className="co-metrics" data-testid="process-metrics">
                <Metric n={pct(m.completionRate)} label="completed" tone={m.completionRate !== null && m.completionRate < 0.5 ? 'bad' : undefined} />
                <Metric n={hrs(m.cycleHoursP50)} label="median cycle" />
                <Metric n={pct(m.deviationRate)} label="steps deviated" tone={m.health === 'revise' ? 'bad' : undefined} />
                <Metric n={pct(m.reworkRate)} label="rework" />
                <Metric n={m.slaBreaches} label="past deadline" tone={m.slaBreaches ? 'warn' : undefined} title="Steps past their SLA" />
              </div>
              <div className="co-faint">{m.done} done · {m.failed} failed · {m.cancelled} cancelled · {m.active} open</div>
            </div>
          )
        : <Conformance c={p.conformance} def={def} />}
    </Card>
  );
}

function Conformance({ c, def }: { c?: ProcessConformance; def: ProcessDef | null }) {
  if (!c || c.runs === 0) return <Empty compact title="No conformance yet">It is computed from the steps of finished runs.</Empty>;
  const title = (id: string) => (id === 'ad-hoc' ? 'Ad-hoc steps' : def?.nodes.find((n) => n.id === id)?.title ?? id);
  const counts: Array<[number, string, boolean]> = [[c.mustOpen, 'MUST left open', true], [c.waivers, `MUST waived${c.waiversPending ? ` (${c.waiversPending} pending)` : ''}`, false], [c.shouldSkips, 'SHOULD skipped', false], [c.adHoc, 'ad-hoc steps', false], [c.outOfOrder, 'out of order', true]];
  return (
    <div data-testid="process-conformance" style={{ display: 'grid', gap: 10 }}>
      <div className={`co-note${c.verdict === 'drifting' ? ' warn' : ''}`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Pill tone={CONFORMANCE_TONE[c.verdict]}>{CONFORMANCE_WORD[c.verdict]}</Pill>{c.why}</div>
      <div className="co-metrics">
        <Metric n={pct(c.rate)} label="steps followed" tone={c.verdict === 'drifting' ? 'warn' : undefined} />
        <Metric n={`${c.conformantRuns}/${c.runs}`} label="runs fully followed" />
      </div>
      <div className="co-faint" style={{ lineHeight: 1.6 }}>{counts.filter(([n]) => n > 0).map(([n, w, bad]) => <span key={w} style={{ marginRight: 12, color: bad ? 'var(--red-text)' : undefined }}><b className="co-num">{n}</b> {w}</span>)}{counts.every(([n]) => n === 0) && 'No deviations.'}</div>
      {c.steps.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="co-sub" style={{ margin: 0 }}>By step</div>
          {c.steps.map((s) => (
            <div key={s.nodeId} style={{ display: 'grid', gap: 3 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title(s.nodeId)}</span>
                <Bar value={s.rate} tone={s.rate < 0.7 ? 'warn' : 'ok'} label={`${title(s.nodeId)}: ${pct(s.rate)} followed`} width={70} />
                <span className="co-num" style={{ width: 82, textAlign: 'right', color: s.rate < 0.7 ? 'var(--warn-text)' : 'var(--text-dim)' }}>{pct(s.rate)} followed</span>
              </div>
              <div className="co-faint">{plural(s.checked, 'run')}{s.mustOpen ? ` · ${s.mustOpen} MUST open` : ''}{s.waivers ? ` · ${s.waivers} waived` : ''}{s.shouldSkips ? ` · ${s.shouldSkips} SHOULD skipped` : ''}{s.adHoc ? ` · ${s.adHoc} ad hoc` : ''}{s.outOfOrder ? ` · ${s.outOfOrder} out of order` : ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A ramped version beside the stable one: the comparison, the verdict, and the owner's promote or roll back. */
function Rollout({ wsId, processId, r, decider, onChanged }: { wsId: string; processId: string; r: ProcessRollout; decider: boolean; onChanged: (d: OrgProcessDetail) => void }) {
  const app = useApp();
  const [ask, setAsk] = useState<null | 'promote' | 'rollback'>(null);
  const act = async (action: 'promote' | 'rollback', reason: string) => {
    onChanged(await api.rolloutOrgProcess(wsId, processId, { action, reason }));
    app.showToast(action === 'promote' ? `v${r.candidateVersion} promoted` : `v${r.candidateVersion} rolled back`);
    setAsk(null);
  };
  const rows = cohortRows(r);
  return (
    <div style={{ marginBottom: 14 }} data-testid="process-rollout">
      <Card title={`Trying v${r.candidateVersion} on ${r.percent}% of new runs`} aside={<Pill tone={RAMP_TONE[r.verdict]}>{RAMP_WORD[r.verdict]}</Pill>}>
        <div className="co-dim" style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.5 }}>{r.why}. {r.auto ? 'The engine applies the verdict by itself.' : 'The owner decides when the verdict is in.'}</div>
        <div style={{ overflowX: 'auto', maxWidth: 680 }}>
          <table className="pr-cohorts">
            <thead><tr><th scope="col">Measure</th><th scope="col">v{r.stableVersion} · stable<br /><span style={{ fontWeight: 500 }}>{plural(r.stableFinished, 'finished run')}</span></th><th scope="col">v{r.candidateVersion} · trying<br /><span style={{ fontWeight: 500 }}>{plural(r.candidateFinished, 'finished run')}</span></th></tr></thead>
            <tbody>
              {rows.map((x) => <tr key={x.label}><td>{x.label}</td><td>{x.stable}</td><td className={x.worse ? 'worse' : undefined}>{x.candidate}{x.worse ? ' · worse' : ''}</td></tr>)}
            </tbody>
          </table>
        </div>
        {decider && (ask
          ? <ReasonForm question={ask === 'promote' ? `Promote v${r.candidateVersion}? Every new run then starts on it.` : `Roll back v${r.candidateVersion}? It takes no more runs; open ones finish on it.`} confirm={ask === 'promote' ? `Promote v${r.candidateVersion}` : 'Roll back'} danger={ask === 'rollback'} onConfirm={(reason) => act(ask, reason)} onCancel={() => setAsk(null)} />
          : (
            <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
              <button className={`co-btn small${r.verdict === 'promote' ? ' primary' : ''}`} onClick={() => setAsk('promote')}>Promote v{r.candidateVersion}</button>
              <button className={`co-btn small${r.verdict === 'rollback' ? ' primary' : ' ghost'}`} onClick={() => setAsk('rollback')}>Roll back</button>
            </div>
          ))}
      </Card>
    </div>
  );
}

function StartForm({ wsId, p, def, onCancel, onDone }: { wsId: string; p: OrgProcess; def: ProcessDef | null; onCancel: () => void; onDone: () => Promise<void> }) {
  const app = useApp();
  const inputs = useMemo(() => varsOf(def), [def]);
  const [title, setTitle] = useState('');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    const vars = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    setBusy(true); setProblem(null);
    try { const r = await api.startOrgProcessRun(wsId, p.id, { title: title.trim() || undefined, vars }); app.showToast(`${r.key} started`); await onDone(); } catch (e) { setProblem(errText(e)); setBusy(false); }
  };
  return (
    <form className="co-card" style={{ padding: 14, marginBottom: 14 }} aria-label={`Start a run of ${p.title}`} data-testid="process-start-form" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <div className="co-form">
        <div className="co-card-title">Start a run of {p.title}</div>
        <div className="co-form-row">
          <label className="co-field"><span>What this run is for</span><input className="co-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${p.title}: …`} autoFocus /></label>
          {inputs.map((k) => (
            <label key={k} className="co-field"><span>{k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ')}</span><input className="co-input" value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} aria-label={k} /><small>The steps' briefs use it as {'${'}{k}{'}'}.</small></label>
          ))}
        </div>
        {problem && <div className="co-alert" role="alert">{problem}</div>}
        <div className="co-form-foot">
          <button type="button" className="co-btn ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="co-btn primary" disabled={busy}>{busy ? 'Starting…' : 'Start the run'}</button>
        </div>
      </div>
    </form>
  );
}

// ---- runs and versions ----

const TL_STATE = (s: { status: string; current: number }): StepState | 'superseded' => (!s.current ? 'superseded' : (['done', 'active', 'failed', 'skipped', 'cancelled'] as string[]).includes(s.status) ? s.status as StepState : 'pending');

/** One step of a run: its state, who has it, its task, the deviations in full. */
function StepLine({ s, state }: { s: RunDetail['steps'][number]; state: StepState | 'superseded' }) {
  const app = useApp();
  const names = useAgentNames();
  const who = s.assigneeAgentId ? names.get(s.assigneeAgentId) : undefined;
  const outputs = Object.entries(s.outputs ?? {});
  const kind = s.nodeId.startsWith('undo:') ? 'Undo' : s.kind === 'stage' ? 'Choosing the next step' : s.kind === 'approval' ? 'Approval' : s.kind === 'meeting' ? 'Meeting' : s.kind === 'wait' ? 'Timer' : s.kind === 'subprocess' ? 'Sub-process' : null;
  const openMeeting = (id: string) => window.dispatchEvent(new CustomEvent<MeetingEventDetail>(MEETING_EVENT, { detail: { workspaceId: '', meetingId: id } }));
  return (
    <div className="pr-tl-body">
      <span className="pr-tl-title">
        {s.title}{s.attempt > 1 ? <Pill plain>round {s.attempt}</Pill> : null}
        {kind && <span className="co-faint" style={{ fontWeight: 500 }}>{kind}</span>}
      </span>
      <span className="pr-tl-meta">
        <span>{state === 'superseded' ? 'Sent back for another round' : `${STEP_STATE_WORD[state]}${s.outcome && s.outcome !== s.status && s.outcome !== 'done' ? `: ${s.outcome}` : ''}`}</span>
        {who && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>· <Avatar a={who} size={15} />{who.name}</span>}
        {s.taskKey && s.taskId && <>· <button className="co-link" onClick={() => app.openOrgTask(s.taskId!)}>{s.taskKey}</button></>}
        {s.meetingId && <>· <button className="co-link" onClick={() => openMeeting(s.meetingId!)}>Open the meeting</button></>}
        {s.approvalId && state === 'active' && <span>· waits in the Inbox</span>}
        {s.endedAt ? <span>· {ago(s.endedAt)}</span> : s.startedAt ? <span>· since {ago(s.startedAt)}</span> : null}
        {s.slaBreachedAt && <Pill tone="warn" plain>past its deadline</Pill>}
      </span>
      {outputs.length > 0 && <span className="pr-outputs">{outputs.map(([k, v]) => <span key={k} style={{ marginRight: 10 }}><b>{k}</b>: {String(v).slice(0, 80)}</span>)}</span>}
      {s.deviations.map((x, i) => (
        <div key={i} className="pr-dev">
          <b>{x.level.toUpperCase()} {x.status === 'waived' ? 'waived' : x.status === 'pending' ? 'waiver asked' : 'skipped'}</b>{x.item ? ` (${x.item})` : ''}: {x.reason}{x.alternative ? `. Instead: ${x.alternative}` : ''}
        </div>
      ))}
    </div>
  );
}

function Runs({ wsId, d, decider, shown, onShow, onChanged }: { wsId: string; d: OrgProcessDetail; decider: boolean; shown: string | null; onShow: (id: string) => void; onChanged: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [open, setOpen] = useState<string | null>(() => d.runs.find((r) => r.status === 'running' || r.status === 'blocked')?.id ?? null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const list = all ? d.runs : d.runs.slice(0, 8);
  return (
    <Card title="Runs" aside={`${d.runs.length}`} flush>
      {d.runs.length === 0 && <div style={{ padding: '4px 10px 8px' }}><Empty compact title="No runs yet">{`Runs start ${triggerWords(d.process.triggers)}.`}</Empty></div>}
      <div className="co-rows" data-testid="process-runs">
        {list.map((r) => {
          const prog = runProgress(d.def, r.steps);
          const live = r.steps.filter((s) => s.current && s.status === 'active' && s.kind !== 'stage');
          const ordered = [...r.steps].sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '') || a.attempt - b.attempt);
          return (
            <div key={r.id}>
              <button className="co-row" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                <span className="co-row-main">
                  <span className="co-row-title"><span className="co-key">{r.key}</span>{r.title || 'Run'}</span>
                  <span className="co-row-meta">
                    {live.length ? `Now: ${live.map((s) => `${s.title}${s.assigneeAgentId ? ` (${names.get(s.assigneeAgentId)?.name ?? 'a member'})` : ''}`).join(', ')}` : r.endedAt ? `Ended ${ago(r.endedAt)}` : `Started ${ago(r.startedAt)}`}
                    {` · v${r.version}`}
                  </span>
                </span>
                <span className="co-row-end">
                  {prog.total > 0 && <span className="pr-run-progress" title={`${prog.done} of ${prog.total} steps`}><Bar value={prog.done / prog.total} tone={r.status === 'failed' ? 'bad' : r.status === 'done' ? 'ok' : undefined} label={`${r.key}: ${prog.done} of ${prog.total} steps`} width={48} /><span className="co-num">{prog.done}/{prog.total}</span></span>}
                  {r.compensation && <Pill tone={r.compensation === 'partial' ? 'bad' : r.compensation === 'running' ? 'warn' : 'muted'} plain title="Undoing what the run did">{r.compensation === 'running' ? 'undoing' : r.compensation === 'partial' ? 'partly undone' : 'undone'}</Pill>}
                  <Pill tone={runTone(r.status)}>{RUN_STATUS_WORD[r.status] ?? r.status}</Pill><I d={open === r.id ? P.chevD : P.chevR} size={12} />
                </span>
              </button>
              {open === r.id && (
                <div style={{ padding: '6px 12px 12px 14px', display: 'grid', gap: 10 }}>
                  {r.note && <div className={`co-note${r.status === 'blocked' || r.status === 'failed' ? ' warn' : ''}`}>{r.note}</div>}
                  <ol className="pr-timeline" aria-label={`Steps of ${r.key}`}>
                    {ordered.filter((s) => s.kind !== 'stage').map((s) => {
                      const st = TL_STATE(s);
                      return (
                        <li key={s.id} className="pr-tl" data-state={st}>
                          <span className="pr-tl-mark" aria-label={st === 'superseded' ? 'sent back' : STEP_STATE_WORD[st]}>{st === 'done' ? <I d={P.check} size={10} sw={3} /> : st === 'failed' ? <I d={P.x} size={10} sw={3} /> : null}</span>
                          <StepLine s={s} state={st} />
                        </li>
                      );
                    })}
                    {(r.status === 'running' || r.status === 'blocked') && d.def && d.def.nodes.filter((n) => !n.compensation && !r.steps.some((s) => s.nodeId === n.id)).map((n) => (
                      <li key={`next-${n.id}`} className="pr-tl" data-state="pending">
                        <span className="pr-tl-mark" aria-label="not reached yet" />
                        <div className="pr-tl-body"><span className="pr-tl-title" style={{ color: 'var(--text-faint)', fontWeight: 500 }}>{n.title}</span></div>
                      </li>
                    ))}
                  </ol>
                  {Object.keys(r.vars).length > 0 && <div className="co-faint">Inputs: {Object.entries(r.vars).map(([k, v]) => `${k.replace(/_/g, ' ')} = ${String(v).slice(0, 60)}`).join(' · ')}</div>}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {d.def && <button className="co-btn small" onClick={() => onShow(r.id)} disabled={shown === r.id}>{shown === r.id ? 'Shown on the graph' : 'Show on the graph'}</button>}
                    {decider && (r.status === 'running' || r.status === 'blocked') && cancelling !== r.id && <button className="co-btn small ghost" onClick={() => setCancelling(r.id)}>Cancel run</button>}
                  </div>
                  {cancelling === r.id && <ReasonForm question="Cancel this run? Its open step tasks are cancelled, and what it did is undone where the process says how." confirm="Cancel the run" danger
                    onConfirm={async (reason) => { await api.cancelOrgProcessRun(wsId, r.id, reason); app.showToast(`${r.key} cancelled`); setCancelling(null); await onChanged(); }} onCancel={() => setCancelling(null)} />}
                </div>
              )}
            </div>
          );
        })}
        {d.runs.length > 8 && <button className="co-link" style={{ margin: '6px 10px' }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${d.runs.length} runs`}</button>}
      </div>
    </Card>
  );
}

const VERSION_WORD: Record<string, string> = { active: 'active', superseded: 'earlier', pending: 'waits for approval', rejected: 'rejected', candidate: 'trying', rolled_back: 'rolled back' };

function Versions({ wsId, d, decider, nameOf, onChanged }: { wsId: string; d: OrgProcessDetail; decider: boolean; nameOf: (id: string) => string | undefined; onChanged: (d: OrgProcessDetail) => void }) {
  const app = useApp();
  const [open, setOpen] = useState<number | null>(null);
  const [ask, setAsk] = useState<number | null>(null);
  const tone = { active: 'ok', superseded: 'muted', pending: 'warn', rejected: 'bad', candidate: 'info', rolled_back: 'bad' } as const;
  return (
    <Card title="Versions" aside={`${d.versions.length}`} flush>
      <div className="co-rows" data-testid="process-versions">
        {d.versions.map((v) => (
          <div key={v.id}>
            <button className="co-row" onClick={() => setOpen(open === v.version ? null : v.version)} aria-expanded={open === v.version}>
              <span className="co-row-main">
                <span className="co-row-title"><span className="co-key">v{v.version}</span>{v.reason}</span>
                <span className="co-row-meta">by {authorWords(v.author, nameOf)} · {ago(v.createdAt)}{v.diff.length ? ` · ${plural(v.diff.length, 'change')}` : ''}</span>
              </span>
              <span className="co-row-end"><Pill tone={tone[v.status]} plain={v.status === 'superseded'}>{VERSION_WORD[v.status] ?? v.status}</Pill></span>
            </button>
            {open === v.version && (
              <div style={{ padding: '2px 12px 10px 14px' }}>
                <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', fontSize: 12, color: 'var(--text-dim)', display: 'grid', gap: 3, fontFamily: 'var(--mono)' }} data-testid="process-diff">
                  {v.diff.map((l, i) => { const add = l.startsWith('+') || / \+ /.test(l) || / \+$/.test(l); const del = l.startsWith('-') || / − /.test(l); return <li key={i} style={{ color: add ? 'var(--ok-text)' : del ? 'var(--red-text)' : undefined, overflowWrap: 'anywhere' }}>{l}</li>; })}
                </ul>
                {v.status === 'pending' && <div className="co-faint" style={{ marginTop: 6 }}>It applies once approved in the Inbox.</div>}
                {decider && v.status === 'superseded' && (ask === v.version
                  ? <ReasonForm question={`Roll back to v${v.version}? This writes a new version with v${v.version}'s definition, at once.`} confirm={`Roll back to v${v.version}`} danger
                      onConfirm={async (reason) => { onChanged(await api.rollbackOrgProcess(wsId, d.process.id, { version: v.version, reason })); app.showToast(`Rolled back to v${v.version}`); setAsk(null); }} onCancel={() => setAsk(null)} />
                  : <button className="co-btn small" style={{ marginTop: 8 }} onClick={() => setAsk(v.version)}>Roll back to v{v.version}</button>)}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
