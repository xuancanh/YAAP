/** The Inbox (docs/owners-seat.md "Inbox and notifications"): the owner's
 *  feed in full — the same page the bell shows, so the two never disagree.
 *
 *  Two-pane triage on a wide screen: a compact list on the left (one line
 *  of title, one of who · kind · context, the time, an unread dot, a quiet
 *  deadline badge), and the reading pane on the right (InboxDetail.tsx) with
 *  the whole item and its actions. A phone (or a narrow window) shows the
 *  list, and an item full screen with Back. The open item is in the
 *  address (`/<company>/inbox/<filter>/<item>`), so it can be shared.
 *
 *  - **Needs you**: what waits on you until it is resolved, urgent first
 *    (critical, or a default due within 6 hours). Chips narrow it to one
 *    kind (only kinds that have items show); a kind's full queue (the
 *    Approvals pane, Pending changes, My tasks) is one click from its chip.
 *  - **Mentions**: what agents wrote you and @mentions of you.
 *  - **Updates**: news on what you follow and run, grouped per thing
 *    ("Writer's runs failed 3 times"); the Following chip lists every live
 *    follow. Which kinds arrive is the workspace's choice (the ⋯ menu).
 *  - **Done**: what used to wait on you and how it ended (InboxHistory.tsx).
 *
 *  Numbers sit on the tabs: Needs you counts its open items (the nav badge),
 *  Mentions and Updates their unread rows (together, the bell). Keyboard:
 *  j/k or ↑/↓ move, Enter opens in the pane, o opens where it lives, m marks
 *  read, e marks read and moves on, Esc closes the pane; a/r approve or
 *  reject only while an item is open in the pane. */
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useApp } from '../store';
import { api, type FeedAction, type FeedItem, type FeedTypeInfo, type FollowRow, type OrgDetail } from '../lib/api';
import { followingList, type InboxItem } from '../lib/inbox';
import { INBOX_TABS, NEEDS_CHIPS, countLabel, feedOpen, inboxGroups, inboxView, itemsOf, needsYouLabel, tabFilter, unreadLabel, visibleChips, yesNo, type InboxTab } from '../lib/feed';
import { markFeedRead, reloadFeed, useFeed } from '../lib/feed-store';
import { I, P } from '../lib/icons';
import { btn, faint, pill, ago } from './org-ui';
import { Approvals } from './OrganizationView';
import { FeedRow, useFeedAction, useOpenFeedItem } from './FeedRow';
import { InboxDetail, InboxPaneEmpty } from './InboxDetail';
import { navigate } from '../lib/routes';

const PlansPane = lazy(() => import('./OrgCapitalView').then((m) => ({ default: m.PlansPane })));
const MyTasksPane = lazy(() => import('./OrgPeopleView').then((m) => ({ default: m.MyTasksPane })));
const InboxHistory = lazy(() => import('./InboxHistory').then((m) => ({ default: m.InboxHistory })));

/** The pane sits beside the list from this width of the Inbox itself. */
const TWO_PANE_MIN = 860;

const EMPTY: Record<Exclude<InboxTab, 'history'>, { title: string; text: string }> = {
  needs: { title: 'You\'re clear', text: 'Nothing waits on you. Decisions, escalations, keys, your tasks and reviews land here and stay until they are resolved.' },
  mentions: { title: 'No mentions', text: 'When an agent writes to you, or someone @mentions you in a channel, a thread or a task, it lands here.' },
  updates: { title: 'No news', text: 'News on what you follow, failed runs, budgets, meetings, briefs and hires lands here.' },
};

