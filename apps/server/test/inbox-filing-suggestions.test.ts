import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { createRecordFeatures } from '../src/application/record-features.js';
import {
  InboxFilingSuggestions,
  type FilingAdviceProvider,
  type FilingAdviceInput,
} from '../src/application/inbox-filing-suggestions.js';
import { openDatabase } from '../src/infrastructure/database.js';
import type { CommandKind } from '@our-place/contracts';
import { dedicatedCodexProvider } from '../src/infrastructure/filing-codex-provider.js';

async function fixture(provider?: FilingAdviceProvider) {
  const f = await integrationFixture();
  const service = await buildApp({
    db: f.db,
    dataRoot: f.dataRoot,
    development: true,
    publicOrigin: 'http://localhost',
    now: f.now,
    ...(provider ? { filingAdviceProvider: provider } : {}),
  });
  const a = service.access.authenticate('a'.repeat(43)),
    b = service.access.authenticate('b'.repeat(43));
  const shared = service.access.scopes(a).find((s) => s.kind === 'shared')!.scopeId;
  const privateScope = service.access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
  const records = createRecordFeatures(f.db, service.access).records;
  const run = (kind: CommandKind, args: unknown) =>
    service.writes.execute(a, kind, {
      operationId: randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: 'fixture-epoch',
      arguments: args,
    });
  const note = (scopeId = shared, category = 'inbox') => {
    const inboxId = randomUUID();
    assert.equal(
      run('CreateInboxEntry', {
        inboxId,
        scopeId,
        category,
        text: 'Synthetic note to file',
        capturedAt: f.now(),
        source: { kind: 'typed' },
        attachments: [],
      }).status,
      'Applied',
    );
    return service.inbox.get(a, inboxId);
  };
  const project = (scopeId = shared, title = 'Synthetic project') => {
    const recordId = randomUUID();
    assert.equal(
      run('CreateProject', { recordId, scopeId, title, description: 'Do not export this content' }).status,
      'Applied',
    );
    return recordId;
  };
  const advice = (p: FilingAdviceProvider, destinationTitles = false, scopes = [shared]) =>
    new InboxFilingSuggestions(f.db, service.inbox, records, p, { scopeIds: scopes, destinationTitles });
  const api = (url: string, payload?: object, person = 'a') =>
    service.app.inject({
      method: payload ? 'POST' : 'GET',
      url,
      headers: {
        ...(person === 'b'
          ? { authorization: `Bearer ${person.repeat(43)}` }
          : { cookie: `our_place_session=${person.repeat(43)}` }),
        origin: 'http://localhost',
      },
      ...(payload ? { payload } : {}),
    });
  return {
    ...f,
    service,
    a,
    b,
    shared,
    privateScope,
    records,
    note,
    project,
    advice,
    run,
    api,
    close: async () => {
      await service.app.close();
      await f.close();
    },
  };
}

test('dedicated adapter preserves durable dispatch and original data through the suggestion route', async () => {
  let calls = 0;
  const provider = dedicatedCodexProvider(
    {
      launcher: process.execPath,
      workingDirectory: process.cwd(),
      model: 'gpt-5.6-luna',
      effort: 'low',
      isolationReviewed: true,
    },
    async (_exe, args, payload, _cwd, env) => {
      calls++;
      assert.deepEqual(args, []);
      assert.equal(env['CODEX_HOME'], undefined);
      assert.equal(env['PATH'], undefined);
      const request = JSON.parse(payload);
      assert.equal(request.version, 1);
      assert.equal(request.model, 'gpt-5.6-luna');
      assert.deepEqual(Object.keys(request.input).sort(), ['choices', 'instruction', 'text']);
      assert.equal(request.input.text, 'Synthetic note to file');
      return '{"keys":["1"]}';
    },
  );
  const f = await fixture(provider);
  try {
    const note = f.note();
    await f.api('/api/filing-advice/settings', {
      expectedRevision: 0,
      preferences: { enabled: true, automatic: false, scopeIds: [f.shared], destinationTitles: false },
    });
    const request = { expectedRevision: note.revision, expectedAttempt: 0, destinationIds: [] };
    const response = await f.api(`/api/inbox/${note.inboxId}/filing-advice`, request);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().review.choices, [{ kind: 'category', category: 'shopping' }]);
    await f.api(`/api/inbox/${note.inboxId}/filing-advice`, request);
    assert.equal(calls, 1);
    assert.equal(f.service.inbox.get(f.a, note.inboxId).text, note.text);
    assert.equal(f.service.inbox.get(f.a, note.inboxId).revision, note.revision);
  } finally {
    await f.close();
  }
});

