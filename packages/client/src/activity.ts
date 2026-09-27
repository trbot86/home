import type { Attachment } from '@our-place/contracts';
import type { ClientState } from './index.js';

export type ActivityKind = 'task' | 'purchase' | 'cooking' | 'maintenance';
export type ActivityLink = { recordId: string; label: string };
export type ActivityItem = {
  recordId: string;
  scopeId: string;
  kinds: ActivityKind[];
  title: string;
  occurredAt: number;
  personId: string | null;
  personName: string | null;
  context: 'home' | 'work';
  notes: string[];
  attachments: Attachment[];
  links: ActivityLink[];
  sourceDeleted: boolean;
};
export type ActivityState = Pick<ClientState, 'session' | 'tasks' | 'shopping' | 'home' | 'recipes'>;
export type ActivityFilter = {
  visibility: 'shared' | 'private' | 'all';
  context: 'home' | 'work' | 'both';
  kind: ActivityKind | 'all';
  personId: string | 'everyone' | 'unrecorded';
  search: string;
};
export const defaultActivityFilter = (): ActivityFilter => ({
  visibility: 'shared',
  context: 'both',
  kind: 'all',
  personId: 'everyone',
  search: '',
});

/** A view of completed work in the current authorised snapshot, never a second activity log. */
export function householdActivity(state: ActivityState): ActivityItem[] {
  if (!state.session) return [];
  const allowed = new Set(state.session.scopes.map((s) => s.scopeId));
  const readable = (row: { scopeId: string }) => allowed.has(row.scopeId);
  const live = (row: { scopeId: string; deletedAt: number | null }) =>
    readable(row) && row.deletedAt === null;
  const definitions = new Map(state.tasks.definitions.filter(readable).map((r) => [r.recordId, r]));
  const occurrences = new Map(state.tasks.occurrences.filter(readable).map((r) => [r.recordId, r]));
  const recipes = new Map(state.recipes.recipes.filter(readable).map((r) => [r.recordId, r]));
  const assets = new Map(state.home.assets.filter(readable).map((r) => [r.recordId, r]));
  const people = new Map(state.tasks.people.map((p) => [p.personId, p.displayName]));
  const result: ActivityItem[] = [];
  const completions = new Map<string, ActivityItem>();
  for (const record of state.tasks.completions.filter(live)) {
    const occurrence = occurrences.get(record.occurrenceId);
    const task = occurrence && definitions.get(occurrence.taskId);
    if (
      !task ||
      !occurrence ||
      occurrence.deletedAt !== null ||
      occurrence.state !== 'completed' ||
      occurrence.scopeId !== record.scopeId ||
      task.scopeId !== record.scopeId
    )
      continue;
    const item: ActivityItem = {
      recordId: record.recordId,
      scopeId: record.scopeId,
      kinds: ['task'],
      title: task.title,
      occurredAt: record.completedAt,
      personId: record.performedByPersonId,
      personName: record.performerName,
      context: task.context,
      notes: record.note ? [record.note] : [],
      attachments: [...(record.attachments ?? [])],
      links: [{ recordId: task.recordId, label: 'Task' }],
      sourceDeleted: task.deletedAt !== null,
    };
    result.push(item);
    completions.set(record.recordId, item);
  }
  const merge = (item: ActivityItem, notes: string, attachments: Attachment[], link: ActivityLink) => {
    if (notes && !item.notes.includes(notes)) item.notes.push(notes);
    const ids = new Set(item.attachments.map((a) => a.attachmentId));
    item.attachments.push(...attachments.filter((a) => !ids.has(a.attachmentId)));
    item.links.push(link);
  };
  for (const record of state.recipes.cookingRecords.filter(live)) {
    const recipe = recipes.get(record.recipeId);
    if (!recipe || recipe.scopeId !== record.scopeId) continue;
    if (record.completionId) {
      const completion = completions.get(record.completionId);
      if (completion?.scopeId === record.scopeId) {
        completion.kinds = completion.kinds.filter((kind) => kind !== 'task');
        completion.kinds.push('cooking');
        merge(completion, record.notes, record.attachments, { recordId: recipe.recordId, label: 'Recipe' });
      }
      continue;
    }
    result.push({
      recordId: record.recordId,
      scopeId: record.scopeId,
      kinds: ['cooking'],
      title: recipe.title,
      occurredAt: record.cookedAt,
      personId: record.cookedByPersonId,
      personName: record.cookedByPersonId
        ? (people.get(record.cookedByPersonId) ?? 'Person unavailable')
        : null,
      context: 'home',
      notes: record.notes ? [record.notes] : [],
      attachments: [...record.attachments],
      links: [{ recordId: recipe.recordId, label: 'Recipe' }],
      sourceDeleted: recipe.deletedAt !== null,
    });
  }
  for (const record of state.home.serviceRecords.filter(live)) {
    const asset = assets.get(record.assetId);
    if (!asset || asset.scopeId !== record.scopeId) continue;
    if (record.completionId) {
      const completion = completions.get(record.completionId);
      if (completion?.scopeId === record.scopeId) {
        completion.kinds = completion.kinds.filter((kind) => kind !== 'task');
        completion.kinds.push('maintenance');
        merge(completion, record.notes, record.attachments, { recordId: asset.recordId, label: 'Home item' });
      }
      continue;
    }
    result.push({
      recordId: record.recordId,
      scopeId: record.scopeId,
      kinds: ['maintenance'],
      title: asset.name,
      occurredAt: record.occurredAt,
      personId: null,
      personName: null,
      context: 'home',
      notes: record.notes ? [record.notes] : [],
      attachments: [...record.attachments],
      links: [{ recordId: asset.recordId, label: 'Home item' }],
      sourceDeleted: asset.deletedAt !== null,
    });
  }
  for (const record of state.shopping.purchases.filter(live)) {
    result.push({
      recordId: record.recordId,
      scopeId: record.scopeId,
      kinds: ['purchase'],
      title: record.items.map((item) => [item.label, item.quantity].filter(Boolean).join(' · ')).join(', '),
      occurredAt: record.boughtAt,
      personId: record.buyerPersonId,
      personName: record.buyerName,
      context: 'home',
      notes: record.notes ? [record.notes] : [],
      attachments: [],
      links: [],
      sourceDeleted: false,
    });
  }
  return result.sort((a, b) => b.occurredAt - a.occurredAt || a.recordId.localeCompare(b.recordId));
}

export function filterActivity(
  items: ActivityItem[],
  state: ActivityState,
  filter: ActivityFilter,
): ActivityItem[] {
  const scopes = new Set(
    state.session?.scopes
      .filter((s) => filter.visibility === 'all' || s.kind === filter.visibility)
      .map((s) => s.scopeId),
  );
  const needle = filter.search.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      scopes.has(item.scopeId) &&
      (filter.context === 'both' || item.context === filter.context) &&
      (filter.kind === 'all' || item.kinds.includes(filter.kind)) &&
      (filter.personId === 'everyone' ||
        (filter.personId === 'unrecorded' ? item.personId === null : item.personId === filter.personId)) &&
      (!needle ||
        [item.title, item.personName ?? '', ...item.notes].join('\n').toLocaleLowerCase().includes(needle)),
  );
}
