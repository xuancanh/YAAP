/** Item 31 on screen (docs/boundary.md, docs/evals.md, docs/owners-seat.md;
 *  SPA item 32 part two): the Evals pane (golden cases per role, runs with
 *  pass rate against the baseline, "Run eval" with a candidate), the
 *  Outcomes pane (value realised against spend per objective, measured
 *  movement, what an outcome is worth, value events), Settings' delegations
 *  and the boundary table, the capacity strip on the board, and the eval
 *  line a gated charter or routing card carries. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import {
  api, type BoundaryRule, type CardEval, type EvalCandidateKind, type EvalCase, type EvalRun, type HumanRole, type OrgCapacity, type OrgDelegation, type OrgDetail, type OrgHuman, type OutcomeRow, type ValueEvent,
} from '../lib/api';
import { flattenIntent } from '../lib/org';
import { delegationOptions, evalRunText, fmtNum, fmtUsd2, movementText, roiText, roleKeyOf, VERDICT_COLOR, VERDICT_LABEL_B, wipLabel, CLASS_LABEL, describeCheck } from '../lib/org3';
import { card, input, btn, pill, h2, faint, label, linkBtn, ago, useAgentNames, useFollowRef, useUnits, Avatar } from './org-ui';
import { useOrgRole } from './OrgSensingView';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 220) : 'failed');

// ---- Evals ----

export function EvalsPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const isCeo = role === 'ceo';
  const names = useAgentNames();
  const [cases, setCases] = useState<EvalCase[] | null>(null);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [roleKey, setRoleKey] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const refresh = useCallback(async () => {
    const [c, r] = await Promise.all([api.orgEvalCases(wsId).catch((): EvalCase[] => []), api.orgEvalRuns(wsId).catch((): EvalRun[] => [])]);
    setCases(c); setRuns(r);
  }, [wsId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const members = org.members.filter((m) => m.status === 'active');
  const roles = useMemo(() => {
    const keys = new Map<string, string[]>();
    for (const m of members) { const k = roleKeyOf(m); keys.set(k, [...(keys.get(k) ?? []), names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)]); }
    for (const c of cases ?? []) if (!keys.has(c.roleKey)) keys.set(c.roleKey, []);
    return [...keys.entries()].map(([key, who]) => ({ key, who, cases: (cases ?? []).filter((c) => c.roleKey === key).length })).sort((a, b) => b.cases - a.cases || a.key.localeCompare(b.key));
  }, [members, cases, names]);
  const current = roleKey || roles[0]?.key || '';
  const roleCases = (cases ?? []).filter((c) => c.roleKey === current);
  const roleRuns = runs.filter((r) => r.roleKey === current && r.kind === 'candidate');
  const act = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); await refresh(); app.showToast(done); } catch (e) { app.showToast(errText(e)); } };
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={h2}>Evals</h2>
        <div style={faint}>Each role keeps a golden set of past work with known-good outcomes, harvested when a task is accepted by its checks or on the first review. A charter, playbook, model or routing change is replayed against it in a sandbox first; a regression blocks it.</div>
      </div>
      <div role="tablist" aria-label="Role" style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
        {roles.map((r) => (
          <button key={r.key} role="tab" aria-selected={r.key === current} onClick={() => setRoleKey(r.key)} title={r.who.join(', ')}
            style={{ ...pill(r.key === current ? 'var(--accent)' : 'var(--panel-2)', r.key === current ? '#fff' : 'var(--text)'), padding: '3px 9px', cursor: 'pointer' }}>{r.key} <span style={{ opacity: .7 }}>{r.cases}</span></button>
        ))}
        {roles.length === 0 && <span style={faint}>No members yet.</span>}
      </div>
      {current && (
        <>
          <div style={{ ...card, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>Golden set · {current} · {roleCases.length} case(s)</span>
              {isCeo && <button style={btn()} onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add a case'}</button>}
              {isCeo && roleCases.length > 0 && <button style={btn(true)} onClick={() => setRunning(!running)}>{running ? 'Close' : 'Run eval'}</button>}
            </div>
            {adding && <AddCaseForm wsId={wsId} roleKey={current} onDone={async () => { setAdding(false); await refresh(); }} />}
            {running && <RunEvalForm wsId={wsId} roleKey={current} org={org} onDone={async () => { setRunning(false); await refresh(); }} />}
            {cases !== null && roleCases.length === 0 && <div style={faint}>No cases yet — they are harvested from accepted work{isCeo ? ', or add one from a task' : ''}.</div>}
            {roleCases.map((c) => (
              <div key={c.id} style={{ borderTop: '1px solid var(--border-soft)', padding: '6px 0', display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <span style={pill()} title="How the case was harvested">{c.source}</span>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{c.taskSnapshot?.title ?? '(untitled)'}</div>
                  <div style={{ ...faint, fontSize: 11.5, overflowWrap: 'anywhere' }}>
                    {c.expected?.checks.length ? `checks: ${c.expected.checks.map((x) => describeCheck(x)).join('; ')}` : `rubric: ${(c.expected?.rubric ?? '').slice(0, 160) || '—'}`}
                  </div>
                </div>
                <span style={faint}>{ago(c.createdAt)}</span>
                {isCeo && <button style={{ ...linkBtn, color: 'var(--red)' }} onClick={() => { if (confirm('Retire this golden case? It stops counting in runs.')) void act(() => api.retireOrgEvalCase(wsId, c.id), 'Case retired'); }}>Retire</button>}
              </div>
            ))}
          </div>
          <div style={card}>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>Runs · {current}</div>
            {roleRuns.length === 0 && <div style={faint}>No candidate run yet. Gated changes (charter, routing, a new playbook version) run here on their own.</div>}
            {roleRuns.map((r) => <EvalRunRow key={r.id} r={r} />)}
          </div>
        </>
      )}
    </div>
  );
}

function EvalRunRow({ r }: { r: EvalRun }) {
  const [open, setOpen] = useState(false);
  const t = evalRunText(r);
  return (
    <div style={{ borderTop: '1px solid var(--border-soft)', padding: '6px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={pill(t.color === 'var(--text-dim)' ? 'var(--panel-2)' : t.color, t.color === 'var(--text-dim)' ? 'var(--text)' : '#fff')}>{r.verdict || r.status}</span>
        <span style={{ fontSize: 12.5 }}>{r.candidate ? `${r.candidate.kind}${r.candidate.ref ? ` ${r.candidate.ref.slice(0, 24)}` : ''} → ${r.candidate.after.replace(/\s+/g, ' ').slice(0, 60)}` : 'candidate'}</span>
        <span style={{ fontSize: 12, color: t.color, flex: 1, minWidth: 160 }}>{t.text}</span>
        <span style={faint}>{r.requestedBy} · {ago(r.startedAt)} · ${r.usd.toFixed(2)}</span>
        <button style={linkBtn} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'hide' : 'cases'}</button>
      </div>
      {open && r.results.map((x) => (
        <div key={x.caseId} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '2px 0 2px 10px', flexWrap: 'wrap' }}>
          <span style={{ color: x.pass === true ? 'var(--green)' : x.pass === false ? 'var(--red)' : 'var(--text-faint)', minWidth: 52 }}>{x.pass === true ? 'pass' : x.pass === false ? 'fail' : x.gradedBy === 'skipped' ? 'skipped' : 'ungraded'}</span>
          <span style={{ ...faint }}>{x.gradedBy}</span>
          <span style={{ flex: 1, minWidth: 140, overflowWrap: 'anywhere' }}>{x.detail}</span>
        </div>
      ))}
    </div>
  );
}

function AddCaseForm({ wsId, roleKey, onDone }: { wsId: string; roleKey: string; onDone: () => Promise<void> }) {
  const app = useApp();
  const [from, setFrom] = useState<'task' | 'written'>('task');
  const [taskId, setTaskId] = useState('');
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const [rubric, setRubric] = useState('');
  const ok = from === 'task' ? taskId.trim().length >= 6 : title.trim() && rubric.trim();
  const save = async () => {
    try {
      await api.addOrgEvalCase(wsId, from === 'task' ? { roleKey, taskId: taskId.trim(), ...(rubric.trim() ? { rubric: rubric.trim() } : {}) } : { roleKey, title: title.trim(), brief: { outcome, done_when: rubric }, rubric: rubric.trim() });
      app.showToast('Golden case added'); await onDone();
    } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div role="form" aria-label="Add a golden case" style={{ display: 'grid', gap: 8, margin: '6px 0 10px', padding: 10, border: '1px dashed var(--border)', borderRadius: 9 }}>
      <div role="radiogroup" aria-label="Source" style={{ display: 'flex', gap: 10, fontSize: 12.5 }}>
        <label><input type="radio" checked={from === 'task'} onChange={() => setFrom('task')} /> from a task</label>
        <label><input type="radio" checked={from === 'written'} onChange={() => setFrom('written')} /> written by hand</label>
      </div>
      {from === 'task'
        ? <div><label style={label} htmlFor="ec-task">Task id (or its first 8 characters)</label><input id="ec-task" value={taskId} onChange={(e) => setTaskId(e.target.value)} style={{ ...input, ...mono }} /></div>
        : <>
          <div><label style={label} htmlFor="ec-title">Title</label><input id="ec-title" value={title} onChange={(e) => setTitle(e.target.value)} style={input} /></div>
          <div><label style={label} htmlFor="ec-out">Outcome</label><textarea id="ec-out" value={outcome} onChange={(e) => setOutcome(e.target.value)} rows={2} style={{ ...input, resize: 'vertical' }} /></div>
        </>}
      <div><label style={label} htmlFor="ec-rub">Rubric{from === 'task' ? ' (optional — defaults to its done_when)' : ''}</label><textarea id="ec-rub" value={rubric} onChange={(e) => setRubric(e.target.value)} rows={2} style={{ ...input, resize: 'vertical' }} /></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button style={btn(true)} disabled={!ok} onClick={() => void save()}>Add to {roleKey}</button></div>
    </div>
  );
}

function RunEvalForm({ wsId, roleKey, org, onDone }: { wsId: string; roleKey: string; org: OrgDetail; onDone: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [kind, setKind] = useState<EvalCandidateKind>('charter');
  const [ref, setRef] = useState('');
  const [after, setAfter] = useState('');
  const [busy, setBusy] = useState(false);
  const holders = org.members.filter((m) => m.status === 'active' && roleKeyOf(m) === roleKey);
  const ok = after.trim() && (kind !== 'routing' || ref.trim());
  const run = async () => {
    setBusy(true);
    try { const r = await api.runOrgEval(wsId, { roleKey, candidate: { kind, ...(ref.trim() ? { ref: ref.trim() } : {}), after } }); app.showToast(`Eval: ${evalRunText(r).text}`); await onDone(); } catch (e) { app.showToast(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div role="form" aria-label="Run an eval" style={{ display: 'grid', gap: 8, margin: '6px 0 10px', padding: 10, border: '1px dashed var(--border)', borderRadius: 9 }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <div><label style={label} htmlFor="ev-kind">Candidate</label>
          <select id="ev-kind" value={kind} onChange={(e) => { setKind(e.target.value as EvalCandidateKind); setRef(''); setAfter(''); }} style={input}>
            <option value="charter">charter</option><option value="playbook">playbook body</option><option value="model">model</option><option value="routing">routing tier</option>
          </select></div>
        {kind === 'charter' && <div><label style={label} htmlFor="ev-ref">Member</label><select id="ev-ref" value={ref} onChange={(e) => setRef(e.target.value)} style={input}><option value="">{holders.length ? 'The role\'s first member' : 'Any'}</option>{holders.map((m) => <option key={m.id} value={m.agentId}>{names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)}</option>)}</select></div>}
        {kind === 'playbook' && <div><label style={label} htmlFor="ev-ref">Playbook (id or name)</label><input id="ev-ref" value={ref} onChange={(e) => setRef(e.target.value)} style={{ ...input, ...mono }} /></div>}
        {kind === 'routing' && <div><label style={label} htmlFor="ev-ref">Task class</label><input id="ev-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="review" style={{ ...input, ...mono }} /></div>}
        {kind === 'routing' && <div><label style={label} htmlFor="ev-after">Tier</label><select id="ev-after" value={after} onChange={(e) => setAfter(e.target.value)} style={input}><option value="">Pick…</option>{['cheap', 'standard', 'strong'].map((t) => <option key={t} value={t}>{t}</option>)}</select></div>}
        {kind === 'model' && <div><label style={label} htmlFor="ev-after">Model id</label><input id="ev-after" value={after} onChange={(e) => setAfter(e.target.value)} style={{ ...input, ...mono }} /></div>}
      </div>
      {(kind === 'charter' || kind === 'playbook') && <textarea aria-label={kind === 'charter' ? 'Candidate charter' : 'Candidate playbook body'} value={after} onChange={(e) => setAfter(e.target.value)} rows={5} placeholder={kind === 'charter' ? 'The charter to try in place of the current one' : 'The playbook body to try'} style={{ ...input, resize: 'vertical' }} />}
      <div style={faint}>Replays up to evals.casesPerRun cases on the current configuration (cached) and on the candidate, sandboxed — nothing executes. Spend is capped by evals.runUsdCap.</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button style={btn(true)} disabled={!ok || busy} onClick={() => void run()}>{busy ? 'Running…' : 'Run eval'}</button></div>
    </div>
  );
}

/** The eval result a gated charter or routing card carries (`payload.eval`). */
export function CardEvalLine({ ev }: { ev: CardEval | undefined }) {
  if (!ev) return null;
  const t = evalRunText({ passRate: ev.passRate, baselinePassRate: ev.baselinePassRate, verdict: ev.verdict });
  return (
    <div role="status" style={{ fontSize: 12.5, marginTop: 6, padding: '6px 8px', borderRadius: 8, border: `1px solid ${t.color}`, color: t.color }}>
      Eval{ev.roleKey ? ` (${ev.roleKey})` : ''}: {ev.passRate === null && ev.baselinePassRate === null ? ev.verdict : t.text}{ev.summary ? <div style={{ ...faint, marginTop: 2 }}>{ev.summary}</div> : null}
    </div>
  );
}

