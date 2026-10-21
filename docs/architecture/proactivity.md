# Proactive observation

Proactive observation ships with `ARCHIE_PROACTIVITY_MODE=off`. Shadow mode collects and analyses public activity without sending proactive messages. Live delivery requires an exact, human-reviewed policy evaluation and explicit owner approval. Production usefulness remains a rollout requirement; synthetic tests cannot establish it.

## Integration

Public Slack activity enters a bounded background intake queue before ordinary task-routing filters. Collection does not create tasks. Mentions, edits and engaged-thread replies continue through existing routing independently of background network calls. Explicit `initiative …` commands in the configured owner's verified DM are consumed as controls.

The observation backend lives under `src/memory/`: `observation-store.ts` owns transactional evidence and runtime state, `observations.ts` installs its recall interface, and `tools.ts` combines observation results into the existing `search_memory` tool. When enabled, `read_observation`, `list_open_matters` and `read_matter` are attached to the same memory MCP server. Existing Markdown profiles, entities and completed-task extraction remain on their existing writers.

Public tasks can retrieve observations from their own source channel. Only the configured owner's verified DM can retrieve open matters or combine observations across sources that owner can currently access. Private task summaries and profiles do not enter background analysis. Retrieval rechecks source access; already loaded PM context retains the existing session limitations described in [memory](memory.md).

`src/proactivity/` contains the runtime, Slack adapter, job processing and direct Anthropic request gateway. Background analysis receives structured public evidence and no PM session, shell, repository writer or unrestricted MCP tools. A human request in a proactive thread creates or resumes an ordinary task, with an inline evidence brief and optional `initiative_origin` metadata.

## Configuration and storage

Node 24 or later is required when enabled. `ARCHIE_PROACTIVITY_MODE=off|shadow|live` defaults off. `ARCHIE_PROACTIVITY_OWNER` is an internal human Slack ID. Extraction defaults to `claude-haiku-5-5`; investigation defaults to `claude-sonnet-5-5`. The gateway accepts only explicitly priced model routes and verifies account availability during initialization. Knowledge-memory flags do not enable or disable observation storage.

The existing memory API owns an additional SQLite backend for observations. The Markdown backend stores durable profiles, entities and task summaries; SQLite stores changing source revisions and evidence links. Transactions let one source edit invalidate observations, matters and unsent deliveries together. Proactivity keeps its jobs, billing reservations and outbox in that same database so their state changes can also be atomic. This extends Archie's memory without fitting every observation into an entity or adding another MCP server.

State lives at `WORKDIR/initiative/state.sqlite`, bound to the Slack team and initiative owner. SQLite uses WAL, full durability, FTS5 and versioned migrations. Its location protects observation and operational state from the Markdown knowledge-store reset lifecycle. It remains inaccessible through the PM filesystem sandbox. Back up the database with a SQLite-aware backup or after a clean stop; copying a live database without its WAL is insufficient. Restore only into the same workspace and owner configuration.

First successful activation establishes the observation watermark. Restarts preserve it. There is no historical import. A new reply may retrieve its older parent as bounded context. Source revisions, tombstones, processing generations and coverage gaps distinguish new evidence from duplicates. Every refresh also revalidates a previously fetched older parent; it does not import the older thread history. Coverage gaps must remain visible until collection proves them repaired. Archie-authored messages preserve provenance and cannot independently establish a new observation. An edit or deletion of an Archie message already used as context invalidates dependent state.

Human source changes invalidate derived observations, attention state and pending notifications. Host-controlled generation checks reject stale model results. The scheduler holds a persisted ownership lease, while individual jobs have fenced leases and generations. Rescheduling preserves a running investigation and keeps newer work after its completion.

## Operation

The scheduler drains up to 32 due jobs per minute within a 45-second drain window; a running analysis has its own five-minute bound. Routine extraction is hourly. New or substantively reopened matters get their first investigation in that extraction cycle; existing next checks and human snoozes remain authoritative. Known deadlines can schedule earlier checks. Thread refresh jobs are event-driven and continue only while pagination is incomplete. Active matters get fresh thread checks before investigation or delivery. Matters retain supporting evidence, inferred versus explicit ownership/deadlines, resolution, snooze and dismissal state. There is no two-week expiry or automatic service pause. Day 14 is a reporting checkpoint, not an operating limit.

