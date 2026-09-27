# Household app — restoring an older server safely

Date: 2026-09-26. Status: proposed recovery contract discovered while making the first slice deployable. It supplements [operation contracts](APPLICATION_CONTRACTS.md), [the database model](DATA_MODEL.md) and [file/backup storage](decisions/0003-file-media-and-container-storage.md). This is a small explicit recovery procedure, not replication or automatic recovery of unbacked-up data.

## 1. Why normal idempotency is insufficient after restore

Suppose Monday's backup contains no operation `O1`. On Tuesday, a phone creates inbox entry `I1` under `O1`; the server commits, but the reply is lost. Someone then edits or deletes `I1`. Wednesday the server disk fails and Monday's backup is restored.

The restored database has neither `O1`'s receipt nor Tuesday's later changes. An ordinary retry could therefore look new. A restored record can also have an old revision number that coincidentally matches a stale editor. Per-record revisions and retained receipts work during normal operation, but cannot describe data deliberately rolled back beyond the backup point.

The restore really loses changes not present in the backup. Neither this protocol nor phone caches magically recover the complete household history. The contract prevents silent replay and false continuity, and provides a deliberate path to recover useful pending content.

## 2. One installation ID and one recovery epoch

Maintain these singleton metadata values:

```text
installation_id       Stable identity of this household installation.
recovery_epoch        Opaque random ID changed by supported restore procedure.
restored_from_at      Optional backup/snapshot timestamp for explanation.
recovery_mode         Normal or awaiting operator/client reconciliation.
```

An ordinary process restart, credential rotation, container replacement or forward schema migration does not change the epoch. The supported restore command changes it **before** accepting writes from restored state. A filesystem copy rolled back manually without this step bypasses the contract; it is not an equivalent supported restore procedure.

The capability/current-data responses include installation ID and epoch. Clients retain them with their profile/cache, edit base and frozen requests. Content commands carry `expectedServerEpoch`; it is part of immutable request identity. Upload preparation also checks it before transferring a large old submission. A never-paired offline draft can remain local; it cannot freeze a household submission before the destination installation/scope is known.

An epoch is not a user-visible activity counter, time-travel version or network retry stage. It only distinguishes a server recovery discontinuity. Authentication, per-record revisions and permissions are still required.

## 3. Receipt and epoch check order

For a well-formed authenticated operation:

1. Verify installation/client context, then look up the operation's receipt.
2. If a matching final receipt exists, return it without re-executing the action. Its IDs/revisions describe that saved result; retrieve current authorised state separately.
3. If no receipt exists and the request epoch differs, return `RecoveryRequired`. Do not execute the mutation and do not claim it never committed before the restore.
4. Only a matching epoch with no prior receipt enters the ordinary validation/write path.

Receipt key remains `(client_id, operation_id)`; the epoch is a guard and a digested envelope field, not permission to reuse an operation ID. Never change the epoch field of a frozen request and resend it under its old key.

After a restore, a receipt present in the backup remains useful. It cannot prove that later edits/deletes missing from the backup never happened. The app must show the recovery notice and refresh from the restored current state, rather than represent this as seamless continuity.

## 4. Client reconciliation

On detecting a changed epoch, retain local drafts, in-flight requests, pending media and cached recovery material. Mark ordinary cached projections stale and refresh into a new cache generation; keep old copies that are needed for recovery separately from normal current views. Do not merge old cache rows into authoritative server state or silently overwrite a draft's base revision.

| Local material | Recovery behaviour |
| --- | --- |
| Mutable, never-submitted capture | Preserve it; select the restored destination and explicitly submit against the new epoch when ready. |
| Frozen capture with a surviving receipt | Resolve receipt, then fetch current record/tombstone. Do not recreate content from the frozen snapshot. |
| Frozen capture without a surviving receipt | Pause as `SUBMITTED` with a recovery reason. Show recoverable text/photo and allow deliberate reconciliation. |
| Existing-record edit buffer | Keep text, reload current record under new epoch, then explicitly save against its new base. No blind replay. |
| Previously acknowledged content absent from backup | Show the restore point; offer copying/export of any cached text/media still available. Do not promise every phone retained every accepted record. |
| Missing client credentials after restore | Re-authenticate/re-pair with the correct person before exposing private recovery content or accepting new commands. Never infer identity from a claimed client ID. |

For a paused uncertain capture, initial recovery can be manual and conservative. The user reviews the restored inbox and the preserved draft; the app can resolve a known matching result or explicitly abandon the old operation, then create a new draft with new IDs if the user wants it saved again.

`AbandonRestoredOperation` is a dedicated authenticated recovery action for an operation from an older epoch. In one transaction, it rechecks whether a final receipt now exists. If one exists, resolve it; otherwise record a durable terminal rejection for the old key/digest with reason `abandoned_after_restore`. This means it will not execute in the recovered installation, **not** that it could never have executed in the lost history. Only then enable a corrected/recovered new submission. Do not implement general cancellation of ordinary in-flight submissions under this name.

If client identity cannot be securely recovered, do not fabricate an old receipt namespace. Preserve/export local recovery data and require explicit import under the newly authenticated client after operator reconciliation. The old epoch remains barred from automatic mutation.

## 5. Operator procedure

1. Stop the old application and all of its workers; never run the old and restored installations concurrently as the same household authority.
2. Restore the database and media together into an isolated data directory (a new named volume on the Windows Docker target). Verify backup manifest/schema compatibility and referenced-file availability. Never extract over the live volume; see [Windows restore deployment](WINDOWS_DEPLOYMENT.md#5-startup-upgrades-and-restore).
3. Set a new recovery epoch and restore timestamp before serving commands. Pause external-effect jobs and automatic pending client submission during reconciliation.
4. Start the app, verify text/history/media, re-establish necessary identities, and display the restore notice. Clients reconcile as above.
5. Review/resume background work deliberately. A restored reminder/export job may have already acted outside the database since the snapshot; do not automatically repeat all external effects. Abandon copied in-progress backup jobs. For online exports that omit partial upload bytes, mark affected staging acquisitions incomplete/retryable before serving upload status; do not claim missing bytes are ready. Rebuild safe derived work against current references and recheck GC eligibility after verification. Ready originals required by the snapshot must already be verified present.

Routine backup may use the [online database-plus-media export](WINDOWS_DEPLOYMENT.md#3-backup-procedure); restoration remains an isolated maintenance procedure. A cold whole-volume copy is also supported as a fallback. Automatic merging of every client's cached changes, replaying a complete lost history, or guaranteed duplicate-free effects in external providers is outside this design.

## 6. Required first-slice checks

- Restore a backup predating a committed-but-unacknowledged capture; its old-epoch retry performs no mutation without reconciliation.
- Preserve a matching receipt in a backup; replay resolves it without a second record.
- Restore an older revision matching an open editor; the epoch guard still rejects its stale save.
- Reconcile/abandon an old operation while a retry arrives; the old key never becomes eligible for fresh execution.
- Container replacement without restore retains the epoch and ordinary pending work proceeds.
- Pending local media and private draft/profile boundaries survive the recovery workflow.

These are planned acceptance tests, not executed recovery evidence. The supplied Windows/Docker host, local NVMe and main-PC backup destination are reflected in [WINDOWS_DEPLOYMENT.md](WINDOWS_DEPLOYMENT.md). Cadence/retention have working defaults; confirm actual destination access and acceptable data-loss interval before real use.
