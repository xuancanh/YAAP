/** The Vision page (docs/company-vision.md §2, §8; execution plan item 18),
 *  read as a document: the statement with its horizon, what it looks like
 *  when reached, the mission, the operating profile (values, culture), the
 *  standing rules and the chief's latest strategy memo. The CEO revises the
 *  vision (the chief re-plans) and the profile, and asks for a planning
 *  session now with what it will do spelled out first. The objectives and
 *  key results live on the Goals page; this page links to them. The "Why"
 *  drawer walks task → key result → objective → vision. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgDetail, type OrgVisionInfo, type WhyChain } from '../lib/api';
import { I, P } from '../lib/icons';
import { Markdown } from '../lib/md';
import { KIND_LABEL } from '../lib/org';
import { HEALTH_LABEL, HEALTH_TONE, horizonOf, objectiveHealth, objectivesOfTree, plural } from '../lib/direction';
import { card, btn, pill, h2, faint, linkBtn, ago, Drawer } from './org-ui';
import { Bar, Empty, PageHeader, Pill, Skeleton } from './CompanyKit';

/** Is the person on screen the CEO? The server refuses writes otherwise; the
 *  page says so instead of failing. */
export function useIsCeo(wsId: string): boolean | null {
  const [role, setRole] = useState<boolean | null>(null);
  useEffect(() => { void api.orgHumans(wsId).then((h) => setRole(h.me.role === 'ceo')).catch(() => setRole(null)); }, [wsId]);
  return role;
}

const PLAN_STEPS = [
  'The chief of staff reads the vision, the values and culture, the standing rules and where every objective stands.',
  'It proposes objectives and measurable key results, and the projects that move them.',
  'It writes a strategy memo explaining the plan; the memo appears on this page.',
];

