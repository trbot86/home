import { expect, test, type Page } from '@playwright/test';

async function capture(page: Page, text: string) {
  await page.getByLabel('What’s on your mind?').fill(text);
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: text.split('\n')[0]! });
  await expect(card).toHaveCount(1);
  return card;
}
async function copyLink(page: Page, text: string) {
  await page
    .locator('.entry-card')
    .filter({ hasText: text })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.getByText('Link copied', { exact: true })).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  return url;
}

test('copied note links use titles, preserve unfinished source edits, and survive deletion and offline reload', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  const title = 'Boiler manual and filter measurements';
  const target = await capture(page, title + '\nKeep the original photo.');
  const url = await copyLink(page, title);
  expect(new URL(url).origin).toBe(new URL(page.url()).origin);
  expect([...new URL(url).searchParams.keys()]).toEqual(['entry']);
  expect(url).not.toContain('Boiler');
  const sourceText = 'Annual service reference\n' + url;
  await capture(page, sourceText);
  // Rendering resolves the authorized title without rewriting the stored text.
  const sourceCard = page.locator('.entry-card').filter({ hasText: 'Annual service reference' });
  const link = sourceCard.getByRole('link', { name: title, exact: true });
  await expect(link).toHaveAttribute('href', url);
  await expect(link).not.toHaveAttribute('target', '_blank');
  await sourceCard.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(sourceText);
  await page.getByLabel('Entry text').fill(sourceText + '\nUnfinished service notes');
  await page.locator('.entry-links').getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(title + '\nKeep the original photo.');
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  await sourceCard.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(sourceText + '\nUnfinished service notes');
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  await target
    .filter({ hasText: 'Keep the original photo.' })
    .getByRole('button', { name: 'Delete entry', exact: true })
    .click();
  await sourceCard.getByRole('link', { name: 'Deleted note', exact: true }).click();
  await expect(page.getByLabel('Entry text')).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Entry text')).toHaveValue(title + '\nKeep the original photo.');
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(link).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.goto(url);
  await expect(page.getByLabel('Entry text')).toHaveValue(title + '\nKeep the original photo.');
  await expect(page.getByLabel('Entry text')).toHaveAttribute('readonly', '');
});

test('private note titles never carry across profiles and inaccessible deep links reveal no content', async ({
  page,
  context,
  browser,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Just me' });
  const secret = 'Private birthday surprise for partner';
  await capture(page, secret);
  const url = await copyLink(page, secret);
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Shared' });
  await page.getByLabel('What’s on your mind?').fill('Shared pointer without a disclosed title\n' + url);
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  await expect(page.getByRole('link', { name: secret, exact: true })).toBeVisible();
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  const source = page.locator('.entry-card').filter({ hasText: 'Shared pointer without a disclosed title' });
  await expect(source.getByRole('link', { name: 'Open note', exact: true })).toBeVisible();
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  await source.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.entry-links').getByRole('link', { name: 'Open note', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('unavailable for your profile');
  await expect(page.getByLabel('Entry text')).toHaveValue('Shared pointer without a disclosed title\n' + url);
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  await page.goto(url);
  await expect(page.getByRole('alert')).toContainText('unavailable for your profile');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await other.goto(url);
  await other.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(other.getByLabel('Entry text')).toHaveValue(secret);
  await fresh.close();
});

test('a late link lookup cannot reopen another profile’s note, and clipboard failure has a manual fallback', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Just me' });
  const title = 'Private note with delayed navigation';
  await capture(page, title);
  const url = await copyLink(page, title);
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Shared' });
  await page.getByLabel('What’s on your mind?').fill('Delayed shared pointer\n' + url);
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  const source = page.locator('.entry-card').filter({ hasText: 'Delayed shared pointer' });
  await expect(source.getByRole('link', { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel('Current profile')).toBeEnabled();
  let release!: () => void;
  let entered = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/cache/inbox', async (route) => {
    if (entered) return route.continue();
    entered = true;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await source.getByRole('link', { name: title, exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await expect(page.getByLabel('Current profile').locator('option:checked')).toHaveText('Sam');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(source.getByRole('link', { name: 'Open note', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await source.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: () => Promise.reject(new Error('Clipboard unavailable')),
    });
  });
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.getByLabel('Note link', { exact: true })).toHaveValue(/\?entry=/);
  for (const width of [320, 390, 820]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.getByRole('dialog').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
      true,
    );
  }
});
