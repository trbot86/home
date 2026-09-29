import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyRecipeFields } from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';

test('sourcing is bounded, private, durable across retries, stale-safe, and distinguishes failure from no exceptions', async () => {
  const f = await integrationFixture();
  let calls = 0,
    fail = false,
    invalid = false,
    entered: (() => void) | undefined,
    release: (() => void) | undefined;
  let block: Promise<void> | undefined;
  const service = await buildApp({
    db: f.db,
    dataRoot: f.dataRoot,
    development: true,
    publicOrigin: 'http://localhost',
    now: f.now,
    filingAdviceProvider: async (input) => {
      calls++;
      assert.equal(input.purpose, 'ingredient_sources');
      assert.equal(JSON.stringify(input).includes('Excluded directions'), false);
      entered?.();
      if (block) await block;
      if (fail) throw Error('synthetic failure');
      return invalid
        ? ['invented']
        : input.choices.filter((c) => c.label === 'Specialty ingredient').map((c) => c.key);
    },
  });
  const person = service.access.authenticate('a'.repeat(43));
  const scopeId = service.access.scopes(person).find((s) => s.kind === 'private')!.scopeId;
  const headers = { cookie: `our_place_session=${'a'.repeat(43)}`, origin: 'http://localhost' };
  const api = (url: string, payload?: object) =>
    service.app.inject({ method: payload ? 'POST' : 'GET', url, headers, ...(payload ? { payload } : {}) });
  const recipeId = randomUUID(),
    ingredients = [
      { ingredientId: randomUUID(), text: 'Flour' },
      { ingredientId: randomUUID(), text: 'Specialty ingredient' },
    ];
  try {
    assert.equal(
      service.writes.execute(person, 'CreateRecipe', {
        operationId: randomUUID(),
        contractVersion: 1,
        expectedServerEpoch: 'fixture-epoch',
        arguments: {
          recordId: recipeId,
          scopeId,
          ...emptyRecipeFields(),
          title: 'Recipe',
          steps: [{ stepId: randomUUID(), text: 'Excluded directions' }],
          ingredients,
          collectionIds: [],
        },
      }).status,
      'Applied',
    );
    const prefs = { location: 'Example city', stores: [], defaultStore: 'Example supermarket' };
    assert.equal(
      (await api('/api/shopping/settings', { expectedRevision: 0, preferences: prefs })).statusCode,
      200,
    );
    const path = `/api/recipes/${recipeId}/sourcing`;
    const args = {
      expectedRevision: 1,
      expectedPreferencesRevision: 1,
      expectedAttempt: 0,
      ingredientIds: ingredients.map((i) => i.ingredientId),
    };
    const first = await api(path, args);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json().review.exceptionIds, [ingredients[1]!.ingredientId]);
    await api(path, args);
    assert.equal(calls, 1);
    assert.equal((await api(path)).json().review.state, 'complete');
    assert.equal(calls, 1);
    assert.equal(
      (await service.app.inject({ url: path, headers: { authorization: `Bearer ${'b'.repeat(43)}` } }))
        .statusCode,
      404,
    );
    fail = true;
    assert.equal((await api(path, { ...args, expectedAttempt: 1 })).json().review.state, 'failed');
    await api(path, { ...args, expectedAttempt: 1 });
    assert.equal(calls, 2);
    fail = false;
    invalid = true;
    assert.equal((await api(path, { ...args, expectedAttempt: 2 })).json().review.state, 'failed');
    invalid = false;
    assert.equal(
      (await api(path, { ...args, expectedAttempt: 3, ingredientIds: [ingredients[0]!.ingredientId] })).json()
        .review.state,
      'complete',
    );
    assert.deepEqual((await api(path)).json().review.exceptionIds, []);
    block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const running = api(path, { ...args, expectedAttempt: 4 });
    await started;
    assert.equal((await api(path, { ...args, expectedAttempt: 4 })).json().review.state, 'working');
    const count = calls;
    await api('/api/shopping/settings', {
      expectedRevision: 1,
      preferences: { ...prefs, location: 'Other city' },
    });
    release!();
    const stale = await running;
    assert.equal(stale.json().review.state, 'stale');
    assert.deepEqual(stale.json().review.exceptionIds, []);
    assert.equal(calls, count);
    block = undefined;
    f.db.prepare("UPDATE ingredient_sourcing SET state='working'").run();
    f.db.prepare('UPDATE ingredient_sourcing SET preferences_revision=2').run();
    assert.equal((await api(path)).json().review.state, 'failed');
    assert.equal(calls, count);
    const secured = await api(`/api/records/${recipeId}/security`, {
      secure: true,
      expectedRevision: 0,
      expectedServerEpoch: 'fixture-epoch',
    });
    assert.equal(secured.statusCode, 200, secured.body);
    assert.equal(
      (await api(path, { ...args, expectedPreferencesRevision: 2, expectedAttempt: 5 })).json().code,
      'secure_record_excluded',
    );
    assert.equal(calls, count);
  } finally {
    release?.();
    await service.app.close();
    await f.close();
  }
});
