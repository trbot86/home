# Google iCal subscriptions

In Settings → Calendars, add a label and the Google Calendar **Secret address in
iCal format**. Find it on the Google Calendar website under Settings → the
calendar → Integrate calendar. No Cloud project, OAuth client or billing setup
is required. Some work administrators disable secret feeds.

After adding the feed, choose its visibility: private home, private work, or
shared home. New feeds start hidden. Edits remain in Google Calendar. The server
refreshes selected calendars approximately every ten minutes, with a thirty
minute retry delay after failures; Settings also offers a manual refresh.
The agenda cache covers the previous eight days and next sixty-two days.

Treat the feed URL as a credential. The server-only `calendar_ical_credentials`
table holds it; it is not returned in settings, shared calendar projections or
Android caches. It is included in private database backups. Disconnect removes
the active credential and event cache; retained backups still contain their
historical copy. Reset the secret URL in Google to revoke that copy's access.

The initial provider accepts only HTTPS Google Calendar `basic.ics` feeds,
without redirects, query parameters or URL credentials. Other iCal hosts are
not supported yet. Fetches are capped at 5 MiB. Parsing and recurrence expansion
run in a memory-limited worker with a five-second deadline and 5,000-event limit;
failures preserve the previous complete snapshot. No remote attachments are
fetched. Calendar events are read-only projections, separate from household
record history. Existing OAuth connections remain supported.
