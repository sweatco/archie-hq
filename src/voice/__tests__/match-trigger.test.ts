import { describe, it, expect } from 'vitest';
import { isArchie, matchTrigger, TRIGGER_VARIANTS } from '../meeting.js';
import { BOT_NAME } from '../types.js';

// Targets Cyrillic near-misses sharing phonemes with Арчи/Archie.
describe('matchTrigger', () => {
  describe('fires when addressed', () => {
    const addressed = [
      'Archie',
      'hey Archie',
      'Archie, can you check that',
      'ARCHIE',
      'Archie!!!',
      "Archie's answer was wrong",
      'Арчи',
      'арчи, посмотри пожалуйста',
      'Арчик',
      'Ａｒｃｈｉｅ', // full-width, folded by NFKC
    ];
    for (const text of addressed) {
      it(`fires on ${JSON.stringify(text)}`, () => {
        expect(matchTrigger(text)).not.toBeNull();
      });
    }
  });

  describe('stays silent on words that merely start the same way', () => {
    const quiet = [
      'архитектура',
      'архитектурный',
      'архив',
      'архивный',
      'архивы',
      'Архитектурный обзор архива',
      'арчибальд',
      'марчи',
      'archive',
      'archived',
      'archives',
      'architecture',
      'ARCHITECTURE',
      'arch',
      'the arch of the bridge',
      'anarchy',
      'marching',
      'searching',
      'search his notes',
      'artichoke',
      'article',
      'archery',
    ];
    for (const text of quiet) {
      it(`stays silent on ${JSON.stringify(text)}`, () => {
        expect(matchTrigger(text)).toBeNull();
      });
    }
  });

  it('matches whole tokens, so a name embedded in a longer word never counts', () => {
    expect(matchTrigger('Ｄａｒｃｈｉｅ')).toBeNull();
    expect(matchTrigger('darchie')).toBeNull();
  });

  it('does not treat spelled-out letters as the name', () => {
    expect(matchTrigger('a r c h i e')).toBeNull();
  });

  it('returns which variant matched, for the activation log', () => {
    expect(matchTrigger('hey Archie')).toBe('archie');
    expect(matchTrigger('Арчи, привет')).toBe('арчи');
  });

  it('ships no variant that is itself a common English word', () => {
    const commonWords = ['art', 'arty', 'archive', 'arch', 'artsy', 'bot', 'the'];
    for (const variant of TRIGGER_VARIANTS) {
      expect(commonWords).not.toContain(variant);
    }
  });

  it('covers the name the bot joins under, so the join name is also the wake word', () => {
    // Nothing else pins the two together now that the name is one constant rather than a knob adding itself to the list.
    expect(matchTrigger(BOT_NAME)).not.toBeNull();
  });
});

describe('isArchie', () => {
  it('recognises our own participant, whatever the transport capitalises it as', () => {
    expect(isArchie(BOT_NAME)).toBe(true);
    expect(isArchie('  ARCHIE ')).toBe(true);
  });

  it('does not claim a colleague, or an unnamed participant', () => {
    expect(isArchie('Archie Test')).toBe(false);
    expect(isArchie('Ann')).toBe(false);
    expect(isArchie(null)).toBe(false);
  });
});
