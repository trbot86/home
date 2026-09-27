import { randomUUID } from 'node:crypto';
import {
  AgendaEvent,
  isValid,
  isCalendarDate,
  isTimeZone,
  type AgendaEvent as Event,
  type Command,
} from '@our-place/contracts';
import type { CommandHandler } from '../records/command-handler.js';
import type { Sqlite } from '../../infrastructure/database.js';
import { NotFound, Rejection } from '../../application/errors.js';
import { AccessService, requireHuman, type HumanRequestContext } from '../access/access.js';
import {
  CalendarProviderError,
  calendarWindow,
  type CalendarProviderErrorCode,
  type CalendarWindow,
  type CalendarEventSnapshot,
  type ProviderCalendar,
} from './provider.js';
type ConnectionRow = {
  connection_id: string;
  owner_person_id: string;
  provider: 'google';
  label: string;
  credential_ref: string | null;
  state: 'active' | 'needs_auth' | 'disconnected';
  generation: number;
  discovery_generation: number;
  last_attempt_at: number | null;
  error_code: CalendarProviderErrorCode | null;
  updated_at: number;
};
type CalendarRow = {
  calendar_id: string;
  connection_id: string;
  provider_calendar_id: string;
  title: string;
  time_zone: string;
  access_role: ProviderCalendar['accessRole'];
  is_primary: number;
  scope_id: string | null;
  context: 'home' | 'work';
  revision: number;
  refresh_generation: number;
  snapshot_from: number | null;
  snapshot_until: number | null;
  refreshed_at: number | null;
  last_attempt_at: number | null;
  error_code: CalendarProviderErrorCode | null;
};
type ConnectionLease = { connectionId: string; connectionGeneration: number; credentialRef: string };
export type CalendarDiscoveryLease = ConnectionLease & { discoveryGeneration: number };
export type CalendarRefreshLease = ConnectionLease & {
  calendarId: string;
  providerCalendarId: string;
  revision: number;
  refreshGeneration: number;
  window: CalendarWindow;
};
export type AgendaCalendarSnapshot = {
  calendarId: string;
  scopeId: string;
  context: 'home' | 'work';
  title: string;
  timeZone: string;
  refreshedAt: number | null;
  lastAttemptAt: number | null;
  errorCode: CalendarProviderErrorCode | null;
  window: CalendarWindow | null;
  events: Event[];
};

