/**
 * The top bar's copy and rules (docs/home.md "Top bar"), pure so they test
 * without a DOM: the spend meter's tone, the next meeting in words, the
 * bell's groups and filters, where a notification opens, and the command
 * palette's ranking and shortcut.
 */
import type { HomeNeed, NotificationKind, TopNotification, WorkspaceStatus } from './api';
import { needTarget, type HomeTarget } from './home';

// ---- the status strand ----

export type SpendTone = 'ok' | 'warn' | 'over';

/** Red when the month is at or over the envelope or the forecast says stop; amber on warn. */
export function spendTone(s: WorkspaceStatus['spend']): SpendTone {
  if (!s) return 'ok';
  if ((s.monthCapUsd && (s.monthUsd ?? 0) >= s.monthCapUsd) || s.forecastState === 'stop') return 'over';
  if (s.forecastState === 'warn') return 'warn';
  return 'ok';
}

/** The meter's two marks as fractions of the envelope (spent, month-end forecast), clamped to 0–1; null without an envelope. */
export function spendMeter(s: WorkspaceStatus['spend']): { spent: number; forecast: number } | null {
  if (!s || !s.monthCapUsd) return null;
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return { spent: clamp((s.monthUsd ?? 0) / s.monthCapUsd), forecast: clamp((s.projectedUsd ?? s.monthUsd ?? 0) / s.monthCapUsd) };
}

export const usd = (n: number | null | undefined): string => {
  const v = n ?? 0;
  return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
};

