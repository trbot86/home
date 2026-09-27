# Alexa inbox note trial

Research checked: 2026-09-27. The local handler, proposed English (Canada) model,
explicit integration principal and separate capture listener are implemented.
No live skill, cloud resource, listener, credential or device connection has been
configured. The production `CaptureSink` transport is still unimplemented;
local tests connect synthetic Alexa events to the capture listener using HTTP
injection and an isolated SQLite database. See
[the backend checkpoint](ALEXA_BACKEND_CHECKPOINT.md) for verification and limits.
See [the imported checkpoint](ALEXA_HANDOFF.md) for its original scope.

## First interaction

Start with a short note into the shared inbox. Suggested one-shot phrase:

> Alexa, tell Our Place to remember the spare key is in the blue drawer.

After the home server acknowledges the save, the proposed response is:

> Saved to your shared inbox: the spare key is in the blue drawer.

Selected interaction: save immediately, then read back without asking for
confirmation. The user can walk away once they finish speaking; listening to the
readback is optional and does not decide whether the note is saved. Success
speech begins only after the home server acknowledges the write. Silence or
ending the voice session after that acknowledgement must not cancel the note.

The current handler already follows this flow and ends the session after its
response. It does not yet support spoken correction, undo, app browsing, long
dictation or a durable cloud queue. If the readback reveals a mistake, correction
is currently an edit in the app. Any later spoken correction must be a separate,
explicit action on the saved note, rather than a prerequisite for saving it.
A timeout says that the save could not be confirmed and asks the user to check
the app before repeating; repeating a spoken command can create a new note.

The included model exposes only notes. Shopping handler support is disabled by
default and requires an explicit `shoppingEnabled` option and a later model
extension. A shopping intent received while disabled cannot reach the sink.

Opening the current skill prompts the user to say `remember` followed by the
note. A possible later flow is `Alexa, open Our Place`, a prompt asking for the
note, and the note alone. That requires a dialog model and slot elicitation;
neither is implemented by simply leaving the current session open.

## What Amazon documents

