// Requires only the project test emulator and a disposable browser-fixture server.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const adb = (...args) => exec(resolve('.tools/android-sdk/platform-tools/adb.exe'), ['-H', '127.0.0.1', '-P', '5041', '-s', '127.0.0.1:5581', ...args], { windowsHide: true });
if ((await adb('shell', 'getprop', 'ro.boot.qemu.avd_name')).stdout.trim() !== 'OurPlaceTest') throw new Error('Refusing non-test device');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
try {
  const page = browser.contexts()[0].pages()[0];
  const invoke = (method, args = {}) => page.evaluate(async ({ method, args }) =>
    (await window.Capacitor.Plugins.Household.invoke({ method, args })).value, { method, args });
  if ((await invoke('endpoint')) !== 'http://10.0.2.2:4173') throw new Error('Refusing non-test household');
  if (!(await invoke('state')).session) await page.getByRole('button', { name: 'Alex', exact: true }).click();
  const text = `Native browser handoff ${Date.now()} http://10.0.2.2:4173/health`;
  await page.getByLabel('What’s on your mind?').fill(text);
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: text });
  await expect(card).toHaveCount(1); await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Entry text').fill(text + '\nKeep my unfinished native edit');
  const link = page.locator('.entry-links a').first();
  const active = async () => (await adb('shell', 'dumpsys', 'activity', 'activities')).stdout.split('\n').filter(line => /topResumedActivity|mResumedActivity/.test(line)).join('\n');
  await link.click();
  await expect.poll(active).toContain('org.chromium.webview_shell');
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await expect.poll(active).toContain('dev.ourplace.household');
  await expect(page.getByLabel('Entry text')).toHaveValue(text + '\nKeep my unfinished native edit');
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(text + '\nKeep my unfinished native edit');
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const install = page.getByRole('link', { name: 'Open Android installation page', exact: false });
  await expect(install).toHaveAttribute('href', 'http://10.0.2.2:4173/install/');
  await install.click(); await expect.poll(active).toContain('org.chromium.webview_shell');
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await expect.poll(active).toContain('dev.ourplace.household');
  await expect(page.getByRole('heading', { name: 'Android app & updates', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/android-update-shortcut.png' });
  console.log('PASS: native web links open in the browser; Back retains unfinished edits; update shortcut uses the configured household endpoint.');
} finally { await browser.close(); }
