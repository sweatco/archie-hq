import { describe, it, expect } from 'vitest';
import { matchTrigger, TRIGGER_VARIANTS } from '../meeting.js';

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

  it('honours a configured bot name so renaming cannot disarm the trigger', () => {
    expect(matchTrigger('can you look at this, Jarvis', ['jarvis'])).not.toBeNull();
    expect(matchTrigger('hey Archie', ['jarvis'])).toBeNull();
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
});
