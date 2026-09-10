# Migrating archie-plugins to the flat model

How to repeat the plugins-repo half of the flat-PM rework for real. This is a record of a first pass done end-to-end in one session against `sweatco/archie-plugins`, written so the next attempt can go faster and skip the wrong turns. It assumes the target model from the flat-PM discussion notes: one PM session per task, skills and agents loaded natively by the SDK, `plugin:skill` and `plugin:agent` namespacing, and root files owned by the engine.

## What the rewrite actually is

Three separable jobs, and they should be done in this order because each one changes the input to the next.

The first is **structural**: move files so every skill sits in the domain plugin it belongs to, merge the shell/craft duplicates, delete the agent files that no longer earn their place, and add the small number of new skills that absorb their bodies. This is mechanical, fast, and the part a script should do.

The second is **prose**: rewrite every sentence that assumes the old multi-agent runtime. This is the bulk of the work by wall-clock time and it is not scriptable end to end, because the same token means different things in different sentences.

The third is **the frame**: the root config files, the marketplace manifest, `CLAUDE.md`, the authoring skill, and the README. These describe the model, so they can only be written once the first two have settled what the model looks like in practice.

Build the mapping tables before touching anything. They are cheap to write, they surface the pairs nobody remembered, and they are what makes a verification pass possible afterwards.

## Mapping table 1 — agents

Five agents survive. Each keeps its file because of one of the three stated reasons; if you cannot name the reason, it is a skill.

| Agent | Fate | Reason, or where the body went |
|---|---|---|
| `data-analytics/agents/data-analyst.md` | keep | discipline — a fixed output envelope that makes an analysis re-runnable months later |
| `marketing/agents/tov-reviewer.md` | keep | blindness — must not see the craft skill that produced the copy |
| `qa/agents/qa-reviewer.md` | keep | blindness — same |
| `engineering/agents/release-manager.md` | keep | a permanent write deny list that keeps release state inside Tramline |
| `engineering/agents/coder.md` | **new** | effort — a per-spawn Agent call takes a model but not `effort`; this one is opus at `xhigh` and preloads `engineering:pr-workflow` |
| `engineering/agents/backend.md` | delete | → `engineering/skills/backend-repo` |
| `engineering/agents/mobile.md` | delete | → `engineering/skills/mobile-repo`; its `disallowedTools` → root `.mcp.json` `archie.deny` |
| `engineering/agents/infrastructure.md` | delete | → `engineering/skills/infrastructure-repo` |
| `archie/agents/archie.md` | delete | → `archie/skills/improving-archie` |
| `growth/agents/growth-ops.md` | delete | → `growth/skills/growth-liveops` |
| `ops/agents/ops.md` | delete | → new `ops/skills/ops-operating-rules` |
| `marketing/agents/copywriter.md` | delete | → new `marketing/skills/copywriting` |
| `qa/agents/qa-analyst.md` | delete | → new `qa/skills/qa-analysis` |
| `pm/agents/pm.md` | delete | body was a single empty heading; its `mcpServers` frontmatter becomes root-owned |

The three repo agents were the surprise: their bodies are almost nothing. Backend is one paragraph. What they actually carried was frontmatter — the repo binding, the model, the effort, the deny list — and all four of those things move somewhere else in the new model. The skills they become (`backend-repo`, `mobile-repo`, `infrastructure-repo`) exist to hold the repo identity, the default base branch, the observability read-only rules, and the must-load skill list, and they are short.

Frontmatter contract for what remains: `name`, `description`, `model`, `effort`, `disallowedTools`, `skills`, `memory`. Drop `role`, `expertise`, `mcpServers`, `allowedNetworkDomains`, and the whole `metadata.archie` block. The `description` has to absorb what `role` and `expertise` carried, because it is now the only thing the PM reads before choosing an agent — write it as "what this does, when to spawn it, what to put in the brief."

## Mapping table 2 — merged shell/craft pairs

Ten pairs, not nine. The tenth (`marketplace-performance-deep-dive`) is a genuine same-name collision inside one plugin and has to merge whether or not anyone listed it.

