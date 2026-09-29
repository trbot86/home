import { expect, test, type Page } from '@playwright/test';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);
async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'Recipes', exact: true }).click();
}
async function manual(page: Page, title: string) {
  await page.getByRole('button', { name: 'Add a recipe', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a recipe', exact: true });
  await dialog.getByRole('button', { name: 'Write a recipe', exact: true }).click();
  await dialog.getByLabel('Recipe name', { exact: true }).fill(title);
  await dialog.getByLabel('Who can see this', { exact: true }).selectOption({ label: 'Shared' });
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
async function shoppingList(page: Page, name: string) {
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Who can see this', { exact: true })
    .selectOption({ label: 'Shared' });
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Recipes', exact: true }).click();
}

test('recipe shopping preserves a selected checklist, collapsed named groups, source links and safe group removal', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await shoppingList(page, 'Recipe groceries');
  await manual(page, 'Shopping carrot soup');
  await page.getByRole('button', { name: 'Shop for this recipe', exact: true }).click();
  await page.getByLabel('Ingredient shopping list').selectOption({ label: 'Recipe groceries' });
  await page.getByLabel('Ingredient group name').fill('Soup for Sunday');
  await page.getByLabel('Include 1 onion', { exact: true }).uncheck();
  await page.getByLabel('Quantity for 2 carrots', { exact: true }).fill('One bag');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Recipes', exact: true }).click();
  await page.locator('.food-card').filter({ hasText: 'Shopping carrot soup' }).click();
  await page.getByRole('button', { name: 'Shop for this recipe', exact: true }).click();
  await expect(page.getByLabel('Ingredient group name')).toHaveValue('Soup for Sunday');
  await expect(page.getByLabel('Include 1 onion', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Quantity for 2 carrots', { exact: true })).toHaveValue('One bag');
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(await page.getByRole('dialog').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  }
  await page.getByLabel('Ingredient group name').press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Recipe groceries' });
  const group = page
    .locator('.shopping-group')
    .filter({ has: page.locator('summary').filter({ hasText: 'Soup for Sunday' }) });
  await expect(group).not.toHaveAttribute('open', '');
  await expect(group.locator('summary').first()).toContainText('1 needed');
  await group.locator('summary').first().click();
  await expect(group.locator('.shopping-row')).toHaveCount(1);
  await expect(group).toContainText('One bag');
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Grouped shopping fits ${width}`,
    ).toBe(true);
    await page.screenshot({ path: `test-results/shopping-group-${width}.png`, fullPage: true });
  }
  await group.getByRole('button', { name: 'Recipe: Shopping carrot soup', exact: true }).first().click();
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Recipe name', { exact: true }).fill('Renamed carrot soup');
  await page.getByLabel('Ingredients', { exact: true }).fill('4 carrots');
  await page.getByLabel('Ingredients', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Recipe groceries' });
  await group.locator('summary').first().click();
  await group.getByRole('button', { name: /^Edit / }).click();
  await page.getByRole('dialog').getByText('From a recipe', { exact: true }).click();
  await expect(
    page.getByRole('dialog').locator('.shopping-source').filter({ hasText: 'From a recipe' }),
  ).toContainText('2 carrots');
  await expect(
    page.getByRole('dialog').locator('.shopping-source').filter({ hasText: 'From a recipe' }),
  ).toContainText('Shopping carrot soup');
  await page.getByRole('button', { name: 'Close shopping dialog' }).click();
  await group.getByRole('button', { name: 'Delete Soup for Sunday', exact: true }).click();
  await page.getByRole('button', { name: 'Remove group, keep items', exact: true }).click();
  await expect(group).toHaveCount(0);
  await expect(page.locator('.shopping-row')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(group).toHaveCount(1);
  await group.locator('summary').first().click();
  const partnerContext = await browser.newContext();
  try {
    const partner = await partnerContext.newPage();
    await partner.goto('/');
    await partner.getByRole('button', { name: 'Sam', exact: true }).click();
    await partner.getByRole('button', { name: 'Shopping', exact: true }).click();
    await partner.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Recipe groceries' });
    const partnerGroup = partner.locator('.shopping-group').filter({ hasText: 'Soup for Sunday' });
    await partnerGroup.locator('summary').first().click();
    await partnerGroup.getByRole('button', { name: 'Bought 2 carrots', exact: true }).click();
    await expect(partnerGroup.locator('summary').first()).toContainText('0 needed');
    await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
    await page.keyboard.press('Control+Shift+z');
    await expect(group).toHaveCount(1);
    await page.getByRole('button', { name: 'Purchased', exact: true }).click();
    await group.locator('summary').first().click();
    await group.getByRole('button', { name: /^Edit / }).click();
    await expect(page.getByRole('dialog')).toContainText('Bought by Sam');
    await page.getByRole('button', { name: 'Close shopping dialog' }).click();
  } finally {
    await partnerContext.close();
  }
  expect(errors).toEqual([]);
});

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
  await expect(page.locator('.food-card').filter({ hasText: 'Our lemon carrot soup' })).toHaveCount(1);
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

test('a lost recipe-shopping response is reconciled once and grouped shopping remains readable offline', async ({
  page,
  context,
}) => {
  await login(page);
  await shoppingList(page, 'Retry recipe groceries');
  await manual(page, 'Retry vegetable soup');
  await page.getByRole('button', { name: 'Shop for this recipe', exact: true }).click();
  await page.getByLabel('Ingredient shopping list').selectOption({ label: 'Retry recipe groceries' });
  await page.getByLabel('Ingredient group name').fill('Retry Sunday soup');
  await page.route(
    '**/api/commands/AddRecipeIngredients',
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await page.getByLabel('Ingredient group name').press('Control+Enter');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
  await page.getByRole('button', { name: 'Shop for this recipe', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Retry recipe groceries' });
  const group = page.locator('.shopping-group');
  await expect(group).toHaveCount(1);
  await group.locator('summary').first().click();
  await expect(group.locator('.shopping-row')).toHaveCount(2);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
  await expect(group.getByRole('button', { name: 'Bought 2 carrots', exact: true })).toBeDisabled();
  await expect(group).toContainText('Retry Sunday soup');
  await group.getByRole('button', { name: 'Recipe: Retry vegetable soup', exact: true }).first().click();
  await expect(page.locator('.food-detail')).toContainText('2 carrots');
  await expect(page.getByRole('button', { name: 'Shop for this recipe', exact: true })).toBeDisabled();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
});

test('pasted link saves immediately, ambiguous source is reviewed, duplicate links open the existing recipe and offline cache remains readable', async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Add a recipe', exact: true }).click();
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
  await page.getByRole('button', { name: 'Add a recipe', exact: true }).click();
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
  await page.getByRole('button', { name: 'Add a recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Write a recipe', exact: true }).click();
  await page.getByLabel('Recipe name', { exact: true }).fill('Private unfinished pie');
  await page.getByLabel('Who can see this', { exact: true }).selectOption({ label: 'Just me' });
  await page.getByLabel('Description', { exact: true }).fill('Keep this draft and its private visibility.');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Recipes', exact: true }).click();
  await page.getByRole('button', { name: 'Add a recipe', exact: true }).click();
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
  await page.getByRole('button', { name: 'Add a recipe', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.food-card').filter({ hasText: 'Private unfinished pie' })).toHaveCount(1);
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await page.getByRole('button', { name: 'Recipes', exact: true }).click();
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
  await page.getByRole('button', { name: 'Recipes', exact: true }).click();
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
  await page
    .locator('.task-card')
    .filter({ hasText: 'Make Planned lentil soup' })
    .locator('summary.task-summary')
    .click();
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

test('recipe ingredients create a named list with store-search notes and preserve the saved selection', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .locator('.settings-section > summary')
    .filter({ hasText: /^Nearby shopping$/ })
    .click();
  const settings = page.getByRole('region', { name: 'Shopping preferences' });
  await settings.getByLabel('City or postal code').fill('Example city');
  await settings.getByRole('button', { name: 'Add store', exact: true }).click();
  await settings.getByLabel('Store 1', { exact: true }).fill('Neighbourhood market');
  await settings.getByRole('button', { name: 'Add store', exact: true }).click();
  await settings.getByLabel('Store 2', { exact: true }).fill('Bulk warehouse');
  await settings.getByLabel('Prefer for larger orders').nth(1).check();
  await settings.getByRole('button', { name: 'Save shopping preferences', exact: true }).click();
  await expect(settings.getByRole('status')).toHaveText('Shopping preferences saved.');
  await page.getByRole('button', { name: 'Recipes', exact: true }).click();
  await manual(page, 'New list soup');
  await page.getByRole('button', { name: 'Shop for this recipe', exact: true }).click();
  await page.getByLabel('Ingredient shopping list').selectOption('new');
  await page.getByLabel('New list name', { exact: true }).fill('Dinner supplies');
  await page.getByRole('button', { name: 'Check nearby stores', exact: true }).click();
  await expect(page.getByText('Neighbourhood market', { exact: true })).toBeVisible();
  await expect(page.getByText('Bulk warehouse · larger orders', { exact: true })).toHaveCount(0);
  await page.getByLabel('Larger order: include bulk stores').check();
  await expect(page.getByText('Bulk warehouse · larger orders', { exact: true })).toBeVisible();
  await page.getByText('Neighbourhood market', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'Find 2 carrots', exact: true })).toHaveAttribute(
    'href',
    /Neighbourhood%20market%20Example%20city%202%20carrots/,
  );
  await page.getByRole('button', { name: 'Save search to buying notes', exact: true }).first().click();
  await expect(page.getByLabel('Buying notes', { exact: true })).toHaveValue(/stock unverified/);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Shop for this recipe', exact: true }).click();
  await expect(page.getByLabel('New list name', { exact: true })).toHaveValue('Dinner supplies');
  await page.getByRole('button', { name: 'Add 2 items to shopping', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Dinner supplies' });
  await page.getByText('List notes', { exact: true }).click();
  await expect(page.locator('.shopping-list-notes')).toContainText('Neighbourhood market');
  await expect(page.locator('.shopping-group')).toHaveCount(1);
  await page.locator('main').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Control+z');
  await expect(
    page
      .getByLabel('Shopping list', { exact: true })
      .locator('option')
      .filter({ hasText: 'Dinner supplies' }),
  ).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(
    page
      .getByLabel('Shopping list', { exact: true })
      .locator('option')
      .filter({ hasText: 'Dinner supplies' }),
  ).toHaveCount(1);
});

test('sourcing shows only exceptions, saves one default-store summary, and keeps failures distinct', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .locator('.settings-section > summary')
    .filter({ hasText: /^Nearby shopping$/ })
    .click();
  const settings = page.getByRole('region', { name: 'Shopping preferences' });
  await settings.getByLabel('Default store', { exact: true }).fill('Example supermarket');
  await settings.getByRole('button', { name: 'Save shopping preferences', exact: true }).click();
  await expect(settings.getByRole('status')).toHaveText('Shopping preferences saved.');
  await page.getByRole('button', { name: 'Recipes', exact: true }).click();
  await manual(page, 'Sourcing example');
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Ingredients', { exact: true }).fill('Flour\nSynthetic specialty ingredient');
  await page.getByLabel('Ingredients', { exact: true }).press('Control+Enter');
  await page.getByRole('button', { name: 'Shop for this recipe', exact: true }).click();
  await page.getByLabel('Ingredient shopping list').selectOption('new');
  const sourcing = page.getByRole('region', { name: 'Ingredient sourcing' });
  await expect(sourcing).toContainText('Everything else is at Example supermarket.');
  await sourcing.getByRole('button', { name: 'Suggest sourcing', exact: true }).click();
  await expect(sourcing.getByRole('link', { name: 'Search alternatives', exact: true })).toHaveCount(1);
  await expect(sourcing.locator('li')).toHaveText(/Synthetic specialty ingredient/);
  await sourcing.getByRole('button', { name: 'Use sourcing notes', exact: true }).click();
  await expect(page.getByLabel('Sourcing notes', { exact: true })).toHaveValue(
    /Everything else is at Example supermarket/,
  );
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Shop for this recipe', exact: true }).click();
  await expect(sourcing.getByRole('link', { name: 'Search alternatives', exact: true })).toHaveCount(1);
  await page.getByLabel('Include Synthetic specialty ingredient', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Add 1 item to shopping', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Clear sourcing notes', exact: true }).click();
  await sourcing.getByRole('button', { name: 'Suggest sourcing', exact: true }).click();
  await expect(sourcing).toContainText('No likely exceptions identified.');
  await sourcing.getByRole('button', { name: 'Use sourcing notes', exact: true }).click();
  await expect(page.getByLabel('Sourcing notes', { exact: true })).not.toHaveValue(/specialty ingredient/);
  await page.getByRole('button', { name: 'Add 1 item to shopping', exact: true }).click();
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByLabel('Shopping list', { exact: true }).selectOption({ label: 'Sourcing example' });
  await expect(page.locator('.shopping-list-notes')).toContainText(
    'Everything else is at Example supermarket',
  );
  await page.getByRole('button', { name: 'Recipes', exact: true }).click();
  await manual(page, 'Sourcing failure example');
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Ingredients', { exact: true }).fill('Synthetic sourcing failure');
  await page.getByLabel('Ingredients', { exact: true }).press('Control+Enter');
  await page.getByRole('button', { name: 'Shop for this recipe', exact: true }).click();
  await sourcing.getByRole('button', { name: 'Suggest sourcing', exact: true }).click();
  await expect(sourcing).toContainText('The last attempt did not finish successfully.');
  await expect(sourcing.getByRole('button', { name: 'Use sourcing notes', exact: true })).toHaveCount(0);
});
