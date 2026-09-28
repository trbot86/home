import { useEffect, useState } from 'react';
import type { ClientPlatform } from '@our-place/client';
import { checkAppUpdate, type InstalledVersion } from './app-version.js';

export function useAppVersion(client: ClientPlatform, online: boolean) {
  const [installed, setInstalled] = useState<InstalledVersion | null>(null);
  const [update, setUpdate] = useState<'available' | 'current' | 'unavailable'>('unavailable');
  useEffect(() => {
    let alive = true;
    let pending = false;
    setUpdate('unavailable');
    const check = async () => {
      if (pending || document.visibilityState === 'hidden' || !client.appVersion) return;
      pending = true;
      try {
        const value = await client.appVersion();
        if (!alive) return;
        setInstalled(value);
        const result =
          online && client.publishedAppVersion
            ? await checkAppUpdate(value, () => client.publishedAppVersion!())
            : 'unavailable';
        if (alive) setUpdate(result);
      } catch {
        if (alive) setUpdate('unavailable');
      } finally {
        pending = false;
      }
    };
    void check();
    const refresh = () => {
      void check();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [client, online]);
  return { installed, update };
}
