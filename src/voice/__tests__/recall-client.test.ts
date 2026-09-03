import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../system/logger.js';
import { createRecallClient } from '../recall.js';
import type { VoiceConfig } from '../types.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const calls: Call[] = [];

interface Reply {
  status: number;
  body: string;
}

const replies: Reply[] = [];

/** Thrown by `fetch` itself: DNS failure, timeout, aborted signal. */
let fetchThrows: Error | null = null;

function fakeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  if (fetchThrows !== null) {
    return Promise.reject(fetchThrows);
  }
  const raw = typeof init?.body === 'string' ? init.body : '{}';
  calls.push({
    url: String(url),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: JSON.parse(raw) as Record<string, unknown>,
  });
  const reply = replies.shift() ?? { status: 200, body: JSON.stringify({ id: 'bot-default' }) };
  return Promise.resolve({
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    text: () => Promise.resolve(reply.body),
  } as Response);
}

// Clears the scrubber's 8-char floor; mutually non-overlapping so no leak is mistaken for another's.
function config(over: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    recallApiKey: 'recall-secret-key-44444',
    recallRegion: 'eu-central-1',
    deepgramApiKey: 'deepgram-secret-key-0000',
    sonioxApiKey: 'soniox-secret-key-33333',
    cerebrasApiKey: 'cerebras-secret-key-2222',
    publicUrl: 'https://archie.example',
    ...over,
  };
}

const joinOpts = {
  meetingUrl: 'https://zoom.us/j/123',
  botName: 'Archie',
  audioWsUrl: 'wss://archie.example/api/voice/audio',
  pageUrl: 'https://archie.example/api/voice/page/page-abc',
};

beforeEach(() => {
  calls.length = 0;
  replies.length = 0;
  fetchThrows = null;
  vi.stubGlobal('fetch', fakeFetch);
  // Every call logs; noise unless a test asserts on it — logger.system writes to stdout, silenced by default.
  vi.spyOn(logger, 'system').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recall client — bot creation', () => {
  it('puts output_media in the create body, in the one request that creates the bot', async () => {
    // A later POST to /bot/{id}/output_media/ is silently accepted, but the bot already joined muted — it plays to nobody all meeting.
    // `output_media: null` on the bot record is the tell; this pins the field into the *create* request.
    replies.push({ status: 201, body: JSON.stringify({ id: 'bot-1' }) });
    const client = createRecallClient(config());

    const botId = await client.createBot(joinOpts);

    expect(botId).toBe('bot-1');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://eu-central-1.recall.ai/api/v1/bot/');
    expect(calls[0].body.output_media).toEqual({
      camera: { kind: 'webpage', config: { url: joinOpts.pageUrl } },
    });
  });

  it('asks Recall to pull the bot out sixty seconds after the room empties, not on its two-second default', async () => {
    // Recall's own ending is the only one the engine acts on now, so this value *is* the empty-room grace period (docs/architecture/voice.md).
    // The 2s default reads a Zoom rejoin — a leave and then a join under a fresh participant id — as an empty room.
    replies.push({ status: 201, body: JSON.stringify({ id: 'bot-leave-timeout' }) });
    const client = createRecallClient(config());

    await client.createBot(joinOpts);

    expect(calls[0].body.automatic_leave).toEqual({
      everyone_left_timeout: { timeout: 60 },
    });
  });

  it('asks for per-participant audio only, delivered to the realtime endpoint we gave it', async () => {
    // audio_separate_raw gives attribution and turn boundaries together; mixed stream (old one-speaker Deepgram model) isn't requested.
    replies.push({ status: 201, body: JSON.stringify({ id: 'bot-2' }) });
    const client = createRecallClient(config());

    await client.createBot(joinOpts);

    const recording = calls[0].body.recording_config as Record<string, unknown>;
    expect(recording.audio_separate_raw).toBeDefined();
    expect(recording.audio_mixed_raw).toBeUndefined();
    // Our own speech coming back as inbound audio would make the bot trigger on itself; that flag must stay absent.
    expect(calls[0].body.include_bot_in_recording).toBeUndefined();
  });

  it('subscribes to audio and only the two participant events the live roster and end-detection need, on the same endpoint', async () => {
    // Other events (.update, .speech_on/off, .webcam/mic/screenshare, .chat_message) share the socket with real-time audio; must not crowd it (recall.ts).
    replies.push({ status: 201, body: JSON.stringify({ id: 'bot-events' }) });
    const client = createRecallClient(config());

    await client.createBot(joinOpts);

    const recording = calls[0].body.recording_config as Record<string, unknown>;
    expect(recording.realtime_endpoints).toEqual([
      {
        type: 'websocket',
        url: joinOpts.audioWsUrl,
        events: ['audio_separate_raw.data', 'participant_events.join', 'participant_events.leave'],
      },
    ]);
  });

  it('authenticates with Recall\'s Token scheme, not Bearer', async () => {
    replies.push({ status: 201, body: JSON.stringify({ id: 'bot-3' }) });
    const client = createRecallClient(config({ recallApiKey: 'recall-secret-key-44444' }));

    await client.createBot(joinOpts);

    expect(calls[0].headers.Authorization).toBe('Token recall-secret-key-44444');
  });

  it('rejects a 2xx that carries no bot id, rather than returning an empty handle', async () => {
    // Bot id is the session id and audio-routing key; empty means a meeting no frame can reach, looking like success.
    replies.push({ status: 200, body: JSON.stringify({ status: 'queued' }) });
    const client = createRecallClient(config());

    await expect(client.createBot(joinOpts)).rejects.toThrow(/no bot id/);
  });

  it('rejects a 2xx whose body is not JSON at all', async () => {
    replies.push({ status: 200, body: '<html>maintenance</html>' });
    const client = createRecallClient(config());

    await expect(client.createBot(joinOpts)).rejects.toThrow(/no bot id/);
  });
});

