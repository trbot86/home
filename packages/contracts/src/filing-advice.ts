import { Type, type Static } from '@sinclair/typebox';
import { Id, Revision, object } from './primitives.js';

export const FilingAdvicePreferences = object({
  enabled: Type.Boolean(),
  automatic: Type.Boolean(),
  scopeIds: Type.Array(Id, { maxItems: 2, uniqueItems: true }),
  destinationTitles: Type.Boolean(),
});
export type FilingAdvicePreferences = Static<typeof FilingAdvicePreferences>;
export type FilingAdviceSettings = FilingAdvicePreferences & { configured: boolean; revision: number };
export const FilingAdviceRequest = object({
  expectedRevision: Revision,
  expectedAttempt: Type.Integer({ minimum: 0 }),
  destinationIds: Type.Array(Id, { maxItems: 20, uniqueItems: true }),
});
export type FilingAdviceRequest = Static<typeof FilingAdviceRequest>;
export type FilingAdvice =
  | { kind: 'category'; category: 'tasks' | 'shopping' | 'projects' }
  | { kind: 'existing'; recordId: string; revision: number };
export type FilingAdviceReview = {
  state: 'attempted' | 'complete' | 'failed' | 'stale';
  attempt: number;
  choices: FilingAdvice[];
};
