import { expect, test, type Page } from '@playwright/test';
async function openTasks(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}
async function createTask(
  page: Page,
  title: string,
  configure?: (dialog: ReturnType<Page['getByRole']>) => Promise<void>,
) {
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Task title', { exact: true }).fill(title);
  if (configure) await configure(dialog);
  await dialog.getByLabel('Instructions', { exact: true }).press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  const card = page.locator('.task-card').filter({ hasText: title });
  await expect(card).toHaveCount(1);
  return card;
}
test('tasks separate deadlines from targets, repeat from actual completion and keep per-person history', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openTasks(page);
  const card = await createTask(page, 'Replace the kitchen filter', async (dialog) => {
    await dialog.getByLabel('Instructions', { exact: true }).fill('Check the size before installing.');
    await dialog.getByLabel('Flexible target', { exact: true }).fill('2026-08-01');
    await dialog.getByLabel('Actual deadline (optional)', { exact: true }).fill('2026-08-15');
    await dialog.getByLabel('Repeat after completion', { exact: true }).selectOption('months');
    await dialog.getByLabel('Repeat every', { exact: true }).fill('1');
  });
  await expect(page.getByRole('heading', { name: 'Past a real deadline', exact: false })).toBeVisible();
  await card.locator('summary').click();
  await card.getByRole('button', { name: '+1 week', exact: true }).click();
  await expect(card.locator('.task-late')).toContainText('Aug 15, 2026');
  await card.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.getByLabel('Actual deadline (optional)', { exact: true })).toHaveValue('2026-08-15');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await card.getByRole('button', { name: 'Done earlier…', exact: true }).click();
  await page.getByLabel('Actually completed at', { exact: true }).fill('2026-08-31T12:00');
  await page.getByLabel('Done by', { exact: true }).selectOption({ label: 'Sam' });
  await page.getByLabel('Completion note', { exact: true }).fill('Installed the spare from the cupboard.');
  await page.getByLabel('Completion note', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card).toContainText('Target · Sep 30, 2026');
  await expect(card).toContainText('by Sam');
  await page.getByRole('button', { name: 'Dismiss confirmation', exact: true }).click();
  await page.keyboard.press('Control+z');
  await expect(card.locator('.task-late')).toContainText('Aug 15, 2026');
  await page.keyboard.press('Control+Shift+z');
  await expect(card).toContainText('Target · Sep 30, 2026');
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  const completion = page.locator('.completion-card').filter({ hasText: 'Replace the kitchen filter' });
  await expect(completion).toContainText('Done by Sam');
  await expect(completion).toContainText('Installed the spare');
  await completion.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.historical-text')).toContainText(['Installed the spare']);
  await page.getByLabel('History for', { exact: true }).selectOption({ label: 'Task details' });
  await expect(page.locator('.historical-text').first()).toContainText('Check the size');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  const flexible = await createTask(page, 'Review the garden ideas', async (dialog) => {
    await dialog.getByLabel('Flexible target', { exact: true }).fill('2026-08-01');
  });
  await expect(flexible.locator('.task-late')).toHaveCount(0);
  await expect(
    flexible.locator('..').getByRole('heading', { name: 'Ready when you are', exact: false }),
  ).toBeVisible();
  await flexible.getByRole('button', { name: 'Delete Review the garden ideas', exact: true }).click();
  await expect(flexible).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(flexible).toHaveCount(1);
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Tasks fit ${width}px`,
    ).toBe(true);
    await page.screenshot({ path: `test-results/tasks-${width}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
test('task editor buffers, uncertain creation, private tasks and offline viewing stay isolated', async ({
  page,
  context,
  browser,
}) => {
  await openTasks(page);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Research a surprise weekend');
  await page.getByLabel('Instructions', { exact: true }).fill('Keep these unfinished details');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  // Simulate an unfinished form written by the previous app version, before maintenance fields existed.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('our-place', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('editors', 'readwrite'),
          store = tx.objectStore('editors');
        const request = store.openCursor();
        let upgradedFixture = false;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (String(cursor.key).endsWith(':task:new')) {
            const buffer = cursor.value,
              form = JSON.parse(buffer.text);
            delete form.maintenanceAssetId;
            delete form.maintenanceReference;
            cursor.update({ ...buffer, text: JSON.stringify(form) });
            upgradedFixture = true;
          }
          cursor.continue();
        };
        tx.oncomplete = () => (upgradedFixture ? resolve() : reject(new Error('Missing saved task fixture')));
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Research a surprise weekend');
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue('Keep these unfinished details');
  await page.getByLabel('Who can see this', { exact: true }).selectOption({ label: 'Just me' });
  let dropped = false;
  await page.route('**/api/commands/CreateTask', async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect.poll(() => dropped).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  const card = page.locator('.task-card').filter({ hasText: 'Research a surprise weekend' });
  await expect(card).toHaveCount(1);
  const partnerContext = await browser.newContext();
  try {
    const partner = await partnerContext.newPage();
    await partner.goto('/');
    await partner.getByRole('button', { name: 'Sam', exact: true }).click();
    await partner.getByRole('button', { name: 'Tasks', exact: true }).click();
    await partner.getByRole('button', { name: 'All tasks', exact: true }).click();
    await expect(partner.getByText('Research a surprise weekend', { exact: true })).toHaveCount(0);
  } finally {
    await partnerContext.close();
  }
  await context.setOffline(true);
  await expect(
    card.getByRole('button', { name: 'Complete Research a surprise weekend', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  await expect(card).toContainText('Keep these unfinished details');
  await expect(card.getByRole('button', { name: 'Plan', exact: true })).toBeDisabled();
  await context.setOffline(false);
});
