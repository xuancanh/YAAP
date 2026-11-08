/**
 * HomeBoard — the owner's command center, drawn from one HomeData
 * (docs/home.md). Presentational: everything it does goes out through the
 * props (an inline decision, a navigation), so web-tests render it with a
 * fixture and no store.
 *
 * Four tabs under the header (docs/home.md "Tabs"). The Overview is what the
 * owner needs at a glance: a state banner when the company is paused or over
 * its envelope, one instrument strip of key numbers, the top of Needs you
 * (the Inbox has the rest), unread messages and a short "while you were
 * away". Progress: roadmap, goals, spend and health, coming up. Team: the
 * roster and every message. Activity: since the last visit, highlights and
 * the full feed, recent files. Wide, each tab is a 12-column grid (a main
 * and a side column); narrower one column; on a phone a 16 px gutter.
 *
 * One card system: a panel with one radius, one border and one padding
 * scale; small-caps section labels; strong titles; meta in the dim text
 * colour (never the faint one, which is too low-contrast to read); status
 * colours only where they mean something; numbers in tabular figures.
 */
import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { AgentMessage, HomeActivity, HomeAgent, HomeData, HomeGoal, HomeNeed, HomeNeedAction, HomeNowProject, PortfolioKind } from '../lib/api';
import {
  activityFilters, activityRows, askedBy, briefSummary, dedupeUpcoming, defaultShort, filesLine, highlights, needBody, needHeadline, recommendationChip,
  sinceLabel, stateBanners, targetWords, upcomingDetail, weekOverWeek, type ActivityFilter, type HomeHighlight, NEED_KIND_LABEL, actionLabel, dayHeading,
  defaultSentence, greeting, headline, recommendationLine, splitPath, targetOf, needTarget, usd, when, type HomeTarget,
} from '../lib/home';
import { Markdown } from '../lib/md';
import type { MentionCandidate } from '../lib/channels';
import { MentionText } from './MentionBox';
import { I, P } from '../lib/icons';
import { hopLine, managerHops } from '../lib/decisions';
import { incidentCounts, incidentLine } from '../lib/org3';
import { HOME_TABS, type HomeTab } from '../lib/routes';

export interface HomeBoardProps {
  data: HomeData;
  /** Phone width: one column, tighter type. */
  narrow: boolean;
  /** Wide enough for the side column. */
  wide: boolean;
  /** The owner's first name or '' — the greeting. */
  name?: string;
  now?: Date;
  /** Needs-you cards with a decision in flight. */
  busy?: Set<string>;
  onAct: (need: HomeNeed, action: HomeNeedAction) => void;
  onOpen: (target: HomeTarget) => void;
  /** "All agents": the full directory. */
  onAllAgents: () => void;
  /** The empty-state calls to action. */
  onStartCompany?: () => void;
  onNewAgent?: () => void;
  onRetry?: () => void;
  /** Open a message from the team: its direct chat (default: onOpen to the chat). */
  onMessage?: (m: AgentMessage) => void;
  /** Who may be tagged (docs/work-tracking.md "Mentions"): `@names` in snippets render as chips. */
  mentionables?: MentionCandidate[];
  /** The tab on screen (docs/home.md "Tabs"); without it the board keeps its own, starting on the Overview. */
  tab?: HomeTab;
  /** A tab picked (the view writes it to the address). */
  onTab?: (tab: HomeTab) => void;
}

// ---- tokens ----

const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
const RADIUS = 12;
const GAP = 20;
const SEV_COLOR: Record<HomeNeed['severity'], string> = { critical: 'var(--red)', high: 'var(--amber)', normal: 'var(--accent)' };
const RAG_COLOR: Record<HomeGoal['rag'], string> = { red: 'var(--red)', amber: 'var(--amber)', green: 'var(--green)', grey: 'var(--text-dim)' };
const RAG_WORD: Record<HomeGoal['rag'], string> = { red: 'At risk', amber: 'Watch', green: 'On track', grey: 'Not measured' };
const STATE_COLOR: Record<HomeAgent['state'], string> = { working: 'var(--blue)', idle: 'var(--green)', blocked: 'var(--amber)', paused: 'var(--text-dim)', error: 'var(--red)' };
const STATE_WORD: Record<HomeAgent['state'], string> = { working: 'Working', idle: 'Idle', blocked: 'Blocked', paused: 'Paused', error: 'Failing' };
const HEALTH_COLOR: Record<string, string> = { on_track: 'var(--green)', at_risk: 'var(--amber)', off_track: 'var(--red)', '': 'var(--border)' };
const HEALTH_WORD: Record<string, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', '': 'No update yet' };
const KIND_WORD: Record<PortfolioKind, string> = { off_track: 'Off track', tripped: 'Breaker tripped', update_missing: 'Update missing', at_risk: 'At risk', over_budget: 'Over budget', late: 'Late' };
const KIND_COLOR: Record<PortfolioKind, string> = { off_track: 'var(--red)', tripped: 'var(--red)', update_missing: 'var(--amber)', at_risk: 'var(--amber)', over_budget: 'var(--amber)', late: 'var(--text-dim)' };
const URGENCY_COLOR: Record<AgentMessage['urgency'], string> = { urgent: 'var(--red)', normal: 'var(--accent)', fyi: 'var(--text-dim)' };
const NEEDS_SHOWN = 5;
/** With a company the Overview shows the top few; the Inbox has them all. */
const NEEDS_GLANCE = 3;
const MESSAGES_GLANCE = 3;
const AWAY_HIGHLIGHTS = 4;
const TEAM_SHOWN = 8;
const HIGHLIGHTS_SHOWN = 8;

const num: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const meta: CSSProperties = { color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.45 };
const body: CSSProperties = { color: 'var(--text)', fontSize: 13.5, lineHeight: 1.5 };
const ellipsis: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
const clamp = (lines: number): CSSProperties => ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' });
const reset: CSSProperties = { background: 'none', border: 'none', padding: 0, margin: 0, font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' };

const btn = (kind: 'primary' | 'plain' | 'quiet' = 'plain', size: 'sm' | 'md' = 'sm'): CSSProperties => ({
  ...reset, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap', flex: 'none',
  height: size === 'sm' ? 30 : 34, padding: kind === 'quiet' ? '0 6px' : size === 'sm' ? '0 11px' : '0 14px', borderRadius: 8,
  fontSize: size === 'sm' ? 12.5 : 13, fontWeight: 600,
  background: kind === 'primary' ? 'var(--accent)' : kind === 'plain' ? 'var(--panel-2)' : 'none',
  color: kind === 'primary' ? 'var(--on-accent)' : kind === 'quiet' ? 'var(--accent-hi)' : 'var(--text)',
  border: kind === 'plain' ? '1px solid var(--border)' : '1px solid transparent',
});
const link: CSSProperties = { ...reset, color: 'var(--accent-hi)', fontSize: 12.5, fontWeight: 600 };
const chip = (color: string, strong = false): CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 6, flex: 'none', whiteSpace: 'nowrap',
  fontSize: 11.5, fontWeight: 650, color, background: tint(color, strong ? 18 : 12),
});
const keyChip: CSSProperties = { fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600, color: 'var(--text)', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 5, padding: '1px 6px', flex: 'none', whiteSpace: 'nowrap' };

/** Hover and focus states, the skeleton shimmer, reduced motion: what inline styles cannot say. */
const CSS = `
.hm { --on-accent: #0b0d10; }
[data-theme="light"] .hm { --on-accent: #fff; }
.hm button:focus-visible, .hm a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.hm .hm-row { transition: background .12s; }
.hm .hm-row:hover { background: var(--hover); }
.hm .hm-tile { transition: background .12s; }
.hm .hm-tile:hover { background: var(--panel-2); }
.hm .hm-btn:hover:not(:disabled) { filter: brightness(1.08); }
.hm .hm-plain:hover:not(:disabled) { background: var(--hover); }
.hm .hm-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.hm button:disabled { cursor: default; opacity: .55; }
.hm-skel { background: linear-gradient(90deg, var(--panel-2) 0%, var(--hover) 50%, var(--panel-2) 100%); background-size: 200% 100%; animation: hmShimmer 1.4s ease-in-out infinite; border-radius: 8px; }
@keyframes hmShimmer { from { background-position: 100% 0 } to { background-position: -100% 0 } }
@media (prefers-reduced-motion: reduce) { .hm-skel { animation: none; } .hm .hm-row, .hm .hm-tile { transition: none; } }
.hm-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; margin-top: -4px; }
.hm-tabs::-webkit-scrollbar { display: none; }
.hm .hm-tabs .ibx-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 6px; }
`;

// ---- primitives ----

