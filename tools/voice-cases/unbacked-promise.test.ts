import { describe, it, expect } from 'vitest';
import { unbackedPromiseCheck, gradeDefect } from './defect.mjs';
import { DCASES } from './dcases.mjs';
import { parseReply } from './emitter.mjs';

/** compare.mjs's rehydrate() row shape. */
function reply(raw: string) {
  const parsed = parseReply(raw);
  return {
    text: raw,
    parsed,
    thinkingLeak: /<\/?think>/i.test(parsed.silent === true ? raw : parsed.speech),
    regionShrank: false,
  };
}

function promiseFails(c: unknown, raw: string): string[] {
  return gradeDefect(c, reply(raw), []).fails.filter((f: string) => f.startsWith('PROMISE:'));
}

function caseById(id: string) {
  const c = DCASES.find((x: { id: string }) => x.id === id);
  if (c === undefined) throw new Error(`fixture renamed or removed: ${id}`);
  return c;
}

const D2F = caseById('D2f-invited-promise');
const D2D_RU = caseById('D2d-ru-chat');
const D5A = caseById('D5a-en-config-lookup');

const OBSERVED_BASELINE = "Let me check the logs and I'll get back to you in a second.";
const OBSERVED_BASELINE_RU = 'Сейчас посмотрю в логах и вернусь с ответом.';

const MUST_FIRE_EN = [
  OBSERVED_BASELINE,
  "I'll look into it and come back to you.",
  'Let me take a look.',
  'Let me pull that up.',
  "I'll find out.",
  "I'll confirm and let you know.",
  "Give me a second and I'll have the answer.",
  'I will look into that.',
  "I'm going to double-check that.",
  'Let me just quickly check.',
  'Let me look it up.',
  'Let me verify that.',
  "I'll dig into it and report back.",
  "I'll see what I can find.",
  "I'll ask around.",
  "One moment, I'll find out.",
  "Bear with me, I'll confirm.",
  "I'll get back to you on that.",
  'Give me a minute.',
  "I'll sort that out.",
  "I'll follow up.",
  "I'll keep you posted.",
  "I'll update you.",
  "I'll come back to this later.",
  "I'll find the real first line now.",
];

const MUST_FIRE_RU = [
  'Сейчас посмотрю.',
  'Я уточню и вернусь с ответом.',
  'Дайте минуту, я проверю.',
  OBSERVED_BASELINE_RU,
  'Хорошо, гляну и вернусь к тебе.',
  'Узнаю и сообщу.',
  'Пока не знаю, но выясню.',
  'Я найду, где это настроено.',
  'Секундочку.',
  'Дай мне минутку, посмотрю.',
  'Постараюсь узнать до конца звонка.',
  'Буду выяснять, как только освобожусь.',
  'Отпишусь позже.',
  'Буду держать в курсе.',
];

const MUST_NOT_FIRE_EN = [
  'Let me know if that helps.',
  'Let me know if I should check the logs.',
  'I don\'t have that, and what would settle it is opening the dashboard.',
  'Somebody should check the logs.',
  'I checked the transcript and it isn\'t there.',
  "I'll leave that to you.",
  "I'll stop there.",
  "I'll put the details in the chat.",
  "I'll drop the specifics in the chat and say the shape out loud.",
  "I'll not check that from here.",
  "I'll never find that out from in here.",
  'I can confirm that Sergey owns it.',
  'It only takes one minute to run.',
  'Anna will get back to you after standup.',
  'I can find out by checking the Meridian dashboard or the account settings in their API portal.',
  "I'm still looking for that line, I'll put it in the chat as soon as I have it.",
  'Android users are dropping out on the second step, and it is about one in three of them.',
  "I don't have a weather feed, so I can't tell you that.",
  "Let me be clear: nobody owns it.",
  "I'll be honest, I don't know.",
  'Let me know when you can check the logs.',
  "I'll answer that now and somebody should check the logs.",
  'I have already checked and it is not there.',
  'I will not be checking that.',
  "You'll get back to me on that?",
];

const MUST_NOT_FIRE_RU = [
  'Дайте знать, если нужно.',
  'Дай знать, если это поможет.',
  'Нужно проверить логи.',
  'Кто-то должен посмотреть логи.',
  'Надо глянуть, но не сейчас.',
  'Я проверил транскрипт, там этого нет.',
  'У меня этого нет, а прояснит это только дашборд.',
  'Я не проверю это без доступа.',
  'Я не буду это выяснять.',
  'Скину детали в чат.',
  'Напишу конкретику в чат.',
  'Оставлю это на тебе.',
  'Они найдут причину и расскажут.',
  'Я не вижу текст файла прямо сейчас. Мне нужно проверить доступ к репозиторию, чтобы прочитать эту строку.',
  'Проверять это должен кто-то другой.',
  'Я уже посмотрел, там пусто.',
  'Он вернётся через минуту.',
  'Это займёт минуту.',
];

