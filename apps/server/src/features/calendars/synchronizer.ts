import { immediate, type Sqlite } from '../../infrastructure/database.js';
import { CalendarsRepository } from './calendars.js';
import {
  CalendarProviderError,
  type CalendarProvider,
  type CalendarProviderErrorCode,
  type CalendarWindow,
} from './provider.js';
export interface CalendarCredentials {
  /** Resolve/refresh a separately protected credential; throw authentication_required if consent must be renewed. */
  accessToken(credentialRef: string, cancellation: AbortSignal): Promise<string>;
}
export type CalendarSyncOutcome =
  { status: 'applied' | 'superseded' | 'skipped' } | { status: 'failed'; code: CalendarProviderErrorCode };
/** Network work never holds a database transaction. Every publication rechecks the original authority. */
export class CalendarSynchronizer {
  constructor(
    private readonly db: Sqlite,
    private readonly calendars: CalendarsRepository,
    private readonly credentials: CalendarCredentials,
    private readonly provider: CalendarProvider,
  ) {}
  private cancellation(signal?: AbortSignal) {
    return AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
  }
  private code(error: unknown): CalendarProviderErrorCode {
    return error instanceof CalendarProviderError ? error.code : 'provider_unavailable';
  }
  async discover(connectionId: string, cancellation?: AbortSignal): Promise<CalendarSyncOutcome> {
    const signal = this.cancellation(cancellation);
    if (signal.aborted) return { status: 'skipped' };
    const lease = immediate(this.db, () => this.calendars.prepareDiscovery(connectionId));
    if (!lease) return { status: 'skipped' };
    try {
      const token = await this.credentials.accessToken(lease.credentialRef, signal);
      signal.throwIfAborted();
      const sources = await this.provider.listCalendars(token, signal);
      signal.throwIfAborted();
      const applied = immediate(this.db, () => this.calendars.publishDiscovery(lease, sources));
      return { status: applied ? 'applied' : 'superseded' };
    } catch (error) {
      const code = this.code(error),
        current = immediate(this.db, () => this.calendars.failDiscovery(lease, code));
      return current ? { status: 'failed', code } : { status: 'superseded' };
    }
  }
  async refresh(
    calendarId: string,
    window: CalendarWindow,
    cancellation?: AbortSignal,
  ): Promise<CalendarSyncOutcome> {
    const signal = this.cancellation(cancellation);
    if (signal.aborted) return { status: 'skipped' };
    const lease = immediate(this.db, () => this.calendars.prepareRefresh(calendarId, window));
    if (!lease) return { status: 'skipped' };
    try {
      const token = await this.credentials.accessToken(lease.credentialRef, signal);
      signal.throwIfAborted();
      const snapshot = await this.provider.readEvents(token, lease.providerCalendarId, lease.window, signal);
      signal.throwIfAborted();
      const applied = immediate(this.db, () => this.calendars.publishRefresh(lease, snapshot));
      return { status: applied ? 'applied' : 'superseded' };
    } catch (error) {
      const code = this.code(error),
        current = immediate(this.db, () => this.calendars.failRefresh(lease, code));
      return current ? { status: 'failed', code } : { status: 'superseded' };
    }
  }
}
