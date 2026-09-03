/**
 * Controls how much of production's request a campaign sends.
 * `bare` (default): transcript+consults only, byte-identical to the 180 rows in results/defect-trim-*.json / defect-live-*.json — pinned by context-arm.test.ts.
 * `full`: adds FIXED_CONTEXT — the three standing blocks a live turn also carries.
 *
 * There were three arms while production ran a triage gate: `full` sent a `<situation>` verdict on top of the standing blocks and `full-noverdict` sent the same blocks with none,
 * which was production's own path whenever the gate failed, timed out or came back unreadable. The gate is gone, `<situation>` with it, and `buildSpeakingUserMessage` takes no verdict —
 * so those two arms would now send byte-identical requests under two names. They are one arm, and it keeps the name of the one whose bytes it still sends.
 */
import { FIXED_CONTEXT } from './promptio.mjs';

export const CONTEXT_ARM_ENV = 'CONTEXT_ARM';

/** Every arm, in the order a campaign would compare them. */
export const CONTEXT_ARMS = ['bare', 'full'];

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

// Empty for `bare`, not `-bare`: keeps results/defect-<candidate>.json at its pre-arm filename.
export function armFileTag(arm) {
  return arm === 'bare' ? '' : `-${arm}`;
}
