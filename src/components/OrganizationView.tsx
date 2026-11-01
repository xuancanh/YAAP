/** The organization panes of a workspace (docs/group-chat.md §5, execution
 *  plan items 14 and 16): the workspace *is* the company, so these render in
 *  the Workspace section when organization mode is on — the shared board,
 *  goals, the org chart, the approvals queue (full artifact, never a
 *  summary), spend vs envelopes, the brief with its one-reply input, and the
 *  audit (runs and the hash-chained log). Enabling, the mode, the chief and
 *  the caps live in Settings → Workspace → Organization; the group log moved
 *  to the `#company` channel. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import {
  api, ORG_TASK_STATUSES, type Agent, type ChannelMessage, type HumanRole, type OrgApproval, type OrgAuditRow, type OrgBrief, type OrgDetail, type OrgGoalNode, type OrgHuman, type OrgMember, type OrgMessage, type OrgRun,
  type OrgSpend, type OrgTask, type OrgTaskBrief, type OrgTaskStatus, type OrgUnitNode, type WorkspaceMember,
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

/** Every unit, depth-first, with its depth (docs/group-chat.md §7). */
function flattenUnits(nodes: OrgUnitNode[], depth = 0): Array<OrgUnitNode & { depth: number }> {
  return nodes.flatMap((n) => [{ ...n, depth }, ...flattenUnits(n.children, depth + 1)]);
}

/** The unit tree of the current workspace plus the lookups the panes share. */
function useUnits() {
  const app = useApp();
  const units = useMemo(() => flattenUnits(app.wsOrg?.units ?? []), [app.wsOrg]);
  const root = units.find((u) => u.parentUnitId === null) ?? null;
  const byId = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  /** The pane's unit: the selected one, else the root. */
  const current = app.orgUnitId ? byId.get(app.orgUnitId) ?? root : root;
  return { units, root, byId, current, isCompany: !app.orgUnitId || app.orgUnitId === root?.id };
}

