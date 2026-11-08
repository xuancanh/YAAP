/** Operations › Improvements (docs/improvements.md): the company's
 *  improvement proposals by status — what needs your decision, what is in
 *  flight and being verified, what was verified, what closed — each with
 *  its target, evidence, hypothesis, the diff it applies, the metric it
 *  promised and what the verification found; the CEO accepts or rejects a
 *  proposal (deciding its card) and checks an applied change now. The Work
 *  sources panel shows where new tasks come from — plans, process steps,
 *  service requests, incidents, retros, agent initiative — the share in the
 *  Operating/Unsorted projects and self-started work against the caps. Lib:
 *  src/lib/improvements.ts. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgDetail, type OrgImprovement, type WorkSources } from '../lib/api';
import {
  CATEGORY_WORD, CLASS_HINT, CLASS_WORD, FILTERS, STATUS_TONE, STATUS_WORD, countByFilter, filterOf, holderWord, pct, sourceBars, verificationWords, type ImprovementFilter,
} from '../lib/improvements';
import { ago, useAgentNames } from './org-ui';
import { useOrgRole } from './OrgSensingView';
import { Bar, Card, Empty, Metric, PageHeader, Pill, Segmented, SkeletonRows } from './CompanyKit';

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 600) : 'failed');

export function ImprovementsPane({ org }: { org: OrgDetail }) {
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const decider = role === 'ceo' || role === 'board';
  const names = useAgentNames();
  const [data, setData] = useState<{ improvements: OrgImprovement[]; sources: WorkSources } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<ImprovementFilter>('decide');
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api.orgImprovements(wsId)); setErr(null); } catch (e) { setErr(errText(e)); }
  }, [wsId]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 30_000); return () => clearInterval(t); }, [load]);
  const rows = useMemo(() => (data?.improvements ?? []).filter((p) => filterOf(p) === filter), [data, filter]);
  const counts = countByFilter(data?.improvements ?? []);
  const s = data?.sources;
  return (
    <div className="co-page" data-testid="improvements-page">
      <PageHeader title="Improvements" purpose="How the company changes the way it works. Retros, postmortems, process reviews and members raise capped proposals — a target, evidence, a hypothesis, the change and the metric it should move — instead of tasks about themselves. A standard change is pre-authorised and applies at once, a normal one is approved by the target's owner, an emergency one applies during an incident and is reviewed after. Every applied change is checked against its metric and reverted when it misses. Work sources shows where new work comes from and how much is self-started." />
      {err && <div className="co-alert" role="alert">{err}</div>}
      {!data && !err && <SkeletonRows rows={4} label="Loading improvements" />}
      {s && (
        <div className="co-metrics" style={{ margin: '4px 0 14px' }} data-testid="improvement-counts">
          <Metric n={counts.decide} label="need a decision" tone={counts.decide ? 'warn' : undefined} />
          <Metric n={s.proposals.verifying} label="being verified" tone={s.proposals.verifying ? 'info' : undefined} />
          <Metric n={s.proposals.verified} label={`verified (${s.days}d)`} tone={s.proposals.verified ? 'ok' : undefined} />
          <Metric n={pct(s.selfShare)} label="of new work self-started" tone={(s.selfShare ?? 0) > 0.5 ? 'bad' : undefined} title="Agent initiative, retro and meeting actions, as a share of new tasks" />
        </div>
      )}
      {data && (
        <>
          <div style={{ marginBottom: 10 }}>
            <Segmented label="Proposals" value={filter} options={FILTERS.map((f) => ({ id: f.id, label: `${f.label} (${counts[f.id]})` }))} onChange={setFilter} />
          </div>
          {rows.length === 0
            ? <div className="co-card"><Empty title={filter === 'decide' ? 'Nothing waits on a decision' : 'None here'} compact>{data.improvements.length === 0 ? 'Retros, postmortems and process reviews raise proposals here; agents raise them with org_improvement_propose.' : undefined}</Empty></div>
            : (
              <Card flush>
                <div className="co-rows" data-testid="improvement-list">
                  {rows.map((p) => <ImprovementRow key={p.id} p={p} names={names} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} decider={decider} wsId={wsId} onChanged={load} />)}
                </div>
              </Card>
            )}
        </>
      )}
      {s && <div style={{ marginTop: 14 }}><WorkSourcesPanel s={s} /></div>}
    </div>
  );
}

function ImprovementRow({ p, names, open, onToggle, decider, wsId, onChanged }: { p: OrgImprovement; names: ReturnType<typeof useAgentNames>; open: boolean; onToggle: () => void; decider: boolean; wsId: string; onChanged: () => Promise<void> }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); app.showToast?.(done); await onChanged(); } catch (e) { app.showToast?.(errText(e)); } finally { setBusy(false); }
  };
  const review = p.status === 'applied' && p.reviewPending === 1;
  const decidable = decider && (p.status === 'proposed' || review);
  return (
    <div className="co-row static" data-testid="improvement-row" style={{ display: 'block' }}>
      <button className="co-row" onClick={onToggle} aria-expanded={open} style={{ width: '100%', padding: 0, border: 'none', background: 'none' }}>
        <span className="co-row-main">
          <span className="co-row-title">{p.key} · {p.title}</span>
          <span className="co-row-meta">{CATEGORY_WORD[p.category] ?? p.category} · {p.targetLabel} · {CLASS_WORD[p.changeClass]} · owner {holderWord(p.owner, names)} · raised by {holderWord(p.proposedBy, names)} ({p.origin.replace('_', ' ')}) {ago(p.createdAt)}</span>
        </span>
        <span className="co-row-end"><Pill tone={STATUS_TONE[p.status]}>{review ? 'Review the emergency change' : STATUS_WORD[p.status]}</Pill></span>
      </button>
      {open && (
        <div style={{ display: 'grid', gap: 8, padding: '10px 4px 4px', fontSize: 13 }} data-testid="improvement-detail">
          <div><b>Hypothesis.</b> {p.hypothesis}</div>
          <div><b>Evidence.</b><ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{p.evidence.map((e, i) => <li key={i}>{e.summary}{e.ref ? <span style={{ color: 'var(--text-faint)' }}> · {e.ref}</span> : null}</li>)}</ul></div>
          <div><b>Change.</b>{p.diff.length
            ? <pre style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--panel-2)', padding: 8, borderRadius: 8, margin: '4px 0 0' }} data-testid="improvement-diff">{p.diff.map((l, i) => <div key={i} style={{ color: l.startsWith('+') ? 'var(--green)' : l.startsWith('-') ? 'var(--red)' : undefined }}>{l}</div>)}</pre>
            : <span> none structured — accepting makes one task for its owner.</span>}</div>
          <div title={CLASS_HINT[p.changeClass]}><b>{CLASS_WORD[p.changeClass]}.</b> {p.classWhy}</div>
          <div data-testid="improvement-verification"><b>Metric.</b> {verificationWords(p)}{p.baseline !== null ? ` (baseline ${p.baseline})` : ''}</div>
          {p.appliedRef && <div style={{ color: 'var(--text-dim)' }}>Applied: {p.appliedRef}</div>}
          {p.lastError && <div className="co-alert" role="status">{p.lastError}</div>}
          <details><summary style={{ cursor: 'pointer', color: 'var(--text-dim)' }}>History ({p.history.length})</summary>
            <ul style={{ margin: '4px 0 0 18px', padding: 0, color: 'var(--text-dim)' }}>{p.history.map((h, i) => <li key={i}>{h.at.slice(0, 16).replace('T', ' ')} · {h.from || '·'} → {h.to} · {holderWord(h.by, names)}: {h.why}</li>)}</ul>
          </details>
          {(decidable || (decider && p.status === 'applied')) && (
            <div className="co-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {decidable && <button className="co-btn primary" disabled={busy} onClick={() => void act(() => api.acceptOrgImprovement(wsId, p.key), review ? `${p.key} kept` : `${p.key} accepted`)}>{review ? 'Keep it' : 'Accept'}</button>}
              {decidable && <button className="co-btn" disabled={busy} onClick={() => { const note = window.prompt(review ? 'Why revert it?' : 'Why not?') ?? ''; void act(() => api.rejectOrgImprovement(wsId, p.key, note), review ? `${p.key} reverted` : `${p.key} rejected`); }}>{review ? 'Revert it' : 'Reject'}</button>}
              {p.status === 'applied' && !review && <button className="co-btn ghost" disabled={busy} onClick={() => void act(() => api.verifyOrgImprovement(wsId, p.key), `${p.key} checked`)}>Check the metric now</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkSourcesPanel({ s }: { s: WorkSources }) {
  const bars = sourceBars(s);
  return (
    <Card title="Work sources" aside={`${s.total} new task${s.total === 1 ? '' : 's'} · ${s.days} days`}>
      <div data-testid="work-sources" style={{ display: 'grid', gap: 10, fontSize: 13 }}>
        {bars.length === 0 ? <Empty title="No new work in the window" compact /> : (
          <div style={{ display: 'grid', gap: 6 }}>
            {bars.map((b) => (
              <div key={b.origin} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) 1fr 64px', gap: 8, alignItems: 'center' }} data-testid="source-bar">
                <span>{b.label}{b.self ? <span style={{ color: 'var(--text-faint)' }}> · self-started</span> : null}</span>
                <Bar value={b.share} tone={b.self ? 'warn' : 'info'} label={`${b.label}: ${pct(b.share)}`} />
                <span style={{ textAlign: 'right', color: 'var(--text-dim)' }}>{b.n} · {pct(b.share)}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ color: 'var(--text-dim)' }}>
          Self-started {pct(s.selfShare)} · in Operating/Unsorted projects {pct(s.systemShare)} · from retros {pct(s.retroShare)}.
        </div>
        <div>
          <b>Caps.</b> At most {s.caps.selfWip} open self-started tasks per unit and {s.caps.selfPerDay} a day per member; over the cap a task is {s.caps.overCap === 'park' ? 'parked as a proposal' : 'refused with what to do instead'}. {s.caps.maxOpenPerTarget} open proposal{s.caps.maxOpenPerTarget === 1 ? '' : 's'} per target, {s.caps.maxOpenPerUnit} per unit, {s.caps.perMeeting} per retro. {s.caps.agentWakesPerHour} wakes from other agents per member per hour.
          {' '}In the window: {s.admission.refused} refused, {s.admission.parked} parked, {s.admission.deferredWakes} wake deferral{s.admission.deferredWakes === 1 ? '' : 's'}.
        </div>
        {s.perUnit.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} data-testid="unit-caps">
            {s.perUnit.map((u) => <Pill key={u.unitId} tone={u.selfOpen >= u.cap ? 'bad' : u.selfOpen >= u.cap - 1 ? 'warn' : 'muted'} title="Open self-started tasks against the unit's cap">{u.name} {u.selfOpen}/{u.cap}</Pill>)}
          </div>
        )}
        <div style={{ color: 'var(--text-dim)' }}>
          Proposals: {s.proposals.opened} opened, {s.proposals.accepted} accepted, {s.proposals.applied} applied, {s.proposals.verified} verified, {s.proposals.reverted} reverted, {s.proposals.rejected} rejected, {s.proposals.expired} expired.
        </div>
      </div>
    </Card>
  );
}
