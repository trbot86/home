import { Type } from '@sinclair/typebox';
import { Id, object } from './primitives.js';
import { AgendaLayout, type AgendaLayout as Layout } from './overview.js';
const pin = {
  recordId: Id,
  scopeId: Id,
  expectedViewRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  pinned: Type.Boolean(),
};
export const navigationSections = [
  'inbox',
  'shopping',
  'tasks',
  'agenda',
  'calendar',
  'home',
  'food',
  'projects',
  'activity',
  'trash',
  'storage',
] as const;
export type NavigationSection = (typeof navigationSections)[number];
const orderSchema = (ids: readonly NavigationSection[]) =>
  Type.Array(Type.Union(ids.map((id) => Type.Literal(id))), {
    minItems: ids.length,
    maxItems: ids.length,
    uniqueItems: true,
  });
// Retain old frozen requests and saved layouts; clients insert Calendar beside Agenda.
export const NavigationOrder = Type.Union([
  orderSchema(navigationSections),
  orderSchema(navigationSections.filter((id) => id !== 'calendar')),
]);
export function completeNavigationOrder(order: readonly NavigationSection[]): NavigationSection[] {
  const result = [...order];
  if (!result.includes('calendar')) result.splice(result.indexOf('agenda') + 1, 0, 'calendar');
  return result;
}
export const viewCommands = {
  SetCardOrder: object({
    scopeId: Id,
    category: Type.Union([Type.Literal('inbox'), Type.Literal('app_suggestion')]),
    expectedViewRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    recordIds: Type.Array(Id, { maxItems: 2000, uniqueItems: true }),
  }),
  SetNavigationOrder: object({
    scopeId: Id,
    expectedViewRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    order: NavigationOrder,
  }),
  SetAgendaLayout: object({
    scopeId: Id,
    expectedViewRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    layout: AgendaLayout,
  }),
  SetRecordPin: Type.Union([
    object({ ...pin, viewKind: Type.Literal('food_soon') }),
    object({ ...pin, viewKind: Type.Literal('project_next'), projectId: Id }),
  ]),
  SetViewPinOrder: object({
    viewId: Id,
    expectedViewRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    recordIds: Type.Array(Id, { maxItems: 200 }),
  }),
};
export type SavedView = {
  viewId: string;
  scopeId: string;
  revision: number;
  pins: { recordId: string; position: number }[];
} & (
  | { kind: 'navigation'; order: NavigationSection[] }
  | { kind: 'card_order'; category: 'inbox' | 'app_suggestion'; recordIds: string[] }
  | { kind: 'food_soon' }
  | { kind: 'project_next'; projectId: string }
  | { kind: 'agenda'; layout: Layout }
);
