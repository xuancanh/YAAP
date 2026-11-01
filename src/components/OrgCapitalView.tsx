/** Capital and the CEO's seat (docs/company-vision.md §7, §8; execution plan
 *  item 23): Plans — every structural change the chief planned as a diff
 *  (hires, reorgs, terminations, scope, budget, routing, tunables) with the
 *  veto countdown, Veto and Apply now, and a dry run that renders the same
 *  diff as hypothetical; Replay — one day of the company as a timeline with
 *  the chain check; Capital — cost per outcome, spend by class, the forecast
 *  per envelope, allocations and the routing table. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, MODEL_TIERS, TASK_CLASSES, type CostReport, type ModelTier, type OrgAllocation, type OrgDetail, type OrgForecast, type OrgPlan, type OrgReplay, type OrgRouting } from '../lib/api';
import { fmtUsd } from '../lib/pricing';
import {
  classRows, costRows, countdownLabel, dayKey, FORECAST_COLOR, FORECAST_LABEL, forecastLine, forecastRows, groupPlanActions, groupReplayByHour, parsePlanActions, parsePlanResults,
  PLAN_GROUP_COLOR, PLAN_GROUP_LABEL, PLAN_STATUS_COLOR, PLAN_STATUS_LABEL, planStoppedAt, planTriggerLabel, REPLAY_KIND_COLOR, REPLAY_KIND_LABEL, routingRows, shiftDay, TIER_HINT, tierModelLabel,
} from '../lib/org2';
import { card, input, btn, pill, h2, faint, label, linkBtn, ago, useAgentNames, useFollowRef, useUnits } from './org-ui';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };

/** A clock that ticks every 30 s for the countdowns. */
function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

// ---- plans ----

