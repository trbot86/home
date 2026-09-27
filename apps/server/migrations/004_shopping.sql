INSERT INTO record_kinds VALUES ('shopping_list'),('restock_item'),('shopping_entry'),('purchase');
CREATE UNIQUE INDEX records_id_scope ON records(record_id,scope_id);
CREATE TABLE shopping_lists (
  shopping_list_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'shopping_list' CHECK(record_kind='shopping_list'),
  scope_id TEXT NOT NULL, name TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('groceries','household','wants','gifts')),
  UNIQUE(shopping_list_id,scope_id),
  FOREIGN KEY(shopping_list_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(shopping_list_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE TABLE restock_items (
  restock_item_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'restock_item' CHECK(record_kind='restock_item'),
  scope_id TEXT NOT NULL, name TEXT NOT NULL, model TEXT NOT NULL, quantity TEXT NOT NULL, notes TEXT NOT NULL, product_url TEXT,
  UNIQUE(restock_item_id,scope_id),
  FOREIGN KEY(restock_item_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(restock_item_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE TABLE shopping_entries (
  shopping_entry_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'shopping_entry' CHECK(record_kind='shopping_entry'),
  scope_id TEXT NOT NULL, shopping_list_id TEXT NOT NULL, restock_item_id TEXT,
  label TEXT NOT NULL, quantity TEXT NOT NULL, notes TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('needed','purchased','cancelled')), position INTEGER NOT NULL CHECK(position>=0),
  -- A maintained index predicate: the registry remains the source of deletion time.
  is_live INTEGER NOT NULL DEFAULT 1 CHECK(is_live IN (0,1)),
  UNIQUE(shopping_entry_id,scope_id),
  FOREIGN KEY(shopping_entry_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(shopping_entry_id,scope_id) REFERENCES records(record_id,scope_id),
  FOREIGN KEY(shopping_list_id,scope_id) REFERENCES shopping_lists(shopping_list_id,scope_id),
  FOREIGN KEY(restock_item_id,scope_id) REFERENCES restock_items(restock_item_id,scope_id)
) STRICT;
CREATE UNIQUE INDEX one_needed_restock ON shopping_entries(shopping_list_id,restock_item_id)
  WHERE state='needed' AND is_live=1 AND restock_item_id IS NOT NULL;
CREATE INDEX shopping_entries_order ON shopping_entries(shopping_list_id,state,position,shopping_entry_id);
CREATE INDEX shopping_entries_restock ON shopping_entries(restock_item_id);
CREATE TRIGGER shopping_entry_live AFTER UPDATE OF deleted_at ON records WHEN NEW.kind='shopping_entry'
BEGIN UPDATE shopping_entries SET is_live=(NEW.deleted_at IS NULL) WHERE shopping_entry_id=NEW.record_id; END;
CREATE TABLE purchases (
  purchase_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'purchase' CHECK(record_kind='purchase'),
  scope_id TEXT NOT NULL, bought_at INTEGER NOT NULL, buyer_person_id TEXT NOT NULL REFERENCES people(person_id),
  buyer_name TEXT NOT NULL, notes TEXT NOT NULL,
  UNIQUE(purchase_id,scope_id),
  FOREIGN KEY(purchase_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(purchase_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE TABLE purchase_items (
  purchase_item_id TEXT PRIMARY KEY NOT NULL, purchase_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  shopping_entry_id TEXT NOT NULL, label TEXT NOT NULL, quantity TEXT NOT NULL,
  FOREIGN KEY(purchase_id,scope_id) REFERENCES purchases(purchase_id,scope_id),
  FOREIGN KEY(shopping_entry_id,scope_id) REFERENCES shopping_entries(shopping_entry_id,scope_id)
) STRICT;
CREATE INDEX purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX purchase_items_entry ON purchase_items(shopping_entry_id);
