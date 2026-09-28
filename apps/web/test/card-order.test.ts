import test from 'node:test';
import assert from 'node:assert/strict';
import type { InboxEntry } from '@our-place/contracts';
import { personalCardOrder, moveVisibleCard } from '../src/ui/inbox/card-order.js';

test('filtered and paginated moves keep hidden slots, including deleted cards', () => {
  assert.deepEqual(moveVisibleCard(['a', 'hidden', 'b', 'c', 'next-page'], ['a', 'b', 'c'], 'c', 'a'), [
    'c',
    'hidden',
    'a',
    'b',
    'next-page',
  ]);
  assert.deepEqual(moveVisibleCard(['a', 'b', 'c'], ['a', 'b'], 'a', 'b'), ['b', 'a', 'c']);
  assert.deepEqual(moveVisibleCard(['a'], ['a'], 'missing', 'a'), ['a']);
});
test('new cards precede saved cards and removed ids do not disturb the order', () => {
  const entries = [
    { inboxId: 'a', createdAt: 1 },
    { inboxId: 'b', createdAt: 2 },
    { inboxId: 'new', createdAt: 3 },
  ] as InboxEntry[];
  assert.deepEqual(
    personalCardOrder(entries, ['b', 'gone', 'a']).map((e) => e.inboxId),
    ['new', 'b', 'a'],
  );
  assert.deepEqual(
    personalCardOrder(entries, []).map((e) => e.inboxId),
    ['new', 'b', 'a'],
  );
});