/** The Inbox's own width (the pane needs room, whatever the window). */
function useWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    setW(el.getBoundingClientRect().width || fallback);
    const ro = new ResizeObserver((entries) => { const r = entries[0]?.contentRect; if (r) setW(r.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return w;
}

/** A followed thread or task in the Following list. */
function FollowLine({ i, onOpen }: { i: InboxItem; onOpen: (i: InboxItem) => void }) {
  const f = i.follow;
  return (
    <button data-testid={`follow-item-${i.key}`} onClick={() => onOpen(i)} className="ibx-follow" style={{ opacity: !f.attention && f.unseen === 0 ? 0.75 : 1 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{i.title}</span>
        {f.attention && <span data-testid="follow-attention" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--amber)', marginTop: 2 }}>Needs you: {f.attention}</span>}
        <span style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginTop: 2, overflowWrap: 'anywhere' }}>{i.detail}</span>
      </span>
      <span style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{ago(i.at)}</span>
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
    <div role="dialog" aria-label="Which updates arrive" data-testid="inbox-customize" className="ibx-customize">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 650 }}>Which updates arrive</span>
        <button style={btn()} onClick={onClose}>Done</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>For this company, in the Inbox and the bell. Needs you and mentions always arrive.</div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{err}</div>}
      {!types && !err && <div style={faint}>Loading…</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 2 }}>
        {types?.map((t) => (
          <label key={t.type} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={t.on} onChange={() => void toggle(t)} data-testid={`notify-${t.type}`} style={{ marginTop: 2 }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{t.label}</span>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-dim)' }}>{t.description}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** The header's ⋯ menu: mark read, which updates arrive, the keys. */
function HeaderMenu({ items }: { items: Array<{ id: string; label: string; run: () => void; hidden?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  const shown = items.filter((x) => !x.hidden);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="ibx-iconbtn" aria-haspopup="menu" aria-expanded={open} aria-label="Inbox options" data-testid="inbox-menu" onClick={() => setOpen((v) => !v)}>
        <I d={P.dots} size={17} sw={2} />
      </button>
      {open && (
        <div role="menu" className="ibx-menu">
          {shown.map((x) => (
            <button key={x.id} role="menuitem" type="button" data-testid={x.id} onClick={() => { setOpen(false); x.run(); }}>{x.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

export function InboxView() {
  const app = useApp();
  const wsId = app.workspaceId;
  const { page, error } = useFeed(wsId);
  const openWhere = useOpenFeedItem();
  const { busy, act } = useFeedAction();
  const view = inboxView(app.inboxFilter);
  const tab = view.tab;
  const chip = view.chip;
  const [queue, setQueue] = useState(false);
  const paneChip = NEEDS_CHIPS.find((c) => c.id === chip && c.pane);
  const showQueue = Boolean(queue && paneChip);
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [follows, setFollows] = useState<FollowRow[] | null>(null);
  const [customize, setCustomize] = useState(false);
  const [keysHelp, setKeysHelp] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { setNow(new Date()); }, [page]);
  const owner = !app.me || app.me.role === 'owner';
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef, typeof app.width === 'number' ? app.width - 72 : 1200);
  const twoPane = !app.stacked && width >= TWO_PANE_MIN;

  // The full queues need the company record; the Following list its follows.
  const loadOrg = useCallback(async () => { if (wsId) setOrg(await api.org(wsId).catch(() => null)); }, [wsId]);
  useEffect(() => { if (showQueue && !org) void loadOrg(); }, [showQueue, org, loadOrg]);
  useEffect(() => { setOrg(null); setFollows(null); }, [wsId]);
  useEffect(() => {
    if (chip !== 'following') return;
    api.followsMine(wsId).then(setFollows).catch(() => setFollows([]));
  }, [chip, wsId]);

  const list = useMemo(() => (tab === 'history' ? [] : itemsOf(page, tab, chip)), [page, tab, chip]);
  const groups = useMemo(() => (tab === 'history' ? [] : inboxGroups(list, tab, now)), [list, tab, now]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const counts = page?.counts;

  // ---- the open item: the address's, or (wide) the first row as a preview ----
  const explicit = app.inboxItem ? flat.find((i) => i.id === app.inboxItem) ?? page?.items.find((i) => i.id === app.inboxItem) ?? null : null;
  const listMode = tab !== 'history' && chip !== 'following' && !showQueue;
  const selected = listMode ? explicit ?? (twoPane ? flat[0] ?? null : null) : null;
  // Opening an item reads it (a preview does not).
  const readOnce = useRef('');
  useEffect(() => {
    if (!explicit || explicit.read || readOnce.current === explicit.id) return;
    readOnce.current = explicit.id;
    void markFeedRead(wsId, [explicit]);
  }, [explicit, wsId]);

  const listRef = useRef<HTMLDivElement>(null);
  const rowEl = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-testid="feed-row-${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&')}"]`) ?? null;
  // Keep the open row in view.
  useEffect(() => { if (selected) rowEl(selected.id)?.scrollIntoView?.({ block: 'nearest' }); }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (i: FeedItem | null, opts: { replace?: boolean } = {}) => app.setInboxItem(i ? i.id : null, opts);
  const go = (i: FeedItem) => {
    const t = feedOpen(i);
    if (t.to === 'queue') { app.setInboxFilter(t.filter); setQueue(true); return; }
    openWhere(i);
  };
  const decide = async (i: FeedItem, a: FeedAction, note?: string) => {
    const at = flat.findIndex((x) => x.id === i.id);
    const next = flat[at + 1] ?? flat[at - 1] ?? null;
    const ok = await act(i, a, note);
    if (ok && app.inboxItem === i.id) select(next, { replace: true });
  };
  const setTab = (t: InboxTab) => { setQueue(false); app.setInboxFilter(tabFilter(t)); };
  const setChip = (f: Parameters<typeof app.setInboxFilter>[0]) => { setQueue(false); app.setInboxFilter(f); };

  // ---- the keyboard ----
  const focusedIndex = () => {
    const el = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[role="listitem"]') : null;
    const id = el?.dataset.testid?.replace(/^feed-row-/, '');
    const n = id ? flat.findIndex((x) => x.id === id) : -1;
    return n >= 0 ? n : selected ? flat.findIndex((x) => x.id === selected.id) : -1;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!listMode || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const onButton = e.target instanceof HTMLElement && e.target.tagName === 'BUTTON';
    const n = focusedIndex();
    const cur = n >= 0 ? flat[n] : null;
    const move = (to: number) => {
      const next = flat[Math.max(0, Math.min(flat.length - 1, to))];
      if (!next) return;
      if (twoPane) select(next, { replace: Boolean(app.inboxItem) });
      rowEl(next.id)?.focus();
    };
    switch (e.key) {
      case 'ArrowDown': case 'j': e.preventDefault(); move(n + 1); return;
      case 'ArrowUp': case 'k': e.preventDefault(); move(n < 0 ? 0 : n - 1); return;
      case 'Enter':
        if (onButton || !cur) return;
        e.preventDefault(); select(cur); return;
      case 'o': if (cur) { e.preventDefault(); go(cur); } return;
      case 'm': if (cur) { e.preventDefault(); void markFeedRead(wsId, [cur]); } return;
      case 'e': if (cur) { e.preventDefault(); void markFeedRead(wsId, [cur]); move(n + 1); } return;
      case 'Escape': if (app.inboxItem) { e.preventDefault(); select(null); } return;
      case 'a': case 'r': {
        // Decide only with the item open in the pane, never from the list.
        if (!explicit || busy.has(explicit.id)) return;
        const { yes, no } = yesNo(explicit);
        const a = e.key === 'a' ? yes : no;
        if (!a || (explicit.type === 'escalation')) return; // an escalation is answered in its box
        e.preventDefault(); void decide(explicit, a);
        return;
      }
      case '?': e.preventDefault(); setKeysHelp((v) => !v); return;
    }
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
  const tabCount = (t: InboxTab): { n: number; tone: 'warn' | 'strong' | 'soft' } | null => {
    if (!counts || t === 'history') return null;
    if (t === 'needs') return { n: counts.needsYou, tone: counts.urgent > 0 ? 'warn' : 'strong' };
    return { n: counts.sections[t].unread, tone: 'soft' };
  };
  const unreadHere = tab !== 'history' && list.some((i) => !i.read);
  const chips = tab === 'needs' ? visibleChips(page, chip) : [];

  // ---- the phone (or a narrow Inbox): an open item fills the screen ----
  if (!twoPane && listMode && explicit) {
    return (
      <div ref={rootRef} className="ibx-root" onKeyDown={onKey} data-testid="inbox-root">
        <InboxDetail item={explicit} now={now} stacked busy={busy.has(explicit.id)} onBack={() => select(null)}
          onAct={(i, a, note) => void decide(i, a, note)} onGo={go} onMarkRead={(i) => void markFeedRead(wsId, [i])} onTask={(id) => app.openOrgTask(id)} />
      </div>
    );
  }

  const header = (
    <div className="ibx-head">
      <div className="ibx-head-row">
        <h2 className="ibx-h2">Inbox</h2>
        <span className="ibx-sr" aria-live="polite" data-testid="inbox-counts">
          {counts ? `${counts.needsYou ? needsYouLabel(counts.needsYou) : 'nothing needs you'} · ${unreadLabel(counts.unread)}` : ''}
        </span>
        <span className="ibx-spacer" />
        <HeaderMenu items={[
          { id: 'inbox-mark-section', label: `Mark ${tab === 'needs' ? 'Needs you' : tab === 'mentions' ? 'Mentions' : 'Updates'} read`, hidden: !unreadHere, run: () => void markFeedRead(wsId, chip !== tab && tab === 'needs' ? list : tab as 'needs' | 'mentions' | 'updates') },
          { id: 'inbox-mark-all', label: 'Mark everything read', hidden: !counts || counts.unread === 0, run: () => void markFeedRead(wsId, 'all') },
          { id: 'inbox-customize-toggle', label: 'Choose which updates arrive', hidden: !owner, run: () => setCustomize(true) },
          { id: 'inbox-keys', label: 'Keyboard shortcuts', hidden: app.stacked, run: () => setKeysHelp((v) => !v) },
        ]} />
      </div>
      <div role="tablist" aria-label="Inbox sections" className="ibx-tabs">
        {INBOX_TABS.map((t) => {
          const c = tabCount(t.id);
          const on = tab === t.id;
          return (
            <button key={t.id} role="tab" aria-selected={on} data-testid={`inbox-tab-${t.id}`} title={t.hint} onClick={() => setTab(t.id)} className={`ibx-tab${on ? ' on' : ''}`}
              aria-label={c && c.n > 0 ? `${t.label}, ${c.n} ${t.id === 'needs' ? 'open' : 'unread'}` : t.label}>
              {t.label}
              {c && c.n > 0 && <span data-testid={`inbox-tab-count-${t.id}`} className={`ibx-count ${c.tone}`}>{countLabel(c.n)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );

  const chipRow = (tab === 'needs' && chips.length > 1) ? (
    <div role="group" aria-label="Show" className="ibx-chips">
      {chips.map((c) => (
        <button key={c.id} type="button" aria-pressed={chip === c.id} data-testid={`inbox-chip-${c.id}`} onClick={() => setChip(c.id)} className={`ibx-chip${chip === c.id ? ' on' : ''}`}>
          {c.label}{c.n > 0 && <span className="ibx-chip-n">{c.n}</span>}
        </button>
      ))}
    </div>
  ) : tab === 'updates' ? (
    <div role="group" aria-label="Show" className="ibx-chips">
      <button type="button" aria-pressed={chip !== 'following'} data-testid="inbox-chip-updates" onClick={() => setChip('updates')} className={`ibx-chip${chip !== 'following' ? ' on' : ''}`}>All updates</button>
      <button type="button" aria-pressed={chip === 'following'} data-testid="inbox-chip-following" onClick={() => setChip('following')} className={`ibx-chip${chip === 'following' ? ' on' : ''}`}>Everything I follow</button>
    </div>
  ) : null;

  const otherTab = tab === 'needs' && counts ? (counts.sections.mentions.unread ? 'mentions' : counts.sections.updates.unread ? 'updates' : null) : null;
  const empty = tab !== 'history' ? (
    <div data-testid="inbox-empty" className="ibx-empty">
      <span className={`ibx-empty-mark${tab === 'needs' ? ' ok' : ''}`} aria-hidden><I d={tab === 'needs' ? P.check : P.inbox} size={20} sw={2} /></span>
      <p className="ibx-empty-title">{chip === 'incidents' ? 'No open incidents' : EMPTY[tab].title}</p>
      <p className="ibx-empty-text">{chip === 'incidents' ? 'Contained and resolved ones are in Operations › Incidents.' : chip !== tab && tab === 'needs' ? 'Nothing of this kind waits on you.' : EMPTY[tab].text}</p>
      {otherTab && counts && chip === 'needs' && (
        <button type="button" className="ibx-linkbtn" onClick={() => setTab(otherTab)}>
          Read the {counts.sections[otherTab].unread} unread {otherTab === 'mentions' ? `mention${counts.sections.mentions.unread === 1 ? '' : 's'}` : `update${counts.sections.updates.unread === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  ) : null;

  const rows = (
    <div role="list" ref={listRef} data-testid={`inbox-list-${tab}`} className="ibx-list"
      aria-label={`${INBOX_TABS.find((t) => t.id === tab)!.label}: j and k to move, Enter to open, m to mark read`}>
      {groups.map((g) => (
        <div key={g.id} role="presentation">
          {g.label && <div role="presentation" className={`ibx-group${g.id === 'urgent' ? ' urgent' : ''}`}>{g.label}</div>}
          {g.items.map((i) => {
            const on = selected?.id === i.id;
            const stop = selected ? on : flat[0]?.id === i.id;
            return (
              <FeedRow key={i.id} item={i} now={now} selected={on && (twoPane || Boolean(explicit))} onOpen={(x) => select(x)} onGo={go}
                onMarkRead={(x) => void markFeedRead(wsId, [x])} tabIndex={stop ? 0 : -1} />
            );
          })}
        </div>
      ))}
    </div>
  );

  const listColumn = (
    <div className={`ibx-col${twoPane ? ' side' : ''}`}>
      {chipRow}
      <div className="ibx-scroll">
        {error && !page && <div style={{ color: 'var(--red)', fontSize: 12.5, margin: '8px 12px' }}>{error}</div>}
        {chip === 'following' ? (
          <div data-testid="following-list" style={{ padding: '4px 6px' }}>
            {follows === null ? <div style={{ ...faint, padding: 8 }}>Loading…</div> : follows.length === 0
              ? <div className="ibx-empty"><p className="ibx-empty-title">You follow nothing yet</p><p className="ibx-empty-text">Threads you start or reply to and tasks you create, own or review are followed for you; the Follow button on a thread or a task adds any other.</p></div>
              : followingList(follows).map((i) => <FollowLine key={i.key} i={i} onOpen={openFollow} />)}
          </div>
        ) : !page ? <div style={{ ...faint, padding: 14 }}>Loading…</div> : list.length === 0 ? empty : rows}
        {listMode && paneChip && list.length > 0 && (
          <button type="button" className="ibx-linkbtn" style={{ margin: '10px 16px' }} data-testid="inbox-queue" onClick={() => setQueue(true)}>Open the full {paneChip.label} queue</button>
        )}
        {listMode && chip === 'incidents' && (
          <button type="button" className="ibx-linkbtn" style={{ margin: '10px 16px' }} onClick={() => { app.setOrgFocus(null); app.setOrgUnitId(null); app.setOrgPane('incidents'); }}>All incidents in Operations</button>
        )}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="ibx-root" onKeyDown={onKey} data-testid="inbox-root">
      {header}
      {customize && <Customize wsId={wsId} onClose={() => setCustomize(false)} />}
      {keysHelp && (
        <div className="ibx-keys" role="note" data-testid="inbox-keys-help">
          <span><kbd className="ibx-kbd">J</kbd><kbd className="ibx-kbd">K</kbd> move</span>
          <span><kbd className="ibx-kbd">Enter</kbd> open</span>
          <span><kbd className="ibx-kbd">O</kbd> open where it lives</span>
          <span><kbd className="ibx-kbd">M</kbd> mark read</span>
          <span><kbd className="ibx-kbd">E</kbd> done, next</span>
          <span><kbd className="ibx-kbd">A</kbd><kbd className="ibx-kbd">R</kbd> approve, reject (item open)</span>
          <span><kbd className="ibx-kbd">Esc</kbd> close</span>
          <button type="button" className="ibx-linkbtn" onClick={() => setKeysHelp(false)}>Hide</button>
        </div>
      )}
      {tab === 'history' ? (
        <div className="ibx-scroll" style={{ padding: app.stacked ? '12px' : '16px 20px' }}>
          <Suspense fallback={<div style={faint}>Loading…</div>}>
            <InboxHistory onWaiting={(f) => app.setInboxFilter(f === 'all' ? 'needs' : f)} />
          </Suspense>
        </div>
      ) : showQueue && paneChip ? (
        <div className="ibx-scroll" style={{ padding: app.stacked ? '12px' : '16px 20px' }}>
          <div style={{ maxWidth: 860 }}>
            <button className="ibx-ghost" style={{ marginBottom: 10 }} data-testid="inbox-back" onClick={() => setQueue(false)}><I d={P.chevL} size={15} sw={2} /> Back to the list</button>
            {!org ? <div style={faint}>Loading…</div> : (
              <Suspense fallback={<div style={faint}>Loading…</div>}>
                {paneChip.pane === 'approvals' && <Approvals org={org} reload={async () => { await loadOrg(); void reloadFeed(wsId); }} />}
                {paneChip.pane === 'plans' && <PlansPane org={org} />}
                {paneChip.pane === 'mytasks' && <MyTasksPane org={org} />}
              </Suspense>
            )}
          </div>
        </div>
      ) : (
        <div className={`ibx-body${twoPane ? ' two' : ''}`}>
          {listColumn}
          {twoPane && listMode && (
            <div className="ibx-pane" data-testid="inbox-pane">
              {selected ? (
                <InboxDetail item={selected} now={now} stacked={false} busy={busy.has(selected.id)} onBack={explicit ? () => select(null) : undefined}
                  onAct={(i, a, note) => void decide(i, a, note)} onGo={go} onMarkRead={(i) => void markFeedRead(wsId, [i])} onTask={(id) => app.openOrgTask(id)} />
              ) : <InboxPaneEmpty clear={list.length === 0} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
