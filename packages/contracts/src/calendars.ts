import { Type, type Static } from '@sinclair/typebox';
import { Id, Revision, object } from './primitives.js';
export const BeginCalendarConnection = object({
  label: Type.String({ minLength: 1, maxLength: 300 }),
  reconnect: Type.Optional(object({ connectionId: Id, generation: Revision })),
});
export type BeginCalendarConnection = Static<typeof BeginCalendarConnection>;
export const calendarCommands = {
  SelectCalendar: object({
    calendarId: Id,
    expectedRevision: Revision,
    scopeId: Type.Union([Id, Type.Null()]),
    context: Type.Union([Type.Literal('home'), Type.Literal('work')]),
  }),
  DisconnectCalendar: object({ connectionId: Id, expectedGeneration: Revision }),
} as const;
export type CalendarSettings = {
  configured: boolean;
  connections: {
    connectionId: string;
    label: string;
    state: 'active' | 'needs_auth' | 'disconnected';
    generation: number;
    updatedAt: number;
    lastAttemptAt: number | null;
    errorCode: string | null;
    calendars: {
      calendarId: string;
      title: string;
      timeZone: string;
      accessRole: 'reader' | 'writer' | 'owner' | 'freeBusyReader';
      primary: boolean;
      scopeId: string | null;
      context: 'home' | 'work';
      revision: number;
    }[];
  }[];
};
