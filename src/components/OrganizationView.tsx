/** The Company section (docs/autonomous-company.md §4.4, execution plan item
 *  14): create an organisation, the org chart, the shared board, goals, the
 *  approvals queue (full artifact, never a summary), spend vs envelopes, the
 *  activity feed (summary → runs → open session), the attributed group log
 *  that wakes nobody, and the brief with its one-reply input. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import {
  api, ORG_TASK_STATUSES, type Agent, type HumanRole, type OrgApproval, type OrgAuditRow, type OrgBrief, type OrgDetail, type OrgHuman, type OrgMember, type OrgMessage, type OrgRun,
  type OrgSpend, type OrgTask, type OrgTaskBrief, type OrgTaskStatus, type WorkspaceMember,
} from '../lib/api';
import { safeJsonParse } from '../lib/util';
import { fmtUsd } from '../lib/pricing';
import { UsageBars, UsageRows } from './UsageChart';
import { I, P } from '../lib/icons';
import { grad } from '../store';

const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 13, background: 'var(--panel)', padding: '14px 16px' };
const input: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px', color: 'var(--text)', fontSize: 12.5, outline: 'none', width: '100%' };
const btn = (primary = false, danger = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : danger ? 'var(--red)' : 'var(--panel-2)', color: primary || danger ? '#fff' : 'var(--text)',
  border: primary || danger ? 'none' : '1px solid var(--border)', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
});
const pill = (bg = 'var(--panel-2)', color = 'var(--text-dim)'): React.CSSProperties => ({ fontSize: 10.5, background: bg, color, border: '1px solid var(--border-soft)', borderRadius: 6, padding: '1px 7px', whiteSpace: 'nowrap' });
const h2: React.CSSProperties = { fontSize: 15, fontWeight: 700, margin: 0 };
const faint: React.CSSProperties = { fontSize: 12, color: 'var(--text-faint)' };

const STATUS_COLOR: Record<OrgTaskStatus, string> = {
  backlog: 'var(--text-faint)', todo: 'var(--blue)', claimed: 'var(--amber)', in_progress: 'var(--amber)', in_review: 'var(--accent)', blocked: 'var(--red)', done: 'var(--green)', cancelled: 'var(--text-faint)',
};

function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now'; if (m < 60) return `${m}m ago`; if (m < 1440) return `${Math.floor(m / 60)}h ago`; return `${Math.floor(m / 1440)}d ago`;
}

function useAgentNames() {
  const app = useApp();
  return useMemo(() => new Map(app.agents.map((a) => [a.id, a])), [app.agents]);
}

function Avatar({ a, size = 22 }: { a?: Agent; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: 7, background: a ? grad(a.colors) : 'var(--panel-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.55, flex: 'none' }}>{a?.emoji ?? '?'}</span>;
}

export function CompanyView() {
  const app = useApp();
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!app.orgId) { setOrg(null); return; }
    try { setOrg(await api.org(app.orgId)); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [app.orgId]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { const t = setInterval(() => { void reload(); }, 30_000); return () => clearInterval(t); }, [reload]);

  if (!app.companiesEnabled) return <div style={{ padding: 24, ...faint }}>Companies are disabled on this server (COMPANIES_ENABLED=false).</div>;
  if (!app.orgId || !org) return <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>{err ? <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{err}</div> : <CreateOrg />}</div>;

  const toggle = async () => {
    try {
      if (org.status === 'active') { if (!confirm(`Pause ${org.name}? Every queued wake is dropped and in-flight runs are aborted.`)) return; await api.pauseOrg(org.id); } else await api.resumeOrg(org.id);
      await app.refreshOrgs(); await reload();
    } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  const view = app.companyView;
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px 10px', borderBottom: '1px solid var(--border)' }}>
        {app.stacked && <button onClick={() => app.setMobileDetail(false)} style={{ ...btn(), padding: 6 }}><I d={P.chevL} size={14} /></button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={h2}>{org.name}</h2>
            <span style={pill(org.status === 'active' ? 'var(--green)' : 'var(--red)', '#fff')}>{org.status}</span>
            {org.charterDrift.length > 0 && <span title="A member's charter changed outside the org path" style={pill('var(--amber)', '#fff')}>charter drift · {org.charterDrift.length}</span>}
          </div>
          {org.mission && <div style={{ ...faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{org.mission}</div>}
        </div>
        <button onClick={toggle} style={btn(false, org.status === 'active')} title={org.status === 'active' ? 'Kill switch: stop every wake and run' : 'Resume wakes and runs'}>{org.status === 'active' ? 'Pause company' : 'Resume'}</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        {view === 'chart' && <OrgChart org={org} reload={reload} />}
        {view === 'board' && <Board org={org} />}
        {view === 'goals' && <Goals org={org} reload={reload} />}
        {view === 'approvals' && <Approvals org={org} reload={reload} />}
        {view === 'spend' && <Spend org={org} reload={reload} />}
        {view === 'activity' && <Activity org={org} />}
        {view === 'chat' && <GroupChat org={org} />}
        {view === 'brief' && <BriefView org={org} />}
      </div>
    </div>
  );
}

// ---- create ----

function CreateOrg() {
  const app = useApp();
  const [name, setName] = useState('');
  const [mission, setMission] = useState('');
  const [mode, setMode] = useState<'existing' | 'new'>(app.agents.length ? 'existing' : 'new');
  const [chiefId, setChiefId] = useState(app.agents[0]?.id ?? '');
  const [chiefName, setChiefName] = useState('Chief of staff');
  const [packId, setPackId] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const pack = app.market.find((m) => m.id === packId);
  const create = async () => {
    if (!name.trim() || !app.workspaceId) return;
    setBusy(true);
    try {
      const o = await api.createOrg({
        workspaceId: app.workspaceId, name: name.trim(), mission: mission.trim() || undefined,
        ...(mode === 'existing' ? { chiefOfStaffAgentId: chiefId } : { chief: { name: chiefName.trim() || 'Chief of staff', packId: pack?.id } }),
        monthlyBudgetUsd: budget ? Number(budget) : undefined,
      });
      await app.refreshOrgs(); await app.refreshAgents(); app.pickOrg(o.id); app.setCompanyView('chart');
      app.showToast(`${o.name} created — add members in the org chart or ask the chief of staff to propose hires`);
    } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } finally { setBusy(false); }
  };
  return (
    <div style={{ maxWidth: 560, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div><h2 style={h2}>New organisation</h2><div style={faint}>One human CEO (you), one chief of staff, two to five specialists, a shared board, hard budgets. The chief proposes; you decide.</div></div>
      <div style={card}>
        <label style={faint}>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Newsletter" style={{ ...input, marginBottom: 10 }} />
        <label style={faint}>Mission</label>
        <textarea value={mission} onChange={(e) => setMission(e.target.value)} rows={3} placeholder="Ship a weekly newsletter our readers forward." style={{ ...input, resize: 'vertical', marginBottom: 10 }} />
        <label style={faint}>Company budget (USD / month, optional — 100% is a hard stop)</label>
        <input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))} placeholder="25" style={input} />
      </div>
      <div style={card}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Chief of staff</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button onClick={() => setMode('existing')} style={btn(mode === 'existing')} disabled={app.agents.length === 0}>An existing agent</button>
          <button onClick={() => setMode('new')} style={btn(mode === 'new')}>Create one</button>
        </div>
        {mode === 'existing' ? (
          <select value={chiefId} onChange={(e) => setChiefId(e.target.value)} style={input}>
            {app.agents.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}{a.role ? ` · ${a.role}` : ''}</option>)}
          </select>
        ) : (
          <>
            <input value={chiefName} onChange={(e) => setChiefName(e.target.value)} placeholder="Chief of staff" style={{ ...input, marginBottom: 8 }} />
            <select value={packId} onChange={(e) => setPackId(e.target.value)} style={input}>
              <option value="">Default chief-of-staff charter (decompose, route, review, report)</option>
              {app.market.map((m) => <option key={m.id} value={m.id}>Start from the {m.name} pack charter</option>)}
            </select>
          </>
        )}
        <div style={{ ...faint, marginTop: 8 }}>The chief starts with file and web tools only. Mail, calendar, code and browser are grants you give in the org chart.</div>
      </div>
      <button onClick={() => void create()} disabled={busy || !name.trim()} style={{ ...btn(true), padding: 10, opacity: busy || !name.trim() ? 0.6 : 1 }}>Create organisation</button>
    </div>
  );
}

// ---- org chart ----

function OrgChart({ org, reload }: { org: OrgDetail; reload: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [adding, setAdding] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [title, setTitle] = useState('');
  const [reportsTo, setReportsTo] = useState(org.chiefOfStaffAgentId ?? '');
  const [scopes, setScopes] = useState('tool:fs_read, tool:fs_write');
  const [editing, setEditing] = useState<string | null>(null);
  const [editScopes, setEditScopes] = useState('');
  const live = org.members.filter((m) => m.status !== 'terminated');
  const free = app.agents.filter((a) => !live.some((m) => m.agentId === a.id));
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await reload(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  const tree = (parent: string | null, depth: number): React.ReactNode => live.filter((m) => m.reportsToAgentId === parent).map((m) => {
    const a = names.get(m.agentId);
    const drift = org.charterDrift.find((d) => d.agentId === m.agentId);
    const sc = safeJsonParse<string[]>(m.scopes, []);
    const isChief = m.agentId === org.chiefOfStaffAgentId;
    return (
      <div key={m.id} style={{ marginLeft: depth * 22, marginBottom: 8 }}>
        <div style={{ ...card, padding: '10px 12px', borderLeft: `3px solid ${m.status === 'active' ? 'var(--green)' : 'var(--amber)'}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Avatar a={a} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ cursor: 'pointer' }} onClick={() => app.openAgent(m.agentId)}>{a?.name ?? m.agentId.slice(0, 8)}</span>
                <span style={pill()}>{isChief ? 'chief of staff' : m.title || 'member'}</span>
                <span style={pill()}>depth {m.depth}</span>
                {m.status === 'paused' && <span style={pill('var(--amber)', '#fff')}>paused</span>}
                {drift && <span style={pill('var(--amber)', '#fff')} title={`recorded ${drift.recorded.slice(0, 8)} · live ${drift.live.slice(0, 8)}`}>charter changed</span>}
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
                {sc.length === 0 && <span style={faint}>no scopes</span>}
                {sc.map((s) => <span key={s} style={{ ...pill(), fontFamily: 'var(--mono)' }}>{s}</span>)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 5, flex: 'none' }}>
              {drift && <button style={btn()} onClick={() => void act(() => api.acceptOrgCharter(org.id, m.agentId))}>Accept charter</button>}
              <button style={btn()} onClick={() => { setEditing(m.agentId); setEditScopes(sc.join(', ')); }}>Scopes</button>
              {!isChief && <button style={btn()} onClick={() => void act(() => m.status === 'active' ? api.pauseOrgMember(org.id, m.agentId) : api.resumeOrgMember(org.id, m.agentId))}>{m.status === 'active' ? 'Pause' : 'Resume'}</button>}
              {!isChief && <button style={btn(false, true)} onClick={() => { if (confirm(`Terminate ${a?.name}? Its reports move up one level; the agent itself stays.`)) void act(() => api.terminateOrgMember(org.id, m.agentId)); }}>Terminate</button>}
            </div>
          </div>
          {editing === m.agentId && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input value={editScopes} onChange={(e) => setEditScopes(e.target.value)} style={input} placeholder="tool:fs_read, connection:gmail:read, folder:shared/notes" />
              <button style={btn(true)} onClick={() => void act(async () => { await api.setOrgMemberScopes(org.id, m.agentId, editScopes.split(',').map((s) => s.trim()).filter(Boolean)); setEditing(null); })}>Save</button>
              <button style={btn()} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          )}
        </div>
        {tree(m.agentId, depth + 1)}
      </div>
    );
  });
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><h2 style={h2}>Org chart</h2><div style={faint}>You → chief of staff → specialists. Depth ≤ {org.maxDepth}, ≤ {org.maxDirectReports} direct reports. Scopes are what a member may touch; the chief can only narrow them without you.</div></div>
        <button style={btn(true)} onClick={() => setAdding(!adding)} disabled={free.length === 0}>Add member</button>
      </div>
      {adding && (
        <div style={{ ...card, marginBottom: 12, display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' }}>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} style={input}><option value="">Agent…</option>{free.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}</select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (Writer, Researcher…)" style={input} />
          <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)} style={input}>{live.map((m) => <option key={m.id} value={m.agentId}>reports to {names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)}</option>)}</select>
          <input value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="scopes, comma-separated" style={input} />
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button style={btn()} onClick={() => setAdding(false)}>Cancel</button>
            <button style={btn(true)} disabled={!agentId} onClick={() => void act(async () => { await api.addOrgMember(org.id, { agentId, title, reportsToAgentId: reportsTo, scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean) }); setAdding(false); setAgentId(''); })}>Add</button>
          </div>
        </div>
      )}
      <Humans org={org} />
      {tree(null, 1)}
    </div>
  );
}

/** The humans of the company (phase D): the owner is CEO; members of the
 *  shared workspace can sit on the board (hire / budget / strategy
 *  approvals) or observe. Only the CEO changes this. */
