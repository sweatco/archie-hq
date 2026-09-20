import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { isSlackDryRun } from '../client.js';
import { setAssistantThreadTitle } from '../title.js';

vi.mock('../client.js', () => ({ isSlackDryRun: vi.fn() }));
vi.mock('../../../system/logger.js', () => ({ logger: { system: vi.fn(), warn: vi.fn() } }));

const setTitle = vi.fn();
const client = { assistant: { threads: { setTitle } } } as unknown as WebClient;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isSlackDryRun).mockReturnValue(false);
});

describe('setAssistantThreadTitle', () => {
  it('does not call Slack in dry-run mode', async () => {
    vi.mocked(isSlackDryRun).mockReturnValue(true);
    await setAssistantThreadTitle(client, 'D123', '123.456', 'Test title');
    expect(setTitle).not.toHaveBeenCalled();
  });

  it('updates the title outside dry-run mode', async () => {
    await setAssistantThreadTitle(client, 'D123', '123.456', 'Test title');
    expect(setTitle).toHaveBeenCalledExactlyOnceWith({
      channel_id: 'D123', thread_ts: '123.456', title: 'Test title',
    });
  });

  it('keeps Slack failures non-fatal', async () => {
    setTitle.mockRejectedValueOnce(new Error('Slack unavailable'));
    await expect(setAssistantThreadTitle(client, 'D123', '123.456', 'Test title')).resolves.toBeUndefined();
  });
});
