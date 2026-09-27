import { randomBytes, randomUUID } from 'node:crypto';
import { immediate, type Sqlite } from '../../infrastructure/database.js';
import { Rejection, Unauthenticated } from '../../application/errors.js';
import {
  AccessService,
  tokenDigest,
  type HumanRequestContext,
  type IntegrationRequestContext,
  type RequestContext,
} from './access.js';

/** Recheck on every write AND receipt resolution, including calls without HTTP. */
export function requireIntegration(
  db: Sqlite,
  context: RequestContext,
  now: number,
): asserts context is IntegrationRequestContext {
  if (
    context.kind !== 'integration' ||
    !db
      .prepare(
        `SELECT 1 FROM clients c
    JOIN integration_actors a USING(integration_id) JOIN client_credentials cc USING(client_id)
    WHERE c.client_id=? AND c.integration_id=? AND c.kind='integration' AND c.enabled=1
    AND a.active=1 AND cc.credential_id=? AND cc.revoked_at IS NULL AND cc.expires_at>?`,
      )
      .get(context.clientId, context.integrationId, context.credentialId, now)
  )
    throw new Unauthenticated();
}

/** Explicit administrative provisioning; never called during migration/startup. */
export class IntegrationAccessService {
  constructor(
    private readonly db: Sqlite,
    private readonly now: () => number,
  ) {}
  private issue(clientId: string, expiresAt: number) {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) throw new Rejection('invalid_expiry');
    const secret = randomBytes(32).toString('base64url'),
      credentialId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO client_credentials(credential_id,client_id,verifier,created_at,expires_at)
      VALUES (?,?,?,?,?)`,
      )
      .run(credentialId, clientId, tokenDigest(secret), this.now(), expiresAt);
    return { secret, credentialId, clientId };
  }
  provision(administrator: HumanRequestContext, displayName: string, expiresAt: number) {
    new AccessService(this.db, this.now).requireAdministrator(administrator);
    if (!displayName.trim() || displayName.length > 80) throw new Rejection('invalid_label');
    return immediate(this.db, () => {
      const integrationId = randomUUID(),
        clientId = randomUUID();
      this.db.prepare('INSERT INTO integration_actors VALUES (?,?,1)').run(integrationId, displayName);
      this.db
        .prepare("INSERT INTO clients(client_id,kind,integration_id) VALUES (?,'integration',?)")
        .run(clientId, integrationId);
      return { ...this.issue(clientId, expiresAt), integrationId };
    });
  }
  rotate(administrator: HumanRequestContext, clientId: string, expiresAt: number) {
    new AccessService(this.db, this.now).requireAdministrator(administrator);
    return immediate(this.db, () => {
      if (
        !this.db
          .prepare(
            `SELECT 1 FROM clients c JOIN integration_actors a USING(integration_id)
        WHERE c.client_id=? AND c.kind='integration' AND c.enabled=1 AND a.active=1`,
          )
          .get(clientId)
      )
        throw new Rejection('unavailable');
      const issued = this.issue(clientId, expiresAt);
      this.db
        .prepare(
          `UPDATE client_credentials SET revoked_at=? WHERE client_id=?
        AND credential_id<>? AND revoked_at IS NULL`,
        )
        .run(this.now(), clientId, issued.credentialId);
      return issued;
    });
  }
  revoke(administrator: HumanRequestContext, clientId: string): void {
    new AccessService(this.db, this.now).requireAdministrator(administrator);
    if (!this.db.prepare("SELECT 1 FROM clients WHERE client_id=? AND kind='integration'").get(clientId))
      throw new Rejection('unavailable');
    this.db
      .prepare('UPDATE client_credentials SET revoked_at=? WHERE client_id=? AND revoked_at IS NULL')
      .run(this.now(), clientId);
  }
  authenticate(secret: string): IntegrationRequestContext {
    const row = this.db
      .prepare(
        `SELECT c.client_id,c.integration_id,cc.credential_id
      FROM client_credentials cc JOIN clients c USING(client_id)
      WHERE cc.verifier=? AND c.kind='integration'`,
      )
      .get(tokenDigest(secret)) as
      { client_id: string; integration_id: string; credential_id: string } | undefined;
    if (!row) throw new Unauthenticated();
    const context: IntegrationRequestContext = {
      kind: 'integration',
      clientId: row.client_id,
      integrationId: row.integration_id,
      credentialId: row.credential_id,
    };
    requireIntegration(this.db, context, this.now());
    return context;
  }
}
