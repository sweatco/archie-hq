import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSlackClient, postSlackMessage } from '../client.js';

vi.mock('../../../system/logger.js', () => ({
  logger: { slack: vi.fn(), warn: vi.fn(), system: vi.fn() },
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValueOnce(Response.json({ ok: true, user_id: 'UBOT', team_id: 'T1' }));
  await initSlackClient('xoxb-test');
  fetchMock.mockClear();
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded Slack notice delivery with the real WebClient', () => {
  it('aborts a stalled request without retrying', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(30));
    let requestSignal: AbortSignal;
    fetchMock.mockImplementation((_url, init) => new Promise((_, reject) => {
      requestSignal = init!.signal!;
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
    }));
    await expect(postSlackMessage({ channel: 'C1', text: 'Paused' }, true)).rejects.toThrow();
    expect(deadline).toHaveBeenCalledWith(5000);
    expect(requestSignal!.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a long rate limit immediately without retrying', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '3600' } }));
    await expect(postSlackMessage({ channel: 'C1', text: 'Paused' }, true)).rejects.toMatchObject({ code: 'slack_webapi_rate_limited_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failed notice', async () => {
    fetchMock.mockResolvedValue(new Response('Unavailable', { status: 503 }));
    await expect(postSlackMessage({ channel: 'C1', text: 'Paused' }, true)).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary messages on the shared client without a deadline', async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true, ts: '1.0' }));
    await expect(postSlackMessage({ channel: 'C1', text: 'An ordinary reply' })).resolves.toBe('1.0');
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeUndefined();
  });
});
