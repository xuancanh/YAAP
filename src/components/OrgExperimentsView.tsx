/** Experiments, the prediction ledger and reconciliation on screen
 *  (docs/experiments.md, execution-plan item 30; SPA item 32): the
 *  Experiments pane — proposed / running / decided lists, each card with the
 *  hypothesis, the metric and its source, direction and expected effect, the
 *  window as a progress bar, baseline versus current mean with n, the
 *  verdict and the revert rule, the CEO's start / stop / keep / revert and
 *  proposal form — then Calibration (per member: resolved, Brier,
 *  calibration against the trust bar, bias; open forecasts) and
 *  Reconciliation (the latest gaps with deep links, "Run now"). */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type CalibrationRow, type ChangeKind, type ExperimentInput, type MetricSource, type OrgDetail, type OrgExperiment, type OrgPlaybook, type OrgPrediction, type OrgTunable, type Reconciliation } from '../lib/api';
import { flattenIntent } from '../lib/org';
import {
  baselineVsCurrent, calibrationLabel, changeSummary, effectLabel, EXPERIMENT_STATUS_COLOR, experimentGroup, experimentHints, experimentProgress, fmtNum, groupGaps, pct, revertRuleLabel, verdictText,
} from '../lib/org3';
import { card, input, btn, pill, h2, faint, label, linkBtn, ago, useAgentNames, useFollowRef, useUnits, Avatar } from './org-ui';
import { useOrgRole } from './OrgSensingView';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 220) : 'failed');

export function ExperimentsPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const isCeo = role === 'ceo';
  const [list, setList] = useState<OrgExperiment[] | null>(null);
  const [sources, setSources] = useState<MetricSource[]>([]);
  const [proposing, setProposing] = useState(false);
  const [showDecided, setShowDecided] = useState(false);
  const refresh = useCallback(async () => {
    const [e, s] = await Promise.all([api.orgExperiments(wsId).catch((): OrgExperiment[] => []), api.orgMetricSources(wsId).catch((): MetricSource[] => [])]);
    setList(e); setSources(s);
  }, [wsId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => {
    if (app.orgFocus?.kind !== 'experiment' || !list) return;
    const hit = list.find((x) => x.id === app.orgFocus!.id || x.id.startsWith(app.orgFocus!.id));
    if (!hit) return;
    if (experimentGroup(hit.status) === 'decided') setShowDecided(true);
    requestAnimationFrame(() => {
      const el = document.getElementById(`exp-${hit.id}`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.style.outline = '2px solid var(--accent)'; setTimeout(() => { el.style.outline = ''; }, 2400); }
    });
    app.setOrgFocus(null);
  }, [list, app]);
  const act = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); await refresh(); void app.refreshWsOrg(); app.showToast(done); } catch (e) { app.showToast(errText(e)); } };
  const groups = { proposed: [] as OrgExperiment[], running: [] as OrgExperiment[], decided: [] as OrgExperiment[] };
  for (const e of list ?? []) groups[experimentGroup(e.status)].push(e);
  groups.decided.sort((a, b) => ((a.decidedAt ?? a.createdAt) < (b.decidedAt ?? b.createdAt) ? 1 : -1));
  const srcName = (id: string | null) => (id ? sources.find((s) => s.id === id)?.name ?? id.slice(0, 8) : null);
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={h2}>Experiments</h2>
          <div style={faint}>Every change meant to move a metric is a hypothesis: a measured metric, a direction, an expected effect, a window and a revert rule. The verdict is model-free — improved is kept, worse is reverted, inconclusive is extended once.</div>
        </div>
        {isCeo && <button style={btn(true)} onClick={() => setProposing(!proposing)}>{proposing ? 'Close' : 'Propose an experiment'}</button>}
      </div>
      {proposing && <ProposalForm org={org} sources={sources} onDone={async () => { setProposing(false); await refresh(); }} />}
      {list === null && <div style={faint}>Loading…</div>}
      {(['running', 'proposed'] as const).map((g) => (
        <section key={g} aria-label={g} style={{ marginBottom: 12 }}>
          <div style={{ ...label, marginBottom: 6 }}>{g} · {groups[g].length}</div>
          {list !== null && groups[g].length === 0 && <div style={{ ...faint, marginBottom: 6 }}>{g === 'running' ? 'Nothing is being measured right now.' : 'No proposals.'}</div>}
          {groups[g].map((e) => <ExperimentCard key={e.id} e={e} srcName={srcName} isCeo={isCeo} act={act} wsId={wsId} />)}
        </section>
      ))}
      {groups.decided.length > 0 && (
        <section aria-label="decided" style={{ marginBottom: 12 }}>
          <button style={linkBtn} onClick={() => setShowDecided(!showDecided)} aria-expanded={showDecided}>{showDecided ? 'Hide' : 'Show'} decided ({groups.decided.length})</button>
          {showDecided && <div style={{ marginTop: 6 }}>{groups.decided.map((e) => <ExperimentCard key={e.id} e={e} srcName={srcName} isCeo={isCeo} act={act} wsId={wsId} />)}</div>}
        </section>
      )}
      <CalibrationCard wsId={wsId} />
      <ReconciliationCard wsId={wsId} isCeo={isCeo} />
    </div>
  );
}

