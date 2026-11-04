/**
 * The top bar (docs/home.md "Top bar"): 48 px across the top of the app,
 * beside the main menu. Left, the workspace switcher; centre, one status
 * strand for a company — run state with Pause / Resume, spend against the
 * envelope, agents working and failing, the turns running now, the next
 * meeting; right, search (the command palette, ⌘K / Ctrl+K), quick create,
 * the notifications bell and the account menu. Without a company the strand
 * keeps only the live runs. On a phone it folds to the switcher, search, the
 * bell and an overflow menu.
 *
 * `TopBar` holds the data (one status request kept live by the workspace
 * stream and a light poll; the bell reads the owner's feed, shared with the
 * Inbox and the main menu's badge — src/lib/feed-store.ts) and the
 * navigation; `TopBarView` is presentational (web-tests/topbar.test.tsx).
 * The bell's count is unread rows of the feed; its popover shows the same
 * rows as the Inbox, with their actions, and opens the Inbox.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { I, P } from '../lib/icons';
import { useApp, grad, type WorkspaceEntry, type Section } from '../store';
import { useAuth } from '../auth';
import { api, type FeedAction, type FeedItem, type FeedPage, type FeedSection, type WorkspaceGlanceRow, type WorkspaceStatus } from '../lib/api';
import {
  elapsed, isMac, isPaletteShortcut, meetingWhen, originLabel, SHORTCUTS, spendMeter, spendTone, usd, type PaletteItem,
} from '../lib/topbar';
import { bellGroups, needsYouLabel, unreadLabel } from '../lib/feed';
import { markFeedRead, reloadFeed, useFeed } from '../lib/feed-store';
import { FeedRow, useFeedAction, useOpenFeedItem } from './FeedRow';
import { isTaskKey, normalizeTaskKey } from '../lib/task-keys';
import { CommandPalette } from './CommandPalette';
import { NewWorkspaceWizard } from './NewWorkspaceWizard';
import { SETTINGS_PANES } from './Rails';

export const TOP_BAR_HEIGHT = 48;
const POLL_MS = 30_000;
const DEBOUNCE_MS = 1_200;

type Menu = 'switcher' | 'run' | 'live' | 'create' | 'bell' | 'account' | 'more' | null;
export type CreateKind = 'chat' | 'task' | 'meeting' | 'agent' | 'workspace';

/** A scoped stylesheet: hover and focus rings inline styles cannot say. */
const CSS = `
.tb button { font: inherit; color: inherit; }
.tb-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 9px; border: none; border-radius: 8px; background: none; color: var(--text-dim); cursor: pointer; white-space: nowrap; }
.tb-btn:hover, .tb-btn[aria-expanded="true"] { background: var(--hover); color: var(--text); }
.tb-btn:focus-visible, .tb-row:focus-visible, .tb-chip:focus-visible, .tb-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tb-icon { width: 32px; padding: 0; justify-content: center; position: relative; }
.tb-row { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 8px 10px; border: none; border-radius: 8px; background: none; text-align: left; cursor: pointer; color: var(--text); }
.tb-row:hover { background: var(--hover); }
.tb-chip { border: 1px solid var(--border); background: none; border-radius: 999px; padding: 3px 10px; font-size: 12px; color: var(--text-dim); cursor: pointer; }
.tb-chip[aria-pressed="true"] { background: var(--accent-dim); border-color: transparent; color: var(--text); }
.tb-link { border: none; background: none; padding: 0; color: var(--accent-hi); font-size: 12.5px; font-weight: 600; cursor: pointer; }
.tb-kbd { font: 500 11px 'IBM Plex Sans', system-ui, sans-serif; color: var(--text-dim); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 5px; padding: 0 5px; line-height: 16px; }
.tb-sep { width: 1px; height: 18px; background: var(--border); flex: none; }
.tb-num { font-variant-numeric: tabular-nums; }
@keyframes tbBreathe { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--green) 55%, transparent); } 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--green) 0%, transparent); } }
.tb-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); animation: tbBreathe 2.4s ease-in-out infinite; flex: none; }
@media (prefers-reduced-motion: reduce) { .tb-live-dot { animation: none; } .tb [style*="animation"] { animation: none !important; } }
`;

// ---- the presentational bar ----

export interface TopBarViewProps {
  now: Date;
  /** Phone width: the compact bar. `width` picks how much of the strand fits. */
  phone: boolean;
  width: number;
  theme: string;
  workspace: WorkspaceEntry;
  workspaces: WorkspaceEntry[];
  /** The switcher's rows by workspace id; null until the switcher first opens. */
  rows: Record<string, WorkspaceGlanceRow> | null;
  status: WorkspaceStatus | null;
  /** A turn started or ended since the status loaded: the live count to show. */
  liveCount?: number | null;
  /** The owner's feed: the bell's rows and counts (the Inbox reads the same page). */
  notifications: FeedPage | null;
  /** The owner may pause and resume the company. */
  canPause: boolean;
  orgOn: boolean;
  account: { name: string; email: string } | null;
  canSignOut: boolean;
  onOpenSwitcher: () => void;
  onPickWorkspace: (id: string) => void;
  onPause: () => Promise<void> | void;
  onResume: () => Promise<void> | void;
  onSpend: () => void;
  onAgents: () => void;
  onFailing: () => void;
  onRun: (sessionId: string) => void;
  onMeeting: () => void;
  onOpenNotification: (n: FeedItem) => void;
  onMarkRead: (items: FeedItem[]) => void;
  onMarkAllRead: () => void;
  /** An inline action on a row (approve, reject, allow, deny…); absent = the rows only open. */
  onNotificationAction?: (n: FeedItem, a: FeedAction) => void;
  /** Rows whose action is running. */
  busy?: Set<string>;
  onInbox: () => void;
  onSearch: () => void;
  onCreate: (kind: CreateKind, title?: string) => void;
  onToggleTheme: () => void;
  onSettings: (pane: string) => void;
  onSignOut: () => void;
}

