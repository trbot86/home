import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, initialiseInstallation } from '../src/infrastructure/database.js';
import { registerShoppingPreferencesRoutes } from '../src/application/shopping-preferences-routes.js';
import { Rejection } from '../src/application/errors.js';

test('shopping preferences isolate profiles and preserve retry/conflict semantics', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  initialiseInstallation(db);
  const a = randomUUID(),
    b = randomUUID();
  for (const id of [a, b])
    db.prepare('INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)').run(
      id,
      id,
      'Test',
      'fixture',
    );
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply.code(400).send({ code: error instanceof Rejection ? error.code : 'error' }),
  );
  registerShoppingPreferencesRoutes(app, db, (request) => ({
    personId: String(request.headers['x-profile']),
    clientId: 'test',
    credentialId: 'test',
    kind: 'browser',
  }));
  try {
    const read = async (profile: string) =>
      (
        await app.inject({ method: 'GET', url: '/api/shopping/settings', headers: { 'x-profile': profile } })
      ).json();
    const save = async (profile: string, expectedRevision: number, location: string) =>
      app.inject({
        method: 'POST',
        url: '/api/shopping/settings',
        headers: { 'x-profile': profile },
        payload: {
          expectedRevision,
          preferences: { location, stores: [{ name: 'Example market', bulk: false }] },
        },
      });
    assert.equal((await read(a)).revision, 0);
    assert.equal((await save(a, 0, 'Example city')).statusCode, 200);
    assert.equal((await save(a, 0, 'Example city')).json().revision, 1);
    assert.equal((await save(a, 0, 'Other city')).json().code, 'revision_conflict');
    assert.equal((await read(b)).location, '');
    assert.equal((await read(a)).location, 'Example city');
  } finally {
    await app.close();
    db.close();
  }
});
