import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyRecipeFields,
  type Attachment,
  type CommandKind,
  type CommandOutcome,
  type Envelope,
  type PageBlock,
  type ProjectPage,
} from '@our-place/contracts';
import {
  openDatabase,
  migrate,
  initialiseInstallation,
  installation,
} from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { AccessService, type HumanRequestContext } from '../src/features/access/access.js';
import { createRecordFeatures } from '../src/application/record-features.js';
import { RecordRegistry } from '../src/features/records/record-registry.js';
import { inboxRecordAdapter } from '../src/features/inbox/inbox-record.js';
import { HistoryService } from '../src/features/history/history.js';
import { WriteCoordinator } from '../src/application/write-coordinator.js';
import { NotFound, ProtocolConflict } from '../src/application/errors.js';
import { ViewPreferences } from '../src/features/views/views.js';

function applied(outcome: CommandOutcome) {
  assert.equal(outcome.status, 'Applied', JSON.stringify(outcome));
  if (outcome.status !== 'Applied') throw new Error();
  return outcome;
}
function rejected(outcome: CommandOutcome, code: string) {
  assert.equal(outcome.status, 'Rejected', JSON.stringify(outcome));
  if (outcome.status === 'Rejected') assert.equal(outcome.code, code);
}
const textBlock = (text = 'Keep the measurements here.'): PageBlock => ({
  blockId: randomUUID(),
  kind: 'text',
  text,
});
const recordBlock = (recordId: string): PageBlock => ({
  blockId: randomUUID(),
  kind: 'record_link',
  recordId,
  caption: 'Reference',
});
function fixture(migrationsPath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'our-place-projects-')),
    db = openDatabase(join(root, 'test.sqlite'));
  migrate(db, migrationsPath);
  initialiseInstallation(db);
  const people = ['Alex', 'Sam'].map((name) => {
    const c: HumanRequestContext = {
      personId: randomUUID(),
      clientId: randomUUID(),
      credentialId: randomUUID(),
      kind: 'browser',
    };
    db.prepare('INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)').run(
      c.personId,
      name,
      name,
      'fixture',
    );
    db.prepare("INSERT INTO clients(client_id,person_id,kind) VALUES (?,?,'browser')").run(
      c.clientId,
      c.personId,
    );
    db.prepare("INSERT INTO visibility_scopes VALUES (?,'private',?)").run(randomUUID(), c.personId);
    return c;
  });
  const a = people[0]!,
    b = people[1]!;
  let clock = Date.parse('2026-09-27T16:00:00Z'),
    fail = false;
  const now = () => ++clock,
    access = new AccessService(db, now);
  const services = () => {
    const features = createRecordFeatures(db, access);
    const enabled = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='projects'").get();
    const records = enabled
      ? features.records
      : new RecordRegistry(db, [
          inboxRecordAdapter(features.inbox),
          ...features.shopping.adapters(),
          ...features.tasks.adapters(),
          ...features.home.adapters(),
          ...features.recipes.adapters(),
          features.shoppingGroups.adapter(),
        ]);
    const history = new HistoryService(db, records, access);
    const writes = new WriteCoordinator(
      db,
      features.inbox,
      history,
      now,
      records,
      () => {
        if (fail) throw new Error('injected commit failure');
      },
      [
        features.shopping.commands(),
        features.shoppingGroups.commands(),
        features.recipes.commands(),
        features.tasks.commands(),
        ...(enabled ? [features.projects.commands()] : []),
      ],
    );
    return { ...features, records, history, writes };
  };
  let active = services();
  const shared = access.scopes(a).find((s) => s.kind === 'shared')!.scopeId,
    privateScope = access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
  const envelope = (args: unknown): Envelope => ({
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: installation(db).recovery_epoch,
    arguments: args,
  });
  const run = (kind: CommandKind, args: unknown, c = a) => active.writes.execute(c, kind, envelope(args));
  const get = (id: string, c = a) => active.records.get(c, id);
  const target = (id: string) => ({ recordId: id, expectedRevision: get(id).revision });
  const page = (id: string) => active.projects.project(get(id)) as ProjectPage;
  const project = (scopeId = shared) => {
    const recordId = randomUUID();
    applied(run('CreateProject', { recordId, scopeId, title: 'Kitchen', description: 'A brighter room' }));
    return recordId;
  };
  const createPage = (projectId: string, parentPageId: string | null = null, blocks: PageBlock[] = []) => {
    const recordId = randomUUID();
    applied(run('CreateProjectPage', { recordId, projectId, parentPageId, title: 'Ideas', blocks }));
    return recordId;
  };
  const edit = (id: string, blocks: PageBlock[], c = a) =>
    run('UpdateProjectPage', { ...target(id), title: page(id).title, blocks }, c);
  const note = (scopeId = shared) => {
    const inboxId = randomUUID();
    applied(
      run('CreateInboxEntry', {
        inboxId,
        scopeId,
        text: 'Measure the cupboard',
        capturedAt: now(),
        source: { kind: 'typed' },
        attachments: [],
      }),
    );
    return inboxId;
  };
  const photo = (scopeId = shared): Attachment => {
    const mediaId = randomUUID(),
      digest = 'a'.repeat(64),
      byteLength = 10,
      mimeType = 'image/png' as const;
    db.prepare("INSERT INTO media_objects VALUES (?,?,?,?,?,?,?,?,'ready',?,NULL,?)").run(
      mediaId,
      scopeId,
      a.clientId,
      digest,
      byteLength,
      mimeType,
      `synthetic/${mediaId}`,
      randomUUID(),
      now(),
      now(),
    );
    return { attachmentId: randomUUID(), mediaId, digest, byteLength, mimeType, position: 0 };
  };
  return {
    db,
    root,
    a,
    b,
    access,
    now,
    shared,
    privateScope,
    envelope,
    run,
    get,
    target,
    page,
    project,
    createPage,
    edit,
    note,
    photo,
    get active() {
      return active;
    },
    set fail(value: boolean) {
      fail = value;
    },
    upgrade() {
      migrate(db);
      active = services();
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('page edits retain ordered stable blocks, readable history and guarded per-person undo', () => {
  const f = fixture();
  try {
    const project = f.project(),
      note = f.note(),
      original: PageBlock[] = [
        textBlock(),
        {
          blockId: randomUUID(),
          kind: 'web_link',
          url: 'https://example.com/cabinet',
          title: 'Cabinet',
          notes: 'Check dimensions',
        },
        recordBlock(note),
      ];
    const page = f.createPage(project, null, original),
      reordered = [
        original[2]!,
        { ...original[0]!, text: 'Revised measurements' },
        original[1]!,
      ] as PageBlock[];
    const saved = applied(f.edit(page, reordered));
    assert.deepEqual(f.page(page).blocks, reordered);
    assert.equal(f.get(note).revision, 1);
    assert.deepEqual(
      f.active.history.list<ProjectPage>(f.a, page, 'project_page').at(-1)!.version.blocks,
      original,
    );
    const undo = applied(f.run('UndoChangeSet', { changeSetId: saved.changeSetId }));
    assert.deepEqual(f.page(page).blocks, original);
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }));
    const mine = applied(f.edit(page, [textBlock('My edit')]));
    applied(f.edit(page, [textBlock('Partner edit')], f.b));
    rejected(f.run('UndoChangeSet', { changeSetId: mine.changeSetId }), 'revision_conflict');
    rejected(f.run('UndoChangeSet', { changeSetId: mine.changeSetId }, f.b), 'unavailable');
    assert.equal(
      f.db.prepare('SELECT COUNT(*) FROM page_blocks WHERE retired_at IS NOT NULL').pluck().get(),
      4,
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.close();
  }
});

