---
name: archie-e2e
description: Test Archie full-cycle on your machine. Boots Archie in Docker, talks to it as your real Slack user by DMing the dev bot via the claude.ai Slack MCP, observes the task through the archie-debug MCP, and verifies the memory layer end-to-end (extraction keying + injection). Use to smoke-test a Slack → PM → memory round-trip locally without writing throwaway scripts.
license: MIT
metadata:
  author: archie-hq
  version: "1.3"
---

# Archie full-cycle E2E harness

Drive a **real Slack round-trip** against a locally dockerized Archie and verify the memory
layer. Input goes in as the Slack MCP's **current authorized user** (so memory keys to their
`U…` id); observation is via the existing `archie-debug` MCP; memory is read off the mounted
`./workdir`. **No Archie code changes — this skill only orchestrates tools that already exist.**

```
claude.ai Slack MCP (posts as you)  →  DM the dev Archie bot
   →  dockerized Archie (dev Slack app, socket mode) receives it as your U… id
   →  PM agent processes, replies in the DM (threaded under your message)
   →  archie-debug MCP / REST API observes task/events/log + approves gates
   →  read ./workdir/memory to prove extraction keyed to you
   →  2nd DM proves injection (PM recites your stored memory)
```

Why Slack and not the debug MCP for *input*: the debug MCP's `create_task`/`send_message`
write `source:'cli'` log lines with **no `@<UID:Name>` marker**, so memory extraction files them
under a `cli:<taskId>` fallback — never your real Slack id. Only the Slack inbound path
(`src/connectors/slack/events.ts` → `task.append` → `appendSlackMessage`,
`src/tasks/persistence.ts:254`) writes the `@<U…:Name>` marker that `extractUsernames`
(`src/memory/lifecycle.ts:108,222`) keys on.

## Tools this skill uses

- **claude.ai Slack MCP** — `mcp__claude_ai_Slack__slack_read_user_profile` (resolve the
  current user — no `user_id`, `response_format:"detailed"`), `…slack_send_message` (DM the
  bot: `channel_id` = bot's user id), `…slack_read_thread` (the bot's threaded reply),
  `…slack_read_channel` (DM history).
- **archie-debug MCP** — `mcp__archie-debug__list_tasks`, `…task_status`, `…get_log`,
  `…get_events`, `…approve`. (Observation only — never for input. See port note below.)
- **Helper scripts** (this skill's `scripts/` dir — run with `bash`, they resolve the repo
  root themselves): `check-env.sh`, `resolve-bot.sh`, `ensure-archie.sh`, `wait-task.sh`.
- **Bash + Read** — nonce minting, reading `workdir/memory/*`.

## Inputs (all optional)

- `teardown` — `docker compose down` at the end. Default **false** (leave running).
- `restart` — force a clean container restart first (`ensure-archie.sh --restart`).
  Default **auto**: restart when the container is unhealthy or recent logs are
  socket-mode warning spam.

Your Slack user and the dev bot are **resolved at runtime** (step 2) — nothing is hardcoded.
Use `AskUserQuestion` only if `.env` / tokens are missing — otherwise run with defaults.

## Worktree / port awareness

Each worktree is its own compose project (project name = dir name) running its own Archie.
The worktrunk pre-start hooks (`.config/wt.toml`) copy `.env` from the base worktree and assign
a **unique PORT** (`hash_port`) so worktrees don't collide on 3000. Consequences:

- The scripts read `PORT` from this checkout's `.env` (fallback 3000) — nothing to pass around.
- The `archie-debug` MCP defaults to `http://localhost:3000`; when PORT differs, set
  `ARCHIE_URL=http://localhost:<PORT>` (an `"env"` block on the `archie-debug` entry in
  `.mcp.json`, or export before launching Claude Code) and reconnect — otherwise its tools talk
  to the wrong Archie. The REST API (`http://localhost:<PORT>/api/...`) is an equivalent
  fallback within an already-running session.
- A **fresh worktree's `workdir/` starts empty** — no prior memory. Step-7 injection needs an
  already-stored bullet; on a first run accept step-6 extraction-keying as the proof. Memory
  assertions also require the checkout to actually contain the memory layer (`src/memory/`).

---

## Steps

