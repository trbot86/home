// Run against the project-owned emulator and scripts/browser-fixture.ts only.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const adb = resolve('.tools/android-sdk/platform-tools/adb.exe');
const device = ['-H', '127.0.0.1', '-P', '5041', '-s', '127.0.0.1:5581'];
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
try {
  const page = browser.contexts()[0].pages()[0];
  const invoke = (method, args = {}) =>
    page.evaluate(
      async ({ method, args }) => (await window.Capacitor.Plugins.Household.invoke({ method, args })).value,
      { method, args },
    );
  const oldState = await invoke('state');
  const oldEndpoint = await invoke('endpoint');
  if (!oldEndpoint.startsWith('http://10.0.2.2:')) throw new Error('Refusing a non-test household');
  if (oldState.session) await invoke('logout');
  await invoke('configure', { url: 'http://10.0.2.2:4173' });
  await invoke('login', { username: 'alex', password: '' });
  await page.reload();
  const text = `Back-navigation fixture ${Date.now()}`;
  await page.getByLabel('What’s on your mind?').fill(text);
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: text });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByLabel('Entry text', { exact: true });
  await editor.fill(text + ' unfinished');
  // Defocus before sending Back so this assertion exercises the app rather than IME dismissal.
  await page.getByRole('button', { name: 'Entry', exact: true }).click();
  const back = () =>
    exec(adb, [...device, 'shell', 'input', 'keyevent', 'KEYCODE_BACK'], { windowsHide: true });
  await back();
  // A visible keyboard consumes the first Back on Android, as usual.
  if (await page.getByRole('dialog').isVisible()) await back();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor).toHaveValue(text + ' unfinished');
  await page.getByRole('button', { name: 'Close entry' }).click();
  await card.getByRole('button', { name: 'History', exact: true }).click();
  await back();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await back();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
  await page.screenshot({ path: 'test-results/android-back-verified.png' });
  const activity = await exec(adb, [...device, 'shell', 'dumpsys', 'activity', 'activities'], {
    windowsHide: true,
  });
  if (!/(?:mResumedActivity:|topResumedActivity=).*dev\.ourplace\.household/.test(activity.stdout))
    throw new Error('App lost foreground');
  console.log(
    'PASS: Android Back closes edit/history, retains unfinished text, returns suggestions to Inbox, and stays in the app.',
  );
} finally {
  await browser.close();
}