function Avatar({ a, size = 22 }: { a?: Agent; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: 7, background: a ? grad(a.colors) : 'var(--panel-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.55, flex: 'none' }}>{a?.emoji ?? '?'}</span>;
}

export function OrganizationView() {
  const app = useApp();
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const wsId = app.workspaceId;
  const reload = useCallback(async () => {
    if (!wsId) { setOrg(null); return; }
    try { setOrg(await api.org(wsId)); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    void app.refreshWsOrg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { const t = setInterval(() => { void reload(); }, 30_000); return () => clearInterval(t); }, [reload]);

  if (!app.companiesEnabled) return <div style={{ padding: 24, ...faint }}>Companies are disabled on this server (COMPANIES_ENABLED=false).</div>;
  if (!wsId || !org) return <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>{err ? <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{err}</div> : <div style={faint}>Loading…</div>}</div>;
  const mode = app.wsOrg?.mode ?? 'supervised';
  const ws = app.workspaces.find((w) => w.id === wsId);

  const toggle = async () => {
    try {
      if (org.status === 'active') { if (!confirm(`Pause ${org.name}? Every queued wake is dropped and in-flight runs are aborted.`)) return; await api.pauseOrg(wsId); } else await api.resumeOrg(wsId);
      await reload();
    } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  const view = app.orgPane ?? 'board';
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px 10px', borderBottom: '1px solid var(--border)' }}>
        {app.stacked && <button onClick={() => app.setMobileDetail(false)} style={{ ...btn(), padding: 6 }}><I d={P.chevL} size={14} /></button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={h2}>{ws?.name ?? org.name}</h2>
            <span style={pill(org.status === 'active' ? 'var(--green)' : 'var(--red)', '#fff')}>{org.status}</span>
            <span title={mode === 'autonomous' ? 'The chief of staff hires, reorganizes and allocates within caps on its own' : 'Structural changes are approvals you decide'} style={pill()}>{mode}</span>
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
        {view === 'audit' && <Audit org={org} />}
        {view === 'brief' && <BriefView org={org} mode={mode} />}
      </div>
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
  const { units } = useUnits();
  const unitByLead = useMemo(() => new Map(units.map((u) => [u.leadAgentId, u])), [units]);
  const openUnit = (u: OrgUnitNode, pane: 'board' | 'goals') => { app.setOrgUnitId(u.parentUnitId === null ? null : u.id); app.setOrgPane(pane); };
  const tree = (parent: string | null, depth: number): React.ReactNode => live.filter((m) => m.reportsToAgentId === parent).map((m) => {
    const a = names.get(m.agentId);
    const drift = org.charterDrift.find((d) => d.agentId === m.agentId);
    const sc = safeJsonParse<string[]>(m.scopes, []);
    const isChief = m.agentId === org.chiefOfStaffAgentId;
    const unit = unitByLead.get(m.agentId);
    const node = (
      <div key={m.id} style={{ marginBottom: 8 }}>
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
              {drift && <button style={btn()} onClick={() => void act(() => api.acceptOrgCharter(org.workspaceId, m.agentId))}>Accept charter</button>}
              <button style={btn()} onClick={() => { setEditing(m.agentId); setEditScopes(sc.join(', ')); }}>Scopes</button>
              {!isChief && <button style={btn()} onClick={() => void act(() => m.status === 'active' ? api.pauseOrgMember(org.workspaceId, m.agentId) : api.resumeOrgMember(org.workspaceId, m.agentId))}>{m.status === 'active' ? 'Pause' : 'Resume'}</button>}
              {!isChief && <button style={btn(false, true)} onClick={() => { if (confirm(`Terminate ${a?.name}? Its reports move up one level; the agent itself stays.`)) void act(() => api.terminateOrgMember(org.workspaceId, m.agentId)); }}>Terminate</button>}
            </div>
          </div>
          {editing === m.agentId && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input value={editScopes} onChange={(e) => setEditScopes(e.target.value)} style={input} placeholder="tool:fs_read, connection:gmail:read, folder:shared/notes" />
              <button style={btn(true)} onClick={() => void act(async () => { await api.setOrgMemberScopes(org.workspaceId, m.agentId, editScopes.split(',').map((s) => s.trim()).filter(Boolean)); setEditing(null); })}>Save</button>
              <button style={btn()} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          )}
        </div>
        <div style={{ marginLeft: 22 }}>{tree(m.agentId, depth + 1)}</div>
      </div>
    );
    if (!unit) return node;
    // A unit boundary (docs/group-chat.md §7): a subtle box around the lead and its reports, labelled with the unit and its channel.
    return (
      <div key={`unit-${unit.id}`} style={{ border: '1px dashed var(--border)', borderRadius: 12, padding: '6px 8px 0', marginBottom: 10, background: depth % 2 === 0 ? 'transparent' : 'var(--panel-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px 8px', fontSize: 11, color: 'var(--text-dim)' }}>
          <span style={{ fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', fontSize: 10 }}>{unit.parentUnitId === null ? 'Company' : 'Unit'}</span>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{unit.name}</span>
          <button onClick={() => app.openChannel(unit.slug)} title="Open the unit channel" style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', padding: 0, fontSize: 11, fontWeight: 600 }}>#{unit.slug}</button>
          <span style={{ flex: 1 }} />
          <span style={faint}>{unit.counts.openTasks} open · {unit.counts.goals} goal(s)</span>
          <button style={{ ...btn(), padding: '2px 7px', fontSize: 11 }} onClick={() => openUnit(unit, 'board')}>Board</button>
          <button style={{ ...btn(), padding: '2px 7px', fontSize: 11 }} onClick={() => openUnit(unit, 'goals')}>Goals</button>
        </div>
        {node}
      </div>
    );
  });
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><h2 style={h2}>Org chart</h2><div style={faint}>You → chief of staff → specialists. Depth ≤ {org.maxDepth}, ≤ {org.maxDirectReports} direct reports. Scopes are what a member may touch and never exceed the chief's own. Every member with reports leads a unit (a board, a channel, goals) — the dashed boxes. Mode, chief and caps: Settings → Workspace → Organization.</div></div>
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
            <button style={btn(true)} disabled={!agentId} onClick={() => void act(async () => { await api.addOrgMember(org.workspaceId, { agentId, title, reportsToAgentId: reportsTo, scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean) }); setAdding(false); setAgentId(''); })}>Add</button>
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
    const h = await api.orgHumans(org.workspaceId).catch(() => null);
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
                  <select value={h.role} onChange={(e) => void act(() => api.setOrgHuman(org.workspaceId, h.memberAccountId, e.target.value as HumanRole))} style={{ ...input, width: 'auto', padding: '3px 6px' }}>
                    <option value="board">board</option><option value="observer">observer</option>
                  </select>
                  <button style={btn()} onClick={() => void act(() => api.removeOrgHuman(org.workspaceId, h.memberAccountId))}>Remove</button>
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
          <button style={btn(true)} disabled={!pick} onClick={() => void act(async () => { await api.setOrgHuman(org.workspaceId, pick, role); setPick(''); })}>Add</button>
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
  const app = useApp();
  const names = useAgentNames();
  const { units, root, byId, current, isCompany } = useUnits();
  const [tasks, setTasks] = useState<OrgTask[]>([]);
  const [open, setOpen] = useState<OrgTask | null>(null);
  const [adding, setAdding] = useState(false);
  const [showCold, setShowCold] = useState(false);
  // The company board rolls up by default (every task); a unit board shows its own tasks until asked to roll up (docs/group-chat.md §7).
  const [rollUp, setRollUp] = useState<Record<string, boolean>>({});
  const unitKey = current?.id ?? 'all';
  const rolled = rollUp[unitKey] ?? isCompany;
  const reload = useCallback(async () => {
    const opts = !current ? {} : rolled && isCompany ? {} : { unitId: current.id, rollUp: rolled };
    setTasks(await api.orgTasks(org.workspaceId, opts).catch(() => []));
  }, [org.workspaceId, current, rolled, isCompany]);
  useEffect(() => { void reload(); const t = setInterval(() => { void reload(); }, 15_000); return () => clearInterval(t); }, [reload]);
  const cols = ORG_TASK_STATUSES.filter((s) => showCold || (s !== 'done' && s !== 'cancelled'));
  const members = org.members.filter((m) => m.status === 'active');
  const lead = current ? names.get(current.leadAgentId) : undefined;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <h2 style={h2}>{isCompany ? 'Board' : `${current?.name ?? 'Unit'} · board`}</h2>
          <div style={faint}>
            {isCompany ? 'One owner per task. Assigning wakes the owner; a comment wakes the owner; mentions wake nobody.' : <>Led by {lead?.name ?? '—'} · tasks of its reports, and what the lead hands them.</>}
            {current && <> · <span style={{ color: 'var(--accent-hi)', cursor: 'pointer' }} onClick={() => app.openChannel(current.slug)}>#{current.slug}</span></>}
          </div>
        </div>
        <label style={{ ...faint, display: 'flex', gap: 5, alignItems: 'center' }} title={isCompany ? 'Every unit\'s tasks, or only the company\'s own' : 'Include the units below this one'}><input type="checkbox" checked={rolled} onChange={(e) => setRollUp({ ...rollUp, [unitKey]: e.target.checked })} />roll up</label>
        <label style={{ ...faint, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={showCold} onChange={(e) => setShowCold(e.target.checked)} />done & cancelled</label>
        <button style={btn(true)} onClick={() => setAdding(true)}>New task</button>
      </div>
      {units.length > 1 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
          {units.map((u) => {
            const active = (u.parentUnitId === null && isCompany) || (u.parentUnitId !== null && app.orgUnitId === u.id);
            const a = names.get(u.leadAgentId);
            return (
              <button key={u.id} onClick={() => app.setOrgUnitId(u.parentUnitId === null ? null : u.id)} title={`${u.counts.openTasks} open task(s)`}
                style={{ ...pill(active ? 'var(--accent)' : 'var(--panel-2)', active ? '#fff' : 'var(--text)'), display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', cursor: 'pointer', marginLeft: u.depth > 1 ? (u.depth - 1) * 6 : 0 }}>
                {u.parentUnitId === null ? '🏢' : <Avatar a={a} size={14} />}{u.parentUnitId === null ? 'Company' : u.name}<span style={{ opacity: .7 }}>{u.counts.openTasks}</span>
              </button>
            );
          })}
        </div>
      )}
      {adding && <NewTask org={org} members={members} units={units} defaultUnitId={isCompany ? '' : current?.id ?? ''} onDone={() => { setAdding(false); void reload(); }} />}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols.length}, minmax(150px, 1fr))`, gap: 8, overflowX: 'auto' }}>
        {cols.map((s) => (
          <div key={s} style={{ background: 'var(--panel-2)', borderRadius: 10, padding: 8, minHeight: 120 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: STATUS_COLOR[s], marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}><span>{s.replace('_', ' ')}</span><span>{tasks.filter((t) => t.status === s).length}</span></div>
            {tasks.filter((t) => t.status === s).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((t) => {
              const a = t.assigneeAgentId ? names.get(t.assigneeAgentId) : undefined;
              const unit = t.unitId ? byId.get(t.unitId) : root;
              const foreign = unit && unit.id !== current?.id;
              return (
                <div key={t.id} onClick={() => setOpen(t)} style={{ ...card, padding: '8px 10px', marginBottom: 6, cursor: 'pointer' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>{t.title}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    {a ? <span style={{ ...pill(), display: 'inline-flex', gap: 4, alignItems: 'center' }}><Avatar a={a} size={14} />{a.name}</span> : <span style={pill()}>unassigned</span>}
                    {foreign && unit && <span style={pill()} title={`On the board of ${unit.name}`}>{unit.parentUnitId === null ? 'company' : unit.name}</span>}
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

function NewTask({ org, members, units, defaultUnitId, onDone }: { org: OrgDetail; members: OrgMember[]; units: Array<OrgUnitNode & { depth: number }>; defaultUnitId: string; onDone: () => void }) {
  const app = useApp();
  const names = useAgentNames();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState<OrgTaskBrief>({ outcome: '', context: '', constraints: '', done_when: '' });
  const [assignee, setAssignee] = useState('');
  const [projectId, setProjectId] = useState('');
  const [unitId, setUnitId] = useState(defaultUnitId);
  const save = async () => {
    try { await api.addOrgTask(org.workspaceId, { title, brief, assigneeAgentId: assignee || null, projectId: projectId || null, unitId: unitId || undefined }); onDone(); }
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
        {units.length > 1 && <select value={unitId} onChange={(e) => setUnitId(e.target.value)} style={input} title="Which unit's board; by default the one led by the assignee's manager"><option value="">Board: by assignee</option>{units.map((u) => <option key={u.id} value={u.id}>{'· '.repeat(u.depth)}{u.parentUnitId === null ? 'Company' : u.name}</option>)}</select>}
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
    const [c, r] = await Promise.all([api.orgTaskComments(org.workspaceId, task.id).catch(() => []), api.orgTaskRuns(org.workspaceId, task.id).catch(() => [])]);
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
          <select value="" onChange={(e) => { if (e.target.value) void act(() => api.assignOrgTask(org.workspaceId, task.id, e.target.value)); }} style={{ ...input, width: 'auto' }}><option value="">Assign to…</option>{members.map((m) => <option key={m.id} value={m.agentId}>{names.get(m.agentId)?.name}</option>)}</select>
          {task.assigneeAgentId && !['done', 'cancelled'].includes(task.status) && <button style={btn()} onClick={() => void act(() => api.wakeOrgTask(org.workspaceId, task.id, true))}>Wake now</button>}
          {task.status === 'in_review' && <><button style={btn(true)} onClick={() => void act(() => api.reviewOrgTask(org.workspaceId, task.id, 'accept', note))}>Accept</button><button style={btn()} onClick={() => void act(() => api.reviewOrgTask(org.workspaceId, task.id, 'request_changes', note || 'changes requested'))}>Request changes</button></>}
          {task.status === 'blocked' && <button style={btn()} onClick={() => void act(() => api.updateOrgTask(org.workspaceId, task.id, { status: 'todo', blockers: [] }))}>Unblock → todo</button>}
          {!['done', 'cancelled'].includes(task.status) && <button style={btn(false, true)} onClick={() => void act(() => api.updateOrgTask(org.workspaceId, task.id, { status: 'cancelled' }))}>Cancel task</button>}
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
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment — wakes the owner" style={input} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { void act(async () => { await api.commentOrgTask(org.workspaceId, task.id, text.trim()); setText(''); }); } }} />
            <button style={btn(true)} disabled={!text.trim()} onClick={() => void act(async () => { await api.commentOrgTask(org.workspaceId, task.id, text.trim()); setText(''); })}>Post</button>
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
  const names = useAgentNames();
  const { units, root, byId, current, isCompany } = useUnits();
  const [tree, setTree] = useState<OrgGoalNode[]>([]);
  const [adding, setAdding] = useState<{ parentGoalId: string } | null>(null);
  const refresh = useCallback(async () => { setTree(await api.orgGoalTree(org.workspaceId, isCompany ? null : current?.id).catch(() => [])); }, [org.id, current?.id, isCompany]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(t); }, [refresh]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); await reload(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  const flat: OrgGoalNode[] = [];
  const walk = (nodes: OrgGoalNode[]) => { for (const g of nodes) { flat.push(g); walk(g.children); } };
  walk(tree);
  const count = (nodes: OrgGoalNode[]): number => nodes.reduce((n, g) => n + 1 + count(g.children), 0);
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <h2 style={h2}>{isCompany ? 'Goals' : `${current?.name ?? 'Unit'} · goals`}</h2>
          <div style={faint}>Progress is computed: done ÷ linked tasks, averaged with the children. Status is yours to set. The chief proposes strategies you approve; unit leads add goals under ones they can see.{current && !isCompany && <> · <span style={{ color: 'var(--accent-hi)', cursor: 'pointer' }} onClick={() => app.openChannel(current.slug)}>#{current.slug}</span></>}</div>
        </div>
        <button style={btn(true)} onClick={() => setAdding(adding ? null : { parentGoalId: '' })}>Add goal</button>
      </div>
      {units.length > 1 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
          {units.map((u) => {
            const active = (u.parentUnitId === null && isCompany) || (u.parentUnitId !== null && app.orgUnitId === u.id);
            return <button key={u.id} onClick={() => app.setOrgUnitId(u.parentUnitId === null ? null : u.id)} style={{ ...pill(active ? 'var(--accent)' : 'var(--panel-2)', active ? '#fff' : 'var(--text)'), display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', cursor: 'pointer' }}>{u.parentUnitId === null ? '🏢 Company' : <><Avatar a={names.get(u.leadAgentId)} size={14} />{u.name}</>}<span style={{ opacity: .7 }}>{u.counts.goals}</span></button>;
          })}
        </div>
      )}
      {adding && <NewGoal org={org} units={units} defaultUnitId={isCompany ? (root?.id ?? '') : (current?.id ?? '')} parents={flat} parentGoalId={adding.parentGoalId} onDone={() => { setAdding(null); void act(async () => undefined); }} />}
      {tree.length === 0 && <div style={faint}>No goals {isCompany ? 'yet' : 'in this unit yet'}.</div>}
      {tree.map((g) => <GoalRow key={g.id} g={g} org={org} depth={0} names={names} unitOf={(id) => (id ? byId.get(id) : root) ?? root} currentUnitId={current?.id ?? null} act={act} addChild={(parentGoalId) => setAdding({ parentGoalId })} />)}
      {flat.length > 0 && <div style={{ ...faint, marginTop: 10 }}>{count(tree)} goal(s) · reference one in a channel as <code>#goal:&lt;id&gt;</code> and it shows up under the goal.</div>}
    </div>
  );
}

function NewGoal({ org, units, defaultUnitId, parents, parentGoalId, onDone }: { org: OrgDetail; units: Array<OrgUnitNode & { depth: number }>; defaultUnitId: string; parents: OrgGoalNode[]; parentGoalId: string; onDone: () => void }) {
  const app = useApp();
  const names = useAgentNames();
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [parent, setParent] = useState(parentGoalId);
  const [unitId, setUnitId] = useState(() => (parentGoalId ? (parents.find((p) => p.id === parentGoalId)?.unitId ?? defaultUnitId) : defaultUnitId));
  const [owner, setOwner] = useState('');
  const save = async () => {
    try {
      await api.addOrgGoal(org.workspaceId, { title, description: desc, unitId: unitId || null, parentGoalId: parent || null, ownerAgentId: owner || null });
      onDone();
    } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  return (
    <div style={{ ...card, display: 'grid', gap: 8, marginBottom: 12 }}>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Goal" style={input} onKeyDown={(e) => { if (e.key === 'Enter' && title.trim()) void save(); }} />
      <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Why / what success looks like" style={input} />
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr 1fr' }}>
        <select value={parent} onChange={(e) => setParent(e.target.value)} style={input}><option value="">Top-level goal</option>{parents.map((p) => <option key={p.id} value={p.id}>under: {p.title}</option>)}</select>
        <select value={unitId} onChange={(e) => setUnitId(e.target.value)} style={input}>{units.map((u) => <option key={u.id} value={u.id}>{'· '.repeat(u.depth)}{u.parentUnitId === null ? 'Company' : u.name}</option>)}</select>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} style={input}><option value="">No owner</option>{org.members.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.agentId}>owner: {names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)}</option>)}</select>
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}><button style={btn()} onClick={onDone}>Cancel</button><button style={btn(true)} disabled={!title.trim()} onClick={() => void save()}>Add</button></div>
    </div>
  );
}

/** One goal of the tracker: progress bar, owner, unit, linked tasks and
 *  messages, inline status, "add child"; children indented below. */
function GoalRow({ g, org, depth, names, unitOf, currentUnitId, act, addChild }: { g: OrgGoalNode; org: OrgDetail; depth: number; names: Map<string, Agent>; unitOf: (id: string | null) => OrgUnitNode | null; currentUnitId: string | null; act: (fn: () => Promise<unknown>) => Promise<void>; addChild: (parentGoalId: string) => void }) {
  const app = useApp();
  const [showMsgs, setShowMsgs] = useState(false);
  const [msgs, setMsgs] = useState<Array<ChannelMessage & { slug: string }> | null>(null);
  const [project, setProject] = useState('');
  const owner = g.ownerAgentId ? names.get(g.ownerAgentId) : undefined;
  const unit = unitOf(g.unitId);
  const pct = Math.round(g.progress * 100);
  const color = g.status === 'achieved' ? 'var(--green)' : g.status === 'abandoned' ? 'var(--text-faint)' : pct >= 100 ? 'var(--green)' : pct > 0 ? 'var(--accent)' : 'var(--border)';
  useEffect(() => { if (showMsgs && msgs === null) void api.goalMessages(org.workspaceId, g.id).then(setMsgs).catch(() => setMsgs([])); }, [showMsgs, msgs, org.workspaceId, g.id]);
  const projects = org.projects.filter((p) => p.goalId === g.id);
  return (
    <div style={{ marginLeft: depth * 18, marginBottom: 8 }}>
      <div style={{ ...card, padding: '10px 12px', borderLeft: `3px solid ${color}`, opacity: g.status === 'abandoned' ? .6 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span>{g.title}</span>
              <span style={{ ...faint, fontFamily: 'var(--mono)', fontSize: 10.5 }} title="Reference it in a channel">#goal:{g.id.slice(0, 8)}</span>
              {unit && unit.id !== currentUnitId && <span style={pill()} title="Unit">{unit.parentUnitId === null ? 'company' : unit.name}</span>}
              {owner && <span style={{ ...pill(), display: 'inline-flex', gap: 4, alignItems: 'center' }}><Avatar a={owner} size={14} />{owner.name}</span>}
            </div>
            {g.description && <div style={faint}>{g.description}</div>}
          </div>
          <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: 'var(--mono)', color }}>{pct}%</span>
          <select value={g.status} onChange={(e) => void act(() => api.updateOrgGoal(org.workspaceId, g.id, { status: e.target.value }))} style={{ ...input, width: 'auto', padding: '3px 6px' }}>{['draft', 'active', 'achieved', 'abandoned'].map((s) => <option key={s}>{s}</option>)}</select>
        </div>
        <div style={{ height: 6, background: 'var(--panel-2)', borderRadius: 3, marginTop: 8, overflow: 'hidden' }}><div style={{ width: `${Math.min(100, pct)}%`, height: 6, background: color, transition: 'width .3s' }} /></div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 7, flexWrap: 'wrap', ...faint }}>
          <span title="Tasks linked through this goal's projects">{g.tasks.done}/{g.tasks.total} task(s) done</span>
          {g.children.length > 0 && <span>{g.children.length} child goal(s)</span>}
          <button onClick={() => setShowMsgs(!showMsgs)} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', padding: 0, fontSize: 12 }}>{showMsgs ? 'hide messages' : `messages${msgs ? ` (${msgs.length})` : ''}`}</button>
          <button onClick={() => addChild(g.id)} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', padding: 0, fontSize: 12 }}>+ child goal</button>
          <span style={{ flex: 1 }} />
          {projects.map((p) => <span key={p.id} style={pill()}>▸ {p.title}</span>)}
        </div>
        {showMsgs && (
          <div style={{ marginTop: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 6 }}>
            {msgs === null && <div style={faint}>Loading…</div>}
            {msgs && msgs.length === 0 && <div style={faint}>No channel message references this goal yet — write <code>#goal:{g.id.slice(0, 8)}</code> in one.</div>}
            {msgs?.map((m) => (
              <div key={m.id} onClick={() => app.openChannel(m.slug, m.id)} style={{ fontSize: 12.5, padding: '4px 0', cursor: 'pointer', display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--accent-hi)', fontWeight: 600, flex: 'none' }}>#{m.slug}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.text}</span>
                <span style={faint}>{ago(m.createdAt)}</span>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="New project under this goal (tasks link through projects)" style={input} />
              <button style={btn()} disabled={!project.trim()} onClick={() => void act(async () => { await api.addOrgProject(org.workspaceId, { title: project, goalId: g.id }); setProject(''); })}>Add</button>
            </div>
          </div>
        )}
      </div>
      {g.children.map((c) => <GoalRow key={c.id} g={c} org={org} depth={depth + 1} names={names} unitOf={unitOf} currentUnitId={currentUnitId} act={act} addChild={addChild} />)}
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
    setRows(await api.orgApprovals(org.workspaceId).catch(() => []));
    const h = await api.orgHumans(org.workspaceId).catch(() => null);
    if (h) setHumans({ me: h.me.role, board: h.humans.filter((x) => x.role === 'board').map((x) => x.memberAccountId) });
  }, [org.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const BOARD_KINDS = new Set(['hire', 'budget_raise', 'strategy']);
  /** Who may decide this card (docs/autonomous-company.md phase D). */
  const deciders = (kind: string) => (BOARD_KINDS.has(kind) && humans.board.length > 0 ? `CEO or board (${humans.board.map((b) => app.nameOf(b)).join(', ')})` : 'CEO only');
  const mayDecide = (kind: string) => humans.me === 'ceo' || (humans.me === 'board' && BOARD_KINDS.has(kind));
  const decide = async (a: OrgApproval, d: 'approve' | 'reject' | 'revise') => {
    try { await api.decideOrgApproval(org.workspaceId, a.id, d, notes[a.id]); await refresh(); await reload(); await app.refreshAgents(); app.showToast(`${a.kind}: ${d}d`); }
    catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  const pending = rows.filter((r) => r.status === 'pending');
  const shown = history ? rows.filter((r) => r.status !== 'pending').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) : pending;
  const nm = (id: unknown) => (typeof id === 'string' ? names.get(id)?.name ?? id.slice(0, 8) : '—');
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><h2 style={h2}>Approvals · {pending.length} pending</h2><div style={faint}>The full artifact, not a summary. Only a human decides here — the CEO, or a board member for hires, budgets and strategy; an agent's message never counts. Unanswered cards expire after 72 h ("not done"). In autonomous mode only strategy, escalations and external actions still arrive here.</div></div>
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
  const refresh = useCallback(async () => setSpend(await api.orgSpend(org.workspaceId).catch(() => null)), [org.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const setCap = async (scope: 'company' | 'agent' | 'project', refId: string) => {
    try { await api.setOrgBudget(org.workspaceId, { scope, refId, monthlyUsd: Number(caps[refId] ?? 0) }); await refresh(); await reload(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
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

// ---- audit ----

function Audit({ org }: { org: OrgDetail }) {
  const names = useAgentNames();
  const [runs, setRuns] = useState<OrgRun[]>([]);
  const [tasks, setTasks] = useState<OrgTask[]>([]);
  const [audit, setAudit] = useState<OrgAuditRow[]>([]);
  const [verify, setVerify] = useState<{ ok: boolean; length: number; brokenAt: number | null; reason?: string } | null>(null);
  const [layer, setLayer] = useState<'runs' | 'audit'>('runs');
  useEffect(() => {
    void Promise.all([api.orgRuns(org.workspaceId).catch(() => []), api.orgTasks(org.workspaceId).catch(() => []), api.orgAudit(org.workspaceId, 150).catch(() => []), api.verifyOrgAudit(org.workspaceId).catch(() => null)])
      .then(([r, t, a, v]) => { setRuns(r); setTasks(t); setAudit(a); setVerify(v); });
  }, [org.id]);
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><h2 style={h2}>Audit</h2><div style={faint}>Runs and their outcomes, and the hash-chained log of every change — including what the chief did on its own in autonomous mode (<code>auto_*</code> rows carry its reason).</div></div>
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

// ---- brief ----

function BriefView({ org, mode }: { org: OrgDetail; mode: string }) {
  const app = useApp();
  const [brief, setBrief] = useState<OrgBrief | null>(null);
  const [reply, setReply] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const refresh = useCallback(async () => setBrief(await api.orgBrief(org.workspaceId).catch(() => null)), [org.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const compose = async () => { try { setBrief(await api.composeOrgBrief(org.workspaceId)); setResult(null); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  const review = async () => { try { const r = await api.reviewOrgStructure(org.workspaceId); app.showToast(r.result === 'ran' ? 'The chief reviewed the structure — see Audit and #company' : `Review ${r.result}`); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  const send = async () => {
    try {
      const r = await api.replyOrgBrief(org.workspaceId, reply);
      setResult(`${r.decisions.map((d) => `#${d.n} ${d.decision} → ${d.status}`).join(' · ') || 'nothing resolved'}${r.unresolved.length ? ` · unresolved: ${r.unresolved.join(', ')}` : ''}`);
      setReply(''); await app.refreshAgents(); await refresh();
    } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><h2 style={h2}>Brief</h2><div style={faint}>Written daily at {String(org.briefHour).padStart(2, '0')}:00 (workspace time, quiet hours respected) and pushed to your channels. Answer the numbered decisions in one line.{mode === 'autonomous' ? ' In autonomous mode it also lists what the chief did on its own since the last brief, and the chief reviews the structure at this hour.' : ''}</div></div>
        {mode === 'autonomous' && <button style={btn()} title="Wake the chief of staff now to review idle and overloaded members, unassigned goals and blocked tasks" onClick={() => void review()}>Review structure now</button>}
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
