import { expect, test, type Page } from '@playwright/test';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);
async function login(page: Page, name = 'Alex') {
  await page.goto('/');
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
}
async function project(page: Page, title: string, privateOnly = false) {
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New project', exact: true });
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  if (privateOnly) await dialog.getByLabel('Visibility', { exact: true }).selectOption({ label: 'Just me' });
  await dialog
    .getByLabel('Description', { exact: true })
    .fill('Plans and inspiration, with room for the details.');
  await dialog.getByLabel('Description', { exact: true }).press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.project-board-heading')).toContainText(title);
}
async function child(page: Page, title: string) {
  await page.getByRole('button', { name: '+ New page', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New page', exact: true });
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByRole('button', { name: '+ Text', exact: true }).click();
  await dialog.getByLabel('Text', { exact: true }).fill('Keep this measurement: 80 cm.');
  await dialog.getByLabel('Text', { exact: true }).press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.project-board-heading')).toContainText(title);
}
async function overview(page: Page, title: string) {
  await page
    .getByRole('navigation', { name: 'Project breadcrumb' })
    .getByRole('button', { name: title, exact: true })
    .click();
}

test('Projects keeps unfinished blocks, photo placements, nested pages and priorities with undo and responsive layouts', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await project(page, 'Kitchen project');
  await child(page, 'Cabinet ideas');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit page', exact: true });
  await editor.getByRole('button', { name: '+ Web link', exact: true }).click();
  await expect(editor.getByLabel('Web address', { exact: true })).toBeVisible();
  await editor.getByLabel('Web address', { exact: true }).fill('https://');
  await editor.getByRole('button', { name: 'Close · keep draft', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: 'Kitchen project' }).click();
  await page.locator('.project-page-card').filter({ hasText: 'Cabinet ideas' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor.getByLabel('Web address', { exact: true })).toHaveValue('https://');
  await editor.getByLabel('Web address', { exact: true }).fill('https://example.com/cabinet');
  await editor.getByLabel('Link title', { exact: true }).fill('Cabinet inspiration');
  await editor.getByLabel('Notes', { exact: true }).fill('Check the depth.');
  await editor.getByLabel('Notes', { exact: true }).press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Cabinet inspiration', exact: true })).toHaveAttribute(
    'href',
    'https://example.com/cabinet',
  );
  await page.getByRole('button', { name: 'Photos', exact: true }).click();
  const photos = page.getByRole('dialog', { name: 'Photos & receipts', exact: true });
  await photos
    .locator('input[type=file]')
    .setInputFiles({ name: 'cabinet.png', mimeType: 'image/png', buffer: png });
  await photos.getByLabel('Caption for photo 1').fill('Door hinge');
  await photos.getByLabel('Caption for photo 1').press('Control+Enter');
  await expect(photos).toHaveCount(0);
  await expect(page.locator('.project-block-attachment img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.getByRole('button', { name: 'Move block 3 up', exact: true }).click();
  await editor.getByLabel('Title', { exact: true }).press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.project-block').nth(1)).toHaveClass(/attachment/);
  await child(page, 'Hardware sizes');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  const moving = page.getByRole('dialog', { name: 'Move page', exact: true });
  await moving.getByLabel('Inside page', { exact: true }).selectOption({ label: 'Project overview' });
  await moving.getByRole('button', { name: 'Move page', exact: true }).click();
  await expect(moving).toHaveCount(0);
  await overview(page, 'Kitchen project');
  await expect(page.locator('.project-page-card')).toHaveCount(2);
  for (const title of ['Cabinet ideas', 'Hardware sizes']) {
    await page.getByRole('button', { name: 'Pin something', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Find something to pin', { exact: true }).fill(title);
    await page.locator('.project-picker').getByRole('button').filter({ hasText: title }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Move priority 2 up', exact: true }).click();
  await expect(page.locator('.project-next li').first()).toContainText('Hardware sizes');
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Projects fits ${width}`,
    ).toBe(true);
    await page.screenshot({ path: `test-results/projects-board-${width}.png`, fullPage: true });
  }
  await page.locator('.project-page-card').filter({ hasText: 'Cabinet ideas' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Remove from project', exact: true })
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expect(page.locator('.project-block-attachment img')).toHaveCount(1);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Project history', exact: true })).toContainText(
    'Keep this measurement: 80 cm.',
  );
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  expect(errors).toEqual([]);
});

test('private boards stay private and shared reference cards open the existing note', async ({
  page,
  browser,
}) => {
  await login(page);
  await project(page, 'Secret present project', true);
  await child(page, 'Surprise idea');
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByLabel('What’s on your mind?', { exact: true }).fill('A shared project reference note');
  await page.getByLabel('What’s on your mind?', { exact: true }).press('Control+Enter');
  await expect(
    page.locator('.entry-card').filter({ hasText: 'A shared project reference note' }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await project(page, 'Shared reference board');
  await child(page, 'Notes to keep');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit page', exact: true });
  await editor.getByRole('button', { name: '+ App reference', exact: true }).click();
  await expect(
    editor.getByLabel('Reference', { exact: true }).locator('option').filter({ hasText: 'Surprise idea' }),
  ).toHaveCount(0);
  await editor
    .getByLabel('Reference', { exact: true })
    .selectOption({ label: 'Note · A shared project reference note' });
  await editor.getByLabel('Caption', { exact: true }).fill('The original note');
  await editor.getByLabel('Caption', { exact: true }).press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await page
    .locator('.project-reference')
    .getByRole('button')
    .filter({ hasText: 'A shared project reference note' })
    .click();
  await expect(page.getByRole('dialog')).toContainText('A shared project reference note');
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  const other = await browser.newContext();
  try {
    const partner = await other.newPage();
    await login(partner, 'Sam');
    await expect(partner.locator('.project-card').filter({ hasText: 'Secret present project' })).toHaveCount(
      0,
    );
    await partner.locator('.project-card').filter({ hasText: 'Shared reference board' }).click();
    await partner.locator('.project-page-card').filter({ hasText: 'Notes to keep' }).click();
    await expect(partner.locator('.project-content')).toContainText('A shared project reference note');
  } finally {
    await other.close();
  }
});

test('a lost project reply reconciles once, cached pages stay readable offline and restore chooses pages explicitly', async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New project', exact: true });
  await editor.getByLabel('Title', { exact: true }).fill('Retry project');
  await page.route(
    '**/api/commands/CreateProject',
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await editor.getByLabel('Title', { exact: true }).press('Control+Enter');
  await editor.getByRole('button', { name: 'Close · keep draft', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
  await expect(page.locator('.project-card').filter({ hasText: 'Retry project' })).toHaveCount(1);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.project-board-heading')).toContainText('Retry project');
  await child(page, 'Parent page');
  await child(page, 'Nested child');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
  await expect(page.locator('.project-content')).toContainText('80 cm');
  await overview(page, 'Retry project');
  await page.locator('.project-page-card').filter({ hasText: 'Parent page' }).click();
  await page.locator('.project-page-card').filter({ hasText: 'Nested child' }).click();
  await expect(page.locator('.project-content')).toContainText('80 cm');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
  await overview(page, 'Retry project');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('2 active nested pages');
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  const restore = page.getByRole('dialog', { name: 'Restore from removed', exact: true });
  await expect(restore.getByRole('checkbox').first()).not.toBeChecked();
  await restore.getByLabel('Parent page / Nested child', { exact: true }).check();
  await expect(restore.getByLabel('Parent page', { exact: true })).toBeChecked();
  await restore.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(restore).toHaveCount(0);
  await page.locator('.project-page-card').filter({ hasText: 'Parent page' }).click();
  await expect(page.locator('.project-page-card')).toContainText('Nested child');
});

test('a pinned task opens the exact existing task while the project and task histories stay independent', async ({
  page,
}) => {
  await login(page);
  const session = (await page.request.get('/api/session')).json();
  const current = await session,
    scopeId = current.scopes.find((s: { kind: string }) => s.kind === 'shared').scopeId;
  const taskId = crypto.randomUUID();
  for (const [recordId, title] of [
    [taskId, 'Paint the pantry'],
    [crypto.randomUUID(), 'Another household task'],
  ]) {
    const response = await page.request.post('/api/commands/CreateTask', {
      headers: { origin: 'http://127.0.0.1:4173' },
      data: {
        operationId: crypto.randomUUID(),
        contractVersion: 1,
        expectedServerEpoch: current.serverEpoch,
        arguments: {
          recordId,
          occurrenceId: crypto.randomUUID(),
          scopeId,
          title,
          instructions: 'Use the washable paint.',
          context: 'home',
          defaultAssigneeId: null,
          defaultPriority: 1,
          recurrence: null,
          assigneeId: null,
          priority: 1,
          deadlineDate: null,
          targetDate: null,
          reviewDate: null,
        },
      },
    });
    expect(response.ok()).toBe(true);
    expect((await response.json()).status).toBe('Applied');
  }
  await page.getByRole('button', { name: 'Refresh and sync', exact: true }).click();
  await project(page, 'Painting project');
  await page.getByRole('button', { name: 'Pin something', exact: true }).click();
  await page.getByLabel('Find something to pin', { exact: true }).fill('Paint the pantry');
  await page
    .locator('.project-picker')
    .getByRole('button')
    .filter({ has: page.locator('.eyebrow').getByText('Task', { exact: true }) })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.project-next').getByRole('button').filter({ hasText: 'Paint the pantry' }).click();
  await expect(page.locator('.task-card')).toHaveCount(1);
  await expect(page.locator('.task-card')).toContainText('Paint the pantry');
  await expect(page.locator('.task-card')).toContainText('Use the washable paint.');
  await expect(
    page.locator('.task-card').getByRole('button', { name: 'Complete Paint the pantry', exact: true }),
  ).toBeEnabled();
  const history = await page.request.get(`/api/records/${taskId}/history`);
  expect((await history.json()).entries).toHaveLength(1);
});
