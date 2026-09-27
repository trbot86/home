# Our place

A self-hosted household app for two people. Deployed features include a shared/private inbox, separate app suggestions, photos, durable offline capture, shopping and restock lists, tasks and recurring chores, maintenance assets and service logs, visual recipe collections, nested project boards, personal overviews, completion/purchase history, guarded undo/redo, storage reporting and online backup/restore. Agenda and Google Calendar settings are implemented; external calendars require host configuration and account consent. The Tailscale household is in real use; follow AGENTS.md to preserve its data during development.

The temporary Docker phone trial on this PC is live over private Tailscale HTTPS. It uses the mockup's dark green theme and a password-free profile picker: choose yourself once, then switch from the profile dropdown. Private items are hidden from the other profile; anyone with network access can deliberately select either profile. See [PHONE_TRIAL.md](PHONE_TRIAL.md) for the addresses and controls and [the access decision](decisions/0004-trusted-network-profiles.md) for the model.

## Try the local demo

Requires Node 24 and pnpm 11.19.0. From this directory:

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm demo
```

Open http://127.0.0.1:3173 and choose **t** or **b**. The demo remembers the selected profile, with a dropdown to switch. Its data lives under `.local/demo/`; subsequent runs preserve it. These are synthetic profiles for local review. The listener is loopback-only. **This is a separate database from the phone trial.** For shared PC/phone testing, use the private origin from ignored `.local/phone-trial/host.json` on every device.

Capture text, attach a photo, choose shared or private, and submit with the button or Ctrl+Enter. Existing entries can be edited, deleted, restored and inspected through History. Ctrl+Z undoes the latest reversible action in the current app session, including deletion; Ctrl+Shift+Z redoes it. Dismissing the confirmation does not lose this action. Text fields keep native text undo. Recently deleted remains available after a reload. App suggestions has its own count and drafts; move entries with Suggest / To inbox, without adding a text prefix. When disconnected, cached entries are read-only; a new capture stays editable until submitted, then remains unchanged while awaiting its receipt. Photos are limited to JPEG, PNG or WebP, 25 MB each, 20 per capture.

On Android, Back closes an open card and keeps unfinished editor text. Within a
project it moves up through the page hierarchy. From another app section it returns
to Inbox; at the root it retains normal Android behavior.
The software keyboard may consume the first Back to dismiss itself.

Use **File** on an inbox note to create a task, shopping item or project page,
or link to something already saved. Unfiled, Filed and All notes keep the original
capture searchable, with its photos and destination links. New items retain the
note's visibility. **Back to inbox** retains its links; **Unlink** keeps the
destination itself. Filing supports guarded undo, durable unfinished forms and
Ctrl+Enter. Offline drafts are editable; filing waits for connection. See
[inbox filing](INBOX_FILING_IMPLEMENTATION.md) for transaction and retention details.

Shopping supports named shared/private lists for groceries, household purchases,
wants and gifts. Add quantities and notes, move items between lists of the same
visibility, and check off purchases with who bought them and when. Save reusable
products on the Restock shelf: **Need this** avoids a duplicate on the same list
and creates a fresh entry after a purchase. History, guarded undo and recovery
share the inbox's existing durable request machinery. Cached lists are read-only
offline; use Inbox for disconnected capture. Lists start empty, with no demo items
inserted into the real household.

Tasks support shared/private Home and Work views, assignees, priorities and
separate deadline, flexible target and review dates. **Move a date** offers a
picker and +1 day/week/2 weeks/month without changing a real deadline. Record
who did the work and when, including work done earlier. Recurring tasks schedule
the next occurrence from actual completion, with calendar-month clamping; fixed
calendar schedules and notification delivery remain future work. History and
guarded undo cover the whole completion action. Cached tasks are read-only offline.

Add **Our place tasks** from the Android launcher's widget picker. It supports
Home/Work filtering, row limits and optional private tasks, with cached reading
and shortcuts to completion/date controls. Resize it to fit your home screen.
It hides task content when you switch profiles. The widget is available in the
private Android download; see [task widget implementation](TASK_WIDGET_IMPLEMENTATION.md).

From an asset in Home, **Browse maintenance ideas** offers optional starting points
with source guidance. Customize a task before saving; its dates and recurrence
start unset. Unfinished suggestion drafts remain separate from manually written
tasks and from other assets.

The Food section saves recipe links immediately and collects metadata
and a source picture in the background. It offers Want to try, Favourites, independent
Make soon pins, source editing, household adjustments, cooking notes/photos and
history. Multiple recipes on a page, or an edit during import, require review before
applying source details. Saved recipes remain readable offline; unfinished forms
stay on the device until submitted online. Linked cooking tasks use ordinary task
dates and recurrence, and record the meal when completed. Choose ingredients in a
checklist to create a named shopping group with a recipe link and retained source
text. Groups start collapsed; renaming, moving items and removing a group while
keeping its items support guarded undo. Quantities are never guessed or combined.
Food and shopping groups are deployed on the web and in the private Android download. See
[recipe implementation](RECIPE_IMPLEMENTATION.md) for verification and limits.

Projects offer shared/private boards, nested pages, photos, ordered text and web
links, and reference cards that open existing household records. Keep next-action
pins separate from reference material and reorder them without editing their
targets. Move pages, archive boards, inspect history, or restore selected deleted
pages with revision-checked undo. Unfinished editors survive closing and reopening;
cached pages and previously viewed images remain readable offline. See
[Projects implementation](PROJECTS_IMPLEMENTATION.md) for verification and limits.

To develop with live reload, bootstrap the default development data first with `pnpm --filter @our-place/server bootstrap` using JSON on stdin (format below), then `pnpm dev`. The web development server proxies `/api` to the local server. The prebuilt demo is the quickest first review.

## Layout and verification

This repository contains source and synthetic test fixtures. Live configuration,
household data, media, credentials, backups and private APKs stay in ignored local
storage. Enable the privacy hook once per checkout with
`git config core.hooksPath .githooks`. Run `pnpm check:public-source` before staging
and `node scripts/check-public-source.mjs --staged` before pushing. The checks
complement manual review; they do not prove the absence of every possible secret.

| Location                                                | Responsibility                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/contracts`                                    | Strict wire schemas and shared TypeScript/Kotlin fixtures                              |
| `packages/client`                                       | React-free client ports and presentation types                                         |
| `apps/server/src/features`                              | Access, inbox, history, immutable media, backup/restore                                |
| `apps/server/src/application`                           | Atomic command, history and idempotency receipt coordination                           |
| `apps/web/src/ui`                                       | Responsive components using only the client port                                       |
| `apps/web/src/platform`                                 | Browser persistence/networking and typed Android bridge                                |
| `apps/android/app/src/main/java/dev/ourplace/household` | Room queue, credentials, native HTTP/worker, camera, gallery, widget and voice capture |
| `ops`                                                   | Single-service Docker Compose configuration                                            |

