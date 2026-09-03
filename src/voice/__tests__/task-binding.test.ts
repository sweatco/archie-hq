// No global `unhandledRejection` handler exists in `src/` (MeetingHost's doc, `../types.ts`) — appenders must swallow and log, never escape, or it kills every task and meeting.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { appendMeetingTranscript, appendMeetingEvent, appendMeetingExchange, appendMeetingChat, getMeetingTranscriptPath, writeMeetingMetadata, writeMeetingCapabilities } = vi.hoisted(() => ({
  appendMeetingTranscript: vi.fn(),
  appendMeetingEvent: vi.fn(),
  appendMeetingExchange: vi.fn(),
  appendMeetingChat: vi.fn(),
  // Deterministic stand-in for the real path helper, letting tests assert sessionId reaches the prompt — never reset, since each call site uses its own pair.
  getMeetingTranscriptPath: vi.fn((taskId: string, sessionId: string) => `/mock/${taskId}/${sessionId}/transcript.log`),
  writeMeetingMetadata: vi.fn(),
  writeMeetingCapabilities: vi.fn(),
}));
vi.mock('../../tasks/persistence.js', () => ({
  appendMeetingTranscript,
  appendMeetingEvent,
  appendMeetingExchange,
  appendMeetingChat,
  getMeetingTranscriptPath,
  writeMeetingMetadata,
  writeMeetingCapabilities,
}));

const { taskGet } = vi.hoisted(() => ({ taskGet: vi.fn() }));
vi.mock('../../tasks/task.js', () => ({
  Task: { get: taskGet },
  activeTasks: new Map(),
}));

/** The host's one async method delegates straight to this; behaviour pinned in written-channel.test.ts. */
const { readWrittenExchange } = vi.hoisted(() => ({ readWrittenExchange: vi.fn() }));
vi.mock('../written.js', () => ({ readWrittenExchange }));

import { logger } from '../../system/logger.js';
import { loadPrompt } from '../../utils/prompt-loader.js';
import type { Meeting } from '../meeting.js';
import {
  createTaskHost,
  registerLiveMeeting,
  unregisterLiveMeeting,
  reserveMeetingSlot,
  releaseMeetingSlot,
  recallChannelKey,
  linkRecallChannel,
  endRecallChannel,
  notifyMeetingEnded,
  writeMeetingMetadataStart,
  updateMeetingParticipantsLive,
  completeMeetingMetadata,
  recordMeetingCapabilities,
} from '../task-binding.js';
import type { TaskMetadata } from '../../types/task.js';

