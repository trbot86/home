# Pre-integration compatibility fixture

`pre-integration.json` was generated from the unchanged schema-006 server at
commit `45a11ea`, before integration implementation began. All content, people,
IDs, credentials and media bytes are synthetic. No live database was opened.

The five stored commands were executed through that version's WriteCoordinator;
their outcomes and digests are its actual output. The pending command's digest
was computed using its original `requestDigest` without submitting it. The table
snapshot follows those writes, and the changeset sequence was raised to 5000 to
test preservation of an AUTOINCREMENT high-water mark above current row IDs.

Use these fixed values as the compatibility oracle. Do not regenerate them from
the updated implementation. To reproduce, use a separate checkout at the producer
revision, migrations 001-006, the listed synthetic identities and media bytes,
execute the listed commands in order, and calculate the pending request digest.
Changeset UUIDs are random; substitute the recorded IDs for subsequent reversal
commands when comparing digests and receipt content.
