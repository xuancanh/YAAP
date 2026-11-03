/** The company section dashboards (docs/company-vision.md "On screen"):
 *  each of Direction, Operations, People, Money and Oversight opens on a
 *  page of compact cards that summarise its pages and link into them. A
 *  dashboard opens with one plain sentence on the state of the section; what
 *  waits on the CEO is never decided here — a slim row links to the Inbox.
 *  Also the Teams page (People › Teams): every unit with its lead, members,
 *  channel, board and goals. Summaries are pure (src/lib/company-dash.ts). */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApp, type OrgFocus, type OrgPane } from '../store';
import {
  api, type OrgAllocation, type OrgAuditRow, type OrgAuditRun, type OrgBrief, type OrgCapacity, type OrgDecision, type OrgDetail, type OrgForecast,
  type OrgIncident, type OrgPulse, type OrgSpend, type OrgTask, type OrgVisionInfo, type RoadmapData, type TrustOverview, type OrgUnitNode,
} from '../lib/api';
import { sectionDef, type CompanySection } from '../lib/company-nav';
import {
  boardCounts, budgetLines, capitalByGoal, directionLede, findingsCount, flatUnits, incidentHistory, laneCounts, moneyLede, nextRituals, objectivesOf,
  operationsLede, oversightLede, peopleLede, yesterdayKey,
} from '../lib/company-dash';
import { atRiskByUnit, firesOn, flattenIntent, MEETING_KIND_TITLES } from '../lib/org';
import { briefSummary } from '../lib/home';
import { fmtUsd } from '../lib/pricing';
import { Markdown } from '../lib/md';
import { faint, linkBtn, ago, Avatar, useAgentNames } from './org-ui';

// ---- the parts every dashboard shares ----

const GAP = 14;
const cardStyle: React.CSSProperties = { minWidth: 0, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 13, display: 'flex', flexDirection: 'column' };
const num: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid var(--border-soft)', fontSize: 12.5, minWidth: 0 };
const ellipsis: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
const rowBtn: React.CSSProperties = { ...row, width: '100%', background: 'none', border: 'none', borderTop: '1px solid var(--border-soft)', color: 'var(--text)', font: 'inherit', fontSize: 12.5, textAlign: 'left', cursor: 'pointer' };