function Panel({ id, title, count, sub, action, children, flush }: { id: string; title: string; count?: number; sub?: ReactNode; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section aria-labelledby={`home-${id}`} data-testid={`home-${id}`} style={{ minWidth: 0, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: RADIUS, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 16px 11px', minHeight: 46, flexWrap: 'wrap' }}>
        <h2 id={`home-${id}`} style={{ margin: 0, fontSize: 15.5, fontWeight: 650, letterSpacing: '.05em', fontVariantCaps: 'all-small-caps', color: 'var(--text)' }}>{title}</h2>
        {count !== undefined && count > 0 && <span style={{ ...num, fontSize: 11.5, fontWeight: 700, color: 'var(--text-dim)', background: 'var(--panel-2)', borderRadius: 10, padding: '1px 7px' }}>{count}</span>}
        {sub && <span style={meta}>{sub}</span>}
        <span style={{ flex: 1 }} />
        {action}
      </div>
      <div style={flush ? undefined : { padding: '0 16px 14px' }}>{children}</div>
    </section>
  );
}

function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div style={{ ...meta, fontSize: 13, padding: '4px 0 2px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span>{children}</span>{action}
    </div>
  );
}

function Avatar({ emoji, colors, size = 30, dot }: { emoji: string; colors: string; size?: number; dot?: string }) {
  let bg = 'linear-gradient(135deg,var(--accent),var(--blue))';
  try { const [a, b] = JSON.parse(colors) as [string, string]; bg = `linear-gradient(140deg,${a},${b})`; } catch { /* default */ }
  return (
    <span style={{ width: size, height: size, borderRadius: size * 0.3, background: bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.5, flex: 'none', position: 'relative' }}>
      {emoji}
      {dot && <span aria-hidden style={{ position: 'absolute', right: -2, bottom: -2, width: 10, height: 10, borderRadius: '50%', background: dot, border: '2px solid var(--panel)' }} />}
    </span>
  );
}

function Bar({ value, color, label, height = 6 }: { value: number; color: string; label: string; height?: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height, borderRadius: height / 2, background: 'var(--panel-2)', overflow: 'hidden', flex: 1, minWidth: 40 }}>
      <div style={{ width: `${pct}%`, minWidth: pct > 0 ? height : 0, height: '100%', background: color, borderRadius: height / 2 }} />
    </div>
  );
}

/** A 14-day trend, single series: line, soft area, today's point. Its words are its label. */
function Spark({ values, color, label }: { values: number[] | undefined; color: string; label: string }) {
  if (!values || values.length < 2 || values.every((v) => v === 0)) return null;
  const w = 76; const h = 24; const max = Math.max(...values) || 1;
  const pts = values.map((v, i) => [2 + (i * (w - 4)) / (values.length - 1), h - 3 - (v / max) * (h - 7)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} style={{ display: 'block', flex: 'none', overflow: 'visible' }}>
      <title>{label}</title>
      <path d={`${line} L${last[0].toFixed(1)} ${h} L2 ${h} Z`} fill={tint(color, 14)} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2.6} fill={color} stroke="var(--panel)" strokeWidth={1.5} />
    </svg>
  );
}

// ---- 1. header and state banners ----

function Header({ data, narrow, name, now, onOpen }: Pick<HomeBoardProps, 'data' | 'narrow' | 'name' | 'onOpen'> & { now: Date }) {
  const c = data.company;
  const sentences = headline(data, now).slice(0, 2);
  const hello = `${greeting(now)}${name ? `, ${name}` : ''}.`;
  return (
    <header data-testid="home-header" style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      {c && <div style={{ ...meta, fontSize: 13 }}>{hello}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: narrow ? 22 : 26, fontWeight: 650, letterSpacing: '-.4px', lineHeight: 1.2, overflowWrap: 'anywhere' }}>{c ? c.name : hello}</h1>
        {c && (
          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span data-testid="home-mode" title={c.mode === 'autonomous' ? 'The chief of staff hires, reorganizes and allocates within caps on its own' : 'Structural changes wait for your decision'}
              style={{ ...chip('var(--text-dim)'), background: 'var(--panel-2)', border: '1px solid var(--border)' }}>
              {c.mode === 'autonomous' ? 'Autonomous' : 'Supervised'}
            </span>
            <button data-testid="home-run-state" className="hm-btn" onClick={() => onOpen({ to: 'pane', pane: 'board' })} title="The kill switch lives in the Company header"
              style={{ ...reset, ...chip(c.status === 'paused' ? 'var(--red)' : 'var(--green)', c.status === 'paused') }}>
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor' }} />
              {c.status === 'paused' ? 'Paused' : 'Running'}
            </button>
          </span>
        )}
      </div>
      <p data-testid="home-headline" style={{ margin: 0, ...meta, fontSize: 14, color: 'var(--text-dim)', ...num }}>
        {sentences.join(' ')}
        {c && <> {c.chiefName ? (/^chief of staff$/i.test(c.chiefName.trim()) ? 'Your chief of staff leads the team' : `${c.chiefName} is chief of staff`) : 'No chief of staff yet'}, with {c.memberCount} {c.memberCount === 1 ? 'member' : 'members'}.</>}
      </p>
      {data.partial.length > 0 && <span role="status" style={{ ...meta, color: 'var(--amber)' }}>Some parts didn't load: {data.partial.join(', ')}.</span>}
    </header>
  );
}

function Banners({ data, narrow, onOpen }: Pick<HomeBoardProps, 'data' | 'narrow' | 'onOpen'>) {
  const list = stateBanners(data);
  if (!list.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {list.map((b) => {
        const color = b.tone === 'red' ? 'var(--red)' : 'var(--amber)';
        return (
          <div key={b.id} role="alert" data-testid={`home-banner-${b.id}`}
            style={{ display: 'flex', gap: 14, alignItems: narrow ? 'flex-start' : 'center', flexDirection: narrow ? 'column' : 'row', padding: narrow ? '14px 16px' : '14px 18px', borderRadius: RADIUS, border: `1px solid ${tint(color, 45)}`, background: tint(color, 10) }}>
            <span aria-hidden style={{ display: narrow ? 'none' : 'inline-flex', width: 34, height: 34, borderRadius: 9, background: tint(color, 20), color, alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <I d={b.id === 'paused' ? P.stopSquare : P.warn} size={17} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 650, color: 'var(--text)' }}>{b.title}</span>
              <span style={{ display: 'block', ...meta, fontSize: 13, color: 'var(--text)', opacity: 0.85 }}>{b.body}</span>
            </span>
            <button className="hm-btn" onClick={() => onOpen(b.action.target)} style={{ ...btn('primary', 'md'), background: color, color: b.tone === 'amber' ? '#1b1405' : '#fff' }}>{b.action.label}</button>
          </div>
        );
      })}
    </div>
  );
}

// ---- 2. the instrument strip ----

function Kpi({ testid, label, value, unit, sub, tone, onClick, children, span }: { testid: string; label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: string; onClick?: () => void; children?: ReactNode; span?: number }) {
  const inner = (
    <>
      <span style={{ ...meta, fontSize: 12.5, fontWeight: 600 }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'flex-end', gap: 10, justifyContent: 'space-between', minWidth: 0 }}>
        <span style={{ ...num, fontSize: 28, fontWeight: 650, letterSpacing: '-.6px', lineHeight: 1.05, color: tone ?? 'var(--text)', whiteSpace: 'nowrap' }}>
          {value}{unit && <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-dim)', letterSpacing: 0, marginLeft: 3 }}>{unit}</span>}
        </span>
        {children}
      </span>
      {sub && <span style={{ ...meta, ...num, minWidth: 0 }}>{sub}</span>}
    </>
  );
  const style: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 16px 13px', background: 'var(--panel)', minWidth: 0, gridColumn: span && span > 1 ? `span ${span}` : undefined };
  return onClick
    ? <button data-testid={testid} className="hm-tile" onClick={onClick} style={{ ...reset, ...style, cursor: 'pointer' }}>{inner}</button>
    : <div data-testid={testid} style={style}>{inner}</div>;
}

/** Spent this month (solid), the month-end forecast (soft), the envelope (a tick). */
function SpendMeter({ month, cap, projected, color }: { month: number; cap: number; projected: number | null; color: string }) {
  const scale = Math.max(cap, projected ?? 0, month) || 1;
  const at = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  return (
    <span role="meter" aria-label="Month spend against the envelope" aria-valuenow={Math.round(month * 100) / 100} aria-valuemin={0} aria-valuemax={cap}
      style={{ position: 'relative', display: 'block', height: 14, marginTop: 2 }}>
      <span style={{ position: 'absolute', left: 0, right: 0, top: 3, height: 8, borderRadius: 4, background: 'var(--border)' }} />
      {projected !== null && projected > month && <span style={{ position: 'absolute', left: 0, top: 3, height: 8, width: at(projected), borderRadius: 4, background: tint(color, 45) }} />}
      <span style={{ position: 'absolute', left: 0, top: 3, height: 8, width: at(month), minWidth: month > 0 ? 4 : 0, borderRadius: 4, background: color }} />
      <span aria-hidden title={`Envelope ${usd(cap)}`} style={{ position: 'absolute', left: `calc(${at(cap)} - 1px)`, top: 0, width: 2, height: 14, borderRadius: 1, background: 'var(--text)' }} />
    </span>
  );
}

