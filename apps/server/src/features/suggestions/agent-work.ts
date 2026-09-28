import { createHash, randomUUID } from 'node:crypto';
import type {
  SuggestionAgentReport,
  SuggestionAgentTransition,
  SuggestionMessage,
  SuggestionRun,
  SuggestionRunContext,
} from '@our-place/contracts';
import { immediate, installation, type Sqlite } from '../../infrastructure/database.js';
import { ProtocolConflict, Rejection } from '../../application/errors.js';
import { requireSuggestionAgent, requireSuggestionRun, type SuggestionAgent } from './agent-access.js';
import type { WorkerContext } from '../access/workers.js';
import type { SuggestionsRepository } from './suggestions.js';
import type { HistoryService } from '../history/history.js';
import type { RecordChange } from '../records/record-registry.js';
import { AttachmentRepository } from '../media/attachments.js';
import type { AccessService } from '../access/access.js';

const leaseDuration = 120_000;
type RunRow = {
  run_id: string;
  suggestion_id: string;
  scope_id: string;
  lease_token: string;
  lease_until: number;
  state: string;
  session_id: string | null;
  turn_id: string | null;
  context_json: string;
  server_epoch: string;
};
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
export class SuggestionAgentWork {
  private readonly attachments: AttachmentRepository;
  constructor(
    private readonly db: Sqlite,
    private readonly repository: SuggestionsRepository,
    private readonly history: HistoryService,
    access: AccessService,
    private readonly now: () => number,
  ) {
    this.attachments = new AttachmentRepository(db, access);
  }
  private worker(agent: SuggestionAgent, runId: string, leaseToken: string): WorkerContext {
    return { kind: 'worker', workerId: agent.agentId, clientId: agent.clientId, jobId: runId, leaseToken };
  }
  media(agent: SuggestionAgent, runId: string, leaseToken: string, epoch: string, mediaId: string) {
    if (epoch !== installation(this.db).recovery_epoch) throw new Rejection('recovery_required');
    const grant = requireSuggestionRun(this.db, this.worker(agent, runId, leaseToken), this.now());
    const context = this.project(this.row(agent, runId)).context;
    const permitted = [
      ...context.original.attachments,
      ...context.messages.flatMap((m) => m.attachments),
      ...(
        this.db.prepare('SELECT message_json FROM suggestion_steering WHERE run_id=?').all(runId) as {
          message_json: string;
        }[]
      ).flatMap((r) => (JSON.parse(r.message_json) as SuggestionMessage).attachments),
    ].find((a) => a.mediaId === mediaId);
    if (!permitted) throw new Rejection('media_not_supplied');
    const media = this.db
      .prepare(
        "SELECT storage_key,mime_type,digest FROM media_objects WHERE media_id=? AND scope_id=? AND state='ready'",
      )
      .get(mediaId, grant.scope_id) as { storage_key: string; mime_type: string; digest: string } | undefined;
    if (!media || media.digest !== permitted.digest) throw new Rejection('media_unavailable');
    return media;
  }
  private receipt<T>(
    agent: SuggestionAgent,
    kind: string,
    operationId: string,
    epoch: string,
    payload: unknown,
    work: () => T,
  ): T {
    return immediate(this.db, () => {
      requireSuggestionAgent(this.db, agent);
      // A restored server cannot authorize an old process even when its old receipt survived.
      if (epoch !== installation(this.db).recovery_epoch) throw new Rejection('recovery_required');
      const digest = createHash('sha256').update(canonical({ kind, epoch, payload })).digest('hex');
      const old = this.db
        .prepare(
          'SELECT request_digest,result_json FROM suggestion_agent_receipts WHERE agent_id=? AND operation_id=?',
        )
        .get(agent.agentId, operationId) as { request_digest: string; result_json: string } | undefined;
      if (old) {
        if (old.request_digest !== digest) throw new ProtocolConflict('Agent operation ID reused');
        return JSON.parse(old.result_json) as T;
      }
      const result = work();
      this.db
        .prepare('INSERT INTO suggestion_agent_receipts VALUES (?,?,?,?,?)')
        .run(agent.agentId, operationId, digest, JSON.stringify(result), this.now());
      return result;
    });
  }
  private project(r: RunRow): SuggestionRun {
    return {
      runId: r.run_id,
      suggestionId: r.suggestion_id,
      leaseToken: r.lease_token,
      leaseUntil: r.lease_until,
      state: r.state,
      sessionId: r.session_id,
      turnId: r.turn_id,
      context: JSON.parse(r.context_json) as SuggestionRunContext,
    };
  }
  private row(agent: SuggestionAgent, id: string): RunRow {
    const row = this.db
      .prepare('SELECT * FROM suggestion_runs WHERE run_id=? AND agent_id=?')
      .get(id, agent.agentId) as RunRow | undefined;
    if (!row) throw new Rejection('run_unavailable');
    return row;
  }
  status(
    agent: SuggestionAgent,
    epoch: string,
    acceptingWork = false,
  ): { runs: SuggestionRun[]; queued: boolean } {
    return immediate(this.db, () => {
      requireSuggestionAgent(this.db, agent);
      if (epoch !== installation(this.db).recovery_epoch) throw new Rejection('recovery_required');
      const now = this.now();
      this.db
        .prepare('UPDATE suggestion_agents SET last_seen_at=?,accepting_work=? WHERE agent_id=?')
        .run(now, acceptingWork ? 1 : 0, agent.agentId);
      // Expiry never frees the active-run slot or launches a replacement.
      this.db
        .prepare(
          "UPDATE suggestion_runs SET state='uncertain',issue='Connection to the development host was lost',updated_at=? WHERE agent_id=? AND state IN ('claimed','starting','running') AND lease_until<=?",
        )
        .run(now, agent.agentId, now);
      this.db
        .prepare(
          "UPDATE suggestion_work_requests SET state='uncertain' WHERE run_id IN (SELECT run_id FROM suggestion_runs WHERE agent_id=? AND state='uncertain')",
        )
        .run(agent.agentId);
      const rows = this.db
        .prepare(
          "SELECT r.* FROM suggestion_runs r JOIN records p ON p.record_id=r.suggestion_id JOIN inbox_entries i ON i.inbox_id=r.suggestion_id WHERE r.agent_id=? AND r.server_epoch=? AND r.state IN ('claimed','starting','running','uncertain') AND p.deleted_at IS NULL AND i.category='app_suggestion' ORDER BY r.created_at",
        )
        .all(agent.agentId, epoch) as RunRow[];
      const queued = !!this.db
        .prepare(
          `SELECT 1 FROM suggestion_work_requests q JOIN records p ON p.record_id=q.suggestion_id
        JOIN inbox_entries i ON i.inbox_id=q.suggestion_id JOIN suggestion_workflows w USING(suggestion_id) JOIN records wr ON wr.record_id=w.workflow_id
        WHERE q.state='queued' AND p.deleted_at IS NULL AND wr.deleted_at IS NULL AND i.category='app_suggestion'
        AND NOT EXISTS (SELECT 1 FROM suggestion_runs r WHERE r.suggestion_id=q.suggestion_id AND r.state IN ('claimed','starting','running','uncertain')) LIMIT 1`,
        )
        .get();
      return { runs: rows.map((r) => this.project(r)), queued };
    });
  }
  claim(agent: SuggestionAgent, operationId: string, epoch: string): { run: SuggestionRun | null } {
    return this.receipt(agent, 'claim', operationId, epoch, {}, () => {
      const now = this.now();
      this.db.prepare('UPDATE suggestion_agents SET last_seen_at=? WHERE agent_id=?').run(now, agent.agentId);
      const next = this.db
        .prepare(
          `SELECT q.* FROM suggestion_work_requests q JOIN records p ON p.record_id=q.suggestion_id
        JOIN inbox_entries i ON i.inbox_id=q.suggestion_id JOIN suggestion_workflows w USING(suggestion_id)
        JOIN records wr ON wr.record_id=w.workflow_id WHERE q.state='queued' AND p.deleted_at IS NULL AND wr.deleted_at IS NULL
        AND i.category='app_suggestion' AND NOT EXISTS (SELECT 1 FROM suggestion_runs r WHERE r.suggestion_id=q.suggestion_id AND r.state IN ('claimed','starting','running','uncertain'))
        ORDER BY q.requested_at,q.request_id LIMIT 1`,
        )
        .get() as { suggestion_id: string; scope_id: string; cause_change_set_id: string } | undefined;
      if (!next) return { run: null };
      const runId = randomUUID(),
        leaseToken = randomUUID();
      this.db
        .prepare(
          `INSERT INTO suggestion_runs(run_id,suggestion_id,scope_id,agent_id,server_epoch,lease_token,lease_until,state,context_json,created_at,updated_at,cause_change_set_id)
        VALUES (?,?,?,?,?,?,?,'claimed','{}',?,?,?)`,
        )
        .run(
          runId,
          next.suggestion_id,
          next.scope_id,
          agent.agentId,
          epoch,
          leaseToken,
          now + leaseDuration,
          now,
          now,
          next.cause_change_set_id,
        );
      const worker = this.worker(agent, runId, leaseToken);
      const ids = this.db
        .prepare(
          'SELECT m.message_id,r.revision FROM suggestion_messages m JOIN records r ON r.record_id=m.message_id WHERE m.suggestion_id=? AND r.deleted_at IS NULL ORDER BY m.sequence LIMIT 2001',
        )
        .all(next.suggestion_id) as { message_id: string; revision: number }[];
      if (ids.length > 2000) throw new Rejection('discussion_requires_context_review');
      const messages = ids.map(
        (id) =>
          this.repository.project(this.repository.getForRun(worker, id.message_id, now)) as SuggestionMessage,
      );
      const original = this.db
        .prepare(
          'SELECT i.text,r.revision FROM inbox_entries i JOIN records r ON r.record_id=i.inbox_id WHERE i.inbox_id=?',
        )
        .get(next.suggestion_id) as { text: string; revision: number };
      const workflow = this.db
        .prepare('SELECT summary FROM suggestion_workflows WHERE suggestion_id=?')
        .get(next.suggestion_id) as { summary: string };
      const questions = messages
        .filter((m) => m.messageType === 'question')
        .map((m) => ({
          questionId: m.recordId,
          suggestionId: next.suggestion_id,
          text: m.text,
          choices: m.choices,
          state: this.db
            .prepare('SELECT 1 FROM suggestion_question_resolutions WHERE question_id=? LIMIT 1')
            .get(m.recordId)
            ? ('resolved' as const)
            : messages.some((a) => a.replyToQuestionId === m.recordId)
              ? ('answered' as const)
              : ('unanswered' as const),
        }));
      const context: SuggestionRunContext = {
        original: {
          suggestionId: next.suggestion_id,
          ...original,
          attachments: this.attachments.list(next.suggestion_id),
        },
        summary: workflow.summary,
        messages,
        questions,
      };
      for (const id of ids)
        this.db
          .prepare('INSERT INTO suggestion_run_inputs VALUES (?,?,?,?,?)')
          .run(runId, id.message_id, id.revision, next.suggestion_id, next.scope_id);
      this.db
        .prepare('UPDATE suggestion_runs SET context_json=? WHERE run_id=?')
        .run(JSON.stringify(context), runId);
      this.db
        .prepare(
          "UPDATE suggestion_work_requests SET state='running',run_id=? WHERE suggestion_id=? AND state='queued'",
        )
        .run(runId, next.suggestion_id);
      return { run: this.project(this.row(agent, runId)) };
    });
  }
  heartbeat(agent: SuggestionAgent, runId: string, leaseToken: string, epoch: string) {
    return immediate(this.db, () => {
      if (epoch !== installation(this.db).recovery_epoch) throw new Rejection('recovery_required');
      requireSuggestionRun(this.db, this.worker(agent, runId, leaseToken), this.now());
      this.db
        .prepare('UPDATE suggestion_runs SET lease_until=?,updated_at=? WHERE run_id=?')
        .run(this.now() + leaseDuration, this.now(), runId);
      this.db
        .prepare('UPDATE suggestion_agents SET last_seen_at=? WHERE agent_id=?')
        .run(this.now(), agent.agentId);
      return { leaseUntil: this.now() + leaseDuration };
    });
  }
  steering(
    agent: SuggestionAgent,
    runId: string,
    leaseToken: string,
    epoch: string,
    updates: { messageId: string; state: 'accepted' | 'uncertain' | 'missed' }[] = [],
    finish = false,
  ) {
    return immediate(this.db, () => this.steeringLocked(agent, runId, leaseToken, epoch, updates, finish));
  }
  private steeringLocked(
    agent: SuggestionAgent,
    runId: string,
    leaseToken: string,
    epoch: string,
    updates: { messageId: string; state: 'accepted' | 'uncertain' | 'missed' }[],
    finish: boolean,
  ) {
    if (epoch !== installation(this.db).recovery_epoch) throw new Rejection('recovery_required');
    const worker = this.worker(agent, runId, leaseToken),
      now = this.now();
    const grant = requireSuggestionRun(this.db, worker, now);
    // The initial snapshot is immutable. Only ordinary comments after its boundary
    // steer this turn; explicitly requested follow-ups retain their next-round semantics.
    const context = this.project(this.row(agent, runId)).context;
    this.db
      .prepare('UPDATE suggestion_runs SET context_json=? WHERE run_id=?')
      .run(JSON.stringify({ ...context, liveSteering: true }), runId);
    const initial = context.messages;
    const boundary = Math.max(0, ...initial.map((m) => m.sequence));
    const fresh = this.db
      .prepare(
        `SELECT m.message_id FROM suggestion_messages m JOIN records r ON r.record_id=m.message_id
        WHERE m.suggestion_id=? AND m.sequence>? AND m.author_person_id IS NOT NULL AND m.message_type='note'
        AND r.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM suggestion_work_requests q WHERE q.request_id=m.message_id)
        AND NOT EXISTS(SELECT 1 FROM suggestion_steering s WHERE s.run_id=? AND s.message_id=m.message_id)
        ORDER BY m.sequence`,
      )
      .all(grant.suggestion_id, boundary, runId) as { message_id: string }[];
    for (const row of fresh) {
      const message = this.repository.project(
        this.repository.getForRun(worker, row.message_id, now),
      ) as SuggestionMessage;
      this.db
        .prepare('INSERT INTO suggestion_steering VALUES (?,?,?,?,?,?)')
        .run(runId, message.recordId, message.revision, JSON.stringify(message), 'pending', now);
      // Pin the exact version once supplied to the host. Delivery is tracked separately.
      this.db
        .prepare('INSERT OR IGNORE INTO suggestion_run_inputs VALUES (?,?,?,?,?)')
        .run(runId, message.recordId, message.revision, grant.suggestion_id, grant.scope_id);
    }
    for (const update of updates) {
      const old = this.db
        .prepare('SELECT state FROM suggestion_steering WHERE run_id=? AND message_id=?')
        .get(runId, update.messageId) as { state: string } | undefined;
      if (!old) throw new Rejection('steering_message_not_supplied');
      if (old.state !== 'pending' && old.state !== update.state)
        throw new Rejection('steering_delivery_already_recorded');
      if (old.state === update.state) continue;
      this.db
        .prepare('UPDATE suggestion_steering SET state=?,updated_at=? WHERE run_id=? AND message_id=?')
        .run(update.state, now, runId, update.messageId);
    }
    if (finish)
      this.db
        .prepare(
          "UPDATE suggestion_steering SET state='missed',updated_at=? WHERE run_id=? AND state='pending'",
        )
        .run(now, runId);
    return {
      messages: (
        this.db
          .prepare(
            "SELECT message_json FROM suggestion_steering WHERE run_id=? AND state='pending' ORDER BY rowid",
          )
          .all(runId) as { message_json: string }[]
      ).map((r) => JSON.parse(r.message_json) as SuggestionMessage),
    };
  }
  transition(agent: SuggestionAgent, args: SuggestionAgentTransition): { run: SuggestionRun } {
    return this.receipt(agent, 'transition', args.operationId, args.expectedServerEpoch, args, () => {
      const now = this.now(),
        row = this.row(agent, args.runId);
      if (row.lease_token !== args.leaseToken || row.server_epoch !== args.expectedServerEpoch)
        throw new Rejection('run_unavailable');
      const reconciling = args.state === 'reconcile';
      if (reconciling) {
        // Only the owning bridge may reconcile; it must retain the exact acknowledged session.
        if (
          !['claimed', 'starting', 'running', 'uncertain'].includes(row.state) ||
          row.session_id !== args.sessionId ||
          row.turn_id !== args.turnId
        )
          throw new Rejection('reconciliation_identity_mismatch');
        this.db
          .prepare("UPDATE suggestion_runs SET state='claimed',lease_until=? WHERE run_id=?")
          .run(now + leaseDuration, args.runId);
      }
      requireSuggestionRun(this.db, this.worker(agent, args.runId, args.leaseToken), now);
      if (!reconciling && row.session_id && args.sessionId !== row.session_id)
        throw new Rejection('session_identity_changed');
      const token = reconciling ? randomUUID() : args.leaseToken,
        state = reconciling ? 'claimed' : args.state;
      this.db
        .prepare(
          'UPDATE suggestion_runs SET state=?,session_id=?,turn_id=?,issue=?,lease_token=?,lease_until=?,updated_at=? WHERE run_id=?',
        )
        .run(state, args.sessionId, args.turnId, args.issue, token, now + leaseDuration, now, args.runId);
      this.db
        .prepare('UPDATE suggestion_work_requests SET state=? WHERE run_id=?')
        .run(['uncertain', 'failed'].includes(state) ? state : 'running', args.runId);
      return { run: this.project(this.row(agent, args.runId)) };
    });
  }
  report(agent: SuggestionAgent, leaseToken: string, report: SuggestionAgentReport): { changeSetId: string } {
    return this.receipt(agent, 'report', report.reportId, report.expectedServerEpoch, report, () => {
      const now = this.now(),
        worker = this.worker(agent, report.runId, leaseToken),
        grant = requireSuggestionRun(this.db, worker, now);
      const workflow = this.db
        .prepare('SELECT workflow_id FROM suggestion_workflows WHERE suggestion_id=?')
        .get(grant.suggestion_id) as { workflow_id: string };
      const before = this.repository.getForRun(worker, workflow.workflow_id, now),
        changes: RecordChange[] = [];
      if (
        report.status !== 'working' &&
        (JSON.parse(this.row(agent, report.runId).context_json) as { liveSteering?: boolean }).liveSteering
      )
        this.steeringLocked(agent, report.runId, leaseToken, report.expectedServerEpoch, [], true);
      const undelivered =
        report.status !== 'working' &&
        this.db
          .prepare("SELECT 1 FROM suggestion_steering WHERE run_id=? AND state<>'accepted' LIMIT 1")
          .get(report.runId);
      const status = undelivered ? 'needs_input' : report.status;
      const summary = undelivered
        ? report.summary.slice(0, 19000) +
          '\nSome discussion comments were not confirmed as delivered to this run. Review them and request another round before release.'
        : report.summary;
      this.db
        .prepare('UPDATE suggestion_workflows SET summary=?,status=? WHERE workflow_id=?')
        .run(summary, status, workflow.workflow_id);
      this.db
        .prepare('UPDATE records SET revision=revision+1,updated_at=? WHERE record_id=?')
        .run(now, workflow.workflow_id);
      changes.push({ before, after: this.repository.getForRun(worker, workflow.workflow_id, now) });
      const reports = [
        ...report.messages,
        ...(report.resolvedQuestionIds.length
          ? [
              {
                messageId: randomUUID(),
                text: 'The recorded answers have been incorporated.',
                kind: 'resolution',
                choices: [],
              },
            ]
          : []),
      ];
      for (const m of reports) {
        this.db
          .prepare("INSERT INTO records VALUES (?,'suggestion_message',?,1,?,?,NULL)")
          .run(m.messageId, grant.scope_id, now, now);
        this.db
          .prepare(
            `INSERT INTO suggestion_messages(message_id,suggestion_id,scope_id,text,message_type,author_agent_id,author_name,run_id,choices_json) VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            m.messageId,
            grant.suggestion_id,
            grant.scope_id,
            m.text,
            m.kind,
            agent.agentId,
            agent.name,
            report.runId,
            JSON.stringify(m.choices),
          );
        changes.push({ before: null, after: this.repository.getForRun(worker, m.messageId, now) });
      }
      for (const id of report.resolvedQuestionIds) {
        if (
          !this.db
            .prepare(
              `SELECT 1 FROM suggestion_run_inputs x JOIN suggestion_messages m ON m.message_id=x.message_id WHERE x.run_id=? AND m.message_id=? AND m.message_type='question'`,
            )
            .get(report.runId, id)
        )
          throw new Rejection('question_not_supplied');
        this.db
          .prepare('INSERT INTO suggestion_question_resolutions VALUES (?,?,?,?)')
          .run(id, reports.at(-1)!.messageId, grant.suggestion_id, grant.scope_id);
      }
      const changeSetId = this.history.recordSuggestionWorker(worker, changes, now);
      if (report.status !== 'working') {
        this.db
          .prepare('UPDATE suggestion_runs SET state=?,updated_at=? WHERE run_id=?')
          .run(status, now, report.runId);
        this.db
          .prepare('UPDATE suggestion_work_requests SET state=? WHERE run_id=?')
          .run(status, report.runId);
      }
      return { changeSetId };
    });
  }
}
