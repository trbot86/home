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

async function configure(page: Page, dialog: any, text: string, titles = false, automatic = false) {
  await expect(dialog.getByLabel('Allow requests from this profile')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Manage note suggestions in Settings' }).click();
  const settings = page.getByRole('region', { name: 'Note suggestion settings' });
  await settings.getByLabel('Allow requests from this profile').check();
  await settings.getByLabel('Shared inbox text', { exact: true }).check();
  if (titles) await settings.getByLabel('Allow selected destination titles with the same visibility').check();
  if (automatic) await settings.getByLabel('Automatically suggest filing for unfiled inbox items').check();
  await settings.getByRole('button', { name: 'Save suggestion permissions' }).click();
  await expect(settings.getByText('Suggestion permissions saved.')).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Inbox', exact: true }).click();
  await page
    .locator('.entry-card')
    .filter({ hasText: text })
    .getByRole('button', { name: /filing suggestions|Filing suggestions/ })
    .click();
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
  await configure(page, dialog, 'Synthetic filing advice capture', true, false);
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
  await configure(page, dialog, 'Synthetic stale advice capture', false, false);
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
  await configure(page, dialog, 'Synthetic automatic filing advice', true, true);
  await expect(dialog.getByRole('button', { name: /Review suggestion: Project/ })).toBeVisible({
    timeout: 25000,
  });
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
  await dialog.getByRole('button', { name: 'Manage note suggestions in Settings' }).click();
  const settings = page.getByRole('region', { name: 'Note suggestion settings' });
  await settings.getByLabel('Allow requests from this profile').uncheck();
  await settings.getByRole('button', { name: 'Save suggestion permissions' }).click();
  await expect(settings.getByText('Suggestion permissions saved.')).toBeVisible();
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
  await card.getByRole('button', { name: 'Filing suggestions', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'File this note', exact: true });
  await expect(
    dialog.getByText('Secure items are excluded from AI context. Manage Secure in the note editor.'),
  ).toBeVisible();
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