function Popover({ open, onClose, align = 'left', width, children, label }: { open: boolean; onClose: () => void; align?: 'left' | 'right' | 'center'; width: number | string; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { const el = ref.current; if (el && !el.parentElement?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, onClose]);
  if (!open) return null;
  const pos: React.CSSProperties = align === 'right' ? { right: 0 } : align === 'center' ? { left: '50%', transform: 'translateX(-50%)' } : { left: 0 };
  return (
    <div ref={ref} role="dialog" aria-label={label}
      style={{ position: 'absolute', top: 'calc(100% + 6px)', ...pos, width, maxWidth: 'calc(100vw - 16px)', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow)', zIndex: 130, padding: 6, animation: 'msgIn .12s', color: 'var(--text)', fontSize: 13 }}>
      {children}
    </div>
  );
}

const Swatch = ({ color, dashed = false, size = 10 }: { color: string; dashed?: boolean; size?: number }) => (
  <span aria-hidden style={{ width: size, height: size, borderRadius: 3, background: color, flex: 'none', outline: dashed ? '1px dashed var(--text-faint)' : 'none', outlineOffset: 1 }} />
);

const Count = ({ n, tone = 'amber', testId }: { n: number; tone?: 'amber' | 'red' | 'accent'; testId?: string }) => (
  <span data-testid={testId} className="tb-num" style={{ minWidth: 16, height: 16, borderRadius: 8, padding: '0 4px', background: `var(--${tone})`, color: '#fff', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>{n > 99 ? '99+' : n}</span>
);

const modeLabel = (m: 'supervised' | 'autonomous') => (m === 'autonomous' ? 'Autonomous' : 'Supervised');

/** One line under a switcher row: the company's state and what waits. */
function rowLine(w: WorkspaceEntry, r: WorkspaceGlanceRow | undefined): { text: string; tone: string } {
  if (w.shared) return { text: `${w.shared.ownerName}'s · ${w.shared.role}`, tone: 'var(--text-dim)' };
  if (!r) return { text: '', tone: 'var(--text-dim)' };
  if (!r.company) return { text: r.needsYou ? `${r.needsYou} need${r.needsYou === 1 ? 's' : ''} you` : 'No company', tone: 'var(--text-dim)' };
  const state = r.company.status === 'paused' ? 'Paused' : 'Running';
  return { text: `${state} · ${modeLabel(r.company.mode)}${r.needsYou ? ` · ${r.needsYou} need${r.needsYou === 1 ? 's' : ''} you` : ''}`, tone: r.company.status === 'paused' ? 'var(--red)' : 'var(--text-dim)' };
}

function Switcher(p: TopBarViewProps & { open: boolean; setOpen: (m: Menu) => void }) {
  const ws = p.workspace;
  const company = p.status?.company ?? null;
  const own = p.workspaces.filter((w) => !w.shared);
  const shared = p.workspaces.filter((w) => w.shared);
  const row = (w: WorkspaceEntry) => {
    const r = p.rows?.[w.id];
    const line = rowLine(w, r);
    const current = w.id === ws.id;
    return (
      <button key={w.id} type="button" className="tb-row" role="menuitemradio" aria-checked={current} onClick={() => { p.setOpen(null); if (!current) p.onPickWorkspace(w.id); }}
        style={{ alignItems: 'center', background: current ? 'var(--panel-2)' : undefined }}>
        <Swatch color={w.color} dashed={Boolean(w.shared)} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
          {line.text && <span style={{ display: 'block', fontSize: 11.5, color: line.tone, marginTop: 1 }}>{line.text}</span>}
        </span>
        {r && r.unread > 0 && !current && <Count n={r.unread} tone="accent" />}
        {current && <I d={P.check} size={14} stroke="var(--accent)" sw={2.5} />}
      </button>
    );
  };
  return (
    <div style={{ position: 'relative', minWidth: 0, flex: p.phone ? '1 1 auto' : 'none' }}>
      <button type="button" className="tb-btn" aria-haspopup="menu" aria-expanded={p.open} aria-label={`Workspace: ${ws.name}. Switch workspace`}
        onClick={() => { if (!p.open) p.onOpenSwitcher(); p.setOpen(p.open ? null : 'switcher'); }}
        style={{ color: 'var(--text)', gap: 8, maxWidth: p.phone ? '100%' : 300, paddingLeft: 8 }}>
        <Swatch color={ws.color} dashed={Boolean(ws.shared)} size={12} />
        <span style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{ws.name}</span>
        {company && !p.phone && (
          <span data-testid="mode-chip" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 999, padding: '1px 7px' }}>{modeLabel(company.mode)}</span>
        )}
        <I d={P.chevD} size={13} stroke="var(--text-faint)" style={{ flex: 'none' }} />
      </button>
      <Popover open={p.open} onClose={() => p.setOpen(null)} width={320} label="Workspaces">
        <div role="menu" aria-label="Workspaces">
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)', padding: '6px 10px 4px' }}>Your workspaces</div>
          {own.map(row)}
          {shared.length > 0 && <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)', padding: '10px 10px 4px', borderTop: '1px solid var(--border-soft)', marginTop: 4 }}>Shared with you</div>}
          {shared.map(row)}
          <div style={{ borderTop: '1px solid var(--border-soft)', marginTop: 4, paddingTop: 4 }}>
            <button type="button" className="tb-row" role="menuitem" onClick={() => { p.setOpen(null); p.onCreate('workspace'); }} style={{ alignItems: 'center', color: 'var(--text-dim)' }}>
              <I d={P.plus} size={14} />New workspace or company
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}

/** Running / Paused, with the owner's one-click (and confirmed) kill switch. */
function RunState(p: TopBarViewProps & { open: boolean; setOpen: (m: Menu) => void; inMenu?: boolean }) {
  const c = p.status?.company;
  const [busy, setBusy] = useState(false);
  if (!c) return null;
  const paused = c.status === 'paused';
  const act = async () => { setBusy(true); try { await (paused ? p.onResume() : p.onPause()); p.setOpen(null); } finally { setBusy(false); } };
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="tb-btn" aria-haspopup="dialog" aria-expanded={p.open} disabled={!p.canPause}
        title={p.canPause ? (paused ? 'Resume the company' : 'Pause the company') : `The company is ${paused ? 'paused' : 'running'}. Only the owner can pause or resume it.`}
        aria-label={p.canPause ? `${paused ? 'Paused' : 'Running'}: ${paused ? 'resume' : 'pause'} the company` : `${paused ? 'Paused' : 'Running'}. Only the owner can pause or resume the company`}
        onClick={() => p.setOpen(p.open ? null : 'run')} style={{ color: paused ? 'var(--red)' : 'var(--text)', cursor: p.canPause ? 'pointer' : 'default', fontWeight: 600, fontSize: 12.5 }}>
        {paused
          ? <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--red)' }} />
          : <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)' }} />}
        {paused ? 'Paused' : 'Running'}
        {p.canPause && <I d={paused ? P.play : P.pause} size={12} sw={2.4} stroke="var(--text-faint)" />}
      </button>
      <Popover open={p.open && p.canPause} onClose={() => p.setOpen(null)} width={290} label={paused ? 'Resume the company' : 'Pause the company'} align={p.inMenu ? 'right' : 'left'}>
        <div style={{ padding: '8px 10px 10px' }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{paused ? `Resume ${c.name}?` : `Pause ${c.name}?`}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 12 }}>
            {paused ? 'Agents pick their work back up: heartbeats, task runs and meetings start again.' : 'Every agent stops after its current step. Heartbeats, task runs and meetings wait until you resume.'}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="tb-btn" onClick={() => p.setOpen(null)} style={{ border: '1px solid var(--border)' }}>Cancel</button>
            <button type="button" className="tb-btn" disabled={busy} onClick={() => void act()}
              style={{ background: paused ? 'var(--accent)' : 'var(--red)', color: '#fff', fontWeight: 600 }}>{paused ? 'Resume company' : 'Pause company'}</button>
          </div>
        </div>
      </Popover>
    </div>
  );
}

