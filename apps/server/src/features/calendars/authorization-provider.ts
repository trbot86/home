import { CalendarProviderError } from './provider.js';

export const calendarReadScopes = [
  'openid',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
] as const;
export type CalendarGrant = {
  clientId: string;
  subject: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
};
export interface CalendarAuthorizationProvider {
  readonly clientId: string;
  authorizationUrl(state: string, codeChallenge: string): string;
  exchange(code: string, verifier: string, cancellation: AbortSignal): Promise<CalendarGrant>;
  refresh(grant: CalendarGrant, cancellation: AbortSignal): Promise<CalendarGrant>;
}
/** Validate all grants, including persisted ones, before a token reaches a provider request. */
export function calendarGrant(
  value: unknown,
  clientId: string,
  now: number,
  allowExpired = false,
): CalendarGrant {
  if (!value || typeof value !== 'object') throw new CalendarProviderError('authentication_required');
  const grant = value as CalendarGrant;
  if (
    grant.clientId !== clientId ||
    typeof grant.subject !== 'string' ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(grant.subject) ||
    ![grant.accessToken, grant.refreshToken].every(
      (t) => typeof t === 'string' && t.length > 0 && t.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(t),
    ) ||
    !Number.isSafeInteger(grant.expiresAt) ||
    grant.expiresAt <= 0 ||
    (!allowExpired && grant.expiresAt <= now) ||
    grant.expiresAt > now + 86400000 ||
    !Array.isArray(grant.scopes) ||
    grant.scopes.length > 100 ||
    !grant.scopes.every((s) => typeof s === 'string' && s.length <= 300) ||
    !calendarReadScopes.every((s) => grant.scopes.includes(s))
  )
    throw new CalendarProviderError('authentication_required');
  return grant;
}
