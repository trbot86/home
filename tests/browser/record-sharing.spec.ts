import { expect, test } from '@playwright/test';

test('saved private note can be explicitly shared with its previous history', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByLabel('What’s on your mind?').fill('Sharing browser original');
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: 'Sharing browser original' });
  await card.getByRole('button', { name: 'Open note', exact: true }).click();
  await page.getByLabel('Entry text').fill('Sharing browser edited');
  await page.getByLabel('Entry text').press('Control+Enter');
  const edited = page.locator('.entry-card').filter({ hasText: 'Sharing browser edited' });
  await edited.getByRole('button', { name: 'Open note', exact: true }).click();
  await page.getByRole('button', { name: 'Share with household', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Sharing' })).toContainText('previous history');
  await page.getByRole('button', { name: 'Cancel sharing', exact: true }).click();
  await page.getByRole('button', { name: 'Share with household', exact: true }).click();
  await page.getByRole('button', { name: 'Share these items', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const context = await browser.newContext();
  try {
    const partner = await context.newPage();
    await partner.goto('/');
    await partner.getByRole('button', { name: 'Sam', exact: true }).click();
    const shared = partner.locator('.entry-card').filter({ hasText: 'Sharing browser edited' });
    await expect(shared).toBeVisible();
    await shared.getByRole('button', { name: 'Open note', exact: true }).press('Enter');
    await partner.getByRole('dialog').getByRole('button', { name: 'History', exact: true }).click();
    await expect(
      partner.locator('.historical-text').filter({ hasText: 'Sharing browser original' }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
