/** The Inbox's History (docs/home.md "Inbox"): everything that used to wait
 *  on me and is resolved, newest first — what it was, how it ended, who
 *  resolved it (me, a person, a delegate, the default at the deadline, an
 *  agent) and when — with the Inbox's filters, a search, a date window and
 *  "Decided without you" for auditing defaults and delegates. A row opens
 *  the record; where an existing route walks a resolution back (revoke the
 *  delegation that decided it, reopen a task) the row offers it. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { api, type HistoryItem } from '../lib/api';
import { HISTORY_RANGES, INBOX_FILTERS, OUTCOME_LABEL, historyBy, historyFrom, historyTarget, outcomeColor, type InboxFilter } from '../lib/inbox';
import { card, btn, pill, faint, ago } from './org-ui';

const KIND_LABEL: Record<HistoryItem['kind'], string> = {
  approvals: 'approval', keys: 'key', escalations: 'escalation', plans: 'plan', mytasks: 'task', incidents: 'incident', following: 'following',
};
const PAGE = 30;

function HistoryRow({ i, onOpen, onUndo }: { i: HistoryItem; onOpen: (i: HistoryItem) => void; onUndo: (i: HistoryItem) => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const color = outcomeColor(i.outcome);
  return (
    <div data-testid={`history-item-${i.key}`} style={{ ...card, padding: 0, marginBottom: 8, borderLeft: `3px solid ${i.withoutYou ? 'var(--amber)' : color}`, overflow: 'hidden' }}>
      <button onClick={() => onOpen(i)} style={{ display: 'flex', width: '100%', textAlign: 'left', gap: 10, alignItems: 'flex-start', padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', font: 'inherit', boxSizing: 'border-box' }}>
        <span style={{ ...pill(), flex: 'none' }}>{KIND_LABEL[i.kind]}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{i.title}</span>
          {i.detail && <span style={{ display: 'block', ...faint, marginTop: 2, overflowWrap: 'anywhere' }}>{i.detail}</span>}
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <span data-testid="history-outcome" style={pill(color, '#fff')}>{OUTCOME_LABEL[i.outcome]}</span>
            <span data-testid="history-by" style={{ ...faint, overflowWrap: 'anywhere' }}>{historyBy(i)}</span>
            {i.withoutYou && <span data-testid="history-without-you" title="A default or a delegate decided this, not you" style={pill('var(--amber)', '#fff')}>decided without you</span>}
          </span>
        </span>
        <span style={{ ...faint, flex: 'none' }} title={i.at}>{ago(i.at)}</span>
      </button>
      {i.undo && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '0 14px 10px' }}>
          {confirm && <button style={btn()} onClick={() => setConfirm(false)}>Cancel</button>}
          <button data-testid="history-undo" disabled={busy} style={btn(false, confirm)}
            onClick={async () => {
              if (!confirm) { setConfirm(true); return; }
              setBusy(true);
              try { await onUndo(i); } finally { setBusy(false); setConfirm(false); }
            }}>
            {confirm ? `Confirm: ${i.undo.label}` : i.undo.label}
          </button>
        </div>
      )}
    </div>
  );
}

export function InboxHistory({ onWaiting }: { onWaiting: (f: InboxFilter) => void }) {
  const app = useApp();
  const wsId = app.workspaceId;
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [days, setDays] = useState(30);
  const [without, setWithout] = useState(false);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const req = useRef(0);

  // The search waits for a pause in typing.
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 250); return () => clearTimeout(t); }, [text]);

  const load = useCallback(async (after: string | null) => {
    if (!wsId) return;
    const n = ++req.current;
    setLoading(true);
    try {
      const page = await api.inboxHistory(wsId, { kind: filter === 'all' ? undefined : filter, q: q || undefined, from: historyFrom(days), without: without || undefined, cursor: after ?? undefined, limit: PAGE });
      if (n !== req.current) return;
      setItems((prev) => (after && prev ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setErr(null);
    } catch (e) {
      if (n === req.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === req.current) setLoading(false);
    }
  }, [wsId, filter, q, days, without]);
  useEffect(() => { setItems(null); setCursor(null); void load(null); }, [load]);

  const open = (i: HistoryItem) => {
    const t = historyTarget(i);
    if (!t) return;
    switch (t.to) {
      case 'task': app.openOrgTask(t.taskId); return;
      case 'chat': app.openSession(t.sessionId); return;
      case 'inbox': onWaiting(t.filter); return;
      case 'pane': app.setOrgFocus(t.focus); app.setOrgUnitId(null); app.setOrgPane(t.pane); app.setMobileDetail(true); return;
      case 'hash': window.location.hash = t.hash; return;
    }
  };
  const undo = async (i: HistoryItem) => {
    if (!i.undo) return;
    try {
      if (i.undo.kind === 'revoke_delegation') { await api.revokeOrgDelegation(wsId, i.undo.delegationId); app.showToast('Delegation revoked — those cards come to you again'); }
      else { await api.updateOrgTask(wsId, i.undo.taskId, { status: 'todo' }); app.showToast('Task reopened'); void app.refreshWsOrg(); }
      await load(null);
    } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); }
  };

  const filtered = filter !== 'all' || q || without;
  return (
    <div style={{ maxWidth: 820 }} data-testid="history-list">
      <div role="tablist" aria-label="History filters" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2, marginBottom: 10 }}>
        {INBOX_FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)} style={{ ...btn(filter === f.id), flex: 'none', whiteSpace: 'nowrap' }}>{f.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input type="search" aria-label="Search history" placeholder="Search history" value={text} onChange={(e) => setText(e.target.value)}
          style={{ flex: '1 1 180px', minWidth: 0, boxSizing: 'border-box', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)', font: 'inherit', fontSize: 13 }} />
        <select aria-label="Date range" value={days} onChange={(e) => setDays(Number(e.target.value))}
          style={{ flex: 'none', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)', font: 'inherit', fontSize: 13 }}>
          {HISTORY_RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
        </select>
        <button aria-pressed={without} onClick={() => setWithout(!without)} style={{ ...btn(without), flex: 'none', whiteSpace: 'nowrap' }} title="Only what a default or a delegate decided">Decided without you</button>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
      {items === null ? <div style={faint}>Loading…</div> : items.length === 0 ? (
        <div data-testid="history-empty" style={faint}>
          {filtered ? 'Nothing matches — try another filter, a wider date range or a different search.'
            : `Nothing resolved in ${days ? `the last ${days} days` : 'this workspace yet'}. Decisions, keys, plans, incidents, your tasks and threads you looked at land here once they are done.`}
        </div>
      ) : items.map((i) => <HistoryRow key={i.key} i={i} onOpen={open} onUndo={undo} />)}
      {cursor && items && (
        <button data-testid="history-more" disabled={loading} onClick={() => void load(cursor)} style={{ ...btn(), width: '100%', marginTop: 4 }}>{loading ? 'Loading…' : 'Load more'}</button>
      )}
    </div>
  );
}
