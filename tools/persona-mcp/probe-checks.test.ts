import { describe, it, expect, vi } from 'vitest';

// normalizeSlackSource is imported only to pin describeAuthorship to the rule it mirrors; its
// Slack client and task dependencies are irrelevant to that rule and are stubbed out.
vi.mock('../../src/connectors/slack/client.js', () => ({
  getBotId: () => 'B0ARCHIE001',
  getBotUserId: () => 'U0ARCHIE001',
  extractMessageContent: (raw: Record<string, unknown>) =>
    Promise.resolve({ text: typeof raw.text === 'string' ? raw.text : '' }),
}));
vi.mock('../../src/tasks/task.js', () => ({ getActiveTaskIds: () => [], getTask: () => null }));

import { normalizeSlackSource } from '../../src/proactivity/slack.js';
import {
  describeAuthorship,
  interpretReach,
  interpretWebhook,
  redactSlackIds,
  type HttpObservation,
} from './probe-checks.js';

const base = { ts: '1800000000.000100', text: 'hello' };
const samples: Array<{ name: string; message: Record<string, unknown>; bot: boolean }> = [
  { name: 'a member typing in a client', bot: false, message: { ...base, user: 'U0ALICE0001' } },
  {
    name: 'a member with a client message id',
    bot: false,
    message: { ...base, user: 'U0ALICE0001', client_msg_id: 'a-b-c' },
  },
  {
    name: 'a user-token post stamped with bot_id',
    bot: true,
    message: { ...base, user: 'U0ALICE0001', bot_id: 'B0PERSONA01' },
  },
  {
    name: 'a post stamped with app_id only',
    bot: true,
    message: { ...base, user: 'U0ALICE0001', app_id: 'A0PERSONA01' },
  },
  {
    name: 'a post carrying a bot profile only',
    bot: true,
    message: { ...base, user: 'U0ALICE0001', bot_profile: { name: 'Personas' } },
  },
  {
    name: 'a legacy bot_message',
    bot: true,
    message: { ...base, subtype: 'bot_message', bot_id: 'B0HOOK00001' },
  },
  { name: 'Slackbot', bot: true, message: { ...base, user: 'USLACKBOT' } },
];

describe('describeAuthorship', () => {
  it.each(samples)('classifies $name', ({ message, bot }) => {
    expect(describeAuthorship(message).proactivityTreatsAsBot).toBe(bot);
  });

  it.each(samples)('agrees with proactivity on $name', async ({ message }) => {
    const normalized = await normalizeSlackSource(message, 'C0PROBE0001');
    expect(normalized?.bot).toBe(describeAuthorship(message).proactivityTreatsAsBot);
  });

  it('reports each marker separately', () => {
    expect(
      describeAuthorship({ ...base, user: 'U0ALICE0001', bot_id: 'B0PERSONA01', app_id: 'A1' }),
    ).toEqual({
      user: true,
      botId: true,
      appId: true,
      botProfile: false,
      clientMsgId: false,
      subtype: null,
      proactivityTreatsAsBot: true,
    });
  });
});

describe('redactSlackIds', () => {
  it('reduces Slack IDs to their type letter at any depth and keeps everything else', () => {
    const payload = {
      user: 'U0ALICE0001',
      team: 'T0TEST00001',
      ts: '1800000000.000100',
      text: '[persona-probe E2E-1a2b3c4d] hello',
      bot_profile: { id: 'B0PERSONA01', name: 'Archie Test Personas', deleted: false },
      reactions: [{ name: 'eyes', users: ['U0ARCHIE001'], count: 1 }],
    };
    expect(redactSlackIds(payload)).toEqual({
      user: 'U…',
      team: 'T…',
      ts: '1800000000.000100',
      text: '[persona-probe E2E-1a2b3c4d] hello',
      bot_profile: { id: 'B…', name: 'Archie Test Personas', deleted: false },
      reactions: [{ name: 'eyes', users: ['U…'], count: 1 }],
    });
  });
});

const ok: HttpObservation = {
  kind: 'response',
  status: 200,
  contentType: 'application/json; charset=utf-8',
  redirectHost: null,
};

describe('interpretReach', () => {
  it('is open when both endpoints answer 200 and the task list is JSON', () => {
    expect(interpretReach(ok, ok)).toMatchObject({ reach: 'open' });
  });

  it('is unreachable on a network error or an unexpected status', () => {
    const refused: HttpObservation = { kind: 'network_error', message: 'connect ETIMEDOUT' };
    expect(interpretReach(refused, refused)).toEqual({
      reach: 'unreachable',
      detail: '/health: connect ETIMEDOUT',
    });
    expect(interpretReach(ok, { ...ok, status: 502 })).toMatchObject({ reach: 'unreachable' });
  });

  it('is gated behind a sign-in redirect, a 401/403, or a 200 that is not JSON', () => {
    const redirect: HttpObservation = { ...ok, status: 302, redirectHost: 'sso.example.test' };
    expect(interpretReach(redirect, redirect)).toMatchObject({ reach: 'gated' });
    expect(interpretReach(ok, { ...ok, status: 403 })).toMatchObject({ reach: 'gated' });
    expect(interpretReach(ok, { ...ok, contentType: 'text/html' })).toMatchObject({
      reach: 'gated',
    });
  });
});

describe('interpretWebhook', () => {
  const accepted = {
    verification: { status: 200, echoedChallenge: true },
    tampered: { status: 401 },
    button: { status: 404 },
  };

  it('accepts synthetic interactions when the signed requests pass and a wrong one is refused', () => {
    expect(interpretWebhook(accepted)).toMatchObject({
      signatureAccepted: true,
      signatureEnforced: true,
      interactionAccepted: true,
    });
  });

  it('does not accept them when the secret is wrong for this instance', () => {
    expect(
      interpretWebhook({
        verification: { status: 401, echoedChallenge: false },
        tampered: { status: 401 },
        button: { status: 401 },
      }),
    ).toMatchObject({ signatureAccepted: false, interactionAccepted: false });
  });

  it('flags an endpoint that answers 200 to anything as not enforcing signatures', () => {
    expect(interpretWebhook({ ...accepted, tampered: { status: 200 } })).toMatchObject({
      signatureEnforced: false,
    });
  });

  it('reports a missing receiver when even url_verification is not found', () => {
    // What an instance in Socket Mode, or without Slack, answers on the webhook path.
    const absent = { status: 404, echoedChallenge: false };
    expect(
      interpretWebhook({
        verification: absent,
        tampered: { status: 404 },
        button: { status: 404 },
      }),
    ).toMatchObject({
      receiverPresent: false,
      signatureAccepted: false,
      signatureEnforced: false,
      interactionAccepted: false,
    });
    expect(interpretWebhook(accepted).receiverPresent).toBe(true);
  });

  it('does not accept a signed click the instance answers with 401 or 500', () => {
    // 401 after a valid signature is Bolt failing its own bot-token authorization.
    expect(interpretWebhook({ ...accepted, button: { status: 401 } })).toMatchObject({
      signatureAccepted: true,
      interactionAccepted: false,
    });
    expect(interpretWebhook({ ...accepted, button: { status: 500 } })).toMatchObject({
      interactionAccepted: false,
    });
    expect(interpretWebhook({ ...accepted, button: { status: 200 } })).toMatchObject({
      interactionAccepted: true,
    });
  });

  it('does not count a 200 without the echoed challenge as an accepted signature', () => {
    expect(
      interpretWebhook({ ...accepted, verification: { status: 200, echoedChallenge: false } }),
    ).toMatchObject({ signatureAccepted: false, interactionAccepted: false });
  });
});
