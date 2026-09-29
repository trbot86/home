// Only the disposable fixture and project-owned emulator are permitted.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const adb = (...args) =>
  exec(
    resolve('.tools/android-sdk/platform-tools/adb.exe'),
    ['-H', '127.0.0.1', '-P', '5041', '-s', '127.0.0.1:5581', ...args],
    { windowsHide: true },
  );
if ((await adb('shell', 'getprop', 'ro.boot.qemu.avd_name')).stdout.trim() !== 'OurPlaceTest')
  throw new Error('Refusing non-test device');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
try {
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  const invoke = (method, args = {}) =>
    page.evaluate(
      async ({ method, args }) => (await window.Capacitor.Plugins.Household.invoke({ method, args })).value,
      { method, args },
    );
  if ((await invoke('endpoint')) !== 'http://10.0.2.2:4173') throw new Error('Refusing non-test household');
  const back = () => adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  if (process.argv.includes('--verify-update')) {
    const before = JSON.parse(await readFile('.local/home-native-before.json', 'utf8'));
    const after = await invoke('state');
    assert.deepEqual(after.session, before.session);
    assert.deepEqual(
      after.drafts.find((d) => d.draftId === before.draft.draftId),
      before.draft,
    );
    assert.deepEqual(await invoke('readEditor', { recordId: 'task:new' }), before.editor);
    await invoke('submitDraft', { draftId: before.draft.draftId });
    await invoke('sync');
    const saved = (await invoke('state')).entries.find((e) => e.inboxId === before.draft.draftId);
    assert.equal(saved.text, before.draft.text);
    assert.deepEqual(saved.attachments, before.draft.attachments);
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await expect(page.getByLabel('Task title', { exact: true })).toHaveValue(
      'Native task drafted before Home',
    );
    await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
      'Do not lose the old unfinished form.',
    );
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    console.log(
      'PASS: installed update preserved native session, photo capture and old task form; both saved successfully.',
    );
  }
  await page.reload();
  await page.getByRole('button', { name: 'Maintenance', exact: true }).click();
  await page.getByRole('button', { name: 'Add asset', exact: true }).click();
  const title = `Native heat pump ${Date.now()}`;
  await page.getByLabel('Asset name', { exact: true }).fill(title);
  await page.getByLabel('Asset notes').fill('Keep this unfinished asset note.');
  await page.getByRole('dialog').getByRole('heading').click();
  await back();
  try {
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 1500 });
  } catch {
    await back();
  }
  await page.reload();
  await page.getByRole('button', { name: 'Maintenance', exact: true }).click();
  await page.getByRole('button', { name: 'Add asset', exact: true }).click();
  await expect(page.getByLabel('Asset notes')).toHaveValue('Keep this unfinished asset note.');
  await page.getByRole('dialog').getByRole('button', { name: 'Add asset', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add maintenance task', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Rinse the native filter');
  await page.getByLabel('Repeat after completion').selectOption('months');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const task = page.locator('.home-maintenance-task').filter({ hasText: 'Rinse the native filter' });
  await task.getByRole('button', { name: 'Record completion', exact: true }).click();
  await page.getByLabel('Actually completed at', { exact: true }).fill('2026-08-31T12:00');
  await page.getByLabel('Done by', { exact: true }).selectOption({ label: 'Sam' });
  await page.getByLabel('Completion note').fill('Washed and dried the native filter.');
  await page.getByRole('dialog').getByRole('button', { name: 'Record completion', exact: true }).click();
  const service = page
    .locator('.home-service-card')
    .filter({ hasText: 'Washed and dried the native filter.' });
  await expect(service).toContainText('Task completed by Sam');
  await expect(task).toContainText('Target Sep 30, 2026');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(service).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(service).toHaveCount(1);
  await service.getByRole('button', { name: 'Photos & receipts', exact: true }).click();
  const homeState = (await invoke('state')).home;
  const asset = homeState.assets.find((a) => a.name === title);
  const record = homeState.serviceRecords.find((s) => s.assetId === asset.recordId && !s.deletedAt);
  const draft = await invoke('openAttachmentDraft', {
    recordId: record.recordId,
    scopeId: record.scopeId,
    revision: record.revision,
    attachments: [],
  });
  await invoke('addAttachmentPhoto', {
    draftId: draft.draftId,
    mimeType: 'image/png',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  });
  await page.getByLabel('Caption for photo 1').fill('Native service receipt');
  await page.getByRole('button', { name: 'Save photos', exact: true }).click();
  await expect.poll(() => service.locator('img').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  await invoke('login', { username: 'sam', password: '' });
  await page.reload();
  await page.getByRole('button', { name: 'Maintenance', exact: true }).click();
  await page.locator('.home-asset-card').filter({ hasText: title }).click();
  await expect.poll(() => service.locator('img').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  await service.getByRole('button', { name: 'Service history', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('.history-list img')
        .first()
        .evaluate((img) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await back();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const cached = (await invoke('state')).home;
  await page.reload();
  await page.getByRole('button', { name: 'Maintenance', exact: true }).click();
  assert.deepEqual((await invoke('state')).home, cached);
  await page.locator('.home-asset-card').filter({ hasText: title }).click();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Native horizontal overflow');
  await page.locator('.home-detail-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/android-home-verified.png' });
  console.log(
    'PASS: native Home draft recovery, Back, linked completion/recurrence, undo/redo, partner photo download, history images and Room cache.',
  );
} finally {
  await browser.close();
}
