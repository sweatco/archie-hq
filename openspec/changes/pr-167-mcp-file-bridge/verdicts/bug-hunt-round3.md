# Adversarial bug hunt — round 3 (final)

**Verdict: PASS**

All round-2 fixes verified on the final tree: (a) whole-server disallow form at src/agents/mcp-file-bridge.ts:133-137, mutation kills its test; (b) `tools` allowlist enforcement at :138-143 with both allow-forms honored and SDK `tools` confirmed as a strict allowlist at spawn.ts:614, mutation kills its test; (c) post-read ceiling re-check at :184-194, mutation kills its test. Additionally confirmed: `applyOAuthBindings` (src/system/oauth/inject.ts:33) mutates the shared map in place, so the bridge's call-time resolution claim holds; prototype-key server names (`__proto__`, `constructor`) fall through to the type/url rejection; the bridge cannot recurse into itself (type `sdk` rejected). Typecheck clean, 18/18 bridge tests pass.
