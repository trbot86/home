import { expect, test, type Page } from '@playwright/test';

async function checkPadding(page: Page) {
  const dialog = page.getByRole('dialog');
  const points = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [
      { x: bounds.left + 5, y: bounds.top + bounds.height / 2 },
      { x: bounds.left + element.clientLeft + element.clientWidth - 5, y: bounds.top + bounds.height / 2 },
    ];
  });
  for (const point of points) {
    // Ensure this is the dialog's empty padding, not a child control.
    expect(
      await dialog.evaluate((element, p) => document.elementFromPoint(p.x, p.y) === element, point),
    ).toBe(true);
    await page.mouse.click(point.x, point.y);
    await expect(dialog).toBeVisible();
  }
}

for (const width of [390, 1440]) {
  test(`dialog padding preserves task, shopping and entry editors at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Alex', exact: true }).click();
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Task title', { exact: true }).fill('Keep this unfinished task');
    await dialog.getByLabel('Instructions', { exact: true }).fill('Retain these instructions');
    await checkPadding(page);
    await dialog.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await checkPadding(page);
    await expect(dialog.getByLabel('Task title', { exact: true })).toHaveValue('Keep this unfinished task');
    await expect(dialog.getByLabel('Instructions', { exact: true })).toHaveValue('Retain these instructions');
    // A genuine backdrop click must still dismiss and retain the draft.
    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await expect(dialog.getByLabel('Task title', { exact: true })).toHaveValue('Keep this unfinished task');
    await expect(dialog.getByLabel('Instructions', { exact: true })).toHaveValue('Retain these instructions');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: 'Shopping', exact: true }).click();
    await page.getByRole('button', { name: 'New list', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Unfinished shopping list');
    await checkPadding(page);
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Unfinished shopping list');
    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: 'Inbox', exact: true }).click();
    await page.getByLabel('What’s on your mind?').fill(`Padding check ${width}`);
    await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
    const card = page.locator('.entry-card').filter({ hasText: `Padding check ${width}` });
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.getByLabel('Entry text').fill('Keep this entry edit');
    await checkPadding(page);
    await expect(dialog.getByLabel('Entry text')).toHaveValue('Keep this entry edit');
    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(dialog.getByLabel('Entry text')).toHaveValue('Keep this entry edit');
    await page.getByRole('button', { name: 'Close entry', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
}
