/** The organization pages of a workspace (docs/group-chat.md §5, execution
 *  plan items 14 and 16): the workspace *is* the company, so in organization
 *  mode each company section (Direction, Operations, People, Money,
 *  Oversight; src/lib/company-nav.ts) renders here — its dashboard, or one of
 *  its pages: the shared board, goals, the org chart, spend vs envelopes,
 *  the brief with its one-reply input, the audit (runs and the hash-chained
 *  log)… The approvals queue (full artifact, never a summary) renders in the
 *  Inbox. Enabling, the mode, the chief and the caps live in Settings ›
 *  Company; the group log moved to the `#company` channel. */
import { decisionLabel, decisionReasons, parseDecisionJson } from '../lib/model-selection';
import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { useApp, type OrgPane } from '../store';
import { sectionDef, sectionOfPane, type CompanySection } from '../lib/company-nav';
import { hopLine, inReviewBelow, managerHops, waitsOnViewer } from '../lib/decisions';
import { isTaskKey, keyStyle, matchesTaskRef } from '../lib/task-keys';
import {
  api, ORG_TASK_STATUSES, type Agent, type HumanRole, type OrgApproval, type OrgAuditRow, type OrgBrief, type OrgDetail, type OrgHuman, type OrgMember, type OrgMessage, type OrgRun,
  type OrgSpend, type OrgForecast, type OrgTask, type OrgTaskBrief, type OrgTaskStatus, type OrgUnitNode, type WorkspaceMember, type TaskCheck, type OrgDelegation, type CardEval,
} from '../lib/api';
import { safeJsonParse } from '../lib/util';
import { fmtUsd } from '../lib/pricing';
import { spendWindowLabel } from '../lib/company-dash';
import { UsageBars, UsageRows } from './UsageChart';
import { I, P } from '../lib/icons';
import { card, input, btn, pill, h2, faint, ago, useAgentNames, useUnits, useFollowRef, Avatar, DecisionExtras } from './org-ui';
import { ClaimBadge, useClaims } from './OrgClaimsView';
import { PluginPanels } from './PluginUi';
import { Bar as KitBar, Card as KitCard, Empty as KitEmpty, InfoButton, Menu, Metric, Owner, PageHeader, PageSkeleton, Pill, SearchBox, SkeletonRows } from './CompanyKit';
import { actorWords, auditCategory, auditSentence, filterAudit, AUDIT_CATEGORY_LABEL, type AuditFilter } from '../lib/oversight';
import { changeSummary, decidedViaBadge, dueBadge, expectedLabel, memberSettingsLines, verificationBadge } from '../lib/org3';
import { FollowToggle } from './FollowToggle';
import { DepartmentName, useMayRenameDepartments } from './DepartmentName';
import { MentionBox, storedMentions, useMentionables } from './MentionBox';
import { Markdown } from '../lib/md';
import { SOURCE_TONE, SOURCE_WORD, blockedText, parseBlockedOn, stepsCount } from '../lib/roadmap';
import type { TaskSource } from '../lib/api';

/** The CEO's-seat panes (docs/company-vision.md §8, items 18–20) load on demand. */
const VisionPane = lazy(() => import('./OrgVisionView').then((m) => ({ default: m.VisionPane })));
const PulsePane = lazy(() => import('./OrgPulseView').then((m) => ({ default: m.PulsePane })));
const MeetingsPane = lazy(() => import('./OrgMeetingsView').then((m) => ({ default: m.MeetingsPane })));
const DecisionsPane = lazy(() => import('./OrgDecisionsView').then((m) => ({ default: m.DecisionsPane })));
const WhyDrawer = lazy(() => import('./OrgVisionView').then((m) => ({ default: m.WhyDrawer })));
/** Memory, capital, blueprints and hybrid staff (items 22–24); playbooks are files under /org/playbooks/ in Artifacts. */
const RelatedDrawer = lazy(() => import('./OrgMemoryView').then((m) => ({ default: m.RelatedDrawer })));
const ReplayPane = lazy(() => import('./OrgCapitalView').then((m) => ({ default: m.ReplayPane })));
const CapitalPane = lazy(() => import('./OrgCapitalView').then((m) => ({ default: m.CapitalPane })));
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
/** Work tracking (docs/work-tracking.md): the roadmap and the project page. */
const RoadmapPane = lazy(() => import('./OrgRoadmapView').then((m) => ({ default: m.RoadmapPane })));
const TeamsPane = lazy(() => import('./CompanyDashboards').then((m) => ({ default: m.TeamsPane })));
const SectionDashboard = lazy(() => import('./CompanyDashboards').then((m) => ({ default: m.SectionDashboard })));
const GoalsPane = lazy(() => import('./OrgGoalsView').then((m) => ({ default: m.GoalsPane })));
/** Quality control (docs/quality.md): the Oversight › Quality page and the task's QC panel. */
const QualityPane = lazy(() => import('./OrgQualityView').then((m) => ({ default: m.QualityPane })));
const TaskQcPanel = lazy(() => import('./OrgQualityView').then((m) => ({ default: m.TaskQcPanel })));
const LAZY_PANES = new Set(['goals', 'vision', 'pulse', 'meetings', 'decisions', 'replay', 'capital', 'incidents', 'roadmap', 'teams', 'quality', 'alignment', 'processes', 'services', 'improvements']);
/** CEO alignment (docs/alignment.md): what needs the CEO's alignment, briefs, threads and decisions. */
const AlignmentPane = lazy(() => import('./AlignmentView').then((m) => ({ default: m.AlignmentPane })));
/** Processes (docs/processes.md): the standing procedures, their versions and runs. */
const ProcessesPane = lazy(() => import('./OrgProcessesView').then((m) => ({ default: m.ProcessesPane })));
/** Services (docs/services.md): each department's catalog with SLAs, the requests and their clocks. */
const ServicesPane = lazy(() => import('./OrgServicesView').then((m) => ({ default: m.ServicesPane })));
/** Improvements (docs/improvements.md): capped proposals, their verification, and where work comes from. */
const ImprovementsPane = lazy(() => import('./OrgImprovementsView').then((m) => ({ default: m.ImprovementsPane })));

const STATUS_COLOR: Record<OrgTaskStatus, string> = {
  backlog: 'var(--text-faint)', waiting: 'var(--text-dim)', todo: 'var(--blue)', claimed: 'var(--amber)', in_progress: 'var(--amber)', in_review: 'var(--accent)', blocked: 'var(--red)', done: 'var(--green)', cancelled: 'var(--text-faint)',
};