test('disabled by default; consent is profile-owned and cannot grant another private scope', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return ['0'];
  });
  try {
    const note = f.note();
    const settings = (await f.api('/api/filing-advice/settings')).json();
    assert.equal(settings.enabled, false);
    assert.deepEqual(settings.scopeIds, []);
    const request = { expectedRevision: 1, expectedAttempt: 0, destinationIds: [] };
    assert.equal(
      (await f.api(`/api/inbox/${note.inboxId}/filing-advice`, request)).json().code,
      'filing_suggestions_disabled',
    );
    const save = {
      expectedRevision: 0,
      preferences: { enabled: true, automatic: false, scopeIds: [f.shared], destinationTitles: false },
    };
    assert.equal((await f.api('/api/filing-advice/settings', save)).statusCode, 200);
    assert.equal((await f.api('/api/filing-advice/settings', save)).json().code, 'revision_conflict');
    assert.equal(
      (
        await f.api(
          '/api/filing-advice/settings',
          { ...save, preferences: { ...save.preferences, scopeIds: [f.privateScope] } },
          'b',
        )
      ).statusCode,
      400,
    );
    assert.equal((await f.api('/api/filing-advice/settings', undefined, 'b')).json().enabled, false);
    assert.equal(
      (await f.api(`/api/inbox/${note.inboxId}/filing-advice`, request)).json().review.state,
      'complete',
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test('no provider means no processing, even with saved consent; HTTP rejects foreign origins', async () => {
  const f = await fixture();
  try {
    const n = f.note();
    const payload = {
      expectedRevision: 0,
      preferences: { enabled: true, automatic: false, scopeIds: [f.shared], destinationTitles: false },
    };
    assert.equal((await f.api('/api/filing-advice/settings', payload)).json().configured, false);
    assert.equal(
      (
        await f.api(`/api/inbox/${n.inboxId}/filing-advice`, {
          expectedRevision: 1,
          expectedAttempt: 0,
          destinationIds: [],
        })
      ).json().code,
      'filing_provider_not_configured',
    );
    assert.equal(
      (
        await f.service.app.inject({
          method: 'POST',
          url: '/api/filing-advice/settings',
          payload,
          headers: { cookie: `our_place_session=${'a'.repeat(43)}`, origin: 'https://example.com' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test('bounded provider input excludes media, source metadata, page bodies and IDs; filing data stays unchanged', async () => {
  const f = await fixture();
  try {
    const note = f.note(),
      target = f.project();
    let input: FilingAdviceInput | undefined;
    const service = f.advice(async (value) => {
      input = value;
      return ['3', '0'];
    }, true);
    const before = f.snapshot();
    const result = await service.suggest(f.a, note.inboxId, 1, [target]);
    assert.equal(result?.state, 'complete');
    assert.equal(result?.choices.length, 2);
    assert.deepEqual(Object.keys(input!), ['instruction', 'text', 'choices']);
    assert.deepEqual(input!.choices.at(-1), { key: '3', label: 'Project: Synthetic project' });
    assert.ok(!JSON.stringify(input).includes(target));
    assert.ok(!JSON.stringify(input).includes('Do not export'));
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.service.inbox.get(f.a, note.inboxId), note);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('in-flight, duplicate and reopened-database requests do not repeat dispatch', async () => {
  const f = await fixture();
  try {
    const n = f.note();
    let calls = 0;
    let finish!: (v: unknown) => void;
    const provider: FilingAdviceProvider = () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const s = f.advice(provider);
    const first = s.suggest(f.a, n.inboxId, 1);
    assert.equal((await s.suggest(f.a, n.inboxId, 1))?.state, 'attempted');
    finish(['0']);
    await first;
    const reopened = openDatabase(f.db.name);
    try {
      const next = new InboxFilingSuggestions(reopened, f.service.inbox, f.records, provider, {
        scopeIds: [f.shared],
        destinationTitles: false,
      });
      assert.equal((await next.suggest(f.a, n.inboxId, 1))?.state, 'complete');
    } finally {
      reopened.close();
    }
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test('invalid responses and provider errors store no free text; retries require a matching explicit attempt', async () => {
  const f = await fixture();
  try {
    for (const response of [
      ['99'],
      ['0', '0'],
      ['0', '1', '2', '3'],
      { secret: 'synthetic sensitive text' },
    ]) {
      const n = f.note();
      assert.equal((await f.advice(async () => response).suggest(f.a, n.inboxId, 1))?.state, 'failed');
    }
    const n = f.note();
    let calls = 0;
    const s = f.advice(async () => {
      calls++;
      if (calls === 1) throw new Error('synthetic sensitive text');
      return ['1'];
    });
    await s.suggest(f.a, n.inboxId, 1);
    await s.suggest(f.a, n.inboxId, 1);
    assert.equal(calls, 1);
    assert.equal((await s.suggest(f.a, n.inboxId, 1, [], Date.now(), 1))?.attempt, 2);
    await s.suggest(f.a, n.inboxId, 1, [], Date.now(), 1);
    assert.equal(calls, 2);
    assert.ok(
      !JSON.stringify(f.db.prepare('SELECT * FROM inbox_filing_suggestions').all()).includes(
        'synthetic sensitive text',
      ),
    );
  } finally {
    await f.close();
  }
});

test('scope, content limits and category checks run before any provider call', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const p = async () => {
      calls++;
      return ['0'];
    };
    const shared = f.note(),
      privateNote = f.note(f.privateScope),
      suggestion = f.note(f.shared, 'app_suggestion');
    await assert.rejects(f.advice(p).suggest(f.a, privateNote.inboxId, 1), /scope_not_permitted/);
    await assert.rejects(f.advice(p).suggest(f.b, privateNote.inboxId, 1));
    assert.throws(() => f.advice(p).review(f.b, privateNote.inboxId));
    await assert.rejects(f.advice(p).suggest(f.a, suggestion.inboxId, 1), /not_uncategorized/);
    await assert.rejects(f.advice(p).suggest(f.a, shared.inboxId, 2), /revision_conflict/);
    await assert.rejects(
      f.advice(p).suggest(f.a, shared.inboxId, 1, [f.project()]),
      /destination_context_not_permitted/,
    );
    await assert.rejects(
      f.advice(p, true).suggest(f.a, shared.inboxId, 1, [f.project(f.privateScope)]),
      /suggestion_target_unavailable/,
    );
    f.db.prepare('UPDATE inbox_entries SET text=? WHERE inbox_id=?').run('x'.repeat(8001), shared.inboxId);
    await assert.rejects(f.advice(p).suggest(f.a, shared.inboxId, 1), /suggestion_text_limit/);
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test('source changes and consent revocation discard asynchronous results; destination revisions guard acceptance', async () => {
  const f = await fixture();
  try {
    const n = f.note(),
      target = f.project();
    const s = f.advice(async () => {
      f.db.prepare('UPDATE records SET revision=revision+1 WHERE record_id=?').run(n.inboxId);
      return ['0'];
    });
    assert.equal((await s.suggest(f.a, n.inboxId, 1))?.state, 'stale');
    const revoked = new InboxFilingSuggestions(
      f.db,
      f.service.inbox,
      f.records,
      async () => ['0'],
      { scopeIds: [f.shared], destinationTitles: false },
      () => false,
    );
    const other = f.note();
    assert.equal((await revoked.suggest(f.a, other.inboxId, 1))?.state, 'stale');
    const source = f.note(),
      good = f.advice(async () => ['3'], true);
    await good.suggest(f.a, source.inboxId, 1, [target]);
    f.db.prepare('UPDATE records SET revision=revision+1 WHERE record_id=?').run(target);
    assert.deepEqual(good.review(f.a, source.inboxId)?.choices, []);
    const outcome = f.run('FileInboxEntry', {
      inboxId: source.inboxId,
      expectedRevision: 1,
      destination: { kind: 'existing', recordId: target, expectedRevision: 1 },
    });
    assert.equal(outcome.status, 'Rejected');
    assert.equal(f.service.inbox.get(f.a, source.inboxId).filedAt, null);
  } finally {
    await f.close();
  }
});

test('automatic worker discovers scoped destinations, processes one item per tick and never repeats old attempts', async () => {
  const inputs: FilingAdviceInput[] = [];
  const f = await fixture(async (input) => {
    inputs.push(input);
    return input.choices.length > 3 ? ['3'] : ['0'];
  });
  try {
    // Exclude the historical synthetic fixture from this queue scenario.
    f.db.prepare('UPDATE inbox_entries SET filed_at=1').run();
    const first = f.note(),
      second = f.note(),
      hidden = f.note(f.privateScope);
    f.note(f.shared, 'app_suggestion');
    const target = f.project();
    f.project(f.privateScope);
    const worker = f.service.filingAdviceWorker;
    assert.equal(await worker.tick(), false);
    const preferences = { enabled: true, automatic: true, scopeIds: [f.shared], destinationTitles: true };
    assert.equal(
      (await f.api('/api/filing-advice/settings', { expectedRevision: 0, preferences })).statusCode,
      200,
    );
    await Promise.all([worker.tick(), worker.tick()]);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.choices.length, 4); // Three categories and one same-scope project.
    await worker.tick();
    assert.equal(inputs.length, 2);
    assert.equal(await worker.tick(), false);
    assert.equal(
      f.db.prepare('SELECT * FROM inbox_filing_suggestions WHERE inbox_id=?').get(hidden.inboxId),
      undefined,
    );
    const snapshot = (await f.api('/api/cache/inbox')).json();
    assert.deepEqual(snapshot.entries.find((e: any) => e.inboxId === first.inboxId).filingAdvice, {
      state: 'complete',
      count: 1,
      attempt: 1,
      choices: [{ kind: 'existing', recordId: target, revision: 1 }],
      context: { mode: 'recent', eligibleCount: 1, includedCount: 1, limited: false },
    });
    f.db.prepare('UPDATE records SET revision=revision+1 WHERE record_id=?').run(second.inboxId);
    assert.equal(await worker.tick(), false);
    assert.equal(inputs.length, 2);
    f.note();
    await f.api('/api/filing-advice/settings', {
      expectedRevision: 1,
      preferences: { ...preferences, enabled: false },
    });
    assert.equal(await worker.tick(), false);
    await f.api('/api/filing-advice/settings', { expectedRevision: 2, preferences });
    f.service.access.logout(f.a);
    assert.equal(await worker.tick(), false);
  } finally {
    await f.close();
  }
});

test('automatic worker remains disabled without provider despite consent', async () => {
  const f = await fixture();
  try {
    await f.api('/api/filing-advice/settings', {
      expectedRevision: 0,
      preferences: { enabled: true, automatic: true, scopeIds: [f.shared], destinationTitles: true },
    });
    assert.equal(await f.service.filingAdviceWorker.tick(), false);
    assert.deepEqual(f.db.prepare('SELECT * FROM inbox_filing_suggestions').all(), []);
  } finally {
    await f.close();
  }
});

test('automatic discovery truncates a long valid destination label without consuming the note as failed or changing its title', async () => {
  let received: FilingAdviceInput | undefined;
  const f = await fixture(async (input) => {
    received = input;
    return ['3'];
  });
  try {
    f.db.prepare('UPDATE inbox_entries SET filed_at=1').run();
    const n = f.note(),
      title = 'Synthetic long destination '.repeat(10),
      target = f.project(f.shared, title);
    await f.api('/api/filing-advice/settings', {
      expectedRevision: 0,
      preferences: { enabled: true, automatic: true, scopeIds: [f.shared], destinationTitles: true },
    });
    assert.equal(await f.service.filingAdviceWorker.tick(), true);
    assert.equal(received!.choices[3]!.label, ('Project: ' + title).slice(0, 200));
    assert.equal(f.records.get(f.a, target).content.title, title);
    const review = f.advice(async () => []).review(f.a, n.inboxId);
    assert.equal(review?.state, 'complete');
    assert.deepEqual(review?.choices, [{ kind: 'existing', recordId: target, revision: 1 }]);
    assert.equal(f.service.inbox.get(f.a, n.inboxId).filedAt, null);
  } finally {
    await f.close();
  }
});

test('timeout aborts the provider and uncertain attempts only retry explicitly after the grace period', async (t) => {
  const f = await fixture();
  try {
    const n = f.note();
    let signal: AbortSignal | undefined;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const s = f.advice(async (_input, received) => {
      signal = received;
      return new Promise(() => {});
    });
    const work = s.suggest(f.a, n.inboxId, 1);
    t.mock.timers.tick(30_001);
    assert.equal((await work)?.state, 'failed');
    assert.equal(signal!.aborted, true);
    t.mock.timers.reset();
    f.db
      .prepare("UPDATE inbox_filing_suggestions SET state='attempted',attempted_at=1000 WHERE inbox_id=?")
      .run(n.inboxId);
    const resumed = f.advice(async () => ['0']);
    await assert.rejects(resumed.suggest(f.a, n.inboxId, 1, [], 2000, 1), /suggestion_still_running/);
    assert.equal((await resumed.suggest(f.a, n.inboxId, 1, [], 61_001, 1))?.attempt, 2);
    f.db.exec('BEGIN');
    await assert.rejects(resumed.suggest(f.a, n.inboxId, 1), /independent transaction/);
    f.db.exec('ROLLBACK');
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('Secure defaults off; authenticated, revision-guarded changes survive content edits and reopen', async () => {
  const f = await fixture();
  try {
    const n = f.note(f.privateScope),
      path = `/api/records/${n.inboxId}/security`;
    assert.deepEqual((await f.api(path)).json(), { secure: false, effective: false, revision: 0 });
    assert.equal((await f.api(path, undefined, 'b')).statusCode, 404);
    const save = { secure: true, expectedRevision: 0, expectedServerEpoch: 'fixture-epoch' };
    assert.equal((await f.api(path, save, 'b')).statusCode, 404);
    assert.equal(
      (await f.api(path, { ...save, expectedServerEpoch: 'old-epoch' })).json().code,
      'recovery_required',
    );
    const before = f.snapshot();
    assert.deepEqual((await f.api(path, save)).json(), { secure: true, effective: true, revision: 1 });
    assert.deepEqual(f.snapshot(), before);
    assert.equal((await f.api(path, save)).json().code, 'revision_conflict');
    const edit = f.run('SetInboxEntryText', {
      inboxId: n.inboxId,
      expectedRevision: 1,
      text: 'Edited synthetic note',
    });
    assert.equal(edit.status, 'Applied');
    if (edit.status === 'Applied')
      assert.equal(f.run('UndoChangeSet', { changeSetId: edit.changeSetId }).status, 'Applied');
    assert.equal((await f.api(path)).json().effective, true);
    const reopened = openDatabase(f.db.name);
    try {
      assert.ok(reopened.prepare('SELECT 1 FROM secure_records WHERE record_id=?').get(n.inboxId));
    } finally {
      reopened.close();
    }
    await assert.rejects(
      f
        .advice(
          async () => {
            throw Error('must not call');
          },
          false,
          [f.privateScope],
        )
        .suggest(f.a, n.inboxId, f.service.inbox.get(f.a, n.inboxId).revision),
      /secure_record_excluded/,
    );
    assert.equal(
      f.db.prepare('SELECT * FROM inbox_filing_suggestions WHERE inbox_id=?').get(n.inboxId),
      undefined,
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('Secure project protects nested pages and filed notes; own flags and safe siblings stay independent', async () => {
  const f = await fixture();
  try {
    const projectId = f.project(),
      safe = f.project(),
      pageId = randomUUID(),
      childId = randomUUID();
    for (const [id, parent] of [
      [pageId, null],
      [childId, pageId],
    ])
      assert.equal(
        f.run('CreateProjectPage', {
          recordId: id,
          projectId,
          parentPageId: parent,
          title: 'Protected synthetic page',
          blocks: [],
        }).status,
        'Applied',
      );
    const n = f.note();
    assert.equal(
      f.run('FileInboxEntry', {
        inboxId: n.inboxId,
        expectedRevision: 1,
        destination: { kind: 'existing', recordId: childId },
      }).status,
      'Applied',
    );
    assert.equal(f.run('ReturnInboxEntry', { inboxId: n.inboxId, expectedRevision: 2 }).status, 'Applied');
    const set = (id: string, secure: boolean, expectedRevision = 0) =>
      f.api(`/api/records/${id}/security`, {
        secure,
        expectedRevision,
        expectedServerEpoch: 'fixture-epoch',
      });
    await set(projectId, true);
    for (const id of [projectId, pageId, childId, n.inboxId])
      assert.equal((await f.api(`/api/records/${id}/security`)).json().effective, true);
    assert.equal((await f.api(`/api/records/${safe}/security`)).json().effective, false);
    await set(childId, false);
    assert.equal((await f.api(`/api/records/${childId}/security`)).json().effective, true);
    await set(pageId, true);
    await set(projectId, false, 1);
    assert.equal((await f.api(`/api/records/${childId}/security`)).json().effective, true);
    const source = f.note();
    let input: FilingAdviceInput | undefined;
    const service = f.advice(async (value) => {
      input = value;
      return ['3'];
    }, true);
    await service.suggest(f.a, source.inboxId, 1, [childId, safe]);
    assert.deepEqual(
      input!.choices.map((c) => c.label),
      ['tasks', 'shopping', 'projects', 'Project: Synthetic project'],
    );
    assert.equal(service.review(f.a, source.inboxId)?.state, 'complete');
    await assert.rejects(service.suggest(f.a, n.inboxId, 3), /secure_record_excluded/);
    await set(pageId, false, 1);
    assert.equal((await f.api(`/api/records/${n.inboxId}/security`)).json().effective, false);
  } finally {
    await f.close();
  }
});

test('secure capture is protected atomically; automatic discovery skips it without consuming deduplication', async () => {
  const inputs: FilingAdviceInput[] = [];
  const f = await fixture(async (input) => {
    inputs.push(input);
    return ['0'];
  });
  try {
    f.db.prepare('UPDATE inbox_entries SET filed_at=1').run();
    const id = randomUUID();
    assert.equal(
      f.run('CreateInboxEntry', {
        inboxId: id,
        scopeId: f.shared,
        text: 'Synthetic secure capture',
        capturedAt: f.now(),
        source: { kind: 'typed' },
        attachments: [],
        secure: true,
      }).status,
      'Applied',
    );
    const project = f.project(f.shared, 'Excluded synthetic title');
    await f.api(`/api/records/${project}/security`, {
      secure: true,
      expectedRevision: 0,
      expectedServerEpoch: 'fixture-epoch',
    });
    f.note();
    await f.api('/api/filing-advice/settings', {
      expectedRevision: 0,
      preferences: { enabled: true, automatic: true, scopeIds: [f.shared], destinationTitles: true },
    });
    assert.equal(await f.service.filingAdviceWorker.tick(), true);
    assert.equal(await f.service.filingAdviceWorker.tick(), false);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.text, 'Synthetic note to file');
    assert.equal(inputs[0]!.choices.length, 3);
    assert.equal(f.db.prepare('SELECT * FROM inbox_filing_suggestions WHERE inbox_id=?').get(id), undefined);
    await f.api(`/api/records/${id}/security`, {
      secure: false,
      expectedRevision: 1,
      expectedServerEpoch: 'fixture-epoch',
    });
    assert.equal(await f.service.filingAdviceWorker.tick(), true);
    assert.equal(inputs.length, 2);
  } finally {
    await f.close();
  }
});

test('Secure changes invalidate saved and in-flight advice even when toggled off before the response', async () => {
  const f = await fixture();
  try {
    const n = f.note(),
      target = f.project();
    let finish!: (value: unknown) => void;
    const service = f.advice(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      true,
    );
    const work = service.suggest(f.a, n.inboxId, 1, [target]);
    const path = `/api/records/${target}/security`;
    await f.api(path, { secure: true, expectedRevision: 0, expectedServerEpoch: 'fixture-epoch' });
    await f.api(path, { secure: false, expectedRevision: 1, expectedServerEpoch: 'fixture-epoch' });
    finish(['3']);
    assert.equal((await work)?.state, 'stale');
    assert.deepEqual(service.review(f.a, n.inboxId)?.choices, []);
    const saved = f.advice(async () => ['3'], true);
    await saved.suggest(f.a, n.inboxId, 1, [target], Date.now(), 1);
    assert.equal(saved.review(f.a, n.inboxId)?.state, 'complete');
    await f.api(path, { secure: true, expectedRevision: 2, expectedServerEpoch: 'fixture-epoch' });
    assert.equal(saved.review(f.a, n.inboxId)?.state, 'stale');
    await f.api(path, { secure: false, expectedRevision: 3, expectedServerEpoch: 'fixture-epoch' });
    assert.deepEqual(saved.review(f.a, n.inboxId)?.choices, []);
  } finally {
    await f.close();
  }
});

test('manual discovery includes bounded permitted titles and excludes other scopes and Secure records', async () => {
  let received: FilingAdviceInput | undefined;
  const f = await fixture(async (input) => {
    received = input;
    return ['1'];
  });
  try {
    f.project(f.privateScope, 'Private excluded destination');
    const secure = f.project(f.shared, 'Secure excluded destination');
    f.db.prepare('INSERT INTO record_security VALUES (?,1,1)').run(secure);
    for (let i = 0; i < 25; i++) f.project(f.shared, 'Allowed destination ' + i);
    const n = f.note();
    await f.api('/api/filing-advice/settings', {
      expectedRevision: 0,
      preferences: { enabled: true, automatic: false, scopeIds: [f.shared], destinationTitles: true },
    });
    const result = await f.api(`/api/inbox/${n.inboxId}/filing-advice`, {
      expectedRevision: 1,
      expectedAttempt: 0,
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().review.state, 'complete');
    assert.equal(received!.choices.length, 28);
    assert.ok(received!.choices.slice(3).every((c) => c.label.startsWith('Project: Allowed destination')));
    await f.api('/api/filing-advice/settings', {
      expectedRevision: 1,
      preferences: { enabled: true, automatic: false, scopeIds: [f.shared], destinationTitles: false },
    });
    const second = f.note();
    await f.api(`/api/inbox/${second.inboxId}/filing-advice`, { expectedRevision: 1, expectedAttempt: 0 });
    assert.deepEqual(
      received!.choices.map((c) => c.label),
      ['tasks', 'shopping', 'projects'],
    );
  } finally {
    await f.close();
  }
});

test('recent discovery offers 1000 titles; explicit broader search includes older destinations and deduplicates retries', async () => {
  const inputs: FilingAdviceInput[] = [];
  const f = await fixture(async (input) => {
    inputs.push(input);
    return [input.choices.find((c) => c.label === 'Project: Older perfect match')?.key ?? '1'];
  });
  try {
    const old = f.project(f.shared, 'Older perfect match');
    f.db.prepare('UPDATE records SET updated_at=0 WHERE record_id=?').run(old);
    for (let i = 0; i < 1000; i++) f.project(f.shared, `Recent destination ${i}`);
    const note = f.note();
    await f.api('/api/filing-advice/settings', {
      expectedRevision: 0,
      preferences: { enabled: true, automatic: false, destinationTitles: true, scopeIds: [f.shared] },
    });
    const path = `/api/inbox/${note.inboxId}/filing-advice`;
    const recent = (await f.api(path, { expectedRevision: 1, expectedAttempt: 0 })).json().review;
    assert.equal(inputs[0]!.choices.length, 1003);
    assert.deepEqual(recent.context, {
      mode: 'recent',
      eligibleCount: 1001,
      includedCount: 1000,
      limited: true,
    });
    const request = { expectedRevision: 1, expectedAttempt: 1, search: 'all' };
    const broader = (await f.api(path, request)).json().review;
    assert.equal(inputs[1]!.choices.length, 1004);
    assert.deepEqual(broader.choices, [{ kind: 'existing', recordId: old, revision: 1 }]);
    assert.deepEqual(broader.context, {
      mode: 'all',
      eligibleCount: 1001,
      includedCount: 1001,
      limited: false,
    });
    assert.deepEqual((await f.api(path, request)).json().review, broader);
    assert.equal(inputs.length, 2);
    assert.equal(f.service.inbox.get(f.a, note.inboxId).filedAt, null);
  } finally {
    await f.close();
  }
});

test('broader context is bounded and reports omitted titles honestly', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 1205; i++) f.project(f.shared, `${i} ` + 'Long title '.repeat(25));
    const note = f.note();
    const service = f.advice(async (input) => {
      assert(input.choices.reduce((n, c) => n + c.label.length, 0) <= 240024);
      return ['1'];
    }, true);
    const selection = service.discover(f.a, note.inboxId, 'all');
    const result = await service.suggest(f.a, note.inboxId, 1, selection.ids, Date.now(), 0, selection);
    assert.deepEqual(result?.context, {
      mode: 'all',
      eligibleCount: 1205,
      includedCount: 1200,
      limited: true,
    });
  } finally {
    await f.close();
  }
});

test('completed and cancelled tasks are excluded; a recurring task with another open occurrence remains eligible', async () => {
  const f = await fixture();
  try {
    const tasks = ['open', 'completed', 'cancelled', 'recurring'].map((title) => {
      const recordId = randomUUID(),
        occurrenceId = randomUUID();
      assert.equal(
        f.run('CreateTask', {
          recordId,
          occurrenceId,
          scopeId: f.shared,
          title,
          instructions: '',
          context: 'home',
          defaultAssigneeId: null,
          defaultPriority: 1,
          recurrence:
            title === 'recurring'
              ? { version: 1, mode: 'after_completion', count: 1, unit: 'days', timeZone: 'UTC' }
              : null,
          assigneeId: null,
          priority: 1,
          deadlineDate: null,
          targetDate: null,
          reviewDate: null,
        }).status,
        'Applied',
      );
      return { recordId, occurrenceId };
    });
    const complete = (index: number, recurring = false) => {
      const result = f.run('CompleteTaskOccurrence', {
        recordId: tasks[index]!.occurrenceId,
        expectedRevision: 1,
        expectedTaskRevision: 1,
        completionId: randomUUID(),
        nextOccurrenceId: recurring ? randomUUID() : null,
        completedAt: f.now(),
        performedByPersonId: f.a.personId,
        note: '',
      });
      assert.equal(result.status, 'Applied', JSON.stringify(result));
    };
    complete(1);
    complete(3, true);
    assert.equal(
      f.run('DeleteTask', {
        recordId: tasks[2]!.recordId,
        expectedRevision: 1,
        occurrence: { recordId: tasks[2]!.occurrenceId, expectedRevision: 1 },
      }).status,
      'Applied',
    );
    const n = f.note(),
      s = f.advice(async () => ['3'], true);
    const ids = s.discover(f.a, n.inboxId).ids;
    assert.deepEqual(new Set(ids), new Set([tasks[0]!.recordId, tasks[3]!.recordId]));
    await s.suggest(f.a, n.inboxId, 1, [tasks[0]!.recordId]);
    complete(0);
    assert.equal(s.review(f.a, n.inboxId)?.state, 'stale');
  } finally {
    await f.close();
  }
});
