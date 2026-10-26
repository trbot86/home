import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import {
  emptyTasks,
  emptyShopping,
  emptyRecipes,
  type TaskDefinition,
  type TaskOccurrence,
  type AgendaCalendarSnapshot,
  type AgendaEvent,
  type EinkPreviewRequest,
} from '@our-place/contracts';
import { displayProjection } from '../src/features/displays/projection.js';
import { renderDisplay } from '../src/features/displays/render.js';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';

const request: EinkPreviewRequest = { layout: 'kitchen', includePrivate: false, days: 2, calendarIds: [] };
const now = Date.parse('2026-10-26T14:00:00Z');
function input() {
  return {
    personId: 'alex',
    displayName: 'Alex',
    sharedScopes: ['shared'],
    privateScopes: ['private'],
    tasks: emptyTasks(),
    shopping: emptyShopping(),
    recipes: emptyRecipes(),
    views: [],
    calendars: [] as AgendaCalendarSnapshot[],
    now,
  };
}
const base = { scopeId: 'shared', revision: 1, createdAt: 0, updatedAt: 0, deletedAt: null };
function task(title: string, scopeId = 'shared', assigneeId: string | null = null) {
  const recordId = randomUUID();
  const definition: TaskDefinition = {
    ...base,
    scopeId,
    recordId,
    kind: 'task',
    title,
    instructions: 'Not display text',
    context: 'home',
    defaultAssigneeId: null,
    defaultPriority: 1,
    recurrence: null,
  };
  const occurrence: TaskOccurrence = {
    ...base,
    scopeId,
    recordId: randomUUID(),
    kind: 'task_occurrence',
    taskId: recordId,
    ordinal: 1,
    assigneeId,
    priority: 1,
    state: 'open',
    deadlineDate: null,
    targetDate: '2026-10-26',
    reviewDate: null,
  };
  return { definition, occurrence };
}
function calendar(
  id: string,
  scopeId: string,
  events: AgendaEvent[],
  context: 'home' | 'work' = 'home',
): AgendaCalendarSnapshot {
  return {
    calendarId: id,
    scopeId,
    context,
    title: id,
    timeZone: 'America/Toronto',
    refreshedAt: now,
    lastAttemptAt: now,
    errorCode: null,
    window: { from: now - 86400000, until: now + 8 * 86400000 },
    events,
  };
}
function event(title: string, startAt = now + 3600000): AgendaEvent {
  return {
    eventId: randomUUID(),
    instanceKey: '',
    recurringEventId: null,
    providerVersion: 'v1',
    title,
    description: 'Never display the meeting passcode',
    location: '',
    sourceUrl: null,
    status: 'confirmed',
    participation: 'accepted',
    visibility: 'default',
    busy: true,
    timing: {
      kind: 'timed',
      startAt,
      endAt: startAt + 3600000,
      timeZone: 'America/Toronto',
      endUnspecified: false,
    },
  };
}
test('projection enforces shared kitchen, explicit private desk, calendar selection and audience before rendering', () => {
  const source = input();
  for (const t of [
    task('Shared chore', 'shared', 'sam'),
    task('My private task', 'private'),
    task('Other private task', 'other'),
    task('Shared for Alex', 'shared', 'alex'),
  ]) {
    source.tasks.definitions.push(t.definition);
    source.tasks.occurrences.push(t.occurrence);
  }
  source.calendars = [
    calendar('family', 'shared', [
      event('Shared appointment'),
      { ...event('Sensitive event'), visibility: 'private' },
      { ...event('Declined'), participation: 'declined' },
    ]),
    calendar('personal', 'private', [event('Personal appointment')]),
    calendar('other', 'other', [event('Other appointment')]),
    calendar('work', 'shared', [event('Work appointment')], 'work'),
  ];
  const selected = { ...request, calendarIds: ['family', 'personal', 'other', 'work'] };
  const kitchen = JSON.stringify(displayProjection(source, selected));
  assert.match(kitchen, /Shared chore/);
  assert.match(kitchen, /Shared appointment/);
  for (const excluded of [
    'My private task',
    'Other private task',
    'Sensitive event',
    'Declined',
    'Personal appointment',
    'Other appointment',
    'Work appointment',
    'passcode',
    'Not display text',
  ])
    assert.equal(kitchen.includes(excluded), false, excluded);
  const desk = JSON.stringify(
    displayProjection(source, { ...selected, layout: 'desk', includePrivate: true }),
  );
  assert.match(desk, /My private task/);
  assert.match(desk, /Personal appointment/);
  assert.match(desk, /Sensitive event/);
  assert.equal(desk.includes('Shared chore'), false);
  assert.equal(desk.includes('Other private task'), false);
  const unselected = JSON.stringify(displayProjection(source, { ...selected, calendarIds: [] }));
  assert.equal(unselected.includes('Shared appointment'), false);
});
test('calendar projection preserves exclusive all-day ends, household timezone and multi-day overlaps', () => {
  const source = input();
  source.now = Date.parse('2026-10-26T04:30:00Z');
  const allDay = {
    ...event('Ended yesterday'),
    timing: { kind: 'all_day' as const, startDate: '2026-10-25', endDate: '2026-10-26' },
  };
  source.calendars = [
    calendar('family', 'shared', [
      allDay,
      {
        ...allDay,
        title: 'Continues today',
        timing: { kind: 'all_day', startDate: '2026-10-25', endDate: '2026-10-27' },
      },
      event('Tomorrow morning', Date.parse('2026-10-27T13:30:00Z')),
      event('Outside window', Date.parse('2026-10-28T13:30:00Z')),
    ]),
  ];
  const model = displayProjection(source, { ...request, calendarIds: ['family'] });
  const rows = model.sections[0]!.rows;
  assert.deepEqual(
    rows.map((r) => r.title),
    ['Continues today', 'Tomorrow morning'],
  );
  assert.equal(rows[0]!.prefix, 'Today\nAll day');
  assert.equal(rows[1]!.prefix, 'Tue\n9:30a');
});
function pngPixels(png: Buffer) {
  assert.equal(png[24], 1);
  assert.equal(png[25], 0);
  const compressed: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at),
      kind = png.toString('ascii', at + 4, at + 8);
    if (kind === 'IDAT') compressed.push(png.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const scan = inflateSync(Buffer.concat(compressed)),
    stride = Math.ceil(png.readUInt32BE(16) / 8),
    height = png.readUInt32BE(20);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    assert.equal(scan[y * (stride + 1)], 0);
    scan.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return pixels;
}
test('exact preview pixels match 1-bit BMP, stay deterministic, and support padded rows at other sizes', () => {
  const model = displayProjection(input(), request);
  model.sections[0]!.rows = [
    {
      title: 'A very long meeting name with café & <script> tags and a long unbroken word '.repeat(8),
      prefix: 'Today\n4:30p',
    },
  ];
  for (const size of [
    { width: 800, height: 480 },
    { width: 803, height: 480 },
  ]) {
    const rendered = renderDisplay(model, size),
      again = renderDisplay(model, size);
    assert.equal(rendered.digest, again.digest);
    assert.deepEqual(rendered.png, again.png);
    const pixels = pngPixels(rendered.png),
      stride = Math.ceil(size.width / 8),
      bmpStride = Math.ceil(size.width / 32) * 4;
    assert.equal(rendered.bmp.toString('ascii', 0, 2), 'BM');
    assert.equal(rendered.bmp.readUInt16LE(28), 1);
    assert.equal(rendered.bmp.length, 62 + bmpStride * size.height);
    for (let y = 0; y < size.height; y++)
      assert.deepEqual(
        rendered.bmp.subarray(
          62 + (size.height - y - 1) * bmpStride,
          62 + (size.height - y - 1) * bmpStride + stride,
        ),
        pixels.subarray(y * stride, (y + 1) * stride),
      );
    assert.ok(pixels.some((p) => p !== 255));
  }
  const different = renderDisplay({ ...model, title: 'Different title' });
  assert.notEqual(renderDisplay(model).digest, different.digest);
  const later = input();
  later.now += 300000;
  assert.equal(
    renderDisplay(displayProjection(input(), request)).digest,
    renderDisplay(displayProjection(later, request)).digest,
    'poll time must not manufacture new pixels',
  );
});
test('preview endpoint authenticates, rejects private kitchen and unbounded options, writes no household records', async () => {
  const f = await integrationFixture();
  const service = await buildApp({
    db: f.db,
    dataRoot: f.dataRoot,
    development: true,
    publicOrigin: 'http://localhost',
    now: f.now,
  });
  const headers = { cookie: `our_place_session=${'a'.repeat(43)}`, origin: 'http://localhost' };
  const tables = ['records', 'operation_receipts', 'change_sets', 'record_changes'];
  const snapshot = () => tables.map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
  try {
    assert.equal(
      (await service.app.inject({ method: 'POST', url: '/api/displays/preview', payload: request }))
        .statusCode,
      401,
    );
    const before = snapshot();
    const response = await service.app.inject({
      method: 'POST',
      url: '/api/displays/preview',
      headers,
      payload: request,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = response.json();
    assert.equal(body.width, 800);
    assert.equal(body.height, 480);
    assert.equal(Buffer.from(body.bmpBase64, 'base64').length, 48062);
    for (const bad of [
      { ...request, includePrivate: true },
      { ...request, days: 999 },
      { ...request, layout: 'other' },
      { ...request, personId: 'someone-else' },
    ])
      assert.equal(
        (await service.app.inject({ method: 'POST', url: '/api/displays/preview', headers, payload: bad }))
          .statusCode,
        400,
      );
    assert.deepEqual(snapshot(), before);
  } finally {
    await service.app.close();
    await f.close();
  }
});
