import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { addCalendarDate, calendarDateAt } from '../../packages/contracts/src/index.js';

test('iCal setup works without OAuth configuration and clears the secret after submission', async ({
  page,
}) => {
  await page.route('**/api/calendars/settings', (route) =>
    route.fulfill({ json: { configured: false, icalAvailable: true, connections: [] } }),
  );
  let submitted: unknown;
  await page.route('**/api/calendars/ical', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { connectionId: randomUUID() } });
  });
  await page.goto('/?settings=calendars');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  const form = page.locator('.calendar-ical');
  await expect(form.getByRole('button', { name: 'Add iCal calendar' })).toBeDisabled();
  await form.getByLabel('Calendar label', { exact: true }).fill('Personal feed');
  const secret = 'https://calendar.google.com/calendar/ical/fixture%40example.com/private-fixture/basic.ics';
  await form.getByLabel('Secret iCal link').fill(secret);
  await form.getByRole('button', { name: 'Add iCal calendar' }).click();
  await expect(form.getByLabel('Secret iCal link')).toHaveValue('');
  expect(submitted).toEqual({ label: 'Personal feed', url: secret });
  await expect(
    page.getByText('Calendar added. Choose its visibility below to show events in your agenda.'),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

async function consent(page: Page) {
  const appOrigin = new URL(page.url()).origin,
    code = randomUUID();
  await page.route('https://accounts.google.com/o/oauth2/v2/auth?**', async (route) => {
    const state = new URL(route.request().url()).searchParams.get('state')!;
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><h1>Simulated Google consent</h1>
      <form action="${appOrigin}/oauth/calendar/callback" method="get"><input type="hidden" name="state" value="${state}"><input type="hidden" name="code" value="${code}"><button>Allow calendar access</button></form></body></html>`,
    });
  });
  await page.getByRole('button', { name: 'Connect Google account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Simulated Google consent' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow calendar access' }).click();
  await expect(page.getByRole('button', { name: 'Finish connecting', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has('code')).toBe(false);
  expect(new URL(page.url()).searchParams.has('state')).toBe(false);
}

test('agenda combines personal tasks and real scheduled fixture refresh, isolates private details and preserves offline data', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const title = `Agenda priority ${randomUUID()}`;
  await page.getByLabel('Task title', { exact: true }).fill(title);
  await page
    .getByLabel('Actual deadline (optional)', { exact: true })
    .fill(addCalendarDate(calendarDateAt(Date.now(), 'America/Toronto'), -1, 'days'));
  await page.getByLabel('Instructions', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const label = `Agenda fixture ${randomUUID()}`;
  await page.getByLabel('Account label', { exact: true }).fill(label);
  await consent(page);
  await page.getByRole('button', { name: 'Finish connecting', exact: true }).click();
  const connection = page.locator('.calendar-connection').filter({ hasText: label });
  const visibility = connection.getByLabel('Visibility for Personal calendar', { exact: true });
  await visibility.selectOption('shared_home');
  await expect(visibility).toHaveValue('shared_home');
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect
    .poll(
      async () => {
        await page.getByLabel('Refresh and sync', { exact: true }).click();
        return page.getByRole('heading', { name: 'Household appointment', exact: true }).count();
      },
      { timeout: 20000 },
    )
    .toBe(1);
  await expect(page.getByRole('heading', { name: 'Private calendar detail', exact: true })).toBeVisible();
  const event = page.locator('.agenda-event').filter({ hasText: 'Household appointment' });
  const details = event.getByRole('button', { name: 'Details for Household appointment', exact: true });
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await expect(event.locator('.agenda-description')).toHaveCount(0);
  await details.click();
  await expect(event.locator('.agenda-description b')).toHaveText('Synthetic details');
  await expect(event.getByRole('link', { name: 'Join meeting' })).toHaveAttribute('href', 'https://example.com/meeting');
  await expect(event.locator('.agenda-description script, .agenda-description img, a[href^="javascript:"]')).toHaveCount(0);
  await expect(event.getByRole('link', { name: 'Unsafe link' })).toHaveCount(0);
  await details.click();
  await expect(event.locator('.agenda-description')).toHaveCount(0);
  const task = page.locator('.agenda-task').filter({ hasText: title });
  await expect(task).toContainText('Past deadline');
  await task.click();
  await expect(page.locator('.task-card').filter({ hasText: title })).toBeVisible();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390 || width === 1440)
      await page.screenshot({ path: `.cache/calendar-agenda-${width}.png`, fullPage: true });
  }
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Household appointment', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Private calendar detail', exact: true })).toHaveCount(0);
  await page.getByLabel('Current profile').selectOption({ label: 'Alex' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await visibility.selectOption('private_work');
  await expect(visibility).toHaveValue('private_work');
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect
    .poll(
      async () => {
        await page.getByLabel('Refresh and sync', { exact: true }).click();
        return page.getByRole('heading', { name: 'Household appointment', exact: true }).count();
      },
      { timeout: 20000 },
    )
    .toBe(1);
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('home');
  await expect(page.getByRole('heading', { name: 'Household appointment', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('work');
  await expect(page.getByRole('heading', { name: 'Household appointment', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private calendar detail', exact: true })).toBeVisible();
  await expect(page.locator('.agenda')).toContainText('Offline · showing the last download');
  await context.setOffline(false);
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Household appointment', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Private calendar detail', exact: true })).toHaveCount(0);
  await page.getByLabel('Current profile').selectOption({ label: 'Alex' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await connection.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await connection.getByRole('button', { name: 'Confirm disconnect', exact: true }).click();
  await expect(connection).toHaveCount(0);
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private calendar detail', exact: true })).toHaveCount(0);
});

test('calendar consent returns to the initiating profile, exposes explicit selection and preserves inbox work', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByLabel('What’s on your mind?').fill('Unfinished household thought before calendar setup');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const label = `Calendar test ${randomUUID()}`;
  await page.getByLabel('Account label', { exact: true }).fill(label);
  await consent(page);
  await page.getByRole('button', { name: 'Finish connecting', exact: true }).click();
  const connection = page.locator('.calendar-connection').filter({ hasText: label });
  await expect(connection).toBeVisible();
  const visibility = connection.getByLabel('Visibility for Personal calendar', { exact: true });
  await expect(visibility).toHaveValue('hidden');
  await visibility.selectOption('private_work');
  await expect(visibility).toHaveValue('private_work');
  await page.reload();
  await expect(visibility).toHaveValue('private_work');
  await visibility.selectOption('shared_home');
  await expect(visibility).toHaveValue('shared_home');
  await expect(connection.getByLabel('Visibility for Availability only', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue(
    'Unfinished household thought before calendar setup',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    expect(
      await page.locator('.calendar-settings').evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390 || width === 1440)
      await page.screenshot({ path: `.cache/calendar-settings-${width}.png`, fullPage: true });
  }
  await connection.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await connection.getByRole('button', { name: 'Keep connection', exact: true }).click();
  await expect(connection).toBeVisible();
  await connection.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await connection.getByRole('button', { name: 'Confirm disconnect', exact: true }).click();
  await expect(connection).toHaveCount(0);
});

test('switching profiles before finishing Google consent cannot connect the account to the other person', async ({
  page,
}) => {
  await page.goto('/?settings=calendars');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByLabel('Account label', { exact: true }).fill(`Unfinished connection ${randomUUID()}`);
  await consent(page);
  await page.getByLabel('Current profile').selectOption({ label: 'Sam' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.calendar-settings')).toContainText('Connect calendars for Sam');
  await page.getByRole('button', { name: 'Finish connecting', exact: true }).click();
  await expect(page.locator('.calendar-settings').getByRole('alert')).toContainText(
    'Start again from the profile',
  );
  await expect(page.locator('.calendar-connection')).toHaveCount(0);
});

test('calendar setup reports unavailable configuration and disables network actions offline', async ({
  page,
  context,
}) => {
  let attempts = 0;
  await page.route('**/api/calendars/settings', (route) =>
    ++attempts === 1
      ? route.fulfill({ status: 503, json: { error: 'unavailable' } })
      : route.fulfill({ json: { configured: false, connections: [] } }),
  );
  await page.goto('/?settings=calendars');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(page.locator('.calendar-settings').getByRole('alert')).toContainText('Could not reach');
  await expect(page.getByText('Loading calendar settings…', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try loading calendar settings again' }).click();
  await expect(page.locator('.calendar-settings')).toContainText('isn’t set up on this server yet');
  await expect(page.getByRole('button', { name: 'Connect Google account' })).toBeDisabled();
  await context.setOffline(true);
  await expect(page.locator('.calendar-settings')).toContainText('Reconnect to the household server');
  await expect(page.getByRole('button', { name: 'Connect Google account' })).toBeDisabled();
});

for (const unavailable of ['loading', 'unconfigured', 'error', 'offline'] as const) {
  test(`calendar connection guards submission while ${unavailable}`, async ({ page, context }) => {
    let starts = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/calendars/authorization/begin', async (route) => {
      starts++;
      await route.fulfill({ status: 503, json: { error: 'unexpected_connection' } });
    });
    await page.route('**/api/calendars/settings', async (route) => {
      if (unavailable === 'loading') await pending;
      await route.fulfill(
        unavailable === 'error'
          ? { status: 503, json: { error: 'unavailable' } }
          : { json: { configured: unavailable !== 'unconfigured', connections: [] } },
      );
    });
    await page.goto('/?settings=calendars');
    await page.getByRole('button', { name: 'Alex', exact: true }).click();
    const label = page.getByLabel('Account label', { exact: true });
    const connect = page.getByRole('button', { name: 'Connect Google account', exact: true });
    if (unavailable === 'offline') {
      await expect(label).toBeEnabled();
      await label.fill('Keep my account label');
      await context.setOffline(true);
    }
    try {
      await expect(label).toBeDisabled();
      await expect(connect).toBeDisabled();
      const help = page.locator('#calendar-connect-help');
      await expect(help).toContainText(
        {
          loading: 'Loading calendar settings',
          unconfigured: 'The household owner needs to set up Google access',
          error: 'Calendar settings could not be loaded',
          offline: 'Reconnect to the household server',
        }[unavailable],
      );
      await expect(label).toHaveAttribute('aria-describedby', 'calendar-connect-help');
      if (unavailable === 'unconfigured') {
        await page.getByRole('button', { name: 'Set up Google Calendar', exact: true }).click();
        const guide = page.getByRole('region', { name: 'Google Calendar setup guide' });
        await expect(guide).toBeVisible();
        await expect(guide).toContainText('Web application');
        await expect(guide).toContainText('/oauth/calendar/callback');
        await guide.getByText('Server configuration details', { exact: true }).click();
        await expect(guide).toContainText('CALENDAR_CONFIG_FILE');
        await page.setViewportSize({ width: 320, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: '.cache/calendar-setup-guide.png', fullPage: true });
        await guide.getByRole('button', { name: 'Check setup again', exact: true }).click();
        await expect(connect).toBeDisabled();
      }

      // Bypass disabled controls to exercise the submit handler itself.
      await page.locator('.calendar-connect').dispatchEvent('submit');
      await expect(help).toBeVisible();
      expect(starts).toBe(0);
    } finally {
      release();
      await context.setOffline(false);
    }
    if (unavailable === 'loading' || unavailable === 'offline') {
      await expect(connect).toBeEnabled();
      if (unavailable === 'offline') await expect(label).toHaveValue('Keep my account label');
    }
  });
}

test('failed settings refresh blocks stale configured state until retry succeeds', async ({
  page,
  context,
}) => {
  let failing = false;
  await page.route('**/api/calendars/settings', (route) =>
    route.fulfill(
      failing
        ? { status: 503, json: { error: 'unavailable' } }
        : { json: { configured: true, connections: [] } },
    ),
  );
  await page.goto('/?settings=calendars');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  const label = page.getByLabel('Account label', { exact: true });
  await label.fill('My saved label');
  failing = true;
  await context.setOffline(true);
  await expect(label).toBeDisabled();
  await context.setOffline(false);
  await expect(page.locator('#calendar-connect-help')).toContainText('could not be loaded');
  await expect(label).toBeDisabled();
  failing = false;
  await page.getByRole('button', { name: 'Try loading calendar settings again' }).click();
  await expect(label).toBeEnabled();
  await expect(label).toHaveValue('My saved label');
  await expect(page.getByRole('button', { name: 'Connect Google account', exact: true })).toBeEnabled();
  await expect(page.locator('.calendar-settings').getByRole('alert')).toHaveCount(0);
  await label.fill('   ');
  await expect(page.getByRole('button', { name: 'Connect Google account', exact: true })).toBeDisabled();
});
