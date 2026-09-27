import { Type } from '@sinclair/typebox';
import { Id, object } from './primitives.js';
export const viewCommands = {
  SetRecordPin: object({
    recordId: Id,
    scopeId: Id,
    viewKind: Type.Literal('food_soon'),
    expectedViewRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    pinned: Type.Boolean(),
  }),
};
export type SavedView = {
  viewId: string;
  scopeId: string;
  kind: 'food_soon';
  revision: number;
  pins: { recordId: string; position: number }[];
};
