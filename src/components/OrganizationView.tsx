/** The organization panes of a workspace (docs/group-chat.md §5, execution
 *  plan items 14 and 16): the workspace *is* the company, so these render in
 *  the Workspace section when organization mode is on — the shared board,
 *  goals, the org chart, the approvals queue (full artifact, never a
 *  summary), spend vs envelopes, the brief with its one-reply input, and the
 *  audit (runs and the hash-chained log). Enabling, the mode, the chief and
 *  the caps live in Settings → Workspace → Organization; the group log moved
 *  to the `#company` channel. */
import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { useApp, type OrgPane } from '../store';
import { tabsOf } from '../lib/inbox';
import { hopLine, inReviewBelow, managerHops, waitsOnViewer } from '../lib/decisions';
import { orgTaskHash, taskOfHash } from '../lib/links';
import { isTaskKey, keyStyle, matchesTaskRef } from '../lib/task-keys';
import {
  api, ORG_TASK_STATUSES, type Agent, type ChannelMessage, type HumanRole, type OrgApproval, type OrgAuditRow, type OrgBrief, type OrgDetail, type OrgGoalNode, type OrgHuman, type OrgMember, type OrgMessage, type OrgRun,
  type OrgSpend, type OrgTask, type OrgTaskBrief, type OrgTaskStatus, type OrgUnitNode, type WorkspaceMember, type TaskCheck, type OrgDelegation, type CardEval,
} from '../lib/api';
import { safeJsonParse } from '../lib/util';
import { fmtUsd } from '../lib/pricing';
import { UsageBars, UsageRows } from './UsageChart';
import { I, P } from '../lib/icons';
import { card, input, btn, pill, h2, faint, ago, useAgentNames, useUnits, useFollowRef, Avatar, DecisionExtras } from './org-ui';
import { changeSummary, decidedViaBadge, dueBadge, expectedLabel, memberSettingsLines, verificationBadge } from '../lib/org3';
import { FollowToggle } from './FollowToggle';

/** The CEO's-seat panes (docs/company-vision.md §8, items 18–20) load on demand. */
const VisionPane = lazy(() => import('./OrgVisionView').then((m) => ({ default: m.VisionPane })));
const PulsePane = lazy(() => import('./OrgPulseView').then((m) => ({ default: m.PulsePane })));
const MeetingsPane = lazy(() => import('./OrgMeetingsView').then((m) => ({ default: m.MeetingsPane })));
const DecisionsPane = lazy(() => import('./OrgMeetingsView').then((m) => ({ default: m.DecisionsPane })));
const WhyDrawer = lazy(() => import('./OrgVisionView').then((m) => ({ default: m.WhyDrawer })));
/** Memory, capital, blueprints and hybrid staff (items 22–24); playbooks are files under /org/playbooks/ in Artifacts. */
const RelatedDrawer = lazy(() => import('./OrgMemoryView').then((m) => ({ default: m.RelatedDrawer })));
const PlansPane = lazy(() => import('./OrgCapitalView').then((m) => ({ default: m.PlansPane })));
const ReplayPane = lazy(() => import('./OrgCapitalView').then((m) => ({ default: m.ReplayPane })));
const CapitalPane = lazy(() => import('./OrgCapitalView').then((m) => ({ default: m.CapitalPane })));
const MyTasksPane = lazy(() => import('./OrgPeopleView').then((m) => ({ default: m.MyTasksPane })));
const HireDialog = lazy(() => import('./OrgPeopleView').then((m) => ({ default: m.HireDialog })));
/** The org chart's mission control (docs/mission-control.md). */
const MissionControlPane = lazy(() => import('./OrgMissionControl').then((m) => ({ default: m.MissionControlPane })));
/** Sensing checks, the trust ledger and incidents (items 27–30, SPA item 32); metrics and experiments are files under /org/ in Artifacts. */
const TaskChecksPanel = lazy(() => import('./OrgSensingView').then((m) => ({ default: m.TaskChecksPanel })));
const ChecksBuilder = lazy(() => import('./OrgSensingView').then((m) => ({ default: m.ChecksBuilder })));
const IncidentsPane = lazy(() => import('./OrgIncidentsView').then((m) => ({ default: m.IncidentsPane })));
const HeldActions = lazy(() => import('./OrgTrustView').then((m) => ({ default: m.HeldActions })));
const ActionCallPreview = lazy(() => import('./OrgTrustView').then((m) => ({ default: m.ActionCallPreview })));
/** Capacity and the cards' eval line (item 31); evals and outcomes are files under /org/ in Artifacts. */
const CapacityStrip = lazy(() => import('./OrgGovernanceView').then((m) => ({ default: m.CapacityStrip })));
const CardEvalLine = lazy(() => import('./OrgGovernanceView').then((m) => ({ default: m.CardEvalLine })));
const LAZY_PANES = new Set(['vision', 'pulse', 'meetings', 'decisions', 'plans', 'replay', 'capital', 'mytasks', 'incidents']);

const STATUS_COLOR: Record<OrgTaskStatus, string> = {
  backlog: 'var(--text-faint)', waiting: 'var(--text-dim)', todo: 'var(--blue)', claimed: 'var(--amber)', in_progress: 'var(--amber)', in_review: 'var(--accent)', blocked: 'var(--red)', done: 'var(--green)', cancelled: 'var(--text-faint)',
};

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
        <PaneTabs view={view} />
        {view === 'chart' && <OrgChart org={org} reload={reload} />}
        {view === 'board' && <Board org={org} />}
        {view === 'goals' && <Goals org={org} reload={reload} />}
        {view === 'approvals' && <Approvals org={org} reload={reload} />}
        {view === 'spend' && <Spend org={org} reload={reload} />}
        {view === 'audit' && <Audit org={org} />}
        {view === 'brief' && <BriefView org={org} mode={mode} />}
        {LAZY_PANES.has(view) && (
          <Suspense fallback={<div style={faint}>Loading…</div>}>
            {view === 'vision' && <VisionPane org={org} reload={reload} />}
            {view === 'pulse' && <PulsePane org={org} />}
            {view === 'meetings' && <MeetingsPane org={org} />}
            {view === 'decisions' && <DecisionsPane org={org} />}
            {view === 'plans' && <PlansPane org={org} />}
            {view === 'replay' && <ReplayPane org={org} />}
            {view === 'capital' && <CapitalPane org={org} />}
            {view === 'mytasks' && <MyTasksPane org={org} />}
            {view === 'incidents' && <IncidentsPane org={org} />}
          </Suspense>
        )}
      </div>
    </div>
  );
}

