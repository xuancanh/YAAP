/** The Vision page (docs/company-vision.md §2, §8; execution plan item 18):
 *  the CEO writes and revises the vision (one line, a paragraph, a horizon,
 *  the standing rules) and the operating profile (values, culture), reads
 *  the chief's latest strategy memo and asks for a planning session now; the
 *  intent tree below shows objectives → key results with measured progress
 *  AND the owner's confidence side by side (they can disagree), the pace
 *  badge, the at-risk flag with its reason, owner, due date and last
 *  check-in, an inline check-in form, and a "Why" drawer on any goal that
 *  walks task → key result → objective → vision and names a broken link. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type MetricSource, type OrgCheckin, type OrgDetail, type OrgGoal, type OrgIntentNode, type OrgVisionInfo, type WhyChain } from '../lib/api';
import { KrSourceLine } from './OrgSensingView';
import { I, P } from '../lib/icons';
import { atRiskByUnit, checkInDue, confidenceGap, daysUntil, dueLabel, flattenIntent, KIND_LABEL, paceBadge, summarizeChildren } from '../lib/org';
import { card, input, btn, pill, h2, faint, label, linkBtn, ago, useAgentNames, useUnits, Avatar, UnitChips, Drawer } from './org-ui';

const textarea: React.CSSProperties = { ...input, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 };

/** Is the person on screen the CEO? The server refuses writes otherwise; the
 *  page says so instead of failing. */
function useIsCeo(wsId: string): boolean | null {
  const [role, setRole] = useState<boolean | null>(null);
  useEffect(() => { void api.orgHumans(wsId).then((h) => setRole(h.me.role === 'ceo')).catch(() => setRole(null)); }, [wsId]);
  return role;
}

