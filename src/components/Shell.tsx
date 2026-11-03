/** Activity bar (docked) and bottom nav (stacked), per the design comp.
 *  The main menu is grouped: Home · Inbox · Chat, then — in organization
 *  mode — the company's sections (Direction, Operations, People, Money,
 *  Oversight; src/lib/company-nav.ts), then Artifacts · Apps · Market, with
 *  Settings at the foot. On a phone the company sections and the rest fold
 *  into two sheets (Company, More) so the bar keeps five targets. */
import { useEffect, useRef, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp, type Section } from '../store';
import { inboxBadge } from '../lib/inbox';
import { COMPANY_SECTIONS, isCompanySection, type CompanySection } from '../lib/company-nav';

interface NavItem { id: Section; label: string; icon: string[]; group: 'core' | 'company' | 'make'; org?: boolean; badge?: number; dot?: { color: string; title: string } }

const SECTION_ICON: Record<CompanySection, string[]> = { direction: P.compass, operations: P.pulse, people: P.people, money: P.coin, oversight: P.eye };

const NAV: NavItem[] = [
  { id: 'overview', label: 'Home', icon: P.bot, group: 'core' },
  // Organization mode only (docs/company-vision.md §8): what waits on the CEO.
  { id: 'inbox', label: 'Inbox', icon: P.inbox, group: 'core', org: true },
  { id: 'home', label: 'Chat', icon: P.chat, group: 'core' },
  // The company, one item per section (each with its own dashboard).
  ...COMPANY_SECTIONS.map((s): NavItem => ({ id: s.id, label: s.label, icon: SECTION_ICON[s.id], group: 'company', org: true })),
  { id: 'artifacts', label: 'Artifacts', icon: P.files, group: 'make' },
  { id: 'apps', label: 'Apps', icon: P.window, group: 'make' },
  { id: 'market', label: 'Market', icon: P.market, group: 'make' },
];

/** The main menu for this workspace, with the Inbox badge and the Operations incident dot. */
export function useNav(): NavItem[] {
  const app = useApp();
  const orgOn = app.companiesEnabled && app.wsOrg !== null && app.wsOrg.mode !== 'off';
  const openIncidents = (app.orgHealth?.openIncidents ?? []).filter((i) => i.status === 'open').length;
  const badge = orgOn ? inboxBadge({
    pendingApprovals: app.wsOrg?.pendingApprovals ?? 0, heldActions: app.orgHeldActions, pendingPlans: app.orgPendingPlans,
    openIncidents, myTasks: app.orgMyTasks,
    followAttention: app.followAttention, unreadMessages: app.unreadMessages,
  }) : 0;
  return NAV.filter((n) => !n.org || orgOn).map((n) => ({
    ...n,
    badge: n.id === 'inbox' && badge > 0 ? badge : undefined,
    dot: n.id === 'operations' && openIncidents > 0 ? { color: 'var(--red)', title: `${openIncidents} open incident${openIncidents === 1 ? '' : 's'}` } : undefined,
  }));
}

/** Is this menu item the current place? Home also covers the agent directory; Operations the legacy Company id. */
function isOn(item: Section, section: Section): boolean {
  if (item === section) return true;
  if (item === 'overview' && section === 'agents') return true;
  return item === 'operations' && section === 'workspace';
}

const Badge = ({ n }: { n: number }) => (
  <span data-testid="inbox-badge" title={`${n} waiting on you`} style={{ position: 'absolute', top: 2, right: 6, minWidth: 16, height: 16, borderRadius: 8, padding: '0 4px', background: 'var(--amber)', color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>{n > 99 ? '99+' : n}</span>
);
const Dot = ({ color, title, testId }: { color: string; title: string; testId: string }) => (
  <span data-testid={testId} title={title} aria-label={title} style={{ position: 'absolute', top: 5, right: 11, width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: '0 0 0 2px var(--panel)' }} />
);

export function ActivityBar() {
  const app = useApp();
  const nav = useNav();
  const btn = (on: boolean): React.CSSProperties => ({
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: 52, position: 'relative',
    padding: '6px 0', border: 'none', borderRadius: 10, cursor: 'pointer',
    background: on ? 'var(--accent-dim)' : 'none', color: on ? 'var(--text)' : 'var(--text-faint)',
  });
  const groups = (['core', 'company', 'make'] as const).map((g) => nav.filter((n) => n.group === g)).filter((g) => g.length > 0);
  return (
    <nav aria-label="Main menu" style={{ width: 64, flex: 'none', background: 'var(--panel)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 0 12px', gap: 2, overflowY: 'auto' }}>
      <div style={{ width: 30, height: 30, flex: 'none', borderRadius: 8, background: 'linear-gradient(135deg,var(--accent),var(--blue))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff', fontSize: 14, marginBottom: 8 }}>Y</div>
      {groups.map((g, gi) => (
        <div key={g[0].group} role="group" aria-label={g[0].group === 'company' ? 'Company' : undefined} data-testid={`nav-group-${g[0].group}`}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, ...(gi > 0 ? { borderTop: '1px solid var(--border)', marginTop: 5, paddingTop: 7 } : {}) }}>
          {g.map((n) => (
            <button key={n.id} onClick={() => app.go(n.id)} style={btn(isOn(n.id, app.section))} aria-label={n.label} aria-current={isOn(n.id, app.section) ? 'page' : undefined}>
              <I d={n.icon} size={18} sw={1.9} />
              <span style={{ fontSize: 9 }}>{n.label}</span>
              {n.badge !== undefined && <Badge n={n.badge} />}
              {n.dot && <Dot color={n.dot.color} title={n.dot.title} testId={`nav-dot-${n.id}`} />}
            </button>
          ))}
        </div>
      ))}
      <div style={{ flex: 1, minHeight: 8 }} />
      <button onClick={() => app.go('settings')} style={btn(app.section === 'settings')} aria-label="Settings">
        <I d={P.gear} size={18} sw={1.9} />
        <span style={{ fontSize: 9 }}>Settings</span>
      </button>
      <button onClick={app.toggleTheme} title="Theme" aria-label="Theme" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 8, borderRadius: 9, display: 'flex', flex: 'none' }}>
        <I d={app.theme === 'dark' ? P.sun : P.moon} size={16} />
      </button>
    </nav>
  );
}