/** Merged panes (src/lib/inbox.ts COMPANY_GROUPS): Pulse | Brief, Spend | Capital, Audit | Replay. */
const TAB_LABEL: Partial<Record<OrgPane, string>> = { pulse: 'Pulse', brief: 'Brief', spend: 'Spend', capital: 'Capital', audit: 'Audit', replay: 'Replay' };
function PaneTabs({ view }: { view: OrgPane }) {
  const app = useApp();
  const tabs = tabsOf(view);
  if (!tabs) return null;
  return (
    <div role="tablist" style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '1px solid var(--border-soft)' }}>
      {tabs.map((t) => (
        <button key={t} role="tab" aria-selected={t === view} onClick={() => app.setOrgPane(t)}
          style={{ background: 'none', border: 'none', borderBottom: `2px solid ${t === view ? 'var(--accent)' : 'transparent'}`, color: t === view ? 'var(--text)' : 'var(--text-dim)', padding: '6px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
          {TAB_LABEL[t] ?? t}
        </button>
      ))}
    </div>
  );
}

// ---- org chart ----

/** The org chart opens as mission control (docs/mission-control.md); the
 *  structure editor below is one click away ("Edit structure"). */
function OrgChart({ org, reload }: { org: OrgDetail; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <div>
        <button style={{ ...btn(), marginBottom: 12 }} onClick={() => setEditing(false)}>Back to mission control</button>
        <OrgStructure org={org} reload={reload} />
      </div>
    );
  }
  return <Suspense fallback={<div style={faint}>Loading…</div>}><MissionControlPane org={org} onEditStructure={() => setEditing(true)} /></Suspense>;
}

