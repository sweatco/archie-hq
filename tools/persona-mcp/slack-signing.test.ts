import { describe, it, expect } from 'vitest';
import { isValidSlackRequest } from '@slack/bolt';
import {
  buttonClickInteraction,
  signedEventRequest,
  signedInteractionRequest,
  slackSignature,
  type SignedSlackRequest,
} from './slack-signing.js';

const SECRET = 'test-signing-secret';
const NOW_SECONDS = 1_800_000_000;

/** Ask Bolt, the library the instance runs, whether it would accept the request. */
function boltAccepts(request: SignedSlackRequest, signingSecret = SECRET): boolean {
  return isValidSlackRequest({
    signingSecret,
    body: request.body,
    headers: {
      'x-slack-signature': request.headers['x-slack-signature'],
      'x-slack-request-timestamp': Number(request.headers['x-slack-request-timestamp']),
    },
    nowMilliseconds: NOW_SECONDS * 1000,
  });
}

describe('signed Slack requests', () => {
  it('produces an event request that Bolt accepts', () => {
    const request = signedEventRequest(SECRET, NOW_SECONDS, {
      type: 'url_verification',
      challenge: 'abc',
    });
    expect(request.headers['content-type']).toBe('application/json');
    expect(boltAccepts(request)).toBe(true);
  });

  it('produces an interaction request that Bolt accepts and can parse', () => {
    const click = buttonClickInteraction(
      {
        teamId: 'T0TEST00001',
        userId: 'U0ALICE0001',
        channelId: 'D0ALICE0001',
        messageTs: '1800000000.000100',
        actionId: 'approve_memory_preference',
        value: 'task-1',
      },
      NOW_SECONDS,
    );
    const request = signedInteractionRequest(SECRET, NOW_SECONDS, click);
    expect(boltAccepts(request)).toBe(true);
    const payload = new URLSearchParams(request.body).get('payload');
    expect(JSON.parse(payload ?? '')).toMatchObject({
      type: 'block_actions',
      user: { id: 'U0ALICE0001' },
      actions: [{ action_id: 'approve_memory_preference', value: 'task-1' }],
    });
  });

  it('is rejected by Bolt under another secret, a changed body or a stale timestamp', () => {
    const request = signedEventRequest(SECRET, NOW_SECONDS, { type: 'url_verification' });
    expect(boltAccepts(request, 'another-secret')).toBe(false);
    expect(boltAccepts({ ...request, body: `${request.body} ` })).toBe(false);
    const stale = signedEventRequest(SECRET, NOW_SECONDS - 600, { type: 'url_verification' });
    expect(boltAccepts(stale)).toBe(false);
  });

  it('signs the exact bytes of the body with the timestamp', () => {
    expect(slackSignature(SECRET, NOW_SECONDS, 'a=1')).toMatch(/^v0=[0-9a-f]{64}$/);
    expect(slackSignature(SECRET, NOW_SECONDS, 'a=1')).not.toBe(
      slackSignature(SECRET, NOW_SECONDS + 1, 'a=1'),
    );
  });
});
