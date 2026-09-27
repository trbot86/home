import { createHash, randomUUID } from 'node:crypto';
import {
  emptyRecipeFields,
  isValid,
  RecipeExtraction,
  recipeImportCommands,
  type Attachment,
  type Command,
  type CommandKind,
  type FinalOutcome,
  type RecipeCandidate,
  type RecipeFields,
  type RecipeImportField,
  type RecipeImportSummary,
} from '@our-place/contracts';
import { immediate, installation, type Sqlite } from '../../infrastructure/database.js';
import { publicWebUrl } from '../../infrastructure/public-web.js';
import { Deferral, NotFound, ProtocolConflict, Rejection } from '../../application/errors.js';
import { requireHuman, type HumanRequestContext } from '../access/access.js';
import { ensureRecipeWorker, requireWorkerJob, type WorkerContext } from '../access/workers.js';
import type { CommandHandler, RecordMutation } from '../records/command-handler.js';
import type { RecordRegistry } from '../records/record-registry.js';
import type { HistoryService } from '../history/history.js';
import { RecipesRepository, type RecipeImportPatch } from './recipes.js';
import type { RecipeSourceResult } from './source-reader.js';

type ImportRow = {
  recipe_import_id: string;
  job_id: string;
  recipe_id: string;
  scope_id: string;
  source_url: string;
  requested_at: number;
  result_json: string | null;
  retrieved_at: number | null;
  automatic_operation_id: string;
  application_json: string | null;
  applied_change_set_id: string | null;
  active: number;
  state: RecipeImportSummary['state'];
  error_code: string | null;
};
const importSelect =
  'SELECT i.*,j.state,j.error_code FROM recipe_imports i JOIN background_jobs j USING(job_id)';
const leaseDuration = 5 * 60000;
type Application = { candidateId: string; fields: RecipeImportField[]; patch: RecipeImportPatch };
export type ClaimedImport = { context: WorkerContext; sourceUrl: string };

function sourceUrl(value: string): string {
  try {
    return publicWebUrl(value).href;
  } catch {
    throw new Rejection('invalid_source_url');
  }
}
function parseResult(json: string): RecipeSourceResult {
  const value = JSON.parse(json) as RecipeSourceResult;
  if (
    !value ||
    !isValid(RecipeExtraction, value.extraction) ||
    !value.page ||
    !/^[a-f0-9]{64}$/.test(value.page.sha256) ||
    !Number.isSafeInteger(value.page.byteLength) ||
    value.page.byteLength < 1 ||
    value.page.byteLength > 2 * 1024 * 1024 ||
    !['text/html', 'application/xhtml+xml'].includes(value.page.mediaType) ||
    typeof value.page.encoding !== 'string' ||
    value.page.encoding.length > 80 ||
    json.length > 2 * 1024 * 1024 ||
    new Set(value.extraction.candidates.map((c) => c.candidateId)).size !== value.extraction.candidates.length
  )
    throw new Error('Invalid persisted recipe source');
  sourceUrl(value.extraction.sourceUrl);
  for (const c of value.extraction.candidates) for (const url of c.imageUrls) sourceUrl(url);
  return value;
}

/** Owns import requests, frozen source results and their one-time application. Network I/O stays outside. */
export class RecipeImports {
  constructor(
    private readonly db: Sqlite,
    private readonly recipes: RecipesRepository,
    private readonly history: HistoryService,
    private readonly records: RecordRegistry,
    private readonly now: () => number,
    private readonly beforeCommit?: () => void,
  ) {}

