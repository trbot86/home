import { expect, test, type Page, type Locator } from '@playwright/test';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=';
async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}
async function clipboardImage(page: Page) {
  await page.evaluate(async () => {
    // Clipboard image writes decode their input; generate a complete PNG like a real screenshot.
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#7e9d78';
    context.fillRect(0, 0, 32, 24);
    const image = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode clipboard fixture'))),
        'image/png',
      ),
    );
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
  });
}
async function transfer(page: Page, files: { type: string; size?: number }[] = [{ type: 'image/png' }]) {
  return page.evaluateHandle(
    ({ data, files }) => {
      const dt = new DataTransfer();
      for (const [i, file] of files.entries()) {
        const bytes =
          file.size === undefined
            ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
            : new Uint8Array(file.size);
        dt.items.add(new File([bytes], `photo-${i}`, { type: file.type }));
      }
      return dt;
    },
    { data: png, files },
  );
}
async function drop(page: Page, target: Locator, files?: { type: string; size?: number }[]) {
  const dt = await transfer(page, files);
  try {
    await target.dispatchEvent('dragenter', { dataTransfer: dt });
    await target.dispatchEvent('dragover', { dataTransfer: dt });
    await target.dispatchEvent('drop', { dataTransfer: dt });
  } finally {
    await dt.dispose();
  }
}

test('real screenshot paste and ordinary text paste create a durable offline capture without submitting early', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  const box = page.getByLabel('What’s on your mind?');
  await page.evaluate(() => navigator.clipboard.writeText('Clipboard capture text'));
  await box.focus();
  await page.keyboard.press('Control+v');
  await expect(box).toHaveValue('Clipboard capture text');
  await clipboardImage(page);
  await page.keyboard.press('Control+v');
  await expect(page.locator('.capture-photos img')).toHaveCount(1);
  await expect(box).toHaveValue('Clipboard capture text');
  const before = await (await page.request.get('/api/cache/inbox')).json();
  expect(before.entries.some((e: { text: string }) => e.text === 'Clipboard capture text')).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(box).toHaveValue('Clipboard capture text');
  await expect
    .poll(() => page.locator('.capture-photos img').evaluate((img: HTMLImageElement) => img.naturalWidth > 0))
    .toBe(true);
  await box.press('Control+Enter');
  await expect(page.getByRole('region', { name: 'Local drafts and pending captures' })).toContainText(
    'Clipboard capture text',
  );
  await context.setOffline(false);
  await page.getByLabel('Refresh and sync', { exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: 'Clipboard capture text' });
  await expect(card).toHaveCount(1);
  await expect(card.locator('img')).toHaveCount(1);
});