| PM shell (deleted) | Merged into |
|---|---|
| `pm/skills/app-stability-report` | `data-analytics/skills/app-stability-report` |
| `pm/skills/club-top-walkers` | `data-analytics/skills/club-top-walkers` |
| `pm/skills/growth-report-daily-summary` | `data-analytics/skills/growth-report-daily-summary` |
| `pm/skills/marketplace-performance-deep-dive` | `data-analytics/skills/marketplace-performance-deep-dive` |
| `pm/skills/comms-ticket-results` | `growth/skills/comms-ticket-results` |
| `pm/skills/offer-copy-update` | `ops/skills/offer-copy-update` |
| `pm/skills/offer-image-qa` | `ops/skills/offer-image-qa` |
| `pm/skills/offer-image-swap` | `ops/skills/offer-image-swap` |
| `pm/skills/branded-challenge` | `marketing/skills/branded-challenge` |
| `pm/skills/ci-failure-diagnosis` | `engineering/skills/ci-build-failure-diagnosis` |

Merge shape, applied identically to all ten: frontmatter with the craft skill's `name` and one `description` covering both sets of triggers; the craft skill's H1; a `## Intake, routing and delivery` section holding the shell body whole; a `## The work itself` section holding the craft body. Demote every heading inside both halves by one level so the two halves stay visually distinct. Do the assembly with a script — it is a hundred lines and it keeps the two bodies intact, which hand-merging does not.

The descriptions are the one part of the merge worth writing by hand. A concatenation of both old descriptions is too long and repeats itself; what you want is one paragraph that names both the casual trigger ("how's app stability looking?") and the formal one, then says what the skill carries.

## Mapping table 3 — the remaining PM skills

| `pm/skills/<name>` | Destination |
|---|---|
| `engineering-team`, `release-status`, `mobile-alert-triage` | `engineering/skills/` |
| `growth-liveops`, `growth-challenge-tracking`, `growth-add-challenge-comms-monitoring` | `growth/skills/` |
| `ops-campaign-create`, `ops-campaign-edit`, `ops-campaign-scheduling`, `ops-offer-rebuild` | `ops/skills/` |
| `qa-team` | `qa/skills/` |
| `data-analytics` | `data-analytics/skills/` |
| `self-improvement` | `archie/skills/` |
| `streak-restore`, `creatives-report-entry`, `sweatcoin-idea-proposal`, `health-check`, `product-anomaly-watch` | stay in `pm/skills/` — no domain home |

Three of these (`growth-challenge-tracking`, `growth-add-challenge-comms-monitoring`, `ops-campaign-scheduling`) were not on anyone's list. They are shells whose craft sibling has a *different* name, so they don't collide and they can simply be folded with the name kept. Folding rather than merging is also what the spec chose for the `ops-campaign-*` shells whose craft siblings are `campaign-creation` / `campaign-edit`, so keep that consistent: **merge only same-named pairs; fold everything else.**

Keep the `ops-` and `growth-` name prefixes on folded skills, but be honest that they are now only a naming convention. They used to earn their keep by driving the PR-triage labeler, which keyed off `pm/skills/<prefix>-*`; once every prefixed skill lives under `ops/**` or `growth/**` those globs match nothing and come out of `.github/labeler.yml` and `.github/CODEOWNERS`, so the prefix does no routing work at all. What is left is that the names are what people say out loud, which is reason enough not to churn them.

Use `git mv` for every fold so history follows. A fold is one command; a merge is a script plus a `git rm` of the shell.

## New skills created from agent bodies

| Skill | Source |
|---|---|
| `engineering/skills/pr-workflow` | `archie-hq/prompts/repo-agent.md` whole, plus the honesty and research-content sections of `agent-core.md`, plus the branch-naming convention read out of `src/connectors/github/branch-naming.ts` |
| `engineering/skills/backend-repo` | backend agent body |
| `engineering/skills/mobile-repo` | mobile agent body |
| `engineering/skills/infrastructure-repo` | infrastructure agent body |
| `ops/skills/ops-operating-rules` | ops agent body — tone, board and sheet IDs, the write-gating table, the never-publish rule |
| `marketing/skills/copywriting` | copywriter agent body — load tone-of-voice, then the craft skill, draft, self-check, blind review loop |
| `qa/skills/qa-analysis` | qa-analyst agent body — context gathering, the branch on ticket state, the lean-test-set principles, the one review round |

