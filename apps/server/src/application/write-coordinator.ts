import { createHash } from 'node:crypto';
import {
  argumentSchemas,
  invalidFields,
  isValid,
  type Command,
  type CommandKind,
  type CommandOutcome,
  type Envelope,
  type FinalOutcome,
} from '@our-place/contracts';
import { immediate, installation, type Sqlite } from '../infrastructure/database.js';
import { requireHuman, type HumanRequestContext, type RequestContext } from '../features/access/access.js';
import { requireIntegration } from '../features/access/integrations.js';
import { contentOf, InboxRepository } from '../features/inbox/inbox.js';
import { HistoryService } from '../features/history/history.js';
import { RecordRegistry } from '../features/records/record-registry.js';
import { trackInbox } from '../features/inbox/inbox-record.js';
import type { CommandHandler } from '../features/records/command-handler.js';
import { Deferral, ProtocolConflict, Rejection } from './errors.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
export function requestDigest(context: RequestContext, kind: string, command: Envelope): string {
  return createHash('sha256')
    .update(
      canonical({
        encodingVersion: context.kind === 'integration' ? 2 : 1,
        clientId: context.clientId,
        ...(context.kind === 'integration'
          ? { integrationId: context.integrationId }
          : { personId: context.personId }),
        kind,
        ...command,
      }),
    )
    .digest('hex');
}
export class WriteCoordinator {
  private readonly handlers = new Map<CommandKind, CommandHandler>();
  constructor(
    private readonly db: Sqlite,
    private readonly inbox: InboxRepository,
    private readonly history: HistoryService,
    private readonly now: () => number,
    private readonly records: RecordRegistry,
    private readonly beforeCommit?: () => void,
    handlers: readonly CommandHandler[] = [],
  ) {
    for (const handler of handlers)
      for (const kind of handler.kinds) {
        if (this.handlers.has(kind)) throw new Error('Duplicate command handler');
        this.handlers.set(kind, handler);
      }
  }
  resolve(
    context: RequestContext,
    operationId: string,
    epoch: string,
  ): CommandOutcome | { status: 'Unresolved' } {
    if (context.kind === 'integration') requireIntegration(this.db, context, this.now());
    else requireHuman(context);
    const receipt = this.db
      .prepare('SELECT outcome_json FROM operation_receipts WHERE client_id=? AND operation_id=?')
      .get(context.clientId, operationId) as { outcome_json: string } | undefined;
    if (receipt) return { ...(JSON.parse(receipt.outcome_json) as FinalOutcome), replayed: true };
    const state = installation(this.db);
    return state.recovery_epoch === epoch
      ? { status: 'Unresolved' }
      : {
          status: 'RecoveryRequired',
          currentServerEpoch: state.recovery_epoch,
          restorePoint: state.restored_from_at,
        };
  }
  abandonRestored(context: HumanRequestContext, kind: CommandKind, command: Envelope): CommandOutcome {
    requireHuman(context);
    const digest = requestDigest(context, kind, command);
    return immediate(this.db, () => {
      const existing = this.db
        .prepare(
          'SELECT request_digest,outcome_json FROM operation_receipts WHERE client_id=? AND operation_id=?',
        )
        .get(context.clientId, command.operationId) as
        { request_digest: string; outcome_json: string } | undefined;
      if (existing) {
        if (existing.request_digest !== digest)
          throw new ProtocolConflict('Operation ID already used with different arguments');
        return { ...(JSON.parse(existing.outcome_json) as FinalOutcome), replayed: true };
      }
      if (command.expectedServerEpoch === installation(this.db).recovery_epoch)
        throw new Rejection('ordinary_submission_cannot_be_abandoned');
      const now = this.now();
      const outcome: FinalOutcome = {
        status: 'Rejected',
        code: 'abandoned_after_restore',
        receipt: { operationId: command.operationId, requestDigest: digest, recordedAt: now },
      };
      this.db
        .prepare(
          'INSERT INTO operation_receipts(client_id,operation_id,request_digest,actor_person_id,outcome_json,recorded_at) VALUES (?,?,?,?,?,?)',
        )
        .run(context.clientId, command.operationId, digest, context.personId, JSON.stringify(outcome), now);
      return outcome;
    });
  }
  execute(context: RequestContext, kind: CommandKind, command: Envelope): CommandOutcome {
    if (context.kind === 'integration') {
      requireIntegration(this.db, context, this.now());
      if (kind !== 'CreateInboxEntry') throw new Rejection('capture_only');
    } else requireHuman(context);
    const digest = requestDigest(context, kind, command);
    return immediate(this.db, () => {
      const existing = this.db
        .prepare(
          'SELECT request_digest,outcome_json FROM operation_receipts WHERE client_id=? AND operation_id=?',
        )
        .get(context.clientId, command.operationId) as
        { request_digest: string; outcome_json: string } | undefined;
      if (existing) {
        if (existing.request_digest !== digest)
          throw new ProtocolConflict('Operation ID already used with different arguments');
        return { ...(JSON.parse(existing.outcome_json) as FinalOutcome), replayed: true };
      }
      const state = installation(this.db);
      if (state.recovery_epoch !== command.expectedServerEpoch)
        return {
          status: 'RecoveryRequired',
          currentServerEpoch: state.recovery_epoch,
          restorePoint: state.restored_from_at,
        };
      const now = this.now();
      const receipt = { operationId: command.operationId, requestDigest: digest, recordedAt: now };
      this.db.exec('SAVEPOINT content');
      let outcome: FinalOutcome;
      try {
        if (!isValid(argumentSchemas[kind], command.arguments))
          throw new Rejection('invalid_arguments', invalidFields(argumentSchemas[kind], command.arguments));
        const result = this.apply(context, kind, command, now);
        this.records.assertComplete();
        outcome = {
          status: 'Applied',
          receipt,
          ...(result.changeSetId ? { changeSetId: result.changeSetId } : {}),
          result: {
            records: result.records.map((record) => ({
              recordId: record.recordId,
              revision: record.revision,
            })),
          },
        };
      } catch (error) {
        if (!(error instanceof Rejection) && !(error instanceof Deferral)) throw error;
        if (!this.db.inTransaction) throw new Error('SQLite transaction aborted before outcome arbitration');
        this.db.exec('ROLLBACK TO content');
        if (error instanceof Deferral) {
          this.db.exec('RELEASE content');
          return { status: 'Deferred', code: error.code };
        }
        outcome = {
          status: 'Rejected',
          receipt,
          code: error.code,
          ...(error.fields ? { safeDetails: { fields: error.fields } } : {}),
        };
      }
      this.db.exec('RELEASE content');
      const actorColumn = context.kind === 'integration' ? 'actor_integration_id' : 'actor_person_id';
      this.db
        .prepare(
          `INSERT INTO operation_receipts(client_id,operation_id,request_digest,${actorColumn},outcome_json,recorded_at) VALUES (?,?,?,?,?,?)`,
        )
        .run(
          context.clientId,
          command.operationId,
          digest,
          context.kind === 'integration' ? context.integrationId : context.personId,
          JSON.stringify(outcome),
          now,
        );
      this.beforeCommit?.();
      return outcome;
    });
  }
  private apply(context: RequestContext, kind: CommandKind, command: Envelope, now: number) {
    if (kind === 'CreateInboxEntry') {
      const entry = this.inbox.create(context, (command as Command<'CreateInboxEntry'>).arguments, now);
      const after = trackInbox(entry);
      return {
        records: [after],
        changeSetId: this.history.record(context, kind, [{ before: null, after }], now),
      };
    }
    requireHuman(context);
    if (kind === 'SetRecordAttachments') {
      const args = (command as Command<'SetRecordAttachments'>).arguments;
      const before = this.records.requireRevision(context, args.recordId, args.expectedRevision);
      const after = this.records.setAttachments(context, before, args.attachments, now);
      return { records: [after], changeSetId: this.history.record(context, kind, [{ before, after }], now) };
    }
    const handler = this.handlers.get(kind);
    if (handler) {
      const result = handler.execute(context, kind, command.arguments, now);
      return {
        records: result.records,
        ...(result.changes.length
          ? { changeSetId: this.history.record(context, kind, result.changes, now) }
          : {}),
      };
    }
    if (kind === 'UndoChangeSet' || kind === 'RedoChangeSet')
      return this.history.reverse(
        context,
        (command as Command<'UndoChangeSet'>).arguments.changeSetId,
        kind === 'RedoChangeSet',
        now,
      );
    if (
      !['SetInboxEntryText', 'SetInboxEntryCategory', 'DeleteInboxEntry', 'RestoreInboxEntry'].includes(kind)
    )
      throw new Error(`No command handler registered for ${kind}`);
    const args = (command as Command<'SetInboxEntryText'>).arguments;
    const before = this.inbox.requireRevision(context, args.inboxId, args.expectedRevision);
    const next = contentOf(before);
    if (kind === 'SetInboxEntryText') {
      if (before.deletedAt !== null) throw new Rejection('deleted');
      next.text = args.text;
    }
    if (kind === 'SetInboxEntryCategory') {
      if (before.deletedAt !== null) throw new Rejection('deleted');
      next.category = (command as Command<'SetInboxEntryCategory'>).arguments.category;
    }
    if (kind === 'DeleteInboxEntry') {
      if (before.deletedAt !== null) throw new Rejection('already_deleted');
      next.deletedAt = now;
    }
    if (kind === 'RestoreInboxEntry') {
      if (before.deletedAt === null) throw new Rejection('not_deleted');
      next.deletedAt = null;
    }
    const entry = this.inbox.setContent(context, before, next, now);
    const after = trackInbox(entry);
    return {
      records: [after],
      changeSetId: this.history.record(context, kind, [{ before: trackInbox(before), after }], now),
    };
  }
}