`AMAZON.SearchQuery` supports English (Canada) and other locales. An intent may
contain at most one phrase slot. A sample containing it cannot contain another
slot, and intent samples need fixed carrier words such as `remember`. Slot-level
samples may omit those words. These rules support testing a prompted reply, but
do not make arbitrary speech an intent-level wildcard. The reference does not
specify a universal maximum note length or listening duration. Our 1,000-character
inbox limit is an application limit, not an Alexa recognition guarantee.
[Slot reference](https://developer.amazon.com/en-US/docs/alexa/custom-skills/slot-type-reference.html#amazonsearchquery).

Amazon describes this slot as suitable for short free-form messages as well as
searches. Recognition of pauses, names, numbers, punctuation and several sentences
must be measured on the actual devices.
[Phrase-slot announcement](https://developer.amazon.com/en-US/blogs/alexa/post/a2716002-0f50-4587-b038-31ce631c0c07/enhance-speech-recognition-of-your-alexa-skills-with-phrase-slots-and-amazon-searchquer).

Dialog directives collect or confirm a slot using a dialog model. A bare-note
reply therefore needs that explicit model/handler work and an Amazon model build,
followed by device tests.
[Dialog reference](https://developer.amazon.com/en-US/docs/alexa/custom-skills/dialog-interface-reference.html).

`our place` is a candidate invocation name. Its format appears consistent with
the English naming rules; this is our assessment, not Amazon approval or evidence
of reliable recognition. Test the name before choosing a replacement.
[Invocation rules](https://developer.amazon.com/en-US/docs/alexa/custom-skills/choose-the-invocation-name-for-a-custom-skill.html).

Development testing uses the developer account on the Echo/Alexa app and a locale
offered by the skill. The phone app has its own language setting. Amazon documents
development skills in both standard Alexa and Alexa+ app navigation. This does not
establish locked-phone or background microphone behavior. Test existing devices;
do not reset or re-register them merely to match a test account.
[Development testing](https://developer.amazon.com/en-US/docs/alexa/test/test-your-skill-overview.html).

Another Amazon account can participate through beta testing after its prerequisites
are satisfied. Amazon's current page says invitation emails are no longer sent on
the developer's behalf; do not follow older instructions that assume they are.
Long-term access for the second account remains a separate setup decision.
[Beta testing](https://developer.amazon.com/en-US/docs/alexa/custom-skills/skills-beta-testing-for-alexa-skills.html).

## Capture bridge proposal

Proposed route: Alexa -> skill-restricted Lambda handler -> restricted tailnet
identity -> dedicated capture-only listener -> existing write coordinator.
No part of this network route is activated by the local handler.

The current application can list profiles and issue sessions without a password
in trusted-network mode (`apps/server/src/app.ts`). A limited token is insufficient
if the cloud machine can reach that listener. The parent app task agreed that the
bridge must expose a separate listener and deny the cloud identity access to all
main-app listeners in the tailnet policy. Tailnet permissions restrict network
destinations, while the capture listener restricts operations; both are necessary.
This is a proposed boundary, not a verified live policy.

The dedicated listener must:

- Accept only authenticated captures, with server-selected shared destination and
  attribution. Reject arbitrary person, scope, path, command, or list selection.
- Offer no login, profile list, generic commands, media, history, backup or browsing
  routes. Do not forward arbitrary URLs, methods or paths to the main app.
- Use revocable integration credentials and server-side allowlists. Restrict the
  Lambda ASK trigger to the exact skill and independently allowlist the intended
  Alexa accounts; a skill ID does not identify the household.
- Preserve operation identity, frozen payload and pinned server epoch across
  retries. Reuse the existing durable receipt/digest arbitration. Never silently
  adopt a restored epoch or change the request identity after a lost response.
- Return success only after a matching validated home-server receipt. Bound
  transport waiting and distinguish known rejection from an uncertain save.

The current function is a Lambda-event adapter, not an HTTP signature verifier.
If a public HTTPS handler is selected instead, it needs Alexa signature and
timestamp validation before accepting events.
[Lambda hosting](https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-an-aws-lambda-function.html),
[HTTPS validation](https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html).

Selected attribution preference: identify the person if it is straightforward;
otherwise label the source Alexa. Capture must not ask who is speaking. Alexa's
account identifier identifies the enabled Amazon account, not necessarily the
speaker. The local implementation uses an explicit integration actor in clients,
history and receipts, labelled Alexa, with no human profile or private scope.
Never infer the author from the note or borrow a person's broad phone credential.
[Request identity reference](https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-and-response-json-reference.html).

Amazon can include an opaque `personId` for a recognized speaker when that
speaker has a voice ID, Personalize skills is enabled, and the skill requests the
personalization permission. Recognition can fail, and the ID is not a person's
name. An optional later enhancement could map recognized IDs to household members
during setup, use that only as attribution metadata, and fall back to Alexa when
absent or unknown. It must not widen scope, permissions or personal undo rights,
add a confirmation turn, or prevent a note from saving. Do not enable Amazon
personalization until that behavior is implemented and its configuration reviewed.
[Personalization requirements](https://developer.amazon.com/en-US/docs/alexa/custom-skills/add-personalization-to-your-skill.html).

## First account setup step

Open the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask)
and sign in with the existing Amazon login used by the test devices. Amazon
supports using an existing consumer Amazon account for developer registration.
First establish whether this opens the skills dashboard or developer registration;
review any registration terms and account information as the account owner. The
local code does not require registering a skill or provisioning cloud resources
just to establish developer-console access.
[Developer account instructions](https://developer.amazon.com/en-US/docs/alexa/ask-overviews/create-developer-account.html).

Amazon allows individual developers; being part of a company is not required.
The registration instructions use **Sole Proprietorship** for individual use,
including students and amateur developers. **Business** asks for a registered
legal business name and company website. The separate customer-facing business
name is the public developer label. The published naming rules do not explain a
particular rejected personal name; inspect the actual field and error instead of
assuming that an Appstore business must be created first.
[Alexa account guidance](https://developer.amazon.com/en-US/docs/alexa/developer-account/manage-developer-account.html),
[registration fields and naming rules](https://developer.amazon.com/docs/app-submission/manage-account-and-permissions.html#create_account).

## Setup and verification sequence

1. Use the selected save-then-readback interaction. Keep the reported locale and
   account arrangement in ignored `.local/alexa/` setup metadata; verify the
   speaker/app language during the device trial. Establish developer-account
   access and coordinate the selected Alexa attribution fallback before
   provisioning an integration binding.
2. Review the implemented listener, authorization and reserved migration 007
   with the main task. Isolated compatibility tests pass; preserve deployed
   migrations 001–006. No live database is a test fixture.
3. Prepare a concrete cloud/tailnet configuration and deployment artifact for
   review, including service/cost choices, allowed listener and denied main-app
   destinations. Account changes, cloud resources and live security configuration
   require the user's authorization before activation.
4. Initially connect the skill to an isolated test household. Build the selected
   locale model in Amazon's console and exercise both text and voice simulation.
5. On one existing speaker, try the invocation, one-shot note and prompted carrier
   phrase. Test an unfamiliar name, number, list within a note, pause and a longer
   sentence. Compare intended speech, received text, readback and stored note.
6. Repeat through the Alexa phone app on mobile data. Record opening/unlocking
   requirements and taps. Repeat with the second person's normal account setup.
7. In the isolated environment test a lost response after commit, identical event
   retry, changed payload under the same ID, disconnected home, revoked binding
   and restore epoch mismatch. Confirm truthful speech and record counts.
8. Test the bridge's network identity: capture succeeds, while every main-app
   listener is unreachable. Test the capture listener independently: profile/login,
   media, history and generic command requests fail without revealing content.
   Unit tests cannot certify a live tailnet policy.
9. Review results before connecting an authorized binding to the real household.
   Keep machine-specific transcripts, IDs, addresses and reports out of Git.

Product preference and reported setup information have been collected; no live
setup or device trial has been completed. Local checks cover handler behavior,
model structure, capture authorization, save/retry behavior, schema compatibility,
backup/restore and TypeScript compatibility. Amazon model acceptance, phrase
recognition, cloud latency, tailnet isolation and real-device behavior remain
unverified.
