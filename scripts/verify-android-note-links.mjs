// Run only against the disposable browser fixture and the project's test emulator.
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
  const title = `Private native reference ${Date.now()}`;
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Just me' });
  const capture = async (text) => {
    await page.getByLabel('What’s on your mind?').fill(text);
    await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
    const card = page.locator('.entry-card').filter({ hasText: text.split('\n')[0] });
    await expect(card).toHaveCount(1); return card;
  };
  const target = await capture(title);
  await target.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.getByText('Link copied', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  const input = page.getByLabel('What’s on your mind?');
  await input.click();
  await adb('shell', 'input', 'keyevent', 'KEYCODE_PASTE');
  await expect(input).toHaveValue(/^http:\/\/10\.0\.2\.2:4173\/\?entry=/);
  const url = await input.inputValue();
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Shared' });
  const text = `Native linked reference ${Date.now()}\n${url}`;
  const source = await capture(text);
  await source.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Entry text').fill(text + '\nUnfinished native notes');
  await page.locator('.entry-links').getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(title);
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await source.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(text + '\nUnfinished native notes');
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await expect(source.getByRole('link', { name: 'Open note', exact: true })).toBeVisible();
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  await source.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.entry-links').getByRole('link', { name: 'Open note', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('unavailable for your profile');
  await page.screenshot({ path: 'test-results/android-note-links.png' });
  console.log('PASS: native clipboard copy/paste, internal link navigation, draft retention, Back, and private title isolation.');
} finally { await browser.close(); }
