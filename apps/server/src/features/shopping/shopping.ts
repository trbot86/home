import {
  emptyShopping,
  isValid,
  shoppingCommands,
  shoppingContentSchemas,
  type Command,
  type ShoppingKind,
  type ShoppingRecord,
  type ShoppingSnapshot,
  type RestockItem,
  type ShoppingEntry,
} from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { AccessService, type RequestContext } from '../access/access.js';
import type {
  RecordAdapter,
  RecordChange,
  RecordContent,
  TrackedRecord,
} from '../records/record-registry.js';
import { NotFound, Rejection } from '../../application/errors.js';
import type { CommandHandler } from '../records/command-handler.js';

export type ShoppingCommandKind = keyof typeof shoppingCommands;
const tables: Record<ShoppingKind, [string, string]> = {
  shopping_list: ['shopping_lists', 'shopping_list_id'],
  restock_item: ['restock_items', 'restock_item_id'],
  shopping_entry: ['shopping_entries', 'shopping_entry_id'],
  purchase: ['purchases', 'purchase_id'],
};
type HeaderRow = {
  record_id: string;
  kind: ShoppingKind;
  scope_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};
type Result = { records: TrackedRecord[]; changes: RecordChange[] };
export class ShoppingRepository {
  commands(): CommandHandler {
    return {
      kinds: Object.keys(shoppingCommands) as ShoppingCommandKind[],
      execute: (context, kind, payload, now) =>
        this.execute(context, kind as ShoppingCommandKind, payload, now),
    };
  }
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
  ) {}
  private content(kind: ShoppingKind, value: unknown): RecordContent {
    if (!isValid(shoppingContentSchemas[kind], value)) throw new Error('Invalid shopping history content');
    const content = value as RecordContent;
    if (
      ('name' in content && !String(content.name).trim()) ||
      ('label' in content && !String(content.label).trim())
    )
      throw new Rejection('name_required');
    if (content.productUrl) {
      try {
        const url = new URL(String(content.productUrl));
        if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error();
      } catch {
        throw new Rejection('invalid_product_url');
      }
    }
    return content;
  }
  adapters(): RecordAdapter[] {
    return (Object.keys(tables) as ShoppingKind[]).map((kind) => ({
      kind,
      payloadTable: tables[kind][0],
      payloadId: tables[kind][1],
      get: (context, id) => this.get(context, id, kind),
      setContent: (context, before, content, now) => this.setContent(context, before, content, now),
      project: (record) => this.project(record),
      validateContent: (content) => this.content(kind, content),
      ...(kind === 'shopping_list' ? { assertConsistent: () => this.assertConsistent() } : {}),
    }));
  }
  get(context: RequestContext, id: string, expectedKind?: ShoppingKind): TrackedRecord {
    const row = this.db.prepare('SELECT * FROM records WHERE record_id=?').get(id) as HeaderRow | undefined;
    if (
      !row ||
      !Object.hasOwn(tables, row.kind) ||
      (expectedKind && row.kind !== expectedKind) ||
      !this.access.canAccess(context, row.scope_id)
    )
      throw new NotFound();
    const [table, key] = tables[row.kind];
    const data = this.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(id) as Record<string, unknown>;
    if (!data) throw new Error('Shopping payload missing');
    let fields: Record<string, unknown>;
    if (row.kind === 'shopping_list') fields = { name: data.name, purpose: data.purpose };
    else if (row.kind === 'restock_item')
      fields = {
        name: data.name,
        model: data.model,
        quantity: data.quantity,
        notes: data.notes,
        productUrl: data.product_url,
      };
    else if (row.kind === 'shopping_entry')
      fields = {
        listId: data.shopping_list_id,
        restockItemId: data.restock_item_id,
        label: data.label,
        quantity: data.quantity,
        notes: data.notes,
        state: data.state,
        position: data.position,
      };
    else
      fields = {
        boughtAt: data.bought_at,
        buyerPersonId: data.buyer_person_id,
        buyerName: data.buyer_name,
        notes: data.notes,
        items: this.db
          .prepare(
            'SELECT purchase_item_id AS purchaseItemId,shopping_entry_id AS shoppingEntryId,label,quantity FROM purchase_items WHERE purchase_id=? ORDER BY purchase_item_id',
          )
          .all(id),
      };
    return {
      recordId: id,
      kind: row.kind,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      content: this.content(row.kind, { scopeId: row.scope_id, deletedAt: row.deleted_at, ...fields }),
    };
  }
  project(record: TrackedRecord): ShoppingRecord {
    const { recordId, kind, revision, createdAt, updatedAt } = record;
    return {
      recordId,
      kind,
      revision,
      createdAt,
      updatedAt,
      ...this.content(kind as ShoppingKind, record.content),
    } as ShoppingRecord;
  }
  snapshot(context: RequestContext): ShoppingSnapshot {
    const rows = this.db
      .prepare(
        `SELECT r.record_id FROM records r JOIN visibility_scopes s USING(scope_id)
      WHERE r.kind IN ('shopping_list','restock_item','shopping_entry','purchase') AND (s.kind='shared' OR s.owner_person_id=?)
      ORDER BY r.created_at,r.record_id LIMIT 2001`,
      )
      .all(context.personId) as { record_id: string }[];
    if (rows.length > 2000) throw new Rejection('cache_capacity_exceeded');
    const snapshot = emptyShopping();
    for (const row of rows) {
      const record = this.project(this.get(context, row.record_id));
      switch (record.kind) {
        case 'shopping_list':
          snapshot.lists.push(record);
          break;
        case 'restock_item':
          snapshot.restockItems.push(record);
          break;
        case 'shopping_entry':
          snapshot.entries.push(record);
          break;
        case 'purchase':
          snapshot.purchases.push(record);
          break;
      }
    }
    return snapshot;
  }
  private require(
    context: RequestContext,
    id: string,
    kind?: ShoppingKind,
    revision?: number,
  ): TrackedRecord {
    let record: TrackedRecord;
    try {
      record = this.get(context, id, kind);
    } catch (error) {
      if (error instanceof NotFound) throw new Rejection('unavailable');
      throw error;
    }
    if (revision !== undefined && record.revision !== revision) throw new Rejection('revision_conflict');
    return record;
  }
  private live(record: TrackedRecord): TrackedRecord {
    if (record.content.deletedAt !== null) throw new Rejection('deleted');
    return record;
  }
  private create(
    context: RequestContext,
    kind: ShoppingKind,
    id: string,
    value: RecordContent,
    now: number,
  ): TrackedRecord {
    const c = this.content(kind, value);
    this.access.requireScope(context, c.scopeId);
    if (this.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(id))
      throw new Rejection('id_unavailable');
    this.db.prepare('INSERT INTO records VALUES (?,?,?,1,?,?,NULL)').run(id, kind, c.scopeId, now, now);
    if (kind === 'shopping_list')
      this.db
        .prepare("INSERT INTO shopping_lists VALUES (?,'shopping_list',?,?,?)")
        .run(id, c.scopeId, c.name, c.purpose);
    else if (kind === 'restock_item')
      this.db
        .prepare("INSERT INTO restock_items VALUES (?,'restock_item',?,?,?,?,?,?)")
        .run(id, c.scopeId, c.name, c.model, c.quantity, c.notes, c.productUrl);
    else if (kind === 'shopping_entry')
      this.db
        .prepare("INSERT INTO shopping_entries VALUES (?,'shopping_entry',?,?,?,?,?,?,?,?,1)")
        .run(id, c.scopeId, c.listId, c.restockItemId, c.label, c.quantity, c.notes, c.state, c.position);
    else {
      this.db
        .prepare("INSERT INTO purchases VALUES (?,'purchase',?,?,?,?,?)")
        .run(id, c.scopeId, c.boughtAt, c.buyerPersonId, c.buyerName, c.notes);
      for (const item of (
        this.project({
          recordId: id,
          kind,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          content: c,
        }) as Extract<ShoppingRecord, { kind: 'purchase' }>
      ).items) {
        if (this.db.prepare('SELECT 1 FROM purchase_items WHERE purchase_item_id=?').get(item.purchaseItemId))
          throw new Rejection('id_unavailable');
        this.db
          .prepare('INSERT INTO purchase_items VALUES (?,?,?,?,?,?)')
          .run(item.purchaseItemId, id, c.scopeId, item.shoppingEntryId, item.label, item.quantity);
      }
    }
    return this.get(context, id, kind);
  }
  private setContent(
    context: RequestContext,
    before: TrackedRecord,
    value: RecordContent,
    now: number,
  ): TrackedRecord {
    const c = this.content(before.kind as ShoppingKind, value);
    if (c.scopeId !== before.content.scopeId) throw new Rejection('scope_change_not_supported');
    const id = before.recordId;
    if (before.kind === 'shopping_list')
      this.db
        .prepare('UPDATE shopping_lists SET name=?,purpose=? WHERE shopping_list_id=?')
        .run(c.name, c.purpose, id);
    else if (before.kind === 'restock_item')
      this.db
        .prepare(
          'UPDATE restock_items SET name=?,model=?,quantity=?,notes=?,product_url=? WHERE restock_item_id=?',
        )
        .run(c.name, c.model, c.quantity, c.notes, c.productUrl, id);
    else if (before.kind === 'shopping_entry') {
      const list = this.require(context, String(c.listId), 'shopping_list');
      if (list.content.scopeId !== c.scopeId) throw new Rejection('scope_mismatch');
      // Check the final slot before the unique index, including resurrection by undo.
      if (
        c.deletedAt === null &&
        c.state === 'needed' &&
        c.restockItemId &&
        this.needed(String(c.listId), String(c.restockItemId), id)
      )
        throw new Rejection('restock_already_needed');
      this.db
        .prepare(
          'UPDATE shopping_entries SET shopping_list_id=?,label=?,quantity=?,notes=?,state=?,position=? WHERE shopping_entry_id=?',
        )
        .run(c.listId, c.label, c.quantity, c.notes, c.state, c.position, id);
      if (c.restockItemId !== before.content.restockItemId) throw new Error('Restock identity cannot change');
    } else {
      const { deletedAt: _old, ...old } = before.content;
      const { deletedAt: _next, ...next } = c;
      if (JSON.stringify(old) !== JSON.stringify(next)) throw new Error('Purchase snapshots are immutable');
    }
    this.db
      .prepare('UPDATE records SET revision=revision+1,updated_at=?,deleted_at=? WHERE record_id=?')
      .run(now, c.deletedAt, id);
    return this.get(context, id);
  }
  private needed(listId: string, restockId: string, except = ''): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT shopping_entry_id AS id FROM shopping_entries WHERE shopping_list_id=? AND restock_item_id=? AND state='needed' AND is_live=1 AND shopping_entry_id<>?",
        )
        .get(listId, restockId, except) as { id: string } | undefined
    )?.id;
  }
  private position(listId: string): number {
    return (
      this.db
        .prepare('SELECT COALESCE(MAX(position),-1)+1 AS next FROM shopping_entries WHERE shopping_list_id=?')
        .get(listId) as { next: number }
    ).next;
  }
  execute(context: RequestContext, kind: ShoppingCommandKind, payload: unknown, now: number): Result {
    const created = (after: TrackedRecord): Result => ({
      records: [after],
      changes: [{ before: null, after }],
    });
    const changed = (before: TrackedRecord, c: RecordContent): Result => {
      const after = this.setContent(context, before, c, now);
      return { records: [after], changes: [{ before, after }] };
    };
    if (kind === 'CreateShoppingList' || kind === 'CreateRestockItem') {
      const { recordId, ...content } = payload as Command<'CreateShoppingList'>['arguments'];
      return created(
        this.create(
          context,
          kind === 'CreateShoppingList' ? 'shopping_list' : 'restock_item',
          recordId,
          { ...content, deletedAt: null },
          now,
        ),
      );
    }
    if (kind === 'AddShoppingEntry' || kind === 'NeedRestockItem') {
      const args = payload as Command<'AddShoppingEntry'>['arguments'];
      const list = this.live(this.require(context, args.listId, 'shopping_list'));
      let fields = { label: args.label, quantity: args.quantity, notes: args.notes },
        restockItemId: string | null = null;
      if (kind === 'NeedRestockItem') {
        const need = payload as Command<'NeedRestockItem'>['arguments'];
        const restock = this.live(
          this.require(context, need.restockItemId, 'restock_item', need.expectedRestockRevision),
        );
        if (restock.content.scopeId !== list.content.scopeId) throw new Rejection('scope_mismatch');
        restockItemId = restock.recordId;
        const existing = this.needed(args.listId, restockItemId);
        if (existing) return { records: [this.get(context, existing)], changes: [] };
        const product = this.project(restock) as RestockItem;
        fields = { label: product.name, quantity: product.quantity, notes: product.notes };
      }
      return created(
        this.create(
          context,
          'shopping_entry',
          args.recordId,
          {
            ...fields,
            scopeId: list.content.scopeId,
            deletedAt: null,
            listId: args.listId,
            restockItemId,
            state: 'needed',
            position: this.position(args.listId),
          },
          now,
        ),
      );
    }
    const args = payload as Command<'DeleteShoppingRecord'>['arguments'];
    const expected =
      kind === 'UpdateShoppingList'
        ? 'shopping_list'
        : kind === 'UpdateRestockItem'
          ? 'restock_item'
          : ['UpdateShoppingEntry', 'MoveShoppingEntry', 'PurchaseShoppingEntry'].includes(kind)
            ? 'shopping_entry'
            : undefined;
    const before = this.require(context, args.recordId, expected, args.expectedRevision);
    if (kind === 'DeleteShoppingRecord' || kind === 'RestoreShoppingRecord') {
      if (before.kind === 'purchase') throw new Rejection('use_purchase_undo');
      const deleting = kind === 'DeleteShoppingRecord';
      if (deleting === (before.content.deletedAt !== null))
        throw new Rejection(deleting ? 'already_deleted' : 'not_deleted');
      return changed(before, { ...before.content, deletedAt: deleting ? now : null });
    }
    this.live(before);
    if (kind === 'PurchaseShoppingEntry') {
      const buy = payload as Command<'PurchaseShoppingEntry'>['arguments'];
      const item = this.project(before) as ShoppingEntry;
      if (item.state !== 'needed') throw new Rejection('item_not_needed');
      const person = this.db
        .prepare('SELECT display_name FROM people WHERE person_id=?')
        .get(context.personId) as { display_name: string };
      const purchase = this.create(
        context,
        'purchase',
        buy.purchaseId,
        {
          scopeId: item.scopeId,
          deletedAt: null,
          boughtAt: buy.boughtAt,
          buyerPersonId: context.personId,
          buyerName: person.display_name,
          notes: '',
          items: [
            {
              purchaseItemId: buy.purchaseItemId,
              shoppingEntryId: item.recordId,
              label: item.label,
              quantity: item.quantity,
            },
          ],
        },
        now,
      );
      const result = changed(before, { ...before.content, state: 'purchased' });
      return {
        records: [...result.records, purchase],
        changes: [...result.changes, { before: null, after: purchase }],
      };
    }
    if (kind === 'MoveShoppingEntry') {
      const move = payload as Command<'MoveShoppingEntry'>['arguments'];
      const list = this.live(this.require(context, move.listId, 'shopping_list'));
      if (list.content.scopeId !== before.content.scopeId) throw new Rejection('scope_mismatch');
      return changed(before, {
        ...before.content,
        listId: move.listId,
        position: this.position(move.listId),
      });
    }
    const { recordId: _id, expectedRevision: _revision, ...fields } = payload as Record<string, unknown>;
    return changed(before, { ...before.content, ...fields });
  }
  private assertConsistent(): void {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM shopping_entries e JOIN records r ON r.record_id=e.shopping_entry_id
      JOIN records l ON l.record_id=e.shopping_list_id WHERE r.deleted_at IS NULL AND l.deleted_at IS NOT NULL LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('list_contains_items');
    if (
      this.db
        .prepare(
          `SELECT 1 FROM purchase_items i JOIN records p ON p.record_id=i.purchase_id JOIN shopping_entries e ON e.shopping_entry_id=i.shopping_entry_id
      WHERE p.deleted_at IS NULL AND e.state<>'purchased' LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('purchase_dependency_changed');
    if (
      this.db
        .prepare(
          `SELECT 1 FROM shopping_entries e WHERE
      (SELECT count(*) FROM purchase_items i JOIN records p ON p.record_id=i.purchase_id WHERE i.shopping_entry_id=e.shopping_entry_id AND p.deleted_at IS NULL)
      <> CASE WHEN e.state='purchased' THEN 1 ELSE 0 END LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('purchase_dependency_changed');
    if (
      this.db
        .prepare(
          `SELECT 1 FROM shopping_entries e JOIN records r ON r.record_id=e.shopping_entry_id WHERE e.is_live<>(r.deleted_at IS NULL) LIMIT 1`,
        )
        .get()
    )
      throw new Error('Restock live-index invariant failed');
  }
}
