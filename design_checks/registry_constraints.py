"""Design probe, not a migration or application implementation.

Run: python design_checks/registry_constraints.py
Uses only an in-memory SQLite database. Some tests deliberately demonstrate
what foreign keys CANNOT enforce, so the application contract stays explicit.
"""

import sqlite3
import unittest


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE records (
    record_id TEXT NOT NULL PRIMARY KEY,
    record_kind TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    UNIQUE(record_id, record_kind)
);
CREATE TABLE notes (
    note_id TEXT NOT NULL PRIMARY KEY,
    record_kind TEXT NOT NULL DEFAULT 'note' CHECK(record_kind = 'note'),
    body TEXT NOT NULL,
    FOREIGN KEY(note_id, record_kind) REFERENCES records(record_id, record_kind)
);
CREATE TABLE tasks (
    task_id TEXT NOT NULL PRIMARY KEY,
    record_kind TEXT NOT NULL DEFAULT 'task' CHECK(record_kind = 'task'),
    FOREIGN KEY(task_id, record_kind) REFERENCES records(record_id, record_kind)
);
CREATE TABLE task_occurrences (
    occurrence_id TEXT NOT NULL PRIMARY KEY,
    record_kind TEXT NOT NULL DEFAULT 'occurrence' CHECK(record_kind = 'occurrence'),
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    ordinal INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','completed','skipped','cancelled')),
    UNIQUE(task_id, ordinal),
    FOREIGN KEY(occurrence_id, record_kind) REFERENCES records(record_id, record_kind)
);
CREATE UNIQUE INDEX one_open_occurrence
    ON task_occurrences(task_id) WHERE state = 'open';
CREATE TABLE task_completions (
    completion_id TEXT NOT NULL PRIMARY KEY,
    record_kind TEXT NOT NULL DEFAULT 'completion' CHECK(record_kind = 'completion'),
    occurrence_id TEXT NOT NULL REFERENCES task_occurrences(occurrence_id),
    voided_at INTEGER,
    FOREIGN KEY(completion_id, record_kind) REFERENCES records(record_id, record_kind)
);
CREATE UNIQUE INDEX one_unvoided_completion
    ON task_completions(occurrence_id) WHERE voided_at IS NULL;
CREATE TABLE shopping_lists (
    shopping_list_id TEXT NOT NULL PRIMARY KEY,
    record_kind TEXT NOT NULL DEFAULT 'shopping_list' CHECK(record_kind = 'shopping_list'),
    FOREIGN KEY(shopping_list_id, record_kind) REFERENCES records(record_id, record_kind)
);
CREATE TABLE restock_items (
    restock_item_id TEXT NOT NULL PRIMARY KEY,
    record_kind TEXT NOT NULL DEFAULT 'restock_item' CHECK(record_kind = 'restock_item'),
    FOREIGN KEY(restock_item_id, record_kind) REFERENCES records(record_id, record_kind)
);
CREATE TABLE shopping_entries (
    shopping_entry_id TEXT NOT NULL PRIMARY KEY,
    record_kind TEXT NOT NULL DEFAULT 'shopping_entry' CHECK(record_kind = 'shopping_entry'),
    shopping_list_id TEXT NOT NULL REFERENCES shopping_lists(shopping_list_id),
    restock_item_id TEXT REFERENCES restock_items(restock_item_id),
    state TEXT NOT NULL CHECK(state IN ('needed','purchased','cancelled')),
    FOREIGN KEY(shopping_entry_id, record_kind) REFERENCES records(record_id, record_kind)
);
CREATE UNIQUE INDEX one_needed_restock_entry
    ON shopping_entries(shopping_list_id, restock_item_id)
    WHERE state = 'needed' AND restock_item_id IS NOT NULL;