  commands(): CommandHandler {
    return {
      kinds: Object.keys(recipeImportCommands) as (keyof typeof recipeImportCommands)[],
      execute: (context, kind, payload, now) => this.execute(context, kind, payload, now),
    };
  }
  private row(id: string): ImportRow {
    const row = this.db.prepare(`${importSelect} WHERE i.recipe_import_id=?`).get(id) as
      ImportRow | undefined;
    if (!row) throw new NotFound();
    return row;
  }
  private forJob(context: WorkerContext): ImportRow {
    requireWorkerJob(this.db, context, this.now());
    const row = this.db.prepare(`${importSelect} WHERE i.job_id=? AND i.active=1`).get(context.jobId) as
      ImportRow | undefined;
    if (!row) throw new Rejection('import_unavailable');
    return row;
  }
  private summary(row: ImportRow): RecipeImportSummary {
    return {
      importId: row.recipe_import_id,
      recipeId: row.recipe_id,
      sourceUrl: row.source_url,
      requestedAt: row.requested_at,
      state: row.state,
      errorCode: row.error_code,
      candidateCount: row.result_json ? parseResult(row.result_json).extraction.candidates.length : 0,
      appliedChangeSetId: row.applied_change_set_id,
    };
  }
  snapshot(context: HumanRequestContext): RecipeImportSummary[] {
    requireHuman(context);
    const rows = this.db
      .prepare(
        `${importSelect} JOIN visibility_scopes s ON s.scope_id=i.scope_id
      WHERE (s.kind='shared' OR s.owner_person_id=?) AND i.recipe_import_id=(SELECT recent.recipe_import_id FROM recipe_imports recent
        JOIN worker_jobs g ON g.job_id=recent.job_id JOIN change_sets h ON h.change_set_id=g.cause_change_set_id
        WHERE recent.recipe_id=i.recipe_id ORDER BY h.commit_sequence DESC LIMIT 1)
      ORDER BY i.requested_at DESC,i.recipe_import_id DESC LIMIT 4001`,
      )
      .all(context.personId) as ImportRow[];
    if (rows.length > 4000) throw new Rejection('cache_capacity_exceeded');
    return rows.map((row) => this.summary(row));
  }
  detail(context: HumanRequestContext, id: string) {
    const row = this.row(id);
    this.recipes.get(context, row.recipe_id, 'recipe');
    const result = row.result_json ? parseResult(row.result_json) : null;
    return {
      ...this.summary(row),
      retrievedAt: row.retrieved_at,
      candidates:
        result?.extraction.candidates.map(({ imageUrls: _urls, ...candidate }) => ({
          ...candidate,
          image: this.image(row.job_id, candidate.candidateId),
        })) ?? [],
      warnings: result?.extraction.warnings ?? [],
    };
  }
  image(jobId: string, candidateId: string): Attachment | null {
    return (
      (this.db
        .prepare(
          `SELECT p.attachment_id AS attachmentId,m.media_id AS mediaId,m.digest,
      m.byte_length AS byteLength,m.mime_type AS mimeType,0 AS position FROM recipe_import_media p
      JOIN media_objects m USING(media_id) WHERE p.job_id=? AND p.candidate_id=? AND m.state='ready'`,
        )
        .get(jobId, candidateId) as Attachment | undefined) ?? null
    );
  }
  source(context: WorkerContext): RecipeSourceResult | null {
    const row = this.forJob(context);
    return row.result_json ? parseResult(row.result_json) : null;
  }
  hasApplication(context: WorkerContext): boolean {
    return this.forJob(context).application_json !== null;
  }
  private execute(
    context: HumanRequestContext,
    kind: CommandKind,
    payload: unknown,
    now: number,
  ): RecordMutation {
    requireHuman(context);
    if (!this.db.inTransaction) throw new Error('Import commands require the content transaction');
    if (kind === 'CancelRecipeImport') {
      const args = payload as Command<'CancelRecipeImport'>['arguments'],
        row = this.row(args.importId);
      this.recipes.get(context, row.recipe_id, 'recipe');
      if (row.state === 'complete') throw new Rejection('import_already_applied');
      this.finish(row, 'abandoned', null);
      return { records: [], changes: [] };
    }
    if (kind === 'ApplyRecipeImport') {
      const args = payload as Command<'ApplyRecipeImport'>['arguments'],
        row = this.row(args.importId);
      const before = this.recipes.get(context, row.recipe_id, 'recipe');
      if (row.recipe_id !== args.recordId) throw new Rejection('import_unavailable');
      if (!row.result_json || ['queued', 'running', 'ready', 'abandoned'].includes(row.state))
        throw new Rejection('import_not_reviewable');
      if (row.applied_change_set_id) throw new Rejection('import_already_applied');
      const candidate = parseResult(row.result_json).extraction.candidates.find(
        (c) => c.candidateId === args.candidateId,
      );
      if (!candidate) throw new Rejection('candidate_unavailable');
      const patch = this.patch(row, candidate, args.fields, before.content.attachments as Attachment[]);
      const mutation = this.recipes.applyReviewedImport(
        context,
        row.recipe_id,
        args.expectedRevision,
        patch,
        now,
      );
      return {
        ...mutation,
        afterHistory: (changeSetId) => {
          this.finish(row, 'complete', null, changeSetId);
        },
      };
    }
    const args = payload as Command<'ImportRecipe'>['arguments'] & { expectedRevision?: number };
    if (this.db.prepare('SELECT 1 FROM recipe_imports WHERE recipe_import_id=?').get(args.importId))
      throw new Rejection('id_unavailable');
    const url = sourceUrl(args.url);
    const pending = this.db
      .prepare(`${importSelect} WHERE i.recipe_id=? AND i.active=1`)
      .get(args.recordId) as ImportRow | undefined;
    // Authorise the recipe before revealing an outstanding request.
    let mutation: RecordMutation;
    if (kind === 'ImportRecipe') {
      mutation = this.recipes.commands().execute(
        context,
        'CreateRecipe',
        {
          recordId: args.recordId,
          scopeId: args.scopeId,
          collectionIds: args.collectionIds,
          ...emptyRecipeFields(),
          title: new URL(url).hostname,
          sourceUrl: url,
        },
        now,
      );
    } else if (kind === 'RequestRecipeImport') {
      const before = this.recipes.project(this.recipes.get(context, args.recordId, 'recipe'));
      if (before.kind !== 'recipe') throw new Rejection('unavailable');
      const fields: RecipeFields = {
        title: before.title,
        description: before.description,
        sourceUrl: url,
        author: before.author,
        yieldText: before.yieldText,
        prepTime: before.prepTime,
        cookTime: before.cookTime,
        totalTime: before.totalTime,
        ingredients: before.ingredients,
        steps: before.steps,
      };
      mutation = this.recipes.commands().execute(
        context,
        'UpdateRecipe',
        {
          ...fields,
          recordId: args.recordId,
          expectedRevision: args.expectedRevision,
        },
        now,
      );
    } else throw new Error('Unknown recipe import command');
    if (pending && ['queued', 'running', 'ready'].includes(pending.state))
      throw new Rejection('import_in_progress');
    if (pending)
      this.db
        .prepare('UPDATE recipe_imports SET active=0 WHERE recipe_import_id=?')
        .run(pending.recipe_import_id);
    const after = mutation.records[0]!;
    return {
      ...mutation,
      afterHistory: (changeSetId) => {
        const principal = ensureRecipeWorker(this.db, context),
          jobId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO background_jobs(job_id,kind,dedupe_key,payload_json,state,run_after) VALUES (?,'recipe_import',?,'{}','queued',?)",
          )
          .run(jobId, `recipe-import:${args.importId}`, now);
        this.db
          .prepare('INSERT INTO worker_jobs VALUES (?,?,?,?,?,?,?,?)')
          .run(
            jobId,
            principal.clientId,
            principal.workerId,
            after.recordId,
            after.content.scopeId,
            after.revision,
            installation(this.db).recovery_epoch,
            changeSetId,
          );
        this.db
          .prepare(
            `INSERT INTO recipe_imports(recipe_import_id,job_id,recipe_id,scope_id,source_url,requested_at,automatic_operation_id,active)
        VALUES (?,?,?,?,?,?,?,1)`,
          )
          .run(args.importId, jobId, after.recordId, after.content.scopeId, url, now, randomUUID());
      },
    };
  }
  claim(): ClaimedImport | null {
    return immediate(this.db, () => {
      const now = this.now();
      const row = this.db
        .prepare(
          `SELECT i.job_id,i.source_url,g.client_id,g.worker_id FROM recipe_imports i JOIN background_jobs j USING(job_id)
        JOIN worker_jobs g USING(job_id) JOIN clients c ON c.client_id=g.client_id JOIN worker_actors w ON w.worker_id=g.worker_id
        JOIN change_sets h ON h.change_set_id=g.cause_change_set_id JOIN people p ON p.person_id=h.actor_person_id
        WHERE i.active=1 AND g.expected_server_epoch=? AND c.enabled=1 AND w.active=1 AND p.active=1
          AND j.kind='recipe_import' AND j.run_after<=? AND (j.state='queued' OR (j.state IN ('running','ready') AND (j.lease_until IS NULL OR j.lease_until<=?)))
        ORDER BY j.run_after,j.job_id LIMIT 1`,
        )
        .get(installation(this.db).recovery_epoch, now, now) as
        { job_id: string; source_url: string; client_id: string; worker_id: string } | undefined;
      if (!row) return null;
      const context: WorkerContext = {
        kind: 'worker',
        jobId: row.job_id,
        clientId: row.client_id,
        workerId: row.worker_id,
        leaseToken: randomUUID(),
      };
      this.db
        .prepare(
          "UPDATE background_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=?,error_code=NULL WHERE job_id=?",
        )
        .run(context.leaseToken, now + leaseDuration, row.job_id);
      requireWorkerJob(this.db, context, now);
      return { context, sourceUrl: row.source_url };
    });
  }
  saveSource(context: WorkerContext, result: RecipeSourceResult): void {
    const json = JSON.stringify(result);
    try {
      parseResult(json);
    } catch {
      throw new Rejection('invalid_import_result');
    }
    immediate(this.db, () => {
      const row = this.forJob(context);
      if (row.result_json && row.result_json !== json) throw new Rejection('import_source_frozen');
      if (!row.result_json)
        this.db
          .prepare('UPDATE recipe_imports SET result_json=?,retrieved_at=? WHERE job_id=?')
          .run(json, this.now(), context.jobId);
      this.db.prepare("UPDATE background_jobs SET state='ready' WHERE job_id=?").run(context.jobId);
    });
  }
  private patch(
    row: ImportRow,
    c: RecipeCandidate,
    fields: RecipeImportField[],
    current: Attachment[],
  ): RecipeImportPatch {
    if (new Set(fields).size !== fields.length) throw new Rejection('duplicate_import_field');
    const patch: RecipeImportPatch = { sourceUrl: parseResult(row.result_json!).extraction.sourceUrl };
    for (const field of fields) {
      if (field === 'ingredients')
        patch.ingredients = c.ingredients.map((text) => ({ ingredientId: randomUUID(), text }));
      else if (field === 'steps') patch.steps = c.steps.map((text) => ({ stepId: randomUUID(), text }));
      else if (field === 'times')
        Object.assign(patch, { prepTime: c.prepTime, cookTime: c.cookTime, totalTime: c.totalTime });
      else if (field === 'photo') {
        const image = this.image(row.job_id, c.candidateId);
        if (!image) throw new Rejection('import_image_unavailable');
        const manual = current.filter(
          (a) =>
            !this.db
              .prepare(
                'SELECT 1 FROM recipe_import_media p JOIN worker_jobs j USING(job_id) WHERE p.media_id=? AND j.target_record_id=?',
              )
              .get(a.mediaId, row.recipe_id),
        );
        if (manual.length >= 20) throw new Rejection('attachment_limit');
        patch.attachments = [image, ...manual].map((a, position) => ({ ...a, position }));
      } else patch[field] = c[field];
    }
    return patch;
  }
  /** Freeze all generated child/media IDs before the first application attempt. */
  freezeApplication(context: WorkerContext): boolean {
    return immediate(this.db, () => {
      const row = this.forJob(context);
      if (row.application_json) return true;
      if (!row.result_json) throw new Rejection('import_source_missing');
      const candidates = parseResult(row.result_json).extraction.candidates;
      if (candidates.length !== 1) {
        this.finish(row, 'review', 'multiple_candidates');
        return false;
      }
      const candidate = candidates[0]!,
        fields: RecipeImportField[] = ['title', 'description'];
      if (candidate.kind === 'recipe') fields.push('author', 'yieldText', 'times', 'ingredients', 'steps');
      if (this.image(row.job_id, candidate.candidateId)) fields.push('photo');
      const current = this.db
        .prepare('SELECT deleted_at,revision FROM records WHERE record_id=?')
        .get(row.recipe_id) as { deleted_at: number | null; revision: number };
      const grant = requireWorkerJob(this.db, context, this.now());
      // Current photos are only read after confirming the source snapshot still applies.
      // On conflict the frozen application is harmless: the receipt records the rejection.
      const photos =
        current.revision === grant.expected_revision
          ? (this.db
              .prepare(
                `SELECT a.attachment_id AS attachmentId,m.media_id AS mediaId,m.digest,
        m.byte_length AS byteLength,m.mime_type AS mimeType,a.caption,a.position FROM attachments a JOIN media_objects m USING(media_id)
        WHERE a.record_id=? AND a.removed_at IS NULL ORDER BY a.position`,
              )
              .all(row.recipe_id)
              .map((raw) => {
                const { caption, ...a } = raw as Attachment & { caption: string | null };
                return caption === null ? a : { ...a, caption };
              }) as Attachment[])
          : [];
      let patch: RecipeImportPatch;
      try {
        patch = this.patch(row, candidate, fields, photos);
      } catch (error) {
        if (!(error instanceof Rejection)) throw error;
        this.finish(row, 'review', error.code);
        return false;
      }
      this.db
        .prepare('UPDATE recipe_imports SET application_json=? WHERE job_id=?')
        .run(
          JSON.stringify({ candidateId: candidate.candidateId, fields, patch } satisfies Application),
          context.jobId,
        );
      return true;
    });
  }
  apply(context: WorkerContext): FinalOutcome & { replayed?: boolean } {
    return immediate(this.db, () => {
      // A durable receipt can be recovered even after its lease was released or its epoch restored.
      const row = this.db
        .prepare(
          `${importSelect} JOIN worker_jobs g USING(job_id)
        WHERE i.job_id=? AND g.client_id=? AND g.worker_id=?`,
        )
        .get(context.jobId, context.clientId, context.workerId) as ImportRow | undefined;
      if (!row?.application_json) throw new Rejection('import_application_missing');
      const application = JSON.parse(row.application_json) as Application;
      const grant = this.db
        .prepare('SELECT expected_server_epoch,expected_revision FROM worker_jobs WHERE job_id=?')
        .get(context.jobId) as { expected_server_epoch: string; expected_revision: number };
      const digest = createHash('sha256')
        .update(
          JSON.stringify({
            encodingVersion: 3,
            clientId: context.clientId,
            workerId: context.workerId,
            jobId: context.jobId,
            kind: 'ApplyRecipeImport',
            operationId: row.automatic_operation_id,
            expectedServerEpoch: grant.expected_server_epoch,
            recordId: row.recipe_id,
            expectedRevision: grant.expected_revision,
            application,
          }),
        )
        .digest('hex');
      const prior = this.db
        .prepare(
          'SELECT request_digest,outcome_json FROM operation_receipts WHERE client_id=? AND operation_id=?',
        )
        .get(context.clientId, row.automatic_operation_id) as
        { request_digest: string; outcome_json: string } | undefined;
      if (prior) {
        if (prior.request_digest !== digest) throw new ProtocolConflict('Import operation changed');
        return { ...(JSON.parse(prior.outcome_json) as FinalOutcome), replayed: true };
      }
      this.forJob(context);
      const now = this.now(),
        receipt = { operationId: row.automatic_operation_id, requestDigest: digest, recordedAt: now };
      let outcome: FinalOutcome;
      this.db.exec('SAVEPOINT import_content');
      try {
        const mutation = this.recipes.applyWorkerImport(context, application.patch, now);
        const changeSetId = this.history.recordWorker(context, mutation.changes, now);
        this.records.assertComplete();
        outcome = {
          status: 'Applied',
          receipt,
          changeSetId,
          result: { records: mutation.records.map((r) => ({ recordId: r.recordId, revision: r.revision })) },
        };
        this.finish(row, 'complete', null, changeSetId);
      } catch (error) {
        if (!(error instanceof Rejection) && !(error instanceof Deferral)) throw error;
        this.db.exec('ROLLBACK TO import_content');
        outcome = { status: 'Rejected', receipt, code: error.code };
        this.finish(row, error.code === 'deleted' ? 'abandoned' : 'review', error.code);
      }
      this.db.exec('RELEASE import_content');
      this.db
        .prepare(
          `INSERT INTO operation_receipts(client_id,operation_id,request_digest,actor_worker_id,outcome_json,recorded_at)
        VALUES (?,?,?,?,?,?)`,
        )
        .run(
          context.clientId,
          row.automatic_operation_id,
          digest,
          context.workerId,
          JSON.stringify(outcome),
          now,
        );
      this.beforeCommit?.();
      return outcome;
    });
  }
  private finish(
    row: ImportRow,
    state: RecipeImportSummary['state'],
    error: string | null,
    changeSetId?: string,
  ): void {
    this.db
      .prepare(
        'UPDATE background_jobs SET state=?,error_code=?,lease_token=NULL,lease_until=NULL WHERE job_id=?',
      )
      .run(state, error, row.job_id);
    this.db
      .prepare(
        'UPDATE recipe_imports SET active=0,applied_change_set_id=COALESCE(?,applied_change_set_id) WHERE job_id=?',
      )
      .run(changeSetId ?? null, row.job_id);
  }
  fail(context: WorkerContext, code: string): void {
    immediate(this.db, () => {
      this.finish(this.forJob(context), 'failed', code);
    });
  }
  abandonDeleted(context: WorkerContext): boolean {
    return immediate(this.db, () => {
      const row = this.forJob(context);
      if (
        !this.db
          .prepare('SELECT 1 FROM records WHERE record_id=? AND deleted_at IS NOT NULL')
          .get(row.recipe_id)
      )
        return false;
      this.finish(row, 'abandoned', 'deleted');
      return true;
    });
  }
  release(context: WorkerContext): void {
    immediate(this.db, () => {
      const row = this.forJob(context);
      this.db
        .prepare('UPDATE background_jobs SET state=?,lease_token=NULL,lease_until=NULL WHERE job_id=?')
        .run(row.result_json ? 'ready' : 'queued', row.job_id);
    });
  }
}
