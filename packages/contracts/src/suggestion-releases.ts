import { Type, type Static } from '@sinclair/typebox';
import { Id, Instant, object } from './primitives.js';
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const commit = Type.String({ pattern: '^[a-f0-9]{40}$' });
export const SuggestionReleaseMember = object({ suggestionId: Id, runId: Id });
export type SuggestionReleaseMember = Static<typeof SuggestionReleaseMember>;
export const SuggestionReleaseManifest = object({
  baseCommit: commit,
  sourceCommit: commit,
  sources: Type.Optional(
    Type.Array(object({ suggestionId: Id, runId: Id, sourceCommit: commit }), { minItems: 1, maxItems: 20 }),
  ),
  candidateCommit: commit,
  imageId: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  previousImageId: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  apkSha256: hash,
  checks: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 20 }),
  preparedAt: Instant,
});
export type SuggestionReleaseManifest = Static<typeof SuggestionReleaseManifest>;
export type SuggestionReleaseState =
  | 'queued'
  | 'preparing'
  | 'prepared'
  | 'deploy_queued'
  | 'deploying'
  | 'released'
  | 'failed'
  | 'cancelled'
  | 'uncertain';
export type SuggestionRelease = {
  releaseId: string;
  suggestionId: string;
  runId: string;
  members?: SuggestionReleaseMember[];
  state: SuggestionReleaseState;
  revision: number;
  summary: string;
  manifest: SuggestionReleaseManifest | null;
  manifestDigest: string | null;
  createdAt: number;
  updatedAt: number;
};
export const suggestionReleaseCommands = {
  PrepareSuggestionRelease: object({ releaseId: Id, suggestionId: Id, runId: Id }),
  DeploySuggestionRelease: object({ releaseId: Id, manifestDigest: hash }),
  CancelSuggestionRelease: object({ releaseId: Id }),
  RetrySuggestionRelease: object({ releaseId: Id, replacementReleaseId: Id }),
} as const;
export const SuggestionReleaseUpdate = object({
  expectedServerEpoch: Id,
  releaseId: Id,
  expectedRevision: Type.Integer({ minimum: 1 }),
  state: Type.Union(
    ['preparing', 'prepared', 'deploying', 'released', 'failed', 'uncertain'].map((s) => Type.Literal(s)),
  ),
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  manifest: Type.Optional(SuggestionReleaseManifest),
});
export type SuggestionReleaseUpdate = Static<typeof SuggestionReleaseUpdate>;
