---
name: archie-e2e
description: Test Archie full-cycle on your machine. Boots Archie in Docker, talks to it as your real Slack user by DMing the dev bot via the claude.ai Slack MCP, observes the task through the archie-debug MCP, and verifies the memory layer end-to-end (extraction keying + injection). Use to smoke-test a Slack → PM → memory round-trip locally without writing throwaway scripts.
license: MIT
metadata:
  author: archie-hq
  version: "1.2"
---

# Archie full-cycle E2E harness

Drive a **real Slack round-trip** against a locally dockerized Archie and verify the memory
layer. Input goes in as your actual Slack user (so it keys to your `U…` id); observation is via
the existing `archie-debug` MCP; memory is read off the mounted `./workdir`. **No Archie code
changes — this skill only orchestrates tools that already exist.**

```
claude.ai Slack MCP (posts as you)  →  DM the dev Archie bot
   →  dockerized Archie (dev Slack app, socket mode) receives it as your U… id
   →  PM agent processes, replies in the DM (threaded under your message)
   →  archie-debug MCP observes task/events/log + approves gates
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

- **claude.ai Slack MCP** — `mcp__claude_ai_Slack__slack_send_message` (DM the bot: set
  `channel_id` to the bot's user id), `…slack_read_thread` (read the bot's threaded reply),
  `…slack_read_channel` (DM history), `…slack_search_users`.
- **archie-debug MCP** — `mcp__archie-debug__list_tasks`, `…task_status`, `…get_log`,
  `…get_events`, `…approve`. (Observation only — never for input.)
- **Bash + Read** — Docker lifecycle, `auth.test`, minting a nonce, reading `workdir/memory/*`.

## Inputs (all optional)

- `slack_user_id` — your Slack id. Default **`U03RQQTE1EF`** (Igor Sova).
- `bot_user_id` — the dev bot to DM. Default resolved at runtime from `SLACK_BOT_TOKEN`
  (currently **`U0AT3BYG99C`** = `archie_test`, team `T03PDDDEK`, DM channel `D0AUZLR6ZJQ`).
- `teardown` — `docker compose down` at the end. Default **false** (leave running).
- `restart` — force a clean container restart first. Default **auto** (restart if the container
  is unhealthy or its recent logs are socket-mode warning spam).

Use `AskUserQuestion` only if `.env` / tokens are missing — otherwise run with defaults.

## Worktree / port awareness

Each worktree is its own compose project (project name = dir name) running its own Archie.
The worktrunk pre-start hooks (`.config/wt.toml`) copy `.env` from the base worktree and assign
a **unique PORT** (`hash_port`) so worktrees don't collide on 3000. Consequences:

- All `localhost` URLs below use `$PORT` from this checkout's `.env` (fallback 3000) — derived in step 1.
- The `archie-debug` MCP defaults to `http://localhost:3000`; when PORT differs it must be
  repointed (step 1).
- A **fresh worktree's `workdir/` starts empty** — no prior memory. Step-7 injection needs an
  already-stored bullet; on a first run accept step-6 extraction-keying as the proof. Memory
  assertions also require the checkout to actually contain the memory layer (`src/memory/`).

---

## Steps

Track progress with `TodoWrite`. Stop and report on any hard failure.

### 1. Preconditions

```bash
cd <repo-root>   # the dir with docker-compose.yml
python3 - <<'PY'
env={}
for line in open('.env'):
    line=line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k,v=line.split('=',1); env[k.strip()]=v.strip().strip('"').strip("'")
for v in ['ANTHROPIC_API_KEY','SLACK_BOT_TOKEN','SLACK_APP_TOKEN']:
    print(f"{v}: {'present' if env.get(v) else 'MISSING'}")
print("ARCHIE_MEMORY:", env.get('ARCHIE_MEMORY','(unset -> enabled)'))
print("PORT:", env.get('PORT','3000'))
PY
PORT=$(grep '^PORT=' .env | head -1 | cut -d= -f2-); PORT=${PORT:-3000}
```

- All three keys must be `present` (never print token VALUES). `SLACK_APP_TOKEN` (xapp-) is
  required for socket mode. `ARCHIE_MEMORY` must not be `false`.
- Confirm the `archie-debug` and `claude.ai Slack` MCPs are connected.
- If `PORT` ≠ 3000, repoint the `archie-debug` MCP: set `ARCHIE_URL=http://localhost:<PORT>`
  (an `"env"` block on the `archie-debug` entry in `.mcp.json`, or export it before launching
  Claude Code), then reconnect the MCP. Otherwise its tools talk to the wrong Archie.

### 2. Resolve the dev bot + confirm same workspace

```bash
python3 - <<'PY'
import json,urllib.request
env={}
for line in open('.env'):
    line=line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k,v=line.split('=',1); env[k.strip()]=v.strip().strip('"').strip("'")
tok=env['SLACK_BOT_TOKEN']
req=urllib.request.Request('https://slack.com/api/auth.test',
    headers={'Authorization':f'Bearer {tok}'},method='POST')
d=json.load(urllib.request.urlopen(req,timeout=10))
print("ok:",d.get('ok'),"bot_user_id:",d.get('user_id'),"bot_user:",d.get('user'),
      "team:",d.get('team'),d.get('team_id'),"err:",d.get('error'))
PY
```

- `user_id` → the **`bot_user_id`** to DM. `team_id` → the bot's workspace.
- The bot must be in the **same workspace** you post from (the Slack MCP's self id is
  `U03RQQTE1EF`; Sweatcoin = `T03PDDDEK`). If `team_id` differs, **stop** — the DM can't reach it.

### 3. Boot / ensure a healthy Archie in Docker

```bash
curl -fsS -m 5 "http://localhost:${PORT:-3000}/health" && echo " UP" || echo " DOWN"
docker compose ps
```

- **Down** → `docker compose up --build -d`, then wait for health (curl's own retry avoids a
  foreground sleep): `curl --retry 40 --retry-delay 2 --retry-all-errors -fsS "http://localhost:${PORT:-3000}/health"`.
- **Up but unhealthy, or recent logs are socket-mode pong/ping warning spam** → restart for a
  clean socket: `docker compose restart archie`, then wait for health again.
- Confirm Slack is connected (not CLI-only):

```bash
docker compose logs --since 2m archie 2>/dev/null | grep -iE "socket mode connected|cli-only|bot user id"
```

  Expect `Slack: Socket Mode connected` and `[Slack] Bot user ID: …`. A `CLI-only mode` line
  means tokens weren't detected → fix `.env`, rebuild.

### 4. Turn 1 — DM as yourself (the attribution proof)

Mint a nonce:

```bash
echo "E2E-$(openssl rand -hex 4)"   # e.g. E2E-a9c9ffa5
```

- Snapshot existing tasks: `mcp__archie-debug__list_tasks` (note the newest id).
- Send the DM (posts as you):
  `mcp__claude_ai_Slack__slack_send_message`
  `{ channel_id: "<bot_user_id>", message: "Noting for context: I like deploys on Friday afternoons. Reply 'noted'. (<nonce>)" }`
  Capture the returned **channel** (`D…`) and message **ts** from the response.
- **Correlate**: poll `mcp__archie-debug__list_tasks` (~every 3–5 s, up to ~30 s) for a new
  `task-…` not in the snapshot. Confirm with `mcp__archie-debug__get_log {task_id}` — the first
  user line should read `[@<U03RQQTE1EF:Igor Sova> in slack:#<D…:DM with Igor Sova>:<ts>] …`
  and contain the nonce. **That `@<U03RQQTE1EF:…>` marker is the attribution proof.** Record `task_id`.

> Note: `task_owner`/`participants` are **agent** names (e.g. `backend-agent`), NOT the
> requester — don't assert on them for user identity. The requester only lives in the transcript
> marker above.

### 5. Wait for completion + read the reply

- Poll events: `mcp__archie-debug__get_events {task_id, after:<cursor>}`, advancing `after` to the
  returned `Cursor` each call (or run a background `curl` loop on
  `http://localhost:$PORT/api/tasks/<id>/events`). Stop conditions:
  - `task:completed` → **done, extraction will run.**
  - `approval:requested` (data `approvalType` ∈ `edit_mode|research_budget`) →
    `mcp__archie-debug__approve {task_id, type:<approvalType>, approve:true}`, then keep polling.
  - `task:stopped` → stopped **without** completion → no extraction (see Troubleshooting).
- Read the bot's reply. **Archie threads its reply under your DM message** (verified), so:
  `mcp__claude_ai_Slack__slack_read_thread { channel_id:"<D… from step 4>", message_ts:"<ts from step 4>" }`
  (fall back to `slack_read_channel` for top-level). Assert a coherent, non-empty reply — the
  round-trip proof. (It also appears as a `message` event `from:"pm-agent" to:"user"`.)

### 6. Verify EXTRACTION keyed to you (read mounted `./workdir`, with retry)

Extraction is **async** (queued on `task:completed`); the summary file appears when it finishes.
Poll for up to ~90 s.

- **Deterministic (primary) — this is the real proof:**
  - `Read workdir/memory/summaries/<task_id>.md` → YAML `users:` block lists `id: U03RQQTE1EF`.
  - `Read workdir/memory/recent-activity.md` → a row for `<task_id>` with `User = U03RQQTE1EF`.
  - Written unconditionally by `writeSummary`/`appendActivity` (`src/memory/lifecycle.ts:194,198`),
    so they prove the message was attributed to you and keyed to your id.
- **Best-effort (secondary):**
  - `Read workdir/memory/users/U03RQQTE1EF.md`. A new bullet may or may not appear: the
    extractor errs on extracting *less* and, importantly, **rejects explicit "please remember X"
    instructions as an untrusted prompt-injection surface** — verified: such a Turn-1 yields a
    summary of `## Memory Updates: _no durable learnings_`. **Expect no new bullet from
    instruction-style input; that is correct, not a failure.** Never fail the run on a missing bullet.

### 7. Verify INJECTION — behavioral 2nd turn

Ask about memory the user file **already** holds (don't rely on Turn-1 having written a new
bullet — it usually won't, per step 6). First `Read workdir/memory/users/U03RQQTE1EF.md` to see
what's stored (e.g. "prefers concise, as short as possible answers").

- Send a 2nd DM (new top-level message → new task), answerable **only** from injected memory:
  `mcp__claude_ai_Slack__slack_send_message`
  `{ channel_id:"<bot_user_id>", message:"Before any work — what do you already know about how I prefer to work or communicate?" }`
- Correlate + wait for the new task (steps 4–5); read its threaded reply.
- **PASS** if the reply recites the stored preference. Verified example reply:
  *"Just one note on file: you prefer concise, as-short-as-possible answers."* The PM has no
  other source for this, so it proves the `<user_preferences user_id="U03RQQTE1EF">` block was
  injected via `enrichPromptWithMemory`/`buildMemoryContext` (`src/agents/spawn.ts:251-253`).

### 8. Report

| Check | Result | Evidence |
|---|---|---|
| Bot resolved + same workspace | ✅/❌ | bot_user_id, team_id |
| Archie up + Slack connected | ✅/❌ | health, "Socket Mode connected" |
| Turn-1 task created, attributed to you | ✅/❌ | task_id, `@<U03RQQTE1EF…>` log line + nonce |
| Round-trip reply received | ✅/❌ | threaded reply excerpt |
| Extraction keyed to you (deterministic) | ✅/❌ | summary `users:` + recent-activity row |
| New bullet stored (best-effort; often correctly rejected) | ✅/⚠️ | user-file diff; "no durable learnings" is OK |
| Injection: 2nd reply recites stored memory | ✅/⚠️ | 2nd reply excerpt |

Include both `task_id`s. End with the headline result.

### 9. Teardown

Only if `teardown` was requested: `docker compose down`. **Never** delete `workdir/memory/*`.

---

## Troubleshooting

- **No task appears after the DM** — socket likely disconnected/stale. Check
  `docker compose logs --since 2m archie | grep -i "socket mode"`; restart the container. If the
  dev app lacks the `message.im` event subscription or `im:history` scope, DMs won't arrive →
  fall back to `@mention`ing the bot in a channel (`app_mention` handler).
- **`CLI-only mode` in logs** — `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` not detected; fix `.env`, rebuild.
- **Socket-mode "pong wasn't received" spam / container `unhealthy`** — a long-lived instance can
  degrade; `docker compose restart archie` for a fresh WebSocket before testing.
- **Task never `task:completed` (only idle/`task:stopped`)** — extraction won't run. Phrase
  Turn-1 as a self-contained request that invites a short confirmation so the PM calls
  `report_completion`. Avoid open-ended asks that leave the PM waiting.
- **No bullet extracted** — expected for "remember this" phrasing: the extractor treats
  in-transcript instructions as untrusted (anti-prompt-injection) and records durable preferences
  only from observed behavior. Don't chase a bullet; rely on step-6 keying + step-7 injection.
- **Workspace mismatch** — the bot's `team_id` (auth.test) must equal the workspace your
  claude.ai Slack connection posts to, or the DM never reaches this Archie.
- **Multiple Archies on the same dev app** — Slack socket mode delivers each event to only one
  connection; a staging/prod instance on the *same* app can intercept your DM. Use the dev app
  exclusively while testing.
