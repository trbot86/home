import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, name = 'Alex') {
  await page.goto('/');
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByLabel('Who can see this capture')).toBeVisible();
}

test('new captures are private, explicit shared drafts survive reload, and the next capture is private', async ({
  page,
  browser,
}) => {
  await login(page);
  const visibility = page.getByLabel('Who can see this capture');
  await expect(visibility.locator('option:checked')).toHaveText('Just me');
  await page.getByLabel('What’s on your mind?').fill('Private default fixture');
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  await expect(page.locator('.entry-card').filter({ hasText: 'Private default fixture' })).toHaveCount(1);
  await visibility.selectOption({ label: 'Shared' });
  await page.getByLabel('What’s on your mind?').fill('Explicit shared draft fixture');
  await expect(page.getByText('Draft saved on this device')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('Explicit shared draft fixture');
  await expect(visibility.locator('option:checked')).toHaveText('Shared');
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  await expect(page.locator('.entry-card').filter({ hasText: 'Explicit shared draft fixture' })).toHaveCount(
    1,
  );
  await expect(visibility.locator('option:checked')).toHaveText('Just me');
  const other = await browser.newContext();
  try {
    const partner = await other.newPage();
    await login(partner, 'Sam');
    await expect(
      partner.locator('.entry-card').filter({ hasText: 'Explicit shared draft fixture' }),
    ).toHaveCount(1);
    await expect(partner.locator('.entry-card').filter({ hasText: 'Private default fixture' })).toHaveCount(
      0,
    );
  } finally {
    await other.close();
  }
});

test('standalone editors default to Just me and retain explicitly selected visibility', async ({ page }) => {
  await login(page);
  for (const [section, button, label] of [
    ['Tasks', 'New task', 'Who can see this'],
    ['Home', 'Add asset', 'Who can see this'],
    ['Food', 'Add a recipe', 'Who can see this'],
    ['Projects', 'New project', 'Visibility'],
    ['Shopping', 'New list', 'Who can see this'],
  ]) {
    await page.getByRole('button', { name: section, exact: true }).click();
    await page.getByRole('button', { name: button, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(label, { exact: true }).locator('option:checked')).toHaveText('Just me');
    await dialog.getByLabel(label, { exact: true }).selectOption({ label: 'Shared' });
    await dialog.getByRole('button', { name: /^Close (dialog|shopping dialog)$/ }).click();
    await page.getByRole('button', { name: button, exact: true }).click();
    await expect(dialog.getByLabel(label, { exact: true }).locator('option:checked')).toHaveText('Shared');
    await dialog.getByRole('button', { name: /^Close (dialog|shopping dialog)$/ }).click();
  }
});

test('shared lists and projects pass visibility to children without making the next standalone list shared', async ({
  page,
  browser,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Shared inheritance fixture');
  await dialog.getByLabel('Who can see this').selectOption({ label: 'Shared' });
  await dialog.getByLabel('Name', { exact: true }).press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('Add a shopping item').fill('Inherited shared item fixture');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(
    page.locator('.shopping-row').filter({ hasText: 'Inherited shared item fixture' }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Who can see this').locator('option:checked')).toHaveText(
    'Just me',
  );
  await page.getByRole('button', { name: /^Close (dialog|shopping dialog)$/ }).click();
  await page.getByRole('button', { name: 'Restock shelf', exact: true }).click();
  await page.getByRole('button', { name: 'New product', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Who can see this').locator('option:checked')).toHaveText(
    'Just me',
  );
  await page.getByRole('button', { name: /^Close (dialog|shopping dialog)$/ }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill('Shared project fixture');
  await dialog.getByLabel('Visibility').selectOption({ label: 'Shared' });
  await dialog.getByLabel('Title', { exact: true }).press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '+ New page', exact: true }).click();
  await dialog.getByLabel('Title', { exact: true }).fill('Inherited shared page fixture');
  await dialog.getByLabel('Title', { exact: true }).press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  const other = await browser.newContext();
  try {
    const partner = await other.newPage();
    await login(partner, 'Sam');
    await partner.getByRole('button', { name: 'Shopping', exact: true }).click();
    await partner
      .getByLabel('Shopping list', { exact: true })
      .selectOption({ label: 'Shared inheritance fixture' });
    await expect(
      partner.locator('.shopping-row').filter({ hasText: 'Inherited shared item fixture' }),
    ).toHaveCount(1);
    await partner.getByRole('button', { name: 'Projects', exact: true }).click();
    await partner.getByRole('button', { name: /Shared project fixture/ }).click();
    await expect(partner.getByRole('button', { name: /Inherited shared page fixture/ })).toBeVisible();
  } finally {
    await other.close();
  }
});
