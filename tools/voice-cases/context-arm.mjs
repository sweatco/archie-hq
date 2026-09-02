/**
 * Controls how much of production's six-block request a campaign sends.
 * `bare` (default): transcript+consults only, byte-identical to the 180 rows in results/defect-trim-*.json / defect-live-*.json — pinned by context-arm.test.ts.
 * `full`: adds FIXED_CONTEXT plus a derived <situation> verdict.
 * `full-noverdict`: same context, no verdict — production's fail-safe path when triage fails/times out/is unreadable; a real arm, not a control.
 * Placement (ARCHIE_VOICE_PROMPT_PLACEMENT) is resolved inside production's assembleSpeakingRequest under all three, via userMsg.
 */
import { assembleSpeakingRequest } from '../../src/voice/comprehension.ts';
import { FIXED_CONTEXT } from './promptio.mjs';

export const CONTEXT_ARM_ENV = 'CONTEXT_ARM';

/** Every arm, in the order a campaign would compare them. */
export const CONTEXT_ARMS = ['bare', 'full', 'full-noverdict'];

export function resolveContextArm(raw) {
  const value = (raw ?? '').trim();
  if (value.length === 0) {
    return 'bare';
  } else if (CONTEXT_ARMS.includes(value)) {
    return value;
  } else {
    throw new Error(
      `${CONTEXT_ARM_ENV}="${raw}" is not an arm. Use one of: ${CONTEXT_ARMS.join(', ')}. ` +
      `Defaulting silently would collect a bare run under a name that claims otherwise, and ` +
      `nothing downstream could tell the difference afterwards.`,
    );
  }
}

// undefined, not {}, for bare: {} would claim an empty roster/capabilities rather than none, mattering once a block renders its own emptiness (identical today).
export function armContext(arm) {
  return arm === 'bare' ? undefined : FIXED_CONTEXT;
}

// undefined (bare) vs null (full-noverdict): both render no block, but undefined = argument not passed (byte-identical pre-<situation>); null = production's fail-safe value from runTriageGate.
export function armVerdict(arm, c) {
  if (arm === 'bare') {
    return undefined;
  } else if (arm === 'full-noverdict') {
    return null;
  } else {
    return deriveVerdict(c);
  }
}

// Empty for `bare`, not `-bare`: keeps results/defect-<candidate>.json at its pre-arm filename.
export function armFileTag(arm) {
  return arm === 'bare' ? '' : `-${arm}`;
}

/**
 * The verdict each family's construction implies, for cases the consult rule doesn't decide.
 * Total map over kinds — unmapped throws, not a silent no-verdict; context-arm.test.ts asserts full dcases.mjs coverage.
 * Each entry is where the answer must come from, not whether the topic appears; verdictContradictions checks it against the fixture at derivation.
 */
export const FAMILY_VERDICT = {
  D1: 'outside',
  D2: 'outside',
  D3: 'room',
  D4: 'room',
  D5: 'outside',
  D6: 'elsewhere',
  D7: 'room',
  D8: 'room',
  D10: 'elsewhere',
};

// The turn just addressed is always the transcript's last line, per production's window ordering.
function lastUtterance(transcript) {
  const lines = String(transcript).trimEnd().split(/\r?\n/);
  return lines[lines.length - 1] ?? '';
}

function outstandingConsults(c) {
  return (c.consults ?? []).filter((x) => (x.answer ?? '').trim().length === 0);
}

function hasOutstandingConsult(c) {
  return outstandingConsults(c).length > 0;
}

// `subject` reuses D6/D7's pendingNagCheck regexes, so the verdict and detector can't disagree on what the consult is.
// Empty `subject` defaults true: D8 references the consult only by pronoun ("did you get *that*"), invisible to a last-line regex.
function turnIsAboutTheConsult(c) {
  const subject = c.subject ?? [];
  if (subject.length === 0) {
    return true;
  }
  const asked = lastUtterance(c.transcript);
  return subject.some((re) => re.test(asked));
}

/**
 * Read live via assembleSpeakingRequest rather than hand-copied: a copy would go stale when comprehension.ts rewords it.
 * `placement` is hardcoded (`guidance-first`) and irrelevant — it only changes where `<situation>` lands, not its wording.
 */
export function situationSentence(where) {
  const rendered = assembleSpeakingRequest({
    prompt: '',
    transcript: 'Anna: hi',
    triage: { where },
    placement: 'guidance-first',
  }).user;
  const found = rendered.match(/<situation>\n([\s\S]*?)\n<\/situation>/);
  const sentence = found === null ? '' : found[1].trim();
  // The literal "undefined" check matters: SITUATION is a total Record over the four verdicts, so an out-of-union `where` still renders a well-formed block holding that text.
  if (sentence.length === 0 || sentence === 'undefined') {
    throw new Error(
      `context-arm: production rendered no <situation> block for the verdict "${where}" (it rendered ` +
      `${JSON.stringify(sentence)}). Either that is not a verdict production accepts, or the block's ` +
      `shape has changed — and this harness quotes that block back when it refuses a contradiction, ` +
      `so it must not guess at it.`,
    );
  }
  return sentence;
}

