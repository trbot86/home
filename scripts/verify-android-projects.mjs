// Writes only to the disposable OurPlaceTest emulator and the isolated browser fixture.
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
assert.equal((await adb('shell', 'getprop', 'ro.boot.qemu.avd_name')).stdout.trim(), 'OurPlaceTest');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
try {
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  const invoke = (method, args = {}) =>
    page.evaluate(
      async ({ method, args }) => (await window.Capacitor.Plugins.Household.invoke({ method, args })).value,
      { method, args },
    );
  if (process.argv.includes('--configure')) {
    assert.equal((await invoke('state')).session, null, 'Configuration requires a fresh test profile');
    await invoke('configure', { url: 'http://10.0.2.2:4173' });
  }
  assert.equal(await invoke('endpoint'), 'http://10.0.2.2:4173', 'Refusing a non-test household');
  if (!(await invoke('state')).session) await invoke('login', { username: 'alex', password: '' });
  await page.reload();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const title = `Native kitchen ${Date.now()}`;
  const pageTitle = `Cabinet ideas ${Date.now()}`;
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Description', { exact: true }).fill('Measurements and inspiration.');
  await page.getByLabel('Description', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const child = async (name) => {
    await page.getByRole('button', { name: '+ New page', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill(name);
    await page.getByRole('button', { name: '+ Text', exact: true }).click();
    await page.getByLabel('Text', { exact: true }).fill('Keep this measurement: 80 cm.');
    await page.getByLabel('Text', { exact: true }).press('Control+Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.project-board-heading')).toContainText(name);
  };
  const back = async () => {
    await page.locator('.project-board-heading').click();
    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  };
  await child(pageTitle);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: '+ Web link', exact: true }).click();
  await page.getByLabel('Web address', { exact: true }).fill('https://');
  await page.getByRole('dialog').getByRole('heading').click();
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  try {
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 1500 });
  } catch {
    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).click();
  await page.locator('.project-page-card').filter({ hasText: pageTitle }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Web address', { exact: true })).toHaveValue('https://');
  await page.getByLabel('Web address', { exact: true }).fill('https://example.com/cabinet');
  await page.getByLabel('Link title', { exact: true }).fill('Cabinet inspiration');
  await page.getByLabel('Link title', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Photos', exact: true }).click();
  const record = (await invoke('state')).projects.pages.find((p) => p.title === pageTitle);
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
  await page.getByLabel('Caption for photo 1').fill('Door hinge');
  await page.getByRole('button', { name: 'Save photos', exact: true }).click();
  await expect
    .poll(() => page.locator('.project-block-attachment img').evaluate((img) => img.naturalWidth))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Move block 3 up', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.project-block').nth(1)).toHaveClass(/attachment/);
  await child('Hardware sizes');
  await back();
  await expect(page.locator('.project-board-heading')).toContainText(pageTitle);
  await back();
  await expect(page.locator('.project-board-heading')).toContainText(title);
  await page.getByRole('button', { name: 'Pin something', exact: true }).click();
  await page.getByLabel('Find something to pin', { exact: true }).fill(pageTitle);
  await page.locator('.project-picker').getByRole('button').filter({ hasText: pageTitle }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.project-next li')).toHaveCount(1);
  await page.locator('.project-next .project-reference button').click();
  await expect(page.locator('.project-board-heading')).toContainText(pageTitle);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Keep this measurement: 80 cm.');
  await expect
    .poll(() =>
      page
        .locator('.history-list img')
        .first()
        .evaluate((img) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-results/android-projects-verified.png' });
  const before = await invoke('state');
  const token = (await readFile('.local/projects-fixture-token.txt', 'utf8')).trim();
  const stopped = await fetch('http://127.0.0.1:4174/stop', {
    method: 'POST',
    headers: { 'x-test-token': token },
  });
  assert.equal(stopped.status, 200);
  await assert.rejects(invoke('refresh'));
  await page.reload();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).click();
  await page.locator('.project-next .project-reference button').click();
  await expect(page.locator('.project-content')).toContainText('Keep this measurement: 80 cm.');
  await expect
    .poll(() => page.locator('.project-block-attachment img').evaluate((img) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
  const after = await invoke('state');
  for (const field of ['session', 'projects', 'views']) assert.deepEqual(after[field], before[field], field);
  const scopeId = after.session.scopes.find((s) => s.kind === 'shared').scopeId;
  const capture = await invoke('createDraft', { scopeId });
  await invoke('saveDraft', {
    draftId: capture.draftId,
    scopeId,
    text: 'Offline capture alongside cached project pages',
  });
  await invoke('submitDraft', { draftId: capture.draftId });
  await page.reload();
  assert.equal(
    (await invoke('state')).drafts.find((d) => d.draftId === capture.draftId).text,
    'Offline capture alongside cached project pages',
  );
  console.log(
    'PASS: native Projects forms, partial-link recovery, Back through nested pages, photos, block order, pins, history, offline Room/photo cache and offline inbox queue.',
  );
} finally {
  await browser.close();
}
