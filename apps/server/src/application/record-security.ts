import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { isValid } from '@our-place/contracts';
import { immediate, installation, type Sqlite } from '../infrastructure/database.js';
import type { HumanRequestContext } from '../features/access/access.js';
import type { RecordRegistry } from '../features/records/record-registry.js';
import { Rejection } from './errors.js';

export function isSecure(db: Sqlite, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM secure_records WHERE record_id=?').get(id);
}

export function registerRecordSecurityRoutes(
  app: FastifyInstance,
  db: Sqlite,
  records: RecordRegistry,
  authenticate: (request: FastifyRequest) => HumanRequestContext,
) {
  function read(context: HumanRequestContext, id: string) {
    records.get(context, id); // Authorize before inspecting metadata or ancestry.
    const row = db.prepare('SELECT secure,revision FROM record_security WHERE record_id=?').get(id) as
      { secure: number; revision: number } | undefined;
    return { secure: row?.secure === 1, revision: row?.revision ?? 0, effective: isSecure(db, id) };
  }
  const schema = Type.Object(
    {
      secure: Type.Boolean(),
      expectedRevision: Type.Integer({ minimum: 0 }),
      expectedServerEpoch: Type.String(),
    },
    { additionalProperties: false },
  );
  app.get<{ Params: { id: string } }>('/api/records/:id/security', async (request) =>
    read(authenticate(request), request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/records/:id/security', async (request) => {
    const context = authenticate(request);
    if (!isValid(schema, request.body)) throw new Rejection('invalid_security_setting');
    const body = request.body;
    return immediate(db, () => {
      const install = installation(db);
      if (install.recovery_mode !== 'normal' || install.recovery_epoch !== body.expectedServerEpoch)
        throw new Rejection('recovery_required');
      const before = read(context, request.params.id);
      if (before.revision !== body.expectedRevision) throw new Rejection('revision_conflict');
      db.prepare(
        `INSERT INTO record_security VALUES (?,?,?) ON CONFLICT(record_id)
        DO UPDATE SET secure=excluded.secure,revision=excluded.revision`,
      ).run(request.params.id, Number(body.secure), before.revision + 1);
      // Invalidate old and in-flight advice. It cannot become visible again when protection is removed.
      db.prepare(
        "UPDATE inbox_filing_suggestions SET state='stale',choices_json='[]' WHERE state='attempted' OR inbox_id IN (SELECT record_id FROM secure_records) OR EXISTS (SELECT 1 FROM json_each(choices_json) c JOIN secure_records s ON s.record_id=json_extract(c.value,'$.recordId'))",
      ).run();
      return read(context, request.params.id);
    });
  });
}