/** Transactional ownership and cache state. Call writes inside the caller's receipt/worker transaction. */
export class CalendarsRepository {
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
    private readonly now: () => number,
  ) {}
  commands(): CommandHandler {
    return {
      kinds: ['SelectCalendar', 'DisconnectCalendar'],
      execute: (context, kind, args) => {
        try {
          if (kind === 'SelectCalendar') {
            const value = args as Command<'SelectCalendar'>['arguments'];
            this.setSelection(
              context,
              value.calendarId,
              value.expectedRevision,
              value.scopeId,
              value.context,
            );
          } else {
            const value = args as Command<'DisconnectCalendar'>['arguments'];
            this.disconnect(context, value.connectionId, value.expectedGeneration);
          }
          return { records: [], changes: [] };
        } catch (error) {
          if (error instanceof NotFound) throw new Rejection('unavailable');
          throw error;
        }
      },
    };
  }
  private writing() {
    if (!this.db.inTransaction) throw new Error('Calendar writes require a transaction');
  }
  private connection(id: string) {
    return this.db.prepare('SELECT * FROM calendar_connections WHERE connection_id=?').get(id) as
      ConnectionRow | undefined;
  }
  private calendar(id: string) {
    return this.db.prepare('SELECT * FROM calendars WHERE calendar_id=?').get(id) as CalendarRow | undefined;
  }
  private owned(context: HumanRequestContext, id: string) {
    requireHuman(context);
    const row = this.connection(id);
    if (!row || row.owner_person_id !== context.personId) throw new NotFound();
    return row;
  }
  private matches(lease: ConnectionLease) {
    const row = this.connection(lease.connectionId);
    return row &&
      row.state === 'active' &&
      row.generation === lease.connectionGeneration &&
      row.credential_ref === lease.credentialRef
      ? row
      : null;
  }
  private clear(calendarId: string) {
    this.db.prepare('DELETE FROM calendar_event_cache WHERE calendar_id=?').run(calendarId);
    this.db
      .prepare(
        'UPDATE calendars SET snapshot_from=NULL,snapshot_until=NULL,refreshed_at=NULL,last_attempt_at=NULL,error_code=NULL,refresh_generation=refresh_generation+1 WHERE calendar_id=?',
      )
      .run(calendarId);
  }
  /** The OAuth completion path supplies a reference to a separately protected credential, never token bytes. */
  registerConnection(context: HumanRequestContext, label: string, credentialRef: string) {
    this.writing();
    requireHuman(context);
    if (!label.trim() || label.length > 300 || !/^[a-zA-Z0-9_-]{8,80}$/.test(credentialRef))
      throw new Rejection('invalid_calendar_connection');
    const count = (
      this.db
        .prepare(
          "SELECT COUNT(*) n FROM calendar_connections WHERE owner_person_id=? AND state<>'disconnected'",
        )
        .get(context.personId) as { n: number }
    ).n;
    if (count >= 8) throw new Rejection('calendar_connection_limit');
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO calendar_connections(connection_id,owner_person_id,provider,label,credential_ref,state,generation,updated_at) VALUES (?,?,'google',?,?,'active',1,?)",
      )
      .run(id, context.personId, label.trim(), credentialRef, this.now());
    return id;
  }
  ownerConnections(context: HumanRequestContext) {
    requireHuman(context);
    return (
      this.db
        .prepare('SELECT * FROM calendar_connections WHERE owner_person_id=? ORDER BY connection_id')
        .all(context.personId) as ConnectionRow[]
    ).map((row) => ({
      connectionId: row.connection_id,
      label: row.label,
      state: row.state,
      generation: row.generation,
      updatedAt: row.updated_at,
      lastAttemptAt: row.last_attempt_at,
      errorCode: row.error_code,
    }));
  }
  ownerCalendars(context: HumanRequestContext, connectionId: string) {
    this.owned(context, connectionId);
    return (
      this.db
        .prepare('SELECT * FROM calendars WHERE connection_id=? ORDER BY title,calendar_id')
        .all(connectionId) as CalendarRow[]
    ).map((row) => ({
      calendarId: row.calendar_id,
      providerId: row.provider_calendar_id,
      title: row.title,
      timeZone: row.time_zone,
      accessRole: row.access_role,
      primary: row.is_primary === 1,
      scopeId: row.scope_id,
      context: row.context,
      revision: row.revision,
    }));
  }
  disconnect(context: HumanRequestContext, connectionId: string, expectedGeneration: number) {
    this.writing();
    const connection = this.owned(context, connectionId);
    if (connection.generation !== expectedGeneration) throw new Rejection('calendar_connection_changed');
    this.db.prepare('DELETE FROM calendars WHERE connection_id=?').run(connectionId);
    this.db
      .prepare(
        "UPDATE calendar_connections SET state='disconnected',credential_ref=NULL,generation=generation+1,updated_at=? WHERE connection_id=?",
      )
      .run(this.now(), connectionId);
    return connection.credential_ref;
  }
  prepareDiscovery(connectionId: string): CalendarDiscoveryLease | null {
    this.writing();
    const connection = this.connection(connectionId);
    if (!connection || connection.state !== 'active') return null;
    this.db
      .prepare(
        'UPDATE calendar_connections SET discovery_generation=discovery_generation+1,last_attempt_at=? WHERE connection_id=?',
      )
      .run(this.now(), connectionId);
    return {
      connectionId,
      connectionGeneration: connection.generation,
      credentialRef: connection.credential_ref!,
      discoveryGeneration: connection.discovery_generation + 1,
    };
  }
  publishDiscovery(lease: CalendarDiscoveryLease, calendars: ProviderCalendar[]) {
    this.writing();
    const connection = this.matches(lease);
    if (!connection || connection.discovery_generation !== lease.discoveryGeneration) return false;
    if (calendars.length > 500 || new Set(calendars.map((c) => c.providerId)).size !== calendars.length)
      throw new CalendarProviderError('calendar_limit');
    const existing = this.db
      .prepare('SELECT * FROM calendars WHERE connection_id=?')
      .all(lease.connectionId) as CalendarRow[];
    for (const item of calendars) {
      if (
        !item.providerId ||
        item.providerId.length > 2048 ||
        item.title.length > 1000 ||
        !isTimeZone(item.timeZone) ||
        !['reader', 'writer', 'owner', 'freeBusyReader'].includes(item.accessRole)
      )
        throw new CalendarProviderError('invalid_provider_response');
      const old = existing.find((row) => row.provider_calendar_id === item.providerId);
      if (!old)
        this.db
          .prepare(
            'INSERT INTO calendars(calendar_id,connection_id,provider_calendar_id,title,time_zone,access_role,is_primary,scope_id,context,revision) VALUES (?,?,?,?,?,?,?,NULL,?,1)',
          )
          .run(
            randomUUID(),
            lease.connectionId,
            item.providerId,
            item.title,
            item.timeZone,
            item.accessRole,
            Number(item.primary),
            'home',
          );
      else if (
        old.title !== item.title ||
        old.time_zone !== item.timeZone ||
        old.access_role !== item.accessRole ||
        old.is_primary !== Number(item.primary)
      ) {
        this.db
          .prepare(
            'UPDATE calendars SET title=?,time_zone=?,access_role=?,is_primary=?,revision=revision+1 WHERE calendar_id=?',
          )
          .run(item.title, item.timeZone, item.accessRole, Number(item.primary), old.calendar_id);
        if (old.access_role !== item.accessRole) this.clear(old.calendar_id);
        if (item.accessRole === 'freeBusyReader') {
          this.db.prepare('UPDATE calendars SET scope_id=NULL WHERE calendar_id=?').run(old.calendar_id);
        }
      }
    }
    const present = new Set(calendars.map((item) => item.providerId));
    for (const old of existing)
      if (!present.has(old.provider_calendar_id))
        this.db.prepare('DELETE FROM calendars WHERE calendar_id=?').run(old.calendar_id);
    this.db
      .prepare('UPDATE calendar_connections SET error_code=NULL WHERE connection_id=?')
      .run(lease.connectionId);
    return true;
  }
  failDiscovery(lease: CalendarDiscoveryLease, code: CalendarProviderErrorCode) {
    this.writing();
    const connection = this.matches(lease);
    if (!connection || connection.discovery_generation !== lease.discoveryGeneration) return false;
    this.db
      .prepare('UPDATE calendar_connections SET error_code=?,updated_at=? WHERE connection_id=?')
      .run(code, this.now(), lease.connectionId);
    if (code === 'authentication_required' || code === 'access_denied')
      this.db
        .prepare(
          "UPDATE calendar_connections SET state='needs_auth',generation=generation+1 WHERE connection_id=?",
        )
        .run(lease.connectionId);
    return true;
  }
  setSelection(
    context: HumanRequestContext,
    calendarId: string,
    expectedRevision: number,
    scopeId: string | null,
    kind: 'home' | 'work',
  ) {
    this.writing();
    requireHuman(context);
    const row = this.calendar(calendarId);
    if (!row) throw new NotFound();
    const connection = this.owned(context, row.connection_id);
    if (connection.state !== 'active') throw new Rejection('calendar_needs_connection');
    if (row.revision !== expectedRevision) throw new Rejection('calendar_selection_changed');
    if (scopeId) {
      this.access.requireScope(context, scopeId);
      if (row.access_role === 'freeBusyReader') throw new Rejection('calendar_details_unavailable');
      const scope = this.db.prepare('SELECT kind FROM visibility_scopes WHERE scope_id=?').get(scopeId) as {
        kind: string;
      };
      if (kind === 'work' && scope.kind !== 'private') throw new Rejection('work_calendar_must_be_private');
      const count = (
        this.db
          .prepare(
            'SELECT COUNT(*) n FROM calendars c JOIN calendar_connections x USING(connection_id) WHERE x.owner_person_id=? AND c.scope_id IS NOT NULL AND c.calendar_id<>?',
          )
          .get(context.personId, calendarId) as { n: number }
      ).n;
      if (count >= 12) throw new Rejection('selected_calendar_limit');
    }
    this.clear(calendarId);
    this.db
      .prepare('UPDATE calendars SET scope_id=?,context=?,revision=revision+1 WHERE calendar_id=?')
      .run(scopeId, kind, calendarId);
  }
  prepareRefresh(calendarId: string, window: CalendarWindow): CalendarRefreshLease | null {
    this.writing();
    const row = this.calendar(calendarId),
      connection = row && this.connection(row.connection_id);
    if (!row || !row.scope_id || !connection || connection.state !== 'active') return null;
    window = calendarWindow(window);
    this.db
      .prepare(
        'UPDATE calendars SET refresh_generation=refresh_generation+1,last_attempt_at=? WHERE calendar_id=?',
      )
      .run(this.now(), calendarId);
    return {
      connectionId: connection.connection_id,
      connectionGeneration: connection.generation,
      credentialRef: connection.credential_ref!,
      calendarId,
      providerCalendarId: row.provider_calendar_id,
      revision: row.revision,
      refreshGeneration: row.refresh_generation + 1,
      window: { ...window },
    };
  }
  private current(lease: CalendarRefreshLease) {
    if (!this.matches(lease)) return null;
    const row = this.calendar(lease.calendarId);
    return row &&
      row.connection_id === lease.connectionId &&
      row.scope_id &&
      row.revision === lease.revision &&
      row.refresh_generation === lease.refreshGeneration
      ? row
      : null;
  }
  publishRefresh(lease: CalendarRefreshLease, snapshot: CalendarEventSnapshot) {
    this.writing();
    const row = this.current(lease);
    if (!row) return false;
    if (
      snapshot.window.from !== lease.window.from ||
      snapshot.window.until !== lease.window.until ||
      !isTimeZone(snapshot.timeZone)
    )
      throw new CalendarProviderError('invalid_provider_response');
    if (snapshot.events.length > 10000) throw new CalendarProviderError('calendar_limit');
    const rows = snapshot.events.map((event) => {
      if (
        !isValid(AgendaEvent, event) ||
        (event.timing.kind === 'all_day'
          ? !isCalendarDate(event.timing.startDate) ||
            !isCalendarDate(event.timing.endDate) ||
            event.timing.endDate <= event.timing.startDate
          : event.timing.endAt < event.timing.startAt || !isTimeZone(event.timing.timeZone))
      )
        throw new CalendarProviderError('invalid_provider_response');
      return { event, json: JSON.stringify(event) };
    });
    if (
      new Set(rows.map(({ event }) => JSON.stringify([event.eventId, event.instanceKey]))).size !==
      rows.length
    )
      throw new CalendarProviderError('invalid_provider_response');
    const retained = (
      this.db
        .prepare(
          'SELECT COALESCE(SUM(length(CAST(e.payload_json AS BLOB))),0) bytes FROM calendar_event_cache e JOIN calendars c USING(calendar_id) JOIN calendar_connections x USING(connection_id) WHERE x.owner_person_id=(SELECT owner_person_id FROM calendar_connections WHERE connection_id=?) AND c.calendar_id<>?',
        )
        .get(lease.connectionId, lease.calendarId) as { bytes: number }
    ).bytes;
    if (retained + rows.reduce((sum, row) => sum + Buffer.byteLength(row.json), 0) > 16 * 1024 * 1024)
      throw new CalendarProviderError('calendar_limit');
    this.db.prepare('DELETE FROM calendar_event_cache WHERE calendar_id=?').run(row.calendar_id);
    const insert = this.db.prepare(
      'INSERT INTO calendar_event_cache(calendar_id,provider_event_id,instance_key,payload_json) VALUES (?,?,?,?)',
    );
    for (const { event, json } of rows) insert.run(row.calendar_id, event.eventId, event.instanceKey, json);
    this.db
      .prepare(
        'UPDATE calendars SET snapshot_from=?,snapshot_until=?,time_zone=?,refreshed_at=?,error_code=NULL WHERE calendar_id=?',
      )
      .run(lease.window.from, lease.window.until, snapshot.timeZone, this.now(), row.calendar_id);
    return true;
  }
  failRefresh(lease: CalendarRefreshLease, code: CalendarProviderErrorCode) {
    this.writing();
    if (!this.current(lease)) return false;
    if (code === 'authentication_required')
      this.db
        .prepare(
          "UPDATE calendar_connections SET state='needs_auth',error_code='authentication_required',generation=generation+1,updated_at=? WHERE connection_id=?",
        )
        .run(this.now(), lease.connectionId);
    if (code === 'access_denied' || code === 'calendar_unavailable') this.clear(lease.calendarId);
    this.db.prepare('UPDATE calendars SET error_code=? WHERE calendar_id=?').run(code, lease.calendarId);
    return true;
  }
  snapshot(context: HumanRequestContext): AgendaCalendarSnapshot[] {
    requireHuman(context);
    const calendars = this.db
      .prepare(
        "SELECT c.*,x.owner_person_id FROM calendars c JOIN calendar_connections x USING(connection_id) JOIN visibility_scopes s USING(scope_id) WHERE x.state='active' AND (s.kind='shared' OR s.owner_person_id=?) ORDER BY c.title,c.calendar_id",
      )
      .all(context.personId) as (CalendarRow & { owner_person_id: string })[];
    return calendars.map((row) => {
      const events = (
        this.db
          .prepare(
            'SELECT payload_json FROM calendar_event_cache WHERE calendar_id=? ORDER BY provider_event_id,instance_key',
          )
          .all(row.calendar_id) as { payload_json: string }[]
      )
        .map((item) => JSON.parse(item.payload_json) as Event)
        .filter(
          (event) =>
            row.owner_person_id === context.personId ||
            (event.visibility !== 'private' && event.visibility !== 'confidential'),
        );
      return {
        calendarId: row.calendar_id,
        scopeId: row.scope_id!,
        context: row.context,
        title: row.title,
        timeZone: row.time_zone,
        refreshedAt: row.refreshed_at,
        lastAttemptAt: row.last_attempt_at,
        errorCode: row.error_code,
        window: row.snapshot_from === null ? null : { from: row.snapshot_from, until: row.snapshot_until! },
        events,
      };
    });
  }
}
