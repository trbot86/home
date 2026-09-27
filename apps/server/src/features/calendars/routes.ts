import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { BeginCalendarConnection, Id, isValid, type CalendarSettings } from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { NotFound, Rejection } from '../../application/errors.js';
import type { HumanRequestContext } from '../access/access.js';
import { CalendarsRepository } from './calendars.js';
import { CalendarAuthorizationService } from './authorization.js';
import { CalendarBrowserHandoff } from './browser-handoff.js';
import { CalendarSynchronizer } from './synchronizer.js';
import type { CalendarConfiguration } from './configuration.js';

const cookieName = 'our_place_calendar_browser';
const finishSchema = Type.Object({ handoffId: Id }, { additionalProperties: false });
export function registerCalendarRoutes(
  app: FastifyInstance,
  db: Sqlite,
  calendars: CalendarsRepository,
  authenticate: (request: FastifyRequest) => HumanRequestContext,
  origin: string,
  now: () => number,
  configuration?: CalendarConfiguration,
) {
  const abort = new AbortController(),
    pending = new Set<Promise<unknown>>();
  const auth =
    configuration &&
    new CalendarAuthorizationService(db, calendars, configuration.secrets, configuration.authorization, now);
  const handoff = auth && configuration && new CalendarBrowserHandoff(db, auth, configuration.secrets, now);
  const sync = auth && configuration && new CalendarSynchronizer(db, calendars, auth, configuration.events);
  async function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  }
  function enabled() {
    if (!handoff || !sync) throw new Rejection('calendar_not_configured');
    return { handoff, sync };
  }
  app.get('/api/calendars/settings', async (request): Promise<CalendarSettings> => {
    const context = authenticate(request);
    return {
      configured: !!configuration,
      connections: calendars
        .ownerConnections(context)
        .map((c) => ({
          ...c,
          calendars: calendars
            .ownerCalendars(context, c.connectionId)
            .map(({ providerId: _providerId, ...source }) => source),
        })),
    };
  });
  app.post(
    '/api/calendars/authorization/begin',
    { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const context = authenticate(request);
      if (!isValid(BeginCalendarConnection, request.body)) throw new Rejection('invalid_calendar_connection');
      const result = enabled().handoff.begin(context, request.body);
      reply.setCookie(cookieName, result.browserSecret, {
        httpOnly: true,
        secure: origin.startsWith('https:'),
        sameSite: 'lax',
        path: '/oauth/calendar',
        maxAge: 600,
      });
      return { authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt };
    },
  );
  app.get('/oauth/calendar/callback', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    const query = request.query as Record<string, unknown>;
    try {
      if (
        typeof query.state !== 'string' ||
        (query.error === undefined ? typeof query.code !== 'string' : typeof query.error !== 'string')
      )
        throw new Rejection('invalid_calendar_authorization');
      const id = enabled().handoff.receive(
        query.state,
        request.cookies[cookieName] ?? '',
        query.error === undefined ? (query.code as string) : null,
      );
      reply.clearCookie(cookieName, {
        path: '/oauth/calendar',
        secure: origin.startsWith('https:'),
        sameSite: 'lax',
      });
      // No code, state or provider error follows the user into the application page.
      return reply.redirect('/?settings=calendars&calendarConnect=' + (id ?? 'cancelled'));
    } catch {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/calendar-status.css"><title>Calendar connection</title><body><h1>Start the calendar connection again</h1><p>This connection could not be verified in this browser.</p><a href="/?settings=calendars">Return to Our place</a></body></html>',
        );
    }
  });
  app.post('/api/calendars/authorization/finish', async (request) => {
    const context = authenticate(request);
    if (!isValid(finishSchema, request.body)) throw new Rejection('invalid_calendar_authorization');
    const runtime = enabled();
    const connected = await track(runtime.handoff.finish(context, request.body.handoffId, abort.signal));
    const discovery = await track(runtime.sync.discover(connected.connectionId, abort.signal));
    return { ...connected, discovery };
  });
  app.post<{ Params: { id: string } }>(
    '/api/calendars/connections/:id/discover',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const context = authenticate(request);
      if (!calendars.ownerConnections(context).some((c) => c.connectionId === request.params.id))
        throw new NotFound();
      return await track(enabled().sync.discover(request.params.id, abort.signal));
    },
  );
  return {
    stop: async () => {
      abort.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
