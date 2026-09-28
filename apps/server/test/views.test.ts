import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  defaultAgendaLayout,
  navigationSections,
  emptyRecipeFields,
  type CommandKind,
  type CommandOutcome,
} from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { ViewPreferences } from '../src/features/views/views.js';

function applied(result: CommandOutcome) {
  assert.equal(result.status, 'Applied', JSON.stringify(result));
  if (result.status !== 'Applied') throw new Error();
  return result;
}
function rejected(result: CommandOutcome, code: string) {
  assert.equal(result.status, 'Rejected', JSON.stringify(result));
  if (result.status === 'Rejected') assert.equal(result.code, code);
}
async function fixture() {
  const f = await integrationFixture(),
    service = await buildApp({
      db: f.db,
      dataRoot: f.dataRoot,
      development: true,
      publicOrigin: 'http://localhost',
      now: f.now,
    });
  const a = service.access.authenticate('a'.repeat(43)),
    b = service.access.authenticate('b'.repeat(43)),
    views = new ViewPreferences(f.db, service.access);
  const shared = service.access.scopes(a).find((s) => s.kind === 'shared')!.scopeId,
    privateScope = service.access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
  const envelope = (args: unknown) => ({
    operationId: randomUUID(),
    contractVersion: 1 as const,
    expectedServerEpoch: 'fixture-epoch',
    arguments: args,
  });
  const run = (kind: CommandKind, args: unknown, c = a) => service.writes.execute(c, kind, envelope(args));
  const project = (scopeId = shared) => {
    const id = randomUUID();
    applied(run('CreateProject', { recordId: id, scopeId, title: 'Garden', description: '' }));
    return id;
  };
  const note = (scopeId = shared) => {
    const id = randomUUID();
    applied(
      run('CreateInboxEntry', {
        inboxId: id,
        scopeId,
        text: 'Plant flowers',
        capturedAt: f.now(),
        source: { kind: 'typed' },
        attachments: [],
      }),
    );
    return id;
  };
  const view = (projectId: string) =>
    views.snapshot(a).find((v) => v.kind === 'project_next' && v.projectId === projectId);
  const pin = (projectId: string, recordId: string, pinned = true, scopeId = shared) =>
    run('SetRecordPin', {
      projectId,
      recordId,
      pinned,
      scopeId,
      viewKind: 'project_next',
      expectedViewRevision: view(projectId)?.revision ?? 0,
    });
  return {
    ...f,
    service,
    a,
    b,
    views,
    shared,
    privateScope,
    envelope,
    run,
    project,
    note,
    view,
    pin,
    close: async () => {
      await service.app.close();
      await f.close();
    },
  };
}

test('personal agenda layouts isolate profiles, reject stale edits and commit atomically with replayable receipts', async () => {
  const f = await fixture();
  try {
    f.note();
    const contentTables = ['records', 'record_changes', 'change_sets'];
    const before = contentTables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
    const layout = defaultAgendaLayout();
    layout.context = 'work';
    layout.days = 30;
    layout.sections.reverse();
    layout.sections[0]!.enabled = true;
    const args = { scopeId: f.privateScope, expectedViewRevision: 0, layout },
      command = f.envelope(args);
    rejected(f.run('SetAgendaLayout', { ...args, scopeId: f.shared }), 'private_view_required');
    rejected(f.run('SetAgendaLayout', command.arguments, f.b), 'private_view_required');
    const saved = applied(f.service.writes.execute(f.a, 'SetAgendaLayout', command));
    assert.equal(saved.changeSetId, undefined);
    assert.deepEqual(f.service.writes.execute(f.a, 'SetAgendaLayout', command), { ...saved, replayed: true });
    const view = f.views.snapshot(f.a).find((v) => v.kind === 'agenda')!;
    assert.equal(view.revision, 1);
    assert.deepEqual(view.kind === 'agenda' && view.layout, layout);
    assert.deepEqual(view.pins, []);
    assert.equal(
      f.views.snapshot(f.b).some((v) => v.kind === 'agenda'),
      false,
    );
    for (const [i, table] of contentTables.entries())
      assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), before[i]);
    rejected(f.run('SetAgendaLayout', command.arguments), 'view_revision_conflict');
    rejected(
      f.run('SetViewPinOrder', { viewId: view.viewId, expectedViewRevision: 1, recordIds: [] }),
      'view_does_not_support_pins',
    );
    const updated = f.envelope({
      ...args,
      expectedViewRevision: 1,
      layout: defaultAgendaLayout(),
    });
    f.db.exec(
      "CREATE TEMP TRIGGER reject_layout_receipt BEFORE INSERT ON operation_receipts BEGIN SELECT RAISE(ABORT,'injected layout commit failure'); END",
    );
    assert.throws(
      () => f.service.writes.execute(f.a, 'SetAgendaLayout', updated),
      /injected layout commit failure/,
    );
    assert.deepEqual(
      f.views.snapshot(f.a).find((v) => v.kind === 'agenda'),
      view,
    );
    f.db.exec('DROP TRIGGER reject_layout_receipt');
    applied(f.service.writes.execute(f.a, 'SetAgendaLayout', updated));
    assert.equal(f.views.snapshot(f.a).find((v) => v.kind === 'agenda')!.revision, 2);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.throws(
      () =>
        f.db
          .prepare(
            "INSERT INTO saved_views(view_id,scope_id,kind,revision,layout_json) VALUES (?,?,'agenda',1,?)",
          )
          .run(randomUUID(), f.shared, JSON.stringify(layout)),
      /private scope/,
    );
  } finally {
    await f.close();
  }
});

