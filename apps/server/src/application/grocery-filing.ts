import type { Sqlite } from '../infrastructure/database.js';
import type { TrackedRecord } from '../features/records/record-registry.js';
import { isSecure } from './record-security.js';

/** Explicit grocery filing may publish an item while retaining its private source. */
export function canShareToGroceries(db: Sqlite, sourceScope: string, target: TrackedRecord): boolean {
  return target.kind === 'shopping_list' && target.content.purpose === 'groceries' &&
    target.content.deletedAt === null && !isSecure(db, target.recordId) && !!db.prepare(`SELECT 1 FROM visibility_scopes source, visibility_scopes destination
      WHERE source.scope_id=? AND source.kind='private' AND destination.scope_id=? AND destination.kind='shared'`)
      .get(sourceScope, target.content.scopeId);
}
