import type { ClientState } from '@our-place/client';
import type { Attachment } from '@our-place/contracts';

export type RecordReference = {
  recordId: string;
  scopeId: string;
  kind: string;
  label: string;
  title: string;
  text: string;
  deletedAt: number | null;
  attachments: Attachment[];
};
/** References resolve only against the current profile's authorised snapshot. */
export function recordReferences(state: ClientState): RecordReference[] {
  const result: RecordReference[] = [];
  const add = (
    record: {
      recordId: string;
      scopeId: string;
      kind: string;
      deletedAt: number | null;
      attachments?: Attachment[];
    },
    label: string,
    title: string,
    text = '',
  ) =>
    result.push({
      recordId: record.recordId,
      scopeId: record.scopeId,
      kind: record.kind,
      deletedAt: record.deletedAt,
      label,
      title,
      text,
      attachments: record.attachments ?? [],
    });
  for (const note of state.entries)
    add(
      { ...note, recordId: note.inboxId, kind: 'inbox' },
      'Note',
      note.text.split('\n')[0]?.slice(0, 150) || 'Photo note',
      note.text,
    );
  for (const task of state.tasks.definitions) add(task, 'Task', task.title, task.instructions);
  for (const occurrence of state.tasks.occurrences) {
    const task = state.tasks.definitions.find((t) => t.recordId === occurrence.taskId);
    add(
      occurrence,
      'Scheduled task',
      task?.title ?? 'Task',
      `${occurrence.state}${occurrence.targetDate ? ` · Aim for ${occurrence.targetDate}` : ''}`,
    );
  }
  for (const completion of state.tasks.completions) {
    const occurrence = state.tasks.occurrences.find((o) => o.recordId === completion.occurrenceId),
      task = state.tasks.definitions.find((t) => t.recordId === occurrence?.taskId);
    add(completion, 'Task completion', task?.title ?? 'Completed task', completion.note);
  }
  for (const recipe of state.recipes.recipes) add(recipe, 'Recipe', recipe.title, recipe.description);
  for (const collection of state.recipes.collections) add(collection, 'Recipe collection', collection.name);
  for (const cooking of state.recipes.cookingRecords) {
    const recipe = state.recipes.recipes.find((r) => r.recordId === cooking.recipeId);
    add(cooking, 'Cooking notes', recipe?.title ?? 'Cooking notes', cooking.notes);
  }
  for (const asset of state.home.assets) add(asset, 'Home item', asset.name, asset.notes);
  for (const service of state.home.serviceRecords) {
    const asset = state.home.assets.find((a) => a.recordId === service.assetId);
    add(service, 'Maintenance record', asset?.name ?? 'Maintenance', service.notes);
  }
  for (const list of state.shopping.lists) add(list, 'Shopping list', list.name);
  for (const item of state.shopping.entries)
    add(item, 'Shopping item', item.label, [item.quantity, item.notes].filter(Boolean).join('\n'));
  for (const group of state.shopping.groups) add(group, 'Shopping group', group.name);
  for (const item of state.shopping.restockItems)
    add(item, 'Restock item', item.name, [item.quantity, item.model, item.notes].filter(Boolean).join('\n'));
  for (const purchase of state.shopping.purchases)
    add(purchase, 'Purchase', purchase.items.map((i) => i.label).join(', '), purchase.notes);
  for (const project of state.projects.projects) add(project, 'Project', project.title, project.description);
  for (const page of state.projects.pages)
    add(
      page,
      'Project page',
      page.title,
      page.blocks
        .filter((b) => b.kind === 'text')
        .map((b) => b.text)
        .join('\n\n'),
    );
  return result;
}
export function linkableReferences(state: ClientState, scopeId: string) {
  const shared = new Set(state.session?.scopes.filter((s) => s.kind === 'shared').map((s) => s.scopeId));
  return recordReferences(state).filter(
    (r) => r.deletedAt === null && (r.scopeId === scopeId || shared.has(r.scopeId)),
  );
}
