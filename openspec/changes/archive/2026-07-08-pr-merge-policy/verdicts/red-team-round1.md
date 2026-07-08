# Red-team verdict: pr-merge-policy (round 1)

**Verdict: FAIL — 2 blocking objections, 5 non-blocking.** The core design is sound and proportional: every load-bearing piece (frontmatter threading, `isAutoMergeRepo`, the ready bucket + `BranchState` marker, the `pending_merge_approval` slot, the mirrored `merge` approval type) is pinned by at least one AC, and I could not construct a materially simpler design that meets all 9 ACs (axis 3 passes — see "Simplicity" below). The failures are blast-radius omissions: the plan changes the system's merge behavior while leaving the PM's own instructions asserting the old behavior, and it misdeclares an existing spec as untouched when the change contradicts its text.

Attack basis: all seven plan documents, plus code reads of `merge.ts`, `webhooks.ts`, `tools.ts` (both tool sites), `task.ts` (approval machinery, `postInteractiveToUser`, `save`, `Task.get`), `events.ts`, `routes.ts`, `registry.ts`, `persistence.ts`, `spawn.ts:475-495`, prompts, PM skills in archie-plugins, and `openspec/specs/`. Dossier claims I re-verified all held (orchestrator condition, per-PR merging, external-approver semantics at `events.ts:249-253`, explicit field copies, `mcp__repo-tools__merge_pull_request` in read-only `disallowedTools` at `spawn.ts:482`, whole-object JSON metadata persistence at `task.ts:1095-1099` so new fields round-trip, `Task.get` returning the live instance from `activeTasks`, and `syncPlugins()` → `initRegistry()` on every `Task.get` so the "live registry" claim in Decision 2 is real).

---

## Blocking objections

### 1. BLOCKING — The PM's engineering skill will lie on deploy day; the plan never updates it

**Applies to:** tasks.md §8 (Docs), design.md Decision 9, proposal.md Impact/Docs.

**Evidence:** `/Users/khmelev/Projects/swc/archie-plugins/pm/skills/engineering-team/SKILL.md:28` — "**Merge** → System auto-merges when approved + CI passes." and `:78` — "Successful CI runs do not wake you — … auto-merge handles the green path."

The plan's only plugins-repo doc task (8.3) updates the archie-plugins `CLAUDE.md` frontmatter reference. It does not touch the PM's engineering-team skill, which is the document that actually drives the PM's runtime behavior. On deploy day, for every repo:

- The PM will tell users "this will merge automatically once approved" — false for all repos, and directly contradicting the ready notification the engine then sends.
- The PM has no guidance for the new system finding ("PR ready — offer merge on request"), which is the mechanism AC1's user-visible half depends on. The engine guarantees once-ness of the *finding*; the single Slack post is the PM's job, and the PM's current instructions tell it the opposite story.
- Line 78's "auto-merge handles the green path" mis-frames why the PM is being woken on green CI post-change.

Line 28's second sentence ("If the user asks to merge manually, delegate to the repo agent") is the one piece that survives — the merge-on-request routing exists — but it too needs a sentence about the approval button that will now follow.

This is squarely inside the brief's scope ("Plugins repo: docs only" — a skill markdown edit is docs) and inside the brief's own risk framing (goal 4: "Hard enforcement in the engine, not prompts" — enforcement is in the engine, but the prompts must not *contradict* the engine). **Fix:** extend task 8.3 (same archie-plugins docs PR) to rewrite SKILL.md:28 and :78 for the new default (ready notification → relay to user → on user request delegate to repo agent → user confirms via the approval button), noting `autoMerge: true` repos keep the old behavior.

### 2. BLOCKING — proposal.md declares "Modified Capabilities: none," but the change contradicts the existing `debug-mcp-task-waiting` spec

**Applies to:** proposal.md Capabilities section, `specs/` (missing delta), tasks.md §7.

**Evidence:** `openspec/specs/debug-mcp-task-waiting/spec.md:40` — "**THEN** it returns `state: "approval_requested"` together with the approval `type` (`edit_mode` or `research_budget`), never `stopped`."

