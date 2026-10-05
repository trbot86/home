import { expect, test } from '@playwright/test';

for (const width of [390, 1440]) test(`compact controls at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  const search = page.getByRole('button', { name: 'Search inbox', exact: true });
  const sort = page.getByLabel('Sort inbox');
  await expect(search).toBeVisible();
  const a = await search.boundingBox(), b = await sort.boundingBox();
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(20);
  await search.click();
  const input = page.getByRole('searchbox', { name: 'Search inbox' });
  await expect(input).toBeFocused();
  await input.fill('active query');
  await sort.focus();
  await expect(input).toBeVisible();
  await input.fill('');
  await sort.focus();
  await expect(input).toHaveCount(0);
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByRole('button', { name: 'Search shopping', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search shopping' })).toBeFocused();
  for (const name of ['Recipes', 'Projects']) {
    await page.getByRole('button', { name, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