Notifications are limited to a weekday 09:00 digest of at most five items plus two additional interventions per day, Monday–Friday, 09:00–18:00 Europe/Lisbon. Delivery is bound to the verified owner DM or the original public discussion. Pending deliveries recheck evidence, controls, policy and active PM work. The outbox reserves notification slots atomically. A timed-out or interrupted send remains uncertain and is reconciled by its outbound Slack metadata; it is never blindly sent again.

Owner controls currently include `initiative status`, `mute`/`unmute`, `pause`/`resume`, `stop`/`start`, and `handled`, `later`, `not useful` or `stop following` followed by a matter ID. Single-matter messages also offer owner-only Slack buttons bound to the delivery record. Other users cannot operate these controls. `later` wakes at the next weekday 09:00. Mute blocks new delivery; pause aborts new analysis; stop cancels queued analysis and pending delivery while preserving intake, accounting and reconciliation responsibilities.

The daily ceiling is $200 on Europe/Lisbon calendar days. Routine work uses at most $150; priority checks can use the remaining $50. Every paid request reserves a conservative maximum before dispatch. SDK retries are disabled and explicit model retries must receive new admission. Complete billable usage settles a reservation conservatively; missing usage leaves liability outstanding. Unsettled liability consumes capacity across possible execution days. Settled debits do not reopen already-consumed allowance, and prior-day refunds do not accumulate. Exhaustion defers paid work until capacity returns automatically. A known pricing overrun is accounted in full and prevents further unverified paid admission.

At most four model requests can be outstanding, with batches using at most three slots so direct checks retain capacity. Hourly extraction groups only threads from the same source channel and carries consolidated state across bounded context parts. Reflection and replay use asynchronous batches with persisted semantic steps.

