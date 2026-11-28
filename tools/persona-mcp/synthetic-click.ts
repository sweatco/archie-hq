/**
 * Sends a button click to an instance as a signed request, without Slack in between.
 *
 * It exercises the handler's own checks, including who is allowed to press the button. It
 * does not show that Slack displayed the button to that member, so every result says it is
 * synthetic. It needs the instance to run the HTTP receiver; in Socket Mode nothing listens.
 */

import {
  buttonClickInteraction,
  signedInteractionRequest,
  type ButtonClick,
} from './slack-signing.js';

export interface SyntheticClickResult {
  synthetic: true;
  httpStatus: number;
  outcome: 'acknowledged' | 'no_listener' | 'rejected' | 'failed';
  note: string;
}

const NOTES: Record<SyntheticClickResult['outcome'], string> = {
  acknowledged: 'a handler acknowledged the click; read the conversation to see what it did',
  no_listener:
    'no handler claimed this action, or the instance has no HTTP receiver at the webhook URL',
  rejected: 'the instance refused the signature or its own Slack authorization failed',
  failed: 'the instance failed while processing the click',
};

function classify(httpStatus: number): SyntheticClickResult['outcome'] {
  if (httpStatus >= 200 && httpStatus < 300) return 'acknowledged';
  if (httpStatus === 404) return 'no_listener';
  if (httpStatus === 401) return 'rejected';
  return 'failed';
}

export async function sendSyntheticClick(
  target: { webhookUrl: string; signingSecret: string },
  click: ButtonClick,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  send: typeof fetch = fetch,
): Promise<SyntheticClickResult> {
  const request = signedInteractionRequest(
    target.signingSecret,
    nowSeconds,
    buttonClickInteraction(click, nowSeconds),
  );
  const response = await send(target.webhookUrl, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(10_000),
  });
  const outcome = classify(response.status);
  return { synthetic: true, httpStatus: response.status, outcome, note: NOTES[outcome] };
}
