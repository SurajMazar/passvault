import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmProvider, ToastProvider, applyTheme } from '@passvault/ui';
import './popup.css';
import { App } from './App';

// Light/dark follows the system setting.
applyTheme('system');
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme('system'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
);
