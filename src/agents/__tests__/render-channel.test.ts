/**
 * Tests for `renderChannel` — how one of a task's channels reads in the PM's
 * context block.
 *
 * These are the strings the PM is shown, so getting one wrong is not cosmetic:
 * the PM decides where to post from this block. `Meeting (live)` and
 * `Meeting (ended)` had no coverage at all for a while — the channel-renderer
 * registry's own test was asserting them, and deleting the registry took the
 * assertions with it while the strings moved into `spawn.ts`. Hence a test per
 * kind rather than a test for the one kind that prompted this.
 */
import { describe, it, expect } from 'vitest';

const { renderChannel } = await import('../spawn.js');

describe('renderChannel', () => {
  it('prefixes a Slack channel with # and leaves a DM alone', () => {
    expect(
      renderChannel('slack:C1', {
        type: 'slack',
        thread_id: '1',
        channel_id: 'C1',
        channel_name: 'bot-test',
        last_processed_ts: '0',
      }),
    ).toBe('#bot-test');
    // Already carries its own prefix, and "#DM with Egor" would read as a channel that does not exist.
    expect(
      renderChannel('slack:D1', {
        type: 'slack',
        thread_id: '1',
        channel_id: 'D1',
        channel_name: 'DM with Egor',
        last_processed_ts: '0',
      }),
    ).toBe('DM with Egor');
  });

  it('falls back to the channel id when Slack never reported a name', () => {
    expect(
      renderChannel('slack:C9', {
        type: 'slack',
        thread_id: '1',
        channel_id: 'C9',
        channel_name: '',
        last_processed_ts: '0',
      }),
    ).toBe('#C9');
  });

  it('names a GitHub channel by its PR', () => {
    expect(renderChannel('github:x', { type: 'github', repo: 'sweatco/archie-hq', pr_number: 323 })).toBe(
      'PR sweatco/archie-hq#323',
    );
  });

  it('renders the CLI channel', () => {
    expect(renderChannel('cli:local', { type: 'cli', id: 'cli:local' })).toBe('CLI session');
  });

  // The pair that lost its coverage. A task that hosted several meetings shows one line each, so `ended` is the only thing distinguishing them.
  it('tells a live meeting from an ended one', () => {
    expect(renderChannel('recall:abc', { type: 'recall', session_id: 'abc', ended: false })).toBe('Meeting (live)');
    expect(renderChannel('recall:abc', { type: 'recall', session_id: 'abc', ended: true })).toBe('Meeting (ended)');
  });

  it('renders an unknown kind as its raw key rather than inventing a label', () => {
    // Unreachable through `Channel` today — the union is closed — but this is the branch that keeps a future kind from being described wrongly before anyone teaches this function about it.
    expect(renderChannel('telegram:42', { type: 'telegram' } as never)).toBe('telegram:42');
  });
});
