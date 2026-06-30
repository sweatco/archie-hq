---
name: archie-e2e
description: Smoke-test Archie's Slack round-trip on your machine. Boots Archie in Docker (npm run docker:dev), DMs the dev bot as your real Slack user via the claude.ai Slack MCP, and observes the task through the archie-debug MCP — proving the DM is ingested via the real socket-mode path, attributed to your user, and answered by the PM. Use to verify a Slack → PM round-trip locally without writing throwaway scripts.
license: MIT
metadata:
  author: archie-hq
  version: "2.0"
---

# Archie Slack round-trip E2E harness

Drive a **real Slack round-trip** against a locally dockerized Archie. Input goes in as the
Slack MCP's **current authorized user** (so the task is attributed to their real `U…` id via the
socket-mode path, not the synthetic `cli` ingress); observation is via the existing
`archie-debug` MCP. **No Archie code changes — this skill only orchestrates tools that already
exist.**

```
claude.ai Slack MCP (posts as you)  →  DM the dev Archie bot
   →  dockerized Archie (dev Slack app, socket mode) receives it as your U… id
   →  PM agent processes, replies in the DM (threaded under your message)
   →  archie-debug MCP / REST API observes task/events/log + approves gates
```

Why Slack and not the debug MCP for *input*: the debug MCP's `create_task`/`send_message`
write `source:'cli'` log lines — a synthetic ingress. Only the Slack inbound path
(`src/connectors/slack/events.ts` → `task.append` → `appendSlackMessage`) runs the real
socket-mode handler and stamps the `@<U…:Name>` attribution marker, so DMing as your real user
is what actually exercises (and proves) the production Slack path end-to-end.

## Tools this skill uses

- **claude.ai Slack MCP** — `mcp__claude_ai_Slack__slack_read_user_profile` (resolve the
  current user — no `user_id`, `response_format:"detailed"`), `…slack_send_message` (DM the
  bot: `channel_id` = bot's user id), `…slack_read_thread` (the bot's threaded reply),
  `…slack_read_channel` (DM history).
- **archie-debug MCP** — `mcp__archie-debug__list_tasks`, `…task_status`, `…get_log`,
  `…get_events`, `…approve`. (Observation only — never for input. See port note below.)
- **Helper scripts** (this skill's `scripts/` dir — run with `bash`, they resolve the repo
  root themselves): `check-env.sh`, `resolve-bot.sh`, `ensure-archie.sh`, `wait-task.sh`.
- **Bash** — nonce minting; the helper scripts run under `bash`.

## Inputs (all optional)

- `teardown` — `npm run docker:stop` at the end. Default **false** (leave running).
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

---

## Steps

Track progress with `TodoWrite`. Stop and report on any hard failure.
`SKILL_DIR` below = this skill's directory (`.claude/skills/archie-e2e`).

### 1. Preconditions

```bash
bash SKILL_DIR/scripts/check-env.sh
```

Prints presence (never values) of `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
plus this checkout's `PORT`. Non-zero exit = missing key → stop. `SLACK_APP_TOKEN` (xapp-) is
required for socket mode. Note the printed `PORT` — it drives the debug-MCP/REST note above.

### 2. Resolve identities (current user + dev bot, same workspace)

- **Current user** (who the harness posts as):
  `mcp__claude_ai_Slack__slack_read_user_profile { response_format: "detailed" }` (no
  `user_id`) → record `User ID` as `<user_id>` and `Real Name` as `<user_name>`.
- **Dev bot**:

```bash
bash SKILL_DIR/scripts/resolve-bot.sh
```

  → `bot_user_id` (the DM target) and `team`. Non-zero exit = bad token → stop.
- **Same workspace check**: the bot's `team` must be the workspace your Slack MCP posts to
  (compare with the profile's organization). Mismatch → **stop**, the DM can't reach this Archie.

### 3. Boot / ensure a healthy Archie in Docker

```bash
bash SKILL_DIR/scripts/ensure-archie.sh          # boots if down (npm run docker:dev), waits until docker compose ps shows healthy
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
  line), `STATE=` and any `PM_REPLY:` lines. Assert `LOG_HEAD` contains the
  `@<<user_id>:<user_name>>` marker — that proves the DM was ingested via the real socket-mode
  path and attributed to your user (not the `cli` fallback). (Nonce correlation is already
  guaranteed: `wait-task.sh` located the task *by* matching the nonce in its log.)
- `STATE` handling:
  - `COMPLETED` → done.
  - `APPROVAL_REQUESTED` → `mcp__archie-debug__approve { task_id, type, approve: true }`
    (type from the event: `edit_mode` | `research_budget`), then re-run `wait-task.sh`.
  - `STOPPED` → ended without completion (see Troubleshooting).
  - `TIMEOUT` → inspect `mcp__archie-debug__task_status` / the events API.

> Note: `task_owner`/`participants` in task metadata are **agent** names (e.g.
> `backend-agent`), NOT the requester — don't assert on them for user identity. The requester
> only lives in the transcript marker above.

### 5. Read the reply on the Slack side

**Archie threads its reply under your DM message** (verified):
`mcp__claude_ai_Slack__slack_read_thread { channel_id:"<D… from step 4>", message_ts:"<ts from step 4>" }`
(fall back to `slack_read_channel` for top-level). Assert a coherent, non-empty reply — the
round-trip proof. (`wait-task.sh` already showed it as `PM_REPLY` from the events side.)

### 6. Report

| Check | Result | Evidence |
|---|---|---|
| Identities resolved + same workspace | ✅/❌ | `<user_id>`, bot_user_id, team |
| Archie up + Slack connected | ✅/❌ | `docker compose ps` healthy, "Socket Mode connected" |
| Turn-1 task created, attributed to current user | ✅/❌ | task_id, `@<U…:Name>` LOG_HEAD + nonce |
| Round-trip reply received | ✅/❌ | threaded reply excerpt |

Include the `task_id`. End with the headline result.

### 7. Teardown

Only if `teardown` was requested: `npm run docker:stop`.

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
- **`STATE=STOPPED` (never completed)** — phrase Turn-1 as a self-contained request that invites
  a short confirmation so the PM calls `report_completion`. Avoid open-ended asks that leave the
  PM waiting.
- **Workspace mismatch** — the bot's `team` (resolve-bot.sh) must equal the workspace your
  claude.ai Slack connection posts to, or the DM never reaches this Archie.
- **Multiple Archies on the same dev app** — Slack socket mode delivers each event to only one
  connection; another worktree's (or staging/prod) instance on the *same* app can intercept
  your DM. Stop the others (`docker compose -p <project> stop`) while testing.
