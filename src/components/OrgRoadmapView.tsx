/**
 * The roadmap and the project page (docs/work-tracking.md "Views"):
 * Company › Direction › Roadmap.
 *
 *  - **Timeline**: one row per project, grouped by goal (objective → key
 *    result) or by unit; a bar from start to target date, its fill the share
 *    of tasks done, its colour the lead's latest health call; milestones as
 *    diamonds, a line for today, the appetite used beside it. Month or
 *    quarter zoom.
 *  - **Now / Next / Later**: the CEO's ordering of bets, one card per
 *    project; a lane change applies at once (the CEO is a person: no card).
 *  - **The project page**: brief, key results, dates and milestones,
 *    progress and the hill, the health history with the lead's call, budget
 *    burn, the forecast range (or "not enough history"), tasks by status,
 *    blockers, decisions and files.
 *
 * The board's cards drag between lanes (or move with their menu); a
 * person's move applies at once, an agent's move to Now becomes a card and
 * the card says so. Below the timeline: milestones coming up and the
 * projects with no dates yet.
 *
 * Decision: the timeline is read-only — no dragging bars. A project's dates
 * are commitments the CEO approves, so they change in the project page's
 * form (one deliberate edit, audited) rather than by an accidental drag.
 *
 * The presentational parts (RoadmapTimeline, LaneBoard, ProjectPageView)
 * take data and callbacks so web-tests render them without the store.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '../store';
import { api, type OrgDetail, type ProgramItem, type ProgramOwner, type ProjectPage, type ProjectPatch, type ProjectSummary, type ProjectTeam, type RoadmapData, type TaskSource } from '../lib/api';
import { ProgramBlock, ProgramOwnerBadge, useProgram } from './ProgramMatrixView';
import {
  LANES, LANE_WORD, SOURCE_TONE, SOURCE_WORD, appetiteLine, appetiteUsed, buildScale, dayMs, forecastLine, groupProjects, healthColor, healthWord, hillPoint,
  laneColumns, spanOf, updateWord, xOf, type GroupBy, type Lane, type Zoom,
} from '../lib/roadmap';
import { card, input, btn, pill, h2, faint, ago } from './org-ui';
import { Bar, Card, Empty, Menu, PageHeader, PageSkeleton, Pill } from './CompanyKit';
import { HEALTH_LABEL, HEALTH_TONE, inDays, nextMilestone, projectHealth, shortDate } from '../lib/direction';
import { I, P } from '../lib/icons';

const DAY_MS = 86_400_000;
import { keyStyle } from '../lib/task-keys';

type View = 'timeline' | 'board';

function HealthDot({ health, size = 8 }: { health: string; size?: number }) {
  return <span aria-hidden style={{ width: size, height: size, borderRadius: '50%', background: healthColor(health), flex: 'none', display: 'inline-block' }} />;
}

function Meter({ value, color, label, width = 64 }: { value: number; color: string; label: string; width?: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <span role="meter" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ display: 'inline-block', width, height: 5, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden', verticalAlign: 'middle' }}>
      <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color }} />
    </span>
  );
}

/** Budget used, with the breaker spelled out. */
function Appetite({ p }: { p: ProjectSummary }) {
  const used = appetiteUsed(p.appetite);
  if (p.appetite.tripped) return <span style={pill('var(--red)', '#fff')} title={`Appetite used up: ${appetiteLine(p.appetite)}. New task claims are paused until it is extended, cut or killed.`}>breaker tripped</span>;
  if (used === null) return <span style={faint}>no appetite</span>;
  const color = used >= 1 ? 'var(--red)' : used >= 0.8 ? 'var(--amber)' : 'var(--text-dim)';
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color }} title={appetiteLine(p.appetite)}><Meter value={used} color={color} label={`${p.title} appetite used`} width={44} />{Math.round(used * 100)}%</span>;
}

// ---- the timeline ----

const LABEL_W = 300;
const ROW_H = 54;

/** "P-3 Beta IELTS Writing tutor" with the owner, health and progress under it. */
function RowLabel({ p, owner }: { p: ProjectSummary; owner?: ProgramOwner }) {
  const h = projectHealth(p.health);
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
      <span title={`${p.key ? `${p.key} ` : ''}${p.title}`} style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
        {p.key && <span className="co-key">{p.key}</span>}{p.title}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-dim)', minWidth: 0 }}>
        <Pill tone={HEALTH_TONE[h]}>{h === 'unknown' ? 'No update' : HEALTH_LABEL[h]}</Pill>
        <span className="co-num">{p.progress.pct}%</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{owner && owner.role !== 'none' ? owner.name : p.lead.kind === 'none' ? 'No lead' : p.lead.name}</span>
      </span>
    </span>
  );
}