function fakeMeeting(): Meeting {
  return {
    onAudio: vi.fn(),
    deliverConsultAnswer: vi.fn().mockReturnValue({ ok: true }),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as Meeting;
}

/** The connector's teardown funnel, for the tests that aren't about `leaveMeeting`. */
const noopEnd = async (): Promise<void> => {};

// Lets queued microtasks (the host's un-awaited `.catch()` chains) settle before assertions run.
const drain = () => new Promise((r) => setTimeout(r, 10));

describe('createTaskHost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    appendMeetingTranscript.mockReset();
    appendMeetingEvent.mockReset();
    appendMeetingExchange.mockReset();
    appendMeetingChat.mockReset();
    writeMeetingMetadata.mockReset();
    taskGet.mockReset();
  });

  describe('recordUtterance / noteEvent', () => {
    it('records a finalised utterance via appendMeetingTranscript, scoped to this meeting', () => {
      appendMeetingTranscript.mockResolvedValue(undefined);
      const host = createTaskHost('task-utter', 'sess-utter', noopEnd);

      host.recordUtterance('Ann', 'when did it ship?');

      expect(appendMeetingTranscript).toHaveBeenCalledWith('task-utter', 'sess-utter', 'Ann', 'when did it ship?');
    });

    it('records an event via appendMeetingEvent, not the transcript', () => {
      appendMeetingEvent.mockResolvedValue(undefined);
      const host = createTaskHost('task-event', 'sess-event', noopEnd);

      host.noteEvent('meeting started');

      expect(appendMeetingEvent).toHaveBeenCalledWith('task-event', 'meeting started');
      expect(appendMeetingTranscript).not.toHaveBeenCalled();
    });

    it('does not take down the meeting when the underlying appender rejects, and logs', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      appendMeetingTranscript.mockRejectedValue(new Error('disk is full'));
      const host = createTaskHost('task-reject', 'sess-reject', noopEnd);

      expect(() => host.recordUtterance('Ann', 'hello')).not.toThrow();
      await drain();

      expect(warn).toHaveBeenCalled();
      const [prefix, message] = warn.mock.calls[0];
      expect(prefix).toBe('voice-task-binding');
      expect(String(message)).toContain('task-reject');
    });

    it('records a meeting-chat line via appendMeetingChat, never the transcript', async () => {
      // A line lands in exactly one file — chat filed as an utterance would have Archie believe it said what it wrote.
      appendMeetingChat.mockResolvedValue(undefined);
      const host = createTaskHost('task-written', 'sess-written', noopEnd);

      host.recordChat('Archie', 'commit 4f2a91c, deployed 12:03 UTC');

      expect(appendMeetingChat).toHaveBeenCalledWith('task-written', 'sess-written', 'Archie', 'commit 4f2a91c, deployed 12:03 UTC');
      expect(appendMeetingTranscript).not.toHaveBeenCalled();
    });

    it('does not take down the meeting when appendMeetingChat rejects', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      appendMeetingChat.mockRejectedValue(new Error('ENOSPC'));
      const host = createTaskHost('task-written-reject', 'sess-written-reject', noopEnd);

      expect(() => host.recordChat('Archie', 'commit 4f2a91c')).not.toThrow();
      await drain();

      expect(warn.mock.calls.some((c) => String(c[1]).includes('task-written-reject'))).toBe(true);
    });

    it('delegates readWrittenExchange with this task', async () => {
      readWrittenExchange.mockResolvedValue([{ speaker: 'Ann', text: 'can you join?' }]);
      const host = createTaskHost('task-exchange-read', 'sess-exchange-read', noopEnd);

      await expect(host.readWrittenExchange()).resolves.toEqual([{ speaker: 'Ann', text: 'can you join?' }]);
      expect(readWrittenExchange).toHaveBeenCalledWith('task-exchange-read');
    });

    it('does the same for noteEvent when appendMeetingEvent rejects', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      appendMeetingEvent.mockRejectedValue(new Error('ENOENT'));
      const host = createTaskHost('task-reject-2', 'sess-reject-2', noopEnd);

      expect(() => host.noteEvent('meeting ended')).not.toThrow();
      await drain();

      expect(warn).toHaveBeenCalled();
    });
  });

  describe('consult', () => {
    it('wakes the PM with the question and the channel key, and does not touch the meeting on success', async () => {
      appendMeetingEvent.mockResolvedValue(undefined);
      appendMeetingExchange.mockResolvedValue(undefined);
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      taskGet.mockResolvedValue({ sendMessage });
      const meeting = fakeMeeting();
      registerLiveMeeting('task-ok', meeting);

      const host = createTaskHost('task-ok', 'sess-ok', noopEnd);
      expect(() => host.consult('c1', 'what is the deploy status?')).not.toThrow();
      await drain();

      expect(taskGet).toHaveBeenCalledWith('task-ok');
      expect(sendMessage).toHaveBeenCalledWith(
        await loadPrompt('voice-wakeup-question', {
          CHANNEL_KEY: 'recall:sess-ok',
          QUESTION: 'what is the deploy status?',
        }),
        'pm-agent',
      );
      expect(meeting.deliverConsultAnswer).not.toHaveBeenCalled();
      // The "asked" half of the exchange log — appendMeetingExchange's doc explains the 'voice' label and sessionId scope.
      expect(appendMeetingExchange).toHaveBeenCalledWith('task-ok', 'sess-ok', 'voice', 'what is the deploy status?');

      unregisterLiveMeeting('task-ok');
    });

    // A consult that can't be delivered must surface as a failed answer, so a spoken promise ("let me check with the team") isn't left unkept.
    // No id check needed: FIFO is correct — nothing else can jump the queue between this consult being raised and the catch block running.
    it('answers a consult that cannot be delivered as a failed answer', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      appendMeetingEvent.mockResolvedValue(undefined);
      appendMeetingExchange.mockResolvedValue(undefined);
      taskGet.mockRejectedValue(new Error('Task task-gone not found'));
      const meeting = fakeMeeting();
      registerLiveMeeting('task-gone', meeting);

      const host = createTaskHost('task-gone', 'sess-gone', noopEnd);
      expect(() => host.consult('c-42', 'are we still shipping today?')).not.toThrow();
      await drain();

      expect(meeting.deliverConsultAnswer).toHaveBeenCalledTimes(1);
      const [text] = (meeting.deliverConsultAnswer as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(typeof text).toBe('string');
      expect((text as string).length).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalled();
      // The question was asked whether or not the PM was reachable — the log records that regardless.
      expect(appendMeetingExchange).toHaveBeenCalledWith('task-gone', 'sess-gone', 'voice', 'are we still shipping today?');

      unregisterLiveMeeting('task-gone');
    });

    // Distinct from the test above: a synthetic answer in the room isn't enough — exchange.log must also show something came back, or a reader sees it as unanswered.
    // Labelled 'system', never 'pm-agent' — the PM was never reached, and the log must not imply otherwise.
    it('leaves no dangling question in the exchange log when delivery fails — the failure is recorded as such, not silently', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      appendMeetingEvent.mockResolvedValue(undefined);
      appendMeetingExchange.mockResolvedValue(undefined);
      taskGet.mockRejectedValue(new Error('Task task-dangling not found'));
      const meeting = fakeMeeting();
      registerLiveMeeting('task-dangling', meeting);

      const host = createTaskHost('task-dangling', 'sess-dangling', noopEnd);
      host.consult('c-99', 'is the deploy still on track?');
      await drain();

      expect(appendMeetingExchange).toHaveBeenCalledTimes(2);
      const [askedCall, answeredCall] = appendMeetingExchange.mock.calls;
      expect(askedCall).toEqual(['task-dangling', 'sess-dangling', 'voice', 'is the deploy still on track?']);
      const [, , answerSpeaker, answerMessage] = answeredCall;
      expect(answerSpeaker).not.toBe('pm-agent');
      expect(answerSpeaker).toBe('system');
      // So the exchange log agrees with what was actually spoken into the room.
      const [roomText] = (meeting.deliverConsultAnswer as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(answerMessage).toBe(roomText);
      expect(answerMessage).toMatch(/could not be reached/i);

      unregisterLiveMeeting('task-dangling');
    });

    it('does not throw when no meeting is registered for the failing consult (registry lookup is optional)', async () => {
      taskGet.mockRejectedValue(new Error('Task task-nobody not found'));
      appendMeetingEvent.mockResolvedValue(undefined);
      appendMeetingExchange.mockResolvedValue(undefined);
      vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const host = createTaskHost('task-nobody', 'sess-nobody', noopEnd); // never registered
      expect(() => host.consult('c1', 'anyone there?')).not.toThrow();
      await expect(drain()).resolves.toBeUndefined();
    });
  });

  describe('leaveMeeting', () => {
    it("hands the connector's teardown this meeting's own sessionId, without waiting for it", async () => {
      // Sync void by contract (types.ts): it fires from the audio loop, so it must not await teardown.
      let resolveEnd!: () => void;
      const end = vi.fn(() => new Promise<void>((resolve) => { resolveEnd = resolve; }));
      const host = createTaskHost('task-leave', 'sess-leave', end);

      expect(host.leaveMeeting()).toBeUndefined();

      expect(end).toHaveBeenCalledWith('sess-leave');
      resolveEnd();
      await drain();
    });

    it('swallows a teardown that rejects, and logs — a failed leave must not kill the process', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const end = vi.fn().mockRejectedValue(new Error('Recall is unreachable'));
      const host = createTaskHost('task-leave-fails', 'sess-leave-fails', end);

      expect(() => host.leaveMeeting()).not.toThrow();
      await drain();

      expect(warn.mock.calls.some((c) => String(c[1]).includes('sess-leave-fails'))).toBe(true);
    });
  });
});

