/** The Inbox (docs/company-vision.md §8 "The CEO's seat"): everything
 *  waiting on the CEO in one list — decision cards, actions waiting for the
 *  owner's key, escalations, plans awaiting a veto, my tasks and reviews,
 *  open incidents, and what changed on the threads and tasks I follow
 *  (docs/follows.md) — with filters; a filter opens the full pane for that
 *  kind (the full artifact, never a summary). Incidents are the exception:
 *  the open ones are listed here and handled in Operations › Incidents, the
 *  one incident page. A task opens through its deep
 *  link (`#/ws/<id>/org/board?task=<id>`). The History toggle shows what
 *  used to wait on me and how it ended (InboxHistory.tsx). */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type AgentMessage, type FollowRow, type OrgApproval, type OrgDetail, type OrgPlan, type OrgTask } from '../lib/api';
import { buildInbox, filterInbox, followingList, messagesList, waitingCount, INBOX_FILTERS, type InboxFilter, type InboxItem, type InboxMode } from '../lib/inbox';
import { I, P } from '../lib/icons';
import { card, btn, pill, h2, faint, ago } from './org-ui';
import { Approvals } from './OrganizationView';
import { MentionText, useMentionables } from './MentionBox';
import type { MentionCandidate } from '../lib/channels';

const PlansPane = lazy(() => import('./OrgCapitalView').then((m) => ({ default: m.PlansPane })));
const MyTasksPane = lazy(() => import('./OrgPeopleView').then((m) => ({ default: m.MyTasksPane })));
const InboxHistory = lazy(() => import('./InboxHistory').then((m) => ({ default: m.InboxHistory })));

const KIND_COLOR: Record<InboxItem['kind'], string> = {
  messages: 'var(--blue)', approvals: 'var(--amber)', keys: 'var(--amber)', escalations: 'var(--red)', plans: 'var(--blue)', mytasks: 'var(--accent)', incidents: 'var(--red)', following: 'var(--green)',
};
const KIND_LABEL: Record<InboxItem['kind'], string> = {
  messages: 'message', approvals: 'approval', keys: 'key', escalations: 'escalation', plans: 'plan', mytasks: 'task', incidents: 'incident', following: 'following',
};

function Row({ i, onOpen, members = [] }: { i: InboxItem; onOpen: (i: InboxItem) => void; members?: MentionCandidate[] }) {
  const f = i.follow;
  const m = i.message;
  const color = f?.attention || m?.urgency === 'urgent' ? (m ? 'var(--red)' : 'var(--amber)') : KIND_COLOR[i.kind];
  return (
    <button data-testid={`inbox-item-${i.key}`} onClick={() => onOpen(i)}
      style={{ ...card, display: 'flex', width: '100%', textAlign: 'left', gap: 10, alignItems: 'flex-start', marginBottom: 8, cursor: 'pointer', borderLeft: `3px solid ${color}`, color: 'var(--text)', font: 'inherit', boxSizing: 'border-box', opacity: (f && !f.attention && f.unseen === 0) || m?.read ? 0.75 : 1 }}>
      <span style={{ ...pill(KIND_COLOR[i.kind], '#fff'), flex: 'none' }}>{KIND_LABEL[i.kind]}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{i.title}</span>
        {f?.attention && <span data-testid="follow-attention" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--amber)', marginTop: 2, overflowWrap: 'anywhere' }}>Needs you: {f.attention}</span>}
        {i.detail && <span style={{ display: 'block', ...faint, marginTop: 2, overflowWrap: 'anywhere' }}><MentionText text={i.detail} members={members} /></span>}
      </span>
      <span style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        {i.at && <span style={faint}>{ago(i.at)}</span>}
        {f && f.unseen > 0 && <span data-testid="follow-unseen" title={`${f.unseen} new since you looked`} style={pill('var(--accent)', '#fff')}>{f.unseen} new</span>}
        {f?.closed && <span style={pill()}>closed</span>}
        {m && !m.read && <span data-testid="message-unread" style={pill('var(--accent)', '#fff')}>new</span>}
        {m && m.urgency !== 'normal' && <span data-testid="message-urgency" style={m.urgency === 'urgent' ? pill('var(--red)', '#fff') : pill()}>{m.urgency}</span>}
      </span>
    </button>
  );
}

