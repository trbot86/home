import { expect, test, type Page } from '@playwright/test';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);
async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'Food', exact: true }).click();
}
async function manual(page: Page, title: string) {
  await page.getByRole('button', { name: 'Save a recipe', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save a recipe', exact: true });
  await dialog.getByRole('button', { name: 'Write a recipe', exact: true }).click();
  await dialog.getByLabel('Recipe name', { exact: true }).fill(title);
  await dialog.getByLabel('Ingredients', { exact: true }).fill('2 carrots\n1 onion');
  await dialog.getByLabel('Directions', { exact: true }).fill('Chop the vegetables.\n\nSimmer until tender.');
  await dialog.getByLabel('Directions', { exact: true }).press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.food-detail-heading')).toContainText(title);
}
async function runImport(page: Page) {
  const response = await page.request.post('http://127.0.0.1:4174/run-recipe-import', {
    headers: { 'x-test-token': process.env['OUR_PLACE_TEST_TOKEN']! },
  });
  expect(response.ok()).toBe(true);
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
}

test('Food keeps photos, adjustments, cooking notes and independent Soon pins across collections at all screen sizes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await manual(page, 'Our carrot soup');
  await page.getByRole('button', { name: 'Photos', exact: true }).click();
  const photos = page.getByRole('dialog', { name: 'Photos & receipts', exact: true });
  await photos
    .locator('input[type=file]')
    .setInputFiles({ name: 'soup.png', mimeType: 'image/png', buffer: png });
  await photos.getByLabel('Caption for photo 1').fill('Our soup test photo');
  await photos.getByLabel('Caption for photo 1').press('Control+Enter');
  await expect(page.locator('.food-detail img')).toHaveCount(1);
  await page.locator('.food-detail').getByRole('button', { name: 'Make soon', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pinned for soon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Move to favourites', exact: true }).click();
  await expect(
    page
      .getByRole('group', { name: 'Recipe collection' })
      .getByRole('button', { name: 'Favourites', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.food-card')).toContainText('Our carrot soup');
  await page.getByRole('button', { name: 'Add a note', exact: true }).click();
  await page.getByLabel('Adjustment', { exact: true }).fill('Use less salt next time.');
  await page.getByLabel('Adjustment', { exact: true }).press('Control+Enter');
  await expect(page.locator('.food-adjustments')).toContainText('Use less salt next time.');
  await page.getByRole('button', { name: 'Record cooking', exact: true }).click();
  await page.getByLabel('Cooked at', { exact: true }).fill('2026-02-13T18:30');
  await page.getByLabel('Cooked by', { exact: true }).selectOption({ label: 'Sam' });
  await page.getByLabel('Cooking notes', { exact: true }).fill('A keeper, with extra lemon.');
  await page.getByLabel('Cooking notes', { exact: true }).press('Control+Enter');
  await expect(page.locator('.food-cooking')).toContainText('extra lemon');
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Recipe name', { exact: true }).fill('Our lemon carrot soup');
  await page.getByLabel('Recipe name', { exact: true }).press('Control+Enter');
  await expect(page.locator('.food-detail-heading')).toContainText('Our lemon carrot soup');
  await expect(page.locator('.food-adjustments')).toContainText('Use less salt');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.food-detail-heading')).toContainText('Our carrot soup');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.food-detail-heading')).toContainText('Our lemon carrot soup');
  await page
    .getByRole('group', { name: 'Recipe collection' })
    .getByRole('button', { name: 'Make soon', exact: true })
    .click();
  await expect(page.locator('.food-card')).toContainText('Our lemon carrot soup');
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Food fits ${width}px`,
    ).toBe(true);
    await page.screenshot({ path: `test-results/food-${width}.png`, fullPage: true });
  }
  await page.getByText('Recipe options', { exact: true }).click();
  await page.getByRole('button', { name: 'Recipe history', exact: true }).click();
  await expect(page.locator('.history-list')).toContainText('Use less salt');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Archive recipe', exact: true }).click();
  await expect(page.locator('.food-detail-heading')).toContainText('Archived recipe');
  await expect(page.locator('.food-cooking')).toContainText('extra lemon');
  expect(errors).toEqual([]);
});

test('pasted link saves immediately, ambiguous source is reviewed, duplicate links open the existing recipe and offline cache remains readable', async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Save a recipe', exact: true }).click();
  await page.getByLabel('Recipe source link', { exact: true }).fill('https://example.com/multiple');
  await page.getByLabel('Recipe source link', { exact: true }).press('Control+Enter');
  await expect(page.locator('.food-import-status')).toContainText('Waiting');
  await runImport(page);
  await page.getByRole('button', { name: 'Review import', exact: true }).click();
  await page.getByLabel('Recipe found on page', { exact: true }).selectOption({ label: 'Synthetic stew' });
  await expect(page.getByLabel('Source picture', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Apply selected details', exact: true }).click();
  await expect(page.locator('.food-detail-heading')).toContainText('Synthetic stew');
  await expect(page.locator('.food-detail')).toContainText('Total · 30 min');
  await expect(page.locator('.food-detail')).toContainText('2 carrots');
  await expect(page.locator('.food-detail img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save a recipe', exact: true }).click();
  await page.getByLabel('Recipe source link', { exact: true }).fill('https://example.com/multiple#top');
  await page.getByLabel('Recipe source link', { exact: true }).press('Control+Enter');
  await page.getByRole('button', { name: 'Open existing recipe', exact: true }).click();
  await expect(page.locator('.food-card').filter({ hasText: 'Synthetic stew' })).toHaveCount(1);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
  await expect(page.locator('.food-section')).toContainText('Your saved recipes are available here');
  await expect(page.locator('.food-detail')).toContainText('Simmer until tender.');
  await expect(page.getByRole('button', { name: 'Move to favourites', exact: true })).toBeDisabled();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
});

test('recipe forms survive reload and lost acknowledgement without duplicate saves; private cards stay with their profile', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Save a recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Write a recipe', exact: true }).click();
  await page.getByLabel('Recipe name', { exact: true }).fill('Private unfinished pie');
  await page.getByLabel('Who can see this', { exact: true }).selectOption({ label: 'Just me' });
  await page.getByLabel('Description', { exact: true }).fill('Keep this draft and its private visibility.');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  await page.getByRole('button', { name: 'Save a recipe', exact: true }).click();
  await expect(page.getByLabel('Recipe name', { exact: true })).toHaveValue('Private unfinished pie');
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
    'Keep this draft and its private visibility.',
  );
  await page.route(
    '**/api/commands/CreateRecipe',
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await page.getByLabel('Description', { exact: true }).press('Control+Enter');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
  await page.getByRole('button', { name: 'Save a recipe', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.food-card').filter({ hasText: 'Private unfinished pie' })).toHaveCount(1);
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  await page
    .getByRole('group', { name: 'Recipe collection' })
    .getByRole('button', { name: 'All recipes', exact: true })
    .click();
  await expect(page.locator('.food-card').filter({ hasText: 'Private unfinished pie' })).toHaveCount(0);
});

test('recipe cooking tasks preserve plans, link back from Tasks, postpone independently and undo the whole meal completion', async ({
  page,
}) => {
  await login(page);
  await manual(page, 'Planned lentil soup');
  await page.getByRole('button', { name: 'Create a to-do', exact: true }).click();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue('Make Planned lentil soup');
  await expect(page.getByLabel('Cooks (optional)', { exact: true })).toHaveValue(/.+/);
  await page.getByLabel('Assigned to', { exact: true }).selectOption({ label: 'Sam' });
  await page.getByLabel('Flexible target', { exact: true }).fill('2026-10-01');
  await page.getByLabel('Actual deadline (optional)', { exact: true }).fill('2026-11-30');
  await page.getByLabel('Repeat after completion', { exact: true }).selectOption('months');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  await page.locator('.food-card').filter({ hasText: 'Planned lentil soup' }).click();
  await page.getByRole('button', { name: 'Create a to-do', exact: true }).click();
  await expect(page.getByLabel('Flexible target', { exact: true })).toHaveValue('2026-10-01');
  await page.getByLabel('Task title', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  let plan = page.locator('.food-cooking-task').filter({ hasText: 'Make Planned lentil soup' });
  await expect(plan).toContainText('Sam');
  await expect(plan).toContainText('Target Oct 1, 2026');
  await plan.getByText('Move a date', { exact: true }).click();
  await plan.getByRole('button', { name: '+1 week', exact: true }).click();
  await expect(plan).toContainText('Target Oct 8, 2026');
  await expect(plan).toContainText('Deadline Nov 30, 2026');
  await expect(page.locator('.food-cooking article')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByLabel('Task person').selectOption('everyone');
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Recipe: Planned lentil soup', exact: true }).click();
  await expect(page.locator('.food-detail-heading')).toContainText('Planned lentil soup');
  plan = page.locator('.food-cooking-task').filter({ hasText: 'Make Planned lentil soup' });
  await plan.getByRole('button', { name: 'Record completion', exact: true }).click();
  await page.getByLabel('Actually completed at', { exact: true }).fill('2026-08-31T18:30');
  await page.getByLabel('Done by', { exact: true }).selectOption({ label: 'Sam' });
  await page.getByLabel('Completion note', { exact: true }).fill('Made with smoked paprika.');
  await page.getByLabel('Completion note', { exact: true }).press('Control+Enter');
  await expect(page.locator('.food-cooking')).toContainText('smoked paprika');
  await expect(plan).toContainText('Target Sep 30, 2026');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.food-cooking article')).toHaveCount(0);
  await expect(plan).toContainText('Target Oct 8, 2026');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.food-cooking article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit cooking notes', exact: true }).click();
  await expect(page.getByLabel('Cooked by', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Cooked at', { exact: true })).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 1100 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
