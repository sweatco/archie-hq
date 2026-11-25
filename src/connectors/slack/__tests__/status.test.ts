import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { getSlackClient, isSlackDryRun } from '../client.js';
import { setSlackThreadStatus } from '../status.js';

vi.mock('../client.js', () => ({ getSlackClient: vi.fn(), isSlackDryRun: vi.fn() }));
vi.mock('../../../system/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

const apiCall = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isSlackDryRun).mockReturnValue(false);
  vi.mocked(getSlackClient).mockReturnValue({ apiCall } as unknown as WebClient);
});

describe('setSlackThreadStatus', () => {
  it('marks the agent session as working for any status text', async () => {
    await setSlackThreadStatus('D123', '123.456', 'is checking Jira…');
    expect(apiCall).toHaveBeenCalledExactlyOnceWith('agents.sessions.setStatus', {
      channel_id: 'D123',
      thread_ts: '123.456',
      status: 'processing',
    });
  });

  it('ends the working state for an empty status', async () => {
    await setSlackThreadStatus('D123', '123.456', '');
    expect(apiCall).toHaveBeenCalledExactlyOnceWith('agents.sessions.setStatus', {
      channel_id: 'D123',
      thread_ts: '123.456',
      status: 'active',
    });
  });

  it('does not call Slack in dry-run mode', async () => {
    vi.mocked(isSlackDryRun).mockReturnValue(true);
    await setSlackThreadStatus('D123', '123.456', '');
    expect(apiCall).not.toHaveBeenCalled();
  });

  it('keeps Slack failures non-fatal', async () => {
    apiCall.mockRejectedValueOnce(new Error('not_allowed'));
    await expect(setSlackThreadStatus('D123', '123.456', '')).resolves.toBeUndefined();
  });
});
