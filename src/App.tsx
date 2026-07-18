/** Layout composition per the design comp: activity bar · secondary panel ·
 *  main pane · artifact panel, with the stacked mobile variant. */
import { useState } from 'react';
import { AppProvider, useApp } from './store';
import { ActivityBar, BottomNav, Toast } from './components/Shell';
import { WorkspacePill, HomeRail, MarketRail, SettingsRail, SecondaryHeader } from './components/Rails';
import { ChatView } from './components/ChatView';
import { FilesView } from './components/FilesView';
import { AgentsDirectory, AgentHome, NewAgentDialog } from './components/AgentsView';
import { MarketView, HireModal } from './components/MarketView';
import { SettingsView } from './components/SettingsView';
import { ArtifactPanel } from './components/ArtifactPanel';

function Layout() {
  const app = useApp();
  const [marketCat, setMarketCat] = useState('All');
  const [settingsPane, setSettingsPane] = useState('providers');

  const sec = app.section;
  const detailActive =
    (sec === 'home' && app.mobileChatOpen) ||
    (sec === 'settings' && app.mobileDetail);
  const showSecondary = app.stacked ? !detailActive : true;
  const showMain = app.stacked ? !showSecondary : true;

  const secTitle = sec === 'home' ? 'Agents & chats' : sec === 'market' ? 'Categories' : 'Settings';

  return (
    <div data-theme={app.theme} style={{ height: '100vh', display: 'flex', position: 'relative', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, overflow: 'hidden', paddingBottom: app.stacked ? 58 : 0 }}>
      {!app.stacked && <ActivityBar />}

      {showSecondary && (
        <aside style={{ width: app.stacked ? '100%' : app.mediumDock ? 250 : 292, flex: 'none', background: 'var(--panel)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {(sec === 'home' || sec === 'settings') && <WorkspacePill />}
          <SecondaryHeader title={secTitle} />
          {sec === 'home' && <HomeRail />}
          {sec === 'market' && <MarketRail cat={marketCat} setCat={setMarketCat} />}
          {sec === 'settings' && <SettingsRail pane={settingsPane} setPane={setSettingsPane} />}
        </aside>
      )}

      {showMain && (
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {sec === 'home' && app.homeView === 'chat' && <ChatView />}
          {sec === 'home' && app.homeView === 'file' && <FilesView />}
          {sec === 'home' && app.homeView === 'agent' && (app.selectedAgent ? <AgentHome /> : <AgentsDirectory />)}
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
