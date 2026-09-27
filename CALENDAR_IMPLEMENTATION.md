# Calendar integration

Projects and optional maintenance ideas are deployed. Calendar integration follows
the ownership and privacy boundaries in DATA_MODEL.md, section 12. The user is
building a read-only agenda first; household event editing remains a separate
decision. No Google account, OAuth
client, token or live calendar connection has been configured.

## Implemented foundation (not deployed)

The development branch contains a provider-neutral event contract, a bounded
Google reader, transactional calendar ownership/cache storage and an asynchronous
synchronizer. Migration 017 adds connection, source and event-cache tables without
changing household records, receipts or history. The live app still runs migrations
001–016. Calendar settings and browser consent are now wired in the development
branch, including a cached agenda; no live account is connected and no agenda has
been released.

`CalendarSynchronizer` resolves an opaque credential reference through the
`CalendarCredentials` port and performs network work outside SQLite transactions.
The authorization service described below implements that credential resolver;
runtime configuration and OAuth routes are described below. Each result rechecks the
connection generation, source selection revision and operation generation before
publication. A disconnect, reselection, newer refresh or discovery therefore
invalidates older in-flight work. Source deletion cascades to its cached events.

Discovery returns owner-only source metadata. Sources start unselected; the owner
must explicitly choose a scope. Work calendars require a private scope. Sharing a
selected calendar omits Google events marked private or confidential from the other
profile's projection, including their counts. Source identifiers and credential
references are absent from the shared calendar metadata. Revoked authentication
suppresses all snapshots from that connection. Lost source access clears its cache;
transient failures retain the last complete snapshot and record a safe error code.

The Google adapter fetches expanded instances for one complete window, up to
366 days, before publishing anything. Limits are 80 pages, 4 MiB per page, 16 MiB
per fetch and 10,000 events. Stored event payloads are limited to 16 MiB per person,
with at most 12 selected calendars and eight active connections. Exceeding a limit
fails the refresh rather than presenting a partial agenda. Google quota responses
remain retryable; provider response bodies, tokens and arbitrary error messages
are not persisted.

All-day dates retain their exclusive civil end date. Timed events retain explicit
instants and the display timezone; moved recurring instances retain their original
identity. HTML descriptions become plain text, attendee lists are omitted and only
validated Google HTTPS event links remain. Ambiguous or nonexistent local times
without an explicit offset fail normalization. Cancellation disappears on complete
snapshot replacement.

Eighteen focused tests cover these boundaries, full pagination, streamed limits,
quota/authentication failures, DST, cancellation, moved instances, atomic rollback,
privacy, ownership and asynchronous disconnect races. An isolated upgrade test
preserves every pre-calendar table and installation identity. No test accesses a
real Google account or writes to the live household.

## Authorization service (not deployed)

Migration 018 adds encrypted credential storage, expiring authorization attempts
and stable Google account bindings. `CalendarAuthorizationService` begins a
ten-minute, single-use PKCE exchange tied to the initiating person, client,
session credential and recovery epoch. It rechecks that live authority after the
network response and commits the connection, encrypted grant and completion result
together. Retrying a completed request returns its existing connection; an uncertain
or interrupted exchange requires a fresh consent attempt. Starting a replacement
attempt invalidates the old one, including an exchange still in flight.

