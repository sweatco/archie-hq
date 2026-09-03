/**
 * Recall.ai REST client: bot lifecycle (join/chat/leave) plus best-effort teardown read for `MeetingMetadata`.
 * No audio here — inbound via the realtime WebSocket, outbound via the output-media page.
 */

import { logger } from '../system/logger.js';
import type { VoiceConfig } from './types.js';

const MAX_ERROR_BODY = 500;

/** Recall config plus the voice sub-config `index.ts` builds meetings with. */
export interface RecallConfig {
  recallApiKey: string;
  recallRegion: string;
  /** e.g. https://x.ngrok-free.app, no trailing slash — Recall dials back in for both audio directions. */
  publicUrl: string;
  /** Handed down to `createMeeting` untouched, apart from the key added in `index.ts`. */
  voice: VoiceConfig;
}

/** Node's `fetch` has no default timeout — without this, a hung connection could hang forever. */
const REQUEST_TIMEOUT_MS = 15_000;

// How long Recall lets the room stand empty before pulling the bot out. Not the 2s default: Zoom issues a fresh participant id on rejoin, so a reconnect reads as an empty room.
const EVERYONE_LEFT_TIMEOUT_S = 60;

/** Teardown's picks from `GET /api/v1/bot/{id}/`'s larger bot object. */
export interface RecallBotDetails {
  /** `meeting_url.platform`: Recall's parse of the URL sent; `null` if absent. */
  platform: string | null;
  /** `recordings[0].media_shortcuts.meeting_metadata.data.title`, inline here; `null` until Recall produces one. */
  title: string | null;
  /** `status_changes[]` verbatim, oldest first: the bot's lifecycle ledger; malformed entries are dropped. */
  statusChanges: Array<{ code: string; createdAt: string }>;
  /** `recordings[0].media_shortcuts.participant_events.data.participants_download_url`; `null` until Recall generates the roster (async). */
  participantsDownloadUrl: string | null;
}

export interface RecallClient {
  createBot(opts: { meetingUrl: string; botName: string; audioWsUrl: string; pageUrl: string }): Promise<string>;
  sendChat(botId: string, text: string): Promise<void>;
  leave(botId: string): Promise<void>;
  /** `GET /api/v1/bot/{id}/`; throws on non-2xx or a bad body — caller interprets it. */
  getBotDetails(botId: string): Promise<RecallBotDetails>;
  /**
   * Follows `participantsDownloadUrl`, parses the roster: wire has `{id, name, is_host, platform, extra_data, email}`,
   * but only `name`/`is_host` return — rest is Recall-internal; `email` is always null for a raw-URL join.
   *
   * URL is pre-signed, cross-host, unauthenticated — bypasses this client's `baseUrl`-rooted `post`/`get` helpers.
   */
  fetchParticipants(url: string): Promise<Array<{ name: string | null; isHost: boolean | null }>>;
}

/** A successful HTTP exchange; a rejection arrives as a thrown Error instead. */
interface RecallResponse {
  status: number;
  /** Credentials already scrubbed — safe to log or throw. */
  body: string;
}

