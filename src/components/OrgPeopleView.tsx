/** Roles and hybrid staff (docs/company-vision.md §4, §9; execution plan
 *  item 24): the Hire dialog of the org chart — the role catalog ranked
 *  against the operating profile as chips with a charter preview, scopes,
 *  tier and estimated USD, beside the profession packs — proposing a `hire`
 *  card (or, in autonomous mode, the chief's own hire); and the My tasks
 *  pane for human employees: their task cards with status, comments and
 *  "request review" to a human or an agent reviewer. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgRole, type OrgDetail, type OrgHuman, type OrgMember, type OrgTask, type OrgTaskBrief, type OrgTaskStatus } from '../lib/api';
import { safeJsonParse } from '../lib/util';
import { card, input, btn, pill, h2, faint, label, linkBtn, ago, useAgentNames, useFollowRef, Avatar, Drawer } from './org-ui';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const STATUS_COLOR: Record<OrgTaskStatus, string> = {
  backlog: 'var(--text-faint)', waiting: 'var(--text-dim)', todo: 'var(--blue)', claimed: 'var(--amber)', in_progress: 'var(--amber)', in_review: 'var(--accent)', blocked: 'var(--red)', done: 'var(--green)', cancelled: 'var(--text-faint)',
};

// ---- the hire dialog ----

export function HireDialog({ org, members, onClose, onDone }: { org: OrgDetail; members: OrgMember[]; onClose: () => void; onDone: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const wsId = org.workspaceId;
  const [tab, setTab] = useState<'roles' | 'packs'>('roles');
  const [roles, setRoles] = useState<OrgRole[] | null>(null);
  const [pick, setPick] = useState<string>('');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [reportsTo, setReportsTo] = useState(org.chiefOfStaffAgentId ?? '');
  const [scopes, setScopes] = useState('');
  const [usd, setUsd] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.orgRoles(wsId).then((r) => setRoles(r ?? [])); }, [wsId]);
  const packs = useMemo(() => app.market.filter((m) => m.id.startsWith('pack-')), [app.market]);
  const role = roles?.find((r) => r.id === pick.replace(/^role:/, '')) ?? null;
  const pack = packs.find((p) => p.id === pick) ?? null;
  const choose = (id: string) => {
    setPick(id);
    const r = roles?.find((x) => `role:${x.id}` === id);
    if (r) { setTitle(r.title); setScopes(r.toolScopes.join(', ')); setUsd(String(r.estMonthlyUsd)); if (!name) setName(r.title); }
    const p = packs.find((x) => x.id === id);
    if (p) { setTitle(p.role); setScopes(''); setUsd(''); if (!name) setName(p.name); }
  };
  const propose = async () => {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { templateOrPack: pick, name: name.trim() || undefined, title: title.trim() || undefined, reportsToAgentId: reportsTo || undefined, scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean) };
      if (usd.trim()) payload.monthlyBudgetUsd = Number(usd) || 0;
      await api.proposeOrgApproval(wsId, { kind: 'hire', payload, recommendation: note.trim() || undefined });
      app.showToast(app.wsOrg?.mode === 'autonomous' ? 'Hire proposed' : 'Hire card created — decide it under Approvals');
      await onDone(); onClose();
    } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 200) : 'the hire could not be proposed'); } finally { setBusy(false); }
  };
  return (
    <Drawer onClose={onClose} width={640}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ ...h2, flex: 1 }}>Hire</h2>
        <div role="tablist" aria-label="Catalog" style={{ display: 'flex', gap: 4 }}>
          <button role="tab" aria-selected={tab === 'roles'} style={btn(tab === 'roles')} onClick={() => setTab('roles')}>Roles{roles ? ` · ${roles.length}` : ''}</button>
          <button role="tab" aria-selected={tab === 'packs'} style={btn(tab === 'packs')} onClick={() => setTab('packs')}>Packs · {packs.length}</button>
        </div>
        <button style={btn()} onClick={onClose} aria-label="Close">×</button>
      </div>
      <div style={faint}>{tab === 'roles' ? <>The role catalog (§4), ranked against the company's operating profile and vision. A role is a charter, competencies, tool scopes capped by what the chief holds, and a model tier that resolves through the routing table.</> : 'Profession packs: a charter and bundled skills. Scopes are what you grant below.'}</div>
      {tab === 'roles' && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }} role="listbox" aria-label="Roles">
          {roles === null && <span style={faint}>Loading the catalog…</span>}
          {roles?.map((r) => {
            const active = pick === `role:${r.id}`;
            return (
              <button key={r.id} role="option" aria-selected={active} onClick={() => choose(`role:${r.id}`)} title={r.matched?.length ? `fits: ${r.matched.join(', ')}` : r.fits.join(', ')}
                style={{ ...pill(active ? 'var(--accent)' : 'var(--panel-2)', active ? '#fff' : 'var(--text)'), cursor: 'pointer', padding: '4px 10px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                {r.title}<span style={{ opacity: .7, ...mono, fontSize: 10 }}>{r.modelTier} · ${r.estMonthlyUsd}</span>{(r.score ?? 0) > 0 && <span style={{ opacity: .7 }}>★ {r.score}</span>}
              </button>
            );
          })}
        </div>
      )}
      {tab === 'packs' && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }} role="listbox" aria-label="Packs">
          {packs.length === 0 && <span style={faint}>No pack in the market catalog.</span>}
          {packs.map((p) => <button key={p.id} role="option" aria-selected={pick === p.id} onClick={() => choose(p.id)} style={{ ...pill(pick === p.id ? 'var(--accent)' : 'var(--panel-2)', pick === p.id ? '#fff' : 'var(--text)'), cursor: 'pointer', padding: '4px 10px' }}>{p.emoji} {p.name} <span style={{ opacity: .7 }}>· {p.role}</span></button>)}
        </div>
      )}
      {role && (
        <div style={{ ...card, display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{role.title}</b><span style={pill()}>{role.modelTier} tier</span><span style={pill()}>est. ${role.estMonthlyUsd}/month</span>
          </div>
          <div style={faint}>Competencies: {role.competencies.join(', ') || '—'}</div>
          <div>Scopes: {role.toolScopes.length ? role.toolScopes.map((s) => <span key={s} style={{ ...pill(), ...mono, marginRight: 4 }}>{s}</span>) : <i>none</i>}</div>
          <details><summary style={{ cursor: 'pointer', ...faint }}>Charter preview ({role.charter.length} chars)</summary><pre style={{ ...mono, fontSize: 11.5, whiteSpace: 'pre-wrap', background: 'var(--panel-2)', padding: 8, borderRadius: 8, maxHeight: 220, overflow: 'auto' }}>{role.charter}</pre></details>
        </div>
      )}
      {pack && <div style={{ ...card, ...faint }}>{pack.tagline}{pack.skills?.length ? ` · ${pack.skills.length} bundled skill(s)` : ''}</div>}
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={input} />
        <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" style={input} />
        <select aria-label="Reports to" value={reportsTo} onChange={(e) => setReportsTo(e.target.value)} style={input}>{members.map((m) => <option key={m.id} value={m.agentId}>reports to {names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)}</option>)}</select>
        <input aria-label="Monthly USD" value={usd} onChange={(e) => setUsd(e.target.value.replace(/[^\d.]/g, ''))} placeholder="envelope $ / month (optional)" style={{ ...input, ...mono }} />
      </div>
      <input aria-label="Scopes" value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="scopes, comma-separated — never more than the chief holds" style={{ ...input, ...mono }} />
      <input aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this hire (shows on the card)" style={input} />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
        <span style={{ ...faint, flex: 1 }}>{app.wsOrg?.mode === 'autonomous' ? 'The hire is made within the caps and audited.' : 'A hire card for you (or the board) to decide. Nothing is inherited: no memory, no connections, no loops.'}</span>
        <button style={btn()} onClick={onClose}>Cancel</button>
        <button style={btn(true)} disabled={!pick || busy} onClick={() => void propose()}>{busy ? 'Proposing…' : 'Propose hire'}</button>
      </div>
      {!pick && <div style={faint}>Pick a role or a pack first.</div>}
    </Drawer>
  );
}

// ---- my tasks (human employees) ----

function parseBrief(raw: string): OrgTaskBrief {
  const b = safeJsonParse<Partial<OrgTaskBrief>>(raw, {});
  return { outcome: b.outcome ?? '', context: b.context ?? '', constraints: b.constraints ?? '', done_when: b.done_when ?? '' };
}

export function MyTasksPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const names = useAgentNames();
  const follow = useFollowRef();
  const [data, setData] = useState<{ assigned: OrgTask[]; reviewing: OrgTask[] } | null>(null);
  const [me, setMe] = useState<OrgHuman | null | undefined>(undefined);
  const [humans, setHumans] = useState<OrgHuman[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [reviewer, setReviewer] = useState('');
  const refresh = useCallback(async () => {
    const [t, h] = await Promise.all([api.orgMyTasks(wsId).then((v) => { setErr(null); return v; }).catch((e) => { setErr(e instanceof Error ? e.message.slice(0, 160) : 'unavailable'); return null; }), api.orgHumans(wsId).catch(() => null)]);
    setData(t);
    if (h) { setHumans(h.humans); setMe(h.humans.find((x) => x.memberAccountId === h.me.actorId) ?? null); }
  }, [wsId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(t); }, [refresh]);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); await refresh(); if (done) app.showToast(done); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); }
  };
  const employees = humans.filter((h) => h.role === 'employee' && h.memberAccountId !== me?.memberAccountId);
  const manager = me?.reportsToAgentId ? names.get(me.reportsToAgentId) : undefined;
  const card_ = (t: OrgTask, reviewing: boolean) => {
    const brief = parseBrief(t.brief);
    const expanded = open === t.id;
    return (
      <div key={t.id} style={{ ...card, marginBottom: 8, borderLeft: `3px solid ${STATUS_COLOR[t.status]}` }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={pill(STATUS_COLOR[t.status], '#fff')}>{t.status.replace('_', ' ')}</span>
          <button onClick={() => setOpen(expanded ? null : t.id)} style={{ ...linkBtn, fontSize: 13.5, fontWeight: 600, color: 'var(--text)', textAlign: 'left', flex: 1, minWidth: 160 }} aria-expanded={expanded}>{t.title}</button>
          {t.class && <span style={pill()}>{t.class}</span>}
          {reviewing && t.assigneeAgentId && <span style={{ ...pill(), display: 'inline-flex', gap: 4, alignItems: 'center' }}><Avatar a={names.get(t.assigneeAgentId)} size={14} />{names.get(t.assigneeAgentId)?.name}</span>}
          <span style={faint}>{ago(t.updatedAt)}</span>
          <button style={btn()} onClick={() => follow('task', t.id)} title="Open on the board">Board</button>
        </div>
        {brief.outcome && <div style={{ fontSize: 12.5, marginTop: 4 }}>{brief.outcome}</div>}
        {expanded && (
          <div style={{ marginTop: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 8, display: 'grid', gap: 8 }}>
            {(['context', 'constraints', 'done_when'] as const).map((k) => brief[k] && <div key={k}><div style={label}>{k.replace('_', ' ')}</div><div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{brief[k]}</div></div>)}
            {!reviewing && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <select aria-label="Status" value={t.status} onChange={(e) => void act(() => api.updateOrgTask(wsId, t.id, { status: e.target.value as OrgTaskStatus }), 'Status updated')} style={{ ...input, width: 'auto' }}>
                  {(['todo', 'in_progress', 'blocked', 'done'] as OrgTaskStatus[]).map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                  {!['todo', 'in_progress', 'blocked', 'done'].includes(t.status) && <option value={t.status}>{t.status.replace('_', ' ')}</option>}
                </select>
                <select aria-label="Reviewer" value={reviewer} onChange={(e) => setReviewer(e.target.value)} style={{ ...input, width: 'auto' }}>
                  <option value="">reviewer: the agent reviewer</option>
                  {employees.map((h) => <option key={h.id} value={h.memberAccountId}>reviewer: {app.nameOf(h.memberAccountId)}{h.title ? ` (${h.title})` : ''}</option>)}
                </select>
                <button style={btn(true)} disabled={t.status === 'in_review'} onClick={() => void act(() => api.requestOrgTaskReview(wsId, t.id, { text: text.trim() || undefined, reviewerHumanId: reviewer || undefined }), 'Review requested')}>Request review</button>
              </div>
            )}
            {reviewing && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={faint}>Your review card is under Approvals (approve accepts the task; reject requests changes with your note).</span>
                <button style={btn(true)} onClick={() => { app.setOrgPane('approvals'); app.setMobileDetail(true); }}>Open the card</button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <input aria-label="Comment" value={text} onChange={(e) => setText(e.target.value)} placeholder={reviewing ? 'Comment to the owner' : 'Comment — also the note of a review request'} style={input} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) void act(async () => { await api.commentOrgTask(wsId, t.id, text.trim()); setText(''); }); }} />
              <button style={btn()} disabled={!text.trim()} onClick={() => void act(async () => { await api.commentOrgTask(wsId, t.id, text.trim()); setText(''); })}>Post</button>
            </div>
          </div>
        )}
      </div>
    );
  };
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ marginBottom: 10 }}>
        <h2 style={h2}>My tasks</h2>
        <div style={faint}>
          {me === undefined ? 'Loading…' : me?.role === 'employee' ? <>You are <b>{me.title || 'an employee'}</b>{manager ? <> reporting to <b>{manager.name}</b></> : ''} of this company: tasks assigned to you by an agent or the CEO, and reviews requested of you. Updating a status or commenting wakes nobody; a review request wakes the reviewer.</> : 'Tasks assigned to you as a human member of the company. You are not an employee here; the CEO seats employees under Org chart → People.'}
        </div>
      </div>
      {err && <div style={{ ...card, color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
      {data && (
        <>
          <div style={{ ...label, marginBottom: 6 }}>Assigned to me · {data.assigned.length}</div>
          {data.assigned.length === 0 && <div style={{ ...card, ...faint, marginBottom: 10 }}>Nothing assigned to you.</div>}
          {data.assigned.map((t) => card_(t, false))}
          <div style={{ ...label, margin: '12px 0 6px' }}>Waiting for my review · {data.reviewing.length}</div>
          {data.reviewing.length === 0 && <div style={{ ...card, ...faint }}>No review requested of you.</div>}
          {data.reviewing.map((t) => card_(t, true))}
        </>
      )}
    </div>
  );
}