function KpiStrip({ data, narrow, wide, now, onOpen, onAgents }: Pick<HomeBoardProps, 'data' | 'narrow' | 'wide' | 'onOpen'> & { now: Date; onAgents: () => void }) {
  const c = data.company;
  const s = data.spend;
  const r = data.recap;
  const tiles: Array<(span: number) => ReactNode> = [];
  const n = data.headline.needsYou;
  const soon = data.needs.filter((x) => x.deadline && new Date(x.deadline).getTime() - now.getTime() < 6 * 3_600_000).length;
  const critical = data.needs.filter((x) => x.severity === 'critical').length;
  tiles.push((span) => (
    <Kpi key="needs" span={span} testid="kpi-needs" label="Needs you" value={n} tone={n > 0 ? 'var(--accent-hi)' : undefined}
      sub={n === 0 ? 'Nothing waiting' : critical ? `${critical} critical` : soon ? `${soon} due within 6 h` : 'Decisions and keys'}
      onClick={c ? () => onOpen({ to: 'inbox' }) : () => document.getElementById('home-needs')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
  ));
  const cap = s.monthCapUsd ?? 0;
  const spendColor = s.forecastState === 'stop' || (cap > 0 && (s.monthUsd ?? 0) >= cap) ? 'var(--red)' : s.forecastState === 'warn' ? 'var(--amber)' : 'var(--accent)';
  const usdSeries = s.series?.map((d) => d.usd);
  tiles.push((span) => (
    <Kpi key="spend" span={span} testid="kpi-spend" label={cap > 0 ? 'Spend vs envelope' : 'Spend this month'} value={usd(s.monthUsd)}
      unit={cap > 0 ? `/ ${usd(cap).replace('.00', '')}` : undefined}
      sub={cap > 0
        ? <span style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <SpendMeter month={s.monthUsd ?? 0} cap={cap} projected={s.projectedUsd} color={spendColor} />
            <span>{s.projectedUsd !== null ? <>Forecast <b style={{ color: spendColor === 'var(--accent)' ? 'var(--text)' : spendColor, fontWeight: 650 }}>{usd(s.projectedUsd)}</b></> : 'No forecast yet'}{s.todayUsd !== null ? `, ${usd(s.todayUsd)} today` : ''}</span>
          </span>
        : s.tokens ? `${Math.round(s.tokens.spent / 1000)}k of ${Math.round(s.tokens.budget / 1000)}k tokens` : s.todayUsd !== null ? `${usd(s.todayUsd)} today` : 'Nothing spent yet'}
      onClick={c ? () => onOpen({ to: 'pane', pane: 'spend' }) : undefined}>
      {cap > 0 ? null : <Spark values={usdSeries} color="var(--accent)" label="Spend per day, last 14 days" />}
    </Kpi>
  ));
  const doneVals = r.doneSeries?.map((d) => d.done);
  const wow = weekOverWeek(doneVals);
  tiles.push((span) => (
    <Kpi key="done" span={span} testid="kpi-done" label={wow ? 'Done this week' : 'Done since your visit'} value={wow ? wow.thisWeek : r.tasksDone}
      sub={wow && wow.delta !== null
        ? <span style={{ color: wow.delta > 0 ? 'var(--green)' : 'var(--text-dim)' }}>{wow.delta > 0 ? `+${wow.delta}` : wow.delta === 0 ? 'Same as' : wow.delta} {wow.delta === 0 ? 'last week' : 'vs last week'}</span>
        : `${r.tasksDone} since you were here`}
      onClick={c ? () => onOpen({ to: 'pane', pane: 'board' }) : undefined}>
      <Spark values={doneVals} color="var(--green)" label={`Tasks done per day, last 14 days: ${wow?.thisWeek ?? r.tasksDone} this week`} />
    </Kpi>
  ));
  tiles.push((span) => (
    <Kpi key="blocked" span={span} testid="kpi-blocked" label="Blocked" value={r.tasksBlocked} tone={r.tasksBlocked ? 'var(--amber)' : undefined}
      sub={r.tasksBlocked ? (r.tasksBlocked === 1 ? 'One task waits on something' : 'Tasks waiting on something') : 'Nothing blocked'}
      onClick={c ? () => onOpen({ to: 'pane', pane: 'board' }) : undefined} />
  ));
  const working = data.team.filter((a) => a.state === 'working').length;
  const failing = data.team.filter((a) => a.state === 'error').length;
  tiles.push((span) => (
    <Kpi key="agents" span={span} testid="kpi-agents" label="Agents working" value={working} unit={`/ ${data.team.length}`}
      sub={failing ? <span style={{ color: 'var(--red)', fontWeight: 600 }}>{failing} failing</span> : data.team.length ? 'None failing' : 'No agents yet'}
      onClick={onAgents} />
  ));
  if (r.pulse && c) {
    const p = r.pulse;
    tiles.push((span) => (
      <Kpi key="pulse" span={span} testid="kpi-pulse" label="Pulse" value={p.score} unit="/ 100" tone={p.score < 60 ? 'var(--amber)' : undefined}
        sub={p.breaches ? <span style={{ color: 'var(--amber)' }}>{p.breaches} breach{p.breaches === 1 ? '' : 'es'}</span> : 'No breaches'}
        onClick={c ? () => onOpen({ to: 'pane', pane: 'pulse' }) : undefined} />
    ));
  }
  const cols = narrow ? 2 : wide ? tiles.length : 3;
  const rem = tiles.length % cols;
  return (
    <div data-testid="home-kpis" role="group" aria-label="Key numbers"
      style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 1, background: 'var(--border)', border: '1px solid var(--border)', borderRadius: RADIUS, overflow: 'hidden' }}>
      {tiles.map((t, i) => t(i === tiles.length - 1 && rem ? cols - rem + 1 : 1))}
    </div>
  );
}

// ---- 3. needs you ----

function NeedRow({ n, now, narrow, busy, first, onAct, onOpen, mentionables = [] }: { n: HomeNeed; now: Date; narrow: boolean; busy: boolean; first: boolean; onAct: HomeBoardProps['onAct']; onOpen: HomeBoardProps['onOpen']; mentionables?: MentionCandidate[] }) {
  const [open, setOpen] = useState(false);
  const { title, task } = needHeadline(n);
  const who = askedBy(n);
  const short = defaultShort(n, now);
  const full = defaultSentence(n, now);
  const rec = recommendationChip(n);
  const target = needTarget(n);
  const detail = needBody(n);
  const sev = SEV_COLOR[n.severity];
  const defaultTone = n.defaultAction === 'approve' || n.defaultAction === 'apply' ? 'var(--amber)' : 'var(--text-dim)';
  const actions = (
    <span style={{ display: 'inline-flex', gap: 6, flex: 'none', flexWrap: 'wrap' }}>
      {n.actions.map((a, i) => (
        <button key={a} disabled={busy} className={i === 0 ? 'hm-btn' : 'hm-plain'} onClick={() => onAct(n, a)} style={btn(i === 0 ? 'primary' : 'plain')}>{actionLabel(n, a)}</button>
      ))}
      {n.actions.length === 0 && target && <button className="hm-plain" onClick={() => onOpen(target)} style={btn('plain')}>Review</button>}
    </span>
  );
  return (
    <article data-testid="need-card" data-kind={n.kind} aria-busy={busy}
      style={{ borderTop: first ? 'none' : '1px solid var(--border-soft)', opacity: busy ? 0.6 : 1, position: 'relative' }}>
      <span aria-hidden style={{ position: 'absolute', left: 0, top: 12, bottom: 12, width: 3, borderRadius: 2, background: n.severity === 'normal' ? 'transparent' : sev }} />
      <div style={{ display: 'flex', gap: 12, alignItems: narrow ? 'flex-start' : 'center', padding: '12px 16px', flexDirection: narrow ? 'column' : 'row' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5, width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={chip(sev, n.severity !== 'normal')}>{NEED_KIND_LABEL[n.kind]}</span>
            <button className="hm-link" onClick={() => setOpen(!open)} aria-expanded={open} title={title}
              style={{ ...reset, ...(narrow ? { ...clamp(2), minWidth: 0 } : ellipsis), flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--text)', overflowWrap: 'anywhere' }}>{title}</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px 12px', flexWrap: 'wrap', ...meta }}>
            {task && (task.key
              ? <button className="hm-link" onClick={() => n.ref.taskId && onOpen({ to: 'task', taskId: n.ref.taskId })} title={task.title} style={{ ...reset, ...keyChip }}>{task.key}</button>
              : <span title={task.title} style={{ ...ellipsis, maxWidth: 260 }}>on “{task.title}”</span>)}
            {who && <span>{who}</span>}
            <span style={num}>{when(n.createdAt, now)}</span>
            {short && <span data-testid="need-default" title={full} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: defaultTone, fontWeight: 600 }}><I d={P.clock} size={12} />{short}</span>}
            {rec && <span data-testid="need-rec" style={chip('var(--text-dim)')}>{rec}</span>}
          </div>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' }}>
          {actions}
          <button className="hm-plain" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'}
            style={{ ...btn('quiet'), width: 30, color: 'var(--text-dim)' }}>
            <I d={open ? P.chevD : P.chevR} size={15} />
          </button>
        </span>
      </div>
      {open && (
        <div data-testid="need-detail" style={{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 8, marginTop: -2 }}>
          {task && <div style={meta}>About {task.key ? <b style={{ color: 'var(--text)', fontWeight: 600 }}>{task.key}</b> : 'the task'} {task.title}</div>}
          {detail && <div style={{ ...body, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}><MentionText text={detail} members={mentionables} /></div>}
          {n.chain && (
            <div data-testid="need-chain" style={{ ...meta, display: 'grid', gap: 2 }}>
              <div style={{ overflowWrap: 'anywhere' }}><span style={{ color: 'var(--text)', fontWeight: 600 }}>{n.chain.line}</span>{n.chain.reserved ? <span>. Only you decide this ({n.chain.reserved}).</span> : null}</div>
              {managerHops(n.chain.hops).map((h, i) => <div key={`${h.at}-${i}`} data-testid="need-chain-hop" style={{ ...clamp(2), overflowWrap: 'anywhere' }}>{hopLine({ ...h, byName: h.by })}</div>)}
            </div>
          )}
          {(n.recommendation || recommendationLine(n)) && (
            <div style={meta}>{recommendationLine(n)}{n.recommendation ? <span style={{ color: 'var(--text)' }}> “{n.recommendation}”</span> : null}</div>
          )}
          {full && <div data-testid="need-default-full" style={{ ...meta, color: defaultTone, display: 'flex', alignItems: 'center', gap: 6 }}><I d={P.clock} size={13} />{full}</div>}
          {target && <div><button className="hm-link" style={link} onClick={() => onOpen(target)}>Open for the full context</button></div>}
        </div>
      )}
    </article>
  );
}

