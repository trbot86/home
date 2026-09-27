# Calendar integration: next design boundary

Projects and optional maintenance ideas are deployed. Calendar integration follows
the ownership and privacy boundaries in DATA_MODEL.md, section 12. The user is
being asked whether the first release should only display an agenda or also
create/edit events in a separate household calendar. No Google account, OAuth
client, token or live calendar connection has been configured.

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

For reading, request only calendar-list and event read scopes. Verify the grants
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