Model rates were checked against [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-20. Haiku's higher input tier and conservative cache-write pricing bound reservations. Provider usage priced conservatively is not presented as an exact invoice total.

## Reviewed learning and development handoff

Daily reflection proposes small changes to ranking, context selection and reminder wording. It uses forward-collected episodes and explicit feedback, including acknowledgements from the separate development loop. Reflection records every supplied training source, including related context and inherited provenance. Training channels are excluded from evaluation; complete human topic sets for every training and evaluation thread provide a second holdout boundary. A stop changes the responsibility epoch so late results cannot create policies, proposals or completed replay cases under a new responsibility.

Episodes are captured before extraction, including threads that produce no matters. An evaluation case preserves the production source group, recorded clock, bounded related-source read surface, prior attention and delivery history, manual controls, active PM state and already consumed notification slots. Its source bodies are referenced by exact revisions rather than copied into a second raw-message archive.

Before candidate predictions, an operator freezes the first chronological non-overlapping source groups and their human urgency, actionability and topic labels. The immutable manifest binds every case, source input, candidate/base policy, owner/model configuration, responsibility epoch, rubric and decision implementation. At least 100 distinct held-out threads are required, including 20 urgent and 20 non-actionable. Every frozen case must complete; missing results, failed steps, coverage gaps and deleted or expired source material cannot disappear from the denominator.

Replay runs the production extraction, reconciliation, context selection, first-check investigation and delivery checks on isolated SQLite state, with recorded source reads and simulated Slack sends. A zero-matter result is a completed no-action case and can count as an urgent miss. Missing semantic model steps are submitted through the real budget gateway; replay restarts from the original source and clock after their batch results arrive. It never advances time to make a deferred job due. This tests the decision on recorded evidence at that clock; it does not claim to simulate later unobserved discussion.

The baseline uses base-policy extraction and a deterministic title/detail brief instead of model-generated help. Both strategies share the ordinary digest; evaluation compares additional messages under the same chronological two-per-day interruption allowance. Human labels assess every candidate and baseline draft separately, and identify the actionable threads each message covers. Usefulness counts admitted messages; urgency misses count uncovered urgent threads. A candidate must improve usefulness, add no urgent misses, and have zero reported scope, authority, stop or budget violations.

After building, use the local operator commands:

```bash
node dist/cli/initiative.js <database> <team-id> export <policy-id> before.json
node dist/cli/initiative.js <database> <team-id> cohort <policy-id> ground-truth.json
# The running subsystem advances batch replay during its minute ticks.
node dist/cli/initiative.js <database> <team-id> export <policy-id> after.json
node dist/cli/initiative.js <database> <team-id> evaluate <policy-id> message-labels.json report.json
node dist/cli/initiative.js <database> <team-id> proposals proposals.json
node dist/cli/initiative.js <database> <team-id> ack <proposal-id> <issue-url> filed
```

The ground-truth file contains `training: [{episode, threads: [{channel, thread, topics: [...]}]}]` and `groups: [{episode, threads: [{channel, thread, topics: [...], urgent, actionable}]}]`. Supply all topics for every training thread, including related context. Use the exported chronological group order without skipping cases. Inherited training labels remain fixed.

After every replay case finishes, the message-label file contains the exported `cohort` ID and `messages: [{episode, strategy, draft, useful, covers, violation}]`. `strategy` is `candidate` or `baseline`; `draft` is the exported content hash; `covers` lists covered actionable thread keys as `channel:thread`. Label every exported message exactly once. The simulator adds urgent misses caused by no output or withheld notification slots. Do not substitute model-generated or synthetic labels for the human rollout review.

The owner previews a candidate with `initiative policy <policy-id>` in the verified DM and activates it with `initiative approve <policy-id> <evaluation-id>`. Offline commands cannot activate policies. Approval rechecks current source access, input availability and exact versions. Code or owner/model configuration changes invalidate delivery approval on restart. Raw-input cleanup can invalidate an unfinished cohort; it cannot silently substitute excerpts and reuse an old prediction. Expired/deleted inputs also purge dependent replay content. Initial approval checks every fresh training input, including uncited sources. Inherited topic provenance may survive source cleanup only through the already owner-approved base proof; resupplying that episode to reflection makes it fresh input again. `initiative rollback <policy-id>` restores a previously approved version when its implementation/configuration still matches. Base guidance without a passing approval never grants live delivery.

Capability proposals remain `pending filing` until the separate development loop creates an issue under its own remote-write approvals and acknowledges it. Acknowledgements accept `filed`, `implementing`, `completed` or `rejected`, with an optional outcome. The issue must belong to the proposal's configured repository. This subsystem does not modify repository code or file issues itself.

## Verification and rollout limits

On 2026-10-20, the TypeScript build, compiled disabled-runtime smoke check and all 2,106 tests across 149 suites passed on Node 24.19.0. The full suite required loopback access for an existing API fixture. The independent review fixes were verified in focused reruns.

Final PR preparation on 2026-10-21 repeated the typecheck, build and all 2,106 tests successfully. CI now uses Node 24 so it can run the SQLite-backed subsystem tests.

Subsystem tests use temporary SQLite databases, fake Slack/provider services and controlled clocks. They exercise intake, source boundaries, retention, job recovery, context bounds, accounting, delivery reconciliation, controls, memory recall, reflection, snapshot replay and the human activation gate. These tests establish implementation contracts, not live usefulness or complete production Slack coverage.

The Node 24 Docker image now builds successfully on Docker 29.8.1. In the Linux image (Node 24.22.0), 2,105 tests passed and one root-sensitive permission test skipped; all 17 tests in that file then passed when rerun as the non-root `archie` user. These runs disabled external networking and used fake providers.

On 2026-10-21, the repository's live E2E harness booted an isolated Docker instance and attested checkout `7651e8753a38834539bc7e54d64936247a1370ec-dirty`. The live sandbox check passed with Claude CLI 2.1.281: non-allowlisted egress was blocked, allowlisted egress and npm installation worked, and Yarn proxy configuration was present. The tool approval check blocked its local marker write before approval, allowed the read-only tool without approval, and executed the approved write exactly once. These checks used paid Anthropic requests with initiative disabled and no Slack credentials.

An additional `basic-nonce` scenario correlated and completed its read-only CLI task, but failed its observable PM reply assertion. With the test's Haiku PM override, the model answered in plain SDK assistant text, then called `report_completion({})` without posting its answer. Its CLI channel was linked. Independent review traced this to the existing explicit-message delivery path; initiative was disabled and no feature regression was identified. Completion alone is not a passing reply check. The failed scenario and passing tool-gate evidence are preserved under the local ignored `e2e-evidence/` directory. Teardown confirmed no containers remained for the isolated project, and its temporary credential file was removed.

The repository's lint command lacks an installed/configured ESLint dependency. Passing TypeScript, Vitest and live SDK checks do not establish production Slack coverage or the usefulness of initiative decisions.

There has been no live initiative activation, Slack notification or real forward usefulness evaluation during implementation. Collect and label real forward evidence in shadow mode before requesting delivery approval. Day 14 remains a report only; manual controls and the daily spending ceiling continue to govern operation afterward.