Tasks 7.1/7.2 make `wait_for_task` return `approval_type: merge` (that is the whole point of AC3's observability), which contradicts the existing spec's exhaustive parenthetical enumeration. proposal.md's claim that the spec is "approval-type-agnostic (the type enum widens, no scenario changes semantics)" is false as written — the scenario text names the types. Left as-is, archiving this change produces a spec the shipped code contradicts. **Fix:** one-paragraph `MODIFIED Requirement` delta for `debug-mcp-task-waiting` rewording the scenario ("together with the approval type", enumeration updated or dropped), and move it from "None" to Modified Capabilities.

---

## Non-blocking objections

### 3. NON-BLOCKING — repo-agent prompt and the tool's own description become stale

**Applies to:** tasks.md §4 and §8, proposal.md Impact.

`prompts/repo-agent.md:142` — "`merge_pull_request(pr_number)` — merge the PR (checks mergeability first, returns status if not ready)" — and the tool description at `src/agents/tools.ts:1461` ("Merge a pull request. Checks mergeability first…"). In non-auto repos (i.e. **all** repos on deploy day) the call now posts an approval request and pauses the entire task — a materially different contract the agent should know before calling, not learn from the return text. Cheap fix: update the description string in task 4.1 and add `prompts/repo-agent.md` to §8.

### 4. NON-BLOCKING — an approved merge lands the branch's *current* head, not the content that existed at request time

**Applies to:** design.md Decision 7 and Risks.

`pending_merge_approval` carries `{github, pr_number, requested_by, requested_at}` — no head SHA. The pause is escapable: any user thread message reactivates the PM (design acknowledges resumption implicitly via the slot surviving), the agent can push more commits to the PR branch, and a later click on the *original* Approve button merges whatever the branch holds, after only a state-based re-check. Same class as GitHub's own stale-approval problem, and consistent with today's auto-merge, but on the "supervised repo" path it deserves either a head-SHA capture (needs a small `getPRStatus` extension — `PRStatus` carries no SHA today, research §9) with warn-or-refuse on mismatch, or an explicit line in Risks accepting it. Currently the "no head SHA" acceptance is written only for the notification marker, not the approval slot.

### 5. NON-BLOCKING — a pending slot has no cancel path and the buttons are never re-posted

**Applies to:** design.md Decision 7 (duplicate suppression), tasks.md 4.2.

If the user responds in the thread ("hold off") instead of clicking Deny, the task resumes with the slot set forever. Every later `merge_pull_request` call returns "already pending" and never re-posts the interactive message; the only resolutions are finding the days-old Slack message or a manual `POST /tasks/:id/approve`. Suggest: `handleMergeDenial` semantics exposed to the PM (e.g. the informational return telling the agent/PM how to cancel), or clear the slot when a new user message reactivates the task, or allow re-posting when the prior prompt is stale. As designed it works but strands users in a common conversational flow.

### 6. NON-BLOCKING — external Slack guests can be the sole human gate on a merge

**Applies to:** design.md Decision 6.

Verified at `events.ts:246-253`: the edit-mode external-user check only skips *identity recording*; the approval still resolves. The design consciously mirrors this for merge ("an external/guest approver still resolves the approval"), and the dossier constraint (§9 "same bail-out as edit-mode") is satisfied as written. But the edit-mode bail-out exists to protect git authorship; for merge, the click is the *only* human gate onto the default branch, and the explicit path deliberately drops the GitHub-review requirement (AC5). Net post-change: in a shared channel, an external guest can merge a zero-review PR into a supervised repo. Defensible (the same guest can approve edit mode and drive the task), but it should be an explicit sign-off in Risks — or merge should deny external approvers — rather than an inherited default.

### 7. NON-BLOCKING — AC1's "PM posts exactly one notification" is verified only at the finding layer

**Applies to:** verification-plan.md AC1 row.

The integration test asserts one finding + one `sendMessage('pm-agent')` across webhook bursts. Whether the *PM* then posts exactly one Slack message — or posts two, or contradicts it per objection 1 — is LLM/prompt-layer and untested (accepted architecture pattern; `notifyPMAboutConflicts` has the same shape). The verification plan should name this proxy explicitly, and note that objection 1's skill fix is what makes the user-visible half hold in practice.

---

## Attacks run that did NOT land (for the record)

- **Simplicity / over-engineering:** each scrutinized piece survives. `mergeability.ts` resolves dossier open item 2 and its type-only import of `PRStatus` from `agents/tools.js` follows existing precedent (`merge.ts:25` already does exactly this — no layering or cycle problem; folding it into `client.ts` would be equivalent, not simpler). The `pending_merge_approval` slot is the minimum for restart-surviving resolution (AC4) plus stale-click no-ops. The `BranchState` marker is the minimum for AC1's once-per-ready-state across bursts *and* restarts (5s debounce provably insufficient; metadata persists whole-object JSON so it round-trips). AND-semantics is one line and fail-safe; multi-agent-same-repo is real (the orchestrator dedupes exactly this case, `merge.ts:71-73`). The double-confirmation UX (user says "merge it", then must also click Approve) is pinned by the brief's goal 2, not the plan's invention.
- **Orchestrator bypass:** `triggerMergeCheck`/`checkAndMergeLinkedPRs` have exactly one external caller (`webhooks.ts:281`); gating inside `triggerMergeCheck` covers everything. (The stale "since PM is calling this via a tool" comment at `merge.ts:56-58` could be cleaned in passing.)
- **Merge without edit mode:** impossible — tool in `disallowedTools` when read-only (`spawn.ts:482` confirmed), and engine-side merge is reachable only from a slot only the tool sets.
- **Replay / wrong PR:** slot cleared on every resolution, stale resolutions no-op, approval re-checks live GitHub state for the exact `{github, pr_number}`; button value = taskId carries no authority. API route validates unknown types with a 400 (`routes.ts:265-267`) and the new branch is additive.
- **CLI channel:** `postInteractiveToUser` falls back to CLI log + `approval:requested` event (`task.ts:576-597`); resolution via the API/debug-MCP `merge` branch works without Slack.
- **Registry staleness:** `Task.get` → `syncPlugins()` → `initRegistry()` (`plugin-sync.ts:40`), so merge-time policy really is live, as Decision 2 claims.
- **Concurrent instances:** `Task.get` returns the live instance from `activeTasks` (`task.ts:237-239`); the transient-instance webhook path matches the existing `notifyPMAboutConflicts` shape.
- **Existing `autoMerge` frontmatter in the wild:** none (grep of archie-plugins) — no silent semantic flip beyond the intended one.
- **In-flight tasks at deploy:** any PR still open at deploy is pending something (a ready PR would already have auto-merged pre-deploy); its next webhook lands it in the held bucket with a notification — the discovery mechanism the design names. Old tasks lack the new optional fields, which is their correct default.
- **Double PM notification after approval-path merge:** the post-merge `pull_request closed` webhook ping is pre-existing behavior identical to today's orchestrator merges — not a new regression.

## Bottom line

Fix objections 1 and 2 (both are small, docs/spec-layer edits: one skill rewrite in the archie-plugins docs PR, one MODIFIED-capability delta) and this plan is implementable as designed. Objections 3-7 are recorded for the implementer/design "Known trade-offs" section and none of them requires structural change.