/** "now", "in 12 min", "in 2 h 5 min", or the clock time when it is later than three hours. */
export function meetingWhen(at: string, now: Date): string {
  const min = Math.round((Date.parse(at) - now.getTime()) / 60_000);
  if (min <= 0) return 'now';
  if (min < 60) return `in ${min} min`;
  if (min < 180) { const h = Math.floor(min / 60); const m = min % 60; return m ? `in ${h} h ${m} min` : `in ${h} h`; }
  return `at ${new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** How long a run has been going: "12 s", "4 min", "1 h 10 min". */
export function elapsed(startedAt: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(startedAt)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "Chat", "Heartbeat", "Channel"… — what started a run, in words. */
export function originLabel(origin: string): string {
  switch (origin) {
    case 'user': return 'Chat';
    case 'loop': return 'Loop';
    case 'heartbeat': return 'Heartbeat';
    case 'channel': return 'Channel';
    case 'org': return 'Company';
    case 'meeting': return 'Meeting';
    case 'app': return 'App';
    default: return origin ? origin[0].toUpperCase() + origin.slice(1) : 'Run';
  }
}

// ---- the bell ----

export type NotificationFilter = 'all' | 'waiting' | 'messages' | 'runs';
export const NOTIFICATION_FILTERS: Array<{ id: NotificationFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'waiting', label: 'Waiting on you' },
  { id: 'messages', label: 'Messages' },
  { id: 'runs', label: 'Runs' },
];

const MESSAGE_KINDS: NotificationKind[] = ['message', 'mention', 'follow'];
const RUN_KINDS: NotificationKind[] = ['run_failed', 'budget_stop'];

export function filterNotifications(items: TopNotification[], f: NotificationFilter): TopNotification[] {
  switch (f) {
    case 'waiting': return items.filter((i) => i.waiting);
    case 'messages': return items.filter((i) => MESSAGE_KINDS.includes(i.kind));
    case 'runs': return items.filter((i) => RUN_KINDS.includes(i.kind));
    default: return items;
  }
}

export interface NotificationGroup { id: 'waiting' | 'today' | 'earlier'; label: string; items: TopNotification[] }

/** Waiting on you first (in the server's rank), then today and earlier, newest first. Empty groups are dropped. */
export function groupNotifications(items: TopNotification[], now: Date): NotificationGroup[] {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const cut = midnight.toISOString();
  const news = items.filter((i) => !i.waiting).sort((a, b) => b.at.localeCompare(a.at));
  const groups: NotificationGroup[] = [
    { id: 'waiting', label: 'Waiting on you', items: items.filter((i) => i.waiting) },
    { id: 'today', label: 'Today', items: news.filter((i) => i.at >= cut) },
    { id: 'earlier', label: 'Earlier', items: news.filter((i) => i.at < cut) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

export const KIND_LABEL: Record<NotificationKind, string> = {
  decision: 'Decision', escalation: 'Escalation', key: 'Needs your key', plan: 'Pending change', incident: 'Incident', signal: 'Signal',
  queued_action: 'Queued action', message: 'Message', mention: 'Mention', follow: 'Following', run_failed: 'Run failed', budget_stop: 'Budget stop', activity: 'Update',
};

/** The tone of a row's mark: red for what is failing or critical, amber for what waits or expires, the accent for messages, faint otherwise. */
export function kindTone(n: Pick<TopNotification, 'kind' | 'severity' | 'expiresSoon' | 'waiting'>): 'red' | 'amber' | 'accent' | 'faint' {
  if (n.severity === 'critical' || n.kind === 'run_failed' || n.kind === 'budget_stop' || n.kind === 'incident') return 'red';
  if (n.waiting || n.expiresSoon) return 'amber';
  if (n.kind === 'message' || n.kind === 'mention') return 'accent';
  return 'faint';
}

/** Where a notification opens: a card goes where Home sends it; an event to its chat, its link or its agent. */
export type NotificationOpen = HomeTarget | { to: 'hash'; hash: string };
export function notificationTarget(n: TopNotification): NotificationOpen {
  const t = n.target;
  switch (t.to) {
    case 'need': return needTarget(t.need as HomeNeed) ?? { to: 'inbox' };
    case 'chat': return { to: 'chat', sessionId: t.sessionId };
    case 'agent': return { to: 'agent', agentId: t.agentId };
    case 'hash': return { to: 'hash', hash: t.hash };
    default: return { to: 'inbox' };
  }
}

/** "now", "5m", "3h", "2d", or the date. */
export function ago(iso: string, now: Date): string {
  const m = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Expires in 40 min" / "Expires in 3 h" for a card whose default is near. */
export function expiresLabel(deadline: string | null, now: Date): string {
  if (!deadline) return '';
  const min = Math.round((Date.parse(deadline) - now.getTime()) / 60_000);
  if (min <= 0) return 'Expired';
  return min < 60 ? `Expires in ${min} min` : `Expires in ${Math.round(min / 60)} h`;
}

// ---- the command palette ----

export type PaletteGroup = 'Actions' | 'Go to' | 'Agents' | 'Channels' | 'Chats' | 'Tasks' | 'Files' | 'Messages' | 'Settings';
export const PALETTE_ORDER: PaletteGroup[] = ['Tasks', 'Actions', 'Go to', 'Agents', 'Channels', 'Chats', 'Files', 'Messages', 'Settings'];

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  /** A second, dimmer line or a right-hand hint (a shortcut, a path). */
  hint?: string;
  /** Extra words it answers to ("pause", "kill switch"). */
  keywords?: string;
}

/** How well `q` matches `text`: 3 the start, 2 the start of a word, 1 anywhere, 0.5 the letters in order, 0 not at all. */
export function matchScore(text: string, q: string): number {
  const t = text.toLowerCase();
  const s = q.trim().toLowerCase();
  if (!s) return 1;
  if (t.startsWith(s)) return 3;
  if (new RegExp(`(^|[\\s/#·:_-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 2;
  if (t.includes(s)) return 1;
  let i = 0;
  for (const ch of t) { if (ch === s[i]) i++; if (i === s.length) return 0.5; }
  return 0;
}

/** The items that match, best first, grouped in the palette's order; at most `perGroup` per group. With no query, actions and places only. */
export function rankPalette<T extends PaletteItem>(items: T[], q: string, perGroup = 6): T[] {
  const query = q.trim();
  const scored = items
    .map((it) => ({ it, score: Math.max(matchScore(it.label, query), it.keywords ? matchScore(it.keywords, query) * 0.9 : 0) }))
    .filter((x) => x.score > 0 && (query || x.it.group === 'Actions' || x.it.group === 'Go to'));
  const out: T[] = [];
  for (const g of PALETTE_ORDER) {
    out.push(...scored.filter((x) => x.it.group === g).sort((a, b) => b.score - a.score).slice(0, perGroup).map((x) => x.it));
  }
  return out;
}

/** ⌘K on a Mac, Ctrl+K elsewhere (either works anywhere). */
export function isPaletteShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}

export const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

/** The keyboard shortcuts the help menu lists. */
export const SHORTCUTS: Array<{ keys: string; what: string }> = [
  { keys: 'mod+K', what: 'Search and run a command' },
  { keys: 'Esc', what: 'Close a menu, the palette or a panel' },
  { keys: '↑ ↓ Enter', what: 'Move through the palette and open the pick' },
];
