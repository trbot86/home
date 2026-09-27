import type { CommandKind } from '@our-place/contracts';
import type { RequestContext } from '../access/access.js';
import type { RecordChange, TrackedRecord } from './record-registry.js';
export type RecordMutation = { records: TrackedRecord[]; changes: RecordChange[] };
/** A statically registered feature handler; the coordinator owns transaction and receipt boundaries. */
export interface CommandHandler {
  kinds: readonly CommandKind[];
  execute(context: RequestContext, kind: CommandKind, payload: unknown, now: number): RecordMutation;
}
