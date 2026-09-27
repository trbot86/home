// Dedicated emulator and disposable synthetic server only. Sends real Android launch intents.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const adb = (...args) =>
  exec(
    resolve('.tools/android-sdk/platform-tools/adb.exe'),
    ['-H', '127.0.0.1', '-P', '5041', '-s', '127.0.0.1:5581', ...args],
    { windowsHide: true },
  );
assert.equal((await adb('shell', 'getprop', 'ro.boot.qemu.avd_name')).stdout.trim(), 'OurPlaceTest');
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
  await page.reload();
  const session = (await invoke('state')).session;
  const shared = session.scopes.find((s) => s.kind === 'shared').scopeId;
  const privateScope = session.scopes.find((s) => s.kind === 'private').scopeId;
  const taskId = crypto.randomUUID(),
    occurrenceId = crypto.randomUUID();
  const create = async (
    title,
    scopeId,
    context,
    recordId = crypto.randomUUID(),
    occurrence = crypto.randomUUID(),
  ) => {
    const result = await invoke('command', {
      recordId,
      kind: 'CreateTask',
      expectedServerEpoch: session.serverEpoch,
      arguments: {
        recordId,
        occurrenceId: occurrence,
        scopeId,
        title,
        instructions: 'Synthetic widget fixture',
        context,
        defaultAssigneeId: null,
        defaultPriority: 3,
        recurrence: null,
        assigneeId: null,
        priority: 3,
        deadlineDate: '2099-12-31',
        targetDate: '2026-01-01',
        reviewDate: null,
      },
    });
    assert.equal(result.status, 'Applied');
  };
  await create('Widget household task', shared, 'home', taskId, occurrenceId);
  await create('Private widget gift', privateScope, 'home');
  await create('Widget work priority', shared, 'work');
  await page.getByLabel('What’s on your mind?').fill('Keep this capture while using widget actions');
  await expect(page.getByText('Draft saved on this device', { exact: true })).toBeVisible();
  const launch = async (action, owner = session.clientId, epoch = session.serverEpoch) => {
    await adb(
      'shell',
      'am',
      'start',
      '-n',
      'dev.ourplace.household/.MainActivity',
      '-a',
      'dev.ourplace.household.OPEN_TASK_WIDGET',
      '--es',
      'clientId',
      owner,
      '--es',
      'serverEpoch',
      epoch,
      '--es',
      'recordId',
      occurrenceId,
      '--es',
      'taskAction',
      action,
    );
  };
  await launch('postpone');
  const card = page.locator('.task-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Widget household task');
  await expect(card.locator('.task-postpone')).toHaveAttribute('open', '');
  await card.getByRole('button', { name: '+1 week', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await invoke('state')).tasks.occurrences.find((o) => o.recordId === occurrenceId).targetDate,
    )
    .not.toBe('2026-01-01');
  assert.equal(
    (await invoke('state')).tasks.occurrences.find((o) => o.recordId === occurrenceId).deadlineDate,
    '2099-12-31',
  );
  await launch('complete');
  const completion = page.getByRole('dialog', { name: 'Record completion', exact: true });
  await expect(completion).toBeVisible();
  await completion.getByLabel('Completion note', { exact: true }).fill('Completed from widget shortcut');
  await adb('shell', 'input', 'keyevent', '4');
  // Android gives the keyboard first refusal on Back when a text field is focused.
  if (await completion.isVisible()) await adb('shell', 'input', 'keyevent', '4');
  await expect(completion).toHaveCount(0);
  await launch('complete');
  await expect(completion.getByLabel('Completion note', { exact: true })).toHaveValue(
    'Completed from widget shortcut',
  );
  await completion.getByLabel('Completion note', { exact: true }).press('Control+Enter');
  await expect(completion).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await invoke('state')).tasks.completions.filter(
          (c) => c.occurrenceId === occurrenceId && c.deletedAt === null,
        ).length,
    )
    .toBe(1);
  await launch('complete');
  await expect(page.getByText('This task occurrence is no longer open.', { exact: false })).toBeVisible();
  assert.equal(
    (await invoke('state')).tasks.completions.filter((c) => c.occurrenceId === occurrenceId).length,
    1,
  );
  await launch('show', session.clientId, 'previous-epoch');
  await expect(
    page.getByText('The server was restored. Check recovery in the app, then set up this widget again.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue(
    'Keep this capture while using widget actions',
  );
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await expect.poll(async () => (await invoke('state')).session.person.displayName).toBe('Sam');
  await launch('show');
  await expect(page.getByText('This widget belongs to another profile.', { exact: false })).toBeVisible();
  assert.equal(
    (await invoke('state')).tasks.definitions.some((t) => t.title === 'Private widget gift'),
    false,
  );
  await page.getByLabel('Current profile').selectOption({ label: 'Alex' });
  await expect.poll(async () => (await invoke('state')).session.person.displayName).toBe('Alex');
  await create('Another widget household priority', shared, 'home');
  // Keep the fixture available for actual launcher binding, resize and offline widget checks.
  await writeFile(
    '.local/task-widget-native-fixture.json',
    JSON.stringify({ session, origin, taskId, occurrenceId }, null, 2),
  );
  console.log(
    'PASS: actual Android widget intents open completion/date controls, retain unfinished capture/completion text, preserve true deadlines and reject stale occurrences, recovery epochs and other profiles. Fixture remains running for launcher checks.',
  );
} finally {
  await browser.close();
}
