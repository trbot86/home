import { randomUUID } from 'node:crypto';
import { immediate, type Sqlite } from '../../infrastructure/database.js';
import type { HumanRequestContext } from '../access/access.js';
import { CalendarsRepository } from './calendars.js';
import { googleIcalUrl, IcalProvider } from './ical-provider.js';
import { CalendarProviderError, type CalendarProvider, type CalendarWindow } from './provider.js';
import type { CalendarCredentials } from './synchronizer.js';

export class IcalSubscriptions {
  constructor(
    private readonly db: Sqlite,
    private readonly calendars: CalendarsRepository,
    private readonly provider = new IcalProvider(),
  ) {}
  async connect(context: HumanRequestContext, label: string, rawUrl: string, signal?: AbortSignal) {
    const url = googleIcalUrl(rawUrl);
    // Validate before saving a connection. Repeated submissions of the same link are idempotent per owner.
    const day = 86400000,
      from = Math.floor(Date.now() / day) * day;
    const snapshot = await this.provider.read(url, { from: from - 8 * day, until: from + 62 * day }, signal);
    return immediate(this.db, () => {
      const existing = this.db
        .prepare(
          `SELECT c.connection_id FROM calendar_connections c JOIN calendar_ical_credentials f USING(connection_id)
        WHERE c.owner_person_id=? AND c.state<>'disconnected' AND f.feed_url=?`,
        )
        .get(context.personId, url) as { connection_id: string } | undefined;
      if (existing) return { connectionId: existing.connection_id };
      const ref = 'ical_' + randomUUID(),
        id = this.calendars.registerConnection(context, label, ref);
      this.db.prepare("UPDATE calendar_connections SET transport='ical' WHERE connection_id=?").run(id);
      this.db.prepare('INSERT INTO calendar_ical_credentials VALUES (?,?,?)').run(ref, id, url);
      const lease = this.calendars.prepareDiscovery(id)!;
      this.calendars.publishDiscovery(lease, [
        {
          providerId: 'feed',
          title: label,
          timeZone: snapshot.timeZone,
          accessRole: 'reader',
          primary: true,
        },
      ]);
      // Start hidden: the user explicitly chooses private home, private work or shared home.
      return { connectionId: id };
    });
  }
  credentials(fallback?: CalendarCredentials): CalendarCredentials {
    return {
      accessToken: async (ref, signal) => {
        const row = this.db
          .prepare(
            `SELECT f.feed_url,c.label FROM calendar_ical_credentials f JOIN calendar_connections c USING(connection_id)
        WHERE f.credential_ref=? AND c.state='active'`,
          )
          .get(ref) as { feed_url: string; label: string } | undefined;
        if (row) return 'ical:' + JSON.stringify({ url: row.feed_url, label: row.label });
        if (fallback && !ref.startsWith('ical_')) return 'oauth:' + (await fallback.accessToken(ref, signal));
        throw new CalendarProviderError('authentication_required');
      },
    };
  }
  events(fallback?: CalendarProvider): CalendarProvider {
    const decode = (token: string) => JSON.parse(token.slice(5)) as { url: string; label: string };
    return {
      listCalendars: async (token, signal) => {
        if (token.startsWith('ical:')) {
          const feed = decode(token),
            from = Date.now();
          const snapshot = await this.provider.read(feed.url, { from, until: from + 86400000 }, signal);
          return [
            {
              providerId: 'feed',
              title: feed.label,
              timeZone: snapshot.timeZone,
              accessRole: 'reader',
              primary: true,
            },
          ];
        }
        if (!fallback) throw new CalendarProviderError('authentication_required');
        return fallback.listCalendars(token.slice(6), signal);
      },
      readEvents: async (token, id, window: CalendarWindow, signal) => {
        if (token.startsWith('ical:')) return this.provider.read(decode(token).url, window, signal);
        if (!fallback) throw new CalendarProviderError('authentication_required');
        return fallback.readEvents(token.slice(6), id, window, signal);
      },
    };
  }
}