function SpendMeter({ status, compact, onClick }: { status: WorkspaceStatus; compact: boolean; onClick: () => void }) {
  const s = status.spend;
  if (!s) return null;
  const tone = spendTone(s);
  const color = tone === 'over' ? 'var(--red)' : tone === 'warn' ? 'var(--amber)' : 'var(--accent)';
  const meter = spendMeter(s);
  const title = `${usd(s.todayUsd)} today · ${usd(s.monthUsd)}${s.monthCapUsd ? ` of ${usd(s.monthCapUsd)}` : ''} this month${s.projectedUsd != null ? ` · month-end forecast ${usd(s.projectedUsd)}` : ''}`;
  return (
    <button type="button" className="tb-btn" onClick={onClick} title={title} aria-label={`Spend: ${title}`} data-tone={tone} data-testid="spend">
      <span className="tb-num" style={{ fontSize: 12.5, color: tone === 'over' ? 'var(--red)' : 'var(--text)', fontWeight: 600 }}>{usd(s.todayUsd)}</span>
      {!compact && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>today</span>}
      {meter && (
        <span aria-hidden style={{ position: 'relative', width: 52, height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'visible' }}>
          <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${meter.forecast * 100}%`, borderRadius: 2, background: color, opacity: 0.3 }} />
          <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${meter.spent * 100}%`, borderRadius: 2, background: color }} />
        </span>
      )}
    </button>
  );
}

function Faces({ status }: { status: WorkspaceStatus }) {
  const faces = status.agents.faces.slice(0, 4);
  if (!faces.length) return null;
  return (
    <span aria-hidden style={{ display: 'inline-flex' }}>
      {faces.map((f, i) => (
        <span key={f.id} title={f.name} style={{ width: 20, height: 20, borderRadius: '50%', background: grad(f.colors), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, marginLeft: i ? -6 : 0, boxShadow: `0 0 0 2px var(--panel)${f.state === 'error' ? ', 0 0 0 3.5px var(--red)' : ''}`, position: 'relative', zIndex: 5 - i }}>{f.emoji}</span>
      ))}
    </span>
  );
}

function LiveRuns(p: TopBarViewProps & { open: boolean; setOpen: (m: Menu) => void; align?: 'left' | 'right' | 'center' }) {
  const runs = p.status?.live ?? [];
  const n = p.liveCount ?? runs.length;
  if (n <= 0) return null;
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="tb-btn" aria-haspopup="dialog" aria-expanded={p.open} aria-label={`${n} running now`} data-testid="live-runs" onClick={() => p.setOpen(p.open ? null : 'live')}>
        <span className="tb-live-dot" aria-hidden />
        <span className="tb-num" style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 600 }}>{n}</span>
        {!p.phone && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>running</span>}
      </button>
      <Popover open={p.open} onClose={() => p.setOpen(null)} width={340} label="Running now" align={p.align ?? 'center'}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)', padding: '6px 10px 4px' }}>Running now</div>
        {runs.length === 0 && <div style={{ padding: '6px 10px 10px', fontSize: 12.5, color: 'var(--text-dim)' }}>Loading the runs…</div>}
        {runs.map((r) => (
          <button key={r.sessionId} type="button" className="tb-row" onClick={() => { p.setOpen(null); p.onRun(r.sessionId); }}>
            <span className="tb-live-dot" aria-hidden style={{ marginTop: 6 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.agentName} <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>· {r.sessionName || originLabel(r.origin)}</span></span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{r.toolLabel ? `${r.toolLabel[0].toUpperCase()}${r.toolLabel.slice(1)}` : 'Thinking'} · {elapsed(r.startedAt, p.now)}</span>
            </span>
          </button>
        ))}
      </Popover>
    </div>
  );
}

