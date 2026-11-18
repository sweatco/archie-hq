# Behaviour evals for Archie — implementation handoff

**Status:** Approved by the maintainer on 2026-11-18; nothing is implemented. Stage 0 is specified deeply enough to start; later stages are outlines. One independent review checked the claims about the current system, and its corrections are applied.
**Sources:** repository at `29290acc`; a live instance run on 2026-11-18 (six tasks); five production task folders read and deleted the same day; the production memory snapshot of 2026-11-18; the [proposal](../proposals/behaviour-evals.md).
**First milestone:** [Behaviour evals: repeatable prompt regression baseline](https://github.com/sweatco/archie-hq/milestone/4).

## Decision

Build one **session record** and one set of **graders**, fed from two sources. Pulled production sessions are graded offline and describe how Archie really behaves. Synthetic cases are run on a base and a candidate instance and attribute a change to a prompt, skill or tool-description edit. Runs on pull requests reuse the paired run behind an approval gate.

The decisive reason: production runs with memory injected, real plugins and Slack, none of which an API-driven test instance can reproduce today. One source cannot both be faithful and be controlled, so the design uses two and scores them the same way.

```
production task folder ─┐
                        ├─► session record ─► graders ─► report
eval instance (base) ───┤                                  ▲
eval instance (PR) ─────┘        paired comparison ────────┘
```

> A maintainer can see, for a prompt or agent change, how replies and tool use differ from main on a fixed case set, and can read the same measures over real production sessions.

## Scope

- **Covers:** the PM agent's replies and tool use; offline grading of production sessions; on-demand paired runs; approved runs on pull requests.
- **Not prescribed yet:** pass thresholds, trial counts and spend caps. Each needs a measured baseline first (see Deferred).

| Non-goal | Reason |
| --- | --- |
| A merge-blocking check | The pilot's control arm failed the factuality check too; a gate needs a noise floor first |
| A simulated Slack surface | Largest piece of work; decided out of the first milestone |
| Measuring memory uplift | Owned by the [Memory evaluation milestone](https://github.com/sweatco/archie-hq/milestone/1) |
| Evaluating the plugins repository's content | Lives in another repository; the runner only accepts a plugins directory |
| Replacing the live E2E recipes | They verify lifecycle and gates, including real PRs |

## What exists and what is missing

| Needed capability | Existing mechanism | Reuse, extend, or new |
| --- | --- | --- |
| Create a task and get its id without Slack | `POST /api/tasks`, `src/connectors/api/routes.ts:166` | Reuse |
| Follow a task to a settled state | `events.jsonl` replay and wait states, `tools/debug-mcp/wait-for-task.ts:7` | Reuse the logic in a script |
| Replies per task | `message` events, `src/system/event-bus.ts:11` | Reuse |
| Cost per task | `usage.jsonl`, written at `src/agents/spawn.ts:1052`; reducer in `src/agents/task-usage.ts` | Reuse |
| Tool, skill and subagent use | Transcripts under `sessions/<id>/claude/<agent>/session/` (`src/agents/spawn.ts:276`), read by the SDK's `getSessionMessages`, `listSubagents`, `getSubagentMessages` | Reuse; nothing in the engine |
| Boot an instance from a branch | `tools/e2e/boot.ts`, `teardown.ts` | Extend with a hermetic profile |
| A self-driving live check | `tools/e2e/tool-gate-check.ts` | Follow the pattern |
| Pull production data | `scripts/pull-remote-data.sh` takes all sessions | Extend with per-task selection |
| Know what a session ran with | No manifest is persisted: `git_sha` on `/health` (`src/index.ts:157`), the model in `usage.jsonl`, the plugin list checked and logged at `src/agents/spawn.ts:953` | New |
| Approval-gated CI run | None; the repository has no GitHub Environments | New |

Invariants to keep:

- Event types are a closed set shared with the CLI (`src/system/event-bus.ts:11`); a new type must be added on both sides.
- `tools/debug-mcp/` and the three E2E recipes keep working unchanged.
- Production data and anything derived from its text never enter the repository or CI.
- No per-task configuration overrides are added to the engine; an arm is a separate instance.

Missing:

1. **A session record** — nothing turns a task folder into one comparable unit.
2. **Graders** — no code or rubric check of replies or tool use exists.
3. **A hermetic boot** — `tools/e2e/prepare-worktree.ts:29` copies the main checkout's `.env`, Slack tokens included, and links its workdir.
4. **A paired runner and a case set** — the [concise pilot](20260926-prompt-only-concise-pilot.md)'s fixtures were never committed.
5. **A session manifest** — results cannot be tied to a prompt, plugin set or memory state.
6. **An approval gate in CI** — and proof that sandboxed agent work runs on a hosted runner.

## Design

### Session record

One record per task, built only from files in its folder. It never needs a running instance, so the same builder serves production folders and eval trials.

```ts
interface SessionRecord {
  source: 'production' | 'eval';
  taskId: string;
  eval?: { caseId: string; ref: string; trial: number };
  turns: { inbound: string; replies: string[] }[];
  toolCalls: {
    agent: string;
    name: string;
    skill?: string;
    subagentType?: string;
    failed: boolean;
  }[];
  complete: boolean;
  usage: { costUsd: number; models: string[] };
  manifest: SessionManifest | 'unknown';
  grades: { grader: string; pass?: boolean; value?: number }[];
}
```

Rules:

- The builder reads every session recorded for the task. The SDK reader follows one message chain, while the PM session is forked after a refusal and replaced for max mode, so one read can miss calls.
- `complete` is false when the transcript's raw tool-call count differs from what the reader returned. A "not called" assertion never passes on an incomplete record.
- `failed` is true when the result carries the error flag or matches known failure text. Archie's own tools do not always set the flag (`list_available_repos` returned an unflagged error in the live run).
- A production record's text fields stay in a private location outside the repository. Reports carry counts and grades only.
- `manifest: 'unknown'` never counts as a match in a comparison.

Rejected: structured tool-call events in the engine. Events carry only lossy traces of tool use (status lines and background tasks), but the SDK reader already returns tool calls for live and production folders, so an engine change buys nothing for evals. Accepted limitation: the record depends on the SDK's reader API.

### Graders

Two kinds, applied identically to both sources.

- **Code graders:** reply count, word count, terminal state, cost, and trajectory assertions (called, not called, order, approval before mutation).
- **Judge:** a model applies a written rubric: requested facts present, unsupported claims, scope kept, result first. It runs under a spend cap and is trusted only as far as a human comparison supports. It may read pulled production sessions (decided 2026-11-18).

Rules:

- A grade is a measurement, not a verdict on the change. Only a paired comparison says whether a change moved it.
- Hard invariants (for example, no merge without approval) must hold in every trial; everything else is reported as a change against base.

Rejected: an absolute pass mark per case. The pilot's control arm failed factuality, so it would block every change.

### Paired run

The same cases run on a base instance and a candidate instance, several trials each, and the report gives the per-case change. A main-versus-main run comes first and sets the noise floor that later tolerances are read against.

Rule: a comparison is valid only when the two manifests differ in the intended way and no other.

Rejected: a full matrix of memory, plugins and model. Cost multiplies and failures cannot be attributed. Other arms are added one factor at a time, later.

### Eval profile

A hermetic instance: a fresh workdir built from in-repo fixtures (example plugins plus a stub MCP server), the model key and a port, and nothing else. The live run on 2026-11-18 used exactly this by hand and ran six concurrent tasks for $0.75.

Rules:

- Slack and GitHub credentials are never loaded, even when the main checkout has them.
- The main checkout's workdir is never linked or written.

Accepted limitation: without Slack the memory layer does not initialise (`src/memory/index.ts:53`), Slack tools fail, and triggers cannot be proposed. The profile measures engine conduct, not the production configuration.

### Session manifest

What a session ran with: model, CLI version, tools, skills, plugins with versions, MCP servers, a hash of the system prompt, and whether memory was injected. It carries no prompt text.

A new engine event, emitted where the SDK `init` message is already handled, is the contract. For sessions that predate it, the request shape the CLI writes to the raw transcript is a best-effort source, checked against the CLI version and reported as `unknown` when absent.

Rejected: transcript-only derivation. It needs no engine change and works on old sessions, but the format is CLI-internal and the project has been caught by CLI changes before.

### Approved PR run

A `pull_request` workflow with a path filter queues an eval job bound to a protected GitHub Environment with the maintainer as required reviewer. The eval key is an environment secret with its own name, separate from the repository-wide key and spend-limited. A manual dispatch with a PR number covers changes outside the filter.

Rules:

- The eval key cannot be read before approval. A job without the environment fails closed because the secret name does not exist elsewhere.
- The gate controls spend on the eval key. It is not a security boundary against collaborators: a same-repository PR can change the workflow, and the repository-wide key is readable without an environment, as it is today.
- Same-repository PRs only. Fork and Dependabot PRs receive no secrets; the dispatch path looks up the head repository before checkout and refuses forks.
- The environment exists, and admits pull-request merge refs, before the workflow merges.
- Never a required check. Superseded waiting runs on a PR are cancelled. Results go to the job summary.
- Only synthetic cases run in CI.

Rejected: a label trigger (anyone with triage rights can start a paid run) and a comment trigger (runs with default-branch privileges while checking out PR code).

## Stages

### Stage 0 — Real sessions can be graded without running anything

Deliverables:

1. A record builder for a task folder, with unit tests on a trimmed synthetic folder from the 2026-11-18 live run.
2. Code graders and the judge with its rubric and spend cap.
3. A per-task pull from a container host, by id or day, without repos, attachments or artifacts.
4. A private data location outside the repository, following the Memory evaluation's convention.
5. A first report over a pulled production sample, and a human comparison of judge verdicts on part of it.

Depends on: access to production session folders, which exists. Does not yet allow: attributing a change, or anything in CI.

**Exit condition:** the report exists, the judge's agreement with the human review is recorded, and no production text is inside the repository.

### Stage 1 — A hermetic instance boots from any ref

Deliverables: an eval profile for boot and teardown; fixture plugins with a stub MCP server.

Depends on: nothing. Does not yet allow: comparisons.

**Exit condition:** two refs run side by side on separate ports and workdirs; no Slack or GitHub credentials are loaded; the main checkout is unchanged.

### Stage 2 — A change can be compared against main on demand

Deliverables: a documented case format and a scripted runner (multi-turn, concurrent, spend-capped); about 25 synthetic cases from the merged behaviour PRs, the API-reachable core skills and the pilot; a main-versus-main run; a saved baseline on main.

Depends on: Stages 0 and 1.

**Exit condition:** a paired report exists for a real prompt change, read against the recorded noise floor.

### Stage 3 — Results are attributable

Deliverables: the manifest event in the engine and CLI; the transcript fallback; the runner's manifest check.

Depends on: Stage 2 for the runner's check; the event itself has no prerequisite.

**Exit condition:** a paired run flags a pair whose manifests differ beyond the intended change.

### Stage 4 — The maintainer approves an eval from the pull request

Deliverables: proof that an eval instance boots and runs sandboxed agent work on a GitHub-hosted runner; the workflow, environment and dedicated key; the job-summary report.

Depends on: Stage 1 for the proof; Stages 2 and 3 for the workflow.

**Exit condition:** a prompt PR shows a waiting eval job; approval produces a paired report; an unapproved run never reads the eval key, and a fork PR is skipped.

### Later — not designed here

Simulated Slack, which unlocks thread conduct, multi-user cases and the memory arm; a full-plugin arm run from the plugins repository; repo-backed cases; scheduled runs on main for model and CLI drift. Each needs Stage 2.

## Milestones and issues

**[Behaviour evals: repeatable prompt regression baseline](https://github.com/sweatco/archie-hq/milestone/4)** — Stages 0 to 3.

- [#393](https://github.com/sweatco/archie-hq/issues/393) Build session records and graders, run offline on real sessions (Stage 0)
- [#394](https://github.com/sweatco/archie-hq/issues/394) Add a hermetic eval boot profile (Stage 1)
- [#395](https://github.com/sweatco/archie-hq/issues/395) Add a scripted eval runner with paired refs and a case format (Stage 2)
- [#396](https://github.com/sweatco/archie-hq/issues/396) Seed the baseline eval cases and record the noise floor (Stage 2)
- [#397](https://github.com/sweatco/archie-hq/issues/397) Record a session manifest for attribution (Stage 3)

**[Behaviour evals: approved runs on pull requests](https://github.com/sweatco/archie-hq/milestone/5)** — Stage 4.

- [#398](https://github.com/sweatco/archie-hq/issues/398) Prove an eval instance runs a sandboxed task on a hosted runner
- [#399](https://github.com/sweatco/archie-hq/issues/399) Add the approval-gated eval workflow for pull requests

The later arms have no milestone or issue until accepted. No issue has an owner or a date.

## Validation and rollout

- The record is correct → the builder reproduces the known tool sequences of the six live tasks.
- The judge can be trusted → agreement with a human review on a production sample, disagreements recorded.
- The runner measures change, not noise → the main-versus-main run.
- The gate holds → an unapproved run never reads the eval key; a fork PR is skipped.
- Baselines to measure before any threshold is set: cost per case, run-to-run variance, judge agreement.
- Rollback: Stages 0 to 2 and 4 are tools and one workflow, removed by deleting them. Stage 3 adds one event type; reverting it must also revert the CLI side.

## First slice

Stage 0 alone, on a small pulled sample.

> Given a pulled production task folder, when the record command runs, then it reports the replies, the tool sequence including delegated workers, and the cost, and the trajectory grader correctly names a skill that was invoked, while no production text is written inside the repository.

## Deferred

| Left open | Needed by | Settled by |
| --- | --- | --- |
| Spend caps for the judge and for paired runs | Stages 0, 2 | Cost measured in the first report and first baseline |
| Trials per case and tolerance | Stage 2 | The main-versus-main run |
| Sample size and retention of pulled sessions | Stage 0 | First pull; default is delete after the report |
| Case file format | Stage 2 | Implementer's choice |
| Concurrency above six | Stage 2 | A measured run on one instance |
| PR path filter | Stage 4 | Files changed in past behaviour PRs |
| Reuse of base results in CI | Stage 4 | Measured run time |

## Open questions

1. Does sandboxed agent work run on a GitHub-hosted runner? Bubblewrap needs unprivileged user namespaces inside the container, which Ubuntu 24.04 restricts. Affects Stage 4; resolved by #398; blocking for Stage 4 only.
2. Does a waiting eval job stop Archie's own armed merge on that PR? Affects Stage 4; resolved in #399; not blocking.
3. Who reviews the judge calibration sample? Affects the Stage 0 exit; maintainer's ruling; not blocking to start.
4. Who creates the dedicated, spend-limited model key and the environment? Affects Stage 4; maintainer action.

## Risks

- The judge is unreliable → code graders first; the judge is used only as far as human agreement supports.
- The baseline arm does not resemble production → offline grading covers it descriptively; later arms close the gap.
- Realistic cases cost dollars each → caps, and a small synthetic set to begin.
- A CLI update drops the request-shape lines → the manifest event is the contract; the fallback degrades to `unknown`.
- Private data leaks → offline only, outside the repository, aggregates only, pulled copies deleted.
- A PR run exposes the key → an environment-scoped, spend-limited key; same-repository PRs; the approver reads the diff, workflow changes included.

## Evidence

- **Run:** six concurrent API tasks on a live instance; the SDK reader on those six and on five production folders (CLI 2.1.321); timing analysis of 2,259 production memory records.
- **Read in code:** the anchors cited inline, at `29290acc`, re-opened by the independent reviewer.
- **Documented only:** GitHub's rules that environment secrets wait for approval and that fork and Dependabot PRs receive no secrets.
- **Not verified or absent:** sandboxed work on a hosted runner; whether a waiting job affects armed merges; transcript completeness after compaction; concurrency above six; judge reliability; cost of realistic cases; a local source of task-level production archives.

## Status and next action

Researched and partly exercised; approved as a plan; tracked by the two milestones above. Next action: start #393 and #394, which have no prerequisites.
