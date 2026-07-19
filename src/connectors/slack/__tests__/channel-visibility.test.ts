import { describe, it, expect } from 'vitest';
import { classifyConversationInfo } from '../client.js';

describe('classifyConversationInfo', () => {
  it('classifies DMs from flags or the D prefix when info is present', () => {
    expect(classifyConversationInfo({ is_im: true }, 'D0123456789')).toBe('dm');
    // D prefix with fetched info still classifies dm even without flags…
    expect(classifyConversationInfo({}, 'D0123456789')).toBe('dm');
  });

  it('fails closed to unknown when conversation info is unavailable — D ids included', () => {
    expect(classifyConversationInfo(null, 'C0123456789')).toBe('unknown');
    expect(classifyConversationInfo(null, 'G0123456789')).toBe('unknown');
    // No API-free dm short-circuit: an unfetchable D id may be a Slack
    // Connect DM, so it must lock down, not classify dm.
    expect(classifyConversationInfo(null, 'D0123456789')).toBe('unknown');
  });

  it('ext-shared wins over private and dm flags — Slack Connect DMs included', () => {
    expect(classifyConversationInfo({ is_ext_shared: true, is_private: true }, 'C1')).toBe('ext-shared');
    expect(classifyConversationInfo({ is_pending_ext_shared: true }, 'C1')).toBe('ext-shared');
    expect(classifyConversationInfo({ connected_team_ids: ['T1', 'T2'] }, 'C1')).toBe('ext-shared');
    expect(classifyConversationInfo({ is_ext_shared: true, is_mpim: true }, 'C1')).toBe('ext-shared');
    // The Slack Connect DM shape: D-prefixed, is_im, ext-shared → ext-shared.
    expect(classifyConversationInfo({ is_im: true, is_ext_shared: true }, 'D0123456789')).toBe('ext-shared');
  });

  it('single connected team does not count as ext-shared', () => {
    expect(classifyConversationInfo({ connected_team_ids: ['T1'] }, 'C1')).toBe('public');
  });

  it('classifies group DMs (mpim/im flags) as dm', () => {
    expect(classifyConversationInfo({ is_mpim: true }, 'C1')).toBe('dm');
    expect(classifyConversationInfo({ is_im: true }, 'C1')).toBe('dm');
  });

  it('classifies private channels via is_private or legacy G-prefix', () => {
    expect(classifyConversationInfo({ is_private: true }, 'C1')).toBe('private');
    expect(classifyConversationInfo({}, 'G0123456789')).toBe('private');
  });

  it('classifies plain channels as public', () => {
    expect(classifyConversationInfo({}, 'C0123456789')).toBe('public');
    expect(classifyConversationInfo({ is_private: false }, 'C0123456789')).toBe('public');
  });
});