/** The company at a glance. */
function Strand(p: TopBarViewProps & { menu: Menu; setOpen: (m: Menu) => void }) {
  const st = p.status;
  if (!st) return null;
  const full = p.width >= 1360;
  const mid = p.width >= 1080;
  const parts: ReactNode[] = [];
  if (st.company) {
    parts.push(<RunState key="run" {...p} open={p.menu === 'run'} />);
    if (st.spend && mid) parts.push(<SpendMeter key="spend" status={st} compact={!full} onClick={p.onSpend} />);
    if (st.agents.total > 0 && mid) {
      parts.push(
        <span key="agents" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <button type="button" className="tb-btn" onClick={p.onAgents} aria-label={`${st.agents.working} of ${st.agents.total} agents working`}>
            <Faces status={st} />
            <span className="tb-num" style={{ fontSize: 12.5, color: 'var(--text)' }}>{st.agents.working}</span>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>working</span>
          </button>
          {st.agents.failing > 0 && (
            <button type="button" className="tb-btn" onClick={p.onFailing} data-testid="failing" aria-label={`${st.agents.failing} failing: open mission control`} style={{ color: 'var(--red)', fontWeight: 600, fontSize: 12.5, paddingLeft: 2 }}>
              {st.agents.failing} failing
            </button>
          )}
        </span>,
      );
    }
  }
  const live = <LiveRuns key="live" {...p} open={p.menu === 'live'} />;
  if ((p.liveCount ?? st.live.length) > 0) parts.push(live);
  if (st.company && st.nextMeeting && full) {
    parts.push(
      <button key="meeting" type="button" className="tb-btn" onClick={p.onMeeting} data-testid="next-meeting" title={`${st.nextMeeting.title}, ${new Date(st.nextMeeting.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`}>
        <I d={P.clock} size={14} stroke="var(--text-faint)" />
        <span style={{ fontSize: 12.5, color: 'var(--text)', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' }}>{st.nextMeeting.title}</span>
        <span className="tb-num" style={{ fontSize: 12, color: 'var(--text-dim)' }}>{meetingWhen(st.nextMeeting.at, p.now)}</span>
      </button>,
    );
  }
  if (!parts.length) return null;
  return (
    <div role="group" aria-label="Status" data-testid="strand" style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
      {parts.map((x, i) => <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>{i > 0 && <span className="tb-sep" aria-hidden />}{x}</span>)}
    </div>
  );
}

/** The bell's filters: everything, or one section of the feed. */
type BellFilter = 'all' | FeedSection;
const BELL_FILTERS: Array<{ id: BellFilter; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'needs', label: 'Needs you' }, { id: 'mentions', label: 'Mentions' }, { id: 'updates', label: 'Updates' },
];
/** Rows the popover shows; the Inbox has the rest. */
const BELL_ROWS = 40;

export function NotificationsPanel({ page, now, orgOn, onOpen, onMarkRead, onMarkAllRead, onInbox, onAction, busy }: {
  page: FeedPage | null; now: Date; orgOn: boolean;
  onOpen: (n: FeedItem) => void; onMarkRead: (items: FeedItem[]) => void; onMarkAllRead: () => void; onInbox: () => void;
  onAction?: (n: FeedItem, a: FeedAction) => void; busy?: Set<string>;
}) {
  const [filter, setFilter] = useState<BellFilter>('all');
  const all = page ? (filter === 'all' ? page.items : page.items.filter((i) => i.section === filter)) : [];
  const shown = all.slice(0, BELL_ROWS);
  const groups = bellGroups(shown, now);
  const c = page?.counts;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px 2px' }}>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>Notifications</span>
        {page && page.unread > 0 && <button type="button" className="tb-link" onClick={onMarkAllRead}>Mark all read</button>}
      </div>
      {c && (
        <div data-testid="bell-summary" style={{ padding: '0 10px 8px', fontSize: 11.5, color: 'var(--text-dim)' }}>
          <span title="Unread rows in every section: the bell's count">{unreadLabel(c.unread)}</span>
          {orgOn && <> · <span title="Open items that wait on you: the Inbox's badge" style={{ color: c.needsYou ? 'var(--amber)' : undefined }}>{needsYouLabel(c.needsYou)}</span></>}
        </div>
      )}
      <div role="group" aria-label="Show" style={{ display: 'flex', gap: 6, padding: '0 10px 8px', flexWrap: 'wrap' }}>
        {BELL_FILTERS.map((f) => {
          const n = !c ? 0 : f.id === 'all' ? 0 : f.id === 'needs' ? c.needsYou : c.sections[f.id].unread;
          return <button key={f.id} type="button" className="tb-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}{n ? ` · ${n}` : ''}</button>;
        })}
      </div>
      <div role="list" style={{ maxHeight: 'min(62vh, 540px)', overflowY: 'auto', borderTop: '1px solid var(--border-soft)', paddingTop: 4 }}>
        {!page && <div style={{ padding: '14px 10px', fontSize: 12.5, color: 'var(--text-dim)' }}>Loading…</div>}
        {page && groups.length === 0 && (
          <div style={{ padding: '18px 10px', fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {filter === 'all' ? 'You are all caught up. What needs you, messages and mentions, and news on what you follow land here.' : 'Nothing here right now.'}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.id} aria-label={g.label}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)', padding: '8px 10px 2px' }}>{g.label}</div>
            {g.items.map((n) => (
              <div key={n.id} data-testid={`note-${n.id}`}>
                <FeedRow item={n} now={now} compact onOpen={onOpen} onMarkRead={(x) => onMarkRead([x])}
                  onAction={onAction && n.actions.length <= 2 ? onAction : undefined} busy={busy?.has(n.id)} />
              </div>
            ))}
          </section>
        ))}
        {page && all.length > shown.length && <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-dim)' }}>{all.length - shown.length} more in the {orgOn ? 'Inbox' : 'list'}.</div>}
      </div>
      <div style={{ borderTop: '1px solid var(--border-soft)', padding: '8px 10px 4px', display: 'flex' }}>
        <button type="button" className="tb-link" onClick={onInbox}>{orgOn ? 'Open Inbox' : 'Open Home'}</button>
      </div>
    </div>
  );
}

function Bell(p: TopBarViewProps & { open: boolean; setOpen: (m: Menu) => void }) {
  const unread = p.notifications?.unread ?? 0;
  const urgent = (p.notifications?.items ?? []).some((n) => !n.read && (n.severity === 'critical' || n.expiresSoon));
  return (
    <div style={{ position: p.phone ? 'static' : 'relative' }}>
      <button type="button" className="tb-btn tb-icon" aria-haspopup="dialog" aria-expanded={p.open} aria-label={unread ? `Notifications, ${unreadLabel(unread)}` : 'Notifications'} title={unread ? unreadLabel(unread) : 'Notifications'} onClick={() => p.setOpen(p.open ? null : 'bell')}>
        <I d={P.bell} size={17} sw={1.9} />
        {unread > 0 && <span style={{ position: 'absolute', top: 2, right: 1 }}><Count n={unread} tone={urgent ? 'red' : 'amber'} testId="bell-count" /></span>}
      </button>
      <Popover open={p.open} onClose={() => p.setOpen(null)} width={p.phone ? 'calc(100vw - 16px)' : 400} label="Notifications" align="right">
        <NotificationsPanel page={p.notifications} now={p.now} orgOn={p.orgOn} busy={p.busy}
          onOpen={(n) => { p.setOpen(null); p.onOpenNotification(n); }} onMarkRead={p.onMarkRead} onMarkAllRead={p.onMarkAllRead} onInbox={() => { p.setOpen(null); p.onInbox(); }}
          onAction={p.onNotificationAction} />
      </Popover>
    </div>
  );
}

