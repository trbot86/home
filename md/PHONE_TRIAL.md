# Private Android development trial

The household is hosted behind a private HTTPS route. Its address, installation
identity, generated credentials and backup destinations live only in ignored
`.local/phone-trial/` metadata. Do not copy them into documentation or commits.

The live household contains real data. Follow AGENTS.md for all operations.
The loopback demo uses a separate database; devices must use the same configured
private origin to share household records.

## Deployment controls

Run `node scripts/dev-host.mjs status` locally to inspect the configured trial.
Use `upgrade` for a verified backup before migrations, then `publish-client`
to update the private installer. Never reset or recreate an existing household.
Use `node --import tsx scripts/replicate-backups.ts` for the independently
configured secondary copy. Detailed reports stay in ignored local storage.

The Android build helper reads the private origin from `host.json` and compiles
it into the local APK. Saved phone addresses remain unchanged. APKs, signing
keys, generated Android assets and build outputs are excluded from Git.
Install updates over the existing phone app; do not uninstall or clear data.

## Device checks

1. Select a profile and verify shared/private captures on both devices.
2. Disconnect, capture text/photos, restart, reconnect and verify one upload.
3. Check camera/gallery cancellation and unfinished editor recovery.
4. Try the capture widget, final speech result and spoken readback.
5. Check normal device locking and background restrictions without weakening security.
6. Check Shopping and Tasks, completion/undo and Android Back in dialogs.
7. Save a recipe link in Food, review imported details, and choose ingredients
   for a shopping group. Cached recipes and groups remain readable offline.

Emulator tests cannot establish manufacturer-specific microphone, lock-screen,
gesture or power-management behavior. See md/BUILD_PROGRESS.md for implementation
status; private release evidence remains local.
