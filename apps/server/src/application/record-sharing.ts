import { createHash } from 'node:crypto';
import type { SharingPreview, Command } from '@our-place/contracts';
import { installation, type Sqlite } from '../infrastructure/database.js';
import { requireHuman, type AccessService, type HumanRequestContext } from '../features/access/access.js';
import type { RecordRegistry } from '../features/records/record-registry.js';
import type { CommandHandler } from '../features/records/command-handler.js';
import { Rejection } from './errors.js';

// Scope-bearing relational payloads. History and receipts retain their original bytes.
const tables = [
  'shopping_lists',
  'restock_items',
  'shopping_entries',
  'purchases',
  'purchase_items',
  'tasks',
  'task_occurrences',
  'task_completions',
  'home_assets',
  'maintenance_plans',
  'maintenance_records',
  'recipes',
  'recipe_collections',
  'recipe_collection_memberships',
  'recipe_cooking_records',
  'shopping_groups',
  'shopping_entry_groups',
  'recipe_shopping_sources',
  'projects',
  'project_pages',
  'inbox_destinations',
  'suggestion_workflows',
  'suggestion_messages',
  'suggestion_runs',
  'suggestion_work_requests',
  'suggestion_run_inputs',
  'suggestion_question_resolutions',
  'worker_jobs',
  'recipe_imports',
] as const;
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
export class RecordSharing {
  constructor(
    private db: Sqlite,
    private access: AccessService,
    private records: RecordRegistry,
  ) {}
  private plan(context: HumanRequestContext, id: string) {
    requireHuman(context);
    const root = this.records.get(context, id);
    const scope = root.content.scopeId;
    const owner = this.db
      .prepare("SELECT owner_person_id FROM visibility_scopes WHERE scope_id=? AND kind='private'")
      .get(scope) as { owner_person_id: string } | undefined;
    if (!owner || owner.owner_person_id !== context.personId) throw new Rejection('already_shared');
    const ids = this.db
      .prepare('SELECT record_id FROM records WHERE scope_id=? ORDER BY record_id')
      .all(scope) as { record_id: string }[];
    const records = ids.map((row) => this.records.get(context, row.record_id));
    const known = new Set(ids.map((row) => row.record_id));
    const media = this.db.prepare('SELECT media_id FROM media_objects WHERE scope_id=?').all(scope) as {
      media_id: string;
    }[];
    for (const row of media) known.add(row.media_id);
    const edges: string[][] = [];
    const edge = (values: unknown) =>
      edges.push([...new Set(strings(values).filter((value) => known.has(value)))]);
    for (const record of records) {
      edge([record.recordId, record.content]);
      const history = this.db
        .prepare('SELECT delta_json FROM record_changes WHERE record_id=?')
        .all(record.recordId) as { delta_json: string }[];
      for (const row of history) edge([record.recordId, JSON.parse(row.delta_json)]);
    }
    const rows = tables.flatMap((table) =>
      (
        this.db
          .prepare(`SELECT rowid AS sharing_rowid,* FROM ${table} WHERE scope_id=?`)
          .all(scope) as Record<string, unknown>[]
      ).map((row) => {
        edge(Object.values(row));
        return { table, row };
      }),
    );
    for (const row of this.db
      .prepare(
        'SELECT a.record_id,a.media_id FROM attachments a JOIN records r USING(record_id) WHERE r.scope_id=?',
      )
      .all(scope))
      edge(row);
    for (const row of this.db
      .prepare(
        'SELECT j.target_record_id,m.media_id FROM recipe_import_media m JOIN worker_jobs j USING(job_id) WHERE j.scope_id=?',
      )
      .all(scope))
      edge(row);
    const views = this.db
      .prepare('SELECT * FROM saved_views WHERE scope_id=? AND context_record_id IS NOT NULL')
      .all(scope) as { view_id: string; context_record_id: string }[];
    for (const view of views) {
      const pins = this.db.prepare('SELECT record_id FROM record_pins WHERE view_id=?').all(view.view_id);
      edge([view.context_record_id, pins]);
    }
    const selected = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const group of edges)
        if (group.some((value) => selected.has(value)))
          for (const value of group)
            if (!selected.has(value)) {
              selected.add(value);
              changed = true;
            }
    }
    const affected = records.filter((record) => selected.has(record.recordId));
    if (affected.length > 1000) throw new Rejection('sharing_group_too_large');
    const selectedRows = rows.filter(({ row }) => strings(row).some((value) => selected.has(value)));
    const selectedViews = views.filter((view) => selected.has(view.context_record_id));
    const token = createHash('sha256')
      .update(
        JSON.stringify({
          epoch: installation(this.db).recovery_epoch,
          affected,
          selectedRows,
          selectedViews,
          selected: [...selected].sort(),
        }),
      )
      .digest('hex');
    return { scope, affected, selected, selectedRows, selectedViews, token };
  }
  preview(context: HumanRequestContext, id: string): SharingPreview {
    const plan = this.plan(context, id);
    const notices: string[] = [];
    if (plan.selectedRows.some(({ table, row }) => table === 'recipe_imports' && row.active === 1))
      notices.push('Unfinished recipe imports will stop. Any fetched results remain available for review.');
    if (plan.selectedRows.some(({ table, row }) => table === 'recipe_collections' && row.role !== null))
      notices.push('Personal recipe collections keep their names as shared collections.');
    return {
      recordId: id,
      token: plan.token,
      notices,
      records: plan.affected.map((record) => ({
        recordId: record.recordId,
        revision: record.revision,
        kind: record.kind,
        title: String(
          record.content.title ??
            record.content.name ??
            record.content.label ??
            record.content.text ??
            record.kind,
        ).slice(0, 300),
        deleted: record.content.deletedAt !== null,
      })),
    };
  }
  commands(): CommandHandler {
    return {
      kinds: ['ShareRecords'],
      execute: (context, _kind, payload, now) => {
        if (!this.db.inTransaction) throw new Error('Sharing requires the receipt transaction');
        const args = payload as Command<'ShareRecords'>['arguments'];
        const plan = this.plan(context, args.recordId);
        if (plan.token !== args.token) throw new Rejection('sharing_preview_changed');
        const shared = this.access.scopes(context).find((scope) => scope.kind === 'shared')!.scopeId;
        // Cross-table scope keys are checked after the entire connected group moves.
        this.db.pragma('defer_foreign_keys = ON');
        for (const before of plan.affected)
          this.db
            .prepare('UPDATE records SET scope_id=?,revision=revision+1,updated_at=? WHERE record_id=?')
            .run(shared, now, before.recordId);
        for (const { table, row } of plan.selectedRows) {
          if (table === 'recipe_imports' && row.active === 1) {
            this.db
              .prepare(
                'UPDATE background_jobs SET state=?,error_code=?,lease_token=NULL,lease_until=NULL WHERE job_id=?',
              )
              .run(row.result_json ? 'review' : 'abandoned', 'visibility_changed', row.job_id);
            this.db.prepare('UPDATE recipe_imports SET active=0 WHERE rowid=?').run(row.sharing_rowid);
          }
          // Keep named collections without colliding with household built-in collection roles.
          if (table === 'recipe_collections')
            this.db.prepare('UPDATE recipe_collections SET role=NULL WHERE rowid=?').run(row.sharing_rowid);
          if (table === 'inbox_destinations')
            this.db
              .prepare('UPDATE inbox_destinations SET scope_id=?,target_scope_id=? WHERE rowid=?')
              .run(shared, shared, row.sharing_rowid);
          else this.db.prepare(`UPDATE ${table} SET scope_id=? WHERE rowid=?`).run(shared, row.sharing_rowid);
        }
        for (const id of plan.selected)
          this.db
            .prepare('UPDATE media_objects SET scope_id=? WHERE media_id=? AND scope_id=?')
            .run(shared, id, plan.scope);
        for (const view of plan.selectedViews) {
          this.db
            .prepare('UPDATE saved_views SET scope_id=?,revision=revision+1 WHERE view_id=?')
            .run(shared, view.view_id);
          this.db
            .prepare('UPDATE record_pins SET scope_id=?,target_scope_id=? WHERE view_id=?')
            .run(shared, shared, view.view_id);
        }
        for (const before of plan.affected) {
          this.db
            .prepare('UPDATE record_pins SET target_scope_id=? WHERE record_id=?')
            .run(shared, before.recordId);
          this.db
            .prepare('UPDATE inbox_destinations SET target_scope_id=? WHERE target_record_id=?')
            .run(shared, before.recordId);
        }
        if ((this.db.pragma('foreign_key_check') as unknown[]).length)
          throw new Rejection('sharing_related_records_changed');
        const changes = plan.affected.map((before) => ({
          before,
          after: this.records.get(context, before.recordId),
        }));
        return { records: changes.map((change) => change.after), changes };
      },
    };
  }
}