function CreateMenu(p: TopBarViewProps & { open: boolean; setOpen: (m: Menu) => void; inline?: boolean }) {
  const company = Boolean(p.status?.company);
  const [taskTitle, setTaskTitle] = useState<string | null>(null);
  const close = () => { setTaskTitle(null); p.setOpen(null); };
  const items: Array<{ kind: CreateKind; label: string; hint: string }> = [
    { kind: 'chat', label: 'New chat', hint: 'with an agent' },
    ...(company ? [{ kind: 'task' as const, label: 'New task', hint: 'on the company board' }, { kind: 'meeting' as const, label: 'Start a meeting', hint: 'with a unit' }] : []),
    { kind: 'agent', label: 'New agent', hint: 'hire or build one' },
    { kind: 'workspace', label: 'New workspace or company', hint: '' },
  ];
  const body = taskTitle !== null ? (
    <form onSubmit={(e) => { e.preventDefault(); const t = taskTitle.trim(); if (!t) return; close(); p.onCreate('task', t); }} style={{ padding: '6px 8px 8px', display: 'grid', gap: 8 }}>
      <label style={{ fontSize: 12.5, fontWeight: 600 }} htmlFor="tb-task-title">New task</label>
      <input id="tb-task-title" autoFocus value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="What needs doing?"
        style={{ height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel-2)', color: 'var(--text)', padding: '0 10px', fontSize: 13, outline: 'none' }} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="tb-btn" onClick={() => setTaskTitle(null)} style={{ border: '1px solid var(--border)' }}>Back</button>
        <button type="submit" className="tb-btn" disabled={!taskTitle.trim()} style={{ background: 'var(--accent)', color: '#fff', fontWeight: 600 }}>Create task</button>
      </div>
    </form>
  ) : (
    <div role="menu" aria-label="Create">
      {items.map((it) => (
        <button key={it.kind} type="button" className="tb-row" role="menuitem" style={{ alignItems: 'center' }}
          onClick={() => { if (it.kind === 'task') { setTaskTitle(''); return; } close(); p.onCreate(it.kind); }}>
          <span style={{ flex: 1, fontSize: 13 }}>{it.label}</span>
          {it.hint && <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{it.hint}</span>}
        </button>
      ))}
    </div>
  );
  if (p.inline) return body;
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="tb-btn tb-icon" aria-haspopup="menu" aria-expanded={p.open} aria-label="Create" title="Create" onClick={() => (p.open ? close() : p.setOpen('create'))}>
        <I d={P.plus} size={17} sw={2} />
      </button>
      <Popover open={p.open} onClose={close} width={280} label="Create" align="right">{body}</Popover>
    </div>
  );
}

function AccountMenu(p: TopBarViewProps & { open: boolean; setOpen: (m: Menu) => void }) {
  const [keys, setKeys] = useState(false);
  const name = p.account?.name || p.account?.email?.split('@')[0] || 'You';
  const initial = name.trim()[0]?.toUpperCase() ?? 'Y';
  const mod = isMac() ? '⌘' : 'Ctrl+';
  const close = () => { setKeys(false); p.setOpen(null); };
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="tb-btn tb-icon" aria-haspopup="menu" aria-expanded={p.open} aria-label="Account and preferences" onClick={() => (p.open ? close() : p.setOpen('account'))}>
        <span aria-hidden style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--accent-dim)', color: 'var(--text)', fontSize: 11.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{initial}</span>
      </button>
      <Popover open={p.open} onClose={close} width={260} label="Account" align="right">
        <div role="menu" aria-label="Account">
          <div style={{ padding: '8px 10px 10px', borderBottom: '1px solid var(--border-soft)', marginBottom: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{name}</div>
            {p.account?.email && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.account.email}</div>}
          </div>
          <button type="button" className="tb-row" role="menuitem" onClick={() => { p.onToggleTheme(); }} style={{ alignItems: 'center' }}>
            <I d={p.theme === 'dark' ? P.sun : P.moon} size={15} /><span style={{ flex: 1 }}>{p.theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
          </button>
          <button type="button" className="tb-row" role="menuitem" onClick={() => { close(); p.onSettings('account'); }} style={{ alignItems: 'center' }}>
            <I d={P.user} size={15} /><span style={{ flex: 1 }}>Account</span>
          </button>
          <button type="button" className="tb-row" role="menuitem" onClick={() => { close(); p.onSettings('providers'); }} style={{ alignItems: 'center' }}>
            <I d={P.gear} size={15} /><span style={{ flex: 1 }}>Settings</span>
          </button>
          <button type="button" className="tb-row" role="menuitem" aria-expanded={keys} onClick={() => setKeys(!keys)} style={{ alignItems: 'center' }}>
            <I d={P.help} size={15} /><span style={{ flex: 1 }}>Keyboard shortcuts</span>
          </button>
          {keys && (
            <div style={{ padding: '2px 10px 8px 35px', display: 'grid', gap: 6 }}>
              {SHORTCUTS.map((s) => (
                <div key={s.keys} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
                  <kbd className="tb-kbd" style={{ flex: 'none' }}>{s.keys.replace('mod+', mod)}</kbd><span style={{ color: 'var(--text-dim)' }}>{s.what}</span>
                </div>
              ))}
            </div>
          )}
          {p.canSignOut && (
            <button type="button" className="tb-row" role="menuitem" onClick={() => { close(); p.onSignOut(); }} style={{ alignItems: 'center', borderTop: '1px solid var(--border-soft)', marginTop: 4, borderRadius: 0 }}>
              <span style={{ width: 15 }} /><span style={{ flex: 1 }}>Sign out</span>
            </button>
          )}
        </div>
      </Popover>
    </div>
  );
}