export function VisionPane({ org, reload }: { org: OrgDetail; reload: () => Promise<void> }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const isCeo = useIsCeo(wsId);
  const mode = app.wsOrg?.mode ?? 'supervised';
  const [info, setInfo] = useState<OrgVisionInfo | null | undefined>(undefined);
  const [strategy, setStrategy] = useState<{ memo: string; at: string | null } | null | undefined>(undefined);
  const [editing, setEditing] = useState<'vision' | 'profile' | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planResult, setPlanResult] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [v, s] = await Promise.all([api.orgVision(wsId).catch(() => null), api.orgStrategy(wsId).catch(() => null)]);
    setInfo(v); setStrategy(s);
  }, [wsId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 60_000); return () => clearInterval(t); }, [refresh]);
  const act = useCallback(async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); await refresh(); void reload(); if (done) app.showToast(done); return true; } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); return false; }
  }, [refresh, reload, app]);
  const planNow = async () => {
    setPlanning(true); setPlanResult(null);
    try {
      const r = await api.orgPlanNow(wsId, { reason: 'planning requested by the CEO from the vision page' });
      const ran = r.result === 'done' || r.result === 'ran';
      setPlanResult(ran ? (mode === 'autonomous' ? 'Planning ran. The objectives on the Goals page are refreshed.' : 'Planning ran. Its plan waits for you in the Inbox; the memo below is refreshed.') : `Planning did not run: ${r.result}.`);
      await refresh(); void reload();
    } catch (e) { setPlanResult(e instanceof Error ? e.message.slice(0, 200) : 'Planning failed.'); } finally { setPlanning(false); }
  };
  const objectives = useMemo(() => objectivesOfTree(app.orgIntent ?? []).filter((o) => o.kind === 'objective' && o.status !== 'abandoned'), [app.orgIntent]);
  const v = info?.vision ?? null;
  const canWrite = isCeo !== false;
  const horizon = horizonOf(v);
  const openGoals = (id?: string) => { app.setOrgFocus(id ? { kind: 'goal', id } : null); app.setOrgUnitId(null); app.setOrgPane('goals'); };

  return (
    <div className="co-page narrow" data-testid="vision-page">
      <PageHeader title="Vision" purpose={<>Where the company is going and how it works. The chief of staff plans every objective from this page.{isCeo === false ? ' Only the CEO writes here.' : ''}</>}
        actions={<>
          <button className="co-btn" aria-expanded={planOpen} onClick={() => setPlanOpen(!planOpen)} disabled={!v}>Plan now</button>
          {canWrite && v && editing !== 'vision' && <button className="co-btn primary" onClick={() => setEditing('vision')}>Revise vision</button>}
        </>} />

      {planOpen && (
        <div className="co-card" style={{ padding: '14px 16px', marginBottom: 16 }} data-testid="plan-now">
          <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 6 }}>Run a planning session now</div>
          <ol style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: 'var(--text-dim)' }}>{PLAN_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--text-dim)' }}>{mode === 'autonomous' ? 'In autonomous mode the plan applies within the caps; you can veto it from the Inbox.' : 'In supervised mode the plan arrives in your Inbox as a card: nothing changes until you approve it.'} It ignores the planning cooldown and spends from the chief’s budget.</p>
          {planResult && <div className="co-note" role="status" style={{ marginBottom: 10 }}>{planResult}</div>}
          <div className="co-form-foot" style={{ justifyContent: 'flex-start' }}>
            <button className="co-btn primary" disabled={planning} onClick={() => void planNow()}>{planning ? 'Planning…' : 'Run planning'}</button>
            <button className="co-btn ghost" onClick={() => { setPlanOpen(false); setPlanResult(null); }}>Close</button>
          </div>
        </div>
      )}

      {info === undefined ? (
        <div style={{ display: 'grid', gap: 12 }} role="status" aria-label="Loading"><Skeleton w="75%" h={30} /><Skeleton w="40%" h={12} /><Skeleton h={12} /><Skeleton w="90%" h={12} /></div>
      ) : editing === 'vision' || (!v && canWrite && editing !== 'profile') ? (
        <VisionForm info={info} first={!v} onCancel={v ? () => setEditing(null) : undefined} onSave={(body) => act(async () => { await api.setOrgVision(wsId, body); setEditing(null); }, v ? 'Vision revised. The chief re-plans.' : 'Vision set. The chief plans the objectives.')} />
      ) : !v ? (
        <Empty title="No vision yet">Only the CEO writes the vision. Once it exists, the chief plans objectives from it.</Empty>
      ) : (
        <article data-testid="vision-doc">
          <p style={{ margin: 0, fontSize: 'clamp(24px, 3vw, 32px)', lineHeight: 1.18, fontWeight: 650, letterSpacing: '-.024em', textWrap: 'balance', maxWidth: '26ch' } as React.CSSProperties} data-testid="vision-statement">{v.title}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '12px 0 4px', flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-dim)' }}>
            {horizon ? <><Bar value={horizon.elapsed} label="Time elapsed toward the horizon" width={140} tone={v.atRisk ? 'warn' : undefined} /><span>{horizon.label}</span></> : <span>No horizon set. {canWrite && <button className="co-link" onClick={() => setEditing('vision')}>Add one</button>}</span>}
            <span className="co-faint">Revised {ago(v.createdAt)}</span>
          </div>
          {v.atRisk === 1 && <div className="co-note warn" style={{ marginTop: 10 }}>The vision is at risk: {v.atRiskReason || 'the objectives under it are behind.'}</div>}
          {v.description && <Section title="What it looks like when we get there"><div className="co-prose" style={{ whiteSpace: 'pre-wrap' }}>{v.description}</div></Section>}
          {org.mission && org.mission.trim() !== (v.description ?? '').trim() && <Section title="Mission"><div className="co-prose" style={{ whiteSpace: 'pre-wrap' }}>{org.mission}</div></Section>}
          {editing === 'profile' ? (
            <Section title="How we work"><ProfileForm info={info} onCancel={() => setEditing(null)} onSave={(body) => act(async () => { await api.setOrgProfile(wsId, body); setEditing(null); }, 'Saved. Every planning session, meeting and audit reads it.')} /></Section>
          ) : (
            <Section title="How we work" action={canWrite && (info?.values || info?.culture) ? <button className="co-btn small" onClick={() => setEditing('profile')}>Edit</button> : undefined}>
              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
                <ProfileBlock name="Values" text={info?.values ?? ''} example="Ship small and often. Ask before you widen scope. Write it down." canWrite={canWrite} onWrite={() => setEditing('profile')} />
                <ProfileBlock name="Culture" text={info?.culture ?? ''} example="Few meetings, short ones. Decisions logged with their alternatives." canWrite={canWrite} onWrite={() => setEditing('profile')} />
              </div>
            </Section>
          )}
          {info?.rules && <Section title="Standing rules"><div className="co-prose" style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{info.rules}</div></Section>}
          <Section title="Strategy memo" action={strategy?.at ? <span className="co-faint">By the chief of staff, {ago(strategy.at)}</span> : undefined}>
            {strategy === undefined ? <Skeleton h={12} /> : <StrategyMemo memo={strategy?.memo ?? ''} onPlan={() => setPlanOpen(true)} />}
          </Section>
          <Section title="Objectives" action={<button className="co-link" onClick={() => openGoals()}>Open goals</button>}>
            {objectives.length === 0 ? <Empty compact title="No objectives yet">Planning runs when the vision is written or revised. Plan now runs it at once.</Empty> : (
              <div className="co-rows" style={{ margin: '0 -10px' }}>
                {objectives.map((o) => {
                  const h = objectiveHealth(o);
                  return (
                    <button key={o.id} className="co-row" onClick={() => openGoals(o.id)}>
                      <span className="co-row-main"><span className="co-row-title wrap">{o.title}</span><span className="co-row-meta">{plural(o.children.filter((c) => c.kind === 'key_result').length, 'key result')} · {Math.round(o.progress * 100)}%</span></span>
                      <Pill tone={HEALTH_TONE[h]}>{HEALTH_LABEL[h]}</Pill>
                    </button>
                  );
                })}
              </div>
            )}
          </Section>
        </article>
      )}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 26 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid var(--border-soft)' }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 650 }}>{title}</h3><span style={{ flex: 1 }} />{action}
      </div>
      {children}
    </section>
  );
}