export function RoadmapTimeline({ data, groupBy, zoom, onOpen, owners }: { data: RoadmapData; groupBy: GroupBy; zoom: Zoom; onOpen: (projectId: string) => void; owners?: Map<string, ProgramOwner> }) {
  const groups = useMemo(() => groupProjects(data, groupBy), [data, groupBy]);
  const spans = useMemo(() => new Map(data.projects.map((p) => [p.id, spanOf(p)])), [data.projects]);
  const scale = useMemo(() => buildScale(data.today, [...spans.values()], zoom), [data.today, spans, zoom]);
  const today = xOf(scale, dayMs(data.today));
  if (data.projects.length === 0) return <div className="co-card"><Empty title="No projects yet">The chief of staff and the function heads propose them as they plan. You can add one with New project.</Empty></div>;
  const scheduled = groups.map((g) => ({ ...g, projects: g.projects.filter((p) => spans.get(p.id)) }));
  return (
    <div data-testid="roadmap-timeline" className="co-card" style={{ padding: 0, overflowX: 'auto' }}>
      <div style={{ minWidth: LABEL_W + 560, position: 'relative' }}>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--panel)', zIndex: 4, borderRadius: '12px 12px 0 0' }}>
          <div style={{ width: LABEL_W, flex: 'none', padding: '9px 14px', fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>{groupBy === 'goal' ? 'Grouped by objective and key result' : 'Grouped by department'}</div>
          <div style={{ flex: 1, position: 'relative', height: 32 }}>
            {scale.columns.map((c) => (
              <span key={c.at} style={{ position: 'absolute', left: `${xOf(scale, c.at) * 100}%`, top: 9, fontSize: 11, color: 'var(--text-faint)', paddingLeft: 4, borderLeft: '1px solid var(--border-soft)', whiteSpace: 'nowrap' }}>{c.label}</span>
            ))}
            <span style={{ position: 'absolute', left: `${today * 100}%`, top: 0, transform: 'translateX(-50%)', fontSize: 10.5, fontWeight: 700, color: '#fff', background: 'var(--accent)', borderRadius: '0 0 5px 5px', padding: '0 5px', lineHeight: '15px' }}>Today</span>
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: LABEL_W, right: 0, pointerEvents: 'none', zIndex: 1 }}>
            {scale.columns.map((c) => <span key={c.at} style={{ position: 'absolute', top: 0, bottom: 0, left: `${xOf(scale, c.at) * 100}%`, borderLeft: '1px solid var(--border-soft)', opacity: .6 }} />)}
            <span data-testid="today-line" data-x={today.toFixed(4)} title={`Today, ${data.today}`} style={{ position: 'absolute', top: 0, bottom: 0, left: `${today * 100}%`, borderLeft: '2px solid var(--accent)' }} />
          </div>
          {scheduled.map((g) => (
            <div key={g.id} data-testid="roadmap-group" data-group={g.title}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: `10px 14px 4px ${14 + g.depth * 16}px`, borderTop: '1px solid var(--border-soft)', width: LABEL_W, boxSizing: 'border-box' }}>
                {g.subtitle && <span style={{ fontSize: 11, color: 'var(--text-faint)', flex: 'none' }}>{g.subtitle}</span>}
                <span style={{ fontSize: 12.5, fontWeight: 650, color: g.id === 'none' ? 'var(--text-dim)' : 'var(--text)', overflowWrap: 'anywhere' }}>{g.title}</span>
              </div>
              {g.projects.map((p) => <TimelineRow key={p.id} p={p} depth={g.depth} span={spans.get(p.id) ?? null} scale={scale} onOpen={onOpen} owner={owners?.get(p.id)} />)}
            </div>
          ))}
        </div>
      </div>
      <Legend />
    </div>
  );
}

function Legend() {
  const item: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 };
  const diamond = (filled: boolean): CSSProperties => ({ width: 9, height: 9, transform: 'rotate(45deg)', border: '1.5px solid var(--text)', background: filled ? 'var(--text)' : 'var(--panel)', display: 'inline-block' });
  return (
    <div data-testid="roadmap-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', padding: '10px 14px', borderTop: '1px solid var(--border-soft)', fontSize: 11.5, color: 'var(--text-dim)' }}>
      <span style={item}><span style={{ width: 22, height: 9, borderRadius: 3, background: 'color-mix(in srgb, var(--green) 30%, var(--panel))', border: '1px solid var(--green)', display: 'inline-block' }} />Start to target, filled by tasks done</span>
      <span style={item}><span style={{ width: 22, height: 9, borderRadius: 3, border: '1px dashed var(--text-faint)', display: 'inline-block' }} />Dates estimated from the appetite</span>
      <span style={item}><span style={diamond(false)} />Milestone</span>
      <span style={item}><span style={diamond(true)} />Milestone done</span>
      <span style={item}><span style={{ width: 2, height: 12, background: 'var(--accent)', display: 'inline-block' }} />Today</span>
      <span style={item}>Bar colour is the lead’s latest health call</span>
    </div>
  );
}