export function InboxView() {
  const app = useApp();
  const wsId = app.workspaceId;
  // @mentions in task comments (docs/work-tracking.md "Mentions") render as chips in the rows.
  const members = useMentionables(app.companiesEnabled && app.wsOrg && app.wsOrg.mode !== 'off' ? wsId : null);
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [src, setSrc] = useState<{ approvals: OrgApproval[]; plans: OrgPlan[]; tasks: { assigned: OrgTask[]; reviewing: OrgTask[] } | null; follows: FollowRow[]; messages: AgentMessage[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Waiting (the default) or History (docs/home.md "Inbox"). */
  const [mode, setMode] = useState<InboxMode>('waiting');
  // A filter picked from elsewhere (Home, a Company link) is a Waiting view.
  useEffect(() => { setMode('waiting'); }, [app.inboxFilter]);
  const reload = useCallback(async () => {
    if (!wsId) return;
    try {
      const [o, approvals, plans, tasks, follows, messages] = await Promise.all([
        api.org(wsId), api.orgApprovals(wsId, 'pending').catch((): OrgApproval[] => []), api.orgPlans(wsId, 'pending').catch((): OrgPlan[] => []), api.orgMyTasks(wsId).catch(() => null),
        api.followsMine(wsId).catch((): FollowRow[] => []),
        api.inboxMessages(wsId).then((r) => r.items).catch((): AgentMessage[] => []),
      ]);
      setOrg(o); setSrc({ approvals, plans, tasks, follows, messages }); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    void app.refreshWsOrg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);
  useEffect(() => { void reload(); const t = setInterval(() => { void reload(); }, 30_000); return () => clearInterval(t); }, [reload]);

  const items = useMemo(() => (src ? buildInbox({ ...src, incidents: app.orgHealth?.openIncidents ?? [], heldActions: app.orgHeldActions }) : []), [src, app.orgHealth, app.orgHeldActions]);
  const following = useMemo(() => followingList(src?.follows ?? []), [src]);
  const messages = useMemo(() => messagesList(src?.messages ?? []), [src]);
  const filter = app.inboxFilter;
  const count = (f: InboxFilter) => (f === 'messages' ? messages.filter((i) => !i.message?.read).length : f === 'following' ? following.filter((i) => i.follow && (i.follow.unseen > 0 || i.follow.attention)).length : filterInbox(items, f).length);
  const waiting = waitingCount(items);

  /** A followed thread or task: open it where it lives, and it is seen. */
  const openFollow = (i: InboxItem) => {
    const f = i.follow!;
    setSrc((s) => (s ? { ...s, follows: s.follows.map((r) => (r.targetKind === f.targetKind && r.targetId === f.targetId ? { ...r, unseenCount: 0, attentionAt: null, attention: '' } : r)) } : s));
    void api.markFollowSeen(wsId, f.targetKind, f.targetId).then(() => app.refreshWsOrg()).catch(() => undefined);
    if (f.targetKind === 'org_task') app.openOrgTask(f.targetId);
    else if (f.link) window.location.hash = f.link.replace(/^[^#]*/, '');
  };
  /** A message: open the agent's direct chat (the reply goes there), and the chat's messages are read. */
  const openMessage = (i: InboxItem) => {
    const m = i.message!;
    setSrc((s) => (s ? { ...s, messages: s.messages.map((x) => (x.sessionId === m.sessionId ? { ...x, read: true } : x)) } : s));
    void api.markMessagesRead(wsId, { sessionId: m.sessionId }).then(() => app.refreshWsOrg()).catch(() => undefined);
    app.openSession(m.sessionId);
  };
  const open = (i: InboxItem) => {
    if (i.kind === 'messages') { openMessage(i); return; }
    if (i.kind === 'following') { openFollow(i); return; }
    if (i.kind === 'mytasks') { app.openOrgTask(i.refId); return; }
    // An incident is contained and resolved on its one page, Operations › Incidents.
    if (i.kind === 'incidents') { app.setOrgFocus({ kind: 'incident', id: i.refId }); app.setOrgUnitId(null); app.setOrgPane('incidents'); return; }
    if (i.kind === 'plans') app.setOrgFocus({ kind: 'plan', id: i.refId });
    app.setInboxFilter(i.kind);
  };

  if (!app.companiesEnabled || !app.wsOrg || app.wsOrg.mode === 'off') {
    return <div style={{ flex: 1, padding: 24, ...faint }}>The Inbox gathers what waits on you when the workspace runs as a company — turn organization mode on in Settings › Company.</div>;
  }
  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <I d={P.inbox} size={18} />
          <h2 style={{ ...h2, flex: 1 }}>Inbox</h2>
          <span style={faint}>{waiting ? `${waiting} waiting on you` : 'nothing waiting'}</span>
        </div>
        <div role="group" aria-label="Inbox view" style={{ display: 'inline-flex', marginTop: 10, border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden' }}>
          {(['waiting', 'history'] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} data-testid={`inbox-mode-${m}`} onClick={() => setMode(m)}
              style={{ padding: '5px 14px', border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 600, background: mode === m ? 'var(--accent)' : 'var(--panel)', color: mode === m ? '#fff' : 'var(--text-dim)' }}>
              {m === 'waiting' ? 'Waiting' : 'History'}
            </button>
          ))}
        </div>
        {mode === 'waiting' && <div role="tablist" aria-label="Inbox filters" style={{ display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto', paddingBottom: 2 }}>
          {INBOX_FILTERS.map((f) => {
            const n = f.id === 'all' ? items.length : count(f.id);
            return (
              <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => app.setInboxFilter(f.id)} style={{ ...btn(filter === f.id), flex: 'none', whiteSpace: 'nowrap' }}>
                {f.label}{n > 0 ? ` · ${n}` : ''}
              </button>
            );
          })}
        </div>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 16 }}>
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
        {mode === 'history' ? (
          <Suspense fallback={<div style={faint}>Loading…</div>}>
            <InboxHistory onWaiting={(f) => { app.setInboxFilter(f); setMode('waiting'); }} />
          </Suspense>
        ) : !org || !src ? <div style={faint}>Loading…</div> : filter === 'all' ? (
          <div style={{ maxWidth: 820 }} data-testid="inbox-list">
            {items.length === 0 && <div style={faint}>Nothing waits on you. Decisions, keys, plans, your tasks, new incidents and what changed on what you follow show up here.</div>}
            {items.map((i) => <Row key={i.key} i={i} onOpen={open} members={members} />)}
          </div>
        ) : filter === 'messages' ? (
          <div style={{ maxWidth: 820 }} data-testid="messages-list">
            {messages.length === 0 && <div style={faint}>No messages from your team. When an agent writes to you directly it lands here and in its chat with you, where your reply goes.</div>}
            {messages.map((i) => <Row key={i.key} i={i} onOpen={open} members={members} />)}
          </div>
        ) : filter === 'incidents' ? (
          <div style={{ maxWidth: 820 }} data-testid="incidents-list">
            {filterInbox(items, 'incidents').length === 0 && <div style={faint}>No open incidents. Contained and resolved ones are in Operations › Incidents.</div>}
            {filterInbox(items, 'incidents').map((i) => <Row key={i.key} i={i} onOpen={open} />)}
            <button style={{ ...btn(), marginTop: 4 }} onClick={() => { app.setOrgFocus(null); app.setOrgUnitId(null); app.setOrgPane('incidents'); }}>All incidents in Operations</button>
          </div>
        ) : filter === 'following' ? (
          <div style={{ maxWidth: 820 }} data-testid="following-list">
            {following.length === 0 && <div style={faint}>You follow nothing yet. Threads you start or reply to and tasks you create, own or review are followed for you; the Follow button on a thread or a task adds any other.</div>}
            {following.map((i) => <Row key={i.key} i={i} onOpen={open} members={members} />)}
          </div>
        ) : (
          <Suspense fallback={<div style={faint}>Loading…</div>}>
            {(filter === 'approvals' || filter === 'keys' || filter === 'escalations') && <Approvals org={org} reload={reload} />}
            {filter === 'plans' && <PlansPane org={org} />}
            {filter === 'mytasks' && <MyTasksPane org={org} />}
          </Suspense>
        )}
      </div>
    </div>
  );
}
