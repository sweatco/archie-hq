// No global `unhandledRejection` handler exists in `src/` (MeetingHost's doc, `../types.ts`) — appenders must swallow and log, never escape, or it kills every task and meeting.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { appendMeetingEvent, appendMeetingRow, getMeetingRecordPath } = vi.hoisted(() => ({
  appendMeetingEvent: vi.fn(),
  appendMeetingRow: vi.fn(),
  // Deterministic stand-in for the real path helper, letting tests assert sessionId reaches the prompt — never reset, since each call site uses its own pair.
  getMeetingRecordPath: vi.fn((taskId: string, sessionId: string) => `/mock/${taskId}/${sessionId}/meeting.jsonl`),
}));
vi.mock('../../tasks/persistence.js', () => ({
  appendMeetingEvent,
  appendMeetingRow,
  getMeetingRecordPath,
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
    appendMeetingEvent.mockReset();
    appendMeetingRow.mockReset();
    taskGet.mockReset();
  });

  // The host is now four methods: the room's own speech and chat go straight to the transport's recorder, never through here.
  describe('what the host is, and is not', () => {
    it('records an event via appendMeetingEvent, and writes no row of its own', () => {
      appendMeetingEvent.mockResolvedValue(undefined);
      const host = createTaskHost('task-event', 'sess-event', noopEnd);

      host.noteEvent('meeting started');

      expect(appendMeetingEvent).toHaveBeenCalledWith('task-event', 'meeting started');
      expect(appendMeetingRow).not.toHaveBeenCalled();
    });

    it('offers no way to record speech or chat — those travel through the transport', () => {
      const host = createTaskHost('task-shape', 'sess-shape', noopEnd);

      expect(Object.keys(host).sort()).toEqual(['consult', 'leaveMeeting', 'noteEvent', 'readWrittenExchange']);
    });

    it('delegates readWrittenExchange with this task', async () => {
      readWrittenExchange.mockResolvedValue([{ speaker: 'Ann', text: 'can you join?' }]);
      const host = createTaskHost('task-exchange-read', 'sess-exchange-read', noopEnd);

      await expect(host.readWrittenExchange()).resolves.toEqual([{ speaker: 'Ann', text: 'can you join?' }]);
      expect(readWrittenExchange).toHaveBeenCalledWith('task-exchange-read');
    });

    it('does not take down the meeting when appendMeetingEvent rejects, and logs the task by name', async () => {
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
      // The question's own `consult` row was written by `routeConsult` in meeting.ts before this ran; the host adds nothing.
      expect(appendMeetingRow).not.toHaveBeenCalled();

      unregisterLiveMeeting('task-ok');
    });

    // A consult that can't be delivered must surface as a failed answer, so a spoken promise ("let me check with the team") isn't left unkept.
    // No id needed: a cap of one outstanding question means nothing can jump the queue between this consult being raised and the catch block running.
    it('answers a consult that cannot be delivered as a failed answer', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      appendMeetingEvent.mockResolvedValue(undefined);
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

      unregisterLiveMeeting('task-gone');
    });

    // Distinct from the test above: the record's `answer` row must not imply the PM answered, since it never got the question.
    // The row itself is written inside `deliverConsultAnswer`; what this pins is the `'system'` label reaching it.
    it('labels the self-answer system, never pm-agent, when delivery fails', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      appendMeetingEvent.mockResolvedValue(undefined);
      taskGet.mockRejectedValue(new Error('Task task-dangling not found'));
      const meeting = fakeMeeting();
      registerLiveMeeting('task-dangling', meeting);

      const host = createTaskHost('task-dangling', 'sess-dangling', noopEnd);
      host.consult('c-99', 'is the deploy still on track?');
      await drain();

      expect(meeting.deliverConsultAnswer).toHaveBeenCalledTimes(1);
      const [roomText, from] = (meeting.deliverConsultAnswer as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(from).toBe('system');
      expect(roomText).toMatch(/could not be reached/i);

      unregisterLiveMeeting('task-dangling');
    });

    it('does not throw when no meeting is registered for the failing consult (registry lookup is optional)', async () => {
      taskGet.mockRejectedValue(new Error('Task task-nobody not found'));
      appendMeetingEvent.mockResolvedValue(undefined);
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
  it('names the record file it is handing over', async () => {
    const text = await loadPrompt('voice-wakeup-ended', {
      RECORD_PATH: '/workdir/tasks/task-1/shared/recall/bot-1/meeting.jsonl',
    });

    expect(text).toContain('/workdir/tasks/task-1/shared/recall/bot-1/meeting.jsonl');
  });

  it('still says plainly that the room has dispersed and nothing posted now reaches it', async () => {
    const text = await loadPrompt('voice-wakeup-ended', { RECORD_PATH: '/path/to/meeting.jsonl' });

    expect(text).toMatch(/dispersed/i);
    expect(text).toMatch(/nothing you post now reaches/i);
  });
});

describe('notifyMeetingEnded', () => {
  // Pins sessionId, not just taskId, reaching the record path — else the wake-up could point at the wrong meeting's file on a multi-meeting task.
  it('wakes the PM with the ended wake-up, pointing at this meeting\'s own record path', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    taskGet.mockResolvedValue({ sendMessage });

    notifyMeetingEnded('task-ended', 'sess-ended');
    await drain();

    expect(taskGet).toHaveBeenCalledWith('task-ended');
    expect(getMeetingRecordPath).toHaveBeenCalledWith('task-ended', 'sess-ended');
    expect(sendMessage).toHaveBeenCalledWith(
      await loadPrompt('voice-wakeup-ended', { RECORD_PATH: '/mock/task-ended/sess-ended/meeting.jsonl' }),
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