describe('recall client — region', () => {
  // Regions are separate deployments: the same key gave 200 on eu-central-1, 401 on us-west-2 — wrong region means no bot, not a slow one.
  it.each([
    ['eu-central-1', 'https://eu-central-1.recall.ai/api/v1'],
    ['us-west-2', 'https://us-west-2.recall.ai/api/v1'],
    ['ap-northeast-1', 'https://ap-northeast-1.recall.ai/api/v1'],
  ])('builds %s into the base URL', async (region, base) => {
    replies.push({ status: 201, body: JSON.stringify({ id: 'bot-r' }) });
    const client = createRecallClient(config({ recallRegion: region }));

    await client.createBot(joinOpts);

    expect(calls[0].url).toBe(`${base}/bot/`);
  });

  it('uses the same region for every call in a meeting, not just the join', async () => {
    replies.push(
      { status: 201, body: JSON.stringify({ id: 'bot-4' }) },
      { status: 200, body: '{}' },
      { status: 200, body: '{}' },
    );
    const client = createRecallClient(config({ recallRegion: 'us-west-2' }));

    await client.createBot(joinOpts);
    await client.sendChat('bot-4', 'hello');
    await client.leave('bot-4');

    expect(calls.map((c) => c.url)).toEqual([
      'https://us-west-2.recall.ai/api/v1/bot/',
      'https://us-west-2.recall.ai/api/v1/bot/bot-4/send_chat_message/',
      'https://us-west-2.recall.ai/api/v1/bot/bot-4/leave_call/',
    ]);
  });

  it('surfaces a wrong-region 401 instead of swallowing it', async () => {
    // Nothing downstream can recover from this; must reach the caller as a rejection carrying the status.
    replies.push({ status: 401, body: '{"detail":"Invalid token."}' });
    const client = createRecallClient(config({ recallRegion: 'us-west-2' }));

    // Checks the specific failure: a 2xx with no bot id also rejects, so a loose matcher would pass even without the non-2xx check.
    const failure = await client.createBot(joinOpts).catch((err: unknown) => String(err));
    expect(failure).toContain('Recall POST /bot/ failed: HTTP 401');
    expect(failure).toContain('Invalid token.');
  });
});

describe('recall client — errors', () => {
  it('surfaces a rejection body verbatim, since it is the only account of what Recall disliked', async () => {
    replies.push({ status: 400, body: '{"meeting_url":["Enter a valid URL."]}' });
    const client = createRecallClient(config());

    const failure = await client.createBot(joinOpts).catch((err: unknown) => String(err));
    expect(failure).toContain('Recall POST /bot/ failed: HTTP 400');
    expect(failure).toContain('Enter a valid URL.');
  });

  it('lets a transport failure out of sendChat rather than reporting a delivered message', async () => {
    fetchThrows = new Error('socket hang up');
    const client = createRecallClient(config());

    await expect(client.sendChat('bot-5', 'hello')).rejects.toThrow('socket hang up');
  });

  it('lets a failed leave out, so the caller can log a bot left running', async () => {
    replies.push({ status: 404, body: '{"detail":"Not found."}' });
    const client = createRecallClient(config());

    await expect(client.leave('bot-6')).rejects.toThrow(/HTTP 404/);
  });
});

