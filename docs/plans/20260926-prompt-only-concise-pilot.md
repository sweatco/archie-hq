# Prompt-and-skill concise reply pilot

**TL;DR:** This draft changes Archie's PM prompt and two skills, with no output style, application code, dependency, or runtime setting change. The revised prompt-and-skills arm used 2,187 words across 26 replies versus 5,910 in the control, a 63% reduction and 231 words more than the first revision. It retained the requested facts in the reviewed fixtures but still made unsupported claims, so the PR remains a draft.

## Changes

- `prompts/pm-agent.md`: give each fact once, use the form the user requested, and check factual clauses against the user message or tool results before posting.
- `examples/plugins/helper/skills/structured-summary/SKILL.md`: replace the required TL;DR-plus-bullets template with a conclusion and only the bullets needed to preserve distinct facts.
- `core-plugin/skills/thread-conduct/SKILL.md`: skip a separate acknowledgement when Archie can answer in the same turn; keep interim posts tied to user need.

No Claude Code output style is included. Archie's current runtime and generated agent settings remain unchanged.

## Fixture evaluation

The 22 fixtures contain 26 reply positions: 20 single-turn tasks and two three-turn threads. The original four-arm comparison and a subsequent prompt-and-skills revision used fresh Archie tasks with the same prompts, Claude Agent SDK 0.3.283, and the same container image and runtime configuration. The only switched files were the PM prompt, the two skills, and the candidate plugin output style. Every arm made 26 user-facing posts. Word counts include all of each post; they are not estimates from final messages alone.

| Arm | Words | Change from control | Result |
| --- | ---: | ---: | --- |
| Clean control | 5,910 | — | Unsupported claims in several cases |
| Initial PM prompt and skills | 1,956 | −67% | Factuality gate failed |
| Revised PM prompt and skills (current draft) | 2,187 | −63% | More explanation; factuality gate still fails |
| Forced custom output style only | 3,315 | −44% | Leaves the old summary template and several factual errors |
| PM prompt, skills, and style | 1,743 | −71% | Shortest; factuality gate still fails |

| Case | Control | Initial prompt + skills | Revised prompt + skills | Style only | Combined |
| --- | ---: | ---: | ---: | ---: | ---: |
| Rollout | 98 | 61 | 68 | 89 | 79 |
| Meeting | 76 | 58 | 60 | 63 | 57 |
| Incident | 303 | 69 | 78 | 163 | 80 |
| Migration | 277 | 70 | 136 | 145 | 76 |
| Latency | 438 | 264 | 322 | 360 | 241 |
| Customer reply | 222 | 45 | 43 | 100 | 48 |
| Release update | 135 | 64 | 46 | 65 | 34 |
| Queue retries | 538 | 138 | 116 | 429 | 112 |
| Checkout status | 96 | 34 | 36 | 43 | 34 |
| Shipment reply | 226 | 30 | 26 | 33 | 28 |
| Report status | 416 | 47 | 53 | 36 | 34 |
| Pricing test | 291 | 72 | 99 | 193 | 75 |
| Search latency | 332 | 171 | 216 | 280 | 181 |
| Webhook retries | 461 | 134 | 134 | 320 | 95 |
| Inventory reply | 167 | 31 | 29 | 32 | 31 |
| Uptime | 120 | 39 | 34 | 40 | 35 |
| Experiment | 357 | 78 | 173 | 336 | 75 |
| Refund reply | 193 | 31 | 33 | 59 | 30 |
| Deploy | 22 | 20 | 20 | 18 | 16 |
| Percentiles | 335 | 208 | 190 | 188 | 169 |
| Release thread, turn 1 | 163 | 71 | 77 | 50 | 42 |
| Release thread, turn 2 | 76 | 36 | 48 | 30 | 27 |
| Release thread, turn 3 | 28 | 24 | 17 | 31 | 16 |
| Incident thread, turn 1 | 177 | 78 | 67 | 65 | 50 |
| Incident thread, turn 2 | 247 | 50 | 38 | 114 | 37 |
| Incident thread, turn 3 | 116 | 33 | 28 | 33 | 41 |
| **Total (26 replies)** | **5,910** | **1,956** | **2,187** | **3,315** | **1,743** |

Manual review found the requested decisions and named facts in the prompt-and-skills and combined arms, but none met the no-unsupported-claim gate. A factuality issue here means a claim about the source or world that the supplied facts do not establish; clearly labeled recommendations and hypotheses are not counted as source facts.

