# Household app — working planning notes

Updated: 2026-09-26. Status: the first inbox/media/offline/history/backup slice is implemented and locally verified; the broader product below remains a plan. See [README.md](README.md) and [BUILD_PROGRESS.md](BUILD_PROGRESS.md) for what can be run and what has been tested. These notes preserve the conversation and distinguish agreed directions from proposed behaviours and build order. Self-hosting for two people with file-based media and SQLite is selected. The expected deployment is Docker on Windows with local NVMe and backups to the main PC. Actual installation settings, device behaviour and display hardware remain open.

## What the household wants

Two people using Android phones and computers together. The app should reduce the effort of remembering, capturing, finding, and completing household work.

Current shopping is a shared Google Keep list. The user reports sync problems and awkward phone interaction. Work uses Google Calendar and will continue to do so. Household events should be distinct from work while remaining easy to see together when useful.

The couple already talks: in-app chat and assignment negotiation are unnecessary. Individual task overviews, completion controls, and a separate feed acknowledging what each person accomplished could be useful.

Concrete examples beyond those below will come later; further brainstorming can proceed meanwhile.

### Purchases and gifts

- Groceries and routine shopping.
- Occasional restocking, such as electric toothbrush heads, with an easy tap to say they are needed and optional reminders.
- Things wanted but not yet needed or committed to buying.
- Gifts for other people.
- Gifts for each other, with appropriate hiding and a way to leave suggestions.
- Ideal capture: say something like "add X to my shopping list" to Google Assistant and have it arrive in this app.

### Chores, time, and personal attention

- Assign chores and schedule recurring work.
- Personal overview of what is relevant now, overdue, upcoming, or a priority.
- Record when recurring tasks were ACTUALLY completed.
- Dates may mean a deadline, a flexible target, or a date to reconsider something. Many items only need priority ordering.
- Very easy postponement: one day, one week, two weeks, or one month.
- Selective reminders with easy on/off control. Candidate channels include push, email, or a Discord bot; no channel has been chosen or connected.
- Calendar integration and an Android home-screen widget are interests.

### Food and recipes

- The user's wife wants to suggest recipes by pasting links, with an imported picture because she chooses visually, and quickly make a linked to-do or reminder when useful.
- The couple likes Want to try, Favourites, moving recipes between sections, a Let's make this soon pin, and adjustment notes kept with each recipe.
- Treat food as a distinct app section with prominent dish photos. Automatic external recommendations are an open possibility; the user is unsure how that engine would work. Prioritise the couple's own saved suggestions first.
- Recipe/image import sources, food preferences, and dietary constraints remain to be decided; no actual recipe recommendations or integrations have been selected.

### Maintenance, projects, and records

- Maintenance with photos, receipts, and other supporting material.
- Suggested maintenance appropriate to the home, plus an ability to pin priorities.
- Project boards with photos, screenshots, notes, hyperlinks, and mixed media, potentially nested like hierarchical pinboards.
- Preserve the distinction between storing reference material and making priorities, ordering, and next actions visually clear.
- Potential future desk and kitchen e-ink displays. No hardware has been bought for this purpose yet.

### Capture

- "Remember this unsorted thing" should be a valid complete interaction.
- Organize captured material later with little effort.

## Proposed organising idea

An item has a stable place to live, while personal and shared overviews bring it forward when relevant. A furnace manual can stay with the furnace record; a filter replacement can appear in a person's current tasks; the compatible filter can appear on a shopping list. Those views should link to the same underlying records instead of requiring copied notes.

Possible entry points, still open to revision:

- My day: agenda, selected priorities, tasks needing attention, and items returning for review.
- Buy: needed purchases, restock favourites, wants, and gifts, with appropriate visibility.
- Food: shared recipe suggestions, Want to try, Favourites, and a Let's make this soon selection, linked to shopping and tasks.
- Home and projects: nested boards, household records, maintenance, and reference material.
- Inbox: uncategorised text, links, photos, and screenshots.
- Recent activity: a quiet, separate completion feed.

Exact navigation and names have not been chosen.

## Proposed behaviour details

### Time and recurrence

Keep these meanings distinct even if the interface offers simple controls:

