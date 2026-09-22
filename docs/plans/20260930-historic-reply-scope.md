# Historic reply scope pilot

**TL;DR:** The selected compression reduces the PM prompt and two skills from 7,390 to 3,887 whitespace-token words (47.4%). In a fresh 44-execution comparison against the current PR prompt, each version delivered 21 of 22 replies. Manual review retained all requested facts and found no unsupported factual claims in the 21 posted candidate replies. The shared long-report delivery failure remains; this is a draft, not a rollout-ready result.

## Historic evidence

The merged local archives contain 4,776 tasks and 16,314 human-message turns with PM replies. Keyword screening found 301 brevity cues and 95 possible style-feedback cues. These are screening candidates, not validated complaint counts.

Selected direct corrections illustrate four patterns:

- A big-picture technical decision became an implementation inventory: 993 words before the correction, 99 after it.
- A message to send became a research readout: 458 words, then 147 after the requester specified executive information and the action.
- A short bug recap became investigation history: 427 words across two posts, then 84 after a request for natural wording. The long reply occurred after the September 28 rollout.
- A correction could still expand the next reply: one technical follow-up grew from 504 to 1,119 words; a subsequent narrow verdict used 57.

These cases identify failure shapes. They span different prompt versions and task states, so they do not establish prevalence or causation. The existing instruction to “never drop a fact” was not limited to requested facts. Worker reports also supplied suggested copy and leads, which could pull the reply toward their structure.

## Scope revision (V7)

`prompts/pm-agent.md` selects content from the current request and preserves requested facts and decision-changing caveats. Its writing rules:

- Group brief technical scope into work categories, explicit reuse and open items. Omit implementation inventories and unrequested alternatives.
- Keep a brief recap to findings, current state and the requested next step.
- Keep every requested metric and slice in one table, with a checked takeaway. Verify grouped comparisons; add calculated measures when requested and checked.
- Preserve pending decisions and the source's certainty, operational verbs and implementation relationships. A flag is not evidence of a blocked action; reuse does not establish unchanged readiness.
- Deliver through posting tools and complete after messages and files have been posted.
- Preserve every requested row and complete file body when the request calls for them.

V7 changed only the PM prompt. V11 also compresses two skills. There is no word cap or output style; application code and SDK dependencies are unchanged. The branch is based on `2b8f547e04d8cd6b873cf5c13dba68d5e417f46c`; this pilot has not been deployed.

## Replay method

Eleven frozen fixtures cover technical scope, an executive rollout draft, a bug recap, a narrow fix-status reply, chart delivery, market/platform analysis, a long worker report, complete rows, verbatim files, incomparable measurements and a customer draft. One includes redacted historic worker text; the others reconstruct failure shapes with fixed source facts. Their requests, sources and supplied history did not change between revisions.

The harness uses Claude Code through Agent SDK 0.3.281, `opus`, medium effort. Every execution reported the actual model `claude-opus-5-5`. Fresh sessions use project settings with no selected output style. A source tool returns the same fixed evidence, while posting, attachment and completion tools capture the result locally. The harness checks the 12,000-character limit, valid fixture paths and completion idempotency. Its 22 local capture/grader assertions passed without external calls.

This reconstructs the answer stage after investigation and domain loading. Original workflows, skills and complete tool traces are not replayed. Source returns are fixed; the model chooses its tool calls and its output remains stochastic. The chart fixture tests attachment selection and delivery order, not actual chart pixels or Slack upload.

An early checkpoint sentence said no external tool was needed. It was clarified to say no additional investigation or repository mutation was needed, identically in both arms. Earlier undelivered outputs remain failures; the wording change is not a proven explanation for them. Results from the two checkpoint versions remain separate.

The clarified-checkpoint control ran twice on all 11 cases, alternating arm order in its paired run. Later candidates reuse those 22 control captures. The final comparison therefore has 22 fresh candidate executions and 22 frozen control captures, rather than a fresh interleaved run. Checks confirm identical request, history, source return, checkpoint, SDK and actual model across each matched pair. Prompt differences are recorded by hash.

## Iterations

