/** The Inbox (docs/company-vision.md §8 "The CEO's seat"): everything
 *  waiting on the CEO in one list — decision cards, actions waiting for the
 *  owner's key, escalations, plans awaiting a veto, my tasks and reviews,
 *  open incidents, and what changed on the threads and tasks I follow
 *  (docs/follows.md) — with filters; a filter opens the full pane for that
 *  kind (the full artifact, never a summary). A task opens through its deep
 *  link (`#/ws/<id>/org/board?task=<id>`). */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type FollowRow, type OrgApproval, type OrgDetail, type OrgPlan, type OrgTask } from '../lib/api';
import { buildInbox, filterInbox, followingList, waitingCount, INBOX_FILTERS, type InboxFilter, type InboxItem } from '../lib/inbox';
import { I, P } from '../lib/icons';
import { card, btn, pill, h2, faint, ago } from './org-ui';
import { Approvals } from './OrganizationView';

const PlansPane = lazy(() => import('./OrgCapitalView').then((m) => ({ default: m.PlansPane })));
const MyTasksPane = lazy(() => import('./OrgPeopleView').then((m) => ({ default: m.MyTasksPane })));
const IncidentsPane = lazy(() => import('./OrgIncidentsView').then((m) => ({ default: m.IncidentsPane })));

const KIND_COLOR: Record<InboxItem['kind'], string> = {
  approvals: 'var(--amber)', keys: 'var(--amber)', escalations: 'var(--red)', plans: 'var(--blue)', mytasks: 'var(--accent)', incidents: 'var(--red)', following: 'var(--green)',
};
const KIND_LABEL: Record<InboxItem['kind'], string> = {
  approvals: 'approval', keys: 'key', escalations: 'escalation', plans: 'plan', mytasks: 'task', incidents: 'incident', following: 'following',
};

function Row({ i, onOpen }: { i: InboxItem; onOpen: (i: InboxItem) => void }) {
  const f = i.follow;
  const color = f?.attention ? 'var(--amber)' : KIND_COLOR[i.kind];
  return (
    <button data-testid={`inbox-item-${i.key}`} onClick={() => onOpen(i)}
      style={{ ...card, display: 'flex', width: '100%', textAlign: 'left', gap: 10, alignItems: 'flex-start', marginBottom: 8, cursor: 'pointer', borderLeft: `3px solid ${color}`, color: 'var(--text)', font: 'inherit', boxSizing: 'border-box', opacity: f && !f.attention && f.unseen === 0 ? 0.75 : 1 }}>
      <span style={{ ...pill(KIND_COLOR[i.kind], '#fff'), flex: 'none' }}>{KIND_LABEL[i.kind]}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{i.title}</span>
        {f?.attention && <span data-testid="follow-attention" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--amber)', marginTop: 2, overflowWrap: 'anywhere' }}>Needs you: {f.attention}</span>}
        {i.detail && <span style={{ display: 'block', ...faint, marginTop: 2, overflowWrap: 'anywhere' }}>{i.detail}</span>}
      </span>
      <span style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        {i.at && <span style={faint}>{ago(i.at)}</span>}
        {f && f.unseen > 0 && <span data-testid="follow-unseen" title={`${f.unseen} new since you looked`} style={pill('var(--accent)', '#fff')}>{f.unseen} new</span>}
        {f?.closed && <span style={pill()}>closed</span>}
      </span>
    </button>
  );
}