/** One card: its title opens the page it summarises. `lead` spans the row. */
function Card({ id, title, open, openLabel, lead, children, aside }: { id: string; title: string; open?: () => void; openLabel?: string; lead?: boolean; children: ReactNode; aside?: ReactNode }) {
  return (
    <section data-testid={`dash-card-${id}`} aria-labelledby={`dash-${id}`} style={{ ...cardStyle, ...(lead ? { gridColumn: '1 / -1' } : {}) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px 8px', flexWrap: 'wrap' }}>
        <h3 id={`dash-${id}`} style={{ margin: 0, fontSize: 15, fontWeight: 650, letterSpacing: '.05em', fontVariantCaps: 'all-small-caps', color: 'var(--text)' }}>{title}</h3>
        {aside}
        <span style={{ flex: 1 }} />
        {open && <button style={linkBtn} onClick={open}>{openLabel ?? `Open ${title.toLowerCase()}`}</button>}
      </div>
      <div style={{ padding: '0 16px 14px', flex: 1, minWidth: 0 }}>{children}</div>
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gap: GAP, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', alignItems: 'start' }}>{children}</div>;
}

/** The dashboard's opening: what the section is for, then where it stands, in one sentence. */
function Lede({ section, state }: { section: CompanySection; state: string | null }) {
  const def = sectionDef(section);
  return (
    <div style={{ marginBottom: 16, maxWidth: 760 }}>
      <p data-testid="dash-lede" style={{ margin: 0, fontSize: 18, lineHeight: 1.4, fontWeight: 560, letterSpacing: '-.2px', color: 'var(--text)', minHeight: 25 }}>{state ?? ' '}</p>
      <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>{def.blurb}</p>
    </div>
  );
}

/** What waits on the CEO from this section: decided in the Inbox, linked from here. */
function InboxRow({ text, pane }: { text: string; pane: Extract<OrgPane, 'approvals' | 'plans' | 'mytasks'> }) {
  const app = useApp();
  return (
    <button data-testid="dash-inbox-row" onClick={() => { app.setOrgFocus(null); app.setOrgPane(pane); }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', marginBottom: GAP, padding: '10px 14px', borderRadius: 11, border: '1px solid var(--border)', borderLeft: '3px solid var(--amber)', background: 'var(--panel-2)', color: 'var(--text)', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>
      <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
      <span style={{ ...linkBtn, flex: 'none' }}>Open the Inbox</span>
    </button>
  );
}

function Bar({ value, color = 'var(--accent)', label }: { value: number; color?: string; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 5, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden', flex: 1, minWidth: 40 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
    </div>
  );
}

/** A labelled figure inside a sentence-like strip ("12 in progress"). */
function Fig({ n, label, tone }: { n: number | string; label: string; tone?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, whiteSpace: 'nowrap' }}>
      <span style={{ ...num, fontSize: 20, fontWeight: 650, color: tone ?? 'var(--text)', letterSpacing: '-.3px' }}>{n}</span>
      <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{label}</span>
    </span>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <div style={{ ...faint, fontSize: 12.5, padding: '2px 0' }}>{children}</div>;
const Loading = () => <div style={faint}>Loading…</div>;
const HEALTH_COLOR: Record<string, string> = { on_track: 'var(--green)', at_risk: 'var(--amber)', off_track: 'var(--red)' };

/** Fetch a dashboard's data once per workspace: undefined while loading, null if it failed. */
function useData<T>(load: (wsId: string) => Promise<T>, wsId: string, key = ''): T | null | undefined {
  const [state, setState] = useState<{ k: string; v: T | null } | null>(null);
  const k = `${wsId}|${key}`;
  useEffect(() => {
    let live = true;
    load(wsId).then((v) => { if (live) setState({ k, v }); }).catch(() => { if (live) setState({ k, v: null }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
  return state && state.k === k ? state.v : undefined;
}

function useOpen() {
  const app = useApp();
  return (pane: OrgPane, focus: OrgFocus | null = null, unitId: string | null = null) => {
    app.setOrgFocus(focus); app.setOrgUnitId(unitId); app.setOrgPane(pane); app.setMobileDetail(true);
  };
}

export function SectionDashboard({ section, org }: { section: CompanySection; org: OrgDetail }) {
  return (
    <div data-testid={`dashboard-${section}`} style={{ maxWidth: 1180 }}>
      {section === 'direction' && <DirectionDashboard org={org} />}
      {section === 'operations' && <OperationsDashboard org={org} />}
      {section === 'people' && <PeopleDashboard org={org} />}
      {section === 'money' && <MoneyDashboard org={org} />}
      {section === 'oversight' && <OversightDashboard org={org} />}
    </div>
  );
}

// ---- Direction ----

function DirectionDashboard({ org }: { org: OrgDetail }) {
  const app = useApp();
  const open = useOpen();
  const ws = org.workspaceId;
  const vision = useData<OrgVisionInfo>(api.orgVision, ws);
  const roadmap = useData<RoadmapData>(api.orgRoadmap, ws);
  const decisions = useData<OrgDecision[]>((w) => api.orgDecisions(w), ws);
  const objectives = useMemo(() => objectivesOf(app.orgIntent ?? []), [app.orgIntent]);
  const lanes = roadmap ? laneCounts(roadmap.projects) : null;
  const pending = app.wsOrg?.pendingApprovals ?? 0;
  const nowProjects = (roadmap?.projects ?? []).filter((p) => p.lane === 'now' && p.status !== 'done' && p.status !== 'cancelled').sort((a, b) => a.rank - b.rank).slice(0, 4);
  return (
    <>
      <Lede section="direction" state={directionLede(objectives, lanes)} />
      {pending > 0 && <InboxRow pane="approvals" text={`${pending} decision card${pending === 1 ? '' : 's'} wait${pending === 1 ? 's' : ''} on you.`} />}
      <Grid>
        <Card id="vision" title="Vision" lead open={() => open('vision')}>
          {vision === undefined ? <Loading /> : !vision?.vision ? <Empty>No vision yet. Write the one sentence the company works toward.</Empty> : (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <div style={{ flex: '2 1 320px', minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4 }}>{vision.vision.title}</div>
                {vision.vision.description && <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{vision.vision.description}</div>}
              </div>
              {(vision.values || vision.vision.dueAt) && (
                <div style={{ flex: '1 1 200px', minWidth: 0, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  {vision.vision.dueAt && <div>Horizon: <span style={{ color: 'var(--text)' }}>{new Date(vision.vision.dueAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span></div>}
                  {vision.values && <div style={{ ...ellipsis, whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>Values: <span style={{ color: 'var(--text)' }}>{vision.values.replace(/\n+/g, ' · ')}</span></div>}
                </div>
              )}
            </div>
          )}
        </Card>
        <Card id="goals" title="Goals" open={() => open('goals')} aside={objectives.length > 0 ? <span style={faint}>{objectives.length} objective{objectives.length === 1 ? '' : 's'}</span> : undefined}>
          {objectives.length === 0 ? <Empty>No objectives yet.</Empty> : objectives.slice(0, 5).map((o) => (
            <button key={o.id} style={rowBtn} onClick={() => open('vision', { kind: 'goal', id: o.id })} title={o.atRisk ? o.reason || 'At risk' : undefined}>
              <span style={{ ...ellipsis, flex: '1 1 50%' }}>{o.title}</span>
              {o.atRisk && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--amber)' }}>at risk</span>}
              <Bar value={o.progress} color={o.atRisk ? 'var(--amber)' : 'var(--accent)'} label={`${o.title} progress`} />
              <span style={{ ...num, ...faint, width: 34, textAlign: 'right' }}>{Math.round(o.progress * 100)}%</span>
            </button>
          ))}
        </Card>
        <Card id="roadmap" title="Roadmap" open={() => open('roadmap')}>
          {roadmap === undefined ? <Loading /> : !roadmap ? <Empty>The roadmap is not available.</Empty> : (
            <>
              <div style={{ display: 'flex', gap: 18, marginBottom: 6 }}><Fig n={lanes!.now} label="now" /><Fig n={lanes!.next} label="next" /><Fig n={lanes!.later} label="later" /></div>
              {nowProjects.length === 0 ? <Empty>Nothing in Now.</Empty> : nowProjects.map((p) => (
                <button key={p.id} style={rowBtn} onClick={() => open('roadmap', { kind: 'project', id: p.id })}>
                  <span aria-label={p.health || 'no update'} style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: HEALTH_COLOR[p.health] ?? 'var(--border)' }} />
                  <span style={{ ...ellipsis, flex: 1 }}>{p.key ? <span style={{ ...faint, marginRight: 5 }}>{p.key}</span> : null}{p.title}</span>
                  <span style={{ ...num, ...faint }}>{p.progress.pct}%</span>
                </button>
              ))}
            </>
          )}
        </Card>
        <Card id="decisions" title="Decisions" open={() => open('decisions')} openLabel="Decision log">
          {decisions === undefined ? <Loading /> : !decisions || decisions.length === 0 ? <Empty>Nothing decided yet. Decisions from meetings and cards land here.</Empty> : decisions.slice(0, 4).map((d) => (
            <button key={d.id} style={rowBtn} onClick={() => open('decisions', { kind: 'decision', id: d.id })}>
              <span style={{ ...ellipsis, flex: 1 }}>{d.title || d.decision}</span>
              <span style={faint}>{ago(d.createdAt)}</span>
            </button>
          ))}
        </Card>
      </Grid>
    </>
  );
}

// ---- Operations ----

function OperationsDashboard({ org }: { org: OrgDetail }) {
  const app = useApp();
  const open = useOpen();
  const ws = org.workspaceId;
  const tasks = useData<OrgTask[]>((w) => api.orgTasks(w), ws);
  const pulse = useData<OrgPulse>(api.orgPulse, ws);
  const brief = useData<OrgBrief | null>(api.orgBrief, ws);
  const names = useAgentNames();
  const board = tasks ? boardCounts(tasks) : null;
  const health = app.orgHealth;
  const openIncidents = (health?.openIncidents ?? []).filter((i) => i.status === 'open');
  const live = (health?.openIncidents ?? []);
  const units = app.wsOrg?.units ?? [];
  const today = (app.orgCadences ?? []).filter((c) => c.enabled === 1 && firesOn(c.cron));
  const upcoming = nextRituals(app.orgCadences ?? [], units);
  const blocked = (tasks ?? []).filter((t) => t.status === 'blocked').slice(0, 3);
  const summary = brief ? briefSummary(brief.text, 2) : null;
  return (
    <>
      <Lede section="operations" state={operationsLede(board, openIncidents.length, pulse ? pulse.score : null)} />
      {app.orgPendingPlans > 0 && <InboxRow pane="plans" text={`${app.orgPendingPlans} pending change${app.orgPendingPlans === 1 ? '' : 's'} will apply unless you veto ${app.orgPendingPlans === 1 ? 'it' : 'them'}.`} />}
      <Grid>
        <Card id="board" title="Board" lead open={() => open('board')}>
          {tasks === undefined ? <Loading /> : !board ? <Empty>The board is not available.</Empty> : (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', flex: '1 1 340px' }}>
                <Fig n={board.inProgress} label="in progress" />
                <Fig n={board.inReview} label="in review" />
                <Fig n={board.blocked} label="blocked" tone={board.blocked ? 'var(--red)' : undefined} />
                <Fig n={board.todo} label="to do" />
                <Fig n={board.doneThisWeek} label="done this week" tone={board.doneThisWeek ? 'var(--green)' : undefined} />
              </div>
              {blocked.length > 0 && (
                <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                  {blocked.map((t) => (
                    <button key={t.id} style={rowBtn} onClick={() => app.openOrgTask(t.key ?? t.id)}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--red)', flex: 'none' }}>blocked</span>
                      <span style={{ ...ellipsis, flex: 1 }}>{t.key ? <span style={{ ...faint, marginRight: 5 }}>{t.key}</span> : null}{t.title}</span>
                      {t.assigneeAgentId && <Avatar a={names.get(t.assigneeAgentId)} size={18} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
        <Card id="pulse" title="Pulse" open={() => open('pulse')} aside={pulse ? <span style={{ ...num, fontSize: 12, fontWeight: 700, color: pulse.score >= 70 ? 'var(--green)' : pulse.score >= 40 ? 'var(--amber)' : 'var(--red)' }}>{Math.round(pulse.score)} / 100</span> : undefined}>
          {pulse === undefined ? <Loading /> : !pulse ? <Empty>No pulse yet.</Empty> : pulse.breaches.length === 0 ? <Empty>Every target is met.</Empty> : pulse.breaches.slice(0, 3).map((b) => (
            <div key={b.metric} style={row}><span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--amber)', flex: 'none' }}>off target</span><span style={{ ...ellipsis, flex: 1 }}>{b.detail}</span></div>
          ))}
        </Card>
        <Card id="brief" title="Brief" open={() => open('brief')} openLabel="Read the brief" aside={brief ? <span style={faint}>{ago(brief.at)}</span> : undefined}>
          {brief === undefined ? <Loading /> : !brief || !summary ? <Empty>No brief yet. The chief of staff writes one daily at {String(org.briefHour).padStart(2, '0')}:00.</Empty> : (
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-dim)', maxHeight: 96, overflow: 'hidden' }}><Markdown text={summary.md} compact /></div>
          )}
        </Card>
        <Card id="meetings" title="Meetings" open={() => open('meetings')} aside={today.length > 0 ? <span style={faint}>{today.length} today</span> : undefined}>
          {upcoming.length === 0 ? <Empty>No rituals scheduled.</Empty> : upcoming.map((m) => (
            <div key={m.id} style={row}>
              <span style={{ ...ellipsis, flex: 1 }}>{MEETING_KIND_TITLES[m.kind] ?? m.kind} <span style={faint}>· {m.unitName}</span></span>
              <span style={{ ...faint, ...num }}>{whenNext(m.at)}</span>
            </div>
          ))}
        </Card>
        <Card id="incidents" title="Incidents" open={() => open('incidents')} aside={health ? <span style={{ fontSize: 11, fontWeight: 600, color: health.status === 'ok' ? 'var(--green)' : health.status === 'degraded' ? 'var(--amber)' : 'var(--red)' }}>{health.status === 'ok' ? 'healthy' : health.status}</span> : undefined}>
          {live.length === 0 ? <Empty>No open incidents{health && health.lines.length ? ` · ${health.lines[0]}` : ''}.</Empty> : live.slice(0, 4).map((i) => (
            <button key={i.id} style={rowBtn} onClick={() => open('incidents', { kind: 'incident', id: i.id })}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: i.status === 'open' ? 'var(--red)' : 'var(--amber)', flex: 'none' }}>{i.status === 'open' ? i.severity : 'contained'}</span>
              <span style={{ ...ellipsis, flex: 1 }}>{i.title}</span>
              <span style={faint}>{ago(i.openedAt)}</span>
            </button>
          ))}
        </Card>
      </Grid>
    </>
  );
}

/** "today 09:00", "Thu 09:00", "12 Nov". */
function whenNext(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  if (d.getTime() - now.getTime() < 6 * 86_400_000) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// ---- People ----

function PeopleDashboard({ org }: { org: OrgDetail }) {
  const app = useApp();
  const open = useOpen();
  const names = useAgentNames();
  const capacity = useData<OrgCapacity>(api.orgCapacity, org.workspaceId);
  const members = org.members.filter((m) => m.status !== 'terminated');
  const units = flatUnits(app.wsOrg?.units ?? []);
  const paused = members.filter((m) => m.status === 'paused').length;
  const chief = names.get(org.chiefOfStaffAgentId ?? '');
  const reports = (id: string) => members.filter((m) => m.reportsToAgentId === id).length;
  const leads = members.filter((m) => reports(m.agentId) > 0).sort((a, b) => a.depth - b.depth || reports(b.agentId) - reports(a.agentId)).slice(0, 5);
  const atLimit = capacity ? capacity.members.filter((m) => m.atLimit).length : 0;
  const loaded = capacity ? [...capacity.members].sort((a, b) => b.wip - a.wip || b.open - a.open).slice(0, 4) : [];
  const outside = app.agents.filter((a) => !members.some((m) => m.agentId === a.id)).length;
  return (
    <>
      <Lede section="people" state={peopleLede(members.length, Math.max(1, units.length), atLimit)} />
      <Grid>
        <Card id="chart" title="Org chart" lead open={() => open('chart')} openLabel="Open mission control">
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', flex: '1 1 300px' }}>
              <Fig n={members.length} label={members.length === 1 ? 'member' : 'members'} />
              <Fig n={units.length} label={units.length === 1 ? 'team' : 'teams'} />
              {paused > 0 && <Fig n={paused} label="paused" tone="var(--amber)" />}
              <Fig n={Math.max(0, ...members.map((m) => m.depth)) + 1} label="levels" />
            </div>
            <div style={{ flex: '1 1 300px', minWidth: 0 }}>
              {chief && <div style={{ ...row, borderTop: 'none' }}><Avatar a={chief} size={20} /><span style={{ ...ellipsis, flex: 1 }}>{chief.name} <span style={faint}>· chief of staff</span></span><span style={faint}>{reports(chief.id)} direct</span></div>}
              {leads.filter((m) => m.agentId !== chief?.id).slice(0, 4).map((m) => (
                <div key={m.id} style={row}><Avatar a={names.get(m.agentId)} size={20} /><span style={{ ...ellipsis, flex: 1 }}>{names.get(m.agentId)?.name ?? 'A member'}{m.title ? <span style={faint}> · {m.title}</span> : null}</span><span style={faint}>{reports(m.agentId)} direct</span></div>
              ))}
            </div>
          </div>
        </Card>
        <Card id="teams" title="Teams" open={() => open('teams')} openLabel="All teams">
          {units.length === 0 ? <Empty>One team: the company.</Empty> : units.slice(0, 5).map((u) => (
            <button key={u.id} style={rowBtn} onClick={() => open('teams')}>
              <Avatar a={names.get(u.leadAgentId)} size={18} />
              <span style={{ ...ellipsis, flex: 1 }}>{u.parentUnitId === null ? 'Company' : u.name}</span>
              <span style={faint}>{u.memberAgentIds.length} · {u.counts.openTasks} open</span>
            </button>
          ))}
        </Card>
        <Card id="capacity" title="Capacity" aside={capacity ? <span style={faint}>{capacity.wip} in progress</span> : undefined}>
          {capacity === undefined ? <Loading /> : !capacity || loaded.length === 0 ? <Empty>No work in progress.</Empty> : loaded.map((m) => (
            <div key={m.agentId} style={row}>
              <Avatar a={names.get(m.agentId)} size={18} />
              <span style={{ ...ellipsis, flex: 1 }}>{m.name}</span>
              {m.atLimit && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--amber)' }}>at limit</span>}
              <span style={{ ...faint, ...num }}>{m.wip} doing · {m.open} open</span>
            </div>
          ))}
        </Card>
        <Card id="agents" title="Agents" open={() => app.go('agents')} openLabel="All agents">
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {app.agents.length} agent{app.agents.length === 1 ? '' : 's'} in this workspace{outside > 0 ? `, ${outside} outside the company` : ''}. Hire a function head from the Market and it hires its own team.
          </div>
          <button style={{ ...linkBtn, marginTop: 8 }} onClick={() => app.go('market')}>Hire from the Market</button>
        </Card>
      </Grid>
    </>
  );
}

/** People › Teams: every unit as a card — lead, members, what is open, at risk and on today, and its channel, board and goals. */
export function TeamsPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const open = useOpen();
  const names = useAgentNames();
  const units = flatUnits(app.wsOrg?.units ?? []);
  const atRisk = useMemo(() => atRiskByUnit(app.orgIntent ?? []), [app.orgIntent]);
  const depthOf = useMemo(() => {
    const byId = new Map(units.map((u) => [u.id, u]));
    return (u: OrgUnitNode) => { let d = 0; let p = u.parentUnitId; while (p && byId.has(p) && d < 8) { d += 1; p = byId.get(p)!.parentUnitId; } return d; };
  }, [units]);
  if (units.length === 0) return <div style={faint}>No units yet: the company is one team. The chief of staff proposes units as the company grows.</div>;
  return (
    <div style={{ maxWidth: 1180 }} data-testid="teams-pane">
      <div style={{ ...faint, fontSize: 12.5, marginBottom: 14, maxWidth: 640 }}>Each team has a lead, a channel, a board and goals. The board and goals open filtered to the team. {org.name} is the top of the tree.</div>
      <Grid>
        {units.map((u) => {
          const isRoot = u.parentUnitId === null;
          const lead = names.get(u.leadAgentId);
          const channel = app.channels.find((c) => c.id === u.channelId) ?? app.channels.find((c) => c.slug === u.slug);
          const risk = (atRisk[u.id] ?? 0) + (isRoot ? atRisk[''] ?? 0 : 0);
          const today = (app.orgCadences ?? []).filter((c) => c.unitId === u.id && c.enabled === 1 && firesOn(c.cron)).map((c) => MEETING_KIND_TITLES[c.kind] ?? c.kind);
          const unitId = isRoot ? null : u.id;
          const d = depthOf(u);
          return (
            <section key={u.id} data-testid={`team-${u.slug}`} style={{ ...cardStyle, padding: '13px 16px', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <Avatar a={lead} size={28} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...ellipsis, fontSize: 14, fontWeight: 650 }}>{isRoot ? 'Company' : u.name}</div>
                  <div style={{ ...faint, ...ellipsis }}>{d > 0 ? `level ${d + 1} · ` : ''}led by {lead?.name ?? 'an agent'}</div>
                </div>
                {risk > 0 && <span title={`${risk} goal(s) at risk`} style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--amber)' }}>{risk} at risk</span>}
              </div>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                {u.memberAgentIds.slice(0, 8).map((id) => <Avatar key={id} a={names.get(id)} size={18} />)}
                {u.memberAgentIds.length > 8 && <span style={faint}>+{u.memberAgentIds.length - 8}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                {u.memberAgentIds.length} member{u.memberAgentIds.length === 1 ? '' : 's'} · {u.counts.openTasks} open task{u.counts.openTasks === 1 ? '' : 's'} · {u.counts.goals} goal{u.counts.goals === 1 ? '' : 's'}{today.length ? ` · today: ${today.join(', ').toLowerCase()}` : ''}
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 2 }}>
                <button style={linkBtn} onClick={() => app.openChannel(channel?.slug ?? u.slug)}>#{channel?.slug ?? u.slug}</button>
                <button style={linkBtn} onClick={() => open('board', null, unitId)}>Board</button>
                <button style={linkBtn} onClick={() => open('goals', null, unitId)}>Goals</button>
              </div>
            </section>
          );
        })}
      </Grid>
    </div>
  );
}

// ---- Money ----

function MoneyDashboard({ org }: { org: OrgDetail }) {
  const app = useApp();
  const open = useOpen();
  const ws = org.workspaceId;
  const spend = useData<OrgSpend>(api.orgSpend, ws);
  const forecast = useData<OrgForecast>(api.orgForecast, ws);
  const allocations = useData<OrgAllocation[]>(api.orgAllocations, ws);
  const titles = useMemo(() => new Map(flattenIntent(app.orgIntent ?? []).map((g) => [g.id, g.title])), [app.orgIntent]);
  const cap = spend?.company.monthlyUsd ?? org.monthlyBudgetUsd ?? 0;
  const used = spend ? spend.company.usd + spend.company.reservedUsd : 0;
  const capital = allocations ? capitalByGoal(allocations, (id) => titles.get(id)) : [];
  const budgets = spend ? budgetLines(spend) : [];
  const warn = forecast ? [...forecast.agents, ...forecast.projects, ...forecast.objectives].filter((f) => f.state !== 'onTrack').slice(0, 4) : [];
  const series = spend?.series.slice(-30) ?? [];
  const peak = Math.max(0.000001, ...series.map((d) => d.usd));
  return (
    <>
      <Lede section="money" state={spend === undefined ? null : spend ? moneyLede(used, cap, forecast ? forecast.company.projectedUsd : null, fmtUsd) : 'Spend is not available.'} />
      <Grid>
        <Card id="spend" title="This month" lead open={() => open('spend')} openLabel="Open spend">
          {spend === undefined ? <Loading /> : !spend ? <Empty>Spend is not available.</Empty> : (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 10 }}>
                  <Fig n={fmtUsd(used)} label={cap > 0 ? `of ${fmtUsd(cap)}` : 'no envelope'} />
                  {forecast && <Fig n={fmtUsd(forecast.company.projectedUsd)} label="forecast" tone={forecast.company.state === 'stop' ? 'var(--red)' : forecast.company.state === 'warn' ? 'var(--amber)' : undefined} />}
                  {spend.costPerAcceptedTask !== null && <Fig n={fmtUsd(spend.costPerAcceptedTask)} label="per accepted task" />}
                </div>
                {cap > 0 && <Bar value={used / cap} color={used / cap >= 1 ? 'var(--red)' : used / cap >= 0.8 ? 'var(--amber)' : 'var(--green)'} label="Spend against the company envelope" />}
              </div>
              {series.length > 1 && (
                <svg role="img" aria-label="Spend per day, last 30 days" viewBox={`0 0 ${series.length * 6} 40`} preserveAspectRatio="none" style={{ flex: '1 1 260px', height: 44, minWidth: 0 }}>
                  {series.map((d, i) => { const h = Math.max(1, (d.usd / peak) * 38); return <rect key={d.day} x={i * 6} y={40 - h} width={4} height={h} rx={1} fill="var(--accent)" opacity={0.85}><title>{`${d.day}: ${fmtUsd(d.usd)}`}</title></rect>; })}
                </svg>
              )}
            </div>
          )}
        </Card>
        <Card id="budgets" title="Budgets" open={() => open('spend')} openLabel="Set budgets">
          {spend === undefined ? <Loading /> : budgets.length === 0 ? <Empty>No agent or project has its own envelope yet.</Empty> : budgets.map((b) => (
            <div key={b.key} style={row}>
              <span style={{ ...ellipsis, flex: '1 1 40%' }}>{b.label}</span>
              <Bar value={b.pct} color={b.pct >= 1 ? 'var(--red)' : b.pct >= 0.8 ? 'var(--amber)' : 'var(--green)'} label={`${b.label} against its envelope`} />
              <span style={{ ...faint, ...num, width: 96, textAlign: 'right' }}>{fmtUsd(b.usd)} / {fmtUsd(b.cap)}</span>
            </div>
          ))}
        </Card>
        <Card id="capital" title="Capital by goal" open={() => open('capital')} openLabel="Open capital">
          {allocations === undefined ? <Loading /> : capital.length === 0 ? <Empty>No capital allocated to goals yet.</Empty> : capital.slice(0, 5).map((c) => (
            <button key={c.goalId} style={rowBtn} onClick={() => open('capital')}>
              <span style={{ ...ellipsis, flex: 1 }}>{c.title}</span>
              <span style={{ ...num, fontSize: 12.5 }}>{fmtUsd(c.monthlyUsd)}<span style={faint}> / mo</span></span>
            </button>
          ))}
        </Card>
        <Card id="forecast" title="Forecast" open={() => open('capital')} openLabel="Open capital">
          {forecast === undefined ? <Loading /> : !forecast ? <Empty>No forecast yet.</Empty> : warn.length === 0 ? <Empty>Every envelope is on track for day {forecast.daysInMonth}.</Empty> : warn.map((f) => (
            <div key={`${f.scope}:${f.refId}`} style={row}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: f.state === 'stop' ? 'var(--red)' : 'var(--amber)', flex: 'none' }}>{f.state === 'stop' ? 'will stop' : 'warning'}</span>
              <span style={{ ...ellipsis, flex: 1 }}>{f.name}</span>
              <span style={{ ...faint, ...num }}>{fmtUsd(f.projectedUsd)} / {fmtUsd(f.capUsd)}</span>
            </div>
          ))}
          <div style={{ ...faint, marginTop: 8 }}>Tokens per agent and loop, and the price table, are in <button style={linkBtn} onClick={() => app.openSettings('usage')}>Settings › Usage</button>.</div>
        </Card>
      </Grid>
    </>
  );
}

// ---- Oversight ----

function OversightDashboard({ org }: { org: OrgDetail }) {
  const app = useApp();
  const open = useOpen();
  const ws = org.workspaceId;
  const verify = useData(api.verifyOrgAudit, ws);
  const audit = useData<OrgAuditRow[]>((w) => api.orgAudit(w, 30), ws);
  const runs = useData<OrgAuditRun[]>((w) => api.orgAudits(w, 5), ws);
  const trust = useData<TrustOverview>(api.workspaceTrust, ws);
  const incidents = useData<OrgIncident[]>((w) => api.orgIncidents(w), ws);
  const lastRun = (runs ?? []).find((r) => r.status === 'done') ?? null;
  const findings = lastRun ? findingsCount(lastRun.findings) : null;
  const history = incidents ? incidentHistory(incidents) : null;
  const auto = (audit ?? []).filter((r) => r.action.startsWith('auto_')).length;
  const lowTrust = trust ? trust.agents.filter((a) => a.classes.some((c) => c.effective === 0)).length : 0;
  return (
    <>
      <Lede section="oversight" state={verify === undefined ? null : oversightLede(verify ? verify.ok : null, findings)} />
      {app.orgHeldActions > 0 && <InboxRow pane="approvals" text={`${app.orgHeldActions} action${app.orgHeldActions === 1 ? '' : 's'} wait${app.orgHeldActions === 1 ? 's' : ''} for your key.`} />}
      <Grid>
        <Card id="audit" title="Audit trail" lead open={() => open('audit')} openLabel="Open audit"
          aside={verify ? <span style={{ fontSize: 11, fontWeight: 600, color: verify.ok ? 'var(--green)' : 'var(--red)' }}>{verify.ok ? `chain intact · ${verify.length} entries` : `broken at #${verify.brokenAt}`}</span> : undefined}>
          {audit === undefined ? <Loading /> : !audit || audit.length === 0 ? <Empty>Nothing recorded yet.</Empty> : (
            <>
              {auto > 0 && <div style={{ ...faint, marginBottom: 4 }}>{auto} of the last {audit.length} changes were the chief acting on its own.</div>}
              {audit.slice(0, 5).map((r) => (
                <div key={r.id} style={row}>
                  <span style={{ ...faint, ...num, width: 44, flex: 'none' }}>#{r.seq}</span>
                  <span style={{ ...ellipsis, flex: 1 }}><b style={{ fontWeight: 600 }}>{r.action.replace(/_/g, ' ')}</b> <span style={faint}>{r.refType}</span></span>
                  <span style={{ ...faint, ...ellipsis, maxWidth: 120 }}>{r.actor}</span>
                  <span style={faint}>{ago(r.createdAt)}</span>
                </div>
              ))}
            </>
          )}
        </Card>
        <Card id="auditor" title="Auditor" open={() => open('audit')} openLabel="Open audit">
          {runs === undefined ? <Loading /> : !lastRun ? <Empty>No audit has run yet.</Empty> : (
            <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              <div style={{ display: 'flex', gap: 18, marginBottom: 6 }}><Fig n={findings ?? 0} label={findings === 1 ? 'finding' : 'findings'} tone={findings ? 'var(--amber)' : 'var(--green)'} /><span style={{ ...faint, alignSelf: 'center' }}>{ago(lastRun.endedAt ?? lastRun.startedAt)}</span></div>
              {lastRun.summary && <div style={{ color: 'var(--text-dim)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{lastRun.summary}</div>}
            </div>
          )}
        </Card>
        <Card id="trust" title="Trust" open={() => app.openSettings('workspace')} openLabel="Trust levels">
          {trust === undefined ? <Loading /> : !trust ? <Empty>Trust levels are not available.</Empty> : (
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              <div style={{ display: 'flex', gap: 18, marginBottom: 6 }}><Fig n={trust.agents.length} label="agents earning trust" />{lowTrust > 0 && <Fig n={lowTrust} label="at level 0 somewhere" tone="var(--amber)" />}</div>
              Levels rise after clean outcomes and fall at once on an incident. Your ceilings cap them per action class.
            </div>
          )}
        </Card>
        <Card id="incident-history" title="Incident history" open={() => open('incidents')} openLabel="All incidents">
          {incidents === undefined ? <Loading /> : !history ? <Empty>Incidents are not available.</Empty> : (
            <>
              <div style={{ display: 'flex', gap: 18, marginBottom: 4 }}><Fig n={history.opened} label="in 30 days" /><Fig n={history.resolved} label="resolved" /></div>
              {history.recent.map((i) => (
                <button key={i.id} style={rowBtn} onClick={() => open('incidents', { kind: 'incident', id: i.id })}>
                  <span style={{ ...ellipsis, flex: 1 }}>{i.title}</span>
                  <span style={faint}>{i.status} · {ago(i.resolvedAt ?? i.containedAt ?? i.openedAt)}</span>
                </button>
              ))}
            </>
          )}
        </Card>
        <Card id="replay" title="Replay" open={() => open('replay')} openLabel="Pick a day">
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>Every wake, run, decision, signal and dollar of one day, in order.</div>
          <button style={{ ...linkBtn, marginTop: 8 }} onClick={() => open('replay', { kind: 'replay', id: yesterdayKey() })}>Replay yesterday</button>
        </Card>
        <Card id="governance" title="Governance" open={() => app.openSettings('company')} openLabel="Company settings">
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            The company runs in <b style={{ color: 'var(--text)', fontWeight: 600 }}>{app.wsOrg?.mode ?? 'supervised'}</b> mode. Delegated approvals, the boundary, the tunables and the blueprint are set in Settings › Company.
          </div>
        </Card>
      </Grid>
    </>
  );
}

