import { test, expect, type Page } from '@playwright/test';
async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
}
async function capture(page: Page, text: string) {
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Shared' });
  await page.getByLabel('What’s on your mind?').fill(text);
  await page.getByLabel('What’s on your mind?').press('Control+Enter');
  const card = page
    .locator('.entry-card')
    .filter({ has: page.locator('.entry-text').filter({ hasText: text }) });
  await expect(card).toHaveCount(1);
  return card;
}
async function configure(page: Page, titles = false, automatic = false) {
  await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Note suggestion settings' });
  await settings.getByLabel('Allow requests from this profile').check();
  await settings.getByLabel('Shared inbox text', { exact: true }).check();
  await settings.getByLabel('Allow selected destination titles with the same visibility').setChecked(titles);
  await settings.getByLabel('Automatically suggest filing for unfiled inbox items').setChecked(automatic);
  await settings.getByRole('button', { name: 'Save suggestion permissions' }).click();
  await expect(settings.getByText('Suggestion permissions saved.')).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Inbox', exact: true }).click();
}
async function command(page: Page, kind: string, args: object) {
  const session = await (await page.request.get('/api/session')).json();
  const r = await page.request.post(`/api/commands/${kind}`, {
    headers: { origin: 'http://127.0.0.1:4173' },
    data: {
      operationId: crypto.randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: session.serverEpoch,
      arguments: args,
    },
  });
  expect((await r.json()).status).toBe('Applied');
}
async function snapshot(page: Page) {
  return (await page.request.get('/api/cache/inbox')).json();
}

test('ranked destinations appear on the card; one click files a project page and undo preserves the original', async ({
  page,
}) => {
  await login(page);
  await configure(page, true);
  const session = await (await page.request.get('/api/session')).json(),
    scopeId = session.scopes.find((s: any) => s.kind === 'shared').scopeId;
  const projectId = crypto.randomUUID(),
    pageId = crypto.randomUUID();
  await command(page, 'CreateProject', {
    recordId: projectId,
    scopeId,
    title: 'Advice synthetic project',
    description: 'Excluded body',
  });
  await command(page, 'CreateProjectPage', {
    recordId: pageId,
    projectId,
    parentPageId: null,
    title: 'Advice precise page',
    blocks: [],
  });
  await page.getByRole('button', { name: 'Refresh and sync' }).click();
  const card = await capture(page, 'Synthetic precise advice capture');
  await expect(card.getByLabel('Suggestion destination context')).toHaveCount(0);
  await card.getByRole('button', { name: 'Suggest filing', exact: true }).click();
  const action = card.getByRole('button', { name: 'File to Project page: Advice precise page', exact: true });
  await expect(action).toBeVisible();
  expect(await card.locator('[aria-label="Suggested destinations"] button').count()).toBeLessThanOrEqual(3);
  const note = (await snapshot(page)).entries.find((e: any) => e.text === 'Synthetic precise advice capture');
  expect(note.filedAt).toBeNull();
  await page.reload();
  await expect(action).toBeVisible();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await card.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.cache/filing-quick-phone.png', fullPage: true });
  await action.click();
  await expect(card).toHaveCount(0);
  const data = await snapshot(page),
    filed = data.entries.find((e: any) => e.inboxId === note.inboxId),
    child = data.projects.pages.find((p: any) => p.recordId === filed.destinations[0].recordId);
  expect(child.parentPageId).toBe(pageId);
  expect(child.blocks.some((b: any) => b.text === note.text)).toBe(true);
  expect(filed.text).toBe(note.text);
  await page.keyboard.press('Control+z');
  await expect(card).toHaveCount(1);
});