export function VisionPane({ org, reload }: { org: OrgDetail; reload: () => Promise<void> }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const { current, isCompany } = useUnits();
  const isCeo = useIsCeo(wsId);
  const [info, setInfo] = useState<OrgVisionInfo | null>(null);
  const [strategy, setStrategy] = useState<{ memo: string; at: string | null } | null>(null);
  const [tree, setTree] = useState<OrgIntentNode[] | null>(null);
  const [why, setWhy] = useState<{ goalId: string; title: string } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [sources, setSources] = useState<MetricSource[]>([]);
  const unitId = isCompany ? null : current?.id ?? null;
  const refresh = useCallback(async () => {
    const [v, s, t, src] = await Promise.all([api.orgVision(wsId).catch(() => null), api.orgStrategy(wsId).catch(() => null), api.orgIntent(wsId, unitId).catch((): OrgIntentNode[] => []), api.orgMetricSources(wsId).catch((): MetricSource[] => [])]);
    setInfo(v); setStrategy(s); setTree(t); setSources(src);
  }, [wsId, unitId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(t); }, [refresh]);
  // A deep link (a signal row, a chip) names a goal: scroll to it once rendered.
  useEffect(() => {
    if (app.orgFocus?.kind !== 'goal' || !tree) return;
    const el = document.getElementById(`goal-${app.orgFocus.id}`) ?? document.querySelector<HTMLElement>(`[id^="goal-${app.orgFocus.id}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.style.outline = '2px solid var(--accent)'; setTimeout(() => { el.style.outline = ''; }, 2400); app.setOrgFocus(null); }
  }, [tree, app]);
  const act = useCallback(async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); await refresh(); void reload(); if (done) app.showToast(done); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); }
  }, [refresh, reload, app]);
  const planNow = async () => {
    setPlanning(true);
    try {
      const r = await api.orgPlanNow(wsId, unitId ? { unitId, reason: 'planning requested by the CEO from the vision page' } : { reason: 'planning requested by the CEO from the vision page' });
      app.showToast(r.result === 'done' || r.result === 'ran' ? 'Planning session ran — the tree is refreshed' : `Planning: ${r.result}`);
      await refresh();
    } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'planning failed'); } finally { setPlanning(false); }
  };
  const riskByUnit = useMemo(() => atRiskByUnit(app.orgIntent), [app.orgIntent]);
  // The tree's root is the vision when the company is on screen; objectives otherwise.
  const roots = tree ?? [];
  const visionNode = roots.find((n) => n.kind === 'vision');
  const objectives = visionNode ? visionNode.children : roots;
  const krCount = flattenIntent(objectives).filter((g) => g.kind === 'key_result' && g.status === 'active').length;
  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={h2}>{isCompany ? 'Vision' : `${current?.name ?? 'Unit'} · intent`}</h2>
          <div style={faint}>One vision, a few objectives, measured key results with an owner who checks in. The chief derives the plan; you revise the vision and it re-plans. {isCeo === false && 'Only the CEO writes here.'}</div>
        </div>
        <button style={btn()} disabled={planning} onClick={() => void planNow()} title="Run a planning session of the unit's lead now (the root by default); ignores the cooldown">{planning ? 'Planning…' : 'Plan now'}</button>
      </div>
      <UnitChips count={(u) => riskByUnit[u.parentUnitId === null ? '' : u.id] ?? riskByUnit[u.id] ?? null} title={(u) => `${riskByUnit[u.parentUnitId === null ? '' : u.id] ?? 0} goal(s) at risk`} />
      {isCompany && <VisionCard info={info} isCeo={isCeo} act={act} />}
      {isCompany && <ProfileCard info={info} isCeo={isCeo} act={act} />}
      {isCompany && <StrategyCard strategy={strategy} />}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '16px 0 8px' }}>
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>{isCompany ? 'Objectives and key results' : 'Objectives handed to this unit'}</div>
        <span style={faint}>{objectives.length} objective(s) · {krCount} key result(s){visionNode?.dueAt ? ` · horizon ${visionNode.dueAt.slice(0, 10)}` : ''}</span>
      </div>
      {tree === null && <div style={faint}>Loading…</div>}
      {tree !== null && objectives.length === 0 && (
        <div style={{ ...card, ...faint }}>
          {visionNode || info?.vision ? 'No objectives yet. Planning runs when the vision is written or revised (debounced); "Plan now" runs it immediately.' : 'No vision yet. Write one above — one line, a horizon, your standing rules — and the chief plans the objectives.'}
        </div>
      )}
      {objectives.map((g) => <IntentRow key={g.id} g={g} depth={0} org={org} act={act} onWhy={(goal) => setWhy({ goalId: goal.id, title: goal.title })} sources={sources} isCeo={isCeo} onSourceChanged={async () => { await refresh(); void reload(); }} />)}
      {why && <WhyDrawer wsId={wsId} goalId={why.goalId} title={why.title} onClose={() => setWhy(null)} />}
    </div>
  );
}

// ---- the vision, the profile, the memo ----

function VisionCard({ info, isCeo, act }: { info: OrgVisionInfo | null; isCeo: boolean | null; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const app = useApp();
  const v = info?.vision ?? null;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [due, setDue] = useState('');
  const [rules, setRules] = useState('');
  useEffect(() => { setTitle(v?.title ?? ''); setDesc(v?.description ?? ''); setDue(v?.dueAt ? v.dueAt.slice(0, 10) : ''); setRules(info?.rules ?? ''); }, [v?.id, v?.title, v?.description, v?.dueAt, info?.rules]);
  const save = () => void act(async () => {
    await api.setOrgVision(app.workspaceId, { title: title.trim(), description: desc, dueAt: due ? new Date(`${due}T23:59:59`).toISOString() : null, rules });
    setEditing(false);
  }, v ? 'Vision revised — the chief re-plans' : 'Vision set — the chief plans the objectives');
  const canWrite = isCeo !== false;
  if (!editing) {
    return (
      <div style={{ ...card, marginBottom: 10, borderLeft: `3px solid ${v ? (v.atRisk ? 'var(--amber)' : 'var(--accent)') : 'var(--border)'}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={label}>Vision{v?.dueAt ? ` · by ${v.dueAt.slice(0, 10)}` : ''}{v?.atRisk ? ' · at risk' : ''}</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, lineHeight: 1.35 }}>{v ? v.title : <span style={{ color: 'var(--text-faint)', fontWeight: 500 }}>No vision written yet.</span>}</div>
            {v?.description && <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{v.description}</div>}
            {v?.atRisk === 1 && v.atRiskReason && <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 6 }}>⚠ {v.atRiskReason}</div>}
            {info?.rules && <div style={{ marginTop: 10 }}><div style={label}>Standing rules</div><div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', marginTop: 3, lineHeight: 1.5 }}>{info.rules}</div></div>}
          </div>
          {canWrite && <button style={btn(!v)} onClick={() => setEditing(true)}>{v ? 'Revise' : 'Write the vision'}</button>}
        </div>
      </div>
    );
  }
  return (
    <div style={{ ...card, marginBottom: 10, display: 'grid', gap: 8 }}>
      <label style={label} htmlFor="vision-title">Vision (one line)</label>
      <input id="vision-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} style={{ ...input, fontSize: 14, fontWeight: 600 }} placeholder="Where the company is going, in one sentence" maxLength={200} />
      <label style={label} htmlFor="vision-desc">The paragraph</label>
      <textarea id="vision-desc" value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} style={textarea} placeholder="What it looks like when the vision is reached, and why it matters" />
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(140px, 200px) 1fr' }}>
        <div><label style={label} htmlFor="vision-due">Horizon</label><input id="vision-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} style={input} /></div>
        <div><label style={label} htmlFor="vision-rules">Standing rules</label><textarea id="vision-rules" value={rules} onChange={(e) => setRules(e.target.value)} rows={2} style={textarea} placeholder="What must never happen; what every plan must respect" /></div>
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button style={btn()} onClick={() => setEditing(false)}>Cancel</button>
        <button style={btn(true)} disabled={!title.trim()} onClick={save}>{v ? 'Revise and re-plan' : 'Set the vision'}</button>
      </div>
    </div>
  );
}

