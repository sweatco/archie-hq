/**
 * Unit tests for renderMessageForContext.
 *
 * Direct tests on the pure rendering helper extracted from appendSlackMessage.
 * Covers redaction, forwarded-attachment labels, file lists, edge cases.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../connectors/slack/client.js', () => ({
  isExternalUser: (user: { teamId?: string; isRestricted?: boolean; isUltraRestricted?: boolean }) => {
    if (user.isRestricted || user.isUltraRestricted) return true;
    if (user.teamId && user.teamId !== 'T_HOME') return true;
    return false;
  },
  formatSlackChannelRef: vi.fn(),
  formatSlackChannelDisplay: vi.fn(),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn() },
}));

vi.mock('../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
}));

vi.mock('../../system/workdir.js', () => ({
  SESSIONS_DIR: '/tmp/sessions',
}));

vi.mock('./task.js', () => ({
  activeTasks: new Map(),
}));

import { renderMessageForContext } from '../persistence.js';

describe('renderMessageForContext', () => {
  it('renders plain message text with no attachments', () => {
    const out = renderMessageForContext({ text: 'hello world' }, { redacted: false });
    expect(out).toBe('hello world');
  });

  it('appends file list as trailing [Attachments] line', () => {
    const out = renderMessageForContext(
      {
        text: 'see file',
        files: [
          { id: 'F1', name: 'a.txt', mimetype: 'text/plain', url_private: '', localPath: '/p/a.txt' },
        ],
      },
      { redacted: false },
    );
    expect(out).toBe('see file\n  [Attachments: a.txt (/p/a.txt)]');
  });

  it('appends reactions as a trailing [Reactions] line, with counts only above 1', () => {
    const out = renderMessageForContext(
      {
        text: 'nice',
        reactions: [
          { name: 'thumbsup', count: 3 },
          { name: 'eyes', count: 1 },
        ],
      },
      { redacted: false },
    );
    expect(out).toBe('nice\n  [Reactions: :thumbsup: ×3, :eyes:]');
  });

  it('renders both attachments and reactions lines together', () => {
    const out = renderMessageForContext(
      {
        text: 'see file',
        files: [
          { id: 'F1', name: 'a.txt', mimetype: 'text/plain', url_private: '', localPath: '/p/a.txt' },
        ],
        reactions: [{ name: 'tada', count: 1 }],
      },
      { redacted: false },
    );
    expect(out).toBe('see file\n  [Attachments: a.txt (/p/a.txt)]\n  [Reactions: :tada:]');
  });

  it('returns the redaction placeholder when redacted is true', () => {
    const out = renderMessageForContext(
      {
        text: 'should not appear',
        attachments: [{ text: 'also hidden' }],
      },
      { redacted: true },
    );
    expect(out).toBe('[redacted: external participant in shared channel]');
  });

  it('renders externally-authored attachment under a forwarded-from label', () => {
    const out = renderMessageForContext(
      {
        text: 'check this out',
        attachments: [
          {
            text: 'external content body',
            author: {
              id: 'UEXT',
              username: 'ext',
              realName: 'External Person',
              teamId: 'T_OTHER',
            },
          },
        ],
      },
      { redacted: false },
    );
    expect(out).toBe(
      'check this out\n[forwarded from @<UEXT:External Person> — external, team T_OTHER]\nexternal content body',
    );
  });

  it('only labels first external attachment; later externals fold inline', () => {
    const out = renderMessageForContext(
      {
        text: 'top',
        attachments: [
          {
            text: 'first ext',
            author: { id: 'U1', username: 'a', realName: 'A', teamId: 'T_OTHER' },
          },
          {
            text: 'second ext',
            author: { id: 'U2', username: 'b', realName: 'B', teamId: 'T_OTHER' },
          },
        ],
      },
      { redacted: false },
    );
    // top, second ext (folded inline), then forwarded block for first
    expect(out).toBe(
      'top\nsecond ext\n[forwarded from @<U1:A> — external, team T_OTHER]\nfirst ext',
    );
  });

  it('renders empty text + only attachments without leading newline', () => {
    const out = renderMessageForContext(
      {
        text: '',
        attachments: [{ text: 'inline body' }],
      },
      { redacted: false },
    );
    expect(out).toBe('inline body');
  });

  it('omits team suffix when external author has no teamId', () => {
    const out = renderMessageForContext(
      {
        text: 'top',
        attachments: [
          {
            text: 'guest content',
            author: { id: 'UG', username: 'g', realName: 'G', isRestricted: true },
          },
        ],
      },
      { redacted: false },
    );
    expect(out).toBe('top\n[forwarded from @<UG:G> — external]\nguest content');
  });
});
