---
name: tart-runner-verify
description: Verification ladder for the Tart/Orchard runner subsystem (src/runners/) — static gates, unit/contract tests, a no-Docker config fail-fast smoke, a live disabled-mode /health smoke, and the opt-in real-Orchard canary. Use when asked to "test the runner changes", "verify the tart runner branch", "check that runners work", or before opening/merging a PR that touches src/runners/, runner wiring in spawn.ts/task.ts/index.ts, or docs/architecture/runners.md.
---

# tart-runner-verify — verification ladder for the runner subsystem

Verifies the opt-in Tart VM runner subsystem (see `docs/architecture/runners.md`): Archie stays the control plane, allowlisted repository agents get generic `runner-tools`, and the whole subsystem is inert when `ARCHIE_RUNNERS_CONFIG` is unset.

Tiers are ordered cheap-to-expensive. Always run tiers 1–3. Run tier 4 when Docker is available. Run tier 5 only on explicit user request with real Orchard credentials. Report every tier as PASS / FAIL / SKIPPED (with reason) — never fake a pass, never silently omit a tier.

## Tier 1 — static gates

```bash
npm run typecheck && npm run build
```

Pass: both exit 0. (`npm run lint` is declared but the repo has no ESLint dependency or config — do not count it as a gate.)

## Tier 2 — full unit + contract suite

```bash
npm test
```

Run the full suite, not just runner tests: the runner branch touches shared files (`src/agents/spawn.ts`, `src/tasks/task.ts`, `src/system/event-bus.ts`, `src/index.ts`), so regressions can land anywhere. Pass: exit 0 with `src/runners/__tests__/` (config, manager, orchard-provider, transfer) and `src/agents/__tests__/tool-contract.test.ts` green; `orchard.e2e.test.ts` reports skipped (it is the tier-5 canary, gated on `ARCHIE_ORCHARD_E2E=true`).

For fast iteration on runner-only edits: `npx vitest run src/runners src/agents/__tests__/tool-contract.test.ts` (expect ~22 passed, 1 skipped; counts grow over time).

## Tier 3 — config fail-fast smoke (no Docker)

Proves the startup gates behave outside vitest: subsystem disabled when `ARCHIE_RUNNERS_CONFIG` is unset, hard error on missing Orchard service-account secrets, hard error on a missing profile guest password, and a clean load with the full environment. Run from the repo root; the script must use the `.mts` extension (a bare `.ts` in a tmp dir is inferred as CJS and top-level await fails).

```bash
TMP=$(mktemp -d) && cat > "$TMP/runners.json" <<'JSON'
{
  "version": 1,
  "instanceId": "verify-smoke",
  "orchard": { "baseUrl": "https://orchard.invalid", "context": "default" },
  "profiles": {
    "smoke": {
      "image": "ghcr.io/example/img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "passwordEnv": "SMOKE_GUEST_PASSWORD",
      "allowedAgents": ["backend-agent"]
    }
  }
}
JSON
cat > "$TMP/smoke.mts" <<TS
import { loadRunnerConfig } from '$PWD/src/runners/config.js';

const path = process.env.SMOKE_CONFIG!;
const fail = (msg: string) => { console.error(\`FAIL: \${msg}\`); process.exit(1); };

if (await loadRunnerConfig({}) !== null) fail('expected null when ARCHIE_RUNNERS_CONFIG unset');
console.log('OK: disabled when ARCHIE_RUNNERS_CONFIG unset');

await loadRunnerConfig({ ARCHIE_RUNNERS_CONFIG: path }).then(
  () => fail('expected missing-secrets error'),
  () => console.log('OK: fail-fast on missing Orchard service account'),
);

await loadRunnerConfig({ ARCHIE_RUNNERS_CONFIG: path, ORCHARD_SERVICE_ACCOUNT_NAME: 'n', ORCHARD_SERVICE_ACCOUNT_TOKEN: 't' }).then(
  () => fail('expected guest-password error'),
  () => console.log('OK: fail-fast on missing guest password'),
);

const loaded = await loadRunnerConfig({ ARCHIE_RUNNERS_CONFIG: path, ORCHARD_SERVICE_ACCOUNT_NAME: 'n', ORCHARD_SERVICE_ACCOUNT_TOKEN: 't', SMOKE_GUEST_PASSWORD: 'p' });
if (loaded?.config.instanceId !== 'verify-smoke') fail('expected loaded config');
console.log('OK: loads with full env');
TS
SMOKE_CONFIG="$TMP/runners.json" npx tsx "$TMP/smoke.mts"; SMOKE_EXIT=$?; rm -rf "$TMP"; exit $SMOKE_EXIT
```