describe('the meeting slot', () => {
  // Closes a window in the connector's `startMeeting`: bot creation under way with no Meeting registered yet must read busy, or two close join_recall_meeting calls both create a bot.
  it('refuses a reservation while a meeting is live on the task', () => {
    registerLiveMeeting('task-already', fakeMeeting());

    expect(reserveMeetingSlot('task-already')).toBe(false);

    unregisterLiveMeeting('task-already');
  });

  it('refuses a second reservation on a task whose slot is only reserved, not yet live', () => {
    expect(reserveMeetingSlot('task-reserved')).toBe(true);

    expect(reserveMeetingSlot('task-reserved')).toBe(false);

    releaseMeetingSlot('task-reserved');
    // Released, so a failed creation cannot strand the task.
    expect(reserveMeetingSlot('task-reserved')).toBe(true);
    releaseMeetingSlot('task-reserved');
  });

  it('frees the reservation as the meeting goes live, so the two never both hold the slot', () => {
    expect(reserveMeetingSlot('task-handover')).toBe(true);
    registerLiveMeeting('task-handover', fakeMeeting());

    unregisterLiveMeeting('task-handover');

    expect(reserveMeetingSlot('task-handover')).toBe(true);
    releaseMeetingSlot('task-handover');
  });
});

describe('the meeting-ended wake-up', () => {
  it('names the transcript file it is handing over', async () => {
    const text = await loadPrompt('voice-wakeup-ended', {
      TRANSCRIPT_PATH: '/workdir/tasks/task-1/shared/meeting-transcript.log',
    });

    expect(text).toContain('/workdir/tasks/task-1/shared/meeting-transcript.log');
  });

  it('still says plainly that the room has dispersed and nothing posted now reaches it', async () => {
    const text = await loadPrompt('voice-wakeup-ended', { TRANSCRIPT_PATH: '/path/to/transcript.log' });

    expect(text).toMatch(/dispersed/i);
    expect(text).toMatch(/nothing you post now reaches/i);
  });
});