function Humans({ org }: { org: OrgDetail }) {
  const app = useApp();
  const [humans, setHumans] = useState<OrgHuman[]>([]);
  const [meRole, setMeRole] = useState<HumanRole | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<HumanRole>('board');
  const refresh = useCallback(async () => {
    const h = await api.orgHumans(org.id).catch(() => null);
    if (h) { setHumans(h.humans); setMeRole(h.me.role); }
    setMembers(await api.workspaceMembers(org.workspaceId).catch(() => []));
  }, [org.id, org.workspaceId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const isCeo = meRole === 'ceo';
  const free = members.filter((m) => !humans.some((h) => h.memberAccountId === m.memberAccountId));
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  const ROLE_HINT: Record<HumanRole, string> = { ceo: 'everything', board: 'decides hire, budget and strategy approvals; gets the brief', observer: 'reads the company; decides nothing' };
  return (
    <div style={{ ...card, padding: '10px 12px', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ fontSize: 18 }}>🧑‍💼</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{isCeo ? 'You — CEO' : `${app.nameOf(null)} — CEO`}{meRole && !isCeo && <span style={{ ...pill(), marginLeft: 8 }}>you: {meRole}</span>}</div>
          <div style={faint}>Approvals, budgets and the kill switch are the CEO's. Board members decide hires, budget raises and strategy; observers read.</div>
        </div>
      </div>
      {humans.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {humans.map((h) => (
            <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '4px 0' }}>
              <span style={{ fontSize: 14 }}>🧑</span>
              <span style={{ flex: 1 }}>{app.nameOf(h.memberAccountId)}</span>
              <span style={pill()} title={ROLE_HINT[h.role]}>{h.role}</span>
              {isCeo && (
                <>
                  <select value={h.role} onChange={(e) => void act(() => api.setOrgHuman(org.id, h.memberAccountId, e.target.value as HumanRole))} style={{ ...input, width: 'auto', padding: '3px 6px' }}>
                    <option value="board">board</option><option value="observer">observer</option>
                  </select>
                  <button style={btn()} onClick={() => void act(() => api.removeOrgHuman(org.id, h.memberAccountId))}>Remove</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {isCeo && members.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...input, width: 'auto', flex: 1 }}>
            <option value="">Add a workspace member…</option>
            {free.map((m) => <option key={m.id} value={m.memberAccountId}>{m.displayName || m.email}</option>)}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value as HumanRole)} style={{ ...input, width: 'auto' }}><option value="board">board</option><option value="observer">observer</option></select>
          <button style={btn(true)} disabled={!pick} onClick={() => void act(async () => { await api.setOrgHuman(org.id, pick, role); setPick(''); })}>Add</button>
        </div>
      )}
      {isCeo && members.length === 0 && <div style={{ ...faint, marginTop: 6 }}>Invite people to this workspace (Settings → Workspace → Members) to seat a board.</div>}
    </div>
  );
}

// ---- board ----

function parseBriefText(raw: string): OrgTaskBrief {
  const b = safeJsonParse<Partial<OrgTaskBrief>>(raw, {});
  return { outcome: b.outcome ?? '', context: b.context ?? '', constraints: b.constraints ?? '', done_when: b.done_when ?? '' };
}

function Board({ org }: { org: OrgDetail }) {
  const names = useAgentNames();
  const [tasks, setTasks] = useState<OrgTask[]>([]);
  const [open, setOpen] = useState<OrgTask | null>(null);
  const [adding, setAdding] = useState(false);
  const [showCold, setShowCold] = useState(false);
  const reload = useCallback(async () => { setTasks(await api.orgTasks(org.id).catch(() => [])); }, [org.id]);
  useEffect(() => { void reload(); const t = setInterval(() => { void reload(); }, 15_000); return () => clearInterval(t); }, [reload]);
  const cols = ORG_TASK_STATUSES.filter((s) => showCold || (s !== 'done' && s !== 'cancelled'));
  const members = org.members.filter((m) => m.status === 'active');
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><h2 style={h2}>Board</h2><div style={faint}>One owner per task. Assigning wakes the owner; a comment wakes the owner; mentions wake nobody.</div></div>
        <label style={{ ...faint, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={showCold} onChange={(e) => setShowCold(e.target.checked)} />done & cancelled</label>
        <button style={btn(true)} onClick={() => setAdding(true)}>New task</button>
      </div>
      {adding && <NewTask org={org} members={members} onDone={() => { setAdding(false); void reload(); }} />}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols.length}, minmax(150px, 1fr))`, gap: 8, overflowX: 'auto' }}>
        {cols.map((s) => (
          <div key={s} style={{ background: 'var(--panel-2)', borderRadius: 10, padding: 8, minHeight: 120 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: STATUS_COLOR[s], marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}><span>{s.replace('_', ' ')}</span><span>{tasks.filter((t) => t.status === s).length}</span></div>
            {tasks.filter((t) => t.status === s).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((t) => {
              const a = t.assigneeAgentId ? names.get(t.assigneeAgentId) : undefined;
              return (
                <div key={t.id} onClick={() => setOpen(t)} style={{ ...card, padding: '8px 10px', marginBottom: 6, cursor: 'pointer' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>{t.title}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    {a ? <span style={{ ...pill(), display: 'inline-flex', gap: 4, alignItems: 'center' }}><Avatar a={a} size={14} />{a.name}</span> : <span style={pill()}>unassigned</span>}
                    {t.claimedBy && <span style={pill('var(--amber)', '#fff')}>claimed</span>}
                    {t.reviewRounds > 0 && <span style={pill()}>review {t.reviewRounds}/3</span>}
                    {t.noProgressCount > 0 && <span style={pill()}>no progress ×{t.noProgressCount}</span>}
                    {t.status === 'in_review' && t.reviewerAgentId && <span style={pill()}>reviewer: {names.get(t.reviewerAgentId)?.name ?? '?'}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {open && <TaskDrawer org={org} task={tasks.find((t) => t.id === open.id) ?? open} members={members} onClose={() => setOpen(null)} reload={reload} />}
    </div>
  );
}

function NewTask({ org, members, onDone }: { org: OrgDetail; members: OrgMember[]; onDone: () => void }) {
  const app = useApp();
  const names = useAgentNames();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState<OrgTaskBrief>({ outcome: '', context: '', constraints: '', done_when: '' });
  const [assignee, setAssignee] = useState('');
  const [projectId, setProjectId] = useState('');
  const save = async () => {
    try { await api.addOrgTask(org.id, { title, brief, assigneeAgentId: assignee || null, projectId: projectId || null }); onDone(); }
    catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  return (
    <div style={{ ...card, marginBottom: 12, display: 'grid', gap: 8 }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" style={input} />
      {(['outcome', 'context', 'constraints', 'done_when'] as const).map((k) => (
        <textarea key={k} value={brief[k]} onChange={(e) => setBrief({ ...brief, [k]: e.target.value })} rows={k === 'outcome' || k === 'done_when' ? 2 : 1} placeholder={k === 'done_when' ? 'done_when — the rubric the reviewer checks' : k} style={{ ...input, resize: 'vertical' }} />
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={input}><option value="">Backlog (chief triages)</option>{members.map((m) => <option key={m.id} value={m.agentId}>assign to {names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)}</option>)}</select>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={input}><option value="">No project</option>{org.projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}><button style={btn()} onClick={onDone}>Cancel</button><button style={btn(true)} disabled={!title.trim()} onClick={() => void save()}>Create{assignee ? ' and wake' : ''}</button></div>
    </div>
  );
}

function TaskDrawer({ org, task, members, onClose, reload }: { org: OrgDetail; task: OrgTask; members: OrgMember[]; onClose: () => void; reload: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [comments, setComments] = useState<OrgMessage[]>([]);
  const [runs, setRuns] = useState<OrgRun[]>([]);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const brief = parseBriefText(task.brief);
  const refresh = useCallback(async () => {
    const [c, r] = await Promise.all([api.orgTaskComments(org.id, task.id).catch(() => []), api.orgTaskRuns(org.id, task.id).catch(() => [])]);
    setComments(c); setRuns(r); await reload();
  }, [org.id, task.id, reload]);
  useEffect(() => { void refresh(); }, [refresh]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  const blockers = safeJsonParse<string[]>(task.blockers, []);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 90, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 100%)', background: 'var(--bg)', borderLeft: '1px solid var(--border)', height: '100%', overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...pill(STATUS_COLOR[task.status], '#fff') }}>{task.status.replace('_', ' ')}</span>
          <h2 style={{ ...h2, flex: 1 }}>{task.title}</h2>
          <button style={btn()} onClick={onClose}><I d={P.x} size={14} /></button>
        </div>
        <div style={faint}>[{task.id.slice(0, 8)}] created by {task.createdBy} · {ago(task.createdAt)} · owner {task.assigneeAgentId ? names.get(task.assigneeAgentId)?.name : 'nobody'}{task.reviewerAgentId ? ` · reviewer ${names.get(task.reviewerAgentId)?.name}` : ''}{task.claimedBy ? ' · claimed' : ''}</div>
        <div style={card}>
          {(['outcome', 'context', 'constraints', 'done_when'] as const).map((k) => <div key={k} style={{ marginBottom: 6 }}><div style={{ ...faint, textTransform: 'uppercase', letterSpacing: '.4px', fontSize: 10.5 }}>{k.replace('_', ' ')}</div><div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{brief[k] || <span style={faint}>—</span>}</div></div>)}
          {blockers.length > 0 && <div><div style={{ ...faint, textTransform: 'uppercase', fontSize: 10.5 }}>blockers</div>{blockers.map((b, i) => <div key={i} style={{ fontSize: 12.5, color: 'var(--red)' }}>■ {b}</div>)}</div>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select value="" onChange={(e) => { if (e.target.value) void act(() => api.assignOrgTask(org.id, task.id, e.target.value)); }} style={{ ...input, width: 'auto' }}><option value="">Assign to…</option>{members.map((m) => <option key={m.id} value={m.agentId}>{names.get(m.agentId)?.name}</option>)}</select>
          {task.assigneeAgentId && !['done', 'cancelled'].includes(task.status) && <button style={btn()} onClick={() => void act(() => api.wakeOrgTask(org.id, task.id, true))}>Wake now</button>}
          {task.status === 'in_review' && <><button style={btn(true)} onClick={() => void act(() => api.reviewOrgTask(org.id, task.id, 'accept', note))}>Accept</button><button style={btn()} onClick={() => void act(() => api.reviewOrgTask(org.id, task.id, 'request_changes', note || 'changes requested'))}>Request changes</button></>}
          {task.status === 'blocked' && <button style={btn()} onClick={() => void act(() => api.updateOrgTask(org.id, task.id, { status: 'todo', blockers: [] }))}>Unblock → todo</button>}
          {!['done', 'cancelled'].includes(task.status) && <button style={btn(false, true)} onClick={() => void act(() => api.updateOrgTask(org.id, task.id, { status: 'cancelled' }))}>Cancel task</button>}
        </div>
        {task.status === 'in_review' && <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Review note (optional)" style={input} />}
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Timeline</div>
          {comments.length === 0 && <div style={faint}>No comments yet.</div>}
          {comments.map((c) => { const a = c.fromAgentId ? names.get(c.fromAgentId) : undefined; return (
            <div key={c.id} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border-soft)' }}>
              {a ? <Avatar a={a} size={18} /> : <span style={{ fontSize: 14 }}>🧑‍💼</span>}
              <div style={{ flex: 1, minWidth: 0 }}><div style={faint}>{a?.name ?? 'You'} · {ago(c.createdAt)}</div><div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{c.text}</div></div>
            </div>); })}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment — wakes the owner" style={input} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { void act(async () => { await api.commentOrgTask(org.id, task.id, text.trim()); setText(''); }); } }} />
            <button style={btn(true)} disabled={!text.trim()} onClick={() => void act(async () => { await api.commentOrgTask(org.id, task.id, text.trim()); setText(''); })}>Post</button>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Runs</div>
          {runs.length === 0 && <div style={faint}>No runs yet.</div>}
          {runs.map((r) => <RunRow key={r.id} r={r} names={names} />)}
        </div>
      </div>
    </div>
  );
}

function RunRow({ r, names, title }: { r: OrgRun; names: Map<string, Agent>; title?: string }) {
  const app = useApp();
  const a = names.get(r.agentId);
  const color = r.status === 'done' ? 'var(--green)' : r.status === 'running' ? 'var(--amber)' : r.status === 'refused' ? 'var(--text-faint)' : 'var(--red)';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border-soft)' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' }} />
      <Avatar a={a} size={18} />
      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
        <span style={{ fontWeight: 600 }}>{a?.name ?? '?'}</span> {r.wakeReason} → {r.outcome || r.status}{title ? <span style={faint}> · {title}</span> : null}
        <div style={faint}>{ago(r.startedAt)} · {r.tokensIn + r.tokensOut} tokens · {fmtUsd(r.usd)}</div>
      </div>
      {r.sessionId && <button style={btn()} onClick={() => app.openSession(r.sessionId!)}>Open session</button>}
    </div>
  );
}

// ---- goals ----

function Goals({ org, reload }: { org: OrgDetail; reload: () => Promise<void> }) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [project, setProject] = useState<Record<string, string>>({});
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await reload(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={h2}>Goals</h2><div style={{ ...faint, marginBottom: 12 }}>Set by you, never computed. The chief of staff proposes strategies (goals → projects → tasks) you approve.</div>
      <div style={{ ...card, display: 'flex', gap: 6, marginBottom: 12 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Goal" style={input} />
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Why / what success looks like" style={input} />
        <button style={btn(true)} disabled={!title.trim()} onClick={() => void act(async () => { await api.addOrgGoal(org.id, { title, description: desc }); setTitle(''); setDesc(''); })}>Add</button>
      </div>
      {org.goals.length === 0 && <div style={faint}>No goals yet.</div>}
      {org.goals.map((g) => (
        <div key={g.id} style={{ ...card, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 13.5, fontWeight: 600 }}>{g.title}</div>{g.description && <div style={faint}>{g.description}</div>}</div>
            <select value={g.status} onChange={(e) => void act(() => api.updateOrgGoal(org.id, g.id, { status: e.target.value }))} style={{ ...input, width: 'auto' }}>{['draft', 'active', 'achieved', 'abandoned'].map((s) => <option key={s}>{s}</option>)}</select>
          </div>
          <div style={{ marginTop: 8, paddingLeft: 10, borderLeft: '2px solid var(--border-soft)' }}>
            {org.projects.filter((p) => p.goalId === g.id).map((p) => <div key={p.id} style={{ fontSize: 12.5, padding: '2px 0' }}>▸ {p.title} <span style={pill()}>{p.status}</span></div>)}
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input value={project[g.id] ?? ''} onChange={(e) => setProject({ ...project, [g.id]: e.target.value })} placeholder="New project under this goal" style={input} />
              <button style={btn()} disabled={!(project[g.id] ?? '').trim()} onClick={() => void act(async () => { await api.addOrgProject(org.id, { title: project[g.id], goalId: g.id }); setProject({ ...project, [g.id]: '' }); })}>Add</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- approvals ----

function Approvals({ org, reload }: { org: OrgDetail; reload: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [rows, setRows] = useState<OrgApproval[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [history, setHistory] = useState(false);
  const [humans, setHumans] = useState<{ me: HumanRole | null; board: string[] }>({ me: null, board: [] });
  const refresh = useCallback(async () => {
    setRows(await api.orgApprovals(org.id).catch(() => []));
    const h = await api.orgHumans(org.id).catch(() => null);
    if (h) setHumans({ me: h.me.role, board: h.humans.filter((x) => x.role === 'board').map((x) => x.memberAccountId) });
  }, [org.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const BOARD_KINDS = new Set(['hire', 'budget_raise', 'strategy']);
  /** Who may decide this card (docs/autonomous-company.md phase D). */
  const deciders = (kind: string) => (BOARD_KINDS.has(kind) && humans.board.length > 0 ? `CEO or board (${humans.board.map((b) => app.nameOf(b)).join(', ')})` : 'CEO only');
  const mayDecide = (kind: string) => humans.me === 'ceo' || (humans.me === 'board' && BOARD_KINDS.has(kind));
  const decide = async (a: OrgApproval, d: 'approve' | 'reject' | 'revise') => {
    try { await api.decideOrgApproval(org.id, a.id, d, notes[a.id]); await refresh(); await reload(); await app.refreshAgents(); app.showToast(`${a.kind}: ${d}d`); }
    catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  const pending = rows.filter((r) => r.status === 'pending');
  const shown = history ? rows.filter((r) => r.status !== 'pending').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) : pending;
  const nm = (id: unknown) => (typeof id === 'string' ? names.get(id)?.name ?? id.slice(0, 8) : '—');
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><h2 style={h2}>Approvals · {pending.length} pending</h2><div style={faint}>The full artifact, not a summary. Only a human decides here — the CEO, or a board member for hires, budgets and strategy; an agent's message never counts. Unanswered cards expire after 72 h ("not done").</div></div>
        <button style={btn(history)} onClick={() => setHistory(!history)}>{history ? 'Show pending' : 'History'}</button>
      </div>
      {shown.length === 0 && <div style={faint}>{history ? 'Nothing decided yet.' : 'Nothing to decide.'}</div>}
      {shown.map((a) => {
        const p = safeJsonParse<Record<string, unknown>>(a.payload, {});
        return (
          <div key={a.id} style={{ ...card, marginBottom: 10, borderLeft: `3px solid ${a.status === 'pending' ? 'var(--amber)' : a.status === 'approved' ? 'var(--green)' : 'var(--text-faint)'}` }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span style={pill('var(--accent-dim)', 'var(--text)')}>{a.kind}</span>
              <span style={faint}>by {a.requestedBy} · {ago(a.createdAt)}{a.status !== 'pending' ? ` · ${a.status}${a.decidedBy ? ` by ${app.nameOf(a.decidedBy)}` : ''}${a.decisionNote ? ` — ${a.decisionNote}` : ''}` : a.expiresAt ? ` · expires ${ago(a.expiresAt).replace(' ago', '')}` : ''}</span>
              {a.status === 'pending' && <span style={pill()} title="Who may decide this card">{deciders(a.kind)}</span>}
            </div>
            {a.recommendation && <div style={{ fontSize: 12.5, marginBottom: 6 }}><b>Chief:</b> {a.recommendation}</div>}
            <ApprovalArtifact kind={a.kind} p={p} nm={nm} />
            {a.status === 'pending' && !mayDecide(a.kind) && humans.me !== null && (
              <div style={{ ...faint, marginTop: 10 }}>{humans.me === 'observer' ? 'Observers read the company but decide nothing.' : `A ${a.kind} approval is the CEO's to decide.`}</div>
            )}
            {a.status === 'pending' && mayDecide(a.kind) && (
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <input value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} placeholder="Note to the chief (required for revise)" style={input} />
                <button style={btn(true)} onClick={() => void decide(a, 'approve')}>Approve</button>
                <button style={btn()} disabled={!(notes[a.id] ?? '').trim()} onClick={() => void decide(a, 'revise')}>Revise</button>
                <button style={btn(false, true)} onClick={() => void decide(a, 'reject')}>Reject</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ApprovalArtifact({ kind, p, nm }: { kind: string; p: Record<string, unknown>; nm: (id: unknown) => string }) {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const mono: React.CSSProperties = { fontFamily: 'var(--mono)', fontSize: 11.5 };
  if (kind === 'hire') return (
    <div style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
      <div><b>{String(p.name)}</b> as <b>{String(p.title)}</b>{p.packName ? <> from the <b>{String(p.packName)}</b> pack</> : ' (template)'} · reports to {nm(p.reportsToAgentId)}{p.monthlyBudgetUsd ? ` · $${Number(p.monthlyBudgetUsd).toFixed(2)}/month` : ''}{p.model ? ` · ${String(p.model)}` : ''}</div>
      <div>Scopes it would get: {list(p.scopes).length ? list(p.scopes).map((s) => <span key={s} style={{ ...pill(), ...mono, marginRight: 4 }}>{s}</span>) : <i>none</i>}</div>
      {list(p.outsideChiefHoldings).length > 0 && <div style={faint}>Requested but dropped (the chief does not hold them): {list(p.outsideChiefHoldings).map((s) => <s key={s} style={{ ...mono, marginRight: 6 }}>{s}</s>)}</div>}
      {list(p.skills).length > 0 && <div style={faint}>Skills installed private to it: {list(p.skills).join(', ')}</div>}
      <details><summary style={{ cursor: 'pointer', ...faint }}>Charter ({String(p.charter ?? '').length} chars)</summary><pre style={{ ...mono, whiteSpace: 'pre-wrap', background: 'var(--panel-2)', padding: 8, borderRadius: 8, maxHeight: 260, overflow: 'auto' }}>{String(p.charter ?? '')}</pre></details>
      <div style={faint}>No memory, lessons or connections are inherited. It starts with no loops and wakes only on assignment.</div>
    </div>
  );
  if (kind === 'scope_widen') return (
    <div style={{ fontSize: 12.5 }}>Widen <b>{String(p.agentName ?? nm(p.agentId))}</b>: {list(p.before).map((s) => <span key={s} style={{ ...pill(), ...mono, marginRight: 4 }}>{s}</span>)} <b>+</b> {list(p.widened).map((s) => <span key={s} style={{ ...pill('var(--amber)', '#fff'), ...mono, marginRight: 4 }}>{s}</span>)}</div>
  );
  if (kind === 'reorg') {
    const changes = Array.isArray(p.changes) ? p.changes as Array<Record<string, unknown>> : [];
    const nmap = (p.names ?? {}) as Record<string, string>;
    return <div style={{ fontSize: 12.5 }}>{changes.map((c, i) => <div key={i}>• {String(c.op)} <b>{nmap[String(c.agentId)] ?? nm(c.agentId)}</b>{c.reportsToAgentId ? <> → reports to <b>{nmap[String(c.reportsToAgentId)] ?? nm(c.reportsToAgentId)}</b></> : ''}{c.title ? ` → "${String(c.title)}"` : ''}</div>)}</div>;
  }
  if (kind === 'budget_raise') return <div style={{ fontSize: 12.5 }}>{String(p.scope)} envelope {p.scope !== 'company' ? `(${nm(p.refId)})` : ''}: ${Number(p.current ?? 0).toFixed(2)} → <b>${Number(p.monthlyUsd ?? 0).toFixed(2)}</b> per month</div>;
  if (kind === 'strategy') {
    const goals = Array.isArray(p.goals) ? p.goals as Array<{ title: string; description?: string; projects?: Array<{ title: string; tasks?: Array<{ title: string }> }> }> : [];
    return <div style={{ fontSize: 12.5 }}>{goals.map((g, i) => <div key={i} style={{ marginBottom: 4 }}><b>{g.title}</b>{g.description ? ` — ${g.description}` : ''}{(g.projects ?? []).map((pr, j) => <div key={j} style={{ paddingLeft: 12 }}>▸ {pr.title}{(pr.tasks ?? []).map((t, k) => <div key={k} style={{ paddingLeft: 14, color: 'var(--text-dim)' }}>· {t.title}</div>)}</div>)}</div>)}</div>;
  }
  if (kind === 'terminate') return <div style={{ fontSize: 12.5 }}>Terminate <b>{String(p.agentName ?? nm(p.agentId))}</b>{p.reason ? ` — ${String(p.reason)}` : ''}. Its reports move up one level; the agent itself stays.</div>;
  if (kind === 'escalation') return <div style={{ fontSize: 12.5 }}>Task <b>{String(p.title)}</b> ({nm(p.assigneeAgentId)}): {String(p.reason)}. Approve to reopen it with your note; reject to cancel it.</div>;
  return <pre style={{ ...mono, whiteSpace: 'pre-wrap' }}>{JSON.stringify(p, null, 2)}</pre>;
}

// ---- spend ----

function Spend({ org, reload }: { org: OrgDetail; reload: () => Promise<void> }) {
  const app = useApp();
  const [spend, setSpend] = useState<OrgSpend | null>(null);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => setSpend(await api.orgSpend(org.id).catch(() => null)), [org.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const setCap = async (scope: 'company' | 'agent' | 'project', refId: string) => {
    try { await api.setOrgBudget(org.id, { scope, refId, monthlyUsd: Number(caps[refId] ?? 0) }); await refresh(); await reload(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  if (!spend) return <div style={faint}>Loading…</div>;
  const node = (scope: 'company' | 'agent' | 'project', refId: string, label: string, n: { usd: number; monthlyUsd: number; reservedUsd: number; runs: number }) => {
    const pct = n.monthlyUsd > 0 ? Math.min(100, Math.round(((n.usd + n.reservedUsd) / n.monthlyUsd) * 100)) : null;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 110px 150px', gap: 10, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border-soft)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label} <span style={faint}>· {n.runs} run(s)</span></div>
          {pct !== null && <div style={{ height: 5, background: 'var(--panel-2)', borderRadius: 3, marginTop: 4 }}><div style={{ width: `${pct}%`, height: 5, borderRadius: 3, background: pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)' }} /></div>}
        </div>
        <div style={{ fontSize: 12.5, fontFamily: 'var(--mono)', textAlign: 'right' }}>{fmtUsd(n.usd)}{n.monthlyUsd > 0 ? <span style={faint}> / {fmtUsd(n.monthlyUsd)}</span> : <span style={faint}> / no cap</span>}</div>
        <div style={{ display: 'flex', gap: 4 }}><input value={caps[refId] ?? String(n.monthlyUsd || '')} onChange={(e) => setCaps({ ...caps, [refId]: e.target.value.replace(/[^\d.]/g, '') })} style={{ ...input, padding: '4px 8px' }} placeholder="cap $" /><button style={btn()} onClick={() => void setCap(scope, refId)}>Set</button></div>
      </div>
    );
  };
  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={h2}>Spend vs envelopes · {spend.month}</h2>
      <div style={{ ...faint, marginBottom: 12 }}>Every run reserves its estimate before the model is called and settles from actual usage. 80% warns, 100% stops the scope. {spend.costPerAcceptedTask !== null ? `Cost per accepted task: ${fmtUsd(spend.costPerAcceptedTask)} (${spend.acceptedTasks} accepted).` : `${spend.acceptedTasks} accepted task(s).`}</div>
      <div style={{ ...card, marginBottom: 12 }}><UsageBars series={spend.series} /></div>
      <div style={card}>
        {node('company', org.id, `${org.name} (company)`, spend.company)}
        {spend.projects.map((p) => <div key={p.id} style={{ paddingLeft: 16 }}>{node('project', p.id, `▸ ${p.title}`, p)}</div>)}
        {spend.members.map((m) => <div key={m.agentId} style={{ paddingLeft: 16 }}>{node('agent', m.agentId, `${m.name}${m.title ? ` · ${m.title}` : ''}`, m)}</div>)}
      </div>
      <div style={{ ...card, marginTop: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>By member</div>
        <UsageRows rows={spend.members.map((m) => ({ key: m.agentId, label: m.name, tokensIn: m.tokensIn, tokensOut: m.tokensOut, usd: m.usd, turns: m.runs }))} />
      </div>
    </div>
  );
}

// ---- activity ----

function Activity({ org }: { org: OrgDetail }) {
  const names = useAgentNames();
  const [runs, setRuns] = useState<OrgRun[]>([]);
  const [tasks, setTasks] = useState<OrgTask[]>([]);
  const [audit, setAudit] = useState<OrgAuditRow[]>([]);
  const [verify, setVerify] = useState<{ ok: boolean; length: number; brokenAt: number | null; reason?: string } | null>(null);
  const [layer, setLayer] = useState<'runs' | 'audit'>('runs');
  useEffect(() => {
    void Promise.all([api.orgRuns(org.id).catch(() => []), api.orgTasks(org.id).catch(() => []), api.orgAudit(org.id, 150).catch(() => []), api.verifyOrgAudit(org.id).catch(() => null)])
      .then(([r, t, a, v]) => { setRuns(r); setTasks(t); setAudit(a); setVerify(v); });
  }, [org.id]);
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><h2 style={h2}>Activity</h2><div style={faint}>Three layers: the brief and badges on top, runs and their outcomes here, the full transcript one click away.</div></div>
        <button style={btn(layer === 'runs')} onClick={() => setLayer('runs')}>Runs</button>
        <button style={btn(layer === 'audit')} onClick={() => setLayer('audit')}>Audit log {verify && <span style={pill(verify.ok ? 'var(--green)' : 'var(--red)', '#fff')}>{verify.ok ? `chain ok · ${verify.length}` : `broken at #${verify.brokenAt}`}</span>}</button>
      </div>
      {layer === 'runs' && <div style={card}>{runs.length === 0 ? <div style={faint}>No runs yet. Assign a task to wake somebody.</div> : runs.map((r) => <RunRow key={r.id} r={r} names={names} title={titles.get(r.taskId)} />)}</div>}
      {layer === 'audit' && (
        <div style={card}>
          {!verify?.ok && verify && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 8 }}>Chain broken at #{verify.brokenAt}: {verify.reason}</div>}
          {audit.map((r) => <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '42px 120px 1fr', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border-soft)', fontFamily: 'var(--mono)' }}><span style={faint}>#{r.seq}</span><span>{r.actor}</span><span><b>{r.action}</b> {r.refType}{r.refId ? `:${r.refId.slice(0, 8)}` : ''} <span style={faint}>{r.payload.length > 2 ? r.payload.slice(0, 140) : ''}</span></span></div>)}
        </div>
      )}
    </div>
  );
}

// ---- group chat ----

function GroupChat({ org }: { org: OrgDetail }) {
  const app = useApp();
  const names = useAgentNames();
  const [msgs, setMsgs] = useState<OrgMessage[]>([]);
  const [text, setText] = useState('');
  const refresh = useCallback(async () => setMsgs(await api.orgMessages(org.id).catch(() => [])), [org.id]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 10_000); return () => clearInterval(t); }, [refresh]);
  const post = async () => { if (!text.trim()) return; await api.postOrgMessage(org.id, text.trim()); setText(''); await refresh(); };
  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <h2 style={h2}>Group chat</h2>
      <div style={{ ...faint, marginBottom: 12 }}>A log everyone can read, attributed to who wrote it. Posting here wakes nobody — to make someone act, <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => app.setCompanyView('board')}>assign a task</span>.</div>
      <div style={{ ...card, flex: 1, minHeight: 240, overflowY: 'auto' }}>
        {msgs.length === 0 && <div style={faint}>Quiet so far.</div>}
        {msgs.map((m) => { const a = m.fromAgentId ? names.get(m.fromAgentId) : undefined; return (
          <div key={m.id} style={{ display: 'flex', gap: 9, padding: '7px 0', borderBottom: '1px solid var(--border-soft)' }}>
            {a ? <Avatar a={a} /> : <span style={{ fontSize: 18 }}>🧑‍💼</span>}
            <div style={{ flex: 1, minWidth: 0 }}><div style={faint}>{a ? `${a.name} (agent)` : 'You (CEO)'} · {ago(m.createdAt)}</div><div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.text}</div></div>
          </div>); })}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void post(); }} placeholder="Say something to the company (wakes nobody)" style={input} />
        <button style={btn(true)} onClick={() => void post()} disabled={!text.trim()}>Post</button>
      </div>
    </div>
  );
}

