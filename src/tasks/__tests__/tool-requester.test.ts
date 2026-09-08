// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { requesterFromSlackEvent, restrictToolRequesterToThread, revokeToolRequester } from '../tool-requester.js';
import type { SlackThread, TaskMetadata } from '../../types/task.js';

function thread(...users: string[]): SlackThread {
  return {
    channel: { id: 'C1', name: 'releases' }, threadId: '1', currentMessageTs: '1', shared: false, rootAuthorWasBot: false,
    messages: users.map((id, index) => ({ user: { id, username: id, realName: id, teamId: 'T1' }, ownText: 'request', ts: String(index + 1) })),
  };
}

describe('requester isolation', () => {
  it('creates authority only for the verified triggering author in the known workspace', () => {
    expect(requesterFromSlackEvent(thread('U1'), 'U1', '1', 'T1')).toMatchObject({ userId: 'U1', teamId: 'T1', messageTs: '1' });
    expect(requesterFromSlackEvent(thread('U1'), 'U2', '1', 'T1')).toBeUndefined();
    expect(requesterFromSlackEvent(thread('U1'), 'U1', '1', null)).toBeUndefined();
    expect(requesterFromSlackEvent(thread('U1'), 'U1', '1', 'T2')).toBeUndefined();
    expect(requesterFromSlackEvent(thread('B1'), 'B1', '1', 'T1')).toBeUndefined();
  });

  it('keeps same-author follow-ups and bot output, but permanently revokes on a second author', () => {
    const metadata = { tool_requester: requesterFromSlackEvent(thread('U1'), 'U1', '1', 'T1') } as TaskMetadata;
    const original = metadata.tool_requester;
    restrictToolRequesterToThread(metadata, thread('U1', 'U1', 'UBOT'), 'UBOT');
    expect(metadata.tool_requester).toEqual(original);
    restrictToolRequesterToThread(metadata, thread('U1', 'U2'), 'UBOT');
    expect(metadata.tool_requester).toBeUndefined();
    restrictToolRequesterToThread(metadata, thread('U1'), 'UBOT');
    expect(metadata.tool_requester).toBeUndefined();
  });

  it('preserves revocation over serialization and never invents authority for automation', () => {
    const metadata = { tool_requester: requesterFromSlackEvent(thread('U1'), 'U1', '1', 'T1') } as TaskMetadata;
    revokeToolRequester(metadata);
    const reloaded = JSON.parse(JSON.stringify(metadata));
    restrictToolRequesterToThread(reloaded, thread('U1'), 'UBOT');
    expect(reloaded.tool_requester).toBeUndefined();
  });
});
