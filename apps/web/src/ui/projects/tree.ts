import type { ProjectPage } from '@our-place/contracts';
export const projectTarget = (record: { recordId: string; revision: number }) => ({
  recordId: record.recordId,
  expectedRevision: record.revision,
});
export function descendants(pages: ProjectPage[], pageId: string): ProjectPage[] {
  const children = new Map<string, ProjectPage[]>();
  for (const page of pages)
    if (page.parentPageId)
      children.set(page.parentPageId, [...(children.get(page.parentPageId) ?? []), page]);
  const result: ProjectPage[] = [],
    pending = [pageId],
    seen = new Set(pending);
  while (pending.length)
    for (const page of children.get(pending.pop()!) ?? [])
      if (!seen.has(page.recordId)) {
        seen.add(page.recordId);
        result.push(page);
        pending.push(page.recordId);
      }
  return result;
}
export function pagePath(pages: ProjectPage[], pageId: string): ProjectPage[] {
  const byId = new Map(pages.map((page) => [page.recordId, page])),
    result: ProjectPage[] = [],
    seen = new Set<string>();
  let current: string | null = pageId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const page = byId.get(current);
    if (!page) break;
    result.unshift(page);
    current = page.parentPageId;
  }
  return result;
}
