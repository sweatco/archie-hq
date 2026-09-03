// Loads the real prompt and frames both request halves as decideResponse() does; voice-speaking.md is read, never written.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSpeakingUserMessage } from '../../src/voice/comprehension.ts';

const PROMPT = fileURLToPath(new URL('../../prompts/voice-speaking.md', import.meta.url));

// Lets before/after arms interleave via PROMPT_FILE without editing the real prompt file. Defaults to it.
export function promptPath() {
  return process.env.PROMPT_FILE || PROMPT;
}

// Throws on a leftover {{VAR}}, diverging from production's loadPrompt — see the thrown message for why.
// Not cached — PROMPT_FILE differs between before/after arms (compare.mjs); caching would serve the first arm's prompt to the second. A 17KB read per case is negligible next to the model call.
export function filledPrompt(path = promptPath()) {
  const filled = fs.readFileSync(path, 'utf8').replaceAll('{{BOT_NAME}}', 'Archie');
  const leftover = filled.match(/{{[A-Z0-9_]+}}/g);
  if (leftover !== null) {
    throw new Error(
      `promptio: ${path} carries prompt variables this harness does not supply: ` +
      `${[...new Set(leftover)].join(', ')}. Supply them in filledPrompt() — an unsupplied one is ` +
      `passed through literally by loadPrompt, so every row of this run would silently measure ` +
      `a prompt containing that raw text.`,
    );
  }
  return filled;
}

// The whole filled prompt, as decideResponse sends it: `loadPrompt('voice-speaking', ...)` straight into the system message, with no splitting and no placement switch — production dropped both.
export function system() {
  return filledPrompt();
}

