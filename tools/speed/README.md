# speed

A latency suite for Archie: where the wall-clock goes between a person asking something and Archie answering, and whether a change actually moved it.

It is deliberately independent of every other harness here. `metrics.ts` is pure functions over records Archie already writes, so a measurement can be taken from a live campaign, from a session captured weeks ago, or from a fixture — with no live instance and no re-run.

## The model it measures against

Time-to-first-word is, to a good approximation, `round_trips × cost_per_round_trip`. Those are two independent multipliers and a change usually moves only one, so the suite reports both and treats the round-trip count as the leading indicator: it moves before the felt latency does.

A hand-off to another agent adds a third term, measured separately as `agent spawn->output`, because its cause is different — a fresh CLI subprocess, its own MCP servers, and a cold system-prompt cache write — and so is its fix.

## Baseline, and what it bought

Measured on a live instance from this branch, CLI channel, 303 runs across two campaigns.

| metric | baseline |
|---|---|
| time to first word (p50) | 14.1s |
| round trip (p50) | 2.8s |
| silent setup round trips | 2.0 |
| serving tier | `standard` |

### Where the wait goes

| phase | mean | share |
|---|---|---|
| think / ttft | 11.2s | 67% |
| streaming | 2.6s | 16% |
| dispatch | 2.5s | 15% |
| tool execution | 0.6s | 3% |

**83% of the wait is the model emitting tokens; 3% is doing anything.** Every result follows from that line: changes that cut thinking won, and changes that removed a round trip did not, because round trips were never the expensive part.

The `dispatch` figure is engine overhead before the model starts, and it is **not** spawn cost — on a second turn, with the agent already running, it is still 2.30s against 2.59s cold. Roughly 2.3s is paid on every turn and nothing yet measured touches it.

### Results

| tweak | mechanism | latency | verdict |
|---|---|---|---|
| PM effort high→medium | — | −1.7s to −2.2s, p≤0.01, 5/5 cases | **shipped** (replicated twice) |
| lean reasoning section | — | −0.8s to −1.7s | **shipped, as a pair** — alone it did not replicate; combined it is worth more than effort alone |
| both together | — | **−3.2s (20%), p=0.0001** | **shipped** |
| `alwaysLoad` on hot MCP tools | ToolSearch 1.00 → 0.12/sample | −1.6s, p=0.10 | dropped — fired cleanly, bought nothing |
| inject knowledge.log | log fetches 1.20 → 0.00/sample | −1.0s, p=0.25 | dropped — round-trip cost *rose* 2.8s → 4.3s; fewer, dearer inferences |
| strip malformed `pages` arg | 0 occurrences on CLI | n/a | **unresolved** — see below |

### Two findings about the harness itself

**A null arm calibrates the noise.** The `pages` tweak turned out to have no target on the CLI channel, making it an accidental placebo. At n=20 it read −1.5s and "beat baseline" in 4/5 cases; at n=25 it converged to −0.1s, p=0.559. Anything not clearly better than that is not distinguishable from doing nothing.

**Channel matters more than build.** Splitting historical sessions by channel: Slack tasks make 47 `Read` calls (27 carrying the malformed `pages` argument) against CLI's 9 (zero malformed), and load skills ~3× as often. Everything above was measured on CLI, the cheaper channel. The thinking-cost findings are channel-independent in mechanism; the round-trip ones are not, and the `pages` tweak is unresolved rather than dead — it simply has no target on the channel that was tested.

## Metrics, and what each is for

- **time to first word** — prompt → first user-facing message. The number a person experiences. Everything else exists to explain it.
- **time to completion** — prompt → `task:completed`. In a task that completes and reopens, each completion is charged to the exchange it belongs to, not to the last one.
- **silent setup trips** — round trips that produced nothing the user could see, before the one that finally spoke. The round trip that *does* speak is excluded: it is the work the wait was for, and counting it as waste would hide real movement.
- **round trip** — tool result in → next tool call out. Covers thinking, generation, network and local dispatch; it is a wall-clock span between two transcript rows, not a server-side timer. Gaps over 300s are excluded (the agent was parked, not thinking) and the count of exclusions is always printed.
- **delegation hops** and **agent spawn→output** — how many hand-offs, and what each costs before the delegate produces anything.
- **output tokens / cache creation tokens** — the PM's cost is dominated by output (mostly thinking), and cache-creation is the cold-start tax per task.
- **serving tier** — `standard` or `fast`, straight from `usage.jsonl`. See the warning below.

## Three rules built into the tool

