import { test, expect } from '@playwright/test';
test('compact phone chrome, remembered agenda choices and isolated profile settings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  const nav = page.getByRole('navigation');
  await nav.getByRole('button', { name: 'Tasks', exact: true }).click();
  // Keep the page heading accessible without spending a row on a repeated title.
  expect(
    (await page.getByRole('heading', { name: 'Tasks', exact: true }).boundingBox())!.height,
  ).toBeLessThanOrEqual(1);
  const filters = page.locator('.task-filters');
  expect((await filters.boundingBox())!.y).toBeLessThan(330);
  await page.screenshot({ path: '.cache/layout-tasks-phone.png', fullPage: true });
  await nav.getByRole('button', { name: 'Agenda', exact: true }).click();
  await page.getByLabel('Days', { exact: true }).selectOption('30');
  await page.getByLabel('Show', { exact: true }).selectOption('work');
  await nav.getByRole('button', { name: 'Inbox', exact: true }).click();
  await nav.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.getByLabel('Days', { exact: true })).toHaveValue('30');
  await page.reload();
  await nav.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.getByLabel('Days', { exact: true })).toHaveValue('30');
  await expect(page.getByLabel('Show', { exact: true })).toHaveValue('work');
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await nav.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.getByLabel('Days', { exact: true })).toHaveValue('7');
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.settings-section[open]')).toHaveCount(0);
  await page
    .locator('.settings-section > summary')
    .filter({ hasText: /^Note suggestions$/ })
    .click();
  const settings = page.getByRole('region', { name: 'Note suggestion settings' });
  await expect(settings.getByLabel('Allow requests from this profile')).not.toBeChecked();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.cache/compact-settings-${width}.png`, fullPage: true });
  }
});
test('suggestion card tools share one footer row with labelled icons', async ({ page, request }) => {
  const seed = await request.post('http://127.0.0.1:4174/suggestion-working', {
    headers: { 'x-test-token': process.env['OUR_PLACE_TEST_TOKEN']! },
  });
  const { text } = await seed.json();
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: text });
  await expect(card.getByRole('img', { name: 'Working', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Move to inbox' })).toHaveCount(0);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const row = card.locator('.entry-actions');
    await expect(row.getByRole('group', { name: 'Card position' })).toBeVisible();
    const bounds = await row
      .locator('button')
      .evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().y));
    expect(Math.max(...bounds) - Math.min(...bounds)).toBeLessThan(5);
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `.cache/layout-suggestions-${width}.png`, fullPage: true });
  }
});
