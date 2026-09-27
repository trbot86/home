import type { InboxDestination } from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { Rejection } from '../../application/errors.js';
import type { AccessService, HumanRequestContext } from '../access/access.js';
import { RecordLinkPolicy } from '../records/record-links.js';

/** Source-owned weak references; target deletion never deletes the captured note. */
export class InboxDestinations {
  private readonly links: RecordLinkPolicy;
  constructor(
    private readonly db: Sqlite,
    access: AccessService,
  ) {
    this.links = new RecordLinkPolicy(db, access);
  }
  enabled() {
    // Older-schema restore rehearsals construct repositories before migrating.
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_destinations'")
      .get();
  }
  list(inboxId: string): InboxDestination[] {
    return this.db
      .prepare(
        'SELECT target_record_id AS recordId,filed_at AS filedAt FROM inbox_destinations WHERE inbox_id=? ORDER BY filed_at,target_record_id',
      )
      .all(inboxId) as InboxDestination[];
  }
  replace(context: HumanRequestContext, inboxId: string, scopeId: string, destinations: InboxDestination[]) {
    if (destinations.length > 20 || new Set(destinations.map((d) => d.recordId)).size !== destinations.length)
      throw new Rejection('invalid_inbox_destinations');
    const targets = destinations.map((destination) => {
      if (destination.recordId === inboxId) throw new Rejection('cannot_file_into_itself');
      // Historical references may point to a deleted target. New filing checks liveness separately.
      return {
        ...destination,
        targetScopeId: this.links.validate(context, scopeId, destination.recordId, true),
      };
    });
    this.db.prepare('DELETE FROM inbox_destinations WHERE inbox_id=?').run(inboxId);
    const insert = this.db.prepare(
      'INSERT INTO inbox_destinations(inbox_id,scope_id,target_record_id,target_scope_id,filed_at) VALUES (?,?,?,?,?)',
    );
    for (const target of targets)
      insert.run(inboxId, scopeId, target.recordId, target.targetScopeId, target.filedAt);
  }
}
