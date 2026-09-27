import { readFile, lstat } from 'node:fs/promises';
import { CalendarSecretBox } from './secret-box.js';
import { GoogleCalendarAuthorization } from './google-authorization.js';
import { GoogleCalendarProvider } from './google-provider.js';
import type { CalendarAuthorizationProvider } from './authorization-provider.js';
import type { CalendarProvider } from './provider.js';
export type CalendarConfiguration = {
  secrets: CalendarSecretBox;
  authorization: CalendarAuthorizationProvider;
  events: CalendarProvider;
};
/** One host-only file; no configuration values are returned to a client or included in errors. */
export async function loadCalendarConfiguration(
  filename: string | undefined,
  origin: string,
): Promise<CalendarConfiguration | undefined> {
  if (!filename) return undefined;
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error();
    const raw = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>;
    if (
      typeof raw.clientId !== 'string' ||
      typeof raw.clientSecret !== 'string' ||
      typeof raw.activeKeyId !== 'string' ||
      !raw.keys ||
      typeof raw.keys !== 'object' ||
      Array.isArray(raw.keys)
    )
      throw new Error();
    const keys = new Map(
      Object.entries(raw.keys).map(([id, value]) => {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error();
        const key = Buffer.from(value, 'base64url');
        if (key.toString('base64url') !== value) throw new Error();
        return [id, key] as const;
      }),
    );
    if (keys.size > 8) throw new Error();
    return {
      secrets: new CalendarSecretBox(raw.activeKeyId, keys),
      events: new GoogleCalendarProvider(),
      authorization: new GoogleCalendarAuthorization({
        clientId: raw.clientId,
        clientSecret: raw.clientSecret,
        redirectUri: new URL('/oauth/calendar/callback', origin).href,
      }),
    };
  } catch {
    throw new Error('Calendar configuration is missing or invalid');
  }
}
