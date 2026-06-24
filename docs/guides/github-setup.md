# GitHub App Setup

Archie talks to GitHub through a **GitHub App** (not a personal access token). The App authenticates as an installation, opens and manages pull requests, reads CI results, and pushes branches. This guide walks a self-hoster through creating the App, wiring the webhook, installing it, and setting the environment variables — and lists the **exact repository permissions and webhook events** the engine needs.

GitHub is **optional**: Archie runs fine in CLI/Slack-only mode without it. You only need a GitHub App if you want repo agents that open and manage PRs.

## 1. Create the GitHub App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App** (under your user or org).

- **Name:** anything (e.g. `my-archie`). The slug GitHub derives becomes `GITHUB_APP_SLUG`.
- **Homepage URL:** any valid URL.
- **Webhook → Active:** ✅ enabled.
  - **Webhook URL:** `https://<your-host>/webhooks/github`
  - **Webhook secret:** generate a strong random string; you'll set it as `GITHUB_WEBHOOK_SECRET`.
- Set the **repository permissions** and **subscribe to events** per the tables below.
- **Where can this App be installed:** "Only on this account" is fine for self-hosting.

## 2. Repository permissions

Set exactly these under **Permissions → Repository permissions**. Each line notes whether it's required and what it enables. (This list is derived from the engine's GitHub integration code — the API calls in `src/connectors/github/` and the webhook handlers in `src/connectors/github/webhooks.ts`.)

| Permission | Access | Required? | Enables |
|---|---|---|---|
| **Metadata** | Read | **Required** (mandatory) | Baseline repository access. GitHub auto-requires this for every App. |
| **Contents** | Read & write | **Required** | Clone repositories (read) and push branches/commits (write) using the installation token; also required to merge a PR. |
| **Pull requests** | Read & write | **Required** | Open / update / close / merge PRs; list & read PRs and reviews; post and reply to inline review comments; resolve review threads; request re-reviews; post and read PR conversation comments. Also governs receipt of the `pull_request`, `pull_request_review`, `pull_request_review_comment`, and `issue_comment` events. |
| **Checks** | Read | **Required** | Read check runs on a PR's head commit and individual check runs + annotations (the "are CI checks green?" and failure-detail features). Also governs the `check_suite` event. |
| **Commit statuses** | Read | **Required** | Read legacy combined commit statuses (`/commits/{ref}/status`) — some CIs report as statuses rather than check runs. |
| **Actions** | Read | **Required** | Read workflow runs, their jobs, and failing job-log tails (`/actions/runs/...`, `/actions/jobs/{id}/logs`). Also governs the `workflow_run` event. |
| **Workflows** | Read & write | **Required** | Commit or modify files under `.github/workflows/`. Without it, **any push that touches a workflow file is rejected** by GitHub — which matters because repo agents can edit CI. |
| **Code scanning alerts** | Read | **Optional** | Read the security findings shown in a repo's **Security tab** (e.g. CodeQL) via `/code-scanning/alerts` — powers the `list_code_scanning_alerts` and `get_code_scanning_alert` repo-agent tools. Grant this only if you want agents to review code scanning results; without it those tools return a 403 with a hint to enable the permission. |
| **Issues** | Read | **Optional** | The engine **never writes issues** and never comments on standalone (non-PR) issues. It only posts/reads comments on **pull requests** — which, because PRs are issues, is authorized by **Pull requests: write/read**, not by Issues. The `issue_comment` event is likewise covered by **Pull requests: read**. Grant **Issues: Read** only if you additionally want to support standalone issues; `write` is not needed. |

No other repository permissions are needed. The engine makes **no** calls requiring Administration, Deployments, Packages, Secrets, Members, or Organization permissions (branch protection is configured by you in repo settings, not by the App).

## 3. Subscribe to webhook events

Under **Subscribe to events**, enable exactly these. All seven are handled by the engine's router (`determineRouteAction` in `src/connectors/github/webhooks.ts`); each drives a specific behavior.

| Event | Required? | Governing permission | What it drives in Archie |
|---|---|---|---|
| **Pull request** (`pull_request`) | **Required** | Pull requests: read | `opened` / `synchronize` → run merge checks; `closed` → update the owning task. |
| **Pull request review** (`pull_request_review`) | **Required** | Pull requests: read | `approved` → merge check; `changes_requested` / `commented` → wake the task to address feedback. |
| **Pull request review comment** (`pull_request_review_comment`) | **Required** | Pull requests: read | Inline code-review comments → wake the task to respond. |
| **Issue comment** (`issue_comment`) | **Required** | Pull requests: read | New PR conversation comment → wake the task (deduped by last processed comment id). |
| **Push** (`push`) | **Required** | Contents: read | New commits on a PR branch → re-run merge checks. |
| **Workflow run** (`workflow_run`) | **Required** | Actions: read | CI finished: `success` → merge check; `failure` → wake the task with the failure detail. |
| **Check suite** (`check_suite`) | **Required** | Checks: read | CI check suite completed → "checks ready" routing for the PR. |

If you knowingly don't use a given signal (e.g. you have no CI), you can omit its event — the engine simply won't receive it. For the full PR lifecycle, subscribe to all seven.

## 4. Generate and install the private key

1. On the App's page, **Generate a private key**. GitHub downloads a `.pem` file — store it securely on the host and point `GITHUB_APP_PRIVATE_KEY_PATH` at it.
2. **Install the App** on the account/org and select the repositories Archie should work in (**Install App → choose repos**).
3. After installing, note the **installation ID** — it's the numeric segment in the install settings URL (`.../installations/<INSTALLATION_ID>`). This is `GITHUB_INSTALLATION_ID`.
4. Note the numeric **App ID** (top of the App's General page) → `GITHUB_APP_ID`, and the App's **slug** (from its public URL) → `GITHUB_APP_SLUG`.

> Whenever you change permissions or events later, each installation must **re-accept** the new access (GitHub → org/account → Installed GitHub Apps → Configure). Until accepted, calls needing the new scope return 403.

## 5. Environment variables

Set these in `.env` (see `.env.example`):

```bash
GITHUB_APP_ID=123456                                   # App ID (General page)
GITHUB_APP_SLUG=my-archie                              # App slug; used to recognize and ignore the App's own events (prevents loops)
GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app.pem   # path to the downloaded .pem
GITHUB_INSTALLATION_ID=12345678                        # installation ID
GITHUB_WEBHOOK_SECRET=your-webhook-secret              # must match the App's webhook secret
```

The engine authenticates as the installation (`@octokit/app`) and pushes git over HTTPS using a short-lived installation token (`x-access-token`), so no SSH key or personal token is involved for App-driven work.

## 6. Verify

- Confirm the daemon is reachable at `https://<your-host>/webhooks/github` and that GitHub's webhook **Recent Deliveries** show `200`s.
- Open a test PR in an installed repo and confirm Archie reacts (it acknowledges PR/review/CI events).
- `scripts/test-git-auth.ts` exercises the App credentials and git askpass flow end to end.

## Related

- [Local Development](local-development.md) — full local setup
- [Deployment](deployment.md) — production deployment and CI
- [GitHub Integration](../architecture/github-integration.md) — how the engine routes GitHub events internally
