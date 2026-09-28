import { expect, test } from '@playwright/test';

test('discussion notes steer active work and show acknowledged delivery without queuing a new round', async ({
  page,
  request,
}) => {
  const headers = { 'x-test-token': process.env['OUR_PLACE_TEST_TOKEN']! };
  const seeded = await request.post('http://127.0.0.1:4174/suggestion-working', { headers });
  expect(seeded.ok()).toBe(true);
  const { text } = await seeded.json();
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await page.locator('.entry-card').filter({ hasText: text }).locator('.entry-text').click();
  const discussion = page.getByRole('region', { name: 'Suggestion discussion' });
  await expect(discussion.getByRole('button', { name: 'Send to working agent', exact: true })).toBeVisible();
  await discussion.getByLabel('Add a follow-up').fill('Please use the green layout');
  await discussion.getByLabel('Add a follow-up').press('Control+Enter');
  await expect(
    discussion.locator('.suggestion-timeline').getByText('Please use the green layout', { exact: true }),
  ).toBeVisible();
  expect((await request.post('http://127.0.0.1:4174/deliver-synthetic-steering', { headers })).ok()).toBe(
    true,
  );
  await expect(discussion.getByText('Delivered to the working agent', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(discussion.getByText('Queued', { exact: true })).toHaveCount(0);
});

test('completed suggestions stay behind their filter, retain discussion offline and can be reopened', async ({
  page,
  request,
  context,
}) => {
  const seeded = await request.post('http://127.0.0.1:4174/suggestion-ready', {
    headers: { 'x-test-token': process.env['OUR_PLACE_TEST_TOKEN']! },
  });
  expect(seeded.ok()).toBe(true);
  const { text } = await seeded.json();
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: text });
  const filter = page.locator('[aria-label="Suggestion status filter"]');
  const navCount = page.getByRole('button', { name: 'App suggestions', exact: true }).locator('.nav-count');
  const initialCount = Number(await navCount.innerText());
  await expect(card.getByText('Waiting for update', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Mark completed', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(navCount).toHaveText(String(initialCount - 1));
  await page.getByLabel('Search suggestions').fill(text);
  await expect(card).toHaveCount(0);
  await filter.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(card).toHaveCount(1);
  await expect(card.getByText('Completed', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 820 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/suggestion-completed-phone.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await expect(card).toHaveCount(0);
  await filter.getByRole('button', { name: 'Completed', exact: true }).click();
  await card.locator('.entry-text').click();
  const discussion = page.getByRole('region', { name: 'Suggestion discussion' });
  await expect(discussion.locator('.suggestion-original')).toContainText(text);
  await expect(
    discussion.getByText('Implemented and tested the recipe label.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close entry' }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await expect(card).toHaveCount(0);
  await filter.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Reopen', exact: true })).toBeDisabled();
  await context.setOffline(false);
  await card.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(card).toHaveCount(0);
  await filter.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(card).toHaveCount(1);
  await expect(card.getByText('Waiting for update', { exact: true })).toBeVisible();
  await expect(navCount).toHaveText(String(initialCount));
  await card.locator('.entry-text').click();
  await discussion.getByRole('button', { name: 'Mark completed', exact: true }).click();
  await expect(discussion.getByText('Completed', { exact: true })).toBeVisible();
  await discussion.getByRole('button', { name: 'Work on this', exact: true }).click();
  await expect(discussion.getByRole('button', { name: 'Mark completed', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close entry' }).click();
  await expect(card).toHaveCount(1);
  await expect(card.getByText('Queued', { exact: true })).toBeVisible();
  await card.locator('.entry-text').click();
  await discussion.getByRole('button', { name: 'Cancel queued work', exact: true }).click();
});

test('obsolete questions leave the active list and remain in discussion history', async ({
  page,
  request,
}) => {
  const seeded = await request.post('http://127.0.0.1:4174/suggestion-question', {
    headers: { 'x-test-token': process.env['OUR_PLACE_TEST_TOKEN']! },
  });
  expect(seeded.ok()).toBe(true);
  const { text } = await seeded.json();
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: text });
  await expect(card.getByText('New update', { exact: true })).toBeVisible();
  await expect(card.locator('.suggestion-card-update-text')).toHaveText('An earlier step asked a question.');
  await page.reload();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await expect(card.getByText('New update', { exact: true })).toBeVisible();
  await card.locator('.suggestion-card-update').click();
  await expect(card.getByText('New update', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Questions', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'No longer relevant', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Questions', exact: true })).toHaveCount(0);
  await expect(
    page.locator('.suggestion-summary').getByText('Ready to continue', { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.suggestion-timeline').getByText('Do we still need the old environment?', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText('Marked this question as no longer relevant.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel queued work', exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await expect(card.getByText('New update', { exact: true })).toHaveCount(0);
  await page.locator('.entry-card').filter({ hasText: text }).locator('.entry-text').click();
  await expect(page.getByRole('region', { name: 'Questions', exact: true })).toHaveCount(0);
  await expect(page.getByText('Marked this question as no longer relevant.', { exact: true })).toBeVisible();
});

test('one batch panel automatically prepares several suggestions and deploys only the tested candidate', async ({
  page,
  request,
}) => {
  const headers = { 'x-test-token': process.env['OUR_PLACE_TEST_TOKEN']! };
  const seed = await request.post('http://127.0.0.1:4174/suggestion-ready', { headers });
  expect(seed.ok()).toBe(true);
  const { text } = await seed.json();
  const second = await request.post('http://127.0.0.1:4174/suggestion-ready-same-agent', { headers });
  expect(second.ok()).toBe(true);
  const secondText = (await second.json()).text;
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: text });
  await expect(page.getByRole('button', { name: 'Prepare release', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Deploy update' })).toHaveCount(0);
  expect((await request.post('http://127.0.0.1:4174/prepare-synthetic-release', { headers })).ok()).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Refresh and sync' }).click();
  await expect(card.getByText('Ready to deploy', { exact: true })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Suggestion release', exact: true });
  await expect(panel.getByRole('heading')).toContainText('2 suggestions');
  await expect(panel).toContainText(text);
  await expect(panel).toContainText(secondText);
  await expect(page.getByRole('button', { name: 'Deploy update', exact: true })).toHaveCount(1);
  await page.setViewportSize({ width: 360, height: 820 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: 'test-results/suggestion-release-batch-phone.png' });
  await page.reload();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await panel.getByRole('button', { name: 'Deploy update', exact: true }).click();
  await expect(card.getByText('Deployment queued', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deploy update' })).toHaveCount(0);
  // No host worker is connected to this isolated fixture. Cancel the still-queued deployment.
  await panel.getByRole('button', { name: 'Cancel release', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await card.locator('.entry-text').click();
  await expect(page.getByRole('button', { name: 'Retry update checks', exact: true })).toBeVisible();
});

test('suggestion discussion saves an offline reply once without turning it into an inbox entry', async ({
  page,
  context,
}) => {
  const suggestion = 'Discussion trial ' + crypto.randomUUID(),
    reply = 'Please use compact spacing ' + crypto.randomUUID();
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await page.getByLabel('Suggest an improvement').fill(suggestion);
  await page.getByRole('button', { name: 'Save suggestion', exact: true }).click();
  const card = page.locator('.entry-card').filter({ hasText: suggestion });
  await expect(card).toHaveCount(1);
  await card.locator('.entry-text').click();
  await expect(page.getByRole('region', { name: 'Suggestion discussion' })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.getByLabel('Add a follow-up').fill(reply);
  await page.getByLabel('Add a follow-up').press('Control+Enter');
  await expect(page.getByText('Waiting to upload', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await card.locator('.entry-text').click();
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(page.locator('.suggestion-timeline').getByText(reply, { exact: true })).toHaveCount(1);
  await expect(
    page.getByText('Saved for review; waiting for the development host.', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/suggestion-discussion-phone.png', fullPage: true });
  await page.getByRole('button', { name: 'Entry', exact: true }).click();
  await expect(page.getByLabel('Entry text')).toHaveValue(suggestion);
  await page.getByRole('button', { name: 'Close entry' }).click();
  await expect(page.locator('.entry-card').filter({ hasText: reply })).toHaveCount(0);
});

test('suggestions keep separate drafts and counts through offline reload, move and undo', async ({
  page,
  context,
}) => {
  const suggestion = 'Let Back close an open card ' + crypto.randomUUID();
  await page.goto('/');
  await page.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const initialCount = await page
    .getByRole('button', { name: 'Inbox', exact: true })
    .locator('.nav-count')
    .innerText();
  await page.getByLabel('What’s on your mind?').fill('Unfinished household thought');
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await expect(page.getByLabel('Suggest an improvement')).toHaveValue('');
  await context.setOffline(true);
  await page.getByLabel('Suggest an improvement').fill(suggestion);
  await page.getByRole('button', { name: 'Save suggestion', exact: true }).click();
  await expect(page.getByText('Waiting for confirmation · kept unchanged for retry')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('Unfinished household thought');
  await expect(page.getByRole('button', { name: 'Inbox', exact: true }).locator('.nav-count')).toHaveText(
    initialCount,
  );
  await page.getByRole('button', { name: 'App suggestions', exact: true }).click();
  await expect(page.getByText('Waiting for confirmation · kept unchanged for retry')).toBeVisible();
  await context.setOffline(false);
  const card = page.locator('.entry-card').filter({ hasText: suggestion });
  await expect(card).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Inbox', exact: true }).locator('.nav-count')).toHaveText(
    initialCount,
  );
  await expect(card.locator('.entry-text')).toHaveText(suggestion);
  await card.getByRole('button', { name: 'Move to inbox', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText('Moved to inbox', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close entry' }).click();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/suggestions-phone.png', fullPage: true });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('What’s on your mind?')).toHaveValue('Unfinished household thought');
  await expect(card).toHaveCount(0);
});
