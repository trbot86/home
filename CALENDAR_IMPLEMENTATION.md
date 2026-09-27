# Calendar integration

Projects and optional maintenance ideas are deployed. Calendar integration follows
the ownership and privacy boundaries in DATA_MODEL.md, section 12. The user is
being asked whether the first release should only display an agenda or also
create/edit events in a separate household calendar. No Google account, OAuth
client, token or live calendar connection has been configured.

## Implemented foundation (not deployed)

The development branch contains a provider-neutral event contract, a bounded
Google reader, transactional calendar ownership/cache storage and an asynchronous
synchronizer. Migration 017 adds connection, source and event-cache tables without
changing household records, receipts or history. The live app still runs migrations
001–016; this checkpoint adds no calendar UI or live account connection.

`CalendarSynchronizer` resolves an opaque credential reference through the
`CalendarCredentials` port and performs network work outside SQLite transactions.
The authorization service described below implements that credential resolver;
runtime configuration and OAuth routes still need wiring. Each result rechecks the
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
payloads; their runtime configuration loader is still to be connected.

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

## Remaining connection and UI work

The common foundation is not an end-to-end integration. It still needs host
configuration, a scheduler, receipt-backed selection/disconnect routes,
browser/Android settings and agenda views, and client-cache invalidation when
visibility or connection state changes. The OAuth callback and browser/Android
handoff must establish the original authenticated client before calling `finish`;
constructing a trusted context from a callback's state alone is forbidden. A callback
must not log its code/state or expose them to page assets. Test both browser session
binding and Android's system-browser return before enabling account connection.

The read-only-versus-household-editing question remains open. Build and verify the
chosen user flow before deploying migrations 017–018 or requesting real account consent.
Calendar write scopes and event editing are not part of this checkpoint.

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
Google authorization in the system browser. The server owns token refresh and
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
