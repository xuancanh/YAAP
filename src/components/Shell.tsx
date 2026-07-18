/** Activity bar (docked) and bottom nav (stacked), per the design comp. */
import { I, P } from '../lib/icons';
import { useApp, type Section } from '../store';

const NAV: Array<{ id: Section; label: string; icon: string[] }> = [
  { id: 'home', label: 'Home', icon: P.chat },
  { id: 'market', label: 'Market', icon: P.market },
];

export function ActivityBar() {
  const app = useApp();
  const btn = (on: boolean): React.CSSProperties => ({
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: 48,
    padding: '7px 0', border: 'none', borderRadius: 10, cursor: 'pointer',
    background: on ? 'var(--accent-dim)' : 'none', color: on ? 'var(--text)' : 'var(--text-faint)',
  });
  return (
    <nav style={{ width: 62, flex: 'none', background: 'var(--panel)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 0 14px', gap: 4 }}>
      <div style={{ width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg,var(--accent),var(--blue))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff', fontSize: 14, marginBottom: 8 }}>Y</div>
      {NAV.map((n) => (
        <button key={n.id} onClick={() => app.go(n.id)} style={btn(app.section === n.id)}>
          <I d={n.icon} size={19} sw={1.9} />
          <span style={{ fontSize: 9 }}>{n.label}</span>
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
  const btn = (on: boolean): React.CSSProperties => ({
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
    border: 'none', cursor: 'pointer', background: 'none', color: on ? 'var(--accent)' : 'var(--text-faint)',
  });
  return (
    <nav style={{ position: 'fixed', left: 0, right: 0, bottom: 0, height: 58, background: 'var(--panel)', borderTop: '1px solid var(--border)', display: 'flex', zIndex: 70 }}>
      {[...NAV, { id: 'settings' as Section, label: 'Settings', icon: P.gear }].map((n) => (
        <button key={n.id} onClick={() => app.go(n.id)} style={btn(app.section === n.id)}>
          <I d={n.icon} size={20} sw={1.9} />
          <span style={{ fontSize: 9.5 }}>{n.label}</span>
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
