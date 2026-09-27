import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import { Capacitor } from '@capacitor/core';
import './ui/styles.css';

async function start() {
  const client = Capacitor.isNativePlatform()
    ? new (await import('./platform/android/android-client.js')).AndroidClient()
    : new (await import('./platform/browser/browser-client.js')).BrowserClient();
  createRoot(document.getElementById('root')!).render(<App client={client} />);
  if (!Capacitor.isNativePlatform() && import.meta.env.PROD && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* Shell caching can retry on the next visit. */
    });
  }
}
void start();