// ---- Outcomes ----

export function OutcomesPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const isCeo = role === 'ceo';
  const follow = useFollowRef();
  const { byId } = useUnits();
  const [rows, setRows] = useState<OutcomeRow[] | null>(null);
  const [events, setEvents] = useState<ValueEvent[]>([]);
  const [valuing, setValuing] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [o, e] = await Promise.all([api.orgOutcomes(wsId).catch((): OutcomeRow[] => []), api.orgValueEvents(wsId, new Date(Date.now() - 30 * 86_400_000).toISOString()).catch((): ValueEvent[] => [])]);
    setRows(o); setEvents(e);
  }, [wsId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (app.orgFocus?.kind !== 'unit' || !rows) return;
    const el = document.querySelector<HTMLElement>(`[data-unit="${app.orgFocus.id}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.style.outline = '2px solid var(--amber)'; setTimeout(() => { el.style.outline = ''; }, 2400); }
    app.setOrgFocus(null);
  }, [rows, app]);
  const goals = useMemo(() => new Map(flattenIntent(app.orgIntent).map((g) => [g.id, g])), [app.orgIntent]);
  const total = (rows ?? []).reduce((a, r) => ({ v: a.v + r.valueUsd, s: a.s + r.spentUsd }), { v: 0, s: 0 });
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={h2}>Outcomes</h2>
        <div style={faint}>What moved in the world, and what it was worth against what it cost this month. Value comes from key results bound to a metric source, priced by you; a unit whose objectives move nothing for weeks gets a no-outcome signal (outcome or shrink).</div>
      </div>
      {rows && rows.length > 0 && (
        <div style={{ ...card, display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
          <div><div style={label}>Value realised · month</div><div style={{ ...mono, fontSize: 20, fontWeight: 700 }}>{fmtUsd2(total.v)}</div></div>
          <div><div style={label}>Spent · month</div><div style={{ ...mono, fontSize: 20, fontWeight: 700 }}>{fmtUsd2(total.s)}</div></div>
          <div><div style={label}>Return</div><div style={{ ...mono, fontSize: 20, fontWeight: 700 }}>{total.s > 0 ? `${fmtNum(Math.round((total.v / total.s) * 100) / 100)}×` : '—'}</div></div>
        </div>
      )}
      {rows === null && <div style={faint}>Loading…</div>}
      {rows?.length === 0 && <div style={{ ...card, ...faint }}>No active objectives.</div>}
      {(rows ?? []).map((o) => {
        const r = roiText(o);
        const unit = o.unitId ? byId.get(o.unitId) : null;
        return (
          <div key={o.objectiveId} data-unit={o.unitId ?? ''} style={{ ...card, marginBottom: 10, borderLeft: `3px solid ${r.color}` }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <button style={{ ...linkBtn, color: 'var(--text)', fontSize: 13.5 }} onClick={() => follow('goal', o.objectiveId)}>{o.title}</button>
              {unit && unit.parentUnitId !== null && <span style={pill()}>{unit.name}</span>}
              <span style={{ fontSize: 12.5, color: r.color, marginLeft: 'auto' }}>{r.text}</span>
            </div>
            {o.keyResults.map((k) => {
              const g = goals.get(k.goalId);
              const priced = g && (g.valuePerUnit != null || g.valueOnAchieve != null);
              return (
                <div key={k.goalId} style={{ borderTop: '1px solid var(--border-soft)', padding: '6px 0' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, flex: 1, minWidth: 160 }}>{k.title}</span>
                    <span style={{ fontSize: 12, color: !k.measured ? 'var(--amber)' : (k.movement7d ?? 0) > 0 ? 'var(--green)' : 'var(--text-dim)' }}>{movementText(k)}</span>
                    <span style={{ ...faint, fontSize: 11.5 }} title={g?.valueNote || undefined}>{priced ? `${g?.valuePerUnit != null ? `${fmtUsd2(g.valuePerUnit)}/unit` : ''}${g?.valuePerUnit != null && g?.valueOnAchieve != null ? ' · ' : ''}${g?.valueOnAchieve != null ? `${fmtUsd2(g.valueOnAchieve)} on target` : ''}` : 'not priced'}</span>
                    {isCeo && <button style={linkBtn} onClick={() => setValuing(valuing === k.goalId ? null : k.goalId)}>{valuing === k.goalId ? 'close' : 'set value'}</button>}
                  </div>
                  {valuing === k.goalId && g && <ValueForm wsId={wsId} goalId={k.goalId} initial={{ valuePerUnit: g.valuePerUnit ?? null, valueOnAchieve: g.valueOnAchieve ?? null, valueNote: g.valueNote ?? '' }} unitLabel={g.unitLabel} onDone={async () => { setValuing(null); await app.refreshWsOrg(); await refresh(); }} />}
                </div>
              );
            })}
          </div>
        );
      })}
      <div style={{ ...card, marginTop: 10 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>Value events · 30 days</div>
        {events.length === 0 && <div style={faint}>None yet — price a measured key result and its samples become value.</div>}
        {events.slice(0, 40).map((e) => (
          <div key={e.id} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', flexWrap: 'wrap', borderTop: '1px solid var(--border-soft)' }}>
            <span style={{ ...mono, minWidth: 70, color: e.valueUsd >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtUsd2(e.valueUsd)}</span>
            <span style={{ flex: 1, minWidth: 140 }}>{goals.get(e.goalId)?.title ?? e.goalId.slice(0, 8)}{e.kind === 'achieved' ? ' — target reached' : ` · ${e.delta >= 0 ? '+' : ''}${fmtNum(e.delta)} (${fmtNum(e.fromValue)} → ${fmtNum(e.toValue)})`}</span>
            <span style={faint}>{ago(e.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ValueForm({ wsId, goalId, initial, unitLabel, onDone }: { wsId: string; goalId: string; initial: { valuePerUnit: number | null; valueOnAchieve: number | null; valueNote: string }; unitLabel: string; onDone: () => Promise<void> }) {
  const app = useApp();
  const [per, setPer] = useState(initial.valuePerUnit === null ? '' : String(initial.valuePerUnit));
  const [on, setOn] = useState(initial.valueOnAchieve === null ? '' : String(initial.valueOnAchieve));
  const [note, setNote] = useState(initial.valueNote);
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const bad = [per, on].some((v) => v.trim() !== '' && !Number.isFinite(Number(v)));
  const save = async () => { try { await api.setOrgGoalValue(wsId, goalId, { valuePerUnit: num(per), valueOnAchieve: num(on), valueNote: note }); app.showToast('Value set (audited)'); await onDone(); } catch (e) { app.showToast(errText(e)); } };
  return (
    <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', alignItems: 'end', marginTop: 6 }}>
      <div><label style={label} htmlFor={`v-per-${goalId}`}>USD per {unitLabel || 'unit'}</label><input id={`v-per-${goalId}`} value={per} onChange={(e) => setPer(e.target.value.replace(/[^\d.-]/g, ''))} inputMode="decimal" style={{ ...input, ...mono }} placeholder="0.50" /></div>
      <div><label style={label} htmlFor={`v-on-${goalId}`}>USD on reaching target</label><input id={`v-on-${goalId}`} value={on} onChange={(e) => setOn(e.target.value.replace(/[^\d.-]/g, ''))} inputMode="decimal" style={{ ...input, ...mono }} /></div>
      <div style={{ gridColumn: 'span 2', minWidth: 0 }}><label style={label} htmlFor={`v-note-${goalId}`}>Why it is worth that</label><input id={`v-note-${goalId}`} value={note} onChange={(e) => setNote(e.target.value)} style={input} /></div>
      <button style={btn(true)} disabled={bad} onClick={() => void save()}>Save</button>
    </div>
  );
}

// ---- Settings: delegations and the boundary ----

export function GovernanceSettings({ wsId }: { wsId: string }) {
  const app = useApp();
  const [rules, setRules] = useState<BoundaryRule[]>([]);
  const [dels, setDels] = useState<OrgDelegation[] | null>(null);
  const [humans, setHumans] = useState<{ me: HumanRole | null; list: OrgHuman[] }>({ me: null, list: [] });
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [b, d, h] = await Promise.all([api.orgBoundary(wsId), api.orgDelegations(wsId), api.orgHumans(wsId).catch(() => null)]);
      setRules(b.rules); setDels(d); if (h) setHumans({ me: h.me.role, list: h.humans }); setErr(null);
    } catch (e) { setErr(errText(e)); }
  }, [wsId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const isCeo = humans.me === 'ceo';
  if (err) return null;
  return (
    <>
      <div style={{ ...card, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Delegated approvals</div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>Routine cards can be decided by someone else: a person with standing, or a member role (judged on another model family; "ask" leaves the card to you). The constitution, caps, the kill switch, the external floor, trust ceilings, audit settings, delegation itself and metric sources are never delegable.</div>
        {dels !== null && dels.length === 0 && <div style={{ ...faint, marginTop: 8 }}>No delegations — every card comes to you.</div>}
        {(dels ?? []).map((d) => (
          <div key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid var(--border-soft)', marginTop: 6 }}>
            <span style={pill('var(--accent-dim)', 'var(--text)')}>{CLASS_LABEL[d.kind] ? `${CLASS_LABEL[d.kind]} actions` : d.kind}</span>
            <span style={{ fontSize: 12.5, flex: 1, minWidth: 160 }}>→ {d.delegateType === 'human' ? `🧑 ${app.nameOf(d.delegateRef)}` : `the ${d.delegateRef} role`}{d.maxUsd !== null ? ` · up to ${fmtUsd2(d.maxUsd)}` : ''}</span>
            <span style={faint}>{ago(d.createdAt)}</span>
            {isCeo && <button style={{ ...linkBtn, color: 'var(--red)' }} onClick={() => void (async () => { try { await api.revokeOrgDelegation(wsId, d.id); await refresh(); app.showToast('Revoked'); } catch (e) { app.showToast(errText(e)); } })()}>Revoke</button>}
          </div>
        ))}
        {isCeo && <DelegationForm wsId={wsId} rules={rules} humans={humans.list} onDone={refresh} />}
      </div>
      <div style={{ ...card, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>The self-modification boundary</div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>What the organization may change about itself, and how. Read-only: it is the rule every self-change path asks first. Humans are not bound, except where it says everyone.</div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead><tr>{['Change', 'Scope', 'Verdict', 'Why'].map((h) => <th key={h} scope="col" style={{ textAlign: 'left', padding: '4px 6px', ...label }}>{h}</th>)}</tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <td style={{ padding: '5px 6px', ...mono, whiteSpace: 'nowrap' }}>{r.kind}</td>
                  <td style={{ padding: '5px 6px', minWidth: 120 }}>{r.match}</td>
                  <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}><span style={pill(VERDICT_COLOR[r.verdict] ?? 'var(--panel-2)', '#fff')}>{VERDICT_LABEL_B[r.verdict] ?? r.verdict}</span>{r.everyone ? <span style={{ ...faint, marginLeft: 4 }}>everyone</span> : null}{r.verdict === 'propose' && !r.delegable ? <span style={{ ...faint, marginLeft: 4 }} title="A card of this change is never decided by a delegate">not delegable</span> : null}</td>
                  <td style={{ padding: '5px 6px', minWidth: 180, color: 'var(--text-dim)' }}>{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function DelegationForm({ wsId, rules, humans, onDone }: { wsId: string; rules: BoundaryRule[]; humans: OrgHuman[]; onDone: () => Promise<void> }) {
  const app = useApp();
  const options = useMemo(() => delegationOptions(rules), [rules]);
  const [kind, setKind] = useState('');
  const [maxUsd, setMaxUsd] = useState('');
  const [type, setType] = useState<'human' | 'role'>('human');
  const [ref, setRef] = useState('');
  const opt = options.find((o) => o.kind === kind);
  const people = humans.filter((h) => h.role === 'ceo' || h.role === 'board' || h.role === 'employee');
  const ok = kind && !opt?.disabled && ref.trim() && (maxUsd.trim() === '' || Number.isFinite(Number(maxUsd)));
  const save = async () => {
    try { await api.addOrgDelegation(wsId, { kind, maxUsd: maxUsd.trim() === '' ? null : Number(maxUsd), delegateType: type, delegateRef: ref.trim() }); setKind(''); setRef(''); setMaxUsd(''); await onDone(); app.showToast('Delegated (audited)'); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div role="form" aria-label="Add a delegation" style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', alignItems: 'end', marginTop: 10 }}>
      <div><label style={label} htmlFor="dl-kind">Cards of</label>
        <select id="dl-kind" value={kind} onChange={(e) => setKind(e.target.value)} style={input}>
          <option value="">Pick a kind or class…</option>
          {options.map((o) => <option key={o.kind} value={o.kind} disabled={o.disabled} title={o.note}>{o.label}{o.disabled ? ' — never delegable' : ''}</option>)}
        </select></div>
      <div><label style={label} htmlFor="dl-max">Up to (USD, optional)</label><input id="dl-max" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" style={{ ...input, ...mono }} /></div>
      <div><label style={label} htmlFor="dl-type">Delegate</label>
        <select id="dl-type" value={type} onChange={(e) => { setType(e.target.value as 'human' | 'role'); setRef(''); }} style={input}><option value="human">a person</option><option value="role">a member role</option></select></div>
      <div>{type === 'human'
        ? <><label style={label} htmlFor="dl-ref">Person</label><select id="dl-ref" value={ref} onChange={(e) => setRef(e.target.value)} style={input}><option value="">Pick…</option>{people.map((h) => <option key={h.id} value={h.memberAccountId}>{app.nameOf(h.memberAccountId)} ({h.role})</option>)}</select></>
        : <><label style={label} htmlFor="dl-ref">Role (member title)</label><input id="dl-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="controller" style={input} /></>}</div>
      <button style={btn(true)} disabled={!ok} onClick={() => void save()}>Delegate</button>
      {opt?.note && <div style={{ gridColumn: '1 / -1', fontSize: 12, color: opt.disabled ? 'var(--red)' : 'var(--amber)' }}>{opt.disabled ? 'Never delegable: ' : 'Note: '}{opt.note}</div>}
    </div>
  );
}

// ---- capacity on the board ----

/** Members' open work against the WIP limit (GET …/org/capacity). */
export function CapacityStrip({ wsId, refreshKey }: { wsId: string; refreshKey?: unknown }) {
  const names = useAgentNames();
  const [cap, setCap] = useState<OrgCapacity | null>(null);
  useEffect(() => { void api.orgCapacity(wsId).then(setCap).catch(() => setCap(null)); }, [wsId, refreshKey]);
  if (!cap || cap.members.length === 0) return null;
  return (
    <div aria-label="Work in progress per member" style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
      <span style={label} title="capacity.wipPerMember: open tasks (todo, claimed, in progress, blocked) a member may hold">WIP ≤ {cap.wip}</span>
      {cap.members.map((m) => {
        const w = wipLabel(m);
        return (
          <span key={m.agentId} title={`${m.name}${m.title ? ` (${m.title})` : ''}: ${m.open} open of ${m.wip}${m.atLimit ? ' — at the limit, assignments are refused' : ''}${m.tasks.length ? `\n${m.tasks.map((t) => `· ${t.title} (${t.status})`).join('\n')}` : ''}`}
            style={{ ...pill('var(--panel-2)', w.color), display: 'inline-flex', gap: 4, alignItems: 'center', borderColor: m.atLimit ? 'var(--red)' : undefined }}>
            <Avatar a={names.get(m.agentId)} size={13} />{m.name} {w.text}
          </span>
        );
      })}
    </div>
  );
}
