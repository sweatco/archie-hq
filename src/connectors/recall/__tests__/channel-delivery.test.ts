// A stale channel key must not reach a different meeting live on the same task.
import { describe, it, expect, vi, afterEach } from 'vitest';

const { liveMeetings } = vi.hoisted(() => ({ liveMeetings: new Map<string, unknown>() }));

vi.mock('../../../voice/task-binding.js', () => ({
  getLiveMeeting: (taskId: string) => liveMeetings.get(taskId),
}));

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), system: vi.fn(), debug: vi.fn() },
}));

// clearAllMocks() clears call history, not implementation; stays resolved by default.
const { appendMeetingExchange } = vi.hoisted(() => ({ appendMeetingExchange: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../tasks/persistence.js', () => ({ appendMeetingExchange }));

import { logger } from '../../../system/logger.js';
import { deliverToRecallChannel, renderRecallChannel } from '../channel-delivery.js';
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
      sender: 'pm-agent',
    });

    expect(meeting.deliverConsultAnswer).toHaveBeenCalledWith('the deploy finished at ten');
    // `delivered: true` tells postToUser (deliverThroughSeam) to log this in knowledge.log.
    expect(outcome?.delivered).toBe(true);
    expect(outcome?.note).toMatch(/spoken aloud/i);
    // Only the "answered" half — "asked" comes from `src/voice/task-binding.ts`.
    expect(appendMeetingExchange).toHaveBeenCalledWith('task-1', 'sess-1', 'pm-agent', 'the deploy finished at ten');
  });

  it('reports nothing outstanding, rather than a silent success, when the meeting has nothing to answer — and reports not delivered', async () => {
    const meeting = fakeMeeting('sess-1', { deliverConsultAnswer: vi.fn().mockReturnValue({ ok: false }) });
    liveMeetings.set('task-1', meeting);

    const outcome = await deliverToRecallChannel({
      task: fakeTask('task-1'),
      channel: fakeChannel({ session_id: 'sess-1' }),
      message: 'unsolicited update',
      sender: 'pm-agent',
    });

    expect(meeting.deliverConsultAnswer).toHaveBeenCalled();
    expect(outcome?.delivered).toBe(false);
    expect(outcome?.note).toMatch(/nothing outstanding/i);
    expect(appendMeetingExchange).not.toHaveBeenCalled();
  });

  it('reports the room has dispersed, and not delivered, when no meeting is live on this task at all', async () => {
    const outcome = await deliverToRecallChannel({
      task: fakeTask('task-gone'),
      channel: fakeChannel(),
      message: 'anything',
      sender: 'pm-agent',
    });

    expect(outcome?.delivered).toBe(false);
    expect(outcome?.note).toMatch(/dispersed/i);
    expect(appendMeetingExchange).not.toHaveBeenCalled();
  });

  it('reports the room has dispersed, not delivered, and never touches the meeting, when a different session is now live on the same task', async () => {
    const newerMeeting = fakeMeeting('sess-2');
    liveMeetings.set('task-1', newerMeeting);

    const outcome = await deliverToRecallChannel({
      task: fakeTask('task-1'),
      channel: fakeChannel({ session_id: 'sess-1' }),
      message: 'stale answer — ignore',
      sender: 'pm-agent',
    });

    expect(outcome?.delivered).toBe(false);
    expect(outcome?.note).toMatch(/dispersed/i);
    expect(newerMeeting.deliverConsultAnswer).not.toHaveBeenCalled();
    expect(appendMeetingExchange).not.toHaveBeenCalled();
  });

  it('never throws and logs instead, if it is ever handed a non-recall channel (defensive only)', async () => {
    const outcome = await deliverToRecallChannel({
      task: fakeTask('task-1'),
      channel: { type: 'cli', id: 'cli:local' },
      message: 'x',
      sender: 'pm-agent',
    });

    expect(outcome).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(appendMeetingExchange).not.toHaveBeenCalled();
  });

  // Deliverers must never throw (contract); a disk hiccup must not lose an already-spoken answer.
  it('still reports delivered when recording the exchange fails, and logs instead of throwing', async () => {
    appendMeetingExchange.mockRejectedValueOnce(new Error('disk is full'));
    const meeting = fakeMeeting('sess-1');
    liveMeetings.set('task-1', meeting);

    const outcome = await deliverToRecallChannel({
      task: fakeTask('task-1'),
      channel: fakeChannel({ session_id: 'sess-1' }),
      message: 'the deploy finished at ten',
      sender: 'pm-agent',
    });

    expect(outcome?.delivered).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// Unlike delivery, rendering reads only the channel record, not the live registry — no "meeting not live" case.
describe('renderRecallChannel', () => {
  it('renders a live meeting', () => {
    expect(renderRecallChannel(fakeChannel({ ended: false }))).toBe('Meeting (live)');
  });

  it('renders an ended meeting, still — the record is kept, not removed', () => {
    expect(renderRecallChannel(fakeChannel({ ended: true }))).toBe('Meeting (ended)');
  });

  it('never throws and logs instead, if it is ever handed a non-recall channel (defensive only)', () => {
    const rendered = renderRecallChannel({ type: 'cli', id: 'cli:local' });

    expect(rendered).toBe('cli');
    expect(logger.warn).toHaveBeenCalled();
  });
});
