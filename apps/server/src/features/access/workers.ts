import { randomUUID } from 'node:crypto';
import { installation, type Sqlite } from '../../infrastructure/database.js';
import { Rejection, Unauthenticated } from '../../application/errors.js';
import { requireHuman, type HumanRequestContext } from './access.js';

/** Internal only: neither HTTP authentication path returns this context. */
export type WorkerContext = {
  kind: 'worker';
  clientId: string;
  workerId: string;
  jobId: string;
  leaseToken: string;
};
export type WorkerGrant = {
  target_record_id: string;
  scope_id: string;
  expected_revision: number;
  expected_server_epoch: string;
  cause_change_set_id: string;
};

/** Called within a human import request's transaction, never during migration or ordinary startup. */
export function ensureRecipeWorker(
  db: Sqlite,
  requester: HumanRequestContext,
): { clientId: string; workerId: string } {
  requireHuman(requester);
  if (!db.inTransaction) throw new Error('Worker provisioning must share the requesting transaction');
  if (
    !db
      .prepare(
        "SELECT 1 FROM clients c JOIN people p USING(person_id) WHERE c.client_id=? AND c.person_id=? AND c.enabled=1 AND p.active=1 AND c.kind IN ('browser','android')",
      )
      .get(requester.clientId, requester.personId)
  )
    throw new Unauthenticated();
  const existing = db
    .prepare(
      "SELECT c.client_id AS clientId,w.worker_id AS workerId,c.enabled,w.active FROM worker_actors w JOIN clients c USING(worker_id) WHERE w.purpose='recipe_import'",
    )
    .get() as { clientId: string; workerId: string; enabled: number; active: number } | undefined;
  if (existing) {
    if (!existing.enabled || !existing.active) throw new Rejection('recipe_import_disabled');
    return { clientId: existing.clientId, workerId: existing.workerId };
  }
  const workerId = randomUUID(),
    clientId = randomUUID();
  db.prepare("INSERT INTO worker_actors VALUES (?,'recipe_import','Recipe importer',1)").run(workerId);
  db.prepare("INSERT INTO clients(client_id,kind,worker_id) VALUES (?,'worker',?)").run(clientId, workerId);
  return { clientId, workerId };
}

/** Recheck persisted authority at every internal write, including calls that do not pass through HTTP. */
export function requireWorkerJob(db: Sqlite, context: WorkerContext, now: number): WorkerGrant {
  if (context.kind !== 'worker' || !context.leaseToken) throw new Unauthenticated();
  const grant = db
    .prepare(
      `SELECT g.* FROM worker_jobs g JOIN background_jobs j USING(job_id)
    JOIN clients c ON c.client_id=g.client_id JOIN worker_actors w ON w.worker_id=g.worker_id
    JOIN records r ON r.record_id=g.target_record_id JOIN change_sets cause ON cause.change_set_id=g.cause_change_set_id
    JOIN record_changes rc ON rc.change_set_id=cause.change_set_id AND rc.record_id=g.target_record_id
    JOIN people p ON p.person_id=cause.actor_person_id
    WHERE g.job_id=? AND g.client_id=? AND g.worker_id=? AND c.kind='worker' AND c.worker_id=w.worker_id
      AND c.enabled=1 AND w.active=1 AND w.purpose='recipe_import' AND j.kind='recipe_import'
      AND j.state IN ('running','ready') AND j.lease_token=? AND j.lease_until>?
      AND r.kind='recipe' AND r.scope_id=g.scope_id AND rc.after_revision=g.expected_revision
      AND rc.after_scope_id=g.scope_id AND p.active=1`,
    )
    .get(context.jobId, context.clientId, context.workerId, context.leaseToken, now) as
    WorkerGrant | undefined;
  if (!grant) throw new Unauthenticated();
  if (grant.expected_server_epoch !== installation(db).recovery_epoch)
    throw new Rejection('recovery_required');
  return grant;
}