/** The phone's overflow: the strand as rows, create, and the account items. */
function MoreMenu(p: TopBarViewProps & { open: boolean; setOpen: (m: Menu) => void; menu: Menu }) {
  const st = p.status;
  const c = st?.company;
  const close = () => p.setOpen(null);
  const line = (label: string, value: ReactNode, onClick: () => void, tone?: string) => (
    <button type="button" className="tb-row" role="menuitem" onClick={() => { close(); onClick(); }} style={{ alignItems: 'center' }}>
      <span style={{ flex: 1, fontSize: 13 }}>{label}</span><span className="tb-num" style={{ fontSize: 12.5, color: tone ?? 'var(--text-dim)', fontWeight: 600 }}>{value}</span>
    </button>
  );
  return (
    <div style={{ position: 'static' }}>
      <button type="button" className="tb-btn tb-icon" aria-haspopup="menu" aria-expanded={p.open} aria-label="More" onClick={() => p.setOpen(p.open ? null : 'more')}>
        <I d={P.dots} size={18} fill="currentColor" />
      </button>
      <Popover open={p.open} onClose={close} width="calc(100vw - 16px)" label="More" align="right">
        <div role="menu" aria-label="More" style={{ maxHeight: '75vh', overflowY: 'auto' }}>
          {c && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px' }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{c.name} <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>· {modeLabel(c.mode)}</span></span>
              </div>
              {p.canPause && line(c.status === 'paused' ? 'The company is paused' : 'The company is running', c.status === 'paused' ? 'Resume' : 'Pause', () => {
                const paused = c.status === 'paused';
                if (window.confirm(paused ? `Resume ${c.name}? Agents pick their work back up.` : `Pause ${c.name}? Every agent stops after its current step.`)) void (paused ? p.onResume() : p.onPause());
              }, c.status === 'paused' ? 'var(--red)' : undefined)}
              {st?.spend && line('Spend today', usd(st.spend.todayUsd), p.onSpend, spendTone(st.spend) === 'over' ? 'var(--red)' : undefined)}
              {st && st.agents.total > 0 && line('Agents working', `${st.agents.working} of ${st.agents.total}`, p.onAgents)}
              {st && st.agents.failing > 0 && line('Failing', st.agents.failing, p.onFailing, 'var(--red)')}
              {st?.nextMeeting && line(st.nextMeeting.title, meetingWhen(st.nextMeeting.at, p.now), p.onMeeting)}
              <div style={{ borderTop: '1px solid var(--border-soft)', margin: '4px 0' }} />
            </>
          )}
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)', padding: '6px 10px 2px' }}>Create</div>
          <CreateMenu {...p} open inline setOpen={p.setOpen} />
          <div style={{ borderTop: '1px solid var(--border-soft)', margin: '4px 0' }} />
          <button type="button" className="tb-row" role="menuitem" onClick={() => p.onToggleTheme()} style={{ alignItems: 'center' }}>
            <I d={p.theme === 'dark' ? P.sun : P.moon} size={15} /><span style={{ flex: 1 }}>{p.theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
          </button>
          <button type="button" className="tb-row" role="menuitem" onClick={() => { close(); p.onSettings('account'); }} style={{ alignItems: 'center' }}>
            <I d={P.user} size={15} /><span style={{ flex: 1 }}>{p.account?.name || p.account?.email || 'Account'}</span>
          </button>
          {p.canSignOut && (
            <button type="button" className="tb-row" role="menuitem" onClick={() => { close(); p.onSignOut(); }} style={{ alignItems: 'center' }}>
              <span style={{ width: 15 }} /><span style={{ flex: 1 }}>Sign out</span>
            </button>
          )}
        </div>
      </Popover>
    </div>
  );
}

export function TopBarView(p: TopBarViewProps) {
  const [menu, setMenu] = useState<Menu>(null);
  const setOpen = useCallback((m: Menu) => setMenu(m), []);
  const mod = isMac() ? '⌘K' : 'Ctrl K';
  return (
    <header className="tb" role="banner" data-testid="top-bar" data-mode={p.status?.company ? 'company' : 'plain'}
      style={{ height: TOP_BAR_HEIGHT, flex: 'none', display: 'flex', alignItems: 'center', gap: p.phone ? 2 : 6, padding: p.phone ? '0 6px 0 4px' : '0 10px 0 6px', background: 'var(--panel)', borderBottom: '1px solid var(--border)', position: 'relative', zIndex: 60, minWidth: 0, boxSizing: 'border-box' }}>
      <style>{CSS}</style>
      <Switcher {...p} open={menu === 'switcher'} setOpen={setOpen} />
      {!p.phone && (
        <>
          <span className="tb-sep" aria-hidden />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'flex-start', overflow: 'visible' }}>
            <Strand {...p} menu={menu} setOpen={setOpen} />
          </div>
          <button type="button" className="tb-btn" onClick={p.onSearch} aria-label="Search and commands" aria-keyshortcuts="Meta+K Control+K"
            style={{ border: '1px solid var(--border)', background: 'var(--panel-2)', width: p.width >= 1180 ? 220 : 'auto', justifyContent: 'flex-start', height: 30 }}>
            <I d={P.search} size={14} />
            {p.width >= 1180 && <span style={{ flex: 1, textAlign: 'left', fontSize: 12.5 }}>Search</span>}
            <kbd className="tb-kbd">{mod}</kbd>
          </button>
          <CreateMenu {...p} open={menu === 'create'} setOpen={setOpen} />
          <Bell {...p} open={menu === 'bell'} setOpen={setOpen} />
          <AccountMenu {...p} open={menu === 'account'} setOpen={setOpen} />
        </>
      )}
      {p.phone && (
        <>
          <LiveRuns {...p} open={menu === 'live'} setOpen={setOpen} align="right" />
          <button type="button" className="tb-btn tb-icon" onClick={p.onSearch} aria-label="Search and commands"><I d={P.search} size={17} /></button>
          <Bell {...p} open={menu === 'bell'} setOpen={setOpen} />
          <MoreMenu {...p} menu={menu} open={menu === 'more' || menu === 'create'} setOpen={setOpen} />
        </>
      )}
    </header>
  );
}

// ---- the connected bar ----

type Item = PaletteItem & { run: () => void };