```powershell
pnpm check
pnpm test:browser
pnpm android:assets
./scripts/android-build.ps1
node scripts/container-smoke.mjs
```

Browser tests need Playwright Chromium (`pnpm exec playwright install chromium`). The container test needs an image tagged `our-place:development`; it creates and removes uniquely named test containers/volumes and never selects existing services. Android needs JDK21, SDK36 and the checked-in Gradle wrapper; the PowerShell helper prefers project-local toolchains under `.tools`. Keep generated SDKs, caches and runtime data out of source control.

The debug APK is `apps/android/app/build/outputs/apk/debug/app-debug.apk`. It uses native Room rather than WebView storage for the capture queue. The Android build helper compiles the configured trial HTTPS origin as the editable first-use default; saved server addresses are preserved across APK updates. The emulator-only exception is `http://10.0.2.2:3173`. The private HTTPS endpoint and installer for physical phones are ready as described in PHONE_TRIAL.md. The widget opens native quick capture. Speech recognition availability, end-of-speech behavior, TTS and lock-screen/button entry need testing on the actual phones.

## Docker installation

The intended target is a separate Compose project on the Windows Docker host. Live data uses a dedicated external Linux volume; completed exports use a dedicated existing Windows folder. No Docker socket or media-library mount is needed. No installation on that host has been performed.

