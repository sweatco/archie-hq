# Running the E2E harness in a cloud sandbox (behind a TLS-intercepting proxy)

This is a cold-start runbook for getting the `archie-e2e` harness to a green run inside an ephemeral cloud container (e.g. Claude Code on the web / CI), where outbound HTTPS is transparently re-terminated by a policy proxy with its own root CA and non-HTTPS egress (port 22) is blocked. It complements the `archie-e2e` skill (which documents the harness lifecycle) and `local-development.md` (which covers a normal laptop). If you are on a laptop with direct internet, you do not need any of this — use `local-development.md`.

A fresh container needs the enabling code change (opt-in CA trust + `ssh-keyscan` made best-effort, all shipped in the repo) plus the environment-side setup below. The code change is a no-op without the CA file, so none of this affects normal setups.

## Prerequisites the environment must supply

- **Docker** (client + compose plugin). The daemon is usually not started for you.
- **An Anthropic API key**, but note: Claude Code strips `ANTHROPIC_API_KEY` from every tool/subprocess it spawns, so it will not be in your shell even if set. Provide it under a non-reserved name — in this sandbox it arrives as `E2E_ANTHROPIC_API_KEY` — and map it into `.env` (below). Other secrets (e.g. `GH_TOKEN`) are not stripped.
- **The proxy's root CA** on disk. In this sandbox it is `/root/.ccr/ca-bundle.crt`.

## One-time setup (all steps are local and gitignored)

Run from the repo root.

1. Start the Docker daemon detached, so it survives tool-call teardown, and wait for it:
   ```bash
   setsid dockerd >/tmp/dockerd.log 2>&1 </dev/null &
   until docker info >/dev/null 2>&1; do sleep 1; done
   ```
2. Write `.env`, mapping the non-reserved key var into the name the app expects (the value never needs to be printed):
   ```bash
   printf 'ANTHROPIC_API_KEY=%s\n' "$E2E_ANTHROPIC_API_KEY" > .env
   printf 'PORT=3000\n' >> .env
   chmod 600 .env
   ```
3. Stage the proxy CA where the dev image picks it up (the Dockerfile installs it before `npm ci` and sets `NODE_USE_SYSTEM_CA=1`; `.gitignore`/`.dockerignore` already handle this path):
   ```bash
   cp /root/.ccr/ca-bundle.crt secrets/extra-ca.crt
   ```
4. Give the workdir a plugin set and the container's runtime dirs:
   ```bash
   npm run example:setup                 # symlinks examples/plugins -> workdir/plugins
   mkdir -p claude-data && echo '{}' > claude-data/.claude.json
   ```
5. Fix bind-mount ownership for native-Linux Docker. The container runs as uid 1001 (`archie`); on native Linux the mounts keep host (root) ownership, so the app cannot create `/workdir/repos` etc. (Docker Desktop remaps this automatically and does not need it):
   ```bash
   chown 1001:1001 workdir claude-data
   chown -R 1001:1001 claude-data secrets
   ```

## Run the harness

Boot (build + health-poll). Launch detached with `setsid` — a foreground poll loop can hit the tool-call timeout and its SIGTERM would otherwise kill the build:
```bash
setsid bash -c 'npx tsx tools/e2e/boot.ts --timeout-seconds 480 > /tmp/boot.log 2>&1' </dev/null &
# then poll /tmp/boot.log for the terminal line:
#   ARCHIE_URL=http://localhost:3000     (success, with an "Attested:" line above it)
#   Boot failed ...                      (failure — read the diagnostics block)
```
Cold build is ~1–3 min; the first attempt after a Dockerfile change re-runs apt + `npm ci`. If the app comes up unhealthy with `EACCES /workdir/repos`, you missed step 5 — fix ownership and `docker compose restart archie`.

Drive the `basic-nonce` scenario. If the `archie-debug` MCP is registered in your session, use its tools (`create_task` → `wait_for_task` → assert). If it is not (common in a fresh session), drive Archie's HTTP API directly — the MCP is only a thin wrapper:
```bash
NONCE="E2E-$(openssl rand -hex 4)"
TASK=$(curl -fsS -X POST http://localhost:3000/api/tasks -H 'Content-Type: application/json' \
  -d "{\"message\":\"[$NONCE] What agents are configured in this instance? Reply with a short list and do not modify anything.\"}" \
  | grep -oE '"task_id":"[^"]+"' | cut -d'"' -f4)
# poll GET /api/tasks/$TASK for .metadata.status == completed, then read
# GET /api/tasks/$TASK/events (expect a message from pm-agent) and
# GET /api/tasks/$TASK (its .knowledgeLog must contain $NONCE)
```
A completed task with a PM reply is the real proof: it means a spawned agent CLI reached `api.anthropic.com` through the proxy (the CA propagation working end to end).

Capture evidence and tear down:
```bash
cat payload.json | npx tsx tools/e2e/evidence.ts --out-dir ./e2e-evidence   # writes <scenario>.{json,md}
npx tsx tools/e2e/teardown.ts                                               # docker compose down; verifies no containers remain
```

## Gotchas that cost time

- **Launch every long-running process with `setsid … </dev/null &`.** `nohup … &` alone does not survive a Bash tool-call timeout — the timeout SIGTERMs the whole process group and takes the build/daemon with it.
- **`npm ci` failing with `SELF_SIGNED_CERT_IN_CHAIN`** means the CA step (setup step 3) was skipped or the file was empty.
- **Agents "hang" or the task never completes** with the CA present usually means the CA is trusted in the parent but not forwarded to the spawned CLI — that forwarding is what the code change adds; make sure you are on the branch that has it.
- **`ssh-keyscan`** failing the build is the blocked-port-22 symptom; the branch makes it best-effort.

## What this does NOT cover

- **The `edit-mode-approval` scenario.** It needs (a) a repo-agent plugin in the workdir (the example plugins are generic only) and (b) GitHub credentials. Archie authenticates to GitHub exclusively as a **GitHub App** — both its API (Octokit) and git transport (`scripts/github-token.ts`) require `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_PATH` (a PEM in `secrets/`) + `GITHUB_INSTALLATION_ID`. The sandbox's built-in `GH_TOKEN` is a session token, not an App identity, and cannot be reused for this. `basic-nonce` needs no GitHub at all.
- **Daemon persistence.** `dockerd` is not a managed service here; if the container recycles, re-run step 1.
