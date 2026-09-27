# Capture integration identity proposal

2026-09-27. Design for review before implementation. The main app task reserved
migration `007_integration_principals.sql` and requested an explicit integration
principal. This document does not add a migration or activate any listener.
The initial operation is shared-inbox creation plus resolution of that client's
own receipts. Shopping, speaker personalization and spoken editing are deferred.

## Actor and credential storage

Add `integration_actors(integration_id, display_name, active)`. The Alexa binding
uses an actor labelled Alexa; it is not a row in `people` and has no username,
password, private scope, profile-selection entry or administrator permission.

Rebuild `clients` preserving its existing columns and values, with nullable
`person_id` and an added nullable `integration_id` foreign key. Extend `kind`
with `integration`. A CHECK requires either a browser/android client owned by
exactly one person, or an integration client owned by exactly one integration
actor. Actor ownership cannot be reassigned after client creation.

Rebuild `change_sets` and `operation_receipts` with nullable `actor_person_id`
and added nullable `actor_integration_id`; a CHECK requires exactly one actor.
Composite foreign keys from each `(client_id, actor_*_id)` pair to unique client
owner pairs enforce that the recorded actor owns the client. Keep original
changeset IDs, commit sequence values, reversal links, receipt keys, request
digests, outcome JSON bytes and timestamps. Preserve the AUTOINCREMENT high-water
mark, including when it exceeds the highest surviving sequence value.

Use the existing credential-verifier table and stable client ID for rotation,
with separate authentication methods for human and integration clients. The
ordinary app authentication path must reject integration credentials; the
capture listener must reject browser/android credentials. Both check expiry,
revocation, client enablement and actor activity. Provisioning is an explicit
administrative operation; the migration creates no live integration or secret.

The initial integration capability is fixed in code: create plain shared inbox
notes and resolve its own operations. Resolve the one shared scope server-side;
the caller cannot choose a person, scope, attachment, category, list or command.
There is no general permissions framework or arbitrary proxy configuration.

## Contexts and write boundary

Define a discriminated `RequestContext` union with human and integration variants.
Keep `personId` only on the human variant and `integrationId` only on the
integration variant. Human login/session/profile, shopping, task, media browsing,
history queries and undo/redo APIs accept the human subtype explicitly. The main
HTTP app's `authenticate` continues to return only the human subtype.

Limit the integration-capable path to inbox creation, shared-scope authorization,
history recording and receipt arbitration. Route an integration context through
a narrow creation branch before human-only handlers are considered. Check the
same capability again at the write boundary, so accidentally reaching a generic
command entry point cannot run edits, deletes, undo or shopping. Keep known
argument rejections inside existing durable receipt arbitration.

For human requests, `requestDigest` retains the exact canonical version-1 object
and `personId` encoding. Do not add a discriminator to that digest or reserialize
stored outcomes. Integration digests use a separately versioned actor encoding.
No human client wire command, pending Android request, credential or server epoch
changes solely because this migration ran.

The capture adapter deterministically derives the inbox record ID from the
authenticated client ID and incoming operation ID. Preserve text, capture time
and expected epoch; do not regenerate time or IDs on retry. It calls the same
write coordinator used by human commands, so an edited/deleted note cannot be
overwritten or resurrected by a late create retry. It never adopts a new epoch
automatically. Matching receipts resolve before the epoch guard as they do today.

## History and undo compatibility

Retain the existing human actor wire shape `{personId, displayName}`. Extend the
history actor type with `{kind: 'integration', integrationId, displayName}` and
no human ID. Current web history renderers use `actor.displayName`; verify all
web/native consumers before enabling the feature and update discriminant checks
where needed. A human history entry must continue to serialize as before.

Integration history entries are visible with their shared note and label Alexa.
Neither person acquires personal undo ownership of an Alexa changeset. They may
edit or delete the shared note normally as a new human action; their own action
then follows the existing personal undo rules. Integration credentials cannot
undo any action. Future recognized-speaker attribution is informational and must
not change this authority or ownership without a separate product decision.

## Separate capture listener

Construct an independent Fastify instance, disabled by default, with only:

- `POST /capture/inbox`: authenticate the integration and accept the bounded
  capture shape; require inbox destination and translate to `CreateInboxEntry`.
- `POST /capture/resolve`: authenticate and resolve an operation ID and expected
  epoch in that client's namespace; return receipt state without note content.

Do not register the normal application routes/plugins or generic proxy behavior.
Use bounded bodies, rate limits and transport deadlines. Never log tokens, raw
request bodies or note text. Deployment binds a separate explicit listener and
grants the cloud identity only that destination. A local injection test proves
route isolation, but only testing the deployed tailnet policy can prove that
the cloud identity cannot reach the trusted-network application ports.

## Migration and verification gates

The three referenced tables require a controlled rebuild. The runner must
disable foreign keys outside the rebuild transaction, create replacement tables,
copy exact existing values, replace tables, recreate indexes/triggers and run
`foreign_key_check` before committing. Roll back on violations and restore
foreign-key enforcement in a `finally` path. Preserve the original tables and
checksum record on any failure. Keep this exception explicitly restricted to
the reserved migration. Do not edit `sqlite_schema` or deployed migrations.
This follows SQLite's documented
[table rebuild procedure](https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes).

Continue to enter upgrades only through the backup-verifying upgrade command.
Startup must refuse a pending schema. The primary rehearsal creates an isolated
database at migrations 001–006 with both people, browser and Android clients,
active/revoked credentials, shared/private records, real synthetic media bytes,
history, undo/redo links, final receipts and an unsent frozen request. No copy of
the real household is required.

Implementation acceptance tests, not yet executed:

1. Compare all pre-existing columns/rows, receipt JSON/digests, identities and
   media hashes before/after migration. Foreign keys and integrity checks pass.
2. Replay an old receipt and submit the old frozen request after migration.
   Verify golden human digests from pre-upgrade code, login, both profiles,
   privacy, media access, history labels, and eligible personal undo/redo.
3. Reject invalid actor ownership in SQL and at the application boundary.
   Reject integration credentials on every normal app auth entrance and human
   credentials on the capture listener; verify revocation and rotation.
4. Capture once, drop the reply and retry the exact operation: one note and one
   changeset. Changed payload under that ID conflicts; retry after human edit or
   deletion returns the original receipt without changing current content.
5. Resolve only the caller's receipt. A restore epoch mismatch blocks new writes;
   a retained receipt still resolves. No automatic client or epoch replacement.
6. Reject private scope, media, arbitrary command, caller-selected actor and
   unsupported destination attempts. All non-capture listener routes return no
   household data. Integration bypass attempts against internal human-only
   methods fail through both typechecking and runtime authorization.
7. Force backup and rebuild failures. Check rollback, unchanged migration
   checksum/data, restored FK enforcement and no partially provisioned identity.
8. Restore a verified post-upgrade fixture backup into a new isolated directory
   and verify records/media, identity and explicit epoch reconciliation.

These tests and a source review are prerequisites to integration review. Live
migration, credentials, skill registration, cloud resources and tailnet changes
remain separate, reviewable activation steps requiring the user's authorization.