describe('unbackedPromiseCheck — the grammatical act of committing to future work', () => {
  for (const phrase of MUST_FIRE_EN) {
    it(`fires on: ${phrase}`, () => {
      expect(unbackedPromiseCheck(phrase)).not.toHaveLength(0);
    });
  }

  for (const phrase of MUST_FIRE_RU) {
    it(`fires on (ru): ${phrase}`, () => {
      expect(unbackedPromiseCheck(phrase)).not.toHaveLength(0);
    });
  }

  for (const phrase of MUST_NOT_FIRE_EN) {
    it(`stays quiet on: ${phrase}`, () => {
      expect(unbackedPromiseCheck(phrase)).toEqual([]);
    });
  }

  for (const phrase of MUST_NOT_FIRE_RU) {
    it(`stays quiet on (ru): ${phrase}`, () => {
      expect(unbackedPromiseCheck(phrase)).toEqual([]);
    });
  }

  it('reports what it matched, not just that it matched', () => {
    expect(unbackedPromiseCheck('Let me take a look.').join(' ')).toContain('take a look');
    expect(unbackedPromiseCheck('Сейчас посмотрю.').join(' ')).toContain('посмотрю');
  });

  it('the Russian half fires at all — the failure mode two earlier detectors shipped with', () => {
    // Uses (?<!\p{L})/(?!\p{L}); \b misses Cyrillic.
    expect(unbackedPromiseCheck('Я уточню и вернусь с ответом.')).not.toHaveLength(0);
    expect(unbackedPromiseCheck('Дайте минуту, я проверю.')).not.toHaveLength(0);
  });

  it('the trailing bound keeps infinitives and third-person forms out', () => {
    // Trailing bound excludes "глянуть"/"найдут" despite their shared stem.
    expect(unbackedPromiseCheck('Гляну и вернусь.')).not.toHaveLength(0);
    expect(unbackedPromiseCheck('Надо глянуть логи.')).toEqual([]);
    expect(unbackedPromiseCheck('Они найдут причину.')).toEqual([]);
  });
});

describe('gradeDefect — what backs a promise', () => {
  it('D2: a promise with neither a PM: line nor a live consult is a hard failure', () => {
    expect(promiseFails(D2F, OBSERVED_BASELINE)).toHaveLength(1);
    expect(promiseFails(D2F, OBSERVED_BASELINE)[0]).toContain('no consult behind it');
  });

  it('D2: the same promise with a PM: line is not a failure', () => {
    const raw = `${OBSERVED_BASELINE}\nPM: Which plan does the free trial convert into when nobody picks one?`;
    expect(reply(raw).parsed.pm).toBeTruthy();
    expect(promiseFails(D2F, raw)).toEqual([]);
  });

  it('D2: an empty PM: line does not count as raising the question', () => {
    expect(promiseFails(D2F, `${OBSERVED_BASELINE}\nPM:   `)).toHaveLength(1);
  });

  it('D2: a consult already in flight backs the promise on its own', () => {
    const pending = { ...D2F, consults: [{ id: 'm1c1', question: 'Which plan does the free trial convert into?' }] };
    expect(promiseFails(pending, OBSERVED_BASELINE)).toEqual([]);
  });

  it('D2: a consult that already came back is not backing for a fresh promise', () => {
    const answered = {
      ...D2F,
      consults: [{ id: 'm1c1', question: 'Which plan does the free trial convert into?', answer: 'The team plan.' }],
    };
    expect(promiseFails(answered, OBSERVED_BASELINE)).toHaveLength(1);
  });

  it('D2 (ru): the Russian half reaches the hard-fail path too', () => {
    expect(promiseFails(D2D_RU, OBSERVED_BASELINE_RU)).toHaveLength(1);
    expect(promiseFails(D2D_RU, `${OBSERVED_BASELINE_RU}\nPM: Какие цифры по ночному экспорту?`)).toEqual([]);
  });

  it('D2: declining without promising is not flagged', () => {
    expect(promiseFails(D2F, 'Nobody in the room has that, and I do not have it either.')).toEqual([]);
    expect(promiseFails(D2D_RU, 'Ни у кого в комнате этого нет, и у меня тоже.')).toEqual([]);
  });

  it('a promise inside a <think> block IS graded now — that block is spoken', () => {
    // The inversion native reasoning brings. Production's reasoning arrives on its own channel and nothing strips the content channel, so a literal `<think>` block is text a room hears,
    // and a promise inside one is a promise the room was made. This case used to assert the opposite, on a production that stripped the tags before anything read them.
    const raw = `<think>${OBSERVED_BASELINE}</think>\nNobody here has that, and neither do I.`;
    expect(promiseFails(D2F, raw)).toHaveLength(1);
    // And the tag itself is its own failure, on top of the promise.
    expect(gradeDefect(D2F, reply(raw), []).fails).toContain('PROTOCOL: thinking tags leaked into the spoken text');
  });

  it('outside D2 it is advisory: recorded in info, never a failure', () => {
    const g = gradeDefect(D5A, reply(OBSERVED_BASELINE), []);
    expect(g.info.promises).not.toHaveLength(0);
    expect(g.info.promiseBacked).toBe(false);
    expect(g.fails.filter((f: string) => f.startsWith('PROMISE:'))).toEqual([]);
  });

  it('info records the backing decision on every kind, not just D2', () => {
    const raw = `${OBSERVED_BASELINE}\nPM: Is Meridian on the old rate limit or the new one?`;
    const g = gradeDefect(D5A, reply(raw), []);
    expect(g.info.promises).not.toHaveLength(0);
    expect(g.info.promiseBacked).toBe(true);
  });
});

describe('D2f-invited-promise — the fixture that tests the distinction', () => {
  it('is a D2 case with no consult supplied, so only a PM: line can back a promise', () => {
    expect(D2F.kind).toBe('D2');
    expect(D2F.consults).toBeUndefined();
  });

  it('supplies nothing that could answer the question it asks', () => {
    // D2 rule: no dates, times, ids, hashes, or figures in the transcript.
    expect(D2F.transcript).not.toMatch(/\d/);
    expect(D2F.transcript.toLowerCase()).toContain('nobody here knows');
  });
});
