import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
}
async function capture(page: Page, text: string) {
  await page.getByLabel('What’s on your mind?').fill(text);
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: text.split('\n')[0]! });
  await expect(card).toHaveCount(1);
  return card;
}
async function back(page: Page) {
  await page.goBack();
}
async function forward(page: Page) {
  await page.goForward();
}

test('note history, close, and forward restore the panel without losing unfinished edits', async ({
  page,
}) => {
  await login(page);
  const card = await capture(page, 'Navigation history note');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Entry text').fill('Navigation history note with unfinished edits');
  await page.getByRole('dialog').getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByLabel('Entry text')).toHaveCount(0);
  await back(page);
  await expect(page.getByLabel('Entry text')).toHaveValue('Navigation history note with unfinished edits');
  await forward(page);
  await expect(page.getByRole('dialog').locator('.dialog-tabs .active')).toHaveText('History');
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await back(page);
  await expect(page.getByRole('dialog').locator('.dialog-tabs .active')).toHaveText('History');
  await back(page);
  await expect(page.getByLabel('Entry text')).toHaveValue('Navigation history note with unfinished edits');
  await back(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await forward(page);
  await expect(page.getByLabel('Entry text')).toHaveValue('Navigation history note with unfinished edits');
  expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain('Navigation history note');
});

test('linked-note back and forward preserve the source draft and branch on new navigation', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  const target = await capture(page, 'Navigation target');
  await target.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.getByText('Link copied', { exact: true })).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  const source = await capture(page, 'Navigation source\n' + url);
  await source.getByRole('button', { name: 'Edit', exact: true }).click();
  const draft = 'Unfinished source\n' + url;
  await holdEditorWrite(page);
  await page.getByLabel('Entry text').fill(draft + '\nFirst pending edit');
  await expect.poll(() => page.evaluate(() => (window as any).editorWriteHeld)).toBe(true);
  await page.getByLabel('Entry text').fill(draft);
  await page.locator('.entry-links').getByRole('link', { name: 'Navigation target', exact: true }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(draft);
  await page.evaluate(() => (window as any).releaseEditorWrite());
  await expect(page.getByLabel('Entry text')).toHaveValue('Navigation target');
  await back(page);
  await expect(page.getByLabel('Entry text')).toHaveValue(draft);
  await forward(page);
  await expect(page.getByLabel('Entry text')).toHaveValue('Navigation target');
  await back(page);
  await expect(page.getByLabel('Entry text')).toHaveValue(draft);
  await page.getByRole('dialog').getByRole('button', { name: 'History', exact: true }).click();
  await forward(page);
  await expect(page.getByRole('dialog').locator('.dialog-tabs .active')).toHaveText('History');
});