export function InboxView() {
  const app = useApp();
  const wsId = app.workspaceId;
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [src, setSrc] = useState<{ approvals: OrgApproval[]; plans: OrgPlan[]; tasks: { assigned: OrgTask[]; reviewing: OrgTask[] } | null; follows: FollowRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!wsId) return;
    try {
      const [o, approvals, plans, tasks, follows] = await Promise.all([
        api.org(wsId), api.orgApprovals(wsId, 'pending').catch((): OrgApproval[] => []), api.orgPlans(wsId, 'pending').catch((): OrgPlan[] => []), api.orgMyTasks(wsId).catch(() => null),
        api.followsMine(wsId).catch((): FollowRow[] => []),
      ]);
      setOrg(o); setSrc({ approvals, plans, tasks, follows }); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    void app.refreshWsOrg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);
  useEffect(() => { void reload(); const t = setInterval(() => { void reload(); }, 30_000); return () => clearInterval(t); }, [reload]);

  const items = useMemo(() => (src ? buildInbox({ ...src, incidents: app.orgHealth?.openIncidents ?? [], heldActions: app.orgHeldActions }) : []), [src, app.orgHealth, app.orgHeldActions]);
  const following = useMemo(() => followingList(src?.follows ?? []), [src]);
  const filter = app.inboxFilter;
  const count = (f: InboxFilter) => (f === 'following' ? following.filter((i) => i.follow && (i.follow.unseen > 0 || i.follow.attention)).length : filterInbox(items, f).length);
  const waiting = waitingCount(items);

  /** A followed thread or task: open it where it lives, and it is seen. */
  const openFollow = (i: InboxItem) => {
    const f = i.follow!;
    setSrc((s) => (s ? { ...s, follows: s.follows.map((r) => (r.targetKind === f.targetKind && r.targetId === f.targetId ? { ...r, unseenCount: 0, attentionAt: null, attention: '' } : r)) } : s));
    void api.markFollowSeen(wsId, f.targetKind, f.targetId).then(() => app.refreshWsOrg()).catch(() => undefined);
    if (f.targetKind === 'org_task') app.openOrgTask(f.targetId);
    else if (f.link) window.location.hash = f.link.replace(/^[^#]*/, '');
  };
  const open = (i: InboxItem) => {
    if (i.kind === 'following') { openFollow(i); return; }
    if (i.kind === 'mytasks') { app.openOrgTask(i.refId); return; }
    if (i.kind === 'plans') app.setOrgFocus({ kind: 'plan', id: i.refId });
    else if (i.kind === 'incidents') app.setOrgFocus({ kind: 'incident', id: i.refId });
    app.setInboxFilter(i.kind);
  };

  if (!app.companiesEnabled || !app.wsOrg || app.wsOrg.mode === 'off') {
    return <div style={{ flex: 1, padding: 24, ...faint }}>The Inbox gathers what waits on you when the workspace runs as a company — turn organization mode on in Settings → Workspace.</div>;
  }
  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <I d={P.inbox} size={18} />
          <h2 style={{ ...h2, flex: 1 }}>Inbox</h2>
          <span style={faint}>{waiting ? `${waiting} waiting on you` : 'nothing waiting'}</span>
        </div>
        <div role="tablist" aria-label="Inbox filters" style={{ display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto', paddingBottom: 2 }}>
          {INBOX_FILTERS.map((f) => {
            const n = f.id === 'all' ? items.length : count(f.id);
            return (
              <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => app.setInboxFilter(f.id)} style={{ ...btn(filter === f.id), flex: 'none', whiteSpace: 'nowrap' }}>
                {f.label}{n > 0 ? ` · ${n}` : ''}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 16 }}>
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
        {!org || !src ? <div style={faint}>Loading…</div> : filter === 'all' ? (
          <div style={{ maxWidth: 820 }} data-testid="inbox-list">
            {items.length === 0 && <div style={faint}>Nothing waits on you. Decisions, keys, plans, your tasks, new incidents and what changed on what you follow show up here.</div>}
            {items.map((i) => <Row key={i.key} i={i} onOpen={open} />)}
          </div>
        ) : filter === 'following' ? (
          <div style={{ maxWidth: 820 }} data-testid="following-list">
            {following.length === 0 && <div style={faint}>You follow nothing yet. Threads you start or reply to and tasks you create, own or review are followed for you; the Follow button on a thread or a task adds any other.</div>}
            {following.map((i) => <Row key={i.key} i={i} onOpen={open} />)}
          </div>
        ) : (
          <Suspense fallback={<div style={faint}>Loading…</div>}>
            {(filter === 'approvals' || filter === 'keys' || filter === 'escalations') && <Approvals org={org} reload={reload} />}
            {filter === 'plans' && <PlansPane org={org} />}
            {filter === 'mytasks' && <MyTasksPane org={org} />}
            {filter === 'incidents' && <IncidentsPane org={org} />}
          </Suspense>
        )}
      </div>
    </div>
  );
}
