import { Type, type Static } from '@sinclair/typebox';
import { Id, Instant, Revision, object } from './primitives.js';
import { Attachments } from './attachments.js';
import { MaintenancePlan } from './home.js';
import { CookingPlan } from './recipes.js';
export const CalendarDate = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const nullableDate = Type.Union([CalendarDate, Type.Null()]);
const nullableId = Type.Union([Id, Type.Null()]);
export const TaskPriority = Type.Integer({ minimum: 0, maximum: 3 });
export const TaskRecurrence = object({
  version: Type.Literal(1),
  mode: Type.Literal('after_completion'),
  count: Type.Integer({ minimum: 1, maximum: 365 }),
  unit: Type.Union([Type.Literal('days'), Type.Literal('weeks'), Type.Literal('months')]),
  timeZone: Type.String({ minLength: 1, maxLength: 100 }),
});
export type TaskRecurrence = Static<typeof TaskRecurrence>;
export const TaskDefinitionFields = {
  title: Type.String({ minLength: 1, maxLength: 300 }),
  instructions: Type.String({ maxLength: 20000 }),
  context: Type.Union([Type.Literal('home'), Type.Literal('work')]),
  defaultAssigneeId: nullableId,
  defaultPriority: TaskPriority,
  recurrence: Type.Union([TaskRecurrence, Type.Null()]),
  // Optional on the wire: frozen requests and retained history predate these completion plans.
  maintenance: Type.Optional(Type.Union([MaintenancePlan, Type.Null()])),
  cooking: Type.Optional(Type.Union([CookingPlan, Type.Null()])),
};
export const TaskOccurrenceFields = {
  calendarVisible: Type.Optional(Type.Boolean()),
  approximateDate: Type.Optional(
    Type.Union([Type.Null(), Type.Literal('asap'), Type.Literal('week'), Type.Literal('month')]),
  ),
  assigneeId: nullableId,
  priority: TaskPriority,
  deadlineDate: nullableDate,
  targetDate: nullableDate,
  reviewDate: nullableDate,
};
const common = { scopeId: Id, deletedAt: Type.Union([Instant, Type.Null()]) };
export const taskContentSchemas = {
  task: object({ ...common, ...TaskDefinitionFields, attachments: Type.Optional(Attachments) }),
  task_occurrence: object({
    ...common,
    ...TaskOccurrenceFields,
    taskId: Id,
    ordinal: Type.Integer({ minimum: 1 }),
    state: Type.Union([Type.Literal('open'), Type.Literal('completed'), Type.Literal('cancelled')]),
  }),
  task_completion: object({
    ...common,
    attachments: Type.Optional(Attachments),
    occurrenceId: Id,
    completedAt: Instant,
    performedByPersonId: Id,
    performerName: Type.String({ maxLength: 300 }),
    note: Type.String({ maxLength: 20000 }),
    ruleRevision: Revision,
    recurrence: Type.Union([TaskRecurrence, Type.Null()]),
    nextOccurrenceId: nullableId,
  }),
} as const;
export type TaskKind = keyof typeof taskContentSchemas;
type Header<K extends TaskKind> = {
  recordId: string;
  kind: K;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type TaskDefinition = Header<'task'> & Static<typeof taskContentSchemas.task>;
export type TaskOccurrence = Header<'task_occurrence'> & Static<typeof taskContentSchemas.task_occurrence>;
export type TaskCompletion = Header<'task_completion'> & Static<typeof taskContentSchemas.task_completion>;
export type TaskRecord = TaskDefinition | TaskOccurrence | TaskCompletion;
export type TaskSnapshot = {
  definitions: TaskDefinition[];
  occurrences: TaskOccurrence[];
  completions: TaskCompletion[];
  people: { personId: string; displayName: string }[];
  timeZone: string;
};
export const emptyTasks = (): TaskSnapshot => ({
  definitions: [],
  occurrences: [],
  completions: [],
  people: [],
  timeZone: 'America/Toronto',
});
const target = { recordId: Id, expectedRevision: Revision };
const occurrenceReference = Type.Union([object(target), Type.Null()]);
export const taskCommands = {
  CreateTask: object({
    recordId: Id,
    occurrenceId: Id,
    scopeId: Id,
    ...TaskDefinitionFields,
    ...TaskOccurrenceFields,
  }),
  UpdateTaskDefinition: object({ ...target, ...TaskDefinitionFields }),
  UpdateTaskOccurrence: object({ ...target, ...TaskOccurrenceFields }),
  PostponeTaskOccurrence: object({
    ...target,
    field: Type.Union([Type.Literal('targetDate'), Type.Literal('reviewDate')]),
    date: CalendarDate,
  }),
  CompleteTaskOccurrence: object({
    ...target,
    expectedTaskRevision: Revision,
    completionId: Id,
    nextOccurrenceId: nullableId,
    completedAt: Instant,
    performedByPersonId: Id,
    note: Type.String({ maxLength: 20000 }),
  }),
  DeleteTask: object({ ...target, occurrence: occurrenceReference }),
  RestoreTask: object({ ...target, occurrence: occurrenceReference }),
} as const;