test('agenda layout validation rejects duplicate sections and invalid limits without changing saved preferences', async () => {
  const f = await fixture();
  try {
    const layout = defaultAgendaLayout();
    applied(f.run('SetAgendaLayout', { scopeId: f.privateScope, expectedViewRevision: 0, layout }));
    const before = f.views.snapshot(f.a);
    const duplicate = structuredClone(layout);
    duplicate.sections[0]!.kind = 'calendar';
    rejected(
      f.run('SetAgendaLayout', { scopeId: f.privateScope, expectedViewRevision: 1, layout: duplicate }),
      'invalid_agenda_sections',
    );
    for (const limit of [0, 101, 1.5, '6', null]) {
      const invalid = { ...layout, sections: layout.sections.map((s, i) => (i === 0 ? { ...s, limit } : s)) };
      rejected(
        f.run('SetAgendaLayout', { scopeId: f.privateScope, expectedViewRevision: 1, layout: invalid }),
        'invalid_arguments',
      );
    }
    assert.deepEqual(f.views.snapshot(f.a), before);
  } finally {
    await f.close();
  }
});

test('project pins order references without revising the project or targets; stale and interrupted operations remain safe', async () => {
  const f = await fixture();
  try {
    const project = f.project(),
      one = f.note(),
      two = f.note(),
      other = f.project();
    const histories = [project, one, two].map((id) =>
      f.service.history.list(f.a, id, id === project ? 'project' : 'inbox'),
    );
    applied(f.pin(project, one));
    applied(f.pin(project, two));
    applied(f.pin(other, two));
    const view = f.view(project)!;
    const command = f.envelope({
      viewId: view.viewId,
      expectedViewRevision: view.revision,
      recordIds: [two, one],
    });
    const reordered = applied(f.service.writes.execute(f.b, 'SetViewPinOrder', command));
    assert.deepEqual(f.service.writes.execute(f.b, 'SetViewPinOrder', command), {
      ...reordered,
      replayed: true,
    });
    assert.deepEqual(
      f.view(project)!.pins.map((p) => p.recordId),
      [two, one],
    );
    assert.deepEqual(
      f.view(other)!.pins.map((p) => p.recordId),
      [two],
    );
    rejected(f.run('SetViewPinOrder', command.arguments), 'view_revision_conflict');
    const next = f.view(project)!;
    for (const recordIds of [[one, one], [one], [one, randomUUID()]])
      rejected(
        f.run('SetViewPinOrder', { viewId: next.viewId, expectedViewRevision: next.revision, recordIds }),
        'view_pins_changed',
      );
    for (const [i, id] of [project, one, two].entries())
      assert.deepEqual(f.service.history.list(f.a, id, id === project ? 'project' : 'inbox'), histories[i]);
    const before = f.views.snapshot(f.a);
    f.db.exec(
      "CREATE TEMP TRIGGER reject_pin_receipt BEFORE INSERT ON operation_receipts BEGIN SELECT RAISE(ABORT,'injected pin commit failure'); END",
    );
    const removal = f.envelope({
      projectId: project,
      recordId: one,
      pinned: false,
      scopeId: f.shared,
      viewKind: 'project_next',
      expectedViewRevision: next.revision,
    });
    assert.throws(
      () => f.service.writes.execute(f.a, 'SetRecordPin', removal),
      /injected pin commit failure/,
    );
    assert.deepEqual(f.views.snapshot(f.a), before);
    f.db.exec('DROP TRIGGER reject_pin_receipt');
    applied(f.service.writes.execute(f.a, 'SetRecordPin', removal));
    assert.deepEqual(
      f.view(project)!.pins.map((p) => p.recordId),
      [two],
    );
  } finally {
    await f.close();
  }
});

