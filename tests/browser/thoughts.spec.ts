import { test, expect, type Page } from '@playwright/test';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
}
test('Thoughts keep categorized notes, unfinished edits, history and deleted records', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Thoughts', exact: true }).click();
  await page.getByRole('button', { name: 'New thought', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'New thought', exact: true });
  await expect(dialog.getByLabel('Who can see this', { exact: true })).toHaveValue(/.+/);
  await expect(dialog.getByLabel('Who can see this', { exact: true }).locator('option:checked')).toHaveText(
    'Just me',
  );
  await dialog.getByLabel('Title', { exact: true }).fill('Long lived reference');
  await dialog.getByLabel('Note', { exact: true }).fill('Keep this useful detail. https://example.com');
  await dialog.getByLabel('Category', { exact: true }).fill('Reference');
  await dialog.getByRole('button', { name: 'Save thought', exact: true }).click();
  const detail = page.getByRole('article', { name: 'Thought details' });
  await expect(detail).toContainText('Long lived reference');
  await expect(detail.getByRole('link', { name: 'https://example.com' })).toBeVisible();
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit thought', exact: true });
  await dialog.getByLabel('Note', { exact: true }).fill('Unfinished revised detail');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: 'Thoughts', exact: true }).click();
  await page.getByRole('button').filter({ hasText: 'Long lived reference' }).click();
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(dialog.getByLabel('Note', { exact: true })).toHaveValue('Unfinished revised detail');
  await dialog.getByLabel('Note', { exact: true }).press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await detail.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Thought history' })).toContainText(
    'Keep this useful detail.',
  );
  await page
    .getByRole('dialog', { name: 'Thought history' })
    .getByRole('button', { name: 'Close dialog' })
    .click();
  await detail.getByRole('button', { name: 'Delete', exact: true }).click();
  await detail.getByRole('button', { name: 'Delete thought', exact: true }).click();
  await page.getByRole('button', { name: 'Deleted', exact: true }).click();
  await page.getByRole('button').filter({ hasText: 'Long lived reference' }).click();
  await detail.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Show active', exact: true }).click();
  await page.getByLabel('Thought category').selectOption('Reference');
  await expect(page.locator('.thought-card')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Inbox files text and photos into Thoughts with one atomic undo', async ({ page }) => {
  await login(page);
  await page.locator('.capture-disclosure > summary').click();
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'thought.png', mimeType: 'image/png', buffer: png });
  await page.locator('#capture-text').fill('An idea worth keeping');
  await page.locator('#capture-text').press('Control+Enter');
  const card = page.locator('.entry-card').filter({ hasText: 'An idea worth keeping' });
  await card.getByRole('button', { name: 'To Thoughts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'File this note' });
  await expect(dialog.getByLabel('Filing destination')).toHaveValue('note');
  await dialog.getByLabel('Category', { exact: true }).fill('Ideas');
  await dialog.getByLabel('Title', { exact: true }).press('Control+Enter');
  await expect(card).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: 'Thoughts', exact: true }).click();
  await page.getByRole('button').filter({ hasText: 'An idea worth keeping' }).click();
  await expect(page.getByRole('article', { name: 'Thought details' })).toContainText('Ideas');
  await expect(page.getByRole('article', { name: 'Thought details' }).locator('img')).toHaveCount(1);
  for (const width of [320, 600, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.cache/thoughts-${width}.png`, fullPage: true });
  }
  await page.keyboard.press('Control+z');
  await page.getByRole('navigation').getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(card).toHaveCount(1);
});
