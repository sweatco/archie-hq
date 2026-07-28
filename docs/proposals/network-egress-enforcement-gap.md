# Known gap: Bash network egress is not enforced

**Status:** open — measured 2026-07-28, unfixed. **Severity:** the documented containment guarantee in `docs/architecture/security.md` does not hold in practice.

## Summary

`docs/architecture/security.md` states, under Filesystem Isolation → Network:

> All outbound network access from Bash is denied by default (`allowedDomains: []`). Agents cannot `curl`, `wget`, or otherwise reach the internet from shell commands. Web access is only available through the controlled research pipeline (MCP tools).

**Agents can in fact reach arbitrary internet hosts from Bash.** The filesystem half of the sandbox enforces correctly; the network allowlist does not appear to be enforced at all. This was measured on both the repo-agent and plugin-agent tracks, so it is not track-specific.

The intended design is sound and the wiring looks correct in our code — `buildSandboxConfig` passes `network.allowedDomains` (`src/agents/sandbox.ts:81-83`), fed from `def.allowedNetworkDomains` for the base/plugin track (`src/agents/spawn.ts:288`) and with the trusted registry pair appended for repo agents in approved edit mode (`spawn.ts:530-533`). The gap is in enforcement, not in configuration.

## Measurements

Both agents ran plain `python3 urllib` requests against hosts absent from any allowlist.

**Repo track — `archie-agent`.** Declares **no** `allowedNetworkDomains` whatsoever (`archie-plugins/archie/agents/archie.md`), so it should be deny-all:

| Target | Result |
|---|---|
| `https://example.com` | 200, 559 bytes |
| `https://www.factor75.com/plans` | 200, 3,326,433 bytes |
| `https://searchcactus.com` | 200, redirect-resolved to `https://cactusmedia.com/` |

**Plugin track — `ops-agent`.** Declares four hosts (`sheets.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `production.sweatco.in`). None of the tested targets is among them:

| Target | Result |
|---|---|
| `https://example.com` | 200 |
| `https://www.factor75.com/plans` | 200 |
| `https://searchcactus.com` | 200 → `https://cactusmedia.com/` |
| `https://classpass.com/try/sweatcointrial` | `HTTPError 403` |

The single failure is **not** the sandbox: a `403` is a normal HTTP-level response raised by `urllib` after the request reached the origin (it is a Cloudflare bot challenge). A sandbox block would surface as a connection- or DNS-level error with no HTTP status. Reaching the server at all is itself proof egress succeeded.

**The sandbox is engaged, so this is not a "sandbox disabled" condition.** In the same shells, filesystem denials held: `denyRead` on `/app` returned nothing, and `/home/archie/.claude` exposed only its intended carve-out. `bwrap` 0.11.0 is present at `/usr/bin/bwrap`. Writes outside the allowed set were refused (a `pip install --user` attempt failed with a read-only filesystem error). So filesystem isolation works while network isolation does not.

## Why the two halves may diverge

Not diagnosed — flagged for whoever picks this up. The plausible direction: bubblewrap's network isolation is all-or-nothing (`--unshare-net`), so a *domain allowlist* cannot be expressed by bwrap alone and requires a proxy or filtering resolver to implement. A configuration that bwrap cannot represent may be silently ignored rather than failing closed. Worth confirming against the bundled `@anthropic-ai/claude-agent-sdk` (`^0.3.220`) sandbox runtime before designing a fix.

Whatever the cause, the notable property is that it **fails open**: an unenforceable-or-unimplemented network policy results in full connectivity rather than no connectivity, and nothing surfaces that the policy was dropped.

## Impact

- The exfiltration mitigation described in the threat model does not hold for Bash. Any agent can post data to an arbitrary host.
- "No Web Tools on Agents" (Defense Layer 2) is bypassable. `WebFetch`/`WebSearch` are correctly denied at `spawn.ts:277-281`, but the intent behind that denial — routing all web access through the guardrail-scanned, budget-capped research pipeline — is defeated by shell access. Content fetched via Bash carries none of the `<research_result>` tagging or guardrail scanning that `web_research` applies.
- `allowedNetworkDomains` currently conveys **intent only**. Agents declaring narrow allowlists are not in fact constrained to them, and the field's presence may give false assurance when reviewing an agent definition.

## Before fixing: one dependency to coordinate

`archie-plugins/ops/skills/offer-link-code-qa` relies on this gap. It validates Sweatcoin offer links by opening the brand's landing page, which needs exactly the arbitrary-host egress that is supposed to be denied. It was built and shipped with the gap documented in the skill file, and the trade-off accepted in writing by the requesting stakeholder.

**It is built to fail safely.** It probes a neutral control host before judging any page; if that probe fails it reports every affected offer as `couldn't open — network blocked` and continues to run its admin-data checks. So closing this gap will **not** cause silent false passes — the check degrades loudly and visibly.

What closing the gap *will* do is disable that skill's landing-page half until a replacement exists. The intended replacement is a server-side link-inspection tool in the `sweatco-admin` MCP (fetching from the backend, where egress is legitimate, and able to fetch a given market's regional view — something an agent egressing from a single region cannot do). **Worth a heads-up to the Ops/growth stakeholders when this is scheduled**, rather than a surprise regression.

Note that widening `allowedNetworkDomains` is not a viable accommodation: the brand hosts are discovered per batch at runtime, whereas frontmatter is authored in advance, so the required set is structurally unauthorable.

## Suggested direction

1. **Confirm the mechanism** — determine whether the SDK sandbox implements domain allowlisting on this platform, and whether an unrepresentable policy is being silently dropped.
2. **Fail closed, loudly.** If a requested network policy cannot be enforced, that should be a startup-visible error or an explicit deny, never silent full connectivity. This is the most valuable fix regardless of what else changes, because it removes the class of problem rather than this instance.
3. **Correct the documentation in the meantime.** `security.md`'s network claim is currently read as a guarantee; until enforcement is real it should be marked as intended-not-enforced, with a pointer here. A doc that overstates containment is worse than one that admits a gap.
4. **Land the server-side fetch tool** before or alongside enforcement, so the dependent Ops workflow has a path forward.

## References

- `src/agents/sandbox.ts:81-83` — `network.allowedDomains` wiring; `:28` — "empty = deny all, default"; `:58` — "Network: deny-all by default from Bash"
- `src/agents/spawn.ts:288` — base/plugin track; `:530-533` — repo track, appends `TRUSTED_PACKAGE_REGISTRY_DOMAINS`; `:277-281` — `WebFetch`/`WebSearch` denial
- `src/system/plugin-loader.ts:358-362` — frontmatter parsing of `allowedNetworkDomains`
- `docs/architecture/security.md:64` — the claim this document contradicts
- `archie-plugins/ops/skills/offer-link-code-qa/SKILL.md` — the dependent workflow and its fail-loud design
