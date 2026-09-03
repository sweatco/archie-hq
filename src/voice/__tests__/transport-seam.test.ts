// VoiceTransport is the whole of what meeting.ts sees: a session id, a sink, a chat channel and somewhere to record, nothing about Recall.
// room-silence.test.ts runs the same conversation against the connector's own sink shape; twins are named below.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../../system/logger.js';
import type { AudioSink, MeetingRow, VoiceConfig, VoiceTransport } from '../types.js';

const WORK = mkdtempSync(join(tmpdir(), 'voice-transport-'));
process.env.ARCHIE_WORKDIR = WORK;

type TurnEvent = { kind: 'start' } | { kind: 'end'; transcript: string };

interface FakeStream {
  label: string;
  turnOpen: boolean;
  emit(e: TurnEvent): void;
}

const streams: FakeStream[] = [];

const synthTexts: string[] = [];
let synthSilent = false;
let inFlight = 0;

interface Answer {
  speech: string;
  chat?: string;
}

let decideCalls = 0;
const decideQueue: Array<Answer | null> = [];

vi.mock('../deepgram.js', () => ({
  openTurnStream: (
    _cfg: unknown,
    opts: { label: string; onEvent: (e: TurnEvent) => void },
  ) => {
    const fake: FakeStream = {
      label: opts.label,
      turnOpen: false,
      emit(e: TurnEvent) {
        fake.turnOpen = e.kind === 'start';
        opts.onEvent(e);
      },
    };
    streams.push(fake);
    return {
      write() {},
      isTurnOpen: () => fake.turnOpen,
      isAlive: () => true,
      close() {
        fake.turnOpen = false;
      },
    };
  },
}));

vi.mock('../soniox.js', () => ({
  createSonioxSpeechSession: () => ({
    speak(onPcm: (pcm: Buffer) => void) {
      let aborted = false;
      let bytes = 0;
      const deliveries: Array<Promise<void>> = [];
      return {
        say(text: string) {
          synthTexts.push(text);
          if (!aborted && !synthSilent) {
            inFlight++;
            deliveries.push(
              // Audio arrives over a socket, not synchronously in `say` — hence the tick delay.
              new Promise<void>((resolve) => setTimeout(resolve, 1))
                .then(() => {
                  if (!aborted) {
                    onPcm(Buffer.alloc(64));
                    bytes += 64;
                  }
                })
                .finally(() => {
                  inFlight--;
                }),
            );
          }
        },
        async end() {
          await Promise.all(deliveries);
          return { bytes, msToFirstByte: bytes > 0 ? 12 : null, incomplete: null };
        },
        abort() {
          aborted = true;
        },
      };
    },
    close() {},
  }),
}));

vi.mock('../comprehension.js', () => {
  /** Splits like the real emitter: whole sentences, terminator attached. */
  const sentencesOf = (speech: string): string[] =>
    (speech.match(/[^.!?]+[.!?]*/g) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);

  return {
    wasAddressed: async () => false,
    decideResponse: async (
      _cfg: unknown,
      opts: { transcript: string; onSentence?: (text: string) => void },
    ) => {
      decideCalls++;
      const answer = decideQueue.length > 0 ? decideQueue.shift()! : null;
      if (answer === null) {
        return { outcome: 'silence' };
      } else {
        for (const sentence of sentencesOf(answer.speech)) {
          opts.onSentence?.(sentence);
        }
        return { outcome: 'speak', response: answer };
      }
    },
  };
});

const cfg: VoiceConfig = {
  recallApiKey: 'recall-key',
  recallRegion: 'eu-central-1',
  deepgramApiKey: 'd',
  sonioxApiKey: 'soniox-key',
  cerebrasApiKey: 'cerebras-key',
  publicUrl: 'https://archie.example',
};

