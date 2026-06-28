# Completion as Quiescence

**Status:** Proposed (design verified — 2 subagent rounds, implementation-ready; under review; not yet implemented)
**Supersedes the coordination half of:** the `activePeers` completion guard in `report_completion`.

---

## 1. Background

Multi-agent task. PM owns the user conversation; specialists (mobile, backend, ops…) do work and report back via `send_message_to_agent`. Agents are turn-based: a turn starts on an incoming queue message and ends after a turn-ending tool call; the SDK `Stop` hook then marks the agent inactive ([spawn.ts:560](../../src/agents/spawn.ts) Stop hook → `updateAgentState(false)` at 562). A task with all agents inactive but still `isActive` is either *done* or *stalled*; the idle-check ([recovery.ts:77](../../src/tasks/recovery.ts)) currently always treats it as a stall and triggers recovery.

`report_completion` ([tools.ts:569](../../src/agents/tools.ts)) is PM's turn-ending tool. **Corrected semantics (load-bearing):** completion does *not* mean the overall job is finished. Per the PM prompt itself ([pm-agent.md:86](../../prompts/pm-agent.md)): *"it means 'I've responded to my requester and am now waiting for their next input.'"* The task parks; any later message (user follow-up, late peer message, webhook) reopens it via `activate()` ([task.ts:1080](../../src/tasks/task.ts)) — `task.complete()` ([task.ts:739](../../src/tasks/task.ts)) produces a reopenable state.

### Agent lifecycle fact (verified, essential to this design)

`session.active` is set **only** by `updateAgentState(true)`, called in exactly two places — [spawn.ts:184](../../src/agents/spawn.ts) (start of `spawnAgent`) and [spawn.ts:606](../../src/agents/spawn.ts) (on the SDK `system:init` event). Both are tied to a `query()` spawn/turn-start, **never to message enqueue.**

Empirically (events for `task-20260627-1443-4vm4bv`): a fresh spawn after a park emits **two** `agent:active` (184 + 606); a peer reply to an already-running PM emits **one** (606 only). So **the subprocess persists between turns ("live-idle": `isRunning` true, `session.active` false), and the SDK re-emits `init` on each resumed turn**, which re-marks active — but only *after* the SDK starts the turn. There is a latency gap between "message enqueued to a live-idle agent" and "agent marked active." **This gap is the crux of the design (see §3 Invariant).**

## 2. Problem

To stop PM completing while a specialist was genuinely working (which orphaned the specialist's pending reply), a guard refuses completion if `activePeers()` is non-empty ([tools.ts:593](../../src/agents/tools.ts), [task.ts:824](../../src/tasks/task.ts)).

It misfires because **`session.active` conflates two states**:

- **Working** — mid-turn, may still message PM. Completing *would* orphan it.
- **Winding down** — already made its turn-ending `send_message_to_agent(PM)` call; just hasn't hit its `Stop` hook yet. Completing destroys nothing.

So every threshold is wrong somewhere:

- No check → PM completes over a genuinely-working peer (the original bug).
- Refuse-if-active → PM blocked by a *winding-down* peer; PM falls back to `post_to_user`, ends its turn "waiting for a report that already arrived," nothing reopens it → all idle, no teardown pending → idle-check fires → **spurious recovery** (observed: `task-20260627-1443-4vm4bv`, PM `report_completion` at `20:28:57.759` refused because mobile's `Stop` hook hadn't fired until `20:28:58.108`).

A synchronous gate guarding an asynchronous lifecycle always races the `Stop`-hook boundary. Tuning the gate cannot fix it.

## 3. The model

**Decide at quiescence, not at the racy moment.** `report_completion` stops being a gate and becomes an intent. Teardown is gated on the system actually going quiet.

- **intent** — PM called `report_completion` and has not reopened since. Means "I wait for no one but the user."
- **quiescent** — all agents idle.

`report_completion`:
1. Posts PM's message to the user **immediately** (it is PM's user-facing response, not a "done" banner — **do not defer it**).
2. Sets `task.completionIntent = true`.
3. Returns a short result that confirms completion and tells the agent to **end its turn now**. Since the call no longer tears the agent down, prompt turn-end is what lets the system reach quiescence.
4. **Never refuses.**