test('subtree moves preserve identities including deleted descendants and undo atomically', () => {
  const f = fixture();
  try {
    const project = f.project(),
      destination = f.project(),
      page = f.createPage(project),
      child = f.createPage(project, page),
      grandchild = f.createPage(project, child, [textBlock()]);
    applied(f.run('DeleteProjectPage', { ...f.target(grandchild), descendants: [] }));
    const content = f.page(grandchild),
      stale = f.target(child);
    applied(f.edit(child, [textBlock('Partner edit')], f.b));
    const move = () => ({
      ...f.target(page),
      projectId: destination,
      parentPageId: null,
      descendants: [f.target(child), f.target(grandchild)],
    });
    rejected(
      f.run('MoveProjectPage', { ...move(), descendants: [stale, f.target(grandchild)] }),
      'project_members_changed',
    );
    rejected(
      f.run('MoveProjectPage', { ...move(), descendants: [f.target(child)] }),
      'project_members_changed',
    );
    const saved = applied(f.run('MoveProjectPage', move()));
    assert.equal(saved.result.records.length, 3);
    for (const id of [page, child, grandchild]) assert.equal(f.page(id).projectId, destination);
    assert.equal(f.page(child).parentPageId, page);
    assert.equal(f.page(grandchild).parentPageId, child);
    assert.deepEqual(f.page(grandchild).blocks, content.blocks);
    assert.equal(f.page(grandchild).deletedAt, content.deletedAt);
    const undo = applied(f.run('UndoChangeSet', { changeSetId: saved.changeSetId }));
    for (const id of [page, child, grandchild]) assert.equal(f.page(id).projectId, project);
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }));
    for (const id of [page, child, grandchild]) assert.equal(f.page(id).projectId, destination);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.close();
  }
});

