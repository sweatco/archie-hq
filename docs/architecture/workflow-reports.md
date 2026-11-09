# Scheduled workflow reports

GitHub owns research scheduling and execution. Archie imports completed report artifacts, discusses them in one existing DM conversation and saves feedback for subsequent runs. Its GitHub App needs only Actions read; no GitHub token is exposed to the agent shell and no new scheduler or dispatch tool is added.

## Configure one report conversation

Create the conversation normally in the intended user's DM, then configure the deployment with its task ID. The target must already have a DM as its default channel; a request or webhook cannot supply a different destination.

```dotenv
ARCHIE_WORKFLOW_REPORT={"repository":"owner/mobile","workflow":"rn-ecosystem.yml","branch":"main","artifact":"rn-ecosystem-report","taskId":"task-20261109-0900-example"}
```

Leaving this unset disables the integration. Configuration is parsed at startup. The standard GitHub App credentials and signed `/webhooks/github` endpoint must already be configured, with the App subscribed to `workflow_run` events. No App permission upgrade is required.

The dedicated task can read `${ARCHIE_WORKDIR}/workflow-reports/<task-id>/`: `reports/<run-id>/`, pending feedback, captured submissions and delivery receipts. Only its `pending/` and `applied/` feedback queues are agent-writable; reports, captures, receipts and their parents stay host-owned. These are mounted as siblings because a read-only ancestor hides writable child mounts in the Claude CLI. Acknowledgement falls back to copy-then-delete across those mounts, keeping the pending record if copying fails. Feedback reads reject symlinks. All cycles reuse that conversation and folder. This MVP intentionally uses one continuing DM thread, rather than opening a fresh task/thread for every report.

## Feedback before research

The workflow requests an OIDC token with audience `archie-workflow-feedback` and calls:

```text
GET /webhooks/github/research-feedback?base_run_id=<restored-history-run-id>
Authorization: Bearer <GitHub OIDC token>
```

This narrow endpoint sits under the existing public webhook ingress; `/api` remains protected. It verifies GitHub's signature, issuer, audience, expiry, configured repository/workflow/branch and a scheduled or manual-dispatch event. Only that workload can read the research feedback; it cannot choose another task, repository or path. GitHub's short-lived workflow identity replaces a shared CI/operator secret.

The response captures pending filenames and decisions once per run. Repeated requests return that same capture; feedback arriving later stays pending. The workflow records the response as `submission.json`, validates its decisions against restored history and applies them before research. A feedback outage stops the job before model execution.

## Completion and conversation

The existing signed GitHub completion webhook recognizes the configured workflow's scheduled/manual default-branch runs. On success, the host's existing GitHub client reads the run and downloads its named artifact. It rechecks source/run identity, bounds the archive, rejects escaping paths and symlinks, and verifies the basic bundle and collection commit before waking the existing DM task. The agent receives REPORT and STORE paths and loads the repository's `rn-ecosystem-research` skill; it needs neither gh nor collector dependencies to process feedback.

Archie uses the existing feedback helper to acknowledge only the captured decisions that actually appear in the new successful state. Missing/mismatched decisions and feedback saved during the run remain pending. Source contents are data, not instructions. Reports remain suggestions, including technology experiments, with no quota or permission to implement them.

Failed runs produce a failure notice, not a successful report or an automatic paid retry. Receipts suppress ordinary duplicate completion delivery per run attempt. Delivery is not an exactly-once transaction across a process crash; an operator can reconcile a missing report from its artifact and webhook delivery. No recovery service is introduced.

## Rollout and checks

1. Publish and deploy the integration with the existing DM task binding; confirm the signed completion event subscription and that unauthenticated feedback requests return 401.
2. In the mobile repository set `RN_ECOSYSTEM_ARCHIE_URL` to Archie's origin. Keep `RN_ECOSYSTEM_SCHEDULE_ENABLED` off.
3. Run the research workflow manually once, using bootstrap only when hosted history is confirmed empty. Verify the complete report arrives in the bound DM.
4. Record explicit feedback with a reason, run a subsequent manual restore, and verify only the captured feedback is acknowledged after success. Keep new arrivals pending.
5. Enable `RN_ECOSYSTEM_SCHEDULE_ENABLED=true` only after that qualification. GitHub runs at 09:00 Europe/Lisbon on alternate calendar dates; month boundaries can differ from a strict 48-hour interval.

The research job's USD 5 estimated model stop does not include Archie's normal conversation/model usage. Local contract tests do not establish production delivery, model output quality or usefulness. A real GitHub run and feedback round-trip remain required rollout checks. The sandbox data grant also requires the live harness egress check before shipping, per the archie-e2e skill.
