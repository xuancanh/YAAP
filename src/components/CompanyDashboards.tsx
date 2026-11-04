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
  api, type OrgAllocation, type OrgAuditRow, type OrgAuditRun, type OrgBrief, type OrgCapacity, type OrgDetail, type OrgForecast,
  type OrgIncident, type OrgPulse, type OrgSpend, type OrgTask, type TrustOverview, type OrgUnitNode,
} from '../lib/api';
import { type CompanySection } from '../lib/company-nav';
import {
  boardCounts, budgetLines, capitalByGoal, spendWindowLabel, findingsCount, flatUnits, incidentHistory, moneyLede, nextRituals, 
  operationsLede, oversightLede, pausedMembers, peopleLede, yesterdayKey,
} from '../lib/company-dash';
import { atRiskByUnit, firesOn, flattenIntent, MEETING_KIND_TITLES } from '../lib/org';
import { briefSummary } from '../lib/home';
import { healthWord, incidentCounts } from '../lib/org3';
import { fmtUsd } from '../lib/pricing';
import { Markdown } from '../lib/md';
import { faint, linkBtn, ago, Avatar, useAgentNames } from './org-ui';
import { ProgramPeopleCard } from './ProgramMatrixView';
import { DirectionOverview } from './DirectionOverview';
import { PluginCards } from './PluginUi';
import { Bar as KitBar, Card as KitCard, Empty as KitEmpty, Metric, PageHeader, Pill, SkeletonRows } from './CompanyKit';
import type { Tone } from '../lib/direction';
import { DepartmentName, useMayRenameDepartments } from './DepartmentName';

// ---- the parts every dashboard shares ----

const GAP = 14;
const num: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: '1px solid var(--border-soft)', fontSize: 12.5, minWidth: 0 };
const ellipsis: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
const rowBtn: React.CSSProperties = { ...row, width: '100%', background: 'none', border: 'none', borderTop: '1px solid var(--border-soft)', color: 'var(--text)', font: 'inherit', fontSize: 12.5, textAlign: 'left', cursor: 'pointer', borderRadius: 0 };

/** A colour token as a tone of the kit. */
const toneOf = (c?: string): Tone | undefined => (!c ? undefined : c.includes('red') ? 'bad' : c.includes('amber') ? 'warn' : c.includes('green') ? 'ok' : undefined);

