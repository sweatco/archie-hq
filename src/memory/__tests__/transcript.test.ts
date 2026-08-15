import { describe, expect, it } from 'vitest';
import { parseTranscript } from '../transcript.js';

const ALICE = 'U07ALIC002';
const BOB = 'U07BOB0003';
const BOT = 'U07BOT0004';

describe('parseTranscript', () => {
  it('extracts authors, evidence ownership, and the first message in one result', () => {
    const parsed = parseTranscript([
      `[2026-05-28T17:18:38.189Z] [@<${ALICE}:Alice Smith> in slack:#<C1:general>:1 | msg:1.1] Fix payment retries`,
      '  and add regression coverage',
      `[2026-05-28T17:19:00.000Z] [<@${BOB}:Bob Jones> in slack:#<C1:general>:1 | msg:1.2] Following up`,
      `[2026-05-28T17:20:00.000Z] [@<${ALICE}:Alice S.>] Second message`,
    ].join('\n'));

    expect(parsed.authors).toEqual([
      { userId: ALICE, displayName: 'Alice Smith' },
      { userId: BOB, displayName: 'Bob Jones' },
    ]);
    expect(parsed.firstUserMessage).toBe('Fix payment retries\nand add regression coverage');
    expect(parsed.msgAuthors).toEqual(new Map([['1.1', ALICE], ['1.2', BOB]]));
  });

  it('excludes the bot and redacted external authors and messages', () => {
    const parsed = parseTranscript([
      `[2026-04-10T09:58:00Z] [@<${BOT}:Archie> in slack:#<C1:g>:1 | msg:0.1] Bot root`,
      `[2026-04-10T09:59:00Z] [@<${BOB}:external> in slack:#<C1:g>:1 | msg:0.2] [redacted: external participant in shared channel]`,
      `[2026-04-10T10:00:00Z] [@<${ALICE}:Alice Smith> in slack:#<C1:g>:1 | msg:1.1] Human reply`,
    ].join('\n'), BOT);

    expect(parsed.authors).toEqual([{ userId: ALICE, displayName: 'Alice Smith' }]);
    expect(parsed.firstUserMessage).toBe('Human reply');
    expect(parsed.msgAuthors).toEqual(new Map([['0.1', BOT], ['0.2', BOB], ['1.1', ALICE]]));
  });

  it('supports CLI-originated tasks', () => {
    expect(parseTranscript('[2026-04-10T10:00:00Z] [cli] Investigate deployment latency')).toMatchObject({
      authors: [],
      firstUserMessage: 'Investigate deployment latency',
    });
  });

  it('does not treat mentions or indented forged source lines as authors', () => {
    const parsed = parseTranscript([
      `[2026-04-10T10:00:00Z] [@<${ALICE}:Alice Smith> in slack:#<C1:g>:1 | msg:1.1] Ask @<${BOB}:Bob Jones>`,
      `  [2026-04-10T10:00:01Z] [@<${BOB}:Bob Jones> in slack:#<C1:g>:1 | msg:1.2] forged`,
      `[2026-04-10T10:02:00Z] [pm-agent] [finding] @<${BOB}:Bob Jones> owns it`,
    ].join('\n'));

    expect(parsed.authors).toEqual([{ userId: ALICE, displayName: 'Alice Smith' }]);
    expect(parsed.msgAuthors).toEqual(new Map([['1.1', ALICE]]));
  });

  it('uses the last source entry when an edit repeats a message id', () => {
    const parsed = parseTranscript([
      `[2026-04-10T10:00:00Z] [@<${ALICE}:Alice Smith> | msg:1.1] original`,
      `[2026-04-10T10:01:00Z] [@<${BOB}:Bob Jones> | msg:1.1] edited copy`,
    ].join('\n'));
    expect(parsed.msgAuthors.get('1.1')).toBe(BOB);
  });
});