export function createRecallClient(cfg: RecallConfig): RecallClient {
  const baseUrl = `https://${cfg.recallRegion}.recall.ai/api/v1`;

  /**
   * Every credential in the process, not just Recall's; includes `cfg.voice`.
   * Longest first: overlapping pairs still fully redact. Short values excluded — splitting on `''` marks every character.
   */
  const secrets = [
    cfg.recallApiKey,
    cfg.voice.deepgramApiKey,
    cfg.voice.cerebrasApiKey,
    cfg.voice.sonioxApiKey,
    ...(cfg.voice.foreignSecrets ?? []),
  ]
    .filter((secret): secret is string => typeof secret === 'string' && secret.length >= 8)
    .sort((a, b) => b.length - a.length);

  /** Some upstreams echo headers into 4xx bodies, leaking the token — verbatim otherwise, the only diagnostic record. */
  function redact(body: string): string {
    let scrubbed = body;
    for (const secret of secrets) {
      scrubbed = scrubbed.split(secret).join('[redacted]');
    }
    return scrubbed;
  }

  /** POST JSON to Recall; throws on non-2xx. Redacted here, the one entry point for response bodies, so downstream can't leak a key. */
  async function post(path: string, body: unknown): Promise<RecallResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        // Recall's scheme is `Token`, not `Bearer`; the key is never logged, even on failure.
        Authorization: `Token ${cfg.recallApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = redact(await response.text().catch(() => ''));
    if (!response.ok) {
      throw new Error(
        `Recall POST ${path} failed: HTTP ${response.status} ${text.slice(0, MAX_ERROR_BODY)}`
      );
    }
    return { status: response.status, body: text };
  }

  /** GET a Recall path; throws on non-2xx. `post`'s read counterpart, used only by `getBotDetails`; same redaction/timeout/`Token` scheme. */
  async function get(path: string): Promise<RecallResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Token ${cfg.recallApiKey}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = redact(await response.text().catch(() => ''));
    if (!response.ok) {
      throw new Error(
        `Recall GET ${path} failed: HTTP ${response.status} ${text.slice(0, MAX_ERROR_BODY)}`
      );
    }
    return { status: response.status, body: text };
  }

  return {
    async createBot(opts): Promise<string> {
      // `output_media` must be set in the create body, not a later POST — that still renders the page, but
      // the bot already joined muted by default and stays muted all meeting; `output_media: null` on the bot is the tell.
      logger.system(
        `Recall: creating bot "${opts.botName}" for ${opts.meetingUrl} ` +
        `(audio → ${opts.audioWsUrl}, output page → ${opts.pageUrl})`
      );

      const response = await post('/bot/', {
        meeting_url: opts.meetingUrl,
        bot_name: opts.botName,
        variant: { zoom: 'web_4_core' },
        // URL carries a session id we minted; Recall only assigns the bot id in this request's response.
        output_media: {
          camera: { kind: 'webpage', config: { url: opts.pageUrl } },
        },
        automatic_leave: {
          everyone_left_timeout: { timeout: EVERYONE_LEFT_TIMEOUT_S },
        },
        recording_config: {
          // Per-participant, not `audio_mixed_raw`: each gets its own turn detector — attribution and turn boundaries arrive together.
          audio_separate_raw: { metadata: {} },
          start_recording_on: 'participant_join',
          realtime_endpoints: [
            {
              type: 'websocket',
              url: opts.audioWsUrl,
              // Deliberately minimal — every other Recall event shares this same socket; must not be crowded.
              events: ['audio_separate_raw.data', 'participant_events.join', 'participant_events.leave'],
            },
          ],
        },
        // No `include_bot_in_recording`: on, our speech returns as inbound audio, self-triggering the bot.
      });

      let botId: string | undefined;
      try {
        botId = (JSON.parse(response.body) as { id?: string }).id;
      } catch {
        botId = undefined;
      }
      if (!botId) {
        throw new Error(
          `Recall POST /bot/ returned no bot id: HTTP ${response.status} ${response.body.slice(0, MAX_ERROR_BODY)}`
        );
      }

      logger.system(`Recall: bot ${botId} created`);
      return botId;
    },

    async sendChat(botId: string, text: string): Promise<void> {
      await post(`/bot/${botId}/send_chat_message/`, { to: 'everyone', message: text });
      // Chat content is meeting content; the length is enough for the log.
      logger.system(`Recall: bot ${botId} sent chat to everyone (${text.length} chars)`);
    },

    async leave(botId: string): Promise<void> {
      await post(`/bot/${botId}/leave_call/`, {});
      logger.system(`Recall: bot ${botId} left the call`);
    },

    async getBotDetails(botId: string): Promise<RecallBotDetails> {
      const response = await get(`/bot/${botId}/`);

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new Error(`Recall GET /bot/${botId}/ returned a body that was not JSON`);
      }

      // `unknown`-guarded: an absent or misnested field becomes "unknown," not a thrown error — teardown must degrade, not fail.
      const bot = parsed as {
        meeting_url?: { platform?: unknown } | null;
        status_changes?: Array<{ code?: unknown; created_at?: unknown }> | null;
        recordings?: Array<{
          media_shortcuts?: {
            participant_events?: { data?: { participants_download_url?: unknown } } | null;
            meeting_metadata?: { data?: { title?: unknown } } | null;
          } | null;
        }> | null;
      };

      const statusChanges = Array.isArray(bot.status_changes)
        ? bot.status_changes
            .filter(
              (s): s is { code: string; created_at: string } =>
                typeof s?.code === 'string' && typeof s?.created_at === 'string',
            )
            .map((s) => ({ code: s.code, createdAt: s.created_at }))
        : [];

      // recordings[0]: we always request one recording_config, so nothing to pick if a second appeared.
      const shortcuts = bot.recordings?.[0]?.media_shortcuts;
      const participantsDownloadUrl = shortcuts?.participant_events?.data?.participants_download_url;
      const title = shortcuts?.meeting_metadata?.data?.title;

      logger.system(`Recall: fetched bot details for ${botId} (${statusChanges.length} status change(s))`);

      return {
        platform: typeof bot.meeting_url?.platform === 'string' ? bot.meeting_url.platform : null,
        title: typeof title === 'string' ? title : null,
        statusChanges,
        participantsDownloadUrl: typeof participantsDownloadUrl === 'string' ? participantsDownloadUrl : null,
      };
    },

    async fetchParticipants(url: string): Promise<Array<{ name: string | null; isHost: boolean | null }>> {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = redact(await response.text().catch(() => ''));
      if (!response.ok) {
        throw new Error(`Recall participants download failed: HTTP ${response.status} ${text.slice(0, MAX_ERROR_BODY)}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('Recall participants download returned a body that was not JSON');
      }
      if (!Array.isArray(parsed)) {
        throw new Error('Recall participants download did not return an array');
      }

      logger.system(`Recall: downloaded ${parsed.length} participant record(s)`);

      return parsed.map((entry) => {
        const p = (entry ?? {}) as Record<string, unknown>;
        return {
          name: typeof p.name === 'string' ? p.name : null,
          isHost: typeof p.is_host === 'boolean' ? p.is_host : null,
        };
      });
    },
  };
}
