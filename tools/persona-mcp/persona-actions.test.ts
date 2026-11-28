import { describe, it, expect } from 'vitest';
import { FakeWorkspace } from './fake-workspace.js';
import {
  deleteAs,
  describeSeenMessage,
  describeSlackFailure,
  dmArchieAs,
  editAs,
  postAs,
  reactAs,
  readAs,
} from './persona-actions.js';

const ALICE = 'U0ALICE0001';
const BOB = 'U0BOB000001';
const ARCHIE = 'U0ARCHIE001';

function workspace() {
  const slack = new FakeWorkspace('T0TEST00001');
  slack.addConversation('C0PUBLIC001', [ALICE, BOB, ARCHIE]);
  slack.addConversation('G0PRIVATE01', [ALICE, ARCHIE]);
  return { slack, alice: slack.clientFor(ALICE), bob: slack.clientFor(BOB) };
}

describe('posting as a persona', () => {
  it('posts top-level and returns where the message landed', async () => {
    const { slack, alice } = workspace();
    const posted = await postAs(alice, { channel: 'C0PUBLIC001', text: 'hello [E2E-1]' });
    expect(posted).toEqual({ channel: 'C0PUBLIC001', ts: expect.any(String) as string });
    expect(slack.messagesIn('C0PUBLIC001')).toEqual([
      { ts: posted.ts, user: ALICE, text: 'hello [E2E-1]', thread_ts: undefined },
    ]);
  });

  it('replies inside the given thread', async () => {
    const { slack, alice, bob } = workspace();
    const root = await postAs(alice, { channel: 'C0PUBLIC001', text: 'root' });
    await postAs(bob, { channel: 'C0PUBLIC001', text: 'reply', threadTs: root.ts });
    expect(slack.messagesIn('C0PUBLIC001')[1]).toMatchObject({ user: BOB, thread_ts: root.ts });
  });

  it("opens the persona's own DM with Archie and posts there", async () => {
    const { slack, alice, bob } = workspace();
    const fromAlice = await dmArchieAs(alice, ARCHIE, { text: 'private fact [E2E-2]' });
    const fromBob = await dmArchieAs(bob, ARCHIE, { text: 'another [E2E-3]' });
    expect(fromAlice.channel).toMatch(/^D/);
    expect(fromBob.channel).not.toBe(fromAlice.channel);
    expect(slack.messagesIn(fromAlice.channel)).toHaveLength(1);
  });

  it('fails loudly when Slack returns no ts', async () => {
    const { alice } = workspace();
    const silent = {
      ...alice,
      chat: { ...alice.chat, postMessage: () => Promise.resolve({}) },
    };
    await expect(postAs(silent, { channel: 'C0PUBLIC001', text: 'x' })).rejects.toThrow(/no ts/);
  });
});

describe('editing, deleting and reacting as a persona', () => {
  it('edits and deletes only through the author', async () => {
    const { slack, alice, bob } = workspace();
    const posted = await postAs(alice, { channel: 'C0PUBLIC001', text: 'deploy to staging' });
    await editAs(alice, { ...posted, text: 'deploy to prod' });
    expect(slack.messagesIn('C0PUBLIC001')[0].text).toBe('deploy to prod');
    await expect(editAs(bob, { ...posted, text: 'hijack' })).rejects.toThrow(/cant_update_message/);
    await deleteAs(alice, posted);
    expect(slack.messagesIn('C0PUBLIC001')).toHaveLength(0);
  });

  it('accepts an emoji with or without colons', async () => {
    const { slack, alice, bob } = workspace();
    const posted = await postAs(alice, { channel: 'C0PUBLIC001', text: 'done' });
    await reactAs(bob, { ...posted, emoji: ':eyes:' });
    await reactAs(bob, { ...posted, emoji: 'white_check_mark' });
    expect(slack.messagesIn('C0PUBLIC001')[0].reactions).toEqual([
      { name: 'eyes', count: 1 },
      { name: 'white_check_mark', count: 1 },
    ]);
  });
});

