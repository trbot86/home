import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Shared' });
}
async function capture(page: Page, text: string) {
  await page.getByLabel('What’s on your mind?').fill(text);
  await page.getByLabel('What’s on your mind?').press('Control+Enter');
  const card = page
    .locator('.entry-card')
    .filter({ has: page.locator('.entry-text').filter({ hasText: text }) });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Filing suggestions', exact: true }).click();
  return page.getByRole('dialog', { name: 'File this note', exact: true });
}
async function command(page: Page, kind: string, args: object) {
  const session = await (await page.request.get('/api/session')).json();
  const result = await page.request.post(`/api/commands/${kind}`, {
    headers: { origin: 'http://127.0.0.1:4173' },
    data: {
      operationId: crypto.randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: session.serverEpoch,
      arguments: args,
    },
  });
  expect((await result.json()).status).toBe('Applied');
}

test('consent setup, synthetic suggestions, explicit existing-page filing, reload deduplication and undo', async ({
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
  let dialog = await capture(page, 'Synthetic filing advice capture');
  await expect(dialog.getByRole('button', { name: 'Suggest filing', exact: true })).toBeDisabled();
  await dialog.getByText('Suggestion setup', { exact: true }).click();
  await dialog.getByLabel('Allow requests from this profile').check();
  await dialog.getByLabel('Shared inbox text', { exact: true }).check();
  await dialog.getByLabel('Allow selected destination titles with the same visibility').check();
  await dialog.getByRole('button', { name: 'Save suggestion permissions' }).click();
  await expect(dialog.getByText('Suggestion permissions saved.')).toBeVisible();
  await dialog.getByLabel('Suggestion destination context').selectOption(pageId);
  await dialog.getByRole('button', { name: 'Suggest filing', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Review suggestion: Project page: Advice precise page' }),
  ).toBeVisible();
  const snapshot = await (await page.request.get('/api/cache/inbox')).json();
  const note = snapshot.entries.find((e: any) => e.text === 'Synthetic filing advice capture');
  expect(note.filedAt).toBeNull();
  expect(note.revision).toBe(1);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await page
    .locator('.entry-card')
    .filter({ hasText: 'Synthetic filing advice capture' })
    .getByRole('button', { name: 'Review 2 filing suggestions', exact: true })
    .click();
  dialog = page.getByRole('dialog', { name: 'File this note', exact: true });
  await expect(dialog.getByRole('button', { name: 'Suggest filing', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Review suggestion: Project page: Advice precise page' }).click();
  await expect(dialog.getByLabel('Filing destination')).toHaveValue('existing');
  await expect(dialog.getByLabel('Saved item', { exact: true })).toHaveValue(pageId);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  await dialog.getByRole('button', { name: 'File note', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const filed = await (await page.request.get(`/api/inbox/${note.inboxId}`)).json();
  expect(filed.destinations[0].recordId).toBe(pageId);
  expect(filed.text).toBe(note.text);
  await page.keyboard.press('Control+z');
  await expect(
    page.locator('.entry-card').filter({ hasText: 'Synthetic filing advice capture' }),
  ).toHaveCount(1);
});

test('changed notes hide old suggestions and explicit retries produce a new attempt', async ({ page }) => {
  await login(page);
  const dialog = await capture(page, 'Synthetic stale advice capture');
  await dialog.getByText('Suggestion setup', { exact: true }).click();
  await dialog.getByLabel('Allow requests from this profile').check();
  await dialog.getByLabel('Shared inbox text', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save suggestion permissions' }).click();
  await expect(dialog.getByText('Suggestion permissions saved.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Suggest filing', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Review suggestion: tasks', exact: true })).toBeVisible();
  const snapshot = await (await page.request.get('/api/cache/inbox')).json();
  const note = snapshot.entries.find((e: any) => e.text === 'Synthetic stale advice capture');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await command(page, 'SetInboxEntryText', {
    inboxId: note.inboxId,
    expectedRevision: note.revision,
    text: 'Synthetic edited advice capture',
  });
  await page.reload();
  await page
    .locator('.entry-card')
    .filter({ hasText: 'Synthetic edited advice capture' })
    .getByRole('button', { name: 'Filing suggestions changed', exact: true })
    .click();
  await expect(
    dialog.getByText('This note or a destination changed. Previous suggestions are hidden.'),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Review suggestion: tasks', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Retry suggestions', exact: true })).toBeDisabled();
  await dialog
    .getByLabel('Send this item again; an interrupted attempt may already have reached the provider')
    .check();
  await dialog.getByRole('button', { name: 'Retry suggestions', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Review suggestion: tasks', exact: true })).toBeVisible();
  expect(
    (await (await page.request.get(`/api/inbox/${note.inboxId}/filing-advice`)).json()).review.attempt,
  ).toBe(2);
});

test('automatic consent discovers destinations and updates the inbox card without a manual request', async ({
  page,
}) => {
  await login(page);
  const dialog = await capture(page, 'Synthetic automatic filing advice');
  await dialog.getByText('Suggestion setup', { exact: true }).click();
  await dialog.getByLabel('Allow requests from this profile').check();
  await dialog.getByLabel('Shared inbox text', { exact: true }).check();
  await dialog.getByLabel('Allow selected destination titles with the same visibility').check();
  await dialog.getByLabel('Automatically suggest filing for unfiled inbox items').check();
  await dialog.getByRole('button', { name: 'Save suggestion permissions' }).click();
  await expect(dialog.getByText('Suggestion permissions saved.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Review suggestion: Project/ })).toBeVisible({ timeout: 25000 });
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: 'Synthetic automatic filing advice' });
  await expect(card.getByRole('button', { name: /Review \d+ filing suggestions/ })).toBeVisible({
    timeout: 25000,
  });
  await card.getByRole('button', { name: /Review \d+ filing suggestions/ }).click();
  await expect(dialog.getByRole('button', { name: /Review suggestion: Project/ })).toBeVisible();
  const snapshot = await (await page.request.get('/api/cache/inbox')).json();
  const note = snapshot.entries.find((e: any) => e.text === 'Synthetic automatic filing advice');
  expect(note.filedAt).toBeNull();
  expect(note.revision).toBe(1);
  await dialog.getByText('Suggestion setup', { exact: true }).click();
  await dialog.getByLabel('Allow requests from this profile').uncheck();
  await dialog.getByRole('button', { name: 'Save suggestion permissions' }).click();
  await expect(dialog.getByText('Suggestion permissions saved.')).toBeVisible();
});
