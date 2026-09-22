/**
 * The notice a fresh session gets when resuming the previous one failed.
 *
 * Two halves, pinned separately: the rendered text (which place the lost
 * conversation is readable back from, and the task state the PM would otherwise
 * have to rediscover), and the delivery — the notice has to ride the SAME
 * message the retry replays, exactly once, and must be absent from a run that
 * never failed.
 */
import { describe, it, expect } from 'vitest';

import { buildSessionResetNotice, type SessionResetNoticeInput } from '../prompts.js';
import { MessageQueue, createRecoverableInputGenerator } from '../message-queue.js';

/** A directory that certainly exists, standing in for a clone still on disk. */
const REAL_CLONE = process.cwd();

function metadata(over: Partial<SessionResetNoticeInput> = {}): SessionResetNoticeInput {
  return { channels: {}, default_channel: null, repositories: [], ...over } as SessionResetNoticeInput;
}

function slackTask(over: Partial<SessionResetNoticeInput> = {}): SessionResetNoticeInput {
  return metadata({
    channels: {
      'slack:C123:1716998400.123456': {
        type: 'slack',
        thread_id: '1716998400.123456',
        channel_id: 'C123',
        channel_name: 'eng-archie',
        last_processed_ts: '1716998400.123456',
      },
    },
    default_channel: 'slack:C123:1716998400.123456',
    ...over,
  });
}

describe('buildSessionResetNotice', () => {
  it('points a Slack-linked task at its own thread, with the arguments read_thread takes', () => {
    const notice = buildSessionResetNotice(slackTask());

    expect(notice).toContain('no memory');
    expect(notice).toContain('read_thread');
    expect(notice).toContain('channel C123');
    expect(notice).toContain('#eng-archie');
    expect(notice).toContain('thread_ts 1716998400.123456');
    // The log is the OTHER surface's answer — naming both would leave the PM choosing.
    expect(notice).not.toContain('knowledge.log');
    expect(notice).toContain('continue the work from what the thread shows');
    // This rides in front of a real wake, so it stays small.
    expect(notice.split('\n').length).toBeLessThan(20);
  });

  it('points a CLI/API task at knowledge.log, since it has no thread to re-read', () => {
    const notice = buildSessionResetNotice(metadata());

    expect(notice).toContain('shared/knowledge.log');
    expect(notice).not.toContain('read_thread');
    expect(notice).toContain('continue the work from what the log shows');
  });

  it('falls back to a linked Slack thread when the originating channel is not one', () => {
    const notice = buildSessionResetNotice(
      slackTask({ default_channel: 'cli:local' }),
    );

    expect(notice).toContain('thread_ts 1716998400.123456');
  });

  it('lists the mounted repos and the outstanding approvals the fresh session cannot know about', () => {
    const notice = buildSessionResetNotice(slackTask({
      repositories: [
        { github: 'sweatco/archie-hq', clone_path: REAL_CLONE, current_branch: 'feat/x' },
        { github: 'sweatco/other', clone_path: '/definitely/not/here' },
      ],
      edit_allowed: true,
      pending_merge_approval: { github: 'sweatco/archie-hq', pr_number: 42 },
    } as Partial<SessionResetNoticeInput>));

    expect(notice).toContain(`- sweatco/archie-hq — clone: ${REAL_CLONE} — branch: feat/x — edit mode: on`);
    expect(notice).toContain('- sweatco/other — recorded, not cloned — mount_repo will clone it fresh');
    expect(notice).toContain('mount_repo adopts these existing clones');
    expect(notice).toContain('Pending approvals: merge of sweatco/archie-hq#42.');
  });

  it('says so plainly when nothing is attached', () => {
    const notice = buildSessionResetNotice(metadata());

    expect(notice).toContain('Repositories attached to this task: none');
    expect(notice).not.toContain('Pending approvals');
  });
});

/**
 * The retry in `spawnAgent`'s session-recovery block: the generator is
 * abandoned mid-stream, `reset(notice)` puts what it consumed back, and a new
 * generator reads the replayed messages into the fresh session.
 */
describe('the replayed wake on a fresh-session retry', () => {
  async function drain(gen: AsyncGenerator<{ message: { content: string } }>, n: number): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const next = await gen.next();
      if (next.done) break;
      out.push(next.value.message.content);
    }
    return out;
  }

  it('prefixes the message the retry replays, exactly once, leaving the ones behind it alone', async () => {
    const queue = new MessageQueue();
    const recoverable = createRecoverableInputGenerator(queue);
    queue.addMessage('the wake that was in flight');
    queue.addMessage('a wake that queued up behind it');

    // First attempt reads both, then the session dies.
    expect(await drain(recoverable.generator(), 2)).toEqual([
      'the wake that was in flight',
      'a wake that queued up behind it',
    ]);
    recoverable.reset('SESSION RESET — notice body');

    const replayed = await drain(recoverable.generator(), 2);
    expect(replayed[0]).toBe('SESSION RESET — notice body\n\nthe wake that was in flight');
    expect(replayed[0].match(/SESSION RESET/g)).toHaveLength(1);
    expect(replayed[1]).toBe('a wake that queued up behind it');
  });

  it('delivers the notice on its own when the failed attempt had consumed nothing', async () => {
    const queue = new MessageQueue();
    const recoverable = createRecoverableInputGenerator(queue);

    recoverable.reset('SESSION RESET — notice body');

    expect(await drain(recoverable.generator(), 1)).toEqual(['SESSION RESET — notice body']);
  });

  it('hands a message enqueued after the failure to the retry, not to the abandoned generator', async () => {
    // The abandoned generator is parked inside queue.nextMessage() with a
    // resolver registered. Left in place it is first in line, so the next
    // addMessage (a recovery nudge, the next wake) revives the dead attempt —
    // which swallows the message and makes the SDK abort the controller the
    // spawn shares with the retry. The spawn loop detaches it in its catch.
    const queue = new MessageQueue();
    const recoverable = createRecoverableInputGenerator(queue);
    queue.addMessage('the wake that was in flight');

    const abandoned = recoverable.generator();
    expect(await drain(abandoned, 1)).toEqual(['the wake that was in flight']);
    const parked = abandoned.next(); // waiting on the queue when the query died

    queue.detachWaiters();
    recoverable.reset('SESSION RESET — notice body');
    const retry = recoverable.generator();
    expect(await drain(retry, 1)).toEqual(['SESSION RESET — notice body\n\nthe wake that was in flight']);
    const waiting = retry.next(); // the fresh attempt is reading

    queue.addMessage('RECOVERY: nudge');

    expect((await waiting).value?.message.content).toBe('RECOVERY: nudge');
    // The abandoned generator never wakes — nothing yields into the dead query.
    expect(await Promise.race([parked, Promise.resolve('still parked')])).toBe('still parked');
  });

  it('leaves a run that never failed untouched — no notice reaches a normal spawn', async () => {
    const queue = new MessageQueue();
    const recoverable = createRecoverableInputGenerator(queue);
    queue.addMessage('the wake that was in flight');

    expect(await drain(recoverable.generator(), 1)).toEqual(['the wake that was in flight']);

    // And a reset with no notice (any other replay) still replays verbatim.
    recoverable.reset();
    expect(await drain(recoverable.generator(), 1)).toEqual(['the wake that was in flight']);
  });
});