// Checks `must`/`detail` only, never `mustSay` (D10): it claims the *reply* must say something, not that the transcript supplies it — including it would falsely source D10 and refuse `elsewhere` wrongly.
// Verified per-group against the transcript, since a `must` alternative may be phrased for the reply. context-arm.test.ts asserts no group fails this.
function transcriptSources(c) {
  const found = [];
  for (const group of c.must ?? []) {
    const hits = group.filter((re) => re.test(c.transcript)).map(String);
    if (hits.length > 0) {
      found.push(`\`must\` ${hits.join(' / ')}`);
    }
  }
  for (const re of c.detail ?? []) {
    if (re.test(c.transcript)) {
      found.push(`\`detail\` ${re}`);
    }
  }
  return found;
}

function answeredConsults(c) {
  return (c.consults ?? []).filter((x) => (x.answer ?? '').trim().length > 0);
}

/**
 * Every way this verdict contradicts the fixture's own declarations; empty means it passes.
 * Checks room/pending/transcript-source against fields the fixture already carries for its detectors — no new hand-labelling.
 * Skips: "derived room, no source" under a `triage` override (known gap); `outside` vs `elsewhere` (semantic call); mirror parity (context-arm.test.ts's job); live triage-gate agreement (defeats the point — a rep is only a rep if the bytes match).
 */
export function verdictContradictions(c, verdict) {
  const where = verdict?.where;
  const clashes = [];
  if (where === undefined) {
    // undefined (bare) or null (full-noverdict): verdict?.where is undefined either way, so nothing to contradict.
    return clashes;
  }

  const fromTranscript = transcriptSources(c);
  const answered = answeredConsults(c);
  const outstanding = outstandingConsults(c);
  const overridden = 'triage' in c;

  if (where === 'room' && fromTranscript.length === 0 && answered.length === 0) {
    if (outstanding.length > 0 && turnIsAboutTheConsult(c)) {
      clashes.push(
        `\`room\` states the answer "${situationSentence('room')}", but the fixture's own consults block ` +
        `holds ${outstanding.map((x) => `"${x.id}"`).join(', ')} with no answer, and this turn is about it — ` +
        `the fixture states that it did have to be looked up and that nothing has come back`,
      );
    } else if (!overridden) {
      clashes.push(
        `\`room\` states the answer "${situationSentence('room')}", derived from FAMILY_VERDICT.${c.kind}, but the ` +
        `fixture declares no source for it: no \`must\` group, no \`detail\` regex and no answered consult. ` +
        `A family whose construction puts the answer in the room says so with one of those`,
      );
    }
  }

  if (where === 'pending' && outstanding.length === 0) {
    clashes.push(
      `\`pending\` states "${situationSentence('pending')}", but the fixture declares no consult awaiting an ` +
      `answer${answered.length > 0 ? ' — every consult it carries has one' : ' at all'}`,
    );
  }

  if (fromTranscript.length > 0 && where !== 'room') {
    clashes.push(
      `\`${where}\` states "${situationSentence(where)}", but the fixture declares the answer is in its own ` +
      `transcript — ${fromTranscript.join(', ')} — and \`gradeDefect\` fails a reply that does not relay it`,
    );
  }

  return clashes;
}

/**
 * Derived from the fixture, not a real triage-gate call, so two runs stay comparable — a rep is only a rep if the bytes match.
 * Ladder: own `triage` first (`null` included); outstanding consult the turn is about → `pending`, else `elsewhere`; else FAMILY_VERDICT; unmapped kind throws. verdictContradictions runs last, auditing a hand override too.
 */
export function deriveVerdict(c) {
  let verdict;
  if ('triage' in c) {
    verdict = c.triage;
  } else if (hasOutstandingConsult(c)) {
    verdict = { where: turnIsAboutTheConsult(c) ? 'pending' : 'elsewhere' };
  } else if (c.kind in FAMILY_VERDICT) {
    verdict = { where: FAMILY_VERDICT[c.kind] };
  } else {
    throw new Error(
      `context-arm: no verdict rule for kind "${c.kind}" (case ${c.id}). Add it to ` +
      `FAMILY_VERDICT with the reason, or give the case its own \`triage\`. A family that ` +
      `silently sent no verdict would be measured as if the gate had timed out on every one ` +
      `of its cases.`,
    );
  }

  const clashes = verdictContradictions(c, verdict);
  if (clashes.length > 0) {
    throw new Error(
      `context-arm: the verdict derived for ${c.id} (${c.kind}) contradicts what the fixture itself ` +
      `declares — ${clashes.join('; also ')}. The <situation> block is sent as a statement of fact one ` +
      `line above generation, so a false one is answered by the model and then graded as the model's ` +
      `failure. Fix the rule in FAMILY_VERDICT, or give the case its own \`triage\` with the reason ` +
      `beside its transcript, or correct whichever declaration is the wrong one.`,
    );
  }
  return verdict;
}

export function verdictTally(arm, cases) {
  const tally = {};
  for (const c of cases) {
    const v = armVerdict(arm, c);
    const key = v === undefined ? '(not sent)' : v === null ? 'null (fail-safe)' : v.where;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return tally;
}
