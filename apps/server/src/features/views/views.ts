import { randomUUID } from 'node:crypto';
import {
  AgendaLayout,
  agendaSectionKinds,
  isValid,
  type Command,
  type SavedView,
} from '@our-place/contracts';
import { Rejection } from '../../application/errors.js';
import type { Sqlite } from '../../infrastructure/database.js';
import { AccessService, requireHuman, type HumanRequestContext } from '../access/access.js';
import type { CommandHandler } from '../records/command-handler.js';
import { RecordLinkPolicy } from '../records/record-links.js';

type ViewRow = {
  view_id: string;
  scope_id: string;
  kind: SavedView['kind'];
  revision: number;
  context_record_id: string | null;
  layout_json?: string | null;
};
export class ViewPreferences {
  private readonly links: RecordLinkPolicy;
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
  ) {
    this.links = new RecordLinkPolicy(db, access);
  }
  private pins(viewId: string): SavedView['pins'] {
    return this.db
      .prepare(
        'SELECT record_id AS recordId,position FROM record_pins WHERE view_id=? ORDER BY position,record_id',
      )
      .all(viewId) as SavedView['pins'];
  }
  snapshot(context: HumanRequestContext): SavedView[] {
    requireHuman(context);
    const views = this.db
      .prepare(
        `SELECT v.* FROM saved_views v JOIN visibility_scopes s USING(scope_id) WHERE s.kind='shared' OR s.owner_person_id=? ORDER BY v.view_id`,
      )
      .all(context.personId) as ViewRow[];
    return views.map((view) => ({
      viewId: view.view_id,
      scopeId: view.scope_id,
      revision: view.revision,
      ...(view.kind === 'food_soon'
        ? { kind: 'food_soon' as const }
        : view.kind === 'project_next'
          ? { kind: 'project_next' as const, projectId: view.context_record_id! }
          : { kind: 'agenda' as const, layout: this.readLayout(view.layout_json) }),
      pins: this.pins(view.view_id),
    }));
  }
  commands(): CommandHandler {
    return {
      kinds: ['SetRecordPin', 'SetViewPinOrder', 'SetAgendaLayout'],
      execute: (context, kind, payload) => {
        requireHuman(context);
        if (!this.db.inTransaction) throw new Error('Pins require a receipt transaction');
        if (kind === 'SetAgendaLayout')
          this.setAgendaLayout(context, payload as Command<'SetAgendaLayout'>['arguments']);
        else if (kind === 'SetRecordPin')
          this.setPin(context, payload as Command<'SetRecordPin'>['arguments']);
        else this.setOrder(context, payload as Command<'SetViewPinOrder'>['arguments']);
        return { records: [], changes: [] };
      },
    };
  }
  private readLayout(json: string | null | undefined) {
    const value: unknown = JSON.parse(json ?? 'null');
    if (
      !isValid(AgendaLayout, value) ||
      new Set(value.sections.map((s) => s.kind)).size !== agendaSectionKinds.length
    )
      throw new Error('Stored agenda layout is invalid');
    return value;
  }
  private setAgendaLayout(context: HumanRequestContext, args: Command<'SetAgendaLayout'>['arguments']) {
    const scope = this.access
      .scopes(context)
      .find((scope) => scope.scopeId === args.scopeId && scope.kind === 'private');
    if (!scope) throw new Rejection('private_view_required');
    if (new Set(args.layout.sections.map((section) => section.kind)).size !== agendaSectionKinds.length)
      throw new Rejection('invalid_agenda_sections');
    const row = this.db
      .prepare("SELECT * FROM saved_views WHERE scope_id=? AND kind='agenda'")
      .get(args.scopeId) as ViewRow | undefined;
    if ((row?.revision ?? 0) !== args.expectedViewRevision) throw new Rejection('view_revision_conflict');
    const json = JSON.stringify(args.layout);
    if (row)
      this.db
        .prepare('UPDATE saved_views SET layout_json=?,revision=revision+1 WHERE view_id=?')
        .run(json, row.view_id);
    else
      this.db
        .prepare(
          "INSERT INTO saved_views(view_id,scope_id,kind,revision,layout_json) VALUES (?,?,'agenda',1,?)",
        )
        .run(randomUUID(), args.scopeId, json);
  }
  private requireProject(scopeId: string, projectId: string) {
    if (
      !this.db
        .prepare(
          'SELECT 1 FROM projects p JOIN records r ON r.record_id=p.project_id WHERE p.project_id=? AND p.scope_id=? AND r.deleted_at IS NULL',
        )
        .get(projectId, scopeId)
    )
      throw new Rejection('unavailable');
  }
  private setPin(context: HumanRequestContext, args: Command<'SetRecordPin'>['arguments']) {
    this.access.requireScope(context, args.scopeId);
    const projectId = args.viewKind === 'project_next' ? args.projectId : null;
    if (projectId) this.requireProject(args.scopeId, projectId);
    let targetScopeId: string;
    if (args.viewKind === 'food_soon') {
      const target = this.db
        .prepare("SELECT deleted_at FROM records WHERE record_id=? AND scope_id=? AND kind='recipe'")
        .get(args.recordId, args.scopeId) as { deleted_at: number | null } | undefined;
      if (!target || (args.pinned && target.deleted_at !== null)) throw new Rejection('unavailable');
      targetScopeId = args.scopeId;
    } else targetScopeId = this.links.validate(context, args.scopeId, args.recordId, !args.pinned);
    let view = this.db
      .prepare('SELECT * FROM saved_views WHERE scope_id=? AND kind=? AND context_record_id IS ?')
      .get(args.scopeId, args.viewKind, projectId) as ViewRow | undefined;
    if ((view?.revision ?? 0) !== args.expectedViewRevision) throw new Rejection('view_revision_conflict');
    const pins = view ? this.pins(view.view_id) : [];
    if (args.pinned && pins.length >= 200 && !pins.some((p) => p.recordId === args.recordId))
      throw new Rejection('view_pin_limit');
    if (!view) {
      view = {
        view_id: randomUUID(),
        scope_id: args.scopeId,
        kind: args.viewKind,
        revision: 1,
        context_record_id: projectId,
      };
      this.db
        .prepare(
          'INSERT INTO saved_views(view_id,scope_id,kind,revision,context_record_id) VALUES (?,?,?,1,?)',
        )
        .run(view.view_id, args.scopeId, args.viewKind, projectId);
    } else this.db.prepare('UPDATE saved_views SET revision=revision+1 WHERE view_id=?').run(view.view_id);
    if (args.pinned)
      this.db
        .prepare(
          `INSERT INTO record_pins(view_id,scope_id,record_id,target_scope_id,position)
      SELECT ?,?,?,?,COALESCE(MAX(position),-1)+1 FROM record_pins WHERE view_id=? ON CONFLICT(view_id,record_id) DO NOTHING`,
        )
        .run(view.view_id, args.scopeId, args.recordId, targetScopeId, view.view_id);
    else
      this.db
        .prepare('DELETE FROM record_pins WHERE view_id=? AND record_id=?')
        .run(view.view_id, args.recordId);
  }
  private setOrder(context: HumanRequestContext, args: Command<'SetViewPinOrder'>['arguments']) {
    const view = this.db.prepare('SELECT * FROM saved_views WHERE view_id=?').get(args.viewId) as
      ViewRow | undefined;
    if (!view || !this.access.canAccess(context, view.scope_id)) throw new Rejection('unavailable');
    if (view.kind === 'agenda') throw new Rejection('view_does_not_support_pins');
    if (view.context_record_id) this.requireProject(view.scope_id, view.context_record_id);
    if (view.revision !== args.expectedViewRevision) throw new Rejection('view_revision_conflict');
    const current = this.pins(view.view_id),
      ids = new Set(args.recordIds);
    if (
      ids.size !== args.recordIds.length ||
      current.length !== ids.size ||
      current.some((p) => !ids.has(p.recordId))
    )
      throw new Rejection('view_pins_changed');
    const update = this.db.prepare('UPDATE record_pins SET position=? WHERE view_id=? AND record_id=?');
    args.recordIds.forEach((id, position) => update.run(position, view.view_id, id));
    this.db.prepare('UPDATE saved_views SET revision=revision+1 WHERE view_id=?').run(view.view_id);
  }
}
