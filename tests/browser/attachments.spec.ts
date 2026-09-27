import { expect, test, type Page } from '@playwright/test';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);
const file = (name: string) => ({ name, mimeType: 'image/png', buffer: png });
async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
}
async function task(page: Page, title: string) {
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill(title);
  await page.getByLabel('Instructions', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return page.locator('.task-card').filter({ hasText: title });
}

test('photo edits survive reload, reorder with captions, support undo and completion receipts', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const card = await task(page, 'Photo test: replace filter');
  await card.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Photos & receipts', exact: true });
  await dialog.locator('input[type=file]').setInputFiles([file('label.png'), file('receipt.png')]);
  await expect(dialog.getByLabel('Caption for photo 2')).toBeVisible();
  await dialog.getByLabel('Caption for photo 1').fill('Filter label');
  await dialog.getByLabel('Caption for photo 2').fill('Receipt from the shop');
  await dialog.getByRole('button', { name: 'Move photo 2 earlier', exact: true }).click();
  await expect(dialog.getByLabel('Caption for photo 1')).toHaveValue('Receipt from the shop');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  await card.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  await expect(dialog.getByLabel('Caption for photo 1')).toHaveValue('Receipt from the shop');
  await expect(dialog.locator('img')).toHaveCount(2);
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
      `Photo editor fits ${width}px`,
    ).toBe(true);
    await page.screenshot({ path: `test-results/attachments-${width}.png` });
  }
  await dialog.getByLabel('Caption for photo 1').press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(card.locator('img')).toHaveCount(2);
  await page.getByRole('button', { name: 'Dismiss confirmation', exact: true }).click();
  await page.keyboard.press('Control+z');
  await expect(card.locator('img')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(card.locator('img')).toHaveCount(2);
  const second = await browser.newContext();
  const partner = await second.newPage();
  await partner.goto('/');
  await partner.getByRole('button', { name: 'Sam', exact: true }).click();
  await partner.getByRole('button', { name: 'Tasks', exact: true }).click();
  await partner.getByRole('button', { name: 'All tasks', exact: true }).click();
  const shared = partner.locator('.task-card').filter({ hasText: 'Photo test: replace filter' });
  await expect(shared.locator('img')).toHaveCount(2);
  await expect
    .poll(() =>
      shared
        .locator('img')
        .first()
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await second.close();
  await card.getByRole('button', { name: 'Complete Photo test: replace filter', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  const completion = page.locator('.completion-card').filter({ hasText: 'Photo test: replace filter' });
  await completion.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  await dialog.locator('input[type=file]').setInputFiles(file('done.png'));
  await dialog.getByLabel('Caption for photo 1').fill('Installed and tested');
  await dialog.getByLabel('Caption for photo 1').press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(completion.locator('figcaption')).toHaveText('Installed and tested');
  await completion.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.history-list img')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a lost attachment reply keeps the frozen draft and recovers without reuploading', async ({ page }) => {
  await login(page);
  const card = await task(page, 'Photo test: uncertain save');
  await card.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Photos & receipts', exact: true });
  await dialog.locator('input[type=file]').setInputFiles(file('pending.png'));
  await expect(dialog.getByLabel('Caption for photo 1')).toBeVisible();
  let sends = 0,
    uploads = 0,
    dropped = false,
    allowReceipt = false;
  page.on('request', (request) => {
    if (request.url().includes('/media/') && request.url().endsWith('/prepare')) uploads++;
  });
  await page.route('**/api/commands/SetRecordAttachments', async (route) => {
    sends++;
    await route.fetch();
    dropped = true;
    await route.abort('failed');
  });
  await page.route('**/api/operations/**', async (route) => {
    if (dropped && !allowReceipt) await route.abort('failed');
    else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Save photos', exact: true }).click();
  await expect.poll(() => dropped).toBe(true);
  await expect(dialog.getByLabel('Caption for photo 1')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Discard photo edits', exact: true })).toHaveCount(0);
  allowReceipt = true;
  await page.reload();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  await expect(card.locator('img')).toHaveCount(1);
  await card.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  await dialog.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(sends).toBe(1);
  expect(uploads).toBe(1);
});

test('browser database migration preserves old frozen captures, media and editor buffers', async ({
  page,
}) => {
  await page.goto('/health');
  const frozen = '{"operationId":"migration-test","arguments":{"text":"keep exact bytes"}}';
  await page.evaluate(async (frozen) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('our-place', 1);
      request.onupgradeneeded = () => {
        for (const store of ['drafts', 'media', 'attempts', 'editors', 'cache', 'profiles', 'meta'])
          request.result.createObjectStore(store);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['drafts', 'media', 'attempts', 'editors'], 'readwrite');
    tx.objectStore('drafts').put(
      { draftId: 'old-draft', clientId: 'old-owner', state: 'SUBMITTED', frozenJson: frozen },
      'old-draft',
    );
    tx.objectStore('attempts').put({ frozenJson: frozen }, 'old-owner:record');
    tx.objectStore('media').put({ bytes: new Blob(['keep original']) }, 'old-owner:media');
    tx.objectStore('editors').put({ text: 'unfinished words' }, 'old-owner:record');
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, frozen);
  await login(page);
  const kept = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('our-place');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const read = (store: string, key: string) =>
      new Promise<any>((resolve, reject) => {
        const r = db.transaction(store).objectStore(store).get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    const draft = await read('drafts', 'old-draft'),
      attempt = await read('attempts', 'old-owner:record'),
      media = await read('media', 'old-owner:media'),
      editor = await read('editors', 'old-owner:record');
    const result = {
      version: db.version,
      store: db.objectStoreNames.contains('attachmentDrafts'),
      draft: draft.frozenJson,
      attempt: attempt.frozenJson,
      media: await media.bytes.text(),
      editor: editor.text,
    };
    db.close();
    return result;
  });
  expect(kept).toEqual({
    version: 2,
    store: true,
    draft: frozen,
    attempt: frozen,
    media: 'keep original',
    editor: 'unfinished words',
  });
});
