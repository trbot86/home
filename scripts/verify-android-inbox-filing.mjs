// Mutations are confined to the named disposable emulator and synthetic server fixture.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const adb = (...args) =>
  exec(
    resolve('.tools/android-sdk/platform-tools/adb.exe'),
    ['-H', '127.0.0.1', '-P', '5041', '-s', '127.0.0.1:5581', ...args],
    { windowsHide: true },
  );
assert.equal((await adb('shell', 'getprop', 'ro.boot.qemu.avd_name')).stdout.trim(), 'OurPlaceTest');
assert.ok(process.env.OUR_PLACE_TEST_TOKEN, 'Fixture shutdown token required');
const origin = 'http://127.0.0.1:4173';
assert.equal((await (await fetch(origin + '/health')).json()).development, true);
assert.deepEqual(
  (await (await fetch(origin + '/api/auth/options')).json()).profiles.map((p) => p.displayName).sort(),
  ['Alex', 'Sam'],
);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
try {
  const page = browser.contexts()[0].pages()[0];
  const invoke = (method, args = {}) =>
    page.evaluate(
      async ({ method, args }) => (await window.Capacitor.Plugins.Household.invoke({ method, args })).value,
      { method, args },
    );
  assert.equal((await invoke('state')).session, null, 'Use a fresh disposable emulator profile');
  await invoke('configure', { url: 'http://10.0.2.2:4173' });
  await invoke('login', { username: 'alex', password: '' });
  const session = (await invoke('state')).session;
  const draft = await invoke('createDraft', {
    scopeId: session.scopes.find((s) => s.kind === 'shared').scopeId,
  });
  const text = 'Native filing capture\nCheck the size in the photograph.';
  await invoke('saveDraft', { draftId: draft.draftId, scopeId: draft.scopeId, text });
  await invoke('addPhoto', {
    draftId: draft.draftId,
    mimeType: 'image/png',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  });
  await invoke('submitDraft', { draftId: draft.draftId });
  await page.reload();
  const card = page.locator('.entry-card').filter({ hasText: 'Native filing capture' });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'To task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'File this note', exact: true });
  await dialog.getByLabel('Title', { exact: true }).fill('Native filter task');
  await adb('shell', 'input', 'keyevent', '4');
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await card.getByRole('button', { name: 'To task', exact: true }).click();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Native filter task');
  assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth), false);
  await dialog.getByRole('button', { name: 'File note', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Filed', exact: true }).click();
  await card.getByRole('button', { name: 'Task: Native filter task', exact: true }).click();
  await expect(page.locator('.task-card')).toHaveCount(1);
  await page.getByRole('button', { name: /Original note & photos: Native filing capture/ }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(text);
  await expect(page.getByRole('dialog').locator('img')).toHaveCount(1);
  await adb('shell', 'input', 'keyevent', '4');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const native = await invoke('state');
  const note = native.entries.find((e) => e.text === text),
    task = native.tasks.definitions.find((t) => t.title === 'Native filter task');
  assert.ok(note.filedAt);
  assert.equal(note.destinations[0].recordId, task.recordId);
  const login = await fetch(origin + '/api/auth/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alex', clientKind: 'browser' }),
  });
  assert.equal(login.status, 200);
  const headers = {
    origin,
    cookie: login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  };
  try {
    const remote = await (await fetch(origin + '/api/cache/inbox', { headers })).json();
    assert.deepEqual(
      remote.entries.find((e) => e.inboxId === note.inboxId),
      note,
    );
    assert.deepEqual(
      remote.tasks.definitions.find((t) => t.recordId === task.recordId),
      task,
    );
  } finally {
    assert.equal((await fetch(origin + '/api/auth/logout', { method: 'POST', headers })).status, 200);
  }
  assert.equal(
    (
      await fetch('http://127.0.0.1:4174/stop', {
        method: 'POST',
        headers: { 'x-test-token': process.env.OUR_PLACE_TEST_TOKEN },
      })
    ).status,
    200,
  );
  await invoke('refresh').catch(() => {});
  await page.reload();
  await page.getByRole('button', { name: 'Filed', exact: true }).click();
  await card.getByRole('button', { name: 'Task: Native filter task', exact: true }).click();
  await page.getByRole('button', { name: /Original note & photos: Native filing capture/ }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(text);
  await expect
    .poll(() =>
      page
        .getByRole('dialog')
        .locator('img')
        .evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  await adb('shell', 'input', 'keyevent', '4');
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await card.getByRole('button', { name: 'To task', exact: true }).click();
  await dialog.getByLabel('Title', { exact: true }).fill('Keep this offline filing draft');
  await expect(dialog.getByRole('button', { name: 'File note', exact: true })).toBeDisabled();
  await adb('shell', 'input', 'keyevent', '4');
  await page.reload();
  await page.getByRole('button', { name: 'Filed', exact: true }).click();
  await card.getByRole('button', { name: 'To task', exact: true }).click();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Keep this offline filing draft');
  assert.deepEqual((await invoke('state')).entries, native.entries);
  assert.deepEqual((await invoke('state')).tasks, native.tasks);
  await page.screenshot({ path: 'test-results/android-inbox-filing-offline.png' });
  console.log(
    'PASS: native filing syncs once to the browser, retains original photos, and preserves its Room snapshot and filing drafts through Back, reload and server shutdown.',
  );
} finally {
  await browser.close();
}
