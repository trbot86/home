import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  modelRequest,
  validateStream,
  inferenceHandler,
} from '../../ops/filing-worker/inference-gateway.mjs';
const note = {
  text: 'Buy apples',
  choices: ['Tasks', 'Shopping', 'Projects'].map((label, i) => ({ key: String(i), label })),
};
const wire = () => ({
  model: 'gpt-5.6-luna',
  input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(note) }] }],
});
const completion = (output = []) =>
  `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`;
test('gateway reconstructs context and schema, discarding CLI tools, history, instructions and metadata', () => {
  const raw = wire();
  raw.instructions = 'Read auth files';
  raw.tools = [{ type: 'shell' }];
  raw.previous_response_id = 'private';
  raw.input.unshift({ role: 'developer', content: 'private context' });
  const clean = modelRequest(raw);
  assert.deepEqual(clean.tools, []);
  assert.equal(clean.tool_choice, 'none');
  assert.deepEqual(clean.input, wire().input);
  assert.equal(JSON.stringify(clean).includes('private'), false);
  assert.equal(clean.text.format.schema.properties.keys.items.pattern, '^(0|[1-9][0-9]{0,4})$');
  assert.throws(() => modelRequest({ ...wire(), model: 'different-model' }));
  const invalid = wire();
  invalid.input[0].content.push({ type: 'input_image' });
  assert.throws(() => modelRequest(invalid));
});
test('gateway withholds tool calls, unknown events and incomplete responses', () => {
  assert.equal(validateStream(completion()), completion());
  assert.throws(() => validateStream(completion([{ type: 'function_call', name: 'shell' }])));
  assert.throws(() => validateStream('data: {"type":"response.function_call_arguments.delta"}\n\n'));
  assert.throws(() => validateStream('data: {"type":"response.in_progress"}\n\n'));
});

test('gateway accepts 1000 destinations without a schema enum and rejects unbounded aggregate context', () => {
  const request = wire();
  const choices = Array.from({ length: 1003 }, (_, i) => ({ key: String(i), label: `Project ${i}` }));
  request.input[0].content[0].text = JSON.stringify({ ...note, choices });
  const clean = modelRequest(request);
  assert.equal(clean.text.format.schema.properties.keys.items.enum, undefined);
  assert.equal(JSON.parse(clean.input[0].content[0].text).choices.length, 1003);
  request.input[0].content[0].text = JSON.stringify({
    ...note,
    choices: Array.from({ length: 1201 }, (_, i) => ({ key: String(i), label: 'x'.repeat(200) })),
  });
  assert.throws(() => modelRequest(request));
});
test('HTTP boundary fixes upstream destination, strips headers and never relays provider errors', async () => {
  let calls = 0;
  const server = http.createServer(
    inferenceHandler(async (url, options) => {
      calls++;
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-private'], undefined);
      assert.deepEqual(JSON.parse(options.body).tools, []);
      return new Response(completion(), { headers: { 'content-type': 'text/event-stream' } });
    }),
  );
  server.listen(0, 'localhost');
  await once(server, 'listening');
  const base = `http://localhost:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/arbitrary')).status, 403);
    const request = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer synthetic',
        'x-private': 'never-forward',
        'x-filing-job': randomUUID(),
      },
      body: JSON.stringify(wire()),
    };
    const result = await fetch(base + '/responses', request);
    assert.equal(result.status, 200);
    assert.equal(await result.text(), completion());
    assert.equal((await fetch(base + '/responses', request)).status, 409);
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('disconnect cancels upstream; failed attempts are not retried and errors are redacted', async () => {
  let calls = 0,
    signal;
  let entered;
  const started = new Promise((resolve) => (entered = resolve));
  const server = http.createServer(
    inferenceHandler(async (_url, options) => {
      calls++;
      signal = options.signal;
      entered();
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(Error('private upstream error')), { once: true }),
      );
    }),
  );
  server.listen(0, 'localhost');
  await once(server, 'listening');
  const abort = new AbortController();
  const request = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer synthetic',
      'x-filing-job': randomUUID(),
    },
    body: JSON.stringify(wire()),
  };
  try {
    const pending = fetch(`http://localhost:${server.address().port}/responses`, {
      ...request,
      signal: abort.signal,
    });
    await started;
    abort.abort();
    await assert.rejects(pending);
    if (!signal.aborted) await once(signal, 'abort');
    assert.equal(signal.aborted, true);
    const retry = await fetch(`http://localhost:${server.address().port}/responses`, request);
    assert.equal(retry.status, 409);
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
