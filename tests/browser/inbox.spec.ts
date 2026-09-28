import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, user = 'alex') {
  await page.goto('/');
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: user === 'alex' ? 'Alex' : 'Sam', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Shared' });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}
async function capture(page: Page, text: string) {
  await page.getByLabel('What’s on your mind?').fill(text);
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: text });
  await expect(card).toHaveCount(1);
  return card;
}

test('text editing, per-person history, delete and undo, with Ctrl+Enter', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const text = 'Replace the kitchen tap filter\nMeasure the thread first.';
  await page.getByLabel('What’s on your mind?').fill(text);
  await page.getByLabel('What’s on your mind?').press('Control+Enter');
  const card = page.locator('.entry-card').filter({ hasText: 'Replace the kitchen tap filter' });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Open note', exact: true }).click();
  await page.getByLabel('Entry text').fill('Kitchen tap filter: 22 mm');
  await page.getByLabel('Entry text').press('Control+Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const updated = page.locator('.entry-card').filter({ hasText: 'Kitchen tap filter: 22 mm' });
  await updated.getByRole('button', { name: 'Open note', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'History', exact: true }).click();
  await expect(
    page.locator('.historical-text').filter({ hasText: 'Measure the thread first.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close entry' }).click();
  await updated.getByRole('button', { name: 'Delete entry' }).click();
  await expect(updated).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss confirmation' }).click();
  await page.keyboard.press('Control+z');
  await expect(updated).toHaveCount(1);
  await page.keyboard.press('Control+Shift+z');
  await expect(updated).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(updated).toHaveCount(1);
  await page.getByLabel('What’s on your mind?').focus();
  await page.keyboard.type('A temporary draft');
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('What’s on your mind?')).not.toHaveValue('A temporary draft');
  await expect(updated).toHaveCount(1);

  await page.getByLabel('Who can see this capture').selectOption({ label: 'Just me' });
  await capture(page, 'Gift idea for Sam: a surprise pottery course');
  const second = await browser.newContext();
  const partner = await second.newPage();
  await login(partner, 'sam');
  await expect(partner.getByText('Kitchen tap filter: 22 mm', { exact: true })).toBeVisible();
  await expect(
    partner.getByText('Gift idea for Sam: a surprise pottery course', { exact: true }),
  ).toHaveCount(0);
  await second.close();
  expect(errors).toEqual([]);
});

test('offline draft survives reload, frozen capture syncs once after a lost response', async ({
  page,
  context,
}) => {
  await login(page);
  await context.setOffline(true);
  await page.getByLabel('What’s on your mind?').fill('Offline thought to keep through a restart');
  await expect(page.getByText('Draft saved on this device')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue(
    'Offline thought to keep through a restart',
  );
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  await expect(page.getByText('Waiting for confirmation · kept unchanged for retry')).toBeVisible();
  let dropped = false;
  await page.route('**/api/commands/CreateInboxEntry', async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort('failed');
  });
  await context.setOffline(false);
  await expect.poll(() => dropped).toBe(true);
  await page.reload();
  const card = page.locator('.entry-card').filter({ hasText: 'Offline thought to keep through a restart' });
  await expect(card).toHaveCount(1);
  await expect(page.getByText('Waiting for confirmation · kept unchanged for retry')).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh and sync' }).click();
  await expect(card).toHaveCount(1);
});

test('phone photo capture and desktop layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.locator('input[type=file]').setInputFiles({
    name: 'sample.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.locator('.capture-photos img')).toBeVisible();
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  await expect(page.locator('.entry-card img')).toBeVisible();
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => {
        const footer = document.querySelector('.capture-footer')!.getBoundingClientRect();
        const controlsFit = [
          ...document.querySelectorAll(
            '.capture-footer button, .capture-footer select, .capture-footer .file-button',
          ),
        ].every((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= footer.left && bounds.right <= footer.right;
        });
        const labelsFit = [...document.querySelectorAll('.nav-label-compact')].every(
          (element) =>
            element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) + 1,
        );
        return controlsFit && labelsFit && document.documentElement.scrollWidth <= innerWidth;
      }),
      `Capture controls and navigation fit at ${width}px`,
    ).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/inbox-phone.png', fullPage: true });
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.screenshot({ path: 'test-results/inbox-tablet.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: 'test-results/inbox-desktop.png', fullPage: true });
});

test('profile menu remembers selection and keeps private entries and unfinished drafts with their owner', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await login(page);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(32, 35, 31)');
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Just me' });
  await capture(page, 'Private gift for Sam');
  await page.getByLabel('What’s on your mind?').fill('Alex unfinished private thought');
  await expect(page.getByLabel('Current profile')).toBeEnabled();
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await expect(page.getByLabel('Current profile').locator('option:checked')).toHaveText('Sam');
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('');
  await expect(page.getByText('Private gift for Sam', { exact: true })).toHaveCount(0);
  await page.getByLabel('What’s on your mind?').fill('Sam unfinished thought');
  await expect(page.getByLabel('Current profile')).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('Current profile').locator('option:checked')).toHaveText('Sam');
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('Sam unfinished thought');
  await page.getByLabel('Current profile').selectOption({ label: 'Alex' });
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('Alex unfinished private thought');
  await expect(page.getByText('Private gift for Sam', { exact: true })).toBeVisible();
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('Sam unfinished thought');
});