export function OrganizationView({ section }: { section: CompanySection }) {
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
  if (!wsId || !org) return <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>{err ? <div className="co-alert" role="alert">The company did not load: {err}</div> : <PageSkeleton />}</div>;
  const mode = app.wsOrg?.mode ?? 'supervised';
  const ws = app.workspaces.find((w) => w.id === wsId);

  const toggle = async () => {
    try {
      if (org.status === 'active') { if (!confirm(`Pause ${org.name}? Every queued wake is dropped and in-flight runs are aborted.`)) return; await api.pauseOrg(wsId); } else await api.resumeOrg(wsId);
      await reload();
    } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  const def = sectionDef(section);
  // A page of this section, or the section's dashboard.
  const view: OrgPane | null = app.orgPane && sectionOfPane(app.orgPane) === section ? app.orgPane : null;
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px 10px', borderBottom: app.stacked ? 'none' : '1px solid var(--border)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2 style={{ ...h2, fontSize: 16 }} data-testid="company-section-title">{def.label}</h2>
            {view === null && <InfoButton label={`About ${def.label}`}>{def.blurb}</InfoButton>}
            {/* On a phone the header keeps the section name, the paused state and the kill switch. */}
            {!app.stacked && <span style={faint}>{ws?.name ?? org.name}</span>}
            {(!app.stacked || org.status !== 'active') && <span style={pill(org.status === 'active' ? 'var(--green)' : 'var(--red)', '#fff')}>{org.status}</span>}
            {!app.stacked && <span title={mode === 'autonomous' ? 'The chief of staff hires, reorganizes and allocates within caps on its own' : 'Structural changes are approvals you decide'} style={pill()}>{mode}</span>}
            {org.charterDrift.length > 0 && <span title="A member's charter changed outside the org path" style={pill('var(--amber)', '#fff')}>charter drift · {org.charterDrift.length}</span>}
          </div>
        </div>
        <button onClick={toggle} style={btn(false, org.status === 'active')} title={org.status === 'active' ? 'Kill switch: stop every wake and run' : 'Resume wakes and runs'}>{org.status === 'active' ? (app.stacked ? 'Pause' : 'Pause company') : 'Resume'}</button>
      </div>
      {app.stacked && <PageStrip section={section} view={view} />}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        {view === null && <Suspense fallback={<PageSkeleton />}><SectionDashboard section={section} org={org} /></Suspense>}
        {view === 'chart' && <OrgChart org={org} reload={reload} />}
        {view === 'board' && <Board org={org} />}
                {view === 'spend' && <Spend org={org} reload={reload} />}
        {view === 'audit' && <Audit org={org} />}
        {view === 'brief' && <BriefView org={org} mode={mode} />}
        {view !== null && LAZY_PANES.has(view) && (
          <Suspense fallback={<PageSkeleton />}>
            {view === 'vision' && <VisionPane org={org} reload={reload} />}
            {view === 'goals' && <GoalsPane org={org} reload={reload} />}
            {view === 'pulse' && <PulsePane org={org} />}
            {view === 'meetings' && <MeetingsPane org={org} />}
            {view === 'decisions' && <DecisionsPane org={org} />}
            {view === 'replay' && <ReplayPane org={org} />}
            {view === 'capital' && <CapitalPane org={org} />}
            {view === 'incidents' && <IncidentsPane org={org} />}
            {view === 'roadmap' && <RoadmapPane org={org} />}
            {view === 'teams' && <TeamsPane org={org} />}
            {view === 'quality' && <QualityPane org={org} />}
            {view === 'alignment' && <AlignmentPane org={org} />}
            {view === 'processes' && <ProcessesPane org={org} />}
            {view === 'services' && <ServicesPane org={org} />}
            {view === 'improvements' && <ImprovementsPane org={org} />}
          </Suspense>
        )}
      </div>
    </div>
  );
}

