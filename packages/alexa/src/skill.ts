import { createHash } from 'node:crypto';
import { CaptureRequest, OutcomeSchema, isValid, type CommandOutcome } from '@our-place/contracts';

/** Implementations must return only a validated response from the household server. */
export type CaptureSink = (bindingId: string, capture: CaptureRequest) => Promise<CommandOutcome>;
export type AlexaBinding = { bindingId: string; expectedServerEpoch: string };
export type SkillOptions = {
  skillId: string;
  /** Exact Alexa user IDs, never a display name or the spoken person's name. */
  users: ReadonlyMap<string, AlexaBinding>;
  capture: CaptureSink;
  now?: () => number;
  locales?: readonly string[];
  /** The first trial captures inbox notes only; shopping needs an explicit opt-in. */
  shoppingEnabled?: boolean;
};
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
const boundedString = (value: unknown, max = 1000): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const noteInstructions = 'Say remember, followed by a short note.';
const uncertain = "I couldn't confirm whether that was saved. Please check Our Place before repeating it.";
export type AlexaResponse = {
  version: '1.0';
  response: {
    outputSpeech?: { type: 'PlainText'; text: string };
    reprompt?: { outputSpeech: { type: 'PlainText'; text: string } };
    shouldEndSession: boolean;
  };
};
function say(text: string, reprompt?: string): AlexaResponse {
  return {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      shouldEndSession: reprompt === undefined,
      ...(reprompt ? { reprompt: { outputSpeech: { type: 'PlainText' as const, text: reprompt } } } : {}),
    },
  };
}

/** Stable across delivery retries; changing transcript/intent cannot manufacture a new key. */
export function captureOperationId(skillId: string, userId: string, requestId: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['alexa-capture-v1', skillId, userId, requestId]))
    .digest('hex');
}

/**
 * Lambda event handler only. Do not expose this as an unsigned public HTTP webhook.
 * The Lambda ASK trigger must independently restrict invocation to this skill ID.
 */
export function createAlexaHandler(options: SkillOptions) {
  if (!boundedString(options.skillId) || options.users.size === 0)
    throw new Error('Alexa requires an explicit skill ID and authorized account map');
  const users = new Map(options.users);
  const locales = new Set(options.locales ?? ['en-CA', 'en-US']);
  const shoppingEnabled = options.shoppingEnabled === true;
  const instructions = shoppingEnabled
    ? `${noteInstructions} Or say add to shopping, followed by an item.`
    : noteInstructions;
  for (const binding of users.values()) {
    if (
      !boundedString(binding.bindingId) ||
      !isValid(CaptureRequest, {
        operationId: 'validation',
        expectedServerEpoch: binding.expectedServerEpoch,
        capturedAt: 0,
        destination: 'inbox',
        text: 'validation',
      })
    )
      throw new Error('Invalid Alexa binding');
  }
  return async (event: unknown): Promise<AlexaResponse> => {
    const envelope = object(event),
      system = object(object(envelope?.context)?.System);
    const session = object(envelope?.session),
      request = object(envelope?.request);
    const skillId = object(system?.application)?.applicationId;
    const userId = object(system?.user)?.userId;
    // Alexa account identity is not speaker recognition. A shared speaker uses its account binding.
    if (
      envelope?.version !== '1.0' ||
      skillId !== options.skillId ||
      !boundedString(userId) ||
      !users.has(userId)
    )
      return say('This Alexa account is not connected to Our Place.');
    if (
      session &&
      (object(session.application)?.applicationId !== skillId || object(session.user)?.userId !== userId)
    )
      return say('I could not verify this request.');
    if (!request || !boundedString(request.requestId) || !boundedString(request.timestamp))
      return say('I could not verify this request.');
    const capturedAt = Date.parse(request.timestamp);
    if (
      !Number.isSafeInteger(capturedAt) ||
      capturedAt < 0 ||
      Math.abs((options.now ?? Date.now)() - capturedAt) > 150_000
    )
      return say('That request has expired. Please start again.');
    if (request.type === 'SessionEndedRequest')
      return { version: '1.0', response: { shouldEndSession: true } };
    if (typeof request.locale !== 'string' || !locales.has(request.locale))
      return say('This language is not configured for Our Place yet.');
    if (request.type === 'LaunchRequest') return say(`Welcome to Our Place. ${instructions}`, instructions);
    const intent = object(request.intent);
    if (request.type !== 'IntentRequest' || !intent) return say(instructions, instructions);
    if (intent.name === 'AMAZON.StopIntent' || intent.name === 'AMAZON.CancelIntent') return say('Okay.');
    if (intent.name === 'AMAZON.HelpIntent' || intent.name === 'AMAZON.FallbackIntent')
      return say(instructions, instructions);
    const destination =
      intent.name === 'RememberIntent' ? 'inbox'
        : shoppingEnabled && intent.name === 'AddShoppingIntent' ? 'shopping' : null;
    if (!destination) return say(instructions, instructions);
    const slot = object(object(intent.slots)?.Text);
    const text = typeof slot?.value === 'string' ? slot.value.trim() : '';
    // Never silently truncate, infer quantities, split a list, or execute text as markup.
    if (!text) return say(instructions, instructions);
    const limit = destination === 'shopping' ? 300 : 1000;
    if (text.length > limit)
      return say('That is too long for this capture. Please use a shorter phrase or the app.', instructions);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text))
      return say('I could not read that phrase. Please try again.', instructions);
    const binding = users.get(userId)!;
    const capture: CaptureRequest = {
      operationId: captureOperationId(options.skillId, userId, request.requestId),
      expectedServerEpoch: binding.expectedServerEpoch,
      capturedAt,
      destination,
      text,
    };
    try {
      const outcome = await options.capture(binding.bindingId, capture);
      if (!isValid(OutcomeSchema, outcome)) return say(uncertain);
      if (outcome.status === 'Applied' && outcome.receipt.operationId === capture.operationId)
        return say(
          destination === 'inbox'
            ? `Saved to your shared inbox: ${text}`
            : `Added to shared shopping: ${text}`,
        );
      if (outcome.status === 'RecoveryRequired')
        return say(
          'Our Place needs its voice connection checked after a restore. Please use the app for now.',
        );
      // No optimistic success, no cloud queue, and no automatic re-keying/repetition.
      return say(uncertain);
    } catch {
      // Do not log an event, transcript, endpoint, account ID, or transport error containing a credential.
      return say(uncertain);
    }
  };
}
