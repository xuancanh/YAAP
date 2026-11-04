/**
 * One row of the owner's feed (docs/owners-seat.md "Inbox and notifications"),
 * the same in the Inbox and the bell: two quiet lines — the title a person
 * would write, then who it is from, what kind it is and its context (task
 * key, project, channel, meeting) — with the time, a small dot while it is
 * unread and a quiet deadline badge ("3 h left") when one is near. Hovering
 * (or focusing) a row shows its quick actions: mark read and open where it
 * lives. Decisions are taken in the Inbox's reading pane (InboxDetail.tsx),
 * where the whole card is; the bell may carry the buttons of its top one or
 * two actionable rows. A row opens through the store's own actions
 * (`useOpenFeedItem`, `useOpenInInbox`), never a URL built here.
 */
import { useCallback, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { grad, useApp } from '../store';
import { api, type FeedAction, type FeedItem, type FollowTargetKind } from '../lib/api';
import { contextChips, deadlineBadge, FEED_LABEL, feedActionLabel, feedOpen, feedTone, isUrgent, tabOf } from '../lib/feed';
import { actionDone } from '../lib/home';
import { dropFeedItems, markFeedRead, reloadFeed } from '../lib/feed-store';
import { I, P } from '../lib/icons';
import { navigate } from '../lib/routes';

/** "now", "5m", "3h", "2d", or the date. */
export function shortAgo(iso: string, now: Date): string {
  const m = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Expires in 40 min" / "Expires in 3 h". */
export function expiresIn(deadline: string | null, now: Date): string {
  if (!deadline) return '';
  const min = Math.round((Date.parse(deadline) - now.getTime()) / 60_000);
  if (min <= 0) return 'Expired';
  return min < 60 ? `Expires in ${min} min` : `Expires in ${Math.round(min / 60)} h`;
}

export function FeedAvatar({ item, size = 28 }: { item: Pick<FeedItem, 'actor'>; size?: number }) {
  const a = item.actor;
  const base: React.CSSProperties = { width: size, height: size, borderRadius: '50%', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.5, color: '#fff', fontWeight: 700 };
  if (a?.kind === 'agent') return <span aria-hidden style={{ ...base, background: grad(a.colors ?? '') }}>{a.emoji || a.name.slice(0, 1)}</span>;
  if (a?.kind === 'person') return <span aria-hidden style={{ ...base, background: 'var(--blue)' }}>{a.name.slice(0, 1).toUpperCase()}</span>;
  return <span aria-hidden style={{ ...base, background: 'var(--panel-2)', color: 'var(--text-dim)', border: '1px solid var(--border)' }}><I d={P.bell} size={size * 0.5} /></span>;
}

/** Run an inline action through the route that owns it (with the owner's note, where the route takes one). */
export function runFeedAction(wsId: string, i: FeedItem, a: FeedAction, note?: string): Promise<unknown> {
  const r = i.need?.ref;
  const n = note?.trim() || undefined;
  if ((a === 'allow' || a === 'deny') && i.ref?.agentId && i.ref.eventId) return api.decideAgentEvent(i.ref.agentId, i.ref.eventId, a);
  if (r?.approvalId && (a === 'approve' || a === 'reject')) return api.decideOrgApproval(wsId, r.approvalId, a, n);
  if (r?.actionId && (a === 'approve' || a === 'reject')) return api.giveActionKey(wsId, r.actionId, a === 'approve', n);
  if (r?.planId && a === 'veto') return api.vetoOrgPlan(wsId, r.planId);
  if (r?.planId && a === 'apply_now') return api.applyOrgPlanNow(wsId, r.planId);
  if (r?.signalId && a === 'ack') return api.ackOrgSignal(wsId, r.signalId, n);
  if (r?.eventId && r.agentId && (a === 'approve' || a === 'dismiss')) return api.actOnAgentEvent(r.agentId, r.eventId, a);
  return Promise.reject(new Error(`${a} is not available here; open it for details`));
}

/** Open a row where it lives; it is read, and a message's chat or a follow is seen. */
export function useOpenFeedItem(): (i: FeedItem) => void {
  const app = useApp();
  const wsId = app.workspaceId;
  const orgOn = app.companiesEnabled && app.wsOrg !== null && app.wsOrg.mode !== 'off';
  return useCallback((i: FeedItem) => {
    if (!i.read) void markFeedRead(wsId, [i]);
    if (i.type === 'message' && i.ref?.sessionId) void api.markMessagesRead(wsId, { sessionId: i.ref.sessionId }).then(() => app.refreshWsOrg()).catch(() => undefined);
    if (i.ref?.follow) void api.markFollowSeen(wsId, i.ref.follow.targetKind as FollowTargetKind, i.ref.follow.targetId).then(() => app.refreshWsOrg()).catch(() => undefined);
    const t = feedOpen(i);
    const pane = (p: Parameters<typeof app.setOrgPane>[0], focus: Parameters<typeof app.setOrgFocus>[0] = null) => {
      app.setOrgFocus(focus); app.setOrgUnitId(null); app.setOrgPane(p); app.setMobileDetail(true);
    };
    switch (t.to) {
      case 'pane': pane(t.pane, t.focus ?? null); return;
      case 'task': app.openOrgTask(t.taskId); return;
      case 'agent': app.openAgent(t.agentId); return;
      case 'file': app.openFile({ kind: 'workspace', id: wsId }, t.path); return;
      case 'chat': app.openSession(t.sessionId); return;
      case 'channel': app.openChannel(t.slug, t.messageId); return;
      case 'plugin': app.go('market'); return;
      case 'hash': navigate(t.hash); return;
      case 'queue': app.go('inbox'); app.setInboxFilter(t.filter); return;
      case 'history': app.go('inbox'); app.setInboxFilter('history'); return;
      case 'inbox': app.go(orgOn ? 'inbox' : 'overview'); return;
    }
  }, [app, wsId, orgOn]);
}

/** Open a row in the Inbox's reading pane (the bell does): on its tab, read.
 *  Without a company there is no Inbox: the row opens where it lives. */
export function useOpenInInbox(): (i: FeedItem) => void {
  const app = useApp();
  const openWhere = useOpenFeedItem();
  const orgOn = app.companiesEnabled && app.wsOrg !== null && app.wsOrg.mode !== 'off';
  return useCallback((i: FeedItem) => {
    if (!orgOn) { openWhere(i); return; }
    if (!i.read) void markFeedRead(app.workspaceId, [i]);
    app.go('inbox');
    app.setInboxFilter(tabOf(i));
    app.setInboxItem(i.id);
  }, [app, orgOn, openWhere]);
}

/** Run an action from a row or the pane: it leaves the list at once, the toast says what happened. */
export function useFeedAction(): { busy: Set<string>; act: (i: FeedItem, a: FeedAction, note?: string) => Promise<boolean> } {
  const app = useApp();
  const wsId = app.workspaceId;
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const act = useCallback(async (i: FeedItem, a: FeedAction, note?: string) => {
    setBusy((b) => new Set(b).add(i.id));
    try {
      await runFeedAction(wsId, i, a, note);
      dropFeedItems(wsId, [i.id]);
      app.showToast(a === 'allow' ? 'Allowed' : a === 'deny' ? 'Denied' : actionDone(a));
      void app.refreshWsOrg();
      return true;
    } catch (e) {
      app.showToast(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(i.id); return n; });
      void reloadFeed(wsId);
    }
  }, [app, wsId]);
  return { busy, act };
}

export interface FeedRowProps {
  item: FeedItem;
  now: Date;
  /** The row's click: the Inbox shows it in the reading pane; the bell opens it there. */
  onOpen: (i: FeedItem) => void;
  onMarkRead: (i: FeedItem) => void;
  /** The quick action that opens it where it lives (the task, the chat…); absent = none. */
  onGo?: (i: FeedItem) => void;
  /** Inline actions (the bell's top rows only). */
  onAction?: (i: FeedItem, a: FeedAction) => void;
  busy?: boolean;
  /** The bell: a tighter row. */
  compact?: boolean;
  /** This row is the one in the reading pane. */
  selected?: boolean;
  /** Show the company (a workspace switcher view across companies). */
  showCompany?: boolean;
  /** Roving focus (the Inbox's ↑/↓): this row takes the tab stop. */
  tabIndex?: number;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}

export function FeedRow({ item: i, now, onOpen, onMarkRead, onGo, onAction, busy, compact, selected, showCompany, tabIndex, onKeyDown }: FeedRowProps) {
  const tone = feedTone(i);
  const chips = contextChips(i);
  const actions = onAction ? i.actions : [];
  const badge = deadlineBadge(i, now);
  const urgent = isUrgent(i);
  const stop = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <div role="listitem" data-testid={`feed-row-${i.id}`} data-read={i.read ? 'true' : 'false'} data-selected={selected ? 'true' : undefined} tabIndex={tabIndex} onKeyDown={onKeyDown}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${i.read ? '' : 'Unread. '}${FEED_LABEL[i.type]}: ${i.title}${badge ? `. ${badge}` : ''}`}
      className={`feed-row${compact ? ' compact' : ''}${i.read ? ' read' : ''}${selected ? ' selected' : ''}`}>
      <span aria-hidden className={`feed-dot tone-${tone}`} data-testid="feed-unread-dot" />
      <FeedAvatar item={i} size={compact ? 24 : 28} />
      <div className="feed-main">
        <button type="button" onClick={() => onOpen(i)} data-testid="feed-open" className="feed-open">
          <span className="feed-l1">
            <span className="feed-title">{i.title}</span>
            <span className="feed-time" title={new Date(i.at).toLocaleString()}>{shortAgo(i.at, now)}</span>
          </span>
          <span className="feed-l2">
            <span className="feed-meta">
              {i.actor && i.actor.kind !== 'system' && <span data-testid="feed-actor" className="feed-actor">{i.actor.name}</span>}
              <span data-testid="feed-type" className={`feed-kind tone-${tone}`}>{FEED_LABEL[i.type]}</span>
              {chips.slice(0, compact ? 1 : 2).map((c) => <span key={c} data-testid="feed-chip" className="feed-chip">{c}</span>)}
              {showCompany && i.company && <span>{i.company}</span>}
              {i.count > 1 && <span data-testid="feed-count" className="feed-count">{i.count} updates</span>}
            </span>
            {badge && <span data-testid="feed-expires" className={`feed-badge${urgent ? ' warn' : ''}${badge === 'Overdue' ? ' late' : ''}`}>{badge}</span>}
          </span>
        </button>
        {actions.length > 0 && (
          <div className="feed-actions">
            {actions.map((a, n) => (
              <button key={a} type="button" disabled={busy} data-testid={`feed-action-${a}`} onClick={stop(() => onAction!(i, a))} className={`feed-btn${n === 0 ? ' primary' : ''}`}>
                {feedActionLabel(i, a)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="feed-quick">
        {!i.read && (
          <button type="button" aria-label={`Mark read: ${i.title}`} title="Mark read (m)" data-testid="feed-mark-read" onClick={stop(() => onMarkRead(i))} className="feed-icon">
            <I d={P.check} size={14} sw={2.2} />
          </button>
        )}
        {onGo && feedOpen(i).to !== 'inbox' && (
          <button type="button" aria-label={`Open where it lives: ${i.title}`} title="Open where it lives (o)" data-testid="feed-go" onClick={stop(() => onGo(i))} className="feed-icon">
            <I d={P.external} size={14} sw={2} />
          </button>
        )}
      </div>
    </div>
  );
}