function useTopBarData(wsId: string) {
  const app = useApp();
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  // The bell is the owner's feed, shared with the Inbox and the menu badge.
  const { page: notes } = useFeed(wsId);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const current = useRef(wsId);
  current.current = wsId;
  const loadStatus = useCallback(async () => {
    if (!wsId) return;
    const s = await api.workspaceStatus(wsId).catch(() => null);
    if (s && current.current === wsId) { setStatus(s); setLiveCount(null); }
  }, [wsId]);
  const loadNotes = useCallback(() => reloadFeed(wsId), [wsId]);
  const timers = useRef<{ s?: ReturnType<typeof setTimeout>; n?: ReturnType<typeof setTimeout> }>({});
  const soon = useCallback((which: 'status' | 'notes' | 'both', ms = DEBOUNCE_MS) => {
    if (which !== 'notes') { clearTimeout(timers.current.s); timers.current.s = setTimeout(() => { void loadStatus(); }, ms); }
    if (which !== 'status') { clearTimeout(timers.current.n); timers.current.n = setTimeout(() => { void loadNotes(); }, ms); }
  }, [loadStatus, loadNotes]);
  useEffect(() => () => { clearTimeout(timers.current.s); clearTimeout(timers.current.n); }, []);

  useEffect(() => { setStatus(null); setLiveCount(null); void loadStatus(); }, [loadStatus]);
  // The workspace stream: a turn starting or ending moves the live count at once.
  useEffect(() => app.onWorkspaceEvent((ev) => {
    if (ev.type === 'turn_live') { setLiveCount(ev.running); soon('status', 600); if (!ev.on) soon('notes', 1_500); }
    else if (ev.type === 'task_update' || ev.type === 'channel_approval' || ev.type === 'meeting_update') soon('both');
    else if (ev.type === 'channel_message') soon('notes');
  }), [app, soon]);
  // The fallback: a light poll while the tab is visible, and on focus (the feed polls itself).
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') void loadStatus(); }, POLL_MS);
    const onFocus = () => soon('status', 200);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [loadStatus, soon]);
  // The company's own state changes elsewhere (the Company header's kill switch, Settings).
  const orgKey = `${app.wsOrg?.mode ?? ''}:${app.wsOrg?.orgStatus ?? ''}`;
  useEffect(() => { soon('status', 300); }, [orgKey, soon]);
  return { status, notes, liveCount, loadStatus, loadNotes };
}

