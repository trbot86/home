import { randomUUID } from 'node:crypto';
import {
  emptySuggestions,
  isValid,
  suggestionCommands,
  suggestionContentSchemas,
  type Attachment,
  type Command,
  type SuggestionKind,
  type SuggestionMessage,
  type SuggestionRecord,
  type SuggestionSnapshot,
  type SuggestionWorkflow,
  type SuggestionActivity,
} from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { NotFound, Rejection } from '../../application/errors.js';
import { AccessService, requireHuman, type HumanRequestContext } from '../access/access.js';
import { AttachmentRepository } from '../media/attachments.js';
import { requireSuggestionRun } from './agent-access.js';
import { suggestionReleases, requireNoRelease } from './releases.js';
import type { WorkerContext } from '../access/workers.js';
import type { CommandHandler, RecordMutation } from '../records/command-handler.js';
import type {
  RecordAdapter,
  RecordChange,
  RecordContent,
  TrackedRecord,
} from '../records/record-registry.js';

type Header = {
  record_id: string;
  kind: SuggestionKind;
  scope_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};
const tables = {
  suggestion_workflow: ['suggestion_workflows', 'workflow_id'],
  suggestion_message: ['suggestion_messages', 'message_id'],
} as const;

export class SuggestionsRepository {
  private readonly attachments: AttachmentRepository;
  readonly available: boolean;
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
  ) {
    this.attachments = new AttachmentRepository(db, access);
    this.available = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='suggestion_workflows'").get();
  }
  adapters(): RecordAdapter[] {
    if (!this.available) return [];
    return (Object.keys(tables) as SuggestionKind[]).map((kind) => ({
      kind,
      supportsAttachments: kind === 'suggestion_message',
      payloadTable: tables[kind][0],
      payloadId: tables[kind][1],
      get: (context, id) => this.get(context, id),
      project: (record) => this.project(record),
      validateContent: (value) => this.content(kind, value),
      setContent: (context, before, value, now) => this.setContent(context, before, value, now),
    }));
  }
  commands(): CommandHandler {
    return {
      kinds: Object.keys(suggestionCommands) as (keyof typeof suggestionCommands)[],
      execute: (context, kind, payload, now) =>
        this.execute(context, kind as keyof typeof suggestionCommands, payload, now),
    };
  }
  private content(kind: SuggestionKind, value: unknown): RecordContent {
    if (!isValid(suggestionContentSchemas[kind], value)) throw new Error('Invalid suggestion content');
    return value as RecordContent;
  }
  private requireSuggestion(context: HumanRequestContext, id: string, writable = false) {
    requireHuman(context);
    const row = this.db
      .prepare(
        'SELECT r.*,i.category FROM records r JOIN inbox_entries i ON i.inbox_id=r.record_id WHERE r.record_id=?',
      )
      .get(id) as (Header & { category: string }) | undefined;
    if (!row || !this.access.canAccess(context, row.scope_id)) throw new NotFound();
    if (writable && (row.deleted_at !== null || row.category !== 'app_suggestion'))
      throw new Rejection('suggestion_not_active');
    return row;
  }
  get(context: HumanRequestContext, id: string): TrackedRecord {
    requireHuman(context);
    const header = this.db.prepare('SELECT * FROM records WHERE record_id=?').get(id) as Header | undefined;
    if (!header || !Object.hasOwn(tables, header.kind) || !this.access.canAccess(context, header.scope_id))
      throw new NotFound();
    const record = this.read(header);
    this.requireSuggestion(context, String(record.content.suggestionId));
    return record;
  }
  getForRun(context: WorkerContext, id: string, now: number): TrackedRecord {
    const grant = requireSuggestionRun(this.db, context, now);
    const header = this.db.prepare('SELECT * FROM records WHERE record_id=?').get(id) as Header | undefined;
    if (!header || !Object.hasOwn(tables, header.kind) || header.scope_id !== grant.scope_id)
      throw new NotFound();
    const record = this.read(header);
    if (record.content.suggestionId !== grant.suggestion_id) throw new NotFound();
    return record;
  }
  private read(header: Header): TrackedRecord {
    const id = header.record_id;
    const [table, key] = tables[header.kind];
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(id) as Record<string, unknown>;
    const fields =
      header.kind === 'suggestion_workflow'
        ? { summary: row.summary, status: row.status, completedAt: row.completed_at ?? null }
        : {
            text: row.text,
            messageType: row.message_type,
            authorKind: row.author_person_id ? 'person' : 'agent',
            authorId: row.author_person_id ?? row.author_agent_id,
            authorName: row.author_name,
            runId: row.run_id,
            replyToQuestionId: row.reply_to_question_id,
            choices: JSON.parse(String(row.choices_json)),
            attachments: this.attachments.list(id),
          };
    return {
      recordId: id,
      kind: header.kind,
      revision: header.revision,
      createdAt: header.created_at,
      updatedAt: header.updated_at,
      content: this.content(header.kind, {
        scopeId: header.scope_id,
        deletedAt: header.deleted_at,
        suggestionId: row.suggestion_id,
        ...fields,
      }),
    };
  }
  project(record: TrackedRecord): SuggestionRecord {
    const { recordId, kind, revision, createdAt, updatedAt, content } = record;
    return {
      recordId,
      kind,
      revision,
      createdAt,
      updatedAt,
      ...content,
      ...(kind === 'suggestion_message'
        ? {
            sequence: (
              this.db
                .prepare('SELECT sequence FROM suggestion_messages WHERE message_id=?')
                .get(recordId) as { sequence: number }
            ).sequence,
          }
        : {}),
    } as SuggestionRecord;
  }
  snapshot(context: HumanRequestContext): SuggestionSnapshot {
    requireHuman(context);
    const snapshot = emptySuggestions();
    if (!this.available) return snapshot;
    const workflows = this.db
      .prepare(
        `SELECT w.workflow_id FROM suggestion_workflows w JOIN visibility_scopes s USING(scope_id)
      WHERE s.kind='shared' OR s.owner_person_id=? ORDER BY w.workflow_id LIMIT 2001`,
      )
      .all(context.personId) as { workflow_id: string }[];
    if (workflows.length > 2000) throw new Rejection('suggestion_cache_capacity_exceeded');
    for (const row of workflows) {
      const workflow = this.project(this.get(context, row.workflow_id)) as SuggestionWorkflow;
      snapshot.workflows.push(workflow);
      snapshot.messages.push(...this.messages(context, workflow.suggestionId));
      const questions = this.db
        .prepare(
          `SELECT m.message_id AS questionId,m.text,m.choices_json,
        CASE WHEN EXISTS (SELECT 1 FROM suggestion_question_resolutions q JOIN records r ON r.record_id=q.message_id WHERE q.question_id=m.message_id AND r.deleted_at IS NULL) THEN 'resolved'
        WHEN EXISTS (SELECT 1 FROM suggestion_messages a JOIN records r ON r.record_id=a.message_id WHERE a.reply_to_question_id=m.message_id AND r.deleted_at IS NULL) THEN 'answered' ELSE 'unanswered' END AS state
        FROM suggestion_messages m JOIN records r ON r.record_id=m.message_id WHERE m.suggestion_id=? AND m.message_type='question' AND r.deleted_at IS NULL ORDER BY m.sequence`,
        )
        .all(workflow.suggestionId) as {
        questionId: string;
        text: string;
        choices_json: string;
        state: 'unanswered' | 'answered' | 'resolved';
      }[];
      snapshot.questions.push(
        ...questions.map(({ choices_json, ...q }) => ({
          ...q,
          suggestionId: workflow.suggestionId,
          choices: JSON.parse(choices_json) as string[],
        })),
      );
      snapshot.work.push(
        ...(this.db
          .prepare(
            `SELECT q.request_id AS requestId,q.suggestion_id AS suggestionId,q.requested_at AS requestedAt,
        CASE WHEN q.state='running' AND r.lease_until<=? THEN 'uncertain' ELSE q.state END AS state,q.run_id AS runId,r.issue
        FROM suggestion_work_requests q LEFT JOIN suggestion_runs r USING(run_id) WHERE q.suggestion_id=? ORDER BY q.requested_at DESC,q.rowid DESC LIMIT 30`,
          )
          .all(Date.now(), workflow.suggestionId) as SuggestionSnapshot['work']),
      );
      snapshot.activity!.push(this.activity(context, workflow.suggestionId));
      snapshot.releases!.push(...suggestionReleases(this.db, workflow.suggestionId));
    }
    snapshot.bridgeSeenAt = (
      this.db
        .prepare(
          `SELECT max(a.last_seen_at) AS seen FROM suggestion_agents a JOIN worker_actors w ON w.worker_id=a.agent_id
      JOIN clients c ON c.client_id=a.client_id WHERE a.enabled=1 AND a.accepting_work=1 AND w.active=1 AND c.enabled=1`,
        )
        .get() as { seen: number | null }
    ).seen;
    return snapshot;
  }
  private activity(context: HumanRequestContext, suggestionId: string): SuggestionActivity {
    const workflow = this.db
      .prepare(
        `SELECT r.revision,w.summary FROM suggestion_workflows w JOIN records r ON r.record_id=w.workflow_id WHERE w.suggestion_id=?`,
      )
      .get(suggestionId) as { revision: number; summary: string } | undefined;
    if (!workflow) throw new Rejection('discussion_unavailable');
    const messages = this.db
      .prepare(
        `SELECT coalesce(max(m.sequence),0) AS latest,
      coalesce(max(CASE WHEN m.author_agent_id IS NOT NULL OR m.author_person_id<>? THEN m.sequence END),0) AS others
      FROM suggestion_messages m JOIN records r ON r.record_id=m.message_id WHERE m.suggestion_id=? AND r.deleted_at IS NULL`,
      )
      .get(context.personId, suggestionId) as { latest: number; others: number };
    const run = this.db
      .prepare(
        `SELECT run_id,state,lease_until FROM suggestion_runs WHERE suggestion_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
      )
      .get(suggestionId) as { run_id: string; state: string; lease_until: number } | undefined;
    const state =
      run && ['claimed', 'starting', 'running'].includes(run.state) && run.lease_until <= Date.now()
        ? 'uncertain'
        : run?.state;
    const release = suggestionReleases(this.db, suggestionId)[0];
    const workToken =
      (run ? run.run_id + ':' + state : '') + (release ? `:${release.releaseId}:${release.revision}` : '');
    const seen = this.db
      .prepare(
        'SELECT workflow_revision,message_sequence,work_token FROM suggestion_read_positions WHERE suggestion_id=? AND person_id=?',
      )
      .get(suggestionId, context.personId) as
      { workflow_revision: number; message_sequence: number; work_token: string } | undefined;
    return {
      suggestionId,
      workflowRevision: workflow.revision,
      messageSequence: messages.latest,
      workToken,
      unread:
        (!!workflow.summary && workflow.revision > (seen?.workflow_revision ?? 0)) ||
        messages.others > (seen?.message_sequence ?? 0) ||
        ((!!release || (!!run && ['failed', 'uncertain'].includes(state!))) &&
          workToken !== seen?.work_token),
    };
  }
  messages(
    context: HumanRequestContext,
    suggestionId: string,
    beforeSequence?: number,
    limit = 100,
  ): SuggestionMessage[] {
    this.requireSuggestion(context, suggestionId);
    const ids = this.db
      .prepare(
        `SELECT message_id FROM suggestion_messages WHERE suggestion_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?`,
      )
      .all(suggestionId, beforeSequence ?? Number.MAX_SAFE_INTEGER, Math.min(100, Math.max(1, limit))) as {
      message_id: string;
    }[];
    return ids.reverse().map((row) => this.project(this.get(context, row.message_id)) as SuggestionMessage);
  }
  private create(
    context: HumanRequestContext,
    kind: SuggestionKind,
    id: string,
    value: RecordContent,
    now: number,
  ): TrackedRecord {
    const c = this.content(kind, value);
    this.access.requireScope(context, c.scopeId);
    if (this.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(id))
      throw new Rejection('id_unavailable');
    this.db.prepare('INSERT INTO records VALUES (?,?,?,1,?,?,NULL)').run(id, kind, c.scopeId, now, now);
    if (kind === 'suggestion_workflow')
      this.db
        .prepare(
          'INSERT INTO suggestion_workflows(workflow_id,suggestion_id,scope_id,summary,status,completed_at) VALUES (?,?,?,?,?,?)',
        )
        .run(id, c.suggestionId, c.scopeId, c.summary, c.status, c.completedAt ?? null);
    else {
      this.db
        .prepare(
          `INSERT INTO suggestion_messages(message_id,suggestion_id,scope_id,text,message_type,author_person_id,author_name,reply_to_question_id,choices_json)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          c.suggestionId,
          c.scopeId,
          c.text,
          c.messageType,
          context.personId,
          c.authorName,
          c.replyToQuestionId,
          JSON.stringify(c.choices),
        );
      this.attachments.replace(context, id, c.scopeId, c.attachments as Attachment[], now, {
        creating: true,
        live: true,
      });
    }
    return this.get(context, id);
  }
  private setContent(
    context: HumanRequestContext,
    before: TrackedRecord,
    value: RecordContent,
    now: number,
  ): TrackedRecord {
    requireHuman(context);
    const c = this.content(before.kind as SuggestionKind, value);
    if (c.scopeId !== before.content.scopeId || c.suggestionId !== before.content.suggestionId)
      throw new Rejection('scope_change_not_supported');
    if (before.kind === 'suggestion_message') {
      if (before.content.authorKind !== 'person' || before.content.authorId !== context.personId)
        throw new Rejection('message_not_owned');
      if (
        this.db.prepare('SELECT 1 FROM suggestion_run_inputs WHERE message_id=? LIMIT 1').get(before.recordId)
      )
        throw new Rejection('message_already_supplied_add_a_correction');
      if (
        this.db
          .prepare("SELECT 1 FROM suggestion_work_requests WHERE request_id=? AND state<>'cancelled'")
          .get(before.recordId)
      )
        throw new Rejection('cancel_work_before_retracting');
      const { deletedAt: _oldDeleted, attachments: _oldPhotos, ...old } = before.content;
      const { deletedAt: _newDeleted, attachments: _newPhotos, ...next } = c;
      if (JSON.stringify(old) !== JSON.stringify(next))
        throw new Rejection('messages_are_immutable_add_a_correction');
      this.attachments.replace(context, before.recordId, c.scopeId, c.attachments as Attachment[], now, {
        live: c.deletedAt === null,
      });
    } else {
      if (c.completedAt != null) this.requireIdle(String(c.suggestionId));
      if (
        c.deletedAt !== null &&
        this.db
          .prepare(
            `SELECT 1 FROM suggestion_messages m JOIN records r ON r.record_id=m.message_id
        WHERE m.suggestion_id=? AND r.deleted_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM record_changes wc JOIN record_changes mc ON mc.change_set_id=wc.change_set_id
          WHERE wc.record_id=? AND wc.before_revision=0 AND mc.record_id=m.message_id AND mc.before_revision=0
        ) LIMIT 1`,
          )
          .get(c.suggestionId, before.recordId)
      )
        throw new Rejection('discussion_has_later_messages');
      if (
        this.db
          .prepare(
            "SELECT 1 FROM suggestion_work_requests WHERE suggestion_id=? AND state<>'cancelled' LIMIT 1",
          )
          .get(c.suggestionId)
      )
        throw new Rejection('work_history_cannot_be_reversed');
      this.db
        .prepare('UPDATE suggestion_workflows SET summary=?,status=?,completed_at=? WHERE workflow_id=?')
        .run(c.summary, c.status, c.completedAt ?? null, before.recordId);
    }
    this.db
      .prepare('UPDATE records SET revision=revision+1,updated_at=?,deleted_at=? WHERE record_id=?')
      .run(now, c.deletedAt, before.recordId);
    return this.get(context, before.recordId);
  }
  private requireIdle(suggestionId: string) {
    requireNoRelease(this.db, suggestionId);
    if (
      this.db
        .prepare(
          "SELECT 1 FROM suggestion_work_requests WHERE suggestion_id=? AND state IN ('queued','running','uncertain') LIMIT 1",
        )
        .get(suggestionId)
    )
      throw new Rejection('suggestion_work_in_progress');
  }
  private setCompletion(
    context: HumanRequestContext,
    before: TrackedRecord,
    completedAt: number | null,
    now: number,
  ): TrackedRecord {
    this.db
      .prepare('UPDATE suggestion_workflows SET completed_at=? WHERE workflow_id=?')
      .run(completedAt, before.recordId);
    this.db
      .prepare('UPDATE records SET revision=revision+1,updated_at=?,deleted_at=NULL WHERE record_id=?')
      .run(now, before.recordId);
    return this.get(context, before.recordId);
  }
  private execute(
    context: HumanRequestContext,
    kind: keyof typeof suggestionCommands,
    payload: unknown,
    now: number,
  ): RecordMutation {
    requireHuman(context);
    if (kind === 'SetSuggestionCompleted') {
      const args = payload as Command<'SetSuggestionCompleted'>['arguments'];
      const suggestion = this.requireSuggestion(context, args.suggestionId, true);
      const existing = this.db
        .prepare('SELECT workflow_id FROM suggestion_workflows WHERE suggestion_id=?')
        .get(args.suggestionId) as { workflow_id: string } | undefined;
      const before = existing ? this.get(context, existing.workflow_id) : null;
      if ((before?.revision ?? 0) !== args.expectedRevision) throw new Rejection('suggestion_changed');
      if (args.completed) this.requireIdle(args.suggestionId);
      if ((before?.content.deletedAt == null && before?.content.completedAt != null) === args.completed)
        return { records: [], changes: [] };
      const after = before
        ? this.setCompletion(context, before, args.completed ? now : null, now)
        : this.create(
            context,
            'suggestion_workflow',
            randomUUID(),
            {
              scopeId: suggestion.scope_id,
              deletedAt: null,
              suggestionId: args.suggestionId,
              summary: '',
              status: 'new',
              completedAt: now,
            },
            now,
          );
      return { records: [after], changes: [{ before, after }] };
    }
    if (kind === 'MarkSuggestionRead') {
      const args = payload as Command<'MarkSuggestionRead'>['arguments'];
      this.requireSuggestion(context, args.suggestionId);
      const current = this.activity(context, args.suggestionId);
      if (args.workflowRevision > current.workflowRevision || args.messageSequence > current.messageSequence)
        throw new Rejection('unseen_update');
      this.db
        .prepare(
          `INSERT INTO suggestion_read_positions VALUES (?,?,?,?,?,?)
        ON CONFLICT(suggestion_id,person_id) DO UPDATE SET
        workflow_revision=max(workflow_revision,excluded.workflow_revision),
        message_sequence=max(message_sequence,excluded.message_sequence),
        work_token=CASE WHEN ? THEN excluded.work_token ELSE work_token END,updated_at=excluded.updated_at`,
        )
        .run(
          args.suggestionId,
          context.personId,
          args.workflowRevision,
          args.messageSequence,
          args.workToken === current.workToken ? args.workToken : '',
          now,
          args.workToken === current.workToken ? 1 : 0,
        );
      return { records: [], changes: [] };
    }
    if (kind === 'DismissSuggestionQuestion') {
      const args = payload as Command<'DismissSuggestionQuestion'>['arguments'];
      const suggestion = this.requireSuggestion(context, args.suggestionId, true);
      const question = this.db
        .prepare(
          `SELECT 1 FROM suggestion_messages m JOIN records r ON r.record_id=m.message_id
        WHERE m.message_id=? AND m.suggestion_id=? AND m.message_type='question' AND r.deleted_at IS NULL`,
        )
        .get(args.questionId, args.suggestionId);
      if (!question) throw new Rejection('question_unavailable');
      if (
        this.db
          .prepare(
            `SELECT 1 FROM suggestion_question_resolutions q JOIN records r ON r.record_id=q.message_id
        WHERE q.question_id=? AND r.deleted_at IS NULL`,
          )
          .get(args.questionId)
      )
        return { records: [], changes: [] };
      const person = this.db
        .prepare('SELECT display_name FROM people WHERE person_id=?')
        .get(context.personId) as { display_name: string };
      const message = this.create(
        context,
        'suggestion_message',
        args.recordId,
        {
          scopeId: suggestion.scope_id,
          deletedAt: null,
          suggestionId: args.suggestionId,
          text: 'Marked this question as no longer relevant.',
          messageType: 'resolution',
          authorKind: 'person',
          authorId: context.personId,
          authorName: person.display_name,
          runId: null,
          replyToQuestionId: args.questionId,
          choices: [],
          attachments: [],
        },
        now,
      );
      this.db
        .prepare('INSERT INTO suggestion_question_resolutions VALUES (?,?,?,?)')
        .run(args.questionId, args.recordId, args.suggestionId, suggestion.scope_id);
      return { records: [message], changes: [{ before: null, after: message }] };
    }
    if (kind === 'CancelSuggestionWork') {
      const { requestId } = payload as Command<'CancelSuggestionWork'>['arguments'];
      const row = this.db
        .prepare('SELECT suggestion_id,state FROM suggestion_work_requests WHERE request_id=?')
        .get(requestId) as { suggestion_id: string; state: string } | undefined;
      if (!row) throw new Rejection('unavailable');
      this.requireSuggestion(context, row.suggestion_id);
      if (row.state !== 'queued' && row.state !== 'cancelled') throw new Rejection('work_has_started');
      this.db
        .prepare("UPDATE suggestion_work_requests SET state='cancelled' WHERE request_id=?")
        .run(requestId);
      return { records: [], changes: [] };
    }
    const args = payload as Command<'PostSuggestionMessage'>['arguments'];
    const suggestion = this.requireSuggestion(context, args.suggestionId, true),
      requestWork = kind === 'RequestSuggestionWork' || args.requestWork,
      changes: RecordChange[] = [];
    if (requestWork) requireNoRelease(this.db, args.suggestionId);
    if (kind === 'PostSuggestionMessage' && args.scopeId !== suggestion.scope_id)
      throw new Rejection('scope_mismatch');
    if (kind === 'PostSuggestionMessage' && !args.text.trim() && !args.attachments.length)
      throw new Rejection('empty_message');
    const existing = this.db
      .prepare('SELECT workflow_id FROM suggestion_workflows WHERE suggestion_id=?')
      .get(args.suggestionId) as { workflow_id: string } | undefined;
    if (!existing) {
      const workflow = this.create(
        context,
        'suggestion_workflow',
        randomUUID(),
        {
          scopeId: suggestion.scope_id,
          deletedAt: null,
          suggestionId: args.suggestionId,
          summary: '',
          status: 'new',
        },
        now,
      );
      changes.push({ before: null, after: workflow });
    } else {
      const before = this.get(context, existing.workflow_id);
      if (before.content.deletedAt !== null)
        changes.push({
          before,
          after: this.setContent(
            context,
            before,
            { ...before.content, deletedAt: null, completedAt: null },
            now,
          ),
        });
      else if (requestWork && before.content.completedAt != null)
        changes.push({ before, after: this.setCompletion(context, before, null, now) });
    }
    if (kind === 'PostSuggestionMessage' && args.replyToQuestionId) {
      const question = this.db
        .prepare(
          `SELECT 1 FROM suggestion_messages m JOIN records r ON r.record_id=m.message_id
        WHERE m.message_id=? AND m.suggestion_id=? AND m.message_type='question' AND r.deleted_at IS NULL`,
        )
        .get(args.replyToQuestionId, args.suggestionId);
      if (!question) throw new Rejection('question_unavailable');
    }
    const person = this.db
      .prepare('SELECT display_name FROM people WHERE person_id=?')
      .get(context.personId) as { display_name: string };
    const message = this.create(
      context,
      'suggestion_message',
      args.recordId,
      {
        scopeId: suggestion.scope_id,
        deletedAt: null,
        suggestionId: args.suggestionId,
        text: kind === 'RequestSuggestionWork' ? '' : args.text,
        messageType: kind === 'RequestSuggestionWork' ? 'request' : 'note',
        authorKind: 'person',
        authorId: context.personId,
        authorName: person.display_name,
        runId: null,
        replyToQuestionId: kind === 'RequestSuggestionWork' ? null : args.replyToQuestionId,
        choices: [],
        attachments: kind === 'RequestSuggestionWork' ? [] : args.attachments,
      },
      now,
    );
    changes.push({ before: null, after: message });
    return {
      records: changes.map((c) => c.after),
      changes,
      ...(requestWork
        ? {
            afterHistory: (cause: string) => {
              this.db
                .prepare(
                  'INSERT INTO suggestion_work_requests(request_id,suggestion_id,scope_id,requested_by,requested_at,cause_change_set_id) VALUES (?,?,?,?,?,?)',
                )
                .run(args.recordId, args.suggestionId, suggestion.scope_id, context.personId, now, cause);
              return undefined;
            },
          }
        : {}),
    };
  }
}
