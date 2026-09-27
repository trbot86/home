import { expect, test, type Page } from '@playwright/test';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);
async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
}
async function addAsset(page: Page, title: string, privateAsset = false) {
  await page.getByRole('button', { name: 'Add asset', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New asset', exact: true });
  await dialog.getByLabel('Asset name', { exact: true }).fill(title);
  await dialog.getByLabel('Model', { exact: true }).fill('Fixture model 42');
  await dialog.getByLabel('Location', { exact: true }).fill('Utility room');
  if (privateAsset)
    await dialog.getByLabel('Who can see this', { exact: true }).selectOption({ label: 'Just me' });
  await dialog.getByLabel('Asset notes').press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.home-detail-heading')).toContainText(title);
}

test('Home keeps asset details, past service, photos and actual-completion maintenance together with guarded undo', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await addAsset(page, 'Heat pump for browser fixture');
  await page.getByRole('button', { name: 'Record past service', exact: true }).click();
  await page.getByLabel('Service performed at').fill('2026-02-12T10:30');
  await page.getByLabel('Cost (optional)').fill('143.2500');
  await page.getByLabel('Currency', { exact: true }).fill('CAD');
  await page.getByLabel('Service notes').fill('Replaced the worn valve.');
  await page.getByLabel('Service notes').press('Control+Enter');
  const manual = page.locator('.home-service-card').filter({ hasText: 'Replaced the worn valve.' });
  await expect(manual).toContainText('CAD 143.2500');
  await manual.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  const photos = page.getByRole('dialog', { name: 'Photos & receipts', exact: true });
  await photos
    .locator('input[type=file]')
    .setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: png });
  await photos.getByLabel('Caption for photo 1').fill('Service receipt');
  await photos.getByLabel('Caption for photo 1').press('Control+Enter');
  await expect(manual.locator('img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Add maintenance task', exact: true }).click();
  await expect(page.getByLabel('Maintains (optional)')).toHaveValue(/.{8,}/);
  await page.getByLabel('Task title', { exact: true }).fill('Wash heat-pump filter');
  await page.getByLabel('Repeat after completion').selectOption('months');
  await page.getByLabel('Repeat every', { exact: true }).fill('1');
  await page.getByLabel('Instructions', { exact: true }).press('Control+Enter');
  const task = page.locator('.home-maintenance-task').filter({ hasText: 'Wash heat-pump filter' });
  await expect(task).toHaveCount(1);
  await task.getByRole('button', { name: 'Record completion', exact: true }).click();
  await page.getByLabel('Actually completed at', { exact: true }).fill('2026-08-31T12:00');
  await page.getByLabel('Done by', { exact: true }).selectOption({ label: 'Sam' });
  await page.getByLabel('Completion note').fill('Rinsed and dried the reusable filter.');
  await page.getByLabel('Completion note').press('Control+Enter');
  const service = page
    .locator('.home-service-card')
    .filter({ hasText: 'Rinsed and dried the reusable filter.' });
  await expect(service).toContainText('Task completed by Sam');
  await expect(task).toContainText('Target Sep 30, 2026');
  await page.keyboard.press('Control+z');
  await expect(service).toHaveCount(0);
  await expect(manual).toHaveCount(1);
  await page.keyboard.press('Control+Shift+z');
  await expect(service).toHaveCount(1);
  await expect(task).toContainText('Target Sep 30, 2026');
  await service.getByRole('button', { name: 'Service history', exact: true }).click();
  await expect(page.locator('.historical-text').first()).toContainText('Rinsed and dried');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove asset', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.locator('.home-detail-heading')).toContainText('Archived asset');
  await expect(service).toHaveCount(1);
  await expect(task).toHaveCount(1);
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Home fits ${width}px`,
    ).toBe(true);
    await page.screenshot({ path: `test-results/home-${width}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});

test('Home forms survive reload and uncertain replies; private data and offline cache stay with the profile', async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Add asset', exact: true }).click();
  await page.getByLabel('Asset name').fill('Private studio equipment');
  await page.getByLabel('Asset notes').fill('Keep this unfinished inventory.');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Add asset', exact: true }).click();
  await expect(page.getByLabel('Asset notes')).toHaveValue('Keep this unfinished inventory.');
  await page.getByLabel('Who can see this', { exact: true }).selectOption({ label: 'Just me' });
  let dropped = false;
  await page.route('**/api/commands/CreateHomeAsset', async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByLabel('Asset notes').press('Control+Enter');
  await expect.poll(() => dropped).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
  const asset = page.locator('.home-asset-card').filter({ hasText: 'Private studio equipment' });
  await expect(asset).toHaveCount(1);
  await asset.click();
  await expect(page.locator('.home-detail')).toContainText('Keep this unfinished inventory.');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await asset.click();
  await expect(page.locator('.home-detail')).toContainText('Keep this unfinished inventory.');
  await expect(page.getByRole('button', { name: 'Edit asset', exact: true })).toBeDisabled();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(asset).toHaveCount(0);
  await expect(page.getByText('Keep this unfinished inventory.', { exact: true })).toHaveCount(0);
});
