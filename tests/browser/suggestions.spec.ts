import { expect, test } from '@playwright/test';

test('suggestions keep separate drafts and counts through offline reload, move and undo', async ({
  page,
  context,
}) => {
  const suggestion = 'Let Back close an open card ' + crypto.randomUUID();
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const initialCount = await page
    .getByRole('button', { name: 'Inbox', exact: true })
    .locator('.nav-count')
    .innerText();
  await page.getByLabel('What’s on your mind?').fill('Unfinished household thought');
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await expect(page.getByLabel('Suggest an improvement')).toHaveValue('');
  await context.setOffline(true);
  await page.getByLabel('Suggest an improvement').fill(suggestion);
  await page.getByRole('button', { name: 'Save suggestion', exact: true }).click();
  await expect(page.getByText('Waiting for confirmation · kept unchanged for retry')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('Unfinished household thought');
  await expect(page.getByRole('button', { name: 'Inbox', exact: true }).locator('.nav-count')).toHaveText(
    initialCount,
  );
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await expect(page.getByText('Waiting for confirmation · kept unchanged for retry')).toBeVisible();
  await context.setOffline(false);
  const card = page.locator('.entry-card').filter({ hasText: suggestion });
  await expect(card).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Inbox', exact: true }).locator('.nav-count')).toHaveText(
    initialCount,
  );
  await expect(card.locator('.entry-text')).toHaveText(suggestion);
  await card.getByRole('button', { name: 'Move to inbox', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText('Moved to inbox', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close entry' }).click();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/suggestions-phone.png', fullPage: true });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('Unfinished household thought');
  await expect(card).toHaveCount(0);
});