function NeedsYou({ data, now, narrow, busy, onAct, onOpen, mentionables }: Pick<HomeBoardProps, 'data' | 'narrow' | 'onAct' | 'onOpen' | 'mentionables'> & { now: Date; busy: Set<string> }) {
  const [all, setAll] = useState(false);
  // A company has the Inbox, where every card waits: Home shows the top few
  // and links the rest there. Without one, Home is the only list.
  const inbox = Boolean(data.company);
  const shown = all && !inbox ? data.needs : data.needs.slice(0, inbox ? NEEDS_GLANCE : NEEDS_SHOWN);
  const more = data.headline.needsYou - shown.length;
  return (
    <Panel id="needs" title="Needs you" count={data.headline.needsYou} flush
      action={data.company ? <button className="hm-link" style={link} onClick={() => onOpen({ to: 'inbox' })}>See all in Inbox</button> : undefined}>
      {data.needs.length === 0 ? (
        <div data-testid="needs-empty" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '6px 16px 16px' }}>
          <span aria-hidden style={{ width: 30, height: 30, borderRadius: 8, background: tint('var(--green)', 14), color: 'var(--green)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><I d={P.check} size={16} /></span>
          <span style={{ ...meta, fontSize: 13 }}><b style={{ color: 'var(--text)', fontWeight: 600 }}>You're clear.</b> {data.company ? 'New decisions, keys and escalations land here first.' : 'Approvals your agents ask for land here first.'}</span>
        </div>
      ) : (
        <div>
          {shown.map((n, i) => <NeedRow key={n.id} n={n} now={now} narrow={narrow} first={i === 0} busy={busy.has(n.id)} onAct={onAct} onOpen={onOpen} mentionables={mentionables} />)}
          {more > 0 && (
            <div style={{ borderTop: '1px solid var(--border-soft)', padding: '10px 16px' }}>
              <button className="hm-link" style={link} onClick={() => (!inbox && data.needs.length > shown.length ? setAll(true) : onOpen({ to: 'inbox' }))}>
                {more} more{!inbox && data.needs.length > shown.length ? '' : ' in the Inbox'}
              </button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---- messages from your team (docs/agent-messages.md) ----

/** What agents wrote to the owner with message_owner, unread first. The text
 *  is the agent's, shown as plain text (data, never markup); a row opens the
 *  direct chat, where the reply goes. Hidden when there is nothing. */
function TeamMessages({ data, now, onOpen, onMessage, mentionables = [], glance, onMore }: Pick<HomeBoardProps, 'data' | 'onOpen' | 'onMessage' | 'mentionables'> & { now: Date; glance?: boolean; onMore?: () => void }) {
  const m = data.messages;
  // At a glance (the Overview): the unread ones only, the newest few.
  const items = !m ? [] : glance ? m.items.filter((x) => !x.read).slice(0, MESSAGES_GLANCE) : m.items;
  if (!m || items.length === 0) return null;
  const open = (x: AgentMessage) => (onMessage ? onMessage(x) : onOpen({ to: 'chat', sessionId: x.sessionId }));
  const rest = m.items.length - items.length;
  return (
    <Panel id="messages" title="Messages from your team" count={m.unread} flush
      action={glance && onMore && rest > 0
        ? <button className="hm-link" style={link} onClick={onMore}>All messages</button>
        : data.company ? <button className="hm-link" style={link} onClick={() => onOpen({ to: 'inbox' })}>All in Inbox</button> : undefined}>
      {items.map((x, i) => (
        <button key={x.id} data-testid={`home-message-${x.id}`} className="hm-row" onClick={() => open(x)}
          style={{ ...reset, display: 'flex', gap: 11, alignItems: 'flex-start', width: '100%', padding: '11px 16px', borderTop: i ? '1px solid var(--border-soft)' : 'none' }}>
          <Avatar emoji={x.emoji} colors={x.colors} size={28} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 650, fontSize: 13.5 }}>{x.agentName}</span>
              {x.urgency !== 'normal' && <span data-testid="home-message-urgency" style={chip(URGENCY_COLOR[x.urgency], x.urgency === 'urgent')}>{x.urgency === 'urgent' ? 'Urgent' : 'FYI'}</span>}
              {!x.read && <span data-testid="home-message-unread" aria-label="unread" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />}
              <span style={{ flex: 1 }} />
              <span style={{ ...meta, ...num }}>{when(x.createdAt, now)}</span>
            </span>
            <span style={{ ...body, ...clamp(2), whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 2, color: x.read ? 'var(--text-dim)' : 'var(--text)' }}><MentionText text={x.text} members={mentionables} /></span>
            {x.refs.length > 0 && <span style={{ ...meta, display: 'block', marginTop: 3, overflowWrap: 'anywhere' }}>{x.refs.join(', ')}</span>}
          </span>
        </button>
      ))}
    </Panel>
  );
}

// ---- 4. team ----

function TeamRow({ a, now, first, onOpen }: { a: HomeAgent; now: Date; first: boolean; onOpen: HomeBoardProps['onOpen'] }) {
  const failing = a.state === 'error';
  const err = a.errors[0];
  const role = a.isChief ? 'Chief of staff' : a.title || 'Agent';
  const line = a.doing || (a.state === 'paused' ? 'Paused' : a.lastActiveAt ? `Last active ${when(a.lastActiveAt, now)}` : 'Not active yet');
  return (
    <div data-testid="team-agent" data-state={a.state}
      style={{ borderTop: first ? 'none' : '1px solid var(--border-soft)', background: failing ? tint('var(--red)', 6) : undefined }}>
      <button className="hm-row" onClick={() => onOpen({ to: 'agent', agentId: a.id })} title={`${a.name}, ${role}`}
        style={{ ...reset, display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 16px', minWidth: 0 }}>
        <Avatar emoji={a.emoji} colors={a.colors} dot={STATE_COLOR[a.state]} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
            <span style={{ ...ellipsis, fontSize: 13.5, fontWeight: 600 }}>{a.name}</span>
            <span style={{ ...ellipsis, ...meta, fontSize: 12, flex: 1 }}>{role}</span>
          </span>
          <span style={{ ...ellipsis, display: 'block', ...meta, color: a.state === 'blocked' ? 'var(--amber)' : 'var(--text-dim)' }}>{line}</span>
        </span>
        <span style={chip(STATE_COLOR[a.state], failing)}>{STATE_WORD[a.state]}</span>
      </button>
      {a.errors.length > 0 && (
        <div style={{ padding: '0 16px 11px 57px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {a.errors.map((e, i) => (
            <span key={i} data-testid="agent-error" style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--red)', overflowWrap: 'anywhere', ...clamp(3) }}>{e.message}</span>
          ))}
          {failing && (
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="hm-plain" style={btn('plain')} onClick={() => onOpen({ to: 'agent', agentId: a.id })}>Fix</button>
              {err?.sessionId && <button className="hm-plain" style={btn('plain')} onClick={() => onOpen({ to: 'chat', sessionId: err.sessionId! })}><I d={P.retry} size={13} />Open the run</button>}
              {!err?.sessionId && err?.taskId && <button className="hm-plain" style={btn('plain')} onClick={() => onOpen({ to: 'task', taskId: err.taskId! })}>Open the task</button>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Team({ data, now, onOpen, onAllAgents }: Pick<HomeBoardProps, 'data' | 'onOpen' | 'onAllAgents'> & { now: Date }) {
  const [all, setAll] = useState(false);
  // Failing agents are pinned on top, the rest keep the server's order.
  const team = [...data.team.filter((a) => a.state === 'error'), ...data.team.filter((a) => a.state !== 'error')];
  const failing = team.filter((a) => a.state === 'error').length;
  const shown = all ? team : team.slice(0, Math.max(TEAM_SHOWN, failing));
  const counts = (['working', 'blocked', 'idle', 'paused'] as const).map((s) => [s, team.filter((a) => a.state === s).length] as const).filter(([, n]) => n > 0);
  return (
    <Panel id="team" title="Team" count={data.team.length} flush action={<button className="hm-link" style={link} onClick={onAllAgents}>All agents</button>}>
      {failing > 0 && (
        <div role="alert" style={{ margin: '0 16px 10px', fontSize: 12.5, color: 'var(--red)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          <I d={P.warn} size={13} />{failing === 1 ? 'One agent is failing.' : `${failing} agents are failing.`} Fix them before they miss work.
        </div>
      )}
      {counts.length > 0 && (
        <div style={{ display: 'flex', gap: '4px 14px', flexWrap: 'wrap', padding: '0 16px 10px', ...meta }}>
          {counts.map(([s, n]) => (
            <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: STATE_COLOR[s] }} />
              <span style={num}>{n}</span> {STATE_WORD[s].toLowerCase()}
            </span>
          ))}
        </div>
      )}
      {team.length === 0 ? <div style={{ padding: '0 16px 14px' }}><Empty>No agents yet.</Empty></div> : (
        <div style={{ borderTop: '1px solid var(--border-soft)' }}>
          {shown.map((a, i) => <TeamRow key={a.id} a={a} now={now} first={i === 0} onOpen={onOpen} />)}
          {team.length > shown.length && (
            <div style={{ borderTop: '1px solid var(--border-soft)', padding: '10px 16px' }}>
              <button className="hm-link" style={link} onClick={() => setAll(true)}>Show {team.length - shown.length} more</button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---- 5. roadmap snapshot (docs/work-tracking.md) ----

function ProjectRow({ p, kinds, detail, now, first, narrow, onOpen }: { narrow: boolean; p: { projectId: string; key: string | null; title: string; leadName: string } & Partial<HomeNowProject>; kinds: PortfolioKind[]; detail: string; now: Date; first: boolean; onOpen: (id: string) => void }) {
  const health = p.health ?? '';
  const target = targetWords(p.targetDate ?? null, now);
  return (
    <li data-testid="portfolio-project" data-flagged={kinds.length > 0 || undefined} style={{ borderTop: first ? 'none' : '1px solid var(--border-soft)' }}>
      <button className="hm-row" onClick={() => onOpen(p.projectId)}
        style={{ ...reset, display: 'grid', gridTemplateColumns: narrow ? 'minmax(0,1fr)' : 'minmax(0,1fr) auto', gap: '8px 16px', alignItems: 'center', width: '100%', padding: '11px 16px' }}>
        <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span aria-label={HEALTH_WORD[health]} title={HEALTH_WORD[health]} style={{ width: 9, height: 9, borderRadius: '50%', flex: 'none', background: HEALTH_COLOR[health], boxShadow: health ? `0 0 0 3px ${tint(HEALTH_COLOR[health], 18)}` : undefined }} />
            {p.key && <span style={keyChip}>{p.key}</span>}
            <span style={{ ...ellipsis, fontSize: 13.5, fontWeight: 600 }}>{p.title}</span>
          </span>
          <span style={{ display: 'flex', gap: '4px 10px', flexWrap: 'wrap', alignItems: 'center', ...meta, paddingLeft: 17 }}>
            {kinds.map((k) => <span key={k} style={chip(KIND_COLOR[k])}>{KIND_WORD[k]}</span>)}
            <span>Lead {p.leadName}</span>
            {p.blocked ? <span style={{ color: 'var(--amber)' }}>{p.blocked} blocked</span> : null}
          </span>
          {detail && <span style={{ ...meta, paddingLeft: 17, ...clamp(2), overflowWrap: 'anywhere' }}>{detail}</span>}
        </span>
        {p.progress && (
          <span style={{ display: 'flex', flexDirection: narrow ? 'row' : 'column', alignItems: narrow ? 'center' : 'flex-end', gap: narrow ? 12 : 5, width: narrow ? 'auto' : 132, paddingLeft: narrow ? 17 : 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: narrow ? 160 : '100%', flex: 'none' }}>
              <Bar value={p.progress.pct / 100} color={health ? HEALTH_COLOR[health] : 'var(--accent)'} label={`${p.title} progress`} />
              <span style={{ ...meta, ...num, fontSize: 12, minWidth: 34, textAlign: 'right' }}>{p.progress.done}/{p.progress.total}</span>
            </span>
            {target && <span style={{ ...meta, ...num, fontSize: 12, whiteSpace: 'nowrap', color: p.late ? 'var(--red)' : 'var(--text-dim)' }}>{p.late ? target : `Target ${target}`}</span>}
          </span>
        )}
      </button>
    </li>
  );
}

function Roadmap({ data, now, narrow, onOpen }: Pick<HomeBoardProps, 'data' | 'narrow' | 'onOpen'> & { now: Date }) {
  const pf = data.portfolio;
  if (!data.company || !pf) return null;
  const openProject = (id: string) => onOpen({ to: 'pane', pane: 'roadmap', focus: { kind: 'project', id } });
  const c = pf.counts;
  const ex = new Map(pf.exceptions.map((e) => [e.projectId, e]));
  const nowRows = pf.nowProjects ?? [];
  const inNow = new Set(nowRows.map((p) => p.projectId));
  const elsewhere = pf.exceptions.filter((e) => !inNow.has(e.projectId));
  const openRoadmap = <button className="hm-link" style={link} onClick={() => onOpen({ to: 'pane', pane: 'roadmap' })}>Open roadmap</button>;
  return (
    <Panel id="portfolio" title="Roadmap" flush action={openRoadmap}
      sub={<span data-testid="portfolio-counts" style={num}>{c.now} in Now, {c.next} next, {c.later} later</span>}>
      {nowRows.length === 0 && elsewhere.length === 0 ? (
        <div style={{ padding: '0 16px 14px' }}>
          <Empty action={<button className="hm-plain" style={btn('plain')} onClick={() => onOpen({ to: 'pane', pane: 'roadmap' })}>Propose a bet</button>}>
            {c.now > 0 ? 'Every project in Now is on track with a fresh update.' : 'No project is in Now yet. The roadmap is where you choose the bets.'}
          </Empty>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border-soft)' }}>
          {nowRows.map((p, i) => <ProjectRow key={p.projectId} p={p} kinds={ex.get(p.projectId)?.kinds ?? []} detail={ex.get(p.projectId)?.detail ?? ''} now={now} narrow={narrow} first={i === 0} onOpen={openProject} />)}
          {elsewhere.length > 0 && nowRows.length > 0 && (
            <li aria-hidden style={{ ...meta, fontSize: 12, fontWeight: 600, padding: '10px 16px 4px', borderTop: '1px solid var(--border-soft)' }}>Also flagged</li>
          )}
          {elsewhere.map((e, i) => <ProjectRow key={e.projectId} p={e} kinds={e.kinds} detail={e.detail} now={now} narrow={narrow} first={i === 0 && nowRows.length === 0} onOpen={openProject} />)}
        </ul>
      )}
    </Panel>
  );
}

// ---- 6. goals ----

const GOALS_SHOWN = 4;
const KRS_SHOWN = 3;

function Goals({ data, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'>) {
  if (!data.company) return null;
  const vision = () => onOpen({ to: 'pane', pane: 'vision' });
  const shown = data.goals.slice(0, GOALS_SHOWN);
  return (
    <Panel id="goals" title="Goals" count={data.goals.length} action={<button className="hm-link" style={link} onClick={vision}>Vision and goals</button>}>
      {data.goals.length === 0 ? <Empty action={<button className="hm-plain" style={btn('plain')} onClick={vision}>Set a vision</button>}>No objectives yet.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {shown.map((g) => (
            <div key={g.id} data-testid="home-goal" data-rag={g.rag} style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <button className="hm-link" style={{ ...reset, ...ellipsis, flex: 1, fontSize: 13.5, fontWeight: 600 }} title={g.title} onClick={() => onOpen({ to: 'pane', pane: 'vision', focus: { kind: 'goal', id: g.id } })}>{g.title}</button>
                <span style={chip(RAG_COLOR[g.rag], g.rag === 'red')}>{RAG_WORD[g.rag]}</span>
              </div>
              {(g.atRiskReason || g.confidence !== null) && (
                <div style={{ ...meta, marginTop: 2 }}>{[g.atRiskReason, g.confidence !== null ? `${Math.round(g.confidence * 100)}% confident` : ''].filter(Boolean).join('. ')}</div>
              )}
              {g.keyResults.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {g.keyResults.slice(0, KRS_SHOWN).map((k) => (
                    <div key={k.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(56px, 34%) auto', gap: 10, alignItems: 'center' }}>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ ...ellipsis, display: 'block', ...meta, color: 'var(--text)', fontSize: 12.5 }} title={k.title}>{k.title}</span>
                        {k.projectHealth && <span data-testid="kr-project-health" title="The worst health a lead wrote on the projects that move it (shown beside the measure, not averaged in)" style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: HEALTH_COLOR[k.projectHealth] }}>projects {k.projectHealth.replace('_', ' ')}</span>}
                      </span>
                      <Bar value={k.progress} color={RAG_COLOR[k.rag]} label={`${k.title} progress`} />
                      <span style={{ ...meta, ...num, fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {k.currentValue !== null && k.targetValue !== null ? `${k.currentValue} / ${k.targetValue}${k.unitLabel ? ` ${k.unitLabel}` : ''}` : `${Math.round(k.progress * 100)}%`}
                      </span>
                    </div>
                  ))}
                  {g.keyResults.length > KRS_SHOWN && <button className="hm-link" style={{ ...link, fontWeight: 500 }} onClick={() => onOpen({ to: 'pane', pane: 'vision', focus: { kind: 'goal', id: g.id } })}>{g.keyResults.length - KRS_SHOWN} more key results</button>}
                </div>
              )}
            </div>
          ))}
          {data.goals.length > shown.length && <button className="hm-link" style={link} onClick={vision}>{data.goals.length - shown.length} more objectives</button>}
        </div>
      )}
    </Panel>
  );
}

// ---- 7. since you were here ----

const DECIDED_WORD: Record<string, string> = { default: 'By default', delegate: 'By your delegate', auto: 'On its own', decision: 'Logged' };

function SinceHere({ data, now, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'> & { now: Date }) {
  const r = data.recap;
  const pf = data.company ? data.portfolio : null;
  const openProject = (id: string) => onOpen({ to: 'pane', pane: 'roadmap', focus: { kind: 'project', id } });
  const brief = r.brief ? briefSummary(r.brief.text) : null;
  const facts: string[] = [];
  if (data.company) facts.push(`${r.decisionsCount} decided without you`);
  facts.push(`${r.artifactsChanged} ${r.artifactsChanged === 1 ? 'file' : 'files'} changed`);
  const nothing = !r.decisions.length && !r.people.length && !(pf && (pf.digest.length || pf.doneByProject.length)) && !r.brief;
  return (
    <Panel id="recap" title="Since you were here" sub={sinceLabel(data.since, now, data.firstVisit)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ ...meta, ...num, fontSize: 13 }}>{facts.join(', ')}.</div>
        {r.brief && brief && (
          <div data-testid="home-brief" style={{ borderLeft: '3px solid var(--accent)', paddingLeft: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 650 }}>{data.company?.chiefName ? `${data.company.chiefName}'s brief` : 'The latest brief'}</span>
              <span style={meta}>{when(r.brief.at, now)}</span>
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.5 }}><Markdown text={brief.md} compact /></div>
            <button className="hm-link" style={{ ...link, marginTop: 6 }} onClick={() => onOpen({ to: 'pane', pane: 'brief' })}>Read the brief</button>
          </div>
        )}
        {r.decisions.length > 0 && (
          <div>
            <div style={{ ...meta, fontWeight: 600, marginBottom: 6 }}>Decided without you</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {r.decisions.map((d, i) => {
                const t = targetOf(d.ref);
                return (
                  <li key={i} style={{ ...body, fontSize: 13, overflowWrap: 'anywhere' }}>
                    <span style={{ ...chip('var(--text-dim)'), marginRight: 8 }}>{DECIDED_WORD[d.kind] ?? 'Logged'}</span>
                    {t ? <button className="hm-link" style={{ ...reset, fontWeight: 500 }} onClick={() => onOpen(t)}>{d.title}</button> : d.title}
                    {d.detail && <span style={{ color: 'var(--text-dim)' }}>. {d.detail}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {r.people.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {r.people.map((p, i) => (
              <span key={i} style={{ fontSize: 12.5, padding: '3px 10px', borderRadius: 14, background: 'var(--panel-2)', border: '1px solid var(--border)', color: p.kind === 'hire' ? 'var(--text)' : 'var(--text-dim)' }}>{p.title}</span>
            ))}
          </div>
        )}
        {pf && (pf.digest.length > 0 || pf.doneByProject.length > 0) && (
          <div data-testid="portfolio-digest">
            <div style={{ ...meta, fontWeight: 600, marginBottom: 6 }}>On the roadmap</div>
            {pf.doneByProject.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center', ...meta }}>
                <span>Tasks done</span>
                {pf.doneByProject.map((d) => (
                  <button key={d.projectId} className="hm-plain" onClick={() => openProject(d.projectId)} title={d.title}
                    style={{ ...reset, display: 'inline-flex', gap: 6, alignItems: 'center', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12.5 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600 }}>{d.key ?? d.title.slice(0, 18)}</span>
                    <span style={{ ...num, fontWeight: 650, color: 'var(--green)' }}>{d.done}</span>
                  </button>
                ))}
              </div>
            )}
            {pf.digest.slice(0, 6).map((d, i) => (
              <div key={`${d.projectId}:${d.at}:${i}`} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, padding: '3px 0', minWidth: 0 }}>
                <button className="hm-link" style={{ ...reset, ...keyChip, cursor: 'pointer' }} onClick={() => openProject(d.projectId)} title={d.title}>{d.key ?? d.title.slice(0, 18)}</button>
                <span style={{ ...ellipsis, color: 'var(--text)' }}>{d.text}</span>
              </div>
            ))}
          </div>
        )}
        {nothing && (data.company
          ? <Empty>Quiet so far. The chief of staff's brief arrives at the company's brief hour.</Empty>
          : null)}
      </div>
    </Panel>
  );
}

// ---- the Overview's short "while you were away" ----

/** The Overview's recap: the window, the counts, the brief's first bullets and
 *  the top highlights; the whole story is on the Activity tab. */
function AwaySummary({ data, now, onOpen, onMore }: Pick<HomeBoardProps, 'data' | 'onOpen'> & { now: Date; onMore: () => void }) {
  const r = data.recap;
  const brief = r.brief ? briefSummary(r.brief.text) : null;
  const top = highlights(data.activity).slice(0, AWAY_HIGHLIGHTS);
  const facts: string[] = [`${r.tasksDone} ${r.tasksDone === 1 ? 'task' : 'tasks'} done`];
  if (data.company) facts.push(`${r.decisionsCount} decided without you`);
  facts.push(`${r.artifactsChanged} ${r.artifactsChanged === 1 ? 'file' : 'files'} changed`);
  return (
    <Panel id="away" title="While you were away" sub={sinceLabel(data.since, now, data.firstVisit)} flush
      action={<button className="hm-link" style={link} onClick={onMore}>Everything that happened</button>}>
      <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div data-testid="away-facts" style={{ ...meta, ...num, fontSize: 13 }}>{facts.join(', ')}.</div>
        {r.brief && brief && (
          <div data-testid="home-brief" style={{ borderLeft: '3px solid var(--accent)', paddingLeft: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 650 }}>{data.company?.chiefName ? `${data.company.chiefName}'s brief` : 'The latest brief'}</span>
              <span style={meta}>{when(r.brief.at, now)}</span>
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.5 }}><Markdown text={brief.md} compact /></div>
            <button className="hm-link" style={{ ...link, marginTop: 6 }} onClick={() => onOpen({ to: 'pane', pane: 'brief' })}>Read the brief</button>
          </div>
        )}
        {!r.brief && top.length === 0 && <Empty>{data.company ? "Quiet so far. The chief of staff's brief arrives at the company's brief hour." : 'Quiet so far.'}</Empty>}
      </div>
      {top.length > 0 && (
        <ol data-testid="away-highlights" style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border-soft)' }}>
          {top.map((h, i) => <HighlightRow key={h.id} h={h} now={now} first={i === 0} onOpen={onOpen} />)}
        </ol>
      )}
    </Panel>
  );
}

// ---- the tabs ----

const TAB_LABEL: Record<HomeTab, string> = { overview: 'Overview', progress: 'Progress', team: 'Team', activity: 'Activity' };

/** Home's tabs: a tablist with roving focus (arrows, Home, End). */
function Tabs({ tab, onTab, data }: { tab: HomeTab; onTab: (t: HomeTab) => void; data: HomeData }) {
  const refs = useRef<Partial<Record<HomeTab, HTMLButtonElement | null>>>({});
  const failing = data.team.filter((a) => a.state === 'error').length;
  const hint: Record<HomeTab, string> = {
    overview: 'What needs you, the key numbers and what happened',
    progress: data.company ? 'Roadmap, goals, spend and health, what is coming up' : 'Spend and health, what is coming up',
    team: 'Every agent and what it is doing, messages from your team',
    activity: "Since your last visit, the week's highlights, every event, recent files",
  };
  const count: Partial<Record<HomeTab, { n: number; tone: string; label: string }>> = {};
  if (data.headline.needsYou > 0) count.overview = { n: data.headline.needsYou, tone: 'strong', label: `${data.headline.needsYou} need you` };
  if (failing > 0) count.team = { n: failing, tone: 'warn', label: `${failing} failing` };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = HOME_TABS.indexOf(tab);
    const to = e.key === 'ArrowRight' ? HOME_TABS[(i + 1) % HOME_TABS.length]
      : e.key === 'ArrowLeft' ? HOME_TABS[(i - 1 + HOME_TABS.length) % HOME_TABS.length]
        : e.key === 'Home' ? HOME_TABS[0] : e.key === 'End' ? HOME_TABS[HOME_TABS.length - 1] : null;
    if (!to) return;
    e.preventDefault();
    onTab(to);
    refs.current[to]?.focus();
  };
  return (
    <div role="tablist" aria-label="Home" className="hm-tabs" data-testid="home-tabs">
      {HOME_TABS.map((t) => {
        const on = t === tab;
        const c = count[t];
        return (
          <button key={t} ref={(el) => { refs.current[t] = el; }} role="tab" id={`home-tab-${t}`} aria-selected={on} aria-controls="home-tabpanel" tabIndex={on ? 0 : -1}
            data-testid={`home-tab-${t}`} title={hint[t]} aria-label={c ? `${TAB_LABEL[t]}, ${c.label}` : TAB_LABEL[t]}
            className={`ibx-tab${on ? ' on' : ''}`} onClick={() => onTab(t)} onKeyDown={onKey}>
            {TAB_LABEL[t]}
            {c && <span className={`ibx-count ${c.tone}`}>{c.n}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---- 8. coming up ----

function ComingUp({ data, now, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'> & { now: Date }) {
  const groups: Array<{ day: string; rows: HomeData['upcoming'] }> = [];
  for (const u of dedupeUpcoming(data.upcoming)) {
    const day = dayHeading(u.at, now);
    const g = groups.at(-1);
    if (g && g.day === day) g.rows.push(u); else groups.push({ day, rows: [u] });
  }
  return (
    <Panel id="upcoming" title="Coming up">
      {groups.length === 0 ? <Empty>{data.company ? 'No meetings, rituals or deadlines this week.' : 'No scheduled loops in the next day.'}</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {groups.map((g) => (
            <div key={g.day}>
              <div style={{ ...meta, fontWeight: 650, color: 'var(--text)', marginBottom: 4 }}>{g.day}</div>
              {g.rows.map((u) => {
                const t = targetOf(u.ref);
                const detail = upcomingDetail(u);
                return (
                  <div key={u.id} style={{ display: 'grid', gridTemplateColumns: '58px minmax(0,1fr)', gap: 10, padding: '4px 0', fontSize: 13 }}>
                    <span style={{ ...meta, ...num, whiteSpace: 'nowrap', paddingTop: 1 }}>{new Date(u.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      {t ? <button className="hm-link" style={{ ...reset, fontWeight: 500 }} onClick={() => onOpen(t)}>{u.title}</button> : u.title}
                      {detail && <span style={{ ...meta, display: 'block', color: detail === 'overdue' ? 'var(--red)' : 'var(--text-dim)' }}>{detail}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---- 9. highlights and the full feed ----

function kindMark(a: HomeActivity): { icon: string[]; color: string } {
  if (a.kind === 'task') return /^Blocked:/.test(a.title) ? { icon: P.warn, color: 'var(--amber)' } : { icon: P.check, color: 'var(--green)' };
  if (a.kind === 'decision') return { icon: P.compass, color: 'var(--accent)' };
  if (a.kind === 'hire') return { icon: P.bot, color: 'var(--blue)' };
  if (a.kind === 'meeting') return { icon: P.chat, color: 'var(--blue)' };
  if (a.kind === 'incident') return /^Resolved:/.test(a.title) ? { icon: P.check, color: 'var(--green)' } : { icon: P.warn, color: 'var(--red)' };
  if (a.kind === 'file') return { icon: P.file, color: 'var(--text-dim)' };
  return { icon: P.bolt, color: 'var(--text-dim)' };
}

function Mark({ icon, color }: { icon: string[]; color: string }) {
  return <span aria-hidden style={{ width: 24, height: 24, borderRadius: 7, background: tint(color, 14), color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><I d={icon} size={13} /></span>;
}

function HighlightRow({ h, now, first, onOpen }: { h: HomeHighlight; now: Date; first: boolean; onOpen: HomeBoardProps['onOpen'] }) {
  const [open, setOpen] = useState(false);
  const row: CSSProperties = { display: 'grid', gridTemplateColumns: '24px minmax(0,1fr) auto', gap: 11, alignItems: 'start', padding: '9px 16px', borderTop: first ? 'none' : '1px solid var(--border-soft)' };
  if (h.type === 'files') {
    return (
      <li data-testid="highlight-files" style={row}>
        <Mark icon={P.files} color="var(--text-dim)" />
        <span style={{ minWidth: 0 }}>
          <button className="hm-link" onClick={() => setOpen(!open)} aria-expanded={open} style={{ ...reset, fontSize: 13.5, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {filesLine(h)}<I d={open ? P.chevD : P.chevR} size={13} style={{ color: 'var(--text-dim)' }} />
          </button>
          {open && (
            <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
              {h.items.map((f) => {
                const path = f.ref?.id ?? f.title.replace(/^(Edited|Created) /, '');
                const { name, dir } = splitPath(path);
                return (
                  <li key={f.id} style={{ padding: '2px 0' }}>
                    <button className="hm-link" onClick={() => onOpen({ to: 'file', path })} style={{ ...reset, ...meta, color: 'var(--text)' }}>{name}</button>
                    <span style={{ ...meta, marginLeft: 6 }}>{dir}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </span>
        <span style={{ ...meta, ...num, fontSize: 12, whiteSpace: 'nowrap' }}>{when(h.at, now)}</span>
      </li>
    );
  }
  const a = h.a;
  const t = targetOf(a.ref);
  const m = kindMark(a);
  return (
    <li style={row}>
      <Mark icon={m.icon} color={m.color} />
      <span style={{ minWidth: 0, fontSize: 13.5, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
        {t ? <button className="hm-link" style={{ ...reset, fontWeight: 500 }} onClick={() => onOpen(t)}>{a.title}</button> : <span style={{ fontWeight: 500 }}>{a.title}</span>}
        {(a.actor || a.detail) && <span style={{ ...meta, display: 'block', ...clamp(2) }}>{[a.actor, a.detail].filter(Boolean).join(': ')}</span>}
      </span>
      <span style={{ ...meta, ...num, fontSize: 12, whiteSpace: 'nowrap' }}>{when(a.at, now)}</span>
    </li>
  );
}

/** A day of routine loop runs on one line; the raw runs fold out under it. */
function RoutineRuns({ a, now }: { a: HomeActivity; now: Date }) {
  const [open, setOpen] = useState(false);
  const runs = a.runs!;
  return (
    <>
      <span style={{ color: 'var(--text-dim)' }}>{a.title}</span>
      <button className="hm-link" style={{ ...link, display: 'block', fontSize: 12, fontWeight: 500, marginTop: 1 }} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide the runs' : `Show the ${runs.count === 1 ? 'run' : `${runs.count} runs`}`}
      </button>
      {open && (
        <ol data-testid="routine-runs" style={{ listStyle: 'none', margin: '4px 0 0', padding: '0 0 0 10px', borderLeft: '2px solid var(--border)' }}>
          {runs.items.map((r) => (
            <li key={r.id} style={{ ...meta, padding: '2px 0', overflowWrap: 'anywhere' }}>{when(r.at, now)}{r.detail ? `: ${r.detail}` : ''}</li>
          ))}
          {runs.count > runs.items.length && <li style={{ ...meta, padding: '2px 0' }}>and {runs.count - runs.items.length} earlier</li>}
        </ol>
      )}
    </>
  );
}

function Activity({ data, now, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'> & { now: Date }) {
  const [mode, setMode] = useState<'highlights' | 'all'>('highlights');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [more, setMore] = useState(false);
  const hl = highlights(data.activity);
  const filters = activityFilters(data.activity);
  const rows = activityRows(data.activity, filter);
  const seg = (id: 'highlights' | 'all', label: string) => (
    <button key={id} aria-pressed={mode === id} onClick={() => setMode(id)}
      style={{ ...reset, height: 26, padding: '0 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: mode === id ? 'var(--panel)' : 'none', color: mode === id ? 'var(--text)' : 'var(--text-dim)', boxShadow: mode === id ? '0 0 0 1px var(--border)' : 'none' }}>{label}</button>
  );
  const shown = more ? hl : hl.slice(0, HIGHLIGHTS_SHOWN);
  return (
    <Panel id="activity" title="Highlights" flush
      action={<span role="group" aria-label="Activity view" style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 8, background: 'var(--panel-2)' }}>{seg('highlights', 'Highlights')}{seg('all', 'All activity')}</span>}>
      {mode === 'highlights' ? (
        hl.length === 0 ? <div style={{ padding: '0 16px 14px' }}><Empty>Nothing notable yet this week.</Empty></div> : (
          <>
            <ol data-testid="activity-highlights" style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border-soft)' }}>
              {shown.map((h, i) => <HighlightRow key={h.id} h={h} now={now} first={i === 0} onOpen={onOpen} />)}
            </ol>
            {hl.length > shown.length && (
              <div style={{ borderTop: '1px solid var(--border-soft)', padding: '10px 16px' }}>
                <button className="hm-link" style={link} onClick={() => setMore(true)}>{hl.length - shown.length} more highlights</button>
              </div>
            )}
          </>
        )
      ) : (
        <div style={{ padding: '0 16px 12px' }}>
          {filters.length > 2 && (
            <div role="group" aria-label="Filter activity" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {filters.map((f) => (
                <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                  style={{ ...reset, fontSize: 12, height: 26, padding: '0 10px', borderRadius: 13, border: '1px solid var(--border)', background: filter === f.id ? 'var(--text)' : 'var(--panel)', color: filter === f.id ? 'var(--bg)' : 'var(--text-dim)', fontWeight: 600 }}>
                  {f.label}
                </button>
              ))}
            </div>
          )}
          {rows.length === 0 ? <Empty>Nothing yet this week.</Empty> : (
            <ol data-testid="activity-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {rows.map((a) => {
                const t = targetOf(a.ref);
                return (
                  <li key={a.id} style={{ display: 'grid', gridTemplateColumns: '68px minmax(0,1fr)', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border-soft)' }}>
                    <span style={{ ...meta, ...num, fontSize: 12, paddingTop: 1 }}>{when(a.at, now)}</span>
                    <span style={{ minWidth: 0, fontSize: 13, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
                      {a.runs ? <RoutineRuns a={a} now={now} /> : (
                        <>
                          {t ? <button className="hm-link" style={{ ...reset, fontWeight: 500, fontSize: 13 }} onClick={() => onOpen(t)}>{a.title}</button> : a.title}
                          {(a.actor || a.detail) && <span style={{ display: 'block', ...meta }}>{[a.actor, a.detail].filter(Boolean).join(': ')}</span>}
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---- 10. spend & health ----

function SpendHealth({ data, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'>) {
  const s = data.spend;
  const h = data.health;
  const cap = s.monthCapUsd ?? 0;
  const projectedOver = cap > 0 && (s.projectedUsd ?? 0) > cap;
  const statusColor = h.status === 'ok' ? 'var(--green)' : h.status === 'incident' ? 'var(--red)' : 'var(--amber)';
  const incidents = incidentCounts(h.openIncidents);
  const line = (label: string, value: ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', fontSize: 13 }}>
      <span style={meta}>{label}</span><span style={{ ...num, fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  );
  return (
    <Panel id="spend" title="Spend and health" action={data.company ? <button className="hm-link" style={link} onClick={() => onOpen({ to: 'pane', pane: 'spend' })}>Spend</button> : undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {line('Today', usd(s.todayUsd))}
        {line('This month', <>{usd(s.monthUsd)}{cap > 0 && <span style={{ ...meta, fontWeight: 500 }}> of {usd(cap)} this month</span>}</>)}
        {cap > 0 && s.projectedUsd !== null && <div style={{ ...meta, color: projectedOver ? 'var(--amber)' : 'var(--text-dim)' }}>On pace for {usd(s.projectedUsd)} by month end{projectedOver ? ', over the envelope' : ''}.</div>}
        {s.tokens && <div style={{ ...meta, color: s.tokens.over ? 'var(--red)' : 'var(--text-dim)' }}>{Math.round(s.tokens.spent / 1000)}k of {Math.round(s.tokens.budget / 1000)}k tokens this month{s.tokens.over ? ': over budget, agents are stopped' : ''}.</div>}
        <div style={{ borderTop: '1px solid var(--border-soft)', marginTop: 4, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, boxShadow: `0 0 0 3px ${tint(statusColor, 18)}` }} />
            {h.status === 'ok' ? 'All systems normal' : incidents.open || incidents.contained ? incidentLine(incidents) : 'Degraded'}
          </div>
          {h.openIncidents.slice(0, 3).map((i) => (
            <button key={i.id} className="hm-link" style={{ ...reset, ...meta, color: 'var(--text)' }} onClick={() => onOpen({ to: 'pane', pane: 'incidents', focus: { kind: 'incident', id: i.id } })}>{i.severity}: {i.title}</button>
          ))}
          {h.providers.map((p) => <div key={p.provider} style={{ ...meta, color: 'var(--amber)', overflowWrap: 'anywhere' }}>{p.provider} is {p.state}{p.lastError ? `: ${p.lastError}` : ''}</div>)}
          {h.audit && (
            <div style={meta}>
              <button className="hm-link" style={{ ...reset, color: 'var(--text)', fontWeight: 500 }} onClick={() => onOpen({ to: 'pane', pane: 'audit' })}>Last audit {when(h.audit.at)}</button>: {h.audit.findings === 0 ? 'no findings' : `${h.audit.findings} finding${h.audit.findings === 1 ? '' : 's'}`}
              {h.audit.top.map((f, i) => <div key={i} style={{ overflowWrap: 'anywhere' }}>{f.severity ? `${f.severity}: ` : ''}{f.title}</div>)}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ---- 11. recent files ----

function Artifacts({ data, now, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'> & { now: Date }) {
  return (
    <Panel id="artifacts" title="Recent files" flush>
      {data.artifacts.length === 0 ? <div style={{ padding: '0 16px 14px' }}><Empty>Files your agents write show up here.</Empty></div> : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border-soft)' }}>
          {data.artifacts.map((f, i) => {
            const { name, dir } = splitPath(f.path);
            return (
              <li key={f.path} style={{ borderTop: i ? '1px solid var(--border-soft)' : 'none' }}>
                <button className="hm-row" onClick={() => onOpen({ to: 'file', path: f.path })} style={{ ...reset, width: '100%', display: 'flex', gap: 10, alignItems: 'center', padding: '8px 16px', minWidth: 0 }}>
                  <I d={P.file} size={15} stroke="var(--text-dim)" style={{ flex: 'none' }} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 500, ...ellipsis }}>{name}</span>
                    <span style={{ display: 'block', ...meta, fontSize: 12, ...ellipsis }}>
                      {f.updatedBy.name || f.updatedBy.kind} {f.version > 1 ? `edited v${f.version}` : 'created'} {when(f.updatedAt, now)}{dir ? ` in ${dir}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// ---- the board ----

export function HomeBoard(props: HomeBoardProps) {
  const { data, narrow, wide, name, onOpen, onAct, onAllAgents } = props;
  const now = props.now ?? new Date();
  const busy = props.busy ?? new Set<string>();
  const [ownTab, setOwnTab] = useState<HomeTab>('overview');
  const tab = props.tab ?? ownTab;
  const onTab = (t: HomeTab) => { setOwnTab(t); props.onTab?.(t); };
  const nothingYet = data.team.length === 0;
  const pad = narrow ? '20px 16px 40px' : '28px 32px 56px';
  const needs = <NeedsYou key="needs" data={data} now={now} narrow={narrow} busy={busy} onAct={onAct} onOpen={onOpen} mentionables={props.mentionables} />;
  const spend = <SpendHealth key="spend" data={data} onOpen={onOpen} />;
  const pair = (key: string, a: ReactNode, b: ReactNode) => <div key={key} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: GAP, alignItems: 'start' }}>{a}{b}</div>;
  const col = (children: ReactNode[], span?: string) => <div style={{ display: 'flex', flexDirection: 'column', gap: GAP, minWidth: 0, gridColumn: span }}>{children}</div>;
  /** Wide: a main column and a side column; narrower: one column in the order given. */
  const split = (main: ReactNode[], side: ReactNode[], at = 8, tablet?: ReactNode[]) => (wide
    ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: GAP, alignItems: 'start' }}>{col(main, `span ${at}`)}{col(side, `span ${12 - at}`)}</div>
    : col(!narrow && tablet ? tablet : [...main, ...side]));

  const page = (): ReactNode => {
    switch (tab) {
      case 'overview': {
        const messages = <TeamMessages key="messages" data={data} now={now} onOpen={onOpen} onMessage={props.onMessage} mentionables={props.mentionables} glance onMore={() => onTab('team')} />;
        const away = <AwaySummary key="away" data={data} now={now} onOpen={onOpen} onMore={() => onTab('activity')} />;
        return (
          <>
            <Banners data={data} narrow={narrow} onOpen={onOpen} />
            {!data.company && props.onStartCompany && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', borderRadius: RADIUS, border: '1px dashed var(--border)', ...meta, fontSize: 13 }}>
                <I d={P.building} size={15} style={{ color: 'var(--accent-hi)', flex: 'none' }} />
                <span style={{ flex: 1, minWidth: 200 }}>Your agents work one by one. A chief of staff can run them as a company, with goals and a budget.</span>
                <button className="hm-link" style={link} onClick={props.onStartCompany}>Start a company</button>
              </div>
            )}
            <KpiStrip data={data} narrow={narrow} wide={wide} now={now} onOpen={onOpen} onAgents={() => onTab('team')} />
            {split([needs, messages], [away], 7)}
          </>
        );
      }
      case 'progress': {
        const upcoming = <ComingUp key="upcoming" data={data} now={now} onOpen={onOpen} />;
        if (!data.company) return split([upcoming], [spend]);
        const roadmap = <Roadmap key="roadmap" data={data} now={now} narrow={narrow} onOpen={onOpen} />;
        const goals = <Goals key="goals" data={data} onOpen={onOpen} />;
        return split([roadmap, goals], [spend, upcoming], 8, [roadmap, pair('goals-spend', goals, spend), upcoming]);
      }
      case 'team': {
        const team = <Team key="team" data={data} now={now} onOpen={onOpen} onAllAgents={onAllAgents} />;
        const messages = <TeamMessages key="messages" data={data} now={now} onOpen={onOpen} onMessage={props.onMessage} mentionables={props.mentionables} />;
        return split([team], [messages]);
      }
      case 'activity': {
        const since = <SinceHere key="since" data={data} now={now} onOpen={onOpen} />;
        const activity = <Activity key="activity" data={data} now={now} onOpen={onOpen} />;
        const files = <Artifacts key="files" data={data} now={now} onOpen={onOpen} />;
        return split([since, activity], [files]);
      }
    }
  };

  return (
    <div data-testid="home-board" className="hm" style={{ maxWidth: 1360, margin: '0 auto', padding: pad, display: 'flex', flexDirection: 'column', gap: narrow ? 16 : GAP, minWidth: 0, color: 'var(--text)' }}>
      <style>{CSS}</style>
      <Header data={data} narrow={narrow} name={name} onOpen={onOpen} now={now} />
      {nothingYet ? (
        // An empty workspace: the start card leads; only what can already be true stays. No tabs.
        <>
          <Banners data={data} narrow={narrow} onOpen={onOpen} />
          <div data-testid="home-start" style={{ border: '1px solid var(--border)', background: 'var(--panel)', borderRadius: RADIUS, padding: narrow ? '20px 16px' : '26px 28px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span aria-hidden style={{ width: 38, height: 38, borderRadius: 10, background: tint('var(--accent)', 16), color: 'var(--accent-hi)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><I d={P.building} size={19} /></span>
            <div style={{ fontSize: 17, fontWeight: 650 }}>Start a company with a Chief of Staff</div>
            <div style={{ ...meta, fontSize: 13.5, maxWidth: 560 }}>Give it a vision and a monthly budget. The chief of staff proposes goals, hires specialists and brings you only the decisions that need you.</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              {props.onStartCompany && <button className="hm-btn" style={btn('primary', 'md')} onClick={props.onStartCompany}>Start a company</button>}
              {props.onNewAgent && <button className="hm-plain" style={btn('plain', 'md')} onClick={props.onNewAgent}>Create one agent</button>}
            </div>
          </div>
          {col([needs, spend])}
        </>
      ) : (
        <>
          <Tabs tab={tab} onTab={onTab} data={data} />
          <div role="tabpanel" id="home-tabpanel" aria-labelledby={`home-tab-${tab}`} data-testid={`home-panel-${tab}`}
            style={{ display: 'flex', flexDirection: 'column', gap: narrow ? 16 : GAP, minWidth: 0 }}>
            {page()}
          </div>
        </>
      )}
    </div>
  );
}

/** While the first request is in flight (a skeleton of the page), or after it failed. */
export function HomeStatus({ error, onRetry, narrow }: { error: string | null; onRetry?: () => void; narrow: boolean }) {
  const panel = (h: number, rows = 3) => (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: RADIUS, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: h }}>
      <div className="hm-skel" style={{ height: 12, width: 110 }} />
      {Array.from({ length: rows }, (_, i) => <div key={i} className="hm-skel" style={{ height: 14, width: `${88 - i * 14}%` }} />)}
    </div>
  );
  return (
    <div data-testid="home-status" className="hm" style={{ maxWidth: 1360, margin: '0 auto', padding: narrow ? '20px 16px' : '28px 32px', width: '100%' }}>
      <style>{CSS}</style>
      {error ? (
        <div role="alert" style={{ border: '1px solid var(--border)', background: 'var(--panel)', borderRadius: RADIUS, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start', maxWidth: 640 }}>
          <div style={{ fontSize: 15, fontWeight: 650 }}>Home didn't load</div>
          <div style={{ ...meta, fontSize: 13, overflowWrap: 'anywhere' }}>{error}</div>
          {onRetry && <button className="hm-plain" style={btn('plain', 'md')} onClick={onRetry}><I d={P.retry} size={14} />Try again</button>}
        </div>
      ) : (
        <div aria-busy aria-label="Loading Home" style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="hm-skel" style={{ height: 12, width: 130 }} />
            <div className="hm-skel" style={{ height: 26, width: 'min(320px, 70%)' }} />
            <div className="hm-skel" style={{ height: 13, width: 'min(520px, 90%)' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${narrow ? 2 : 5}, minmax(0,1fr))`, gap: 1, background: 'var(--border)', border: '1px solid var(--border)', borderRadius: RADIUS, overflow: 'hidden' }}>
            {Array.from({ length: narrow ? 4 : 5 }, (_, i) => (
              <div key={i} style={{ background: 'var(--panel)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="hm-skel" style={{ height: 11, width: '55%' }} />
                <div className="hm-skel" style={{ height: 24, width: '40%' }} />
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(0,2fr) minmax(0,1fr)', gap: GAP }}>
            {panel(220, 4)}
            {!narrow && panel(220, 4)}
          </div>
        </div>
      )}
    </div>
  );
}
