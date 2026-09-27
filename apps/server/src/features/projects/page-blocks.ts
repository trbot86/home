import type { PageBlock } from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { Rejection } from '../../application/errors.js';
import type { HumanRequestContext } from '../access/access.js';
import type { RecordLinkPolicy } from '../records/record-links.js';

/** Blocks have stable page-owned identities; history belongs to the page root. */
export class PageBlocksRepository {
  constructor(
    private readonly db: Sqlite,
    private readonly links: RecordLinkPolicy,
  ) {}
  list(pageId: string): PageBlock[] {
    const rows = this.db
      .prepare('SELECT * FROM page_blocks WHERE page_id=? AND retired_at IS NULL ORDER BY position')
      .all(pageId) as Record<string, unknown>[];
    return rows.map((row) => {
      const base = { blockId: row.block_id, kind: row.kind };
      return {
        ...base,
        ...(row.kind === 'text'
          ? { text: row.text }
          : row.kind === 'web_link'
            ? { url: row.url, title: row.title, notes: row.notes }
            : row.kind === 'record_link'
              ? { recordId: row.target_record_id, caption: row.caption }
              : { attachmentId: row.attachment_id }),
      } as PageBlock;
    });
  }
  replace(
    context: HumanRequestContext,
    pageId: string,
    scopeId: string,
    blocks: PageBlock[],
    now: number,
    historical = false,
  ) {
    for (const block of blocks) {
      const previous = this.db
        .prepare('SELECT page_id,kind,target_record_id FROM page_blocks WHERE block_id=?')
        .get(block.blockId) as { page_id: string; kind: string; target_record_id: string | null } | undefined;
      if (previous && (previous.page_id !== pageId || previous.kind !== block.kind))
        throw new Rejection('block_identity_unavailable');
      if (block.kind === 'record_link')
        this.links.validate(
          context,
          scopeId,
          block.recordId,
          historical || previous?.target_record_id === block.recordId,
        );
    }
    this.db
      .prepare('UPDATE page_blocks SET retired_at=? WHERE page_id=? AND retired_at IS NULL')
      .run(now, pageId);
    const put = this.db
      .prepare(`INSERT INTO page_blocks(block_id,page_id,position,kind,text,url,title,notes,target_record_id,caption,attachment_id,retired_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(block_id) DO UPDATE SET position=excluded.position,text=excluded.text,url=excluded.url,title=excluded.title,notes=excluded.notes,target_record_id=excluded.target_record_id,caption=excluded.caption,attachment_id=excluded.attachment_id,retired_at=NULL`);
    blocks.forEach((block, position) =>
      put.run(
        block.blockId,
        pageId,
        position,
        block.kind,
        block.kind === 'text' ? block.text : null,
        block.kind === 'web_link' ? block.url : null,
        block.kind === 'web_link' ? block.title : null,
        block.kind === 'web_link' ? block.notes : null,
        block.kind === 'record_link' ? block.recordId : null,
        block.kind === 'record_link' ? block.caption : null,
        block.kind === 'attachment' ? block.attachmentId : null,
      ),
    );
  }
}
