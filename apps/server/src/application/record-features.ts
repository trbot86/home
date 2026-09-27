import type { Sqlite } from '../infrastructure/database.js';
import type { AccessService } from '../features/access/access.js';
import { InboxRepository } from '../features/inbox/inbox.js';
import { inboxRecordAdapter } from '../features/inbox/inbox-record.js';
import { ShoppingRepository } from '../features/shopping/shopping.js';
import { TasksRepository } from '../features/tasks/tasks.js';
import { HomeRepository } from '../features/home/home.js';
import { RecipesRepository } from '../features/recipes/recipes.js';
import { RecordRegistry } from '../features/records/record-registry.js';

/** One complete adapter set for every writer; constructing features grants no HTTP routes or commands. */
export function createRecordFeatures(db: Sqlite, access: AccessService, householdTimeZone?: string) {
  const inbox = new InboxRepository(db, access);
  const shopping = new ShoppingRepository(db, access);
  const home = new HomeRepository(db, access);
  const recipes = new RecipesRepository(db, access);
  const tasks = new TasksRepository(db, access, householdTimeZone, home, recipes);
  const records = new RecordRegistry(db, [
    inboxRecordAdapter(inbox),
    ...shopping.adapters(),
    ...tasks.adapters(),
    ...home.adapters(),
    ...recipes.adapters(),
  ]);
  return { inbox, shopping, tasks, home, recipes, records };
}
