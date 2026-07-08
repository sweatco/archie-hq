## Context

Two merge paths exist today, both unconditional once GitHub state allows:

1. **Orchestrator** — webhooks (`pull_request_review` approved, `pull_request` opened/synchronize, `push`, `workflow_run` success) route to `handleMergeCheckDirect(taskId)` (5s per-task debounce, `webhooks.ts:260-285`) → `checkAndMergeLinkedPRs(taskId)` → `triggerMergeCheck(taskId)` (`merge.ts:39-203`). It collects linked PRs from `branch_states` across all attached repos (deduped by `github#prNumber`), categorizes each PR independently (there is no "all PRs approved" gate — per-PR is already the model), and merges every PR in the `mergeable` bucket: `state==='open' && approved && (mergeableState==='clean' || (mergeable && mergeableState==='blocked'))`.
2. **Tool** — `merge_pull_request` (`tools.ts:1458-1481`), repo-agent-scoped, edit-mode-gated via `disallowedTools`. Requires `state==='open'` and `mergeable && mergeableState==='clean'` (stricter than the orchestrator — no `blocked` tolerance), then merges immediately. No approval interaction.

The approval machinery to mirror is edit mode: `request_edit_mode` (`tools.ts:489-570`) posts interactive blocks via `task.postInteractiveToUser(text, blocks, approvalType, channel?)` (`task.ts:585`, union `'edit_mode' | 'research_budget'`), suppresses duplicates, freezes the status (`suspendStatus()`), and parks the task (`agent.deferTeardown(() => task.stop())`). Slack action handlers (`events.ts:217-290`) and the API route (`routes.ts:253`) converge on shared Task methods (`handleEditModeApproval/Denial`, `task.ts:1232-1262`) which persist state, append a decision finding, and reactivate the PM. The debug MCP surfaces the gate via `wait_for_task` (`APPROVAL_TYPE=`) and resolves it via `approve` (enum at `server.ts:184`, type at `wait-for-task.ts:14`).

Frontmatter flows: gray-matter parse in `scanPlugins()` (`plugin-loader.ts:240-319`; plural `metadata.archie.repos[]` preferred, singular `metadata.archie.repo` auto-migrated, both-present rejected) → `PluginRepoEntry {github, baseBranch}` via an **explicit field copy** (`plugin-loader.ts:293-296`) → `AgentDef.repo.repos: RepoEntry[]` via a second explicit copy (`registry.ts:81-86`). Unknown keys are dropped at both points. `findAgentDefsContainingRepo(github)` (`registry.ts:178`) returns every registered repo agent declaring a github anywhere in its `repos` list.

## Goals / Non-Goals

**Goals:**
- One per-repo boolean, `autoMerge`, default off, read from agent frontmatter only; enforced in the engine (orchestrator **and** tool), not prompts.
- Off: never merge automatically; notify the thread exactly once per ready state; merge only via explicit request → `merge` approval → user approves → merge if GitHub says mergeable.
- On: today's behavior byte-for-byte (approval webhook + mergeable → squash merge).
- No Archie-side review-approval floor on the explicit path — GitHub branch protection is the sole authority.
- Survive restarts: the pending merge request and the "already notified" marker are persisted task state.

