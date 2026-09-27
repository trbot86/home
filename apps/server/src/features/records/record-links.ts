import type { Sqlite } from '../../infrastructure/database.js';
import { Rejection } from '../../application/errors.js';
import { requireHuman, type AccessService, type HumanRequestContext } from '../access/access.js';

/** Non-owning links may outlive their target, but never broaden its audience. */
export class RecordLinkPolicy {
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
  ) {}
  validate(context: HumanRequestContext, sourceScopeId: string, targetId: string, retained = false) {
    requireHuman(context);
    this.access.requireScope(context, sourceScopeId);
    const target = this.db
      .prepare(
        `SELECT r.scope_id,r.deleted_at,s.kind FROM records r JOIN visibility_scopes s USING(scope_id) WHERE r.record_id=?`,
      )
      .get(targetId) as { scope_id: string; deleted_at: number | null; kind: string } | undefined;
    if (
      !target ||
      !this.access.canAccess(context, target.scope_id) ||
      (target.scope_id !== sourceScopeId && target.kind !== 'shared') ||
      (!retained && target.deleted_at !== null)
    )
      throw new Rejection('link_unavailable');
    return target.scope_id;
  }
}