1. **The mean never decides anything.** Latency is heavy-tailed; one 80s outlier moves a mean enough to invent an effect and moves a rank by one place. Comparisons run on Mann–Whitney U with tie correction.
2. **A comparison across serving tiers or models is refused, not rendered.** It would measure the tier, not the change. `compare` exits non-zero so it cannot pass in CI as a clean result.
3. **Nothing is dropped silently.** Excluded round trips, underpowered arms, unreadable transcripts, torn JSONL lines, timed-out runs and unpriced (gateway-routed) cost records all appear in the output. Gateway models are priced by the SDK at Opus rates whatever actually served them, so their cost is excluded and *counted* rather than reported as `$0.00`.

## Usage

Offline, against sessions already on disk — no instance needed:

```bash
npx tsx tools/speed/measure.ts collect --label baseline --out /tmp/baseline.json
```

Live, one case one sample one process:

```bash
npx tsx tools/speed/run.ts --case self-roster --arm before
```

A campaign, then fold and compare:

```bash
tools/speed/campaign.sh 8 before
```

```bash
npx tsx tools/speed/measure.ts compare tools/speed/results/samples-before.json tools/speed/results/samples-after.json
```

`run.ts` resolves the instance URL the same way the `archie-debug` MCP does (`ARCHIE_URL`, then `PORT`, then `.env`'s `PORT`, then `localhost:3000`) and reads the task folder from `ARCHIE_SESSIONS_DIR` / `$ARCHIE_WORKDIR/sessions`. Against a remote instance the folder is unreadable and the run degrades to event-only metrics, which it says in its output.

## Sampling discipline

Every sample is a separate process. At temperature 0, repetitions inside one process are correlated samples — in a controlled comparison elsewhere in this repo, two invocations of the same prompt produced opposite behaviour while the reps *inside* each invocation were byte-identical. A loop of N reps is much closer to one draw counted N times than to N independent draws.

`campaign.sh` also rotates the case order each round, so no case is permanently first and permanently paying the cold cache.

**Interleave arms whenever you can.** Multi-arm mode round-robins every arm through every round, calling a switch script between them, so drift over a multi-hour window hits all arms equally. `switch-arm.example.sh` is the template — copy it to `switch-arm.sh` (gitignored) and fill in the case block. Two rules it encodes, both learned the hard way: reset every knob before setting one, and confirm from the instance's own output that the arm actually took. An arm whose setting never reached the process records as "that tweak did nothing".

If an arm needs a redeploy and you have no switch script, run each as its own single-arm campaign and prefer **ABBA over AB** — run A, B, B, A, and check A reproduces itself before trusting A-vs-B.

## Cases

`cases.ts` holds the core set. Every case is graded by what it *should* cost, not by what it costs today: `maxDelegations: 0` on a question answerable from the PM's own system prompt is an assertion that currently fails, on purpose.

Grading is mechanical — substring detectors, never an LLM judge, which would add its own latency and variance to a latency measurement. Every detector that fires is printed with the text that tripped it. A run that never replied fails on that ground alone, so a timeout can never be recorded as a fast clean run; a case marked `expectSilence` inverts that, because the strongest rule in the PM prompt is satisfied only by producing no output.

**Audit a detector against raw replies before believing it.** On their first outing three of four adversarial detectors were wrong, and every failure they reported was exemplary behaviour: banning the injection payload failed the reply that *explained* the injection (it necessarily quotes the payload), and banning the word "exactly" failed a model refusal containing "holds exactly one task". Prefer matching the thing compliance cannot fake — `mustMatchAny` for behaviours with many correct phrasings, `mustNotBeOnly` for cases whose failure mode is bare compliance.

Two mechanisms exist to fix a rubric after the fact. `measure.ts matrix --regrade` re-reads events off disk and re-runs the grader, which is the only way to tell a real regression from a bad detector once runs are collected. And every run stores a `stimulus` hash of its prompt, so re-grading can refuse the case the guard exists for: re-grading is valid when the **rubric** changed and invalid when the **stimulus** changed. A run whose prompt hash cannot be verified is excluded rather than scored — "no fingerprint" must not mean "assume fine".

The core cases name no repo, plugin, integration or person, so the same suite runs against any deployment (a test enforces this). Deployment-specific cases go in `cases.local.json` beside `cases.ts` — same shape, validated on load, merged over the core set by id. That file is gitignored.

## Adding a metric

Add the field to the interface in `metrics.ts`, compute it in a pure function there with a unit test on a literal fixture, roll it up in `report.ts`, and add a row to `ROWS`. Keep filesystem access in `sources.ts`; it is the only file that should need changing when Archie's on-disk layout moves.

## What it does not do

No cost modelling beyond what the SDK reports. No correctness judgement past the substring detectors. No opinion about *why* a round trip was slow — it measures the span and leaves attribution to whoever reads it.
