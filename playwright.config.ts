import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
process.env['PLAYWRIGHT_BROWSERS_PATH'] = resolve('.cache/playwright');
process.env['OUR_PLACE_TEST_TOKEN'] ??= randomUUID();
export default defineConfig({
  testDir: './tests/browser', workers: 1, fullyParallel: false, timeout: 30000,
  globalTeardown: './scripts/browser-teardown.ts',
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 1100 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node --import tsx scripts/browser-fixture.ts', url: 'http://127.0.0.1:4173/health', reuseExistingServer: false, timeout: 60000 },
});