function ProfileCard({ info, isCeo, act }: { info: OrgVisionInfo | null; isCeo: boolean | null; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const app = useApp();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState('');
  const [culture, setCulture] = useState('');
  useEffect(() => { setValues(info?.values ?? ''); setCulture(info?.culture ?? ''); }, [info?.values, info?.culture]);
  const save = () => void act(async () => { await api.setOrgProfile(app.workspaceId, { values, culture }); setEditing(false); }, 'Operating profile saved — every prompt carries it');
  return (
    <div style={{ ...card, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={label}>Operating profile</div>
          <div style={{ ...faint, marginTop: 2 }}>Values and culture (§1b): read by every planning session, meeting, audit and heartbeat; the chief tunes thresholds to it.</div>
          {!editing && (
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginTop: 8 }}>
              <div><div style={label}>Values</div><div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', marginTop: 3, lineHeight: 1.5, color: info?.values ? 'var(--text)' : 'var(--text-faint)' }}>{info?.values || 'not written'}</div></div>
              <div><div style={label}>Culture</div><div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', marginTop: 3, lineHeight: 1.5, color: info?.culture ? 'var(--text)' : 'var(--text-faint)' }}>{info?.culture || 'not written'}</div></div>
            </div>
          )}
        </div>
        {isCeo !== false && !editing && <button style={btn()} onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {editing && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <label style={label} htmlFor="profile-values">Values</label>
          <textarea id="profile-values" value={values} onChange={(e) => setValues(e.target.value)} rows={2} style={textarea} placeholder="e.g. Ship small and often. Ask before you widen. Write it down." />
          <label style={label} htmlFor="profile-culture">Culture</label>
          <textarea id="profile-culture" value={culture} onChange={(e) => setCulture(e.target.value)} rows={2} style={textarea} placeholder="e.g. Few meetings, short ones; decisions logged with their alternatives." />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}><button style={btn()} onClick={() => setEditing(false)}>Cancel</button><button style={btn(true)} onClick={save}>Save</button></div>
        </div>
      )}
    </div>
  );
}

function StrategyCard({ strategy }: { strategy: { memo: string; at: string | null } | null }) {
  const [open, setOpen] = useState(false);
  if (!strategy || !strategy.memo) return <div style={{ ...card, marginBottom: 10, ...faint }}>No strategy memo yet — the chief writes one after planning (<code>org_strategy_memo</code>).</div>;
  const long = strategy.memo.length > 600;
  return (
    <div style={{ ...card, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><div style={label}>Strategy memo</div><span style={faint}>by the chief · {ago(strategy.at)}</span></div>
      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.55, marginTop: 6 }}>{open || !long ? strategy.memo : `${strategy.memo.slice(0, 600)}…`}</div>
      {long && <button style={{ ...linkBtn, marginTop: 6 }} onClick={() => setOpen(!open)}>{open ? 'show less' : 'read the whole memo'}</button>}
    </div>
  );
}

// ---- the intent tree ----