| Meaning | Example | Proposed behaviour |
| --- | --- | --- |
| Fixed event or actual deadline | Appointment; return an item before its return window closes | Display the real date; snoozing a reminder preserves it. Explicit rescheduling is a separate action. |
| Flexible target | Clean the garage this weekend | Quick postponement moves the target. |
| Review date | Reconsider buying shelving next month | Resurface for a decision without labelling it a missed deadline. |
| Priority without a date | Fix an annoying cupboard | Pin or order it without inventing a due date. |
| Fixed recurrence | A chore tied to a particular weekday | Completing late does not silently shift the recurring schedule. |
| Recurrence after completion | Do a task again N weeks after doing it | Calculate the next occurrence from actual completion. |

Show the next action and last completion clearly. Completion defaults to now, with a way to record that it was actually done earlier, correct a mistake, or undo it. Skipping and postponing do not count as completion. For routines, prefer one actionable occurrence over a pile of missed duplicate tasks unless the household explicitly wants each missed occurrence recorded as outstanding work.

Personal reminder snooze and changing a household task's target have different scope. The UI should make that clear without requiring a complicated form. Quick actions should remain quick.

### Restocking

Store a reusable item with optional photo, exact product/compatible model, size, and purchase link. "Need this" adds it to the active shopping list without making another copy if it is already there. After purchase, retain the reusable item for next time.

Keep "bought replacements" distinct from "installed/replaced the part". Buying a pack of toothbrush heads should not reset the last-replaced date. Inventory counting is optional future scope, not a prerequisite for easy restocking.

### Gifts and visibility

Proposed separation:

- Shared suggestions: a person can leave things they would like, including links, sizes, and alternatives.
- Private gift planning: the giver can record ideas, purchases, receipts, and plans without revealing them to the recipient.
- Gifts for others can be shared between the couple.

Visibility must apply to attachments, search, activity feeds, reminders, widgets, calendar exports, and shared displays as well as the main list. A hidden gift must not be revealed by a completion feed or thumbnail. How and when a gift becomes shared remains a design decision. Shared suggestions must not inadvertently reveal a private purchase status.

### Project boards and household records

Use nested boards or pages to give material a home. Each board could have a prominent pinned/next-actions area and a browsable reference area, with visual cards for photos and screenshots. Allow links between boards, tasks, purchases, and records. A link card and an uploaded copy of a document have different persistence guarantees; make it clear which was saved.

Example: a bathroom project can hold inspiration images, measurements, product options, quotes, and receipts. "Choose a tap" can be pinned and appear in a personal overview without moving the reference material. A selected tap can become a purchase; its receipt can remain useful after the project is finished.

Maintenance suggestions should be optional, based on what the home actually contains. Any recommended interval should identify its basis and remain editable; manufacturer guidance and household circumstances matter. No specific maintenance intervals have been researched or prescribed yet.

### Food discovery and recipe collection

Proposed design: a photo-led grid that makes the finished dish the main visual, with the recipe name, source, and available cooking time beneath it. On a phone, use generously sized cards; desktop/tablet can show more cards together. Photos should correspond to the actual recipe, using source imagery where available or the household's own dish photo; do not present an invented dish image as a photograph of a sourced recipe. Keep source links visible.

Accepted direction: Want to try and Favourites are the main collections. Recipes can move between them while keeping their photo, source, adjustment notes, and cooking history. A Let's make this soon pin is independent of collection membership, so an old favourite can be pinned too. Keep unpinned and previously tried recipes accessible in the recipe library. Cooking a recipe does not automatically make it a favourite.

Proposed capture flow: paste a link or share it from a phone browser, then Save to Want to try. Save the link immediately while enriching its card with the title, recipe picture, source, and available preparation time, servings, ingredients, and instructions. Keep a visible import state and allow the user to fix the title or choose/replace the image. Where a page offers several recipes, ask which to save. Re-pasting an already saved recipe should offer its existing card rather than silently duplicate it.

Import feasibility checked in documentation on 2026-09-25: Schema.org Recipe markup and Google's recipe guidance describe fields for recipe images, ingredients, instructions, yield, and cooking time, often represented as JSON-LD. Prefer those fields when a source provides them; they avoid needing an LLM for the basic import. Open Graph metadata provides a possible title/image fallback. These standards establish mechanisms, not coverage of every recipe website. If a page cannot be fetched or its details are missing, retain a useful link card and allow pasted text or a user photo. Do not invent missing amounts or instructions. Keep source attribution and distinguish an imported recipe from a link-only bookmark. No actual URL import has been implemented or tested.