test('hierarchy rejects cycles, wrong-project parents, private moves and inconsistent undo', () => {
  const f = fixture();
  try {
    const project = f.project(),
      other = f.project(),
      privateProject = f.project(f.privateScope),
      page = f.createPage(project),
      child = f.createPage(project, page),
      otherPage = f.createPage(other);
    const move = (projectId: string, parentPageId: string | null) => ({
      ...f.target(page),
      projectId,
      parentPageId,
      descendants: [f.target(child)],
    });
    rejected(f.run('MoveProjectPage', move(project, page)), 'page_cycle');
    rejected(f.run('MoveProjectPage', move(project, child)), 'page_cycle');
    rejected(f.run('MoveProjectPage', move(project, otherPage)), 'page_parent_unavailable');
    rejected(f.run('MoveProjectPage', move(privateProject, null)), 'scope_mismatch');
    const created = f.active.history.list(f.a, page, 'project_page').at(-1)!;
    rejected(f.run('UndoChangeSet', { changeSetId: created.changeSetId }), 'page_container_deleted');
    assert.equal(f.page(page).deletedAt, null);
    assert.equal(f.page(child).parentPageId, page);
    assert.throws(
      () => f.db.prepare('UPDATE project_pages SET project_id=? WHERE page_id=?').run(other, page),
      /FOREIGN KEY/,
    );
    assert.throws(
      () => f.db.prepare('UPDATE project_pages SET project_id=? WHERE page_id=?').run(privateProject, page),
      /FOREIGN KEY/,
    );
    assert.throws(
      () => f.db.prepare('UPDATE project_pages SET parent_page_id=page_id WHERE page_id=?').run(page),
      /CHECK/,
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.close();
  }
});

test('compound deletion validates live membership; explicit restoration preserves earlier deletions and requires live ancestors', () => {
  const f = fixture();
  try {
    const project = f.project(),
      page = f.createPage(project),
      child = f.createPage(project, page),
      earlier = f.createPage(project, page),
      note = f.note();
    applied(f.edit(child, [recordBlock(note)]));
    applied(f.run('DeleteProjectPage', { ...f.target(earlier), descendants: [] }));
    const request = { ...f.target(project), pages: [f.target(page), f.target(child)] },
      newPage = f.createPage(project);
    rejected(f.run('DeleteProject', request), 'project_members_changed');
    const earlierRevision = f.get(earlier).revision;
    const deleted = applied(
      f.run('DeleteProject', { ...request, pages: [...request.pages, f.target(newPage)] }),
    );
    for (const id of [project, page, child, newPage]) assert.notEqual(f.get(id).content.deletedAt, null);
    assert.equal(f.get(earlier).revision, earlierRevision);
    assert.equal(f.get(note).revision, 1);
    const undo = applied(f.run('UndoChangeSet', { changeSetId: deleted.changeSetId }));
    for (const id of [project, page, child, newPage]) assert.equal(f.get(id).content.deletedAt, null);
    assert.notEqual(f.get(earlier).content.deletedAt, null);
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }));
    rejected(
      f.run('RestoreProject', { ...f.target(project), pages: [f.target(child)] }),
      'page_container_deleted',
    );
    assert.notEqual(f.get(project).content.deletedAt, null);
    applied(f.run('RestoreProject', { ...f.target(project), pages: [f.target(child), f.target(page)] }));
    assert.equal(f.page(child).deletedAt, null);
    assert.notEqual(f.page(earlier).deletedAt, null);
    assert.notEqual(f.page(newPage).deletedAt, null);
    const removed = applied(
      f.run('DeleteProjectPage', { ...f.target(page), descendants: [f.target(child)] }),
    );
    rejected(f.run('RestoreProjectPage', { ...f.target(child), descendants: [] }), 'page_container_deleted');
    applied(f.run('UndoChangeSet', { changeSetId: removed.changeSetId }));
    const ancestorDeleted = applied(
      f.run('DeleteProjectPage', { ...f.target(page), descendants: [f.target(child)] }),
    );
    applied(f.run('DeleteProject', { ...f.target(project), pages: [] }));
    rejected(f.run('UndoChangeSet', { changeSetId: ancestorDeleted.changeSetId }), 'page_container_deleted');
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.close();
  }
});

