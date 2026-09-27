import { Type } from '@sinclair/typebox';
import { Id, object } from './primitives.js';
const pin = {
  recordId: Id,
  scopeId: Id,
  expectedViewRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  pinned: Type.Boolean(),
};
export const viewCommands = {
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
} & ({ kind: 'food_soon' } | { kind: 'project_next'; projectId: string });