| Revision | New executions | Delivered-pair words, control → candidate | Review outcome |
| --- | ---: | ---: | --- |
| V1 | 44 | 2,691 → 2,699, 20 pairs | Failed: scope remained broad, an observational qualifier was lost and a customer action was added. Three replies were undelivered. |
| V2 | 44 | 3,140 → 2,477, 22 pairs | Failed: unsupported effort/reuse claims, an incorrect revenue ranking, an unasked alternative, an omitted pricing decision and one missing completion call. |
| V3 | 7 diagnostic executions | Subset only | Failed: an undelivered long-report smoke reply; after checkpoint clarification, one reply still added an unasked alternative. |
| V4 | 44 | 3,200 → 2,451, 22 pairs | Failed: an invented cost-allocation decision and an incorrect added DAU percentage. |
| V5 | 22 | 3,200 → 2,486, frozen controls | Failed: a wrong qualitative market ranking and an unverified reuse-readiness claim. |
| V6 | 22 | 3,200 → 2,462, frozen controls | Further revision: an invalid-score observation became an account-rejection claim. |
| V7 | 22 | 3,200 → 2,418, frozen controls | Passed the requested-fact, source-support and delivery review on these cases. |

The baseline also produced unjustified claims in earlier repetitions: it shifted day-zero affordability to day one, strengthened checked hypotheses into ruled-out explanations, and broadened explicitly verified reuse. The model can err in either arm. Those observations do not establish relative error rates.

All prompts, manifests, captures and reviews remain in the private local replay archive. Failed outputs were not discarded or counted as brevity successes.

## V7 case comparison

Counts split posted Markdown on whitespace, including formatting tokens. They are a consistent volume proxy, not a linguistic word count.

| Case | Control words, runs 1 / 2 | Selected PM words, runs 1 / 2 |
| --- | ---: | ---: |
| Technical scope | 225 / 229 | 115 / 136 |
| Executive rollout draft | 130 / 106 | 121 / 123 |
| Short bug recap | 193 / 208 | 147 / 129 |
| Narrow fix-status reply | 88 / 58 | 69 / 76 |
| Chart delivery | 47 / 54 | 66 / 65 |
| Brief sliced analysis | 339 / 327 | 200 / 191 |
| Complete list | 136 / 133 | 135 / 132 |
| Complete file text | 63 / 63 | 63 / 63 |
| Incomparable measurements | 146 / 153 | 127 / 140 |
| Customer draft | 10 / 10 | 15 / 10 |
| Long worker report | 242 / 240 | 168 / 127 |

Each arm has 11 cases and 22 captured replies, with one post per reply. Total and final-post volume are equal; substantive interim volume is zero. This experiment does not measure investigation-stage posting or total production task volume. Short cases may be longer, and complete files remain unchanged.

Manual review checked every requested fact, field association, qualification and commitment against the source, including grouped metric arithmetic and narrative rankings. Exact checks retained both file bodies and their labels. Both chart replies used the declared attachment before completion. Screens for missing words, rows and files were reviewed manually: a valid paraphrase or a denial of causation can trigger a lexical alert.

Some price repetition and correct derived totals remain. The main reproduced inventories, unrequested alternatives and sample histories were removed while requested content survived.

## Limits and follow-up

The same fixtures guided revisions; the preservation cases are not unseen holdouts. Two stochastic repetitions do not prove general reliability. Correctness here means support from the supplied fixture evidence, not independent verification of every historic repository claim. Full skill interactions and real task mix remain untested.

Review the local prompt and this report before rollout. After deployment, record the new rollout boundary in the existing Tuesday snapshot examination and measure full user-facing task volume, interim posts and factual quality. No additional scheduled task is needed.

Control prompt SHA-256: `fd6417120862fe520888f350da4a46671ed2c263020c5e50917fd34985442b59`.

V7 prompt SHA-256: `a119095b7cd296202e9a1d7125bde354bd7578cf7cf37dcdc11c025ebae9493c`.

Control run: `509a9fda-cfba-40bb-a224-a39669070e49`. V7 run: `e96d24f4-9064-4b44-896c-97f4b4b6cb25`.

## Prompt compression (V11)

