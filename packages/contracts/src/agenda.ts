import { Type, type Static } from '@sinclair/typebox';
import { object } from './primitives.js';
const civilDate = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const eventInstant = Type.Integer({ minimum: -62135596800000, maximum: 253402300799999 });
/** Calendar all-day dates stay civil dates; the end is exclusive in both variants. */
export const AgendaTiming = Type.Union([
  object({ kind: Type.Literal('all_day'), startDate: civilDate, endDate: civilDate }),
  object({
    kind: Type.Literal('timed'),
    startAt: eventInstant,
    endAt: eventInstant,
    timeZone: Type.String({ minLength: 1, maxLength: 100 }),
    endUnspecified: Type.Boolean(),
  }),
]);
export type AgendaTiming = Static<typeof AgendaTiming>;
/** Scoped by the containing calendar. These fields never contain provider credentials or attendee lists. */
export const AgendaEvent = object({
  eventId: Type.String({ minLength: 1, maxLength: 2048 }),
  instanceKey: Type.String({ maxLength: 100 }),
  recurringEventId: Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]),
  providerVersion: Type.String({ maxLength: 2048 }),
  title: Type.String({ maxLength: 1000 }),
  description: Type.String({ maxLength: 20000 }),
  location: Type.String({ maxLength: 4000 }),
  sourceUrl: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
  status: Type.Union([Type.Literal('confirmed'), Type.Literal('tentative')]),
  participation: Type.Union([
    Type.Literal('accepted'),
    Type.Literal('declined'),
    Type.Literal('tentative'),
    Type.Literal('needsAction'),
    Type.Null(),
  ]),
  visibility: Type.Union([
    Type.Literal('default'),
    Type.Literal('public'),
    Type.Literal('private'),
    Type.Literal('confidential'),
  ]),
  busy: Type.Boolean(),
  timing: AgendaTiming,
});
export type AgendaEvent = Static<typeof AgendaEvent>;

export type AgendaCalendarSnapshot = {
  calendarId: string;
  scopeId: string;
  context: 'home' | 'work';
  title: string;
  timeZone: string;
  refreshedAt: number | null;
  lastAttemptAt: number | null;
  errorCode: string | null;
  window: { from: number; until: number } | null;
  events: AgendaEvent[];
};
export type AgendaSnapshot = {
  configured: boolean;
  calendars: AgendaCalendarSnapshot[];
  needsReconnect: boolean;
  issue: 'calendar_limit' | null;
  sampledAt: number | null;
};
export const emptyAgenda = (): AgendaSnapshot => ({
  configured: false,
  calendars: [],
  needsReconnect: false,
  issue: null,
  sampledAt: null,
});
