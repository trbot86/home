import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { immediate, installation, type Sqlite } from '../../infrastructure/database.js';
import { NotFound, Rejection, Unauthenticated } from '../../application/errors.js';
import { requireHuman, tokenDigest, type HumanRequestContext } from '../access/access.js';
import { CalendarsRepository } from './calendars.js';
import { CalendarSecretBox } from './secret-box.js';
import {
  calendarGrant,
  type CalendarGrant,
  type CalendarAuthorizationProvider,
} from './authorization-provider.js';
import { CalendarProviderError } from './provider.js';
import type { CalendarCredentials } from './synchronizer.js';

type Attempt = {
  state_digest: string;
  person_id: string;
  client_id: string;
  credential_id: string;
  recovery_epoch: string;
  label: string;
  connection_id: string | null;
  connection_generation: number | null;
  expires_at: number;
  state: 'pending' | 'exchanging' | 'complete' | 'failed';
  sealed_json: string | null;
  result_connection_id: string | null;
};
type CredentialRow = {
  credential_ref: string;
  connection_id: string;
  revision: number;
  sealed_json: string;
  generation: number;
  google_subject: string;
};

/** No callback bypass: finish must receive the original authenticated client context from the HTTP handoff. */
export class CalendarAuthorizationService implements CalendarCredentials {
  private readonly refreshing = new Map<string, Promise<string>>();
  constructor(
    private readonly db: Sqlite,
    private readonly calendars: CalendarsRepository,
    private readonly secrets: CalendarSecretBox,
    private readonly provider: CalendarAuthorizationProvider,
    private readonly now: () => number,
  ) {}
  private live(context: HumanRequestContext) {
    requireHuman(context);
    const valid = this.db
      .prepare(
        `SELECT 1 FROM clients c JOIN client_credentials cc USING(client_id)
      JOIN people p USING(person_id) WHERE c.client_id=? AND c.person_id=? AND c.kind=? AND c.enabled=1 AND p.active=1
      AND cc.credential_id=? AND cc.revoked_at IS NULL AND cc.expires_at>?`,
      )
      .get(context.clientId, context.personId, context.kind, context.credentialId, this.now());
    if (!valid) throw new Unauthenticated();
  }
  private associatedData(kind: 'attempt' | 'credential', id: string) {
    const state = installation(this.db);
    return JSON.stringify(['calendar-secrets-v1', state.installation_id, state.recovery_epoch, kind, id]);
  }
  begin(
    context: HumanRequestContext,
    label: string,
    reconnect?: { connectionId: string; generation: number },
  ) {
    this.live(context);
    if (!label.trim() || label.length > 300) throw new Rejection('invalid_calendar_connection');
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(32).toString('base64url'),
      digest = tokenDigest(state),
      expiresAt = this.now() + 10 * 60000;
    const url = this.provider.authorizationUrl(
      state,
      createHash('sha256').update(verifier).digest('base64url'),
    );
    immediate(this.db, () => {
      if (reconnect) {
        const connection = this.calendars
          .ownerConnections(context)
          .find((c) => c.connectionId === reconnect.connectionId);
        if (!connection) throw new NotFound();
        if (connection.generation !== reconnect.generation || connection.state === 'disconnected')
          throw new Rejection('calendar_connection_changed');
      }
      // Starting over invalidates an earlier exchange even when its network request is still in flight.
      this.db
        .prepare('DELETE FROM calendar_authorizations WHERE expires_at<=? OR client_id=?')
        .run(this.now(), context.clientId);
      this.db
        .prepare(
          `INSERT INTO calendar_authorizations(state_digest,person_id,client_id,credential_id,recovery_epoch,
        label,connection_id,connection_generation,expires_at,state,sealed_json) VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`,
        )
        .run(
          digest,
          context.personId,
          context.clientId,
          context.credentialId,
          installation(this.db).recovery_epoch,
          label.trim(),
          reconnect?.connectionId ?? null,
          reconnect?.generation ?? null,
          expiresAt,
          this.secrets.seal(
            { verifier, clientId: this.provider.clientId },
            this.associatedData('attempt', digest),
          ),
        );
    });
    return { authorizationUrl: url, expiresAt };
  }
  private attempt(context: HumanRequestContext, digest: string): Attempt {
    this.live(context);
    const row = this.db.prepare('SELECT * FROM calendar_authorizations WHERE state_digest=?').get(digest) as
      Attempt | undefined;
    if (
      !row ||
      row.person_id !== context.personId ||
      row.client_id !== context.clientId ||
      row.credential_id !== context.credentialId ||
      row.expires_at <= this.now() ||
      row.recovery_epoch !== installation(this.db).recovery_epoch
    )
      throw new Rejection('calendar_authorization_expired');
    return row;
  }
  async finish(
    context: HumanRequestContext,
    state: string,
    code: string,
    cancellation?: AbortSignal,
  ): Promise<{ connectionId: string }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 4096)
      throw new Rejection('invalid_calendar_authorization');
    const digest = tokenDigest(state),
      signal = AbortSignal.any([AbortSignal.timeout(30000), ...(cancellation ? [cancellation] : [])]);
    signal.throwIfAborted();
    const prepared = immediate(this.db, () => {
      const row = this.attempt(context, digest);
      if (row.state === 'complete') return { complete: row.result_connection_id! };
      if (row.state !== 'pending') throw new Rejection('calendar_authorization_restart_required');
      const secret = this.secrets.open(row.sealed_json!, this.associatedData('attempt', digest)) as {
        verifier: string;
        clientId: string;
      };
      if (secret.clientId !== this.provider.clientId)
        throw new Rejection('calendar_authorization_restart_required');
      this.db
        .prepare(
          "UPDATE calendar_authorizations SET state='exchanging',sealed_json=NULL WHERE state_digest=?",
        )
        .run(digest);
      return { verifier: secret.verifier };
    });
    if ('complete' in prepared) return { connectionId: prepared.complete! };
    try {
      const grant = calendarGrant(
        await this.provider.exchange(code, prepared.verifier!, signal),
        this.provider.clientId,
        this.now(),
      );
      signal.throwIfAborted();
      return immediate(this.db, () => {
        const row = this.attempt(context, digest);
        if (row.state !== 'exchanging') throw new Rejection('calendar_authorization_restart_required');
        const duplicate = this.db
          .prepare(
            `SELECT connection_id FROM calendar_connections WHERE owner_person_id=?
          AND provider='google' AND google_subject=? AND state<>'disconnected'`,
          )
          .get(context.personId, grant.subject) as { connection_id: string } | undefined;
        if (duplicate && duplicate.connection_id !== row.connection_id)
          throw new Rejection('calendar_account_already_connected');
        const credentialRef = randomUUID();
        let connectionId = row.connection_id;
        if (connectionId) {
          const connection = this.db
            .prepare('SELECT * FROM calendar_connections WHERE connection_id=? AND owner_person_id=?')
            .get(connectionId, context.personId) as
            { generation: number; state: string; google_subject: string | null } | undefined;
          if (
            !connection ||
            connection.state === 'disconnected' ||
            connection.generation !== row.connection_generation
          )
            throw new Rejection('calendar_connection_changed');
          if (connection.google_subject !== grant.subject) throw new Rejection('calendar_account_mismatch');
          this.db
            .prepare(
              `UPDATE calendar_connections SET credential_ref=?,state='active',generation=generation+1,
            label=?,error_code=NULL,last_attempt_at=NULL,updated_at=? WHERE connection_id=?`,
            )
            .run(credentialRef, row.label, this.now(), connectionId);
          this.db
            .prepare(
              'DELETE FROM calendar_event_cache WHERE calendar_id IN (SELECT calendar_id FROM calendars WHERE connection_id=?)',
            )
            .run(connectionId);
          this.db
            .prepare(
              `UPDATE calendars SET snapshot_from=NULL,snapshot_until=NULL,refreshed_at=NULL,last_attempt_at=NULL,
            error_code=NULL,revision=revision+1,refresh_generation=refresh_generation+1 WHERE connection_id=?`,
            )
            .run(connectionId);
        } else {
          connectionId = this.calendars.registerConnection(context, row.label, credentialRef);
          this.db
            .prepare('UPDATE calendar_connections SET google_subject=? WHERE connection_id=?')
            .run(grant.subject, connectionId);
        }
        this.db
          .prepare('INSERT INTO calendar_credentials VALUES (?,?,1,?,?)')
          .run(
            credentialRef,
            connectionId,
            this.secrets.seal(grant, this.associatedData('credential', credentialRef)),
            this.now(),
          );
        this.db
          .prepare(
            "UPDATE calendar_authorizations SET state='complete',result_connection_id=? WHERE state_digest=?",
          )
          .run(connectionId, digest);
        return { connectionId };
      });
    } catch (error) {
      immediate(this.db, () =>
        this.db
          .prepare(
            "UPDATE calendar_authorizations SET state='failed' WHERE state_digest=? AND state='exchanging'",
          )
          .run(digest),
      );
      if (
        error instanceof Rejection ||
        error instanceof NotFound ||
        error instanceof Unauthenticated ||
        error instanceof CalendarProviderError
      )
        throw error;
      throw new CalendarProviderError('provider_unavailable');
    }
  }
  private credential(ref: string): CredentialRow {
    const row = this.db
      .prepare(
        `SELECT t.*,c.generation,c.google_subject FROM calendar_credentials t JOIN calendar_connections c USING(connection_id)
      WHERE t.credential_ref=? AND c.credential_ref=t.credential_ref AND c.state='active'`,
      )
      .get(ref) as CredentialRow | undefined;
    if (!row) throw new CalendarProviderError('authentication_required');
    return row;
  }
  private read(row: CredentialRow): CalendarGrant {
    try {
      const grant = calendarGrant(
        this.secrets.open(row.sealed_json, this.associatedData('credential', row.credential_ref)),
        this.provider.clientId,
        this.now(),
        true,
      );
      if (grant.subject !== row.google_subject) throw new Error();
      return grant;
    } catch {
      throw new CalendarProviderError('authentication_required');
    }
  }
  async accessToken(ref: string, cancellation: AbortSignal): Promise<string> {
    cancellation.throwIfAborted();
    const row = this.credential(ref),
      grant = this.read(row);
    if (grant.expiresAt > this.now() + 60000) return grant.accessToken;
    let pending = this.refreshing.get(ref);
    if (!pending) {
      pending = this.refresh(row, grant, cancellation);
      this.refreshing.set(ref, pending);
    }
    try {
      await pending;
      cancellation.throwIfAborted();
      return this.read(this.credential(ref)).accessToken;
    } finally {
      if (this.refreshing.get(ref) === pending) this.refreshing.delete(ref);
    }
  }
  private async refresh(row: CredentialRow, previous: CalendarGrant, cancellation: AbortSignal) {
    const expectedEpoch = installation(this.db).recovery_epoch;
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(20000)]);
    let refreshed: CalendarGrant;
    try {
      refreshed = calendarGrant(
        await this.provider.refresh(previous, signal),
        this.provider.clientId,
        this.now(),
      );
      signal.throwIfAborted();
      if (refreshed.subject !== previous.subject) throw new CalendarProviderError('authentication_required');
    } catch (error) {
      if (error instanceof CalendarProviderError) throw error;
      throw new CalendarProviderError('provider_unavailable');
    }
    return immediate(this.db, () => {
      if (installation(this.db).recovery_epoch !== expectedEpoch)
        throw new CalendarProviderError('authentication_required');
      const current = this.credential(row.credential_ref);
      if (current.generation !== row.generation || current.revision !== row.revision)
        throw new CalendarProviderError('authentication_required');
      this.db
        .prepare(
          'UPDATE calendar_credentials SET revision=revision+1,sealed_json=?,updated_at=? WHERE credential_ref=?',
        )
        .run(
          this.secrets.seal(refreshed, this.associatedData('credential', row.credential_ref)),
          this.now(),
          row.credential_ref,
        );
      return refreshed.accessToken;
    });
  }
}
