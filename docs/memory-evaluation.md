# Memory evaluation

`npm run memory:eval -- <command>` runs the offline memory evaluation in `tools/memory-eval/`. It never connects to Slack, repositories, or business systems. All original histories, pseudonym mappings, checkpoints, model outputs, and reports belong under `/Users/igorsova/Projects/achie-snapshots/memory-eval/`, outside this repository. Set `ARCHIE_EVAL_HOME` for a different private location.

## Commands

| Command | Effect |
| --- | --- |
| `inventory` | Checks the extracted source archive and counts tasks, logs, and completion events. |
| `import` or `draft` | Verifies the archive hash and writes `corpus.json` plus review sheets. Requires cleaned LongMemEval S and oracle JSON under `public-source/`. |
| `labels` | Uses Sonnet 5 within the $100 initial ledger to draft atomic claims and focused questions for the 32 Archie cases. Regenerates review and 20-case calibration sheets. |
| `validate` | Checks case references, chronology, family splits, audience, and evidence spans. |
| `build` | Preflights exact model IDs and builds missing checkpoints for routine cases. Add `--case ID` for one case. |
| `run` | Builds missing checkpoints, then runs 12 fixed development cases in no-memory, candidate, and oracle arms. Add `--case ID` for a diagnostic run. |
| `report` | Displays a saved run report; pass its run ID or omit it for the latest run. |

The routine selector fixes six distinct Archie development families, four synthetic development families, and two public development cases. Within each Archie family it selects the earliest fully claimable case with the fewest completed prefixes. The public pair contains one factual case and one abstention, chosen by shortest full history. This keeps repeated runs bounded while the wider corpus stays available for explicit case runs.

The importer consumes the September 26, 2026 archive whose SHA-256 is `eb5b2e4d66e2954979bebf41db89878bfc8a5c4b5390dfc12dcdc23ec4f24907`. It reads the originals and writes only to the private workspace. The LongMemEval source is the [cleaned release](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned); its oracle file supplies evidence-session IDs only, while full histories come from the cleaned S file. The adaptation is not an official leaderboard result.

The 80 initial cases comprise 32 Archie drafts from eight workload families, 24 synthetic cases from six timeline families, and 24 cleaned LongMemEval cases across six question types, including four abstentions. Family IDs determine development/holdout assignment, keeping variants together. Archie cases are **candidate prompts only**: their required and forbidden claims need review of the cited original messages. The review and calibration sheets are worksheets, not completed human reviews. Public answers and synthetic labels remain advisory until the 20-case calibration review is completed. Missing attachments and external state must be quarantined during review.

The source archive is a live read of current task files. Recorded memory destinations are not proof of historical authorization. The Archie draft importer leaves profile authors blank; an evaluator must establish message-level author provenance at each cutoff before testing profile recall. Original messages are parsed as multiline records. Completion events determine the transcript prefix for each replay, including later resumptions of a task. Current memory snapshots are never used as gold or as initial checkpoint contents.

## Runtime and costs

`run` creates one isolated process and workdir per history checkpoint and per probe. A checkpoint key includes its visible history, cutoff, production extraction/sanitization/persistence/housekeeping/retrieval source hashes, evaluator replay code, model, and pricing assumptions. Each successful completion is snapshotted under a private `.partial` directory; an interrupted build resumes from the last complete snapshot. The final checkpoint is immutable to probes. The candidate arm copies a checkpoint; the no-memory arm has an empty workdir and no memory tools; the oracle arm receives only cited evidence permitted by case scope and query time. All probe outputs are excluded from ingestion.

Replay calls the production extractor, sanitizer, writers, and housekeeping through `replayTaskCompletion`. It uses a recorded scope supplied by the offline fixture and a guarded completion clock that also dates entity observations and housekeeping. The production completion listener still uses live Slack authorization. Candidate probing calls the production memory context builder and the same host-side search/read functions as the MCP tools. The answer probe has three memory tool turns and three total memory calls at most, followed by one final answer turn without tools. It has no tools for live actions. Its results measure bounded recall usefulness, not full task completion.

The pinned models are `claude-sonnet-5` for extraction and `claude-opus-5-5` for reading. The CLI retrieves both model IDs before paid work. It loads `ANTHROPIC_API_KEY` from the environment or the main worktree `.env` by default; override the latter with `ARCHIE_EVAL_ENV_FILE`. The private initial ledger caps extraction at $100 and each routine run ledger caps answer calls at $10. Every call reserves an estimated upper cost before dispatch; extraction also uses the agent SDK's per-call `maxBudgetUsd`. Errors retain the reservation as a conservative charge. Pricing was checked against [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on September 26, 2026: Sonnet 5 $2/$10 and Opus 5.5 $4/$20 per million input/output tokens. Recheck pricing before a later run.

The report denominator includes missing arms and failures. Exact required/forbidden string checks are diagnostic; mentions of an obsolete value can create false forbidden hits. Independently invoked Opus 5.5 judge calls grade individual claims against source evidence without seeing the arm; the verdicts remain advisory for unreviewed cases. Abstention cases count a supported refusal to provide the missing answer separately from unsupported details in its explanation. Source task ID surfacing is recorded separately from answer correctness. Human-calibration disagreement must be reported before semantic labels become gates. A memory uplift is not an acceptance condition; regressions and abstention failures are valid findings.

## Fixture format

`corpus.json` has `histories`, `cases`, and `provenance`. Each history contains ordered `events` with timestamp, role, task ID, and a source span; `completions` identify the task and cutoff of each extraction. A case names one history family, query time, requester, audience, current context, question, required and forbidden claims, supporting spans, split, and review state. The validator rejects references to later evidence and prevents approved Archie gold from citing assistant assertions alone.

The checked-in synthetic generator is the only fixture content in this repository. Real and public corpus instances are generated outside it. GroupMemBench expansion is deferred until supporting messages are annotated.
