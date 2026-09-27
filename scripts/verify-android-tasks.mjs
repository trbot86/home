// Run only with the project-owned emulator and scripts/browser-fixture.ts.
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
try {
  const page = browser.contexts()[0].pages()[0];
  const invoke = (method, args = {}) => page.evaluate(async ({ method, args }) =>
    (await window.Capacitor.Plugins.Household.invoke({ method, args })).value, { method, args });
  if ((await invoke('endpoint')) !== 'http://10.0.2.2:4173') throw new Error('Refusing a non-test household');
  const back = () => exec(resolve('.tools/android-sdk/platform-tools/adb.exe'),
    ['-H', '127.0.0.1', '-P', '5041', '-s', 'emulator-5580', 'shell', 'input', 'keyevent', 'KEYCODE_BACK'],
    { windowsHide: true });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const title = `Native filter change ${Date.now()}`;
  await dialog.getByLabel('Task title', { exact: true }).fill(title);
  await dialog.getByLabel('Instructions', { exact: true }).fill('Check the filter size');
  await dialog.getByLabel('Flexible target', { exact: true }).fill('2026-08-01');
  await dialog.getByLabel('Actual deadline (optional)', { exact: true }).fill('2026-08-15');
  await dialog.getByLabel('Repeat after completion', { exact: true }).selectOption('months');
  await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const card = page.locator('.task-card').filter({ hasText: title });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByLabel('Instructions', { exact: true }).fill('Check the filter size; saved native draft');
  await dialog.getByRole('heading').click();
  await back();
  try { await expect(dialog).toHaveCount(0, { timeout: 1500 }); } catch { await back(); }
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toHaveAttribute('aria-current', 'page');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(dialog.getByLabel('Instructions', { exact: true })).toHaveValue('Check the filter size; saved native draft');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await card.getByRole('button', { name: 'Done earlier…', exact: true }).click();
  await dialog.getByLabel('Actually completed at', { exact: true }).fill('2026-08-31T12:00');
  await dialog.getByLabel('Done by', { exact: true }).selectOption({ label: 'Sam' });
  await dialog.getByLabel('Completion note', { exact: true }).fill('Used the spare');
  await dialog.getByRole('button', { name: 'Record completion', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText('Target · Sep 30, 2026');
  await expect(card).toContainText('by Sam');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card.locator('.task-late')).toContainText('Aug 15, 2026');
  await card.getByRole('button', { name: 'History', exact: true }).click();
  await expect(dialog.locator('.historical-text').first()).toContainText('saved native draft');
  await back();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toHaveAttribute('aria-current', 'page');
  const state = await invoke('state');
  const task = state.tasks.definitions.find(item => item.title === title);
  if (!task || !state.tasks.occurrences.some(item => item.taskId === task.recordId && !item.deletedAt && item.state === 'open'))
    throw new Error('Native Tasks cache missing restored occurrence');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Native horizontal overflow');
  await page.screenshot({ path: 'test-results/android-tasks-verified.png', fullPage: true });
  console.log('PASS: native task creation, date inputs, actual completion/recurrence, performer, undo, history, durable draft, Back priority and Room cache.');
} finally { await browser.close(); }