test('private project pins can reference shared records without leaking activity; shared pins cannot refer to private records', async () => {
  const f = await fixture();
  try {
    const sharedProject = f.project(),
      privateProject = f.project(f.privateScope),
      sharedNote = f.note(),
      privateNote = f.note(f.privateScope);
    const sharedBefore = f.service.history.list(f.b, sharedNote),
      partnerViews = f.views.snapshot(f.b);
    applied(f.pin(privateProject, sharedNote, true, f.privateScope));
    applied(f.pin(privateProject, privateNote, true, f.privateScope));
    assert.deepEqual(f.views.snapshot(f.b), partnerViews);
    assert.deepEqual(f.service.history.list(f.b, sharedNote), sharedBefore);
    rejected(f.pin(sharedProject, privateNote), 'link_unavailable');
    const privateView = f.view(privateProject)!;
    rejected(
      f.run(
        'SetViewPinOrder',
        {
          viewId: privateView.viewId,
          expectedViewRevision: privateView.revision,
          recordIds: [sharedNote, privateNote],
        },
        f.b,
      ),
      'unavailable',
    );
    rejected(
      f.run('SetRecordPin', {
        projectId: privateProject,
        recordId: sharedNote,
        scopeId: f.shared,
        viewKind: 'project_next',
        expectedViewRevision: 0,
        pinned: true,
      }),
      'unavailable',
    );
    applied(f.pin(sharedProject, sharedNote));
    const sharedView = f.view(sharedProject)!;
    assert.throws(
      () =>
        f.db
          .prepare('INSERT INTO record_pins VALUES (?,?,?,?,?)')
          .run(sharedView.viewId, f.shared, privateNote, 1, f.privateScope),
      /audience/,
    );
    assert.throws(
      () =>
        f.db
          .prepare('UPDATE record_pins SET scope_id=?,view_id=? WHERE view_id=? AND record_id=?')
          .run(f.shared, sharedView.viewId, privateView.viewId, privateNote),
      /audience/,
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('pins survive target and project deletion for restoration, and deleted targets can be unpinned', async () => {
  const f = await fixture();
  try {
    const project = f.project(),
      note = f.note();
    applied(f.pin(project, note));
    const before = f.view(project)!;
    const noteDeleted = applied(f.run('DeleteInboxEntry', { inboxId: note, expectedRevision: 1 }));
    assert.deepEqual(f.view(project), before);
    applied(f.pin(project, note, false));
    assert.deepEqual(f.view(project)!.pins, []);
    rejected(f.pin(project, note), 'link_unavailable');
    applied(f.run('UndoChangeSet', { changeSetId: noteDeleted.changeSetId }));
    applied(f.pin(project, note));
    const deletion = applied(f.run('DeleteProject', { recordId: project, expectedRevision: 1, pages: [] }));
    rejected(f.pin(project, note, false), 'unavailable');
    applied(f.run('UndoChangeSet', { changeSetId: deletion.changeSetId }));
    assert.deepEqual(
      f.view(project)!.pins.map((p) => p.recordId),
      [note],
    );
    const recipeId = randomUUID();
    applied(
      f.run('CreateRecipe', {
        recordId: recipeId,
        scopeId: f.shared,
        ...emptyRecipeFields(),
        title: 'Soup',
        collectionIds: [],
      }),
    );
    applied(
      f.run('SetRecordPin', {
        recordId: recipeId,
        scopeId: f.shared,
        viewKind: 'food_soon',
        expectedViewRevision: 0,
        pinned: true,
      }),
    );
    applied(f.run('DeleteRecipe', { recordId: recipeId, expectedRevision: 1 }));
    applied(
      f.run('SetRecordPin', {
        recordId: recipeId,
        scopeId: f.shared,
        viewKind: 'food_soon',
        expectedViewRevision: 1,
        pinned: false,
      }),
    );
    assert.deepEqual(f.views.snapshot(f.a).find((v) => v.kind === 'food_soon')!.pins, []);
  } finally {
    await f.close();
  }
});
test('view pins have their own revision and scope, preserve recipe revision/history, and replay once', async () => {
  const f = await integrationFixture(),
    service = await buildApp({
      db: f.db,
      dataRoot: f.dataRoot,
      development: true,
      publicOrigin: 'http://localhost',
      now: f.now,
    });
  try {
    const a = service.access.authenticate('a'.repeat(43)),
      b = service.access.authenticate('b'.repeat(43)),
      views = new ViewPreferences(f.db, service.access),
      id = randomUUID();
    const scopeId = service.access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
    const envelope = (args: unknown) => ({
      operationId: randomUUID(),
      contractVersion: 1 as const,
      expectedServerEpoch: 'fixture-epoch',
      arguments: args,
    });
    assert.equal(
      service.writes.execute(
        a,
        'CreateRecipe',
        envelope({ recordId: id, scopeId, ...emptyRecipeFields(), title: 'Soup', collectionIds: [] }),
      ).status,
      'Applied',
    );
    const history = service.history.list(a, id, 'recipe'),
      command = envelope({
        recordId: id,
        scopeId,
        viewKind: 'food_soon',
        expectedViewRevision: 0,
        pinned: true,
      });
    const first = service.writes.execute(a, 'SetRecordPin', command);
    assert.equal(first.status, 'Applied');
    assert.deepEqual(service.writes.execute(a, 'SetRecordPin', command), { ...first, replayed: true });
    assert.equal(views.snapshot(a)[0]!.revision, 1);
    assert.equal(views.snapshot(a)[0]!.pins[0]!.recordId, id);
    assert.deepEqual(views.snapshot(b), []);
    assert.deepEqual(service.history.list(a, id, 'recipe'), history);
    assert.equal(f.db.prepare('SELECT revision FROM records WHERE record_id=?').pluck().get(id), 1);
    const conflict = service.writes.execute(
      a,
      'SetRecordPin',
      envelope({ ...(command.arguments as object), pinned: false }),
    );
    assert.equal(conflict.status, 'Rejected');
    assert.equal(views.snapshot(a)[0]!.pins.length, 1);
    assert.equal(
      service.writes.execute(
        a,
        'SetRecordPin',
        envelope({ ...(command.arguments as object), expectedViewRevision: 1, pinned: false }),
      ).status,
      'Applied',
    );
    assert.equal(views.snapshot(a)[0]!.pins.length, 0);
    assert.equal(views.snapshot(a)[0]!.revision, 2);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await service.app.close();
    await f.close();
  }
});

test('navigation order is private, validated, revision guarded and replayable without changing household data', async () => {
  const f = await fixture();
  try {
    f.note();
    const tables = ['records', 'record_changes', 'change_sets', 'clients', 'installation_state'];
    const before = tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
    const order = [...navigationSections].reverse();
    const args = { scopeId: f.privateScope, expectedViewRevision: 0, order };
    rejected(f.run('SetNavigationOrder', { ...args, scopeId: f.shared }), 'private_view_required');
    rejected(f.run('SetNavigationOrder', args, f.b), 'private_view_required');
    const command = f.envelope(args);
    const saved = applied(f.service.writes.execute(f.a, 'SetNavigationOrder', command));
    assert.deepEqual(f.service.writes.execute(f.a, 'SetNavigationOrder', command), {
      ...saved,
      replayed: true,
    });
    assert.deepEqual(
      f.views.snapshot(f.a).find((v) => v.kind === 'navigation'),
      {
        viewId: f.privateScope,
        scopeId: f.privateScope,
        kind: 'navigation',
        revision: 1,
        order,
        pins: [],
      },
    );
    assert.equal(
      f.views.snapshot(f.b).some((v) => v.kind === 'navigation'),
      false,
    );
    rejected(f.run('SetNavigationOrder', args), 'view_revision_conflict');
    for (const invalid of [
      order.slice(1),
      [...order, 'inbox'],
      order.map(() => 'inbox'),
      [...order.slice(1), 'unknown'],
    ]) {
      rejected(
        f.run('SetNavigationOrder', { ...args, expectedViewRevision: 1, order: invalid }),
        'invalid_arguments',
      );
    }
    f.db.exec(
      `CREATE TRIGGER fail_navigation BEFORE UPDATE ON navigation_preferences BEGIN SELECT RAISE(ABORT,'test interruption'); END`,
    );
    const update = f.envelope({ ...args, expectedViewRevision: 1, order: [...navigationSections] });
    assert.throws(() => f.service.writes.execute(f.a, 'SetNavigationOrder', update), /test interruption/);
    assert.equal(f.views.snapshot(f.a).find((v) => v.kind === 'navigation')!.revision, 1);
    f.db.exec('DROP TRIGGER fail_navigation');
    applied(f.service.writes.execute(f.a, 'SetNavigationOrder', update));
    assert.equal(f.views.snapshot(f.a).find((v) => v.kind === 'navigation')!.revision, 2);
    assert.deepEqual(
      tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all()),
      before,
    );
  } finally {
    await f.close();
  }
});

test('card ordering is private, category scoped, revision guarded and preserves records', async () => {
  const f = await fixture();
  try {
    const first = f.note(),
      second = f.note(),
      secret = f.note(f.privateScope);
    const tables = [
      'records',
      'inbox_entries',
      'record_changes',
      'change_sets',
      'attachments',
      'clients',
      'installation_state',
    ];
    const before = tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
    const args = {
      scopeId: f.privateScope,
      category: 'inbox',
      expectedViewRevision: 0,
      recordIds: [second, secret, first],
    };
    rejected(f.run('SetCardOrder', { ...args, scopeId: f.shared }), 'private_view_required');
    rejected(f.run('SetCardOrder', args, f.b), 'private_view_required');
    const otherScope = f.service.access.scopes(f.b).find((s) => s.kind === 'private')!.scopeId;
    rejected(f.run('SetCardOrder', { ...args, scopeId: otherScope }, f.b), 'unavailable');
    rejected(f.run('SetCardOrder', { ...args, category: 'app_suggestion' }), 'unavailable');
    rejected(f.run('SetCardOrder', { ...args, recordIds: [first, first] }), 'invalid_arguments');
    rejected(f.run('SetCardOrder', { ...args, recordIds: [randomUUID()] }), 'unavailable');
    const command = f.envelope(args);
    const saved = applied(f.service.writes.execute(f.a, 'SetCardOrder', command));
    assert.deepEqual(f.service.writes.execute(f.a, 'SetCardOrder', command), { ...saved, replayed: true });
    const read = () => f.views.snapshot(f.a).find((v) => v.kind === 'card_order' && v.category === 'inbox');
    assert.deepEqual(read(), {
      viewId: `${f.privateScope}:inbox`,
      scopeId: f.privateScope,
      kind: 'card_order',
      category: 'inbox',
      revision: 1,
      pins: [],
      recordIds: args.recordIds,
    });
    assert.equal(
      f.views.snapshot(f.b).some((v) => v.kind === 'card_order'),
      false,
    );
    rejected(f.run('SetCardOrder', args), 'view_revision_conflict');
    applied(f.run('SetCardOrder', { ...args, category: 'app_suggestion', recordIds: [] }));
    f.db.exec(
      `CREATE TRIGGER fail_card_order BEFORE UPDATE ON card_order_preferences BEGIN SELECT RAISE(ABORT,'test interruption'); END`,
    );
    const update = f.envelope({ ...args, expectedViewRevision: 1, recordIds: [first, secret, second] });
    assert.throws(() => f.service.writes.execute(f.a, 'SetCardOrder', update), /test interruption/);
    assert.equal(read()!.revision, 1);
    f.db.exec('DROP TRIGGER fail_card_order');
    applied(f.service.writes.execute(f.a, 'SetCardOrder', update));
    assert.equal(read()!.revision, 2);
    assert.deepEqual(
      tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all()),
      before,
    );
    // A previously shared card made private must disappear even from saved-order metadata.
    f.db.prepare('UPDATE records SET scope_id=? WHERE record_id=?').run(otherScope, second);
    const redacted = read();
    assert.ok(redacted?.kind === 'card_order');
    assert.deepEqual(redacted.recordIds, [first, secret]);
    rejected(f.run('SetCardOrder', { ...args, expectedViewRevision: 2 }), 'unavailable');
  } finally {
    await f.close();
  }
});
