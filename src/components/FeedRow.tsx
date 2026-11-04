/**
 * One row of the owner's feed (docs/owners-seat.md "Inbox and notifications"),
 * the same in the Inbox and the bell: who it is from (the agent's avatar),
 * a one-line title, what kind it is, its context (task key, project,
 * channel, meeting), the company, when, the unread mark, and — where the
 * item can be handled in place — its actions (approve, reject, allow, deny,
 * veto…). A row opens where it lives through the store's own actions
 * (`useOpenFeedItem`), never a URL built here.
 */
import { useCallback, useState, type KeyboardEvent } from 'react';
import { grad, useApp } from '../store';
import { api, type FeedAction, type FeedItem, type FollowTargetKind } from '../lib/api';
import { contextChips, FEED_LABEL, feedActionLabel, feedOpen, feedTone, TONE_VAR } from '../lib/feed';
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

/** Run an inline action through the route that owns it. */
export function runFeedAction(wsId: string, i: FeedItem, a: FeedAction): Promise<unknown> {
  const r = i.need?.ref;
  if ((a === 'allow' || a === 'deny') && i.ref?.agentId && i.ref.eventId) return api.decideAgentEvent(i.ref.agentId, i.ref.eventId, a);
  if (r?.approvalId && (a === 'approve' || a === 'reject')) return api.decideOrgApproval(wsId, r.approvalId, a);
  if (r?.actionId && (a === 'approve' || a === 'reject')) return api.giveActionKey(wsId, r.actionId, a === 'approve');
  if (r?.planId && a === 'veto') return api.vetoOrgPlan(wsId, r.planId);
  if (r?.planId && a === 'apply_now') return api.applyOrgPlanNow(wsId, r.planId);
  if (r?.signalId && a === 'ack') return api.ackOrgSignal(wsId, r.signalId);
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

/** Run an action from a row: it leaves the list at once, the toast says what happened. */
export function useFeedAction(): { busy: Set<string>; act: (i: FeedItem, a: FeedAction) => Promise<void> } {
  const app = useApp();
  const wsId = app.workspaceId;
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const act = useCallback(async (i: FeedItem, a: FeedAction) => {
    setBusy((b) => new Set(b).add(i.id));
    try {
      await runFeedAction(wsId, i, a);
      dropFeedItems(wsId, [i.id]);
      app.showToast(a === 'allow' ? 'Allowed' : a === 'deny' ? 'Denied' : actionDone(a));
      void app.refreshWsOrg();
    } catch (e) {
      app.showToast(e instanceof Error ? e.message : String(e));
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
  onOpen: (i: FeedItem) => void;
  onMarkRead: (i: FeedItem) => void;
  onAction?: (i: FeedItem, a: FeedAction) => void;
  busy?: boolean;
  /** The bell: one line of body, fewer chips. */
  compact?: boolean;
  /** Show the company (a workspace switcher view across companies). */
  showCompany?: boolean;
  /** Roving focus (the Inbox's ↑/↓): this row takes the tab stop. */
  tabIndex?: number;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}

export function FeedRow({ item: i, now, onOpen, onMarkRead, onAction, busy, compact, showCompany, tabIndex, onKeyDown }: FeedRowProps) {
  const tone = TONE_VAR[feedTone(i)];
  const chips = contextChips(i);
  const actions = onAction ? i.actions : [];
  return (
    <div role="listitem" data-testid={`feed-row-${i.id}`} data-read={i.read ? 'true' : 'false'} tabIndex={tabIndex} onKeyDown={onKeyDown}
      aria-label={`${i.read ? '' : 'Unread. '}${FEED_LABEL[i.type]}: ${i.title}`}
      className="feed-row"
      style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: compact ? '8px 10px' : '11px 14px', borderRadius: 10, position: 'relative', outline: 'none', background: i.read ? 'transparent' : 'var(--accent-dim)' }}>
      <span aria-hidden style={{ position: 'absolute', left: 3, top: compact ? 15 : 18, width: 6, height: 6, borderRadius: '50%', background: i.read ? 'transparent' : tone }} data-testid="feed-unread-dot" />
      <FeedAvatar item={i} size={compact ? 26 : 30} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <button type="button" onClick={() => onOpen(i)} data-testid="feed-open"
          style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)', font: 'inherit' }}>
          <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 13, fontWeight: i.read ? 500 : 650, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{i.title}</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-dim)', marginTop: 3 }}>
            <span data-testid="feed-type" style={{ color: tone === 'var(--text-faint)' ? 'var(--text-dim)' : tone, fontWeight: 600 }}>{FEED_LABEL[i.type]}</span>
            {i.actor && <span data-testid="feed-actor">{i.actor.name}</span>}
            {chips.map((c) => <span key={c} data-testid="feed-chip" style={{ border: '1px solid var(--border-soft)', borderRadius: 6, padding: '0 6px', background: 'var(--panel-2)', whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c}</span>)}
            {showCompany && i.company && <span>{i.company}</span>}
            {i.count > 1 && <span data-testid="feed-count" style={{ fontWeight: 600 }}>{i.count} updates</span>}
            {i.expiresSoon && i.deadline && <span data-testid="feed-expires" style={{ color: 'var(--amber)', fontWeight: 600 }}>{expiresIn(i.deadline, now)}</span>}
          </span>
          {i.need?.chain?.line && <span data-testid="feed-route" style={{ display: 'block', fontSize: 11.5, color: 'var(--text-dim)', marginTop: 3, overflowWrap: 'anywhere' }}>Route: {i.need.chain.line}</span>}
          {i.body && <span style={{ display: '-webkit-box', WebkitLineClamp: compact ? 1 : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 12, color: 'var(--text-faint)', marginTop: 3, overflowWrap: 'anywhere' }}>{i.body}</span>}
        </button>
        {actions.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
            {actions.map((a, n) => (
              <button key={a} type="button" disabled={busy} data-testid={`feed-action-${a}`} onClick={() => onAction!(i, a)}
                style={{ border: n === 0 ? 'none' : '1px solid var(--border)', background: n === 0 ? 'var(--accent)' : 'var(--panel-2)', color: n === 0 ? '#fff' : 'var(--text)', borderRadius: 7, padding: compact ? '3px 9px' : '4px 11px', fontSize: 12, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
                {feedActionLabel(i, a)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }} title={new Date(i.at).toLocaleString()}>{shortAgo(i.at, now)}</span>
        {!i.read && (
          <button type="button" aria-label={`Mark read: ${i.title}`} title="Mark read (m)" data-testid="feed-mark-read" onClick={() => onMarkRead(i)}
            style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'none', color: 'var(--text-faint)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <I d={P.check} size={13} sw={2.2} />
          </button>
        )}
      </div>
    </div>
  );
}
