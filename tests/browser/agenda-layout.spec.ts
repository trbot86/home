import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  calendarDateAt,
  defaultAgendaLayout,
  emptyRecipeFields,
  type AgendaLayout,
  type SavedView,
} from '../../packages/contracts/src/index.js';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Customise your agenda', exact: true });
async function login(page: Page, name = 'Alex') {
  await page.goto('/');
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
}
async function command(page: Page, kind: string, args: unknown) {
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
  expect(result.status).toBe('Applied');
  return result;
}
async function saved(page: Page) {
  const snapshot = await (await page.request.get('/api/cache/inbox')).json();
  return (snapshot.views as SavedView[]).find(
    (v): v is Extract<SavedView, { kind: 'agenda' }> => v.kind === 'agenda',
  );
}
async function setLayout(page: Page, layout: AgendaLayout = defaultAgendaLayout()) {
  const session = await (await page.request.get('/api/session')).json(),
    view = await saved(page);
  await command(page, 'SetAgendaLayout', {
    scopeId: session.scopes.find((s: { kind: string }) => s.kind === 'private').scopeId,
    expectedViewRevision: view?.revision ?? 0,
    layout,
  });
  await page.getByLabel('Refresh and sync', { exact: true }).click();
}
async function edit(page: Page) {
  await page.getByRole('button', { name: 'Customise agenda', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Save layout', exact: true })).toBeEnabled();
}
const sectionOrder = (page: Page) =>
  page
    .locator('[data-agenda-section]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-agenda-section')));

