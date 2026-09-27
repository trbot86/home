import { randomBytes, randomUUID } from 'node:crypto';
import { immediate, installation, type Sqlite } from '../../infrastructure/database.js';
import { Rejection, Unauthenticated } from '../../application/errors.js';
import { tokenDigest } from '../access/access.js';
import type { WorkerContext } from '../access/workers.js';

export type SuggestionAgent = { agentId: string; clientId: string; name: string };
export type SuggestionGrant = {
  run_id: string;
  suggestion_id: string;
  scope_id: string;
  server_epoch: string;
  cause_change_set_id: string;
  state: string;
  lease_token: string;
  lease_until: number;
};
/** Host administration only. The secret is returned once, never accepted as a household session. */
export function provisionSuggestionAgent(db: Sqlite, name: string, now: number) {
  if (!name.trim() || name.length > 80) throw new Error('Invalid agent name');
  return immediate(db, () => {
    const agentId = randomUUID(),
      clientId = randomUUID(),
      secret = randomBytes(32).toString('base64url');
    db.prepare("INSERT INTO worker_actors VALUES (?,'suggestion_work',?,1)").run(agentId, name);
    db.prepare("INSERT INTO clients(client_id,kind,worker_id) VALUES (?,'worker',?)").run(clientId, agentId);
    db.prepare(
      'INSERT INTO suggestion_agents(agent_id,client_id,token_digest,created_at) VALUES (?,?,?,?)',
    ).run(agentId, clientId, tokenDigest(secret), now);
    return { agentId, clientId, secret };
  });
}
export function requireSuggestionAgent(db: Sqlite, agent: SuggestionAgent): void {
  if (
    !db
      .prepare(
        `SELECT 1 FROM suggestion_agents a JOIN worker_actors w ON w.worker_id=a.agent_id
    JOIN clients c ON c.client_id=a.client_id WHERE a.agent_id=? AND a.client_id=? AND a.enabled=1
    AND w.active=1 AND w.purpose='suggestion_work' AND c.enabled=1 AND c.kind='worker'`,
      )
      .get(agent.agentId, agent.clientId)
  )
    throw new Unauthenticated();
}
export function authenticateSuggestionAgent(db: Sqlite, secret: string): SuggestionAgent {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Unauthenticated();
  const actor = db
    .prepare(
      `SELECT a.agent_id AS agentId,a.client_id AS clientId,w.display_name AS name
    FROM suggestion_agents a JOIN worker_actors w ON w.worker_id=a.agent_id WHERE token_digest=?`,
    )
    .get(tokenDigest(secret)) as SuggestionAgent | undefined;
  if (!actor) throw new Unauthenticated();
  requireSuggestionAgent(db, actor);
  return actor;
}
/** Independent of the recipe worker grant: no generic record-write authority. */
export function requireSuggestionRun(db: Sqlite, context: WorkerContext, now: number): SuggestionGrant {
  requireSuggestionAgent(db, { agentId: context.workerId, clientId: context.clientId, name: '' });
  const row = db
    .prepare(
      `SELECT r.* FROM suggestion_runs r JOIN records p ON p.record_id=r.suggestion_id
    JOIN inbox_entries i ON i.inbox_id=r.suggestion_id JOIN suggestion_workflows w USING(suggestion_id)
    JOIN records wr ON wr.record_id=w.workflow_id WHERE r.run_id=? AND r.agent_id=? AND r.lease_token=?
    AND p.deleted_at IS NULL AND wr.deleted_at IS NULL AND i.category='app_suggestion'`,
    )
    .get(context.jobId, context.workerId, context.leaseToken) as SuggestionGrant | undefined;
  if (
    !row ||
    row.server_epoch !== installation(db).recovery_epoch ||
    row.lease_until <= now ||
    !['claimed', 'starting', 'running'].includes(row.state)
  )
    throw new Rejection('suggestion_run_unavailable');
  return row;
}
