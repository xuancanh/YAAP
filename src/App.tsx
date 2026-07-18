/** Layout composition per the design comp: activity bar · secondary panel ·
 *  main pane · artifact panel, with the stacked mobile variant. */
import { useState } from 'react';
import { AppProvider, useApp } from './store';
import { ActivityBar, BottomNav, Toast } from './components/Shell';
import { WorkspacePill, HomeRail, WorkspaceRail, MarketRail, SettingsRail, SecondaryHeader } from './components/Rails';
import { ChatView } from './components/ChatView';
import { FilesView } from './components/FilesView';
import { AgentsDirectory, AgentHome, NewAgentDialog } from './components/AgentsView';
import { AppsGallery } from './components/AppsView';
import { MarketView, HireModal } from './components/MarketView';
import { SettingsView } from './components/SettingsView';
import { ArtifactPanel } from './components/ArtifactPanel';

function Layout() {
  const app = useApp();
  const [marketCat, setMarketCat] = useState('All');
  const [settingsPane, setSettingsPane] = useState(() => new URLSearchParams(window.location.search).get('pane') ?? 'providers');

  const sec = app.section;
  const detailActive =
    ((sec === 'home' || sec === 'workspace') && app.mobileChatOpen) ||
    (sec === 'settings' && app.mobileDetail);
  const showSecondary = app.stacked ? !detailActive : true;
  const showMain = app.stacked ? !showSecondary : true;

  const secTitle = sec === 'home' ? 'Agents & chats' : sec === 'workspace' ? 'Shared files' : sec === 'market' ? 'Categories' : 'Settings';
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
        </aside>
      )}

      {(showMain || !hasSecondary) && (
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {sec === 'home' && app.homeView === 'chat' && <ChatView />}
          {sec === 'home' && app.homeView === 'file' && <FilesView />}
          {sec === 'home' && app.homeView === 'agent' && (app.selectedAgent ? <AgentHome /> : <AgentsDirectory />)}
          {sec === 'overview' && <AgentsDirectory />}
          {sec === 'apps' && <AppsGallery />}
          {sec === 'workspace' && <FilesView />}
          {sec === 'market' && <MarketView cat={marketCat} setCat={setMarketCat} />}
          {sec === 'settings' && <SettingsView pane={settingsPane} />}
        </main>
      )}

      <ArtifactPanel />
      {app.stacked && <BottomNav />}
      <HireModal />
      <NewAgentDialog />
      <Toast />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Layout />
    </AppProvider>
  );
}
