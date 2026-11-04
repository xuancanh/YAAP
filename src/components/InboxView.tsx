/** The Inbox (docs/owners-seat.md "Inbox and notifications"): the owner's
 *  feed in full — the same page the bell shows, so the two never disagree.
 *
 *  - **Needs you**: what waits on you until it is resolved — decisions,
 *    escalations, keys, pending changes, incidents and signals, a turn
 *    waiting for your connection, your tasks and reviews, what is blocked on
 *    you, what you follow that needs you, plugin updates to review. Rows act
 *    in place (approve, reject, allow, deny, veto…); a chip opens one kind's
 *    full queue (the whole card) for Decisions, Escalations, Keys, Pending
 *    changes and My tasks.
 *  - **Mentions**: what agents wrote you and @mentions of you.
 *  - **Updates**: news on what you follow and run, grouped per thing
 *    ("3 updates on ENG-12"); the Following chip lists every live follow.
 *    Which kinds arrive is the workspace's choice (Customize).
 *  - **Done**: what used to wait on you and how it ended (InboxHistory.tsx).
 *
 *  Numbers: the nav badge and "N need you" count open Needs-you items; the
 *  bell and "N unread" count unread rows in every section. Keyboard: ↑/↓ or
 *  j/k move, Enter or o opens, m marks read. */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useApp } from '../store';
import { api, type FeedItem, type FeedTypeInfo, type FollowRow, type OrgDetail } from '../lib/api';
import { followingList, type InboxItem } from '../lib/inbox';
import { INBOX_TABS, NEEDS_CHIPS, countLabel, inboxView, itemsOf, needsYouLabel, tabFilter, unreadLabel, type InboxTab } from '../lib/feed';
import { markFeedRead, reloadFeed, useFeed } from '../lib/feed-store';
import { I, P } from '../lib/icons';
import { btn, h2, faint, pill, ago } from './org-ui';
import { Approvals } from './OrganizationView';
import { FeedRow, useFeedAction, useOpenFeedItem } from './FeedRow';
import { navigate } from '../lib/routes';

const PlansPane = lazy(() => import('./OrgCapitalView').then((m) => ({ default: m.PlansPane })));
const MyTasksPane = lazy(() => import('./OrgPeopleView').then((m) => ({ default: m.MyTasksPane })));
const InboxHistory = lazy(() => import('./InboxHistory').then((m) => ({ default: m.InboxHistory })));

const EMPTY: Record<InboxTab, string> = {
  needs: 'Nothing needs you. Decisions, keys, pending changes, your tasks and reviews, what is blocked on you and incidents land here, and stay until they are resolved.',
  mentions: 'No mentions or messages. When an agent writes to you, or someone @mentions you in a channel, a thread or a task, it lands here.',
  updates: 'No updates. News on what you follow, failed runs, budgets, meetings, briefs, audits, hires and plugin recalls land here.',
  history: '',
};

