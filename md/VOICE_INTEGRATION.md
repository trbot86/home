# Voice capture feasibility

Research date: 2026-09-25. Status: documentation research only. No speaker, phone, Google account, integration, or credential has been configured or tested.

## Desired experience and current devices

The user wants voice capture into the inbox and shopping list. Phrases such as "Hey Google, remember XYZ" and "Hey Google, add X to my shopping list" are examples, not required exact wording. The user explicitly accepts different wording, including an app invocation name, provided it is easy to say and memorable. Low-friction capture matters more than tying the rest of the app to a particular provider.

Available devices: an approximately 2018 Google Assistant speaker that has not been set up (exact model unknown), an Android phone apparently using Gemini, and older Alexa speakers from 2018 or earlier. Echo models, locale, and assistant version are not yet known. The Alexa devices introduce a promising direct custom-skill route, described below.

Selected direction: begin speaker integration with Alexa, preferred whenever a speaker is available. Add separate Android dictation for inbox capture; automatic stop or tapping again to finish are acceptable. Read the captured entry aloud, and make corrections easy only when needed. Investigate gesture/button activation and capture without unlocking while retaining the secure device lock. The user believes the phone is a Android phone; exact model/OxygenOS build is unverified. Alexa mobile is an additional candidate entrance. Retain the Google and Home Assistant research below for reference, with those experiments deferred.

## Findings

### A generic custom Google voice endpoint is not established

Google's former Conversational Actions platform, which provided custom conversations, was discontinued on June 13, 2023. Current Google Home cloud-to-cloud intents concern smart-home devices and their commands/state. The documented Home automation voice starter matches a query, and the IFTTT V2 route activates a named scene. Those mechanisms do not establish arbitrary dictation capture with the variable text passed into this app.

Do not promise a direct interception of Google's generic shopping or remember commands. Android Assistant App Actions are a different integration surface; their documentation does not prove compatibility with the user's phone Gemini setup or with Home speakers.

The user specifically proposed a Google Home "skill". Rechecked current public documentation on 2026-09-25: Conversational Actions were the closest equivalent to an Alexa custom skill; their retirement also affects named conversations, not just interception of generic commands. The current cloud-to-cloud integration targets devices and their supported commands. No current public route was found that establishes a custom Home speaker conversation passing arbitrary note/shopping text to our service.

A narrower experiment remains possible: a configured phrase such as "restock toothbrush heads" could trigger a known action through a scene/device automation bridge. That handles a predefined item or chore, but does not establish capture of previously unknown words after "remember" or "add". Choosing friendlier wording does not itself supply a variable-text interface. Phone App Actions remain a separate feasibility investigation.

