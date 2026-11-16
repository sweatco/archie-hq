import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addReaction,
  removeReaction,
  initSlackClient,
  getSlackClient,
  setSlackDryRun,
} from '../client.js';
import { expectDefined } from '../../../test-support/assertions.js';

vi.mock('../../../system/logger.js', () => ({
  logger: { slack: vi.fn(), warn: vi.fn(), system: vi.fn() },
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValueOnce(Response.json({ ok: true, user_id: 'UBOT', team_id: 'T1' }));
  await initSlackClient('xoxb-test');
  setSlackDryRun(false);
  fetchMock.mockClear();
});

afterEach(() => {
  setSlackDryRun(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([
  { operation: 'add', mutate: addReaction, satisfied: 'already_reacted' },
  { operation: 'remove', mutate: removeReaction, satisfied: 'no_reaction' },
])('bounded reactions.$operation with the real WebClient', ({ operation, mutate, satisfied }) => {
  it('uses the shared client token and endpoint for the requested reaction', async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));

    await mutate('C1', '1.0', 'thumbsup');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = expectDefined(fetchMock.mock.calls[0]);
    expect(url).toBe(`${getSlackClient().slackApiUrl}reactions.${operation}`);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer xoxb-test');
    expect(new URLSearchParams(String(init?.body))).toEqual(
      new URLSearchParams({ channel: 'C1', timestamp: '1.0', name: 'thumbsup' }),
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts an already satisfied reaction without retrying', async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: false, error: satisfied }));

    await expect(mutate('C1', '1.0', 'thumbsup')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled request at the five-second deadline without retrying', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(30));
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => {
          const signal = expectDefined(init?.signal);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );

    await expect(mutate('C1', '1.0', 'thumbsup')).rejects.toThrow();
    expect(deadline).toHaveBeenCalledWith(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects rate limits immediately without pausing the shared client', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
    );

    await expect(mutate('C1', '1.0', 'thumbsup')).rejects.toMatchObject({
      code: 'slack_webapi_rate_limited_error',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(Response.json({ ok: true, user_id: 'UBOT' }));
    await expect(getSlackClient().auth.test()).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('propagates Slack API errors', async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: false, error: 'missing_scope' }));

    await expect(mutate('C1', '1.0', 'thumbsup')).rejects.toMatchObject({
      data: { error: 'missing_scope' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry server errors', async () => {
    fetchMock.mockResolvedValue(new Response('Unavailable', { status: 503 }));

    await expect(mutate('C1', '1.0', 'thumbsup')).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry transport errors', async () => {
    fetchMock.mockRejectedValue(new Error('connection reset'));

    await expect(mutate('C1', '1.0', 'thumbsup')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves dry-run suppression', async () => {
    setSlackDryRun(true);

    await expect(mutate('C1', '1.0', 'thumbsup')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
