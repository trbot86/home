// Run only against OurPlaceTest and scripts/browser-fixture.ts. No live household writes.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const adb = (...args) => exec(resolve('.tools/android-sdk/platform-tools/adb.exe'), ['-H', '127.0.0.1', '-P', '5041', '-s', '127.0.0.1:5581', ...args], { windowsHide: true });
if ((await adb('shell', 'getprop', 'ro.boot.qemu.avd_name')).stdout.trim() !== 'OurPlaceTest') throw new Error('Refusing non-test device');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
try {
  const page = browser.contexts()[0].pages()[0];
  const invoke = (method, args = {}) => page.evaluate(async ({ method, args }) =>
    (await window.Capacitor.Plugins.Household.invoke({ method, args })).value, { method, args });
  if ((await invoke('endpoint')) !== 'http://10.0.2.2:4173') throw new Error('Refusing non-test household');
  await page.reload();
  if (!(await invoke('state')).session) await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const title = `Native receipt test ${Date.now()}`;
  await page.getByLabel('Task title', { exact: true }).fill(title);
  await page.getByLabel('Instructions', { exact: true }).fill('Keep the product label');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const card = page.locator('.task-card').filter({ hasText: title });
  await card.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Photos & receipts', exact: true });
  const state = await invoke('state'); const task = state.tasks.definitions.find(t => t.title === title);
  const draft = await invoke('openAttachmentDraft', { recordId: task.recordId, scopeId: task.scopeId, revision: task.revision, attachments: [] });
  await invoke('addAttachmentPhoto', { draftId: draft.draftId, mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=' });
  await dialog.getByLabel('Caption for photo 1').fill('Native caption kept after Back');
  await dialog.getByRole('heading').click(); await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  try { await expect(dialog).toHaveCount(0, { timeout: 1500 }); } catch { await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); }
  await expect(dialog).toHaveCount(0);
  await card.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  await expect(dialog.getByLabel('Caption for photo 1')).toHaveValue('Native caption kept after Back');
  await dialog.getByRole('button', { name: 'Save photos', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(card.locator('img')).toHaveCount(1);
  await expect.poll(() => card.locator('img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  // A second profile has no captured original: its preview must use the shared task descriptor.
  await invoke('login', { username: 'sam', password: '' }); await page.reload();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  await expect.poll(() => card.locator('img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  await card.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  await dialog.getByLabel('Caption for photo 1').fill('Partner annotated the shared label');
  await dialog.getByRole('button', { name: 'Save photos', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card.locator('figcaption')).toHaveText('Native caption kept after Back');
  await card.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.history-list img').first()).toBeVisible();
  await expect.poll(() => page.locator('.history-list img').first().evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/android-attachments-verified.png', fullPage: true });
  console.log('PASS: native attachment draft, durable caption, Back priority, save, partner photo download, per-user undo and history images.');
} finally { await browser.close(); }
