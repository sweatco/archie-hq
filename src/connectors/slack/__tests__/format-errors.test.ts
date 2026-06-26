import { describe, it, expect } from 'vitest';
import {
  slackErrorCode,
  formatSlackSendError,
  formatSlackPostError,
  formatSlackReadError,
} from '../format-errors.js';
import { SlackMarkdownLimitError, PrivateChannelError } from '../client.js';

/** A fake Slack WebAPI error carries its code under `.data.error`. */
const apiErr = (code: string) => ({ data: { error: code } });

describe('slackErrorCode', () => {
  it('extracts the Slack WebAPI error code', () => {
    expect(slackErrorCode(apiErr('not_in_channel'))).toBe('not_in_channel');
  });
  it('returns undefined for non-WebAPI errors', () => {
    expect(slackErrorCode(new Error('boom'))).toBeUndefined();
    expect(slackErrorCode(null)).toBeUndefined();
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
});

describe('formatSlackReadError', () => {
  it('explains a private-channel refusal', () => {
    expect(formatSlackReadError(new PrivateChannelError('C9'), 'C9')).toContain('PUBLIC');
  });
  it('maps not_in_channel to an invite hint', () => {
    expect(formatSlackReadError(apiErr('not_in_channel'), 'C1')).toContain('/invite @Archie');
  });
  it('falls back to the underlying error message', () => {
    expect(formatSlackReadError(new Error('weird failure'), 'C1')).toContain('weird failure');
  });
});
