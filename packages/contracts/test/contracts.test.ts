import test from 'node:test';
import assert from 'node:assert/strict';
import { CreateInboxEntry, Envelope, isValid } from '../src/index.js';

const capture = { inboxId: 'inbox-example', scopeId: 'scope-example', capturedAt: 1234, text: 'Remember the filter', source: { kind: 'typed' }, attachments: [] };
test('wire schema preserves absence versus null and rejects extra fields without coercion', () => {
  assert.ok(isValid(CreateInboxEntry, capture));
  assert.ok(!isValid(CreateInboxEntry, { ...capture, capturedAt: '1234' }));
  assert.ok(!isValid(CreateInboxEntry, { ...capture, source: { kind: 'typed', uri: null } }));
  assert.ok(!isValid(CreateInboxEntry, { ...capture, actorPersonId: 'someone-else' }));
});
test('well-formed envelope admits invalid arguments for durable rejection arbitration', () => {
  assert.ok(isValid(Envelope, { operationId: 'operation-example', contractVersion: 1, expectedServerEpoch: 'epoch-example', arguments: { incorrect: true } }));
  assert.ok(!isValid(Envelope, { operationId: '', contractVersion: 1, expectedServerEpoch: 'epoch-example', arguments: capture }));
});