// Pinned, not computed — production builds these from live data (join/leave events, the knowledge log, a capabilities call) a fixture can't reproduce; pinning keeps future runs matching stored rows.
// Shaped as SpeakingContext declares it. <participants> includes someone who has left and someone with no name reported — the two rows easiest to get wrong.
//
// Size is under test — each field is pinned at a measured figure, not whatever reads tidily; context-arm.test.ts asserts the rendered sizes so an edit can't quietly shrink one.
//  - <participants>: 99 chars, ~101 measured for this four-person roster (~316 for twelve — a different arm, not a better pin).
//  - <capabilities>: 1,616 chars — the observed block itself, not a pin at a measured figure: summariseCapabilities's output here (1,585 chars, five areas, twenty specifics). No ceiling asserted.
//  - <written>: 6,955 against ~6,865 measured on a real events.jsonl, the largest of the three. Its cap (~24,512) is a separate arm.
//
// Three mechanical constraints on `written`'s content (context-arm.test.ts), unreadable by eye in ~8,700 characters of prose:
//  - no restating the prompt's own rules (e.g. "keep it short out loud") — measures the prompt repeated, not standing context. Guarded by a banned-term list.
//  - no sourced-looking value (identifier, figure, date, clock time, path): fabricationCheck/leakCheck judge a reply against c.transcript alone — a pinned value here reads as invented once relayed.
//  - no touching any case's subject (readme, nightly export, rate limit, etc.) — sent with every case, it would answer, contradict or bait an answerless fixture, and false-trigger must/detail/subject regexes.
//  - code-switched: half the suite is Russian, and an English-only channel this size nudges a reply toward English — which gradeDefect's LANGUAGE check fails.
export const FIXED_CONTEXT = {
  participants: [
    { name: 'Ann Petrova', is_host: true, joined_at: '2026-09-01T09:00:00.000Z', left_at: null },
    { name: 'Bob Chen', is_host: false, joined_at: '2026-09-01T09:01:00.000Z', left_at: null },
    { name: 'Dana Ruiz', is_host: false, joined_at: '2026-09-01T09:02:00.000Z', left_at: '2026-09-01T09:20:00.000Z' },
    { name: null, is_host: null, joined_at: '2026-09-01T09:03:00.000Z', left_at: null },
  ],
  written: [
    { speaker: 'Ann Petrova', text: 'Can you join the 10am and help us work out who owns billing now?' },
    { speaker: 'Archie', text: "Joining now — I'll speak for myself in the room." },
    { speaker: 'Ann Petrova', text: 'Also, we still have not sorted out who is taking the notes today.' },
    { speaker: 'Dana Ruiz', text: 'Я подключусь позже, так что от меня точно не жди — буду в дороге.' },
    { speaker: 'Bob Chen', text: 'I can do it if nobody else volunteers, though I have another thing at the same time and will only be half there.' },
    { speaker: 'Ann Petrova', text: 'I will take them. It is easier than arguing about it for ten minutes at the top of the call.' },
    { speaker: 'Dana Ruiz', text: 'Спасибо. И давайте не растягивать — в прошлый раз полчаса ушло на то, о чём вполне можно было договориться в переписке.' },
    { speaker: 'Ann Petrova', text: 'On the venue for the offsite — we are down to two places and both of them want an answer this week.' },
    { speaker: 'Bob Chen', text: 'I liked the one by the water. The other has better rooms, but everyone has to change trains twice to get there.' },
    { speaker: 'Dana Ruiz', text: 'Я за то, что у воды. Дорога важнее переговорных, если честно.' },
    { speaker: 'Ann Petrova', text: 'Then the one by the water it is. I will send the booking form round tomorrow and whoever is coming can fill in their own dietary bits.' },
    { speaker: 'Bob Chen', text: 'Works for me.' },
    { speaker: 'Ann Petrova', text: 'Whoever is booking travel, do it before the end of the week — the prices went up on us last time we left it late.' },
    { speaker: 'Dana Ruiz', text: 'У меня уже забронировано, кстати.' },
    { speaker: 'Bob Chen', text: 'While we are here — the naming thing. Does anybody actually object to calling the new one Harbour?' },
    { speaker: 'Dana Ruiz', text: 'Мне нравится. Легко произносится и запоминается.' },
    { speaker: 'Ann Petrova', text: 'No objection from me. It is better than the previous three suggestions put together.' },
    { speaker: 'Bob Chen', text: 'Harbour it is, then. I will rename the folder and tell whoever needs telling.' },
    { speaker: 'Ann Petrova', text: 'Dana, are you away next week or the week after? I have lost track, and I would rather not schedule the design critique into your holiday twice running.' },
    { speaker: 'Dana Ruiz', text: 'Со следующей среды и до конца той недели. Критику лучше поставить до этого, иначе она уедет очень далеко.' },
    { speaker: 'Ann Petrova', text: 'Before then, noted.' },
    { speaker: 'Bob Chen', text: 'I can cover anything urgent while she is away, within reason.' },
    { speaker: 'Ann Petrova', text: 'Thank you. I will put it on the shared calendar so nobody books over it.' },
    { speaker: 'Ann Petrova', text: 'The hiring loop as well — candidate feedback is due before the panel sits, and two of us have not done theirs yet.' },
    { speaker: 'Bob Chen', text: 'Mine goes in tonight. I keep starting it and being pulled off it.' },
    { speaker: 'Dana Ruiz', text: 'Моё уже готово, лежит в черновиках.' },
    { speaker: 'Ann Petrova', text: 'Then it is only me left, which is embarrassing.' },
    { speaker: 'Ann Petrova', text: 'Going back to last week for a moment — the document I wrote about who decides what. Did either of you get to the end of it?' },
    { speaker: 'Bob Chen', text: 'Most of the way. The part I got stuck on is where two people can both say no and nobody at all can say yes.' },
    { speaker: 'Ann Petrova', text: 'That is the part I am least happy with as well. I would rather one person decided and the rest of us argued afterwards.' },
    { speaker: 'Dana Ruiz', text: 'Согласна. Сейчас выходит так, что решает тот, кто громче, или тот, кто просто оказался на встрече.' },
    { speaker: 'Ann Petrova', text: 'Which is exactly why I want it settled rather than remembered differently by everybody.' },
    { speaker: 'Archie', text: 'The open questions from that document are in this channel as a list.' },
    { speaker: 'Ann Petrova', text: 'Thank you — that is what I was after.' },
    { speaker: 'Bob Chen', text: 'Separately: whoever wrote the invitation for this call put the wrong room in it, and half of us went to the wrong floor.' },
    { speaker: 'Ann Petrova', text: 'That was me. Sorry. It is fixed now.' },
    { speaker: 'Dana Ruiz', text: 'Ничего страшного, я всё равно опоздала.' },
    { speaker: 'Bob Chen', text: 'One more from me, and then I will stop: are we keeping the standing half hour on Thursdays, or folding it into this one?' },
    { speaker: 'Ann Petrova', text: 'Folding it in, I think. Two meetings that both start with everybody listing what they are doing is one meeting too many.' },
    { speaker: 'Dana Ruiz', text: 'Поддерживаю. Тогда и заметки будут в одном месте, а не в трёх.' },
    { speaker: 'Ann Petrova', text: 'Then that is settled too.' },
    { speaker: 'Archie', text: 'Noted here.' },
    { speaker: 'Bob Chen', text: 'My laptop is making a noise it has never made before, so if I vanish in the middle of the call, that is why.' },
    { speaker: 'Dana Ruiz', text: 'Классика.' },
    { speaker: 'Ann Petrova', text: 'The expense claims are also still open, by the way. Anything from the last month has to go in before the end of the week or it rolls into the next one.' },
    { speaker: 'Bob Chen', text: 'Mine are in. I did them on the train.' },
    { speaker: 'Dana Ruiz', text: 'А я опять забыла. Сделаю сегодня, честное слово.' },
    { speaker: 'Ann Petrova', text: 'There is also the conference in the autumn — the call for talks closes soon and we said we would put something in.' },
    { speaker: 'Bob Chen', text: 'I would rather present with somebody than alone, if anyone fancies it.' },
    { speaker: 'Dana Ruiz', text: 'Могу с тобой, если тема будет не про дизайн-систему. Про неё я больше не готова.' },
    { speaker: 'Bob Chen', text: 'Deal.' },
    { speaker: 'Ann Petrova', text: 'Good. Put a placeholder in the calendar so we do not miss the date.' },
    { speaker: 'Ann Petrova', text: 'And the coffee machine on our floor is broken again, in case anybody was planning their morning around it.' },
    { speaker: 'Dana Ruiz', text: 'Это самая плохая новость за неделю.' },
    { speaker: 'Bob Chen', text: 'Genuinely.' },
    { speaker: 'Ann Petrova', text: 'Two more small things and then I will leave you alone. The seating plan changes at the end of the month, and we get to say where we would rather sit.' },
    { speaker: 'Bob Chen', text: 'Anywhere away from the door. I have spent a year being the person who gets up to open it.' },
    { speaker: 'Dana Ruiz', text: 'Мне всё равно, лишь бы не под кондиционером. В прошлый раз я месяц просидела в шарфе.' },
    { speaker: 'Ann Petrova', text: 'Noted, both of you. I will put the three of us together and away from the door.' },
    { speaker: 'Bob Chen', text: 'And the shared drive — somebody reorganised it and now none of the old links go anywhere.' },
    { speaker: 'Ann Petrova', text: 'That was deliberate, apparently, though nobody told us it was happening. I have asked for the old layout to be written down somewhere before anybody moves anything else.' },
    { speaker: 'Dana Ruiz', text: 'Я до сих пор не могу найти папку с макетами. Она лежала там, где всё остальное, а теперь её там нет.' },
    { speaker: 'Bob Chen', text: 'It is one level deeper than it was. I found it by accident.' },
    { speaker: 'Ann Petrova', text: 'Somebody new starts on Monday, by the way, and nobody has volunteered to meet them at the door.' },
    { speaker: 'Dana Ruiz', text: 'Я могу, если это не слишком рано. Мне всё равно надо будет заехать в офис.' },
    { speaker: 'Ann Petrova', text: 'Not early. Late morning. Thank you.' },
    { speaker: 'Bob Chen', text: 'I will do lunch with them as well, so they are not eating alone on the day they arrive.' },
    { speaker: 'Ann Petrova', text: 'Good. That is more than we managed for the last two people who joined, which I still feel bad about.' },
    { speaker: 'Dana Ruiz', text: 'Кстати, обед всей командой мы так и не собрали с зимы.' },
    { speaker: 'Ann Petrova', text: 'I know. Pick a week and I will book something.' },
    { speaker: 'Bob Chen', text: 'The heating in the big room is also still wrong. It is either a sauna or it is off entirely.' },
    { speaker: 'Dana Ruiz', text: 'Подтверждаю. Я в том кабинете больше не сижу.' },
    { speaker: 'Ann Petrova', text: 'I have asked about it twice. If it is still like that next week I will stop asking politely.' },
    { speaker: 'Bob Chen', text: 'The badge readers on that side of the floor are temperamental too, so bring somebody with you.' },
    { speaker: 'Ann Petrova', text: 'Last thing before we start: the call is recorded, as always.' },
    { speaker: 'Bob Chen', text: 'Understood.' },
    { speaker: 'Dana Ruiz', text: 'Да, помню.' },
    { speaker: 'Ann Petrova', text: 'And if anything else needs to be on the agenda, say so before we begin rather than halfway through.' },
    { speaker: 'Ann Petrova', text: 'Right. Starting now.' },
  ],
  // Verbatim output of the summariser (buildCapabilitySummary, src/voice/capabilities.ts) — every character came off the wire, not authored.
  // Pinned because observed. Re-observe it the same way if the prompt is restructured — never hand-edit it into a shape that looks right.
  capabilities: [
    '- Mobile: app stability, releases, and build health',
    '  - Pull weekly crash metrics and stability reports for iOS and Android',
    '  - Check the status of store submissions and staged rollout percentages',
    '  - Diagnose failed mobile RC builds from the build logs',
    '  - Run health checks on the current release using warehouse metrics',
    '- Data & Growth: user metrics, campaign performance, and reporting',
    '  - Query DAU, MAU, retention, and revenue from the data warehouse',
    '  - Summarize the Main Growth Report and identify market movers',
    '  - Update CRM ticket performance properties with real campaign results',
    '  - Rank top walkers in specific clubs for leaderboards',
    '  - Add high-performing creatives to the Notion report',
    '- Campaigns & Offers: management of brands, offers, and copy',
    '  - Create or edit brand campaigns on the Monday.com board',
    '  - Update offer titles and descriptions across all locales',
    '  - Swap or QA cover images for offers against brand criteria',
    '  - Reprice offers or retire old ones in the admin panel',
    '  - Coordinate the LiveOps calendar, including push scheduling and draw setups',
    '  - Generate copy for branded challenges',
    '- Engineering & QA: software development and quality assurance',
    '  - Coordinate code investigations, bug fixes, and feature implementation',
    '  - Analyze bug reports and define acceptance criteria for Jira tickets',
    '  - Perform system health checks on connectivity and infrastructure',
    '- Product & Support: feature ideas and user account fixes',
    '  - Submit new product ideas and feature suggestions to Notion',
    '  - Reinstate lost walking streaks for users via the admin panel',
  ].join('\n'),
};

// The real production assembly, imported rather than reproduced — user-message.test.ts pins this delegation byte-for-byte.
// `context` defaults to undefined, not FIXED_CONTEXT — every row in results/ predates it, so defaulting it on would silently invalidate that corpus. context-arm.mjs opts a case in.
// Three arguments and no more: production's speaking call is one call taking exactly these, with no triage verdict to carry any more.
export function userMsg(transcript, consults, context) {
  return buildSpeakingUserMessage(transcript, consults, context);
}
