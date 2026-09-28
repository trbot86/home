import { expect, test, type Page } from '@playwright/test';

async function openShopping(page: Page, user = 'Alex') {
  await page.goto('/');
  await page.getByRole('button', { name: user, exact: true }).click();
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}
async function newList(page: Page, name: string, privateList = false) {
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Who can see this', { exact: true }).selectOption({ label: privateList ? 'Just me' : 'Shared' });
  await dialog.getByLabel('Name', { exact: true }).press('Control+Enter');
  await expect(dialog).not.toBeVisible();
  await page
    .getByLabel('Shopping list', { exact: true })
    .selectOption({ label: name + (privateList ? ' · Just me' : '') });
}
async function add(page: Page, label: string, quantity = '') {
  await page.getByLabel('Add a shopping item').fill(label);
  await page.getByLabel('Quick quantity').fill(quantity);
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const row = page.locator('.shopping-row').filter({ hasText: label });
  await expect(row).toHaveCount(1);
  await expect(page.getByLabel('Add a shopping item')).toHaveValue('');
  return row;
}

test('named shopping groups can be renamed, searched, rearranged and restored without losing items', async ({
  page,
}) => {
  await openShopping(page);
  await newList(page, 'Weekend errands');
  await add(page, 'Seeds', '2 packets');
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Garden');
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Group for Seeds', { exact: true }).selectOption({ label: 'Garden' });
  const group = page.locator('.shopping-group');
  await expect(group).not.toHaveAttribute('open', '');
  await page.getByLabel('Search shopping').fill('Seeds');
  await expect(group).toHaveAttribute('open', '');
  await group.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Planting supplies');
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(group.locator('summary').first()).toContainText('Planting supplies');
  await page.getByLabel('Group for Seeds', { exact: true }).selectOption('');
  await expect(group).toHaveCount(0);
  await page.getByLabel('Search shopping').fill('');
  await expect(group).toHaveCount(1);
  await group.locator('summary').first().click();
  await group.getByRole('button', { name: 'Delete Planting supplies', exact: true }).click();
  await page.getByRole('button', { name: 'Remove group, keep items', exact: true }).click();
  await expect(group).toHaveCount(0);
  await page.getByRole('button', { name: 'Deleted', exact: true }).click();
  const deleted = page.locator('.shopping-row').filter({ hasText: 'Planting supplies' });
  await deleted.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(deleted).toHaveCount(0);
  await page.getByRole('button', { name: 'Need to buy', exact: true }).click();
  await expect(group).toHaveCount(1);
  await expect(page.locator('.shopping-row')).toContainText('Seeds');
});

test('shopping purchase undo, restocking, details, privacy and narrow layouts', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openShopping(page);
  await newList(page, 'Weekly groceries');
  let row = await add(page, 'Apples', '6');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Notes', { exact: true }).fill('Crisp, for lunch boxes');
  await page.getByRole('dialog').getByLabel('Notes', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(row).toContainText('Crisp, for lunch boxes');
  await row.getByRole('button', { name: 'Bought Apples' }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Purchased', exact: true }).click();
  row = page.locator('.shopping-row').filter({ hasText: 'Apples' });
  await expect(row).toContainText('Bought by Alex');
  await page.getByRole('button', { name: 'Dismiss confirmation' }).click();
  await page.keyboard.press('Control+z');
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Need to buy', exact: true }).click();
  await expect(row).toHaveCount(1);
  await page.keyboard.press('Control+Shift+z');
  await expect(row).toHaveCount(0);

  await page.getByRole('button', { name: 'Restock shelf', exact: true }).click();
  await page.getByRole('button', { name: 'New product', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Who can see this', { exact: true }).selectOption({ label: 'Shared' });
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Toothbrush heads');
  await dialog.getByLabel('Model or size').fill('Compatible with our electric brushes');
  await dialog.getByLabel('Quantity', { exact: true }).fill('4 pack');
  await dialog.getByLabel('Notes', { exact: true }).fill('Soft bristles');
  await dialog.getByLabel('Product link').fill('https://example.com/brush-heads');
  await dialog.getByLabel('Notes', { exact: true }).press('Control+Enter');
  await expect(dialog).not.toBeVisible();
  const product = page.locator('.restock-card').filter({ hasText: 'Toothbrush heads' });
  await product.getByRole('button', { name: 'Need this', exact: true }).click();
  await expect(product.getByRole('button', { name: 'Already on this list' })).toBeDisabled();
  await page.getByRole('button', { name: 'Need to buy', exact: true }).click();
  const heads = page.locator('.shopping-row').filter({ hasText: 'Toothbrush heads' });
  await expect(heads).toContainText('4 pack');
  await expect(heads.getByRole('link', { name: 'Product link' })).toHaveAttribute(
    'href',
    'https://example.com/brush-heads',
  );
  await heads.getByRole('button', { name: 'Bought Toothbrush heads' }).click();
  await expect(heads).toHaveCount(0);
  await page.getByRole('button', { name: 'Restock shelf', exact: true }).click();
  await product.getByRole('button', { name: 'Need this', exact: true }).click();
  await page.getByRole('button', { name: 'Need to buy', exact: true }).click();
  await expect(heads).toHaveCount(1);
  await heads.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.historical-text').filter({ hasText: 'Toothbrush heads' })).toBeVisible();
  await page.getByRole('button', { name: 'Close shopping dialog' }).click();

  for (const width of [320, 360, 820, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Shopping fits ${width}px`,
    ).toBe(true);
    await page.screenshot({ path: `test-results/shopping-${width}.png`, fullPage: true });
  }
  await newList(page, 'Surprises for Sam', true);
  await add(page, 'A pottery course');
  const second = await browser.newContext();
  try {
    const partner = await second.newPage();
    await openShopping(partner, 'Sam');
    await expect(partner.getByLabel('Shopping list', { exact: true }).locator('option')).not.toContainText([
      'Surprises for Sam',
    ]);
    await partner.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Weekly groceries' });
    await expect(partner.locator('.shopping-row').filter({ hasText: 'Toothbrush heads' })).toHaveCount(1);
    await expect(partner.getByText('A pottery course', { exact: true })).toHaveCount(0);
  } finally {
    await second.close();
  }
  expect(errors).toEqual([]);
});

test('shopping drafts survive reload; lost responses retry once; cached lists stay read-only offline', async ({
  page,
  context,
}) => {
  await openShopping(page);
  await newList(page, 'Household restock');
  await page.getByLabel('Add a shopping item').fill('Dishwasher salt');
  await page.getByLabel('Quick quantity').fill('2 kg');
  await page.reload();
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Household restock' });
  await expect(page.getByLabel('Add a shopping item')).toHaveValue('Dishwasher salt');
  await expect(page.getByLabel('Quick quantity')).toHaveValue('2 kg');
  let dropped = false;
  await page.route('**/api/commands/AddShoppingEntry', async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect.poll(() => dropped).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Household restock' });
  const row = page.locator('.shopping-row').filter({ hasText: 'Dishwasher salt' });
  await expect(row).toHaveCount(1);
  await expect(page.getByLabel('Add a shopping item')).toHaveValue('');
  await page.getByRole('button', { name: 'Refresh and sync' }).click();
  await expect(row).toHaveCount(1);
  await context.setOffline(true);
  await expect(row.getByRole('button', { name: 'Bought Dishwasher salt' })).toBeDisabled();
  await expect(page.getByLabel('Add a shopping item')).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Household restock' });
  await expect(row).toContainText('2 kg');
  await expect(row.getByRole('button', { name: 'Delete Dishwasher salt' })).toBeDisabled();
  await context.setOffline(false);
});
