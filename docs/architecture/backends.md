# Backend Abstraction (Repo Host)

Archie's engineering path depends on a repo host -- where pull/merge requests, reviews, and CI live. A seam sits between Archie's business logic and that backend so either host can be selected without touching call sites. Two repo hosts are supported: GitHub and GitLab (self-hosted), both fully wired as `RepoHost` implementations. A resolver in `src/system/backends.ts` is the single place that picks the active host from the `REPO_HOST` env var.

## Overview

One port, one resolver:

```
                  src/system/backends.ts
                (REPO_HOST env resolution + gate)
                            |
                      RepoHost port
                  (src/ports/repo-host.ts)
                            |
                +-----------+-----------+
                |                       |
           GitHubHost               GitLabHost
     (GitHubClient, connectors/   (src/connectors/gitlab/)
           github/)
```

Callers never import `GitHubClient` directly to reach these capabilities -- they call `getRepoHost()` from `src/system/backends.ts` and get back a port-typed object. A related seam, `RepoHostEventSource`, normalizes inbound webhook events into a host-neutral `NormalizedEventContext`. GitLab's webhook handler (`src/connectors/gitlab/webhooks.ts`) implements it directly and does its own self-contained routing (wake the existing task, or discard) -- there is no shared cross-host router. GitHub's webhook path (`src/connectors/github/webhooks.ts`) does not use the port.

## The `src/ports/` interfaces

All of the interfaces (plus the shared domain types) live under `src/ports/` and are re-exported from `src/ports/index.ts`.

- `repo-host-types.ts` -- host-neutral domain types shared by `RepoHost` methods: `PRStatus`, `PRReview`, `ReviewThread`, `ReviewThreadComment`, `PRComment`, `PRChecksReport`, `PRCheckEntry`, `MergeableState`, `CheckConclusion` (extracted from `src/agents/tools.ts`), plus the canonical result/report shapes `CreatePRResult`, `PRListItem`, `PRListFilters`, `PRDetails`, `CheckRunAnnotation`, `CheckRunReport`, `WorkflowJobEntry`, `WorkflowRunReport`, `CodeScanningAlertInstance`, `CodeScanningAlert`, `CodeScanningAlertFilters` (relocated out of `connectors/github/client.ts`). Both `tools.ts` and `client.ts` re-export their respective sets so existing importers are unaffected. These are plain data shapes with no vendor types embedded: GitHub produces them directly, and `GitLabHost` maps its own API responses into the same canonical shapes rather than importing from a sibling connector.
- `capabilities.ts` -- the `RepoHostCapabilities` descriptor, plus the concrete `GITHUB_CAPABILITIES` and `GITLAB_CAPABILITIES_DEFAULT` constants (see "Capability descriptors" below).
- `repo-host.ts` -- the `RepoHost` interface: PR/MR lifecycle, reviews, CI checks, repo listing, and code-scanning alerts, keyed by `repo` as `"owner/name"`. Method names are PR-oriented (`getPRStatus`, `createPullRequest`, ...) -- a host-neutral CR-renaming is a possible later change (see limitations below).
- `repo-host-events.ts` -- `RepoHostEventSource` (signature verification, payload parsing, self-event detection) plus the host-neutral `NormalizedEventContext`, `InternalRouteAction`, and `RouteResult` types.
- `index.ts` -- barrel re-exporting all of the above, so consumers can `import { RepoHost, RepoHostEventSource, ... } from '../ports/index.js'`.

## Resolution -- `src/system/backends.ts`

One environment variable selects the active repo host:

- `REPO_HOST` -- defaults to `github` when unset. Supported values: `github`, `gitlab`.

`resolveRepoHostKind()` reads and normalizes (trim + lowercase) that variable. `assertBackendConfig()` validates the resolved value against the supported list and throws an actionable error if it is unsupported. When `REPO_HOST=gitlab`, `assertBackendConfig()` additionally requires `GITLAB_BASE_URL`, `GITLAB_TOKEN`, and `GITLAB_WEBHOOK_SECRET` to be set, and throws naming whichever are missing. `src/index.ts` calls `assertBackendConfig()` early in boot, before workdir bootstrap, so a misconfigured deployment fails fast instead of erroring deep inside webhook handling.

`getBackendMatrix()` returns `{ repoHost }` for the resolved kind. It backs both the boot-time log line (`Backends: repoHost=github`, or `repoHost=gitlab` when selected) and the `backends` field on the `GET /health` response, so the active configuration is observable at runtime without reading environment variables directly.

`getRepoHost(): RepoHost | null` hands callers a concrete, port-typed backend: it returns the `GitHubClient` singleton (via `getGitHubClient()`) when `REPO_HOST=github`, or the `GitLabHost` singleton (via `getGitLabHost()`) when `REPO_HOST=gitlab`. GitHub returns `null` when its App environment is not configured (mirroring pre-existing behavior; callers already handle a null host by disabling PR tools). Unsupported hosts return `null` defensively and log a warning, but in practice `assertBackendConfig()` has already rejected them at boot.

Call sites reach the active backend through `getRepoHost()` rather than importing `getGitHubClient()` directly (`src/agents/tools.ts`). `src/connectors/github/merge.ts` calls `createGitHubClient()` directly -- the merge orchestrator is GitHub-specific; making it host-agnostic is a possible later change.

