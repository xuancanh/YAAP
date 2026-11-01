/** Layout composition per the design comp: activity bar · secondary panel ·
 *  main pane · artifact panel, with the stacked mobile variant. */
import { Component, Suspense, lazy, useState, type ReactNode } from 'react';
import { AppProvider, useApp } from './store';
import { ActivityBar, BottomNav, Toast } from './components/Shell';
import { WorkspacePill, HomeRail, WorkspaceRail, MarketRail, SettingsRail, SecondaryHeader, CompanyRail } from './components/Rails';
import { ChatView } from './components/ChatView';
import { FilesView } from './components/FilesView';
import { AppsGallery } from './components/AppsView';
import { ArtifactPanel } from './components/ArtifactPanel';

/** Heavyweight views load on demand; ChatView stays eager (the hot path). */
const AgentsDirectory = lazy(() => import('./components/AgentsView').then((m) => ({ default: m.AgentsDirectory })));
const AgentHome = lazy(() => import('./components/AgentsView').then((m) => ({ default: m.AgentHome })));
const NewAgentDialog = lazy(() => import('./components/AgentsView').then((m) => ({ default: m.NewAgentDialog })));
const MarketView = lazy(() => import('./components/MarketView').then((m) => ({ default: m.MarketView })));
const HireModal = lazy(() => import('./components/MarketView').then((m) => ({ default: m.HireModal })));
const CompanyView = lazy(() => import('./components/CompanyView').then((m) => ({ default: m.CompanyView })));
const SettingsView = lazy(() => import('./components/SettingsView').then((m) => ({ default: m.SettingsView })));

const viewFallback = (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 13 }}>Loading…</div>
);

function Layout() {
  const app = useApp();
  const [marketCat, setMarketCat] = useState('All');
  const [settingsPane, setSettingsPane] = useState(() => new URLSearchParams(window.location.search).get('pane') ?? 'providers');

  const sec = app.section;
  const detailActive =
    ((sec === 'home' || sec === 'workspace') && app.mobileChatOpen) ||
    ((sec === 'settings' || sec === 'company') && app.mobileDetail);
  const showSecondary = app.stacked ? !detailActive : true;
  const showMain = app.stacked ? !showSecondary : true;

  const secTitle = sec === 'home' ? 'Agents & chats' : sec === 'workspace' ? 'Shared files' : sec === 'market' ? 'Categories' : sec === 'company' ? 'Company' : 'Settings';
  const hasSecondary = sec !== 'overview' && sec !== 'apps'; // fleet overview + apps gallery are full-width

  return (
    <div data-theme={app.theme} style={{ height: '100vh', display: 'flex', position: 'relative', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, overflow: 'hidden', paddingBottom: app.stacked ? 58 : 0 }}>
      {!app.stacked && <ActivityBar />}

      {showSecondary && hasSecondary && (
        <aside style={{ width: app.stacked ? '100%' : app.mediumDock ? 250 : 292, flex: 'none', background: 'var(--panel)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {(sec === 'home' || sec === 'workspace' || sec === 'settings') && <WorkspacePill />}
          <SecondaryHeader title={secTitle} />
          {sec === 'home' && <HomeRail />}
          {sec === 'workspace' && <WorkspaceRail />}
          {sec === 'market' && <MarketRail cat={marketCat} setCat={setMarketCat} />}
          {sec === 'settings' && <SettingsRail pane={settingsPane} setPane={setSettingsPane} />}
          {sec === 'company' && <CompanyRail />}
        </aside>
      )}

      {(showMain || !hasSecondary) && (
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {sec === 'home' && app.homeView === 'chat' && <ChatView />}
          {sec === 'home' && app.homeView === 'file' && <FilesView />}
          {sec === 'home' && app.homeView === 'agent' && <Suspense fallback={viewFallback}>{app.selectedAgent ? <AgentHome /> : <AgentsDirectory />}</Suspense>}
          {sec === 'overview' && <Suspense fallback={viewFallback}><AgentsDirectory /></Suspense>}
          {sec === 'apps' && <AppsGallery />}
          {sec === 'workspace' && <FilesView />}
          {sec === 'market' && <Suspense fallback={viewFallback}><MarketView cat={marketCat} setCat={setMarketCat} /></Suspense>}
          {sec === 'settings' && <Suspense fallback={viewFallback}><SettingsView pane={settingsPane} /></Suspense>}
          {sec === 'company' && <Suspense fallback={viewFallback}><CompanyView /></Suspense>}
        </main>
      )}

      <ArtifactPanel />
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

export default function App() {
  return (
    <AppProvider>
      <ErrorBoundary>
        <Layout />
      </ErrorBoundary>
    </AppProvider>
  );
}
