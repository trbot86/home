import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, name = 'Alex') {
  await page.goto('/');
  await page.getByRole('button', { name, exact: true }).click();
  await page.locator('.capture-disclosure > summary').click();
  await expect(page.locator('#capture-text')).toBeVisible();
}
async function capture(page: Page, text: string, suggestion = false) {
  if (!(await page.locator('#capture-text').isVisible())) await page.locator('.capture-disclosure > summary').click();
  await page.locator('#capture-text').fill(text);
  await page
    .getByRole('button', { name: suggestion ? 'Save suggestion' : 'Save to inbox', exact: true })
    .click();
  await expect(page.locator('.entry-card').filter({ hasText: text })).toHaveCount(1);
}
const card = (page: Page, text: string) => page.locator('.entry-card').filter({ hasText: text });
const order = (page: Page) => page.locator('.entry-card .entry-text').allTextContents();

test('personal inbox order persists across devices, keeps filtered slots and isolates profiles', async ({
  page,
  browser,
}) => {
  await login(page);
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Shared' });
  for (const text of ['order-match A', 'order-hidden B', 'order-match C']) {
    await page.getByLabel('Who can see this capture').selectOption({ label: 'Shared' });
    await capture(page, text);
  }
  await page.getByRole('button', { name: 'Search inbox', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search inbox', exact: true }).fill('order-');
  await expect.poll(() => order(page)).toEqual(['order-match C', 'order-hidden B', 'order-match A']);
  await page.getByRole('button', { name: 'Search inbox', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search inbox', exact: true }).fill('order-match');
  await card(page, 'order-match A').getByRole('button', { name: 'Move card up', exact: true }).press('Enter');
  await expect(page.getByText('Card order saved for your profile.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Search inbox', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search inbox', exact: true }).fill('order-');
  await expect.poll(() => order(page)).toEqual(['order-match A', 'order-hidden B', 'order-match C']);
  await page.reload();
  await page.getByRole('button', { name: 'Search inbox', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search inbox', exact: true }).fill('order-');
  await expect.poll(() => order(page)).toEqual(['order-match A', 'order-hidden B', 'order-match C']);
  const second = await browser.newContext();
  try {
    const other = await second.newPage();
    await login(other);
    await other.getByRole('button', { name: 'Search inbox', exact: true }).click();
    await other.getByRole('searchbox', { name: 'Search inbox', exact: true }).fill('order-');
    await expect.poll(() => order(other)).toEqual(['order-match A', 'order-hidden B', 'order-match C']);
    await other.getByLabel('Current profile').selectOption({ label: 'Sam' });
    await other.getByRole('button', { name: 'Search inbox', exact: true }).click();
    await other.getByRole('searchbox', { name: 'Search inbox', exact: true }).fill('order-');
    await expect.poll(() => order(other)).toEqual(['order-match C', 'order-hidden B', 'order-match A']);
  } finally {
    await second.close();
  }
  await page.getByLabel('Sort inbox').selectOption('newest');
  await expect.poll(() => order(page)).toEqual(['order-match C', 'order-hidden B', 'order-match A']);
  await expect(page.getByRole('button', { name: 'Drag to reorder card' })).toHaveCount(0);
  await page.getByLabel('Sort inbox').selectOption('personal');
  // Real mouse pointer capture, dropping on the target card.
  const handle = card(page, 'order-match C').getByRole('button', { name: 'Drag to reorder card' });
  await handle.scrollIntoViewIfNeeded();
  const start = (await handle.boundingBox())!;
  const target = (await card(page, 'order-match A').boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 30, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['order-match C', 'order-match A', 'order-hidden B']);
});

test('suggestion order supports touch and offline viewing without altering inbox order', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await capture(page, 'category-order A');
  await capture(page, 'category-order B');
  await card(page, 'category-order A').getByRole('button', { name: 'Move card up', exact: true }).click();
  await expect(page.getByText('Card order saved for your profile.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  for (const text of ['touch-order A', 'touch-order B']) await capture(page, text, true);
  await page.getByRole('button', { name: 'Search suggestions', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search suggestions', exact: true }).fill('touch-order');
  await card(page, 'touch-order A').getByRole('button', { name: 'Move card up', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(['touch-order A', 'touch-order B']);
  const handle = card(page, 'touch-order B').getByRole('button', { name: 'Drag to reorder card' });
  await handle.scrollIntoViewIfNeeded();
  expect(await handle.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  expect((await handle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // CDP produces actual touch input, including browser pointer capture and cancellation rules.
  const cdp = await context.newCDPSession(page);
  const start = (await handle.boundingBox())!;
  const target = (await card(page, 'touch-order A').boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: start.x + 20, y: start.y + 20 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: target.x + 30, y: Math.max(5, target.y + target.height - 30) }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => order(page)).toEqual(['touch-order B', 'touch-order A']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await page.getByRole('button', { name: 'Search suggestions', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search suggestions', exact: true }).fill('touch-order');
  await expect.poll(() => order(page)).toEqual(['touch-order B', 'touch-order A']);
  await page.screenshot({ path: '.cache/card-order-phone.png', fullPage: true });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Search inbox', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search inbox', exact: true }).fill('category-order');
  await expect.poll(() => order(page)).toEqual(['category-order A', 'category-order B']);
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await page.getByRole('button', { name: 'Search suggestions', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search suggestions', exact: true }).fill('touch-order');
  await context.setOffline(true);
  await expect(handle).toBeDisabled();
  await expect.poll(() => order(page)).toEqual(['touch-order B', 'touch-order A']);
});

test('cancelled drags do not save, and lost order replies reconcile without changing captures', async ({
  page,
}) => {
  await login(page);
  await capture(page, 'retry-order A');
  await capture(page, 'retry-order B');
  await page.getByRole('button', { name: 'Search inbox', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search inbox', exact: true }).fill('retry-order');
  const handle = card(page, 'retry-order A').getByRole('button', { name: 'Drag to reorder card' });
  await handle.scrollIntoViewIfNeeded();
  const start = (await handle.boundingBox())!;
  const target = (await card(page, 'retry-order B').boundingBox())!;
  await page.mouse.move(start.x + 20, start.y + 20);
  await page.mouse.down();
  await page.mouse.move(target.x + 20, target.y + 20);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['retry-order B', 'retry-order A']);
  let lost = false;
  await page.route('**/api/commands/SetCardOrder', async (route) => {
    if (lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort('failed');
  });
  await card(page, 'retry-order A').getByRole('button', { name: 'Move card up', exact: true }).click();
  await expect.poll(() => lost).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Refresh and sync' }).click();
  await page.getByRole('button', { name: 'Search inbox', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search inbox', exact: true }).fill('retry-order');
  await expect.poll(() => order(page)).toEqual(['retry-order A', 'retry-order B']);
  await expect(
    card(page, 'retry-order A').getByRole('button', { name: 'Move card down', exact: true }),
  ).toBeEnabled();
  await card(page, 'retry-order A').getByRole('button', { name: 'Delete entry', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(['retry-order B']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(['retry-order A', 'retry-order B']);
});
