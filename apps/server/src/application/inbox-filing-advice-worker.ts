import type { FilingAdviceSettings } from '@our-place/contracts';
import { installation, type Sqlite } from '../infrastructure/database.js';
import type { HumanRequestContext } from '../features/access/access.js';
import type { InboxRepository } from '../features/inbox/inbox.js';
import type { RecordRegistry } from '../features/records/record-registry.js';
import { InboxFilingSuggestions, type FilingAdviceProvider } from './inbox-filing-suggestions.js';
import { Rejection } from './errors.js';

/** Bounded discovery with one dispatch per tick. The durable per-item claim is the queue ledger.
 * Consent is tied to its authorizing session; logout/expiry/disable stops further dispatch.
 */
export class FilingAdviceWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<boolean> | undefined;
  private stopped = true;
  constructor(
    private readonly db: Sqlite,
    private readonly inbox: InboxRepository,
    private readonly records: RecordRegistry,
    private readonly settings: (context: HumanRequestContext) => FilingAdviceSettings,
    private readonly provider?: FilingAdviceProvider,
    private readonly now: () => number = Date.now,
  ) {}
  private contexts(): HumanRequestContext[] {
    return this.db
      .prepare(
        `SELECT c.client_id AS clientId,c.person_id AS personId,c.kind,cc.credential_id AS credentialId
      FROM inbox_filing_advice_preferences f JOIN client_credentials cc USING(credential_id)
      JOIN clients c USING(client_id) JOIN people p ON p.person_id=c.person_id
      WHERE f.person_id=c.person_id AND cc.revoked_at IS NULL AND cc.expires_at>?
      AND c.enabled=1 AND p.active=1 AND c.kind IN ('browser','android')
      AND json_extract(f.preferences_json,'$.enabled')=1 AND json_extract(f.preferences_json,'$.automatic')=1
      ORDER BY f.person_id LIMIT 10`,
      )
      .all(this.now()) as HumanRequestContext[];
  }
  start() {
    if (!this.provider || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch(() => {
          /* No provider errors or prompt data in logs. */
        })
        .finally(() => this.schedule(3000));
    }, delay);
    this.timer.unref();
  }
  tick(): Promise<boolean> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run() {
    if (!this.provider || installation(this.db).recovery_mode !== 'normal') return false;
    for (const context of this.contexts()) {
      const consent = this.settings(context);
      for (const scopeId of consent.scopeIds) {
        const candidate = this.db
          .prepare(
            `SELECT r.record_id AS id,r.revision FROM records r
          JOIN inbox_entries i ON i.inbox_id=r.record_id
          LEFT JOIN inbox_filing_suggestions a ON a.inbox_id=r.record_id
          WHERE r.scope_id=? AND r.deleted_at IS NULL AND i.category='inbox' AND i.filed_at IS NULL
          AND length(trim(i.text))>0 AND length(i.text)<=8000 AND a.inbox_id IS NULL
          ORDER BY r.created_at,r.record_id LIMIT 1`,
          )
          .get(scopeId) as { id: string; revision: number } | undefined;
        if (!candidate) continue;
        const destinationIds = consent.destinationTitles
          ? (
              this.db
                .prepare(
                  `SELECT record_id FROM records
          WHERE scope_id=? AND deleted_at IS NULL AND kind IN ('project','project_page','shopping_list','task')
          ORDER BY updated_at DESC,record_id LIMIT 20`,
                )
                .all(scopeId) as { record_id: string }[]
            ).map((r) => r.record_id)
          : [];
        const service = new InboxFilingSuggestions(
          this.db,
          this.inbox,
          this.records,
          this.provider,
          consent,
          () =>
            this.contexts().some((c) => c.credentialId === context.credentialId) &&
            this.settings(context).revision === consent.revision &&
            installation(this.db).recovery_mode === 'normal',
        );
        try {
          await service.suggest(context, candidate.id, candidate.revision, destinationIds, this.now());
        } catch (error) {
          if (!(error instanceof Rejection)) throw error;
          // A bounded-input rejection must not starve later items or cause repeated automatic attempts.
          this.db
            .prepare(
              `INSERT OR IGNORE INTO inbox_filing_suggestions
            (inbox_id,source_revision,scope_id,state,attempted_at) VALUES (?,?,?,'failed',?)`,
            )
            .run(candidate.id, candidate.revision, scopeId, this.now());
        }
        return true;
      }
    }
    return false;
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
