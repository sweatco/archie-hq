import { describe, it, expect } from 'vitest';
import {
  slackErrorCode,
  formatSlackSendError,
  formatSlackPostError,
  formatSlackReadError,
} from '../format-errors.js';
import { SlackMarkdownLimitError, PrivateChannelError, DmPostError } from '../client.js';

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

  it('keeps the non-DM wording byte-identical', () => {
    expect(formatSlackReadError(new PrivateChannelError('C9'), 'C9')).toBe(
      "Couldn't read C9: it's a private channel or DM that isn't this task's own. Reading is limited to public channels (plus the channel this task lives in).",
    );
    const notMember =
      "Couldn't read C1: Archie isn't a member of that public channel (or it doesn't exist). Invite it (`/invite @Archie`) — Archie can only read public channels it's been added to.";
    expect(formatSlackReadError(apiErr('not_in_channel'), 'C1')).toBe(notMember);
    expect(formatSlackReadError(apiErr('channel_not_found'), 'C1')).toBe(notMember);
  });

  it('uses DM wording for a private-channel refusal in a DM task', () => {
    expect(formatSlackReadError(new PrivateChannelError('C9'), 'C9', true)).toContain('person in this DM');
  });

  it('tells a DM task how to get Archie into a private channel', () => {
    for (const code of ['not_in_channel', 'channel_not_found']) {
      const msg = formatSlackReadError(apiErr(code), 'C1', true);
      expect(msg).toContain('/invite @Archie');
      expect(msg).toContain('private channel');
    }
  });
});
