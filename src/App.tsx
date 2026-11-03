/** Layout composition per the design comp: activity bar · secondary panel ·
 *  main pane · artifact panel, with the stacked mobile variant. */
import { Component, Suspense, lazy, useEffect, useRef, type ReactNode } from 'react';
import { AppProvider, useApp } from './store';
import { AuthProvider, useAuth } from './auth';
import { SignIn } from './components/SignIn';
import { ActivityBar, BottomNav, Toast } from './components/Shell';
import { HomeRail, CompanyRail, ArtifactsRail, MarketRail, SettingsRail, SecondaryHeader } from './components/Rails';
import { isCompanySection, sectionDef } from './lib/company-nav';
import { TopBar } from './components/TopBar';
import { ChatView } from './components/ChatView';
import { ChannelView } from './components/ChannelView';
import { FilesView } from './components/FilesView';
import { AppsGallery } from './components/AppsView';
import { ArtifactPanel } from './components/ArtifactPanel';
import { useMarketNav } from './lib/market';
import { closeMeetingView, useMeetingRoute } from './lib/meetings';

/** Heavyweight views load on demand; ChatView stays eager (the hot path). */
const AgentsDirectory = lazy(() => import('./components/AgentsView').then((m) => ({ default: m.AgentsDirectory })));
const AgentHome = lazy(() => import('./components/AgentsView').then((m) => ({ default: m.AgentHome })));
const NewAgentDialog = lazy(() => import('./components/AgentsView').then((m) => ({ default: m.NewAgentDialog })));
const MarketView = lazy(() => import('./components/MarketView').then((m) => ({ default: m.MarketView })));
const HireModal = lazy(() => import('./components/MarketView').then((m) => ({ default: m.HireModal })));
const OrganizationView = lazy(() => import('./components/OrganizationView').then((m) => ({ default: m.OrganizationView })));
const HomeView = lazy(() => import('./components/HomeView').then((m) => ({ default: m.HomeView })));
const InboxView = lazy(() => import('./components/InboxView').then((m) => ({ default: m.InboxView })));
const MeetingScreen = lazy(() => import('./components/MeetingView').then((m) => ({ default: m.MeetingScreen })));
const SettingsView = lazy(() => import('./components/SettingsView').then((m) => ({ default: m.SettingsView })));

const viewFallback = (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 13 }}>Loading…</div>
);

/** A company section without organization mode: nothing to run yet. */
function WorkspaceOff() {
  const app = useApp();
  const btn: React.CSSProperties = { background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 9, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--text-faint)', padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Organization mode is off</div>
      <div style={{ fontSize: 13, maxWidth: 380, lineHeight: 1.55 }}>Turn it on in Settings › Company to run this workspace as a company. Files people and agents build live in Artifacts.</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btn} onClick={() => app.go('artifacts')}>Open Artifacts</button>
        <button style={btn} onClick={() => app.openSettings('company')}>Company settings</button>
      </div>
    </div>
  );
}