Sources: [Recipe structured data](https://developers.google.com/search/docs/appearance/structured-data/recipe), [Schema.org Recipe](https://schema.org/Recipe), [Open Graph](https://ogp.me/).

The user proposes an eventual OpenRouter free-model fallback when useful recipe metadata is missing. Proposed import order: parse available recipe metadata first; if necessary, fetch the page's readable content and candidate image URLs, then ask an LLM to extract the missing recipe fields. Fetching is a separate application step; passing a URL alone does not guarantee that a model reads the page. If the page is inaccessible, accept pasted recipe text and keep the saved link rather than assume the model can recover unavailable content.

Request a defined recipe structure (title, servings, times, ingredient amounts/units, ordered steps, and a source image selected from retrieved candidates). Preserve reliable imported fields and keep household adjustment notes separate. Missing details remain unknown; do not have the model invent quantities, temperatures, steps, or image URLs. Validate the response and present an editable recipe preview, highlighting incomplete or inconsistent fields. Structured output ensures a format where supported; it does not establish factual correctness. Treat page content as data, not instructions, and limit the model to extraction with no ability to change tasks or shopping entries.

OpenRouter's current free router can select free models with compatible features, including structured outputs; its selected model and availability can vary. A tested specific free model or the free router are candidates, with the choice deferred until implementation. Queue/retry failed enrichment while keeping the original card usable, cache successful imports, and do not silently fall back to a paid model. Keep the API key on the backend and send only the recipe material needed for extraction, not household notes or other app records. This is optional future scope; no account, key, model integration, or extraction evaluation has been configured.

Documentation checked on 2026-09-25: [OpenRouter free router](https://github.com/OpenRouterTeam/docs/blob/main/guides/routing/routers/free-router.mdx), [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [Free model availability and limits](https://openrouter.ai/support/).

Offer quick actions directly after capture and on every recipe: Let's make this soon, Create a to-do, Remind me, and Add ingredients to shopping. A task such as "Try this curry" links back to the existing recipe, preserving its photo and notes; it does not replace the recipe record. Allow an optional owner and target/review date with a date picker and existing postponement controls. Reminder notification is optional. Soon alone is an undated priority, not a deadline or a notification. Completing a linked cooking task can record the date cooked; postpone and cancel do not count as cooking. Meal-calendar placement remains optional later scope.

For Add ingredients to shopping, show a checklist so the user can exclude ingredients already at home without maintaining pantry inventory. Review quantities and existing shopping entries before combining them; retain the recipe link. Saving, pinning, or reminding about a recipe alone should not add groceries.

Keep a prominent Our adjustments area with the recipe, for reusable changes such as "halve the chilli" or "use the larger baking dish". Optional dated cooking notes/photos can record what happened on a particular attempt. Collection moves and repeat cooking preserve both. Source re-imports must not overwrite household notes or silently replace household edits. Ingredient additions should make it clear whether they use the source recipe or an explicitly saved household version; do not silently interpret free-text notes as ingredient changes.

Ideas is deferred as an automatic external recommendation feature. A small first version could simply resurface the couple's own collection: a shuffled Want to try selection, a quick meal matching available time, or a favourite not cooked recently. Those are explainable filters/ordering over saved recipes, with no learned recommender required. External discovery would later need chosen sources and explicit preferences; it is not a prerequisite for link capture or the visual recipe collection.

This section has been added to the plan only. The existing three screen mockups have not yet been updated with Food.

### Personal overview and activity

Proposed groups: timed commitments, chosen priorities, genuinely late items, flexible work ready to do, and things to reconsider. Do not make everything returning from snooze look overdue.

Record who did what and when, with optional completion notes/photos. A separate recent-completions feed can make effort visible. Scoring, leaderboards, and chat are not requested.

### Capture and reliability

Typing, dictation, sharing a URL/photo/screenshot, taking a camera photo, and selecting gallery photos are capture entrances. Filing must not be required at capture. Retain the original input when suggesting a task, purchase, date, or destination. A photo-only inbox entry is valid; text/caption and organisation can follow later.

Because sync issues are an existing pain point, shared shopping needs early tests of simultaneous edits, weak connectivity, offline changes, retries, and undo. A visible saved/pending state should tell users whether another device can see a change. These are proposed quality requirements, not claims about an implementation.

The agreed offline direction is an authorised read cache of existing app data plus local inbox drafts. Existing records, including existing inbox entries, are read-only offline. A new draft can be edited/deleted locally until it is durably frozen before its first submission attempt. The user explicitly accepts locking its edits while delivery/acknowledgement is uncertain. Retry the same stable capture identity and immutable payload; after creation is confirmed, editing/deletion uses the normal online API against current server state. Shopping can be browsed offline while check-offs require connectivity. Cache coverage and media download limits remain to be chosen. See [the capture submission decision](decisions/0001-offline-capture-submission.md) for the database and protocol design; no implementation exists yet.

### Unfinished forms and photo capture

Preserve unfinished text boxes and new-item forms locally so they can be resumed after navigation, switching apps, or restarting. Use ordinary editor undo/redo for unsaved typing. Save draft content incrementally and flush pending writes before deliberate navigation or launching the camera/picker; show local-save failure instead of claiming persistence. Recovering the draft contents does not require preserving every keystroke or the editor's undo stack across restart. Drafts are scoped to the person and device/browser and are not automatically shared across devices.

Distinguish local draft autosave from submitting an item. An unfinished form must not be uploaded merely because connectivity returns. Save/Submit or an explicit capture-complete event marks it ready for submission; voice capture can retain its agreed automatic completion flow. Ctrl+Enter invokes that same submit action and validation. Saving a local draft creates no server changeset. Existing-record edit buffers retain their starting server revision and use ordinary online concurrency checks on submission; preserving a buffer does not introduce queued offline updates to existing records.

Offer Take photo and Choose photos wherever attachments make sense: the inbox, project pages, maintenance/receipts, recipes, and purchase records. Show previews, allow removal before submission, and support optional captions. Desktop can use file selection, drag-and-drop, and image paste. These entrances should share the attachment workflow rather than each feature implementing its own uploads. Adding to an existing record still follows its online update rules; offline quick capture can save to the inbox for later filing.

Copy acquired image bytes into durable app-owned local storage before calling the attachment saved. Preserve the unfinished form before opening the camera/gallery, and return to it on cancellation or interrupted acquisition. Locally acquired photos can accompany queued offline inbox captures; a cloud-only gallery selection may need connectivity before its bytes are available. Pending draft/submission media must not be evicted as disposable cache. Keep the original camera/gallery photo untouched when removing an attachment from the app.

### History, undo, and storage visibility

History is primarily read-only: browse earlier record versions and copy old text into a normal edit. Undo/redo is personal, mainly for recent accidental delete/submit/edit actions. It must not reverse the other person's actions. Conservatively reject an undo if an affected row or relevant dependency changed afterward; offer a brief explanation and access to history, without elaborate merge dialogs. Unrelated changes do not block it. The duration/depth of recent undo can be smaller than the retained read-only history.

Add Settings > Storage with the database size on this phone and on the home server, with media-file storage shown separately and a labelled overall total. Show each measurement's last-updated time and a Refresh action; continuous updates are unnecessary. Offline, preserve the last known server size with an explicit stale/offline indication rather than showing zero. Optional details can distinguish database files/journal space, reusable internal pages, media/staging files and bytes awaiting collection. Pending collection is a subset of media usage, not an additional amount to add again. Exact accounting belongs below the simple overview.

For imported photos, preserve the original media URI and relevant source-page URI even after the downloaded bytes are collected. The old image can offer a source link or an attempt to download again. A vanished/changed source must not be represented as an exact restoration of the historical photo; locally uploaded media may have no recoverable remote source.

### Calendar, widgets, and displays

Proposed calendar arrangement: keep work in its existing calendar; use a separate shared Household calendar; show selected calendars together in the app. Initially, reading the work agenda and handling household events separately would keep the integration understandable. Whether household events are edited in both places needs an explicit decision. Keep floating tasks and completion-based recurrence in the app unless a user deliberately schedules time for them.

Work details shown to the other person or on a kitchen display should be configurable; a personal desk view and a shared kitchen view need different content choices. Display refresh rate and interaction depend on the eventual hardware. A last-updated indicator would help identify stale display data.

Android widgets should be considered when choosing the app architecture. Prototype the small interaction loop: view current tasks, complete one, snooze, and add an item. A web shortcut alone does not establish that this widget experience is delivered.

## Integration evidence checked on 2026-09-24

These are documentation findings, not device-tested integrations.

- Google supports creating additional calendars, sharing them, and displaying them in its browser and mobile app: [Create a new calendar](https://support.google.com/calendar/answer/37095?hl=en). Its API represents calendars separately: [Calendars and events](https://developers.google.com/workspace/calendar/api/concepts/events-calendars).
- Android supports glanceable widgets and collection widgets with completion interactions: [App widgets overview](https://developer.android.com/develop/ui/views/appwidgets/overview). This establishes a native platform capability; no app widget has been built or tested here.
- Gemini documents supported notes/list integrations, including Google Keep: [Capture your ideas and notes with Gemini Apps](https://support.google.com/gemini/answer/15230597?hl=en-AU).
- Google Assistant documents Android App Actions and app-specific voice invocation, with Play distribution/review requirements and development/test provisions: [Build App Actions](https://developer.android.com/develop/devices/assistant/get-started).
- These pages do not establish that a custom app can become the destination of the exact generic shopping-list phrase on the user's current phone, or that Assistant App Actions work equivalently with Gemini or household speakers. Treat that as an early feasibility experiment. Test actual assistant, device, account, locale, locked/unlocked behaviour, distribution route, and the acceptable invocation phrase.
- A quick-add widget or app shortcut plus dictation is a separate phone capture route. The user subsequently accepted tapping to start and optionally tapping again to finish; see the selected voice direction below.

## Proposed next design work

The user requests iterative architecture planning with structured classes, modularity, reusability, naming symmetry and foresight. [ARCHITECTURE.md](ARCHITECTURE.md) is at iteration 4, connecting the [database model](DATA_MODEL.md), [worked transactions](WORKED_TRANSACTIONS.md), [stack selection](STACK_SELECTION.md) and [first implementation slice](IMPLEMENTATION_PLAN.md). The working choice shares React screens through Capacitor with a native Kotlin/Room core and a TypeScript/Fastify/SQLite server. [Earlier architecture](ARCHITECTURE_ITERATION_3.md) and [schema inventory](DATA_MODEL_ITERATION_1.md) are preserved. No production application/schema has been scaffolded or deployed.

After partial review, the user gave the go-ahead to continue developing the plan. The first [application contracts](APPLICATION_CONTRACTS.md) now define representative commands/results, query projections, terminal rejection, conservative inverse rules and module composition. This does not mark individual unreviewed proposals as settled; the plan remains revisable.

The user specifies a two-person self-hosted deployment and wants proportionate reliability: transactions, durable client queues, idempotency and backups. Use one host relational database for feature/operational data and one local database per phone. Media bytes are files with identities, references, provenance and lifecycle in the host database. [DATA_MODEL.md](DATA_MODEL.md) now connects the whole known scope so conventions remain coherent as features are added. SQLite remains the working database choice; [A13](decisions/0003-file-media-and-container-storage.md) records the accepted file-storage direction and intended Docker deployment.

The user wants committed changes represented as deltas, primarily for read-only historical browsing/copying and recent per-user undo/redo. Proposed mechanics retain current relational records and append grouped reversible changes in the same transaction; undo/redo creates new changes and rejects conflicting later edits/dependencies. Media is replaced wholesale, without binary deltas or indefinite retention of old bytes. Once no live record uses an old object, schedule collection after roughly 24 hours or earlier under storage pressure. Retain small historical metadata and source URIs where available, enabling a possible recovery attempt while making missing or changed sources explicit. [A09](decisions/0002-record-history-and-media-retention.md) records the proposed design and open details.

The user requested autonomous progress until input becomes necessary. Stack comparison and a bounded build sequence are now documented, including [restore reconciliation](RESTORE_RECONCILIATION.md) when an older backup lacks operation receipts. The supplied Windows/Docker, local-NVMe and main-PC backup context is incorporated in [WINDOWS_DEPLOYMENT.md](WINDOWS_DEPLOYMENT.md). Actual device behaviour, compatible dependency versions and production schema are explicit implementation gates; no broad feature scaffold is needed first.

An initial build could then prioritise reliable shared purchases, recurrence with actual completion history, the personal overview, and a basic capture inbox. Establish visibility and links to attachments early, even if richer gift/board interfaces follow. Calendar, actionable reminders, voice capture, widgets, and displays need sequencing based on the feasibility checks and the couple's preferences; none is automatically committed to a particular release.

Open questions for later, not blockers to brainstorming: actual Assistant/Gemini setup; exact offline cache coverage and upload handoff; which reminder channel to try first; project nesting needs; privacy choices for shared displays; hosting and data export/backup; and the first complete daily workflow both people want to try. Both phones are confirmed to be Android.

## First screen concepts — 2026-09-25

Created three interactive conversation previews under the working name **Our place**. This is a visual direction for discussion, not a chosen brand or a production implementation.

- Desktop starts on the personal overview, with priorities beside a calendar agenda.
- Tablet starts on Bathroom refresh, with next actions, nested reference groups, concept artwork, notes, and example attachments.
- Phone starts on shared purchases, with quick entry, check-off, and restock favourites.
- Each preview also includes Today, Purchases (needed, restock, wants, gifts), Home & projects (bathroom and house care), Inbox, and Recently done. Local sample actions demonstrate completion, postponement, private gift tracking, and filing captured thoughts.
- The design controls offer desktop/tablet/phone layouts, sage/clay/blue accents, and comfortable/compact spacing.

All content and activity are sample data. The three previews have independent temporary state. Calendars, document storage, notifications, voice capture, authentication, and device synchronization are not connected. Drawn inspiration artwork and example document entries demonstrate the intended layout; no real household media were imported. No browser/device validation was performed in this mockup pass.

Preview sources: `<local-mockup-directory>/our-place-desktop.html`, `our-place-tablet.html`, and `our-place-phone.html` in the same directory.

## Feedback on the first concepts — 2026-09-25

The user likes the initial visual direction. The following are requested improvements or topics to resolve, not implemented features:

| Area | User feedback | Proposed next design step |
| --- | --- | --- |
| Task organisation | Unclear how lists work as they grow | Give tasks a project/area and owner; provide a complete task view with grouping, sorting, and filtering. Make the home screen a configurable selection with explicit "View all" counts. |
| Work and home | Explore merged and split views | Offer Home, Work, and Combined views without copying items or implicitly sharing work data. Clarify whether Work initially means calendar events alone or work tasks too. |
| Layout and ease of use | General issues remain | Exercise realistic long lists, long titles, and frequent actions on all three device formats. |
| Editing and deleting | Missing in the mockups | Add item editing, moving, deletion with undo, and a recoverable deleted-items view. |
| Keyboard submission | Ctrl+Enter should submit a multiline text box | Treat Ctrl+Enter as clicking the active form's Save/OK/Submit action; retain Enter for newlines, honour validation and disabled/pending state, and prevent duplicate submission. Apply consistently to capture, notes, editing, and suggestions. A visible shortcut hint and Cmd+Enter on macOS are proposed additions. |
| Dates | Need a date picker as well as postponement presets | Put a calendar picker beside +1 day/week/2 weeks/month, preserving the distinction between a deadline, a target, a review date, and a personal reminder. |
| Home-screen customisation | Choose the types and number of items shown | Let each person choose sections, order, counts, grouping, and work/home scope. Apply separately to app overview, phone widget, and shared display where appropriate. |
| Calendar integration | Needs further design and real integration | Retain calendar ownership and source identity; distinguish read-only work aggregation, household event edits, and explicitly scheduled task time. |
| Product feedback | Add a suggestion button for improvement requests | Provide "Suggest an improvement" from any screen: one text field, automatically attached screen/device context, optional screenshot, and a saved backlog with proposed/planned/done status. Saving a suggestion does not automatically apply changes. |
| Voice capture | Strong interest in Google Home/phone/Alexa phrases for inbox and shopping; wording may change if easy to say and memorable | A short invocation name and custom command are acceptable. Investigate the capture route before selecting hardware or promising particular words. See VOICE_INTEGRATION.md. |

Device context supplied by the user: an older Google Assistant speaker, approximately 2018, not currently set up; exact model unknown. The user's phone apparently uses Gemini. The user also has older Alexa speakers, from 2018 or earlier, and wants equivalent voice capture on those. Exact Echo models, account locale, and original Alexa versus Alexa+ state remain unverified. No Home Assistant installation or voice hardware purchase has been requested.

## Selected voice direction — 2026-09-25

The user accepts Alexa as the initial speaker integration. On Android, they also want a home-screen button that starts dictation and sends the recognised text to the inbox. Tapping again to end dictation is acceptable; minimising visual attention matters more than eliminating every tap. The Alexa phone app is another possible entrance when away from home.

Proposed phone interaction: start capture, hear/feel a ready cue, speak, stop automatically or with a large stop button, then hear the recognised inbox entry read back with its saved/pending state. Spoken readback is a user requirement so capture can work without looking. No routine visual review or extra confirmation should be required. If recognition stops prematurely, offer Continue speaking to append to the same entry; also offer Re-record, Edit text, and Undo. These correction controls are proposals for a smooth exception path. Preserve the original recognised text; classification can happen later. Once a transcript exists, a local pending copy can protect against failed upload, with confirmation distinguishing local storage from household sync. Offline transcription itself requires separate device validation.

The leading Android capture implementation uses platform SpeechRecognizer behind a compact native screen launched by a widget/shortcut. Ordinary keyboard dictation remains useful. This does not require Alexa on the phone or replacing Gemini as the default assistant. The working stack now combines that Kotlin capture component with shared React screens in Capacitor; native persistence and device-specific behaviour have explicit proof gates in [STACK_SELECTION.md](STACK_SELECTION.md).

The user believes their phone is a Android phone; exact model and OxygenOS build are not yet verified. They would like a gesture or physical button to start capture and strongly prefer avoiding unlock. Retain the secure device lock, which they need for wallet security. Investigate a limited capture screen above the lock screen, with readback/corrections for only the current capture; browsing existing household data still requires unlock. Android documents relevant platform building blocks, but the launch trigger and microphone behaviour need testing on this phone. Android phone documents Plus Key voice memos into Mind Space; routing that button to our app is not established. Alexa remains the preferred entrance whenever a speaker is available.

### Hosting and access preference

The user will self-host the app for two people, is comfortable treating home-network access as trusted, and proposes Tailscale for access away from home. The expected host is another Windows box already running Jellyfin/Seerr/arr applications, with Docker for Windows and local NVMe (probably the boot drive); backups can go to the main machine. Use one host relational database for domain data and operational metadata, with media in immutable files. For Windows, the working recommendation refines the earlier host-directory bind mount to a dedicated Linux-backed Docker volume, with separate DB/media subdirectories. Following the user's question about downtime, routine backup uses an online SQLite snapshot and temporarily defers physical media collection while copying its referenced immutable files. The app writes verified exports to a dedicated Windows-folder backup mount; the host's backup system can handle remote copies. A dedicated network-share output mount is an alternative, not a NAS requirement. Limit media cleanup to its own storage roots, and give the external backup system independent retention. Pair personal devices once to support personal views and private gifts without a repeated login during capture; exact identity setup remains implementation work.

The user likes showing backup sizes and availability in settings. Display timestamped local export sizes, verification, availability and run errors. Remote protection is shown only when the external backup system reports it, otherwise as unknown. A small read-only metadata/status mount is enough for an external report; no full remote backup mount is needed merely to show status. Windows VSS can snapshot completed exports; relying directly on a snapshot of Docker's live Linux virtual disk requires verifying the actual backend/backup product and restoring it successfully.

The user is concerned that Docker could slow development/testing. Proposed workflow: support direct local execution and fast tests without Docker, while designing configurable data roots and runtime settings now. Add a Dockerfile and minimal Compose packaging alongside the first runnable server slice, and test the actual image/mount behaviour early. Container development with file sync/hot reload is optional; rebuilding the production image for every source edit is not required. This preserves an easy development loop without leaving deployment assumptions untested until the app is complete. No Docker process or deployment has been started.

Alexa custom-skill requests originate in Amazon's cloud even when the speaker is at home. Proposed bridge: Alexa invokes an AWS Lambda skill handler, which reaches the home app over Tailscale. This keeps the main app private while giving Alexa a reachable handler. Treat the bridge as an integration to test, including startup latency and home-server outages. Neither Tailscale, hosting, nor any cloud endpoint has been configured.

These are requirements and proposed mechanics, not implemented or device-tested features. See [VOICE_INTEGRATION.md](VOICE_INTEGRATION.md) for the APIs, limitations, and revised experiments.
