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
export type FilingAdviceContext = {
  mode: 'recent' | 'all';
  eligibleCount: number;
  includedCount: number;
  limited: boolean;
};
export const FilingAdviceRequest = object({
  expectedRevision: Revision,
  expectedAttempt: Type.Integer({ minimum: 0 }),
  // Omitted discovers bounded, permitted same-scope destinations. [] requests categories only.
  destinationIds: Type.Optional(Type.Array(Id, { maxItems: 20, uniqueItems: true })),
  search: Type.Optional(Type.Union([Type.Literal('recent'), Type.Literal('all')])),
});
export type FilingAdviceRequest = Static<typeof FilingAdviceRequest>;
export type FilingAdvice =
  | { kind: 'category'; category: 'tasks' | 'shopping' | 'projects' }
  | { kind: 'existing'; recordId: string; revision: number };
export type FilingAdviceReview = {
  state: 'attempted' | 'complete' | 'failed' | 'stale';
  attempt: number;
  choices: FilingAdvice[];
  context?: FilingAdviceContext;
};
