// Requires verify-android-task-widget.mjs fixtures and one task widget added through the launcher.
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
assert.equal((await (await fetch('http://127.0.0.1:4173/health')).json()).development, true);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
const ui = async () => {
  await adb('shell', 'uiautomator', 'dump', '/sdcard/our-place-widget-test.xml');
  return (await adb('shell', 'cat', '/sdcard/our-place-widget-test.xml')).stdout;
};
const tap = async (text) => {
  const xml = await ui();
  const all = xml.match(/<node\s[^>]*>/g) ?? [];
  const accessible = all.filter((n) => n.includes(`content-desc="${text}"`));
  const nodes = accessible.length ? accessible : all.filter((n) => n.includes(`text="${text}"`));
  assert.equal(nodes.length, 1, `Expected exactly one native control: ${text}`);
  const bounds = nodes[0]
    .match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    .slice(1)
    .map(Number);
  await adb(
    'shell',
    'input',
    'tap',
    String(Math.round((bounds[0] + bounds[2]) / 2)),
    String(Math.round((bounds[1] + bounds[3]) / 2)),
  );
};
const home = () => adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
const app = () => adb('shell', 'am', 'start', '-n', 'dev.ourplace.household/.MainActivity');
let radiosDisabled = false;
try {
  const page = browser.contexts()[0].pages()[0];
  const invoke = (method, args = {}) =>
    page.evaluate(
      async ({ method, args }) => (await window.Capacitor.Plugins.Household.invoke({ method, args })).value,
      { method, args },
    );
  assert.equal(await invoke('endpoint'), 'http://10.0.2.2:4173');
  assert.equal((await invoke('state')).session.person.displayName, 'Alex');
  await invoke('refresh');
  await home();
  await expect.poll(ui).toContain('Another widget household priority');
  assert.ok((await ui()).includes('Widget work priority'));
  assert.ok(!(await ui()).includes('Private widget gift'));
  await tap('Settings');
  await tap('Home / Work');
  await tap('Home');
  await tap('Include my private tasks');
  await tap('SAVE WIDGET');
  await expect.poll(ui).toContain('Private widget gift');
  let xml = await ui();
  assert.ok(xml.includes('Another widget household priority'));
  assert.ok(!xml.includes('Widget work priority'));
  console.log('PASS: actual launcher configuration filters Home/Work and requires private-task opt-in.');

  // A real row tap must resolve through the app's scoped cache.
  await tap('Private widget gift');
  await expect(page.locator('.task-card')).toHaveCount(1);
  await expect(page.locator('.task-card')).toContainText('Private widget gift');
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await expect.poll(async () => (await invoke('state')).session.person.displayName).toBe('Sam');
  await home();
  await expect.poll(ui).toContain('Open the app with this widget’s profile.');
  xml = await ui();
  assert.ok(!xml.includes('Private widget gift'));
  assert.ok(!xml.includes('Another widget household priority'));
  await app();
  await page.getByLabel('Current profile').selectOption({ label: 'Alex' });
  await expect.poll(async () => (await invoke('state')).session.person.displayName).toBe('Alex');
  await home();
  await expect.poll(ui).toContain('Private widget gift');
  console.log(
    'PASS: profile switching clears all widget task content and restores only its configured owner.',
  );

  radiosDisabled = true;
  await adb('shell', 'svc', 'wifi', 'disable');
  await adb('shell', 'svc', 'data', 'disable');
  await tap('Refresh');
  await expect.poll(async () => (await invoke('state')).online, { timeout: 45000 }).toBe(false);
  xml = await ui();
  assert.ok(xml.includes('Private widget gift') && xml.includes('Downloaded'));
  await tap('Private widget gift');
  await expect(page.locator('.task-card')).toContainText('Private widget gift');
  await expect(
    page.locator('.task-card').getByRole('button', { name: 'Complete Private widget gift', exact: true }),
  ).toBeDisabled();
  await adb('shell', 'svc', 'wifi', 'enable');
  await adb('shell', 'svc', 'data', 'enable');
  radiosDisabled = false;
  await expect
    .poll(
      async () => {
        try {
          await invoke('refresh');
        } catch {}
        return (await invoke('state')).online;
      },
      { timeout: 45000 },
    )
    .toBe(true);
  await home();
  await tap('Settings');
  await tap('Include my private tasks');
  await tap('SAVE WIDGET');
  await expect.poll(ui).not.toContain('Private widget gift');
  assert.ok((await ui()).includes('Another widget household priority'));
  await tap('Open completion form');
  await expect(page.getByRole('dialog', { name: 'Record completion', exact: true })).toContainText(
    'Another widget household priority',
  );
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await home();
  await tap('Open date controls');
  await expect(page.locator('.task-card .task-postpone')).toHaveAttribute('open', '');
  await home();
  await adb('shell', 'screencap', '-p', '/sdcard/our-place-widget-test.png');
  await adb('pull', '/sdcard/our-place-widget-test.png', '.local/task-widget-launcher.png');
  console.log(
    'PASS: cached widget remains readable offline, task changes require connection, and real launcher buttons open the exact completion and date controls.',
  );
} finally {
  if (radiosDisabled) {
    await adb('shell', 'svc', 'wifi', 'enable');
    await adb('shell', 'svc', 'data', 'enable');
  }
  await browser.close();
}
