import test from 'node:test';
import assert from 'node:assert/strict';
import { widgetNavigationError } from '../src/widget-navigation.js';
import type { ClientState, WidgetNavigation } from '../src/index.js';

test('widget shortcuts cannot switch profiles, cross recovery epochs, reveal removed tasks or act on a later recurrence', () => {
  // Only fields consumed by the navigation policy are supplied in this deliberately small fixture.
  const state = {
    session: { clientId: 'client', serverEpoch: 'epoch', scopes: [{ scopeId: 'shared', kind: 'shared' }] },
    recoveryRequired: false,
    tasks: {
      definitions: [{ recordId: 'task', deletedAt: null, scopeId: 'shared' }],
      occurrences: [
        {
          recordId: 'old-occurrence',
          taskId: 'task',
          scopeId: 'shared',
          deletedAt: null,
          state: 'completed',
        },
        { recordId: 'new-occurrence', taskId: 'task', scopeId: 'shared', deletedAt: null, state: 'open' },
      ],
    },
  } as ClientState;
  const request: WidgetNavigation = {
    token: 'token',
    clientId: 'client',
    serverEpoch: 'epoch',
    recordId: 'new-occurrence',
    action: 'complete',
  };
  assert.equal(widgetNavigationError(state, request), null);
  assert.match(widgetNavigationError(state, { ...request, clientId: 'other' })!, /another profile/);
  assert.match(widgetNavigationError(state, { ...request, serverEpoch: 'old' })!, /restored/);
  assert.match(widgetNavigationError({ ...state, recoveryRequired: true }, request)!, /restored/);
  assert.match(widgetNavigationError(state, { ...request, recordId: 'unknown' })!, /no longer available/);
  assert.match(widgetNavigationError(state, { ...request, recordId: 'old-occurrence' })!, /no longer open/);
  assert.equal(
    widgetNavigationError(state, { ...request, recordId: 'old-occurrence', action: 'show' }),
    null,
  );
  state.tasks.definitions[0]!.scopeId = 'private';
  assert.match(widgetNavigationError(state, request)!, /no longer available/);
  state.tasks.definitions[0]!.scopeId = 'shared';
  state.tasks.definitions[0]!.deletedAt = 1;
  assert.match(widgetNavigationError(state, request)!, /no longer available/);
});