Sources: [Conversational Actions sunset](https://developers.google.com/assistant/ca-sunset), [Cloud-to-cloud intents](https://developers.home.google.com/cloud-to-cloud/primer/intents), [OkGoogleEvent](https://developers.home.google.com/automations/schema/reference/entity/assistant/ok_google_event), [IFTTT scene triggers](https://help.ifttt.com/hc/en-us/articles/12203345427227-How-to-Use-Routines-in-Google-Assistant-V2-Without-Saying-Activate).

### Notes, lists, and remembering are distinct

Google documents Gemini mobile note/list creation through supported apps, including adding items to named Google Keep lists. Google Home's note instructions also use Keep. In contrast, the older Assistant's "remember that" command has its own remembered-information feature; its help page points Gemini for Home users to Ask Home. A memory acknowledgement does not prove a Keep note, Google Task, or app inbox item was created.

Sources: [Gemini notes and lists](https://support.google.com/gemini/answer/15230597?hl=en), [Home notes](https://support.google.com/googlehome/answer/16722557?hl=en-GB), [Assistant remembering](https://support.google.com/googlehome/answer/7536723?hl=en), [Gemini for Home supported services](https://support.google.com/googlehome/answer/16709732?hl=en).

### Candidate A: Google Keep as a voice capture channel

Proposed flow: Google voice creates items in designated Keep lists; an importer copies capture events into our app's shopping list or inbox. A named list such as Household Inbox could provide a more predictable destination than the generic remember phrase. Exact wording still requires testing.

Google's official Keep API is documented for enterprise administration and domain delegation, not the ordinary consumer OAuth integration we would want. The independent gkeepapi library offers unofficial access. This makes a consumer Keep bridge a feasibility experiment with maintenance/authentication risk, not a verified supported integration.

If explored, start with selected-list ingestion. Preserve source IDs and detect re-additions after completion; handle retries without duplicating purchases, and retain source material while verifying import. Decide later whether any purchase completion should be mirrored back to Keep. A one-way import does not keep Google's spoken shopping-list readback consistent with check-offs made in our app.

Google's spoken confirmation would confirm the Google-side operation, not necessarily arrival in our app. The bridge would inherit Keep availability and sync behaviour, which is especially relevant because the user already experiences Keep sync issues.

Sources: [Keep API overview](https://developers.google.com/workspace/keep/api/guides), [gkeepapi project](https://github.com/kiwiz/gkeepapi).

### Candidate B: Google Tasks as an officially supported intermediary

Google documents creating tasks/reminders by voice on Home devices, and Google Tasks has an official authenticated API for tasks and task lists. This provides a plausible route for importing deliberately selected voice-created tasks into the app. It does not establish that shopping-list commands or generic remember commands create Tasks.

Test whether an acceptable phrase creates a task without an unwanted time prompt, which task list receives it, how to distinguish household captures from unrelated work/personal tasks, and how both people's accounts behave. The Home help page also lists regional limits for some AI-supported Assistant actions. Do not assume identical phone and speaker behaviour.

Sources: [Voice-created Google Tasks](https://support.google.com/googlehome/answer/16722329?hl=en), [Tasks API](https://developers.google.com/workspace/tasks/reference/rest), [Tasks quickstart prerequisites](https://developers.google.com/workspace/tasks/quickstart/python).

### Candidate C: Home Assistant Assist for custom speech handling

Home Assistant is a separate system from Google Assistant. Its Assist supports custom sentences with wildcard values, built-in shopping-list phrases, and actions that can call a service. Its REST command integration can connect such an action to an authenticated app endpoint. For example, a custom "remember {text}" intent could create an inbox entry after the wake word.

This route would give us control over both the variable text and the app's acknowledgement. It does not automatically turn a Google Home speaker into an Assist microphone. It requires a Home Assistant installation and a compatible voice client.

Android can use Assist through the companion app or a home-screen shortcut. Optional hands-free wake-word detection is documented as experimental, requires Assist as the default assistant, and consumes more battery than Google's wake-word handling. It uses wake words such as Hey Nabu or Hey Jarvis, not a promised replacement route behind Hey Google. No new microphone is required to explore the app/shortcut path on a phone, but the Home Assistant backend is still required.

Sources: [Custom sentences and wildcard slots](https://www.home-assistant.io/voice_control/custom_sentences), [Built-in sentences](https://www.home-assistant.io/voice_control/builtin_sentences), [REST commands](https://www.home-assistant.io/integrations/rest_command/), [Assist on Android](https://www.home-assistant.io/voice_control/android/).

### Candidate D: a custom Alexa skill calling our app

Amazon currently documents original Alexa custom skills, including invocation with an app name and short flexible phrase capture through AMAZON.SearchQuery. Proposed utterances to implement and test:

- "Alexa, tell Our Place to remember the spare key is in the blue drawer."
- "Alexa, ask Our Place to add toothbrush heads to shopping."
- "Alexa, tell Our Place to save an app suggestion: make the shopping text bigger."

These are proposed commands, not an existing skill. The invocation name needs testing for recognition. Separate intents would distinguish inbox, shopping, and app feedback; flexible text would be captured after a fixed carrier phrase such as "remember". Phrase capture supports short open-ended input, but should not be presented as guaranteed unrestricted long-form transcription.

A skill can call our app's service directly and acknowledge after the app stores the item. This avoids the consumer Keep bridge. Original Alexa's skill path does not require Alexa+; Amazon's documentation still supports creating skills for original Alexa. If a device/account is on Alexa+, confirm custom-skill access separately rather than assuming automatic compatibility.

Amazon lists all versions of Echo and Echo Dot among devices capable of launching custom skills through Quick Links. This supports testing the existing older hardware before any purchase, but does not verify these particular devices' setup, network access, or account eligibility. Amazon documents development testing on an Echo registered to the developer account, with a matching skill/device locale. Begin with that controlled test; establish access for both people afterward. No device reset or account change is currently requested.

The built-in phrase "Alexa, add milk to my shopping list" is a separate issue: Amazon ended List skills and the List Management REST API on July 1, 2024. Do not design around reading or intercepting Alexa's built-in lists through that retired interface. Alexa documents some name-free invocation, but that does not guarantee interception of built-in shopping or remembering commands. The explicit skill name is the defensible starting point.

Sources: [Custom skill invocation](https://developer.amazon.com/en-US/docs/alexa/custom-skills/understanding-how-users-invoke-custom-skills.html), [Phrase slot reference](https://developer.amazon.com/en-US/docs/alexa/custom-skills/slot-type-reference.html), [Custom skill build process](https://developer.amazon.com/en-US/docs/alexa/custom-skills/steps-to-build-a-custom-skill.html), [Original Alexa and Alexa+ developer paths](https://developer.amazon.com/en-US/blogs/alexa/alexa-skills-kit/2025/02/new-alexa-announce-blog), [Supported devices for skill launch](https://developer.amazon.com/en-US/docs/alexa/custom-skills/create-a-quick-link-for-your-skill.html), [Development testing on a device](https://developer.amazon.com/en-US/docs/alexa/test/test-your-skill-overview.html), [Retired List Management API](https://developer.amazon.com/en-US/docs/alexa/ask-overviews/deprecated-features.html).

### Android phone capture alongside Alexa

Amazon documents invoking custom skills through the Alexa mobile app. Test our invocation name there as well as on an Echo; a conflicting installed app name can affect invocation. This does not establish always-listening access while the phone is locked or Alexa is closed. Source: [Custom skill invocation](https://developer.amazon.com/en-US/docs/alexa/custom-skills/understanding-how-users-invoke-custom-skills.html).

Three Android options serve different interactions:

| Option | Role in this app |
| --- | --- |
| Keyboard dictation, such as Gboard's microphone | Useful when already editing a text field; the user focuses the field and taps the keyboard microphone. |
| RecognizerIntent.ACTION_RECOGNIZE_SPEECH | A simple prototype can launch the installed recogniser's speech prompt and receive text; availability and interface depend on its handler. |
| SpeechRecognizer | Leading candidate for our own compact listening screen, started from the widget, with a large stop control and our save feedback. |

SpeechRecognizer uses an installed recognition service and exposes startListening, stopListening, and final-result/error callbacks. It requires microphone permission. The recogniser may end a session automatically; a stop button does not guarantee unlimited listening through pauses. On Android 12/API 31 onward, createOnDeviceSpeechRecognizer and an availability check support a local route where available; device/language/model support still needs testing. The default service can use remote processing. An offline preference on an intent is not an offline guarantee.

Proposed flow: launch a small foreground capture activity, play a ready cue, accept speech, stop automatically or on a tap, store the final transcript, then read back the captured words and storage state. Android's TextToSpeech API is a candidate for that readback. Do not create entries from partial results. For premature stopping, Continue speaking should append to the same capture rather than make a second item; Re-record, Edit text, and Undo are other proposed correction controls. Stop readback before listening again to avoid capturing the app's own speech. Do not require a visual review or spoken confirmation on every successful capture. For upload failures after recognition, retain a local pending transcript and describe it as pending sync; never announce shared success when nothing was stored. Test silence timeout, speech output, headphones, and accidental double taps on the actual phone.

This uses Android speech recognition independently of an assistant conversation. It requires a native Android component even if the broader app shares a web interface. No speech model, paid transcription service, or framework has been selected.

Sources: [Gboard voice typing](https://support.google.com/gboard/answer/2781851?hl=en), [RecognizerIntent](https://developer.android.com/reference/android/speech/RecognizerIntent), [SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer), [Widget activity actions](https://developer.android.com/develop/ui/compose/glance/user-interaction), [TextToSpeech](https://developer.android.com/reference/android/speech/tts/TextToSpeech).

### Lock-screen capture and Android phone shortcuts

Unlocking is not established as an unavoidable requirement. Android's setShowWhenLocked lets an activity remain visible above the lock screen. Its Quick Settings tile guide describes launching a safe activity above the lock screen and using unlockAndRun for actions that require authentication. These are documented building blocks, not proof of end-to-end microphone access on the user's phone or an arbitrary screen-off button binding.

Prototype a capture-only activity and a Quick Settings tile, then test gesture/button launch options exposed by the user's OxygenOS version. The locked screen should permit a new capture, readback, and correction of that session only; leaving it should not expose the existing inbox, private gifts, or app navigation. Permission setup happens while unlocked. Preserve the normal device lock; do not solve this by weakening wallet/device security. Verify locked versus unlocked and screen-off behaviour separately.

The official Android phone product page documents long-pressing the Plus Key to record an audio memo of up to 60 seconds into Mind Space. That is evidence for Android phone's own capture feature, not a documented binding to our app or an API to import its transcript. Arbitrary Plus Key remapping and its locked behaviour remain unverified; do not make it a dependency of the first implementation.

Sources: [Activity.setShowWhenLocked](https://developer.android.com/reference/android/app/Activity#setShowWhenLocked(boolean)), [Quick Settings on locked devices](https://developer.android.com/develop/ui/views/quicksettings-tiles), [Android phone and Plus Key](https://www.oneplus.com/us/15).

### Private hosting with a bridge for Alexa

The user proposes trusted home-network access and Tailscale when away. Candidate deployment: a home app reachable on the LAN and through Tailscale by paired phones/computers. Tailscale Serve can provide a private HTTPS entrance; use tailnet access rules. Person/device identity remains useful for personalised views and gift privacy even when repeated login is unnecessary. Do not treat Wi-Fi presence as speaker identity or automatically share private records.

Alexa skills run through Amazon's cloud. A speaker being on the same home network does not give Amazon's skill service direct access to a LAN or private tailnet address. Proposed route: Echo or Alexa phone app -> Amazon Alexa -> our AWS Lambda skill handler -> Tailscale -> home capture API. Amazon documents a Lambda skill endpoint, and Tailscale documents Lambda access through userspace networking; combining them here is a proposed architecture, not a tested integration.

Keep the bridge limited to capture operations and the intended household. Verify the Alexa skill ID and authorised household account(s), use a restricted app credential, and deduplicate request retries. Skill ID verification alone does not identify the household. Test Lambda/Tailscale startup latency, revocation, and failure when the home server is unavailable before promising a spoken saved confirmation. No public exposure of the whole app is needed by this proposed route. A capture stored only in an intermediary must be described as queued, not already saved at home.

Sources: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Alexa Lambda hosting](https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-an-aws-lambda-function.html), [Tailscale on AWS Lambda](https://tailscale.com/docs/install/cloud/aws/aws-lambda).

## Older Google speaker and Gemini for Home

Google currently lists the original Google Home, Google Home Max, first-generation Home Mini, and first-generation Nest Hub among devices with some or full Gemini for Home support. Availability depends on model, firmware, country/language, and rollout. Canada is listed for early access; this does not verify the user's account or device eligibility. Google also states that upgrading the home to Gemini for Home cannot be reversed. Do not recommend buying a new speaker or upgrading the household as a prerequisite to the initial phone experiment.

Source: [Gemini for Home availability and compatible devices](https://support.google.com/googlehome/answer/16618650?hl=en).

## Proposed experiments before committing to an integration

These are proposed next steps; no accounts, cloud resources, skill, or Android app have been created.

1. Prototype a small Alexa skill writing inbox and shopping entries to a minimal app service. Test one existing speaker, invocation name, locale/account access, short notes, quantities, and acknowledgment after storage. Establish access for both people afterward.
2. Prototype Android capture on the probable Android phone. Test the widget and Quick Settings entrances, available gesture/button bindings, locked and screen-off operation, automatic stop and manual stop, spoken readback, and continuing a prematurely ended capture. Keep the device lock enabled. Check recognition availability, language, first-use permission, and ready/pending/saved/error states.
3. Test the same Alexa skill through the Alexa mobile app. Record which steps require opening/unlocking the phone instead of assuming background wake-word access.
4. Exercise LAN and Tailscale access plus the proposed Alexa Lambda-to-tailnet bridge. Test retries, duplicate events, recognition failures, startup latency, and loss of connectivity. Verify that a captured transcript survives an upload failure and that confirmations accurately distinguish pending from shared storage.
5. Revisit Google intermediaries or Home Assistant only if the selected routes leave an important unmet need. No hardware purchase is a prerequisite for these initial tests.

Whatever capture source is chosen, the app should accept a small authenticated capture request with destination, original text, source, and a stable source event identifier. Store the capture before acknowledging it. Voice integrations remain replaceable; core shopping and inbox features should also work directly in the app.
