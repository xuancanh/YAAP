/** Operations › Improvements (docs/improvements.md): the company's
 *  improvement proposals by status — what needs your decision, what is in
 *  flight and being verified, what was verified, what closed. Each opens to
 *  why it should help, the evidence, the change it applies (a diff), its
 *  change class, the metric it promised and what the check found, and its
 *  history; the CEO accepts or rejects a proposal (deciding its card), keeps
 *  or reverts an emergency change, and checks an applied change now. A
 *  rejection or a revert takes a note and a second click. The first
 *  proposal that needs a decision is open on arrival. The Work sources panel
 *  shows where new tasks come from — directed work against self-started
 *  work, origin by origin — and each unit's open self-started work against
 *  its cap. Lib: src/lib/improvements.ts. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgDetail, type OrgImprovement, type WorkSources } from '../lib/api';
import {
  CATEGORY_WORD, CLASS_HINT, CLASS_WORD, FILTERS, ORIGIN_PHRASE, STATUS_TONE, STATUS_WORD, capTone, countByFilter, filterOf, holderWord, pct, sourceSplit, verificationWords, type ImprovementFilter,
} from '../lib/improvements';
import { plural, shortDate } from '../lib/direction';
import { I, P } from '../lib/icons';
import { ago, useAgentNames } from './org-ui';
import { useOrgRole } from './OrgSensingView';
import { Bar, Card, Empty, Metric, PageHeader, Pill, Segmented, SkeletonRows } from './CompanyKit';
import '../styles/align-improve.css';

const upper = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 600) : 'failed');

export function ImprovementsPane({ org }: { org: OrgDetail }) {
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const decider = role === 'ceo' || role === 'board';
  const names = useAgentNames();
  const [data, setData] = useState<{ improvements: OrgImprovement[]; sources: WorkSources } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<ImprovementFilter>('decide');
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  const load = useCallback(async () => {
    try { setData(await api.orgImprovements(wsId)); setErr(null); } catch (e) { setErr(errText(e)); }
  }, [wsId]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 30_000); return () => clearInterval(t); }, [load]);
  const rows = useMemo(() => (data?.improvements ?? []).filter((p) => filterOf(p) === filter), [data, filter]);
  // On arrival, the first proposal that needs a decision is open; after that the reader decides.
  const openId = open === undefined ? (filter === 'decide' ? rows[0]?.id ?? null : null) : open;
  const counts = countByFilter(data?.improvements ?? []);
  const s = data?.sources;
  const none = data && data.improvements.length === 0;
  return (
    <div className="co-page" data-testid="improvements-page">
      <PageHeader title="Improvements" purpose="How the company changes the way it works. Retros, postmortems, process reviews and members raise a small number of proposals instead of tasks about themselves: what to change, the evidence, why it should help and the metric it should move. A standard change is pre-approved and applies at once; a normal one is approved by the owner of what it changes (you, for charters and settings); an emergency one applies during an incident and is reviewed after. Every applied change is checked against its metric and reverted when it misses." />
      {err && <div className="co-alert" role="alert">{err}</div>}
      {!data && !err && <SkeletonRows rows={4} label="Loading improvements" />}
      {s && !none && (
        <div className="co-metrics im-counts" data-testid="improvement-counts">
          <Metric n={counts.decide} label="need a decision" tone={counts.decide ? 'warn' : undefined} onClick={() => { setFilter('decide'); setOpen(undefined); }} />
          <Metric n={counts.flight} label="in flight" tone={counts.flight ? 'info' : undefined} onClick={() => { setFilter('flight'); setOpen(null); }} title="Accepted, applied and waiting for the metric check" />
          <Metric n={s.proposals.verified} label={`verified in ${s.days} days`} tone={s.proposals.verified ? 'ok' : undefined} onClick={() => { setFilter('done'); setOpen(null); }} />
          <Metric n={pct(s.selfShare)} label="of new work self-started" tone={(s.selfShare ?? 0) > 0.5 ? 'warn' : undefined} title="Agent initiative, retro and meeting actions, as a share of new tasks in the window" />
        </div>
      )}
      {data && (none ? (
        <Card>
          <Empty title="No improvement proposals yet" testid="improvements-empty">
            When a retro, a postmortem or a process review finds something to change, it is raised here as a proposal with its evidence and the metric it should move, instead of a task. Standard changes apply on their own; the ones that need you also land in your Inbox.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="im-toolbar">
            <Segmented label="Proposals" value={filter} options={FILTERS.map((f) => ({ id: f.id, label: `${f.label} (${counts[f.id]})` }))} onChange={(f) => { setFilter(f); setOpen(f === 'decide' ? undefined : null); }} />
          </div>
          {rows.length === 0
            ? <div className="co-card"><Empty title={filter === 'decide' ? 'Nothing waits on a decision' : 'Nothing here'} compact>{filter === 'decide' ? 'Proposals that need your approval, and emergency changes to review, appear here and in your Inbox.' : undefined}</Empty></div>
            : (
              <Card flush>
                <div className="im-list" data-testid="improvement-list">
                  {rows.map((p) => <ImprovementRow key={p.id} p={p} names={names} open={openId === p.id} onToggle={() => setOpen(openId === p.id ? null : p.id)} decider={decider} wsId={wsId} onChanged={load} />)}
                </div>
              </Card>
            )}
        </>
      ))}
      {s && <div style={{ marginTop: 14 }}><WorkSourcesPanel s={s} /></div>}
    </div>
  );
}

function ImprovementRow({ p, names, open, onToggle, decider, wsId, onChanged }: { p: OrgImprovement; names: ReturnType<typeof useAgentNames>; open: boolean; onToggle: () => void; decider: boolean; wsId: string; onChanged: () => Promise<void> }) {
  const review = p.status === 'applied' && p.reviewPending === 1;
  const origin = ORIGIN_PHRASE[p.origin] ?? '';
  const bodyId = `im-body-${p.id}`;
  return (
    <div className="im-item" data-testid="improvement-row" data-status={p.status}>
      <button className="im-head" onClick={onToggle} aria-expanded={open} aria-controls={bodyId}>
        <span className="im-chev" aria-hidden><I d={P.chevR} size={14} sw={2.2} /></span>
        <span className="im-main">
          <span className="im-title"><span className="co-key">{p.key}</span> {p.title}</span>
          <span className="im-meta">{CATEGORY_WORD[p.category] ?? p.category} · {p.targetLabel || 'the company'} · raised by {holderWord(p.proposedBy, names)}{origin ? ` ${origin}` : ''} · {ago(p.createdAt)}</span>
        </span>
        <span className="im-end">
          <Pill tone={review ? 'warn' : STATUS_TONE[p.status]}>{review ? 'Review the emergency change' : STATUS_WORD[p.status]}</Pill>
          <span className="co-faint" title={CLASS_HINT[p.changeClass]}>{CLASS_WORD[p.changeClass]}</span>
        </span>
      </button>
      {open && <ImprovementDetail id={bodyId} p={p} names={names} review={review} decider={decider} wsId={wsId} onChanged={onChanged} />}
    </div>
  );
}

function ImprovementDetail({ id, p, names, review, decider, wsId, onChanged }: { id: string; p: OrgImprovement; names: ReturnType<typeof useAgentNames>; review: boolean; decider: boolean; wsId: string; onChanged: () => Promise<void> }) {
  const decidable = decider && (p.status === 'proposed' || review);
  return (
    <div className="im-body" id={id} data-testid="improvement-detail">
      {p.hypothesis && <p className="im-hyp">{p.hypothesis}</p>}
      <div className="im-facts">
        <div className="im-fact"><span>{CLASS_WORD[p.changeClass]}</span><div>{upper(p.classWhy) || CLASS_HINT[p.changeClass]}</div></div>
        <div className="im-fact" data-testid="improvement-verification"><span>Metric</span><div>{verificationWords(p)}{p.baseline !== null && !p.verification ? ` · baseline ${p.baseline}` : ''}</div></div>
        <div className="im-fact"><span>Decided by</span><div>{holderWord(p.owner, names) === 'you' ? 'You' : holderWord(p.owner, names)}{p.status === 'proposed' && p.expiresAt ? ` · expires ${shortDate(p.expiresAt)}` : ''}</div></div>
        {p.appliedRef && <div className="im-fact"><span>Applied</span><div>{p.appliedRef}</div></div>}
      </div>
      {p.evidence.length > 0 && (
        <div className="im-sec">
          <h4>Evidence</h4>
          <ul className="im-evidence">{p.evidence.map((e, i) => <li key={i}><Pill plain tone="muted">{e.kind.replace('_', ' ')}</Pill><span>{e.summary}{e.ref && !e.summary.includes(e.ref) ? <span className="co-faint"> · {e.ref}</span> : null}</span></li>)}</ul>
        </div>
      )}
      <div className="im-sec">
        <h4>The change</h4>
        {p.diff.length
          ? <pre className="im-diff" data-testid="improvement-diff">{p.diff.map((l, i) => <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined}>{l}{'\n'}</span>)}</pre>
          : <span className="co-dim">Nothing structured: accepting makes one task for its owner, and it counts as applied when that task is done.</span>}
      </div>
      {p.lastError && <div className="co-alert" role="status">{p.lastError}</div>}
      {p.history.length > 0 && (
        <details className="im-sec">
          <summary className="co-link" style={{ cursor: 'pointer' }}>History ({p.history.length})</summary>
          <ul className="im-history">{p.history.map((h, i) => <li key={i}>{shortDate(h.at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {h.from ? `${STATUS_WORD[h.from as OrgImprovement['status']] ?? h.from} → ` : ''}{STATUS_WORD[h.to as OrgImprovement['status']] ?? h.to} · {holderWord(h.by, names)}{h.why ? `: ${h.why}` : ''}</li>)}</ul>
        </details>
      )}
      {(decidable || (decider && p.status === 'applied' && !review)) && <ImprovementActions p={p} review={review} decidable={decidable} wsId={wsId} onChanged={onChanged} />}
      {!decider && p.status === 'proposed' && <p className="co-faint" style={{ margin: 0 }}>Its owner decides; you or a board member can decide it too.</p>}
    </div>
  );
}

/** Accept / Reject (Keep / Revert for an emergency change), Check now. A
 *  rejection or a revert asks why and confirms; the note goes on the record. */
