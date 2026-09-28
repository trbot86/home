import { expect, test, type Page } from '@playwright/test';
const editor = (page: Page) => page.getByRole('dialog', { name: 'Reorder navigation', exact: true });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button');
async function login(page: Page, name = 'Alex') {
  await page.goto('/');
  await page.getByRole('button', { name, exact: true }).click();
  await expect(nav(page).first()).toBeVisible();
}
async function edit(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Reorder navigation', exact: true }).click();
  await expect(editor(page).getByRole('button', { name: 'Save order', exact: true })).toBeEnabled();
}
test('navigation order syncs per profile, preserves offline drafts and restores defaults on a narrow screen', async ({
  page,
  browser,
  context,
}) => {
  await login(page);
  await edit(page);
  await editor(page).getByRole('button', { name: 'Use default order', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Move Shopping up', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Save order', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(nav(page).first()).toHaveAttribute('aria-label', 'Shopping');
  await page.reload();
  await expect(nav(page).first()).toHaveAttribute('aria-label', 'Shopping');
  const second = await browser.newContext();
  const other = await second.newPage();
  try {
    await login(other);
    await expect(nav(other).first()).toHaveAttribute('aria-label', 'Shopping');
  } finally {
    await second.close();
  }
  const sam = await browser.newContext();
  try {
    const other = await sam.newPage();
    await login(other, 'Sam');
    await expect(nav(other).first()).toHaveAttribute('aria-label', 'Inbox');
  } finally {
    await sam.close();
  }
  await page.getByRole('combobox', { name: 'Current profile' }).selectOption({ label: 'Sam' });
  await expect(nav(page).first()).toHaveAttribute('aria-label', 'Inbox');
  await page.getByRole('combobox', { name: 'Current profile' }).selectOption({ label: 'Alex' });
  await expect(nav(page).first()).toHaveAttribute('aria-label', 'Shopping');
  await page.setViewportSize({ width: 390, height: 844 });
  await edit(page);
  await context.setOffline(true);
  await expect(editor(page).getByRole('button', { name: 'Save order', exact: true })).toBeDisabled();
  await editor(page).getByRole('button', { name: 'Move Tasks up', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Move Tasks up', exact: true }).click();
  await expect(editor(page).locator('.navigation-order-row').first()).toContainText('Tasks');
  await editor(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Reorder navigation', exact: true }).click();
  await expect(editor(page).locator('.navigation-order-row').first()).toContainText('Tasks');
  await context.setOffline(false);
  await expect(editor(page).getByRole('button', { name: 'Save order', exact: true })).toBeEnabled();
  await editor(page).getByRole('button', { name: 'Save order', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(nav(page).first()).toHaveAttribute('aria-label', 'Tasks');
  await edit(page);
  await editor(page).getByRole('button', { name: 'Use default order', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Save order', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(nav(page).first()).toHaveAttribute('aria-label', 'Inbox');
});

test('a stale navigation draft cannot overwrite another device and can reload its saved order', async ({
  page,
  browser,
}) => {
  await login(page);
  await edit(page);
  await editor(page).getByRole('button', { name: 'Use default order', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Move Tasks up', exact: true }).click();
  const second = await browser.newContext();
  try {
    const other = await second.newPage();
    await login(other);
    await edit(other);
    await editor(other).getByRole('button', { name: 'Use default order', exact: true }).click();
    await editor(other).getByRole('button', { name: 'Move Shopping up', exact: true }).click();
    await editor(other).getByRole('button', { name: 'Save order', exact: true }).click();
    await expect(editor(other)).toHaveCount(0);
    await editor(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByLabel('Refresh and sync', { exact: true }).click();
    await expect(nav(page).first()).toHaveAttribute('aria-label', 'Shopping');
    await page.getByRole('button', { name: 'Reorder navigation', exact: true }).click();
    await expect(
      editor(page).getByText('The saved order changed on another device.', { exact: false }),
    ).toBeVisible();
    await expect(editor(page).getByRole('button', { name: 'Save order', exact: true })).toBeDisabled();
    await editor(page)
      .getByRole('button', { name: 'Discard draft and load saved order', exact: true })
      .click();
    await expect(editor(page).locator('.navigation-order-row').first()).toContainText('Shopping');
    await expect(editor(page).getByRole('button', { name: 'Save order', exact: true })).toBeEnabled();
    await editor(page).getByRole('button', { name: 'Use default order', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Save order', exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
  } finally {
    await second.close();
  }
});
