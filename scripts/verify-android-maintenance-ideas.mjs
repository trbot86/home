// This check writes only to OurPlaceTest and the isolated browser fixture.
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
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Add asset', exact: true }).click();
  const name = `Native maintenance ideas ${Date.now()}`;
  await page.getByLabel('Asset name', { exact: true }).fill(name);
  await page.getByLabel('Who can see this', { exact: true }).selectOption({ label: 'Just me' });
  await page.getByLabel('Asset notes').press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const idea = () =>
    page
      .locator('.maintenance-idea')
      .filter({ has: page.getByRole('heading', { name: 'Clean the washing machine', exact: true }) });
  const browse = () => page.getByRole('button', { name: 'Browse maintenance ideas', exact: true }).click();
  await browse();
  await page.getByLabel('Maintenance idea category').selectOption('Laundry');
  await expect(idea()).toHaveCount(1);
  await page.getByRole('dialog').getByRole('heading', { name: 'Maintenance ideas', exact: true }).click();
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await browse();
  await idea().getByRole('button', { name: 'Customize task', exact: true }).click();
  await expect(page.getByLabel('Repeat after completion', { exact: true })).toHaveValue('off');
  await page
    .getByLabel('Instructions', { exact: true })
    .fill('Use our model manual. Keep this native draft.');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.locator('.home-asset-card').filter({ hasText: name }).click();
  await browse();
  await idea().getByRole('button', { name: 'Customize task', exact: true }).click();
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
    'Use our model manual. Keep this native draft.',
  );
  await expect(page.getByLabel('Who can see this').locator('option:checked')).toHaveText('Just me');
  await expect(page.getByLabel('Maintenance reference', { exact: true })).toHaveValue(
    /https:\/\/www.whirlpool.com/,
  );
  await page.getByLabel('Repeat after completion', { exact: true }).selectOption('months');
  await page.getByLabel('Instructions', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const task = page.locator('.home-maintenance-task').filter({ hasText: 'Clean the washing machine' });
  await expect(task).toHaveCount(1);
  await browse();
  await expect(idea().getByRole('button')).toBeDisabled();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-results/android-maintenance-ideas.png' });
  console.log(
    'PASS: native maintenance ideas, Back, independent Room draft recovery, private asset scope, editable recurrence, retained sources and duplicate-title indication.',
  );
} finally {
  await browser.close();
}