// Typed as AudioSink, not cast: the seam is checked against the real contract, nothing more of it implemented than that.
function plainSink() {
  const state = {
    played: [] as Buffer[],
    cuts: 0,
    enabled: true,
    engaged: false,
    speaking: false,
    sentBytes: 0,
  };
  const sink: AudioSink = {
    play(pcm: Buffer) {
      state.played.push(pcm);
      state.speaking = true;
      state.sentBytes += pcm.length;
    },
    cut() {
      state.cuts++;
      state.speaking = false;
    },
    setEnabled(open: boolean) {
      state.enabled = open;
    },
    setEngaged(engaged: boolean) {
      state.engaged = engaged;
    },
    isSpeaking: () => state.speaking,
    playedBytes: () => state.sentBytes,
  };
  return { sink, state };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long enough for a decision and stubbed synthesis to complete. */
const SETTLED = 80;

const ann = { id: '1', name: 'Ann', email: null, isHost: true };

const openMeetings: Array<{ stop(): Promise<void> }> = [];

function reset(): void {
  streams.length = 0;
  synthTexts.length = 0;
  decideQueue.length = 0;
  synthSilent = false;
  decideCalls = 0;
}

afterEach(async () => {
  for (const meeting of openMeetings.splice(0, openMeetings.length)) {
    await meeting.stop();
  }
  // Nothing cancels an in-flight decision; wait it out or it pollutes the next test's counters.
  for (let i = 0; inFlight > 0 && i < 200; i++) {
    await sleep(10);
  }
  vi.restoreAllMocks();
});

async function makeMeeting(transport: VoiceTransport) {
  const { createMeeting } = await import('../meeting.js');
  const meeting = createMeeting(cfg, transport);
  openMeetings.push(meeting);
  return meeting;
}

function speakerFor(meeting: { onAudio(p: typeof ann, pcm: Buffer): void }) {
  const before = streams.length;
  meeting.onAudio(ann, Buffer.alloc(320));
  return streams[before];
}

describe('voice transport seam', () => {
  it('runs a whole conversation on nothing but a session id, a sink, a chat channel and a recorder', async () => {
    reset();
    decideQueue.push({ speech: 'It shipped on Tuesday.' });
    const posted: string[] = [];
    const recorded: MeetingRow[] = [];
    const { sink, state } = plainSink();
    const meeting = await makeMeeting({
      sessionId: 'seam-basic',
      sink,
      sendChat: async (text: string) => {
        posted.push(text);
      },
      record: (row) => {
        recorded.push(row);
      },
    });

    const a = speakerFor(meeting);
    a.emit({ kind: 'start' });
    a.emit({ kind: 'end', transcript: 'Archie, when did it ship?' });
    await sleep(SETTLED);

    // Proves packet-in, turn, decision, and speech all ran through the interface alone.
    expect(state.played.length).toBeGreaterThan(0);
    expect(synthTexts).toEqual(['It shipped on Tuesday.']);
    expect(posted).toEqual([]);

    // The record travels through the transport and nowhere else: the whole turn is here, and the conversation opened no file of its own.
    expect(recorded.map((r) => r.type)).toEqual(['utterance', 'gate', 'utterance', 'turn']);
    expect(existsSync(join(WORK, 'voice-logs'))).toBe(false);
  });

  it('treats a lone participant as the whole room', async () => {
    reset();
    // First answer is discarded — floor retaken mid-decision re-asks from scratch.
    decideQueue.push({ speech: 'Still here.' }, { speech: 'Still here.' });
    const { sink, state } = plainSink();
    const meeting = await makeMeeting({ sessionId: 'seam-solo', sink, sendChat: async () => {}, record: () => {} });

    // No per-participant separation on a media stream; this speaker's turn state is the floor.
    const a = speakerFor(meeting);
    expect(streams.length).toBe(1);

    a.emit({ kind: 'start' });
    a.emit({ kind: 'end', transcript: 'Archie, are you there?' });
    // Retaken floor, one participant: not-quiet by itself, so nothing may be heard.
    a.emit({ kind: 'start' });
    await sleep(SETTLED);
    expect(state.played.length).toBe(0);

    a.emit({ kind: 'end', transcript: 'sorry, go on' });
    await sleep(SETTLED);
    expect(state.played.length).toBeGreaterThan(0);
  });

  it('publishes engagement through the whole turn without faulting', async () => {
    reset();
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
    decideQueue.push({ speech: 'Green across the board.' });
    const { sink, state } = plainSink();
    // Construction publishes engagement before a word is spoken; every later stage (flag, decision, follow-up) publishes again.
    const meeting = await makeMeeting({ sessionId: 'seam-tile', sink, sendChat: async () => {}, record: () => {} });

    const a = speakerFor(meeting);
    a.emit({ kind: 'start' });
    a.emit({ kind: 'end', transcript: 'Archie, how do the checks look?' });
    await sleep(SETTLED);

    expect(state.played.length).toBeGreaterThan(0);
    // Green: it just spoke, so the follow-up window is still open.
    expect(state.engaged).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    await expect(meeting.stop()).resolves.toBeUndefined();
    // Teardown disengages — a tile left green outlives the meeting.
    expect(state.engaged).toBe(false);
  });
});
