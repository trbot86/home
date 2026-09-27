import { expect, test } from '@playwright/test';

test('plain notes recognize safe web links without changing text or replacing an unfinished editor', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  const text =
    'Try (https://example.com/recipes/soup_(winter)).\nAlso www.example.org/ideas, then https://example.net/?a=1&b=2.\njavascript:alert(1) <img src=x onerror=alert(1)>';
  await page.getByLabel('What’s on your mind?').fill(text);
  await page.getByLabel('What’s on your mind?').press('Control+Enter');
  const card = page.locator('.entry-card').filter({ hasText: 'soup_(winter)' });
  await expect(card).toHaveCount(1);
  await expect(card.locator('a')).toHaveCount(3);
  await expect(card.locator('a').first()).toHaveAttribute(
    'href',
    'https://example.com/recipes/soup_(winter)',
  );
  await expect(card.locator('a').nth(1)).toHaveAttribute('href', 'https://www.example.org/ideas');
  await expect(card.locator('a').nth(2)).toHaveAttribute('href', 'https://example.net/?a=1&b=2');
  await expect(card.locator('.entry-text')).toHaveText(text);
  await expect(card.locator('img')).toHaveCount(0);
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByLabel('Entry text');
  await editor.fill(text + '\nUnfinished changes');
  const first = page.locator('.entry-links a').first();
  await expect(first).toHaveAttribute('rel', 'noopener noreferrer');
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Isolated example page</h1>' }),
  );
  const popupPromise = page.waitForEvent('popup');
  await first.click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: 'Isolated example page' })).toBeVisible();
  await expect(editor).toHaveValue(text + '\nUnfinished changes');
  await popup.close();
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  await page.reload();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor).toHaveValue(text + '\nUnfinished changes');
  for (const width of [320, 390, 820]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.getByRole('dialog').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
      true,
    );
  }
});

test('favicon stays available offline and update link uses this installation origin', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'Storage & backups', exact: true }).click();
  const link = page.getByRole('link', { name: 'Open Android installation page', exact: false });
  await expect(link).toHaveAttribute('href', new URL('/install/', page.url()).href);
  await expect(link).toHaveAttribute('target', '_blank');
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute('href', '/favicon.svg');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  const response = await page.evaluate(async () => {
    const result = await fetch('/favicon.svg');
    return { status: result.status, body: await result.text() };
  });
  expect(response.status).toBe(200);
  expect(response.body).toContain('<svg');
  await expect(link).toHaveAttribute('aria-disabled', 'true');
});
