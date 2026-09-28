import { createHash, randomUUID } from 'node:crypto';
import {
  suggestionReleaseCommands,
  type Command,
  type SuggestionRelease,
  type SuggestionReleaseUpdate,
} from '@our-place/contracts';
import { immediate, installation, type Sqlite } from '../../infrastructure/database.js';
import { Rejection, NotFound } from '../../application/errors.js';
import type { AccessService, HumanRequestContext } from '../access/access.js';
import type { CommandHandler, RecordMutation } from '../records/command-handler.js';
import { requireSuggestionAgent, type SuggestionAgent } from './agent-access.js';

const active = "('queued','preparing','prepared','deploy_queued','deploying','uncertain')";
type Row = {
  release_id: string;
  suggestion_id: string;
  run_id: string;
  server_epoch: string;
  state: SuggestionRelease['state'];
  revision: number;
  summary: string;
  manifest_json: string | null;
  manifest_digest: string | null;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
};
function members(db: Sqlite, releaseId: string) {
  return db
    .prepare(
      'SELECT suggestion_id AS suggestionId,run_id AS runId FROM suggestion_release_members WHERE release_id=? ORDER BY ordinal',
    )
    .all(releaseId) as { suggestionId: string; runId: string }[];
}
function project(db: Sqlite, r: Row, suggestionId = r.suggestion_id): SuggestionRelease {
  const batch = members(db, r.release_id);
  const member = batch.find((m) => m.suggestionId === suggestionId)!;
  return {
    releaseId: r.release_id,
    suggestionId: member.suggestionId,
    runId: member.runId,
    members: batch,
    state: r.state,
    revision: r.revision,
    summary: r.summary,
    manifest: r.manifest_json ? JSON.parse(r.manifest_json) : null,
    manifestDigest: r.manifest_digest,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export function suggestionReleases(db: Sqlite, suggestionId: string): SuggestionRelease[] {
  return (
    db
      .prepare(
        'SELECT r.* FROM suggestion_releases r JOIN suggestion_release_members m USING(release_id) WHERE m.suggestion_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 10',
      )
      .all(suggestionId) as Row[]
  ).map((r) => project(db, r, suggestionId));
}
export function requireNoRelease(db: Sqlite, suggestionId: string) {
  if (
    db
      .prepare(
        `SELECT 1 FROM suggestion_releases r JOIN suggestion_release_members m USING(release_id) WHERE m.suggestion_id=? AND r.state IN ${active}`,
      )
      .get(suggestionId)
  )
    throw new Rejection('release_in_progress');
}
export class SuggestionReleases {
  constructor(
    private db: Sqlite,
    private access: AccessService,
    private now: () => number,
  ) {}
  private visible(context: HumanRequestContext, id: string, writable = true) {
    const r = this.db
      .prepare(
        'SELECT r.scope_id,r.deleted_at,i.category FROM records r JOIN inbox_entries i ON i.inbox_id=r.record_id WHERE r.record_id=?',
      )
      .get(id) as { scope_id: string; deleted_at: number | null; category: string } | undefined;
    if (!r || !this.access.canAccess(context, r.scope_id)) throw new NotFound();
    if (writable && (r.deleted_at !== null || r.category !== 'app_suggestion'))
      throw new Rejection('suggestion_not_active');
  }
  private eligible(id: string, runId: string) {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM records r JOIN inbox_entries i ON i.inbox_id=r.record_id WHERE r.record_id=? AND r.deleted_at IS NULL AND i.category='app_suggestion'",
        )
        .get(id)
    )
      throw new Rejection('suggestion_not_active');
    if (
      this.db
        .prepare('SELECT 1 FROM suggestion_workflows WHERE suggestion_id=? AND completed_at IS NOT NULL')
        .get(id)
    )
      throw new Rejection('reopen_suggestion_before_release');
    const latest = this.db
      .prepare(
        'SELECT run_id,state FROM suggestion_runs WHERE suggestion_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      )
      .get(id) as { run_id: string; state: string } | undefined;
    if (
      latest?.run_id !== runId ||
      latest.state !== 'ready' ||
      this.db
        .prepare(
          "SELECT 1 FROM suggestion_work_requests WHERE suggestion_id=? AND state IN ('queued','running','uncertain')",
        )
        .get(id)
    )
      throw new Rejection('suggestion_not_ready');
  }
  private eligibleBatch(row: Row) {
    for (const m of members(this.db, row.release_id)) this.eligible(m.suggestionId, m.runId);
  }
  private enqueue(
    releaseId: string,
    batch: { suggestionId: string; runId: string }[],
    personId: string,
    now: number,
  ) {
    const first = batch[0]!;
    this.db
      .prepare(
        `INSERT INTO suggestion_releases(release_id,suggestion_id,run_id,server_epoch,requested_by,state,summary,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?,?)`,
      )
      .run(
        releaseId,
        first.suggestionId,
        first.runId,
        installation(this.db).recovery_epoch,
        personId,
        `Preparing an update containing ${batch.length} suggestion${batch.length === 1 ? '' : 's'}.`,
        now,
        now,
      );
    batch.forEach((m, i) =>
      this.db
        .prepare('INSERT INTO suggestion_release_members VALUES (?,?,?,?)')
        .run(releaseId, m.suggestionId, m.runId, i),
    );
  }
  /** Authenticated host polling schedules once per finished run, never on a browser read. */
  private schedule(agent: SuggestionAgent, epoch: string) {
    if (this.db.prepare(`SELECT 1 FROM suggestion_releases WHERE state IN ${active}`).get()) return;
    const candidates = this.db
      .prepare(
        `SELECT r.run_id AS runId,r.suggestion_id AS suggestionId,r.scope_id AS scopeId,r.updated_at AS finishedAt,
      (SELECT requested_by FROM suggestion_work_requests WHERE run_id=r.run_id ORDER BY requested_at LIMIT 1) AS personId
      FROM suggestion_runs r JOIN suggestion_workflows w USING(suggestion_id)
      JOIN records p ON p.record_id=r.suggestion_id JOIN inbox_entries i ON i.inbox_id=r.suggestion_id
      WHERE r.state='ready' AND r.agent_id=? AND r.server_epoch=? AND w.completed_at IS NULL
      AND p.deleted_at IS NULL AND i.category='app_suggestion'
      AND r.run_id=(SELECT run_id FROM suggestion_runs WHERE suggestion_id=r.suggestion_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM suggestion_work_requests WHERE suggestion_id=r.suggestion_id AND state IN ('queued','running','uncertain'))
      AND NOT EXISTS(SELECT 1 FROM suggestion_release_members WHERE run_id=r.run_id)
      ORDER BY r.updated_at,r.run_id`,
      )
      .all(agent.agentId, epoch) as {
      runId: string;
      suggestionId: string;
      scopeId: string;
      finishedAt: number;
      personId: string;
    }[];
    const first = candidates[0];
    if (!first) return;
    // A batch never mixes visibility scopes. Quiet for 30s, with a 2-minute upper bound.
    const batch = candidates.filter((c) => c.scopeId === first.scopeId).slice(0, 20);
    const now = this.now();
    if (now - Math.max(...batch.map((c) => c.finishedAt)) < 30_000 && now - first.finishedAt < 120_000)
      return;
    const releaseId = randomUUID();
    this.enqueue(releaseId, batch, first.personId, now);
    this.db
      .prepare('UPDATE suggestion_releases SET agent_id=? WHERE release_id=?')
      .run(agent.agentId, releaseId);
  }
  commands(): CommandHandler {
    return {
      kinds: Object.keys(suggestionReleaseCommands) as (keyof typeof suggestionReleaseCommands)[],
      execute: (context, kind, payload, now): RecordMutation => {
        if (kind === 'PrepareSuggestionRelease') {
          const a = payload as Command<'PrepareSuggestionRelease'>['arguments'];
          this.visible(context, a.suggestionId);
          this.eligible(a.suggestionId, a.runId);
          if (this.db.prepare(`SELECT 1 FROM suggestion_releases WHERE state IN ${active}`).get())
            throw new Rejection('another_release_in_progress');
          this.enqueue(
            a.releaseId,
            [{ suggestionId: a.suggestionId, runId: a.runId }],
            context.personId,
            now,
          );
        } else {
          const a = payload as Command<'DeploySuggestionRelease'>['arguments'];
          const row = this.db
            .prepare('SELECT * FROM suggestion_releases WHERE release_id=?')
            .get(a.releaseId) as Row | undefined;
          if (!row) throw new NotFound();
          for (const m of members(this.db, row.release_id))
            this.visible(context, m.suggestionId, kind !== 'CancelSuggestionRelease');
          if (kind === 'CancelSuggestionRelease') {
            if (!['queued', 'prepared', 'deploy_queued', 'cancelled'].includes(row.state))
              throw new Rejection('release_has_started');
            this.db
              .prepare(
                "UPDATE suggestion_releases SET state='cancelled',summary='Release cancelled. The running app was not changed.',revision=revision+1,updated_at=? WHERE release_id=?",
              )
              .run(now, a.releaseId);
          } else if (kind === 'RetrySuggestionRelease') {
            if (!['failed', 'cancelled'].includes(row.state)) throw new Rejection('release_not_retryable');
            if (row.server_epoch !== installation(this.db).recovery_epoch)
              throw new Rejection('recovery_required');
            if (this.db.prepare(`SELECT 1 FROM suggestion_releases WHERE state IN ${active}`).get())
              throw new Rejection('another_release_in_progress');
            this.eligibleBatch(row);
            const retry = payload as Command<'RetrySuggestionRelease'>['arguments'];
            this.enqueue(retry.replacementReleaseId, members(this.db, row.release_id), context.personId, now);
          } else {
            if (row.server_epoch !== installation(this.db).recovery_epoch)
              throw new Rejection('recovery_required');
            if (row.state !== 'prepared' || row.manifest_digest !== a.manifestDigest)
              throw new Rejection('release_not_prepared');
            this.eligibleBatch(row);
            this.db
              .prepare(
                "UPDATE suggestion_releases SET state='deploy_queued',summary='Deployment requested for this tested release.',revision=revision+1,updated_at=? WHERE release_id=?",
              )
              .run(now, a.releaseId);
          }
        }
        return { records: [], changes: [] };
      },
    };
  }
  pending(agent: SuggestionAgent, epoch: string): SuggestionRelease | null {
    requireSuggestionAgent(this.db, agent);
    if (epoch !== installation(this.db).recovery_epoch) throw new Rejection('recovery_required');
    immediate(this.db, () => this.schedule(agent, epoch));
    const row = this.db.prepare(`SELECT * FROM suggestion_releases WHERE state IN ${active}`).get() as
      Row | undefined;
    if (!row || (row.agent_id && row.agent_id !== agent.agentId)) return null;
    if (row.server_epoch !== epoch) throw new Rejection('recovery_required');
    return project(this.db, row);
  }
  update(agent: SuggestionAgent, a: SuggestionReleaseUpdate): SuggestionRelease {
    return immediate(this.db, () => {
      requireSuggestionAgent(this.db, agent);
      if (a.expectedServerEpoch !== installation(this.db).recovery_epoch)
        throw new Rejection('recovery_required');
      const row = this.db.prepare('SELECT * FROM suggestion_releases WHERE release_id=?').get(a.releaseId) as
        Row | undefined;
      if (
        !row ||
        row.server_epoch !== a.expectedServerEpoch ||
        (row.agent_id && row.agent_id !== agent.agentId)
      )
        throw new Rejection('release_unavailable');
      const manifest = a.manifest ? JSON.stringify(a.manifest) : row.manifest_json;
      if (
        row.revision === a.expectedRevision + 1 &&
        row.state === a.state &&
        row.summary === a.summary &&
        row.manifest_json === manifest
      )
        return project(this.db, row);
      if (row.revision !== a.expectedRevision) throw new Rejection('release_changed');
      const allowed: Record<string, string[]> = {
        queued: ['preparing', 'failed'],
        preparing: ['prepared', 'failed', 'uncertain'],
        deploy_queued: ['deploying', 'failed'],
        deploying: ['released', 'uncertain'],
      };
      if (!allowed[row.state]?.includes(a.state)) throw new Rejection('invalid_release_transition');
      if (a.state === 'prepared' && !a.manifest) throw new Rejection('release_manifest_required');
      if (a.manifest) {
        const batch = members(this.db, row.release_id);
        const sources = a.manifest.sources;
        if (
          (batch.length > 1 && !sources) ||
          (sources &&
            (sources.length !== batch.length ||
              sources.some(
                (s, i) => s.suggestionId !== batch[i]!.suggestionId || s.runId !== batch[i]!.runId,
              )))
        )
          throw new Rejection('release_members_changed');
      }
      if (a.manifest && a.state !== 'prepared') throw new Rejection('immutable_release_manifest');
      if (['preparing', 'deploying'].includes(a.state)) this.eligibleBatch(row);
      const digest = manifest ? createHash('sha256').update(manifest).digest('hex') : null;
      this.db
        .prepare(
          'UPDATE suggestion_releases SET agent_id=?,state=?,revision=revision+1,summary=?,manifest_json=?,manifest_digest=?,updated_at=? WHERE release_id=?',
        )
        .run(agent.agentId, a.state, a.summary, manifest, digest, this.now(), a.releaseId);
      return project(
        this.db,
        this.db.prepare('SELECT * FROM suggestion_releases WHERE release_id=?').get(a.releaseId) as Row,
      );
    });
  }
}
