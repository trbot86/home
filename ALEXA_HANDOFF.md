# Alexa integration checkpoint

2026-09-27. This is a disabled, schema-free foundation for a separate Alexa development task. No Alexa skill, AWS resource, credential, public endpoint or live household record has been created. Skill/account/device recognition and phrase routing remain untested. Transport, capture-only authentication, provisioning, a server command adapter and deployment are **not implemented**.

This document records the imported checkpoint. Subsequent inbox-only defaults,
primary-documentation findings and the proposed isolated setup sequence are in
[ALEXA_NOTE_TRIAL.md](ALEXA_NOTE_TRIAL.md).

## Existing code

- `packages/alexa/src/skill.ts`: pure Lambda-style event handler behind a `CaptureSink` port. Explicit skill ID and Alexa account allowlist, account-to-binding mapping, timestamp/locale checks, short inbox and shopping phrases, plain-text readback only after a matching validated Applied receipt. It does not infer speaker identity from the account, split shopping phrases, or silently truncate text.
- `packages/contracts/src/capture.ts`: narrow request shape without person, scope, list or arbitrary command parameters. The server must select those from its authorized binding. The original request ID determines a stable operation ID; delivery retries retain it even if payload changes. This requires server-side digest conflict checking and durable receipts; the handler alone cannot provide deduplication.
- `packages/alexa/interaction-models/en-CA.json`: proposed invocation `our place`, `remember {Text}` and `add to shopping {Text}` (plus alternatives). Each capture intent has one `AMAZON.SearchQuery` slot and carrier phrases. It has not been submitted to Amazon's model builder. The same handler also allows en-US, but only the en-CA model is included.
- Five isolated tests cover acknowledgement ordering, deterministic IDs, account/skill rejection, timestamp/locale checks, invalid input, plain-text output, failure/restore responses, and model carrier structure. A fake sink is used; these are not server or Amazon end-to-end tests.

The package is included by the existing `packages/*` workspace rule. Its lockfile importer uses only the existing contracts dependency. With workspace dependencies installed, run `pnpm --filter @our-place/alexa typecheck` and `pnpm --filter @our-place/alexa test`.

## Findings and remaining decisions

Amazon's phrase-slot documentation supports SearchQuery in English (CA) and requires a carrier phrase in intent samples. It allows one phrase slot per intent and disallows combining it with another slot in the same sample. This is flexible short phrase capture, not a guarantee of unrestricted long-form dictation. Test recognition of the invocation, pauses, quantities and unusual names on the actual account/device. [Amazon phrase-slot reference](https://developer.amazon.com/en-US/docs/alexa/custom-skills/slot-type-reference.html#amazonsearchquery).

Use a Lambda Alexa Skills Kit trigger restricted to the exact skill ID. The handler also checks it, but is **not** an HTTP signature verifier; do not expose this function through an unsigned public webhook. Account allowlisting is separately required because a skill ID alone does not identify the household. [Amazon Lambda endpoint and trigger instructions](https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-an-aws-lambda-function.html).

Begin the visible task with note-taking and frequent user interaction: establish the developer/Amazon account, speaker locale, acceptable invocation name, and first on-device phrase trial. Shopping is secondary and can be omitted from the first trial. Do not promise a finished integration from these unit tests.

The home server remains private. Next design the capture-only credential and network bridge before any deployment: Alexa's cloud cannot access a private tailnet merely because the speaker is at home. Do not give Lambda a broad Android credential. Existing clients accept only browser/android kinds; adding an integration kind would need a deliberate schema/access design. No migration was changed here. Coordinate any schema work with the main development task; migrations 001–006 are already deployed and immutable.

The future sink should pin the authorized server epoch, use existing WriteCoordinator idempotency/receipt semantics, map capture only to CreateInboxEntry or AddShoppingEntry, and refuse private scopes. Never automatically adopt a restored epoch or create a new key after an ambiguous save. Bound transport timeouts below the skill response window. Current failure speech tells the user to check the app before repeating; nothing is queued in the cloud. A new spoken command has a new request ID and may create a second entry, even with identical text.

Keep account IDs, tokens, private addresses, deployment settings and device test transcripts in ignored local files. No build/deploy helper is present and no public setup decision has been made.
