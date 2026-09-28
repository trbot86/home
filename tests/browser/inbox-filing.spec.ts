import { expect, test, type Page } from '@playwright/test';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);
async function login(page: Page, name = 'Alex') {
  await page.goto('/');
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Shared' });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}
async function command(page: Page, kind: string, args: object) {
  const session = await (await page.request.get('/api/session')).json();
  const response = await page.request.post(`/api/commands/${kind}`, {
    headers: { origin: 'http://127.0.0.1:4173' },
    data: {
      operationId: crypto.randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: session.serverEpoch,
      arguments: args,
    },
  });
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.status, JSON.stringify(result)).toBe('Applied');
  return result;
}
async function snapshot(page: Page) {
  return (await page.request.get('/api/cache/inbox')).json();
}
async function capture(page: Page, text: string) {
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByLabel('What’s on your mind?').fill(text);
  await page.getByLabel('What’s on your mind?').press('Control+Enter');
  const card = page
    .locator('.entry-card')
    .filter({ has: page.locator('.entry-text').filter({ hasText: text }) });
  await expect(card).toHaveCount(1);
  return card;
}
async function file(page: Page, text: string) {
  const card = page
    .locator('.entry-card')
    .filter({ has: page.locator('.entry-text').filter({ hasText: text }) });
  await card.getByRole('button', { name: 'To task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'File this note', exact: true });
  await expect(dialog.getByLabel('Filing destination')).toBeEnabled();
  return dialog;
}
async function saved(page: Page) {
  await expect(page.getByRole('dialog', { name: 'File this note' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Filed', exact: true }).click();
}

test('filing a photo note into a task keeps its draft, original, links and compound undo at every screen size', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'filter.png', mimeType: 'image/png', buffer: png });
  const text = 'Filing test: kitchen filter\nRead the size from the photo.';
  const card = await capture(page, text);
  let dialog = await file(page, text);
  await dialog.getByLabel('Title', { exact: true }).fill('Fit the photographed filter');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  dialog = await file(page, text);
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Fit the photographed filter');
  await expect(dialog.getByLabel('Details', { exact: true })).toHaveValue(text);
  await dialog.locator('summary').click();
  await expect(dialog.locator('img')).toHaveCount(1);
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      `Filing dialog fits ${width}`,
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.cache/filing-${width}.png`, fullPage: true });
  }
  await dialog.getByLabel('Details', { exact: true }).press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await saved(page);
  await expect(card.locator('img')).toHaveCount(1);
  await card.getByRole('button', { name: 'Task: Fit the photographed filter', exact: true }).click();
  const task = page.locator('.task-card');
  await expect(task).toHaveCount(1);
  await task.getByRole('button', { name: /Original note & photos:/ }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(text);
  await expect(page.getByRole('dialog').locator('img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close entry' }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Unfiled', exact: true }).click();
  await page.keyboard.press('Control+z');
  await expect(card).toHaveCount(1);
  const undone = await snapshot(page);
  expect(
    undone.tasks.definitions.find((t: any) => t.title === 'Fit the photographed filter').deletedAt,
  ).not.toBeNull();
  await page.keyboard.press('Control+Shift+z');
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'All notes', exact: true }).click();
  await expect(card).toHaveCount(1);
  expect(
    (await snapshot(page)).tasks.definitions.filter(
      (t: any) => t.title === 'Fit the photographed filter' && t.deletedAt === null,
    ),
  ).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('shopping and nested project filing preserve full source text; existing links, return and unlink keep destinations', async ({
  page,
}) => {
  await login(page);
  const session = await (await page.request.get('/api/session')).json();
  const scopeId = session.scopes.find((s: any) => s.kind === 'shared').scopeId;
  const listId = crypto.randomUUID(),
    projectId = crypto.randomUUID(),
    parentPageId = crypto.randomUUID();
  await command(page, 'CreateShoppingList', {
    recordId: listId,
    scopeId,
    name: 'Filing supplies',
    purpose: 'household',
  });
  await command(page, 'CreateProject', {
    recordId: projectId,
    scopeId,
    title: 'Filing bathroom',
    description: '',
  });
  await command(page, 'CreateProjectPage', {
    recordId: parentPageId,
    projectId,
    parentPageId: null,
    title: 'Measurements',
    blocks: [],
  });
  await page.getByRole('button', { name: 'Refresh and sync' }).click();
  const text = 'Filing long shopping capture\n' + 'detail '.repeat(1500);
  const card = await capture(page, text);
  let dialog = await file(page, text);
  await dialog.getByLabel('Filing destination').selectOption('shopping');
  await dialog.getByLabel('Shopping list', { exact: true }).selectOption(listId);
  await expect(dialog.getByLabel('Details', { exact: true })).toHaveValue(text);
  await expect(dialog.getByRole('alert')).toContainText('10,000-character limit');
  await expect(dialog.getByRole('button', { name: 'File note', exact: true })).toBeDisabled();
  await dialog.getByLabel('Item name', { exact: true }).fill('Filing brush heads');
  await dialog.getByLabel('Quantity', { exact: true }).fill('2');
  await dialog.getByLabel('Details', { exact: true }).fill('Consult original specifications.');
  await dialog.getByLabel('Details', { exact: true }).press('Control+Enter');
  await saved(page);
  await expect(card.locator('.entry-text')).toHaveText(text);
  await card.getByRole('button', { name: 'Shopping item: Filing brush heads', exact: true }).click();
  await expect(page.locator('.shopping-row').filter({ hasText: 'Filing brush heads' })).toContainText(
    'Original note: Filing long shopping capture',
  );
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  dialog = await file(page, text);
  await dialog.getByLabel('Filing destination').selectOption('project');
  await dialog.getByLabel('Project', { exact: true }).selectOption(projectId);
  await dialog.getByLabel('Inside page', { exact: true }).selectOption(parentPageId);
  await dialog.getByLabel('Title', { exact: true }).fill('Filing brush measurements');
  await dialog.getByLabel('Details', { exact: true }).press('Control+Enter');
  await saved(page);
  await card.getByRole('button', { name: 'Project page: Filing brush measurements', exact: true }).click();
  await expect(page.locator('.project-board-heading')).toContainText('Filing brush measurements');
  await expect(page.getByRole('navigation', { name: 'Project breadcrumb' })).toContainText('Measurements');
  await page.locator('.project-reference').getByRole('button').click();
  await expect(page.getByLabel('Entry text')).toHaveValue(text);
  await page.getByRole('button', { name: 'Close entry' }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await card.getByRole('button', { name: 'Back to inbox', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Unfiled', exact: true }).click();
  await expect(card.locator('.filing-links > div')).toHaveCount(2);
  dialog = await file(page, text);
  await dialog.getByLabel('Filing destination').selectOption('existing');
  await dialog.getByLabel('Find a destination').fill('Filing brush heads');
  await dialog
    .getByLabel('Saved item', { exact: true })
    .selectOption({ label: 'Shopping item: Filing brush heads' });
  // Changing the search must not silently clear a selected destination.
  await dialog.getByLabel('Find a destination').fill('nonmatching search');
  await dialog.getByRole('button', { name: 'File note', exact: true }).click();
  await saved(page);
  await expect(card.locator('.filing-links > div')).toHaveCount(2);
  await card.getByRole('button', { name: 'Unlink Filing brush heads', exact: true }).click();
  await expect(card.locator('.filing-links > div')).toHaveCount(1);
  await card.getByRole('button', { name: 'Unlink Filing brush measurements', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Unfiled', exact: true }).click();
  await expect(card).toHaveCount(1);
  const final = await snapshot(page);
  expect(final.shopping.entries.find((e: any) => e.label === 'Filing brush heads').deletedAt).toBeNull();
  expect(final.projects.pages.find((p: any) => p.title === 'Filing brush measurements').deletedAt).toBeNull();
});

for (const mode of ['task', 'recipe'] as const)
  test(`a lost filing reply freezes edits and retries exactly once without duplicating the ${mode}`, async ({
    page,
  }) => {
    await login(page);
    const text = `Filing retry capture ${mode}`;
    const card = await capture(page, text);
    const dialog = await file(page, text);
    await dialog.getByLabel('Filing destination').selectOption(mode);
    await dialog.getByLabel('Title', { exact: true }).fill(`Filing retry ${mode}`);
    const attempts: string[] = [];
    let release = false;
    await page.route('**/api/commands/FileInboxEntry', async (route) => {
      attempts.push(route.request().postData()!);
      if (release) return route.continue();
      await route.fetch();
      await route.abort('failed');
    });
    await page.route('**/api/operations/**', (route) => (release ? route.continue() : route.abort('failed')));
    await dialog.getByRole('button', { name: 'File note', exact: true }).click();
    await expect(dialog.getByText('Checking the previous filing.', { exact: false })).toBeVisible();
    await expect(dialog.getByLabel('Title', { exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Discard filing draft', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Retry filing', exact: true }).click();
    await expect.poll(() => attempts.length).toBeGreaterThan(1);
    expect(new Set(attempts).size).toBe(1);
    release = true;
    await dialog.getByRole('button', { name: 'Retry filing', exact: true }).click();
    await saved(page);
    await expect(card).toHaveCount(1);
    await page.reload();
    await page.getByRole('button', { name: 'Filed', exact: true }).click();
    const state = await snapshot(page);
    const records = mode === 'task' ? state.tasks.definitions : state.recipes.recipes;
    expect(records.filter((t: any) => t.title === `Filing retry ${mode}`)).toHaveLength(1);
    await card.getByRole('button', { name: 'To task', exact: true }).click();
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(text);
  });

test('offline filing drafts survive reload and refuse to overwrite a partner’s newer source', async ({
  page,
  context,
  browser,
}) => {
  await login(page);
  const text = 'Filing stale capture';
  await capture(page, text);
  await context.setOffline(true);
  let dialog = await file(page, text);
  await dialog.getByLabel('Title', { exact: true }).fill('Keep my offline filing title');
  await expect(dialog.getByRole('button', { name: 'File note', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  dialog = await file(page, text);
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Keep my offline filing title');
  const other = await browser.newContext();
  try {
    const partner = await other.newPage();
    await login(partner, 'Sam');
    const source = (await snapshot(partner)).entries.find((e: any) => e.text === text);
    await command(partner, 'SetInboxEntryText', {
      inboxId: source.inboxId,
      expectedRevision: source.revision,
      text: 'Partner clarified the filing capture',
    });
    await context.setOffline(false);
    await expect(
      dialog.getByText('This note changed since the filing draft began.', { exact: false }),
    ).toBeVisible();
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Keep my offline filing title');
    await expect(dialog.getByRole('button', { name: 'File note', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Discard draft and load current note', exact: true }).click();
    await expect(dialog.getByLabel('Details', { exact: true })).toHaveValue(
      'Partner clarified the filing capture',
    );
    await dialog.getByRole('button', { name: 'File note', exact: true }).click();
    await saved(page);
  } finally {
    await other.close();
  }
});

test('private capture filing keeps destinations private and does not expose backlinks to the other profile', async ({
  page,
  browser,
}) => {
  await login(page);
  const session = await (await page.request.get('/api/session')).json();
  const shared = session.scopes.find((s: any) => s.kind === 'shared').scopeId;
  const listId = crypto.randomUUID();
  await command(page, 'CreateShoppingList', {
    recordId: listId,
    scopeId: shared,
    name: 'Shared filing reference',
    purpose: 'household',
  });
  await page.getByRole('button', { name: 'Refresh and sync' }).click();
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Just me' });
  const text = 'Secret filing present';
  const card = await capture(page, text);
  let dialog = await file(page, text);
  await expect(dialog).toContainText('Just me');
  await dialog.getByLabel('Filing destination').selectOption('shopping');
  await expect(
    dialog.getByLabel('Shopping list', { exact: true }).locator(`option[value="${listId}"]`),
  ).toHaveCount(0);
  await dialog.getByLabel('Filing destination').selectOption('task');
  await dialog.getByLabel('Title', { exact: true }).fill('Secret filing errand');
  await dialog.getByRole('button', { name: 'File note', exact: true }).click();
  await saved(page);
  dialog = await file(page, text);
  await dialog.getByLabel('Filing destination').selectOption('existing');
  await dialog
    .getByLabel('Saved item', { exact: true })
    .selectOption({ label: 'Shopping list: Shared filing reference' });
  await dialog.getByRole('button', { name: 'File note', exact: true }).click();
  await saved(page);
  await expect(card.locator('.filing-links > div')).toHaveCount(2);
  const other = await browser.newContext();
  try {
    const partner = await other.newPage();
    await login(partner, 'Sam');
    const state = await snapshot(partner);
    expect(JSON.stringify(state)).not.toContain('Secret filing');
    await partner.getByRole('button', { name: 'Shopping', exact: true }).click();
    await partner.getByLabel('Shopping list', { exact: true }).selectOption(listId);
    await expect(partner.locator('.capture-sources')).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('destination actions open reviewable drafts and food preserves the original capture', async ({
  page,
}) => {
  await login(page);
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'soup.png', mimeType: 'image/png', buffer: png });
  const text = 'Weeknight soup idea\nKeep these notes for the recipe.';
  const card = await capture(page, text);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const name of ['To task', 'Into project', 'To shopping', 'To food'])
      await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
    await card.screenshot({ path: `.cache/inbox-actions-${width}.png` });
  }
  for (const label of ['Edit', 'History', 'Suggest', 'File'])
    await expect(card.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Open note', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Entry text')).toHaveValue(text);
  await expect(page.getByRole('button', { name: 'History', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close entry' }).click();
  for (const [label, mode] of [
    ['To task', 'task'],
    ['Into project', 'project'],
    ['To shopping', 'shopping'],
    ['To food', 'recipe'],
  ]) {
    await card.getByRole('button', { name: label, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'File this note', exact: true });
    await expect(dialog.getByLabel('Filing destination')).toHaveValue(mode);
    await expect(dialog.getByLabel('Details', { exact: true })).toHaveValue(text);
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  }
  await card.getByRole('button', { name: 'To food', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'File this note', exact: true });
  await dialog.getByLabel('Title', { exact: true }).fill('Reviewed soup');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  // An unfinished draft wins over the next shortcut, so it is never silently replaced.
  await card.getByRole('button', { name: 'To task', exact: true }).click();
  await expect(dialog.getByLabel('Filing destination')).toHaveValue('recipe');
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Reviewed soup');
  await dialog.getByRole('button', { name: 'File note', exact: true }).click();
  await saved(page);
  await card.getByRole('button', { name: 'Recipe: Reviewed soup', exact: true }).click();
  await page.getByRole('button', { name: /Original note & photos: Weeknight soup idea/ }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(text);
  await expect(page.getByRole('dialog').locator('img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close entry' }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.keyboard.press('Control+z');
  await expect
    .poll(
      async () =>
        (await snapshot(page)).recipes.recipes.find((r: any) => r.title === 'Reviewed soup').deletedAt,
    )
    .not.toBeNull();
  await page.keyboard.press('Control+Shift+z');
  await expect
    .poll(
      async () =>
        (await snapshot(page)).recipes.recipes.find((r: any) => r.title === 'Reviewed soup').deletedAt,
    )
    .toBeNull();
});
