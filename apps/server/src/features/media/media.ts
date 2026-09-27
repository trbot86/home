import { randomUUID } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Digest, Id, isValid } from '@our-place/contracts';
import { immediate, installation, type Sqlite } from '../../infrastructure/database.js';
import { Deferral, NotFound, Rejection } from '../../application/errors.js';
import { AccessService, requireHuman, type HumanRequestContext as RequestContext } from '../access/access.js';
import { FileMediaStore, sha256 } from './file-media-store.js';
import { MediaRetentionGate } from './retention-gate.js';
import { requireWorkerJob, type WorkerContext } from '../access/workers.js';
import { publicWebUrl } from '../../infrastructure/public-web.js';

export const PrepareMedia = Type.Object(
  {
    scopeId: Id,
    expectedServerEpoch: Id,
    digest: Digest,
    byteLength: Type.Integer({ minimum: 1, maximum: 25 * 1024 * 1024 }),
    mimeType: Type.Union([Type.Literal('image/jpeg'), Type.Literal('image/png'), Type.Literal('image/webp')]),
  },
  { additionalProperties: false },
);
export type MediaRow = {
  media_id: string;
  scope_id: string;
  creator_client_id: string;
  digest: string;
  byte_length: number;
  mime_type: string;
  storage_key: string;
  generation: string;
  state: 'staging' | 'ready' | 'deleting' | 'collected';
  created_at: number;
  unreferenced_at: number | null;
  protected_until: number;
};
function detectedMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  return null;
}
export class MediaService {
  private readonly uploads = new Map<string, Promise<void>>();
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
    readonly files: FileMediaStore,
    readonly retention: MediaRetentionGate,
    private readonly now: () => number,
  ) {}
  private getOwned(context: RequestContext, id: string): MediaRow {
    requireHuman(context);
    const media = this.db.prepare('SELECT * FROM media_objects WHERE media_id=?').get(id) as
      MediaRow | undefined;
    if (
      !media ||
      media.creator_client_id !== context.clientId ||
      !this.access.canAccess(context, media.scope_id)
    )
      throw new NotFound();
    return media;
  }
  prepare(context: RequestContext, id: string, args: Static<typeof PrepareMedia>): { state: string } {
    if (!isValid(Id, id)) throw new Rejection('invalid_media_id');
    this.access.requireScope(context, args.scopeId);
    if (args.expectedServerEpoch !== installation(this.db).recovery_epoch)
      throw new Rejection('recovery_required');
    return immediate(this.db, () => {
      this.prepareOwned(context.clientId, id, args);
      return { state: this.getOwned(context, id).state };
    });
  }
  private prepareOwned(clientId: string, id: string, args: Static<typeof PrepareMedia>): void {
    const existing = this.db.prepare('SELECT * FROM media_objects WHERE media_id=?').get(id) as
      MediaRow | undefined;
    if (existing) {
      if (
        existing.creator_client_id !== clientId ||
        existing.scope_id !== args.scopeId ||
        existing.digest !== args.digest ||
        existing.byte_length !== args.byteLength ||
        existing.mime_type !== args.mimeType
      )
        throw new Rejection('media_unavailable');
      if (existing.state === 'deleting') throw new Deferral('media_collection_pending');
      if (existing.state === 'collected') {
        const generation = randomUUID();
        this.db
          .prepare(
            "UPDATE media_objects SET state='staging',storage_key=?,generation=?,unreferenced_at=NULL WHERE media_id=?",
          )
          .run(`objects/${generation}.bin`, generation, id);
      }
      this.db
        .prepare('UPDATE media_objects SET protected_until=? WHERE media_id=?')
        .run(this.now() + 86400000, id);
    } else {
      const generation = randomUUID();
      this.db
        .prepare("INSERT INTO media_objects VALUES (?,?,?,?,?,?,?,?,'staging',?,NULL,?)")
        .run(
          id,
          args.scopeId,
          clientId,
          args.digest,
          args.byteLength,
          args.mimeType,
          `objects/${generation}.bin`,
          generation,
          this.now(),
          this.now() + 86400000,
        );
    }
  }
  async transfer(
    context: RequestContext,
    id: string,
    epoch: string,
    bytes: Buffer,
  ): Promise<{ state: 'ready' }> {
    if (epoch !== installation(this.db).recovery_epoch) throw new Rejection('recovery_required');
    return this.transferOwned(id, bytes, () => {
      if (epoch !== installation(this.db).recovery_epoch) throw new Rejection('recovery_required');
      return this.getOwned(context, id);
    });
  }
  /** Only the recipe named by a persisted, leased job can receive this upload. */
  async importImage(
    context: WorkerContext,
    candidateId: string,
    sourceUri: string,
    bytes: Buffer,
  ): Promise<void> {
    if (!isValid(Digest, candidateId) || bytes.length > 8 * 1024 * 1024)
      throw new Rejection('invalid_import_image');
    const mimeType = detectedMime(bytes) as Static<typeof PrepareMedia>['mimeType'] | null;
    if (!mimeType) throw new Rejection('invalid_import_image');
    const source = publicWebUrl(sourceUri).href;
    const id = immediate(this.db, () => {
      const grant = requireWorkerJob(this.db, context, this.now());
      if (
        !this.db
          .prepare(
            `SELECT 1 FROM recipe_imports i,json_each(i.result_json,'$.extraction.candidates') c
        WHERE i.job_id=? AND i.active=1 AND i.recipe_id=? AND json_extract(c.value,'$.candidateId')=?`,
          )
          .get(context.jobId, grant.target_record_id, candidateId)
      )
        throw new Rejection('candidate_unavailable');
      const previous = this.db
        .prepare('SELECT media_id,source_uri FROM recipe_import_media WHERE job_id=? AND candidate_id=?')
        .get(context.jobId, candidateId) as { media_id: string; source_uri: string } | undefined;
      if (previous && previous.source_uri !== source) throw new Rejection('import_image_changed');
      const mediaId = previous?.media_id ?? randomUUID();
      this.prepareOwned(context.clientId, mediaId, {
        scopeId: grant.scope_id,
        expectedServerEpoch: grant.expected_server_epoch,
        digest: sha256(bytes),
        byteLength: bytes.length,
        mimeType,
      });
      if (!previous)
        this.db
          .prepare('INSERT INTO recipe_import_media VALUES (?,?,?,?,?)')
          .run(context.jobId, candidateId, mediaId, randomUUID(), source);
      return mediaId;
    });
    await this.transferOwned(id, bytes, () => {
      const grant = requireWorkerJob(this.db, context, this.now());
      const row = this.db
        .prepare(
          'SELECT m.* FROM media_objects m JOIN recipe_import_media p USING(media_id) WHERE p.job_id=? AND p.candidate_id=? AND m.media_id=? AND m.creator_client_id=? AND m.scope_id=?',
        )
        .get(context.jobId, candidateId, id, context.clientId, grant.scope_id) as MediaRow | undefined;
      if (!row) throw new NotFound();
      return row;
    });
  }
  private async transferOwned(
    id: string,
    bytes: Buffer,
    authorised: () => MediaRow,
  ): Promise<{ state: 'ready' }> {
    const prior = this.uploads.get(id) ?? Promise.resolve();
    const work = prior
      .catch(() => {})
      .then(async () => {
        const media = authorised();
        if (media.state === 'deleting' || media.state === 'collected')
          throw new Deferral('media_needs_preparation');
        if (
          bytes.length !== media.byte_length ||
          sha256(bytes) !== media.digest ||
          detectedMime(bytes) !== media.mime_type
        )
          throw new Rejection('media_bytes_mismatch');
        this.db
          .prepare('UPDATE media_objects SET protected_until=? WHERE media_id=?')
          .run(this.now() + 86400000, id);
        await this.files.publish(media.storage_key, bytes);
        immediate(this.db, () => {
          const current = authorised();
          if (
            current.generation !== media.generation ||
            current.state === 'deleting' ||
            current.state === 'collected'
          )
            throw new Deferral('media_generation_changed');
          const live = this.db
            .prepare(
              'SELECT 1 FROM attachments a JOIN records r ON r.record_id=a.record_id WHERE a.media_id=? AND a.removed_at IS NULL AND r.deleted_at IS NULL LIMIT 1',
            )
            .get(id);
          this.db
            .prepare("UPDATE media_objects SET state='ready',unreferenced_at=? WHERE media_id=?")
            .run(live ? null : (current.unreferenced_at ?? this.now()), id);
        });
      });
    this.uploads.set(id, work);
    try {
      await work;
      return { state: 'ready' };
    } finally {
      if (this.uploads.get(id) === work) this.uploads.delete(id);
    }
  }
  async read(context: RequestContext, id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    requireHuman(context);
    const media = this.db.prepare('SELECT * FROM media_objects WHERE media_id=?').get(id) as
      MediaRow | undefined;
    if (!media || !this.access.canAccess(context, media.scope_id) || media.state !== 'ready')
      throw new NotFound();
    const permittedReference = this.db
      .prepare(
        `SELECT 1 FROM attachments a JOIN records r ON r.record_id=a.record_id JOIN visibility_scopes s ON s.scope_id=r.scope_id
      WHERE a.media_id=? AND (s.kind='shared' OR s.owner_person_id=?) LIMIT 1`,
      )
      .get(id, context.personId);
    const importReference =
      !permittedReference &&
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='recipe_import_media'").get() &&
      this.db
        .prepare(
          `SELECT 1 FROM recipe_import_media p JOIN worker_jobs j USING(job_id)
      JOIN records r ON r.record_id=j.target_record_id WHERE p.media_id=? AND r.scope_id=? AND r.deleted_at IS NULL`,
        )
        .get(id, media.scope_id);
    if (!permittedReference && !importReference && media.creator_client_id !== context.clientId)
      throw new NotFound();
    try {
      return { bytes: await this.files.read(media.storage_key), mimeType: media.mime_type };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFound();
      throw error;
    }
  }
  async collect(): Promise<number> {
    let collected = 0;
    const candidates = this.db
      .prepare(
        "SELECT media_id FROM media_objects WHERE state='deleting' OR (state IN ('ready','staging') AND protected_until<? AND COALESCE(unreferenced_at,created_at)<?) LIMIT 100",
      )
      .all(this.now(), this.now() - 86400000) as { media_id: string }[];
    for (const candidate of candidates) {
      await this.retention.collect(async () => {
        const claim = immediate(this.db, () => {
          const row = this.db
            .prepare('SELECT * FROM media_objects WHERE media_id=?')
            .get(candidate.media_id) as MediaRow;
          if (row.state !== 'deleting') {
            if (
              row.protected_until >= this.now() ||
              (row.unreferenced_at ?? row.created_at) >= this.now() - 86400000 ||
              this.uploads.has(row.media_id)
            )
              return null;
            if (
              this.db
                .prepare(
                  'SELECT 1 FROM attachments a JOIN records r ON r.record_id=a.record_id WHERE a.media_id=? AND a.removed_at IS NULL AND r.deleted_at IS NULL LIMIT 1',
                )
                .get(row.media_id)
            )
              return null;
            this.db.prepare("UPDATE media_objects SET state='deleting' WHERE media_id=?").run(row.media_id);
          }
          return row;
        });
        if (!claim) return;
        await this.files.remove(claim.storage_key);
        this.db
          .prepare(
            "UPDATE media_objects SET state='collected' WHERE media_id=? AND generation=? AND state='deleting'",
          )
          .run(claim.media_id, claim.generation);
        collected++;
      });
    }
    return collected;
  }
}