Track progress with `TodoWrite`. Stop and report on any hard failure.
`SKILL_DIR` below = this skill's directory (`.claude/skills/archie-e2e`).

### 1. Preconditions

```bash
bash SKILL_DIR/scripts/check-env.sh
```

Prints presence (never values) of `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
plus `ARCHIE_MEMORY` and this checkout's `PORT`. Non-zero exit = missing key → stop.
`SLACK_APP_TOKEN` (xapp-) is required for socket mode; `ARCHIE_MEMORY` must not be `false`.
Note the printed `PORT` — it drives the debug-MCP/REST note above.

### 2. Resolve identities (current user + dev bot, same workspace)

- **Current user** (who the harness posts as):
  `mcp__claude_ai_Slack__slack_read_user_profile { response_format: "detailed" }` (no
  `user_id`) → record `User ID` as `<user_id>` and `Real Name` as `<user_name>`. Every
  assertion below keys on `<user_id>`.
- **Dev bot**:

```bash
bash SKILL_DIR/scripts/resolve-bot.sh
```

  → `bot_user_id` (the DM target) and `team`. Non-zero exit = bad token → stop.
- **Same workspace check**: the bot's `team` must be the workspace your Slack MCP posts to
  (compare with the profile's organization). Mismatch → **stop**, the DM can't reach this Archie.

### 3. Boot / ensure a healthy Archie in Docker

```bash
bash SKILL_DIR/scripts/ensure-archie.sh          # boots if down, waits for /health
bash SKILL_DIR/scripts/ensure-archie.sh --restart # force clean restart (unhealthy / pong spam)
```

Expect the tail to show `Slack: Socket Mode connected` and `[Slack] Bot user ID: …`.
A `CLI-only mode` line means tokens weren't detected → fix `.env`, rebuild. First build of a
fresh worktree takes minutes — the script waits, run it in the background.

### 4. Turn 1 — DM as the current user (the attribution proof)

```bash
echo "E2E-$(openssl rand -hex 4)"   # mint a nonce
```

- Send the DM (posts as `<user_id>`):
  `mcp__claude_ai_Slack__slack_send_message`
  `{ channel_id: "<bot_user_id>", message: "Quick smoke check — reply 'noted' please. (<nonce>)" }`
  Capture the returned **channel** (`D…`) and message **ts**.
- Correlate + wait in one shot:

```bash
bash SKILL_DIR/scripts/wait-task.sh <nonce> 240
```

  Prints `TASK=` (found by nonce — no snapshot diffing), `LOG_HEAD=` (first knowledge-log
  line), `STATE=` and any `PM_REPLY:` lines. Assert `LOG_HEAD` contains
  `@<<user_id>:<user_name>>` **and** the nonce — that marker is the attribution proof.
- `STATE` handling:
  - `COMPLETED` → done; extraction will run.
  - `APPROVAL_REQUESTED` → `mcp__archie-debug__approve { task_id, type, approve: true }`
    (type from the event: `edit_mode` | `research_budget`), then re-run `wait-task.sh`.
  - `STOPPED` → ended **without** completion → no extraction (see Troubleshooting).
  - `TIMEOUT` → inspect `mcp__archie-debug__task_status` / the events API.

> Note: `task_owner`/`participants` in task metadata are **agent** names (e.g.
> `backend-agent`), NOT the requester — don't assert on them for user identity. The requester
> only lives in the transcript marker above.

### 5. Read the reply on the Slack side

**Archie threads its reply under your DM message** (verified):
`mcp__claude_ai_Slack__slack_read_thread { channel_id:"<D… from step 4>", message_ts:"<ts from step 4>" }`
(fall back to `slack_read_channel` for top-level). Assert a coherent, non-empty reply — the
round-trip proof. (`wait-task.sh` already showed it as `PM_REPLY` from the events side.)

### 6. Verify EXTRACTION keyed to you (read mounted `./workdir`, with retry)

Extraction is **async** (queued on `task:completed`); the summary file appears when it
finishes. Poll for up to ~90 s.

- **Deterministic (primary) — this is the real proof:**
  - `Read workdir/memory/summaries/<task_id>.md` → YAML `users:` block lists `id: <user_id>`.
  - `Read workdir/memory/recent-activity.md` → a row for `<task_id>` with `User = <user_id>`.
  - Written unconditionally by `writeSummary`/`appendActivity` (`src/memory/lifecycle.ts:194,198`),
    so they prove the message was attributed to you and keyed to your id.
- **Best-effort (secondary):**
  - `Read workdir/memory/users/<user_id>.md`. A new bullet may or may not appear: the
    extractor errs on extracting *less* and, importantly, **rejects explicit "please remember X"
    instructions as an untrusted prompt-injection surface** — verified: such a Turn-1 yields a
    summary of `## Memory Updates: _no durable learnings_`. **Expect no new bullet from
    instruction-style input; that is correct, not a failure.** Never fail the run on a missing
    bullet.