function Bar({ value, color, title }: { value: number | null; color: string; title: string }) {
  return (
    <div title={title} role="progressbar" aria-valuenow={value === null ? undefined : Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={title} style={{ height: 6, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden', flex: 1 }}>
      {value !== null && <div style={{ width: `${Math.min(100, Math.round(value * 100))}%`, height: 6, background: color, transition: 'width .3s' }} />}
    </div>
  );
}

/** One goal: an objective (blended progress, children summary) or a key
 *  result (measured vs confidence, pace, risk, owner, due, check-in). */
function IntentRow({ g, depth, org, act, onWhy, sources, isCeo, onSourceChanged }: { g: OrgIntentNode; depth: number; org: OrgDetail; act: (fn: () => Promise<unknown>, done?: string) => Promise<void>; onWhy: (g: OrgGoal) => void; sources: MetricSource[]; isCeo: boolean | null; onSourceChanged: () => Promise<void> }) {
  const names = useAgentNames();
  const [checkIn, setCheckIn] = useState(false);
  const [history, setHistory] = useState<OrgCheckin[] | null>(null);
  const owner = g.ownerAgentId ? names.get(g.ownerAgentId) : undefined;
  const isKr = g.kind === 'key_result';
  const pace = paceBadge(g.pace, g.expected, g.measured);
  const gap = confidenceGap(g.measured, g.confidence);
  const pct = Math.round(g.progress * 100);
  const edge = g.status === 'achieved' ? 'var(--green)' : g.status === 'abandoned' ? 'var(--text-faint)' : g.atRisk ? 'var(--amber)' : pct > 0 ? 'var(--accent)' : 'var(--border)';
  const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '?' : Number.isInteger(v) ? String(v) : v.toFixed(2));
  const due = dueLabel(g.dueAt);
  const overdue = g.status === 'active' && (daysUntil(g.dueAt) ?? 0) < 0;
  return (
    <div style={{ marginLeft: depth * 18, marginBottom: 8 }}>
      <div id={`goal-${g.id}`} style={{ ...card, padding: '10px 12px', borderLeft: `3px solid ${edge}`, opacity: g.status === 'abandoned' ? .6 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ ...pill(), fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.4px' }}>{KIND_LABEL[g.kind] ?? g.kind}</span>
              <span>{g.title}</span>
              <span style={{ ...faint, fontFamily: 'var(--mono)', fontSize: 10.5 }} title="Reference it in a channel">#goal:{g.id.slice(0, 8)}</span>
              {g.status !== 'active' && <span style={pill()}>{g.status}</span>}
              {isKr && <span style={{ ...pill(pace.color, '#fff') }} title={pace.title}>{pace.label}</span>}
              {g.atRisk === 1 && <span style={{ ...pill('var(--amber)', '#fff'), display: 'inline-flex', alignItems: 'center', gap: 4 }} title={g.atRiskReason}><I d={P.warn} size={11} />at risk</span>}
            </div>
            {g.description && <div style={{ ...faint, marginTop: 2 }}>{g.description}</div>}
            {g.atRisk === 1 && g.atRiskReason && <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 4 }}>{g.atRiskReason}</div>}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 'none' }}>
            {owner ? <span style={{ ...pill(), display: 'inline-flex', gap: 4, alignItems: 'center' }} title="Owner"><Avatar a={owner} size={14} />{owner.name}</span> : isKr && <span style={pill('var(--amber)', '#fff')}>no owner</span>}
            {g.dueAt && <span style={{ ...pill(), color: overdue ? 'var(--red)' : undefined }} title={g.dueAt.slice(0, 10)}>{due}</span>}
            <button style={{ ...btn(), padding: '3px 8px', fontSize: 11 }} onClick={() => onWhy(g)} title="Why does this exist? The chain up to the vision">Why</button>
          </div>
        </div>
        {isKr ? (
          <div style={{ marginTop: 8, display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', ...faint, marginBottom: 3 }}>
                <span>Measured · {g.metric || 'metric'} {fmt(g.currentValue ?? g.startValue)} → {fmt(g.targetValue)}{g.unitLabel ? ` ${g.unitLabel}` : ''}</span>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text)' }}>{g.measured === null ? '—' : `${Math.round(g.measured * 100)}%`}</span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Bar value={g.measured} color={g.pace === 'behind' ? 'var(--amber)' : 'var(--accent)'} title={`Measured progress ${g.measured === null ? 'unknown' : `${Math.round(g.measured * 100)}%`}; ${Math.round((g.expected ?? 0) * 100)}% expected by now`} />
                {g.expected !== null && <span style={{ ...faint, fontSize: 10.5, whiteSpace: 'nowrap' }} title="Linear expectation between creation and due date">exp. {Math.round(g.expected * 100)}%</span>}
              </div>
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', ...faint, marginBottom: 3 }}>
                <span>Owner's confidence</span>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text)' }}>{g.confidence === null ? '—' : `${Math.round(g.confidence * 100)}%`}</span>
              </div>
              <Bar value={g.confidence} color={gap.gap !== null && Math.abs(gap.gap) >= 0.15 ? 'var(--blue)' : 'var(--green)'} title={`Confidence ${g.confidence === null ? 'never given' : `${Math.round(g.confidence * 100)}%`} — ${gap.note}`} />
              <div style={{ ...faint, fontSize: 10.5, marginTop: 3 }}>{gap.note}</div>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', ...faint, marginBottom: 3 }}><span>{summarizeChildren(g.children) || `${g.tasks.done}/${g.tasks.total} task(s) done`}</span><span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text)' }}>{pct}%</span></div>
            <Bar value={g.progress} color={edge === 'var(--border)' ? 'var(--accent)' : edge} title={`Blended progress ${pct}%: measured key results averaged with linked tasks`} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 7, flexWrap: 'wrap', ...faint }}>
          {isKr && <KrSourceLine g={g} wsId={org.workspaceId} sources={sources} isCeo={isCeo} onChanged={onSourceChanged} />}
          {isKr && <span title={g.lastCheckInAt ?? 'never'} style={{ color: checkInDue(g) && g.status === 'active' ? 'var(--amber)' : undefined }}>last check-in {g.lastCheckInAt ? ago(g.lastCheckInAt) : 'never'} · every {g.checkInCadenceDays}d{checkInDue(g) && g.status === 'active' ? ' · due' : ''}</span>}
          {!isKr && g.tasks.total > 0 && <span>{g.tasks.done}/{g.tasks.total} task(s) done</span>}
          {isKr && g.status === 'active' && <button style={linkBtn} onClick={() => setCheckIn(!checkIn)}>{checkIn ? 'close check-in' : 'check in'}</button>}
          {isKr && <button style={linkBtn} onClick={() => { if (history === null) void api.orgCheckIns(org.workspaceId, g.id).then(setHistory).catch(() => setHistory([])); else setHistory(null); }}>{history === null ? 'history' : 'hide history'}</button>}
        </div>
        {checkIn && <CheckInForm g={g} org={org} onDone={() => { setCheckIn(false); setHistory(null); }} act={act} />}
        {history && (
          <div style={{ marginTop: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 6 }}>
            {history.length === 0 && <div style={faint}>No check-ins yet.</div>}
            {history.slice().reverse().slice(0, 8).map((c) => (
              <div key={c.id} style={{ fontSize: 12, display: 'flex', gap: 8, padding: '3px 0', flexWrap: 'wrap' }}>
                <span style={faint}>{ago(c.createdAt)}</span>
                <span style={{ fontFamily: 'var(--mono)' }}>{fmt(c.currentValue)}{g.unitLabel ? ` ${g.unitLabel}` : ''}</span>
                <span style={{ fontFamily: 'var(--mono)' }}>{c.confidence === null ? '—' : `${Math.round(c.confidence * 100)}%`} confident</span>
                <span style={{ flex: 1, minWidth: 120 }}>{c.note}</span>
                <span style={faint}>{c.actor}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {g.children.map((c) => <IntentRow key={c.id} g={c} depth={depth + 1} org={org} act={act} onWhy={onWhy} sources={sources} isCeo={isCeo} onSourceChanged={onSourceChanged} />)}
    </div>
  );
}

function CheckInForm({ g, org, onDone, act }: { g: OrgIntentNode; org: OrgDetail; onDone: () => void; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [value, setValue] = useState(g.currentValue === null ? '' : String(g.currentValue));
  const [conf, setConf] = useState(g.confidence === null ? 70 : Math.round(g.confidence * 100));
  const [note, setNote] = useState('');
  // A measured key result takes its value only from its source: the check-in records confidence and a note.
  const measured = g.measuredBy ?? null;
  const save = () => void act(async () => {
    await api.orgCheckIn(org.workspaceId, g.id, measured ? { confidence: conf / 100, note } : { currentValue: value.trim() === '' ? null : Number(value), confidence: conf / 100, note });
    onDone();
  }, 'Check-in recorded');
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 8, display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', alignItems: 'end' }}>
      {measured
        ? <div style={{ fontSize: 12 }}><div style={label}>Current {g.metric || 'value'}</div><span style={{ fontFamily: 'var(--mono)' }}>{g.currentValue ?? '—'}{g.unitLabel ? ` ${g.unitLabel}` : ''}</span> <span style={faint}>from {measured.name} — your confidence is recorded next to it</span></div>
        : <div><label style={label} htmlFor={`ci-value-${g.id}`}>Current {g.metric || 'value'}{g.unitLabel ? ` (${g.unitLabel})` : ''}</label><input id={`ci-value-${g.id}`} value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.-]/g, ''))} inputMode="decimal" style={{ ...input, fontFamily: 'var(--mono)' }} placeholder={`target ${g.targetValue ?? '?'}`} /></div>}
      <div><label style={label} htmlFor={`ci-conf-${g.id}`}>Confidence · {conf}%</label><input id={`ci-conf-${g.id}`} type="range" min={0} max={100} step={5} value={conf} onChange={(e) => setConf(Number(e.target.value))} style={{ width: '100%' }} /></div>
      <div><label style={label} htmlFor={`ci-note-${g.id}`}>Note</label><input id={`ci-note-${g.id}`} value={note} onChange={(e) => setNote(e.target.value)} style={input} placeholder="What moved, what is in the way" onKeyDown={(e) => { if (e.key === 'Enter') save(); }} /></div>
      <button style={btn(true)} onClick={save}>Record</button>
    </div>
  );
}