test('weak record links preserve privacy and never change or prevent deletion of their target', () => {
  const f = fixture();
  try {
    const project = f.project(),
      page = f.createPage(project),
      privateProject = f.project(f.privateScope),
      privatePage = f.createPage(privateProject),
      sharedNote = f.note(),
      privateNote = f.note(f.privateScope);
    rejected(f.edit(page, [recordBlock(privateNote)]), 'link_unavailable');
    applied(f.edit(privatePage, [recordBlock(sharedNote), recordBlock(privateNote)]));
    assert.equal(f.get(sharedNote).revision, 1);
    assert.equal(f.get(privateNote).revision, 1);
    assert.throws(() => f.get(privatePage, f.b), NotFound);
    assert.throws(() => f.active.history.list(f.b, privatePage, 'project_page'), NotFound);
    assert.deepEqual(
      f.active.projects.snapshot(f.b).pages.map((p) => p.recordId),
      [page],
    );
    rejected(
      f.run('UpdateProjectPage', { ...f.target(privatePage), title: 'Forged', blocks: [] }, f.b),
      'unavailable',
    );
    const link = recordBlock(sharedNote);
    applied(f.edit(page, [link]));
    const targetHistory = f.active.history.list(f.a, sharedNote).length;
    applied(f.run('DeleteInboxEntry', { inboxId: sharedNote, expectedRevision: 1 }, f.b));
    assert.equal(f.active.history.list(f.a, sharedNote).length, targetHistory + 1);
    applied(f.edit(page, [link, textBlock()]));
    const removed = applied(f.edit(page, [textBlock()]));
    applied(f.run('UndoChangeSet', { changeSetId: removed.changeSetId }));
    assert.deepEqual(f.page(page).blocks[0], link);
    rejected(f.edit(page, [recordBlock(sharedNote)]), 'link_unavailable');
    applied(f.run('DeleteProject', { ...f.target(project), pages: [f.target(page)] }));
    assert.equal(f.get(sharedNote).revision, 2);
    assert.equal(f.get(privateNote).revision, 1);
  } finally {
    f.close();
  }
});

