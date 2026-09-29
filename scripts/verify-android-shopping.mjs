// Run only with the project-owned emulator and scripts/browser-fixture.ts.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
try {
  const page = browser.contexts()[0].pages()[0];
  const invoke = (method, args = {}) =>
    page.evaluate(
      async ({ method, args }) => (await window.Capacitor.Plugins.Household.invoke({ method, args })).value,
      { method, args },
    );
  if ((await invoke('endpoint')) !== 'http://10.0.2.2:4173') throw new Error('Refusing a non-test household');
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  const dialog = page.getByRole('dialog').last();
  const name = `Native shopping ${Date.now()}`;
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Shopping list').locator('option:checked')).toHaveText(name);
  await page.getByLabel('Add a shopping item').fill('Native brush heads');
  await page.getByLabel('Quick quantity').fill('4 pack');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const row = page.locator('.shopping-row').filter({ hasText: 'Native brush heads' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Edit Native brush heads', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Notes', exact: true }).fill('Keep this unfinished native edit');
  await dialog.getByRole('heading', { name: 'Edit shopping item' }).click();
  const back = () =>
    exec(
      resolve('.tools/android-sdk/platform-tools/adb.exe'),
      ['-H', '127.0.0.1', '-P', '5041', '-s', 'emulator-5580', 'shell', 'input', 'keyevent', 'KEYCODE_BACK'],
      { windowsHide: true },
    );
  await back();
  // Wait for the asynchronous WebView callback before deciding whether the IME consumed Back.
  try {
    await expect(dialog).toHaveCount(0, { timeout: 1500 });
  } catch {
    await back();
  }
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Shopping', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await row.getByRole('button', { name: 'Edit Native brush heads', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(
    'Keep this unfinished native edit',
  );
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await row.getByRole('button', { name: 'Bought Native brush heads', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Purchased', exact: true }).click();
  await row.getByRole('button', { name: 'Edit Native brush heads', exact: true }).click();
  await expect(dialog).toContainText('Bought by Alex');
  await dialog.getByRole('button', { name: 'History', exact: true }).click();
  await expect(dialog.getByText('Marked purchased', { exact: true })).toBeVisible();
  await back();
  await back();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Shopping', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Need to buy', exact: true }).click();
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Edit Native brush heads', exact: true }).click();
  await expect(dialog.getByLabel('Notes', { exact: true })).toHaveValue('Keep this unfinished native edit');
  await back();
  const state = await invoke('state');
  if (
    !state.shopping.entries.some((entry) => entry.label === 'Native brush heads' && entry.state === 'needed')
  )
    throw new Error('Native cache missing shopping state');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Native horizontal overflow');
  await page.screenshot({ path: 'test-results/android-shopping-verified.png', fullPage: true });
  await back();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
  console.log(
    'PASS: native shopping create/edit, durable editor, purchase/undo, history bridge, dialog Back priority, cache and layout.',
  );
} finally {
  await browser.close();
}