**Non-Goals:**
- No approval counting, merge-method override, channel-scoped permissions, or "prohibited" knob (brief non-goals).
- No `autoMerge: true` for any real repo in archie-plugins — this change ships all-off.
- No change to webhook arrival or debounce mechanics.
- No generalization to per-tool approval gates (issue #168) — this is a single, narrow approval type; #168 can generalize later.

## Revision R2 — reposition the explicit merge as auto-merge *arming* (supersedes parts of Decisions 3, 6, 7)

**Why.** Live use exposed a defect. The explicit-request path merged (or reported "not ready") based on GitHub's mergeable state, reusing the shared `isMergeReadyPerGithub` helper whose `blocked`-but-`mergeable` tolerance is only safe when paired with an `approved` check. The auto orchestrator pairs it with `approved` (`merge.ts:174`); the explicit path deliberately dropped `approved` (AC5). Result: a PR blocked on required human review with CI incomplete (`mergeable:true` = no conflicts, `mergeableState:'blocked'`) was treated as *ready*, so the tool surfaced an Approve/Deny prompt for a PR GitHub would refuse to merge. `mergeable:true` means "no merge conflicts", not "checks/reviews pass".

**Reframe.** In a non-auto repo, approving `merge_pull_request` now means **"merge this PR as soon as it is ready"**, not "merge it now". The human approval is the gate (issue #139's point); the actual merge is delegated to the existing merge orchestrator, which already merges linked PRs when they reach the ready condition on any merge-triggering webhook (approval, `synchronize`, `push`, `workflow_run`). This deletes all mergeable-state interpretation from the explicit path — the exact simplification the reframe buys.

**Mechanic (reuses the orchestrator — no new merge engine):**
- **Request time** (`merge_pull_request`, non-auto branch): drop the `isMergeReadyPerGithub` gate. Prompt for **any open PR** (still bail on closed/merged). Approving a not-yet-green PR is now correct — that is the feature. Slot/pause/identity/atomic-gate machinery is unchanged.
- **Approval** (`Task.handleMergeApproval`): after the atomic identity gate, set a persisted per-PR `BranchState.merge_armed = true` for the approved PR, clear the slot + parked teardown, then trigger `checkAndMergeLinkedPRs(taskId)` once. If the PR is already clean it merges immediately (existing `notifyPMAboutMerge`); otherwise it stays armed and the task un-parks and winds down with the PM relaying "auto-merge armed — I'll merge it once checks pass". No mergeable-state check in the Task method itself.
- **Orchestrator** (`runMergeCheck`): add an **armed bucket** alongside the existing auto bucket. An armed PR merges when `state === 'open' && mergeableState === 'clean'` — GitHub's authoritative "all required reviews + checks satisfied, no conflicts" signal, with **no** Archie `approved` floor (AC5) and **no** `blocked` tolerance (a blocked PR has an unsatisfied required gate; branch protection is the authority, per the brief). The auto-repo bucket keeps `approved && isMergeReadyPerGithub` unchanged. The `merge_armed` marker is cleared when the PR is observed merged or closed.
- **Deny** unchanged: clears the slot, never arms.

**Consequences.** `isMergeReadyPerGithub` (with its `blocked` tolerance) is now used **only** by the auto orchestrator bucket, where `approved` guards it — its doc comment says so. The explicit path never interprets `mergeableState` beyond `=== 'clean'` in the orchestrator's armed bucket. Decision 3 ("tool aligns to the orchestrator's looser condition") is **reversed**: the tool no longer calls `isMergeReadyPerGithub` at all. Decision 6's non-auto branch arms instead of gating on readiness; its auto branch (AC6, direct merge) reverts to a `clean`-only check. Decision 7's resolution arms + triggers a check instead of merging inline.

**Independent defect fixed in the same revision — CLI approval 400.** The API route requires `github`+`pr_number` for `type:'merge'` (Decision 6/7 atomicity), and Slack encodes them in the button value, but the CLI approval path sent neither: `src/cli/api.ts` `sendApproval` posted only `{type, approve}`, and the `approval:requested` event (`task.ts:587`) carried only `{text, approvalType}`. A CLI Approve on a merge prompt 400'd (blank screen). Fix: the merge `approval:requested` event carries `github`+`pr_number`; the CLI captures them and `sendApproval` sends them; the CLI type unions widen to include `'merge'`. This is orthogonal to arming and needed regardless.

## Decisions

### 1. `autoMerge` lives on each repo entry, threaded through both explicit copy points

Frontmatter: `metadata.archie.repos[].autoMerge: true` (per-entry, since one agent can mount several repos with different policies); the legacy singular `metadata.archie.repo.autoMerge` is picked up by the same auto-migration that synthesizes the plural shape (`plugin-loader.ts:310-319`). Parsing is strict: only the boolean literal `true` enables it (`entry.autoMerge === true`); absent, `false`, or any non-boolean value → `false`. This matches the existing typeof-guard style for `baseBranch` and keeps a YAML typo (`autoMerge: "true"`, `autoMerge: yes`-gone-wrong) failing **safe** (off), never failing open.

Threading — the field must be added at both explicit copies or it silently vanishes (research §3):
- `PluginRepoEntry` gains `autoMerge?: boolean` (`plugin-loader.ts:92-96`), populated in the plural map (`plugin-loader.ts:293-296`) and the singular migration.
- `RepoEntry` (`src/types/agent.ts:84-89`) gains `autoMerge: boolean` (resolved, non-optional — default applied at the registry copy `registry.ts:81-86`: `autoMerge: r.autoMerge === true`).
- `synthesizeDynamicAgentDef` (`registry.ts:190`) hardcodes `autoMerge: false` — PM-spawned dynamic agents can never confer auto-merge.

*Alternative rejected:* per-agent flag (`metadata.archie.autoMerge`) — wrong granularity for multi-repo agents, and the brief pins the field next to `github`/`baseBranch`.

### 2. Policy lookup: `isAutoMergeRepo(github)` with ALL-declaring-agents-agree semantics

New export in `src/agents/registry.ts`, beside `findAgentDefsContainingRepo`:

```typescript
export function isAutoMergeRepo(github: string): boolean {
  const defs = findAgentDefsContainingRepo(github);
  if (defs.length === 0) return false;
  return defs.every((d) =>
    d.repo!.repos.filter((r) => r.github === github).every((r) => r.autoMerge === true));
}
```

When multiple agents declare the same repo with conflicting flags, **auto-merge only if ALL say true** (AND). Rationale: the whole change exists because default-off is the safe posture; a conflict means at least one declaration wants supervision, and supervision must win — the failure mode of AND is a missed convenience, the failure mode of OR/ANY is an unsupervised merge into a repo whose owner opted out. AND is also deterministic regardless of registry scan order and makes "add a new agent for the repo without the flag" fail safe rather than silently inheriting auto-merge. Mixed flags log a one-line `logger.warn` at lookup time so the misconfiguration is visible without blocking. Repos declared by **no** registered agent (dynamic-agent-only attachments, retired agents) resolve to `false` — never auto-merge a repo nobody statically owns.

Note the lookup consults the **live registry**, not task-time snapshots: policy is evaluated at merge time (webhook or tool call), so a frontmatter change takes effect on the next merge check after a registry rescan, with no per-task migration.

### 3. Shared mergeability helper; tool aligns to the orchestrator's condition (dossier open item 2)

New tiny module `src/connectors/github/mergeability.ts`:

```typescript
import type { PRStatus } from '../../agents/tools.js'; // type-only import — no runtime cycle
export function isMergeReadyPerGithub(status: PRStatus): boolean {
  return status.mergeableState === 'clean' ||
    (status.mergeable === true && status.mergeableState === 'blocked');
}
```

Both the orchestrator (`merge.ts:111-117`) and `merge_pull_request` (plus the new approval-resolution path) call it; callers add their own `state === 'open'` (and, on the auto path only, `approved`) checks. **Decision: align the tool on the orchestrator's looser condition.** The `blocked`-but-`mergeable` case is the known GitHub Rulesets quirk where the API says `blocked` while the UI shows a green merge button (`merge.ts:105-110`); a user who explicitly asked to merge and then approved the request would otherwise get "not ready (blocked)" for a PR they can merge by hand — the exact bug the orchestrator already works around. The merge API call still fails gracefully if the PR is truly blocked, and that failure is surfaced. One definition also prevents the two paths drifting again. The tool's existing tests asserting `blocked → not ready` flip to asserting the merge is attempted.

### 4. Orchestrator gating: policy split at categorization, "ready" bucket, notify once

In `triggerMergeCheck()`, after the existing categorization, the `mergeable` bucket splits by policy:

- `autoMergeable = mergeable.filter((pr) => isAutoMergeRepo(pr.github))` — merged exactly as today (AC2; squash stays the client default).
- `ready = mergeable` PRs failing the policy check — **never merged**. Recorded in a new `MergeCheckResult.ready: string[]` bucket (categorization logging gains a `READY (merge on request)` label).

Notification: `checkAndMergeLinkedPRs()` gains a `notifyPMAboutReadyPRs(taskId, readyPRs)` step modeled on `notifyPMAboutConflicts` (`merge.ts:234-250`): append a `decision` finding telling the PM the PR is approved and green and should be offered to the user as "ready — ask me to merge", then `task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent')`. The PM posts the single thread message (AC1's "the PM posts"); the engine guarantees once-ness (Decision 5). A held PR whose merge approval is currently pending (`task.metadata.pending_merge_approval` matching its `github` + `pr_number`, Decision 7) is skipped by the notification step — the user already holds an actionable approval prompt for that PR, and a simultaneous "ready — ask me to merge" nudge would be a confusing double prompt.

### 5. Notification dedup: persisted `BranchState` marker with clear-on-not-ready (dossier open item 1)

**Decision: a `BranchState.merge_ready_notified?: boolean` marker, set when the notification fires and cleared whenever a merge check observes that PR not-ready.** Semantics: exactly one notification per *continuous ready period* — a webhook burst (approval + synchronize + push + workflow_run for the same state, AC1) notifies once because the first check sets the marker; a later push that makes the PR un-ready clears it, so a PR that becomes ready *again* (new commits, re-approval) legitimately re-notifies.

Why marker over pure ready-state transition detection: transition detection needs the previous state from somewhere — in-memory state dies on restart and across debounce windows, so any correct transition detector ends up persisting a "was ready" bit anyway; that bit *is* the marker. `BranchState` is the established home for exactly this kind of per-PR bookkeeping (`pr_number`, `last_processed_comment_id`, `pr_card` — research §2). The 5s debounce alone was ruled out (does not cover separate bursts or restarts, research §9). The clear-on-not-ready rule is what upgrades the naive boolean ("notify at most once ever", which under-notifies after a force-push) into per-ready-state semantics without needing a head SHA (`PRStatus` carries none).

Mechanics: the orchestrator already has the `task`; it maps each held PR back to its `BranchState` entries by scanning `task.metadata.repositories` for matching `(github, pr_number)` — the same walk the PR collection does. A PR attached under several agents may match several branch states: "notified" is true if **any** carries the marker; on notify, set it on **all** matches; persist via the task's normal save path (`debouncedSave`).

### 6. New `merge` approval type, mirroring edit mode end-to-end

**Union**: `postInteractiveToUser`'s approvalType (`task.ts:585`) widens to `'edit_mode' | 'research_budget' | 'merge'`. The widening is additive for every consumer of `approval:requested` (SSE/JSONL/debug MCP print the string).

**Request side** (inside `merge_pull_request`, non-auto branch — pattern from `tools.ts:489-570`):
1. `resolveGithub` as today; bail if the repo isn't declared.
2. Duplicate suppression is gated on task-level quiescence, not the caller's own turn — and the suppression-vs-supersede fork applies **only when `pending_merge_approval` is set** (a parked teardown with an empty slot belongs to some other approval type — edit mode, research budget — and neither suppresses nor supersedes a first merge request; the flow proceeds to post its own prompt). With the slot set: if **any** agent process in the task has a pending teardown (`[...task.agentProcesses.values()].some((a) => a.pendingTeardown)` — the same task-quiescence predicate `idleDecision` uses, `src/tasks/recovery.ts:100`), a merge request is already parked in this activation — return an informational "merge approval already pending" result, no second prompt, no second pause. The predicate must be task-level because the slot is per-task while `pendingTeardown` is per-agent: in a multi-repo task a concurrently running second repo agent would otherwise misread a seconds-old request as stale, supersede it, and double-prompt the user. A `pending_merge_approval` slot found while **no** agent holds a pending teardown means the task was reactivated without the prompt being resolved — it does not block: it is superseded per Decision 7.
3. Fetch `getPRStatus`; require `state === 'open'` and `isMergeReadyPerGithub(status)` — **no `approved` check** (AC5: with zero GitHub review approvals but a mergeable report, the flow proceeds). If not ready, return today's "Cannot merge: … not ready" text — asking the user to approve a merge GitHub will refuse is noise.
4. Append a `decision` finding (`Merge approval requested for <github>#<pr>`), post interactive blocks with action ids `approve_merge` / `deny_merge` (value = `<taskId>|<github>#<pr_number>` — taskId to locate the task as edit mode does, plus the PR identity so a click can be verified against the current slot, Decision 7), approvalType `'merge'`.
5. Persist `task.metadata.pending_merge_approval = { github, pr_number, requested_by: agent.def.id, requested_at }`, then `task.suspendStatus()` and `agent.deferTeardown(() => task.stop())`; return "Merge approval requested. Task paused pending user approval."

**Auto branch** (AC6): `isAutoMergeRepo(github)` → keep today's direct-merge body, with the mergeability check swapped to the shared helper (Decision 3). No prompt, no pause. (Edit-mode gating is untouched — the tool remains in `disallowedTools` until edit mode is approved, `spawn.ts:482`.)

**Slack handlers** (`events.ts`, after the edit-mode pair): `app.action('approve_merge')` / `app.action('deny_merge')`, following the `approve_edit_mode`/`deny_edit_mode` shape (`events.ts:217-290`) with one deliberate ordering change: ack, parse the button value into the expected PR identity (`expected = {github, pr_number}`), `Task.get`, `getUserInfo`, then call the shared Task method with the identity — `task.handleMergeApproval(approver, expected)` / `task.handleMergeDenial(expected)`. The handler performs **no** slot verification of its own: a verify in the handler followed by the `updateMessage`/`getUserInfo` awaits would reopen the verify-vs-resolve race Decision 7 closes; the Task method's atomic read-compare-clear is the single verification point. The in-place message update happens *after* the Task method, driven by its returned disposition: resolved → `✅ Merge approved by @user` / `❌ Merge denied by @user`; stale mismatch → a stale-prompt notice. Approver resolution reuses `getUserInfo` + `isExternalUser` with the edit-mode bail-out: an external/guest approver still resolves the approval (they can see the button; the merge is gated by them intentionally clicking), but their identity is not recorded in the finding — mirroring edit mode, where external approvers approve but aren't recorded (`events.ts:249-250`). No git-authorship concern exists here (merging creates no task commits), so the approver name is decoration for the audit finding only.

**API route** (`routes.ts:253` area): new `else if (type === 'merge')` branch. The request body contract is extended for this type: `type: 'merge'` requests **must** carry the PR identity (`github`, `pr_number`) — missing identity → 400, mirroring the existing body validation style. The route passes it through as `expected`: `task.handleMergeApproval(cleanApprover, expected)` / `task.handleMergeDenial(expected)`; the existing `approval:resolved` emit covers the new type unchanged. Slack and API therefore converge on the same Task methods — AC8's "resolves identically" is structural *including the identity verification*, which lives in the Task method rather than in either adapter.

**Debug MCP**: `approve` tool enum → `['edit_mode', 'research_budget', 'merge']` (`server.ts:184`); the tool also gains optional `github`/`pr_number` parameters, required when `type: 'merge'`, forwarded verbatim in the API request body so the route's identity contract is satisfied (the e2e recipe already knows the PR it drove open). `ApprovalType` union in `wait-for-task.ts:14` gains `'merge'`. `wait_for_task` already prints whatever `approvalType` the event carries, so `APPROVAL_TYPE=merge` surfaces with only the type widened.

### 7. Pending-approval state: single persisted slot on `TaskMetadata`

```typescript
// src/types/task.ts, beside edit_allowed / edit_approved_by
pending_merge_approval?: {
  github: string;      // repo of the requested PR
  pr_number: number;   // which PR to merge on approval
  requested_by: string; // agent id — to clear its parked teardown on resolution
  requested_at: string; // ISO 8601, for the audit finding
};
```

Modeled on how `edit_allowed`/`edit_approved_by` persist (task metadata JSON, survives restart — research §7), but as a *request* record rather than a grant: merge approval is one-shot per PR, not a task-lifetime mode. The slot is written at request time and **cleared on every resolution** (approve — successful or not — and deny), so a resolved approval can never replay.

**Single slot, not a per-PR map.** The request pauses the task (`deferTeardown` → `task.stop()`), so the agent cannot issue a second merge request while one is pending; sequential PRs each get their own request/resolution cycle after reactivation. Resolution is identity-verified **inside the Task method, atomically with the clear**: `handleMergeApproval(approver, expected: {github, pr_number})` and `handleMergeDenial(expected)` take the expected PR identity — parsed from the button payload (`<taskId>|<github>#<pr_number>`: taskId locates the task, the remainder is `expected`) or carried in the API request body — and perform a **synchronous read-compare-clear** on the slot: no await between reading the slot, comparing it to `expected`, and clearing it. An empty slot (double-click, or a click after resolution) or a mismatch (`expected` ≠ slot: an old prompt whose buttons stayed live after an API-path resolution followed by a new request, or a supersede that rewrote the slot) → no-op with a stale log line, the slot left untouched, and a stale disposition returned so the calling adapter can update the prompt with a stale-prompt notice. Only on match does the method clear the slot and proceed (merge / deny). Adapters do **no** verification of their own: a handler-side verify followed by `updateMessage`/`getUserInfo` awaits would let a concurrent supersede (the task is active by definition when a stranded slot exists) rewrite the slot between verify and resolve and merge a PR the user never approved. The atomic compare-and-clear closes that window — a supersede landing mid-resolution turns the in-flight click into a stale no-op, never a merge of the superseding PR. No merge, no crash, in any stale case.

**Stuck-slot cancel path: suppress while parked, supersede after quiescence.** Duplicate suppression (Decision 6 step 2) applies while the request's pause is still parked anywhere in the task — any agent process holding a pending teardown, the task-level quiescence predicate `idleDecision` computes (`src/tasks/recovery.ts:100`) — not merely within the calling agent's own turn, so a concurrent second repo agent in a multi-repo task gets the informational "already pending" result instead of superseding a seconds-old request. If the task was reactivated with the slot still set and **no** agent holds a pending teardown — e.g. the user replied "hold off" in the thread instead of clicking Deny, so the prompt was never resolved — a later `merge_pull_request` call does not report "already pending" forever: it **supersedes** the stale slot, rewriting it for the requested PR (same PR or a different one) and posting a fresh prompt, then pausing again. The old prompt's buttons resolve harmlessly: for the same PR they match the new slot and resolve it; for a different PR the payload mismatch no-ops with the stale notice above. Deny (button or API) remains the explicit cancel route; supersede-on-later-turn guarantees a stranded slot can never permanently block merging.

**Resolution** (new Task methods, mirroring `handleEditModeApproval/Denial` at `task.ts:1232-1262`):
- `handleMergeApproval(approver, expected)`: **atomic gate first** — synchronously read the slot, compare to `expected` (`github` + `pr_number`), and clear it on match, with no await between the three steps; empty or mismatched slot → warn + return the stale disposition (slot untouched, no GitHub call). On match, with the slot now cleared: clear the requesting agent's parked teardown (`this.agentProcesses.get(pending.requested_by)?.clearPendingTeardown()` — same stream-closed-loop protection edit mode applies to the PM, but targeted at whichever repo agent parked); fetch `getPRStatus`; if `state === 'open' && isMergeReadyPerGithub(status)` → `client.mergePullRequest(github, pr_number)` → `completion` finding (`PR <github>#<n> merged on user approval[ by <name>]`) — else → `decision` finding recording exactly why not (state / mergeableState / merge-API failure message); either way `debouncedSave()` and reactivate the PM via `sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent')` so the user is told the outcome (AC4 both halves). **No `approved` check anywhere in this path** (AC5).
- `handleMergeDenial(expected)`: the same atomic read-compare-clear gate (empty or mismatched slot → warn + stale disposition, nothing cleared); on match clear the slot and the parked teardown, append `Merge denied by user — PR not merged` finding, reactivate the PM. No GitHub call of any kind (AC3 deny → no merge).

*Why the engine merges on approval (rather than re-waking the agent to re-call the tool):* resolution must be deterministic and testable — a mocked `GitHubClient` and a direct `handleMergeApproval` call prove AC4/AC5 without an LLM in the loop; it matches the orchestrator's precedent (system merges, PM narrates); and it avoids a second tool round-trip that would re-enter the policy gate.

### 8. Sequencing vs open PRs #169 and #176 (dossier open item 3)

PR #169 (max-mode approval) touches every approval surface this change extends (`tools.ts`, `task.ts`, `events.ts`, `routes.ts`, `plugin-loader.ts`, `registry.ts`, `types/task.ts`); #176 touches `tools.ts`. Minimizing the conflict surface, not avoiding it:

- Every shared-file change here is **additive**: a new union member (one line at `task.ts:585` — the only line both changes must touch), new metadata fields appended after existing ones, new handler registrations after the research-budget pair, a new `else if` branch in the route, new functions/new files elsewhere (`mergeability.ts`, new Task methods, new tool branch). No reformatting or restructuring of shared regions, so overlaps resolve as trivial both-sides-keep hunks.
- The debug MCP files are touched only by this change (#169 doesn't extend them — research §8).
- Expectation recorded for the implementer: **whichever change lands second rebases**; the rebase should be mechanical given the additive shape. If #169 lands first and has extracted a named `ApprovalType`, adopt it instead of re-widening inline.

### 9. Docs

- `docs/architecture/github-integration.md`: the Merge Orchestrator section gains the policy layer (frontmatter flag, `isAutoMergeRepo` AND semantics, ready bucket + once-per-ready-state notification, the explicit-request approval path); the Merge Logic table adds the policy column/row; **and** the stale Linked PR Checking code sample (shows a `repoInfo.pr_number` legacy fallback that no longer exists at HEAD) is replaced with the current `repositories → AttachedRepo[] → branch_states` walk.
- `docs/architecture/edit-mode.md`: it enumerates `merge_pull_request` among edit-mode-unlocked tools (lines 15, 185) — add one sentence that in non-auto repos the tool triggers its own `merge` approval rather than merging; the edit-mode approval flow itself is unchanged.
- archie-plugins `CLAUDE.md` (separate repo, docs-only per the brief): frontmatter reference table gains `metadata.archie.repo.autoMerge` / `repos[].autoMerge` — plain language ("when true, Archie may merge this repo's approved, green PRs automatically; when omitted, Archie always asks in the thread first"), no harness internals. The multi-repo section's example gains the field on one entry.
- archie-plugins PM runtime skill `pm/skills/engineering-team/SKILL.md` (same archie-plugins docs PR, coordinated with the engine deploy): line 28's lifecycle step 6 ("**Merge** → System auto-merges when approved + CI passes") and line 78's "auto-merge handles the green path" currently teach the old behavior and would make the PM lie on deploy day. Rewrite both for the new default: the ready-notification finding arrives → the PM relays "PR ready — ask me to merge" to the thread once; on an explicit user request the PM delegates to the repo agent, whose `merge_pull_request` call surfaces approve/deny buttons the user must click; `autoMerge: true` repos keep the old automatic behavior.
- `prompts/repo-agent.md:142` and the `merge_pull_request` tool description string (`tools.ts:1461`): both currently describe "merge the PR (checks mergeability first)". Update to the policy-gated contract — auto repo merges directly; non-auto repo posts a merge-approval request and pauses the task — so agents learn the contract before calling, not from the return text.
- `.claude/skills/archie-e2e/SKILL.md`: new canonical recipe `merge-approval-deny` (see verification plan) mirroring `edit-mode-approval`, exercising the deny path so no real merge ever executes in QA.

## Risks / Trade-offs

- **Deploy-day behavior break is silent per-repo** → mitigated by the ready notification itself: the first post-deploy approved PR produces "ready — ask me to merge" in the thread, which is the discovery mechanism. AC9 names the operator step.
- **AND semantics can surprise** — adding a second agent for a repo without the flag silently turns auto-merge off → accepted: fail-safe direction, and the mixed-flag `logger.warn` plus the plugins-repo doc row make it diagnosable.
- **Single pending-approval slot** — a task cannot have two merge approvals in flight → accepted: the request pauses the task, making concurrent requests unreachable in practice; sequential requests work; revisit only if a real multi-PR-parallel-merge workflow appears.
- **Notification marker without head SHA** — "ready state" is approximated as "continuous ready period" (clear-on-not-ready), not keyed to a commit → accepted: `PRStatus` has no SHA today; behavior meets AC1 exactly and re-notifies on genuine un-ready→ready transitions; adding SHA keying is a compatible refinement later.
- **Tool loosened to `blocked+mergeable`** — the explicit path may now attempt merges GitHub refuses → accepted: identical to the orchestrator's long-standing tolerance; failure is graceful and reported.
- **Policy read from the live registry at merge time** — a frontmatter edit changes behavior for in-flight tasks on the next check → intended (hard enforcement follows current config, not task-creation-time snapshots).

## Known trade-offs

- **Approval is not SHA-pinned.** `pending_merge_approval` carries no head SHA (`PRStatus` exposes none today), so the task can push new commits between the prompt and the click, and an approval merges the branch's *current* head after a state-level re-check only. Accepted: same class as GitHub's own stale-approval behavior and today's auto-merge; mitigated by the re-check plus the paused task in the common path (a parked task isn't pushing). SHA-pinning is a compatible later refinement once `PRStatus` carries a head SHA.
- **External Slack guests can click `approve_merge`.** Mirrors the edit-mode precedent (`events.ts:249-253`): the click resolves the approval, only identity recording is skipped. Accepted for now, consistent with edit mode — the same guest could approve edit mode and drive the task anyway; flagged as input to issue #168's generalization, where approver authorization properly belongs.
- **Rare duplicate ready nudge under cross-trigger races.** The notify-once marker is flushed synchronously before PM activation, but two tight windows remain (bug-hunt round 2, R2-1): an overlapping merge check whose GitHub fetches outlast the 5s debounce, or an independent task activation registering a canonical instance mid-run, can each lose the marker write and produce one duplicate "ready" notification. State converges after; no wrong merge is possible. Inherent to lockless file-based task state — accepted.

## Migration Plan

No data migration. New metadata fields (`pending_merge_approval`, `merge_ready_notified`) are optional — absent on all existing tasks, which is their correct default state. Frontmatter field is optional and unknown to older engines (dropped at the explicit copy — no compat break). Rollout: deploy archie-hq; all repos immediately stop auto-merging (intended); repo owners opt in per repo via archie-plugins PRs later. Rollback: revert the archie-hq deploy; stale `pending_merge_approval`/`merge_ready_notified` fields are ignored by the old code (unknown-key-tolerant JSON metadata). Caveat: a merge approval still pending at rollback time strands its paused task — the old code has no `merge` resolver (the API 400s on `type: "merge"`, and there is no `approve_merge` Slack handler). Operator remedy: deny any pending merge approvals via `POST /tasks/:id/approve` before rolling back (the merge-type body names the pending PR — read `github`/`pr_number` from the task's `pending_merge_approval` metadata), or nudge the task's thread afterwards so the PM reactivates.

## Open Questions

- None blocking. If PR #169 lands first with a shared named `ApprovalType`, adopt it during rebase (Decision 8).