/** A sheet above the bottom bar: the company sections, or everything else. */
function Sheet({ title, items, onPick, onClose }: { title: string; items: NavItem[]; onPick: (id: Section) => void; onClose: () => void }) {
  const app = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector('button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div onClick={onClose} aria-hidden style={{ position: 'fixed', inset: 0, bottom: 58, background: 'var(--scrim)', zIndex: 71 }} />
      <div ref={ref} role="menu" aria-label={title} data-testid={`nav-sheet-${title.toLowerCase()}`}
        style={{ position: 'fixed', left: 8, right: 8, bottom: 66, zIndex: 72, background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: 6 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-faint)', padding: '6px 10px 4px' }}>{title}</div>
        {items.map((n) => {
          const on = isOn(n.id, app.section);
          const blurb = isCompanySection(n.id) ? COMPANY_SECTIONS.find((s) => s.id === n.id)?.blurb : undefined;
          return (
            <button key={n.id} role="menuitem" aria-label={n.label} onClick={() => onPick(n.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', border: 'none', font: 'inherit', padding: '9px 10px', borderRadius: 10, cursor: 'pointer', background: on ? 'var(--accent-dim)' : 'none', color: 'var(--text)', position: 'relative' }}>
              <I d={n.icon} size={19} sw={1.9} style={{ flex: 'none', color: on ? 'var(--text)' : 'var(--text-dim)' }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{n.label}</span>
                {blurb && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{blurb}</span>}
              </span>
              {n.dot && <span title={n.dot.title} style={{ width: 8, height: 8, borderRadius: '50%', background: n.dot.color, flex: 'none' }} />}
            </button>
          );
        })}
      </div>
    </>
  );
}

export function BottomNav() {
  const app = useApp();
  const nav = useNav();
  const [sheet, setSheet] = useState<'company' | 'more' | null>(null);
  const btn = (on: boolean): React.CSSProperties => ({
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, position: 'relative', padding: 0,
    border: 'none', cursor: 'pointer', background: 'none', color: on ? 'var(--accent)' : 'var(--text-faint)',
  });
  const settings: NavItem = { id: 'settings', label: 'Settings', icon: P.gear, group: 'make' };
  const company = nav.filter((n) => n.group === 'company');
  const pick = (id: Section) => { setSheet(null); app.go(id); };
  // Without a company the bar holds everything; with one, the sections and the rest fold into sheets.
  const bar: Array<NavItem & { sheet?: 'company' | 'more' }> = company.length === 0
    ? [...nav, settings]
    : [
      ...nav.filter((n) => n.group === 'core'),
      { id: 'operations', label: 'Company', icon: P.building, group: 'company', sheet: 'company', dot: company.find((c) => c.dot)?.dot },
      { id: 'artifacts', label: 'More', icon: P.more, group: 'make', sheet: 'more' },
    ];
  const more = [...nav.filter((n) => n.group === 'make'), settings];
  return (
    <>
      {sheet === 'company' && <Sheet title="Company" items={company} onPick={pick} onClose={() => setSheet(null)} />}
      {sheet === 'more' && <Sheet title="More" items={more} onPick={pick} onClose={() => setSheet(null)} />}
      <nav aria-label="Main menu" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, height: 58, background: 'var(--panel)', borderTop: '1px solid var(--border)', display: 'flex', zIndex: 70 }}>
        {bar.map((n) => {
          const on = n.sheet === 'company' ? company.some((c) => isOn(c.id, app.section)) : n.sheet === 'more' ? more.some((c) => isOn(c.id, app.section)) : isOn(n.id, app.section);
          return (
            <button key={n.sheet ?? n.id} onClick={() => (n.sheet ? setSheet(sheet === n.sheet ? null : n.sheet) : pick(n.id))} style={btn(on || sheet === n.sheet && n.sheet !== undefined)} aria-label={n.label}
              aria-haspopup={n.sheet ? 'menu' : undefined} aria-expanded={n.sheet ? sheet === n.sheet : undefined}>
              <I d={n.icon} size={20} sw={1.9} />
              <span style={{ fontSize: 9, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.label}</span>
              {n.badge !== undefined && <Badge n={n.badge} />}
              {n.dot && <Dot color={n.dot.color} title={n.dot.title} testId={`nav-dot-${n.sheet ?? n.id}`} />}
            </button>
          );
        })}
      </nav>
    </>
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