### 7. Verify INJECTION — behavioral 2nd turn

Ask about memory the user file **already** holds (don't rely on Turn-1 having written a new
bullet — it usually won't, per step 6). First `Read workdir/memory/users/<user_id>.md` to see
what's stored.

- Send a 2nd DM (new top-level message → new task), answerable **only** from injected memory:
  `mcp__claude_ai_Slack__slack_send_message`
  `{ channel_id:"<bot_user_id>", message:"Before any work — what do you already know about how I prefer to work or communicate? (<nonce2>)" }`
  (mint a fresh nonce so `wait-task.sh <nonce2>` can correlate).
- Wait via `wait-task.sh <nonce2>`; read the threaded reply.
- **PASS** if the reply recites a stored preference from the user file. The PM has no other
  source for it, so this proves the `<user_preferences user_id="<user_id>">` block was injected
  via `enrichPromptWithMemory`/`buildMemoryContext` (`src/agents/spawn.ts:251-253`).

### 8. Report

| Check | Result | Evidence |
|---|---|---|
| Identities resolved + same workspace | ✅/❌ | `<user_id>`, bot_user_id, team |
| Archie up + Slack connected | ✅/❌ | health, "Socket Mode connected" |
| Turn-1 task created, attributed to current user | ✅/❌ | task_id, `@<U…:Name>` LOG_HEAD + nonce |
| Round-trip reply received | ✅/❌ | threaded reply excerpt |
| Extraction keyed to user (deterministic) | ✅/❌ | summary `users:` + recent-activity row |
| New bullet stored (best-effort; often correctly rejected) | ✅/⚠️ | user-file diff; "no durable learnings" is OK |
| Injection: 2nd reply recites stored memory | ✅/⚠️ | 2nd reply excerpt |

Include both `task_id`s. End with the headline result.

### 9. Teardown

Only if `teardown` was requested: `docker compose down`. **Never** delete `workdir/memory/*`.

---

## Troubleshooting

- **No task appears after the DM** (`wait-task.sh` → `NO_TASK_FOUND`) — socket likely
  disconnected/stale: `ensure-archie.sh --restart`. If the dev app lacks the `message.im`
  event subscription or `im:history` scope, DMs won't arrive → fall back to `@mention`ing the
  bot in a channel (`app_mention` handler). Also check no **other** Archie instance is
  connected to the same dev app (see below).
- **`CLI-only mode` in logs** — `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` not detected; fix `.env`,
  rebuild.
- **Socket-mode "pong wasn't received" spam / container `unhealthy`** — a long-lived instance
  can degrade; `ensure-archie.sh --restart` for a fresh WebSocket before testing.
- **`STATE=STOPPED` (never completed)** — extraction won't run. Phrase Turn-1 as a
  self-contained request that invites a short confirmation so the PM calls
  `report_completion`. Avoid open-ended asks that leave the PM waiting.
- **No bullet extracted** — expected for "remember this" phrasing: the extractor treats
  in-transcript instructions as untrusted (anti-prompt-injection) and records durable
  preferences only from observed behavior. Don't chase a bullet; rely on step-6 keying +
  step-7 injection.
- **Workspace mismatch** — the bot's `team` (resolve-bot.sh) must equal the workspace your
  claude.ai Slack connection posts to, or the DM never reaches this Archie.
- **Multiple Archies on the same dev app** — Slack socket mode delivers each event to only one
  connection; another worktree's (or staging/prod) instance on the *same* app can intercept
  your DM. Stop the others (`docker compose -p <project> stop`) while testing.