describe('recall client — credential redaction', () => {
  // Scrubs every credential, not only its own — echoed headers aren't choosy, and a leak doesn't care whose key it was.
  it('scrubs every credential the process holds out of an error body', async () => {
    replies.push({
      status: 400,
      body: JSON.stringify({
        echo: {
          authorization: 'Token recall-secret-key-44444',
          deepgram: 'deepgram-secret-key-0000',
          soniox: 'soniox-secret-key-33333',
          cerebras: 'cerebras-secret-key-2222',
        },
      }),
    });
    const client = createRecallClient(config());

    const failure = await client.createBot(joinOpts).catch((err: unknown) => String(err));

    expect(failure).toContain('[redacted]');
    for (const secret of [
      'recall-secret-key-44444',
      'deepgram-secret-key-0000',
      'soniox-secret-key-33333',
      'cerebras-secret-key-2222',
    ]) {
      expect(failure).not.toContain(secret);
    }
  });

  it('redacts an overlapping pair completely', async () => {
    // Longest first, or scrubbing the short key first leaves the long one's tail in the log.
    const long = 'shared-prefix-and-a-tail';
    const short = 'shared-prefix-a';
    replies.push({ status: 400, body: JSON.stringify({ echo: long }) });
    const client = createRecallClient(
      config({ recallApiKey: short, deepgramApiKey: long }),
    );

    const failure = await client.createBot(joinOpts).catch((err: unknown) => String(err));

    expect(failure).not.toContain('nd-a-tail');
  });

  it('does not treat a short or empty credential as a secret to split on', async () => {
    // Splitting on '' inserts the marker between every character, destroying the account of what went wrong.
    replies.push({ status: 400, body: '{"detail":"Enter a valid URL."}' });
    const client = createRecallClient(
      config({ recallApiKey: '', deepgramApiKey: 'abc', sonioxApiKey: '', cerebrasApiKey: 'xy' }),
    );

    const failure = await client.createBot(joinOpts).catch((err: unknown) => String(err));

    expect(failure).toContain('Enter a valid URL.');
    expect(failure).not.toContain('[redacted]');
  });

  it('never logs the credential it sends, even on a failure', async () => {
    const system = vi.spyOn(logger, 'system').mockImplementation(() => {});
    replies.push({ status: 500, body: 'upstream exploded' });
    const client = createRecallClient(config());

    await client.createBot(joinOpts).catch(() => {});

    const logged = system.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).not.toContain('recall-secret-key-44444');
  });
});

describe('recall client — chat', () => {
  it('addresses the chat to everyone, on the bot it was given', async () => {
    replies.push({ status: 200, body: '{}' });
    const client = createRecallClient(config());

    await client.sendChat('bot-7', 'It shipped on Tuesday.');

    expect(calls[0].url).toBe('https://eu-central-1.recall.ai/api/v1/bot/bot-7/send_chat_message/');
    expect(calls[0].body).toEqual({ to: 'everyone', message: 'It shipped on Tuesday.' });
  });

  it('keeps chat content out of the log — it is meeting content', async () => {
    const system = vi.spyOn(logger, 'system').mockImplementation(() => {});
    replies.push({ status: 200, body: '{}' });
    const client = createRecallClient(config());

    await client.sendChat('bot-8', 'the staging password is hunter2');

    const logged = system.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).not.toContain('hunter2');
    expect(logged).toContain('31 chars');
  });
});

