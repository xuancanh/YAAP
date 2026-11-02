/** The Inbox (docs/company-vision.md §8 "The CEO's seat"): everything
 *  waiting on the CEO in one list — decision cards, actions waiting for the
 *  owner's key, escalations, plans awaiting a veto, my tasks and reviews,
 *  open incidents — with filters; a filter opens the full pane for that kind
 *  (the full artifact, never a summary). */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgApproval, type OrgDetail, type OrgPlan, type OrgTask } from '../lib/api';
import { buildInbox, filterInbox, INBOX_FILTERS, type InboxFilter, type InboxItem } from '../lib/inbox';
import { I, P } from '../lib/icons';
import { card, btn, pill, h2, faint, ago } from './org-ui';
import { Approvals } from './OrganizationView';

const PlansPane = lazy(() => import('./OrgCapitalView').then((m) => ({ default: m.PlansPane })));
const MyTasksPane = lazy(() => import('./OrgPeopleView').then((m) => ({ default: m.MyTasksPane })));
const IncidentsPane = lazy(() => import('./OrgIncidentsView').then((m) => ({ default: m.IncidentsPane })));

const KIND_COLOR: Record<InboxItem['kind'], string> = {
  approvals: 'var(--amber)', keys: 'var(--amber)', escalations: 'var(--red)', plans: 'var(--blue)', mytasks: 'var(--accent)', incidents: 'var(--red)',
};
const KIND_LABEL: Record<InboxItem['kind'], string> = {
  approvals: 'approval', keys: 'key', escalations: 'escalation', plans: 'plan', mytasks: 'task', incidents: 'incident',
};

export function InboxView() {
  const app = useApp();
  const wsId = app.workspaceId;
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [src, setSrc] = useState<{ approvals: OrgApproval[]; plans: OrgPlan[]; tasks: { assigned: OrgTask[]; reviewing: OrgTask[] } | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!wsId) return;
    try {
      const [o, approvals, plans, tasks] = await Promise.all([
        api.org(wsId), api.orgApprovals(wsId, 'pending').catch((): OrgApproval[] => []), api.orgPlans(wsId, 'pending').catch((): OrgPlan[] => []), api.orgMyTasks(wsId).catch(() => null),
      ]);
      setOrg(o); setSrc({ approvals, plans, tasks }); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    void app.refreshWsOrg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);
  useEffect(() => { void reload(); const t = setInterval(() => { void reload(); }, 30_000); return () => clearInterval(t); }, [reload]);

  const items = useMemo(() => (src ? buildInbox({ ...src, incidents: app.orgHealth?.openIncidents ?? [], heldActions: app.orgHeldActions }) : []), [src, app.orgHealth, app.orgHeldActions]);
  const filter = app.inboxFilter;
  const count = (f: InboxFilter) => filterInbox(items, f).length;
  const open = (i: InboxItem) => {
    if (i.kind === 'plans') app.setOrgFocus({ kind: 'plan', id: i.refId });
    else if (i.kind === 'incidents') app.setOrgFocus({ kind: 'incident', id: i.refId });
    else if (i.kind === 'mytasks') app.setOrgFocus({ kind: 'task', id: i.refId });
    app.setInboxFilter(i.kind);
  };

  if (!app.companiesEnabled || !app.wsOrg || app.wsOrg.mode === 'off') {
    return <div style={{ flex: 1, padding: 24, ...faint }}>The Inbox gathers what waits on you when the workspace runs as a company — turn organization mode on in Settings → Workspace.</div>;
  }
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <I d={P.inbox} size={18} />
          <h2 style={{ ...h2, flex: 1 }}>Inbox</h2>
          <span style={faint}>{items.length ? `${items.length} waiting on you` : 'nothing waiting'}</span>
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
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
        {!org || !src ? <div style={faint}>Loading…</div> : filter === 'all' ? (
          <div style={{ maxWidth: 820 }} data-testid="inbox-list">
            {items.length === 0 && <div style={faint}>Nothing waits on you. Decisions, keys, plans, your tasks and new incidents show up here.</div>}
            {items.map((i) => (
              <button key={i.key} onClick={() => open(i)} style={{ ...card, display: 'flex', width: '100%', textAlign: 'left', gap: 10, alignItems: 'flex-start', marginBottom: 8, cursor: 'pointer', borderLeft: `3px solid ${KIND_COLOR[i.kind]}`, color: 'var(--text)', font: 'inherit' }}>
                <span style={{ ...pill(KIND_COLOR[i.kind], '#fff'), flex: 'none' }}>{KIND_LABEL[i.kind]}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.title}</span>
                  {i.detail && <span style={{ display: 'block', ...faint, marginTop: 2 }}>{i.detail}</span>}
                </span>
                {i.at && <span style={{ ...faint, flex: 'none' }}>{ago(i.at)}</span>}
              </button>
            ))}
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
