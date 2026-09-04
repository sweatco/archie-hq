// A stale channel key must not reach a different meeting live on the same task.
import { describe, it, expect, vi, afterEach } from 'vitest';

const { liveMeetings } = vi.hoisted(() => ({ liveMeetings: new Map<string, unknown>() }));

vi.mock('../../../voice/task-binding.js', () => ({
  getLiveMeeting: (taskId: string) => liveMeetings.get(taskId),
}));

// The one writer into a meeting's record; nothing on this deliverer's path may reach it.
const { appendMeetingRow } = vi.hoisted(() => ({ appendMeetingRow: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../tasks/persistence.js', () => ({ appendMeetingRow }));

import { deliverToRecallChannel } from '../channel-delivery.js';
import type { Meeting } from '../../../voice/meeting.js';
import type { RecallChannel } from '../../../types/task.js';
import type { Task } from '../../../tasks/task.js';

function fakeMeeting(sessionId: string, overrides: Partial<Meeting> = {}): Meeting {
  return {
    sessionId,
    onAudio: vi.fn(),
    deliverConsultAnswer: vi.fn().mockReturnValue({ ok: true, id: 'c1' }),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Meeting;
}

function fakeChannel(over: Partial<RecallChannel> = {}): RecallChannel {
  return { type: 'recall', session_id: 'sess-1', url: 'https://zoom.us/j/1', ended: false, ...over };
}

function fakeTask(taskId: string): Task {
  return { taskId } as unknown as Task;
}

afterEach(() => {
  liveMeetings.clear();
  vi.clearAllMocks();
});

describe('deliverToRecallChannel', () => {
  it('delivers to the live meeting when the session id matches, reports delivered, and confirms it will be spoken', async () => {
    const meeting = fakeMeeting('sess-1');
    liveMeetings.set('task-1', meeting);

    const outcome = await deliverToRecallChannel({
      task: fakeTask('task-1'),
      channel: fakeChannel({ session_id: 'sess-1' }),
      message: 'the deploy finished at ten',
    });

    // No `from` argument: 'pm-agent' is the default, and the `answer` row is written inside deliverConsultAnswer — nothing here touches the record.
    expect(meeting.deliverConsultAnswer).toHaveBeenCalledWith('the deploy finished at ten');
    // `delivered: true` is what tells postToUser's `recall` branch to log this in knowledge.log.
    expect(outcome.delivered).toBe(true);
    expect(outcome.note).toMatch(/spoken aloud/i);
  });

  // The append that used to live here is gone: one file, one writer, and the `answer` row goes down inside `deliverConsultAnswer`, where the consult id it belongs to is known.
  it('writes nothing into the meeting record itself, on the delivered path', async () => {
    liveMeetings.set('task-1', fakeMeeting('sess-1'));

    const outcome = await deliverToRecallChannel({
      task: fakeTask('task-1'),
      channel: fakeChannel({ session_id: 'sess-1' }),
      message: 'the deploy finished at ten',
    });

    expect(outcome.delivered).toBe(true);
    expect(appendMeetingRow).not.toHaveBeenCalled();
  });

  it('reports nothing outstanding, rather than a silent success, when the meeting has nothing to answer — and reports not delivered', async () => {
    const meeting = fakeMeeting('sess-1', { deliverConsultAnswer: vi.fn().mockReturnValue({ ok: false }) });
    liveMeetings.set('task-1', meeting);

    const outcome = await deliverToRecallChannel({
      task: fakeTask('task-1'),
      channel: fakeChannel({ session_id: 'sess-1' }),
      message: 'unsolicited update',
    });

    expect(meeting.deliverConsultAnswer).toHaveBeenCalled();
    expect(outcome.delivered).toBe(false);
    expect(outcome.note).toMatch(/nothing outstanding/i);
  });

  it('reports the room has dispersed, and not delivered, when no meeting is live on this task at all', async () => {
    const outcome = await deliverToRecallChannel({
      task: fakeTask('task-gone'),
      channel: fakeChannel(),
      message: 'anything',
    });

    expect(outcome.delivered).toBe(false);
    expect(outcome.note).toMatch(/dispersed/i);
  });

  it('reports the room has dispersed, not delivered, and never touches the meeting, when a different session is now live on the same task', async () => {
    const newerMeeting = fakeMeeting('sess-2');
    liveMeetings.set('task-1', newerMeeting);

    const outcome = await deliverToRecallChannel({
      task: fakeTask('task-1'),
      channel: fakeChannel({ session_id: 'sess-1' }),
      message: 'stale answer — ignore',
    });

    expect(outcome.delivered).toBe(false);
    expect(outcome.note).toMatch(/dispersed/i);
    expect(newerMeeting.deliverConsultAnswer).not.toHaveBeenCalled();
  });
});