function TimelineRow({ p, depth, span, scale, onOpen, owner }: { p: ProjectSummary; depth: number; span: ReturnType<typeof spanOf>; scale: ReturnType<typeof buildScale>; onOpen: (id: string) => void; owner?: ProgramOwner }) {
  const left = span ? xOf(scale, span.start) : 0;
  const right = span ? xOf(scale, span.end) : 0;
  const color = healthColor(p.health);
  const missing = p.update.state === 'missing';
  const label = `${p.progress.pct}% done${p.targetDate ? ` · target ${shortDate(p.targetDate)}` : ''}`;
  const used = appetiteUsed(p.appetite);
  return (
    <div data-testid="roadmap-row" data-project={p.id} style={{ display: 'flex', alignItems: 'center', minHeight: ROW_H }}>
      <button onClick={() => onOpen(p.id)} className="co-row" style={{ width: LABEL_W, flex: 'none', padding: `6px 10px 6px ${22 + depth * 16}px`, borderRadius: 0 }} aria-label={`Open ${p.key ?? ''} ${p.title}`}>
        <RowLabel p={p} owner={owner} />
      </button>
      <div style={{ flex: 1, position: 'relative', height: ROW_H }}>
        {span && (
          <button data-testid="roadmap-bar" data-left={left.toFixed(4)} data-width={(right - left).toFixed(4)} data-health={p.health || 'none'} onClick={() => onOpen(p.id)}
            title={`${p.title}: ${p.startDate ?? '?'} → ${p.targetDate ?? '?'}${span.estimated ? ' (estimated)' : ''} · ${p.progress.done}/${p.progress.total} tasks done · ${healthWord(p.health)}${missing ? ' · update missing' : ''}${used !== null ? ` · ${Math.round(used * 100)}% of appetite used` : ''}`}
            style={{ position: 'absolute', left: `${left * 100}%`, width: `max(${(right - left) * 100}%, 6px)`, top: 9, height: 22, borderRadius: 6, padding: 0, cursor: 'pointer', overflow: 'hidden',
              border: `1px ${span.estimated ? 'dashed' : 'solid'} ${color}`, background: `color-mix(in srgb, ${color} 16%, var(--panel))`, zIndex: 2, font: 'inherit' }}>
            <span data-testid="roadmap-fill" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${p.progress.pct}%`, background: color, opacity: .55 }} />
            <span style={{ position: 'relative', display: 'block', padding: '0 8px', fontSize: 11, fontWeight: 650, lineHeight: '20px', color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' }}>{missing ? `Update missing · ${label}` : label}</span>
          </button>
        )}
        {p.milestones.filter((m) => m.date).map((m) => (
          <span key={m.id} data-testid="milestone" data-done={m.done ? '1' : '0'} role="img" aria-label={`Milestone ${m.name}, ${m.date}${m.done ? ', done' : ''}`} title={`${m.name} — ${shortDate(m.date, { month: 'short', day: 'numeric', year: 'numeric' })}${m.done ? ' (done)' : ''}`}
            style={{ position: 'absolute', left: `calc(${xOf(scale, dayMs(m.date!)) * 100}% - 5px)`, top: 36, width: 10, height: 10, transform: 'rotate(45deg)', zIndex: 3, cursor: 'help',
              border: '1.5px solid var(--text)', background: m.done ? 'var(--text)' : 'var(--panel)' }} />
        ))}
      </div>
    </div>
  );
}

/** Below the timeline: milestones coming up, and the projects with no dates yet. */
function RoadmapBelow({ data, onOpen }: { data: RoadmapData; onOpen: (id: string) => void }) {
  const unscheduled = data.projects.filter((p) => !spanOf(p) && p.status !== 'done' && p.status !== 'cancelled');
  const t = dayMs(data.today);
  const upcoming = data.projects.flatMap((p) => p.milestones.filter((m) => !m.done && m.date && dayMs(m.date) >= t - DAY_MS && dayMs(m.date) <= t + 45 * DAY_MS).map((m) => ({ p, m })))
    .sort((a, b) => (a.m.date ?? '').localeCompare(b.m.date ?? '')).slice(0, 8);
  return (
    <div className="co-grid" style={{ marginTop: 14 }}>
      <Card id="milestones" title="Coming up" aside="next 45 days">
        {upcoming.length === 0 ? <Empty compact title="No milestones in the next 45 days">Leads add milestones on the project page.</Empty> : (
          <div className="co-rows" style={{ margin: '0 -10px' }}>
            {upcoming.map(({ p, m }) => (
              <button key={`${p.id}:${m.id}`} className="co-row" onClick={() => onOpen(p.id)}>
                <span aria-hidden style={{ width: 9, height: 9, transform: 'rotate(45deg)', border: '1.5px solid var(--text)', flex: 'none', marginLeft: 3 }} />
                <span className="co-row-main"><span className="co-row-title">{m.name}</span><span className="co-row-meta">{p.key ? `${p.key} ` : ''}{p.title}</span></span>
                <span className="co-row-end">{shortDate(m.date)} · {inDays(m.date, new Date(t))}</span>
              </button>
            ))}
          </div>
        )}
      </Card>
      <Card id="unscheduled" title="Not on the timeline yet" aside={unscheduled.length || undefined}>
        {unscheduled.length === 0 ? <Empty compact title="Every project has dates">Projects without a start or target date are listed here.</Empty> : (
          <div className="co-rows" style={{ margin: '0 -10px' }} data-testid="unscheduled">
            {unscheduled.map((p) => (
              <button key={p.id} className="co-row" onClick={() => onOpen(p.id)}>
                <span className="co-row-main"><span className="co-row-title wrap">{p.key && <span className="co-key">{p.key}</span>}{p.title}</span><span className="co-row-meta">{LANE_WORD[p.lane as Lane] ?? p.lane} · unscheduled: add a start or target date on its page</span></span>
                <Pill tone={HEALTH_TONE[projectHealth(p.health)]}>{p.progress.pct}%</Pill>
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---- Now / Next / Later ----

const LANE_HINT: Record<Lane, string> = { now: 'Bets in flight', next: 'Shaped, waiting for a bet', later: 'Ideas' };

export function LaneBoard({ projects, onOpen, onLane, errors = {}, notes = {}, owners, pending }: { projects: ProjectSummary[]; onOpen: (id: string) => void; onLane: (id: string, lane: Lane) => void; errors?: Record<string, string>; notes?: Record<string, string>; owners?: Map<string, ProgramOwner>; pending?: string | null }) {
  const cols = laneColumns(projects);
  const [over, setOver] = useState<Lane | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  return (
    <div data-testid="lane-board" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, alignItems: 'start' }}>
      {LANES.map((l) => (
        <section key={l} data-testid={`lane-${l}`} aria-label={LANE_WORD[l]}
          onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(l); } }} onDragLeave={() => setOver((o) => (o === l ? null : o))}
          onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/project') || drag; setOver(null); setDrag(null); const p = projects.find((x) => x.id === id); if (p && p.lane !== l) onLane(p.id, l); }}
          style={{ background: 'var(--panel-2)', borderRadius: 12, padding: 10, minHeight: 160, outline: over === l ? '2px dashed var(--accent)' : 'none', outlineOffset: -2, transition: 'outline-color .1s' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, padding: '0 4px' }}>
            <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 700 }}>{LANE_WORD[l]}</h3>
            <span className="co-faint co-num">{cols[l].length}</span>
            <span style={{ flex: 1 }} />
            <span className="co-faint" style={{ fontSize: 11.5 }}>{LANE_HINT[l]}</span>
          </div>
          {cols[l].length === 0 && <div className="co-faint" style={{ padding: '18px 6px', textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 10 }}>{l === 'now' ? 'Nothing in Now. Drag a shaped project here to bet on it.' : 'Drop a project here.'}</div>}
          {cols[l].map((p) => <ProjectCard key={p.id} p={p} onOpen={onOpen} onLane={onLane} error={errors[p.id]} note={notes[p.id]} owner={owners?.get(p.id)} busy={pending === p.id} onDrag={setDrag} />)}
        </section>
      ))}
    </div>
  );
}

function ProjectCard({ p, onOpen, onLane, error, note, owner, busy, onDrag }: { p: ProjectSummary; onOpen: (id: string) => void; onLane: (id: string, lane: Lane) => void; error?: string; note?: string; owner?: ProgramOwner; busy?: boolean; onDrag?: (id: string | null) => void }) {
  const upd = updateWord(p.update);
  const h = projectHealth(p.health);
  const ms = nextMilestone(p);
  const lane = (LANES.includes(p.lane as Lane) ? p.lane : 'later') as Lane;
  return (
    <article data-testid="project-card" data-project={p.id} draggable onDragStart={(e) => { e.dataTransfer.setData('text/project', p.id); e.dataTransfer.effectAllowed = 'move'; onDrag?.(p.id); }} onDragEnd={() => onDrag?.(null)}
      className="co-card" style={{ padding: '10px 12px', marginBottom: 8, cursor: 'grab', opacity: busy ? .6 : 1, boxShadow: `inset 3px 0 0 ${healthColor(p.health)}` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <button onClick={() => onOpen(p.id)} className="co-link" style={{ flex: 1, minWidth: 0, color: 'var(--text)', fontSize: 13, fontWeight: 650, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
          {p.key && <span className="co-key">{p.key}</span>}{p.title}
        </button>
        <Menu label={`Lane of ${p.title}`} trigger={<I d={P.dots} size={15} />} triggerClass="co-iconbtn" items={LANES.map((l) => ({ id: l, label: `Move to ${LANE_WORD[l]}`, checked: lane === l, onSelect: () => { if (l !== lane) onLane(p.id, l); } }))} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <Pill tone={HEALTH_TONE[h]}>{h === 'unknown' ? 'No update yet' : HEALTH_LABEL[h]}</Pill>
        {upd && <Pill tone={p.update.state === 'missing' ? 'bad' : p.update.state === 'due' ? 'warn' : 'muted'} plain>{upd}</Pill>}
        <Appetite p={p} />
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-dim)' }}>{owner ? <ProgramOwnerBadge owner={owner} /> : <>Lead {p.lead.name}</>}</div>
      {p.healthReason && <div title={`${p.healthReason}${p.healthAsk ? ` Ask: ${p.healthAsk}` : ''}`} style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.healthReason}{p.healthAsk ? <> <b>Ask:</b> {p.healthAsk}</> : null}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <Bar value={p.progress.pct / 100} tone={HEALTH_TONE[h] === 'muted' ? undefined : HEALTH_TONE[h]} label={`${p.title} progress`} />
        <span className="co-num co-faint">{p.progress.done}/{p.progress.total} done</span>
      </div>
      <div className="co-faint" style={{ marginTop: 5 }}>{ms ? `Next: ${ms.name}, ${shortDate(ms.date)} · ` : ''}{forecastLine(p.forecast)}{p.targetDate ? ` · target ${p.targetDate}` : ''}</div>
      {p.goals.length > 0 && <div className="co-faint" title={p.goals.map((g) => g.title).join(', ')} style={{ marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Moves {p.goals.map((g) => g.title).join(', ')}</div>}
      {note && <div role="status" className="co-note" style={{ marginTop: 6 }}>{note}</div>}
      {error && <div role="alert" className="co-alert" style={{ marginTop: 6 }}>{error}</div>}
    </article>
  );
}

// ---- the project page ----

const STATUS_ORDER = ['in_progress', 'claimed', 'in_review', 'blocked', 'waiting', 'todo', 'backlog', 'done', 'cancelled'] as const;
const STATUS_WORD: Record<string, string> = { in_progress: 'In progress', claimed: 'Claimed', in_review: 'In review', blocked: 'Blocked', waiting: 'Waiting', todo: 'To do', backlog: 'Backlog', done: 'Done', cancelled: 'Cancelled' };

export function SourceBadge({ source }: { source: string | undefined }) {
  if (!source || !(source in SOURCE_WORD)) return null;
  const tone = SOURCE_TONE[source as TaskSource];
  return <span data-testid="source-badge" style={{ ...pill(tone.bg, tone.fg), border: 'none' }} title={`Source: ${SOURCE_WORD[source as TaskSource]}`}>{SOURCE_WORD[source as TaskSource]}</span>;
}

function Block({ title, children, action, testid }: { title: string; children: ReactNode; action?: ReactNode; testid?: string }) {
  return (
    <section data-testid={testid} style={{ ...card, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}><h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 700 }}>{title}</h3><span style={{ flex: 1 }} />{action}</div>
      {children}
    </section>
  );
}

/** The hill: uphill is figuring it out, downhill making it happen. */
export function HillChart({ hill, inferred }: { hill: number | null; inferred: boolean }) {
  const W = 220; const H = 62;
  const path = Array.from({ length: 41 }, (_, i) => { const pt = hillPoint(i / 40, W, H); return `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`; }).join(' ');
  const dot = hill === null ? null : hillPoint(hill, W, H);
  return (
    <figure data-testid="hill-chart" style={{ margin: 0 }}>
      <svg width={W} height={H + 14} role="img" aria-label={hill === null ? 'Hill position not set' : `Hill position ${Math.round(hill * 100)}%${inferred ? ', inferred from the tasks' : ''}`}>
        <path d={path} fill="none" stroke="var(--border)" strokeWidth={2} />
        <line x1={W / 2} y1={4} x2={W / 2} y2={H} stroke="var(--border-soft)" strokeDasharray="3 3" />
        {dot && <circle cx={dot.x} cy={dot.y} r={6} fill={inferred ? 'var(--panel)' : 'var(--accent)'} stroke="var(--accent)" strokeWidth={2} />}
        <text x={4} y={H + 12} fontSize={10} fill="var(--text-faint)">figuring it out</text>
        <text x={W - 4} y={H + 12} fontSize={10} fill="var(--text-faint)" textAnchor="end">making it happen</text>
      </svg>
      {inferred && hill !== null && <figcaption style={faint}>Inferred from the tasks; the lead places it with a health update.</figcaption>}
    </figure>
  );
}

function Sparkline({ points }: { points: Array<{ day: string; usd: number }> }) {
  if (points.length < 2) return null;
  const W = 160; const H = 30; const max = Math.max(...points.map((p) => p.usd), 0.0001);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * W).toFixed(1)},${(H - (p.usd / max) * (H - 2) - 1).toFixed(1)}`).join(' ');
  return <svg width={W} height={H} role="img" aria-label="Daily spend"><path d={d} fill="none" stroke="var(--accent)" strokeWidth={1.5} /></svg>;
}

export interface ProjectPageHandlers {
  onBack: () => void;
  onPatch: (patch: ProjectPatch) => Promise<void>;
  onPostUpdate: (u: { health: string; reason?: string; ask?: string; body?: string; hill?: number | null }) => Promise<void>;
  onAddMilestone: (m: { name: string; date: string | null }) => Promise<void>;
  onToggleMilestone: (id: string, done: boolean) => Promise<void>;
  onOpenTask: (taskId: string) => void;
}

export function ProjectPageView({ page, program, ...h }: { page: ProjectPage; program?: ProgramItem | null } & ProjectPageHandlers) {
  const p = page.project;
  const [editing, setEditing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [msName, setMsName] = useState('');
  const [msDate, setMsDate] = useState('');
  const grouped = STATUS_ORDER.map((s) => ({ s, rows: page.tasks.filter((t) => t.status === s) })).filter((g) => g.rows.length > 0);
  return (
    <div data-testid="project-page" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1100 }}>
      <div>
        <button style={{ ...btn(), marginBottom: 10 }} onClick={h.onBack}>Back to roadmap</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {p.key && <span style={keyStyle}>{p.key}</span>}
          <h2 style={{ ...h2, fontSize: 18 }}>{p.title}</h2>
          <span style={pill(p.lane === 'now' ? 'var(--accent)' : 'var(--panel-2)', p.lane === 'now' ? '#fff' : 'var(--text-dim)')}>{LANE_WORD[(p.lane as Lane)] ?? p.lane}</span>
          <span style={pill()}>{p.status}</span>
          {p.kind !== 'project' && <span style={pill()}>{p.kind === 'unsorted' ? 'system: unsorted tasks' : 'system: operating improvements'}</span>}
          <span style={{ flex: 1 }} />
          <button style={btn()} onClick={() => setEditing(!editing)}>{editing ? 'Close edit' : 'Edit'}</button>
        </div>
        <div style={{ ...faint, marginTop: 4 }}>
          {program ? <ProgramOwnerBadge owner={program.owner} /> : <>Lead {p.lead.name}</>}{p.unitName ? ` · ${p.unitName}` : ''} · {p.goals.length ? <>moves {p.goals.map((g) => g.title).join(', ')}</> : 'no key result linked'}
        </div>
      </div>
      {editing && <ProjectEdit page={page} onSave={async (patch) => { await h.onPatch(patch); setEditing(false); }} />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        <Block title="Brief" testid="project-brief">
          {(['problem', 'hypothesis', 'done_when', 'mvp'] as const).map((k) => (
            <div key={k} style={{ marginBottom: 6 }}>
              <div style={{ ...faint, fontSize: 11 }}>{k === 'done_when' ? 'Done when' : k === 'mvp' ? 'MVP' : k[0].toUpperCase() + k.slice(1)}</div>
              <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{p.brief[k] || <span style={faint}>Not written yet</span>}</div>
            </div>
          ))}
        </Block>
        <Block title="Progress" testid="project-progress">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Meter value={p.progress.pct / 100} color={healthColor(p.health)} label="Tasks done" width={140} />
            <span style={{ fontSize: 12.5 }}>{p.progress.done} of {p.progress.total} tasks done</span>
          </div>
          <HillChart hill={p.hill} inferred={p.hillInferred} />
          <div data-testid="project-forecast" style={{ fontSize: 12.5, marginTop: 6 }}>{forecastLine(p.forecast)}{p.targetDate ? <span style={faint}> · target {p.targetDate}</span> : null}</div>
        </Block>
        <Block title="Dates and milestones" testid="project-milestones">
          <div style={{ fontSize: 12.5, marginBottom: 6 }}>{p.startDate ?? 'No start'} → {p.targetDate ?? 'no target date'}{p.late && <span style={{ ...pill('var(--red)', '#fff'), marginLeft: 6 }}>late</span>}</div>
          {p.milestones.length === 0 && <div style={faint}>No milestones yet.</div>}
          {p.milestones.map((m) => (
            <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, padding: '2px 0' }}>
              <input type="checkbox" checked={m.done} onChange={(e) => void h.onToggleMilestone(m.id, e.target.checked)} />
              <span style={{ textDecoration: m.done ? 'line-through' : 'none', color: m.done ? 'var(--text-dim)' : 'var(--text)' }}>{m.name}</span>
              <span style={faint}>{m.date ?? 'no date'}</span>
            </label>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input aria-label="Milestone name" value={msName} onChange={(e) => setMsName(e.target.value)} placeholder="New milestone" style={input} />
            <input aria-label="Milestone date" type="date" value={msDate} onChange={(e) => setMsDate(e.target.value)} style={{ ...input, width: 140 }} />
            <button style={btn()} disabled={!msName.trim()} onClick={() => void h.onAddMilestone({ name: msName.trim(), date: msDate || null }).then(() => { setMsName(''); setMsDate(''); })}>Add</button>
          </div>
        </Block>
        <Block title="Budget" testid="project-budget">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Appetite p={p} /><span style={{ fontSize: 12.5 }}>{appetiteLine(p.appetite)}</span></div>
          {p.appetite.tripped && <div style={{ fontSize: 12.5, color: 'var(--red)', marginTop: 4 }}>The appetite is used up: new task claims are paused until the lead's manager (or you) extends it, cuts scope or kills it.</div>}
          <div style={{ marginTop: 6 }}><Sparkline points={page.burn} /></div>
        </Block>
      </div>
      {program && <ProgramBlock item={program} />}
      {page.team && <ProjectTeamBlock team={page.team} />}
      <Block title="Health updates" testid="project-health" action={<button style={btn(true)} onClick={() => setPosting(!posting)}>{posting ? 'Close' : 'Post update'}</button>}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <HealthDot health={p.health} size={10} /><b style={{ color: healthColor(p.health) }}>{healthWord(p.health)}</b>
          {updateWord(p.update) && <span style={p.update.state === 'missing' ? pill('var(--red)', '#fff') : faint}>{updateWord(p.update)}</span>}
          <span style={faint}>every {p.update.cadenceDays} days</span>
        </div>
        {posting && <UpdateForm onPost={async (u) => { await h.onPostUpdate(u); setPosting(false); }} />}
        {page.updates.length === 0 && <div style={faint}>No health update yet. The lead posts one on its cadence.</div>}
        {page.updates.map((u) => {
          const diff = (() => { try { return JSON.parse(u.diff) as { done?: number; scope?: number; spentUsd?: number; blocked?: number }; } catch { return {}; } })();
          return (
            <div key={u.id} data-testid="health-update" style={{ borderTop: '1px solid var(--border-soft)', padding: '8px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
                <HealthDot health={u.health} /><b style={{ color: healthColor(u.health) }}>{healthWord(u.health)}</b>
                <span style={faint}>{u.createdAt.slice(0, 10)} · {ago(u.createdAt)}</span>
              </div>
              {u.reason && <div style={{ fontSize: 12.5, marginTop: 2 }}>{u.reason}</div>}
              {u.ask && <div style={{ fontSize: 12.5, marginTop: 2 }}><b>Ask:</b> {u.ask}</div>}
              {u.body && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2, whiteSpace: 'pre-wrap' }}>{u.body}</div>}
              <div style={{ ...faint, marginTop: 2 }}>Since the last update: {diff.done ?? 0} done, scope {diff.scope ?? 0}, {diff.blocked ?? 0} blocked, spend ${(diff.spentUsd ?? 0).toFixed(2)}</div>
            </div>
          );
        })}
      </Block>
      <Block title="Tasks" testid="project-tasks">
        {grouped.length === 0 && <div style={faint}>No tasks yet. The lead breaks the project into tasks.</div>}
        {grouped.map((g) => (
          <div key={g.s} data-testid="task-group" data-status={g.s} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-dim)', margin: '4px 0' }}>{STATUS_WORD[g.s]} <span style={faint}>{g.rows.length}</span></div>
            {g.rows.map((t) => (
              <button key={t.id} onClick={() => h.onOpenTask(t.key ?? t.id)} style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', background: 'none', border: 'none', borderBottom: '1px solid var(--border-soft)', padding: '5px 0', cursor: 'pointer', color: 'var(--text)', font: 'inherit', textAlign: 'left', flexWrap: 'wrap' }}>
                {t.key && <span style={keyStyle}>{t.key}</span>}
                <span style={{ fontSize: 12.5, flex: '1 1 200px', minWidth: 0 }}>{t.title}</span>
                <SourceBadge source={t.source} />
                {t.steps.total > 0 && <span style={faint}>steps {t.steps.done}/{t.steps.total}</span>}
                <span style={faint}>{t.assigneeName}</span>
                {t.blockedText && <span style={{ flexBasis: '100%', fontSize: 12, color: 'var(--red)' }}>{t.blockedText}</span>}
              </button>
            ))}
          </div>
        ))}
      </Block>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        <Block title="Blockers" testid="project-blockers">
          {page.blockers.length === 0 ? <div style={faint}>Nothing blocked.</div> : page.blockers.map((b) => (
            <div key={b.taskId} style={{ fontSize: 12.5, padding: '3px 0' }}>{b.key && <span style={{ ...keyStyle, marginRight: 5 }}>{b.key}</span>}{b.title}<div style={{ color: 'var(--red)', fontSize: 12 }}>{b.text} <span style={faint}>· since {ago(b.since)}</span></div></div>
          ))}
        </Block>
        <Block title="Decisions" testid="project-decisions">
          {page.decisions.length === 0 ? <div style={faint}>No decisions yet.</div> : page.decisions.map((d) => (
            <div key={d.id} style={{ fontSize: 12.5, padding: '3px 0', display: 'flex', gap: 6 }}><span style={{ flex: 1 }}>{d.title}</span><span style={pill()}>{d.status.replace(/_/g, ' ')}</span><span style={faint}>{d.at.slice(0, 10)}</span></div>
          ))}
        </Block>
        <Block title="Files" testid="project-files">
          {page.files.length === 0 ? <div style={faint}>No files named by its tasks.</div> : page.files.map((f) => <div key={`${f.taskId}:${f.path}`} style={{ fontSize: 12.5, fontFamily: 'var(--mono)', padding: '2px 0', overflowWrap: 'anywhere' }}>{f.path}</div>)}
        </Block>
      </div>
    </div>
  );
}

/** The cross-functional team: each member with its home unit, role on the project and allocation (docs/work-tracking.md "Project teams"). */
export function ProjectTeamBlock({ team }: { team: ProjectTeam }) {
  const units = team.units.length;
  return (
    <Block title={`Team${team.members.length ? ` · ${team.members.length}` : ''}`} testid="project-team" action={<span style={faint}>{team.channel ? `#${team.channel.slug}` : 'no channel yet'}{team.standup.cron ? ` · standup ${team.standup.cron}` : ''}</span>}>
      <div style={{ ...faint, marginBottom: 6 }}>Led by {team.lead.name}{units > 0 ? ` · drawn from ${units} department${units === 1 ? '' : 's'}: ${team.units.join(', ')}` : ''}. Each member keeps its home unit and head; the head approves the allocation.</div>
      {team.members.length === 0 && <div style={faint}>No team yet. The lead proposes members from any department; their heads approve the allocation.</div>}
      {team.members.map((m) => (
        <div key={m.id} data-testid="project-team-member" data-status={m.status} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border-soft)', padding: '5px 0', fontSize: 12.5 }}>
          <b>{m.name}</b>
          <span style={faint}>{m.role || 'member'}</span>
          <span style={pill()}>{m.allocation}%</span>
          {m.status === 'pending' && <span style={pill('var(--amber)', '#fff')} title={`Waiting on ${m.managerName}`}>pending head approval</span>}
          <span style={{ flex: 1 }} />
          <span style={faint}>home {m.homeUnit?.name ?? 'the company'} · head {m.managerName}</span>
          <span style={faint}>{m.totalAllocation}% across projects · {m.openTasks} open here</span>
        </div>
      ))}
    </Block>
  );
}

function UpdateForm({ onPost }: { onPost: (u: { health: string; reason?: string; ask?: string; body?: string; hill?: number | null }) => Promise<void> }) {
  const [health, setHealth] = useState('on_track');
  const [reason, setReason] = useState('');
  const [ask, setAsk] = useState('');
  const [body, setBody] = useState('');
  const missingReason = health !== 'on_track' && !reason.trim();
  const missingAsk = health === 'at_risk' && !ask.trim();
  return (
    <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
      <select aria-label="Health" value={health} onChange={(e) => setHealth(e.target.value)} style={{ ...input, width: 'auto' }}>
        <option value="on_track">On track</option><option value="at_risk">At risk</option><option value="off_track">Off track</option>
      </select>
      <input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={health === 'on_track' ? 'Reason (optional)' : 'Reason — "unknown, still investigating" is fine'} style={input} />
      {health === 'at_risk' && <input aria-label="Ask" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Ask: the support needed, and from whom" style={input} />}
      <textarea aria-label="Narrative" value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="What happened since the last update (optional)" style={{ ...input, resize: 'vertical' }} />
      <div><button style={btn(true)} disabled={missingReason || missingAsk} onClick={() => void onPost({ health, reason: reason || undefined, ask: ask || undefined, body: body || undefined })}>Post update</button></div>
    </div>
  );
}

function ProjectEdit({ page, onSave }: { page: ProjectPage; onSave: (patch: ProjectPatch) => Promise<void> }) {
  const p = page.project;
  const [title, setTitle] = useState(p.title);
  const [lane, setLane] = useState(p.lane);
  const [startDate, setStart] = useState(p.startDate ?? '');
  const [targetDate, setTarget] = useState(p.targetDate ?? '');
  const [appetiteDays, setDays] = useState(String(p.appetite.days || ''));
  const [appetiteUsd, setUsd] = useState(String(p.appetite.usd || ''));
  const [brief, setBrief] = useState(p.brief);
  return (
    <div data-testid="project-edit" style={{ ...card, display: 'grid', gap: 8 }}>
      <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} style={input} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ ...faint, display: 'grid', gap: 3 }}>Lane<select value={lane} onChange={(e) => setLane(e.target.value)} style={input}>{LANES.map((l) => <option key={l} value={l}>{LANE_WORD[l]}</option>)}</select></label>
        <label style={{ ...faint, display: 'grid', gap: 3 }}>Start<input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} style={input} /></label>
        <label style={{ ...faint, display: 'grid', gap: 3 }}>Target<input type="date" value={targetDate} onChange={(e) => setTarget(e.target.value)} style={input} /></label>
        <label style={{ ...faint, display: 'grid', gap: 3 }}>Appetite (days)<input type="number" min={0} value={appetiteDays} onChange={(e) => setDays(e.target.value)} style={{ ...input, width: 110 }} /></label>
        <label style={{ ...faint, display: 'grid', gap: 3 }}>Appetite (USD)<input type="number" min={0} step="0.5" value={appetiteUsd} onChange={(e) => setUsd(e.target.value)} style={{ ...input, width: 110 }} /></label>
      </div>
      {(['problem', 'hypothesis', 'done_when', 'mvp'] as const).map((k) => (
        <textarea key={k} aria-label={k} value={brief[k]} onChange={(e) => setBrief({ ...brief, [k]: e.target.value })} rows={1} placeholder={k === 'done_when' ? 'Done when' : k === 'mvp' ? 'MVP' : k} style={{ ...input, resize: 'vertical' }} />
      ))}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button style={btn(true)} onClick={() => void onSave({
          title, lane, startDate: startDate || null, targetDate: targetDate || null, brief,
          ...(appetiteDays !== '' ? { appetiteDays: Number(appetiteDays) } : {}), ...(appetiteUsd !== '' ? { appetiteUsd: Number(appetiteUsd) } : {}),
        })}>Save changes</button>
      </div>
    </div>
  );
}