CREATE TABLE projects (
    project_id TEXT NOT NULL PRIMARY KEY,
    record_kind TEXT NOT NULL DEFAULT 'project' CHECK(record_kind = 'project'),
    FOREIGN KEY(project_id, record_kind) REFERENCES records(record_id, record_kind)
);
CREATE TABLE project_pages (
    page_id TEXT NOT NULL PRIMARY KEY,
    record_kind TEXT NOT NULL DEFAULT 'page' CHECK(record_kind = 'page'),
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    parent_page_id TEXT,
    UNIQUE(project_id, page_id),
    FOREIGN KEY(project_id, parent_page_id) REFERENCES project_pages(project_id, page_id),
    FOREIGN KEY(page_id, record_kind) REFERENCES records(record_id, record_kind)
);
CREATE TABLE clients (client_id TEXT NOT NULL PRIMARY KEY);
CREATE TABLE change_sets (change_set_id TEXT NOT NULL PRIMARY KEY);
CREATE TABLE record_changes (
    change_set_id TEXT NOT NULL REFERENCES change_sets(change_set_id),
    record_id TEXT NOT NULL REFERENCES records(record_id),
    PRIMARY KEY(change_set_id, record_id)
);
CREATE TABLE operation_receipts (
    client_id TEXT NOT NULL REFERENCES clients(client_id),
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    change_set_id TEXT REFERENCES change_sets(change_set_id),
    PRIMARY KEY(client_id, operation_id)
);
"""


class ConstraintProbe(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(SCHEMA)

    def tearDown(self):
        self.db.close()

    def root(self, identifier, kind):
        self.db.execute("INSERT INTO records(record_id, record_kind) VALUES (?, ?)", (identifier, kind))

    def task(self, identifier="t"):
        self.root(identifier, "task")
        self.db.execute("INSERT INTO tasks(task_id) VALUES (?)", (identifier,))

    def occurrence(self, identifier, ordinal, state="open"):
        self.root(identifier, "occurrence")
        self.db.execute(
            "INSERT INTO task_occurrences(occurrence_id,task_id,ordinal,state) VALUES (?,'t',?,?)",
            (identifier, ordinal, state),
        )

    def list_and_restock(self):
        for identifier in ("l1", "l2"):
            self.root(identifier, "shopping_list")
            self.db.execute("INSERT INTO shopping_lists(shopping_list_id) VALUES (?)", (identifier,))
        self.root("r", "restock_item")
        self.db.execute("INSERT INTO restock_items(restock_item_id) VALUES ('r')")

    def entry(self, identifier, list_id="l1", restock="r", state="needed"):
        self.root(identifier, "shopping_entry")
        self.db.execute(
            "INSERT INTO shopping_entries(shopping_entry_id,shopping_list_id,restock_item_id,state) VALUES (?,?,?,?)",
            (identifier, list_id, restock, state),
        )

    def project(self, identifier):
        self.root(identifier, "project")
        self.db.execute("INSERT INTO projects(project_id) VALUES (?)", (identifier,))

    def page(self, identifier, project, parent=None):
        self.root(identifier, "page")
        self.db.execute(
            "INSERT INTO project_pages(page_id,project_id,parent_page_id) VALUES (?,?,?)",
            (identifier, project, parent),
        )

    def test_foreign_keys_explicitly_enabled(self):
        self.assertEqual(self.db.execute("PRAGMA foreign_keys").fetchone()[0], 1)

    def test_correct_subtype_accepted(self):
        self.root("n", "note")
        self.db.execute("INSERT INTO notes(note_id,body) VALUES ('n','hello')")
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_wrong_subtype_rejected(self):
        self.root("n", "task")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO notes(note_id,body) VALUES ('n','hello')")

    def test_kind_override_cannot_bypass_subtype(self):
        self.root("n", "task")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO notes VALUES ('n','task','hello')")

    def test_missing_registry_root_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO notes(note_id,body) VALUES ('missing','hello')")

    def test_complete_subtype_is_application_obligation(self):
        self.root("orphan", "note")
        self.db.commit()  # Intentionally succeeds: FK does not require the reverse row.
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM notes").fetchone()[0], 0)

    def test_typed_task_reference_rejects_note_id(self):
        self.root("t", "note")
        self.db.execute("INSERT INTO notes(note_id,body) VALUES ('t','not a task')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.occurrence("o", 1)

    def test_one_open_occurrence_but_many_closed(self):
        self.task()
        self.occurrence("o1", 1)
        self.occurrence("o2", 2, "completed")
        with self.assertRaises(sqlite3.IntegrityError):
            self.occurrence("o3", 3)

    def test_close_then_advance_allowed(self):
        self.task()
        self.occurrence("o1", 1)
        self.db.execute("UPDATE task_occurrences SET state='completed' WHERE occurrence_id='o1'")
        self.occurrence("o2", 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM task_occurrences WHERE state='open'").fetchone()[0], 1)

    def test_one_unvoided_completion(self):
        self.task()
        self.occurrence("o1", 1, "completed")
        for identifier in ("c1", "c2", "c3"):
            self.root(identifier, "completion")
        self.db.execute("INSERT INTO task_completions(completion_id,occurrence_id,voided_at) VALUES ('c1','o1',100)")
        self.db.execute("INSERT INTO task_completions(completion_id,occurrence_id) VALUES ('c2','o1')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO task_completions(completion_id,occurrence_id) VALUES ('c3','o1')")

    def test_needed_restock_unique_per_list(self):
        self.list_and_restock()
        self.entry("e1")
        self.entry("e2", "l2")
        self.entry("e3", state="purchased")
        with self.assertRaises(sqlite3.IntegrityError):
            self.entry("e4")

    def test_freeform_entries_do_not_deduplicate(self):
        self.list_and_restock()
        self.entry("e1", restock=None)
        self.entry("e2", restock=None)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM shopping_entries").fetchone()[0], 2)

    def test_project_parent_must_belong_to_same_project(self):
        self.project("p1")
        self.project("p2")
        self.page("a", "p1")
        self.page("b", "p1", "a")
        with self.assertRaises(sqlite3.IntegrityError):
            self.page("c", "p2", "a")

    def test_cycle_detection_is_application_obligation(self):
        self.project("p1")
        self.page("a", "p1")
        self.page("b", "p1", "a")
        self.db.execute("UPDATE project_pages SET parent_page_id='b' WHERE page_id='a'")
        self.db.commit()  # Deliberately demonstrates the missing cycle invariant.
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_receipt_key_is_client_scoped(self):
        self.db.executemany("INSERT INTO clients VALUES (?)", [("phone",), ("speaker",)])
        self.db.execute("INSERT INTO operation_receipts VALUES ('phone','op','hash',NULL)")
        self.db.execute("INSERT INTO operation_receipts VALUES ('speaker','op','hash',NULL)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO operation_receipts VALUES ('phone','op','different',NULL)")

    def test_failed_action_rolls_back_state_history_and_receipt(self):
        self.db.execute("INSERT INTO clients VALUES ('phone')")
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                self.root("n", "note")
                self.db.execute("INSERT INTO notes(note_id,body) VALUES ('n','hello')")
                self.db.execute("INSERT INTO change_sets VALUES ('c')")
                self.db.execute("INSERT INTO record_changes VALUES ('c','n')")
                self.db.execute("INSERT INTO operation_receipts VALUES ('phone','op','hash','c')")
                self.db.execute("INSERT INTO notes(note_id,body) VALUES ('n','duplicate')")
        for table in ("records", "notes", "change_sets", "record_changes", "operation_receipts"):
            self.assertEqual(self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)


if __name__ == "__main__":
    print(f"In-memory schema design probe; SQLite {sqlite3.sqlite_version}", flush=True)
    unittest.main(verbosity=2)