1. Build `docker build -t our-place:local .` and create `docker volume create our-place-data`.
2. Bootstrap once by passing JSON on stdin to `docker run --rm -i --mount type=volume,source=our-place-data,target=/data our-place:local node apps/server/dist/bootstrap.js`. The JSON contains exactly two people; the first is the administrator. Use real, distinct credentials, provided privately through stdin. Example structure:

   ```json
   {
     "people": [
       { "username": "first", "displayName": "First", "password": "replace-this-password" },
       { "username": "second", "displayName": "Second", "password": "replace-this-password-too" }
     ]
   }
   ```

3. Record the printed `EXPECTED_INSTALLATION_ID`. Configure it, `PUBLIC_ORIGIN` (the private HTTPS origin), and `BACKUP_OUTPUT_DIR` in an untracked environment file. `HOUSEHOLD_DATA_VOLUME` defaults to `our-place-data`; `BACKUP_HOUR` defaults to 6 in `TZ=America/Toronto`.
4. Create the dedicated empty backup folder on Windows. Initialise its ownership marker with `docker compose --env-file <your-env-file> -f ops/compose.yaml run --rm household node apps/server/dist/operations.js init-backups /backups`.
5. Start with `docker compose --env-file <your-env-file> -f ops/compose.yaml up -d`. Configure the host's private HTTPS reverse proxy/Tailscale route to its loopback port3173. Verify filesystem flushing, export/restore and access from both phones on the actual host before real use.

Startup rejects a missing household, a different installation identity, changed migrations or pending schema upgrades. One app process owns the database and maintenance worker. Protect backups separately using the host's backup software or the verified secondary-copy helper described in PHONE_TRIAL.md. The app reports local export availability and the secondary copier's last check; that report does not establish that a disconnected drive is reachable now.

## Backup, upgrade and recovery

Routine exports run online after the configured daily hour, or through the administrator's Storage & backups screen. SQLite's online backup makes the database snapshot; a collection hold protects immutable original photos until their matching copies are verified. An export is usable only when its `.tar.gz.complete.json` marker exists alongside its archive. Partial files are not restore points. Local retention keeps the latest export on each of seven distinct UTC dates, plus four older weekly representatives. Independent remote retention belongs to the host backup tool.

For a schema upgrade, stop this app, retain the previous image, select the new image, then run `node apps/server/dist/operations.js upgrade` using the same data and backup mounts. It verifies an export before applying migrations. Restart only after success. The trial helper `node scripts/dev-host.mjs upgrade` checks ownership and installation identity, stops this app, runs that operation, and restarts on success. Migration003 adds capture categories to the unchanged001/002 baseline; it does not reset or reseed data. Android Room migration1-to-2 preserves queued request bytes and hashes.

Restore is an offline administrative operation into a **new directory**, never over an existing installation:

```text
node apps/server/dist/operations.js restore /backups/backup-<id>.tar.gz.complete.json /data/restored
```

Mount an isolated empty test volume at `/data` for the first rehearsal. Verify the result, then deliberately configure the app to use the restored directory. The installation identity is preserved; the server epoch changes. A surviving operation receipt still resolves. Old requests absent from the backup require review before they can become fresh drafts; unsaved editor text retains its original epoch and cannot silently overwrite restored data. The recovery banner stays visible for this first slice; automatic recovery completion and a richer comparison screen are future work.

Windows direct development uses `--development` for operations because it cannot establish Linux directory-fsync semantics. Production never silently downgrades those checks. Copying exports to the configured the secondary disk drive and restoring from that copy have been verified; Windows VSS integration and host power-loss behavior have not been validated.

See [BUILD_PROGRESS.md](BUILD_PROGRESS.md) for measured results and limits, [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the bounded slice, and [PLANNING.md](PLANNING.md) for future household features.
