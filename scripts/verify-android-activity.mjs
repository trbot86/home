// Dedicated emulator and disposable synthetic server only. Never targets the live household.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { seedActivity } from '../tests/fixtures/activity.ts';

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
  const initial = await invoke('state'),
    session = initial.session;
  const sam = initial.tasks.people.find((p) => p.displayName === 'Sam').personId;
  const records = await seedActivity(
    async (kind, args) => {
      const result = await invoke('command', {
        recordId: args.recordId,
        kind,
        arguments: args,
        expectedServerEpoch: session.serverEpoch,
      });
      assert.equal(result.status, 'Applied', kind);
    },
    session,
    sam,
    'Native activity',
  );
  const completion = (await invoke('state')).tasks.completions.find(
    (c) => c.recordId === records.maintenance.completionId,
  );
  const draft = await invoke('openAttachmentDraft', {
    recordId: completion.recordId,
    scopeId: completion.scopeId,
    revision: completion.revision,
    attachments: completion.attachments,
  });
  const withPhoto = await invoke('addAttachmentPhoto', {
    draftId: draft.draftId,
    mimeType: 'image/png',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  });
  await invoke('saveAttachmentDraft', {
    draftId: draft.draftId,
    revision: withPhoto.revision,
    attachments: withPhoto.attachments.map((photo) => ({ ...photo, caption: 'Filter reference photo' })),
  });
  const saved = await invoke('submitAttachmentDraft', { draftId: draft.draftId });
  assert.equal(saved.status, 'Applied');
  await page.reload();
  const feed = async () => {
    await page.getByRole('button', { name: 'Recently done', exact: true }).click();
    await page.getByLabel('Search activity').fill('Native activity');
    await page.locator('main').click({ position: { x: 1, y: 1 } });
  };
  const cards = page.locator('.activity-card');
  const maintenance = cards.filter({
    has: page.getByRole('heading', { name: 'Native activity Replace filter', exact: true }),
  });
  await feed();
  await expect(cards).toHaveCount(6);
  await expect(maintenance).toContainText('Maintenance · Sam');
  await page.getByLabel('Activity person').selectOption(sam);
  await expect(cards).toHaveCount(3);
  await page.getByLabel('Activity context').selectOption('work');
  await expect(cards).toHaveCount(1);
  await page.getByLabel('Activity person').selectOption('everyone');
  await page.getByLabel('Activity context').selectOption('both');
  await page.getByLabel('Activity visibility').selectOption('private');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('Surprise weekend');
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await feed();
  await expect(page.getByLabel('Activity visibility')).toHaveValue('shared');
  await page.getByLabel('Activity visibility').selectOption('all');
  await expect(cards).toHaveCount(6);
  await expect(page.locator('body')).not.toContainText('Secret present');
  await expect(page.locator('body')).not.toContainText('Surprise weekend');
  await expect(maintenance.locator('img')).toHaveCount(0);
  await maintenance.locator('summary').click();
  await expect(maintenance).toContainText('Native activity Recorded after the work happened');
  await expect
    .poll(() => maintenance.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await maintenance
    .getByRole('button', { name: 'View photo 1: Filter reference photo', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Photo', exact: true })).toBeVisible();
  await adb('shell', 'input', 'keyevent', '4');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByLabel('What’s on your mind?').fill('Keep this unfinished capture beside the activity feed');
  await expect(page.getByText('Draft saved on this device', { exact: true })).toBeVisible();
  const cached = await invoke('state');
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
  await feed();
  await expect(page.getByText('Showing downloaded activity.', { exact: false })).toBeVisible();
  await expect(cards).toHaveCount(6);
  await maintenance.locator('summary').click();
  await expect(maintenance).toContainText('Native activity Recorded after the work happened');
  await expect
    .poll(() => maintenance.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await expect(maintenance).toContainText('Filter reference photo');
  await expect(maintenance.getByRole('button', { name: 'Open history' })).toBeDisabled();
  assert.equal(await page.locator('.activity').evaluate((el) => el.scrollWidth > el.clientWidth), false);
  await maintenance.scrollIntoViewIfNeeded();
  // WebView full-page screenshots can repeat the viewport; capture the visible card.
  await page.screenshot({ path: 'test-results/android-activity-offline.png' });
  await adb('shell', 'input', 'keyevent', '4');
  // The IME may consume the first Back; the next returns to Inbox.
  if (await page.locator('.activity').count()) await adb('shell', 'input', 'keyevent', '4');
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue(
    'Keep this unfinished capture beside the activity feed',
  );
  const offline = await invoke('state');
  for (const key of ['tasks', 'shopping', 'home', 'recipes'])
    assert.deepEqual(offline[key], cached[key], key);
  console.log(
    'PASS: native activity deduplicates work, filters attribution, hides private gifts on profile switch, reads downloaded photos offline, and retains drafts through Android Back.',
  );
} finally {
  await browser.close();
}
