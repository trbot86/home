import { randomUUID } from 'node:crypto';
import type { Command, SavedView } from '@our-place/contracts';
import { Rejection } from '../../application/errors.js';
import type { Sqlite } from '../../infrastructure/database.js';
import { AccessService, requireHuman, type HumanRequestContext } from '../access/access.js';
import type { CommandHandler } from '../records/command-handler.js';
export class ViewPreferences {
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
  ) {}
  snapshot(context: HumanRequestContext): SavedView[] {
    requireHuman(context);
    const views = this.db
      .prepare(
        `SELECT v.view_id AS viewId,v.scope_id AS scopeId,v.kind,v.revision FROM saved_views v JOIN visibility_scopes s USING(scope_id)
      WHERE s.kind='shared' OR s.owner_person_id=? ORDER BY v.view_id`,
      )
      .all(context.personId) as Omit<SavedView, 'pins'>[];
    return views.map((view) => ({
      ...view,
      pins: this.db
        .prepare(
          'SELECT record_id AS recordId,position FROM record_pins WHERE view_id=? ORDER BY position,record_id',
        )
        .all(view.viewId) as SavedView['pins'],
    }));
  }
  commands(): CommandHandler {
    return {
      kinds: ['SetRecordPin'],
      execute: (context, _kind, payload) => {
        if (!this.db.inTransaction) throw new Error('Pins require a receipt transaction');
        const args = payload as Command<'SetRecordPin'>['arguments'];
        this.access.requireScope(context, args.scopeId);
        if (
          !this.db
            .prepare(
              "SELECT 1 FROM records WHERE record_id=? AND scope_id=? AND kind='recipe' AND deleted_at IS NULL",
            )
            .get(args.recordId, args.scopeId)
        )
          throw new Rejection('unavailable');
        let view = this.db
          .prepare('SELECT view_id AS viewId,revision FROM saved_views WHERE scope_id=? AND kind=?')
          .get(args.scopeId, args.viewKind) as { viewId: string; revision: number } | undefined;
        if ((view?.revision ?? 0) !== args.expectedViewRevision)
          throw new Rejection('view_revision_conflict');
        if (!view) {
          view = { viewId: randomUUID(), revision: 1 };
          this.db
            .prepare('INSERT INTO saved_views VALUES (?,?,?,1)')
            .run(view.viewId, args.scopeId, args.viewKind);
        } else this.db.prepare('UPDATE saved_views SET revision=revision+1 WHERE view_id=?').run(view.viewId);
        if (args.pinned)
          this.db
            .prepare(
              `INSERT INTO record_pins(view_id,scope_id,record_id,position)
        SELECT ?,?,?,COALESCE(MAX(position),-1)+1 FROM record_pins WHERE view_id=? ON CONFLICT(view_id,record_id) DO NOTHING`,
            )
            .run(view.viewId, args.scopeId, args.recordId, view.viewId);
        else
          this.db
            .prepare('DELETE FROM record_pins WHERE view_id=? AND record_id=?')
            .run(view.viewId, args.recordId);
        return { records: [], changes: [] };
      },
    };
  }
}
