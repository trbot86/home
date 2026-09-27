// Only the dedicated test emulator and disposable browser fixture are permitted.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const adb = (...args) =>
  exec(
    resolve('.tools/android-sdk/platform-tools/adb.exe'),
    ['-H', '127.0.0.1', '-P', '5041', '-s', '127.0.0.1:5581', ...args],
    { windowsHide: true },
  );
assert.equal((await adb('shell', 'getprop', 'ro.boot.qemu.avd_name')).stdout.trim(), 'OurPlaceTest');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
let external;
try {
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  const invoke = (method, args = {}) =>
    page.evaluate(
      async ({ method, args }) => (await window.Capacitor.Plugins.Household.invoke({ method, args })).value,
      { method, args },
    );
  if (process.argv.includes('--configure')) {
    assert.equal((await invoke('state')).session, null);
    await invoke('configure', { url: 'http://10.0.2.2:4173' });
  }
  assert.equal(await invoke('endpoint'), 'http://10.0.2.2:4173');
  if (!(await invoke('state')).session) await invoke('login', { username: 'alex', password: '' });
  await page.reload();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  const draft = `Keep my native capture during calendar setup ${Date.now()}`;
  await page.getByLabel('What’s on your mind?').fill(draft);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.calendar-settings')).toContainText('Use your browser to connect Google');
  const link = page.getByRole('link', { name: 'Open calendar settings in browser', exact: false });
  await expect(link).toHaveAttribute('href', 'http://10.0.2.2:4173/?settings=calendars');
  await link.click();
  const active = async () =>
    (await adb('shell', 'dumpsys', 'activity', 'activities')).stdout
      .split('\n')
      .filter((line) => /topResumedActivity|mResumedActivity/.test(line))
      .join('\n');
  await expect.poll(active).toContain('org.chromium.webview_shell');
  const externalPid = (await adb('shell', 'pidof', 'org.chromium.webview_shell')).stdout.trim();
  assert.match(externalPid, /^\d+$/);
  await adb('forward', 'tcp:9224', `localabstract:webview_devtools_remote_${externalPid}`);
  external = await chromium.connectOverCDP('http://127.0.0.1:9224', { noDefaults: true });
  let externalPage;
  for (const candidate of external.contexts().flatMap((context) => context.pages())) {
    if (await candidate.evaluate(() => document.visibilityState === 'visible')) externalPage = candidate;
  }
  assert.ok(externalPage, 'Expected a visible external-browser page');
  await expect(externalPage).toHaveURL('http://10.0.2.2:4173/?settings=calendars');
  await expect(
    externalPage
      .getByRole('button', { name: 'Alex', exact: true })
      .or(externalPage.getByRole('heading', { name: 'Google Calendar', exact: true })),
  ).toBeVisible();
  if (await externalPage.getByRole('button', { name: 'Alex', exact: true }).count())
    await externalPage.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(externalPage.getByRole('heading', { name: 'Google Calendar', exact: true })).toBeVisible();
  await expect(
    externalPage.getByRole('button', { name: 'Connect Google account', exact: true }),
  ).toBeEnabled();
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await expect.poll(active).toContain('dev.ourplace.household');
  await expect(page.getByRole('heading', { name: 'Google Calendar', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-results/android-calendar-settings.png' });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue(draft);
  console.log(
    'PASS: Android opens calendar settings in its external browser; Back returns to the app with the unfinished capture preserved. Real Google consent is not simulated in the emulator browser.',
  );
} finally {
  await external?.close();
  await browser.close();
}
