import { Type, type Static } from '@sinclair/typebox';
import { object } from './primitives.js';

export const agendaSectionKinds = ['tasks', 'calendar', 'food_soon', 'project_next'] as const;
export type AgendaSectionKind = (typeof agendaSectionKinds)[number];
export const AgendaLayout = object({
  version: Type.Literal(1),
  context: Type.Union([Type.Literal('both'), Type.Literal('home'), Type.Literal('work')]),
  days: Type.Union([Type.Literal(7), Type.Literal(30)]),
  sections: Type.Array(
    object({
      kind: Type.Union(agendaSectionKinds.map((kind) => Type.Literal(kind))),
      enabled: Type.Boolean(),
      limit: Type.Integer({ minimum: 1, maximum: 100 }),
    }),
    { minItems: 4, maxItems: 4 },
  ),
});
export type AgendaLayout = Static<typeof AgendaLayout>;
export const defaultAgendaLayout = (): AgendaLayout => ({
  version: 1,
  context: 'both',
  days: 7,
  sections: [
    { kind: 'tasks', enabled: true, limit: 12 },
    { kind: 'calendar', enabled: true, limit: 30 },
    { kind: 'food_soon', enabled: false, limit: 6 },
    { kind: 'project_next', enabled: false, limit: 6 },
  ],
});
