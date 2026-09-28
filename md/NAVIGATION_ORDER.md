# Personal navigation order

Settings → Reorder navigation provides touch and keyboard accessible up/down
controls for the main navigation sections, a save button and default order reset.
The same order applies to the desktop sidebar and narrow-screen navigation.
App suggestions remains in its existing separate location.

Orders belong to the signed-in profile's private scope and sync through the
existing view snapshot and receipt-backed command path. Local editor drafts
survive closing the dialog while offline. Saving requires a connection; stale
revisions cannot overwrite another device, and interrupted saves retain the
existing receipt reconciliation behavior.

Migration 028 adds a separate preference table without modifying household
records, identity, media, history, saved views or pending requests. Release must
use the existing backup-verified upgrade command. Android uses the existing JSON
view cache and generic command bridge; no Room schema change is needed.

Focused verification:
- Web and server TypeScript checks.
- Server views.test.ts and integration-upgrade.test.ts (11 passing tests),
  covering private access, validation, stale writes, replay, transaction rollback,
  unchanged content and backup/upgrade/restore preservation.
- Browser navigation-order.spec.ts (2 passing tests), covering cross-device order,
  profile switching, reload, mobile controls, offline draft reopening, default
  reset and stale-draft recovery.
- Web Vite build for the browser fixture; package-boundary and public-source checks.

Full regression suites, Android/device verification and distribution builds are
left to combined-batch release checks. This source change is not a deployment.
