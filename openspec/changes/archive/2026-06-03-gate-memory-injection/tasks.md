## 1. Flag accessor

- [x] 1.1 Add `isInjectionEnabled()` to `src/memory/paths.ts` returning `process.env.ARCHIE_MEMORY_INJECT === 'true'` (default off), placed and styled like `isHousekeepingEnabled()`
- [x] 1.2 Re-export `isInjectionEnabled` from `src/memory/index.ts` alongside `isMemoryEnabled`

## 2. Gate the injection (read) path

- [x] 2.1 In `enrichPromptWithMemory()` (`src/memory/context.ts`), after the existing `isMemoryEnabled()` early-return, add an early-return that returns the input prompt unchanged when `!isInjectionEnabled()` — placed before any call to `buildMemoryContext()` so no store reads occur
- [x] 2.2 Emit a single debug log line via the unified logger on the inject-disabled short-circuit, worded distinctly from the master-disabled path
- [x] 2.3 In `src/agents/spawn.ts`, short-circuit `extractTaskUsernames()` to return `[]` when `!isInjectionEnabled()` (next to the existing `!isMemoryEnabled()` guard), skipping the transcript username scan and per-user file reads
- [x] 2.4 Confirm all three spawn tracks (PM `spawn.ts:252`, repo `381`, plugin `482`) route through the gated helpers and need no per-call-site guard

## 3. Tests

- [x] 3.1 `context.test.ts`: `enrichPromptWithMemory` returns the prompt byte-for-byte when memory is enabled but `ARCHIE_MEMORY_INJECT` is unset / not `true`
- [x] 3.2 `context.test.ts`: no store reads happen on the inject-disabled path (memory file present in temp store, yet output prompt is unchanged, contains no `## Organizational Memory` block, and exactly one `injection disabled` debug line is logged before any read)
- [x] 3.3 `context.test.ts`: positive injection case now sets `ARCHIE_MEMORY_INJECT=true` and asserts injection still works under that flag
- [x] 3.4 `context.test.ts`: master precedence — `ARCHIE_MEMORY=false` with `ARCHIE_MEMORY_INJECT=true` ⇒ passthrough
- [x] 3.5 `paths.test.ts`: `isInjectionEnabled()` real-accessor unit tests — default off when unset, on only for exact `"true"`, off for `false`/`1`/`TRUE`/`yes`/`""`. (The `extractTaskUsernames` short-circuit is a private 1-line perf guard with no test harness; its observable effect — no injection — is covered by the gate tests above and the runtime check in 5.3.)
- [x] 3.6 Confirmed `lifecycle.test.ts` (extraction) stays green and is independent of `ARCHIE_MEMORY_INJECT`

## 4. Documentation

- [x] 4.1 `.env.example`: add `ARCHIE_MEMORY_INJECT` near the other memory flags, documenting default-off and the `true` opt-in, with a note that this inverts the default-enabled convention
- [x] 4.2 `docs/architecture/memory.md`: add the flag to the flags table, add an `ARCHIE_MEMORY` × `ARCHIE_MEMORY_INJECT` truth table, and document the collect-only rollout posture

## 5. Verify

- [x] 5.1 `npm run typecheck` is clean
- [x] 5.2 `npx vitest run src/memory/__tests__/` (299) and `npm test` (385) are green
- [x] 5.3 Verified gate behavior with an unmocked runtime check (real `enrichPromptWithMemory` + real `isInjectionEnabled`, seeded temp `WORKDIR`): inject unset ⇒ no `## Organizational Memory` block + one debug line; `ARCHIE_MEMORY_INJECT=true` ⇒ seeded `<user_preferences>` block reappears; `ARCHIE_MEMORY=false` overrides. Extraction-still-writes is covered by `lifecycle.test.ts`. Full archie-e2e Docker/Slack round-trip not executed (optional — offer to run).
