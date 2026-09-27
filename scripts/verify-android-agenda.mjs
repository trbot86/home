// Synthetic data only: dedicated emulator, disposable HTTP fixture, no Google requests.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
const headers = { origin, 'content-type': 'application/json' };
async function request(path, body) {
  const response = await fetch(origin + path, {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
  });
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  return response;
}
const options = await (await request('/api/auth/options')).json();
assert.deepEqual(options.profiles.map((p) => p.displayName).sort(), ['Alex', 'Sam']);
const login = await request('/api/auth/login', { username: 'alex', clientKind: 'browser' }),
  session = await login.json();
headers.cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
headers['x-client-id'] = session.clientId;
const begun = await request('/api/calendars/authorization/begin', { label: 'Native agenda fixture' });
const authorization = new URL((await begun.json()).authorizationUrl);
assert.equal(authorization.searchParams.has('client_id'), false, 'Refuse real Google configuration');
const callback = await fetch(
  origin +
    '/oauth/calendar/callback?state=' +
    authorization.searchParams.get('state') +
    '&code=' +
    randomUUID(),
  {
    headers: {
      cookie: begun.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    },
    redirect: 'manual',
  },
);
assert.equal(callback.status, 302);
const handoffId = new URL(callback.headers.get('location'), origin).searchParams.get('calendarConnect');
const connected = await (await request('/api/calendars/authorization/finish', { handoffId })).json();
const settings = await (await request('/api/calendars/settings')).json();
const source = settings.connections
  .find((c) => c.connectionId === connected.connectionId)
  .calendars.find((c) => c.title === 'Personal calendar');
const selected = await (
  await request('/api/commands/SelectCalendar', {
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: session.serverEpoch,
    arguments: {
      calendarId: source.calendarId,
      expectedRevision: source.revision,
      scopeId: session.scopes.find((s) => s.kind === 'private').scopeId,
      context: 'work',
    },
  })
).json();
assert.equal(selected.status, 'Applied');
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
  await expect
    .poll(
      async () => {
        await invoke('refresh');
        return page.getByRole('heading', { name: 'Private calendar detail', exact: true }).count();
      },
      { timeout: 20000 },
    )
    .toBe(1);
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('home');
  await expect(page.getByRole('heading', { name: 'Private calendar detail', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('work');
  await expect(page.getByRole('heading', { name: 'Private calendar detail', exact: true })).toBeVisible();
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await expect.poll(async () => (await invoke('state')).session?.person.displayName).toBe('Sam');
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Personal agenda', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Private calendar detail', exact: true })).toHaveCount(0);
  await page.getByLabel('Current profile').selectOption({ label: 'Alex' });
  await expect.poll(async () => (await invoke('state')).session?.person.displayName).toBe('Alex');
  await expect.poll(async () => (await invoke('state')).agenda.calendars.length).toBe(1);
  const cached = (await invoke('state')).agenda;
  assert.equal(cached.calendars[0].events.length, 2);
  const stopped = await fetch('http://127.0.0.1:4174/stop', {
    method: 'POST',
    headers: { 'x-test-token': process.env.OUR_PLACE_TEST_TOKEN },
  });
  assert.equal(stopped.status, 200);
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
  await expect(page.locator('.agenda')).toContainText('Offline · showing the last download');
  await expect(page.getByRole('heading', { name: 'Private calendar detail', exact: true })).toBeVisible();
  assert.deepEqual((await invoke('state')).agenda, cached);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-results/android-agenda-offline.png' });
  console.log(
    'PASS: native agenda uses scheduled fixture data, separates profiles and Home/Work, and survives server shutdown/reload with its exact SQLite snapshot.',
  );
} finally {
  await browser.close();
}