/** A followed thread or task in the Following list. */
function FollowLine({ i, onOpen }: { i: InboxItem; onOpen: (i: InboxItem) => void }) {
  const f = i.follow;
  return (
    <button data-testid={`follow-item-${i.key}`} onClick={() => onOpen(i)}
      style={{ display: 'flex', width: '100%', textAlign: 'left', gap: 10, alignItems: 'flex-start', padding: '10px 14px', borderRadius: 10, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text)', font: 'inherit', boxSizing: 'border-box', opacity: !f.attention && f.unseen === 0 ? 0.75 : 1 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{i.title}</span>
        {f.attention && <span data-testid="follow-attention" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--amber)', marginTop: 2 }}>Needs you: {f.attention}</span>}
        <span style={{ display: 'block', ...faint, marginTop: 2, overflowWrap: 'anywhere' }}>{i.detail}</span>
      </span>
      <span style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <span style={faint}>{ago(i.at)}</span>
        {f.unseen > 0 && <span data-testid="follow-unseen" style={pill('var(--accent)', '#fff')}>{f.unseen} new</span>}
        {f.closed && <span style={pill()}>closed</span>}
      </span>
    </button>
  );
}

/** Which update kinds arrive (the workspace's `notify.*` tunables). */
function Customize({ wsId, onClose }: { wsId: string; onClose: () => void }) {
  const app = useApp();
  const [types, setTypes] = useState<FeedTypeInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.feedTypes(wsId).then(setTypes).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e))); }, [wsId]);
  const toggle = async (t: FeedTypeInfo) => {
    setTypes((l) => l?.map((x) => (x.type === t.type ? { ...x, on: !t.on } : x)) ?? l);
    try {
      await api.setOrgTunable(wsId, { key: t.key, value: t.on ? 0 : 1, why: `Inbox: ${t.on ? 'turned off' : 'turned on'} ${t.label} updates` });
      void reloadFeed(wsId);
    } catch (e) {
      setTypes((l) => l?.map((x) => (x.type === t.type ? { ...x, on: t.on } : x)) ?? l);
      app.showToast(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div role="dialog" aria-label="Which updates arrive" data-testid="inbox-customize" style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--panel)', padding: '12px 14px', marginTop: 10, maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>Which updates arrive</span>
        <button style={btn()} onClick={onClose}>Done</button>
      </div>
      <div style={{ ...faint, marginBottom: 8 }}>For this company, in the Inbox and the bell. Needs you and mentions always arrive.</div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{err}</div>}
      {!types && !err && <div style={faint}>Loading…</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 4 }}>
        {types?.map((t) => (
          <label key={t.type} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={t.on} onChange={() => void toggle(t)} data-testid={`notify-${t.type}`} style={{ marginTop: 2 }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{t.label}</span>
              <span style={{ display: 'block', ...faint, fontSize: 11.5 }}>{t.description}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function InboxView() {
  const app = useApp();
  const wsId = app.workspaceId;
  const { page, error } = useFeed(wsId);
  const open = useOpenFeedItem();
  const { busy, act } = useFeedAction();
  const view = inboxView(app.inboxFilter);
  const tab = view.tab;
  const chip = view.chip;
  const paneChip = NEEDS_CHIPS.find((c) => c.id === chip && c.pane);
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [follows, setFollows] = useState<FollowRow[] | null>(null);
  const [customize, setCustomize] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { setNow(new Date()); }, [page]);
  const owner = !app.me || app.me.role === 'owner';

  // The full queues need the company record; the Following list its follows.
  const loadOrg = useCallback(async () => { if (wsId) setOrg(await api.org(wsId).catch(() => null)); }, [wsId]);
  useEffect(() => { if (paneChip && !org) void loadOrg(); }, [paneChip, org, loadOrg]);
  useEffect(() => { setOrg(null); setFollows(null); }, [wsId]);
  useEffect(() => {
    if (chip !== 'following') return;
    api.followsMine(wsId).then(setFollows).catch(() => setFollows([]));
  }, [chip, wsId]);

  const list = useMemo(() => (tab === 'history' ? [] : itemsOf(page, tab, chip)), [page, tab, chip]);
  const counts = page?.counts;

  // ---- keyboard: ↑/↓ j/k move, Enter/o open, m mark read ----
  const [focus, setFocus] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setFocus(0); }, [tab, chip]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>, i: FeedItem, n: number) => {
    if (e.target !== e.currentTarget) return; // a button inside the row handles its own keys
    const move = (to: number) => {
      const next = Math.max(0, Math.min(list.length - 1, to));
      setFocus(next);
      (listRef.current?.querySelectorAll<HTMLElement>('[role="listitem"]')[next])?.focus();
    };
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); move(n + 1); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); move(n - 1); }
    else if (e.key === 'Enter' || e.key === 'o') { e.preventDefault(); open(i); }
    else if (e.key === 'm') { e.preventDefault(); void markFeedRead(wsId, [i]); }
  };

  const openFollow = (i: InboxItem) => {
    const f = i.follow;
    setFollows((l) => l?.map((r) => (r.targetKind === f.targetKind && r.targetId === f.targetId ? { ...r, unseenCount: 0, attentionAt: null, attention: '' } : r)) ?? l);
    void api.markFollowSeen(wsId, f.targetKind, f.targetId).then(() => { void reloadFeed(wsId); void app.refreshWsOrg(); }).catch(() => undefined);
    if (f.targetKind === 'org_task') app.openOrgTask(f.targetId);
    else if (f.link) navigate(f.link);
  };

  if (!app.companiesEnabled || !app.wsOrg || app.wsOrg.mode === 'off') {
    return <div style={{ flex: 1, padding: 24, ...faint }}>The Inbox gathers what waits on you when the workspace runs as a company — turn organization mode on in Settings › Company. The bell in the top bar still lists what needs you.</div>;
  }
  const tabCount = (t: InboxTab): { n: number; strong: boolean } | null => {
    if (!counts || t === 'history') return null;
    if (t === 'needs') return { n: counts.needsYou, strong: true };
    return { n: counts.sections[t].unread, strong: false };
  };
  const unreadHere = tab !== 'history' && list.some((i) => !i.read);
  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: app.stacked ? '12px 12px 8px' : '14px 16px 10px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <I d={P.inbox} size={18} />
          <h2 style={{ ...h2, flex: 1 }}>Inbox</h2>
          {counts && (
            <span data-testid="inbox-counts" style={{ ...faint, display: 'flex', alignItems: 'center', whiteSpace: 'pre' }}>
              <span title="Open items that wait on you until they are resolved (the Inbox badge)" style={{ color: counts.needsYou ? 'var(--amber)' : undefined, fontWeight: counts.needsYou ? 600 : 400 }}>{counts.needsYou ? needsYouLabel(counts.needsYou) : 'nothing needs you'}</span>
              <span aria-hidden>{' · '}</span>
              <span title="Unread rows in every section (the bell's count)">{unreadLabel(counts.unread)}</span>
            </span>
          )}
          {counts && counts.unread > 0 && <button style={btn()} data-testid="inbox-mark-all" onClick={() => void markFeedRead(wsId, 'all')}>Mark all read</button>}
          {owner && <button style={btn(customize)} aria-pressed={customize} data-testid="inbox-customize-toggle" onClick={() => setCustomize((v) => !v)} title="Choose which updates arrive">Customize</button>}
        </div>
        <div role="tablist" aria-label="Inbox sections" style={{ display: 'flex', gap: 2, marginTop: 10, overflowX: 'auto', borderBottom: '1px solid var(--border-soft)' }}>
          {INBOX_TABS.map((t) => {
            const c = tabCount(t.id);
            const on = tab === t.id;
            return (
              <button key={t.id} role="tab" aria-selected={on} data-testid={`inbox-tab-${t.id}`} title={t.hint} onClick={() => app.setInboxFilter(tabFilter(t.id))}
                style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', border: 'none', borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`, background: 'none', color: on ? 'var(--text)' : 'var(--text-dim)', font: 'inherit', fontSize: 13, fontWeight: on ? 700 : 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {t.label}
                {c && c.n > 0 && <span data-testid={`inbox-tab-count-${t.id}`} style={{ minWidth: 18, height: 18, borderRadius: 9, padding: '0 5px', boxSizing: 'border-box', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: c.strong ? 'var(--amber)' : 'var(--accent)', color: '#fff' }}>{countLabel(c.n)}</span>}
              </button>
            );
          })}
        </div>
        {tab === 'needs' && (
          <div role="group" aria-label="Show" style={{ display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto', paddingBottom: 2 }}>
            {NEEDS_CHIPS.map((c) => {
              const n = c.types.length ? itemsOf(page, 'needs', c.id).length : counts?.needsYou ?? 0;
              return <button key={c.id} aria-pressed={chip === c.id} data-testid={`inbox-chip-${c.id}`} onClick={() => app.setInboxFilter(c.id)} style={{ ...btn(chip === c.id), flex: 'none', whiteSpace: 'nowrap' }}>{c.label}{n > 0 ? ` · ${n}` : ''}</button>;
            })}
          </div>
        )}
        {tab === 'updates' && (
          <div role="group" aria-label="Show" style={{ display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto', paddingBottom: 2 }}>
            <button aria-pressed={chip !== 'following'} data-testid="inbox-chip-updates" onClick={() => app.setInboxFilter('updates')} style={{ ...btn(chip !== 'following'), flex: 'none' }}>All updates</button>
            <button aria-pressed={chip === 'following'} data-testid="inbox-chip-following" onClick={() => app.setInboxFilter('following')} style={{ ...btn(chip === 'following'), flex: 'none' }}>Everything I follow</button>
          </div>
        )}
        {customize && <Customize wsId={wsId} onClose={() => setCustomize(false)} />}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: app.stacked ? '8px 6px' : '12px 12px' }}>
        {error && !page && <div style={{ color: 'var(--red)', fontSize: 12.5, margin: '0 8px 10px' }}>{error}</div>}
        {tab === 'history' ? (
          <div style={{ padding: '4px 4px' }}>
            <Suspense fallback={<div style={faint}>Loading…</div>}>
              <InboxHistory onWaiting={(f) => app.setInboxFilter(f === 'all' ? 'needs' : f)} />
            </Suspense>
          </div>
        ) : paneChip ? (
          <div style={{ maxWidth: 820, padding: '4px 4px' }}>
            <button style={{ ...btn(), marginBottom: 10 }} data-testid="inbox-back" onClick={() => app.setInboxFilter('needs')}>← All that needs you</button>
            {!org ? <div style={faint}>Loading…</div> : (
              <Suspense fallback={<div style={faint}>Loading…</div>}>
                {paneChip.pane === 'approvals' && <Approvals org={org} reload={async () => { await loadOrg(); void reloadFeed(wsId); }} />}
                {paneChip.pane === 'plans' && <PlansPane org={org} />}
                {paneChip.pane === 'mytasks' && <MyTasksPane org={org} />}
              </Suspense>
            )}
          </div>
        ) : chip === 'following' ? (
          <div style={{ maxWidth: 820 }} data-testid="following-list">
            {follows === null ? <div style={{ ...faint, padding: 8 }}>Loading…</div> : follows.length === 0
              ? <div style={{ ...faint, padding: 8 }}>You follow nothing yet. Threads you start or reply to and tasks you create, own or review are followed for you; the Follow button on a thread or a task adds any other.</div>
              : followingList(follows).map((i) => <FollowLine key={i.key} i={i} onOpen={openFollow} />)}
          </div>
        ) : !page ? <div style={{ ...faint, padding: 8 }}>Loading…</div> : (
          <div style={{ maxWidth: 820 }}>
            {unreadHere && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 6px 6px' }}>
                <button style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }} data-testid="inbox-mark-section"
                  onClick={() => void markFeedRead(wsId, chip !== tab && tab === 'needs' ? list : tab)}>
                  Mark these read
                </button>
              </div>
            )}
            {list.length === 0 ? (
              <div data-testid="inbox-empty" style={{ ...faint, padding: '18px 10px', lineHeight: 1.5 }}>
                {chip === 'incidents' ? 'No open incidents. Contained and resolved ones are in Operations › Incidents.' : EMPTY[tab]}
              </div>
            ) : (
              <div role="list" ref={listRef} data-testid={`inbox-list-${tab}`} aria-label={`${INBOX_TABS.find((t) => t.id === tab)!.label}: ↑ ↓ to move, Enter to open, m to mark read`}>
                {list.map((i, n) => (
                  <FeedRow key={i.id} item={i} now={now} onOpen={open} onMarkRead={(x) => void markFeedRead(wsId, [x])} onAction={(x, a) => void act(x, a)} busy={busy.has(i.id)}
                    tabIndex={n === Math.min(focus, list.length - 1) ? 0 : -1} onKeyDown={(e) => onKey(e, i, n)} />
                ))}
              </div>
            )}
            {chip === 'incidents' && <button style={{ ...btn(), margin: '6px 8px' }} onClick={() => { app.setOrgFocus(null); app.setOrgUnitId(null); app.setOrgPane('incidents'); }}>All incidents in Operations</button>}
            {tab === 'needs' && list.length > 0 && <div style={{ ...faint, padding: '10px 10px 0', fontSize: 11.5 }}>Read items stay here until they are resolved. ↑ ↓ to move · Enter to open · m to mark read.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
