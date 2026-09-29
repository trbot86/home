import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
test('approximate planning and calendar visibility persist, with compact grouped agenda and completion on calendar', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const title = 'Approximate ' + randomUUID();
  await page.getByLabel('Task title', { exact: true }).fill(title);
  await page.getByLabel('Timing', { exact: true }).selectOption('asap');
  await expect(page.getByLabel('Show dated task in Calendar')).toBeChecked();
  await page.getByLabel('Show dated task in Calendar').uncheck();
  await page.getByLabel('Priority', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  const group = page.getByRole('region', { name: 'Today / ASAP', exact: true });
  await expect(group).toContainText(title);
  await expect(group).toContainText('Important');
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Calendar tasks' })).not.toContainText(title);
  const snapshot = await (await page.request.get('/api/cache/inbox')).json();
  const task = snapshot.tasks.definitions.find((t: any) => t.title === title),
    occurrence = snapshot.tasks.occurrences.find((o: any) => o.taskId === task.recordId);
  expect(occurrence.approximateDate).toBe('asap');
  expect(occurrence.calendarVisible).toBe(false);
  const session = await (await page.request.get('/api/session')).json();
  const response = await page.request.post('/api/commands/CompleteTaskOccurrence', {
    headers: { origin: 'http://127.0.0.1:4173' },
    data: {
      operationId: randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: session.serverEpoch,
      arguments: {
        recordId: occurrence.recordId,
        expectedRevision: occurrence.revision,
        expectedTaskRevision: task.revision,
        completionId: randomUUID(),
        nextOccurrenceId: null,
        completedAt: Date.now(),
        performedByPersonId: session.person.personId,
        note: '',
      },
    },
  });
  expect((await response.json()).status).toBe('Applied');
  await page.reload();
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Calendar tasks' })).toContainText(title);
  await expect(page.getByRole('region', { name: 'Calendar tasks' })).toContainText('Completed');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.cache/task-calendar-${width}.png`, fullPage: true });
  }
});