test('mixed photo blocks reconcile with the generic photo editor, history and media retention', () => {
  const f = fixture();
  try {
    const project = f.project(),
      text = textBlock(),
      page = f.createPage(project, null, [text]),
      photo = f.photo(),
      second = { ...f.photo(), position: 1 };
    const attach = (attachments: Attachment[]) =>
      f.run('SetRecordAttachments', { ...f.target(page), attachments });
    applied(attach([photo, second]));
    const photoBlocks = f.page(page).blocks.slice(1);
    assert.deepEqual(
      photoBlocks.map((b) => b.kind),
      ['attachment', 'attachment'],
    );
    applied(f.edit(page, [photoBlocks[1]!, text, photoBlocks[0]!]));
    applied(
      attach([
        { ...photo, caption: 'Door hinge' },
        { ...second, caption: 'Floor sample' },
      ]),
    );
    assert.deepEqual(f.page(page).blocks, [photoBlocks[1], text, photoBlocks[0]]);
    const removed = applied(f.edit(page, [text, photoBlocks[0]!]));
    assert.equal(f.page(page).attachments.length, 1);
    assert.notEqual(
      f.db.prepare('SELECT unreferenced_at FROM media_objects WHERE media_id=?').pluck().get(second.mediaId),
      null,
    );
    applied(f.run('UndoChangeSet', { changeSetId: removed.changeSetId }));
    assert.deepEqual(f.page(page).blocks, [photoBlocks[1], text, photoBlocks[0]]);
    assert.equal(
      f.db.prepare('SELECT unreferenced_at FROM media_objects WHERE media_id=?').pluck().get(second.mediaId),
      null,
    );
    applied(f.run('SetProjectArchived', { ...f.target(project), archived: true }));
    assert.equal(
      f.db.prepare('SELECT unreferenced_at FROM media_objects WHERE media_id=?').pluck().get(photo.mediaId),
      null,
    );
    const absent = { ...f.photo(), position: 1 };
    f.db.prepare("UPDATE media_objects SET state='collected' WHERE media_id=?").run(absent.mediaId);
    assert.equal(attach([photo, absent]).status, 'Deferred');
    assert.deepEqual(f.page(page).blocks, [photoBlocks[1], text, photoBlocks[0]]);
    const deleted = applied(f.run('DeleteProject', { ...f.target(project), pages: [f.target(page)] }));
    f.db.prepare("UPDATE media_objects SET state='collected' WHERE media_id=?").run(photo.mediaId);
    rejected(f.run('UndoChangeSet', { changeSetId: deleted.changeSetId }), 'media_unavailable');
    assert.notEqual(f.get(project).content.deletedAt, null);
    assert.notEqual(f.page(page).deletedAt, null);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.close();
  }
});

test('block identity, payload and capacity errors leave both page content and attachments unchanged', () => {
  const f = fixture();
  try {
    const project = f.project(),
      block = textBlock(),
      page = f.createPage(project, null, [block]),
      other = f.createPage(project);
    rejected(f.edit(page, [block, block]), 'duplicate_page_block');
    rejected(f.edit(other, [block]), 'block_identity_unavailable');
    rejected(
      f.edit(page, [
        {
          blockId: block.blockId,
          kind: 'web_link',
          url: 'https://example.com',
          title: 'Different kind',
          notes: '',
        },
      ]),
      'block_identity_unavailable',
    );
    const credentialUrl = new URL('https://example.com');
    credentialUrl.username = 'fixture';
    credentialUrl.password = 'fixture';
    rejected(
      f.edit(page, [
        {
          blockId: randomUUID(),
          kind: 'web_link',
          url: credentialUrl.href,
          title: 'Credentials',
          notes: '',
        },
      ]),
      'invalid_web_link',
    );
    rejected(
      f.edit(page, [
        { blockId: randomUUID(), kind: 'web_link', url: 'javascript:alert(1)', title: 'Unsafe', notes: '' },
      ]),
      'invalid_arguments',
    );
    rejected(f.run('UpdateProjectPage', { ...f.target(page), title: '   ', blocks: [] }), 'title_required');
    rejected(
      f.edit(page, [{ blockId: randomUUID(), kind: 'attachment', attachmentId: randomUUID() }]),
      'page_attachment_mismatch',
    );
    assert.deepEqual(f.page(page).blocks, [block]);
    applied(
      f.edit(
        page,
        Array.from({ length: 200 }, () => textBlock()),
      ),
    );
    rejected(
      f.run('SetRecordAttachments', { ...f.target(page), attachments: [f.photo()] }),
      'page_block_limit',
    );
    assert.equal(f.page(page).blocks.length, 200);
    assert.deepEqual(f.page(page).attachments, []);
    assert.throws(
      () =>
        f.db.prepare("UPDATE page_blocks SET url='https://example.com' WHERE block_id=?").run(block.blockId),
      /CHECK/,
    );
    assert.throws(
      () => f.db.prepare('UPDATE page_blocks SET page_id=? WHERE block_id=?').run(other, block.blockId),
      /immutable/,
    );
  } finally {
    f.close();
  }
});