/** One card (the kit's): its title opens the page it summarises. `lead` spans the row. */
function Card({ id, title, open, openLabel, lead, children, aside }: { id: string; title: string; open?: () => void; openLabel?: string; lead?: boolean; children: ReactNode; aside?: ReactNode }) {
  return (
    <KitCard id={id} title={title} onOpen={open} span={lead} aside={aside} action={open ? <button className="co-link" onClick={open}>{openLabel ?? `Open ${title.toLowerCase()}`}</button> : undefined}>
      {children}
    </KitCard>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="co-grid">{children}</div>;
}

/** The dashboard's opening: where the section stands, in one sentence (what it is for sits behind the (i) by the section title). */
function Lede({ state }: { state: string | null }) {
  return <p data-testid="dash-lede" style={{ margin: '0 0 16px', maxWidth: 760, fontSize: 18, lineHeight: 1.4, fontWeight: 600, letterSpacing: '-.012em', color: 'var(--text)', minHeight: 25 }}>{state ?? ' '}</p>;
}

/** What waits on the CEO from this section: decided in the Inbox, linked from here. */
function InboxRow({ text, pane }: { text: string; pane: Extract<OrgPane, 'approvals' | 'plans' | 'mytasks'> }) {
  const app = useApp();
  return (
    <button data-testid="dash-inbox-row" className="co-note warn" onClick={() => { app.setOrgFocus(null); app.setOrgPane(pane); }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', marginBottom: GAP, cursor: 'pointer', font: 'inherit', fontSize: 13 }}>
      <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
      <span className="co-link" style={{ flex: 'none' }}>Open the Inbox</span>
    </button>
  );
}

function Bar({ value, color, label }: { value: number; color?: string; label: string }) {
  return <KitBar value={Math.max(0, Math.min(1, value))} tone={toneOf(color)} label={label} />;
}

/** A labelled figure ("12 in progress"). */
function Fig({ n, label, tone }: { n: number | string; label: string; tone?: string }) {
  return <Metric n={n} label={label} tone={toneOf(tone)} />;
}

const Empty = ({ children }: { children: ReactNode }) => <div style={{ fontSize: 12.5, color: 'var(--text-dim)', padding: '4px 0', lineHeight: 1.5 }}>{children}</div>;
const Loading = () => <SkeletonRows rows={2} />;

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
      {section === 'direction' && <DirectionOverview org={org} />}
      {section === 'operations' && <OperationsDashboard org={org} />}
      {section === 'people' && <PeopleDashboard org={org} />}
      {section === 'money' && <MoneyDashboard org={org} />}
      {section === 'oversight' && <OversightDashboard org={org} />}
      {/* Extension point: cards and pages plugins add to this section (docs/plugins.md §3.8). */}
      <PluginCards placement={section} />
    </div>
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
  const incidents = incidentCounts(health?.openIncidents);
  const live = (health?.openIncidents ?? []);
  const word = health ? healthWord(health) : null;
  const units = app.wsOrg?.units ?? [];
  const today = (app.orgCadences ?? []).filter((c) => c.enabled === 1 && firesOn(c.cron));
  const upcoming = nextRituals(app.orgCadences ?? [], units);
  const blocked = (tasks ?? []).filter((t) => t.status === 'blocked').slice(0, 3);
  const summary = brief ? briefSummary(brief.text, 2) : null;
  return (
    <>
      <Lede state={operationsLede(board, incidents, pulse ? pulse.score : null)} />
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
        <Card id="incidents" title="Incidents" open={() => open('incidents')} aside={word ? <span data-testid="incidents-health" style={{ fontSize: 11, fontWeight: 600, color: `var(--${word.tone})` }}>{word.text}</span> : undefined}>
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
  const paused = pausedMembers(members, org.status);
  const chief = names.get(org.chiefOfStaffAgentId ?? '');
  const reports = (id: string) => members.filter((m) => m.reportsToAgentId === id).length;
  const leads = members.filter((m) => reports(m.agentId) > 0).sort((a, b) => a.depth - b.depth || reports(b.agentId) - reports(a.agentId)).slice(0, 5);
  const atLimit = capacity ? capacity.members.filter((m) => m.atLimit).length : 0;
  // `wip` is the per-member limit (capacity.wipPerMember), `open` what a member holds — as on Governance › Capacity.
  const loaded = capacity ? capacity.members.filter((m) => m.open > 0).sort((a, b) => b.open - a.open || a.name.localeCompare(b.name)).slice(0, 4) : [];
  const outside = app.agents.filter((a) => !members.some((m) => m.agentId === a.id)).length;
  return (
    <>
      <Lede state={peopleLede(members.length, Math.max(1, units.length), atLimit)} />
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
        <ProgramPeopleCard wsId={org.workspaceId} />
        <Card id="capacity" title="Capacity" aside={capacity ? <span style={faint}>WIP limit {capacity.wip} each</span> : undefined}>
          {capacity === undefined ? <Loading /> : !capacity || loaded.length === 0 ? <Empty>Nobody holds open work.</Empty> : loaded.map((m) => (
            <div key={m.agentId} style={row}>
              <Avatar a={names.get(m.agentId)} size={18} />
              <span style={{ ...ellipsis, flex: 1 }}>{m.name}</span>
              {m.atLimit && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--amber)' }}>at limit</span>}
              <span style={{ ...faint, ...num }}>{m.open} of {m.wip} open</span>
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

/** People › Teams: every department as a card — lead, members, what is open, at risk and on today, and its channel, board and goals; the CEO renames one in place. */
export function TeamsPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const open = useOpen();
  const names = useAgentNames();
  const mayRename = useMayRenameDepartments(org.workspaceId);
  const units = flatUnits(app.wsOrg?.units ?? []);
  const atRisk = useMemo(() => atRiskByUnit(app.orgIntent ?? []), [app.orgIntent]);
  const depthOf = useMemo(() => {
    const byId = new Map(units.map((u) => [u.id, u]));
    return (u: OrgUnitNode) => { let d = 0; let p = u.parentUnitId; while (p && byId.has(p) && d < 8) { d += 1; p = byId.get(p)!.parentUnitId; } return d; };
  }, [units]);
  const about = <>Each department has a lead, a channel, a board and goals; the board and goals open filtered to it. {org.name} is the top of the tree.{mayRename ? ' Rename a department with its pencil.' : ''}</>;
  if (units.length === 0) return <div className="co-page"><PageHeader title="Teams" purpose={about} /><KitEmpty title="One team: the company">The chief of staff proposes departments as the company grows.</KitEmpty></div>;
  return (
    <div className="co-page" data-testid="teams-pane">
      <PageHeader title="Teams" purpose={about} />
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
            <section key={u.id} data-testid={`team-${u.slug}`} className="co-card" style={{ padding: '13px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <Avatar a={lead} size={28} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...ellipsis, fontSize: 14, fontWeight: 650 }}>{isRoot ? 'Company' : <DepartmentName wsId={org.workspaceId} unitId={u.id} name={u.name} editable={mayRename} />}</div>
                  <div style={{ ...faint, ...ellipsis }}>{d > 0 ? `level ${d + 1} · ` : ''}led by {lead?.name ?? 'an agent'}</div>
                </div>
                {risk > 0 && <Pill tone="warn" title={`${risk} goal${risk === 1 ? '' : 's'} at risk`}>{risk} at risk</Pill>}
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
  // Spent is settled spend, the Spend page's and Home's figure; what is held for runs in flight is said beside it.
  const used = spend ? spend.company.usd : 0;
  const held = spend?.company.reservedUsd ?? 0;
  const period = spend ? spendWindowLabel(spend.month) : 'this month';
  const capital = allocations ? capitalByGoal(allocations, (id) => titles.get(id)) : [];
  const budgets = spend ? budgetLines(spend) : [];
  const unenveloped = budgets.filter((b) => b.key.startsWith('a:') && b.pct === null);
  const warn = forecast ? [forecast.company, ...forecast.agents, ...forecast.projects, ...forecast.objectives].filter((f) => f.state !== 'onTrack').slice(0, 4) : [];
  const series = spend?.series.slice(-30) ?? [];
  const peak = Math.max(0.000001, ...series.map((d) => d.usd));
  return (
    <>
      <Lede state={spend === undefined ? null : spend ? moneyLede(used, cap, forecast ? forecast.company.projectedUsd : null, fmtUsd, period) : 'Spend is not available.'} />
      <Grid>
        <Card id="spend" title="This month" lead open={() => open('spend')} openLabel="Open spend" aside={spend ? <span style={faint}>{period} (UTC) to date</span> : undefined}>
          {spend === undefined ? <Loading /> : !spend ? <Empty>Spend is not available.</Empty> : (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 10 }}>
                  <Fig n={fmtUsd(used)} label={`${cap > 0 ? `of ${fmtUsd(cap)}` : 'no envelope'}${held > 0 ? ` · ${fmtUsd(held)} held for runs in flight` : ''}`} />
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
          {spend === undefined ? <Loading /> : budgets.length === 0 ? <Empty>Nobody has spent this month, and no agent or project has its own envelope yet.</Empty> : <>
            {budgets.slice(0, 6).map((b) => (
              <div key={b.key} style={row}>
                <span style={{ ...ellipsis, flex: '1 1 40%' }}>{b.label}</span>
                {b.pct !== null ? <Bar value={b.pct} color={b.pct >= 1 ? 'var(--red)' : b.pct >= 0.8 ? 'var(--amber)' : 'var(--green)'} label={`${b.label} against its envelope`} /> : <span style={{ ...faint, flex: 1, minWidth: 40 }}>no envelope</span>}
                <span style={{ ...faint, ...num, width: 96, textAlign: 'right' }}>{fmtUsd(b.usd)}{b.pct !== null ? ` / ${fmtUsd(b.cap)}` : ''}</span>
              </div>
            ))}
            {budgets.length > 6 && <div style={{ ...faint, marginTop: 4 }}>{budgets.length - 6} more on the Spend page.</div>}
            {unenveloped.length > 0 && spend && <div style={{ ...faint, marginTop: 6 }}>{fmtUsd(unenveloped.reduce((n, b) => n + b.usd, 0))} of {fmtUsd(spend.company.usd)} was spent by members without their own envelope; only the company envelope caps it.</div>}
          </>}
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
              <Pill tone={f.state === 'stop' ? 'bad' : 'warn'}>{f.state === 'stop' ? 'will stop' : 'warning'}</Pill>
              <span style={{ ...ellipsis, flex: 1 }}>{f.scope === 'company' ? `${f.name} (company)` : f.name}</span>
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
      <Lede state={verify === undefined ? null : oversightLede(verify ? verify.ok : null, findings)} />
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
              <div className="co-metrics" style={{ marginBottom: 8 }}><Fig n={findings ?? 0} label={findings === 1 ? 'finding' : 'findings'} tone={findings ? 'var(--amber)' : 'var(--green)'} /><span style={{ ...faint, alignSelf: 'center' }}>{ago(lastRun.endedAt ?? lastRun.startedAt)}</span></div>
              {lastRun.summary && <div style={{ color: 'var(--text-dim)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{lastRun.summary}</div>}
            </div>
          )}
        </Card>
        <Card id="trust" title="Trust" open={() => app.openSettings('workspace')} openLabel="Trust levels">
          {trust === undefined ? <Loading /> : !trust ? <Empty>Trust levels are not available.</Empty> : (
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              <div className="co-metrics" style={{ marginBottom: 8 }}><Fig n={trust.agents.length} label="agents earning trust" />{lowTrust > 0 && <Fig n={lowTrust} label="at level 0 somewhere" tone="var(--amber)" />}</div>
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