test('Shopping asks only for a missing list; direct filing survives a lost reply without duplicates', async ({
  page,
}) => {
  await login(page);
  await configure(page, false);
  const session = await (await page.request.get('/api/session')).json(),
    scopeId = session.scopes.find((s: any) => s.kind === 'shared').scopeId,
    privateId = session.scopes.find((s: any) => s.kind === 'private').scopeId;
  const listId = crypto.randomUUID();
  for (const [id, scope, name] of [
    [listId, scopeId, 'Synthetic chosen purchases'],
    [crypto.randomUUID(), scopeId, 'Synthetic other purchases'],
    [crypto.randomUUID(), privateId, 'Private excluded list'],
  ])
    await command(page, 'CreateShoppingList', { recordId: id, scopeId: scope, name, purpose: 'household' });
  await page.getByRole('button', { name: 'Refresh and sync' }).click();
  const card = await capture(page, 'Buy synthetic household supplies');
  await card.getByRole('button', { name: 'Suggest filing', exact: true }).click();
  await card.getByRole('button', { name: 'File to Shopping', exact: true }).click();
  const picker = card.getByRole('group', { name: 'Choose suggested destination' });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Private excluded list' })).toHaveCount(0);
  let release = false;
  const attempts: string[] = [];
  await page.route('**/api/commands/FileInboxEntry', async (route) => {
    attempts.push(route.request().postData()!);
    if (release) return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await page.route('**/api/operations/**', (route) => (release ? route.continue() : route.abort('failed')));
  await picker.getByRole('button', { name: 'Synthetic chosen purchases', exact: true }).click();
  await expect.poll(() => attempts.length).toBeGreaterThan(0);
  release = true;
  await page.getByRole('button', { name: 'Refresh and sync' }).click();
  await expect(card).toHaveCount(0);
  expect(new Set(attempts).size).toBe(1);
  const data = await snapshot(page),
    items = data.shopping.entries.filter((e: any) => e.label === 'Buy synthetic household supplies');
  expect(items).toHaveLength(1);
  expect(items[0].listId).toBe(listId);
  expect(items[0].notes).toBe('Buy synthetic household supplies');
  // A lost acknowledgement has no immediate Undo toast; history retains the receipt.
  await page.getByRole('button', { name: 'Filed', exact: true }).click();
  await card.getByRole('button', { name: 'Open note', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'History', exact: true }).click();
  await dialog.getByRole('button', { name: 'Undo this change', exact: true }).first().click();
  await dialog.getByRole('button', { name: 'Close entry', exact: true }).click();
  await page.getByRole('button', { name: 'Unfiled', exact: true }).click();
  await expect(card).toHaveCount(1);
});

test('changed notes hide stale suggestions and retry is a single explicit action', async ({ page }) => {
  await login(page);
  await configure(page, false);
  let card = await capture(page, 'Synthetic stale advice capture');
  await card.getByRole('button', { name: 'Suggest filing', exact: true }).click();
  await expect(card.getByRole('button', { name: 'File to Tasks', exact: true })).toBeVisible();
  const note = (await snapshot(page)).entries.find((e: any) => e.text === 'Synthetic stale advice capture');
  await command(page, 'SetInboxEntryText', {
    inboxId: note.inboxId,
    expectedRevision: note.revision,
    text: 'Synthetic edited advice capture',
  });
  await page.reload();
  card = page.locator('.entry-card').filter({ hasText: 'Synthetic edited advice capture' });
  await expect(card.getByRole('button', { name: 'File to Tasks', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Retry suggestions', exact: true }).click();
  await expect(card.getByRole('button', { name: 'File to Tasks', exact: true })).toBeVisible();
  expect(
    (await (await page.request.get(`/api/inbox/${note.inboxId}/filing-advice`)).json()).review.attempt,
  ).toBe(2);
});

test('failed processing is retryable and reload does not dispatch another request', async ({ page }) => {
  await login(page);
  await configure(page, false);
  const card = await capture(page, 'Buy synthetic retry supplies');
  await card.getByRole('button', { name: 'Suggest filing', exact: true }).click();
  await expect(card.getByText("Suggestions couldn't be loaded. Try again.")).toBeVisible();
  await page.reload();
  await expect(card.getByRole('button', { name: 'Retry suggestions', exact: true })).toBeVisible();
  const note = (await snapshot(page)).entries.find((e: any) => e.text === 'Buy synthetic retry supplies');
  expect(note.filingAdvice.attempt).toBe(1);
  await card.getByRole('button', { name: 'Retry suggestions', exact: true }).click();
  await expect(card.getByRole('button', { name: 'File to Shopping', exact: true })).toBeVisible();
  expect(
    (await snapshot(page)).entries.find((e: any) => e.inboxId === note.inboxId).filingAdvice.attempt,
  ).toBe(2);
});

test('quick filing preserves a modified saved filing draft', async ({ page }) => {
  await login(page);
  await configure(page, false);
  const card = await capture(page, 'Synthetic draft advice capture');
  await card.getByRole('button', { name: 'Suggest filing', exact: true }).click();
  await card.getByRole('button', { name: 'To task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'File this note' });
  await dialog.getByLabel('Title', { exact: true }).fill('Keep my edited title');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await card.getByRole('button', { name: 'File to Tasks', exact: true }).click();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Keep my edited title');
  const note = (await snapshot(page)).entries.find((e: any) => e.text === 'Synthetic draft advice capture');
  expect(note.filedAt).toBeNull();
});

test('Think harder requests broader context explicitly and coverage survives reload without another send', async ({
  page,
}) => {
  await login(page);
  await configure(page, true);
  const card = await capture(page, 'Synthetic broader advice capture');
  await card.getByRole('button', { name: 'Suggest filing', exact: true }).click();
  await expect(card.locator('[aria-label="Suggested destinations"] button').first()).toBeVisible();
  await card.getByText('More options', { exact: true }).click();
  await expect(card.getByText(/Recent destinations:/)).toBeVisible();
  let broaderPosts = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/filing-advice') &&
      request.postDataJSON().search === 'all'
    )
      broaderPosts++;
  });
  await card.getByRole('button', { name: 'Think harder', exact: true }).click();
  await expect(card.getByText(/Broader search:/)).toBeVisible();
  const note = (await snapshot(page)).entries.find((e: any) => e.text === 'Synthetic broader advice capture');
  expect(note.filingAdvice.attempt).toBe(2);
  expect(note.filingAdvice.context.mode).toBe('all');
  expect(note.filedAt).toBeNull();
  await page.reload();
  await card.getByText('More options', { exact: true }).click();
  await expect(card.getByText(/Broader search:/)).toBeVisible();
  expect(broaderPosts).toBe(1);
});

test('automatic suggestions arrive as direct actions without opening a dialog', async ({ page }) => {
  await login(page);
  await configure(page, true, true);
  const card = await capture(page, 'Synthetic automatic filing advice');
  await expect(card.locator('[aria-label="Suggested destinations"] button').first()).toBeVisible({
    timeout: 25000,
  });
  const note = (await snapshot(page)).entries.find(
    (e: any) => e.text === 'Synthetic automatic filing advice',
  );
  expect(note.filedAt).toBeNull();
  await configure(page, true, false);
});

test('Secure capture persists offline and excludes requests; existing-note toggle survives reload', async ({
  page,
  context,
}) => {
  await login(page);
  await context.setOffline(true);
  await page.getByLabel('What’s on your mind?').fill('Synthetic protected offline capture');
  await page.getByLabel('Secure — exclude from AI context', { exact: true }).click();
  await expect(page.getByLabel('Secure — exclude from AI context', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Secure — exclude from AI context', { exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('Secure — exclude from AI context', { exact: true })).toBeChecked();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('Synthetic protected offline capture');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: 'Synthetic protected offline capture' });
  await expect(card).toHaveCount(1);
  const snapshot = await (await page.request.get('/api/cache/inbox')).json();
  const note = snapshot.entries.find((e: any) => e.text === 'Synthetic protected offline capture');
  const path = `/api/records/${note.inboxId}/security`;
  expect((await (await page.request.get(path)).json()).effective).toBe(true);
  await card.getByRole('button', { name: 'To task', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'File this note', exact: true });
  await dialog.getByText('More options', { exact: true }).click();
  await expect(dialog.getByText('Secure notes are excluded from suggestions.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Suggest filing', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await card.locator('.entry-text').click();
  dialog = page.getByRole('dialog');
  const toggle = dialog.getByLabel('Secure — exclude from AI context', { exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect.poll(async () => (await (await page.request.get(path)).json()).effective).toBe(false);
  await page.reload();
  await card.locator('.entry-text').click();
  await expect(
    page.getByRole('dialog').getByLabel('Secure — exclude from AI context', { exact: true }),
  ).not.toBeChecked();
});

test('project Secure control protects child pages and shows inherited protection at phone widths', async ({
  page,
}) => {
  await login(page);
  const session = await (await page.request.get('/api/session')).json();
  const scopeId = session.scopes.find((s: any) => s.kind === 'shared').scopeId;
  const projectId = crypto.randomUUID(),
    pageId = crypto.randomUUID();
  await command(page, 'CreateProject', {
    recordId: projectId,
    scopeId,
    title: 'Synthetic secure project',
    description: '',
  });
  await command(page, 'CreateProjectPage', {
    recordId: pageId,
    projectId,
    parentPageId: null,
    title: 'Synthetic protected page',
    blocks: [],
  });
  await page.getByRole('button', { name: 'Refresh and sync' }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: 'Synthetic secure project' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Edit project', exact: true });
  const toggle = dialog.getByLabel('Secure — exclude from AI context', { exact: true });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close · keep draft', exact: true }).click();
  await page.locator('.project-page-card').filter({ hasText: 'Synthetic protected page' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit page', exact: true });
  await expect(dialog.getByText(/Protected by a Secure container/)).toBeVisible();
  await expect(dialog.getByLabel('Secure — exclude from AI context', { exact: true })).not.toBeChecked();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  expect((await (await page.request.get(`/api/records/${pageId}/security`)).json()).effective).toBe(true);
});

test('ranked alternatives stay under More options; recipe filing preserves the note and supports undo', async ({
  page,
}) => {
  await login(page);
  await configure(page, false);
  const card = await capture(page, 'Synthetic broccoli cheddar soup');
  await card.getByRole('button', { name: 'Suggest filing', exact: true }).click();
  await expect(card.getByRole('button', { name: 'File to Shopping', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'File to Recipes', exact: true })).not.toBeVisible();
  let sends = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/filing-advice')) sends++;
  });
  await card.getByText('More options', { exact: true }).click();
  const alternatives = card.getByLabel('Alternative suggestions');
  await expect(alternatives.getByRole('button', { name: 'File to Recipes', exact: true })).toBeVisible();
  await expect(alternatives.getByRole('button', { name: 'File to Tasks', exact: true })).toBeVisible();
  await expect(alternatives.getByRole('button')).toHaveCount(2);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(await card.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    for (const name of ['Think harder', 'File to Recipes']) {
      const button = card.getByRole('button', { name, exact: true });
      expect(await button.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('solid');
      expect(await button.evaluate((e) => parseFloat(getComputedStyle(e).borderTopWidth))).toBeGreaterThan(0);
    }
  }
  await page.setViewportSize({ width: 390, height: 1000 });
  await card.screenshot({ path: '.cache/filing-alternatives-phone.png' });
  const note = (await snapshot(page)).entries.find((e: any) => e.text === 'Synthetic broccoli cheddar soup');
  await alternatives.getByRole('button', { name: 'File to Recipes', exact: true }).click();
  await expect(card).toHaveCount(0);
  const data = await snapshot(page);
  const filed = data.entries.find((e: any) => e.inboxId === note.inboxId);
  expect(filed.text).toBe(note.text);
  const recipe = data.recipes.recipes.find((r: any) => r.recordId === filed.destinations[0].recordId);
  expect(recipe.title).toBe(note.text);
  expect(recipe.description).toBe(note.text);
  expect(recipe.scopeId).toBe(note.scopeId);
  expect(recipe.ingredients).toEqual([]);
  expect(recipe.steps).toEqual([]);
  await page.keyboard.press('Control+z');
  await expect(card).toHaveCount(1);
  expect(
    (await snapshot(page)).recipes.recipes.find((r: any) => r.recordId === recipe.recordId).deletedAt,
  ).not.toBeNull();
  expect(sends).toBe(0);
});
