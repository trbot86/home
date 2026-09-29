import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { seedActivity } from '../fixtures/activity.js';

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}
async function command(page: Page, kind: string, args: Record<string, unknown>) {
  const session = await (await page.request.get('/api/session')).json();
  const response = await page.request.post(`/api/commands/${kind}`, {
    headers: { origin: 'http://127.0.0.1:4173' },
    data: {
      operationId: randomUUID(),
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
const row = (page: Page, title: string) =>
  page.locator('.activity-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
async function feed(page: Page, search: string) {
  await page.getByRole('button', { name: 'Recently done', exact: true }).click();
  await page.getByLabel('Search activity').fill(search);
}

test('recent work combines actual completions without double counting, filters attribution and protects private activity', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  const session = await (await page.request.get('/api/session')).json();
  const cache = await (await page.request.get('/api/cache/inbox')).json();
  const sam = cache.tasks.people.find((p: { displayName: string }) => p.displayName === 'Sam').personId;
  await seedActivity((kind, args) => command(page, kind, args), session, sam, 'Activity');
  await page.getByLabel('Refresh and sync', { exact: true }).click();
  await feed(page, 'Activity');
  await expect(page.locator('.activity-card')).toHaveCount(6);
  await expect(page.locator('.activity-card h3')).toHaveText([
    'Activity Work paperwork',
    'Activity Make soup',
    'Activity Brush heads · 4-pack',
    'Activity Replace filter',
    'Activity Bread',
    'Activity Garden tool',
  ]);
  await expect(row(page, 'Activity Replace filter')).toContainText('Maintenance · Sam');
  await expect(row(page, 'Activity Make soup')).toContainText('Cooked · Sam');
  await expect(row(page, 'Activity Make soup').locator('..').getByRole('heading', { level: 2 })).toHaveText(
    'Tuesday, August 11, 2026',
  );
  await expect(page.locator('.activity-card')).not.toContainText(['Surprise weekend']);
  await page.getByLabel('Activity kind').selectOption('maintenance');
  await expect(page.locator('.activity-card')).toHaveCount(2);
  await page.getByLabel('Activity person').selectOption(sam);
  await expect(page.locator('.activity-card')).toHaveCount(1);
  await page.getByLabel('Activity kind').selectOption('all');
  await expect(page.locator('.activity-card')).toHaveCount(3);
  await page.getByLabel('Activity person').selectOption('unrecorded');
  await expect(page.locator('.activity-card')).toHaveCount(2);
  await page.getByLabel('Activity person').selectOption('everyone');
  await page.getByLabel('Activity context').selectOption('work');
  await expect(page.locator('.activity-card')).toHaveCount(1);
  await page.getByLabel('Activity context').selectOption('both');
  await page.getByLabel('Search activity').fill('Surprise');
  await expect(page.locator('.activity-card')).toHaveCount(0);
  await page.getByLabel('Activity visibility').selectOption('private');
  await expect(page.locator('.activity-card')).toHaveCount(1);
  await page.getByLabel('Search activity').fill('Activity');
  await expect(page.locator('.activity-card')).toHaveCount(2);
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await feed(page, 'Activity');
  await expect(page.getByLabel('Activity visibility')).toHaveValue('shared');
  await expect(page.locator('.activity-card')).toHaveCount(6);
  await page.getByLabel('Activity visibility').selectOption('all');
  await expect(page.locator('.activity-card')).toHaveCount(6);
  await expect(page.locator('body')).not.toContainText('Secret present');
  await expect(page.locator('body')).not.toContainText('Surprise weekend');
  await row(page, 'Activity Replace filter').getByRole('button', { name: 'Open history' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.historical-text')).toContainText(['Recorded after the work happened']);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await feed(page, 'Activity');
  await row(page, 'Activity Make soup').getByRole('button', { name: 'Recipe', exact: true }).click();
  await expect(page.locator('.food-detail')).toContainText('Activity Soup');
  await feed(page, 'Activity');
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.activity').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/activity-${width}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});

test('activity follows completion undo and keeps cached notes, photo status and drafts through offline navigation', async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByLabel('What’s on your mind?').fill('Keep this unfinished capture while reading activity');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Who can see this', { exact: true })
    .selectOption({ label: 'Shared' });
  await page.getByLabel('Task title', { exact: true }).fill('Feed undo fixture');
  await page.getByLabel('Instructions', { exact: true }).press('Control+Enter');
  const task = page.locator('.task-card').filter({ hasText: 'Feed undo fixture' });
  if (!(await task.locator('details.task-card-body').getAttribute('open'))) {
    if (!(await task.locator('details.task-card-body').evaluate((el) => (el as HTMLDetailsElement).open)))
      await task.locator('summary.task-summary').click();
  }
  await task.getByRole('button', { name: 'Done earlier…', exact: true }).click();
  await page.getByLabel('Completion note', { exact: true }).fill('Keep the spare in the cupboard');
  await page.getByLabel('Completion note', { exact: true }).press('Control+Enter');
  await feed(page, 'Feed undo fixture');
  await expect(page.locator('.activity-card')).toHaveCount(1);
  await page.locator('main').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Control+z');
  await expect(page.locator('.activity-card')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.activity-card')).toHaveCount(1);
  await row(page, 'Feed undo fixture').getByRole('button', { name: 'Task', exact: true }).click();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await page
    .locator('.completion-card')
    .filter({ hasText: 'Feed undo fixture' })
    .getByRole('button', { name: 'Photos & receipts' })
    .click();
  const photoDialog = page.getByRole('dialog', { name: 'Photos & receipts', exact: true });
  await photoDialog.locator('input[type=file]').setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(photoDialog.getByLabel('Caption for photo 1')).toBeVisible();
  await photoDialog.getByLabel('Caption for photo 1').fill('Spare filter');
  await photoDialog.getByRole('button', { name: 'Save photos', exact: true }).click();
  await expect(photoDialog).toHaveCount(0);
  await feed(page, 'Feed undo fixture');
  const card = row(page, 'Feed undo fixture');
  await expect(card.locator('img')).toHaveCount(0);
  await card.locator('summary').click();
  await expect(card).toContainText('Keep the spare in the cupboard');
  await expect(card.locator('img')).toHaveCount(1);
  await expect
    .poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await feed(page, 'Feed undo fixture');
  await expect(page.getByText('Showing downloaded activity.', { exact: false })).toBeVisible();
  await card.locator('summary').click();
  await expect(card).toContainText('Keep the spare in the cupboard');
  // Browser media URLs need a connection after reload; the caption and explicit unavailable state remain.
  await expect(card.getByText('Photo unavailable', { exact: true })).toBeVisible();
  await expect(card).toContainText('Spare filter');
  await expect(card.getByRole('button', { name: 'Open history' })).toBeDisabled();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue(
    'Keep this unfinished capture while reading activity',
  );
  await context.setOffline(false);
});
