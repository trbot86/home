// Disposable fixture and OurPlaceTest emulator only. Preserving upgrade is checked separately before reset.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile),
  adb = (...args) =>
    exec(
      resolve('.tools/android-sdk/platform-tools/adb.exe'),
      ['-H', '127.0.0.1', '-P', '5041', '-s', '127.0.0.1:5581', ...args],
      { windowsHide: true },
    );
assert.equal((await adb('shell', 'getprop', 'ro.boot.qemu.avd_name')).stdout.trim(), 'OurPlaceTest');
assert.ok(process.env.OUR_PLACE_TEST_TOKEN);
const origin = 'http://127.0.0.1:4173',
  control = async (action) => {
    assert.equal(
      (
        await fetch('http://127.0.0.1:4174/' + action, {
          method: 'POST',
          headers: { 'x-test-token': process.env.OUR_PLACE_TEST_TOKEN },
        })
      ).status,
      200,
    );
  };
assert.equal((await (await fetch(origin + '/health')).json()).development, true);
let browser, page;
async function connect() {
  await expect
    .poll(async () => {
      const pid = (
        await adb('shell', 'pidof', 'dev.ourplace.household').catch(() => ({ stdout: '' }))
      ).stdout.trim();
      if (!/^\d+$/.test(pid)) return false;
      await adb('forward', 'tcp:9223', 'localabstract:webview_devtools_remote_' + pid);
      try {
        browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
        page = browser.contexts()[0].pages()[0];
        return !!page;
      } catch {
        return false;
      }
    })
    .toBe(true);
  await page.waitForFunction(() => !!window.Capacitor?.Plugins?.Household);
}
const invoke = (method, args = {}) =>
  page.evaluate(
    async ({ method, args }) => (await window.Capacitor.Plugins.Household.invoke({ method, args })).value,
    { method, args },
  );
try {
  await connect();
  assert.equal(
    (await invoke('state')).session,
    null,
    'Use only a fresh disposable app after preserving-update verification',
  );
  await invoke('configure', { url: 'http://10.0.2.2:4173' });
  await page.reload();
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  const title = 'Native suggestion discussion ' + Date.now();
  await page.getByLabel('Suggest an improvement').fill(title);
  await page.getByRole('button', { name: 'Save suggestion', exact: true }).click();
  const card = () => page.locator('.entry-card').filter({ hasText: title });
  await expect(card()).toHaveCount(1);
  await card().locator('.entry-text').click();
  await control('offline');
  await invoke('refresh').catch(() => {});
  await page.getByLabel('Add a follow-up').fill('Keep this offline reply and its picture');
  const draft = (await invoke('state')).drafts.find((d) => d.replyTarget && d.state === 'DRAFT');
  assert.ok(draft);
  await invoke('addPhoto', {
    draftId: draft.draftId,
    mimeType: 'image/png',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  });
  await page.getByRole('button', { name: 'Reply & continue work', exact: true }).click();
  await expect(page.getByText('Waiting to upload', { exact: true })).toBeVisible();
  const frozen = (await invoke('state')).drafts.find((d) => d.draftId === draft.draftId);
  assert.equal(frozen.state, 'SUBMITTED');
  await browser.close();
  browser = null;
  await adb('shell', 'am', 'force-stop', 'dev.ourplace.household');
  await adb('shell', 'am', 'start', '-n', 'dev.ourplace.household/.MainActivity');
  await connect();
  const reopened = (await invoke('state')).drafts.find((d) => d.draftId === draft.draftId);
  assert.equal(reopened.frozenJson, frozen.frozenJson);
  assert.equal(reopened.frozenHash, frozen.frozenHash);
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await card().locator('.entry-text').click();
  await expect(page.getByText('Waiting to upload', { exact: true })).toBeVisible();
  await control('online');
  await invoke('sync');
  await expect(
    page
      .locator('.suggestion-timeline')
      .getByText('Keep this offline reply and its picture', { exact: true }),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      page.locator('.suggestion-timeline img').evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  const synced = await invoke('state'),
    message = synced.suggestions.messages.find((m) => m.recordId === draft.draftId);
  assert.equal(message.attachments.length, 1);
  assert.equal(synced.suggestions.work.filter((w) => w.requestId === draft.draftId).length, 1);
  const login = await fetch(origin + '/api/auth/login', {
    method: 'POST',
    headers: { origin: 'http://10.0.2.2:4173', 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'sam', clientKind: 'android' }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const headers = { authorization: 'Bearer ' + session.credential };
  const shared = await (await fetch(origin + '/api/cache/inbox', { headers })).json();
  assert.deepEqual(
    shared.suggestions.messages.find((m) => m.recordId === draft.draftId),
    message,
  );
  assert.equal(shared.entries.filter((e) => e.inboxId === draft.draftId).length, 0);
  await fetch(origin + '/api/auth/logout', { method: 'POST', headers });
  await page.locator('.suggestion-timeline').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/android-suggestion-discussion.png' });
  assert.equal(await page.getByRole('dialog').evaluate((el) => el.scrollWidth > el.clientWidth), false);
  await adb('shell', 'input', 'keyevent', '4');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  console.log(
    'PASS: native offline reply and photo survive process termination, upload once, appear for the other profile, and stay separate from inbox captures.',
  );
} finally {
  if (browser) await browser.close();
  await control('online');
}