function ImprovementActions({ p, review, decidable, wsId, onChanged }: { p: OrgImprovement; review: boolean; decidable: boolean; wsId: string; onChanged: () => Promise<void> }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [saying, setSaying] = useState(false);
  const [note, setNote] = useState('');
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); app.showToast?.(done); setSaying(false); setNote(''); await onChanged(); } catch (e) { app.showToast?.(errText(e)); } finally { setBusy(false); }
  };
  const no = review ? 'Revert it' : 'Reject';
  return (
    <div className="im-actions">
      {saying ? (
        <form onSubmit={(e) => { e.preventDefault(); void act(() => api.rejectOrgImprovement(wsId, p.key, note.trim()), review ? `${p.key} reverted` : `${p.key} rejected`); }} style={{ display: 'grid', gap: 8 }}>
          <label className="co-field">
            <span>{review ? 'Why revert it?' : 'Why not?'} <span className="co-faint">(optional, goes to whoever raised it)</span></span>
            <textarea className="co-input" rows={2} autoFocus value={note} onChange={(e) => setNote(e.target.value)} aria-label="Reason" onKeyDown={(e) => { if (e.key === 'Escape') setSaying(false); }} />
          </label>
          <div className="al-btns">
            <button type="submit" className="co-btn al-danger" disabled={busy}>{review ? `Confirm: revert ${p.key}` : `Confirm: reject ${p.key}`}</button>
            <button type="button" className="co-btn ghost" onClick={() => setSaying(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="al-btns">
          {decidable && <button className="co-btn primary" disabled={busy} onClick={() => void act(() => api.acceptOrgImprovement(wsId, p.key), review ? `${p.key} kept` : `${p.key} accepted`)}>{review ? 'Keep it' : 'Accept'}</button>}
          {decidable && <button className="co-btn" disabled={busy} onClick={() => setSaying(true)}>{no}…</button>}
          {p.status === 'applied' && !review && <button className="co-btn ghost" disabled={busy} onClick={() => void act(() => api.verifyOrgImprovement(wsId, p.key), `${p.key} checked`)} title={p.verifyAt ? `Otherwise checked on ${shortDate(p.verifyAt)}` : undefined}>Check the metric now</button>}
          {decidable && !review && <span className="co-faint">Accepting applies it through {p.targetKind ? 'its own versioning' : 'one task for its owner'}; it is checked after the window.</span>}
        </div>
      )}
    </div>
  );
}

/** Where new work came from in the window: directed vs self-started as one
 *  split bar, then each origin on one shared scale with its count and its
 *  share of all new work; beside it, each unit's open self-started tasks
 *  against its cap. The rules behind the caps sit behind a disclosure. */
export function WorkSourcesPanel({ s }: { s: WorkSources }) {
  const split = sourceSplit(s);
  const total = Math.max(1, split.total);
  return (
    <Card title="Work sources" aside={`${plural(s.total, 'new task')} · last ${s.days} days`}>
      <div data-testid="work-sources">
        {s.total === 0 ? <Empty title="No new work in the window" compact>New tasks are counted here by where they came from.</Empty> : (
          <div className="ws-grid">
            <div>
              <div className="ws-split" role="img" aria-label={`${split.directed} directed and ${split.self} self-started tasks`}>
                {split.directed > 0 && <span className="dir" style={{ width: `${(split.directed / total) * 100}%` }} />}
                {split.self > 0 && <span className="self" style={{ width: `${(split.self / total) * 100}%` }} />}
              </div>
              <div className="ws-legend">
                <span><i className="ws-key dir" />Directed <b>{split.directed}</b> ({pct(split.directed / total)})</span>
                <span><i className="ws-key self" />Self-started <b>{split.self}</b> ({pct(split.self / total)})</span>
              </div>
              {split.groups.map((g) => (
                <div key={g.id} className="ws-group">
                  <div className="ws-group-head"><span>{g.label}</span><span>{plural(g.n, 'task')}</span></div>
                  <div className="ws-rows">
                    {g.rows.map((r) => (
                      <div key={r.origin} className="ws-row" data-testid="source-bar">
                        <span className="ws-label" title={r.label}>{r.label}{g.id === 'self' ? <span className="co-sr"> · self-started</span> : null}</span>
                        <span className={`co-bar ${g.id === 'self' ? 'self' : 'dir'}`} role="img" aria-label={`${r.label}: ${r.n} tasks, ${pct(r.share)} of new work`}><span style={{ width: `${Math.max(2, r.scale * 100)}%` }} /></span>
                        <span className="ws-n">{r.n}<small>{pct(r.share)}</small></span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div>
              <div className="ws-group-head" style={{ marginBottom: 8 }}><span>Open self-started work against the cap</span><span>cap {s.caps.selfWip} per unit</span></div>
              {s.perUnit.length === 0 ? <p className="co-faint" style={{ margin: 0 }}>No units yet.</p> : (
                <div className="ws-rows" data-testid="unit-caps">
                  {s.perUnit.map((u) => (
                    <div key={u.unitId} className="ws-cap-row" title="Open self-started tasks against the unit's cap">
                      <span className="ws-label">{u.name}</span>
                      <Bar value={u.cap > 0 ? Math.min(1, u.selfOpen / u.cap) : 0} tone={capTone(u.selfOpen, u.cap)} label={`${u.name}: ${u.selfOpen} of ${u.cap} open self-started tasks`} />
                      <span className="ws-n">{u.selfOpen}/{u.cap}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="ws-stats">
                <span><b>{s.admission.refused}</b> refused</span>
                <span><b>{s.admission.parked}</b> parked</span>
                <span><b>{s.admission.deferredWakes}</b> {s.admission.deferredWakes === 1 ? 'wake' : 'wakes'} deferred</span>
                <span><b>{pct(s.systemShare)}</b> filed in Operating/Unsorted</span>
                <span><b>{pct(s.retroShare)}</b> from retros</span>
              </div>
              <details className="ws-rules">
                <summary>How the caps work</summary>
                <ul>
                  <li>At most {s.caps.selfWip} open self-started tasks per unit, and {s.caps.selfPerDay} new ones a day per member. Over the cap a task is {s.caps.overCap === 'park' ? 'parked unassigned in the backlog' : 'refused with what to do instead'}.</li>
                  <li>{plural(s.caps.maxOpenPerTarget, 'open proposal')} per target at a time, {s.caps.maxOpenPerUnit} per unit, {s.caps.perMeeting} raised per retro.</li>
                  <li>A member is woken by other agents at most {s.caps.agentWakesPerHour} times an hour; the rest wait for the next hour.</li>
                  <li>In the window: {s.proposals.opened} proposals opened, {s.proposals.accepted} accepted, {s.proposals.applied} applied, {s.proposals.verified} verified, {s.proposals.reverted} reverted, {s.proposals.rejected} rejected, {s.proposals.expired} expired.</li>
                </ul>
              </details>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