## Vendor isolation

`@octokit` imports are confined to `src/connectors/github/`, and GitLab REST calls (`api/v4` paths, the `PRIVATE-TOKEN` header) are confined to `src/connectors/gitlab/` -- every GitLab REST call flows through the single `glRequest`/`glRequestAll` seam in `src/connectors/gitlab/http.ts`. `RepoHost` and `RepoHostEventSource` consumers elsewhere in the codebase depend only on the port types, never on a vendor SDK or a host's raw REST shape directly. This is a standing gate, not just a one-time check: a grep for `api/v4|PRIVATE-TOKEN` outside `connectors/gitlab` (and `@octokit` outside `connectors/github`) is expected to stay empty as the codebase grows.

## Capability descriptors

`src/ports/capabilities.ts` declares what each backend can and cannot do, so gaps are surfaced explicitly rather than failing silently (or crashing) when a less-capable backend is swapped in later.

`RepoHostCapabilities` describes: `reviewStates` (distinct approved/changes-requested review states vs. approvals-and-notes-only), `securityAlerts` (code-scanning/security-alert availability), `nativeAutoMerge` (host-native "merge when pipeline succeeds," which GitHub lacks and Archie orchestrates itself), and `reReviewRequest` (whether re-review can be requested from prior reviewers). `GITHUB_CAPABILITIES` sets `reviewStates`, `securityAlerts`, and `reReviewRequest` to `true` and `nativeAutoMerge` to `false`.

`GITLAB_CAPABILITIES_DEFAULT` is used as-is, fixed at construction, with no runtime probing: `reviewStates: true` (GitLab has no native `approved`/`changes_requested` review objects, but `GitLabHost.getPRReviews` synthesizes both -- `approved` from MR approvals, `changes_requested` from unresolved reviewer discussions -- so consumers see the same distinct review states as GitHub), `securityAlerts: false` (there is no license probe or vulnerability-to-code-scanning mapping, so code-scanning findings are not surfaced for GitLab), `nativeAutoMerge: true` (GitLab's native "merge when pipeline succeeds"; Archie does not orchestrate merges for GitLab, so nothing consumes it), and `reReviewRequest: false` (GitLab has no re-request-review primitive, so that call no-ops).

`RepoHost.capabilities()` returns this descriptor on the active backend instance, so callers can branch on capability rather than on backend kind. The `list_code_scanning_alerts` / `get_code_scanning_alert` tool handlers already do this: they short-circuit with a clear "not available on this repo host" message when `capabilities().securityAlerts` is `false`, so GitLab degrades gracefully instead of stubbing the methods.

## Scope: GitHub and GitLab repo hosts

Two repo hosts are wired today -- `github` (`GitHubHost`/`GitHubClient`, `src/connectors/github/`) and `gitlab` (`GitLabHost`, `src/connectors/gitlab/`):

- Any value for `REPO_HOST` other than `github` or `gitlab` is rejected as invalid by `assertBackendConfig()`.
- `REPO_HOST=gitlab` additionally requires `GITLAB_BASE_URL`, `GITLAB_TOKEN`, and `GITLAB_WEBHOOK_SECRET`; `assertBackendConfig()` throws naming whichever are missing.
- Git clone/fetch/push authentication (`scripts/git-askpass.sh`, `GIT_ASKPASS`) is GitHub-only. `RepoHost.askpassToken?()` exists as a typed optional accessor on the port and `GitLabHost` implements it (`src/connectors/gitlab/client.ts`), but nothing calls it -- wiring GitLab's git auth path is a future extension.

**Vendor isolation gate.** No GitLab REST call (`api/v4` paths, `PRIVATE-TOKEN` header) may appear outside `src/connectors/gitlab/` -- everything routes through `glRequest`/`glRequestAll` in `src/connectors/gitlab/http.ts`. This mirrors the pre-existing `@octokit`-confined-to-`connectors/github/` gate. Both should stay part of any future repo-host-adjacent PR's review.

## Limitations and future extensions

A few seam details are deliberately left thin, to avoid speculative abstraction:

- **`github → neutral` method/field rename.** `RepoHost` methods and shared types still use GitHub-flavored names (`getPRStatus`, `createPullRequest`, `githubRepo`, ...) even though `GitLabHost` implements the same interface. Renaming to host-neutral vocabulary (`getCrStatus`, `createChangeRequest`, ...) is a larger, mechanical, high-blast-radius change left for later.
- **`src/connectors/github/merge.ts` is GitHub-specific.** The merge orchestrator (`checkAndMergeLinkedPRs`) imports `createGitHubClient()` directly rather than going through `getRepoHost()`. Making merge orchestration host-agnostic, and adding any shared cross-host webhook router, are possible later changes.
- **`askpassToken()` is an unused seam.** `GitLabHost.askpassToken()` is implemented but not called anywhere; git authentication for clone/push flows entirely through the GitHub-only `scripts/git-askpass.sh`. Making git auth host-aware is a future extension.
- **License-tier capability probing is not implemented.** `GITLAB_CAPABILITIES_DEFAULT` is fixed at construction, so `securityAlerts` is `false` and code-scanning alerts are not surfaced for GitLab. Probing the instance's license tier (e.g. Ultimate, which exposes the vulnerability API) to raise `securityAlerts`, and mapping those findings to canonical code-scanning alerts, is a future extension.