test('commit failures and lost replies cannot leave partial trees, duplicate blocks or overwritten partner edits', () => {
  const f = fixture();
  try {
    const project = f.project(),
      request = f.envelope({
        recordId: randomUUID(),
        projectId: project,
        parentPageId: null,
        title: 'Ideas',
        blocks: [textBlock()],
      });
    const tables = [
      'records',
      'project_pages',
      'page_blocks',
      'record_changes',
      'change_sets',
      'operation_receipts',
    ];
    const before = tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
    f.fail = true;
    assert.throws(
      () => f.active.writes.execute(f.a, 'CreateProjectPage', request),
      /injected commit failure/,
    );
    for (const [i, table] of tables.entries())
      assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), before[i], table);
    f.fail = false;
    const saved = applied(f.active.writes.execute(f.a, 'CreateProjectPage', request));
    const page = saved.result.records[0]!.recordId;
    applied(f.edit(page, [textBlock('Partner changed this')], f.b));
    const replay = applied(f.active.writes.execute(f.a, 'CreateProjectPage', request));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, saved.receipt);
    assert.equal(f.page(page).revision, 2);
    assert.throws(
      () =>
        f.active.writes.execute(f.a, 'CreateProjectPage', {
          ...request,
          arguments: { ...(request.arguments as object), title: 'Changed payload' },
        }),
      ProtocolConflict,
    );
    const deletion = f.envelope({ ...f.target(project), pages: [f.target(page)] });
    const beforeDelete = tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
    f.fail = true;
    assert.throws(() => f.active.writes.execute(f.a, 'DeleteProject', deletion), /injected commit failure/);
    for (const [i, table] of tables.entries())
      assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), beforeDelete[i], table);
    f.fail = false;
    applied(f.active.writes.execute(f.a, 'DeleteProject', deletion));
  } finally {
    f.close();
  }
});