describe('recall client — bot details (the teardown fetch)', () => {
  it('GETs the bot with Token auth, and reads platform, status changes, the title and the participants url out of it', async () => {
    replies.push({
      status: 200,
      body: JSON.stringify({
        meeting_url: { platform: 'zoom' },
        status_changes: [
          { code: 'joining_call', created_at: '2026-08-29T10:00:00.000Z' },
          { code: 'call_ended', created_at: '2026-08-29T10:45:00.000Z' },
        ],
        recordings: [
          {
            media_shortcuts: {
              participant_events: { data: { participants_download_url: 'https://participants.example/roster/1' } },
              meeting_metadata: { data: { title: 'Sprint planning' } },
            },
          },
        ],
      }),
    });
    const client = createRecallClient(config());

    const details = await client.getBotDetails('bot-9');

    expect(calls[0].url).toBe('https://eu-central-1.recall.ai/api/v1/bot/bot-9/');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.Authorization).toBe('Token recall-secret-key-44444');
    expect(details).toEqual({
      platform: 'zoom',
      title: 'Sprint planning',
      statusChanges: [
        { code: 'joining_call', createdAt: '2026-08-29T10:00:00.000Z' },
        { code: 'call_ended', createdAt: '2026-08-29T10:45:00.000Z' },
      ],
      participantsDownloadUrl: 'https://participants.example/roster/1',
    });
  });

  it('reads a bot object with none of it yet — a fresh bot, or Recall genuinely has nothing — as all-null-and-empty, not an error', async () => {
    replies.push({ status: 200, body: '{}' });
    const client = createRecallClient(config());

    const details = await client.getBotDetails('bot-10');

    expect(details).toEqual({
      platform: null,
      title: null,
      statusChanges: [],
      participantsDownloadUrl: null,
    });
  });

  it('drops a malformed status_changes entry rather than passing it through half-formed', async () => {
    replies.push({
      status: 200,
      body: JSON.stringify({
        status_changes: [
          { code: 'joining_call', created_at: '2026-08-29T10:00:00.000Z' },
          { code: 'call_ended' }, // no created_at
          { created_at: '2026-08-29T10:45:00.000Z' }, // no code
          'not even an object',
        ],
      }),
    });
    const client = createRecallClient(config());

    const details = await client.getBotDetails('bot-11');

    expect(details.statusChanges).toEqual([{ code: 'joining_call', createdAt: '2026-08-29T10:00:00.000Z' }]);
  });

  it('rejects a non-2xx, like every other method here', async () => {
    replies.push({ status: 404, body: '{"detail":"Not found."}' });
    const client = createRecallClient(config());

    const failure = await client.getBotDetails('bot-12').catch((err: unknown) => String(err));
    expect(failure).toContain('Recall GET');
    expect(failure).toContain('HTTP 404');
  });

  it('rejects a 2xx body that is not JSON', async () => {
    replies.push({ status: 200, body: '<html>maintenance</html>' });
    const client = createRecallClient(config());

    await expect(client.getBotDetails('bot-13')).rejects.toThrow(/not JSON/);
  });

  it('scrubs every credential the process holds out of a bot-details error body too', async () => {
    replies.push({
      status: 500,
      body: JSON.stringify({ echo: { authorization: 'Token recall-secret-key-44444' } }),
    });
    const client = createRecallClient(config());

    const failure = await client.getBotDetails('bot-14').catch((err: unknown) => String(err));
    expect(failure).not.toContain('recall-secret-key-44444');
    expect(failure).toContain('[redacted]');
  });
});

describe('recall client — participants download', () => {
  const PARTICIPANTS_URL = 'https://participants.example/roster/1';

  it('GETs the presigned url directly, with no Authorization header and no Recall base url', async () => {
    replies.push({
      status: 200,
      body: JSON.stringify([
        { id: 1, name: 'Ann', is_host: true, platform: 'zoom', extra_data: {}, email: null },
      ]),
    });
    const client = createRecallClient(config());

    const participants = await client.fetchParticipants(PARTICIPANTS_URL);

    expect(calls[0].url).toBe(PARTICIPANTS_URL);
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(participants).toEqual([{ name: 'Ann', isHost: true }]);
  });

  it('keeps a participant who was never host and never named at all, and drops Recall-internal fields we do not persist', async () => {
    replies.push({
      status: 200,
      // No is_host, no name — roster is presence, not attendance quality; a thin record is still a record.
      body: JSON.stringify([
        { id: 2, name: null, is_host: null, platform: 'phone', extra_data: { foo: 'bar' }, email: null },
      ]),
    });
    const client = createRecallClient(config());

    const participants = await client.fetchParticipants(PARTICIPANTS_URL);

    expect(participants).toEqual([{ name: null, isHost: null }]);
  });

  it('rejects a non-2xx download', async () => {
    replies.push({ status: 403, body: '{"detail":"expired"}' });
    const client = createRecallClient(config());

    const failure = await client.fetchParticipants(PARTICIPANTS_URL).catch((err: unknown) => String(err));
    expect(failure).toContain('HTTP 403');
  });

  it('rejects a body that is not a JSON array', async () => {
    replies.push({ status: 200, body: JSON.stringify({ not: 'an array' }) });
    const client = createRecallClient(config());

    await expect(client.fetchParticipants(PARTICIPANTS_URL)).rejects.toThrow(/did not return an array/);
  });

  it('scrubs every credential the process holds out of a failed download body too', async () => {
    replies.push({
      status: 500,
      body: JSON.stringify({ echo: 'deepgram-secret-key-0000' }),
    });
    const client = createRecallClient(config());

    const failure = await client.fetchParticipants(PARTICIPANTS_URL).catch((err: unknown) => String(err));
    expect(failure).not.toContain('deepgram-secret-key-0000');
    expect(failure).toContain('[redacted]');
  });
});
