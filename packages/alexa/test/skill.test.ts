import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { CaptureRequest, CommandOutcome } from '@our-place/contracts';
import { captureOperationId, createAlexaHandler, type CaptureSink } from '../src/skill.js';

const now = Date.parse('2026-09-27T12:00:00Z');
const skillId = 'test-skill',
  userId = 'test-user',
  epoch = 'test-epoch';
function event(intentName = 'RememberIntent', text = 'The spare key is in the blue drawer') {
  return {
    version: '1.0',
    context: { System: { application: { applicationId: skillId }, user: { userId } } },
    request: {
      type: 'IntentRequest',
      requestId: 'request-one',
      timestamp: new Date(now).toISOString(),
      locale: 'en-CA',
      intent: { name: intentName, slots: { Text: { name: 'Text', value: text } } },
    },
  };
}
function saved(capture: CaptureRequest): CommandOutcome {
  return {
    status: 'Applied',
    receipt: { operationId: capture.operationId, requestDigest: 'a'.repeat(64), recordedAt: now },
    result: { records: [{ recordId: 'test-record', revision: 1 }] },
  };
}
function handler(capture: CaptureSink, shoppingEnabled = false) {
  return createAlexaHandler({
    skillId,
    users: new Map([[userId, { bindingId: 'test-binding', expectedServerEpoch: epoch }]]),
    capture,
    now: () => now,
    shoppingEnabled,
  });
}
test('capture routes only recognized text and a stable operation ID; readback follows acknowledgement', async () => {
  const calls: CaptureRequest[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = handler(async (bindingId, capture) => {
    assert.equal(bindingId, 'test-binding');
    calls.push(capture);
    await gate;
    return saved(capture);
  }, true);
  let finished = false;
  const pending = run(event()).then((response) => {
    finished = true;
    return response;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  const response = await pending;
  assert.equal(
    response.response.outputSpeech?.text,
    'Saved to your shared inbox: The spare key is in the blue drawer',
  );
  assert.equal(response.response.shouldEndSession, true);
  await run(event());
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0]!.capturedAt, now);
  assert.equal(calls[0]!.expectedServerEpoch, epoch);
  assert.equal(calls[0]!.operationId, captureOperationId(skillId, userId, 'request-one'));
  assert.notEqual(calls[0]!.operationId, captureOperationId(skillId, 'another-user', 'request-one'));
  const changed = event('AddShoppingIntent', 'two cartons of milk and eggs');
  await run(changed);
  assert.equal(
    calls[2]!.operationId,
    calls[0]!.operationId,
    'payload changes must conflict at the server, not acquire a fresh key',
  );
  assert.equal(calls[2]!.destination, 'shopping');
  assert.equal(calls[2]!.text, 'two cartons of milk and eggs', 'no inferred splitting or quantities');
});
test('unapproved identity, stale timestamps, unknown locales and non-capture intents do not write', async () => {
  let calls = 0;
  const run = handler(async (_binding, capture) => {
    calls++;
    return saved(capture);
  });
  const wrongSkill = event();
  wrongSkill.context.System.application.applicationId = 'other-skill';
  await run(wrongSkill);
  const wrongUser = event();
  wrongUser.context.System.user.userId = 'other-user';
  await run(wrongUser);
  const old = event();
  old.request.timestamp = new Date(now - 150_001).toISOString();
  await run(old);
  const future = event();
  future.request.timestamp = new Date(now + 150_001).toISOString();
  await run(future);
  const locale = event();
  locale.request.locale = 'fr-CA';
  await run(locale);
  const mismatch = {
    ...event(),
    session: { application: { applicationId: skillId }, user: { userId: 'other-user' } },
  };
  await run(mismatch);
  for (const intent of [
    'AMAZON.StopIntent',
    'AMAZON.CancelIntent',
    'AMAZON.HelpIntent',
    'AMAZON.FallbackIntent',
    'UnknownIntent',
  ])
    await run(event(intent));
  for (const malformed of [null, {}, [], { version: '1.0' }]) await run(malformed);
  assert.equal(calls, 0);
});

test('the first trial offers inbox notes and blocks shopping even if an event names that intent', async () => {
  let calls = 0;
  const run = handler(async (_binding, capture) => {
    calls++;
    return saved(capture);
  });
  const launch = { ...event(), request: { ...event().request, type: 'LaunchRequest' } };
  for (const request of [launch, event('AMAZON.HelpIntent'), event('AddShoppingIntent', 'milk')]) {
    const response = await run(request);
    assert.match(response.response.outputSpeech!.text, /Say remember/);
    assert.doesNotMatch(response.response.outputSpeech!.text, /shopping/i);
    assert.doesNotMatch(response.response.reprompt!.outputSpeech.text, /shopping/i);
    assert.equal(response.response.shouldEndSession, false);
  }
  assert.equal(calls, 0);
  await run(event());
  assert.equal(calls, 1);
});
test('missing and overlong capture are not truncated; readback remains plain text', async () => {
  let calls = 0;
  const run = handler(async (_binding, capture) => {
    calls++;
    return saved(capture);
  }, true);
  await run(event('RememberIntent', '   '));
  await run(event('RememberIntent', 'x'.repeat(1001)));
  await run(event('AddShoppingIntent', 'x'.repeat(301)));
  await run(event('RememberIntent', 'bad\u0000text'));
  assert.equal(calls, 0);
  const response = await run(event('RememberIntent', '<audio src="example"> & milk'));
  assert.equal(response.response.outputSpeech?.type, 'PlainText');
  assert.equal(calls, 1);
});
test('ambiguous failures, malformed replies and wrong receipts never announce saved', async () => {
  const outcomes: unknown[] = [
    { status: 'Deferred', code: 'busy' },
    {
      status: 'Rejected',
      receipt: { operationId: 'test-operation', requestDigest: 'b'.repeat(64), recordedAt: now },
      code: 'unavailable',
    },
    { status: 'Applied' },
    saved({ operationId: 'wrong-operation' } as CaptureRequest),
  ];
  for (const outcome of outcomes) {
    const response = await handler(async () => outcome as CommandOutcome)(event());
    assert.match(response.response.outputSpeech!.text, /couldn't confirm/);
  }
  const response = await handler(async () => {
    throw new Error('lost acknowledgement');
  })(event());
  assert.match(response.response.outputSpeech!.text, /check Our Place before repeating/i);
  const restored = await handler(async () => ({
    status: 'RecoveryRequired',
    currentServerEpoch: 'new-epoch',
    restorePoint: now,
  }))(event());
  assert.match(restored.response.outputSpeech!.text, /after a restore/);
});
test('interaction model uses one phrase slot per capture intent with nonempty carriers', () => {
  const model = JSON.parse(
    readFileSync(new URL('../interaction-models/en-CA.json', import.meta.url), 'utf8'),
  );
  const intents = model.interactionModel.languageModel.intents as {
    name: string;
    slots?: { name: string; type: string }[];
    samples: string[];
  }[];
  assert.equal(intents.some((intent) => intent.name === 'AddShoppingIntent'), false);
  for (const name of ['RememberIntent']) {
    const intent = intents.find((item) => item.name === name)!;
    assert.deepEqual(intent.slots, [{ name: 'Text', type: 'AMAZON.SearchQuery' }]);
    for (const sample of intent.samples) {
      assert.equal((sample.match(/\{/g) ?? []).length, 1);
      assert.ok(sample.replace('{Text}', '').trim().length > 0);
    }
  }
});
