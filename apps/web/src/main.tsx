import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { OfflineGate, PwaHead, captureInstallPrompt } from './assist/touch/pwa';
import './styles/index.css';

// Phase F section 7.7: keep Android Chrome's install prompt for the account page's Install button.
captureInstallPrompt();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      {/* Phase F sections 7.5, 7.6: the manifest link and the app-shell worker, on /app routes only. */}
      <PwaHead />
      <OfflineGate>
        <App />
      </OfflineGate>
    </BrowserRouter>
  </StrictMode>,
);
