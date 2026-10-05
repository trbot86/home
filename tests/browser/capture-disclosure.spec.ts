import { expect, test } from '@playwright/test';

test('Inbox capture opens with focus and keeps a draft across collapse and reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  const summary = page.locator('.capture-disclosure > summary');
  const text = page.locator('#capture-text');
  await expect(text).toBeHidden();
  await summary.click();
  await expect(text).toBeFocused();
  await expect(text).toHaveAttribute('placeholder', 'A thought or link…');
  await text.fill('Keep this unfinished thought');
  await expect(page.locator('.draft-state')).toHaveText('Draft saved on this device');
  await summary.click();
  await expect(text).toBeHidden();
  await page.reload();
  await expect(text).toBeHidden();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(text).toBeFocused();
  await expect(text).toHaveValue('Keep this unfinished thought');
  await text.press('Control+Enter');
  await expect(text).toHaveValue('');
  await expect(page.locator('.entry-text').filter({ hasText: 'Keep this unfinished thought' })).toBeVisible();
});