/** The structure editor: members with their scopes, pause and terminate, add and hire, the humans, unit boundaries. */
function OrgStructure({ org, reload }: { org: OrgDetail; reload: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [adding, setAdding] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [title, setTitle] = useState('');
  const [reportsTo, setReportsTo] = useState(org.chiefOfStaffAgentId ?? '');
  const [scopes, setScopes] = useState('tool:fs_read, tool:fs_write');
  const [editing, setEditing] = useState<string | null>(null);
  const [editScopes, setEditScopes] = useState('');
  const [hiring, setHiring] = useState(false);
  // Hybrid staff (item 24): employees hang under the member they report to, with a person badge.
  const [humans, setHumans] = useState<OrgHuman[]>([]);
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
        <div style={{ marginLeft: 22 }}>
          {humans.filter((h) => h.role === 'employee' && h.reportsToAgentId === m.agentId).map((h) => (
            <div key={h.id} style={{ ...card, padding: '8px 12px', marginBottom: 8, borderLeft: '3px solid var(--blue)', display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ width: 22, height: 22, borderRadius: 7, background: 'var(--panel-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>🧑</span>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{app.nameOf(h.memberAccountId)}</span>
                <span style={pill('var(--blue)', '#fff')} title="A human employee: takes task cards, reviews, sits in the unit channel">person</span>
                <span style={pill()}>{h.title || 'employee'}</span>
              </div>
            </div>
          ))}
          {tree(m.agentId, depth + 1)}
        </div>
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
        <button style={btn()} onClick={() => setAdding(!adding)} disabled={free.length === 0} title="Seat an existing agent of this workspace">Add member</button>
        <button style={btn(true)} onClick={() => setHiring(true)} title="Hire from the role catalog or a pack (a hire card in supervised mode)">Hire</button>
      </div>
      {hiring && <Suspense fallback={null}><HireDialog org={org} members={live} onClose={() => setHiring(false)} onDone={reload} /></Suspense>}
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
      <Humans org={org} onLoaded={setHumans} />
      {tree(null, 1)}
    </div>
  );
}

/** The humans of the company (phase D): the owner is CEO; members of the
 *  shared workspace can sit on the board (hire / budget / strategy
 *  approvals) or observe. Only the CEO changes this. */
function Humans({ org, onLoaded }: { org: OrgDetail; onLoaded?: (humans: OrgHuman[]) => void }) {
  const app = useApp();
  const names = useAgentNames();
  const [humans, setHumans] = useState<OrgHuman[]>([]);
  const [meRole, setMeRole] = useState<HumanRole | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<HumanRole>('board');
  const [empTitle, setEmpTitle] = useState('');
  const [empManager, setEmpManager] = useState(org.chiefOfStaffAgentId ?? '');
  const refresh = useCallback(async () => {
    const h = await api.orgHumans(org.workspaceId).catch(() => null);
    if (h) { setHumans(h.humans); setMeRole(h.me.role); onLoaded?.(h.humans); }
    setMembers(await api.workspaceMembers(org.workspaceId).catch(() => []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.id, org.workspaceId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const isCeo = meRole === 'ceo';
  const free = members.filter((m) => !humans.some((h) => h.memberAccountId === m.memberAccountId));
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  const ROLE_HINT: Record<HumanRole, string> = { ceo: 'everything', board: 'decides hire, budget and strategy approvals; gets the brief', observer: 'reads the company; decides nothing', employee: 'a hybrid staff member: takes task cards, reviews, sits in the unit channel (docs/company-vision.md §4)' };
  const live = org.members.filter((m) => m.status === 'active');
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
              <span style={pill(h.role === 'employee' ? 'var(--blue)' : undefined, h.role === 'employee' ? '#fff' : undefined)} title={ROLE_HINT[h.role]}>{h.role}{h.role === 'employee' && h.title ? ` · ${h.title}` : ''}</span>
              {h.role === 'employee' && h.reportsToAgentId && <span style={faint}>reports to {names.get(h.reportsToAgentId)?.name ?? h.reportsToAgentId.slice(0, 8)}</span>}
              {isCeo && (
                <>
                  <select value={h.role} onChange={(e) => void act(() => api.setOrgEmployee(org.workspaceId, { memberAccountId: h.memberAccountId, role: e.target.value as HumanRole, reportsToAgentId: e.target.value === 'employee' ? (h.reportsToAgentId ?? org.chiefOfStaffAgentId) : undefined, title: h.title }))} style={{ ...input, width: 'auto', padding: '3px 6px' }}>
                    <option value="board">board</option><option value="observer">observer</option><option value="employee">employee</option>
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
          <select value={role} onChange={(e) => setRole(e.target.value as HumanRole)} style={{ ...input, width: 'auto' }}><option value="board">board</option><option value="observer">observer</option><option value="employee">employee</option></select>
          {role === 'employee' && <input aria-label="Title" value={empTitle} onChange={(e) => setEmpTitle(e.target.value)} placeholder="Title" style={{ ...input, width: 120 }} />}
          {role === 'employee' && <select aria-label="Reports to" value={empManager} onChange={(e) => setEmpManager(e.target.value)} style={{ ...input, width: 'auto' }}>{live.map((m) => <option key={m.id} value={m.agentId}>reports to {names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)}</option>)}</select>}
          <button style={btn(true)} disabled={!pick || (role === 'employee' && !empManager)} onClick={() => void act(async () => { await api.setOrgEmployee(org.workspaceId, { memberAccountId: pick, role, reportsToAgentId: role === 'employee' ? empManager : undefined, title: role === 'employee' ? empTitle : undefined }); setPick(''); setEmpTitle(''); })}>Add</button>
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
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    const opts = !current ? {} : rolled && isCompany ? {} : { unitId: current.id, rollUp: rolled };
    setTasks(await api.orgTasks(org.workspaceId, opts).catch(() => []));
    setLoaded(true);
  }, [org.workspaceId, current, rolled, isCompany]);
  useEffect(() => { void reload(); const t = setInterval(() => { void reload(); }, 15_000); return () => clearInterval(t); }, [reload]);
  // A task link (#/ws/<id>/org/board?task=<id>), a signal row or a minutes
  // card asked for one task: open its drawer once the board has loaded, and
  // fetch the task when it is not on this board (another unit, or closed).
  const focusId = app.orgFocus?.kind === 'task' ? app.orgFocus.id : null;
  useEffect(() => {
    if (!focusId || !loaded) return;
    const t = tasks.find((x) => matchesTaskRef(x, focusId));
    app.setOrgFocus(null);
    // Opened from inside the app (a signal row, a minutes card): put it in the address too.
    if (taskOfHash(window.location.hash) !== focusId) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${orgTaskHash(org.workspaceId, focusId)}`);
    if (t) {
      setOpen(t); if (t.status === 'done' || t.status === 'cancelled') setShowCold(true);
      // A key or prefix in the address becomes the task's key (or id) once found.
      if (t.key && focusId !== t.key && focusId !== t.id) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${orgTaskHash(org.workspaceId, t.key)}`);
      return;
    }
    let live = true;
    api.orgTask(org.workspaceId, focusId)
      .then((found) => { if (live) setOpen(found); })
      .catch(() => { if (live) app.showToast(`Task ${isTaskKey(focusId) ? focusId.toUpperCase() : focusId.slice(0, 8)} was not found`); });
    return () => { live = false; };
  }, [focusId, loaded, tasks, app, org.workspaceId]);
  // The open drawer is in the address bar (back, forward and reload work);
  // the address moving off it (back) closes the drawer.
  const openTask = (t: OrgTask) => {
    setOpen(t);
    const hash = orgTaskHash(org.workspaceId, t.key || t.id);
    if (window.location.hash !== hash) window.history.pushState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  };
  const closeTask = () => {
    setOpen(null);
    if (taskOfHash(window.location.hash)) window.history.pushState(null, '', `${window.location.pathname}${window.location.search}`);
  };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const onHash = () => { if (!taskOfHash(window.location.hash)) setOpen(null); };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => {
      mounted.current = false;
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
      // Leaving the board: a task link left behind would reopen on reload.
      // (Deferred: StrictMode's remount is not a leave.)
      setTimeout(() => { if (!mounted.current && taskOfHash(window.location.hash)) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); }, 0);
    };
  }, []);
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
            {current && <> · <TaskKeyPrefix wsId={org.workspaceId} unitId={current.id} prefix={current.taskKey ?? null} /></>}
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
      <Suspense fallback={null}><CapacityStrip wsId={org.workspaceId} refreshKey={tasks.length} /></Suspense>
      {adding && <NewTask org={org} members={members} units={units} tasks={tasks} defaultUnitId={isCompany ? '' : current?.id ?? ''} onDone={() => { setAdding(false); void reload(); }} />}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols.length}, minmax(150px, 1fr))`, gap: 8, overflowX: 'auto' }}>
        {cols.map((s) => (
          <div key={s} style={{ background: 'var(--panel-2)', borderRadius: 10, padding: 8, minHeight: 120 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: STATUS_COLOR[s], marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}><span title={s === 'cancelled' ? 'Cancelled, or abandoned by its owner (the reason is on the timeline)' : s === 'waiting' ? 'Waiting on another task; cannot be claimed yet' : undefined}>{s === 'cancelled' ? 'cancelled · abandoned' : s.replace('_', ' ')}</span><span>{tasks.filter((t) => t.status === s).length}</span></div>
            {tasks.filter((t) => t.status === s).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((t) => {
              const a = t.assigneeAgentId ? names.get(t.assigneeAgentId) : undefined;
              const unit = t.unitId ? byId.get(t.unitId) : root;
              const foreign = unit && unit.id !== current?.id;
              return (
                <div key={t.id} onClick={() => openTask(t)} style={{ ...card, padding: '8px 10px', marginBottom: 6, cursor: 'pointer' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>{t.key && <span style={{ ...keyStyle, marginRight: 5 }}>{t.key}</span>}{t.title}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    {a ? <span style={{ ...pill(), display: 'inline-flex', gap: 4, alignItems: 'center' }}><Avatar a={a} size={14} />{a.name}</span> : t.assigneeHumanId ? <span style={pill('var(--blue)', '#fff')} title="A human employee owns this task">🧑 {app.nameOf(t.assigneeHumanId)}</span> : <span style={pill()}>unassigned</span>}
                    {t.class && t.class !== 'general' && <span style={pill()} title="Task class (routing, cost by class)">{t.class}</span>}
                    {foreign && unit && <span style={pill()} title={`On the board of ${unit.name}`}>{unit.parentUnitId === null ? 'company' : unit.name}</span>}
                    {t.claimedBy && <span style={pill('var(--amber)', '#fff')}>claimed</span>}
                    {t.reviewRounds > 0 && <span style={pill()}>review {t.reviewRounds}/3</span>}
                    {t.noProgressCount > 0 && <span style={pill()}>no progress ×{t.noProgressCount}</span>}
                    {t.status === 'in_review' && t.reviewerAgentId && <span style={pill()}>reviewer: {names.get(t.reviewerAgentId)?.name ?? '?'}</span>}
                    {(() => { const v = verificationBadge(t.verification); return v ? <span style={pill(v.color, '#fff')} title={v.title}>{v.label}</span> : null; })()}
                    {t.status !== 'done' && t.checks && t.checks !== '[]' && <span style={pill()} title="Executable checks run before review">checks</span>}
                    {(() => { const d = dueBadge(t.dueAt, t.status); return d ? <span style={pill(d.color, d.color === 'var(--panel-2)' ? 'var(--text-dim)' : '#fff')} title={d.title}>{d.label}</span> : null; })()}
                    {(t.waitingOn ?? []).map((id) => { const dep = tasks.find((x) => x.id === id); return <span key={id} style={pill()} title={`Waits on: ${dep?.title ?? id} (${dep?.status ?? 'unknown'})`}>⧗ {dep ? `${dep.key ? `${dep.key} ` : ''}${dep.title.slice(0, 18)}` : id.slice(0, 8)}</span>; })}
                    {t.status !== 'done' && t.status !== 'cancelled' && expectedLabel(t.expected) && <span style={{ ...pill(), opacity: .8 }} title={`Expected from ${t.expected?.samples} finished task(s) (${t.expected?.basis})`}>{expectedLabel(t.expected)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {open && <TaskDrawer org={org} task={tasks.find((t) => t.id === open.id) ?? open} members={members} onClose={closeTask} reload={reload} board={tasks} />}
    </div>
  );
}

function NewTask({ org, members, units, tasks, defaultUnitId, onDone }: { org: OrgDetail; members: OrgMember[]; units: Array<OrgUnitNode & { depth: number }>; tasks: OrgTask[]; defaultUnitId: string; onDone: () => void }) {
  const app = useApp();
  const names = useAgentNames();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState<OrgTaskBrief>({ outcome: '', context: '', constraints: '', done_when: '' });
  const [assignee, setAssignee] = useState('');
  const [projectId, setProjectId] = useState('');
  const [unitId, setUnitId] = useState(defaultUnitId);
  const [checks, setChecks] = useState<TaskCheck[]>([]);
  const [withChecks, setWithChecks] = useState(false);
  const [deps, setDeps] = useState<string[]>([]);
  const [due, setDue] = useState('');
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const save = async () => {
    try { await api.addOrgTask(org.workspaceId, { title, brief, assigneeAgentId: assignee || null, projectId: projectId || null, unitId: unitId || undefined, ...(checks.length ? { checks } : {}), ...(deps.length ? { dependsOn: deps } : {}), ...(due ? { dueAt: new Date(due).toISOString() } : {}) }); onDone(); }
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
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ ...faint, display: 'flex', gap: 5, alignItems: 'center' }}>Due <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} style={{ ...input, width: 'auto' }} aria-label="Due date" /></label>
        <select value="" onChange={(e) => { const v = e.target.value; if (v && !deps.includes(v)) setDeps([...deps, v]); }} style={{ ...input, width: 'auto', flex: '1 1 160px' }} aria-label="Depends on" title="It waits (and cannot be claimed) until these are done">
          <option value="">Depends on…</option>{open.filter((t) => !deps.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.title.slice(0, 60)} ({t.status})</option>)}
        </select>
        {deps.map((d) => <span key={d} style={{ ...pill(), display: 'inline-flex', gap: 4 }}>⧗ {tasks.find((t) => t.id === d)?.title.slice(0, 24) ?? d.slice(0, 8)}<button aria-label="Remove dependency" onClick={() => setDeps(deps.filter((x) => x !== d))} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>×</button></span>)}
      </div>
      {withChecks ? <Suspense fallback={<div style={faint}>Loading…</div>}><ChecksBuilder wsId={org.workspaceId} value={checks} onChange={setChecks} /></Suspense>
        : <button style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 600, justifySelf: 'start' }} onClick={() => setWithChecks(true)}>+ executable checks (accept without a model)</button>}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}><button style={btn()} onClick={onDone}>Cancel</button><button style={btn(true)} disabled={!title.trim()} onClick={() => void save()}>Create{assignee ? ' and wake' : ''}</button></div>
    </div>
  );
}

/** The board's task key prefix (docs/tasks-keys.md), editable by the owner:
 *  new tasks take the new prefix; existing keys stay. */
function TaskKeyPrefix({ wsId, unitId, prefix }: { wsId: string; unitId: string; prefix: string | null }) {
  const app = useApp();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(prefix ?? '');
  const save = async () => {
    try { await api.setOrgUnitTaskKey(wsId, unitId, value.trim()); setEditing(false); await app.refreshWsOrg(); app.showToast(`New tasks on this board are ${value.trim().toUpperCase()}-n`); }
    catch (err) { app.showToast(err instanceof Error ? err.message : String(err)); }
  };
  if (!editing) return <span title="Task keys on this board (new tasks take the next number)">keys <span style={keyStyle}>{prefix ? `${prefix}-n` : '—'}</span> <button type="button" aria-label="Change the task key prefix" onClick={() => { setValue(prefix ?? ''); setEditing(true); }} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', padding: 0, fontSize: 'inherit' }}>edit</button></span>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <input aria-label="Task key prefix" value={value} maxLength={6} onChange={(e) => setValue(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(false); }} style={{ ...input, width: 80, padding: '1px 6px', fontFamily: 'var(--mono)' }} />
      <button type="button" style={btn(true)} onClick={() => void save()} disabled={!/^[A-Z][A-Z0-9]{1,5}$/.test(value)}>Save</button>
      <button type="button" style={btn()} onClick={() => setEditing(false)}>Cancel</button>
    </span>
  );
}

function TaskDrawer({ org, task, members, onClose, reload, board }: { org: OrgDetail; task: OrgTask; members: OrgMember[]; onClose: () => void; reload: () => Promise<void>; board?: OrgTask[] }) {
  const tasksKeyOf = (id: string) => board?.find((x) => x.id === id)?.key ?? `[${id.slice(0, 8)}]`;
  const app = useApp();
  const names = useAgentNames();
  const [comments, setComments] = useState<OrgMessage[]>([]);
  const [runs, setRuns] = useState<OrgRun[]>([]);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [why, setWhy] = useState(false);
  const [related, setRelated] = useState(false);
  const [employees, setEmployees] = useState<OrgHuman[]>([]);
  const brief = parseBriefText(task.brief);
  useEffect(() => { void api.orgHumans(org.workspaceId).then((h) => setEmployees(h.humans.filter((x) => x.role === 'employee'))).catch(() => setEmployees([])); }, [org.workspaceId]);
  const refresh = useCallback(async () => {
    const [c, r] = await Promise.all([api.orgTaskComments(org.workspaceId, task.id).catch(() => []), api.orgTaskRuns(org.workspaceId, task.id).catch(() => [])]);
    setComments(c); setRuns(r); await reload();
  }, [org.id, task.id, reload]);
  useEffect(() => { void refresh(); }, [refresh]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  const blockers = safeJsonParse<string[]>(task.blockers, []);
  // A member may abandon its own task (stored as cancelled, with the reason as an "Abandoned by its owner" comment).
  const abandoned = task.status === 'cancelled' ? comments.find((c) => c.text.startsWith('Abandoned by its owner')) : undefined;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 90, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 100%)', background: 'var(--bg)', borderLeft: '1px solid var(--border)', height: '100%', overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...pill(STATUS_COLOR[task.status], '#fff') }}>{task.status.replace('_', ' ')}</span>
          <h2 style={{ ...h2, flex: 1 }}>{task.title}</h2>
          <FollowToggle wsId={org.workspaceId} targetKind="org_task" targetId={task.id} />
          <button style={btn()} onClick={() => setWhy(true)} title="Why does this task exist? The chain up to the vision (docs/company-vision.md §2)">Why</button>
          <button style={btn()} onClick={() => setRelated(true)} title="Everything linked to this task in the record (docs/company-vision.md §6)">Related</button>
          <button style={btn()} onClick={onClose} aria-label="Close"><I d={P.x} size={14} /></button>
        </div>
        {why && <Suspense fallback={null}><WhyDrawer wsId={org.workspaceId} taskId={task.id} title={task.title} onClose={() => setWhy(false)} /></Suspense>}
        {related && <Suspense fallback={null}><RelatedDrawer wsId={org.workspaceId} ref={`task:${task.id}`} title={task.title} onClose={() => setRelated(false)} /></Suspense>}
        <div style={faint}>{task.key ? <button type="button" onClick={() => { void navigator.clipboard?.writeText(task.key!).then(() => app.showToast(`${task.key} copied`), () => app.showToast('Copy failed')); }} title="Copy the task key" aria-label={`Copy task key ${task.key}`} style={{ ...keyStyle, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 4, padding: '0 5px', cursor: 'pointer', marginRight: 4 }}>{task.key} ⧉</button> : `[${task.id.slice(0, 8)}] `}created by {task.createdBy} · {ago(task.createdAt)} · owner {task.assigneeAgentId ? names.get(task.assigneeAgentId)?.name : task.assigneeHumanId ? `🧑 ${app.nameOf(task.assigneeHumanId)}` : 'nobody'}{task.reviewerAgentId ? ` · reviewer ${names.get(task.reviewerAgentId)?.name}` : task.reviewerHumanId ? ` · reviewer 🧑 ${app.nameOf(task.reviewerHumanId)}` : ''}{task.claimedBy ? ' · claimed' : ''}{task.class ? ` · class ${task.class}` : ''}</div>
        {(task.dueAt || (task.waitingOn ?? []).length > 0 || task.expected) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {(() => { const d = dueBadge(task.dueAt, task.status); return d ? <span style={pill(d.color, d.color === 'var(--panel-2)' ? 'var(--text-dim)' : '#fff')} title={d.title}>{d.label}</span> : task.dueAt ? <span style={pill()}>due {task.dueAt.slice(0, 16).replace('T', ' ')}</span> : null; })()}
            {(task.waitingOn ?? []).length > 0 && <span style={faint}>waiting on {(task.waitingOn ?? []).map((id) => <RefButton key={id} kind="task" id={id} label={tasksKeyOf(id)} />)}</span>}
            {expectedLabel(task.expected) && <span style={faint}>expected {expectedLabel(task.expected)} from history</span>}
          </div>
        )}
        {abandoned && <div role="status" style={{ ...card, borderLeft: '3px solid var(--amber)', fontSize: 12.5 }}><b>Abandoned by {names.get(abandoned.fromAgentId ?? '')?.name ?? 'its owner'}</b> — {abandoned.text.replace(/^Abandoned by its owner:\s*/, '')} <span style={faint}>· {ago(abandoned.createdAt)} · the chief was told to triage</span></div>}
        <div style={card}>
          {(['outcome', 'context', 'constraints', 'done_when'] as const).map((k) => <div key={k} style={{ marginBottom: 6 }}><div style={{ ...faint, textTransform: 'uppercase', letterSpacing: '.4px', fontSize: 10.5 }}>{k.replace('_', ' ')}</div><div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{brief[k] || <span style={faint}>—</span>}</div></div>)}
          {blockers.length > 0 && <div><div style={{ ...faint, textTransform: 'uppercase', fontSize: 10.5 }}>blockers</div>{blockers.map((b, i) => <div key={i} style={{ fontSize: 12.5, color: 'var(--red)' }}>■ {b}</div>)}</div>}
        </div>
        <Suspense fallback={null}><TaskChecksPanel wsId={org.workspaceId} task={task} onRan={() => void refresh()} /></Suspense>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select value="" onChange={(e) => { const v = e.target.value; if (!v) return; void act(() => v.startsWith('human:') ? api.assignOrgTaskHuman(org.workspaceId, task.id, v.slice(6)) : api.assignOrgTask(org.workspaceId, task.id, v)); }} style={{ ...input, width: 'auto' }} aria-label="Assign to">
            <option value="">Assign to…</option>
            {members.map((m) => <option key={m.id} value={m.agentId}>{names.get(m.agentId)?.name}</option>)}
            {employees.length > 0 && <optgroup label="People">{employees.map((h) => <option key={h.id} value={`human:${h.memberAccountId}`}>🧑 {app.nameOf(h.memberAccountId)}{h.title ? ` · ${h.title}` : ''}</option>)}</optgroup>}
          </select>
          {employees.length > 0 && !['done', 'cancelled', 'in_review'].includes(task.status) && (
            <select value="" onChange={(e) => { if (e.target.value) void act(() => api.requestOrgTaskReview(org.workspaceId, task.id, { reviewerHumanId: e.target.value, text: note || undefined })); }} style={{ ...input, width: 'auto' }} aria-label="Request a human review" title="Send the task to a human employee for review (a card they decide)">
              <option value="">Human review by…</option>
              {employees.map((h) => <option key={h.id} value={h.memberAccountId}>🧑 {app.nameOf(h.memberAccountId)}</option>)}
            </select>
          )}
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

/** The approvals queue — rendered by the Inbox (src/components/InboxView.tsx). */
export function Approvals({ org, reload }: { org: OrgDetail; reload: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [rows, setRows] = useState<OrgApproval[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [history, setHistory] = useState(false);
  const [humans, setHumans] = useState<{ me: HumanRole | null; actorId: string; board: string[] }>({ me: null, actorId: '', board: [] });
  const [delegations, setDelegations] = useState<OrgDelegation[]>([]);
  const refresh = useCallback(async () => {
    setRows(await api.orgApprovals(org.workspaceId).catch(() => []));
    const h = await api.orgHumans(org.workspaceId).catch(() => null);
    if (h) setHumans({ me: h.me.role, actorId: h.me.actorId, board: h.humans.filter((x) => x.role === 'board').map((x) => x.memberAccountId) });
    setDelegations(await api.orgDelegations(org.workspaceId).catch((): OrgDelegation[] => []));
  }, [org.id]);
  // A countdown on each card's deadline: re-render every minute.
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 60_000); return () => clearInterval(t); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const BOARD_KINDS = new Set(['hire', 'budget_raise', 'strategy']);
  /** Who may decide this card (docs/autonomous-company.md phase D). */
  const deciders = (kind: string) => (BOARD_KINDS.has(kind) && humans.board.length > 0 ? `CEO or board (${humans.board.map((b) => app.nameOf(b)).join(', ')})` : 'CEO only');
  /** A person a card's kind (or a held action's class) is delegated to may decide it too (docs/owners-seat.md §2); the server re-checks the amount and the boundary. */
  const delegatedToMe = (a: OrgApproval, p: Record<string, unknown>) => delegations.some((d) => d.delegateType === 'human' && d.delegateRef === humans.actorId && (d.kind === a.kind || (a.kind === 'two_key' && d.kind === p.class)));
  const mayDecide = (kind: string, a?: OrgApproval, p?: Record<string, unknown>) => humans.me === 'ceo' || (humans.me === 'board' && BOARD_KINDS.has(kind)) || (a && p ? delegatedToMe(a, p) : false);
  const decide = async (a: OrgApproval, d: 'approve' | 'reject' | 'revise') => {
    try { await api.decideOrgApproval(org.workspaceId, a.id, d, notes[a.id]); await refresh(); await reload(); await app.refreshAgents(); app.showToast(`${a.kind}: ${d}d`); }
    catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  // Decision routing (docs/owners-seat.md §7): a card a manager still holds is on its way up, not yours yet.
  const pending = rows.filter(waitsOnViewer);
  const below = inReviewBelow(rows);
  const holdMine = (a: OrgApproval) => Boolean(humans.actorId) && a.holder === `human:${humans.actorId}`;
  const [recs, setRecs] = useState<Record<string, 'approve' | 'deny' | 'modify'>>({});
  const act = async (a: OrgApproval, d: 'approve' | 'reject' | 'send_back' | 'escalate') => {
    try { const r = await api.actOnOrgDecision(org.workspaceId, a.id, d, notes[a.id], recs[a.id]); await refresh(); await reload(); app.showToast(r.message ?? `${a.kind}: ${d.replace('_', ' ')}`); }
    catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  // A held or staged action is decided in "Waiting for your key" below (the same key; its two_key card closes with it).
  const shown = history ? rows.filter((r) => r.status !== 'pending').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) : pending.filter((r) => r.kind !== 'two_key' || holdMine(r));
  const nm = (id: unknown) => (typeof id === 'string' ? names.get(id)?.name ?? id.slice(0, 8) : '—');
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><h2 style={h2}>Approvals · {pending.length} pending</h2>{below > 0 && !history && <div data-testid="in-review-below" style={{ ...faint, marginBottom: 4 }}>{below} more in review by your managers — each decides within its authority or brings it up with a recommendation.</div>}<div style={faint}>The full artifact, not a summary. Only a human decides here — the CEO, or a board member for hires, budgets and strategy; an agent's message never counts. Unanswered cards expire after 72 h ("not done"). In autonomous mode only strategy, escalations and external actions still arrive here.</div></div>
        <button style={btn(history)} onClick={() => setHistory(!history)}>{history ? 'Show pending' : 'History'}</button>
      </div>
      {!history && (app.orgHeldActions > 0 || app.orgFocus?.kind === 'action') && <div style={{ ...card, marginBottom: 12 }}><Suspense fallback={<div style={faint}>Loading…</div>}><HeldActions wsId={org.workspaceId} /></Suspense></div>}
      {shown.length === 0 && <div style={faint}>{history ? 'Nothing decided yet.' : app.orgHeldActions > 0 ? 'No other card to decide.' : 'Nothing to decide.'}</div>}
      {shown.map((a) => {
        const p = safeJsonParse<Record<string, unknown>>(a.payload, {});
        return (
          <div key={a.id} style={{ ...card, marginBottom: 10, borderLeft: `3px solid ${a.status === 'pending' ? 'var(--amber)' : a.status === 'approved' ? 'var(--green)' : 'var(--text-faint)'}` }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span style={pill('var(--accent-dim)', 'var(--text)')}>{a.kind}</span>
              <span style={faint}>by {a.requestedBy} · {ago(a.createdAt)}{a.status !== 'pending' ? ` · ${a.status}${a.decidedBy ? ` by ${app.nameOf(a.decidedBy)}` : ''}${a.decisionNote ? ` — ${a.decisionNote}` : ''}` : a.expiresAt ? ` · expires ${ago(a.expiresAt).replace(' ago', '')}` : ''}</span>
              {a.status === 'pending' && <span style={pill()} title="Who may decide this card">{deciders(a.kind)}</span>}
            </div>
            {a.recommendation && <div style={{ fontSize: 12.5, marginBottom: 6 }}><b>{a.chainHops && a.chainHops.length > 0 ? 'Requester' : 'Chief'}:</b> {a.recommendation}</div>}
            <DecisionChain a={a} />
            <DecisionExtras source={{ ...p, ...(a as unknown as Record<string, unknown>) }} skip={a.status === 'pending' ? ['recommendation'] : ['recommendation', 'deadline', 'defaultAction']} />
            <ApprovalArtifact kind={a.kind} p={p} nm={nm} wsId={org.workspaceId} />
            {(() => { const v = decidedViaBadge(a.decidedVia, (id) => app.nameOf(id)); return v ? <div style={{ marginTop: 6 }}><span style={pill('var(--blue)', '#fff')} title={v.title}>{v.label}</span></div> : null; })()}
            {p.eval && typeof p.eval === 'object' ? <Suspense fallback={null}><CardEvalLine ev={p.eval as CardEval} /></Suspense> : null}
            {a.status === 'pending' && holdMine(a) && (
              <div style={{ display: 'grid', gap: 6, marginTop: 10 }} data-testid="manager-actions">
                <div style={faint}>You are this card's reviewer{a.reserved ? ` — CEO-reserved (${a.reserved}): recommend and escalate, or send it back` : ': decide it within your authority, send it back with guidance, or escalate it with your recommendation'}.</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <input value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} placeholder="Your reasoning (required to send back)" style={input} />
                  <select aria-label="Recommendation" value={recs[a.id] ?? 'approve'} onChange={(e) => setRecs({ ...recs, [a.id]: e.target.value as 'approve' | 'deny' | 'modify' })} style={{ ...input, flex: 'none', width: 'auto' }}>
                    <option value="approve">recommend approve</option><option value="deny">recommend deny</option><option value="modify">recommend changes</option>
                  </select>
                  {!a.reserved && <button style={btn(true)} onClick={() => void act(a, 'approve')}>Approve</button>}
                  {!a.reserved && <button style={btn(false, true)} onClick={() => void act(a, 'reject')}>Reject</button>}
                  {a.kind !== 'two_key' && <button style={btn()} disabled={!(notes[a.id] ?? '').trim()} onClick={() => void act(a, 'send_back')}>Send back</button>}
                  <button style={btn()} onClick={() => void act(a, 'escalate')}>Escalate</button>
                </div>
              </div>
            )}
            {a.status === 'pending' && !holdMine(a) && !mayDecide(a.kind, a, p) && humans.me !== null && (
              <div style={{ ...faint, marginTop: 10 }}>{humans.me === 'observer' ? 'Observers read the company but decide nothing.' : `A ${a.kind} approval is the CEO's to decide.`}</div>
            )}
            {a.status === 'pending' && !holdMine(a) && mayDecide(a.kind, a, p) && (
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <input value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} placeholder="Note to the chief (required for revise)" style={input} />
                <button style={btn(true)} onClick={() => void decide(a, 'approve')}>{a.kind === 'two_key' ? (p.staged ? 'Send the draft (my key)' : 'Approve (my key)') : 'Approve'}</button>
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

/** The route a card climbed (docs/owners-seat.md §7): "Writer → Head of Content → Chief → you" and each manager's recommendation. */
export function DecisionChain({ a }: { a: Pick<OrgApproval, 'chainLine' | 'chainHops' | 'reserved' | 'status'> }) {
  const hops = managerHops(a.chainHops);
  if (!a.chainLine || !a.chainLine.includes('→')) return null;
  return (
    <div data-testid="decision-chain" style={{ fontSize: 12.5, marginBottom: 6, display: 'grid', gap: 3 }}>
      <div><span style={faint}>Route:</span> <b>{a.chainLine}</b>{a.reserved ? <span style={{ ...faint, marginLeft: 6 }}>· CEO-reserved: {a.reserved}</span> : null}</div>
      {hops.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {hops.map((h, i) => <li key={`${h.at}-${i}`} data-testid="decision-hop" style={{ overflowWrap: 'anywhere' }}>{hopLine(h)}</li>)}
        </ul>
      )}
    </div>
  );
}

