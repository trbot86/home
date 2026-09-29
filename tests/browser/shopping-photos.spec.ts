import { expect, test, type Page } from '@playwright/test';

const file = {
  name: 'fixture.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
    'base64',
  ),
};
async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
}
async function list(page: Page, name: string, privateOnly = false) {
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(name);
  await page
    .getByRole('dialog')
    .getByLabel('Who can see this')
    .selectOption({ label: privateOnly ? 'Just me' : 'Shared' });
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function product(page: Page, name: string, privateOnly = false) {
  await page.getByRole('button', { name: 'Restock shelf', exact: true }).click();
  await page.getByRole('button', { name: 'New product', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(name);
  await page
    .getByRole('dialog')
    .getByLabel('Who can see this')
    .selectOption({ label: privateOnly ? 'Just me' : 'Shared' });
  await page.getByRole('dialog').getByLabel('Model or size').fill('Compatible size');
  await page.getByRole('dialog').getByLabel('Notes', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return page.locator('.restock-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
}
async function photo(page: Page, caption: string) {
  const dialog = page.getByRole('dialog', { name: 'Photos & receipts', exact: true });
  await dialog.locator('input[type=file]').setInputFiles(file);
  await dialog.getByLabel('Caption for photo 1').fill(caption);
  return dialog;
}
test('product photos stay with restocking while receipt photos retain purchase history, undo and activity', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await list(page, 'Photo shopping');
  const card = await product(page, 'Photo brush heads');
  await card.getByRole('button', { name: 'Product photos', exact: true }).click();
  let dialog = await photo(page, 'Package label');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Photo shopping' });
  await page.getByRole('button', { name: 'Restock shelf', exact: true }).click();
  await card.getByRole('button', { name: 'Product photos', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Photos & receipts', exact: true });
  await expect(dialog.getByLabel('Caption for photo 1')).toHaveValue('Package label');
  await dialog.getByLabel('Caption for photo 1').press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(card.locator('figcaption')).toHaveText('Package label');
  await card.getByRole('button', { name: 'Need this', exact: true }).click();
  await page.getByRole('button', { name: 'Need to buy', exact: true }).click();
  const item = page.locator('.shopping-row').filter({ hasText: 'Photo brush heads' });
  await item.getByRole('button', { name: 'Edit Photo brush heads', exact: true }).click();
  const row = page.locator('.shopping-entry-details');
  await row.locator('summary').filter({ hasText: 'Product photos' }).click();
  await expect(row.locator('figcaption')).toHaveText('Package label');
  await page.getByRole('button', { name: 'Close shopping dialog' }).click();
  await item.getByRole('button', { name: 'Bought Photo brush heads', exact: true }).click();
  await page.getByRole('button', { name: 'Purchased', exact: true }).click();
  await page.getByRole('button', { name: /^Edit Photo (brush heads|secret present)$/ }).click();
  await page
    .locator('.shopping-entry-details')
    .getByRole('button', { name: 'Receipt photos', exact: true })
    .click();
  dialog = await photo(page, 'Receipt from Saturday');
  await dialog.getByLabel('Caption for photo 1').press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await row.locator('summary').filter({ hasText: 'Receipt photos' }).click();
  await expect(row.locator('.shopping-purchase figcaption')).toHaveText('Receipt from Saturday');
  await page.getByRole('button', { name: 'Close shopping dialog' }).click();
  await page.locator('main').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Control+z');
  await item.getByRole('button', { name: 'Edit Photo brush heads', exact: true }).click();
  await expect(row.locator('.shopping-purchase img')).toHaveCount(0);
  await expect(row).toContainText('Bought by Alex');
  await page.getByRole('button', { name: 'Close shopping dialog' }).click();
  await page.locator('main').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Control+Shift+z');
  await item.getByRole('button', { name: 'Edit Photo brush heads', exact: true }).click();
  await row.locator('summary').filter({ hasText: 'Receipt photos' }).click();
  await expect(row.locator('.shopping-purchase figcaption')).toHaveText('Receipt from Saturday');
  await row.getByRole('button', { name: 'Purchase history', exact: true }).click();
  await expect(page.locator('.history-list').getByText('Updated photos', { exact: true })).toBeVisible();
  await expect(page.locator('.history-list img').first()).toBeVisible();
  await page.getByRole('button', { name: 'Close shopping dialog', exact: true }).last().click();
  await page.getByRole('button', { name: 'Close shopping dialog', exact: true }).click();
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/shopping-photos-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Recently done', exact: true }).click();
  await page.getByLabel('Search activity').fill('Photo brush heads');
  await page.locator('.activity-card summary').click();
  await expect(page.locator('.activity-card figcaption')).toHaveText('Receipt from Saturday');
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Photo shopping' });
  await page.getByRole('button', { name: 'Restock shelf', exact: true }).click();
  await expect(card.locator('figcaption')).toHaveText('Package label');
  await card.getByRole('button', { name: 'Need this', exact: true }).click();
  await page.getByRole('button', { name: 'Need to buy', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Receipt photos', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('private gift product and receipt photos stay out of the other profile and shared activity', async ({
  page,
}) => {
  await login(page);
  await list(page, 'Photo gift list', true);
  const card = await product(page, 'Photo secret present', true);
  await card.getByRole('button', { name: 'Product photos', exact: true }).click();
  let dialog = await photo(page, 'Secret product label');
  await dialog.getByRole('button', { name: 'Save photos', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await card.getByRole('button', { name: 'Need this', exact: true }).click();
  await page.getByRole('button', { name: 'Need to buy', exact: true }).click();
  await page.getByRole('button', { name: 'Bought Photo secret present', exact: true }).click();
  await page.getByRole('button', { name: 'Purchased', exact: true }).click();
  const row = page.locator('.shopping-row').filter({ hasText: 'Photo secret present' });
  await page.getByRole('button', { name: /^Edit Photo (brush heads|secret present)$/ }).click();
  await page
    .locator('.shopping-entry-details')
    .getByRole('button', { name: 'Receipt photos', exact: true })
    .click();
  dialog = await photo(page, 'Secret receipt');
  await dialog.getByRole('button', { name: 'Save photos', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Close shopping dialog' }).click();
  const cache = await (await page.request.get('/api/cache/inbox')).json();
  const secret = cache.shopping.purchases.find((p: { items: { label: string }[] }) =>
    p.items.some((i) => i.label === 'Photo secret present'),
  );
  await page.getByRole('button', { name: 'Recently done', exact: true }).click();
  await page.getByLabel('Search activity').fill('Photo secret present');
  await expect(page.locator('.activity-card')).toHaveCount(0);
  await page.getByLabel('Activity visibility').selectOption('private');
  await page.locator('.activity-card summary').click();
  await expect(page.locator('.activity-card figcaption')).toHaveText('Secret receipt');
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await expect(page.getByLabel('Current profile')).toHaveValue(/.+/);
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByRole('button', { name: 'Restock shelf', exact: true }).click();
  await expect(page.locator('body')).not.toContainText('Photo secret present');
  const media = await page.request.get(`/api/media/${secret.attachments[0].mediaId}`);
  expect(media.status()).toBe(404);
  await page.getByRole('button', { name: 'Recently done', exact: true }).click();
  await page.getByLabel('Activity visibility').selectOption('all');
  await page.getByLabel('Search activity').fill('Secret receipt');
  await expect(page.locator('.activity-card')).toHaveCount(0);
});
