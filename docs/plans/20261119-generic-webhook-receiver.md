# Generic webhook receiver and durable inbox (#401)

ID: 2026-11-19-generic-webhook-receiver-and-durable-inbox-401-553ff5
Created: 2026-11-19T01:03:28+00:00

**Status:** Implementation handoff for [#401](https://github.com/sweatco/archie-hq/issues/401). Stages 1–3 are implemented locally and uncommitted. The staging ingress check is open; it needs the infrastructure change.
**Sources:** `sweatco/archie-hq` at `d0e85a24` (2026-11-19); issues #400–#403; the [incoming events plan](20261116-incoming-events-shared-receiver.md), which owns the feature design; the private infrastructure repository at `0d0bde82` for ingress; the Standard Webhooks specification.
**First milestone:** Stage 1 — a signed delivery commits a receipt, and its retry returns the same one.

## Decision

Build the receiver, inbox and dispatcher as one module, `src/incoming/`, with its own SQLite file, and connect later work through one small consumer port. #401 ships the port and no production consumer; routines (#402) and proactivity (#406) plug into it.

This keeps Task, trigger and model code off the request path. Every acceptance criterion except the live ingress check can then be proven with a real Express app and a real database file.

`POST /webhooks/incoming/:inputId` → authenticate → one transaction (dedupe · match · receipt + payload + handoffs) → `202` → dispatcher claims a handoff → consumer handles it → finish; the last finish deletes the payload.

> A signed delivery to the mounted route returns `202` only after its receipt is committed. The same delivery again returns the same receipt and writes nothing.

## Scope

- **Covers:** the public route, bearer and Standard Webhooks authentication, duplicate detection, receipt/payload/handoff storage, the leased dispatcher, input create/pause/resume/delete operations with an operator CLI, process wiring behind a flag, and the owning architecture document.
- **Not prescribed yet:** numeric limits and timings. The parent plan's values are starting defaults; see Deferred.

| Non-goal | Reason |
|---|---|
| Routine consumer, `incoming_event` trigger condition, Task creation | #402 |
| Slack review, history, key reveal and rotation | #403 |
| MCP subscriptions, challenge, cursor | #404, #405. The receipt key reserves a `binding` for them. |
| Proactivity import | #406 |
| An `/api` route that creates inputs | The router is unauthenticated (`docs/architecture/tool-approvals.md:126`); it would hand out callback secrets. |
| Finishing the 2026-11-11 local prototype | It kept the inbox in the proactivity database and required `Idempotency-Key`. The parent plan decided against both. Its test scenarios are still useful. |

## What exists and what is missing

| Needed capability | Existing mechanism | Reuse, extend, or new |
|---|---|---|
| Shared HTTP app and connector mounts | `src/index.ts:153`, `:168-175` | Reuse; add one mount |
| Route-local raw body | `express.raw` on `/webhooks/github`, `src/connectors/github/events.ts:45-47`. The only JSON parser is router-scoped, `src/connectors/api/routes.ts:51`. | Reuse the pattern; add `inflate: false` and a limit |
| Durable acknowledgment | None. The GitHub route replies, then processes in memory (`events.ts:75-84`). | New |
| SQLite conventions | `DatabaseSync` with busy timeout, WAL, `synchronous=FULL`, foreign keys (`src/proactivity/store.ts:47-55`); synchronous `BEGIN IMMEDIATE` wrapper (`:143-153`) | Reuse the conventions in a new store |
| Lease pattern | Token and lease on claim, token-guarded finish (`store.ts:485-506`); attempts counted at claim (`:1009-1034`) | Reuse the pattern |
| Storage agents cannot read | `WORKDIR/initiative/state.sqlite` (`src/proactivity/runtime.ts:21-23`); the sandbox denies `WORKDIR` and re-allows named paths (`src/agents/spawn.ts:405`) | Reuse: `WORKDIR/incoming/` |
| Secret sealing | `encryptJson` / `decryptJson` (`src/system/secrets-vault.ts:62`, `:82`); sealed OAuth files (`src/system/oauth/storage.ts:58-60`) | Reuse |
| Signature verification | The GitHub route checks its HMAC with `node:crypto` in a dozen lines (`src/connectors/github/webhooks.ts:27-39`). | New: the same approach for the Standard Webhooks scheme, about 30 lines, no dependency |
| Shutdown gate | `getIsShuttingDown()` (`src/system/shutdown.ts:10`), used at `events.ts:49` | Reuse |
| Public exposure | Production ingress exempts `/webhooks/*` and `/oauth/*` from employee SSO and gates every other path. Read in the private infrastructure repository. | Reuse; production needs no ingress change |

Invariants to keep:

- The server listens only after Task recovery (`src/index.ts:203-211`). The dispatcher also starts after recovery.
- `/api` stays free of secrets and relies on ingress for privacy. This work adds no `/api` route and does not widen the SSO exemption.
- No `await` inside a SQLite transaction. The wrapper takes a synchronous function (`store.ts:143`).
- `/webhooks/github` and `/webhooks/slack` behave as before.
- Routines must work with proactivity off. `initInitiative` returns before opening its database in that mode (`src/proactivity/index.ts:19-20`). That database is also bound to one Slack workspace and refuses any schema version but its own (`src/proactivity/persistence/schema.ts:66-75`). So the inbox keeps its own file; sharing one would tie the two modules' startup and migrations together.

Missing:

1. **Durable inbox** — no store accepts external evidence before work starts.
2. **Duplicate identity** — nothing maps a sender's key to one receipt.
3. **Consumer seam** — #402 and #406 need one agreed way to receive a handoff.
4. **Provisioning before #403** — an input must exist to test the route on a running instance.
5. **Staging exposure** — the SSO exemption names only the production host.

Documentation drift, corrected in Stage 3: the deployment guide described inbound access as a firewall limited to Slack addresses.

## Design

### Request path

Steps run in this order. Each failure stops the request and starts no work.

1. Flag off: the route is not mounted. Storage failed to open: every delivery gets `503`.
2. Shutting down → `503`.
3. Look up the input by `:inputId` → `404` unknown, `410` deleted. No body has been read.
4. Bearer input: compare the token before reading the body → `401`.
5. Read the raw body with `express.raw({ type: 'application/json', inflate: false, limit })` → `413`, and `415` for an encoded body. The parser skips other media types without an error, so the handler returns `415` itself when the body is not a buffer, as `events.ts:62-66` does.
6. Signed input: verify `webhook-id`, `webhook-timestamp` and `webhook-signature` against the received bytes → `401`.
7. Decode as UTF-8 with a fatal decoder, then parse JSON; the value must be an object → `400`.
8. Check shutdown again, then run the receipt transaction.

The receipt transaction decides the reply. Cases are tested top to bottom.

| Case | Writes | Reply |
|---|---|---|
| Key has a receipt with the same digest | Nothing | `200`, the original `receipt_id` |
| Key has a receipt with a different digest | Conflict count and time on the original receipt | `409` |
| Input is paused | Body-less receipt, `ignored: paused` | `200` |
| The input's `filter` fails, or no consumer matches | Body-less receipt, `ignored: filtered` | `200` |
| Inbox is over capacity | Nothing | `429` |
| Otherwise | Receipt, payload, one handoff per matching consumer | `202` |

Rules:

- Duplicate detection comes before pause, filter and capacity. That ordering is what returns the same receipt when the inbox is full.
- Every `2xx` reply is `{ receipt_id, status }`. `status` is `accepted` for a new receipt, `duplicate` for a matching retry and `ignored` for a paused or filtered delivery.
- The signature and the digest cover the received bytes. Parsing uses a fatal decode of the same bytes; `Buffer.toString()` would silently replace invalid ones (run locally). A leading byte-order mark is accepted and stored as received.
- Replies and log lines carry an error category, never a parser or verifier message. `JSON.parse` errors can quote the input (run locally).
- A commit failure returns `503`. `202` is sent only after `COMMIT` returns.

Rejected: reply first and process afterwards, as the GitHub route does. A crash would lose the event. Limitation accepted: a signed input must read up to the size limit before it can authenticate, so ingress is the only defence against unauthenticated floods.

### Records

Only fields that carry a decision are shown.

```ts
type Input = {
  id: string; // random and unguessable; not a secret
  state: 'enabled' | 'paused' | 'deleted';
  auth: 'standard_webhooks' | 'bearer';
  secretRefs: string[]; // sealed vault records; one entry in #401
  filter: PointerCheck[]; // all must pass
  revision: number;
};
type PointerCheck =
  | { pointer: string; op: 'present' }
  | { pointer: string; op: 'equals'; value: JsonPrimitive }
  | { pointer: string; op: 'in'; values: JsonPrimitive[] };

type Receipt = {
  id: string;
  inputId: string;
  binding: string; // 'generic' here
  eventKey: string | null; // unique with inputId and binding; null when the sender gave no key
  digest: string; // SHA-256 of the raw body
  outcome: 'open' | 'closed' | 'ignored';
  ignoredReason?: 'paused' | 'filtered';
  conflicts: number;
};
type Payload = { receiptId: string; body: Uint8Array };

type Handoff = {
  id: string;
  receiptId: string;
  consumerKind: string;
  consumerId: string;
  snapshot: string; // consumer's JSON, fixed at receipt time
  state: 'pending' | 'accepted' | 'skipped' | 'cancelled' | 'failed';
  token: string | null;
  leaseUntil: number;
  attempts: number;
  dueAt: number;
  reservation: string | null; // consumer's durable progress marker
};
```

Rules:

- The event key is `webhook-id` for a signed delivery and `Idempotency-Key` for a bearer delivery. A bearer delivery without one has no key, so it is always new and can never be a retry or a conflict.
- One key maps to one receipt until receipt retention expires. An ignored receipt is final: the same key after resume returns the ignored receipt.
- A `Payload` row is the only place a body is stored. It exists exactly while its receipt has a pending handoff.
- `snapshot` and `reservation` belong to the consumer. The inbox does not interpret them, and a consumer must not copy the body into either.
- A filter is the input owner's list of conditions on the event JSON, for example "`/type` equals `meeting.ended`". Every condition must hold, or the delivery is recorded as ignored and its body is not kept. The parent plan defines the three condition kinds. A numeric condition value must be one JSON holds exactly, so equality cannot also match a neighbouring integer.
- Event kind is a `PointerCheck` on `/type`, not a separate concept.
- The receiver reads input state from SQLite on every request. A CLI or Slack change applies to the next delivery.
- Vault paths are built from generated ids only, never from request input.

Rejected: the body as a column on the receipt. A separate row makes "no body retained" a row count, and keeps history queries away from blobs. Rejected: writing nothing for ignored deliveries; #403's history must show skipped events. Limitation accepted: each unkeyed ignored delivery adds one small row until retention removes it.

### Consumer port

This is the seam between #401 and its consumers.

```ts
interface IncomingConsumer {
  kind: string;
  match(input: Input, event: Record<string, unknown>): ConsumerMatch[];
  handle(work: HandoffWork): Promise<'accepted' | 'skipped'>;
}
type ConsumerMatch = { consumerId: string; snapshot: string };
type HandoffWork = { handoff: Handoff; body: Uint8Array; saveReservation(reservation: string): void };
```

Rules:

- `match` runs on the request path, immediately before the receipt transaction, with nothing awaited in between. It is synchronous and has no effects. #402 can satisfy this from the scheduler's in-memory index (`src/system/trigger-scheduler.ts:46`).
- `handle` may run more than once for one handoff, for example after a crash that follows its own commit. The handoff id is its idempotency key. `saveReservation` stores a reservation under the lease so a retry finds earlier work.
- Throwing means "retry later". After the attempt limit the handoff is `failed`.
- No consumer is registered in production by #401. With the flag on, an authenticated delivery is recorded as `ignored: filtered` until #402 lands.

Rejected: copying routine definitions into inbox rows so matching is pure SQL. That creates a second source of truth racing with trigger edits. The trigger lock covers only the pending lifecycle today (`src/system/trigger-store.ts:20-23`).

### Lease and payload disposal

- **Claim.** One transaction picks the oldest due pending handoff whose lease has expired, sets a new token and lease, and increments attempts. A handoff whose input is no longer enabled is cancelled here instead.
- **Finish, save, release.** Each updates `WHERE id = ? AND token = ?`. Zero rows changed means the lease was lost; the caller stops and records nothing.
- **Attempt.** A handler has one lease to finish. If it is still running then, the dispatcher releases the handoff for retry and moves on, and the handler's later writes are refused. One stuck consumer cannot stall the loop.
- **Retry.** A failed attempt waits 1, 5, 15, then 30 minutes; the fifth failure is final. A handoff interrupted during its last attempt is failed without another run.
- **Disposal.** The finishing transaction also checks the receipt. With no pending handoff left, it deletes the payload row and closes the receipt.
- **Pause and delete.** One transaction sets the input's state, cancels its unleased pending handoffs, and applies the same disposal rule. A leased handoff may finish its current attempt. If that attempt fails, or its holder dies, while the input is still paused or deleted, the handoff is cancelled, at release or at the next claim.
- **Sweep.** An hourly pass fails unleased handoffs older than seven days and removes settled receipts older than 30 days. A removed receipt's key is new again. A sweep that fails is reported and does not hold up deliveries.
- **Lifecycle.** One dispatcher loop per process, polling every second and delivering one handoff at a time, yielding to the event loop between handoffs. It starts after `recoverActiveTasks()`. On shutdown it stops first, and the store closes after at most five seconds.

Deletion here is logical. Physical erasure from SQLite pages and the WAL is deferred to #407.

### Provisioning, secrets and enablement

- Lifecycle operations are exported functions: create, pause, resume, delete. #403's tools and Bolt callbacks will call the same functions.
- #401 exposes them through an operator CLI run inside the container, like the OAuth CLI (`src/cli/oauth.ts:80`). It prints the callback URL from `ARCHIE_PUBLIC_URL` and the secret once.
- The host generates 32 random bytes per secret, with the `whsec_` base64 form for signed inputs. The secret is sealed with `encryptJson` under `SECRETS_DIR/incoming/` and written before the input row is enabled.
- Bearer comparison uses `timingSafeEqual` over SHA-256 digests of both values, so length does not leak.
- `ARCHIE_INCOMING_EVENTS=off|on`, default `off`. `on` requires `ARCHIE_SECRETS_KEY`. An unknown value or a missing key stops the boot.
- The CLI runs as the daemon's user. It refuses to run as root beside directories another user owns, because the daemon could not read what it created.

Rejected: a sealed-secret column in SQLite. The parent plan keeps keys in the vault so a database snapshot restores without them, and `/app/secrets` is already in the backup set.

## Stages

### Stage 1 — A delivery is authenticated and durably received

Covers acceptance criteria 1 and 2.

Deliverables:

1. Signature verification, qualified with valid, altered, expired and invalidly encoded requests. Decided 2026-11-19: Archie's own check on `node:crypto`, no library; see the Stage 1 outcome.
2. Inbox store and schema version 1 for inputs, receipts, payloads and handoffs.
3. The route with both authentication schemes, the consumer port, and the receipt transaction.
4. Create, pause, resume and delete operations as state changes.
5. Tests over a real Express app on an ephemeral port and a temporary database file, following `src/connectors/github/__tests__/webhook-endpoint.test.ts:1-6`. A test consumer is injected.

Depends on: nothing. Does not yet allow: draining handoffs or running in the Archie process.

**Exit condition:** tests show `202` with the receipt readable from a reopened database; each rejected request leaves all four tables unchanged; a retry at full capacity returns the original receipt; changed content returns `409` and increments `conflicts`; filtered and paused deliveries leave no payload row.

### Stage 2 — Handoffs are finished once and their payload removed

Covers acceptance criterion 3.

Deliverables:

1. Claim, save, release and finish with token checks.
2. Dispatcher loop with backoff, attempt limit and sweep.
3. Pause and delete cancel unstarted handoffs.

Depends on: Stage 1. Does not yet allow: real consumers.

**Exit condition:** after closing and reopening the store, a second dispatcher delivers the committed handoff. With two dispatchers on one file and a handler that outlives its lease, the first holder's finish changes nothing. With two consumers, the payload row survives the first finish and is gone in the transaction of the second.

### Stage 3 — The receiver runs in Archie and is reachable

Covers acceptance criterion 4.

Deliverables:

1. Wiring in `src/index.ts` behind the flag: mount with the other connectors, open storage before `listen`, start the dispatcher after recovery, stop and close on shutdown.
2. Operator CLI.
3. `docs/architecture/incoming-events.md`, the deployment guide correction, the flag in `.env.example`, and index links.
4. A live check on a booted instance with the E2E harness, then on the staging host.
5. A separately approved change in the private infrastructure repository: exempt the staging callback path from SSO and set the flag in the staging unit.

Depends on: Stages 1 and 2. The staging check also needs deliverable 5 applied.

**Exit condition:** `npm run check` passes on Node 24. On a booted instance, a signed delivery with a unique body marker and a dummy secret leaves neither string in container logs or the `/api/events/stream` capture. From outside the network, a bad signature sent to the staging host gets Archie's `401` rather than an SSO redirect, and `/api/tasks` gets the SSO redirect.

## Validation and rollout

- "No work starts on rejection" → row counts in all four tables before and after each rejected request.
- "`202` after commit" → a store whose commit throws returns `503`; a successful receipt is read back after reopening.
- "Secrets and bodies stay out of logs and streams" → in-process capture of the logger and event bus on the accepted path, plus the live scan on the ignored path. The live accepted path needs #402.
- Rollout: the flag is off by default. Turning it on in a deployment is a separate, approved infrastructure change.
- Decided by the owner on 2026-11-19: the ingress check runs on staging. Production stays off until #402. Rejected: checking in production, which needs no ingress change but opens a public route there early.
- Rollback: the flag off unmounts the route and stops the dispatcher. Removing `WORKDIR/incoming/` and `SECRETS_DIR/incoming/` removes all state. No existing schema or file changes.

## Deferred

| Left open | Needed by | Settled by |
|---|---|---|
| Body limit, per-input and workspace capacity, attempt limit and backoff, handoff and receipt retention | Stage 1–2 ship the parent plan's defaults as named constants; final values before production enablement | Sizes and failure rates from the first real sender |
| Per-input request rate limit. Until then, a caller who knows an input id can cause a secret read, a body read and a warning per request, and an authenticated sender can add ignored receipts without a `429`; retention removes them after 30 days. | Before the first external sender (#403) | Choosing an in-memory counter or `express-rate-limit`, already in the tree transitively |
| Cost of the capacity check, which sums every waiting body per accepted delivery | Before production enablement | Timing with a backed-up inbox; a running total if it shows |
| One unreadable secret file fails a delivery even when another secret is valid | #403, with rotation | The rotation flow |
| Sharing the inbox's transaction helper (`src/incoming/sqlite.ts`) with proactivity | A separate change | It would also carry the rollback fix to proactivity; see the Stage 1 outcome |
| Matching against the input as read at commit. Today consumers match against the input read before the body arrives, which is exact only while an input's filter cannot change | #403, with input edits | The edit flow: re-read the input after the body, or compare `revision` in the receipt transaction |
| Waking the dispatcher when a receipt commits, instead of waiting up to one poll | #402, if a second of delay matters | Time from `202` to Task start |
| Delivering more than one handoff at a time | #402 | Task preparation time under load |
| A handoff whose consumer kind is not registered is retried, then failed | #406 | Whether proactivity being off should skip such handoffs or hold them |
| A handler time limit shorter than the lease, and an abort signal for a handler that ran out of time | A second dispatcher process, or #402 | Whether Task preparation can be interrupted. With one dispatcher the limit and the lease cannot race. |
| Body read timeout | Before production enablement | Measuring slow uploads; the shared server sets no timeouts in `src/index.ts` |
| Physical erasure of deleted bodies | #407 | Marker scan of the database and WAL files with `secure_delete` and a truncating checkpoint |
| Two active secrets during rotation | #403 | The rotation flow; `secretRefs` is already a list |
| Decrypted-secret caching | Stage 3, only if profiling asks | Request timing on the booted instance |
| Draft and provisioning input states | #403, #405 | Those flows; `state` is an open set |
| Migration policy past schema version 1 | First schema change | The proactivity precedent (`src/proactivity/persistence/schema.ts:66-75`) |

## Open questions

1. Is a live `202` required to close #401? No consumer exists before #402, so a live delivery ends as `ignored`. Recommendation: accept test evidence for `202` here and record the live `202` under #402. Blocking: closing the issue, not the work.

## Risks

- The `/webhooks/*` exemption makes the route public as soon as the flag is on in production. — Keep the flag off until the owner enables it.
- An edge rule may challenge non-browser senders. — Stage 3 sends a real external request before any sender is connected.
- Archie's own signature check could drift from the specification. — The specification's published vector and the altered, expired and malformed cases are permanent tests.
- Direct access to the origin that bypasses the edge was not checked. — Confirm with the infrastructure owner before production enablement.

## Stage 1 outcome

Implemented on 2026-11-19 in `src/incoming/`, uncommitted. Expected: the Stage 1 exit condition. Observed: met in tests.

- **Checks run:** `npm run check` on Node 24.22.3 passed, with 2,632 Vitest tests. The 94 new tests use a real Express app, a real SQLite file and real sealed secrets. Six deliberate source mutations each failed exactly one test.
- **No signing library:** the check is about 30 lines of `node:crypto` in `src/incoming/authenticate.ts` and passes the specification's published vector. This departs from the parent plan, which named `standardwebhooks@1.1.1`. `package.json` and the lockfile are unchanged.
- **Review:** one fresh reviewer found no authentication, durability or leakage defect. Its two low-severity defects and three test gaps were fixed and not re-reviewed.
- **Refinements to this plan:** a request with no body at all gets `400`; an event key must be 1–255 printable ASCII characters; an ignored reply also carries `reason`; a `409` carries the original `receipt_id`; pausing does not change `revision`.
- **Two later reviews, same day:** sixteen findings, nine fixed. The rest are in Deferred, except `revision`, kept for #403. The fixes were not re-reviewed.
- **Process-level check, same day:** 40 checks passed with the receiver as its own process over real HTTP, signed by the reference `standardwebhooks` library and by `openssl` with `curl`. After `kill -9` during a burst, all 685 acknowledged deliveries were present. The log held no body or secret.
- **Existing bug seen in passing, not fixed here:** proactivity's transaction wrapper at `src/proactivity/store.ts:143-153` runs `ROLLBACK` even after SQLite has already rolled back, for example on a full disk. That throws "no transaction is active" and hides the real error. The inbox's helper checks first.

## Stage 2 outcome

Implemented on 2026-11-19 in `src/incoming/dispatcher.ts` and `store.ts`, uncommitted. Expected: the Stage 2 exit condition. Observed: met in tests and at process level.

- **Checks run:** `npm run check` passed with 2,669 Vitest tests, 37 of them new, including two child processes claiming at the same moment. Thirty-two deliberate mutations each fail a test.
- **Process-level check:** 15 checks passed with a receiver process and separate dispatcher processes, before and after the review fixes: takeover after `kill -9` only once the lease ran out, 300 deliveries each started once by two competing workers, and a backlog of 150 delivered once each after every process was killed.
- **Review:** one fresh reviewer found no high-severity defect and could not break lease exclusivity with four processes, or the body and receipt invariants over 60,000 random operations. Nine of ten findings were fixed, among them a loop that could stall the receiver and a retry that survived a pause. The tenth is in Deferred. The fixes were not re-reviewed.
- **Changes to schema version 1:** an index on receipt age, and the due index now covers pending handoffs only. Nothing has shipped, so the version is unchanged.
- **Not done:** nothing is mounted in `src/index.ts`, and no CLI or architecture document exists; that is Stage 3. Deleted bodies remain in SQLite's free pages until #407, which the process-level check confirmed.

## Stage 3 outcome

Implemented on 2026-11-19, uncommitted. Expected: the Stage 3 exit condition. Observed: met on a booted instance; the staging half is open.

- **Built:** wiring behind `ARCHIE_INCOMING_EVENTS` (`src/incoming/runtime.ts`, `src/index.ts`); the operator CLI (`npm run incoming`); `docs/architecture/incoming-events.md`; the deployment guide correction; the flag in `.env.example`; `secrets/incoming/` in `.gitignore`.
- **Checks run:** `npm run check` on Node 24.22.3 passed with 2,711 Vitest tests, 42 of them new for this stage, including the real command run as a child process. Twenty-two mutations of the wiring and CLI rules each failed a test. One wiring test failed once in 24 runs and could not be reproduced.
- **Live check:** the E2E harness booted this checkout, attested as `d0e85a24-dirty`, with Slack off and its own empty workdir. Twenty checks passed: the CLI inside the container; signed deliveries from the host (`200` ignored, duplicate, `409`, `401`, `404`, `413`); the same receipt after a container restart; pause and delete; and no body marker or secret in the container logs or the `/api/events/stream` capture. Ten checks passed again after the review fixes.
- **Review:** one fresh reviewer and the author found no high-severity defect and ten findings, all fixed. The main one: run as root, the default for `docker exec`, the CLI created secret and database files the daemon's user could not read, so every delivery would have got `503`. macOS bind mounts hid this in the first live check. The CLI now refuses to run that way, the inbox directory is owner-only, and shutdown stops the dispatcher first. The fixes were not re-reviewed.
- **Seen in passing:** `docker compose stop` in the development image never reaches the shutdown handler, because `npm run dev` exits without forwarding the signal. Sent to the Archie process directly, the signal runs it to "Server closed".
- **Not done:** the staging check, which waits for the infrastructure change. The live accepted path waits for #402.

## Evidence

- **Read in code:** the HTTP entry point, GitHub webhook route, API router mount, proactivity store and schema, vault and OAuth storage, trigger store and types, shutdown flag, event bus, sandbox path grants, at `d0e85a24`.
- **Read in the private infrastructure repository at `0d0bde82`:** the proxy configuration, the SSO application definitions and the service unit. Details are kept in a private evidence note, not in this public repository. Whether that configuration is applied was not checked.
- **Run:** two local Node probes for `JSON.parse` error text and UTF-8 decoding, on Node 23.6. `npm view` for package versions.
- **Read and tested in Stage 1:** the Standard Webhooks specification and the `standardwebhooks` 1.1.1 source; Archie's check against the specification's published vector.
- **Not verified:** edge body limits and bot rules; origin reachability; whether staging runs Slack in Socket Mode.

## Status and next action

Planned on 2026-11-19. One fresh reviewer checked the plan's code anchors before implementation and found nothing blocking. Stages 1–3 are implemented and verified as recorded above. Nothing is committed.

Next action: commit and open the pull request. Then the staging check: apply the private infrastructure change (exempt the staging callback path from SSO, set the flag), send a bad signature from outside the network and expect Archie's `401`, and request `/api/tasks` and expect the SSO redirect.