// ---- the why chain ----

/** task → key result → objective → vision; a broken link (abandoned goal or
 *  cancelled task) is named and the work below it has lost its why. */
export function WhyDrawer({ wsId, goalId, taskId, title, onClose }: { wsId: string; goalId?: string; taskId?: string; title: string; onClose: () => void }) {
  const app = useApp();
  const [why, setWhy] = useState<WhyChain | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void api.orgWhy(wsId, taskId ? { taskId } : { goalId }).then((w) => { setWhy(w); setErr(null); }).catch((e) => setErr(e instanceof Error ? e.message : 'failed')); }, [wsId, goalId, taskId]);
  const openLink = (l: WhyChain['chain'][number]) => {
    if (l.kind === 'task') app.openOrgTask(l.id); else { app.setOrgFocus({ kind: 'goal', id: l.id }); app.setOrgUnitId(null); app.setOrgPane('vision'); }
    onClose();
  };
  // Shown top-down: vision first, the asked-about item last.
  const chain = why ? [...why.chain].reverse() : [];
  return (
    <Drawer onClose={onClose} width={480}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ ...h2, flex: 1 }}>Why · {title}</h2>
        <button style={btn()} onClick={onClose} aria-label="Close"><I d={P.x} size={14} /></button>
      </div>
      <div style={faint}>Every task should trace to a key result, an objective and the vision. A link that was abandoned or cancelled breaks the chain: the work below it has lost its why and should be re-homed.</div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{err}</div>}
      {why && !why.linked && <div style={{ ...card, borderLeft: '3px solid var(--amber)', fontSize: 12.5 }}>Not linked to any goal: this task's project has no goal. Ask the chief where it belongs.</div>}
      {why && why.broken && <div style={{ ...card, borderLeft: '3px solid var(--red)', fontSize: 12.5 }}>Broken chain — a link below was abandoned or cancelled.</div>}
      {why && why.linked && !why.broken && chain.length > 1 && <div style={{ ...card, borderLeft: '3px solid var(--green)', fontSize: 12.5 }}>Intact: {chain.length} links up to the {chain[0].kind.replace('_', ' ')}.</div>}
      <div>
        {chain.map((l, i) => {
          const broken = why?.brokenAt === l.id;
          const last = i === chain.length - 1;
          return (
            <div key={l.id} style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 14, flex: 'none' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: broken ? 'var(--red)' : last ? 'var(--accent)' : 'var(--green)', marginTop: 12, flex: 'none' }} />
                {i < chain.length - 1 && <span style={{ flex: 1, width: 2, background: broken ? 'var(--red)' : 'var(--border)' }} />}
              </div>
              <div style={{ ...card, flex: 1, padding: '8px 11px', marginBottom: 6, borderColor: broken ? 'var(--red)' : undefined }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ ...pill(), fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.4px' }}>{KIND_LABEL[l.kind] ?? l.kind}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{l.title}</span>
                  <span style={{ ...pill(broken ? 'var(--red)' : 'var(--panel-2)', broken ? '#fff' : 'var(--text-dim)') }}>{l.status.replace('_', ' ')}</span>
                </div>
                {broken && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>This is the broken link.</div>}
                <button style={{ ...linkBtn, marginTop: 4 }} onClick={() => openLink(l)}>open</button>
              </div>
            </div>
          );
        })}
        {why && chain.length === 0 && <div style={faint}>Nothing to show.</div>}
        {!why && !err && <div style={faint}>Loading…</div>}
      </div>
    </Drawer>
  );
}