function Layout() {
  const app = useApp();
  const { settingsPane, setSettingsPane } = app;

  // The legacy Company id is resolved by the store; read it as Operations here too.
  const sec = app.section === 'workspace' ? 'operations' : app.section;
  // The full-screen meeting room (docs/meetings.md): #/ws/<id>/meeting/<id>
  // fills the main area; moving to another place in the app closes it.
  const meeting = useMeetingRoute();
  const place = `${sec}|${app.homeView}|${app.currentChannel ?? ''}|${app.orgPane ?? ''}|${app.currentFile ?? ''}`;
  const lastPlace = useRef(place);
  useEffect(() => {
    if (lastPlace.current !== place && meeting) closeMeetingView();
    lastPlace.current = place;
  }, [place, meeting]);
  // The workspace is the company (docs/group-chat.md §5): each company
  // section (Direction, Operations, People, Money, Oversight) has its own
  // rail and dashboard; the files live in their own Artifacts section.
  const company = isCompanySection(sec);
  const orgOn = app.companiesEnabled && app.wsOrg !== null && app.wsOrg.mode !== 'off';
  // The Market's Personal | Business switch defaults to Business for a company.
  const market = useMarketNav(orgOn);
  const orgOpen = company && orgOn;
  const detailActive = Boolean(meeting) ||
    ((sec === 'home' || sec === 'artifacts') && app.mobileChatOpen) ||
    (sec === 'settings' && app.mobileDetail);
  const showSecondary = app.stacked ? !detailActive : true;
  const showMain = app.stacked ? !showSecondary : true;

  const secTitle = sec === 'home' ? 'Channels & chats' : company ? sectionDef(sec).label : sec === 'artifacts' ? 'Artifacts' : sec === 'market' ? 'Market' : 'Settings';
  const hasSecondary = !meeting && sec !== 'overview' && sec !== 'agents' && sec !== 'apps' && sec !== 'inbox' // Home, the agent directory, apps gallery and the Inbox are full-width
    && !(company && (app.stacked || !orgOpen)) // on a phone a company section carries its own page strip
    && !(sec === 'market' && app.stacked); // on a phone the Market view carries its own segment switch and chips

  return (
    <div data-theme={app.theme} style={{ height: '100vh', display: 'flex', position: 'relative', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, overflow: 'hidden', paddingBottom: app.stacked ? 58 : 0 }}>
      {!app.stacked && <ActivityBar />}

      {/* The top bar (docs/home.md "Top bar") spans the work area beside the
          main menu: the workspace switcher, the company at a glance, search,
          create, notifications and the account. */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <TopBar onSettings={(pane) => { setSettingsPane(pane); app.go('settings'); app.setMobileDetail(true); }} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
      {showSecondary && hasSecondary && (
        <aside style={{ width: app.stacked ? '100%' : app.mediumDock ? 250 : 292, flex: 'none', background: 'var(--panel)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <SecondaryHeader title={secTitle} />
          {sec === 'home' && <HomeRail />}
          {company && <CompanyRail section={sec} />}
          {sec === 'artifacts' && <ArtifactsRail />}
          {sec === 'market' && <MarketRail nav={market.nav} setNav={market.setNav} />}
          {sec === 'settings' && <SettingsRail pane={settingsPane} setPane={setSettingsPane} />}
        </aside>
      )}

      {(showMain || !hasSecondary) && (
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {meeting && <Suspense fallback={viewFallback}><MeetingScreen route={meeting} /></Suspense>}
          {!meeting && <>
          {sec === 'home' && app.homeView === 'chat' && <ChatView />}
          {sec === 'home' && app.homeView === 'channel' && <ChannelView />}
          {sec === 'home' && app.homeView === 'file' && <FilesView />}
          {sec === 'home' && app.homeView === 'agent' && <Suspense fallback={viewFallback}>{app.selectedAgent ? <AgentHome /> : <AgentsDirectory />}</Suspense>}
          {sec === 'overview' && <Suspense fallback={viewFallback}><HomeView /></Suspense>}
          {sec === 'agents' && <Suspense fallback={viewFallback}><AgentsDirectory /></Suspense>}
          {sec === 'apps' && <AppsGallery />}
          {company && (orgOpen ? <Suspense fallback={viewFallback}><OrganizationView section={sec} /></Suspense> : <WorkspaceOff />)}
          {sec === 'artifacts' && <FilesView />}
          {sec === 'inbox' && <Suspense fallback={viewFallback}><InboxView /></Suspense>}
          {sec === 'market' && <Suspense fallback={viewFallback}><MarketView nav={market.nav} setNav={market.setNav} /></Suspense>}
          {sec === 'settings' && <Suspense fallback={viewFallback}><SettingsView pane={settingsPane} /></Suspense>}
          </>}
        </main>
      )}

      <ArtifactPanel />
      </div>
      </div>
      {app.stacked && <BottomNav />}
      <Suspense fallback={null}><HireModal /></Suspense>
      <Suspense fallback={null}><NewAgentDialog /></Suspense>
      <Toast />
    </div>
  );
}

/** Last line of defense: a render error anywhere below shows a recoverable
 *  panel instead of a white screen (the store above it stays alive). */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div data-theme={localStorage.getItem('yaam-theme') || 'dark'} style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }}>
          <div style={{ maxWidth: 420, textAlign: 'center', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 14, padding: '28px 32px', boxShadow: 'var(--shadow)' }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Something went wrong</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', fontFamily: 'var(--mono)', wordBreak: 'break-word', marginBottom: 18 }}>{error.message}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={() => this.setState({ error: null })} style={{ background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Try again</button>
              <button onClick={() => window.location.reload()} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Reload app</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Nothing below mounts until /api/auth/me has answered: in accounts mode an
 *  unauthenticated visitor sees the sign-in screen instead of a wall of 401s;
 *  in single mode (or with the API down) the app renders exactly as before. */
function AuthGate() {
  const auth = useAuth();
  if (auth.mode === null) return null;
  if (auth.mode === 'accounts' && !auth.authenticated) return <SignIn />;
  return (
    <AppProvider>
      <ErrorBoundary>
        <Layout />
      </ErrorBoundary>
    </AppProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
