# App version and update notice

Settings displays the web package version, or the installed Android version and
the first eight characters of its APK SHA-256 fingerprint. Android compares the
full installed fingerprint with the existing public `/install/build.json` metadata.
This detects published changes even while Android versionName remains unchanged.
It identifies a different published package, including an intentional rollback;
it does not claim semantic version ordering.

A different package produces a notice above Inbox. The link opens the existing
installation page in the system browser; installation remains a user action.
Checks run on opening, returning to the app, reconnecting, and every five minutes
while visible. Failed or malformed checks are shown as unavailable in Settings,
without blocking capture or claiming that the installed app is current.

The native check reads the APK and public metadata only. It sends no account
credentials, follows no redirects, limits the response to 4 KiB, and changes no
database, draft, frozen request, or installation identity. Install updates over
the existing app. Older apps need one manual update to gain this notice.

Focused validation: web version/comparison/render tests, client-download privacy
and cache checks, browser links/offline/editor-preservation tests, web typecheck
and bundle, package-boundary audit, and Android AppVersionTest, CaptureStoreTest,
and AttachmentDraftStoreTest. Full regression suites, distribution APK builds,
and physical-phone validation belong to the release coordinator. No deployment
is part of this change.