describe('reading as a persona', () => {
  it('returns a conversation oldest first, and a thread when asked', async () => {
    const { alice, bob } = workspace();
    const first = await postAs(alice, { channel: 'C0PUBLIC001', text: 'first' });
    await postAs(bob, { channel: 'C0PUBLIC001', text: 'second' });
    await postAs(bob, { channel: 'C0PUBLIC001', text: 'in thread', threadTs: first.ts });

    const conversation = await readAs(bob, { channel: 'C0PUBLIC001' });
    expect(conversation.map((message) => message.text)).toEqual(['first', 'second']);
    const thread = await readAs(bob, { channel: 'C0PUBLIC001', threadTs: first.ts });
    expect(thread.map((message) => message.text)).toEqual(['first', 'in thread']);
  });

  it('cannot read a conversation the member is not in', async () => {
    const { alice, bob } = workspace();
    await postAs(alice, { channel: 'G0PRIVATE01', text: 'private-channel fact' });
    await expect(readAs(bob, { channel: 'G0PRIVATE01' })).rejects.toMatchObject({
      data: { error: 'channel_not_found' },
    });
    const aliceDm = await dmArchieAs(alice, ARCHIE, { text: 'dm fact' });
    await expect(readAs(bob, { channel: aliceDm.channel })).rejects.toMatchObject({
      data: { error: 'channel_not_found' },
    });
  });
});

describe('describeSeenMessage', () => {
  it('finds buttons at any depth with their action id, value and label', () => {
    const card = {
      ts: '1800000001.000100',
      bot_id: 'B0ARCHIE001',
      text: 'Save this preference?',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'Prefers short answers' } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              action_id: 'approve_memory_preference',
              value: 'task-1',
              text: { type: 'plain_text', text: 'Save across conversations' },
            },
            { type: 'button', action_id: 'deny_memory_preference', text: { text: 'Not now' } },
          ],
        },
      ],
    };
    expect(describeSeenMessage(card)).toMatchObject({
      author: 'bot:B0ARCHIE001',
      appAuthored: true,
      buttons: [
        {
          actionId: 'approve_memory_preference',
          value: 'task-1',
          label: 'Save across conversations',
        },
        { actionId: 'deny_memory_preference', value: '', label: 'Not now' },
      ],
    });
  });

  it('separates who wrote a message from whether an app posted it', () => {
    const typed = describeSeenMessage({ ts: '1.1', user: ALICE, text: 'hi' });
    expect(typed).toMatchObject({ author: ALICE, appAuthored: false, buttons: [], reactions: [] });
    const viaToken = describeSeenMessage({ ts: '1.2', user: ALICE, bot_id: 'B0PERSONA01' });
    expect(viaToken).toMatchObject({ author: ALICE, appAuthored: true });
    expect(describeSeenMessage({ ts: '1.3', user: ALICE, app_id: 'A0PERSONA01' }).appAuthored).toBe(
      true,
    );
  });
});

describe('describeSlackFailure', () => {
  const slackError = (code: string) => Object.assign(new Error(code), { data: { error: code } });

  it('says the persona cannot see a conversation Slack hides', () => {
    for (const code of ['channel_not_found', 'not_in_channel', 'thread_not_found']) {
      expect(describeSlackFailure(slackError(code), 'bob')).toBe(
        `"bob" cannot see that conversation (Slack: ${code})`,
      );
    }
  });

  it('explains a read-only conversation, which is what a DM with an app is by default', () => {
    expect(
      describeSlackFailure(slackError('restricted_action_read_only_channel'), 'alice'),
    ).toMatch(/"alice" cannot post there: the conversation is read-only.*Messages tab/);
  });

  it('points at the manifest for a missing scope and passes other codes through', () => {
    expect(describeSlackFailure(slackError('missing_scope'), 'bob')).toMatch(/re-run authorize/);
    expect(describeSlackFailure(slackError('ratelimited'), 'bob')).toMatch(/"bob": ratelimited/);
    expect(describeSlackFailure(new Error('socket hang up'), 'bob')).toBe('socket hang up');
  });
});
