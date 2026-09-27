// This check can only operate on the disposable project emulator and browser fixture.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
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
    assert.equal((await invoke('state')).session, null, 'Configuration requires a fresh test profile');
    await invoke('configure', { url: 'http://10.0.2.2:4173' });
  }
  assert.equal(await invoke('endpoint'), 'http://10.0.2.2:4173', 'Refusing non-test household');
  if (!(await invoke('state')).session) await invoke('login', { username: 'alex', password: '' });
  await page.reload();
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  await page.getByRole('button', { name: 'Save a recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Write a recipe', exact: true }).click();
  const title = `Native soup ${Date.now()}`;
  await page.getByLabel('Recipe name', { exact: true }).fill(title);
  await page.getByLabel('Ingredients', { exact: true }).fill('2 carrots\n1 onion');
  await page.getByLabel('Directions', { exact: true }).fill('Keep this unfinished recipe.');
  await page.getByRole('dialog').getByRole('heading').click();
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  try {
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 1500 });
  } catch {
    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  }
  await page.reload();
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  await page.getByRole('button', { name: 'Save a recipe', exact: true }).click();
  await expect(page.getByLabel('Recipe name', { exact: true })).toHaveValue(title);
  await expect(page.getByLabel('Directions', { exact: true })).toHaveValue('Keep this unfinished recipe.');
  await page.getByRole('button', { name: 'Save to Want to try', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Photos', exact: true }).click();
  const recipe = (await invoke('state')).recipes.recipes.find((r) => r.title === title);
  const draft = await invoke('openAttachmentDraft', {
    recordId: recipe.recordId,
    scopeId: recipe.scopeId,
    revision: recipe.revision,
    attachments: [],
  });
  await invoke('addAttachmentPhoto', {
    draftId: draft.draftId,
    mimeType: 'image/png',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  });
  await page.getByLabel('Caption for photo 1').fill('Native recipe photo');
  await page.getByRole('button', { name: 'Save photos', exact: true }).click();
  await expect
    .poll(() => page.locator('.food-detail img').evaluate((img) => img.naturalWidth))
    .toBeGreaterThan(0);
  await page.locator('.food-detail').getByRole('button', { name: 'Make soon', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pinned for soon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Add a note', exact: true }).click();
  await page.getByLabel('Adjustment', { exact: true }).fill('Add lemon next time.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.food-adjustments')).toContainText('Add lemon next time.');
  await page.getByRole('button', { name: 'Record cooking', exact: true }).click();
  await page.getByLabel('Cooked at', { exact: true }).fill('2026-02-13T18:30');
  await page.getByLabel('Cooking notes', { exact: true }).fill('Shared native dinner.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.food-cooking')).toContainText('Shared native dinner.');
  await page.getByRole('button', { name: 'Save a recipe', exact: true }).click();
  await page.getByLabel('Recipe source link', { exact: true }).fill('https://example.com/multiple');
  await page.getByRole('button', { name: 'Save to Want to try', exact: true }).click();
  await expect(page.locator('.food-import-status')).toContainText('Waiting');
  const token = (await readFile('.local/food-fixture-token.txt', 'utf8')).trim();
  const control = async (path) => {
    const response = await fetch(`http://127.0.0.1:4174/${path}`, {
      method: 'POST',
      headers: { 'x-test-token': token },
    });
    assert.equal(response.status, 200);
  };
  await control('run-recipe-import');
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
  await page.getByRole('button', { name: 'Review import', exact: true }).click();
  await page.getByLabel('Recipe found on page', { exact: true }).selectOption({ label: 'Synthetic stew' });
  await page.getByRole('button', { name: 'Apply selected details', exact: true }).click();
  await expect(page.locator('.food-detail-heading')).toContainText('Synthetic stew');
  await expect(page.locator('.food-detail')).toContainText('2 carrots');
  await invoke('login', { username: 'sam', password: '' });
  await page.reload();
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  await page.locator('.food-card').filter({ hasText: title }).click();
  await expect(page.locator('.food-adjustments')).toContainText('Add lemon next time.');
  await expect
    .poll(() => page.locator('.food-detail img').evaluate((img) => img.naturalWidth))
    .toBeGreaterThan(0);
  await page.getByText('Recipe options', { exact: true }).click();
  await page.getByRole('button', { name: 'Recipe history', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('.history-list img')
        .first()
        .evaluate((img) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('.food-detail-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/android-food-verified.png' });
  const before = await invoke('state');
  await control('stop');
  await assert.rejects(invoke('refresh'));
  await page.reload();
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  await page.locator('.food-card').filter({ hasText: title }).click();
  await expect(page.locator('.food-section')).toContainText('Your saved recipes are available here');
  await expect
    .poll(() => page.locator('.food-detail img').evaluate((img) => img.naturalWidth))
    .toBeGreaterThan(0);
  const after = await invoke('state');
  for (const field of ['session', 'recipes', 'recipeImports', 'views'])
    assert.deepEqual(after[field], before[field]);
  console.log(
    'PASS: native Food form recovery, Back, photo upload/download, notes, cooking, Soon, import review, history and offline Room/photo cache.',
  );
} finally {
  await browser.close();
}