Pass: four `OK:` lines and exit 0.

## Tier 4 — live disabled-mode smoke (Docker)

Boot from the branch with the archie-e2e harness — load the `archie-e2e` skill and use its boot/teardown scripts, do not hand-roll compose. Boot preflight requires a repo-root `.env` with a non-empty `ANTHROPIC_API_KEY` and a running Docker daemon; further caveats (port handling, credential-helper hangs, cloud-sandbox TLS) are documented in that skill. If `.env` lacks GitHub App credentials, `workdir/plugins` must point at plugins that declare no private repos (e.g. `ln -sfn ../examples/plugins workdir/plugins`) — otherwise startup dies cloning the first declared repo (`Missing GitHub App configuration`) and the instance never turns healthy.

```bash
npx tsx tools/e2e/boot.ts            # prints ARCHIE_URL=... on success
curl -fsS "$ARCHIE_URL/health" | jq .runners
npx tsx tools/e2e/teardown.ts
```

Pass: `/health` contains exactly `{"enabled": false, "degraded": false, "activeLeases": 0}` (the boot environment must not set `ARCHIE_RUNNERS_CONFIG`), and the container log shows `Runners: disabled (ARCHIE_RUNNERS_CONFIG is not set)`. This proves the disabled path adds zero risk to a default deployment. Optionally run the harness's `basic-nonce` recipe to confirm normal task flow is unaffected. Always finish with a clean teardown exit.

## Tier 5 — real Orchard canary (opt-in, credentials required)

Never run without an explicit user request plus real credentials: it provisions a real Tart VM on the shared Orchard pool. Use a disposable `ARCHIE_WORKDIR` — the harness writes lease audit state there.

```bash
ARCHIE_ORCHARD_E2E=true \
ARCHIE_RUNNERS_CONFIG=<path> \
ORCHARD_SERVICE_ACCOUNT_NAME=<name> ORCHARD_SERVICE_ACCOUNT_TOKEN=<token> \
<each profile passwordEnv>=<password> \
ARCHIE_ORCHARD_E2E_PROFILE=<profile> ARCHIE_ORCHARD_E2E_AGENT=<agent-id> ARCHIE_ORCHARD_E2E_REPO_PATH=<local-repo> \
ARCHIE_WORKDIR=$(mktemp -d) \
npx vitest run src/runners/__tests__/orchard.e2e.test.ts
```

Optional: `ARCHIE_ORCHARD_E2E_COMMANDS` (JSON array of argv arrays for an app-specific canary; defaults verify Xcode, `simctl`, and LLDB toolchains), `ARCHIE_ORCHARD_E2E_GITHUB`. The canary provisions, syncs, execs, detaches/reconnects, validates the VNC handoff, releases, and confirms Orchard deleted the VM.

## Report format

One line per tier, then a verdict:

```
Tier 1 static gates: PASS
Tier 2 full suite:   PASS (846 tests; runner + contract green, canary skipped)
Tier 3 config smoke: PASS (4/4 OK)
Tier 4 live smoke:   SKIPPED (no Docker daemon)
Tier 5 canary:       SKIPPED (not requested / no credentials)
Verdict: runner subsystem verified at tiers 1-3.
```

A FAIL at any executed tier makes the verdict FAIL; quote the shortest decisive output line for each failure.
