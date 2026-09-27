import { Type, type Static } from '@sinclair/typebox';
import { Id, Instant, Revision, object } from './primitives.js';
import { Attachments } from './attachments.js';

const nullableId = Type.Union([Id, Type.Null()]);
export const SuggestionStatus = Type.Union([
  Type.Literal('new'),
  Type.Literal('queued'),
  Type.Literal('working'),
  Type.Literal('needs_input'),
  Type.Literal('ready'),
  Type.Literal('released'),
]);
export type SuggestionStatus = Static<typeof SuggestionStatus>;
const common = { scopeId: Id, deletedAt: Type.Union([Instant, Type.Null()]), suggestionId: Id };
export const suggestionContentSchemas = {
  suggestion_workflow: object({
    ...common,
    summary: Type.String({ maxLength: 20000 }),
    status: SuggestionStatus,
  }),
  suggestion_message: object({
    ...common,
    text: Type.String({ maxLength: 20000 }),
    messageType: Type.Union([
      Type.Literal('note'),
      Type.Literal('request'),
      Type.Literal('progress'),
      Type.Literal('question'),
      Type.Literal('resolution'),
      Type.Literal('release'),
    ]),
    authorKind: Type.Union([Type.Literal('person'), Type.Literal('agent')]),
    authorId: Id,
    authorName: Type.String({ minLength: 1, maxLength: 300 }),
    runId: nullableId,
    replyToQuestionId: nullableId,
    choices: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }),
    attachments: Attachments,
  }),
} as const;
export type SuggestionKind = keyof typeof suggestionContentSchemas;
type Header<K extends SuggestionKind> = {
  recordId: string;
  kind: K;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type SuggestionWorkflow = Header<'suggestion_workflow'> &
  Static<typeof suggestionContentSchemas.suggestion_workflow>;
export type SuggestionMessage = Header<'suggestion_message'> &
  Static<typeof suggestionContentSchemas.suggestion_message> & { sequence: number };
export type SuggestionRecord = SuggestionWorkflow | SuggestionMessage;
export type SuggestionQuestion = {
  questionId: string;
  suggestionId: string;
  text: string;
  choices: string[];
  state: 'unanswered' | 'answered' | 'resolved';
};
export type SuggestionWork = {
  requestId: string;
  suggestionId: string;
  requestedAt: number;
  state: 'queued' | 'running' | 'needs_input' | 'ready' | 'failed' | 'uncertain' | 'cancelled';
  runId: string | null;
  issue: string | null;
};
export type SuggestionSnapshot = {
  workflows: SuggestionWorkflow[];
  messages: SuggestionMessage[];
  questions: SuggestionQuestion[];
  work: SuggestionWork[];
  bridgeSeenAt: number | null;
  messagesPerSuggestion: number;
};
export const emptySuggestions = (): SuggestionSnapshot => ({
  workflows: [],
  messages: [],
  questions: [],
  work: [],
  bridgeSeenAt: null,
  messagesPerSuggestion: 100,
});
export const SuggestionReplyTarget = object({
  suggestionId: Id,
  questionId: nullableId,
  requestWork: Type.Boolean(),
});
export type SuggestionReplyTarget = Static<typeof SuggestionReplyTarget>;
export const suggestionCommands = {
  PostSuggestionMessage: object({
    recordId: Id,
    suggestionId: Id,
    scopeId: Id,
    text: Type.String({ maxLength: 20000 }),
    replyToQuestionId: nullableId,
    requestWork: Type.Boolean(),
    attachments: Attachments,
  }),
  RequestSuggestionWork: object({ recordId: Id, suggestionId: Id }),
  CancelSuggestionWork: object({ requestId: Id }),
} as const;

/** Agent reports are persisted as a whole before publishing; retries keep these IDs. */
export const SuggestionAgentReport = object({
  reportId: Id,
  expectedServerEpoch: Id,
  runId: Id,
  summary: Type.String({ minLength: 1, maxLength: 20000 }),
  status: Type.Union([Type.Literal('working'), Type.Literal('needs_input'), Type.Literal('ready')]),
  messages: Type.Array(
    object({
      messageId: Id,
      text: Type.String({ minLength: 1, maxLength: 20000 }),
      kind: Type.Union([Type.Literal('progress'), Type.Literal('question')]),
      choices: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }),
    }),
    { maxItems: 20 },
  ),
  resolvedQuestionIds: Type.Array(Id, { maxItems: 100, uniqueItems: true }),
});
export type SuggestionAgentReport = Static<typeof SuggestionAgentReport>;
export const SuggestionAgentClaim = object({ operationId: Id, expectedServerEpoch: Id });
export const SuggestionAgentTransition = object({
  operationId: Id,
  expectedServerEpoch: Id,
  runId: Id,
  leaseToken: Id,
  state: Type.Union(['starting', 'running', 'uncertain', 'failed', 'reconcile'].map((s) => Type.Literal(s))),
  sessionId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  turnId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  issue: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
});
export type SuggestionAgentTransition = Static<typeof SuggestionAgentTransition>;
export type SuggestionRunContext = {
  original: { suggestionId: string; text: string; revision: number; attachments: Static<typeof Attachments> };
  summary: string;
  messages: SuggestionMessage[];
  questions: SuggestionQuestion[];
};
export type SuggestionRun = {
  runId: string;
  suggestionId: string;
  leaseToken: string;
  leaseUntil: number;
  state: string;
  sessionId: string | null;
  turnId: string | null;
  context: SuggestionRunContext;
};
