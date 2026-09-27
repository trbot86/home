import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

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
      await page.screenshot({ path: `.local/calendar-settings-${width}.png`, fullPage: true });
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