test('personal sections, counts, order and defaults sync across devices, retain offline drafts and open the pinned recipe or project page', async ({
  page,
  browser,
  context,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await setLayout(page);
  const session = await (await page.request.get('/api/session')).json(),
    scopeId = session.scopes.find((s: { kind: string }) => s.kind === 'private').scopeId;
  for (let i = 0; i < 3; i++) {
    const recordId = randomUUID();
    await command(page, 'CreateRecipe', {
      recordId,
      scopeId,
      ...emptyRecipeFields(),
      title: `Agenda soup ${i}`,
      collectionIds: [],
    });
    await command(page, 'SetRecordPin', {
      recordId,
      scopeId,
      viewKind: 'food_soon',
      expectedViewRevision: i,
      pinned: true,
    });
    await command(page, 'CreateTask', {
      recordId: randomUUID(),
      occurrenceId: randomUUID(),
      scopeId,
      title: `Agenda task ${i}`,
      instructions: 'Keep the details.',
      context: 'home',
      defaultAssigneeId: null,
      defaultPriority: 1,
      recurrence: null,
      assigneeId: null,
      priority: 1,
      deadlineDate: calendarDateAt(Date.now(), 'America/Toronto'),
      targetDate: null,
      reviewDate: null,
    });
  }
  const projectId = randomUUID(),
    pageId = randomUUID();
  await command(page, 'CreateProject', {
    recordId: projectId,
    scopeId,
    title: 'Agenda kitchen',
    description: '',
  });
  await command(page, 'CreateProjectPage', {
    recordId: pageId,
    projectId,
    parentPageId: null,
    title: 'Agenda measurements',
    blocks: [{ blockId: randomUUID(), kind: 'text', text: 'Keep this exact measurement: 81 cm.' }],
  });
  await command(page, 'SetRecordPin', {
    projectId,
    recordId: pageId,
    scopeId,
    viewKind: 'project_next',
    expectedViewRevision: 0,
    pinned: true,
  });
  await page.getByLabel('Refresh and sync', { exact: true }).click();
  await edit(page);
  await dialog(page).getByLabel('Make soon recipes', { exact: true }).check();
  await dialog(page).getByLabel('Project priorities', { exact: true }).check();
  for (const section of ['Your tasks today', 'Calendar events', 'Make soon recipes', 'Project priorities'])
    await dialog(page).getByLabel(`${section} item limit`, { exact: true }).fill('1');
  await dialog(page)
    .getByRole('button', { name: 'Move Make soon recipes up', exact: true })
    .click({ clickCount: 1 });
  await dialog(page).getByRole('button', { name: 'Move Make soon recipes up', exact: true }).click();
  await dialog(page)
    .getByRole('combobox', { name: 'Default Home/Work view', exact: true })
    .selectOption('home');
  await dialog(page)
    .getByRole('combobox', { name: 'Default calendar range', exact: true })
    .selectOption('30');
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await dialog(page).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await dialog(page)
    .getByRole('combobox', { name: 'Default calendar range', exact: true })
    .press('Control+Enter');
  await expect(dialog(page)).toHaveCount(0);
  expect(await sectionOrder(page)).toEqual(['food_soon', 'tasks', 'calendar', 'project_next']);
  await expect(page.locator('.agenda-focus .agenda-task')).toHaveCount(1);
  await expect(page.locator('.agenda-recipe')).toHaveCount(1);
  await page.getByRole('button', { name: 'Show more recipes (2 remaining)', exact: true }).click();
  await expect(page.locator('.agenda-recipe')).toHaveCount(2);
  await page.locator('.agenda-recipe').first().click();
  await expect(page.locator('.food-detail-heading')).toContainText('Agenda soup 0');
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await page.locator('.agenda-project-pin .agenda-task').click();
  await expect(page.locator('.project-board-heading')).toContainText('Agenda measurements');
  await expect(page.locator('.project-content')).toContainText('81 cm');
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await page
    .locator('.agenda-project-pin')
    .getByRole('button', { name: 'Agenda kitchen', exact: true })
    .click();
  await expect(page.locator('.project-board-heading')).toContainText('Agenda kitchen');
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390 || width === 1440)
      await page.screenshot({ path: `.local/agenda-layout-${width}.png`, fullPage: true });
  }
  const other = await browser.newPage();
  try {
    await login(other);
    expect(await sectionOrder(other)).toEqual(['food_soon', 'tasks', 'calendar', 'project_next']);
    await expect(other.getByRole('combobox', { name: 'Show', exact: true })).toHaveValue('home');
    await expect(other.getByRole('combobox', { name: 'Days', exact: true })).toHaveValue('30');
    await other.getByLabel('Current profile').selectOption({ label: 'Sam' });
    await other.getByRole('button', { name: 'Agenda', exact: true }).click();
    expect(await sectionOrder(other)).toEqual(['tasks', 'calendar']);
    expect(await saved(other)).toBeUndefined();
    const sam = await (await other.request.get('/api/cache/inbox')).json();
    expect(JSON.stringify(sam)).not.toContain('Agenda soup');
    expect(JSON.stringify(sam)).not.toContain('Agenda measurements');
  } finally {
    await other.close();
  }
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  expect(await sectionOrder(page)).toEqual(['food_soon', 'tasks', 'calendar', 'project_next']);
  await page.getByRole('button', { name: 'Customise agenda', exact: true }).click();
  await dialog(page).getByLabel('Your tasks today item limit').fill('');
  await expect(dialog(page).getByRole('button', { name: 'Save layout', exact: true })).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await page.getByRole('button', { name: 'Customise agenda', exact: true }).click();
  await expect(dialog(page).getByLabel('Your tasks today item limit')).toHaveValue('');
  await dialog(page).getByLabel('Your tasks today item limit').fill('2');
  await context.setOffline(false);
  await expect(dialog(page).getByRole('button', { name: 'Save layout', exact: true })).toBeEnabled();
  await dialog(page).getByRole('button', { name: 'Save layout', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.agenda-focus .agenda-task')).toHaveCount(2);
  await setLayout(page);
  expect(errors).toEqual([]);
});

test('a lost layout reply freezes edits until its receipt is reconciled without a second revision', async ({
  page,
}) => {
  await login(page);
  await setLayout(page);
  await edit(page);
  const before = (await saved(page))!.revision;
  await dialog(page)
    .getByRole('combobox', { name: 'Default Home/Work view', exact: true })
    .selectOption('work');
  const bodies: string[] = [];
  let sends = 0,
    dropped = false,
    allowReceipt = false;
  await page.route('**/api/commands/SetAgendaLayout', async (route) => {
    sends++;
    bodies.push(route.request().postData()!);
    const response = await route.fetch();
    if (allowReceipt) {
      expect((await response.json()).replayed).toBe(true);
      await route.fulfill({ response });
      return;
    }
    dropped = true;
    await route.abort('failed');
  });
  await page.route('**/api/operations/**', async (route) => {
    if (dropped && !allowReceipt) await route.abort('failed');
    else await route.continue();
  });
  await dialog(page).getByRole('button', { name: 'Save layout', exact: true }).click();
  await expect.poll(() => dropped).toBe(true);
  await expect(
    dialog(page).getByRole('combobox', { name: 'Default Home/Work view', exact: true }),
  ).toBeDisabled();
  await expect(
    dialog(page).getByRole('button', { name: 'Discard draft and load saved layout' }),
  ).toBeDisabled();
  allowReceipt = true;
  await dialog(page).getByRole('button', { name: 'Retry pending save', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await saved(page))!.revision).toBe(before + 1);
  expect(sends).toBe(2);
  expect(bodies[1]).toBe(bodies[0]);
  await page.unroute('**/api/commands/SetAgendaLayout');
  await setLayout(page);
});

test('an unreadable saved layout draft can be recovered and every section can be hidden', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await setLayout(page);
  await edit(page);
  await dialog(page).getByLabel('Your tasks today item limit').fill('2');
  await dialog(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
  const session = await (await page.request.get('/api/session')).json();
  await page.evaluate(async (clientId: string) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('our-place');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction('editors', 'readwrite'),
      store = tx.objectStore('editors'),
      key = `${clientId}:agenda:layout`,
      get = store.get(key);
    get.onsuccess = () => store.put({ ...get.result, text: JSON.stringify({ layout: 'broken draft' }) }, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, session.clientId);
  await page.getByRole('button', { name: 'Customise agenda', exact: true }).click();
  await expect(dialog(page)).toContainText('cannot be opened');
  await dialog(page).getByRole('button', { name: 'Discard draft and load saved layout' }).click();
  await expect(dialog(page).getByLabel('Your tasks today item limit')).toHaveValue('12');
  for (const section of ['Your tasks today', 'Calendar events', 'Make soon recipes', 'Project priorities'])
    await dialog(page).getByLabel(section, { exact: true }).uncheck();
  await dialog(page).getByRole('button', { name: 'Save layout', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await sectionOrder(page)).toEqual([]);
  await expect(page.locator('.agenda')).toContainText('No sections are shown');
  await setLayout(page);
  expect(errors).toEqual([]);
});

test('a second device cannot overwrite an open layout draft; defaults require an explicit save', async ({
  page,
  browser,
}) => {
  await login(page);
  await setLayout(page);
  await edit(page);
  await dialog(page).getByLabel('Your tasks today item limit').fill('3');
  const other = await browser.newPage();
  try {
    await login(other);
    const updated = defaultAgendaLayout();
    updated.context = 'work';
    await setLayout(other, updated);
    await dialog(page).getByRole('button', { name: 'Save layout', exact: true }).click();
    await expect(dialog(page)).toContainText('changed on another device');
    await expect(dialog(page).getByLabel('Your tasks today item limit')).toHaveValue('3');
    await expect(dialog(page).getByRole('button', { name: 'Save layout', exact: true })).toBeDisabled();
    await dialog(page).getByRole('button', { name: 'Discard draft and load saved layout' }).click();
    await expect(
      dialog(page).getByRole('combobox', { name: 'Default Home/Work view', exact: true }),
    ).toHaveValue('work');
    await dialog(page).getByRole('button', { name: 'Use default layout', exact: true }).click();
    expect((await saved(page))!.layout.context).toBe('work');
    await dialog(page).getByRole('button', { name: 'Save layout', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect((await saved(page))!.layout.context).toBe('both');
  } finally {
    await other.close();
  }
});