// ---- brief ----

function BriefView({ org }: { org: OrgDetail }) {
  const app = useApp();
  const [brief, setBrief] = useState<OrgBrief | null>(null);
  const [reply, setReply] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const refresh = useCallback(async () => setBrief(await api.orgBrief(org.id).catch(() => null)), [org.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const compose = async () => { try { setBrief(await api.composeOrgBrief(org.id)); setResult(null); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  const send = async () => {
    try {
      const r = await api.replyOrgBrief(org.id, reply);
      setResult(`${r.decisions.map((d) => `#${d.n} ${d.decision} → ${d.status}`).join(' · ') || 'nothing resolved'}${r.unresolved.length ? ` · unresolved: ${r.unresolved.join(', ')}` : ''}`);
      setReply(''); await app.refreshAgents(); await refresh();
    } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><h2 style={h2}>Brief</h2><div style={faint}>Written daily at {String(org.briefHour).padStart(2, '0')}:00 (workspace time, quiet hours respected) and pushed to your channels. Answer the numbered decisions in one line.</div></div>
        <button style={btn()} onClick={() => void compose()}>Write one now</button>
      </div>
      {!brief ? <div style={faint}>No brief yet.</div> : (
        <>
          <div style={{ ...card, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.55 }}>{brief.text}</div>
          <div style={{ ...faint, marginTop: 6 }}>{ago(brief.at)} · {brief.items.length} decision(s) numbered</div>
        </>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && reply.trim()) void send(); }} placeholder='e.g. "do 1, 3, skip 2" or "revise 2: halve the budget"' style={input} disabled={!brief || brief.items.length === 0} />
        <button style={btn(true)} onClick={() => void send()} disabled={!reply.trim() || !brief}>Reply</button>
      </div>
      {result && <div style={{ ...faint, marginTop: 6 }}>{result}</div>}
    </div>
  );
}