function ExperimentCard({ e, srcName, isCeo, act, wsId }: { e: OrgExperiment; srcName: (id: string | null) => string | null; isCeo: boolean; act: (fn: () => Promise<unknown>, done: string) => Promise<void>; wsId: string }) {
  const app = useApp();
  const follow = useFollowRef();
  const group = experimentGroup(e.status);
  const prog = experimentProgress(e);
  const verdict = verdictText(e);
  const color = EXPERIMENT_STATUS_COLOR[e.status] ?? 'var(--border)';
  const source = srcName(e.metricSourceId);
  const confirmRun = (what: string, fn: () => Promise<unknown>, done: string) => { if (confirm(what)) void act(fn, done); };
  return (
    <div id={`exp-${e.id}`} style={{ ...card, marginBottom: 8, borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={pill(color, '#fff')}>{e.status}</span>
        <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1, minWidth: 160 }}>{e.title}</span>
        <span style={pill()} title="What the experiment changes">{e.changeKind}</span>
        {e.extensions > 0 && <span style={pill()}>extended ×{e.extensions}</span>}
      </div>
      <div style={{ fontSize: 12.5, marginTop: 5, whiteSpace: 'pre-wrap' }}>{e.hypothesis}</div>
      <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginTop: 8, fontSize: 12 }}>
        <div><div style={label}>Change</div><div style={{ ...mono, fontSize: 11.5, overflowWrap: 'anywhere' }}>{changeSummary(e.changeKind, e.change)}</div></div>
        <div><div style={label}>Metric</div>{source ? <button style={linkBtn} onClick={() => { app.setOrgFocus({ kind: 'source', id: e.metricSourceId! }); app.setOrgPane('metrics'); }}>{source}</button> : <span style={faint}>unmeasured (other)</span>}</div>
        <div><div style={label}>Expected</div>{effectLabel(e)}</div>
        <div><div style={label}>Revert rule</div><span style={faint}>{revertRuleLabel(e.revertRule)}</span></div>
      </div>
      <div style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', ...faint, marginBottom: 3, flexWrap: 'wrap', gap: 6 }}><span>{prog.label}{e.design === 'slice' ? ' · slice (evaluated before/after)' : ''}</span><span style={mono}>{baselineVsCurrent(e)}</span></div>
        <div role="progressbar" aria-label="Window" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(prog.pct * 100)} style={{ height: 6, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.round(prog.pct * 100)}%`, background: color, borderRadius: 3 }} />
        </div>
      </div>
      {verdict && <div style={{ fontSize: 12.5, marginTop: 8, fontWeight: 500 }}>{verdict}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8, ...faint }}>
        <span>by {e.proposedBy} · {ago(e.createdAt)}</span>
        {e.decisionId && <button style={linkBtn} onClick={() => follow('decision', e.decisionId!)}>decision log</button>}
        {(e.approvalId || e.changeApprovalId) && e.status === 'proposed' && <button style={linkBtn} onClick={() => follow('approval', e.approvalId ?? e.changeApprovalId!)}>approval card</button>}
        {isCeo && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {e.status === 'proposed' && <button style={btn(true)} onClick={() => confirmRun(`Start "${e.title}"? The baseline is taken from the last ${e.windowDays} days of samples and the change (${changeSummary(e.changeKind, e.change)}) is applied now.`, () => api.orgExperimentAction(wsId, e.id, 'start'), 'Started — the baseline is snapshotted')}>Start</button>}
            {group === 'running' && <button style={btn()} onClick={() => confirmRun(`Keep "${e.title}" now? The change stays and the verdict is recorded.`, () => api.orgExperimentAction(wsId, e.id, 'keep'), 'Kept')}>Keep</button>}
            {group === 'running' && <button style={btn()} onClick={() => confirmRun(`Revert "${e.title}" now? ${e.changeKind === 'charter' || e.changeKind === 'structure' ? 'An inverse approval card is opened.' : 'The previous state is restored.'}`, () => api.orgExperimentAction(wsId, e.id, 'revert'), 'Reverted')}>Revert</button>}
            {(e.status === 'proposed' || group === 'running') && <button style={btn(false, true)} onClick={() => { const note = prompt(`Stop "${e.title}"? ${group === 'running' ? 'The change is reverted first. ' : ''}A note for the record:`); if (note !== null) void act(() => api.orgExperimentAction(wsId, e.id, 'stop', note), 'Stopped'); }}>Stop</button>}
          </span>
        )}
      </div>
    </div>
  );
}

const CHANGE_KINDS: ChangeKind[] = ['tunable', 'cadence', 'routing', 'playbook', 'charter', 'structure', 'other'];

function ProposalForm({ org, sources, onDone }: { org: OrgDetail; sources: MetricSource[]; onDone: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const { units } = useUnits();
  const [f, setF] = useState<Partial<ExperimentInput>>({ changeKind: 'tunable', change: {}, direction: 'up', effectKind: 'relative', windowDays: 14, design: 'before_after' });
  const [effect, setEffect] = useState('10');
  const [worse, setWorse] = useState('10');
  const [metricRef, setMetricRef] = useState('');
  const [structureJson, setStructureJson] = useState('[{"op": "move", "agent": "", "reportsTo": ""}]');
  const [tunables, setTunables] = useState<OrgTunable[]>([]);
  const [playbooks, setPlaybooks] = useState<OrgPlaybook[]>([]);
  useEffect(() => {
    void api.orgTunables(org.workspaceId).then((t) => setTunables(t.filter((x) => !x.key.startsWith('experiments.')))).catch(() => setTunables([]));
    void api.orgPlaybooks(org.workspaceId).then(setPlaybooks).catch(() => setPlaybooks([]));
  }, [org.workspaceId]);
  const krs = useMemo(() => flattenIntent(app.orgIntent).filter((g) => g.kind === 'key_result' && g.measuredBy), [app.orgIntent]);
  const live = sources.filter((s) => s.status === 'ok' || s.status === 'error' || s.status === 'stale');
  const change = f.change ?? {};
  const setChange = (k: string, v: unknown) => setF({ ...f, change: { ...change, [k]: v } });
  const effectNum = Number(effect);
  const body: Partial<ExperimentInput> = {
    ...f,
    expectedEffect: f.effectKind === 'relative' ? effectNum / 100 : effectNum,
    ...(metricRef.startsWith('kr:') ? { keyResult: metricRef.slice(3), metric: undefined } : metricRef ? { metric: metricRef, keyResult: undefined } : {}),
    revertRule: { worseBy: Number(worse) / 100, relative: true },
  };
  let structureErr: string | null = null;
  if (f.changeKind === 'structure') { try { const v = JSON.parse(structureJson) as unknown; if (!Array.isArray(v)) structureErr = 'steps are a JSON array'; else body.change = { changes: v }; } catch { structureErr = 'steps are not valid JSON'; } }
  const hints = [...experimentHints(body), ...(structureErr ? [structureErr] : []), ...(effect.trim() === '' || !Number.isFinite(effectNum) ? ['an expected effect'] : [])];
  const submit = async () => {
    try { await api.proposeOrgExperiment(org.workspaceId, body as ExperimentInput); app.showToast('Proposed — start it when ready'); await onDone(); } catch (e) { app.showToast(errText(e)); }
  };
  const tun = tunables.find((t) => t.key === change.key);
  return (
    <div role="form" aria-label="Propose an experiment" style={{ ...card, marginBottom: 12, display: 'grid', gap: 8 }}>
      <div><label style={label} htmlFor="ex-title">Title</label><input id="ex-title" value={f.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} style={input} placeholder="Shorter standups" /></div>
      <div><label style={label} htmlFor="ex-hyp">Hypothesis</label><textarea id="ex-hyp" value={f.hypothesis ?? ''} onChange={(e) => setF({ ...f, hypothesis: e.target.value })} rows={2} style={{ ...input, resize: 'vertical' }} placeholder="What changes, what it should move, and why" /></div>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <div><label style={label} htmlFor="ex-kind">Change</label>
          <select id="ex-kind" value={f.changeKind} onChange={(e) => setF({ ...f, changeKind: e.target.value as ChangeKind, change: {} })} style={input}>{CHANGE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select></div>
        {f.changeKind === 'tunable' && <>
          <div><label style={label} htmlFor="ex-tk">Tunable</label><select id="ex-tk" value={String(change.key ?? '')} onChange={(e) => setChange('key', e.target.value)} style={input}><option value="">Pick…</option>{tunables.map((t) => <option key={t.key} value={t.key}>{t.key} (now {t.value})</option>)}</select></div>
          <div><label style={label} htmlFor="ex-tv">New value{tun ? ` (${tun.min}–${tun.max})` : ''}</label><input id="ex-tv" value={String(change.value ?? '')} onChange={(e) => setChange('value', e.target.value === '' ? '' : Number(e.target.value))} inputMode="decimal" style={{ ...input, ...mono }} /></div>
        </>}
        {f.changeKind === 'routing' && <>
          <div><label style={label} htmlFor="ex-rc">Task class</label><input id="ex-rc" value={String(change.class ?? '')} onChange={(e) => setChange('class', e.target.value)} style={{ ...input, ...mono }} placeholder="review" /></div>
          <div><label style={label} htmlFor="ex-rt">Tier</label><select id="ex-rt" value={String(change.tier ?? '')} onChange={(e) => setChange('tier', e.target.value)} style={input}><option value="">Pick…</option>{['cheap', 'standard', 'strong'].map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
        </>}
        {f.changeKind === 'cadence' && <>
          <div><label style={label} htmlFor="ex-cu">Unit</label><select id="ex-cu" value={String(change.unit ?? '')} onChange={(e) => setChange('unit', e.target.value)} style={input}><option value="">The company</option>{units.filter((u) => u.parentUnitId !== null).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
          <div><label style={label} htmlFor="ex-ck">Meeting</label><select id="ex-ck" value={String(change.kind ?? '')} onChange={(e) => setChange('kind', e.target.value)} style={input}><option value="">Pick…</option>{['planning', 'standup', 'weekly_review', 'retro', 'board'].map((k) => <option key={k} value={k}>{k}</option>)}</select></div>
          <div><label style={label} htmlFor="ex-cc">Cron (or "off")</label><input id="ex-cc" value={String(change.cron ?? '')} onChange={(e) => setChange('cron', e.target.value)} style={{ ...input, ...mono }} placeholder="0 9 * * 1-5" /></div>
        </>}
        {f.changeKind === 'playbook' && <>
          <div><label style={label} htmlFor="ex-pb">Playbook</label><select id="ex-pb" value={String(change.playbook ?? '')} onChange={(e) => setChange('playbook', e.target.value)} style={input}><option value="">Pick…</option>{playbooks.filter((p) => p.status === 'active' || p.status === 'retired').map((p) => <option key={p.id} value={p.id}>{p.title} ({p.status})</option>)}</select></div>
          <div><label style={label} htmlFor="ex-pa">Action</label><select id="ex-pa" value={String(change.action ?? '')} onChange={(e) => setChange('action', e.target.value)} style={input}><option value="">Pick…</option><option value="activate">re-activate (retired only)</option><option value="retire">retire (active only)</option></select></div>
        </>}
        {f.changeKind === 'charter' && <>
          <div><label style={label} htmlFor="ex-ca">Member</label><select id="ex-ca" value={String(change.agent ?? '')} onChange={(e) => setChange('agent', e.target.value)} style={input}><option value="">Pick…</option>{org.members.filter((m) => m.status !== 'terminated').map((m) => <option key={m.id} value={m.agentId}>{names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)}</option>)}</select></div>
          <div><label style={label} htmlFor="ex-cm">Mode</label><select id="ex-cm" value={String(change.mode ?? 'append')} onChange={(e) => setChange('mode', e.target.value)} style={input}><option value="append">append</option><option value="replace">replace</option></select></div>
        </>}
      </div>
      {f.changeKind === 'charter' && <textarea aria-label="Charter text" value={String(change.text ?? '')} onChange={(e) => setChange('text', e.target.value)} rows={3} style={{ ...input, resize: 'vertical' }} placeholder="The charter text to append (or the replacement) — goes to you as a charter_change card" />}
      {f.changeKind === 'structure' && <div><label style={label} htmlFor="ex-st">Reorg steps (move, retitle, pause, resume — never terminate)</label><textarea id="ex-st" value={structureJson} onChange={(e) => setStructureJson(e.target.value)} rows={3} style={{ ...input, ...mono, resize: 'vertical' }} /></div>}
      {f.changeKind === 'other' && <div><label style={label} htmlFor="ex-od">What changes (the system applies nothing)</label><input id="ex-od" value={String(change.description ?? '')} onChange={(e) => setChange('description', e.target.value)} style={input} /></div>}
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <div><label style={label} htmlFor="ex-metric">Measured by</label>
          <select id="ex-metric" value={metricRef} onChange={(e) => setMetricRef(e.target.value)} style={input}>
            <option value="">{f.changeKind === 'other' ? 'Unmeasured' : 'Pick a metric…'}</option>
            {live.length > 0 && <optgroup label="Metric sources">{live.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>}
            {krs.length > 0 && <optgroup label="Key results bound to a source">{krs.map((g) => <option key={g.id} value={`kr:${g.id}`}>{g.title}</option>)}</optgroup>}
          </select></div>
        <div><label style={label} htmlFor="ex-dir">Better is</label><select id="ex-dir" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value as 'up' | 'down' })} style={input}><option value="up">up</option><option value="down">down</option></select></div>
        <div><label style={label} htmlFor="ex-eff">Expected effect</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <input id="ex-eff" value={effect} onChange={(e) => setEffect(e.target.value.replace(/[^\d.-]/g, ''))} inputMode="decimal" style={{ ...input, ...mono, minWidth: 0 }} />
            <select aria-label="Effect kind" value={f.effectKind} onChange={(e) => setF({ ...f, effectKind: e.target.value as 'relative' | 'absolute' })} style={{ ...input, width: 'auto' }}><option value="relative">%</option><option value="absolute">units</option></select>
          </div></div>
        <div><label style={label} htmlFor="ex-win">Window (days, 3–90)</label><input id="ex-win" value={String(f.windowDays ?? '')} onChange={(e) => setF({ ...f, windowDays: Number(e.target.value.replace(/\D/g, '')) || undefined })} inputMode="numeric" style={{ ...input, ...mono }} /></div>
        <div><label style={label} htmlFor="ex-rev">Revert if worse by (%)</label><input id="ex-rev" value={worse} onChange={(e) => setWorse(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" style={{ ...input, ...mono }} /></div>
        {units.length > 1 && <div><label style={label} htmlFor="ex-unit">Unit</label><select id="ex-unit" value={f.unitId ?? ''} onChange={(e) => setF({ ...f, unitId: e.target.value || undefined })} style={input}><option value="">The company</option>{units.filter((u) => u.parentUnitId !== null).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>}
      </div>
      {hints.length > 0 && <div style={{ fontSize: 12, color: 'var(--amber)' }}>Needs: {hints.join(' · ')}</div>}
      <div style={faint}>The server re-checks the change against its bounds and needs enough baseline samples (experiments.minSamples, 5 by default) to start. One running experiment per unit by default (effects would confound).</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button style={btn(true)} disabled={hints.length > 0} onClick={() => void submit()}>Propose</button></div>
    </div>
  );
}

function CalibrationCard({ wsId }: { wsId: string }) {
  const names = useAgentNames();
  const follow = useFollowRef();
  const [rows, setRows] = useState<CalibrationRow[] | null>(null);
  const [open, setOpen] = useState<OrgPrediction[]>([]);
  const [bar, setBar] = useState(0.7);
  const [showOpen, setShowOpen] = useState(false);
  useEffect(() => {
    void api.orgCalibration(wsId).then(setRows).catch(() => setRows([]));
    void api.orgPredictions(wsId, { status: 'open' }).then(setOpen).catch(() => setOpen([]));
    void api.orgTunables(wsId).then((t) => { const b = t.find((x) => x.key === 'trust.calibrationBar'); if (b) setBar(b.value); }).catch(() => undefined);
  }, [wsId]);
  return (
    <div style={{ ...card, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>Calibration</span>
        <span style={faint} title="trust.calibrationBar: promotion in the trust ledger needs at least this once a member is scored">trust bar {pct(bar)}</span>
      </div>
      <div style={{ ...faint, marginBottom: 6 }}>How close each member's forecasts land (1 − mean loss of its recent resolved forecasts). Below the bar, discount its estimates; its trust level does not rise.</div>
      {rows === null && <div style={faint}>Loading…</div>}
      {rows?.length === 0 && <div style={faint}>No members.</div>}
      {(rows ?? []).map((r) => {
        const l = calibrationLabel(r, bar);
        const w = r.calibration === null ? 0 : Math.round(r.calibration * 100);
        return (
          <div key={r.agentId} style={{ borderTop: '1px solid var(--border-soft)', padding: '6px 0' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Avatar a={names.get(r.agentId)} size={16} />
              <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 90 }}>{r.name}</span>
              <span style={{ fontSize: 12, color: l.below ? 'var(--amber)' : undefined, flex: 1, minWidth: 160 }}>{l.text}</span>
              <span style={{ ...faint, fontSize: 11 }}>{r.resolved} resolved · {r.open} open · Brier {r.brier === null ? '—' : r.brier.toFixed(3)} · {l.bias}</span>
            </div>
            <div aria-hidden style={{ position: 'relative', height: 6, background: 'var(--panel-2)', borderRadius: 3, marginTop: 4 }}>
              <div style={{ height: '100%', width: `${w}%`, background: l.below ? 'var(--amber)' : 'var(--green)', borderRadius: 3 }} />
              <div title={`trust bar ${pct(bar)}`} style={{ position: 'absolute', top: -2, bottom: -2, left: `${Math.round(bar * 100)}%`, width: 2, background: 'var(--text)' }} />
            </div>
          </div>
        );
      })}
      {open.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button style={linkBtn} onClick={() => setShowOpen(!showOpen)} aria-expanded={showOpen}>{showOpen ? 'Hide' : 'Show'} open forecasts ({open.length})</button>
          {showOpen && open.slice(0, 50).map((p) => (
            <div key={p.id} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontWeight: 600 }}>{names.get(p.agentId)?.name ?? p.agentId.slice(0, 8)}</span>
              <span style={{ flex: 1, minWidth: 140 }}>{p.question || `${p.subjectKind} ${p.subjectId.slice(0, 8)}`}</span>
              <span style={mono}>{p.forecast.kind === 'probability' ? pct(Number(p.forecast.value)) : `${String(p.forecast.value ?? '?')}${p.forecast.unit ? ` ${p.forecast.unit}` : ''}`}</span>
              {p.resolvesAt && <span style={faint}>by {p.resolvesAt.slice(0, 10)}</span>}
              {(p.subjectKind === 'task' || p.subjectKind === 'key_result' || p.subjectKind === 'experiment') && p.subjectId && <button style={linkBtn} onClick={() => follow(p.subjectKind === 'key_result' ? 'goal' : p.subjectKind, p.subjectId)}>open</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReconciliationCard({ wsId, isCeo }: { wsId: string; isCeo: boolean }) {
  const app = useApp();
  const follow = useFollowRef();
  const [r, setR] = useState<Reconciliation | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => { void api.orgReconciliation(wsId).then(setR).catch(() => setR({ at: null, gaps: [], checked: { keyResults: 0, tasks: 0, brief: false } })); }, [wsId]);
  const run = async () => {
    setRunning(true);
    try { const x = await api.runOrgReconciliation(wsId); setR(x); app.showToast(`${x.gaps.length} gap(s) found`); } catch (e) { app.showToast(errText(e)); } finally { setRunning(false); }
  };
  const groups = groupGaps(r?.gaps ?? []);
  return (
    <div style={{ ...card, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>Reconciliation</span>
        <span style={faint}>{r?.at ? `last sweep ${ago(r.at)} · ${r.checked.keyResults} key result(s), ${r.checked.tasks} task(s)${r.checked.brief ? ', the brief' : ''}` : 'no sweep yet'}</span>
        {isCeo && <button style={btn()} disabled={running} onClick={() => void run()}>{running ? 'Running…' : 'Run now'}</button>}
      </div>
      <div style={{ ...faint, marginBottom: 6 }}>Once a day what members claim is compared with ground truth the doers did not write. Gaps go into the auditor's sample; a claim mismatch is also a minor incident.</div>
      {r && r.gaps.length === 0 && <div style={faint}>{r.at ? 'No gaps in the latest sweep.' : 'Nothing reconciled yet.'}</div>}
      {groups.map((g) => (
        <div key={g.kind} style={{ marginTop: 6 }}>
          <div style={{ ...label }}>{g.label} · {g.gaps.length} <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>— {g.blurb}</span></div>
          {g.gaps.map((x, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '4px 0', borderTop: '1px solid var(--border-soft)', flexWrap: 'wrap', alignItems: 'baseline' }}>
              <span style={{ fontWeight: 600 }}>{x.title}</span>
              <span style={{ ...faint, flex: 1, minWidth: 160 }}>{x.detail}{x.claimed !== undefined && x.claimed !== null ? ` · claimed ${String(x.claimed)}` : ''}{x.measured !== undefined && x.measured !== null ? ` · measured ${fmtNum(x.measured)}` : ''}</span>
              {x.link && <button style={linkBtn} onClick={() => follow(x.link!.kind, x.link!.id)}>open</button>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