`pr-workflow` is the biggest single piece of new writing and the one worth doing carefully. Take `repo-agent.md` whole: the tool lists, the read-only/edit-mode split, the making-changes and conflicts and rebasing sequences, the what-NOT-to-do list, the PR tool reference, the creating-a-PR and handling-reviews steps. The only framing that changes is "you are the repo agent with repositories mounted at spawn" becoming "you are working inside a clone that was mounted into this task, at the path in your brief." Three details need sourcing from outside the prompt: the branch name is `archie/<taskId>` with `-2`, `-3` suffixes for extra branches (the webhook that maps a PR event back to a task reads that pattern, so it is load-bearing); the base branch comes from the repo rather than from frontmatter; and edit mode is what makes the clone writable and the push and PR tools present.

Two paragraphs of `repo-agent.md` do not survive: the "read `metadata.json` from the shared folder" instruction for finding the Slack channel (state the rule — link the thread, or write `Requested by <name>` for a DM — without the file path), and "the knowledge log surfaces `[comment_id=N]`" (say the comment carries an id).

## Mechanical prose substitutions

The counts before the rewrite, which are a fair estimate of the size of this job: `ops-agent` 110, `data-analyst-agent` 20, `copywriter-agent` 18, `release-manager-agent` 13, `qa-analyst-agent` 13, `mobile-agent` 13, `growth-ops-agent` 10, `archie-agent` 10, `tov-reviewer-agent` 8, `backend-agent` 8, `qa-reviewer-agent` 7, `pm-agent` 4, `infrastructure-agent` 1; plus `task owner` 24, `headless` 16, `send_message_to_agent` 15, `report_completion` 10, `knowledge.log` 8, `log_finding` 3.

| Old | New |
|---|---|
| a surviving agent's name, e.g. `data-analyst-agent` | `` `data-analytics:data-analyst` `` — safe to do with a global regex |
| `pm-agent` | "the PM", or "you" inside a PM-run skill |
| a deleted agent's name | the skill that absorbed it, or "a worker" — **never scriptable**, see below |
| "delegate to X as task owner" | "spawn `plugin:agent` with …", or "load `skill` and run it" |
| "hand a step to a worker" (new) | "hand it to a worker (sonnet) with the skill name and the inputs; take back its report" |
| `send_message_to_agent(...)` | delete — the Agent tool result is the reply |
| `log_finding`, `share_artifact`, `knowledge.log` | delete — the PM's context is the shared context |
| `report_completion(message)` | "post it in the thread" |
| "then STOP and wait" | "read the worker's result", or delete |
| "you are headless / you have no Slack" in a PM-run skill | delete |
| "you are headless" in a worker-run skill | "return the result to the caller" — keep the constraint, drop the word |
| "hand it to the PM, which posts it" in a PM-run skill | "post it" |
| specialist-to-specialist handoff | PM-mediated: spawn the second worker with the first one's output |
| "the requesting agent" | "the caller" |
| "ask the repo agent" | "mount the repo and put a worker on the clone with a specific question" |

The two-line rule that decides every ambiguous case: **in a skill the PM runs, the reader owns the conversation; in a skill a worker runs, the reader hands a result back.** Everything else follows.

## Traps

**The same token is not the same edit.** `ops-agent` appears as "delegate to ops-agent", "ops-agent's `campaign-creation` skill", "ops-agent will refuse to write without it", "do not let ops-agent run it", and "ops-agent has no Slack tools". Those are five different rewrites. A global regex on a deleted agent's name produces sentences that parse and mean the wrong thing, which is worse than leaving the name in. Substitute exact sentences, not tokens, and let the script report a miss loudly when a sentence has drifted.

**Deleting a deny list is a silent security change.** The mobile agent's `disallowedTools` was the only thing preventing a TeamCity `trigger_build`. Moving it to the root config's `archie.deny` preserves the behaviour, but note the exception: release-manager deliberately does *not* deny `firebase_update_environment`, because without it every Crashlytics read fails `PRECONDITION_FAILED`. A naive union of the two lists breaks release health reports. Diff the two lists deliberately rather than merging them.

**The "PM enforces the Slack conduct" pattern is load-bearing and appears in files you are not editing.** Three ops craft skills point at `pm/skills/ops-campaign-create/SKILL.md` for their thread conduct. When that file moves, the pointers break. Grep for `pm/skills/` after every fold.

**`.github/CODEOWNERS` and `.github/labeler.yml` contain paths.** A folded skill's CODEOWNERS line has to move with it or the PR opens unreviewed. The marketplace-watchdog block in CODEOWNERS names `pm/skills/marketplace-performance-deep-dive/` explicitly; that path stops existing.

**Frontmatter is not always parseable by a naive splitter.** Several descriptions are YAML block scalars (`description: >`) spanning ten lines, and one is a quoted string containing colons. Use a real split on the `---` delimiters and treat the body as opaque text unless you actually need a field.