test('image drops reject whole invalid batches and limits, accept suggestions and block file navigation elsewhere', async ({
  page,
}) => {
  await login(page);
  const zone = page.getByRole('form', { name: 'Inbox capture' });
  await drop(page, zone, [{ type: 'image/png' }, { type: 'application/pdf' }]);
  await expect(page.getByRole('alert')).toContainText('Choose PNG, JPEG or WebP');
  await expect(page.locator('.capture-photos img')).toHaveCount(0);
  await drop(page, zone, [{ type: 'image/png', size: 26 * 1024 * 1024 }]);
  await expect(page.getByRole('alert')).toContainText('25 MB');
  await drop(
    page,
    zone,
    Array.from({ length: 21 }, () => ({ type: 'image/png' })),
  );
  await expect(page.getByRole('alert')).toContainText('20 photos');
  await expect(page.locator('.capture-photos img')).toHaveCount(0);
  const dt = await transfer(page, [{ type: 'image/png' }, { type: 'image/png' }]);
  await zone.dispatchEvent('dragenter', { dataTransfer: dt });
  await expect(zone).toHaveClass(/photo-dragging/);
  await page.screenshot({ path: 'test-results/photo-drop-active.png' });
  await zone.dispatchEvent('drop', { dataTransfer: dt });
  await dt.dispose();
  await expect(page.locator('.capture-photos img')).toHaveCount(2);
  await expect(zone).not.toHaveClass(/photo-dragging/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const url = page.url();
  await drop(page, page.locator('.page-status'));
  expect(page.url()).toBe(url);
  await expect(page.getByRole('alert')).toContainText('Drop photos in the capture box');
  await expect(page.locator('.capture-photos img')).toHaveCount(2);
  await page.getByRole('button', { name: /App suggestions/ }).click();
  await drop(page, page.getByRole('form', { name: 'Suggestion capture' }));
  await expect(page.locator('.capture-photos img')).toHaveCount(1);
  await page.reload();
  await page.getByRole('button', { name: /App suggestions/ }).click();
  await expect(page.locator('.capture-photos img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.locator('.capture-photos img')).toHaveCount(2);
});

test('photo editor accepts drop and real clipboard images, preserves captions and refuses offline changes', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  await page.getByLabel('What’s on your mind?').fill('Unfinished inbox text stays separate');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Transferred task photos');
  await page.getByLabel('Instructions', { exact: true }).press('Control+Enter');
  const card = page.locator('.task-card').filter({ hasText: 'Transferred task photos' });
  if (!(await card.locator('details.task-card-body').getAttribute('open'))) {
    if (!(await card.locator('details.task-card-body').evaluate((el) => (el as HTMLDetailsElement).open)))
      await card.locator('summary.task-summary').click();
  }
  await card.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Photos & receipts', exact: true }),
    editor = page.getByRole('form', { name: 'Photo editor' });
  await drop(page, editor);
  await dialog.getByLabel('Caption for photo 1').fill('Keep this caption');
  await clipboardImage(page);
  await page.keyboard.press('Control+v');
  await expect(dialog.getByLabel('Caption for photo 2')).toBeVisible();
  await expect(dialog.getByLabel('Caption for photo 1')).toHaveValue('Keep this caption');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  if (!(await card.locator('details.task-card-body').getAttribute('open'))) {
    if (!(await card.locator('details.task-card-body').evaluate((el) => (el as HTMLDetailsElement).open)))
      await card.locator('summary.task-summary').click();
  }
  await card.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  await expect(dialog.locator('img')).toHaveCount(2);
  await expect(dialog.getByLabel('Caption for photo 1')).toHaveValue('Keep this caption');
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/photo-transfer-${width}.png` });
  }
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  if (!(await card.locator('details.task-card-body').getAttribute('open'))) {
    if (!(await card.locator('details.task-card-body').evaluate((el) => (el as HTMLDetailsElement).open)))
      await card.locator('summary.task-summary').click();
  }
  await card.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Save photos', exact: true })).toBeDisabled();
  await drop(page, editor);
  await expect(dialog.getByRole('alert')).toContainText('read-only or saving');
  await expect(dialog.locator('img')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('Unfinished inbox text stays separate');
  await expect(page.locator('.capture-photos img')).toHaveCount(0);
  await context.setOffline(false);
  await page.getByLabel('Refresh and sync', { exact: true }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  if (!(await card.locator('details.task-card-body').getAttribute('open'))) {
    if (!(await card.locator('details.task-card-body').evaluate((el) => (el as HTMLDetailsElement).open)))
      await card.locator('summary.task-summary').click();
  }
  await card.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  await dialog.getByLabel('Caption for photo 1').press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(card.locator('img')).toHaveCount(2);
});

test('Ctrl+Enter cannot freeze a capture before dropped image bytes are saved', async ({ page }) => {
  await login(page);
  await page.getByLabel('What’s on your mind?').fill('Wait for image bytes before submitting');
  let submissions = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/commands/CreateInboxEntry')) submissions++;
  });
  const dt = await transfer(page);
  await page.evaluate((data) => {
    const file = data.files[0]!,
      original = file.arrayBuffer.bind(file);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => {
        await gate;
        return original();
      },
    });
    (window as unknown as { releasePhoto: () => void }).releasePhoto = release;
    const form = document.querySelector('.capture')!;
    form.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    form.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', ctrlKey: true }),
    );
  }, dt);
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  expect(submissions).toBe(0);
  await page.evaluate(() => (window as unknown as { releasePhoto: () => void }).releasePhoto());
  await dt.dispose();
  await expect(page.locator('.capture-photos img')).toHaveCount(1);
  expect(submissions).toBe(0);
  await page.getByLabel('What’s on your mind?').press('Control+Enter');
  await expect(
    page.locator('.entry-card').filter({ hasText: 'Wait for image bytes before submitting' }),
  ).toHaveCount(1);
  expect(submissions).toBe(1);
});
