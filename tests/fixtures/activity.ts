import { randomUUID } from 'node:crypto';
import { emptyRecipeFields, type Session } from '../../packages/contracts/src/index.js';
type Run = (kind: string, args: Record<string, unknown>) => Promise<unknown>;
/** Synthetic records shared by browser and native activity verification. */
export async function seedActivity(run: Run, session: Session, partnerId: string, prefix: string) {
  const shared = session.scopes.find((s) => s.kind === 'shared')!.scopeId;
  const privateScope = session.scopes.find((s) => s.kind === 'private')!.scopeId;
  const title = (value: string) => `${prefix} ${value}`;
  async function asset(name: string) {
    const id = randomUUID();
    await run('CreateHomeAsset', {
      recordId: id,
      scopeId: shared,
      name: title(name),
      model: '',
      serial: '',
      location: '',
      acquiredDate: null,
      notes: '',
    });
    return id;
  }
  async function recipe(name: string) {
    const id = randomUUID();
    await run('CreateRecipe', {
      recordId: id,
      scopeId: shared,
      ...emptyRecipeFields(),
      title: title(name),
      collectionIds: [],
    });
    return id;
  }
  async function completed(name: string, at: string, options: Record<string, unknown> = {}) {
    const taskId = randomUUID(),
      occurrenceId = randomUUID(),
      completionId = randomUUID();
    const privateOnly = options.privateOnly === true;
    const scopeId = privateOnly ? privateScope : shared;
    await run('CreateTask', {
      recordId: taskId,
      occurrenceId,
      scopeId,
      title: title(name),
      instructions: '',
      context: options.context ?? 'home',
      defaultAssigneeId: null,
      defaultPriority: 0,
      recurrence: null,
      assigneeId: null,
      priority: 0,
      deadlineDate: null,
      targetDate: null,
      reviewDate: null,
      maintenance: options.maintenance ?? null,
      cooking: options.cooking ?? null,
    });
    await run('CompleteTaskOccurrence', {
      recordId: occurrenceId,
      expectedRevision: 1,
      expectedTaskRevision: 1,
      completionId,
      nextOccurrenceId: null,
      completedAt: Date.parse(at),
      performedByPersonId: privateOnly ? session.person.personId : partnerId,
      note: privateOnly ? 'Keep the surprise private' : title('Recorded after the work happened'),
    });
    return { taskId, occurrenceId, completionId };
  }
  async function purchase(name: string, scopeId: string) {
    const listId = randomUUID(),
      entryId = randomUUID(),
      purchaseId = randomUUID();
    await run('CreateShoppingList', {
      recordId: listId,
      scopeId,
      name: title('List ' + name),
      purpose: 'household',
    });
    await run('AddShoppingEntry', {
      recordId: entryId,
      listId,
      label: title(name),
      quantity: '4-pack',
      notes: '',
    });
    await run('PurchaseShoppingEntry', {
      recordId: entryId,
      expectedRevision: 1,
      purchaseId,
      purchaseItemId: randomUUID(),
      boughtAt: Date.parse('2026-08-11T16:00:00Z'),
    });
    return purchaseId;
  }
  const furnace = await asset('Furnace'),
    soup = await recipe('Soup'),
    bread = await recipe('Bread');
  const maintenance = await completed('Replace filter', '2026-08-10T16:00:00Z', {
    maintenance: { assetId: furnace, reference: '' },
  });
  const cooking = await completed('Make soup', '2026-08-12T03:30:00Z', { cooking: { recipeId: soup } });
  const work = await completed('Work paperwork', '2026-08-13T16:00:00Z', { context: 'work' });
  const privateTask = await completed('Surprise weekend', '2026-08-14T16:00:00Z', { privateOnly: true });
  await run('CreateRecipeCookingRecord', {
    recordId: randomUUID(),
    scopeId: shared,
    recipeId: bread,
    cookedAt: Date.parse('2026-08-09T16:00:00Z'),
    cookedByPersonId: null,
    notes: title('Use less salt next time'),
  });
  const tool = await asset('Garden tool');
  await run('CreateMaintenanceRecord', {
    recordId: randomUUID(),
    scopeId: shared,
    assetId: tool,
    occurredAt: Date.parse('2026-08-08T16:00:00Z'),
    notes: title('Serviced by the shop'),
    costAmount: null,
    currency: null,
  });
  const bought = await purchase('Brush heads', shared),
    gift = await purchase('Secret present', privateScope);
  return { maintenance, cooking, work, privateTask, bought, gift };
}
