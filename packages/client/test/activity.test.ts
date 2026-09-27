import test from 'node:test';
import assert from 'node:assert/strict';
import {
  householdActivity,
  filterActivity,
  defaultActivityFilter,
  type ActivityState,
} from '../src/activity.js';

// Only fields read by this projection are supplied; browser tests use real command-created records.
const record = (recordId: string, extra: object = {}) => ({
  recordId,
  scopeId: 'shared',
  deletedAt: null,
  attachments: [],
  ...extra,
});
function fixture(): ActivityState {
  return {
    session: {
      scopes: [
        { scopeId: 'shared', kind: 'shared' },
        { scopeId: 'mine', kind: 'private' },
      ],
    },
    tasks: {
      timeZone: 'America/Toronto',
      people: [
        { personId: 'alex', displayName: 'Alex' },
        { personId: 'sam', displayName: 'Sam' },
      ],
      definitions: [
        record('task', { title: 'Replace filter', context: 'home' }),
        record('private-task', { scopeId: 'mine', title: 'Secret gift', context: 'home' }),
        record('work-task', { title: 'Work task', context: 'work' }),
      ],
      occurrences: [
        record('occurrence', { taskId: 'task', state: 'completed' }),
        record('private-occurrence', { scopeId: 'mine', taskId: 'private-task', state: 'completed' }),
        record('work-occurrence', { taskId: 'work-task', state: 'completed' }),
      ],
      completions: [
        record('completion', {
          occurrenceId: 'occurrence',
          completedAt: 1000,
          createdAt: 9000,
          performedByPersonId: 'sam',
          performerName: 'Sam',
          note: 'Installed the spare',
        }),
        record('private-completion', {
          scopeId: 'mine',
          occurrenceId: 'private-occurrence',
          completedAt: 3000,
          performedByPersonId: 'alex',
          performerName: 'Alex',
          note: 'Surprise',
        }),
        record('work-completion', {
          occurrenceId: 'work-occurrence',
          completedAt: 1500,
          performedByPersonId: 'alex',
          performerName: 'Alex',
          note: '',
        }),
      ],
    },
    shopping: {
      purchases: [
        record('purchase', {
          boughtAt: 2000,
          buyerPersonId: 'alex',
          buyerName: 'Alex',
          notes: '',
          items: [{ label: 'Brush heads', quantity: '4-pack' }],
        }),
      ],
    },
    home: {
      assets: [record('asset', { name: 'Furnace' })],
      serviceRecords: [
        record('service', {
          assetId: 'asset',
          completionId: 'completion',
          occurredAt: 1000,
          notes: 'Installed the spare',
        }),
      ],
    },
    recipes: {
      recipes: [record('recipe', { title: 'Soup' })],
      cookingRecords: [
        record('cooking', {
          recipeId: 'recipe',
          completionId: null,
          cookedAt: 500,
          cookedByPersonId: null,
          notes: 'Less salt',
        }),
      ],
    },
  } as unknown as ActivityState;
}
test('activity uses actual work dates and performers and collapses a linked service into one completion', () => {
  const state = fixture(),
    before = JSON.stringify(state);
  const rows = householdActivity(state);
  assert.deepEqual(
    rows.map((r) => r.recordId),
    ['private-completion', 'purchase', 'work-completion', 'completion', 'cooking'],
  );
  const done = rows.find((r) => r.recordId === 'completion')!;
  assert.deepEqual(done.kinds, ['maintenance']);
  assert.equal(done.personName, 'Sam');
  assert.equal(done.occurredAt, 1000);
  assert.deepEqual(done.notes, ['Installed the spare']);
  assert.deepEqual(
    done.links.map((l) => l.label),
    ['Task', 'Home item'],
  );
  assert.equal(rows.at(-1)!.personName, null);
  assert.equal(JSON.stringify(state), before, 'Projection must not mutate canonical cached records');
});
test('private activity, counts and search stay outside shared views, including invalid cross-scope links', () => {
  const state = fixture();
  state.shopping.purchases.push({
    ...state.shopping.purchases[0]!,
    recordId: 'partner-secret',
    scopeId: 'inaccessible',
    items: [{ purchaseItemId: 'p', shoppingEntryId: 'e', label: 'Partner secret', quantity: '' }],
  });
  state.home.serviceRecords.push({
    ...state.home.serviceRecords[0]!,
    recordId: 'private-service',
    scopeId: 'mine',
    notes: 'Private link must not appear',
    assetId: 'asset',
  });
  const rows = householdActivity(state),
    defaults = defaultActivityFilter();
  const shared = filterActivity(rows, state, defaults);
  assert.equal(shared.length, 4);
  assert.ok(!JSON.stringify(shared).includes('Secret gift'));
  assert.ok(!JSON.stringify(rows).includes('Partner secret'));
  assert.ok(!JSON.stringify(rows).includes('Private link'));
  assert.equal(filterActivity(rows, state, { ...defaults, search: 'Surprise' }).length, 0);
  assert.deepEqual(
    filterActivity(rows, state, { ...defaults, visibility: 'private' }).map((r) => r.recordId),
    ['private-completion'],
  );
  assert.equal(householdActivity({ ...state, session: null }).length, 0);
});
test('undo or removal clears completed activity while deleting a task preserves the actual completion', () => {
  const state = fixture();
  state.tasks.definitions[0]!.deletedAt = 7000;
  assert.equal(householdActivity(state).find((r) => r.recordId === 'completion')!.sourceDeleted, true);
  state.tasks.completions[0]!.deletedAt = 8000;
  assert.ok(!householdActivity(state).some((r) => ['completion', 'service'].includes(r.recordId)));
  state.tasks.completions[0]!.deletedAt = null;
  state.tasks.occurrences[0]!.state = 'open';
  assert.ok(!householdActivity(state).some((r) => r.recordId === 'completion'));
  state.shopping.purchases[0]!.deletedAt = 8000;
  assert.ok(!householdActivity(state).some((r) => r.recordId === 'purchase'));
});
test('cooking completion is shown once, and person, kind, context and unknown-person filters compose', () => {
  const state = fixture();
  state.home.serviceRecords = [];
  state.recipes.cookingRecords[0]!.completionId = 'completion';
  const rows = householdActivity(state),
    defaults = defaultActivityFilter();
  const cooked = rows.find((r) => r.recordId === 'completion')!;
  assert.deepEqual(cooked.kinds, ['cooking']);
  assert.deepEqual(cooked.notes, ['Installed the spare', 'Less salt']);
  assert.equal(
    rows.some((r) => r.recordId === 'cooking'),
    false,
  );
  assert.deepEqual(
    filterActivity(rows, state, { ...defaults, context: 'work' }).map((r) => r.recordId),
    ['work-completion'],
  );
  assert.deepEqual(
    filterActivity(rows, state, { ...defaults, kind: 'cooking', personId: 'sam', search: 'salt' }).map(
      (r) => r.recordId,
    ),
    ['completion'],
  );
  state.recipes.cookingRecords[0]!.completionId = null;
  assert.deepEqual(
    filterActivity(householdActivity(state), state, { ...defaults, personId: 'unrecorded' }).map(
      (r) => r.recordId,
    ),
    ['cooking'],
  );
});

test('one completion linked to both cooking and maintenance remains one row in either category', () => {
  const state = fixture();
  state.recipes.cookingRecords[0]!.completionId = 'completion';
  const rows = householdActivity(state),
    defaults = defaultActivityFilter();
  assert.deepEqual(rows.find((r) => r.recordId === 'completion')!.kinds, ['cooking', 'maintenance']);
  for (const kind of ['cooking', 'maintenance'] as const)
    assert.equal(filterActivity(rows, state, { ...defaults, kind }).length, 1);
});
