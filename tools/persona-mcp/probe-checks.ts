/**
 * The decisions behind the persona probes, kept free of Slack and network calls so each
 * verdict can be tested from a recorded observation.
 */

export interface Authorship {
  user: boolean;
  botId: boolean;
  appId: boolean;
  botProfile: boolean;
  clientMsgId: boolean;
  subtype: string | null;
  /** Whether Archie's proactivity would treat this message as bot-authored. */
  proactivityTreatsAsBot: boolean;
}

/**
 * Report which authorship markers a Slack message carries.
 *
 * `proactivityTreatsAsBot` repeats the `bot` predicate of `normalizeSlackSource` in
 * src/proactivity/slack.ts, because that is the rule a persona's message has to pass.
 * probe-checks.test.ts compares the two on the same payloads, so a change there fails here.
 */
export function describeAuthorship(message: Record<string, unknown>): Authorship {
  const botId = typeof message.bot_id === 'string';
  const appId = typeof message.app_id === 'string';
  const botProfile = Boolean(message.bot_profile);
  const subtype = typeof message.subtype === 'string' ? message.subtype : null;
  return {
    user: typeof message.user === 'string',
    botId,
    appId,
    botProfile,
    clientMsgId: typeof message.client_msg_id === 'string',
    subtype,
    proactivityTreatsAsBot:
      botId || appId || botProfile || subtype === 'bot_message' || message.user === 'USLACKBOT',
  };
}

const SLACK_ID = /^[A-Z][A-Z0-9]{8,}$/;

/** Copy a payload with every Slack ID reduced to its type letter, so it can be shared. */
export function redactSlackIds(value: unknown): unknown {
  if (typeof value === 'string') return SLACK_ID.test(value) ? `${value[0]}…` : value;
  if (Array.isArray(value)) return value.map(redactSlackIds);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, redactSlackIds(inner)]),
    );
  }
  return value;
}

export type HttpObservation =
  | { kind: 'response'; status: number; contentType: string | null; redirectHost: string | null }
  | { kind: 'network_error'; message: string };

export type ReachVerdict =
  | { reach: 'open'; detail: string }
  | { reach: 'gated'; detail: string }
  | { reach: 'unreachable'; detail: string };

/** Classify whether the instance's task API can be used from this machine, and what stands in the way. */
export function interpretReach(health: HttpObservation, tasks: HttpObservation): ReachVerdict {
  for (const [name, observation] of [
    ['/health', health],
    ['/api/tasks', tasks],
  ] as const) {
    if (observation.kind === 'network_error') {
      return { reach: 'unreachable', detail: `${name}: ${observation.message}` };
    }
    if (observation.redirectHost) {
      return { reach: 'gated', detail: `${name} redirects to a sign-in host` };
    }
    if (observation.status === 401 || observation.status === 403) {
      return { reach: 'gated', detail: `${name} answered ${observation.status}` };
    }
    if (observation.status !== 200) {
      return { reach: 'unreachable', detail: `${name} answered ${observation.status}` };
    }
  }
  if (tasks.kind === 'response' && !tasks.contentType?.includes('json')) {
    return {
      reach: 'gated',
      detail: '/api/tasks answered 200 without JSON, likely a sign-in page',
    };
  }
  return { reach: 'open', detail: '/health and /api/tasks answered 200' };
}

export interface WebhookObservation {
  /** A correctly signed `url_verification`, which Bolt answers by echoing the challenge. */
  verification: { status: number; echoedChallenge: boolean };
  /** The same request with a wrong signature. */
  tampered: { status: number };
  /** A correctly signed `block_actions` for an action no handler claims. */
  button: { status: number };
}

export interface WebhookVerdict {
  /** False when nothing answers Slack requests at this URL, as in Socket Mode. */
  receiverPresent: boolean;
  signatureAccepted: boolean;
  signatureEnforced: boolean;
  interactionAccepted: boolean;
  detail: string;
}

/**
 * Decide whether signed synthetic interactions are usable against the instance.
 * Bolt answers 401 to a bad signature, and also when its own bot token fails authorization,
 * and 500 when processing throws. A signed click that passes both reaches the listeners: an
 * unclaimed action then ends as 404 once the acknowledgement window passes.
 */
export function interpretWebhook(observation: WebhookObservation): WebhookVerdict {
  // Bolt never answers 404 to `url_verification`: a mounted receiver says 200 or 401.
  const receiverPresent = observation.verification.status !== 404;
  const signatureAccepted =
    observation.verification.status === 200 && observation.verification.echoedChallenge;
  const signatureEnforced = observation.tampered.status === 401;
  const buttonStatus = observation.button.status;
  const buttonReachedListeners =
    buttonStatus === 404 || (buttonStatus >= 200 && buttonStatus < 300);
  const interactionAccepted = signatureAccepted && buttonReachedListeners;
  const detail = [
    `signed url_verification: ${observation.verification.status}${observation.verification.echoedChallenge ? ', challenge echoed' : ', no echo'}`,
    `wrong signature: ${observation.tampered.status}`,
    `signed block_actions: ${observation.button.status}`,
  ].join('; ');
  return { receiverPresent, signatureAccepted, signatureEnforced, interactionAccepted, detail };
}