The compression removes the duplicate reasoning example, repeated writing bullets and explanatory padding. Each distinct operational requirement was reviewed in 26 groups across the three files. The original private compliance checks and six V7 scope/source-support paragraphs remain verbatim after smaller candidates failed. This selection does not prove those paragraphs are necessary or that this is a global minimum.

| Instruction file | Current PR words | Selected words | Reduction |
| --- | ---: | ---: | ---: |
| PM prompt | 5,979 | 3,370 | 43.6% |
| Thread conduct | 1,220 | 440 | 63.9% |
| Structured summary | 191 | 77 | 59.7% |
| **Total** | **7,390** | **3,887** | **47.4%** |

These are source-file whitespace counts, not runtime tokens or cost savings. Skill load frequency determines their runtime contribution. Names and trigger coverage were retained; quoted frontmatter descriptions parse completely. Skill instructions and operational workflows were reviewed statically; neither skill is loaded by the answer-stage replay.

### Rejected trims

| Revision | PM words | New executions | Outcome |
| --- | ---: | ---: | --- |
| V8 | 1,859 | 22 | Draft framing, an overbroad affordability claim, expanded reuse/alternatives, a customer instruction and one unposted reply. |
| V9 | 1,904 | 22 | Unchanged-readiness and cost-allocation claims; one unposted, incomplete metric reply. |
| V10 | 2,428 | 22 | A customer instruction and two unposted, incomplete replies. |
| V11 | 3,370 | 44 | Selected: posted replies passed the source/fact review; one reply remained unposted in each arm. |

V8–V10 reused the earlier deployed-control captures. V11 compares fresh current-PR V7 controls with fresh compressed candidates, twice on every fixture, alternating arm order. The requests, sources, history, checkpoint, harness, SDK and actual model remain fixed. The two delivery failures occur on the long-worker fixture: control repetition 1 and candidate repetition 2. Neither is counted as a brevity success. Both made a completion call, which did not deliver an answer.

### Fresh current-PR comparison

| Case | Current PR words, runs 1 / 2 | Compressed words, runs 1 / 2 |
| --- | ---: | ---: |
| Technical scope | 131 / 127 | 137 / 127 |
| Executive rollout draft | 122 / 120 | 113 / 121 |
| Short bug recap | 150 / 136 | 136 / 149 |
| Narrow fix-status reply | 67 / 57 | 63 / 63 |
| Chart delivery | 66 / 56 | 66 / 69 |
| Brief sliced analysis | 195 / 194 | 204 / 196 |
| Complete list | 135 / 132 | 135 / 135 |
| Complete file text | 63 / 63 | 63 / 63 |
| Incomparable measurements | 145 / 137 | 147 / 171 |
| Customer draft | 10 / 10 | 10 / 10 |
| Long worker report | unposted / 127 | 107 / unposted |

Each arm made 22 attempts, 21 posts and 22 completion calls. Total/final-post words were 2,243 for the current PR and 2,285 for the compression; substantive interim volume was zero. On the 20 matched pairs delivered by both arms, volume was 2,116 → 2,178 words (+2.9%). This supports a smaller instruction footprint with roughly similar reply volume in this sample, not a further output-length reduction or a relative reliability estimate.

Manual review checked every posted candidate reply for facts, associations, pending decisions, certainty, commitments and unrequested additions. All requested rows and file bodies survived; chart attachments preceded completion. Some headings, price repetition and correct derived totals remain. Lexical alerts included valid paraphrases and denials of causation; they were not treated as failures automatically.

Keep the PR in draft. Reproduce and address the shared delivery failure in the integrated workflow before rollout, then test actual skill interactions and examine real task output at the next rollout boundary. There is no production change and no additional scheduled task.

V11 prompt SHA-256: `3614f967fdeee60ac9b549d3d44542c3ea869b1b5ea07727c56a4f95528dd2bc`.

Fresh paired run: `ba39f07c-9701-475e-94d4-b56820b27f09`. Failed trim runs: `af06b4d1-208d-49bf-86f7-704b4cc3a445`, `d868e96b-d241-4b03-a49c-45bca78584e3`, `c9393aba-99aa-4c15-8444-493456691e7e`.
