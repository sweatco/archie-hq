import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../system/logger.js';
import {
  assembleSpeakingRequest,
  buildSpeakingUserMessage,
  resolveSpeakingPlacement,
  splitSpeakingPrompt,
} from '../comprehension.js';

const TRANSCRIPT = ['Ann: the billing service went red again around noon.', 'Ann: Archie, who owns it now?'].join('\n');

const PROMPT = [
  'You are Archie. You are sitting in a live voice meeting with your colleagues.',
  '',
  '## What that actually means',
  '',
  'There is one floor and you are sharing it.',
  '',
  '## How to reply',
  '',
  'Reply with the words to be spoken and nothing else.',
  '',
].join('\n');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolving which arm is selected', () => {
  it('defaults to what production sends, for every spelling of "nothing"', () => {
    expect(resolveSpeakingPlacement(undefined)).toBe('guidance-first');
    expect(resolveSpeakingPlacement('')).toBe('guidance-first');
    expect(resolveSpeakingPlacement('   ')).toBe('guidance-first');
  });

  it('reads both arms, tolerating case and surrounding whitespace', () => {
    expect(resolveSpeakingPlacement('guidance-first')).toBe('guidance-first');
    expect(resolveSpeakingPlacement('data-first')).toBe('data-first');
    expect(resolveSpeakingPlacement(' DATA-FIRST ')).toBe('data-first');
  });

  it('reports a typo and falls back, rather than reading it as the nearest arm', () => {
    // Silent fallback looks correct while collecting data under the wrong arm.
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(resolveSpeakingPlacement('data_first')).toBe('guidance-first');
    expect(warnings).toHaveBeenCalledOnce();
    expect(warnings.mock.calls[0][1]).toContain('data_first');
  });
});

describe('cutting the prompt at its first heading', () => {
  it('splits the opening statement of role from everything after it', () => {
    const { role, guidance } = splitSpeakingPrompt(PROMPT);
    expect(role).toBe('You are Archie. You are sitting in a live voice meeting with your colleagues.');
    expect(guidance.startsWith('## What that actually means')).toBe(true);
    expect(guidance).toContain('## How to reply');
  });

  it('cuts at the first `## ` only, and does not mistake a deeper heading for the seam', () => {
    const deeper = ['You are Archie.', '', '### Not the seam', '', 'body', '', '## The seam', '', 'more'].join('\n');
    const { role, guidance } = splitSpeakingPrompt(deeper);
    expect(role).toContain('### Not the seam');
    expect(guidance.startsWith('## The seam')).toBe(true);
  });

  it('reports no guidance at all when there is no heading to cut at', () => {
    const { role, guidance } = splitSpeakingPrompt('You are Archie. Answer the room.');
    expect(role).toBe('You are Archie. Answer the room.');
    expect(guidance).toBe('');
  });
});

describe('assembling the request', () => {
  const user = buildSpeakingUserMessage(TRANSCRIPT);

  it('sends the pre-experiment request under guidance-first', () => {
    const request = assembleSpeakingRequest({ prompt: PROMPT, transcript: TRANSCRIPT, placement: 'guidance-first' });
    expect(request.system).toBe(PROMPT);
    expect(request.user).toBe(user);
  });

  it('moves the guidance to the very end of the user message under data-first', () => {
    const request = assembleSpeakingRequest({ prompt: PROMPT, transcript: TRANSCRIPT, placement: 'data-first' });
    expect(request.system).toBe('You are Archie. You are sitting in a live voice meeting with your colleagues.');
    expect(request.user).toBe(`${user}\n\n${splitSpeakingPrompt(PROMPT).guidance}`);
    expect(request.user.startsWith(user)).toBe(true);
    expect(request.user.indexOf('</transcript>')).toBeLessThan(request.user.indexOf('## '));
  });

  it('carries the same characters in both arms, only placed differently', () => {
    const a = assembleSpeakingRequest({ prompt: PROMPT, transcript: TRANSCRIPT, placement: 'guidance-first' });
    const b = assembleSpeakingRequest({ prompt: PROMPT, transcript: TRANSCRIPT, placement: 'data-first' });
    // Tolerance covers only the seam trim; more means text was dropped or reworded.
    expect(Math.abs(a.system.length + a.user.length - (b.system.length + b.user.length))).toBeLessThanOrEqual(4);
    expect(b.user).not.toContain(a.system);
  });

  it('the guidance lands after every standing block, not merely after the transcript', () => {
    const request = assembleSpeakingRequest({
      prompt: PROMPT,
      transcript: TRANSCRIPT,
      consults: [{ id: 'm1c1', question: 'who owns billing?' }],
      context: {
        participants: [{ name: 'Ann Petrova', is_host: true, joined_at: null, left_at: null }],
        written: [{ speaker: 'Ann Petrova', text: 'can you join?' }],
        capabilities: '- read the repos',
      },
      placement: 'data-first',
    });
    expect(request.user.indexOf('</capabilities>')).toBeLessThan(request.user.indexOf('## '));
  });

  it('falls back to guidance-first, loudly, for a prompt with no seam in it', () => {
    // Otherwise a no-seam prompt logs as the variant, compared to itself.
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const bare = 'You are Archie. Answer the room.';
    const request = assembleSpeakingRequest({ prompt: bare, transcript: TRANSCRIPT, placement: 'data-first' });
    expect(request.system).toBe(bare);
    expect(request.user).toBe(user);
    expect(warnings).toHaveBeenCalledOnce();
  });

  it('leaves the shared builder — and so the triage gate — identical under both arms', () => {
    // Gate shares only this builder; leaked guidance would bleed into its own reasoning.
    const before = buildSpeakingUserMessage(TRANSCRIPT);
    assembleSpeakingRequest({ prompt: PROMPT, transcript: TRANSCRIPT, placement: 'data-first' });
    expect(buildSpeakingUserMessage(TRANSCRIPT)).toBe(before);
    expect(before).not.toContain('## ');
  });

  it('reads the environment when no placement is passed', () => {
    const previous = process.env.ARCHIE_VOICE_PROMPT_PLACEMENT;
    try {
      delete process.env.ARCHIE_VOICE_PROMPT_PLACEMENT;
      expect(assembleSpeakingRequest({ prompt: PROMPT, transcript: TRANSCRIPT }).system).toBe(PROMPT);
      process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = 'data-first';
      expect(assembleSpeakingRequest({ prompt: PROMPT, transcript: TRANSCRIPT }).system).not.toBe(PROMPT);
    } finally {
      if (previous === undefined) delete process.env.ARCHIE_VOICE_PROMPT_PLACEMENT;
      else process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = previous;
    }
  });
});

describe('the real prompt has the seam this experiment cuts at', () => {
  it('opens with one short statement of role, then a heading', () => {
    // Unmarked cut: role is everything before the first `## `; breaking it falls back silently, not loudly.
    const prompt = readFileSync(join(process.cwd(), 'prompts/voice-speaking.md'), 'utf8');
    const { role, guidance } = splitSpeakingPrompt(prompt);
    expect(role.length).toBeGreaterThan(0);
    expect(role.split('\n\n')).toHaveLength(1);
    expect(role.length).toBeLessThan(400);
    expect(guidance.length).toBeGreaterThan(role.length * 10);
  });
});
