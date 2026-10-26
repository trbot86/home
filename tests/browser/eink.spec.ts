import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
async function setup(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .locator('.settings-section > summary')
    .filter({ hasText: /^E-ink dashboards$/ })
    .click();
  return page.getByRole('region', { name: 'E-ink dashboard preview' });
}
test('e-ink previews render exact monochrome pixels, download device BMP and stay within phone layout', async ({
  page,
}) => {
  const preview = await setup(page);
  await expect(preview.getByText('No display is connected yet.', { exact: false })).toBeVisible();
  await preview.getByRole('button', { name: 'Generate preview', exact: true }).click();
  const image = preview.getByRole('img', { name: 'Kitchen dashboard preview' });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]))
    .toEqual([800, 480]);
  const source = await image.getAttribute('src');
  await writeFile('.cache/eink-empty-kitchen.png', Buffer.from(source!.split(',')[1]!, 'base64'));
  const download = preview.getByRole('link', { name: 'Download 1-bit BMP' });
  const bmp = Buffer.from((await download.getAttribute('href'))!.split(',')[1]!, 'base64');
  expect(bmp.length).toBe(48062);
  expect(bmp.readUInt16LE(28)).toBe(1);
  await preview.getByLabel('Dashboard layout').selectOption('desk');
  await expect(preview.locator('img')).toHaveCount(0);
  await expect(preview.getByLabel('Include my private items and private calendar events')).not.toBeChecked();
  await preview.getByLabel('Include my private items and private calendar events').check();
  await preview.getByRole('button', { name: 'Generate preview', exact: true }).click();
  await expect(preview.getByRole('img', { name: 'Desk dashboard preview' })).toBeVisible();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await preview.getByLabel('Show at actual pixel size').check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await preview.getByLabel('Show at actual pixel size').uncheck();
  }
});
test('changing dashboard options discards an in-flight preview rather than showing an old private frame', async ({
  page,
}) => {
  const preview = await setup(page);
  let release!: () => void, fetched!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (fetched = resolve));
  await page.route(
    '**/api/displays/preview',
    async (route) => {
      const response = await route.fetch();
      fetched();
      await hold;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await preview.getByRole('button', { name: 'Generate preview', exact: true }).click();
  await started;
  await preview.getByLabel('Dashboard layout').selectOption('desk');
  await expect(preview.getByRole('button', { name: 'Generate preview', exact: true })).toBeEnabled();
  const finished = page.waitForResponse('**/api/displays/preview');
  release();
  await finished;
  await preview.getByRole('button', { name: 'Generate preview', exact: true }).click();
  await expect(preview.getByRole('img', { name: 'Desk dashboard preview' })).toBeVisible();
  await expect(preview.getByRole('img', { name: 'Kitchen dashboard preview' })).toHaveCount(0);
});