> **Hardened return text** (replaces the now-inaccurate `'Stopped task.'` / `'Posted message to Slack and stopped task.'`): *"Message posted. Nothing left to do — end your turn."* (with message) / *"Completion recorded. Nothing left to do — end your turn."* (no message). Kept minimal on purpose. It's a **soft** reinforcement of the prompt's "STOP immediately," not a correctness guarantee — the quiescence model self-protects (a lingering agent only delays the park; contradictory work makes a peer active → not quiescent), and the 30-min wall-clock `complete()` is the hard backstop.

The idle-check (the single "system went quiet" handler) becomes:

```
on the 3s idle tick:
  if (!task.isActive || getIsShuttingDown())            return;
  if (any agent has a pending teardown)                  return;   // edit-mode / research-budget winding down
  if (!allAgentsIdle())                                  return;   // not quiescent yet
  // quiescent:
  if (task.completionIntent) { await task.complete(); return; }    // PM's "wait for no one", verified → park
  await triggerRecovery(task);                                     // quiet but nobody parked → dropped ball
```

### Invariant (resolves the live-idle gap — see §1 and §13/H1)

> **An agent is marked `active` synchronously the moment a message is enqueued to it — not lazily when the SDK re-emits `init`.**

Without this, a live-idle agent that just received a message (e.g. a peer's report reopening PM) is still `session.active === false` until the SDK starts its turn. In that gap the idle-check would see the system "quiescent" while PM is actually mid-turn, and with intent set it would **park PM and drop the very reply this design exists to protect.** Marking active at enqueue makes "all agents idle" a faithful proxy for "no work in flight," so the quiescence verdict is never wrong. (Implementation in §7.)

### Why this is correct (and kills the misfire structurally)

> `report_completion` is PM's **claim**: "I wait for no one." Quiescence is the system **verifying** it.

- Claim true (no peer working, none queued) → quiescent → park. ✓
- Claim false (misfire — a peer is genuinely working, or about to be messaged) → a message is or will be enqueued → target marked active → **not quiescent** → no park. The peer is protected *structurally*. Its report reopens PM (enqueue → PM active → intent cleared) → PM continues. **The false claim self-corrects.**

Completion now runs from the idle-check **while PM is already idle** — not inside PM's turn — so it needs no deferred-teardown, and the prior idle-check-vs-deferred-teardown race cannot occur for completion at all.

## 4. Recovery is kept — it is the answer to the dropped-ball case

Recovery is the `no-intent` branch of quiescence: all idle, nobody parked = someone went silent without reporting → nudge ([recovery.ts:117](../../src/tasks/recovery.ts) `triggerRecovery`, unchanged). The bug was recovery firing when PM *had* parked (incident 2); fixed because parking now sets `completionIntent`, routing quiescence to `complete()` instead of recovery. Recovery gets **more** precise, not weaker.

## 5. Scenario matrix

`intent` = `completionIntent` set. `quiescent` = all agents idle (and, per the §3 invariant, no message enqueued-but-unprocessed). Message posts immediately wherever `report_completion` is called.

| # | Situation | intent | at "all idle" | outcome |
|---|---|---|---|---|
| 1 | **Happy relay** — peer reports, PM relays + completes | yes | quiescent | park ✓ |
| 2 | **Incident 2** — peer winding down when PM completes | yes | quiescent once peer `Stop`-hooks | park ✓ (no refuse, no recovery) |
| 3 | **Dropped ball** — PM waiting, peer finishes silently | no | quiescent | recovery → nudge → continue ✓ |
| 4 | **PM misfire** — peer genuinely working, PM completes early | yes | peer active / peer's report enqueued → PM marked active → **not** quiescent; PM reopens → intent cleared | message posted, PM continues; no premature park ✓ |
| 5 | **Double fault** — PM misfires *and* peer then finishes silently (no report) | yes | quiescent | park ⚠️ (reopenable; see §10) |
| 6 | **Parallel** — PM waits on 2 peers | no | quiescent only when both idle | both report → reopen → park; any silent → recovery ✓ |
| 7 | **User barges in** mid-completion | set, then cleared | user msg enqueued → PM marked active → intent cleared | PM handles new request ✓ |
| 8 | **PM stall/crash** (no delegation) | no | quiescent | recovery → respawn PM ✓ |
| 9 | **Peer crash** mid-work | no | quiescent | recovery → nudge/respawn peer ✓ |
| 10 | **Silent completion** — `report_completion()` no message | yes | quiescent | park silently ✓ |
| 11 | **Message in flight** at the idle moment | — | enqueue marked target active → not quiescent | wait → processed → re-evaluate ✓ |
| 12 | **Late peer message** after park | — | — | reopens task (`activate`) — self-heals ✓ |

Rows currently broken: **2** (spurious recovery), **4** (flaky refuse). Both become correct. Rows 3/8/9 (recovery's real job) unchanged. Rows 4/7/11 are correct **only with the §3 invariant** — without it they regress to H1.

## 6. Intent lifecycle

- **Set:** in `report_completion`, after the message posts.
- **Cleared:** on PM's `inactive→active` transition in `updateAgentState` ([task.ts:1030](../../src/tasks/task.ts)). With the §7 enqueue-marks-active change, this edge fires the moment a peer report or user message is delivered to a parked-intent PM — exactly when the intent should be reconsidered.
  - **Implementation guardrail (edge-exact):** capture the *pre-update* `session.active` and clear intent only on a genuine `false→true` PM edge. The idempotency early-return at [task.ts:1037](../../src/tasks/task.ts) (`active === active && !sessionId`) covers the no-sessionId case, **but the SDK `init` re-fire calls `updateAgentState(pm, true, sessionId)` *with* a sessionId, which bypasses that early-return** — so a naive "clear whenever the body runs with active=true" would mis-fire on every resumed turn's init. Gate strictly on the edge. (In practice the synchronous enqueue-mark sets PM active ~30ms before the init re-fire, so intent is already cleared by then; the edge-gate just keeps it exact.)
- **Not cleared by** a specialist going active (it has no bearing on PM's "waiting on user" claim unless it messages PM, which routes through PM going active). A more conservative variant — clear on *any* agent reactivation — trades rare premature parks (row 5) for slightly more recovery churn; default **pm-only**, noted as a tunable.
- **Recovery nudge:** [recovery.ts:159](../../src/tasks/recovery.ts) currently marks active via `updateSession(true)` (no event, no intent-clear). Switch it to `updateAgentState(true)` so a nudged PM also clears intent and re-decides (otherwise stale intent could park instead of re-recovering).
- **Persistence:** in-memory on `Task` (like `recoveryAttempts`, [task.ts:83](../../src/tasks/task.ts)). Lost on restart → a task about to park instead takes the recovery path on resume (nudge → PM re-completes). Acceptable; no new persistence.

## 7. Code changes

| File | Change |
|---|---|
| `src/tasks/task.ts` | Add `completionIntent: boolean`. In `updateAgentState`, clear it on pm-agent `inactive→active`. **Enqueue-marks-active:** in `toolSendMessage` ([task.ts:869](../../src/tasks/task.ts), after `addMessage` at ~908) call `updateAgentState(target, true)` so the recipient is active synchronously (the §3 invariant). |
| `src/agents/tools.ts` | `report_completion`: **remove** the `activePeers` refuse ([tools.ts:593](../../src/agents/tools.ts)). Keep idempotency (`!task.isActive`) + no-channel guard + the immediate message post. Replace `deferTeardown(() => task.complete())` ([tools.ts:629](../../src/agents/tools.ts)) with `task.setCompletionIntent()`. **No teardown deferred for completion.** Replace both return strings ([tools.ts:630](../../src/agents/tools.ts)) with the hardened directive result (§3) — the old `'Stopped task.'` wording is now inaccurate (nothing stops synchronously). |
| `src/tasks/recovery.ts` | `scheduleIdleCheck`: restructure to the §3 loop (quiescence gate, then `completionIntent → complete()` else `triggerRecovery()`). Nudge path ([recovery.ts:159](../../src/tasks/recovery.ts)): `updateSession(true)` → `updateAgentState(true)`. |
| `src/tasks/task.ts` | **Choke set (verified complete — round 2):** mark the target active right after `addMessage` in **both** `sendMessage` (~[task.ts:223](../../src/tasks/task.ts) — every external/system enqueue funnels here: slack/events, github webhooks, api routes, launch, reminders, edit-mode/research/denial resumes, startup recovery) and `toolSendMessage` (~908), plus the recovery-nudge switch above. `Agent.sendMessage` ([agent.ts:84](../../src/agents/agent.ts)) has **zero callers**, and `prependMessage` only replays already-consumed messages into a mid-retry (already-active) generator — neither needs marking. So two call sites + the nudge switch cover everything. |
| `src/tasks/task.ts` | `activePeers()` ([task.ts:824](../../src/tasks/task.ts)) becomes unused (sole caller is the deleted refuse — verified). Remove it. |

**Second completion site (benign, no change):** the 60-min wall-clock cap calls `await this.complete()` ([task.ts:1112](../../src/tasks/task.ts)). Idempotent with the idle-check's `complete()` and ignores intent — parks unconditionally on timeout, which is correct. Noted so the reader knows completion isn't solely `report_completion`'s concern.

**Unchanged / still needed** — the three teardown-race fixes already landed (pending-teardown guard, mid-turn abort, `finally` backstop) remain valid for the **forced-stop** paths that still defer from inside a turn: `request_edit_mode` ([tools.ts:563](../../src/agents/tools.ts) → `task.stop()`) and research-budget ([task.ts:981](../../src/tasks/task.ts) → `task.stop()`):
- pending-teardown guard in the idle-check (still guards those defers),
- abort mid-turn agents in `complete()`/`stop()`,
- the `finally` backstop ([spawn.ts](../../src/agents/spawn.ts)) that runs a stranded deferred teardown on agent exit.

Completion stops using the defer machinery; the forced stops keep it.

## 8. Prompt updates

The PM prompt hard-codes the deleted behavior and must be rewritten, not just "located":

- [pm-agent.md:88](../../prompts/pm-agent.md): *"The tool enforces this: if a peer is still active, `report_completion` refuses and names who."* — **false under the new model** (never refuses). Rewrite: the guidance "only complete when no agent work is outstanding" stays as a *PM responsibility*; drop the "tool enforces / refuses" claim. Optionally note the system won't tear down a task while a peer is genuinely active (quiescence), but PM should still not call it while awaiting a peer.
- [pm-agent.md:39](../../prompts/pm-agent.md): "It would pause the task and tear down the agent you're waiting on, dropping its reply." — soften: with quiescence the reply isn't dropped, but the correct behavior is still `post_to_user` + end turn (not `report_completion`) while awaiting a peer.
- [pm-agent.md:33](../../prompts/pm-agent.md), [:86](../../prompts/pm-agent.md): already align with the corrected semantics ("waiting for their next input") — leave.

Note (round-2 corrected): the active PM prompt is `prompts/pm-agent.md`, loaded via `loadPrompt('pm-agent')` ([spawn.ts:53](../../src/agents/spawn.ts)) — the pm-agent.md:88/:39 edits above are correctly targeted and mandatory. The active **skills** dir is `<repo>/skills/` (registry `CORE_SKILLS_DIR`, mounted at [spawn.ts:110](../../src/agents/spawn.ts)), **not** `prompts/_original/.claude/skills/` (a preserved, unloaded copy). **No active skill describes the refuse** (only `skills/self-awareness/SKILL.md` names `report_completion` as an internal tool) — so **no skill edit is needed**; only the two PM-prompt lines.

## 9. Quiescence precision

`allAgentsIdle()` = `checkAllAgentsInactive` ([recovery.ts:100](../../src/tasks/recovery.ts)) — all `session.active === false`. With the §3 invariant (enqueue marks active), an agent with an unprocessed message is `active`, so all-idle faithfully means no work in flight. **Do not** rely on `queue.pendingCount()` for this: `addMessage` hands a message directly to a waiting consumer without pushing to `messages[]`, so `pendingCount()` is 0 throughout processing ([message-queue.ts:39](../../src/agents/message-queue.ts)) — it cannot detect in-flight work. The enqueue-marks-active invariant is the correct mechanism; `pendingCount` is not a substitute.

## 10. Residual risk

**Row 5 (double fault):** PM *wrongly* parks (misfire) **and** the working peer then finishes **silently** (never reports what it should have). Result: premature park. Mitigations: (a) two simultaneous faults; (b) "parked awaiting user" is reopenable — any later message resurrects the task; (c) no worse than today, where the `activePeers` refuse only catches this if the peer happens to still be `active` at that exact instant (the same flaky race). Every other scenario resolves correctly by construction.

**Pre-existing spawn-failure wedge (not introduced here; worth fixing alongside).** `spawnAgent` marks the agent active at [spawn.ts:184](../../src/agents/spawn.ts) *before* heavy async setup (workspace, MCP, clone) that can throw, but only wires the crash-handler that marks it inactive once `handle` is set at [spawn.ts:725](../../src/agents/spawn.ts). If setup throws in between, the agent stays `active` forever → never quiescent → no park/recovery until the 30-min wall-clock. This pre-dates the design, but the quiescence model leans harder on agents reliably reaching `inactive`, so add a `try`/guard in `spawnAgent`/`ensureAgentSpawned` that marks inactive if spawn throws. Note the §7 enqueue-mark adds **no** new wedge: it runs *after* `ensureAgentSpawned`, so a spawn failure throws before the mark.

## 11. Testing

- **Unit (vitest):** model the idle-check decision as a pure function of `(isActive, anyPendingTeardown, allIdle, completionIntent)` → assert the four outcomes. Test intent set/clear edges: set on `report_completion`; cleared on pm `inactive→active` (including the enqueue-driven transition); *not* cleared by a specialist reactivation or intra-turn `init` re-fire on PM. Test `toolSendMessage` marks the target active synchronously.
- **Integration / manual (Docker):** reproduce incident 2 (peer winding down at completion → parks, no recovery log); the misfire (peer working + early `report_completion` → message posts, no park until peer done); the dropped ball (peer silent finish → recovery nudge); the live-idle race (user replies in the ~3s window after `report_completion` → PM re-engages, no park).
- Local vitest runner currently fails to load (`rolldown-binding.darwin-universal.node` missing) — run in Docker or fix the binding.

## 12. Out of scope (future)

- Unifying `request_edit_mode` parking onto the same intent+quiescence model (same shape: PM parks awaiting user approval). Deferred to limit blast radius.
- Persisting `completionIntent` across restarts (intentionally in-memory).

## 13. Design-review log

**Round 1 (subagent verification) — blocker found and resolved:**

- **H1 (critical):** removing completion's teardown leaves PM **live-idle** (subprocess alive, `session.active` false) between turns; a message arriving in the pre-park window would be processed before the SDK re-emits `init` and re-marks active, so the idle-check could read the system as quiescent and **park PM mid-turn**, dropping the reply. **Resolution:** §3 Invariant — mark an agent active synchronously at message **enqueue** (§7), not lazily at `init`. Closes the gap; `session.active` becomes "has work queued or processing."
- **H2 (medium):** intent could never clear for a live-idle PM, because the clear keyed off `updateAgentState(true)` which (pre-fix) only fired at spawn/`init`. **Resolution:** same enqueue-marks-active change routes the resume through `updateAgentState(true)`, firing the `inactive→active` clear; plus the recovery-nudge switch to `updateAgentState(true)` (§6).
- **Ref drift:** stale line numbers in the first draft corrected throughout (activePeers 824, updateAgentState 1030/guard 1037, checkAllAgentsInactive 100, triggerRecovery 117, complete() 739, report_completion 569, timeout complete() 1112).
- **Confirmed sound:** `activePeers` has a single caller (safe to delete); `complete()`/`stop()` idempotent (no double-complete harm); forced-stop paths unaffected; recovery branch logic intact.

**Round 2 (subagent verification of the revision) — implementation-ready, no blockers.**

- **Enqueue-marks-active confirmed correct + choke set complete.** Three enqueue mechanisms (`sendMessage`, `toolSendMessage`, the recovery-nudge `addMessage`); all covered by two call-site marks + the nudge switch. `Agent.sendMessage` has no callers; `prependMessage` is internal retry-replay. No uncovered path.
- **Live-idle gap measured.** Event trace shows enqueue→active latency of 18–44ms on live-idle resumes; a scan found **no** real instant where all-idle coincided with a queued-but-unprocessed message (H1 narrow in practice — the active *sender* normally bridges PM's re-activation). The invariant makes it airtight regardless.
- **No premature intent-clear** — provided the clear is edge-exact (see §6 guardrail): the sessionId-bearing `init` re-fire bypasses the idempotency early-return, so gate on the true `false→true` PM edge, not "body ran with active=true."
- **Restructured loop race-free** — runs synchronously to `complete()`'s first `await` (which sets `isActive=false` + stops/aborts queues), so no message interleaves the quiescence check.
- **Recovery-nudge `agent:active` emission is safe** — no subscriber re-arms idle checks; no recovery↔complete oscillation (nudge runs only in the `!intent` branch).
- **One pre-existing spawn-failure wedge** surfaced (see §10) — not introduced here.
- Minor doc fixes applied from round 2: §8 skills path, §1 Stop-hook ref (560/562), choke-set wording (§7), this log.

## 14. Rollout

1. Build on the landed teardown-race fixes (pending-teardown guard, mid-turn abort, `finally` backstop).
2. Implement §7 + §8 (and, ideally, the §10 spawn-failure guard).
3. Post-implementation subagent review (regression check on forced-stop paths + the edge-exact intent-clear + the spawn-failure guard).
4. Build/typecheck; Docker repro of incident 2 + misfire + dropped ball + live-idle race.
5. Hand off.