test('screen and editor navigation preserves separate inbox and suggestion drafts', async ({ page }) => {
  await login(page);
  await page.getByLabel('What’s on your mind?').fill('Unfinished inbox capture');
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await page.getByLabel('Suggest an improvement').fill('Unfinished suggestion capture');
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Unfinished list');
  await back(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await forward(page);
  await expect(page.getByRole('dialog').getByLabel('Name', { exact: true })).toHaveValue('Unfinished list');
  await back(page);
  await back(page);
  await expect(page.getByLabel('Suggest an improvement')).toHaveValue('Unfinished suggestion capture');
  await back(page);
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('Unfinished inbox capture');
  await forward(page);
  await expect(page.getByLabel('Suggest an improvement')).toHaveValue('Unfinished suggestion capture');
});

test('old profile history cannot reopen private panels', async ({ page }) => {
  await login(page);
  await page.getByLabel('Who can see this capture').selectOption({ label: 'Just me' });
  const card = await capture(page, 'Private navigation secret');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await expect(page.getByLabel('Current profile').locator('option:checked')).toHaveText('Sam');
  for (let i = 0; i < 3; i++) {
    await back(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Private navigation secret', { exact: true })).toHaveCount(0);
  }
  await forward(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Private navigation secret', { exact: true })).toHaveCount(0);
});

// Hold the first editor transaction's completion. Further useSavedForm writes
// remain queued, so the last keystrokes are not yet in IndexedDB when Back runs.
async function holdEditorWrite(page: Page) {
  await page.evaluate(() => {
    const pending: Array<() => void> = [];
    const original = IDBTransaction.prototype.addEventListener;
    let armed = true;
    (window as any).releaseEditorWrite = () => {
      armed = false;
      pending.splice(0).forEach((fn) => fn());
    };
    (window as any).editorWriteHeld = false;
    IDBTransaction.prototype.addEventListener = function (type: string, listener: any, options?: any) {
      if (
        armed &&
        type === 'complete' &&
        this.mode === 'readwrite' &&
        this.objectStoreNames.contains('editors')
      ) {
        armed = false;
        return original.call(
          this,
          type,
          (event: Event) => {
            (window as any).editorWriteHeld = true;
            pending.push(() => listener.call(this, event));
          },
          options,
        );
      }
      return original.call(this, type, listener, options);
    } as typeof original;
  });
}

test('Back waits for queued useSavedForm writes and Forward restores the last keystrokes', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  await page.getByRole('button', { name: 'Add a recipe', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a recipe', exact: true });
  await dialog.getByRole('button', { name: 'Write a recipe', exact: true }).click();
  const name = dialog.getByLabel('Recipe name', { exact: true });
  await holdEditorWrite(page);
  await name.fill('First queued value');
  await expect.poll(() => page.evaluate(() => (window as any).editorWriteHeld)).toBe(true);
  await name.fill('Last keystrokes must survive');
  await back(page);
  await expect(name).toHaveValue('Last keystrokes must survive');
  await forward(page);
  await expect(name).toHaveValue('Last keystrokes must survive');
  await back(page);
  await page.evaluate(() => (window as any).releaseEditorWrite());
  await expect(dialog).toHaveCount(0);
  await forward(page);
  await expect(dialog.getByLabel('Recipe name', { exact: true })).toHaveValue('Last keystrokes must survive');
});

test('reload and unknown tokens fall back safely while keeping calendar query parameters', async ({
  page,
}) => {
  await page.goto('/?settings=calendars&calendarConnect=synthetic-handoff');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
  await page.getByRole('button', { name: 'Shopping', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New list', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('settings')).toBe('calendars');
  expect(new URL(page.url()).searchParams.get('calendarConnect')).toBe('synthetic-handoff');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reorder navigation', exact: true })).toBeVisible();
  await back(page);
  await expect(page.getByRole('button', { name: 'Reorder navigation', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('calendarConnect')).toBe('synthetic-handoff');
  await forward(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('an old note URL still resolves through authorized lookup after browser reload', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  const card = await capture(page, 'Reloaded navigation link');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.getByText('Link copied', { exact: true })).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  await page.goto(url);
  await expect(page.getByLabel('Entry text')).toHaveValue('Reloaded navigation link');
  await page.getByRole('button', { name: 'Close entry', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
  await back(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await back(page);
  await expect(page.getByLabel('Entry text')).toHaveValue('Reloaded navigation link');
});

test('failed editor storage keeps the editor mounted until a successful retry', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  await page.getByRole('button', { name: 'Add a recipe', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a recipe', exact: true });
  await dialog.getByRole('button', { name: 'Write a recipe', exact: true }).click();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'editors') {
        IDBObjectStore.prototype.put = put;
        throw new Error('Synthetic editor storage failure');
      }
      return put.apply(this, args);
    };
  });
  await dialog.getByLabel('Recipe name', { exact: true }).fill('Keep this unsaved text');
  await expect(page.getByText('Synthetic editor storage failure', { exact: true })).toBeVisible();
  await back(page);
  await expect(dialog.getByLabel('Recipe name', { exact: true })).toHaveValue('Keep this unsaved text');
  await dialog.getByLabel('Recipe name', { exact: true }).fill('Recovered final draft');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await back(page);
  await expect(dialog.getByLabel('Recipe name', { exact: true })).toHaveValue('Recovered final draft');
});