describe('notifyMeetingEnded', () => {
  // Pins sessionId, not just taskId, reaching the transcript path — else the wake-up could point at the wrong meeting's file on a multi-meeting task.
  it('wakes the PM with the ended wake-up, pointing at this meeting\'s own transcript path', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    taskGet.mockResolvedValue({ sendMessage });

    notifyMeetingEnded('task-ended', 'sess-ended');
    await drain();

    expect(taskGet).toHaveBeenCalledWith('task-ended');
    expect(getMeetingTranscriptPath).toHaveBeenCalledWith('task-ended', 'sess-ended');
    expect(sendMessage).toHaveBeenCalledWith(
      await loadPrompt('voice-wakeup-ended', { TRANSCRIPT_PATH: '/mock/task-ended/sess-ended/transcript.log' }),
      'pm-agent',
    );
  });

  it('does not throw when the task cannot be loaded, and logs', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    taskGet.mockRejectedValue(new Error('task-ended-gone not found'));

    expect(() => notifyMeetingEnded('task-ended-gone', 'sess-ended-gone')).not.toThrow();
    await drain();

    expect(warn).toHaveBeenCalled();
  });
});

describe('recallChannelKey', () => {
  it('builds the exact key linkRecallChannel writes and the consult prompt names', () => {
    expect(recallChannelKey('bot-abc')).toBe('recall:bot-abc');
  });
});