- **Control:** among other errors, it invented a calendar date for the checkout update, a shipment date and customer follow-up commitment, and exact statistical results from rounded conversion rates. A second earlier clean-control run also made unsupported claims.
- **Initial prompt and skills:** the migration reply checked rollback against the 30-minute limit without including B's 15-minute cutover; the uptime reply broadened an unaudited missed-events question into data loss; the search reply said a CDN split would confirm or rule out causation; the pricing reply treated a significance test as the rollout decision; and the webhook reply assumed the retry intervals were sequential.
- **Revised prompt and skills:** the migration, uptime, search and pricing replies corrected those specific overclaims, and the extra explanation remained below half the control length. The same run still added "today" to an undated inventory count, inferred that the missing freshness check caused the stale dashboard, treated an ambiguous 650 ms database metric as time on slow requests, assumed human action and an exclusive alert after a webhook entered review, and placed the incident deploy at the API failure time. In the multi-turn incident it also called a recovered success rate "resolved." A further stricter prompt run used 2,229 words and made different unsupported claims, including broadening missed events into data loss again. These single runs do not establish a lower error rate.
- **Style only:** it treated the 650 ms database figure as 81% of the 800 ms endpoint p95, even though their populations were not established as comparable. It also calculated exact test statistics from rounded rates and added unsupported customer follow-up commitments. The unchanged summary skill still produced TL;DR sections and duplicated points.
- **Combined:** it still assumed sequential retry delays, treated statistical significance as sufficient for rollout, and said a CDN latency split would confirm a cause. Its 213-word saving over prompt-and-skills does not justify forcing a style across all sessions and overriding user style settings.

The custom style had `force-for-plugin: true` in Archie's core plugin. [Claude Code's output-style documentation](https://code.claude.com/docs/en/output-styles) says that this applies automatically whenever the plugin is enabled, overrides the user's `outputStyle`, and instructs every response in the session. It is broader than changing the PM prompt and the relevant skills. The local PR therefore excludes the style. The built-in `Concise` style was not a full-run arm: Archie's current SDK startup selects project settings and generates each agent's `.claude/settings.json` with attribution only. It does not select the built-in style, and a user-level setting is not a reliable configuration path for these sessions without changing startup behavior.

Raw captures are retained locally under `workdir/concise-pilot/quad-<arm>-<group>.json` for the first four arms, and `prompt-v2-<group>.json` for the revision. The fixtures start fresh Archie tasks; they do not replay tool calls, fixed tool results, model randomness, or original snapshot tasks. The snapshot archive has shared task events and memory but no agent tool-call transcripts for a faithful replay. This is one stochastic run per arm, not a reliable estimate of a production error rate. The evaluation used SDK 0.3.283; the repository pins 0.3.281, which was not rerun here.

An earlier **related prompt-only iteration** on SDK 0.3.257 produced 2,014 words versus 4,767 in its control, a 58% reduction. Its wording differed from this draft. An earlier combined run on SDK 0.3.283 produced 1,670 versus 5,833 words and made an unsupported causal claim. Both older clean-control runs made unsupported claims too.

The snapshot archive at `~/Projects/achie-snapshots/archie-eval-source-20260926-022439Z.tgz` supplies a real-task length baseline. Across 258 tasks since 2026-09-19, the median final post was 194 words, median total user-facing output was 640 words, and median posts per task was three. Of those tasks, 237 had multiple user-facing posts; 109 final posts exceeded 250 words. Interim posts accounted for 159,750 of 229,352 words (70%); first posts of at most 30 words totaled just 2,578 words. This suggests that cutting substantive repetition matters more than removing brief acknowledgements. The fixture arms all produced exactly one post per requested turn, so they do not measure this larger real-task source of volume. The archive was analyzed in aggregate; private task text was not published or replayed.

## Rollout gate

Keep the PR in draft. The paired fixture runs passed the length target but failed the factuality target. A read-only GitHub tool-backed probe could not complete because the isolated deployment's GitHub client was not configured; that limitation did not affect the self-contained fixtures. Test representative tool-backed tasks in an integrated environment before rollout, especially whether the thread-conduct edit reduces substantive interim posts. Review requested facts, unsupported claims, total words, and post count. The target remains at least 25% fewer words with no missing requested facts and no unsupported factual claims. Prompt instructions alone do not enforce that last condition.
