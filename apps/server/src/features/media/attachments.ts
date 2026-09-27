import type { Attachment } from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { Deferral, Rejection } from '../../application/errors.js';
import { AccessService, type HumanRequestContext as RequestContext } from '../access/access.js';
import type { MediaRow } from './media.js';

/** Placements belong to their parent record's revision, transaction and history. */
export class AttachmentRepository {
  constructor(private readonly db: Sqlite, private readonly access: AccessService) {}
  list(recordId: string): Attachment[] {
    const rows = this.db.prepare(`SELECT a.attachment_id AS attachmentId,a.media_id AS mediaId,m.digest,
      m.byte_length AS byteLength,m.mime_type AS mimeType,a.caption,a.position FROM attachments a
      JOIN media_objects m USING(media_id) WHERE a.record_id=? AND a.removed_at IS NULL ORDER BY a.position`).all(recordId) as
      (Attachment & { caption: string | null })[];
    return rows.map(({ caption, ...rest }) => caption === null ? rest : { ...rest, caption });
  }
  replace(context: RequestContext, recordId: string, scopeId: string, next: Attachment[], now: number,
    options: { creating?: boolean; live: boolean }): void {
    if (!this.db.inTransaction) throw new Error('Attachments must share the parent transaction');
    this.access.requireScope(context, scopeId);
    if (next.length > 20 || new Set(next.map(a => a.attachmentId)).size !== next.length ||
      new Set(next.map(a => a.position)).size !== next.length) throw new Rejection('duplicate_attachment');
    for (const a of next) {
      const previous = this.db.prepare('SELECT record_id,media_id,removed_at FROM attachments WHERE attachment_id=?').get(a.attachmentId) as
        { record_id: string; media_id: string; removed_at: number | null } | undefined;
      if (previous && (options.creating || previous.record_id !== recordId || previous.media_id !== a.mediaId))
        throw new Rejection('id_unavailable');
      const media = this.db.prepare('SELECT * FROM media_objects WHERE media_id=?').get(a.mediaId) as MediaRow | undefined;
      if (!media) throw new Deferral('media_not_ready');
      if (media.scope_id !== scopeId || media.digest !== a.digest || media.byte_length !== a.byteLength || media.mime_type !== a.mimeType)
        throw new Rejection('media_unavailable');
      // A fresh upload is private to its client until attached. Existing same-scope media can be reused.
      if (media.creator_client_id !== context.clientId && !this.db.prepare(`SELECT 1 FROM attachments a
        JOIN records r ON r.record_id=a.record_id WHERE a.media_id=? AND r.scope_id=? LIMIT 1`).get(a.mediaId, scopeId))
        throw new Rejection('media_unavailable');
      if (options.live && media.state !== 'ready') {
        if (previous) throw new Rejection('media_unavailable');
        throw new Deferral('media_not_ready');
      }
    }
    const affected = new Set([...this.list(recordId), ...next].map(a => a.mediaId));
    // Vacate every live position before a reorder, then reactivate stable placement IDs.
    this.db.prepare('UPDATE attachments SET removed_at=? WHERE record_id=? AND removed_at IS NULL').run(now, recordId);
    const put = this.db.prepare(`INSERT INTO attachments(attachment_id,record_id,media_id,caption,position,removed_at)
      VALUES (?,?,?,?,?,NULL) ON CONFLICT(attachment_id) DO UPDATE SET caption=excluded.caption,position=excluded.position,removed_at=NULL`);
    for (const a of next) put.run(a.attachmentId, recordId, a.mediaId, a.caption ?? null, a.position);
    for (const mediaId of affected) this.refreshRetention(mediaId, now);
  }
  private refreshRetention(mediaId: string, now: number): void {
    const live = this.db.prepare(`SELECT 1 FROM attachments a JOIN records r ON r.record_id=a.record_id
      WHERE a.media_id=? AND a.removed_at IS NULL AND r.deleted_at IS NULL LIMIT 1`).get(mediaId);
    this.db.prepare(live ? 'UPDATE media_objects SET unreferenced_at=NULL WHERE media_id=?' :
      'UPDATE media_objects SET unreferenced_at=COALESCE(unreferenced_at,?) WHERE media_id=?').run(...(live ? [mediaId] : [now, mediaId]));
  }
}
