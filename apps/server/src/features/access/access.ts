import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { HouseholdProfile, Person, Scope, Session } from '@our-place/contracts';
import {
  immediate,
  initialiseInstallation,
  installation,
  type Sqlite,
} from '../../infrastructure/database.js';
import { NotFound, Rejection, Unauthenticated } from '../../application/errors.js';

export type RequestContext = {
  clientId: string;
  personId: string;
  credentialId: string;
  kind: 'browser' | 'android';
};
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
async function passwordKey(password: string, salt: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 32, passwordOptions, (error, key) => (error ? reject(error) : resolve(key))),
  );
}
export async function passwordVerifier(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) throw new Error('Password must have 12–256 characters');
  const salt = randomBytes(16);
  return `scrypt1:${salt.toString('hex')}:${(await passwordKey(password, salt)).toString('hex')}`;
}
async function verifyPassword(password: string, verifier: string): Promise<boolean> {
  const [version, salt, digest] = verifier.split(':');
  if (version !== 'scrypt1' || !salt || !digest || password.length > 256) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = await passwordKey(password, Buffer.from(salt, 'hex'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function tokenDigest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
export async function provisionHousehold(
  db: Sqlite,
  people: { username: string; displayName: string; password: string }[],
): Promise<void> {
  if (people.length !== 2 || new Set(people.map((p) => p.username.toLowerCase().trim())).size !== 2)
    throw new Error('Two distinct accounts are required');
  const prepared = await Promise.all(
    people.map(async (person) => ({
      ...person,
      verifier: await passwordVerifier(person.password),
      personId: randomUUID(),
    })),
  );
  immediate(db, () => {
    initialiseInstallation(db);
    for (const [index, person] of prepared.entries()) {
      db.prepare(
        'INSERT INTO people(person_id,username,display_name,password_verifier,is_administrator) VALUES (?,?,?,?,?)',
      ).run(
        person.personId,
        person.username.toLowerCase().trim(),
        person.displayName,
        person.verifier,
        index === 0 ? 1 : 0,
      );
      db.prepare("INSERT INTO visibility_scopes VALUES (?, 'private', ?)").run(randomUUID(), person.personId);
    }
  });
}
export async function provisionPerson(
  db: Sqlite,
  username: string,
  displayName: string,
  password: string,
): Promise<string> {
  const verifier = await passwordVerifier(password);
  const personId = randomUUID();
  immediate(db, () => {
    db.prepare('INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)').run(
      personId,
      username.toLowerCase().trim(),
      displayName,
      verifier,
    );
    db.prepare("INSERT INTO visibility_scopes VALUES (?, 'private', ?)").run(randomUUID(), personId);
  });
  return personId;
}
export class AccessService {
  constructor(
    private readonly db: Sqlite,
    private readonly now: () => number,
  ) {}
  async login(
    username: string,
    password: string,
    kind: RequestContext['kind'],
    clientId?: string,
  ): Promise<{ secret: string; session: Session }> {
    const person = this.db
      .prepare('SELECT * FROM people WHERE username=? AND active=1')
      .get(username.toLowerCase().trim()) as { person_id: string; password_verifier: string } | undefined;
    // Do equivalent expensive work for unknown accounts as well.
    const dummy = `scrypt1:${'0'.repeat(32)}:${'0'.repeat(64)}`;
    const valid = await verifyPassword(password, person?.password_verifier ?? dummy);
    if (!person || !valid) throw new Unauthenticated();
    return this.issueSession(person.person_id, kind, clientId);
  }
  profiles(): HouseholdProfile[] {
    return this.db
      .prepare(
        'SELECT person_id AS personId, display_name AS displayName, username FROM people WHERE active=1 ORDER BY rowid',
      )
      .all() as HouseholdProfile[];
  }
  // Called only by the explicitly enabled trusted-network authentication mode.
  selectProfile(
    username: string,
    kind: RequestContext['kind'],
    clientId?: string,
  ): { secret: string; session: Session } {
    const person = this.db
      .prepare('SELECT person_id FROM people WHERE username=? AND active=1')
      .get(username.toLowerCase().trim()) as { person_id: string } | undefined;
    if (!person) throw new Unauthenticated();
    return this.issueSession(person.person_id, kind, clientId);
  }
  private issueSession(
    personId: string,
    kind: RequestContext['kind'],
    clientId?: string,
  ): { secret: string; session: Session } {
    const secret = randomBytes(32).toString('base64url');
    const credentialId = randomUUID();
    const stableClientId = immediate(this.db, () => {
      const existing = clientId
        ? (this.db.prepare('SELECT person_id,kind,enabled FROM clients WHERE client_id=?').get(clientId) as
            { person_id: string; kind: string; enabled: number } | undefined)
        : undefined;
      if (
        clientId &&
        existing &&
        (existing.person_id !== personId || existing.kind !== kind || !existing.enabled)
      )
        throw new Unauthenticated();
      // A restore can predate this device's registration. The configured access
      // policy, never the claimed client ID, establishes the person for re-pairing.
      if (clientId && !existing && installation(this.db).recovery_mode !== 'reconciling')
        throw new Unauthenticated();
      const id = clientId ?? randomUUID();
      if (!existing)
        this.db
          .prepare('INSERT INTO clients(client_id,person_id,kind) VALUES (?,?,?)')
          .run(id, personId, kind);
      this.db
        .prepare(
          'INSERT INTO client_credentials(credential_id,client_id,verifier,created_at,expires_at) VALUES (?,?,?,?,?)',
        )
        .run(credentialId, id, tokenDigest(secret), this.now(), this.now() + 90 * 86400000);
      return id;
    });
    return {
      secret,
      session: this.session({ personId, clientId: stableClientId, credentialId, kind }),
    };
  }
  authenticate(secret: string): RequestContext {
    const row = this.db
      .prepare(
        `SELECT c.client_id, c.person_id, c.kind, cc.credential_id FROM client_credentials cc
      JOIN clients c USING(client_id) JOIN people p USING(person_id)
      WHERE cc.verifier=? AND cc.revoked_at IS NULL AND cc.expires_at>? AND c.enabled=1 AND p.active=1`,
      )
      .get(tokenDigest(secret), this.now()) as
      | { client_id: string; person_id: string; kind: RequestContext['kind']; credential_id: string }
      | undefined;
    if (!row) throw new Unauthenticated();
    return {
      clientId: row.client_id,
      personId: row.person_id,
      credentialId: row.credential_id,
      kind: row.kind,
    };
  }
  logout(context: RequestContext): void {
    this.db
      .prepare('UPDATE client_credentials SET revoked_at=? WHERE credential_id=?')
      .run(this.now(), context.credentialId);
  }
  scopes(context: RequestContext): Scope[] {
    return this.db
      .prepare(
        "SELECT scope_id AS scopeId,kind FROM visibility_scopes WHERE kind='shared' OR owner_person_id=? ORDER BY kind DESC",
      )
      .all(context.personId) as Scope[];
  }
  canAccess(context: RequestContext, scopeId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM visibility_scopes WHERE scope_id=? AND (kind='shared' OR owner_person_id=?)")
      .get(scopeId, context.personId);
  }
  requireScope(context: RequestContext, scopeId: string): void {
    if (!this.canAccess(context, scopeId)) throw new Rejection('unavailable');
  }
  isAdministrator(context: RequestContext): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM people WHERE person_id=? AND is_administrator=1 AND active=1')
      .get(context.personId);
  }
  requireAdministrator(context: RequestContext): void {
    if (!this.isAdministrator(context)) throw new NotFound();
  }
  session(context: RequestContext): Session {
    const state = installation(this.db);
    const person = this.db
      .prepare('SELECT person_id AS personId,display_name AS displayName FROM people WHERE person_id=?')
      .get(context.personId) as Person;
    return {
      person,
      clientId: context.clientId,
      scopes: this.scopes(context),
      installationId: state.installation_id,
      serverEpoch: state.recovery_epoch,
      restorePoint: state.restored_from_at,
      isAdministrator: this.isAdministrator(context),
    };
  }
}
