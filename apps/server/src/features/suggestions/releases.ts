import { createHash } from 'node:crypto';
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
function project(r: Row): SuggestionRelease {
  return {
    releaseId: r.release_id,
    suggestionId: r.suggestion_id,
    runId: r.run_id,
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
        'SELECT * FROM suggestion_releases WHERE suggestion_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10',
      )
      .all(suggestionId) as Row[]
  ).map(project);
}
export function requireNoRelease(db: Sqlite, suggestionId: string) {
  if (
    db
      .prepare(`SELECT 1 FROM suggestion_releases WHERE suggestion_id=? AND state IN ${active}`)
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
          this.db
            .prepare(
              `INSERT INTO suggestion_releases(release_id,suggestion_id,run_id,server_epoch,requested_by,state,summary,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?,?)`,
            )
            .run(
              a.releaseId,
              a.suggestionId,
              a.runId,
              installation(this.db).recovery_epoch,
              context.personId,
              'Waiting for the development host to prepare and test this release.',
              now,
              now,
            );
        } else {
          const a = payload as Command<'DeploySuggestionRelease'>['arguments'];
          const row = this.db
            .prepare('SELECT * FROM suggestion_releases WHERE release_id=?')
            .get(a.releaseId) as Row | undefined;
          if (!row) throw new NotFound();
          this.visible(context, row.suggestion_id, kind !== 'CancelSuggestionRelease');
          if (kind === 'CancelSuggestionRelease') {
            if (!['queued', 'prepared', 'deploy_queued', 'cancelled'].includes(row.state))
              throw new Rejection('release_has_started');
            this.db
              .prepare(
                "UPDATE suggestion_releases SET state='cancelled',summary='Release cancelled. The running app was not changed.',revision=revision+1,updated_at=? WHERE release_id=?",
              )
              .run(now, a.releaseId);
          } else {
            if (row.server_epoch !== installation(this.db).recovery_epoch)
              throw new Rejection('recovery_required');
            if (row.state !== 'prepared' || row.manifest_digest !== a.manifestDigest)
              throw new Rejection('release_not_prepared');
            this.eligible(row.suggestion_id, row.run_id);
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
    const row = this.db.prepare(`SELECT * FROM suggestion_releases WHERE state IN ${active}`).get() as
      Row | undefined;
    if (!row || (row.agent_id && row.agent_id !== agent.agentId)) return null;
    if (row.server_epoch !== epoch) throw new Rejection('recovery_required');
    return project(row);
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
        return project(row);
      if (row.revision !== a.expectedRevision) throw new Rejection('release_changed');
      const allowed: Record<string, string[]> = {
        queued: ['preparing', 'failed'],
        preparing: ['prepared', 'failed', 'uncertain'],
        deploy_queued: ['deploying', 'failed'],
        deploying: ['released', 'uncertain'],
      };
      if (!allowed[row.state]?.includes(a.state)) throw new Rejection('invalid_release_transition');
      if (a.state === 'prepared' && !a.manifest) throw new Rejection('release_manifest_required');
      if (a.manifest && a.state !== 'prepared') throw new Rejection('immutable_release_manifest');
      if (['preparing', 'deploying'].includes(a.state)) this.eligible(row.suggestion_id, row.run_id);
      const digest = manifest ? createHash('sha256').update(manifest).digest('hex') : null;
      this.db
        .prepare(
          'UPDATE suggestion_releases SET agent_id=?,state=?,revision=revision+1,summary=?,manifest_json=?,manifest_digest=?,updated_at=? WHERE release_id=?',
        )
        .run(agent.agentId, a.state, a.summary, manifest, digest, this.now(), a.releaseId);
      return project(
        this.db.prepare('SELECT * FROM suggestion_releases WHERE release_id=?').get(a.releaseId) as Row,
      );
    });
  }
}