export function PlansPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const names = useAgentNames();
  const [rows, setRows] = useState<OrgPlan[] | null>(null);
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [dry, setDry] = useState<{ prompt: string; usd: string; running: boolean; plan: OrgPlan | null; result: string | null }>({ prompt: '', usd: '', running: false, plan: null, result: null });
  const now = useNow();
  const refresh = useCallback(async () => {
    setRows(await api.orgPlans(wsId, status || undefined).catch((): OrgPlan[] => []));
    void app.refreshWsOrg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, status]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => {
    if (app.orgFocus?.kind !== 'plan' || !rows) return;
    const p = rows.find((x) => x.id === app.orgFocus!.id || x.id.startsWith(app.orgFocus!.id));
    if (p) { setOpen(p.id); app.setOrgFocus(null); requestAnimationFrame(() => document.getElementById(`plan-${p.id}`)?.scrollIntoView({ block: 'center' })); }
    else if (rows.length) { app.setOrgFocus(null); app.showToast('That plan is not in this list'); }
  }, [rows, app]);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try { await fn(); await refresh(); app.showToast(done); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); }
  };
  const dryRun = async () => {
    setDry((d) => ({ ...d, running: true, plan: null, result: null }));
    try {
      const r = await api.orgDryRun(wsId, { prompt: dry.prompt.trim() || undefined, assume: dry.usd.trim() ? { monthlyUsd: Number(dry.usd) || 0 } : undefined });
      setDry((d) => ({ ...d, running: false, plan: r.plan, result: r.result }));
    } catch (e) { setDry((d) => ({ ...d, running: false, result: e instanceof Error ? e.message.slice(0, 200) : 'failed' })); }
  };
  const nameOf = (id: string) => names.get(id)?.name;
  const pending = (rows ?? []).filter((p) => p.status === 'pending');
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={h2}>Plans{pending.length ? ` · ${pending.length} awaiting your veto` : ''}</h2>
          <div style={faint}>In autonomous mode every structural change the chief plans — hires, reorganisations, terminations, scope and budget changes, routing, tunables — is written here first and applies after the veto window (<code>capital.vetoWindowMinutes</code>) unless you veto it. A dry run asks the chief what it would do and applies nothing.</div>
        </div>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...input, width: 'auto' }}>
          <option value="">every status</option>{(['pending', 'applied', 'vetoed', 'expired', 'dry_run'] as const).map((s) => <option key={s} value={s}>{PLAN_STATUS_LABEL[s]}</option>)}
        </select>
      </div>
      <div style={{ ...card, marginBottom: 12, display: 'grid', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Dry run — what would the chief do?</div>
        <textarea aria-label="Dry-run prompt" value={dry.prompt} onChange={(e) => setDry({ ...dry, prompt: e.target.value })} rows={2} placeholder="Optional framing, e.g. “we are adding a second product line next quarter” — leave empty for a plain planning pass" style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ ...faint, display: 'flex', gap: 6, alignItems: 'center' }}>assume a monthly envelope of $<input aria-label="Assumed monthly USD" value={dry.usd} onChange={(e) => setDry({ ...dry, usd: e.target.value.replace(/[^\d.]/g, '') })} placeholder={String(org.monthlyBudgetUsd || 0)} style={{ ...input, width: 90, ...mono }} /></label>
          <span style={{ flex: 1 }} />
          <button style={btn(true)} disabled={dry.running} onClick={() => void dryRun()}>{dry.running ? 'Running…' : 'Dry run'}</button>
        </div>
        {dry.result && !dry.plan && <div style={{ ...faint, color: dry.result.startsWith('skipped') ? 'var(--amber)' : undefined }}>{dry.result.startsWith('skipped') ? `The chief did not run: ${dry.result.replace('skipped:', '').replace(/_/g, ' ')}` : dry.result === 'done' || dry.result === 'ran' ? 'The chief planned nothing for this framing.' : dry.result}</div>}
        {dry.plan && <PlanDiff plan={dry.plan} nameOf={nameOf} hypothetical />}
      </div>
      {rows === null && <div style={faint}>Loading…</div>}
      {rows && rows.length === 0 && <div style={{ ...card, ...faint }}>{status ? 'No plan with this status.' : 'No plan yet. Plans are captured from autonomous planning runs and chief reviews; in supervised mode the same changes arrive as approval cards.'}</div>}
      {rows?.map((p) => {
        const expanded = open === p.id;
        const actions = parsePlanActions(p.actions);
        return (
          <div key={p.id} id={`plan-${p.id}`} style={{ ...card, marginBottom: 8, borderLeft: `3px solid ${PLAN_STATUS_COLOR[p.status]}` }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>{p.summary || `${actions.length} action(s)`}</span>
                  <span style={pill(PLAN_STATUS_COLOR[p.status], '#fff')}>{PLAN_STATUS_LABEL[p.status]}</span>
                  {p.status === 'pending' && <span style={pill('var(--amber)', '#fff')} title={p.applyAt ? new Date(p.applyAt).toLocaleString() : ''}>{countdownLabel(p.applyAt, now)}</span>}
                </div>
                <div style={{ ...faint, marginTop: 3 }}>{planTriggerLabel(p.trigger)} · {actions.length} action{actions.length === 1 ? '' : 's'} · est. {fmtUsd(p.estimateUsd)} · {ago(p.createdAt)}{p.appliedAt ? ` · applied ${ago(p.appliedAt)}` : ''}{p.decidedBy ? ` · ${p.decidedBy === 'system' ? 'by the tick' : p.decidedBy === 'user' ? 'by you' : p.decidedBy}` : ''}</div>
              </div>
              <button style={btn()} onClick={() => setOpen(expanded ? null : p.id)} aria-expanded={expanded}>{expanded ? 'Hide diff' : 'Diff'}</button>
            </div>
            {expanded && (
              <div style={{ marginTop: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
                <PlanDiff plan={p} nameOf={nameOf} />
                {p.status === 'pending' && <PlanDecision onVeto={(note) => act(() => api.vetoOrgPlan(wsId, p.id, note), 'Plan vetoed — nothing applied')} onApply={() => act(() => api.applyOrgPlanNow(wsId, p.id), 'Plan applied')} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PlanDecision({ onVeto, onApply }: { onVeto: (note: string) => Promise<void>; onApply: () => Promise<void> }) {
  const [note, setNote] = useState('');
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
      <input aria-label="Veto note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the chief (optional)" style={{ ...input, flex: 1, minWidth: 180 }} />
      <button style={btn(false, true)} onClick={() => void onVeto(note)} title="Nothing in this plan applies; the chief reads your note">Veto</button>
      <button style={btn(true)} onClick={() => { if (confirm('Apply every action of this plan now, without waiting for the window?')) void onApply(); }}>Apply now</button>
    </div>
  );
}

/** The plan as a diff: one row per action, grouped, with the estimate and —
 *  once applied — what each did and where application stopped. */
export function PlanDiff({ plan, nameOf, hypothetical = false }: { plan: OrgPlan; nameOf?: (id: string) => string | undefined; hypothetical?: boolean }) {
  const actions = parsePlanActions(plan.actions);
  const results = parsePlanResults(plan.result);
  const groups = groupPlanActions(actions, results, nameOf);
  const stopped = planStoppedAt(results);
  const total = actions.reduce((n, a) => n + (a.estimateUsd || 0), 0);
  return (
    <div>
      {(hypothetical || plan.status === 'dry_run') && <div style={{ ...pill('var(--blue)', '#fff'), display: 'inline-block', marginBottom: 8 }}>hypothetical — nothing applied</div>}
      {plan.summary && (hypothetical || plan.status === 'dry_run') && <div style={{ fontSize: 13, marginBottom: 8 }}>{plan.summary}</div>}
      {actions.length === 0 && <div style={faint}>The chief planned no structural change.</div>}
      {groups.map((g) => (
        <div key={g.group} style={{ marginBottom: 8 }}>
          <div style={{ ...label, color: PLAN_GROUP_COLOR[g.group], display: 'flex', gap: 6, alignItems: 'baseline' }}><span>{PLAN_GROUP_LABEL[g.group]} · {g.rows.length}</span>{g.estimateUsd > 0 && <span style={{ ...faint, textTransform: 'none', letterSpacing: 0 }}>est. {fmtUsd(g.estimateUsd)}</span>}</div>
          {g.rows.map((r) => (
            <div key={r.index} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', borderBottom: '1px solid var(--border-soft)', flexWrap: 'wrap', opacity: stopped !== null && r.index > stopped ? .55 : 1 }}>
              <span aria-hidden style={{ width: 3, alignSelf: 'stretch', background: PLAN_GROUP_COLOR[g.group], borderRadius: 2, flex: 'none' }} />
              <span style={{ fontSize: 13, flex: 1, minWidth: 200 }}>{r.text}</span>
              <span style={{ ...faint, ...mono, fontSize: 10.5 }}>{r.tool}</span>
              {r.estimateUsd > 0 && <span style={{ ...faint, ...mono }}>{fmtUsd(r.estimateUsd)}</span>}
              {r.result && <span style={pill(r.result.ok ? 'var(--green)' : 'var(--red)', '#fff')} title={r.result.output}>{r.result.ok ? 'applied' : 'refused'}</span>}
              {stopped === r.index && <span style={{ ...faint, flexBasis: '100%', color: 'var(--red)' }}>stopped here: {r.result?.output || 'refused'}</span>}
              {stopped !== null && r.index > stopped && <span style={{ ...faint, flexBasis: '100%' }}>not applied</span>}
            </div>
          ))}
        </div>
      ))}
      {actions.length > 0 && <div style={{ ...faint, display: 'flex', gap: 10, justifyContent: 'flex-end' }}><span>{actions.length} action{actions.length === 1 ? '' : 's'}</span><span>total est. <b style={mono}>{fmtUsd(total || plan.estimateUsd)}</b>/month</span></div>}
    </div>
  );
}

// ---- replay ----

export function ReplayPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const follow = useFollowRef();
  const [day, setDay] = useState(dayKey());
  const [replay, setReplay] = useState<OrgReplay | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (app.orgFocus?.kind === 'replay') { setDay(app.orgFocus.id); app.setOrgFocus(null); }
  }, [app]);
  useEffect(() => {
    setReplay(null);
    void api.orgReplay(wsId, day).then((r) => { setReplay(r); setErr(null); }).catch((e) => setErr(e instanceof Error ? e.message.slice(0, 160) : 'failed'));
  }, [wsId, day]);
  const hours = replay ? groupReplayByHour(replay.entries) : [];
  const today = dayKey();
  const tile = (k: string, v: string | number) => <div style={{ ...card, padding: '8px 12px' }}><div style={label}>{k}</div><div style={{ fontSize: 18, fontWeight: 700, ...mono }}>{v}</div></div>;
  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={h2}>Replay</h2>
          <div style={faint}>One day of the company (§8): what woke, what ran and what it cost, what was decided, which signals fired, which plans were written — and whether the hash chain over that day's audit rows holds.</div>
        </div>
        <button style={btn()} onClick={() => setDay(shiftDay(day, -1))} aria-label="Previous day">‹</button>
        <input aria-label="Day" type="date" value={day} max={today} onChange={(e) => { if (e.target.value) setDay(e.target.value); }} style={{ ...input, width: 'auto', ...mono }} />
        <button style={btn()} onClick={() => setDay(shiftDay(day, 1))} disabled={day >= today} aria-label="Next day">›</button>
        {day !== today && <button style={btn()} onClick={() => setDay(today)}>Today</button>}
      </div>
      {err && <div style={{ ...card, color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
      {!replay && !err && <div style={faint}>Reading the day…</div>}
      {replay && (
        <>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', marginBottom: 10 }}>
            {tile('Runs', replay.totals.runs)}{tile('Spent', fmtUsd(replay.totals.usd))}{tile('Decisions', replay.totals.decisions)}{tile('Signals', replay.totals.signals)}{tile('Plans', replay.totals.plans)}{tile('Audit rows', replay.totals.auditRows)}
          </div>
          <div style={{ ...card, display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={pill(replay.chain.ok ? 'var(--green)' : 'var(--red)', '#fff')}>{replay.chain.ok ? 'chain verified' : `chain broken at #${replay.chain.brokenAt}`}</span>
            <span style={faint}>{replay.chain.rows} row(s){replay.chain.fromSeq !== null ? ` · #${replay.chain.fromSeq} → #${replay.chain.toSeq}` : ''}{replay.chain.reason ? ` · ${replay.chain.reason}` : ''} · every row hashes the one before it; a break means the log was edited.</span>
            <span style={{ flex: 1 }} />
            <button style={linkBtn} onClick={() => app.setOrgPane('audit')}>full audit log</button>
          </div>
          {replay.entries.length === 0 && <div style={{ ...card, ...faint }}>Nothing happened on {day}.</div>}
          {hours.map((h) => (
            <div key={h.hour} style={{ display: 'grid', gridTemplateColumns: '52px 1fr', gap: 10, marginBottom: 6 }}>
              <div style={{ ...faint, ...mono, paddingTop: 8, textAlign: 'right' }}>{h.hour}{h.usd > 0 && <div style={{ fontSize: 10 }}>{fmtUsd(h.usd)}</div>}</div>
              <div style={{ ...card, padding: '4px 12px' }}>
                {h.rows.map((e, i) => {
                  const linkable = Boolean(e.refId) && ['task', 'decision', 'meeting', 'goal', 'plan', 'agent', 'member', 'signal', 'approval', 'unit'].includes(e.refType);
                  return (
                    <div key={`${e.at}-${e.seq ?? i}`} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', borderBottom: i < h.rows.length - 1 ? '1px solid var(--border-soft)' : 'none', flexWrap: 'wrap' }}>
                      <span style={{ ...faint, ...mono, fontSize: 10.5, width: 38, flex: 'none' }}>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).slice(0, 5)}</span>
                      <span style={{ ...pill(REPLAY_KIND_COLOR[e.kind], '#fff'), width: 54, textAlign: 'center' }}>{REPLAY_KIND_LABEL[e.kind]}</span>
                      {linkable ? <button onClick={() => follow(e.refType, e.refId)} style={{ ...linkBtn, fontWeight: 600, textAlign: 'left', fontSize: 13, color: 'var(--text)', flex: 1, minWidth: 160 }}>{e.title}</button> : <span style={{ fontSize: 13, flex: 1, minWidth: 160 }}>{e.title}</span>}
                      {e.usd !== null && e.usd > 0 && <span style={{ ...faint, ...mono }}>{fmtUsd(e.usd)}</span>}
                      {e.seq !== null && <span style={{ ...faint, ...mono, fontSize: 10.5 }} title="audit row">#{e.seq}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ---- capital: costs, forecast, allocations, routing ----

export function CapitalPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const names = useAgentNames();
  const follow = useFollowRef();
  const { current, isCompany } = useUnits();
  const [period, setPeriod] = useState<'month' | 'all'>('month');
  const [costs, setCosts] = useState<CostReport | null>(null);
  const [forecast, setForecast] = useState<OrgForecast | null>(null);
  const [allocations, setAllocations] = useState<OrgAllocation[]>([]);
  const [routing, setRouting] = useState<OrgRouting | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const unitId = isCompany ? null : current?.id ?? null;
  const refresh = useCallback(async () => {
    const [c, f, a, r] = await Promise.all([
      api.orgCosts(wsId, period, unitId).then((v) => { setErr(null); return v; }).catch((e) => { setErr(e instanceof Error ? e.message.slice(0, 160) : 'costs unavailable'); return null; }),
      api.orgForecast(wsId).catch(() => null), api.orgAllocations(wsId).catch((): OrgAllocation[] => []), api.orgRouting(wsId).catch(() => null),
    ]);
    setCosts(c); setForecast(f); setAllocations(a); setRouting(r);
  }, [wsId, period, unitId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 60_000); return () => clearInterval(t); }, [refresh]);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); await refresh(); if (done) app.showToast(done); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); }
  };
  const rows = costs ? costRows(costs) : [];
  const classes = costs ? classRows(costs.byClass) : [];
  const chief = org.chiefOfStaffAgentId ? names.get(org.chiefOfStaffAgentId) : undefined;
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={h2}>Capital</h2>
          <div style={faint}>Money as a signal (§7): what each objective cost against what it bought, the forecast per envelope over the trailing window, the allocations you give each objective, and which model tier each task class runs on.</div>
        </div>
        <div role="tablist" aria-label="Period" style={{ display: 'flex', gap: 4 }}>
          {(['month', 'all'] as const).map((p) => <button key={p} role="tab" aria-selected={period === p} style={btn(period === p)} onClick={() => setPeriod(p)}>{p === 'month' ? 'This month' : 'All time'}</button>)}
        </div>
      </div>
      {err && <div style={{ ...card, color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
      {costs && (
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 10 }}>
          <Tile k={`Spent · ${period === 'month' ? 'month' : 'all time'}`} v={fmtUsd(costs.totalUsd)} sub={costs.companyEnvelopeUsd > 0 ? `of ${fmtUsd(costs.companyEnvelopeUsd)} envelope` : 'no company envelope'} />
          <Tile k="Attributed to objectives" v={fmtUsd(costs.attributedUsd)} sub={`${fmtUsd(costs.unlinkedUsd)} unlinked to any goal`} color={costs.unlinkedUsd > costs.attributedUsd ? 'var(--amber)' : undefined} />
          <Tile k="Cost per accepted task" v={costs.costPerAcceptedTaskUsd === null ? '—' : fmtUsd(costs.costPerAcceptedTaskUsd)} sub={costs.vision ? `vision: ${fmtUsd(costs.vision.spentUsd)} total` : 'no vision set'} />
          <Tile k="Overspend margin" v={`${Math.round(costs.margin * 100)} pts`} sub={`${rows.filter((r) => r.overspend).length} objective(s) flagged`} color={rows.some((r) => r.overspend) ? 'var(--red)' : undefined} />
        </div>
      )}
      {costs && (
        <div style={{ ...card, marginBottom: 10, overflowX: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}><div style={{ fontSize: 13.5, fontWeight: 700 }}>Cost per outcome</div><span style={faint}>spend share against measured progress; flagged when the share runs ahead of progress by more than the margin</span></div>
          {rows.length === 0 && <div style={faint}>No objective has spend yet.</div>}
          {rows.length > 0 && (
            <div style={{ minWidth: 560 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px,2fr) 80px 70px minmax(110px,1fr) 90px 90px', gap: 8, ...label, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                <span>Objective</span><span style={{ textAlign: 'right' }}>Spent</span><span style={{ textAlign: 'right' }}>Share</span><span>Envelope</span><span style={{ textAlign: 'right' }}>Progress</span><span style={{ textAlign: 'right' }}>Measured</span>
              </div>
              {rows.map((r) => (
                <div key={r.goalId} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px,2fr) 80px 70px minmax(110px,1fr) 90px 90px', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border-soft)', fontSize: 12.5 }} title={r.note}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button onClick={() => follow('goal', r.goalId)} style={{ ...linkBtn, fontWeight: 600, fontSize: 12.5, color: 'var(--text)', textAlign: 'left' }}>{r.title}</button>
                      {r.overspend && <span style={pill('var(--red)', '#fff')} title={r.note}>overspend</span>}
                      {r.status !== 'active' && <span style={pill()}>{r.status}</span>}
                    </div>
                    {r.buys && <div style={faint}>buys: {r.buys}</div>}
                  </div>
                  <span style={{ ...mono, textAlign: 'right' }}>{fmtUsd(r.spentUsd)}</span>
                  <span style={{ ...mono, textAlign: 'right', color: r.color }}>{r.sharePct}%</span>
                  <div>
                    {r.envelopePct !== null ? <><div style={{ height: 5, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden' }} role="progressbar" aria-valuenow={Math.min(100, r.envelopePct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${r.title} envelope`}><div style={{ width: `${Math.min(100, r.envelopePct)}%`, height: 5, background: r.envelopePct >= 100 ? 'var(--red)' : r.envelopePct >= 80 ? 'var(--amber)' : 'var(--green)' }} /></div><div style={{ ...faint, fontSize: 10.5 }}>{r.envelopePct}% of {fmtUsd(r.envelopeUsd)} ({r.envelopeSource})</div></> : <span style={faint}>no envelope</span>}
                  </div>
                  <span style={{ ...mono, textAlign: 'right' }}>{r.progressPct}%</span>
                  <span style={{ ...mono, textAlign: 'right', color: r.measuredPct === null ? 'var(--text-faint)' : undefined }}>{r.measuredPct === null ? '—' : `${r.measuredPct}%`}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', marginBottom: 10 }}>
        {costs && (
          <div style={card}>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>Spend by class</div>
            {classes.length === 0 && <div style={faint}>No run has a class yet.</div>}
            {classes.map((c) => (
              <div key={c.cls} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 70px', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 12.5 }}>
                <span style={mono}>{c.cls}</span>
                <div style={{ height: 6, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden' }}><div style={{ width: `${c.pct}%`, height: 6, background: 'var(--accent)' }} /></div>
                <span style={{ ...mono, textAlign: 'right' }}>{fmtUsd(c.usd)} <span style={faint}>{c.pct}%</span></span>
              </div>
            ))}
            {costs.byAgent.length > 0 && <div style={{ ...faint, marginTop: 8 }}>By member: {costs.byAgent.slice(0, 6).map((a) => `${a.name} ${fmtUsd(a.usd)}`).join(' · ')}</div>}
          </div>
        )}
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}><div style={{ fontSize: 13.5, fontWeight: 700 }}>Forecast</div>{forecast && <span style={faint}>trailing {forecast.windowDays}d · day {forecast.day}/{forecast.daysInMonth} · warns at {forecast.warnPct}%, stops at {forecast.criticalPct}%</span>}</div>
          {!forecast && <div style={faint}>No forecast yet.</div>}
          {forecast && forecastRows(forecast).map((f) => (
            <div key={`${f.scope}:${f.refId}`} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid var(--border-soft)', fontSize: 12.5, flexWrap: 'wrap' }}>
              <span style={pill(FORECAST_COLOR[f.state], '#fff')}>{FORECAST_LABEL[f.state]}</span>
              <span style={{ fontWeight: 600, flex: 1, minWidth: 120 }}>{f.name}{f.scope !== 'company' && <span style={{ ...faint, marginLeft: 5 }}>{f.scope}</span>}</span>
              <span style={{ ...faint, flexBasis: '100%' }}>{forecastLine(f).replace(/^[^·]*· /, '')}</span>
            </div>
          ))}
        </div>
      </div>
      <AllocationsCard org={org} costs={costs} allocations={allocations} onSet={(goalId, monthlyUsd, buys) => act(() => api.setOrgAllocation(wsId, { goalId, monthlyUsd, buys }), 'Allocation set')} />
      {routing && <RoutingCard routing={routing} chief={chief ? { provider: chief.provider, model: chief.model } : null} onSet={(patch) => act(() => api.setOrgRouting(wsId, patch), 'Routing updated')} />}
    </div>
  );
}

function Tile({ k, v, sub, color }: { k: string; v: string; sub?: string; color?: string }) {
  return <div style={{ ...card, padding: '10px 12px' }}><div style={label}>{k}</div><div style={{ fontSize: 20, fontWeight: 700, ...mono, color, marginTop: 2 }}>{v}</div>{sub && <div style={faint}>{sub}</div>}</div>;
}

/** The allocations editor: a monthly USD and "what it buys" per objective (§7). */
function AllocationsCard({ org, costs, allocations, onSet }: { org: OrgDetail; costs: CostReport | null; allocations: OrgAllocation[]; onSet: (goalId: string, monthlyUsd: number, buys: string) => Promise<void> }) {
  const [drafts, setDrafts] = useState<Record<string, { usd: string; buys: string }>>({});
  const objectives = useMemo(() => {
    const fromCosts = costs?.objectives.map((o) => ({ id: o.goalId, title: o.title, status: o.status })) ?? [];
    const fromOrg = org.goals.filter((g) => g.kind === 'objective' && g.status === 'active' && !fromCosts.some((o) => o.id === g.id)).map((g) => ({ id: g.id, title: g.title, status: g.status }));
    return [...fromCosts, ...fromOrg];
  }, [costs, org.goals]);
  const allocated = allocations.reduce((n, a) => n + a.monthlyUsd, 0);
  const envelope = costs?.companyEnvelopeUsd ?? org.monthlyBudgetUsd;
  return (
    <div style={{ ...card, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>Allocations</div>
        <span style={faint}>{fmtUsd(allocated)} of {envelope > 0 ? fmtUsd(envelope) : 'no'} company envelope allocated to objectives; the chief allocates within it in autonomous mode and asks you in supervised mode</span>
      </div>
      {objectives.length === 0 && <div style={faint}>No active objective. Allocations attach to objectives on the vision page.</div>}
      {objectives.map((o) => {
        const a = allocations.find((x) => x.goalId === o.id);
        const d = drafts[o.id] ?? { usd: a ? String(a.monthlyUsd) : '', buys: a?.rationale ?? '' };
        return (
          <div key={o.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px,1.5fr) 90px minmax(140px,2fr) auto', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border-soft)', fontSize: 12.5 }}>
            <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.title}>{o.title}</span>
            <input aria-label={`${o.title} monthly USD`} value={d.usd} onChange={(e) => setDrafts({ ...drafts, [o.id]: { ...d, usd: e.target.value.replace(/[^\d.]/g, '') } })} placeholder="$ / month" style={{ ...input, ...mono, padding: '4px 8px' }} />
            <input aria-label={`${o.title} buys`} value={d.buys} onChange={(e) => setDrafts({ ...drafts, [o.id]: { ...d, buys: e.target.value } })} placeholder="what it buys (which key results)" style={{ ...input, padding: '4px 8px' }} />
            <button style={btn()} disabled={d.usd.trim() === ''} onClick={() => void onSet(o.id, Number(d.usd) || 0, d.buys)}>Set</button>
          </div>
        );
      })}
    </div>
  );
}

/** The routing table (§7): class → tier with the model the tier resolves to
 *  for the chief's provider, and the CEO's pinned model per tier. */
function RoutingCard({ routing, chief, onSet }: { routing: OrgRouting; chief: { provider: string; model: string } | null; onSet: (patch: { classes?: Record<string, string | null>; models?: Record<string, string | null>; why?: string }) => Promise<void> }) {
  const [pins, setPins] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState('');
  const rows = routingRows(routing, TASK_CLASSES);
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>Routing</div>
        <span style={faint}>which model tier a task class runs on; a model the CEO pinned on an agent always wins; an unrouted class runs on the agent's own model</span>
      </div>
      <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {rows.map((r) => {
          const resolved = r.tier ? tierModelLabel(routing, r.tier, chief) : null;
          return (
            <label key={r.cls} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '4px 0' }}>
              <span style={{ ...mono, width: 80 }}>{r.cls}</span>
              <select aria-label={`Tier for ${r.cls}`} value={r.tier ?? ''} onChange={(e) => void onSet({ classes: { [r.cls]: e.target.value || null } })} style={{ ...input, width: 'auto', padding: '3px 6px' }}>
                <option value="">unrouted</option>{MODEL_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <span style={{ ...faint, ...mono, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={resolved ? (resolved.pinned ? 'pinned by you' : TIER_HINT[r.tier as ModelTier]) : 'the agent\'s own model'}>{resolved ? `→ ${resolved.model}${resolved.pinned ? ' (pinned)' : ''}` : ''}</span>
            </label>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <input aria-label="Another class" value={extra} onChange={(e) => setExtra(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} placeholder="another class (lowercase slug)" style={{ ...input, width: 200, ...mono }} />
        <button style={btn()} disabled={!extra} onClick={() => { void onSet({ classes: { [extra]: 'standard' } }); setExtra(''); }}>Route as standard</button>
      </div>
      <div style={{ marginTop: 10, borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
        <div style={label}>Pinned tier models</div>
        <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginTop: 4 }}>
          {MODEL_TIERS.map((t) => {
            const v = pins[t] ?? routing.models[t] ?? '';
            return (
              <div key={t} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
                <span style={{ width: 64 }}>{t}</span>
                <input aria-label={`Pinned model for ${t}`} value={v} onChange={(e) => setPins({ ...pins, [t]: e.target.value })} placeholder={TIER_HINT[t]} style={{ ...input, ...mono, padding: '4px 8px' }} />
                <button style={btn()} onClick={() => void onSet({ models: { [t]: v.trim() || null } })}>{v.trim() ? 'Pin' : 'Unpin'}</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
