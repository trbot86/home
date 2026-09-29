// Dedicated emulator and disposable synthetic server only. Never uses a household database.
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
assert.ok(process.env.OUR_PLACE_TEST_TOKEN, 'Fixture shutdown token required');
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
  const session = (await invoke('state')).session,
    scopeId = session.scopes.find((s) => s.kind === 'shared').scopeId;
  const run = async (kind, args) => {
    const result = await invoke('command', {
      recordId: args.recordId,
      kind,
      arguments: args,
      expectedServerEpoch: session.serverEpoch,
    });
    assert.equal(result.status, 'Applied', kind);
    return result;
  };
  const listId = crypto.randomUUID(),
    productId = crypto.randomUUID(),
    entryId = crypto.randomUUID(),
    purchaseId = crypto.randomUUID();
  await run('CreateShoppingList', {
    recordId: listId,
    scopeId,
    name: 'Native photo shopping',
    purpose: 'household',
  });
  await run('CreateRestockItem', {
    recordId: productId,
    scopeId,
    name: 'Native photo brush heads',
    model: 'Compatible size',
    quantity: '4 pack',
    notes: '',
    productUrl: null,
  });
  await page.reload();
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption(listId);
  await page.getByRole('button', { name: 'Restock shelf', exact: true }).click();
  const product = page.locator('.restock-card').filter({ hasText: 'Native photo brush heads' });
  await product.getByRole('button', { name: 'Product photos', exact: true }).click();
  const photoDraft = await invoke('openAttachmentDraft', {
    recordId: productId,
    scopeId,
    revision: 1,
    attachments: [],
  });
  const addPhoto = (draftId) =>
    invoke('addAttachmentPhoto', {
      draftId,
      mimeType: 'image/png',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
    });
  await addPhoto(photoDraft.draftId);
  const dialog = page.getByRole('dialog', { name: 'Photos & receipts', exact: true });
  await dialog.getByLabel('Caption for photo 1').fill('Native package label');
  await dialog.getByRole('heading').click();
  await adb('shell', 'input', 'keyevent', '4');
  if (await dialog.count()) await adb('shell', 'input', 'keyevent', '4');
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption(listId);
  await page.getByRole('button', { name: 'Restock shelf', exact: true }).click();
  await product.getByRole('button', { name: 'Product photos', exact: true }).click();
  await expect(dialog.getByLabel('Caption for photo 1')).toHaveValue('Native package label');
  await dialog.getByRole('button', { name: 'Save photos', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(product.locator('figcaption')).toHaveText('Native package label');
  await run('NeedRestockItem', {
    recordId: entryId,
    listId,
    restockItemId: productId,
    expectedRestockRevision: 2,
  });
  await run('PurchaseShoppingEntry', {
    recordId: entryId,
    expectedRevision: 1,
    purchaseId,
    purchaseItemId: crypto.randomUUID(),
    boughtAt: Date.now(),
  });
  await page.getByRole('button', { name: 'Purchased', exact: true }).click();
  const item = page.locator('.shopping-row').filter({ hasText: 'Native photo brush heads' });
  await item.getByRole('button', { name: 'Edit Native photo brush heads', exact: true }).click();
  const row = page.locator('.shopping-entry-details');
  await row.getByRole('button', { name: 'Receipt photos', exact: true }).click();
  const receipt = await invoke('openAttachmentDraft', {
    recordId: purchaseId,
    scopeId,
    revision: 1,
    attachments: [],
  });
  await addPhoto(receipt.draftId);
  await dialog.getByLabel('Caption for photo 1').fill('Native purchase receipt');
  await dialog.getByRole('button', { name: 'Save photos', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Close shopping dialog' }).click();
  // A second profile must download server bytes, independently of the captured originals.
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption(listId);
  await page.getByRole('button', { name: 'Purchased', exact: true }).click();
  await item.getByRole('button', { name: 'Edit Native photo brush heads', exact: true }).click();
  await row.locator('summary').filter({ hasText: 'Product photos' }).click();
  await row.locator('summary').filter({ hasText: 'Receipt photos' }).click();
  await expect(row.locator('img')).toHaveCount(2);
  await expect
    .poll(() =>
      row.locator('img').evaluateAll((imgs) => imgs.every((img) => img.complete && img.naturalWidth > 0)),
    )
    .toBe(true);
  await row.getByRole('button', { name: 'Purchase history', exact: true }).click();
  await expect(page.locator('.history-list img')).toHaveCount(1);
  await adb('shell', 'input', 'keyevent', '4');
  await adb('shell', 'input', 'keyevent', '4');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const before = (await invoke('state')).shopping;
  assert.equal(
    (
      await fetch('http://127.0.0.1:4174/stop', {
        method: 'POST',
        headers: { 'x-test-token': process.env.OUR_PLACE_TEST_TOKEN },
      })
    ).status,
    200,
  );
  await invoke('refresh').catch(() => {});
  await page.reload();
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption(listId);
  await page.getByRole('button', { name: 'Purchased', exact: true }).click();
  await item.getByRole('button', { name: 'Edit Native photo brush heads', exact: true }).click();
  await row.locator('summary').filter({ hasText: 'Product photos' }).click();
  await row.locator('summary').filter({ hasText: 'Receipt photos' }).click();
  await expect(row.locator('img')).toHaveCount(2);
  await expect
    .poll(() =>
      row.locator('img').evaluateAll((imgs) => imgs.every((img) => img.complete && img.naturalWidth > 0)),
    )
    .toBe(true);
  await expect(row).toContainText('Native package label');
  await expect(row).toContainText('Native purchase receipt');
  assert.deepEqual((await invoke('state')).shopping, before);
  await row.getByRole('button', { name: 'Receipt photos', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Save photos', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Caption for photo 1')).toHaveValue('Native purchase receipt');
  await adb('shell', 'input', 'keyevent', '4');
  await expect(dialog).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/android-shopping-photos-offline.png' });
  console.log(
    'PASS: native product and purchase photos preserve drafts across Back/reload, sync to the partner, appear in history and remain readable offline without altering shopping records.',
  );
} finally {
  await browser.close();
}
