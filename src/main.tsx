import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';
import './styles/doc.css';
import { registerServiceWorker } from './lib/push';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: the service worker only handles push notifications and the install
// prompt — no fetch interception, so the app never serves stale code.
registerServiceWorker();