function ApprovalArtifact({ kind, p, nm, wsId }: { kind: string; p: Record<string, unknown>; nm: (id: unknown) => string; wsId: string }) {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const mono: React.CSSProperties = { fontFamily: 'var(--mono)', fontSize: 11.5 };
  // Items 27, 28, 30: the owner's second key (the exact call), a proposed metric source, an experiment.
  if (kind === 'two_key') return (
    <div style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
      <div><b style={mono}>{String(p.tool ?? '')}</b> by {nm(p.agentId)} — {String(p.class ?? '').replace(/_/g, ' ')}{p.staged ? ', staged as a draft' : ''}</div>
      {typeof p.actionId === 'string' ? <Suspense fallback={<div style={faint}>Loading the call…</div>}><ActionCallPreview wsId={wsId} actionId={p.actionId} /></Suspense> : <div style={faint}>{String(p.summary ?? '')}</div>}
    </div>
  );
  if (kind === 'member_settings') {
    const lines = memberSettingsLines(p as Parameters<typeof memberSettingsLines>[0]);
    return (
      <div style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
        <div>Change the settings of <b>{String(p.agentName ?? nm(p.agentId))}</b>{p.summary ? <> — {String(p.summary)}</> : null}</div>
        {lines.length > 0 && <ul style={{ margin: 0, paddingLeft: 18 }}>{lines.map((l) => <li key={l} style={mono}>{l}</li>)}</ul>}
        {p.why ? <div style={faint}>Why: {String(p.why)}</div> : null}
        {typeof p.agentId === 'string' ? <div><RefButton kind="agent" id={p.agentId} label="Open the member" /></div> : null}
      </div>
    );
  }
  if (kind === 'metric_source') return (
    <div style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
      <div>Make <b>{String(p.name ?? '')}</b> a live {String(p.kind ?? '')} source{p.unit ? ` (${String(p.unit)})` : ''}{p.pollMinutes ? `, read every ${String(p.pollMinutes)} min` : ''}.</div>
      <div style={{ ...mono, overflowWrap: 'anywhere' }}>{String(p.target ?? '')}</div>
      {p.why ? <div style={faint}>Why: {String(p.why)}</div> : null}
      <details><summary style={{ cursor: 'pointer', ...faint }}>Config</summary><pre style={{ ...mono, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--panel-2)', padding: 8, borderRadius: 8 }}>{JSON.stringify(p.config ?? {}, null, 2)}</pre></details>
      <div style={faint}>A source defines what counts as truth: only you make one live. A referenced secret must be set first.</div>
    </div>
  );
  if (kind === 'experiment') return (
    <div style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
      <div>Start the experiment <b>{String(p.title ?? '')}</b>{p.hypothesis ? <> — <i>{String(p.hypothesis)}</i></> : null}</div>
      <div><span style={mono}>{changeSummary(String(p.changeKind ?? ''), (p.change ?? {}) as Record<string, unknown>)}</span> · measured by {String(p.metric ?? 'unmeasured')} · expected {String(p.expected ?? '?')} ({String(p.direction ?? 'up')} is better) · {String(p.windowDays ?? '?')}-day window</div>
      {p.experimentId ? <div><RefButton kind="experiment" id={String(p.experimentId)} label="Open the experiment" /></div> : null}
      <details><summary style={{ cursor: 'pointer', ...faint }}>Details</summary><pre style={{ ...mono, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--panel-2)', padding: 8, borderRadius: 8 }}>{JSON.stringify(p, null, 2)}</pre></details>
    </div>
  );
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
  if (kind === 'escalation') return <div style={{ fontSize: 12.5 }}>Task <b>{String(p.title)}</b> ({nm(p.assigneeAgentId)}): {String(p.reason)}. Approve to reopen it with your note; reject to cancel it. {p.taskId ? <RefButton kind="task" id={String(p.taskId)} label="Open the task" /> : null}</div>;
  // Items 22–24: the human review card, a retro's charter change with its diff, a blueprint's hires, routing, a tunable, a cadence.
  if (kind === 'human_review') return (
    <div style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
      <div>Review of task <b>{String(p.title ?? '')}</b>{p.assigneeAgentId ? <> by {nm(p.assigneeAgentId)}</> : null} — requested of <b>🧑 {String(p.reviewerName ?? p.reviewerHumanId ?? 'a human employee')}</b>.</div>
      {p.note ? <div style={faint}>Note: {String(p.note)}</div> : null}
      <div style={faint}>Approve accepts the task (done); reject requests changes with your note and wakes the owner. <RefButton kind="task" id={String(p.taskId ?? '')} label="Open the task" /></div>
    </div>
  );
  if (kind === 'charter_change') return (
    <div style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
      <div>{String(p.mode ?? 'append') === 'replace' ? 'Replace' : 'Append to'} the charter of <b>{String(p.agentName ?? nm(p.agentId))}</b>{p.lesson ? <> — lesson: <i>{String(p.lesson)}</i></> : null}</div>
      <pre style={{ ...mono, whiteSpace: 'pre-wrap', background: 'var(--panel-2)', padding: 8, borderRadius: 8, maxHeight: 260, overflow: 'auto' }}>{String(p.diff ?? '').split('\n').map((l, i) => <div key={i} style={{ color: l.startsWith('+') ? 'var(--green)' : l.startsWith('-') ? 'var(--red)' : undefined }}>{l}</div>)}</pre>
      <div style={faint}>The agent accepts the new charter on approval; the change is audited with the meeting it came from.</div>
    </div>
  );
  if (kind === 'blueprint') {
    const hires = Array.isArray(p.hires) ? p.hires as Array<Record<string, unknown>> : [];
    return (
      <div style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
        <div>Staff <b>{String(p.name ?? 'the company')}</b> from its blueprint: {hires.length} hire(s).</div>
        {hires.map((h, i) => <div key={i} style={{ paddingLeft: 10 }}>• <b>{String(h.name ?? h.title)}</b> as {String(h.title)}{h.roleId ? <span style={{ ...faint, marginLeft: 4 }}>role:{String(h.roleId)}</span> : null} → reports to {String(h.reportsToTitle ?? nm(h.reportsToAgentId))}{Array.isArray(h.scopes) && h.scopes.length ? <span style={faint}> · {(h.scopes as unknown[]).length} scope(s)</span> : null}</div>)}
        <div style={faint}>Nothing is inherited; playbooks land as drafts; cadences are listed, not written.</div>
      </div>
    );
  }
  if (kind === 'routing') return <div style={{ fontSize: 12.5 }}>Route class <b style={mono}>{String(p.class ?? '')}</b> → <b>{String(p.tier ?? '')}</b>{p.from ? <> (was {String(p.from)})</> : null}{p.model ? <span style={faint}> · resolves to {String(p.model)}</span> : null}{p.why ? <div style={faint}>{String(p.why)}</div> : null}</div>;
  if (kind === 'tune') return <div style={{ fontSize: 12.5 }}>Tune <b style={mono}>{String(p.key ?? '')}</b>: {p.from !== undefined ? <>{String(p.from)} → </> : null}<b>{String(p.value ?? '')}</b>{p.why ? <div style={faint}>{String(p.why)}</div> : null}<div style={faint}>Bounds are re-checked on apply.</div></div>;
  if (kind === 'cadence') return <div style={{ fontSize: 12.5 }}>{String(p.kind ?? 'meeting')} of <b>{String(p.unitName ?? 'the company')}</b> → {p.cron ? <code>{String(p.cron)}</code> : 'off'}</div>;
  return <pre style={{ ...mono, whiteSpace: 'pre-wrap' }}>{JSON.stringify(p, null, 2)}</pre>;
}

/** A small link that follows a reference to its pane (used by the approval artifacts). */
function RefButton({ kind, id, label }: { kind: string; id: string; label: string }) {
  const follow = useFollowRef();
  if (!id) return null;
  return <button style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 600 }} onClick={() => follow(kind, id)}>{label}</button>;
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
