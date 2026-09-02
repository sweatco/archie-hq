// Thin end of VoiceTransport: no chat channel, no setEngaged — a phone call over a media stream.
// room-silence.test.ts runs this same conversation on the fuller Recall transport; twins are named below.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../../system/logger.js';
import type { AudioSink, VoiceConfig, VoiceTransport } from '../types.js';

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

vi.mock('../speech.js', () => ({
  ttsProviderName: () => 'deepgram',
  createSpeechSession: () => ({
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
    modelProviderName: () => 'anthropic',
    wasAddressed: async () => false,
    // Null verdict mirrors the gate's fail-safe — transport here, gate wiring in room-silence.test.ts.
    runTriageGate: async () => null,
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
  deepgramApiKey: 'd',
  anthropicApiKey: 'a',
  botName: 'Archie',
};

// Typed as AudioSink, not cast: omitting setEngaged is checked against the real contract.
function audioOnlySink() {
  const state = {
    played: [] as Buffer[],
    cuts: 0,
    enabled: true,
    speaking: false,
  };
  const sink: AudioSink = {
    play(pcm: Buffer) {
      state.played.push(pcm);
      state.speaking = true;
    },
    cut() {
      state.cuts++;
      state.speaking = false;
    },
    setEnabled(open: boolean) {
      state.enabled = open;
    },
    isSpeaking: () => state.speaking,
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

function rows(sessionId: string): Array<Record<string, unknown>> {
  const path = join(WORK, 'voice-logs', `${sessionId}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function speakerFor(meeting: { onAudio(p: typeof ann, pcm: Buffer): void }) {
  const before = streams.length;
  meeting.onAudio(ann, Buffer.alloc(320));
  return streams[before];
}

describe('voice transport seam', () => {
  it('runs a whole conversation on nothing but a session id, a sink and a chat channel', async () => {
    reset();
    decideQueue.push({ speech: 'It shipped on Tuesday.' });
    const posted: string[] = [];
    const { sink, state } = audioOnlySink();
    const meeting = await makeMeeting({
      sessionId: 'seam-basic',
      sink,
      sendChat: async (text: string) => {
        posted.push(text);
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

    // Session id is the log's whole identity — nothing else reaches it.
    const written = rows('seam-basic');
    expect(written.length).toBeGreaterThan(0);
    expect(new Set(written.map((r) => r.sessionId))).toEqual(new Set(['seam-basic']));
  });

  it('treats a lone participant as the whole room', async () => {
    reset();
    // First answer is discarded — floor retaken mid-decision re-asks from scratch.
    decideQueue.push({ speech: 'Still here.' }, { speech: 'Still here.' });
    const { sink, state } = audioOnlySink();
    const meeting = await makeMeeting({ sessionId: 'seam-solo', sink });

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

  it('drops the CHAT detail when the transport has no chat channel, and still records the answer', async () => {
    reset();
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
    decideQueue.push({ speech: 'It failed on the schema change.', chat: 'commit a3f91c4' });
    const { sink, state } = audioOnlySink();
    const meeting = await makeMeeting({ sessionId: 'seam-nochat', sink });

    const a = speakerFor(meeting);
    a.emit({ kind: 'start' });
    a.emit({ kind: 'end', transcript: 'Archie, why did the job fail?' });
    await sleep(SETTLED);

    // Comprehension withholds CHAT upstream; guards against a future "helpfully read it aloud instead".
    expect(state.played.length).toBeGreaterThan(0);
    expect(synthTexts).toEqual(['It failed on the schema change.']);
    expect(synthTexts.join(' ')).not.toContain('a3f91c4');

    // Missing chat channel is a transport property, not a fault; no error logged.
    expect(errors).not.toHaveBeenCalled();

    // Recorded as answered — the room heard an answer.
    const responses = rows('seam-nochat').filter((r) => r.kind === 'response');
    expect(responses.length).toBe(1);
    expect(responses[0].verdict).toBe('addressed');
    expect(responses[0].answer).toBe('It failed on the schema change.');

    // Transcript carries only what was said aloud.
    // Twin: "posts a CHAT payload without speaking it" (room-silence.test.ts).
    decideQueue.push(null);
    a.emit({ kind: 'start' });
    a.emit({ kind: 'end', transcript: 'Archie, and when did that land?' });
    await sleep(SETTLED);
    const later = rows('seam-nochat').filter((r) => r.kind === 'response');
    expect(String(later[1].window)).toContain('Archie: It failed on the schema change.');
    expect(String(later[1].window)).not.toContain('a3f91c4');
  });

  it('does not claim to have answered when it can neither speak nor write', async () => {
    reset();
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
    synthSilent = true;
    decideQueue.push({ speech: 'It rolled back at ten.' });
    const { sink, state } = audioOnlySink();
    const meeting = await makeMeeting({ sessionId: 'seam-mute', sink });

    const a = speakerFor(meeting);
    a.emit({ kind: 'start' });
    a.emit({ kind: 'end', transcript: 'Archie, what happened to the deploy?' });
    await sleep(SETTLED);

    expect(state.played.length).toBe(0);
    // Falls back to chat (twin: "answers in chat when synthesis produces no audio", room-silence.test.ts).
    // Without one there's no second route, hence the error.
    const responses = rows('seam-mute').filter((r) => r.kind === 'response');
    expect(responses[0].verdict).toBe('error');
    expect(String(responses[0].error)).toContain('no chat channel');
    expect(errors).toHaveBeenCalled();

    // Must not record words the room never got, or the next decision thinks it's answered.
    decideQueue.push(null);
    a.emit({ kind: 'start' });
    a.emit({ kind: 'end', transcript: 'Archie, are you there?' });
    await sleep(SETTLED);
    const later = rows('seam-mute').filter((r) => r.kind === 'response');
    expect(String(later[1].window)).not.toContain('It rolled back at ten.');

    // Debt dropped, not stuck failing — second turn judged fresh (`name`, not `already-owed`).
    const tiers = rows('seam-mute')
      .filter((r) => r.kind === 'response')
      .map((r) => r.tier);
    expect(tiers).toEqual(['name', 'name']);
  });

  it('is unharmed by a sink with no setEngaged', async () => {
    reset();
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
    decideQueue.push({ speech: 'Green across the board.' });
    const { sink, state } = audioOnlySink();
    // Construction publishes engagement; an unguarded setEngaged would throw before speaking.
    const meeting = await makeMeeting({ sessionId: 'seam-notile', sink });

    const a = speakerFor(meeting);
    a.emit({ kind: 'start' });
    a.emit({ kind: 'end', transcript: 'Archie, how do the checks look?' });
    await sleep(SETTLED);

    // Engagement changes at every stage (flag, decision, follow-up); none may fault.
    expect(state.played.length).toBeGreaterThan(0);
    expect(errors).not.toHaveBeenCalled();
    await expect(meeting.stop()).resolves.toBeUndefined();
  });
});
