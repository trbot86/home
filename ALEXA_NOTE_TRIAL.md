# Alexa inbox note trial

Research checked: 2026-09-27. The local handler and proposed English (Canada)
model are available. No skill, cloud resource, capture listener, integration
credential or device connection has been configured. The handler calls an
unimplemented `CaptureSink`; tests use synthetic events and a fake sink.
See [the imported checkpoint](ALEXA_HANDOFF.md) for its original scope.

## First interaction

Start with a short note into the shared inbox. Suggested one-shot phrase:

> Alexa, tell Our Place to remember the spare key is in the blue drawer.

After the home server acknowledges the save, the proposed response is:

> Saved to your shared inbox: the spare key is in the blue drawer.

The current handler saves immediately, reads the text back, and ends the session.
Confirmation before saving is a pending product preference. It does not yet
support spoken correction, undo, app browsing, long dictation or a durable cloud
queue. A timeout says that the save could not be confirmed and asks the user to
check the app before repeating; repeating a spoken command can create a new note.

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

Attribution is unresolved: Alexa's account identifier identifies the enabled
Amazon account, not necessarily the person speaking. The current app's clients,
history and receipts require a person. Agree how a shared speaker should appear
with the user and coordinate any schema change with the parent task. Never infer
the author from the note or borrow a person's broad phone credential.
[Request identity reference](https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-and-response-json-reference.html).

## Setup and verification sequence

1. Establish speaker/app locale, same versus separate Amazon accounts, access to
   a developer account, preferred readback/confirmation, and shared attribution.
   Record identifiers and configuration only in ignored `.local/alexa/` metadata.
2. Implement and test the proposed listener and authorization in isolated
   fixtures after coordinating shared contracts with the main task. Preserve
   deployed migrations 001–006. No live database is a test fixture.
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

No step above is reported as completed by this plan. Local checks cover only
handler behavior, model structure and TypeScript compatibility. Amazon model
acceptance, phrase recognition, cloud latency, tailnet isolation and real-device
behavior remain unverified.
