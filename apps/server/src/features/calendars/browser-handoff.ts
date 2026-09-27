import { randomBytes, randomUUID } from 'node:crypto';
import type { BeginCalendarConnection } from '@our-place/contracts';
import { immediate, installation, type Sqlite } from '../../infrastructure/database.js';
import { Rejection } from '../../application/errors.js';
import { tokenDigest, type HumanRequestContext } from '../access/access.js';
import { CalendarAuthorizationService } from './authorization.js';
import { CalendarSecretBox } from './secret-box.js';

export class CalendarBrowserHandoff {
  constructor(
    private readonly db: Sqlite,
    private readonly authorization: CalendarAuthorizationService,
    private readonly secrets: CalendarSecretBox,
    private readonly now: () => number,
  ) {}
  private associatedData(id: string) {
    const state = installation(this.db);
    return JSON.stringify(['calendar-browser-v1', state.installation_id, state.recovery_epoch, id]);
  }
  begin(context: HumanRequestContext, input: BeginCalendarConnection) {
    if (context.kind !== 'browser') throw new Rejection('calendar_use_browser');
    const attempt = this.authorization.begin(context, input.label, input.reconnect),
      state = new URL(attempt.authorizationUrl).searchParams.get('state'),
      browserSecret = randomBytes(32).toString('base64url');
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state))
      throw new Error('Calendar authorization URL lacks state');
    immediate(this.db, () =>
      this.db
        .prepare('INSERT INTO calendar_browser_handoffs VALUES (?,?,?,NULL)')
        .run(randomUUID(), tokenDigest(state), tokenDigest(browserSecret)),
    );
    return { ...attempt, browserSecret };
  }
  receive(state: string, browserSecret: string, code: string | null) {
    if (
      ![state, browserSecret].every((s) => /^[A-Za-z0-9_-]{43}$/.test(s)) ||
      (code !== null && (!code || code.length > 4096))
    )
      throw new Rejection('calendar_authorization_expired');
    return immediate(this.db, () => {
      const row = this.db
        .prepare(
          `SELECT h.handoff_id,h.sealed_response,a.state FROM calendar_browser_handoffs h
        JOIN calendar_authorizations a USING(state_digest) WHERE h.state_digest=? AND h.browser_digest=?
        AND a.expires_at>? AND a.recovery_epoch=?`,
        )
        .get(
          tokenDigest(state),
          tokenDigest(browserSecret),
          this.now(),
          installation(this.db).recovery_epoch,
        ) as { handoff_id: string; sealed_response: string | null; state: string } | undefined;
      if (!row || row.state !== 'pending') throw new Rejection('calendar_authorization_expired');
      if (row.sealed_response) return row.handoff_id;
      if (code === null) {
        this.db
          .prepare("UPDATE calendar_authorizations SET state='failed',sealed_json=NULL WHERE state_digest=?")
          .run(tokenDigest(state));
        return null;
      }
      this.db
        .prepare('UPDATE calendar_browser_handoffs SET sealed_response=? WHERE handoff_id=?')
        .run(this.secrets.seal({ state, code }, this.associatedData(row.handoff_id)), row.handoff_id);
      return row.handoff_id;
    });
  }
  async finish(context: HumanRequestContext, handoffId: string, signal?: AbortSignal) {
    if (context.kind !== 'browser') throw new Rejection('calendar_use_browser');
    const row = this.db
      .prepare(
        `SELECT h.sealed_response,a.state,a.result_connection_id FROM calendar_browser_handoffs h
      JOIN calendar_authorizations a USING(state_digest) WHERE h.handoff_id=? AND a.person_id=? AND a.client_id=?
      AND a.credential_id=? AND a.expires_at>? AND a.recovery_epoch=?`,
      )
      .get(
        handoffId,
        context.personId,
        context.clientId,
        context.credentialId,
        this.now(),
        installation(this.db).recovery_epoch,
      ) as { sealed_response: string | null; state: string; result_connection_id: string | null } | undefined;
    if (!row?.sealed_response) throw new Rejection('calendar_authorization_restart_required');
    const response = this.secrets.open(row.sealed_response, this.associatedData(handoffId)) as {
      state: string;
      code: string;
    };
    return await this.authorization.finish(context, response.state, response.code, signal);
  }
}