for (const fault of [
  '',
  'SELECT missing_migration_function();',
  "INSERT INTO clients(client_id,person_id,kind) VALUES ('bad-client','no-person','browser');",
]) {
  test(`020 agenda layout migration preserves old rows and pins${fault ? ` after ${fault.startsWith('SELECT') ? 'SQL' : 'FK'} rollback` : ''}`, () => {
    const previous = mkdtempSync(join(tmpdir(), 'our-place-agenda-previous-'));
    for (const file of readdirSync(migrationsRoot).filter((name) => /^0(0\d|1\d)_/.test(name)))
      copyFileSync(join(migrationsRoot, file), join(previous, file));
    const f = fixture(previous);
    try {
      const note = f.note(),
        project = f.project(),
        recipeId = randomUUID();
      const command = f.envelope({
        recordId: recipeId,
        scopeId: f.shared,
        ...emptyRecipeFields(),
        title: 'Retained soup',
        collectionIds: [],
      });
      const saved = applied(f.active.writes.execute(f.a, 'CreateRecipe', command));
      for (const [kind, context, target] of [
        ['food_soon', null, recipeId],
        ['project_next', project, note],
      ] as const) {
        const viewId = randomUUID();
        f.db
          .prepare(
            'INSERT INTO saved_views(view_id,scope_id,kind,revision,context_record_id) VALUES (?,?,?,3,?)',
          )
          .run(viewId, f.shared, kind, context);
        f.db
          .prepare(
            'INSERT INTO record_pins(view_id,scope_id,record_id,position,target_scope_id) VALUES (?,?,?,7,?)',
          )
          .run(viewId, f.shared, target, f.shared);
      }
      const views = new ViewPreferences(f.db, f.access),
        pins = views.snapshot(f.a);
      const tables = (
        f.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
      const selects = tables.map(
        (table) =>
          `SELECT ${(f.db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name).join(',')} FROM ${table}`,
      );
      const before = selects.map((sql) => JSON.stringify(f.db.prepare(sql).all()));
      const filename = '020_agenda_layouts.sql';
      copyFileSync(join(migrationsRoot, filename), join(previous, filename));
      if (fault) {
        appendFileSync(join(previous, filename), '\n' + fault);
        const migrations = f.db.prepare('SELECT * FROM schema_migrations').all();
        assert.throws(() => migrate(f.db, previous), /function|foreign key check/);
        for (const [i, sql] of selects.entries())
          assert.equal(JSON.stringify(f.db.prepare(sql).all()), before[i], tables[i]);
        assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations').all(), migrations);
        assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
        assert.deepEqual(views.snapshot(f.a), pins);
      }
      f.upgrade();
      for (const [i, sql] of selects.entries())
        assert.equal(JSON.stringify(f.db.prepare(sql).all()), before[i], tables[i]);
      assert.deepEqual(views.snapshot(f.a), pins);
      assert.deepEqual(applied(f.active.writes.execute(f.a, 'CreateRecipe', command)).receipt, saved.receipt);
      applied(f.run('UndoChangeSet', { changeSetId: saved.changeSetId }));
      assert.deepEqual(views.snapshot(f.a), pins);
      assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
      assert.deepEqual(f.db.pragma('foreign_key_check'), []);
      assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      f.close();
      rmSync(previous, { recursive: true, force: true });
    }
  });
}

test('014 upgrade retains all old tables, Food pins and frozen receipts byte-for-byte', () => {
  const previous = mkdtempSync(join(tmpdir(), 'our-place-projects-previous-'));
  for (const file of readdirSync(migrationsRoot).filter((name) => /^0(0\d|1[0-4])_/.test(name)))
    copyFileSync(join(migrationsRoot, file), join(previous, file));
  const f = fixture(previous);
  try {
    const photo = f.photo(),
      command = f.envelope({
        inboxId: randomUUID(),
        scopeId: f.shared,
        text: 'Original note',
        capturedAt: f.now(),
        source: { kind: 'typed' },
        attachments: [photo],
      });
    const bytes = JSON.stringify(command),
      saved = applied(f.active.writes.execute(f.a, 'CreateInboxEntry', command));
    const recipeId = randomUUID();
    applied(
      f.run('CreateRecipe', {
        recordId: recipeId,
        scopeId: f.shared,
        ...emptyRecipeFields(),
        title: 'Favourite soup',
        collectionIds: [],
      }),
    );
    const views = new ViewPreferences(f.db, f.access);
    // Seed a retained existing preference using its published SQL representation.
    const viewId = randomUUID();
    f.db.prepare("INSERT INTO saved_views VALUES (?,?,'food_soon',1)").run(viewId, f.shared);
    f.db.prepare('INSERT INTO record_pins VALUES (?,?,?,?)').run(viewId, f.shared, recipeId, 0);
    const pins = views.snapshot(f.a);
    const tables = (
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','record_kinds') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const selects = tables.map(
      (table) =>
        `SELECT ${(f.db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name).join(',')} FROM ${table}`,
    );
    const before = selects.map((sql) => JSON.stringify(f.db.prepare(sql).all()));
    f.upgrade();
    for (const [i, table] of tables.entries())
      assert.equal(JSON.stringify(f.db.prepare(selects[i]!).all()), before[i], table);
    assert.equal(JSON.stringify(command), bytes);
    assert.deepEqual(views.snapshot(f.a), pins);
    assert.deepEqual(
      applied(f.active.writes.execute(f.a, 'CreateInboxEntry', command)).receipt,
      saved.receipt,
    );
    applied(f.run('UndoChangeSet', { changeSetId: saved.changeSetId }));
    const project = f.project(),
      page = f.createPage(project, null, [recordBlock(recipeId)]);
    assert.equal(f.page(page).blocks.length, 1);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    f.close();
    rmSync(previous, { recursive: true, force: true });
  }
});