`GoogleCalendarAuthorization` uses pinned `google-auth-library` 11.1.0 for code
exchange and refresh. It requests the two calendar read scopes plus `openid`,
checks the returned token's audience and grants, and obtains the stable subject
from Google's authenticated user-info endpoint. Email addresses and unverified ID
tokens are not account identifiers. SDK diagnostics are replaced with bounded
application error codes. Automatic exchange retries and HTTP redirects are disabled.
See [Google's OAuth library](https://github.com/googleapis/google-auth-library-nodejs)
and [Google's OpenID Connect account guidance](https://developers.google.com/identity/openid-connect/openid-connect).

Reconnect preserves calendar selections only for that same subject and connection
generation; it clears old snapshots and invalidates in-flight refreshes. Account
switches require a separate connection with fresh selection. Concurrent refreshes
in the server process share one request, preserve an omitted refresh token, and
save provider-issued rotation before returning the new access token. Disconnect
removes the stored credential transactionally. A late refresh cannot recreate it.
This is local disconnection; Google-side grant revocation is not wired yet.

`CalendarSecretBox` uses AES-256-GCM with a fresh nonce and authenticates each value's
purpose, reference, installation and recovery epoch. A host-supplied key ring allows
new writes to use a new key while retaining old keys for existing ciphertext.
Missing keys and authentication failures never generate replacement keys. Keys and
OAuth client configuration remain outside the database, public source and client
payloads. The optional runtime configuration loader is described below.

The database backup includes token ciphertext, but excludes encryption keys and
plaintext external credentials. Restoring a backup discards pending consent and
stored grants, marks connections as needing reconnection, and keeps selections and
household records. This prevents a restored database from silently resuming old
Google authorization. An ordinary process restart retains working grants.

Fourteen additional isolated tests cover the real SDK with simulated HTTP responses,
exact callback/PKCE parameters, minimal consent, audience/grant checks, account
matching, token rotation, retry behavior, expired/replaced/revoked sessions, guarded
commit and disconnect races, key rotation/tampering, populated-schema migration and
backup/restore. No real account has been connected.

## Browser settings and Android handoff (not deployed)

Settings now includes profile-owned Google connections, discovery, explicit
Home/Work/private/shared selection, reconnection and confirmed disconnection.
Selection and disconnection use the existing command receipts. Connection metadata
stays owner-only; calendar provider IDs and credentials do not reach these screens.
Sources start unselected, and availability-only sources cannot expose event details.
The former Storage & backups navigation entry is named Settings and retains all
existing storage, backup and app-update controls. Failed settings loads offer a retry.

Migration 019 adds expiring browser handoffs associated with the original consent
attempt. Begin sets a short-lived HttpOnly, SameSite=Lax browser-binding cookie.
The callback requires both the state and that cookie, captures the code as encrypted
data and redirects without provider secrets. It performs no token exchange. The
user then finishes from the original authenticated browser profile, client and
session. Switching profiles, replacing consent, expiry or restore cannot transfer
the grant to another identity. Restores cascade deletion of these handoffs. Callback
logging is disabled, and request logging elsewhere strips query strings. Callback
failure pages use the same dark theme and never echo provider errors.

Android opens the household website's calendar settings in its external browser.
The user selects their profile there; native credentials are never passed through a
URL or browser session. Setup and consent belong to that browser session. Returning
to Android keeps its unfinished work intact. The dedicated test emulator verified
the actual external-browser launch, settings profile selection and Back navigation;
its system browser is a WebView test shell, so this does not verify Google's real
consent restrictions or a physical phone's browser behavior.

Five HTTP tests cover ownership, receipt replay, origin checks, cookie binding,
callback replay and expiry, encrypted handoff, profile changes and configuration
failure. Three browser flows cover simulated cross-site consent, selection, drafts,
disconnection, responsive layouts, profile isolation, retry and offline behavior.
Installing the candidate APK over the prior emulator installation preserved its
session, cached records, photos and unfinished editors before disposable flow tests.

## Host configuration

Without `CALENDAR_CONFIG_FILE`, the server starts normally and settings explains
that account setup is pending. When set, it names a host-managed JSON file containing
`clientId`, `clientSecret`, `activeKeyId` and a `keys` object. Each named key is exactly
32 random bytes in canonical base64url encoding; the active ID must name one of the
supplied keys. Existing key IDs must retain their original values during rotation.
The file must be a regular non-symlink file at most 64 KiB. Invalid configuration
stops startup with a generic error that excludes its values and path.

Keep this file in ignored local configuration outside the household data and backup
trees. For Docker, mount only this configuration file read-only and set
`CALENDAR_CONFIG_FILE` to its container path. The loader derives the exact callback
as `/oauth/calendar/callback` under `PUBLIC_ORIGIN`; register that exact private URL
in the Google OAuth client. Never put the real callback, client credentials or keys
in public source, APKs or documentation. No such live file or credentials have been
created. Google account configuration and actual consent remain interactive steps.

## Agenda and scheduled refresh (not deployed)

The Agenda screen combines calendar events with today's assigned or unassigned
tasks that need attention. It has Home/Work/combined filtering, a date picker and
seven- or thirty-day views. Task cards retain deadline/target/review semantics and
open the existing task flow for editing, postponement or completion. Calendar events
remain read-only, retain provider status and link back to Google for editing.
All-day dates stay civil dates; exclusive ends, midnight boundaries, zero-duration
events, DST transitions and events spanning several days are handled explicitly.
Timed events are displayed in the household timezone.

The scheduler runs one bounded fetch at a time. Successful calendars become due
after ten minutes and discovery after a day; failed operations retry after thirty
minutes. Persisted attempt times survive process restarts. New selections become
eligible immediately, and graceful shutdown cancels and awaits in-flight work.
The rolling download covers eight days before UTC midnight through sixty-two days
after it; the extra boundary days cover timezone differences. Every publication
still checks the original selection and connection generation.

The coherent household snapshot includes a profile-scoped agenda. Browser IndexedDB
and Android's existing Room snapshot retain it for read-only offline use without a
local schema migration. Older caches default to an empty agenda. Replacement clears
calendars and events removed by selection, disconnection or access loss. An offline
device retains its last authorized snapshot until it can reconnect; the UI says so
and shows each source's refresh time, failures and uncovered dates. Reconnection
notices belong only to the connection owner. After privacy filtering, an agenda
larger than 8 MiB returns an explicit limit notice with no partial event list. It
does not change Google's events or delete the server cache.

Six additional package tests cover scheduling, restart/backoff, cancellation,
oversized private projections and date grouping. The browser agenda flow exercises
the actual scheduler against a simulated provider, task navigation, shared/private
calendar changes, profile switching, responsive layouts and offline reload. The
dedicated Android emulator verifies scheduled data, profile isolation and exact
SQLite cache preservation after server shutdown and app reload. In-place APK
installation separately preserves earlier cached sections, drafts, photos and text.

## Remaining account and release work

The implemented read-only flow still needs a live host configuration, real Google
account consent and exact callback/device verification. A restore rehearsal and
normal backed-up upgrade must precede deployment of migrations 017–019. Google
account setup is optional for household tasks; the unconfigured app shows that
state explicitly. Calendar write scopes and event editing are not implemented.

## Common foundation

Keep Google-owned events separate from household records and their undo history.
A task target or review date does not become a calendar appointment implicitly.
Start with a Calendar provider port, a Google adapter, connection ownership,
calendar selection and a scoped event-cache projection. The agenda combines that
projection with existing tasks without copying their contents or changing dates.

Each connection belongs to a person. Calendar discovery is visible only to that
person; selections default to their private scope. Explicitly selecting a
household calendar for sharing is a separate choice. Scope affects cached titles,
descriptions, locations, links, counts, search, errors and any future display or
widget, not just cards. Provider credentials never enter browser/phone caches,
record history, public source or APKs. Profile switching remains subject to the
existing trusted-network access model.

Use server-side authorization-code exchange, single-use expiring state tied to
the initiating person/client, and an exact configured callback. Android opens
the household calendar settings in the system browser, which then starts Google
authorization. The server owns token refresh and
reports revoked or expired access as needing reconnection, without discarding
saved household records. Account consent is an interactive user step. OAuth
configuration and redirect addresses must remain in ignored local configuration.
[Google's web-server authorization guide](https://developers.google.com/identity/protocols/oauth2/web-server)
and [OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies)
are the implementation references. The actual private-host callback needs an
end-to-end check before claiming account integration works.

For reading, request calendar-list and event read scopes plus `openid` for stable
account binding. Verify the grants
actually returned before enabling discovery or synchronization; partial consent
must not look like an empty calendar. See [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).
Do not add calendar-write permission until the household editing contract is
chosen. External apps left in Google's Testing publishing state normally receive
seven-day refresh tokens for these scopes, so this is not a durable unattended
configuration. Check the appropriate personal-use publishing setup during account
connection. See [Google's token-expiration rules](https://developers.google.com/identity/protocols/oauth2).

An initial bounded agenda refresh can fetch a complete time window, including all
pages, into a staging result and replace that calendar/window atomically. Preserve
the previous complete snapshot on failure and show its refresh time. Set explicit
response/event limits and report an incomplete refresh rather than silently
dropping events. A future incremental adapter must honor sync-token restrictions
and rebuild the projection after HTTP 410; it cannot combine a changing time
window with an old token indiscriminately. See [Google's synchronization guide](https://developers.google.com/workspace/calendar/api/guides/sync).

Represent all-day civil dates and timed instants separately; preserve calendar
timezone, exclusive end dates, cancellation and recurring-instance identity.
Normalize provider events in the adapter. The UI must not parse provider-specific
payloads or infer that a declined/cancelled event is an actionable household task.
Authorization changes suppress access immediately even while a fetch is in flight;
a completed fetch must recheck the connection/selection generation before commit.

## Editing decision

Read-only means discovery, selection, refresh and an agenda, with edits continuing
in Google Calendar. Adding household editing requires choosing the authoritative
event store and the conflict behavior first. The earlier proposal was app-owned
household appointments with explicit export bindings; direct editing of arbitrary
Google events is a different contract. Keep either choice separate from private
work calendars. A reply preferring editing should trigger this concrete design
pass before introducing a write scope or creating a calendar.

## Verification before release

Use a fake provider and disposable databases for token expiry, pagination,
mid-fetch disconnect/reselection, private/shared projections, all-day/DST cases,
cancelled/moved recurring instances and stale cache display. Test browser and native
reconnect flows without placing provider secrets in UI state. Preserve all existing
records, receipts, queued captures, media and installation identity through the
additive migration and normal backup/restore checks. Finally connect a user-chosen
real calendar and verify its exact access and refresh behavior; mocks alone do not
establish that Google's account, consent or callback configuration is usable.