describe('linkRecallChannel', () => {
  function fakeTask(metadata: Partial<TaskMetadata>) {
    const save = vi.fn().mockResolvedValue(undefined);
    const task = { metadata: metadata as TaskMetadata, save };
    taskGet.mockResolvedValue(task);
    return { task, save };
  }

  it('links an active recall channel keyed by session id, and flushes', async () => {
    const { task, save } = fakeTask({ channels: {}, default_channel: 'slack:C1:100' });

    await linkRecallChannel('task-link', 'bot-1', 'https://zoom.us/j/1');

    expect(task.metadata.channels['recall:bot-1']).toEqual({
      type: 'recall',
      session_id: 'bot-1',
      url: 'https://zoom.us/j/1',
      ended: false,
    });
    expect(save).toHaveBeenCalledWith(true);
  });

  // A durable channel link must never make a meeting the default_channel — only task.ts's `??=` sites assign that; this must not become a fourth.
  it('never assigns default_channel, whatever it already was', async () => {
    const { task } = fakeTask({ channels: {}, default_channel: 'slack:C1:100' });
    await linkRecallChannel('task-link-2', 'bot-2', 'https://zoom.us/j/2');
    expect(task.metadata.default_channel).toBe('slack:C1:100');

    const { task: task2 } = fakeTask({ channels: {}, default_channel: null });
    await linkRecallChannel('task-link-3', 'bot-3', 'https://zoom.us/j/3');
    expect(task2.metadata.default_channel).toBeNull();
  });

  it('does not throw when the task cannot be loaded, and logs', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    taskGet.mockRejectedValue(new Error('task-gone-3 not found'));

    await expect(linkRecallChannel('task-gone-3', 'bot-4', 'url')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('endRecallChannel', () => {
  function fakeTask(metadata: Partial<TaskMetadata>) {
    const save = vi.fn().mockResolvedValue(undefined);
    const task = { metadata: metadata as TaskMetadata, save };
    taskGet.mockResolvedValue(task);
    return { task, save };
  }

  it('marks the record ended in place — never removes it — and flushes', async () => {
    const { task, save } = fakeTask({
      channels: { 'recall:bot-5': { type: 'recall', session_id: 'bot-5', url: 'u', ended: false } },
      default_channel: null,
    });

    await endRecallChannel('task-end', 'bot-5');

    expect(task.metadata.channels['recall:bot-5']).toEqual({
      type: 'recall',
      session_id: 'bot-5',
      url: 'u',
      ended: true,
    });
    expect(Object.keys(task.metadata.channels)).toEqual(['recall:bot-5']);
    expect(save).toHaveBeenCalledWith(true);
  });

  it('is a no-op when the record is already gone, rather than inventing one', async () => {
    const { task, save } = fakeTask({ channels: {}, default_channel: null });

    await endRecallChannel('task-missing', 'bot-6');

    expect(task.metadata.channels).toEqual({});
    expect(save).not.toHaveBeenCalled();
  });

  it('does not throw when the task cannot be loaded, and logs', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    taskGet.mockRejectedValue(new Error('task-gone-4 not found'));

    await expect(endRecallChannel('task-gone-4', 'bot-7')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('writeMeetingMetadataStart', () => {
  afterEach(() => {
    writeMeetingMetadata.mockReset();
  });

  it('writes the first half of the record, with everything else honestly null', async () => {
    writeMeetingMetadata.mockResolvedValue(undefined);

    await writeMeetingMetadataStart('task-meta-1', 'sess-meta-1', 'https://zoom.us/j/1', '2026-08-29T10:00:00.000Z');

    expect(writeMeetingMetadata).toHaveBeenCalledWith('task-meta-1', 'sess-meta-1', {
      session_id: 'sess-meta-1',
      url: 'https://zoom.us/j/1',
      platform: null,
      title: null,
      archie_joined_at: '2026-08-29T10:00:00.000Z',
      meeting_ended_at: null,
      duration_seconds: null,
      participants: null,
      live_participants: [],
    });
  });

  it('does not throw when the write fails, and logs', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    writeMeetingMetadata.mockRejectedValue(new Error('disk is full'));

    await expect(
      writeMeetingMetadataStart('task-meta-2', 'sess-meta-2', 'https://zoom.us/j/2', '2026-08-29T10:00:00.000Z'),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('updateMeetingParticipantsLive', () => {
  afterEach(() => {
    writeMeetingMetadata.mockReset();
  });

  it('rewrites the file with the live roster, re-asserting every other field null', async () => {
    writeMeetingMetadata.mockResolvedValue(undefined);

    await updateMeetingParticipantsLive('task-live-1', 'sess-live-1', 'https://zoom.us/j/live1', '2026-08-29T10:00:00.000Z', [
      { name: 'Ann', is_host: true, joined_at: '2026-08-29T10:01:00.000Z', left_at: null },
    ]);

    expect(writeMeetingMetadata).toHaveBeenCalledWith('task-live-1', 'sess-live-1', {
      session_id: 'sess-live-1',
      url: 'https://zoom.us/j/live1',
      platform: null,
      title: null,
      archie_joined_at: '2026-08-29T10:00:00.000Z',
      meeting_ended_at: null,
      duration_seconds: null,
      participants: null,
      live_participants: [{ name: 'Ann', is_host: true, joined_at: '2026-08-29T10:01:00.000Z', left_at: null }],
    });
  });

  it('does not throw when the write fails, and logs', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    writeMeetingMetadata.mockRejectedValue(new Error('disk is full'));

    await expect(
      updateMeetingParticipantsLive('task-live-2', 'sess-live-2', 'https://zoom.us/j/live2', '2026-08-29T10:00:00.000Z', []),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('completeMeetingMetadata', () => {
  afterEach(() => {
    writeMeetingMetadata.mockReset();
    vi.useRealTimers();
  });

  it('completes the record with everything the teardown fetch found, duration computed from the two timestamps', async () => {
    writeMeetingMetadata.mockResolvedValue(undefined);

    await completeMeetingMetadata('task-meta-3', 'sess-meta-3', {
      url: 'https://zoom.us/j/3',
      archieJoinedAt: '2026-08-29T10:00:00.000Z',
      platform: 'zoom',
      title: 'Sprint planning',
      meetingEndedAt: '2026-08-29T10:45:00.000Z',
      participants: [
        { name: 'Ann', isHost: true },
        { name: 'Ghost', isHost: false },
      ],
      // Carried in from the connector's own live accumulation; teardown passes it straight through, never recomputing.
      liveParticipants: [
        { name: 'Ann', is_host: true, joined_at: '2026-08-29T10:01:00.000Z', left_at: null },
      ],
    });

    expect(writeMeetingMetadata).toHaveBeenCalledWith('task-meta-3', 'sess-meta-3', {
      session_id: 'sess-meta-3',
      url: 'https://zoom.us/j/3',
      platform: 'zoom',
      title: 'Sprint planning',
      archie_joined_at: '2026-08-29T10:00:00.000Z',
      meeting_ended_at: '2026-08-29T10:45:00.000Z',
      duration_seconds: 45 * 60,
      // Renamed to the persisted shape's field names, including the participant ("Ghost") who never spoke.
      participants: [
        { name: 'Ann', is_host: true },
        { name: 'Ghost', is_host: false },
      ],
      // Verbatim — teardown never closes out `left_at` on this connector's behalf, even though the meeting has ended.
      live_participants: [
        { name: 'Ann', is_host: true, joined_at: '2026-08-29T10:01:00.000Z', left_at: null },
      ],
    });
  });

  it('invents nothing when the fetch found nothing — every unknown field stays null, not guessed', async () => {
    writeMeetingMetadata.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T12:00:00.000Z'));

    await completeMeetingMetadata('task-meta-4', 'sess-meta-4', {
      url: 'https://zoom.us/j/4',
      archieJoinedAt: '2026-08-29T11:30:00.000Z',
      platform: null,
      title: null,
      meetingEndedAt: null,
      participants: null,
      liveParticipants: [],
    });

    const [, , written] = writeMeetingMetadata.mock.calls[0];
    expect(written.platform).toBeNull();
    expect(written.title).toBeNull();
    expect(written.participants).toBeNull();
    // Unlike participants (null = fetch never ran), live_participants is always an array — empty here because nobody joined, not because anything failed.
    expect(written.live_participants).toEqual([]);
    // Unlike platform/title/participants, meeting_ended_at falls back to this call's wall clock, not null — the meeting has, one way or another, ended by now.
    expect(written.meeting_ended_at).toBe('2026-08-29T12:00:00.000Z');
    expect(written.duration_seconds).toBe(30 * 60);
  });

  it('reports no duration rather than a negative one when the two timestamps disagree', async () => {
    writeMeetingMetadata.mockResolvedValue(undefined);

    await completeMeetingMetadata('task-meta-5', 'sess-meta-5', {
      url: 'https://zoom.us/j/5',
      archieJoinedAt: '2026-08-29T10:00:00.000Z',
      platform: null,
      title: null,
      // Earlier than archieJoinedAt — two clocks disagreeing, not a real span.
      meetingEndedAt: '2026-08-29T09:00:00.000Z',
      participants: null,
      liveParticipants: [],
    });

    const [, , written] = writeMeetingMetadata.mock.calls[0];
    expect(written.duration_seconds).toBeNull();
  });

  it('does not throw when the write fails, and logs', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    writeMeetingMetadata.mockRejectedValue(new Error('disk is full'));

    await expect(
      completeMeetingMetadata('task-meta-6', 'sess-meta-6', {
        url: 'https://zoom.us/j/6',
        archieJoinedAt: '2026-08-29T10:00:00.000Z',
        platform: null,
        title: null,
        meetingEndedAt: null,
        participants: null,
        liveParticipants: [],
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

// Drained via microtasks, not the shared drain(): writer is sync void with an internal promise chain, and a later test freezes the clock, which would stop a real setTimeout.
const flushMicrotasks = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

describe('recordMeetingCapabilities', () => {
  afterEach(() => {
    writeMeetingCapabilities.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes the block verbatim to this meeting's own folder, with the moment it landed", async () => {
    writeMeetingCapabilities.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T09:30:00.000Z'));
    // Multi-line on purpose — the block's line shape is half of what a reader needs, and exactly what a line-per-entry log would flatten.
    const block = '- Look up numbers in the analytics warehouse\n- Read the code in the team repositories';

    recordMeetingCapabilities('task-caps-1', 'sess-caps-1', block);
    await flushMicrotasks();

    expect(writeMeetingCapabilities).toHaveBeenCalledWith('task-caps-1', 'sess-caps-1', {
      session_id: 'sess-caps-1',
      outcome: 'summarised',
      summary: block,
      captured_at: '2026-09-02T09:30:00.000Z',
    });
  });

  it('records an empty summary as such rather than leaving no file — the empty case is a finding, not an absence', async () => {
    writeMeetingCapabilities.mockResolvedValue(undefined);

    recordMeetingCapabilities('task-caps-2', 'sess-caps-2', '');
    await flushMicrotasks();

    expect(writeMeetingCapabilities).toHaveBeenCalledTimes(1);
    const [, , written] = writeMeetingCapabilities.mock.calls[0];
    expect(written.outcome).toBe('empty');
    expect(written.summary).toBe('');
  });

  it('counts a whitespace-only summary as empty, because that is what the model gets', async () => {
    // setCapabilities and the prompt renderer both trim, so this reaches the model as no block — recording spaces would store what the meeting never saw.
    writeMeetingCapabilities.mockResolvedValue(undefined);

    recordMeetingCapabilities('task-caps-3', 'sess-caps-3', '   \n\t ');
    await flushMicrotasks();

    const [, , written] = writeMeetingCapabilities.mock.calls[0];
    expect(written.outcome).toBe('empty');
    expect(written.summary).toBe('');
  });

  it('warns when the write fails, so a missing file is never read as an empty block', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    writeMeetingCapabilities.mockRejectedValue(new Error('disk is full'));

    recordMeetingCapabilities('task-caps-4', 'sess-caps-4', '- Look up numbers in the analytics warehouse');
    await flushMicrotasks();

    expect(warn).toHaveBeenCalled();
    const [prefix, message] = warn.mock.calls[0];
    expect(prefix).toBe('voice-task-binding');
    // Named, or a reader with several live meetings can't tell which lost its record.
    expect(String(message)).toContain('task-caps-4');
  });

  it('does not re-log the empty case as a failure — one degradation, one warning', async () => {
    // setCapabilities in meeting.ts already warns for this — a second warning here would make one degraded meeting look like two faults.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    writeMeetingCapabilities.mockResolvedValue(undefined);

    recordMeetingCapabilities('task-caps-5', 'sess-caps-5', '');
    await flushMicrotasks();

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not propagate a failed write into the join path it is called from', async () => {
    // Caller is the un-awaited `.then()` in `startMeeting` — sync void, nothing pending; Vitest itself fails the run on a leaked rejection.
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    writeMeetingCapabilities.mockRejectedValue(new Error('disk is full'));

    expect(recordMeetingCapabilities('task-caps-6', 'sess-caps-6', '- Something')).toBeUndefined();
    await flushMicrotasks();
  });
});
