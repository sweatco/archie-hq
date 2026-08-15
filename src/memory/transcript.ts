import { isSlackUserId } from './paths.js';
import type { UserRef } from './types.js';

const SLACK_ENTRY_RE = /^\[[^\]]*\] \[(?:@<|<@)([A-Z][A-Z0-9]{6,}):([^>]*)>([^\]]*)\](?: \[[^\]]+\])? (.*)$/;
const CLI_ENTRY_RE = /^\[[^\]]*\] \[cli\](?: \[[^\]]+\])? (.*)$/;
const REDACTED_EXTERNAL = '[redacted: external participant in shared channel]';

export interface ParsedTranscript {
  authors: UserRef[];
  firstUserMessage?: string;
  msgAuthors: Map<string, string>;
}

export function parseTranscript(transcript: string, excludedSlackUserId?: string): ParsedTranscript {
  const authors = new Map<string, string>();
  const msgAuthors = new Map<string, string>();
  let firstUserMessage: string | undefined;
  const lines = transcript.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const slack = SLACK_ENTRY_RE.exec(lines[i]);
    const cli = slack ? null : CLI_ENTRY_RE.exec(lines[i]);
    if (!slack && !cli) continue;

    const body = [slack?.[4] ?? cli?.[1] ?? ''];
    while (i + 1 < lines.length && lines[i + 1].startsWith('  ')) body.push(lines[++i].slice(2));

    if (slack) {
      const userId = slack[1];
      const displayName = slack[2].trim();
      const msgId = /\bmsg:([^\s\]]+)/.exec(slack[3])?.[1];
      if (msgId) msgAuthors.set(msgId, userId);

      const excluded = !isSlackUserId(userId)
        || userId === excludedSlackUserId
        || displayName === 'external';
      if (!excluded && !authors.has(userId)) authors.set(userId, displayName || userId);
      if (excluded || firstUserMessage) continue;
    } else if (firstUserMessage) {
      continue;
    }

    const text = body.join('\n').trim();
    if (text && text !== REDACTED_EXTERNAL) firstUserMessage = text;
  }

  return {
    authors: Array.from(authors, ([userId, displayName]) => ({ userId, displayName })),
    firstUserMessage,
    msgAuthors,
  };
}
