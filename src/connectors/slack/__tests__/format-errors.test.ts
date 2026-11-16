import { describe, it, expect } from 'vitest';
import {
  formatSlackReactionError,
  formatSlackSendError,
  formatSlackPostError,
  formatSlackReadError,
} from '../format-errors.js';
import { slackErrorCode } from '../api-errors.js';
import { SlackMarkdownLimitError, PrivateChannelError, DmPostError } from '../client.js';

/** A fake Slack WebAPI error carries its code under `.data.error`. */
const apiErr = (code: string) => ({ data: { error: code } });

describe('slackErrorCode', () => {
  it('extracts the Slack WebAPI error code', () => {
    expect(slackErrorCode(apiErr('not_in_channel'))).toBe('not_in_channel');
  });
  it('extracts codes from Slack Error instances and accepts the existing safe-code limits', () => {
    expect(
      slackErrorCode(Object.assign(new Error('private details'), apiErr('already_reacted'))),
    ).toBe('already_reacted');
    expect(slackErrorCode(apiErr('a'))).toBe('a');
    expect(slackErrorCode(apiErr('a'.repeat(64)))).toBe('a'.repeat(64));
  });
  it.each([
    new Error('boom'),
    null,
    undefined,
    'missing_scope',
    123,
    {},
    { data: null },
    { data: 'missing_scope' },
    { data: 123 },
    { data: {} },
    { data: { error: 123 } },
    { data: { error: null } },
    apiErr(''),
    apiErr('missing_\nscope'),
    apiErr('MISSING_SCOPE'),
    apiErr('_missing_scope'),
    apiErr('xoxb-private-token'),
    apiErr('private details'),
    apiErr('a'.repeat(65)),
  ])('returns undefined for malformed or unsafe errors: %j', (error) => {
    expect(slackErrorCode(error)).toBeUndefined();
  });
});

describe('formatSlackReactionError', () => {
  it.each(['missing_scope', 'invalid_name', 'message_not_found'])(
    'reports the safe %s code',
    (code) => {
      expect(formatSlackReactionError(apiErr(code))).toBe(`Reaction was not confirmed (${code}).`);
    },
  );
  it.each([
    new Error('socket hang up: xoxb-private-token'),
    apiErr('xoxb-private-token'),
    { data: { error: 123 } },
    null,
  ])('falls back without exposing raw details: %j', (error) => {
    expect(formatSlackReactionError(error)).toBe('Reaction was not confirmed (unknown_error).');
  });
});

describe('formatSlackSendError', () => {
  it('explains a markdown-limit overflow', () => {
    const msg = formatSlackSendError(new SlackMarkdownLimitError(13000));
    expect(msg).toContain('exceeds');
    expect(msg).toContain('Split');
  });
  it('falls back to the underlying error message', () => {
    expect(formatSlackSendError(new Error('network down'))).toContain('network down');
  });
});

describe('formatSlackPostError', () => {
  it('maps not_in_channel / channel_not_found to an invite hint', () => {
    expect(formatSlackPostError(apiErr('not_in_channel'), 'C1')).toContain('/invite @Archie');
    expect(formatSlackPostError(apiErr('channel_not_found'), 'C1')).toContain('/invite @Archie');
  });
  it('maps is_archived and thread_not_found', () => {
    expect(formatSlackPostError(apiErr('is_archived'), 'C1')).toContain('archived');
    expect(formatSlackPostError(apiErr('thread_not_found'), 'C1')).toContain('thread_ts');
  });
  it('routes a markdown-limit error through the send formatter', () => {
    expect(formatSlackPostError(new SlackMarkdownLimitError(13000), 'C1')).toContain('exceeds');
  });
  it('explains a DM / group-DM refusal', () => {
    const msg = formatSlackPostError(new DmPostError('G6'), 'G6');
    expect(msg).toMatch(/DM or group DM/i);
    expect(msg).toMatch(/post_to_user/);
  });
});

describe('formatSlackReadError', () => {
  it('explains a private-channel refusal', () => {
    const msg = formatSlackReadError(new PrivateChannelError('C9'), 'C9');
    expect(msg).toMatch(/private channel or DM/i);
    expect(msg).toContain('public');
  });
  it('maps not_in_channel to an invite hint', () => {
    expect(formatSlackReadError(apiErr('not_in_channel'), 'C1')).toContain('/invite @Archie');
  });
  it('falls back to the underlying error message', () => {
    expect(formatSlackReadError(new Error('weird failure'), 'C1')).toContain('weird failure');
  });
});
