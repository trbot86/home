// Dedicated emulator and disposable fixture only; no household content is used.
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
assert.ok(process.env.OUR_PLACE_TEST_TOKEN, 'Fixture shutdown token is required');
const origin = 'http://127.0.0.1:4173';
assert.equal((await (await fetch(origin + '/health')).json()).development, true);
assert.deepEqual(
  (await (await fetch(origin + '/api/auth/options')).json()).profiles.map((p) => p.displayName).sort(),
  ['Alex', 'Sam'],
);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
try {
  const page = browser.contexts()[0].pages()[0];
  const invoke = (method, args = {}) =>
    page.evaluate(
      async ({ method, args }) => (await window.Capacitor.Plugins.Household.invoke({ method, args })).value,
      { method, args },
    );
  assert.equal((await invoke('state')).session, null, 'Use a fresh disposable emulator profile');
  await invoke('configure', { url: 'http://10.0.2.2:4173' });
  await invoke('login', { username: 'alex', password: '' });
  await page.reload();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await page.getByRole('button', { name: 'Customise agenda', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Customise your agenda', exact: true });
  await dialog.getByLabel('Make soon recipes', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Move Make soon recipes up', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move Make soon recipes up', exact: true }).click();
  await dialog.getByLabel('Your tasks today item limit', { exact: true }).fill('4');
  await adb('shell', 'input', 'keyevent', '4');
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await page.getByRole('button', { name: 'Customise agenda', exact: true }).click();
  await expect(dialog.getByLabel('Your tasks today item limit', { exact: true })).toHaveValue('4');
  assert.equal(await dialog.evaluate((e) => e.scrollWidth > e.clientWidth), false);
  await dialog.getByRole('button', { name: 'Save layout', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const native = (await invoke('state')).views.find((v) => v.kind === 'agenda');
  assert.ok(native);
  assert.equal(native.layout.sections[0].kind, 'food_soon');
  const login = await fetch(origin + '/api/auth/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alex', clientKind: 'browser' }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const headers = {
    origin,
    cookie: login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
    'x-client-id': session.clientId,
  };
  try {
    const cached = await (await fetch(origin + '/api/cache/inbox', { headers })).json();
    assert.deepEqual(
      cached.views.find((v) => v.kind === 'agenda'),
      native,
    );
  } finally {
    assert.equal((await fetch(origin + '/api/auth/logout', { method: 'POST', headers })).status, 200);
  }
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await expect.poll(async () => (await invoke('state')).session?.person.displayName).toBe('Sam');
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Make soon recipes', exact: true })).toHaveCount(0);
  assert.equal(
    (await invoke('state')).views.some((v) => v.kind === 'agenda'),
    false,
  );
  await page.getByLabel('Current profile').selectOption({ label: 'Alex' });
  await expect.poll(async () => (await invoke('state')).session?.person.displayName).toBe('Alex');
  await expect
    .poll(async () => (await invoke('state')).views.filter((v) => v.kind === 'agenda').length)
    .toBe(1);
  const stop = await fetch('http://127.0.0.1:4174/stop', {
    method: 'POST',
    headers: { 'x-test-token': process.env.OUR_PLACE_TEST_TOKEN },
  });
  assert.equal(stop.status, 200);
  await expect
    .poll(async () => {
      try {
        await fetch(origin + '/health');
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
  await invoke('refresh').catch(() => {});
  await page.reload();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Make soon recipes', exact: true })).toBeVisible();
  assert.deepEqual(
    (await invoke('state')).views.find((v) => v.kind === 'agenda'),
    native,
  );
  await page.getByRole('button', { name: 'Customise agenda', exact: true }).click();
  await dialog.getByLabel('Your tasks today item limit', { exact: true }).fill('');
  await expect(dialog.getByRole('button', { name: 'Save layout', exact: true })).toBeDisabled();
  await adb('shell', 'input', 'keyevent', '4');
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await page.getByRole('button', { name: 'Customise agenda', exact: true }).click();
  await expect(dialog.getByLabel('Your tasks today item limit', { exact: true })).toHaveValue('');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-results/android-agenda-layout-offline.png' });
  console.log(
    'PASS: native agenda layout syncs to a browser session, stays private to its profile, and preserves its SQLite cache and unfinished draft through Back, offline reload and server shutdown.',
  );
} finally {
  await browser.close();
}