/** On a phone the section's pages are a strip of tabs under the header (no rail). */
function PageStrip({ section, view }: { section: CompanySection; view: OrgPane | null }) {
  const app = useApp();
  const def = sectionDef(section);
  return (
    <div role="tablist" aria-label={`${def.label} pages`} data-testid="company-page-strip" className="co-strip">
      <button role="tab" aria-selected={view === null} onClick={() => { app.setOrgUnitId(null); app.go(section); }}>Overview</button>
      {def.pages.map((p) => <button key={p.pane} role="tab" aria-selected={view === p.pane} onClick={() => { app.setOrgUnitId(null); app.setOrgPane(p.pane); }}>{p.label}</button>)}
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
        <button className="co-btn ghost small" style={{ marginBottom: 10 }} onClick={() => setEditing(false)}><I d={P.chevL} size={12} />Back to the org chart</button>
        <OrgStructure org={org} reload={reload} />
      </div>
    );
  }
  return <Suspense fallback={<PageSkeleton />}><MissionControlPane org={org} onEditStructure={() => setEditing(true)} /></Suspense>;
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
  const mayRename = useMayRenameDepartments(org.workspaceId);
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
                <span style={pill('var(--blue)', '#fff')} title="A human employee: takes task cards, reviews, sits in the department channel">person</span>
                <span style={pill()}>{h.title || 'employee'}</span>
              </div>
            </div>
          ))}
          {tree(m.agentId, depth + 1)}
        </div>
      </div>
    );
    if (!unit) return node;
    // A department boundary (docs/group-chat.md §7): a subtle box around the lead and its reports, labelled with the department's own name (renamable in place) and its channel.
    return (
      <div key={`unit-${unit.id}`} style={{ border: '1px dashed var(--border)', borderRadius: 12, padding: '6px 8px 0', marginBottom: 10, background: depth % 2 === 0 ? 'transparent' : 'var(--panel-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px 8px', fontSize: 11, color: 'var(--text-dim)' }}>
          <span style={{ fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', fontSize: 10 }}>{unit.parentUnitId === null ? 'Company' : 'Department'}</span>
          {unit.parentUnitId === null
            ? <span style={{ fontWeight: 600, color: 'var(--text)' }}>{unit.name}</span>
            : <DepartmentName wsId={org.workspaceId} unitId={unit.id} name={unit.name} editable={mayRename} style={{ fontWeight: 600, color: 'var(--text)' }} />}
          <button onClick={() => app.openChannel(unit.slug)} title={unit.parentUnitId === null ? 'Open the company channel' : 'Open the department channel'} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', padding: 0, fontSize: 11, fontWeight: 600 }}>#{unit.slug}</button>
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
    <div className="co-page narrow" data-testid="org-structure">
      <PageHeader title="Edit structure" purpose={<>You, then the chief of staff, then specialists: depth at most {org.maxDepth}, at most {org.maxDirectReports} direct reports. A member's scopes never exceed the chief's. Every member with reports leads a department (the dashed boxes); rename one in place with its pencil and its channel follows.</>}
        actions={<>
          <button className="co-btn" onClick={() => setAdding(!adding)} disabled={free.length === 0} title="Seat an existing agent of this workspace">Add member</button>
          <button className="co-btn primary" onClick={() => setHiring(true)} title="Hire from the role catalog or a pack (a hire card in supervised mode)">Hire</button>
        </>} />
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
  const ROLE_HINT: Record<HumanRole, string> = { ceo: 'everything', board: 'decides hire, budget and strategy approvals; gets the brief', observer: 'reads the company; decides nothing', employee: 'a hybrid staff member: takes task cards, reviews, sits in the department channel (docs/company-vision.md §4)' };
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
  /** Work tracking: filter the board to one project ('' = all). */
  const [projectFilter, setProjectFilter] = useState('');
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
  // A task in the address (/<company>/tasks/<key>), a signal row or a
  // minutes card asked for one task: open its drawer once the board has
  // loaded, and fetch the task when it is not on this board (another unit,
  // or closed).
  const focusId = app.orgFocus?.kind === 'task' ? app.orgFocus.id : null;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!focusId || !loaded) return;
    const t = tasks.find((x) => matchesTaskRef(x, focusId));
    app.setOrgFocus(null);
    // Opened from inside the app (a signal row, a minutes card): put it in the address too.
    if (app.routeTask !== focusId) app.setRouteTask(focusId, { replace: true });
    // A key or prefix in the address becomes the task's key (or id) once found.
    const canonical = (x: OrgTask) => { if (x.key && focusId !== x.key && focusId !== x.id) app.setRouteTask(x.key, { replace: true }); };
    if (t) {
      setOpen(t); if (t.status === 'done' || t.status === 'cancelled') setShowCold(true);
      canonical(t);
      return;
    }
    // (Clearing the focus re-renders with a new `app`: only leaving the board drops the answer.)
    api.orgTask(org.workspaceId, focusId)
      .then((found) => { if (alive.current) { setOpen(found); canonical(found); } })
      .catch(() => { if (alive.current) app.showToast(`Task ${isTaskKey(focusId) ? focusId.toUpperCase() : focusId.slice(0, 8)} was not found`); });
  }, [focusId, loaded, tasks, app, org.workspaceId]);
  // The open drawer is in the address (back, forward and reload work):
  // opening and closing it are history entries, and the address moving off
  // it (back) closes the drawer.
  const openTask = (t: OrgTask) => {
    setOpen(t);
    const key = t.key || t.id;
    if (app.routeTask !== key) app.setRouteTask(key);
  };
  const closeTask = () => {
    setOpen(null);
    if (app.routeTask) app.setRouteTask(null);
  };
  useEffect(() => { if (!app.routeTask) setOpen(null); }, [app.routeTask]);
  const cols = ORG_TASK_STATUSES.filter((s) => showCold || (s !== 'done' && s !== 'cancelled'));
  const projectsById = new Map(org.projects.map((p) => [p.id, p]));
  const shown = projectFilter ? tasks.filter((t) => t.projectId === projectFilter) : tasks;
  const members = org.members.filter((m) => m.status === 'active');
  const lead = current ? names.get(current.leadAgentId) : undefined;
  const STATUS_WORD: Record<string, string> = { backlog: 'Backlog', waiting: 'Waiting', todo: 'To do', claimed: 'Claimed', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' };
  const STATUS_HINT: Record<string, string> = { cancelled: 'Cancelled, or abandoned by its owner (the reason is on the timeline)', waiting: 'Waiting on another task; cannot be claimed yet', blocked: 'Stuck on something named on the card', claimed: 'An owner picked it up and has not started', in_review: 'Done by its owner, waiting on a reviewer' };
  const wip = shown.filter((t) => t.status === 'in_progress' || t.status === 'claimed' || t.status === 'in_review').length;
  const blockedN = shown.filter((t) => t.status === 'blocked').length;
  return (
    <div data-testid="board-page">
      <PageHeader title={isCompany ? 'Board' : `${current?.name ?? 'Department'} board`}
        purpose={isCompany ? 'Every task, one owner each. Assigning or commenting wakes the owner; @Name in a comment wakes that member or notifies that person.' : <>Led by {lead?.name ?? '—'}: the tasks of its reports and what the lead hands them.</>}
        actions={<>
          {org.projects.length > 0 && (
            <select aria-label="Project" className="co-input" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} style={{ width: 'auto', maxWidth: 220 }}>
              <option value="">All projects</option>
              {org.projects.filter((p) => p.status !== 'cancelled').map((p) => <option key={p.id} value={p.id}>{p.key ? `${p.key} ` : ''}{p.title}</option>)}
            </select>
          )}
          <Menu label="Board options" trigger={<>Show<I d={P.chevD} size={12} /></>} triggerClass="co-btn" items={[
            { id: 'roll', label: isCompany ? 'Every department’s tasks' : 'Include the departments below', checked: rolled, onSelect: () => setRollUp({ ...rollUp, [unitKey]: !rolled }) },
            { id: 'cold', label: 'Done and cancelled columns', checked: showCold, onSelect: () => setShowCold(!showCold) },
          ]} />
          <button className="co-btn primary" onClick={() => setAdding(true)}>New task</button>
        </>} />
      <div className="co-toolbar">
        {units.length > 1 && (
          <div className="co-chips" role="tablist" aria-label="Department">
            {units.map((u) => {
              const active = (u.parentUnitId === null && isCompany) || (u.parentUnitId !== null && app.orgUnitId === u.id);
              return (
                <button key={u.id} role="tab" aria-selected={active} className={`co-chip${active ? ' on' : ''}`} onClick={() => app.setOrgUnitId(u.parentUnitId === null ? null : u.id)} title={`${u.counts.openTasks} open task${u.counts.openTasks === 1 ? '' : 's'}`}>
                  {u.parentUnitId === null ? 'Whole company' : u.name}<span className="co-chip-n">{u.counts.openTasks}</span>
                </button>
              );
            })}
          </div>
        )}
        <span style={{ flex: 1 }} />
        {current && <span className="co-faint"><button className="co-link" style={{ fontSize: 12 }} onClick={() => app.openChannel(current.slug)}>#{current.slug}</button> · <TaskKeyPrefix wsId={org.workspaceId} unitId={current.id} prefix={current.taskKey ?? null} /></span>}
      </div>
      <div className="co-metrics" style={{ marginBottom: 12 }} data-testid="board-summary">
        <Metric n={shown.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length} label="open" />
        <Metric n={wip} label="in flight" title="Claimed, in progress or in review" />
        <Metric n={blockedN} label="blocked" tone={blockedN ? 'bad' : undefined} />
        <Metric n={shown.filter((t) => !t.assigneeAgentId && !t.assigneeHumanId && t.status !== 'done' && t.status !== 'cancelled').length} label="unassigned" />
      </div>
      <Suspense fallback={null}><CapacityStrip wsId={org.workspaceId} refreshKey={tasks.length} /></Suspense>
      {adding && <NewTask org={org} members={members} units={units} tasks={tasks} defaultUnitId={isCompany ? '' : current?.id ?? ''} onDone={() => { setAdding(false); void reload(); }} />}
      {!loaded ? <PageSkeleton cards={4} /> : (
        <div style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(240px, 1fr)', gap: 10, overflowX: 'auto', paddingBottom: 8, alignItems: 'start' }} data-testid="kanban">
          {cols.map((s) => {
            const inCol = shown.filter((t) => t.status === s).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
            return (
              <section key={s} aria-label={STATUS_WORD[s]} data-testid={`col-${s}`} style={{ background: 'var(--panel-2)', borderRadius: 12, padding: 8, minHeight: 140, border: '1px solid var(--border-soft)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px 8px' }} title={STATUS_HINT[s]}>
                  <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[s] }} />
                  <h3 style={{ margin: 0, fontSize: 13, fontWeight: 650 }}>{STATUS_WORD[s] ?? s}</h3>
                  <span className="co-faint co-num">{inCol.length}</span>
                </div>
                {inCol.length === 0 && <div className="co-faint" style={{ padding: '14px 6px', textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 9 }}>Nothing {s === 'blocked' ? 'blocked' : 'here'}</div>}
                {inCol.map((t) => {
                  const a = t.assigneeAgentId ? names.get(t.assigneeAgentId) : undefined;
                  const unit = t.unitId ? byId.get(t.unitId) : root;
                  const foreign = unit && unit.id !== current?.id;
                  const project = t.projectId ? projectsById.get(t.projectId) : undefined;
                  const blocked = t.status === 'blocked' ? blockedText(parseBlockedOn(t.blockedOn), (id) => names.get(id)?.name ?? tasks.find((x) => x.id === id)?.key ?? id.slice(0, 8)) || safeJsonParse<string[]>(t.blockers, []).at(-1) || '' : '';
                  const steps = stepsCount(t.steps);
                  const due = dueBadge(t.dueAt, t.status);
                  const v = verificationBadge(t.verification);
                  return (
                    <button key={t.id} onClick={() => openTask(t)} className="co-card" data-testid="task-card" style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 11px', marginBottom: 6, cursor: 'pointer', font: 'inherit', color: 'var(--text)', boxShadow: t.status === 'blocked' ? 'inset 3px 0 0 var(--red)' : undefined }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        {t.key && <span className="co-key" style={{ marginRight: 0 }}>{t.key}</span>}
                        {project && <span data-testid="project-badge" className="co-key" style={{ marginRight: 0 }} title={`Project: ${project.title}`}>· {project.key ?? project.title.slice(0, 14)}</span>}
                        <span style={{ flex: 1 }} />
                        {due && <span className={`co-pill plain ${due.color.includes('red') ? 'bad' : due.color.includes('amber') ? 'warn' : ''}`} title={due.title}>{due.label}</span>}
                      </span>
                      <span style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 13, fontWeight: 600, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{t.title}</span>
                      {blocked && <span data-testid="blocked-on" className="co-alert" style={{ display: 'block', marginTop: 7, padding: '5px 8px', fontSize: 12, lineHeight: 1.4 }}>{blocked}</span>}
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                        {a ? <Owner agent={a} /> : t.assigneeHumanId ? <Owner name={app.nameOf(t.assigneeHumanId)} role="person" /> : <Owner none="Unassigned" />}
                        <span style={{ flex: 1 }} />
                        {t.source && t.source in SOURCE_WORD && t.source !== 'agent' && <span data-testid="source-badge" style={{ ...pill(SOURCE_TONE[t.source as TaskSource].bg, SOURCE_TONE[t.source as TaskSource].fg), border: 'none' }} title={`Source: ${SOURCE_WORD[t.source as TaskSource]}`}>{SOURCE_WORD[t.source as TaskSource]}</span>}
                        {steps.total > 0 && <span className="co-faint co-num" title="Checklist steps done">{steps.done}/{steps.total} steps</span>}
                      </span>
                      {(foreign || t.claimedBy || t.reviewRounds > 0 || t.noProgressCount > 0 || v || (t.waitingOn ?? []).length > 0 || (t.class && t.class !== 'general') || (t.status === 'in_review' && t.reviewerAgentId)) && (
                        <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                          {t.class && t.class !== 'general' && <span style={pill()} title="Task class (routing, cost by class)">{t.class}</span>}
                          {foreign && unit && <span style={pill()} title={`On the board of ${unit.name}`}>{unit.parentUnitId === null ? 'company' : unit.name}</span>}
                          {t.claimedBy && t.status === 'claimed' && <span style={pill()}>claimed</span>}
                          {t.reviewRounds > 0 && <span style={pill()}>review {t.reviewRounds}/3</span>}
                          {t.noProgressCount > 0 && <span style={pill('var(--panel-2)', 'var(--warn-text)')}>no progress ×{t.noProgressCount}</span>}
                          {t.status === 'in_review' && t.reviewerAgentId && <span style={pill()}>reviewer {names.get(t.reviewerAgentId)?.name ?? '?'}</span>}
                          {v && <span style={pill(v.color, '#fff')} title={v.title}>{v.label}</span>}
                          {(t.waitingOn ?? []).map((id) => { const dep = tasks.find((x) => x.id === id); return <span key={id} style={pill()} title={`Waits on: ${dep?.title ?? id} (${dep?.status ?? 'unknown'})`}>waits on {dep ? dep.key ?? dep.title.slice(0, 18) : id.slice(0, 8)}</span>; })}
                        </span>
                      )}
                      {t.status !== 'done' && t.status !== 'cancelled' && expectedLabel(t.expected) && <span className="co-faint" style={{ display: 'block', marginTop: 5 }} title={`Expected from ${t.expected?.samples} finished task(s) (${t.expected?.basis})`}>{expectedLabel(t.expected)}</span>}
                    </button>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}
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
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={input} title="Every task has a project; without one it lands in its department's Unsorted project"><option value="">Project: Unsorted</option>{org.projects.filter((p) => p.status !== 'cancelled' && p.status !== 'done').map((p) => <option key={p.id} value={p.id}>{p.key ? `${p.key} ` : ''}{p.title}</option>)}</select>
        {units.length > 1 && <select value={unitId} onChange={(e) => setUnitId(e.target.value)} style={input} title="Which department's board; by default the one led by the assignee's manager"><option value="">Board: by assignee</option>{units.map((u) => <option key={u.id} value={u.id}>{'· '.repeat(u.depth)}{u.parentUnitId === null ? 'Company' : u.name}</option>)}</select>}
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
  // Evidence-gated claims (docs/evidence.md): each update's verified / unverified badge.
  const claims = useClaims(org.workspaceId, 'task_comment', comments.filter((c) => c.fromAgentId).map((c) => c.id));
  const [runs, setRuns] = useState<OrgRun[]>([]);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [why, setWhy] = useState(false);
  const [related, setRelated] = useState(false);
  const [employees, setEmployees] = useState<OrgHuman[]>([]);
  // @mentions (docs/work-tracking.md "Mentions"): who may be tagged here.
  const mentionables = useMentionables(org.workspaceId, true);
  const brief = parseBriefText(task.brief);
  useEffect(() => { void api.orgHumans(org.workspaceId).then((h) => setEmployees(h.humans.filter((x) => x.role === 'employee'))).catch(() => setEmployees([])); }, [org.workspaceId]);
  const refresh = useCallback(async () => {
    const [c, r] = await Promise.all([api.orgTaskComments(org.workspaceId, task.id).catch(() => []), api.orgTaskRuns(org.workspaceId, task.id).catch(() => [])]);
    setComments(c); setRuns(r); await reload();
  }, [org.id, task.id, reload]);
  useEffect(() => { void refresh(); }, [refresh]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  const blockers = safeJsonParse<string[]>(task.blockers, []);
  // Work tracking (docs/work-tracking.md): the one structured blocker, the project and the checklist.
  const blockedOn = parseBlockedOn(task.blockedOn);
  const steps = safeJsonParse<Array<{ id: string; text: string; done: boolean; dropped?: boolean }>>(task.steps ?? '[]', []).filter((s) => !s.dropped);
  const project = task.projectId ? org.projects.find((p) => p.id === task.projectId) : undefined;
  const [stepText, setStepText] = useState('');
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
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {task.source && task.source in SOURCE_WORD && <span style={{ ...pill(SOURCE_TONE[task.source as TaskSource].bg, SOURCE_TONE[task.source as TaskSource].fg), border: 'none' }}>source: {SOURCE_WORD[task.source as TaskSource]}</span>}
          <select aria-label="Project of the task" value={task.projectId ?? ''} onChange={(e) => { const pid = e.target.value; if (pid && pid !== task.projectId) void act(() => api.linkTaskToProject(org.workspaceId, pid, task.id)); }} style={{ ...input, width: 'auto', maxWidth: 260 }}>
            {!task.projectId && <option value="">No project</option>}
            {org.projects.filter((p) => p.id === task.projectId || (p.status !== 'cancelled' && p.status !== 'done')).map((p) => <option key={p.id} value={p.id}>project {p.key ? `${p.key} ` : ''}{p.title}</option>)}
          </select>
          {project && project.kind === 'project' && <button style={btn()} onClick={() => { app.setOrgFocus({ kind: 'project', id: project.id }); app.setOrgPane('roadmap'); }}>Open project</button>}
          {task.doneAt && <span style={faint}>done {task.doneAt.slice(0, 10)}</span>}
          {task.wakesPausedAt && <span style={pill('var(--amber)', '#fff')} title="The owner repeated the same failed approach; wakes are paused until someone rebriefs, reassigns or comments">wakes paused</span>}
        </div>
        {blockedOn && task.status === 'blocked' && <div role="status" data-testid="drawer-blocked-on" style={{ ...card, borderLeft: '3px solid var(--red)', fontSize: 12.5 }}><b>{blockedText(blockedOn, (id) => names.get(id)?.name ?? (board?.find((x) => x.id === id)?.key ?? id.slice(0, 8)))}</b><span style={faint}> · since {ago(blockedOn.since)}</span></div>}
        {abandoned && <div role="status" style={{ ...card, borderLeft: '3px solid var(--amber)', fontSize: 12.5 }}><b>Abandoned by {names.get(abandoned.fromAgentId ?? '')?.name ?? 'its owner'}</b> — {abandoned.text.replace(/^Abandoned by its owner:\s*/, '')} <span style={faint}>· {ago(abandoned.createdAt)} · the chief was told to triage</span></div>}
        <div style={card}>
          {(['outcome', 'context', 'constraints', 'done_when'] as const).map((k) => <div key={k} style={{ marginBottom: 6 }}><div style={{ ...faint, textTransform: 'uppercase', letterSpacing: '.4px', fontSize: 10.5 }}>{k.replace('_', ' ')}</div><div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{brief[k] || <span style={faint}>—</span>}</div></div>)}
          {blockers.length > 0 && <div><div style={{ ...faint, textTransform: 'uppercase', fontSize: 10.5 }}>blockers</div>{blockers.map((b, i) => <div key={i} style={{ fontSize: 12.5, color: 'var(--red)' }}>■ {b}</div>)}</div>}
        </div>
        <div data-testid="task-steps" style={card}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Steps {steps.length > 0 && <span style={faint}>{steps.filter((s) => s.done).length}/{steps.length}</span>}</div>
          {steps.length === 0 && <div style={faint}>No checklist yet.</div>}
          {steps.map((s) => (
            <label key={s.id} style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12.5, padding: '2px 0' }}>
              <input type="checkbox" checked={s.done} onChange={(e) => void act(() => api.taskSteps(org.workspaceId, task.id, e.target.checked ? { done: s.id } : { undo: s.id }))} />
              <span style={{ textDecoration: s.done ? 'line-through' : 'none', color: s.done ? 'var(--text-dim)' : 'var(--text)' }}>{s.text}</span>
            </label>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input aria-label="New step" value={stepText} onChange={(e) => setStepText(e.target.value)} placeholder="Add a step" style={input} />
            <button style={btn()} disabled={!stepText.trim()} onClick={() => void act(async () => { await api.taskSteps(org.workspaceId, task.id, { add: stepText.trim() }); setStepText(''); })}>Add</button>
          </div>
        </div>
        <Suspense fallback={null}><TaskChecksPanel wsId={org.workspaceId} task={task} onRan={() => void refresh()} /></Suspense>
        <Suspense fallback={null}><TaskQcPanel wsId={org.workspaceId} task={task} /></Suspense>
        {/* Extension point: panels plugins add to a task (docs/plugins.md §3.8). */}
        <PluginPanels placement="task" context={{ taskKey: task.key ?? '', taskTitle: task.title }} />
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
          {task.status === 'blocked' && <button style={btn()} onClick={() => void act(() => blockedOn ? api.setTaskBlockedOn(org.workspaceId, task.id, { clear: true }) : api.updateOrgTask(org.workspaceId, task.id, { status: 'todo', blockers: [] }))}>Unblock → todo</button>}
          {!['done', 'cancelled'].includes(task.status) && <button style={btn(false, true)} onClick={() => void act(() => api.updateOrgTask(org.workspaceId, task.id, { status: 'cancelled' }))}>Cancel task</button>}
        </div>
        {task.status === 'in_review' && <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Review note (optional)" style={input} />}
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Timeline</div>
          {comments.length === 0 && <div style={faint}>No comments yet.</div>}
          {comments.map((c) => { const a = c.fromAgentId ? names.get(c.fromAgentId) : undefined; const who = a?.name ?? (c.fromUserId && c.fromUserId !== app.me?.actorId ? app.nameOf(c.fromUserId) : 'You'); return (
            <div key={c.id} data-testid="task-comment" style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border-soft)' }}>
              {a ? <Avatar a={a} size={18} /> : <span style={{ fontSize: 14 }}>🧑‍💼</span>}
              <div style={{ flex: 1, minWidth: 0 }}><div style={faint}>{who} · {ago(c.createdAt)} <ClaimBadge claim={claims.get(c.id)} /></div><div style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}><Markdown text={c.text} compact mentions={storedMentions(c.mentions, mentionables)} /></div></div>
            </div>); })}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <MentionBox value={text} onChange={setText} members={mentionables} ariaLabel="Comment" placeholder="Comment — wakes the owner · @ to tag a member or a person" style={input}
              onSubmit={() => { if (text.trim()) void act(async () => { await api.commentOrgTask(org.workspaceId, task.id, text.trim()); setText(''); }); }} />
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
  const decision = parseDecisionJson(r.modelDecision);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border-soft)' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' }} />
      <Avatar a={a} size={18} />
      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
        <span style={{ fontWeight: 600 }}>{a?.name ?? '?'}</span> {r.wakeReason} → {r.outcome || r.status}{title ? <span style={faint}> · {title}</span> : null}
        <div style={faint}>{ago(r.startedAt)} · {r.tokensIn + r.tokensOut} tokens · {fmtUsd(r.usd)}{decision ? <span data-testid="run-tier" title={decisionReasons(decision)}> · {decisionLabel(decision)}</span> : null}</div>
      </div>
      {r.sessionId && <button style={btn()} onClick={() => app.openSession(r.sessionId!)}>Open session</button>}
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
  // An improvement proposal's normal change, or the review of an emergency change (docs/improvements.md).
  if (kind === 'improvement') return (
    <div style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
      <div>{p.review ? 'Review the emergency change ' : 'Improvement '}<b>{String(p.key ?? '')}</b> on {String(p.targetLabel || 'the company')}: {String(p.title ?? '')} <span style={faint}>({String(p.category ?? '')}, {String(p.changeClass ?? '')} change)</span></div>
      {p.hypothesis ? <div><i>{String(p.hypothesis)}</i></div> : null}
      {list(p.diff).length > 0 && <pre style={{ ...mono, whiteSpace: 'pre-wrap', background: 'var(--panel-2)', padding: 8, borderRadius: 8, maxHeight: 220, overflow: 'auto' }}>{list(p.diff).map((l, i) => <div key={i} style={{ color: l.startsWith('+') ? 'var(--green)' : l.startsWith('-') ? 'var(--red)' : undefined }}>{l}</div>)}</pre>}
      <div style={faint}>Expected: {String(p.expected ?? 'no metric named')}. {p.review ? 'Approve keeps it; reject reverts it.' : 'Approve applies it through the target\'s own versioning; it is verified against the metric after the window.'} Operations › Improvements has the evidence and history.</div>
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
  const [spend, setSpend] = useState<OrgSpend | null | undefined>(undefined);
  const [forecast, setForecast] = useState<OrgForecast | null>(null);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    const [s, f] = await Promise.all([api.orgSpend(org.workspaceId).catch(() => null), api.orgForecast(org.workspaceId).catch(() => null)]);
    setSpend(s); setForecast(f);
  }, [org.workspaceId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const setCap = async (scope: 'agent' | 'project', refId: string) => {
    try { await api.setOrgBudget(org.workspaceId, { scope, refId, monthlyUsd: Number(caps[refId] ?? 0) }); await refresh(); await reload(); app.showToast('Envelope set'); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  if (spend === undefined) return <PageSkeleton cards={2} />;
  if (spend === null) return <div className="co-page"><PageHeader title="Spend" /><div className="co-alert" role="alert">Spend did not load. Try again in a moment.</div></div>;
  const windowLabel = `${spendWindowLabel(spend.month)} (UTC) to date`;
  const fc = (scope: string, refId: string) => forecast ? (scope === 'company' ? forecast.company : [...forecast.agents, ...forecast.projects].find((f) => f.scope === scope && f.refId === refId)) : undefined;
  const node = (scope: 'company' | 'agent' | 'project', refId: string, label: ReactNodeLike, n: { usd: number; monthlyUsd: number; reservedUsd: number; runs: number }) => {
    const share = n.monthlyUsd > 0 ? n.usd / n.monthlyUsd : null;
    const f = fc(scope, refId);
    const tone = share === null ? undefined : share >= 1 ? 'bad' : share >= 0.8 ? 'warn' : 'ok';
    return (
      <div key={`${scope}:${refId}`} data-testid={`spend-${scope}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(120px, 1fr) minmax(150px, auto)', gap: 14, alignItems: 'center', padding: '10px 14px', borderTop: '1px solid var(--border-soft)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
          <div className="co-faint">{n.runs} run{n.runs === 1 ? '' : 's'}{f && f.dailyBurnUsd > 0 ? ` · ${fmtUsd(f.dailyBurnUsd)}/day` : ''}</div>
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <span className="co-num" style={{ fontSize: 12.5 }}>{fmtUsd(n.usd)}<span className="co-dim"> {n.monthlyUsd > 0 ? `of ${fmtUsd(n.monthlyUsd)}` : 'no envelope'}</span></span>
          {share !== null && <KitBar value={Math.min(1, share)} tone={tone} marker={f && n.monthlyUsd > 0 ? Math.min(1, f.projectedUsd / n.monthlyUsd) : null} label={`${typeof label === 'string' ? label : scope} spend`} />}
          {f && n.monthlyUsd > 0 && <span className={`co-faint${f.state === 'stop' ? ' co-bad' : ''}`} style={f.state !== 'onTrack' ? { color: f.state === 'stop' ? 'var(--red-text)' : 'var(--warn-text)' } : undefined}>Month-end forecast {fmtUsd(f.projectedUsd)}{f.projectedPct !== null ? ` (${Math.round(f.projectedPct)}%)` : ''}</span>}
        </div>
        {scope === 'company'
          // The company envelope is set in one place: Settings › Company, beside the mode and the agent cap.
          ? <button className="co-link" style={{ justifySelf: 'start' }} data-testid="envelope-settings-link" onClick={() => app.openSettings('company')}>Change in Settings</button>
          : <form style={{ display: 'flex', gap: 4 }} onSubmit={(e) => { e.preventDefault(); void setCap(scope, refId); }}><label className="co-sr" htmlFor={`cap-${refId}`}>Monthly envelope in USD</label><input id={`cap-${refId}`} className="co-input co-num" value={caps[refId] ?? String(n.monthlyUsd || '')} onChange={(e) => setCaps({ ...caps, [refId]: e.target.value.replace(/[^\d.]/g, '') })} style={{ padding: '4px 8px', width: 90 }} placeholder="$ / month" /><button type="submit" className="co-btn small">Set</button></form>}
      </div>
    );
  };
  const co = forecast?.company;
  return (
    <div className="co-page narrow" data-testid="spend-page">
      <PageHeader title={`Spend · ${windowLabel}`} purpose="Every figure comes from the one spend ledger. A run reserves its estimate before the model is called and settles from actual usage; 80% of an envelope warns, 100% stops that scope." />
      <div className="co-metrics" style={{ marginBottom: 16 }}>
        <Metric n={fmtUsd(spend.company.usd)} label={`spent, ${windowLabel}`} />
        <Metric n={spend.company.monthlyUsd > 0 ? fmtUsd(spend.company.monthlyUsd) : 'none'} label="company envelope" />
        {co && <Metric n={fmtUsd(co.projectedUsd)} label="month-end forecast" tone={co.state === 'stop' ? 'bad' : co.state === 'warn' ? 'warn' : undefined} title={`Trailing ${forecast!.windowDays}-day burn of ${fmtUsd(co.dailyBurnUsd)}/day, day ${forecast!.day} of ${forecast!.daysInMonth}`} />}
        {spend.company.reservedUsd > 0 && <Metric n={fmtUsd(spend.company.reservedUsd)} label="held for runs in flight" />}
        <Metric n={spend.costPerAcceptedTask !== null ? fmtUsd(spend.costPerAcceptedTask) : '—'} label={`per accepted task (${spend.acceptedTasks})`} />
      </div>
      {co && co.state !== 'onTrack' && <div className="co-note warn" style={{ marginBottom: 14 }}>At the current burn the company spends {fmtUsd(co.projectedUsd)} by month end, {co.projectedPct !== null ? `${Math.round(co.projectedPct)}% of` : 'past'} its {fmtUsd(co.capUsd)} envelope{co.state === 'stop' ? ': work stops when it is reached' : ''}.</div>}
      <KitCard title="Daily spend" aside={windowLabel}><UsageBars series={spend.series} /></KitCard>
      <div style={{ height: 14 }} />
      <KitCard title="Envelopes" aside="the bar is spent; the tick is the month-end forecast" flush>
        {node('company', org.id, `${org.name} (company)`, spend.company)}
        {spend.projects.length > 0 && <div className="co-sub" style={{ padding: '0 14px' }}>Projects</div>}
        {spend.projects.map((p) => node('project', p.id, p.title, p))}
        {spend.members.length > 0 && <div className="co-sub" style={{ padding: '0 14px' }}>Members · includes their meetings, reviews and audits{(spend.company.overheadUsd ?? 0) > 0 ? ` (${fmtUsd(spend.company.overheadUsd ?? 0)} of the company's)` : ''}</div>}
        {spend.members.map((m) => node('agent', m.agentId, `${m.name}${m.title ? ` · ${m.title}` : ''}${m.status === 'terminated' ? ' (left)' : ''}`, m))}
      </KitCard>
      <div style={{ height: 14 }} />
      <KitCard title="Tokens by member"><UsageRows rows={spend.members.map((m) => ({ key: m.agentId, label: m.name, tokensIn: m.tokensIn, tokensOut: m.tokensOut, usd: m.usd, turns: m.runs }))} /></KitCard>
    </div>
  );
}
type ReactNodeLike = string;

// ---- audit ----

function Audit({ org }: { org: OrgDetail }) {
  const app = useApp();
  const names = useAgentNames();
  const [runs, setRuns] = useState<OrgRun[] | null>(null);
  const [tasks, setTasks] = useState<OrgTask[]>([]);
  const [audit, setAudit] = useState<OrgAuditRow[] | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; length: number; brokenAt: number | null; reason?: string } | null>(null);
  const [layer, setLayer] = useState<'audit' | 'runs'>('audit');
  const [f, setF] = useState<AuditFilter>({ q: '', category: 'all', actor: 'all', autoOnly: false, routine: false });
  const [limit, setLimit] = useState(300);
  useEffect(() => {
    void Promise.all([api.orgRuns(org.workspaceId).catch(() => []), api.orgTasks(org.workspaceId).catch(() => []), api.orgAudit(org.workspaceId, limit).catch(() => []), api.verifyOrgAudit(org.workspaceId).catch(() => null)])
      .then(([r, t, a, v]) => { setRuns(r); setTasks(t); setAudit(a); setVerify(v); });
  }, [org.workspaceId, limit]);
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const agentName = (id: string) => names.get(id)?.name;
  const refName = (refType: string, refId: string) => (refType === 'task' ? titles.get(refId) : refType === 'goal' ? org.goals.find((g) => g.id === refId)?.title : refType === 'project' ? org.projects.find((p) => p.id === refId)?.title : refType === 'member' || refType === 'agent' ? names.get(refId)?.name : undefined);
  const rows = useMemo(() => filterAudit(audit ?? [], f, agentName), [audit, f, names]); // eslint-disable-line react-hooks/exhaustive-deps
  const actors = useMemo(() => [...new Set((audit ?? []).map((r) => r.actor))], [audit]);
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const r of audit ?? []) { const k = auditCategory(r.action); c[k] = (c[k] ?? 0) + 1; } return c; }, [audit]);
  const set = (p: Partial<AuditFilter>) => setF((x) => ({ ...x, ...p }));
  return (
    <div className="co-page narrow" data-testid="audit-page">
      <PageHeader title="Audit" purpose="Every change the company made, in a hash-chained log that cannot be edited after the fact, and every run with its outcome. Rows the chief did on its own carry its reason."
        actions={<>
          {verify && <Pill tone={verify.ok ? 'ok' : 'bad'} title={verify.ok ? 'Every row’s hash matches the one before it' : verify.reason}>{verify.ok ? `Chain intact · ${verify.length} rows` : `Chain broken at #${verify.brokenAt}`}</Pill>}
          <div className="co-seg" role="tablist" aria-label="Layer"><button role="tab" aria-selected={layer === 'audit'} onClick={() => setLayer('audit')}>Changes</button><button role="tab" aria-selected={layer === 'runs'} onClick={() => setLayer('runs')}>Runs</button></div>
        </>} />
      {layer === 'runs' && <div className="co-card" style={{ padding: '4px 14px' }}>{runs === null ? <SkeletonRows rows={4} /> : runs.length === 0 ? <KitEmpty compact title="No runs yet">Assign a task to wake somebody.</KitEmpty> : runs.map((r) => <RunRow key={r.id} r={r} names={names} title={titles.get(r.taskId)} />)}</div>}
      {layer === 'audit' && (
        <>
          {verify && !verify.ok && <div className="co-alert" role="alert" style={{ marginBottom: 12 }}>The chain is broken at #{verify.brokenAt}: {verify.reason}. Rows after it cannot be trusted until it is explained.</div>}
          <div className="co-toolbar">
            <SearchBox value={f.q} onChange={(q) => set({ q })} label="Search the audit log" placeholder="Search who did what" />
            <select className="co-input" style={{ width: 'auto' }} aria-label="Who" value={f.actor} onChange={(e) => set({ actor: e.target.value })}>
              <option value="all">Anyone</option>
              {actors.map((a) => <option key={a} value={a}>{actorWords(a, agentName, (id) => app.nameOf(id))}</option>)}
            </select>
            <label className="co-chip" style={{ cursor: 'pointer' }}><input type="checkbox" checked={f.autoOnly} onChange={(e) => set({ autoOnly: e.target.checked })} style={{ margin: 0 }} />Only what the chief did on its own</label>
            <label className="co-chip" style={{ cursor: 'pointer' }} title="Runs starting and ending, spend reserved and settled"><input type="checkbox" checked={Boolean(f.routine)} onChange={(e) => set({ routine: e.target.checked })} style={{ margin: 0 }} />Include run bookkeeping</label>
          </div>
          <div className="co-chips" role="tablist" aria-label="Kind of change" style={{ marginBottom: 12 }}>
            {(['all', 'goals', 'work', 'people', 'money', 'decisions', 'system'] as const).filter((k) => k === 'all' || counts[k]).map((k) => (
              <button key={k} role="tab" aria-selected={f.category === k} className={`co-chip${f.category === k ? ' on' : ''}`} onClick={() => set({ category: k })}>{k === 'all' ? 'All' : AUDIT_CATEGORY_LABEL[k]}<span className="co-chip-n">{k === 'all' ? audit?.length ?? 0 : counts[k]}</span></button>
            ))}
          </div>
          <div className="co-card" style={{ padding: '4px 6px' }}>
            {audit === null ? <SkeletonRows rows={6} label="Loading the audit log" /> : rows.length === 0 ? <KitEmpty compact title={audit.length ? 'No change matches' : 'Nothing recorded yet'}>{audit.length ? 'Try fewer filters or other words.' : 'Changes appear here as the company works.'}</KitEmpty> : (
              <ol style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="audit-rows">
                {rows.map((r) => {
                  const s = auditSentence(r, agentName, (id) => app.nameOf(id), refName);
                  return (
                    <li key={r.id} className="co-row static" data-testid="audit-row" style={{ alignItems: 'flex-start' }}>
                      <span className="co-row-main">
                        <span className="co-row-title wrap" style={{ fontWeight: 550 }}>{s.text}{s.auto && <> <Pill tone="warn" plain>autonomous</Pill></>}</span>
                        {s.detail && <span className="co-row-meta" style={{ whiteSpace: 'normal' }}>{s.detail}</span>}
                      </span>
                      <span className="co-row-end" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 2 }} title={`${r.action} · ${r.refType}${r.refId ? `:${r.refId}` : ''} · hash ${r.hash.slice(0, 12)}`}>
                        <span>{ago(r.createdAt)}</span><span className="co-key" style={{ marginRight: 0 }}>#{r.seq}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          {audit && audit.length >= limit && <button className="co-btn small" style={{ marginTop: 10 }} onClick={() => setLimit(limit + 500)}>Load older changes</button>}
        </>
      )}
    </div>
  );
}

// ---- brief ----

function BriefView({ org, mode }: { org: OrgDetail; mode: string }) {
  const app = useApp();
  const [brief, setBrief] = useState<OrgBrief | null | undefined>(undefined);
  const [reply, setReply] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => setBrief(await api.orgBrief(org.workspaceId).catch(() => null)), [org.workspaceId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const compose = async () => { setBusy(true); try { setBrief(await api.composeOrgBrief(org.workspaceId)); setResult(null); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } finally { setBusy(false); } };
  const review = async () => { try { const r = await api.reviewOrgStructure(org.workspaceId); app.showToast(r.result === 'ran' ? 'The chief reviewed the structure: see Audit and #company' : `Review ${r.result}`); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  const send = async () => {
    try {
      const r = await api.replyOrgBrief(org.workspaceId, reply);
      setResult(`${r.decisions.map((d) => `#${d.n} ${d.decision} → ${d.status}`).join(' · ') || 'Nothing resolved'}${r.unresolved.length ? ` · unresolved: ${r.unresolved.join(', ')}` : ''}`);
      setReply(''); await app.refreshAgents(); await refresh();
    } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  const hour = `${String(org.briefHour).padStart(2, '0')}:00`;
  return (
    <div className="co-page narrow" data-testid="brief-page">
      <PageHeader title="Brief" purpose={<>The chief writes it daily at {hour} (workspace time, quiet hours respected) and pushes it to your channels. Answer its numbered decisions in one line.{mode === 'autonomous' ? ' In autonomous mode it also lists what the chief did on its own.' : ''}</>}
        actions={<>
          {mode === 'autonomous' && <button className="co-btn" title="Wake the chief of staff to review idle and overloaded members, unassigned goals and blocked tasks" onClick={() => void review()}>Review structure now</button>}
          <button className="co-btn" disabled={busy} onClick={() => void compose()}>{busy ? 'Writing…' : 'Write one now'}</button>
        </>} />
      {brief === undefined ? <PageSkeleton cards={1} /> : !brief ? (
        <div className="co-card"><KitEmpty title="No brief yet" action={<button className="co-btn primary" onClick={() => void compose()}>Write one now</button>}>The next one is written at {hour}.</KitEmpty></div>
      ) : (
        <article className="co-card" style={{ padding: '18px 22px' }} data-testid="brief-doc">
          <div className="co-faint" style={{ marginBottom: 10 }}>{new Date(brief.at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · written {ago(brief.at)}{brief.items.length ? ` · ${brief.items.length} decision${brief.items.length === 1 ? '' : 's'} to answer` : ''}</div>
          <div className="co-prose"><Markdown text={brief.text} /></div>
        </article>
      )}
      {brief && brief.items.length > 0 && (
        <form className="co-card co-form" style={{ padding: 14, marginTop: 14 }} onSubmit={(e) => { e.preventDefault(); if (reply.trim()) void send(); }}>
          <label className="co-field"><span>Answer the numbered decisions</span>
            <input className="co-input" value={reply} onChange={(e) => setReply(e.target.value)} placeholder='e.g. "do 1, 3, skip 2" or "revise 2: halve the budget"' />
            <small>{brief.items.map((it) => `#${it.n} ${it.summary}`).join(' · ').slice(0, 300)}</small>
          </label>
          <div className="co-form-foot"><button type="submit" className="co-btn primary" disabled={!reply.trim()}>Send answer</button></div>
          {result && <div role="status" className="co-note">{result}</div>}
        </form>
      )}
    </div>
  );
}
