import type { Sqlite } from '../../infrastructure/database.js';
import { Rejection } from '../../application/errors.js';
type PageNode = {
  page_id: string;
  project_id: string;
  parent_page_id: string | null;
  deleted_at: number | null;
  revision: number;
};
export class ProjectHierarchy {
  constructor(private readonly db: Sqlite) {}
  pages(projectId: string): PageNode[] {
    return this.db
      .prepare(
        `SELECT p.page_id,p.project_id,p.parent_page_id,r.deleted_at,r.revision FROM project_pages p JOIN records r ON r.record_id=p.page_id WHERE p.project_id=? ORDER BY p.page_id`,
      )
      .all(projectId) as PageNode[];
  }
  descendants(pageId: string, projectId: string): PageNode[] {
    const children = new Map<string, PageNode[]>();
    for (const page of this.pages(projectId))
      if (page.parent_page_id)
        children.set(page.parent_page_id, [...(children.get(page.parent_page_id) ?? []), page]);
    const result: PageNode[] = [],
      seen = new Set([pageId]),
      pending = [pageId];
    while (pending.length) {
      for (const child of children.get(pending.pop()!) ?? []) {
        if (seen.has(child.page_id)) throw new Rejection('page_cycle');
        seen.add(child.page_id);
        result.push(child);
        pending.push(child.page_id);
      }
    }
    return result;
  }
  position(projectId: string, parentPageId: string | null) {
    return (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(position),-1)+1 AS next FROM project_pages WHERE project_id=? AND parent_page_id IS ?',
        )
        .get(projectId, parentPageId) as { next: number }
    ).next;
  }
  assertConsistent() {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM project_pages p JOIN project_pages parent ON parent.page_id=p.parent_page_id WHERE p.project_id<>parent.project_id LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('page_parent_unavailable');
    if (
      this.db
        .prepare(
          `SELECT 1 FROM project_pages p JOIN records r ON r.record_id=p.page_id JOIN records project ON project.record_id=p.project_id LEFT JOIN records parent ON parent.record_id=p.parent_page_id WHERE r.deleted_at IS NULL AND (project.deleted_at IS NOT NULL OR parent.deleted_at IS NOT NULL) LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('page_container_deleted');
    const rows = this.db.prepare('SELECT page_id,parent_page_id FROM project_pages').all() as {
      page_id: string;
      parent_page_id: string | null;
    }[];
    const parents = new Map(rows.map((p) => [p.page_id, p.parent_page_id])),
      complete = new Set<string>();
    for (const row of rows) {
      const chain = new Set<string>();
      let current: string | null = row.page_id;
      while (current && !complete.has(current)) {
        if (chain.has(current)) throw new Rejection('page_cycle');
        chain.add(current);
        current = parents.get(current) ?? null;
      }
      for (const id of chain) complete.add(id);
    }
  }
}