function ProfileBlock({ name, text, example, canWrite, onWrite }: { name: string; text: string; example: string; canWrite: boolean; onWrite: () => void }) {
  if (text) return <div><div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 4 }}>{name}</div><div className="co-prose" style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{text}</div></div>;
  return (
    <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: '12px 14px' }} data-testid={`profile-empty-${name.toLowerCase()}`}>
      <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 4 }}>Write the company’s {name.toLowerCase()}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 10 }}>Every planning session, meeting, audit and heartbeat reads them, and the chief tunes its thresholds to them. For example: “{example}”</div>
      {canWrite && <button className="co-btn small" onClick={onWrite}>Write {name.toLowerCase()}</button>}
    </div>
  );
}

function StrategyMemo({ memo, onPlan }: { memo: string; onPlan: () => void }) {
  const [open, setOpen] = useState(false);
  if (!memo) return <Empty compact title="No strategy memo yet" action={<button className="co-btn small" onClick={onPlan}>Plan now</button>}>The chief writes one after each planning session: the bets, why these, and what it will not do.</Empty>;
  const long = memo.length > 1400;
  return (
    <div data-testid="strategy-memo">
      <div className="co-prose" style={long && !open ? { maxHeight: 320, overflow: 'hidden', maskImage: 'linear-gradient(#000 70%, transparent)', WebkitMaskImage: 'linear-gradient(#000 70%, transparent)' } : undefined}><Markdown text={memo} /></div>
      {long && <button className="co-link" style={{ marginTop: 6 }} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Read the whole memo'}</button>}
    </div>
  );
}

function VisionForm({ info, first, onSave, onCancel }: { info: OrgVisionInfo | null; first: boolean; onSave: (b: { title: string; description: string; dueAt: string | null; rules: string }) => Promise<boolean>; onCancel?: () => void }) {
  const v = info?.vision ?? null;
  const [title, setTitle] = useState(v?.title ?? '');
  const [desc, setDesc] = useState(v?.description ?? '');
  const [due, setDue] = useState(v?.dueAt ? v.dueAt.slice(0, 10) : '');
  const [rules, setRules] = useState(info?.rules ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); await onSave({ title: title.trim(), description: desc, dueAt: due ? new Date(`${due}T23:59:59`).toISOString() : null, rules }); setBusy(false); };
  return (
    <form className="co-card co-form" style={{ padding: 16 }} data-testid="vision-form" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void save(); }}>
      <div style={{ fontSize: 14, fontWeight: 650 }}>{first ? 'Write the vision' : 'Revise the vision'}</div>
      <label className="co-field"><span>The statement</span><input className="co-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Where the company is going, in one sentence" style={{ fontSize: 15, fontWeight: 600 }} /><small>{title.length}/200 · one sentence a new hire could repeat</small></label>
      <label className="co-field"><span>What it looks like when we get there</span><textarea className="co-input" rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Who it serves, what is true then that is not now, and why it matters" /></label>
      <div className="co-form-row">
        <label className="co-field"><span>Horizon</span><input className="co-input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /><small>When the vision should be true</small></label>
        <label className="co-field" style={{ gridColumn: 'span 2' }}><span>Standing rules</span><textarea className="co-input" rows={2} value={rules} onChange={(e) => setRules(e.target.value)} placeholder="What must never happen; what every plan must respect" /></label>
      </div>
      <div className="co-form-foot">
        <span className="co-faint" style={{ marginRight: 'auto' }}>{first ? 'Saving sets the vision; the chief plans objectives from it.' : 'Saving revises the vision; the chief re-plans shortly after.'}</span>
        {onCancel && <button type="button" className="co-btn ghost" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="co-btn primary" disabled={!title.trim() || busy}>{first ? 'Set the vision' : 'Save and re-plan'}</button>
      </div>
    </form>
  );
}

function ProfileForm({ info, onSave, onCancel }: { info: OrgVisionInfo | null; onSave: (b: { values: string; culture: string }) => Promise<boolean>; onCancel: () => void }) {
  const [values, setValues] = useState(info?.values ?? '');
  const [culture, setCulture] = useState(info?.culture ?? '');
  return (
    <form className="co-form" data-testid="profile-form" onSubmit={(e) => { e.preventDefault(); void onSave({ values, culture }); }}>
      <label className="co-field"><span>Values</span><textarea className="co-input" autoFocus rows={3} value={values} onChange={(e) => setValues(e.target.value)} placeholder="Ship small and often. Ask before you widen scope. Write it down." /></label>
      <label className="co-field"><span>Culture</span><textarea className="co-input" rows={3} value={culture} onChange={(e) => setCulture(e.target.value)} placeholder="Few meetings, short ones. Decisions logged with their alternatives." /></label>
      <div className="co-form-foot"><button type="button" className="co-btn ghost" onClick={onCancel}>Cancel</button><button type="submit" className="co-btn primary">Save</button></div>
    </form>
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
    if (l.kind === 'task') app.openOrgTask(l.id); else { app.setOrgFocus({ kind: 'goal', id: l.id }); app.setOrgUnitId(null); app.setOrgPane(l.kind === 'vision' ? 'vision' : 'goals'); }
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
