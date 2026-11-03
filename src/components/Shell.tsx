/** Activity bar (docked) and bottom nav (stacked), per the design comp. */
import { I, P } from '../lib/icons';
import { useApp, type Section } from '../store';
import { inboxBadge } from '../lib/inbox';

const NAV: Array<{ id: Section; label: string; icon: string[]; org?: boolean }> = [
  { id: 'overview', label: 'Home', icon: P.bot },
  { id: 'home', label: 'Chat', icon: P.chat },
  // Organization mode only (docs/company-vision.md §8): what waits on the CEO, and the company.
  { id: 'inbox', label: 'Inbox', icon: P.inbox, org: true },
  { id: 'workspace', label: 'Company', icon: P.building, org: true },
  { id: 'artifacts', label: 'Artifacts', icon: P.files },
  { id: 'apps', label: 'Apps', icon: P.window },
  { id: 'market', label: 'Market', icon: P.market },
];

/** The main menu for this workspace, with the Inbox badge. */
function useNav() {
  const app = useApp();
  const orgOn = app.companiesEnabled && app.wsOrg !== null && app.wsOrg.mode !== 'off';
  const badge = orgOn ? inboxBadge({
    pendingApprovals: app.wsOrg?.pendingApprovals ?? 0, heldActions: app.orgHeldActions, pendingPlans: app.orgPendingPlans,
    openIncidents: (app.orgHealth?.openIncidents ?? []).filter((i) => i.status === 'open').length, myTasks: app.orgMyTasks,
    followAttention: app.followAttention, unreadMessages: app.unreadMessages,
  }) : 0;
  return NAV.filter((n) => !n.org || orgOn).map((n) => ({ ...n, badge: n.id === 'inbox' && badge > 0 ? badge : undefined }));
}

const Badge = ({ n }: { n: number }) => (
  <span data-testid="inbox-badge" title={`${n} waiting on you`} style={{ position: 'absolute', top: 2, right: 6, minWidth: 16, height: 16, borderRadius: 8, padding: '0 4px', background: 'var(--amber)', color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>{n > 99 ? '99+' : n}</span>
);

export function ActivityBar() {
  const app = useApp();
  const nav = useNav();
  const btn = (on: boolean): React.CSSProperties => ({
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: 48, position: 'relative',
    padding: '7px 0', border: 'none', borderRadius: 10, cursor: 'pointer',
    background: on ? 'var(--accent-dim)' : 'none', color: on ? 'var(--text)' : 'var(--text-faint)',
  });
  return (
    <nav style={{ width: 62, flex: 'none', background: 'var(--panel)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 0 14px', gap: 4 }}>
      <div style={{ width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg,var(--accent),var(--blue))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff', fontSize: 14, marginBottom: 8 }}>Y</div>
      {nav.map((n) => (
        <button key={n.id} onClick={() => app.go(n.id)} style={btn(app.section === n.id || (n.id === 'overview' && app.section === 'agents'))} aria-label={n.label}>
          <I d={n.icon} size={19} sw={1.9} />
          <span style={{ fontSize: 9 }}>{n.label}</span>
          {n.badge !== undefined && <Badge n={n.badge} />}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <button onClick={() => app.go('settings')} style={btn(app.section === 'settings')}>
        <I d={P.gear} size={19} sw={1.9} />
        <span style={{ fontSize: 9 }}>Settings</span>
      </button>
      <button onClick={app.toggleTheme} title="Theme" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 8, borderRadius: 9, display: 'flex' }}>
        <I d={app.theme === 'dark' ? P.sun : P.moon} size={16} />
      </button>
    </nav>
  );
}

export function BottomNav() {
  const app = useApp();
  const nav = useNav();
  const btn = (on: boolean): React.CSSProperties => ({
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, position: 'relative', padding: 0,
    border: 'none', cursor: 'pointer', background: 'none', color: on ? 'var(--accent)' : 'var(--text-faint)',
  });
  return (
    <nav style={{ position: 'fixed', left: 0, right: 0, bottom: 0, height: 58, background: 'var(--panel)', borderTop: '1px solid var(--border)', display: 'flex', zIndex: 70 }}>
      {[...nav, { id: 'settings' as Section, label: 'Settings', icon: P.gear, badge: undefined }].map((n) => (
        <button key={n.id} onClick={() => app.go(n.id)} style={btn(app.section === n.id || (n.id === 'overview' && app.section === 'agents'))} aria-label={n.label}>
          <I d={n.icon} size={20} sw={1.9} />
          <span style={{ fontSize: 9, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.label}</span>
          {n.badge !== undefined && <Badge n={n.badge} />}
        </button>
      ))}
    </nav>
  );
}

export function Toast() {
  const app = useApp();
  if (!app.toast) return null;
  return (
    <div style={{ position: 'fixed', bottom: app.stacked ? 72 : 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 11, padding: '11px 18px', boxShadow: 'var(--shadow)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 9, zIndex: 120, animation: 'msgIn .18s', color: 'var(--text)' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />
      {app.toast}
    </div>
  );
}