// ---- the pane (store-connected) ----

const VIEW_WORD: Record<View, string> = { timeline: 'Timeline', board: 'Now / Next / Later' };

export function RoadmapPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const [data, setData] = useState<RoadmapData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<View>('timeline');
  const [groupBy, setGroupBy] = useState<GroupBy>('goal');
  const [zoom, setZoom] = useState<Zoom>('month');
  const [projectId, setProjectIdRaw] = useState<string | null>(null);
  const [laneErrors, setLaneErrors] = useState<Record<string, string>>({});
  const [laneNotes, setLaneNotes] = useState<Record<string, string>>({});
  const [moving, setMoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const matrix = useProgram(wsId, data ? String(data.projects.length) : '');
  const owners = useMemo(() => new Map((matrix?.items ?? []).filter((i) => i.refType === 'project').map((i) => [i.id, i.owner])), [matrix]);
  const load = useCallback(async () => {
    try { setData(await api.orgRoadmap(wsId)); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [wsId]);
  useEffect(() => { void load(); }, [load]);
  // The open project is in the address (/<company>/projects/<key>): opening
  // and closing it are history entries, and Back off it closes the page.
  const keyOf = (id: string) => data?.projects.find((p) => p.id === id)?.key || id;
  const setProjectId = (id: string | null) => {
    setProjectIdRaw(id);
    app.setRouteProject(id ? keyOf(id) : null);
  };
  // A link to a project (the address, Home's portfolio, a task drawer) arrives as focus.
  useEffect(() => {
    if (app.orgFocus?.kind === 'project') {
      setProjectIdRaw(app.orgFocus.id);
      if (app.routeProject !== app.orgFocus.id) app.setRouteProject(app.orgFocus.id, { replace: true });
      app.setOrgFocus(null);
    }
  }, [app, app.orgFocus]);
  useEffect(() => { if (!app.routeProject) setProjectIdRaw(null); }, [app.routeProject]);

  if (projectId) return <ProjectPane wsId={wsId} projectId={projectId} onBack={() => { setProjectId(null); void load(); }} />;
  const onLane = async (id: string, lane: Lane) => {
    const before = data?.projects.find((p) => p.id === id);
    setMoving(id);
    setLaneErrors((e) => { const n = { ...e }; delete n[id]; return n; });
    setLaneNotes((e) => { const n = { ...e }; delete n[id]; return n; });
    try {
      const after = await api.updateOrgProject(wsId, id, { lane });
      // A person's move applies at once; when the server keeps the old lane
      // the move became a decision card (an agent's bet): say so, do not pretend.
      if (after && after.lane && after.lane !== lane) setLaneNotes((x) => ({ ...x, [id]: `Moving it to ${LANE_WORD[lane]} needs a decision: a card is waiting in the Inbox.` }));
      else app.showToast(`${before?.key ?? 'Project'} moved to ${LANE_WORD[lane]}${lane === 'now' ? ': its appetite clock starts' : ''}`);
      await load();
    } catch (e) { setLaneErrors((x) => ({ ...x, [id]: e instanceof Error ? e.message : String(e) })); }
    finally { setMoving(null); }
  };
  const summary = `${VIEW_WORD[view]}${view === 'timeline' ? ` · by ${groupBy === 'goal' ? 'goal' : 'department'} · ${zoom === 'month' ? 'weeks' : 'months'}` : ''}`;
  return (
    <div data-testid="roadmap-pane" className="co-page">
      <PageHeader title="Roadmap" purpose="Every project the company works on, the key result it moves, and when. Leads post health; you choose what is in Now."
        actions={<>
          <Menu label="View options" testid="roadmap-view-options" trigger={<><I d={P.rows} size={13} />{summary}<I d={P.chevD} size={12} /></>} triggerClass="co-btn" sections={[
            { label: 'View', items: (['timeline', 'board'] as View[]).map((v) => ({ id: v, label: VIEW_WORD[v], checked: view === v, onSelect: () => setView(v) })) },
            { label: 'Group the timeline by', items: [{ id: 'goal', label: 'Goal', checked: groupBy === 'goal', onSelect: () => { setGroupBy('goal'); setView('timeline'); } }, { id: 'unit', label: 'Department', checked: groupBy === 'unit', onSelect: () => { setGroupBy('unit'); setView('timeline'); } }] },
            { label: 'Zoom', items: [{ id: 'month', label: 'Weeks (about 3 months)', checked: zoom === 'month', onSelect: () => { setZoom('month'); setView('timeline'); } }, { id: 'quarter', label: 'Months (about a year)', checked: zoom === 'quarter', onSelect: () => { setZoom('quarter'); setView('timeline'); } }] },
          ]} />
          <button className="co-btn primary" onClick={() => setAdding(!adding)} aria-expanded={adding}>New project</button>
        </>} />
      {adding && <NewProject org={org} onDone={async (id) => { setAdding(false); await load(); if (id) setProjectId(id); }} />}
      {err && <div role="alert" className="co-alert" style={{ marginBottom: 10 }}>The roadmap did not load: {err}</div>}
      {!data ? (err ? null : <PageSkeleton cards={1} />) : view === 'timeline'
        ? <><RoadmapTimeline data={data} groupBy={groupBy} zoom={zoom} onOpen={setProjectId} owners={owners} /><RoadmapBelow data={data} onOpen={setProjectId} /></>
        : <LaneBoard projects={data.projects} onOpen={setProjectId} onLane={(id, l) => void onLane(id, l)} errors={laneErrors} notes={laneNotes} owners={owners} pending={moving} />}
      {data && data.system.length > 0 && (
        <div className="co-faint" style={{ marginTop: 14 }}>
          Also on the board: {data.system.map((p, i) => <span key={p.id}>{i > 0 && ', '}<button className="co-link" style={{ fontSize: 12 }} onClick={() => setProjectId(p.id)}>{p.title}{p.unitName ? ` (${p.unitName})` : ''}</button> {p.progress.total - p.progress.done} open</span>)}
        </div>
      )}
    </div>
  );
}

function NewProject({ org, onDone }: { org: OrgDetail; onDone: (id: string | null) => Promise<void> }) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const [goalId, setGoalId] = useState('');
  const [lane, setLane] = useState<Lane>('next');
  const [targetDate, setTarget] = useState('');
  const krs = org.goals.filter((g) => (g as { kind?: string }).kind === 'key_result' || (g as { kind?: string }).kind === 'objective');
  const save = async () => {
    try {
      const p = await api.createOrgProject(org.workspaceId, { title: title.trim(), lane, ...(goalId ? { goalIds: [goalId] } : {}), ...(targetDate ? { targetDate } : {}) });
      await onDone(p.id);
    } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };
  return (
    <form className="co-card co-form" style={{ padding: 16, marginBottom: 14 }} onSubmit={(e) => { e.preventDefault(); if (title.trim()) void save(); }}>
      <div style={{ fontSize: 14, fontWeight: 650 }}>New project</div>
      <label className="co-field"><span>Title</span><input className="co-input" aria-label="Project title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What will be built or changed" /></label>
      <div className="co-form-row">
        <label className="co-field"><span>Key result it moves</span><select className="co-input" aria-label="Key result" value={goalId} onChange={(e) => setGoalId(e.target.value)}><option value="">None yet</option>{krs.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}</select></label>
        <label className="co-field"><span>Lane</span><select className="co-input" aria-label="Lane" value={lane} onChange={(e) => setLane(e.target.value as Lane)}>{LANES.map((l) => <option key={l} value={l}>{LANE_WORD[l]}</option>)}</select></label>
        <label className="co-field"><span>Target date</span><input className="co-input" aria-label="Target date" type="date" value={targetDate} onChange={(e) => setTarget(e.target.value)} /></label>
      </div>
      <div className="co-form-foot"><button type="button" className="co-btn ghost" onClick={() => void onDone(null)}>Cancel</button><button type="submit" className="co-btn primary" disabled={!title.trim()}>Create project</button></div>
    </form>
  );
}

function ProjectPane({ wsId, projectId, onBack }: { wsId: string; projectId: string; onBack: () => void }) {
  const app = useApp();
  const [page, setPage] = useState<ProjectPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gen, setGen] = useState(0);
  const matrix = useProgram(wsId, String(gen));
  const load = useCallback(async () => {
    setGen((g) => g + 1);
    try { setPage(await api.orgProject(wsId, projectId)); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [wsId, projectId]);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } };
  if (!page) return <div>{err ? <div role="alert" className="co-alert">{err}</div> : <PageSkeleton cards={4} />}<button className="co-btn" style={{ marginTop: 10 }} onClick={onBack}>Back to roadmap</button></div>;
  const id = page.project.id;
  return (
    <ProjectPageView page={page} program={matrix?.items.find((i) => i.refType === 'project' && i.id === id) ?? null} onBack={onBack}
      onPatch={(patch) => act(() => api.updateOrgProject(wsId, id, patch))}
      onPostUpdate={(u) => act(() => api.postProjectUpdate(wsId, id, u))}
      onAddMilestone={(m) => act(() => api.addProjectMilestone(wsId, id, m))}
      onToggleMilestone={(mid, done) => act(() => api.setProjectMilestone(wsId, id, mid, { done }))}
      onOpenTask={(taskId) => app.openOrgTask(taskId)} />
  );
}
