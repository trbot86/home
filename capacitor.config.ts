import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'dev.ourplace.household',
  appName: 'Our place',
  webDir: 'apps/web/dist',
  android: { path: 'apps/android', allowMixedContent: false, backgroundColor: '#20231f' },
  plugins: {
    SystemBars: { insetsHandling: 'native', initialViewportFitValueHint: 'contain', style: 'DARK' },
  },
  server: { androidScheme: 'https', hostname: 'localhost' },
};
export default config;
