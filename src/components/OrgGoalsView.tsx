/** Direction › Goals: the OKR view (docs/company-vision.md §2). Each
 *  objective is a block with its health, owner and blended progress; its key
 *  results are compact rows — title, owner, the metric current → target with
 *  a bar and the pace marker, the health pill, the owner's confidence, the
 *  next check-in and the linked tasks. A row expands to its description,
 *  the measurement source, the check-in history, linked projects and
 *  channel messages, and a check-in form (value, confidence, note). Status
 *  changes, "add key result", "Why" and the `#goal:` reference live in a
 *  row menu; a department filter scopes the tree. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type ChannelMessage, type MetricSource, type OrgCheckin, type OrgDetail, type OrgIntentNode, type ProgramOwner } from '../lib/api';
import { checkInDue, confidenceGap, flattenIntent } from '../lib/org';
import { fmtNum, HEALTH_LABEL, HEALTH_TONE, inDays, krHealth, nextCheckIn, objectiveHealth, objectivesOfTree, plural, shortDate, type Health } from '../lib/direction';
import { I, P } from '../lib/icons';
import { ago, useAgentNames, useUnits } from './org-ui';
import { Bar, Empty, Menu, Metric, Owner, PageHeader, PageSkeleton, Pill, CopyRef } from './CompanyKit';
import { KrSourceLine } from './OrgSensingView';
import { useProgram } from './ProgramMatrixView';
import { useIsCeo, WhyDrawer } from './OrgVisionView';

const STATUSES: Array<{ id: string; label: string }> = [{ id: 'active', label: 'Active' }, { id: 'achieved', label: 'Achieved' }, { id: 'draft', label: 'Draft' }, { id: 'abandoned', label: 'Abandoned' }];

type Act = (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;

export function GoalsPane({ org, reload }: { org: OrgDetail; reload: () => Promise<void> }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const names = useAgentNames();
  const { units, current, isCompany } = useUnits();
  const isCeo = useIsCeo(wsId);
  const unitId = isCompany ? null : current?.id ?? null;
  const [tree, setTree] = useState<OrgIntentNode[] | null>(null);
  const [sources, setSources] = useState<MetricSource[]>([]);
  const [show, setShow] = useState<'active' | 'all'>('active');
  const [adding, setAdding] = useState<{ kind: 'objective' | 'key_result'; parentId: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [why, setWhy] = useState<{ id: string; title: string } | null>(null);
  const matrix = useProgram(wsId, String(tree?.length ?? 0));
  const owners = useMemo(() => new Map((matrix?.items ?? []).filter((i) => i.refType === 'goal').map((i) => [i.id, i.owner])), [matrix]);
  const refresh = useCallback(async () => {
    const [t, src] = await Promise.all([api.orgIntent(wsId, unitId).catch((): OrgIntentNode[] => []), api.orgMetricSources(wsId).catch((): MetricSource[] => [])]);
    setTree(t); setSources(src);
  }, [wsId, unitId]);
  useEffect(() => { setTree(null); void refresh(); const t = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(t); }, [refresh]);
  const act: Act = useCallback(async (fn, done) => {
    try { await fn(); await refresh(); void reload(); if (done) app.showToast(done); return true; } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); return false; }
  }, [refresh, reload, app]);
  // A deep link (Overview, a chip, the Why drawer) names a goal: open and scroll to it.
  useEffect(() => {
    if (app.orgFocus?.kind !== 'goal' || !tree) return;
    const id = app.orgFocus.id;
    const hit = flattenIntent(tree).find((g) => g.id === id || g.id.startsWith(id));
    app.setOrgFocus(null);
    if (!hit) return;
    if (hit.kind === 'key_result') setOpen(hit.id);
    requestAnimationFrame(() => { const el = document.getElementById(`goal-${hit.id}`); if (el) { el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); } });
  }, [tree, app]);

  const vision = tree?.find((n) => n.kind === 'vision') ?? null;
  const objectives = useMemo(() => objectivesOfTree(tree ?? []).filter((o) => show === 'all' || o.status === 'active' || o.status === 'draft'), [tree, show]);
  const all = useMemo(() => flattenIntent(objectives), [objectives]);
  const krs = all.filter((g) => g.kind === 'key_result' && g.status === 'active');
  const count = (h: Health) => krs.filter((k) => krHealth(k) === h).length;
  const due = krs.filter((k) => checkInDue(k)).length;
  const canWrite = isCeo !== false;

  if (tree === null) return <PageSkeleton cards={2} />;
  return (
    <div className="co-page narrow" data-testid="goals-page">
      <PageHeader title={isCompany ? 'Goals' : `${current?.name ?? 'Department'} goals`}
        purpose="Objectives and the key results that measure them. Owners check in on a rhythm; progress is measured, confidence is theirs."
        actions={canWrite && <button className="co-btn primary" onClick={() => setAdding({ kind: 'objective', parentId: vision?.id ?? '' })}>Add objective</button>} />
      <div className="co-toolbar">
        {units.length > 1 && (
          <div className="co-chips" role="tablist" aria-label="Department">
            {units.map((u) => {
              const on = (u.parentUnitId === null && isCompany) || (u.parentUnitId !== null && app.orgUnitId === u.id);
              return <button key={u.id} role="tab" aria-selected={on} className={`co-chip${on ? ' on' : ''}`} onClick={() => app.setOrgUnitId(u.parentUnitId === null ? null : u.id)}>{u.parentUnitId === null ? 'Whole company' : u.name}</button>;
            })}
          </div>
        )}
        <span style={{ flex: 1 }} />
        <div className="co-seg" role="tablist" aria-label="Show">
          <button role="tab" aria-selected={show === 'active'} onClick={() => setShow('active')}>Active</button>
          <button role="tab" aria-selected={show === 'all'} onClick={() => setShow('all')}>All</button>
        </div>
      </div>
      {krs.length > 0 && (
        <div className="co-metrics" style={{ marginBottom: 16 }} data-testid="goals-summary">
          <Metric n={objectives.length} label={objectives.length === 1 ? 'objective' : 'objectives'} />
          <Metric n={count('on_track')} label="on track" tone={count('on_track') ? 'ok' : undefined} />
          <Metric n={count('at_risk')} label="at risk" tone={count('at_risk') ? 'warn' : undefined} />
          <Metric n={count('off_track')} label="off track" tone={count('off_track') ? 'bad' : undefined} />
          <Metric n={due} label={due === 1 ? 'check-in due' : 'check-ins due'} tone={due ? 'warn' : undefined} />
        </div>
      )}
      {adding && <GoalForm org={org} kind={adding.kind} parents={all.filter((g) => g.kind === 'objective')} parentId={adding.parentId} visionId={vision?.id ?? null} defaultUnit={unitId} act={act} onClose={() => setAdding(null)} />}
      {objectives.length === 0 && !adding && (
        <Empty title={isCompany ? 'No objectives yet' : 'No objectives handed to this department'} action={canWrite ? <button className="co-btn primary" onClick={() => setAdding({ kind: 'objective', parentId: vision?.id ?? '' })}>Add objective</button> : undefined}>
          {vision ? 'The chief plans objectives when the vision is written or revised; Plan now on the Vision page runs it at once. You can add one yourself.' : 'Write the vision first: the chief plans objectives and key results from it.'}
        </Empty>
      )}
      <div style={{ display: 'grid', gap: 14 }}>
        {objectives.map((o) => <ObjectiveBlock key={o.id} o={o} depth={0} org={org} owners={owners} names={names} sources={sources} isCeo={isCeo} open={open} setOpen={setOpen} act={act} onAdd={(parentId) => setAdding({ kind: 'key_result', parentId })} onWhy={(g) => setWhy({ id: g.id, title: g.title })} refresh={refresh} />)}
      </div>
      {why && <WhyDrawer wsId={wsId} goalId={why.id} title={why.title} onClose={() => setWhy(null)} />}
    </div>
  );
}

interface RowCtx {
  org: OrgDetail; owners: Map<string, ProgramOwner>; names: ReturnType<typeof useAgentNames>; sources: MetricSource[]; isCeo: boolean | null;
  open: string | null; setOpen: (id: string | null) => void; act: Act; onAdd: (parentId: string) => void; onWhy: (g: OrgIntentNode) => void; refresh: () => Promise<void>;
}

function OwnerOf({ g, owners, names }: { g: OrgIntentNode; owners: Map<string, ProgramOwner>; names: RowCtx['names'] }) {
  const o = owners.get(g.id);
  if (o && o.role !== 'none') return <Owner agent={o.agentId ? names.get(o.agentId) : undefined} name={o.name} role={o.role === 'acting_chief' ? 'acting PM' : o.role === 'pm' ? 'PM' : undefined} />;
  return <Owner agent={g.ownerAgentId ? names.get(g.ownerAgentId) : undefined} name={g.ownerName} />;
}

function GoalMenu({ g, ctx }: { g: OrgIntentNode; ctx: RowCtx }) {
  const { org, act } = ctx;
  return (
    <Menu label={`Actions for ${g.title}`} trigger={<I d={P.dots} size={15} />} triggerClass="co-iconbtn" sections={[
      { items: [
        ...(g.kind === 'objective' ? [{ id: 'add', label: 'Add key result', onSelect: () => ctx.onAdd(g.id) }] : []),
        { id: 'why', label: 'Why does this exist?', onSelect: () => ctx.onWhy(g) },
        { id: 'copy', label: 'Copy reference', onSelect: () => { void navigator.clipboard?.writeText(`#goal:${g.id.slice(0, 8)}`).catch(() => undefined); } },
      ] },
      { label: 'Status', items: STATUSES.map((s) => ({ id: s.id, label: s.label, checked: g.status === s.id, onSelect: () => { if (s.id !== g.status) void act(() => api.updateOrgGoal(org.workspaceId, g.id, { status: s.id }), `Marked ${s.label.toLowerCase()}`); } })) },
    ]} />
  );
}

function ObjectiveBlock({ o, depth, ...ctx }: { o: OrgIntentNode; depth: number } & RowCtx) {
  const [more, setMore] = useState(false);
  const h = objectiveHealth(o);
  const krs = o.children.filter((c) => c.kind === 'key_result');
  const subs = o.children.filter((c) => c.kind !== 'key_result');
  const pct = Math.round(o.progress * 100);
  return (
    <section className={depth === 0 ? 'co-card' : undefined} id={`goal-${o.id}`} tabIndex={-1} data-testid="objective" data-health={h} style={{ outline: 'none', ...(depth > 0 ? { borderTop: '1px solid var(--border-soft)', marginTop: 4 } : {}), opacity: o.status === 'abandoned' ? .65 : 1 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', padding: depth === 0 ? '14px 16px 10px' : '12px 16px 8px' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <Pill tone={HEALTH_TONE[h]}>{HEALTH_LABEL[h]}</Pill>
            {o.status !== 'active' && <Pill plain>{o.status}</Pill>}
            <OwnerOf g={o} owners={ctx.owners} names={ctx.names} />
          </div>
          <h3 style={{ margin: 0, fontSize: depth === 0 ? 15.5 : 14, fontWeight: 650, lineHeight: 1.35, letterSpacing: '-.008em' }}>{o.title}</h3>
          {o.description && (
            <p style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-dim)', maxWidth: '72ch', ...(more ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }) }}>{o.description}</p>
          )}
          {o.description && o.description.length > 180 && <button className="co-link" style={{ fontSize: 12, marginTop: 2 }} aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}</button>}
          {o.atRisk === 1 && o.atRiskReason && <div className="co-note warn" style={{ marginTop: 8 }}>{o.atRiskReason}</div>}
        </div>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width: 130 }}><Bar value={o.progress} tone={HEALTH_TONE[h] === 'muted' ? undefined : HEALTH_TONE[h]} label={`${o.title} progress`} /><span className="co-num" style={{ fontSize: 13, fontWeight: 650, width: 36, textAlign: 'right' }}>{pct}%</span></span>
          <CopyRef text={`#goal:${o.id.slice(0, 8)}`} />
          <GoalMenu g={o} ctx={ctx} />
        </div>
      </div>
      {krs.length > 0 ? (
        <div role="list" aria-label={`Key results of ${o.title}`} style={{ padding: '0 6px 8px' }}>
          {krs.map((k) => <KrRow key={k.id} k={k} {...ctx} />)}
        </div>
      ) : (
        <div style={{ padding: '0 16px 14px', fontSize: 12.5, color: 'var(--text-dim)' }}>No key results yet. {ctx.isCeo !== false && <button className="co-link" onClick={() => ctx.onAdd(o.id)}>Add one</button>} {o.tasks.total > 0 && <span>· {o.tasks.done} of {plural(o.tasks.total, 'linked task')} done</span>}</div>
      )}
      {subs.map((s) => <ObjectiveBlock key={s.id} o={s} depth={depth + 1} {...ctx} />)}
    </section>
  );
}

function KrRow({ k, ...ctx }: { k: OrgIntentNode } & RowCtx) {
  const expanded = ctx.open === k.id;
  const h = krHealth(k);
  const next = nextCheckIn(k);
  const isDue = k.status === 'active' && checkInDue(k);
  const value = `${fmtNum(k.currentValue ?? k.startValue)} / ${fmtNum(k.targetValue)}${k.unitLabel ? ` ${k.unitLabel}` : ''}`;
  return (
    <div role="listitem" id={`goal-${k.id}`} tabIndex={-1} data-testid="kr-row" data-health={h} style={{ outline: 'none', borderRadius: 8, background: expanded ? 'var(--panel-2)' : undefined, opacity: k.status === 'abandoned' ? .6 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button className="co-row" aria-expanded={expanded} onClick={() => ctx.setOpen(expanded ? null : k.id)} style={{ flexWrap: 'wrap', rowGap: 6 }}>
          <span style={{ flex: 'none', color: 'var(--text-faint)', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .12s', display: 'inline-flex' }} aria-hidden><I d={P.chevR} size={12} /></span>
          <span className="co-row-main" style={{ flex: '1 1 220px' }}>
            <span className="co-row-title wrap" style={{ fontWeight: 560 }}>{k.title}</span>
            <span className="co-row-meta">{k.metric || 'metric'} · {k.tasks.total ? `${k.tasks.done}/${plural(k.tasks.total, 'task')} done` : 'no linked tasks'}</span>
          </span>
          <span className="co-kr-end">
            <OwnerOf g={k} owners={ctx.owners} names={ctx.names} />
            <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, minWidth: 0 }} title={k.expected !== null ? `${Math.round((k.measured ?? 0) * 100)}% measured; ${Math.round(k.expected * 100)}% expected by now` : undefined}>
              <span className="co-num" style={{ fontSize: 12, color: 'var(--text)', textAlign: 'right', whiteSpace: 'nowrap' }}>{value}</span>
              <Bar value={k.measured} tone={HEALTH_TONE[h] === 'muted' ? undefined : HEALTH_TONE[h]} marker={k.expected} label={`${k.title} measured progress`} />
            </span>
            <Pill tone={HEALTH_TONE[h]}>{HEALTH_LABEL[h]}</Pill>
            <span className="co-num" style={{ fontSize: 12, color: isDue ? 'var(--warn-text)' : 'var(--text-dim)', textAlign: 'right', whiteSpace: 'nowrap' }} title={k.lastCheckInAt ? `Last check-in ${ago(k.lastCheckInAt)}` : 'Never checked in'}>{k.status !== 'active' ? '' : isDue ? 'Check-in due' : `Next ${shortDate(next)}`}</span>
          </span>
        </button>
        <span style={{ flex: 'none', display: 'flex', paddingRight: 6 }}><GoalMenu g={k} ctx={ctx} /></span>
      </div>
      {expanded && <KrDetail k={k} {...ctx} />}
    </div>
  );
}

function KrDetail({ k, org, sources, isCeo, act, refresh }: { k: OrgIntentNode } & RowCtx) {
  const app = useApp();
  const [history, setHistory] = useState<OrgCheckin[] | null>(null);
  const [msgs, setMsgs] = useState<Array<ChannelMessage & { slug: string }> | null>(null);
  const [checking, setChecking] = useState(false);
  const load = useCallback(() => { void api.orgCheckIns(org.workspaceId, k.id).then(setHistory).catch(() => setHistory([])); }, [org.workspaceId, k.id]);
  useEffect(() => { load(); void api.goalMessages(org.workspaceId, k.id).then(setMsgs).catch(() => setMsgs([])); }, [load, org.workspaceId, k.id]);
  const gap = confidenceGap(k.measured, k.confidence);
  const projects = org.projects.filter((p) => p.goalId === k.id || (p.goalIds ?? '').includes(k.id));
  return (
    <div style={{ padding: '4px 16px 14px 36px', display: 'grid', gap: 12 }} data-testid="kr-detail">
      {k.description && <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-dim)', maxWidth: '72ch', whiteSpace: 'pre-wrap' }}>{k.description}</p>}
      {k.atRisk === 1 && k.atRiskReason && <div className="co-note warn">{k.atRiskReason}</div>}
      <dl className="co-dl">
        <dt>Measured</dt><dd>{k.measured === null ? 'No measurement yet' : `${Math.round(k.measured * 100)}%`}{k.expected !== null ? ` (${Math.round(k.expected * 100)}% expected by now)` : ''}</dd>
        <dt>Confidence</dt><dd>{k.confidence === null ? 'Never given' : `${Math.round(k.confidence * 100)}%`} · {gap.note}</dd>
        <dt>Due</dt><dd>{k.dueAt ? `${shortDate(k.dueAt, { month: 'short', day: 'numeric', year: 'numeric' })} (${inDays(k.dueAt)})` : 'No due date'}</dd>
        <dt>Check-ins</dt><dd>Every {plural(k.checkInCadenceDays, 'day')} · last {k.lastCheckInAt ? ago(k.lastCheckInAt) : 'never'}</dd>
        <dt>Source</dt><dd><KrSourceLine g={k} wsId={org.workspaceId} sources={sources} isCeo={isCeo} onChanged={refresh} /></dd>
      </dl>
      {k.status === 'active' && (checking
        ? <CheckInForm k={k} onCancel={() => setChecking(false)} onSave={async (body) => { const ok = await act(() => api.orgCheckIn(org.workspaceId, k.id, body), 'Check-in recorded'); if (ok) { setChecking(false); load(); } }} />
        : <div><button className="co-btn primary small" onClick={() => setChecking(true)}>Check in</button></div>)}
      <div>
        <div className="co-sub" style={{ marginTop: 0 }}>Check-in history</div>
        {history === null ? <span className="co-faint">Loading…</span> : history.length === 0 ? <span className="co-faint">No check-ins yet.</span> : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }} data-testid="checkin-history">
            {history.slice().reverse().slice(0, 8).map((c) => (
              <li key={c.id} style={{ display: 'flex', gap: 10, fontSize: 12.5, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className="co-num co-faint" style={{ width: 64 }}>{shortDate(c.createdAt)}</span>
                <span className="co-num" style={{ fontWeight: 600 }}>{fmtNum(c.currentValue)}{k.unitLabel ? ` ${k.unitLabel}` : ''}</span>
                <span className="co-dim">{c.confidence === null ? 'no confidence' : `${Math.round(c.confidence * 100)}% confident`}</span>
                {c.note && <span style={{ flex: '1 1 200px' }}>{c.note}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
      {(projects.length > 0 || (msgs && msgs.length > 0)) && (
        <div>
          <div className="co-sub" style={{ marginTop: 0 }}>Linked work</div>
          <div className="co-rows" style={{ margin: '0 -10px' }}>
            {projects.map((p) => <button key={p.id} className="co-row" onClick={() => { app.setOrgFocus({ kind: 'project', id: p.id }); app.setOrgPane('roadmap'); }}><span className="co-row-main"><span className="co-row-title">{p.key && <span className="co-key">{p.key}</span>}{p.title}</span></span><span className="co-row-end">{p.lane ?? ''}</span></button>)}
            {msgs?.slice(0, 5).map((m) => <button key={m.id} className="co-row" onClick={() => app.openChannel(m.slug, m.id)}><span className="co-row-main"><span className="co-row-title" style={{ fontWeight: 450 }}>{m.text}</span><span className="co-row-meta">#{m.slug}</span></span><span className="co-row-end">{ago(m.createdAt)}</span></button>)}
          </div>
        </div>
      )}
    </div>
  );
}

const CONF_WORD = (c: number) => (c >= 80 ? 'confident' : c >= 60 ? 'likely' : c >= 40 ? 'unsure' : 'unlikely');

export function CheckInForm({ k, onSave, onCancel }: { k: OrgIntentNode; onSave: (b: { currentValue?: number | null; confidence: number; note: string }) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState(k.currentValue === null ? '' : String(k.currentValue));
  const [conf, setConf] = useState(k.confidence === null ? 70 : Math.round(k.confidence * 100));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const measured = k.measuredBy ?? null;
  const bad = !measured && value.trim() !== '' && !Number.isFinite(Number(value));
  const submit = async () => { setBusy(true); await onSave(measured ? { confidence: conf / 100, note } : { currentValue: value.trim() === '' ? null : Number(value), confidence: conf / 100, note }); setBusy(false); };
  return (
    <form className="co-card co-form" style={{ padding: 14 }} data-testid="checkin-form" onSubmit={(e) => { e.preventDefault(); if (!bad) void submit(); }}>
      <div className="co-form-row">
        {measured
          ? <div className="co-field"><span>Current {k.metric || 'value'}</span><div className="co-num" style={{ fontSize: 14, fontWeight: 600 }}>{fmtNum(k.currentValue)}{k.unitLabel ? ` ${k.unitLabel}` : ''}</div><small>Measured by {measured.name}; you add your confidence</small></div>
          : <label className="co-field"><span>Current {k.metric || 'value'}{k.unitLabel ? ` (${k.unitLabel})` : ''}</span><input className="co-input co-num" autoFocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.,-]/g, '').replace(',', '.'))} placeholder={`Target ${fmtNum(k.targetValue)}`} aria-invalid={bad} /><small>Target {fmtNum(k.targetValue)}{k.unitLabel ? ` ${k.unitLabel}` : ''}</small></label>}
        <label className="co-field"><span>Confidence: {conf}% ({CONF_WORD(conf)})</span><input type="range" min={0} max={100} step={5} value={conf} onChange={(e) => setConf(Number(e.target.value))} aria-valuetext={`${conf}%, ${CONF_WORD(conf)}`} /><small>How likely the target is met by its due date</small></label>
      </div>
      <label className="co-field"><span>Note</span><input className="co-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What moved, and what is in the way" /></label>
      <div className="co-form-foot"><button type="button" className="co-btn ghost" onClick={onCancel}>Cancel</button><button type="submit" className="co-btn primary" disabled={busy || bad}>Record check-in</button></div>
    </form>
  );
}

function GoalForm({ org, kind: kind0, parents, parentId, visionId, defaultUnit, act, onClose }: { org: OrgDetail; kind: 'objective' | 'key_result'; parents: OrgIntentNode[]; parentId: string; visionId: string | null; defaultUnit: string | null; act: Act; onClose: () => void }) {
  const names = useAgentNames();
  const { units, root } = useUnits();
  const [kind, setKind] = useState(kind0);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [parent, setParent] = useState(kind0 === 'key_result' ? parentId : '');
  const [unitId, setUnitId] = useState(defaultUnit ?? root?.id ?? '');
  const [owner, setOwner] = useState('');
  const [metric, setMetric] = useState('');
  const [start, setStart] = useState('');
  const [target, setTarget] = useState('');
  const [unitLabel, setUnitLabel] = useState('');
  const [due, setDue] = useState('');
  const [cadence, setCadence] = useState('7');
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const isKr = kind === 'key_result';
  const invalid = !title.trim() || (isKr && (!parent || num(target) === null || !Number.isFinite(num(target)!)));
  const save = () => void act(async () => {
    await api.addOrgGoal(org.workspaceId, {
      title: title.trim(), description: desc, kind, unitId: unitId || null, ownerAgentId: owner || null,
      parentGoalId: isKr ? parent : (parent || visionId || null),
      ...(due ? { dueAt: new Date(`${due}T23:59:59`).toISOString() } : {}),
      ...(isKr ? { metric: metric.trim(), startValue: num(start), targetValue: num(target), unitLabel: unitLabel.trim(), checkInCadenceDays: Math.max(1, Math.min(90, Number(cadence) || 7)) } : {}),
    });
    onClose();
  }, isKr ? 'Key result added' : 'Objective added');
  return (
    <form className="co-card co-form" style={{ padding: 16, marginBottom: 16 }} data-testid="goal-form" onSubmit={(e) => { e.preventDefault(); if (!invalid) save(); }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 650, flex: 1 }}>{isKr ? 'New key result' : 'New objective'}</div>
        <div className="co-seg" role="tablist" aria-label="Kind">
          <button type="button" role="tab" aria-selected={!isKr} onClick={() => setKind('objective')}>Objective</button>
          <button type="button" role="tab" aria-selected={isKr} onClick={() => { setKind('key_result'); if (!parent && parents[0]) setParent(parents[0].id); }} disabled={parents.length === 0} title={parents.length === 0 ? 'Add an objective first' : undefined}>Key result</button>
        </div>
      </div>
      <label className="co-field"><span>{isKr ? 'What is measured' : 'The objective'}</span><input className="co-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={isKr ? 'e.g. 40 paying learners by March' : 'e.g. Prove learners will pay for feedback'} /></label>
      <label className="co-field"><span>Why it matters <small style={{ fontWeight: 400 }}>(optional)</small></span><textarea className="co-input" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={isKr ? 'How it is measured and what counts' : 'What success looks like'} /></label>
      {isKr && (
        <div className="co-form-row">
          <label className="co-field"><span>Metric</span><input className="co-input" value={metric} onChange={(e) => setMetric(e.target.value)} placeholder="paying learners" /></label>
          <label className="co-field"><span>Start</span><input className="co-input co-num" inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} placeholder="0" /></label>
          <label className="co-field"><span>Target</span><input className="co-input co-num" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="40" required /></label>
          <label className="co-field"><span>Unit</span><input className="co-input" value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} placeholder="learners, %, $" /></label>
        </div>
      )}
      <div className="co-form-row">
        {isKr
          ? <label className="co-field"><span>Objective</span><select className="co-input" value={parent} onChange={(e) => setParent(e.target.value)}>{parents.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
          : parents.length > 0 && <label className="co-field"><span>Under</span><select className="co-input" value={parent} onChange={(e) => setParent(e.target.value)}><option value="">The vision (top level)</option>{parents.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
        {units.length > 1 && <label className="co-field"><span>Department</span><select className="co-input" value={unitId} onChange={(e) => setUnitId(e.target.value)}>{units.map((u) => <option key={u.id} value={u.id}>{u.parentUnitId === null ? 'Whole company' : `${'  '.repeat(Math.max(0, u.depth - 1))}${u.name}`}</option>)}</select></label>}
        <label className="co-field"><span>Owner</span><select className="co-input" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">No owner yet</option>{org.members.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.agentId}>{names.get(m.agentId)?.name ?? m.title}</option>)}</select></label>
        <label className="co-field"><span>Due</span><input className="co-input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        {isKr && <label className="co-field"><span>Check in every (days)</span><input className="co-input co-num" type="number" min={1} max={90} value={cadence} onChange={(e) => setCadence(e.target.value)} /></label>}
      </div>
      <div className="co-form-foot"><button type="button" className="co-btn ghost" onClick={onClose}>Cancel</button><button type="submit" className="co-btn primary" disabled={invalid}>{isKr ? 'Add key result' : 'Add objective'}</button></div>
    </form>
  );
}