export function TopBar({ onSettings }: { onSettings: (pane: string) => void }) {
  const app = useApp();
  const auth = useAuth();
  const wsId = app.workspaceId;
  const { status, notes, liveCount, loadStatus, loadNotes } = useTopBarData(wsId);
  const openFeedItem = useOpenFeedItem();
  const { busy, act } = useFeedAction();
  const [rows, setRows] = useState<Record<string, WorkspaceGlanceRow> | null>(null);
  const [palette, setPalette] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(id); }, []);
  useEffect(() => { setNow(new Date()); }, [status, notes]);

  // ⌘K / Ctrl+K anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (isPaletteShortcut(e)) { e.preventDefault(); setPalette((v) => !v); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const orgOn = app.companiesEnabled && app.wsOrg !== null && app.wsOrg.mode !== 'off';
  const canPause = !app.me || app.me.role === 'owner';
  const ws = app.workspaces.find((w) => w.id === wsId);

  const openPane = useCallback((pane: Parameters<typeof app.setOrgPane>[0], focus: Parameters<typeof app.setOrgFocus>[0] = null) => {
    app.setOrgFocus(focus); app.setOrgUnitId(null); app.setOrgPane(pane); app.setMobileDetail(true);
  }, [app]);

  const pause = useCallback(async () => {
    try { await api.pauseOrg(wsId); app.showToast(`${status?.company?.name ?? 'The company'} is paused`); } catch (e) { app.showToast(e instanceof Error ? e.message : String(e)); }
    await app.refreshWsOrg(); await loadStatus();
  }, [app, wsId, status, loadStatus]);
  const resume = useCallback(async () => {
    try { await api.resumeOrg(wsId); app.showToast(`${status?.company?.name ?? 'The company'} is running again`); } catch (e) { app.showToast(e instanceof Error ? e.message : String(e)); }
    await app.refreshWsOrg(); await loadStatus();
  }, [app, wsId, status, loadStatus]);

  const markRead = useCallback((list: FeedItem[]) => { void markFeedRead(wsId, list); }, [wsId]);
  const markAll = useCallback(() => { void markFeedRead(wsId, 'all'); }, [wsId]);

  const create = useCallback((kind: CreateKind, title?: string) => {
    switch (kind) {
      case 'chat': void app.newChat(null).catch((e: unknown) => app.showToast(e instanceof Error ? e.message : String(e))); return;
      case 'agent': app.setNewAgentOpen(true); return;
      case 'workspace': setWizard(true); return;
      case 'meeting': openPane('meetings'); return;
      case 'task':
        if (!title) { openPane('board'); return; }
        void api.addOrgTask(wsId, { title }).then((t) => { app.showToast(`Created ${t.key ?? 'the task'}`); app.openOrgTask(t.id); void loadNotes(); })
          .catch((e: unknown) => app.showToast(e instanceof Error ? e.message : String(e)));
    }
  }, [app, wsId, openPane, loadNotes]);

  // ---- the palette's items ----
  const items = useMemo<Item[]>(() => {
    const go = (s: Section) => () => app.go(s);
    const out: Item[] = [
      { id: 'new-chat', group: 'Actions', label: 'New chat', keywords: 'create conversation talk', run: () => create('chat') },
      { id: 'new-agent', group: 'Actions', label: 'New agent', keywords: 'create hire build', run: () => create('agent') },
      { id: 'new-ws', group: 'Actions', label: 'New workspace or company', keywords: 'create start a company', run: () => create('workspace') },
      { id: 'theme', group: 'Actions', label: app.theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme', keywords: 'theme dark light appearance', run: app.toggleTheme },
      { id: 'read-all', group: 'Actions', label: 'Mark all notifications read', keywords: 'notifications bell clear', run: markAll },
      { id: 'go-home', group: 'Go to', label: 'Home', hint: 'mission control', run: go('overview') },
      { id: 'go-chat', group: 'Go to', label: 'Chat', hint: 'channels and chats', run: go('home') },
      { id: 'go-agents', group: 'Go to', label: 'All agents', run: go('agents') },
      { id: 'go-artifacts', group: 'Go to', label: 'Artifacts', hint: 'files', keywords: 'files documents', run: go('artifacts') },
      { id: 'go-apps', group: 'Go to', label: 'Apps', run: go('apps') },
      { id: 'go-market', group: 'Go to', label: 'Market', keywords: 'foundry hire templates', run: go('market') },
      { id: 'go-settings', group: 'Go to', label: 'Settings', run: () => onSettings('providers') },
    ];
    if (orgOn) {
      out.push(
        { id: 'new-task', group: 'Actions', label: 'New task', keywords: 'create board todo', run: () => create('task') },
        { id: 'meeting', group: 'Actions', label: 'Start a meeting', keywords: 'standup review retro', run: () => create('meeting') },
        { id: 'go-inbox', group: 'Go to', label: 'Inbox', hint: 'what waits on you', keywords: 'approvals decisions', run: go('inbox') },
        { id: 'go-company', group: 'Go to', label: 'Company', hint: 'board', keywords: 'board tasks', run: () => openPane('board') },
        { id: 'go-chart', group: 'Go to', label: 'Mission control', hint: 'org chart', keywords: 'org chart agents status', run: () => openPane('chart') },
        { id: 'go-spend', group: 'Go to', label: 'Spend', keywords: 'budget money envelope cost', run: () => openPane('spend') },
        { id: 'go-meetings', group: 'Go to', label: 'Meetings', run: () => openPane('meetings') },
      );
      if (canPause && status?.company) {
        const paused = status.company.status === 'paused';
        out.push({ id: 'pause', group: 'Actions', label: paused ? 'Resume the company' : 'Pause the company', keywords: 'kill switch stop halt', run: () => { if (window.confirm(paused ? `Resume ${status.company!.name}?` : `Pause ${status.company!.name}? Every agent stops after its current step.`)) void (paused ? resume() : pause()); } });
      }
    }
    for (const a of app.agents) out.push({ id: `agent:${a.id}`, group: 'Agents', label: a.name, hint: a.role ?? '', run: () => app.openAgent(a.id) });
    for (const c of app.channels) out.push({ id: `channel:${c.id}`, group: 'Channels', label: `#${c.slug}`, hint: c.name !== c.slug ? c.name : '', run: () => app.openChannel(c.slug) });
    for (const s of app.sessions.slice(0, 200)) out.push({ id: `chat:${s.id}`, group: 'Chats', label: s.name || s.autoTitle || 'Chat', hint: app.agents.find((a) => a.id === s.agentId)?.name ?? '', run: () => app.openSession(s.id) });
    for (const sp of SETTINGS_PANES) out.push({ id: `settings:${sp.id}`, group: 'Settings', label: sp.label, keywords: 'settings preferences', run: () => onSettings(sp.id) });
    return out;
  }, [app, orgOn, canPause, status, create, markAll, onSettings, openPane, pause, resume]);

  const extra = useCallback((q: string): Item[] => {
    if (!orgOn || !isTaskKey(q)) return [];
    const key = normalizeTaskKey(q) ?? q.toUpperCase();
    return [{ id: `task:${key}`, group: 'Tasks', label: `Open task ${key}`, run: () => {
      void api.orgTask(wsId, key).then((t) => app.openOrgTask(t.id)).catch(() => app.showToast(`No task ${key} in this company`));
    } }];
  }, [orgOn, wsId, app]);

  const remote = useCallback(async (q: string): Promise<Item[]> => {
    const r = await api.search(wsId, q);
    const out: Item[] = [];
    for (const s of r.sessions.slice(0, 6)) out.push({ id: `chat:${s.id}`, group: 'Chats', label: s.name || s.autoTitle || 'Chat', keywords: q, run: () => app.openSession(s.id) });
    for (const f of r.files.slice(0, 6)) out.push({ id: `file:${f.path}`, group: 'Files', label: f.path.split('/').pop() || f.path, hint: f.path, keywords: `${f.path} ${q}`, run: () => app.openFile({ kind: 'workspace', id: wsId }, f.path) });
    for (const m of r.messages.slice(0, 5)) out.push({ id: `msg:${m.messageId}`, group: 'Messages', label: m.snippet.replace(/<\/?b>/g, '').replace(/\s+/g, ' ').slice(0, 120), keywords: q, run: () => app.openSession(m.sessionId) });
    for (const m of (r.channelMessages ?? []).slice(0, 4)) out.push({ id: `cmsg:${m.messageId}`, group: 'Messages', label: m.snippet.replace(/<\/?b>/g, '').replace(/\s+/g, ' ').slice(0, 120), hint: `#${m.slug}`, keywords: q, run: () => app.openChannel(m.slug, m.messageId) });
    return out;
  }, [wsId, app]);

  if (!ws) return <div style={{ height: TOP_BAR_HEIGHT, flex: 'none', background: 'var(--panel)', borderBottom: '1px solid var(--border)' }} />;
  return (
    <>
      <TopBarView
        now={now} phone={app.stacked} width={app.width} theme={app.theme}
        workspace={ws} workspaces={app.workspaces} rows={rows} status={status} liveCount={liveCount} notifications={notes}
        canPause={canPause} orgOn={orgOn}
        account={auth.account ? { name: auth.account.name, email: auth.account.email } : null} canSignOut={auth.mode === 'accounts'}
        onOpenSwitcher={() => { void api.workspaceGlance().then((list) => setRows(Object.fromEntries(list.map((r) => [r.workspaceId, r])))).catch(() => undefined); }}
        onPickWorkspace={(id) => { const w = app.workspaces.find((x) => x.id === id); app.pickWorkspace(id); if (w) app.showToast(`Switched to ${w.name}`); }}
        onPause={pause} onResume={resume}
        onSpend={() => openPane('spend')}
        onAgents={() => (orgOn ? openPane('chart') : app.go('agents'))}
        onFailing={() => (orgOn ? openPane('chart', { kind: 'mission', id: 'error' }) : app.go('agents'))}
        onRun={(id) => app.openSession(id)}
        onMeeting={() => openPane('meetings', status?.nextMeeting?.meetingId ? { kind: 'meeting', id: status.nextMeeting.meetingId } : null)}
        onOpenNotification={openFeedItem} onMarkRead={markRead} onMarkAllRead={markAll} onNotificationAction={(n, a) => void act(n, a)} busy={busy}
        onInbox={() => app.go(orgOn ? 'inbox' : 'overview')}
        onSearch={() => setPalette(true)} onCreate={create}
        onToggleTheme={app.toggleTheme} onSettings={onSettings} onSignOut={() => { void auth.signOut(); }}
      />
      {palette && <CommandPalette items={items} extra={extra} remote={remote} phone={app.stacked} onClose={() => setPalette(false)} onRun={(it) => it.run()} />}
      {wizard && <NewWorkspaceWizard onClose={() => setWizard(false)} />}
    </>
  );
}