**Skills whose names collide across plugins no longer collide.** `challenge-tracking` exists in both `growth` and `data-analytics` and always did; the SDK namespaces them, so the two can stay. Don't merge things just because they share a name across plugins — merge only same-named pairs *within* the plugin they are moving into.

**Historical files are not documentation.** `ops/skills/campaign-creation/CHANGELOG.md` and the dated notes in `ops/references/` describe the retired two-agent model in the past tense, correctly. Leave them. Rewriting history entries to match the new model destroys the record of why a rule exists.

## Known behaviour changes

Two things the old per-agent frontmatter carried have no equivalent in the flat model. Neither is a regression to fix during the migration; both are stated here so nobody rediscovers them as bugs.

**Per-agent max mode is gone.** `archie`, `backend`, `mobile` and `infrastructure` each declared `metadata.archie.maxMode` as `claude-fable-5-1` at `high` effort, so turning max mode on upgraded that agent and only that agent. With the agents deleted there is nowhere in a plugin to hang that pair. In the flat model max mode upgrades the PM session instead, and the model/effort pair it upgrades to comes from the engine's defaults rather than from any plugin file. The practical difference is that max mode is now one switch over the whole session, not four independent per-agent settings — a repo-heavy task gets the upgrade the same way a conversation does.

**The per-agent `statusLabel` is dropped.** Only one agent set it: growth-ops, with `statusLabel: growth ops`, which phrased the live "Archie is…" line in the user's thread as the domain rather than the agent key. There is no per-agent status to label any more, so the line is phrased from the PM session alone. Nothing else used the field, and the key is no longer part of the allowed agent frontmatter.

## What took longest

The prose pass, by a wide margin — roughly two-thirds of the session. Within it, the four ops routing skills (`ops-campaign-create`, `ops-campaign-edit`, `ops-offer-rebuild`, `ops-campaign-scheduling`) took the longest single stretch, because each is built around a literal delegation template — a fenced block addressed to another agent — and the template has to become a description of state carried through a procedure rather than a message sent to somebody. `qa-team` and `engineering-team` have the same shape.

The second-longest was deciding, per sentence, whether a deleted agent's name should become a skill name, "a worker", or nothing at all. That judgement cannot be delegated to a table.

Everything structural — 13 folds, 10 merges, 14 deletions, 9 new files — took well under an hour once the mapping tables existed.

## What to automate next time

- **The fold.** A list of `(from, to)` pairs driving `git mv`. Trivial and already effectively scripted.
- **The merge assembly.** Split both files on frontmatter, strip the craft H1, emit frontmatter + H1 + `## Intake, routing and delivery` + shell body + `## The work itself` + craft body, then demote headings inside both halves while skipping fenced code blocks. Leave a `MERGED_DESCRIPTION_PLACEHOLDER` in the frontmatter and fill the ten descriptions by hand in a second pass — the placeholder makes an unfilled one impossible to miss.
- **The safe renames.** Surviving agents only: `X-agent` → `` `plugin:X` ``, including the bold and backticked variants, plus collapsing the doubled backticks that produces.
- **A linter, which is the highest-value thing to build.** Run it in CI, not just during the migration. It should assert: agent frontmatter uses only the seven allowed keys and has `name` and `description`; skill frontmatter has a `description`; skill names are unique within a plugin; every `${CLAUDE_PLUGIN_ROOT}/…` path resolves; every plugin directory appears in `marketplace.json` and vice versa; every JSON file parses; and no `.md` outside `CLAUDE.md`, the authoring skill and CHANGELOGs contains `task owner`, `send_message_to_agent`, `log_finding`, `share_artifact`, `knowledge.log`, `report_completion`, or a `<name>-agent` token. That last check is the one that would have caught every leftover found by hand in this pass.
- **A cross-reference check** for paths in prose: any `pm/skills/…`, `<plugin>/agents/….md` or `.github` path mentioned in a Markdown file must exist.

## Verification worth doing at the end

Beyond the linter: read the five surviving agent bodies end to end, because they are the only files where a stale multi-agent sentence changes runtime behaviour rather than just reading oddly. Then read the two or three largest merged skills in full — not diffed — to check that a gate did not lose its subject when its surrounding paragraph was rewritten. The failure mode to look for is a confirmation gate whose "who confirms" has quietly become ambiguous.
