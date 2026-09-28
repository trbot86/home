import { categoryOf, filingOf, type Command, type FilingDestination } from '@our-place/contracts';
import type { Sqlite } from '../infrastructure/database.js';
import type { AccessService, HumanRequestContext } from '../features/access/access.js';
import { requireHuman } from '../features/access/access.js';
import { InboxRepository, contentOf } from '../features/inbox/inbox.js';
import { trackInbox } from '../features/inbox/inbox-record.js';
import { RecordLinkPolicy } from '../features/records/record-links.js';
import type { RecordRegistry } from '../features/records/record-registry.js';
import type { CommandHandler, RecordMutation } from '../features/records/command-handler.js';
import { NotFound, Rejection } from './errors.js';

type CreationKind = Exclude<FilingDestination['kind'], 'existing'> | 'CreateProject';
/** Compose existing synchronous feature commands under one history/receipt boundary. */
export class InboxFiling {
  private readonly links: RecordLinkPolicy;
  constructor(
    private readonly db: Sqlite,
    access: AccessService,
    private readonly inbox: InboxRepository,
    private readonly records: RecordRegistry,
    private readonly creators: Record<CreationKind, CommandHandler>,
  ) {
    this.links = new RecordLinkPolicy(db, access);
    for (const [kind, handler] of Object.entries(creators))
      if (!handler.kinds.includes(kind as CreationKind))
        throw new Error('Filing creator does not handle its command');
  }
  commands(): CommandHandler {
    return {
      kinds: ['FileInboxEntry', 'ReturnInboxEntry', 'RemoveInboxDestination'],
      execute: (context, kind, payload, now) => {
        requireHuman(context);
        if (!this.db.inTransaction) throw new Error('Filing requires a receipt transaction');
        const args = payload as Command<'FileInboxEntry'>['arguments'];
        const source = this.inbox.requireRevision(context, args.inboxId, args.expectedRevision);
        if (source.deletedAt !== null) throw new Rejection('deleted');
        if (categoryOf(source) !== 'inbox') throw new Rejection('only_inbox_entries_can_be_filed');
        const next = contentOf(source),
          filing = filingOf(source);
        let created: RecordMutation = { records: [], changes: [] };
        if (kind === 'FileInboxEntry') {
          const destination = args.destination;
          let id: string;
          if (destination.kind === 'existing') {
            id = destination.recordId;
            if (id === source.inboxId) throw new Rejection('cannot_file_into_itself');
            this.links.validate(context, source.scopeId, id);
          } else {
            if (filing.destinations.length >= 20) throw new Rejection('inbox_destination_limit');
            created = this.create(context, source.scopeId, destination, now);
            id = destination.arguments.recordId;
          }
          if (!filing.destinations.some((d) => d.recordId === id)) {
            if (filing.destinations.length >= 20) throw new Rejection('inbox_destination_limit');
            next.destinations = [...filing.destinations, { recordId: id, filedAt: now }];
          } else if (filing.filedAt !== null) return { records: [trackInbox(source)], changes: [] };
          next.filedAt = filing.filedAt ?? now;
        } else if (kind === 'ReturnInboxEntry') {
          if (filing.filedAt === null) return { records: [trackInbox(source)], changes: [] };
          next.filedAt = null;
        } else {
          const id = (payload as Command<'RemoveInboxDestination'>['arguments']).recordId;
          if (!filing.destinations.some((d) => d.recordId === id))
            return { records: [trackInbox(source)], changes: [] };
          next.destinations = filing.destinations.filter((d) => d.recordId !== id);
          if (!next.destinations.length) next.filedAt = null;
        }
        const after = trackInbox(this.inbox.setContent(context, source, next, now));
        return {
          records: [after, ...created.records],
          changes: [{ before: trackInbox(source), after }, ...created.changes],
        };
      },
    };
  }
  private create(
    context: HumanRequestContext,
    scopeId: string,
    destination: Exclude<FilingDestination, { kind: 'existing' }>,
    now: number,
  ) {
    const args = destination.arguments;
    let project: RecordMutation = { records: [], changes: [] };
    if (destination.kind === 'CreateProjectPage' && destination.newProject) {
      if (destination.newProject.scopeId !== scopeId) throw new Rejection('filing_requires_same_visibility');
      if (
        destination.newProject.recordId !== destination.arguments.projectId ||
        destination.arguments.parentPageId !== null
      )
        throw new Rejection('invalid_filing_project');
      project = this.creators.CreateProject.execute(context, 'CreateProject', destination.newProject, now);
      if (project.afterHistory) throw new Error('Filing creator requires unsupported post-history work');
    }
    let destinationScope: string;
    try {
      destinationScope =
        destination.kind === 'CreateTask'
          ? destination.arguments.scopeId
          : this.records.get(
              context,
              destination.kind === 'AddShoppingEntry'
                ? destination.arguments.listId
                : destination.arguments.projectId,
            ).content.scopeId;
    } catch (error) {
      if (error instanceof NotFound) throw new Rejection('unavailable');
      throw error;
    }
    // Creating from captured content must never silently broaden or change its audience.
    if (destinationScope !== scopeId) throw new Rejection('filing_requires_same_visibility');
    const mutation = this.creators[destination.kind].execute(context, destination.kind, args, now);
    if (mutation.afterHistory) throw new Error('Filing creator requires unsupported post-history work');
    const target = mutation.records.find((r) => r.recordId === args.recordId);
    if (!target || target.content.scopeId !== scopeId)
      throw new Error('Filing creator returned the wrong target');
    return {
      records: [...project.records, ...mutation.records],
      changes: [...project.changes, ...mutation.changes],
    };
  }
}
