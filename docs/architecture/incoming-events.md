# Incoming Events

Incoming events let a system other than Slack or GitHub tell Archie that something happened. A sender posts a JSON webhook to a callback URL. Archie authenticates it, records it durably, and later hands it to whatever acts on it.

**Status:** the receiver, the inbox, the dispatcher and event routines are implemented behind `ARCHIE_INCOMING_EVENTS`, which is off by default. An event starts a Task only for a routine linked to its input. A person can set a routine up in Slack with a new input, which they then own, connect a sender, and ask Archie which inputs exist and what became of each delivery. Rotating a key and transferring an input in Slack are still to come ([#403](https://github.com/sweatco/archie-hq/issues/403)). The feature design is in the [incoming events plan](../plans/20261116-incoming-events-shared-receiver.md).

The inbox is in `src/incoming/`. The routine consumer is `src/system/routine-consumer.ts`, beside the trigger code it uses.

## How a delivery flows

`POST /webhooks/incoming/:inputId` → authenticate → one transaction (duplicate check, receipt, body, handoffs) → reply → the dispatcher claims a handoff → the consumer handles it → finish. The finish that ends the last handoff deletes the body.

No Task, trigger or model code runs on the request path.

## Inputs

An input is one callback URL with its own secret.

- **State:** `enabled`, `paused` or `deleted`. A deleted input answers `410` and cannot be resumed.
- **Authentication:** `signed` uses the [Standard Webhooks](https://www.standardwebhooks.com/) headers `webhook-id`, `webhook-timestamp` and `webhook-signature`, with a five-minute tolerance. `bearer` uses `Authorization: Bearer <secret>`, plus an optional `Idempotency-Key`.
- **Filter:** a list of conditions on the event JSON, such as "`/type` equals `meeting.ended`". An event that fails one is recorded as ignored.
- **Owner:** the Slack user who approved the proposal that created the input. Only the owner approves another routine on it. An input the operator made has no owner and is managed from the CLI alone.
- **Purpose:** a short label for cards and listings, such as "Meeting recordings".
- **Linked routines:** the triggers allowed to receive this input's events, by its owner's approval or by the operator. See [Event routines](#event-routines).

The secret is generated on the host and sealed with the [secrets vault](secrets.md) under `SECRETS_DIR/incoming/`. The database holds only a reference to it.

## Replies

| Reply | Meaning |
|---|---|
| `202` | An event was recorded with its body. Sent only after the commit. |
| `200` `duplicate` | The same key and content again, with nothing new to do. Carries the original `receipt_id`. |
| `200` `ignored` | The input is paused, the filter excludes the event, or no consumer wants it. No body is kept. |
| `409` | The same key with different content. Counted on the original receipt. |
| `429` | The inbox is full. Nothing was recorded, so the sender should retry. |
| `401` | The signature or token did not verify. |
| `400` | An empty body, invalid UTF-8, malformed JSON, a JSON value that is not an object, or an event key that is not 1–255 printable ASCII characters. |
| `413` `415` | A body over 1 MiB, or a media type other than `application/json` or a compressed body. |
| `404` `410` | Unknown or deleted input. |
| `503` | Archie is shutting down or the inbox is unavailable. |

Rules that hold on every path:

- The event key is `webhook-id` for a signed delivery and `Idempotency-Key` for a bearer one. A bearer delivery without a key is always new.
- The duplicate check comes first, so a retry gets its original receipt even when the inbox is full.
- A retry of an ignored event is accepted under its original receipt once the input is enabled and a consumer wants it. A sender can therefore replay what arrived during a pause.
- The signature covers the bytes as received. A bearer token is compared before the body is read.
- Logs carry input and receipt ids and an error category. They never carry a body, a secret or a parser message.

## Storage

The inbox is its own SQLite file, `WORKDIR/incoming/state.sqlite`, in a directory only its owner can read. The agent sandbox cannot read `WORKDIR`, and a separate file keeps incoming events working when proactivity is off.

| Table | Holds |
|---|---|
| `inputs` | State, authentication scheme, secret references, filter, linked routines, owner, purpose |
| `receipts` | One row per event key: digest, outcome, conflict count |
| `payloads` | The raw body, only while a handoff is pending |
| `handoffs` | One row per receipt and consumer: state, reason, lease, attempts, reservation |

The schema is versioned and migrates forward when the file is opened. An older binary refuses a newer file.

Deleting a body is logical. Erasing it from SQLite's free pages is [#407](https://github.com/sweatco/archie-hq/issues/407).

## Handing off

A consumer is the code that acts on an event. It implements two functions, defined in `types.ts`:

- `match` runs on the request path, just before the receipt commits. It is synchronous and has no effects.
- `handle` runs later, from the dispatcher. It may run more than once for one handoff, so the handoff id is its idempotency key. It answers `accepted`, or `skipped` with a reason.
- `reconcile` is optional. It runs with each sweep, the first at start, so a consumer can drop work for handoffs that ended without `handle` seeing it.
- `uses` is optional. It names what of that kind takes an input's events, so the inventory can list an input that no routine uses.

`handle` can save a reservation on its handoff: a durable marker of progress that the next attempt reads. It also gets a read view of the inbox, for checks it repeats while it works.

The dispatcher is one loop per process. It polls every second and delivers one handoff at a time.

- **Lease:** a claim sets a token and a five-minute lease. Saving progress, releasing and finishing all require the token, so a holder that lost its lease records nothing.
- **Time limit:** a handler still running when its lease ends counts as a failed attempt.
- **Retry:** a failed attempt waits 1, 5, 15, then 30 minutes. The fifth failure is final, so a handoff is given up after 51 minutes of waiting plus the time its attempts took.
- **Pause and delete:** handoffs nobody is working on are cancelled and their bodies deleted. One being worked on may finish its attempt. If that attempt fails while the input is still paused or deleted, it is cancelled too.
- **Unreadable handoff:** a handoff whose stored body or rows cannot be loaded is failed and logged, and the next one is delivered.
- **Sweep:** hourly, handoffs older than seven days are failed and settled receipts older than 30 days are removed. A removed receipt's key is new again.

Every handoff that ends any way other than `accepted` records why:

| Ending | Decided by | Reason |
|---|---|---|
| `skipped` | The consumer | Its own reason. Routines use the list under [What stops a routine](#what-stops-a-routine). |
| `cancelled` | The inbox | `input_paused`, `input_deleted` |
| `failed` | The dispatcher or the sweep | `attempts_exhausted`, `interrupted` (the process died during the last attempt), `expired`, `unreadable` (its stored body or rows could not be loaded) |

## Event routines

An event routine is an ordinary [trigger](triggers.md) whose conditions are all `incoming_event`. Each condition names an input and may add its own filter. The routine's binding is where the result goes.

Two things must hold before a routine receives anything:

- **The conversation approved it.** The routine is proposed and approved in the conversation it delivers to, like any trigger.
- **It is linked to the input.** The approval links it when the approver may manage the input. Otherwise the operator links it with the CLI. Removing the link is how access is revoked.

An input id appears in the callback URL and in logs, so the id alone grants nothing. Several routines can be linked to one input; each gets its own Task for an event that passes its filter.

One function, `routineMayUseInput` in `src/incoming/access.ts`, answers "may this routine still use this input?" for every check below. `mayManageInput` in `src/incoming/inputs.ts` answers who may change an input: the operator always, a Slack user only as its owner.

### Approving an event routine

A proposal names an existing input or asks for a new one, with a purpose and a scheme. Nothing is written to the inbox, and no key exists, until a person approves.

The approval card is a review: the source, its owner, the filter, the audience and the instructions in full. Its Approve button carries a digest of what the card shows.

| The proposal names | Who approves | Result |
|---|---|---|
| A new input | A member of the workspace | The input is created with that person as owner; the routine is enabled and linked |
| An existing input | Its owner | The routine is enabled and linked |
| An existing input | Someone else | Refused; the proposal stays pending |
| An operator-made input | A member of the workspace | The routine is enabled; the operator links it |
| Any | A guest, or a person from another organisation | Refused |

- **A refusal is told to the approver alone.** The card stays, because the right person may still approve it.
- **An edit retires the earlier card.** The proposal records where its newest review card was posted (`Trigger.review_card`). When an edit posts a new card, the earlier one is rewritten to say it is out of date and loses its buttons. Other triggers keep their earlier cards, as [triggers](triggers.md#while-a-proposal-is-pending) describes.
- **An outdated card that is still clickable refuses.** That happens when retiring it failed. The digest is compared with the proposal when the button is clicked and again inside the trigger store's lock, so an edit that lands in between is not approved unseen. The click then retires the card.
- **Approval can repeat.** The proposal records the id reserved for a new input before the input is created. A second click, or a click after a crash, continues with the same input. Only the person who began may continue.
- **A channel shared with another organisation is refused,** at proposal and at approval. The check is the existing `isChannelShared`, which answers "not shared" when Slack cannot be asked, and it does not run again after approval ([#453](https://github.com/sweatco/archie-hq/issues/453)).
- **The operator approves through the API** with the same reference. An input it creates has no owner.
- **After approval, trigger rules apply.** An edit can still change a routine's event filter without the owner ([#452](https://github.com/sweatco/archie-hq/issues/452)).

The pure parts are in `src/system/routine-review.ts`: the card, the digest and the condition a new input becomes. `src/system/routine-approval.ts` checks the approver and creates and links inputs.

### Connecting a sender

When an approval links a routine to an input the approver manages, the approval line keeps a **Connect a sender** button. Everyone in the conversation sees it. The button carries an id only, and each click is checked against the input as it is then: only the owner gets a window, anyone else is told who owns the input, and only they see that.

**Connect a sender** opens a window with the callback URL, the headers to send, the key behind a **Show key** button, and the connection status. The URL is built from `ARCHIE_PUBLIC_URL`; without it the window shows the path alone.

- **The key is shown to the owner alone,** and only after they ask. A Slack window is visible to the person who opened it, which makes it the one place in Slack a key may appear. The key never reaches model context, a card, an action value or a log. It does pass through Slack.
- **An owner who is no longer a member of the workspace** is refused the key.
- **The operator cannot read a key.** The CLI prints one only for an input it creates.

**The connection status** reads two things and starts nothing:

- the newest delivery that authenticated, whether it was acted on or not;
- when a delivery was last refused because its signature or token did not verify. The receiver keeps this in memory (`src/incoming/refusals.ts`), so a refusal costs no write and the time is lost on restart.

To test a sender without a run, pause the routine. An authenticated delivery is then recorded as ignored, with no body kept, and the status shows it.

The layout is in `src/system/input-panels.ts` and the handlers are in `src/system/input-controls.ts`.

### The inventory and the history

The PM has two read-only tools. `list_inputs` lists inputs with their owner, state, last delivery and what takes their events. `get_input_history` shows what became of an input's newest 50 deliveries.

Both are scoped by the conversation the question comes from, like trigger listings (`src/system/trigger-visibility.ts`):

| Asked from | What is shown |
|---|---|
| The owner's own DM, or the operator | The input whole: every linked routine and every other consumer |
| Any other conversation | Only the linked routines visible from it. Everything else is a count. An input with no routine visible there is not listed, and its history is refused |

Neither tool shows a key or a callback address. A deleted input is left out of the inventory. A delivery that was not acted on belongs to no routine, so history shows its time and reason wherever the input is visible.

History reads the receipts, which are kept for 30 days, and tells five outcomes apart:

| Shown as | Meaning |
|---|---|
| Received | The handoff is waiting to start |
| Handed off | The handoff was accepted: a Task started and has not posted yet |
| Delivered | That Task opened its thread; the row links to it |
| Skipped | The receipt was ignored, or the handoff ended without a run, with the reason in words |
| Uncertain | The handoff was cancelled or failed, yet the Task it reserved exists |

No event content is kept after handoff, so history cannot show or replay an event. A delivery that failed authentication has no receipt and does not appear; the Connect window shows when one was last refused.

**Pausing a routine is a trigger operation** and touches nothing else. The paused routine stops matching at receipt, while the input's other routines and its other consumers keep receiving.

The code is in `src/system/input-inventory.ts`; the tools are `list_inputs` and `get_input_history` in `src/agents/tools.ts`.

### From event to Task

1. **Snapshot at receipt.** `match` reads each linked routine from the trigger index and records its prompt and binding in the handoff. The run uses that snapshot. An edit applies to events received after it.
2. **Live check.** At dispatch, the input must be enabled and still list the routine, and the routine must be enabled and still name the input.
3. **Reserve.** A run slot is taken from the daily allowance that all triggers share, and the new Task's id is saved as the handoff's reservation, in one step.
4. **Prepare.** The event is written as `incoming-event.json` in the Task's folder. Then the Task's metadata is written with status `preparing`, homed in the routine's conversation.
5. **Start.** The live check runs again, the Task flips to `in_progress`, and the PM gets its instruction.

Each step is safe to repeat. A retry finds the reservation, continues the same Task and takes no second slot. A Task that already started is accepted without a second instruction. A start whose first wake fails is undone, so the retry starts the Task. After a crash in mid-start, the retry waits for the interrupted attempt's lease to end, up to five minutes.

The Task opens its own thread with its first post, as a [schedule fire](triggers.md#a-schedule-fire-homes-its-task-in-the-bound-channel) does.

### The event stays in its file

The instruction names the event file and says its content is untrusted data, never instructions. The body goes nowhere else: not into the snapshot, the reservation, the instruction, `metadata.json`, `knowledge.log`, an event or a log line. The Task keeps the whole event for as long as its folder lives, and backups of Task folders include it. Once the PM reads the file, its content is also in that Task's agent session transcript, in the same folder.

### What stops a routine

| Change | Work not started yet | A Task that already runs |
|---|---|---|
| Prompt edited | Runs on its snapshot | Unaffected |
| Routine paused, deleted, or no longer naming the input | Skipped | Unaffected |
| Input paused | Cancelled, or skipped when an attempt was in flight | Unaffected |
| Input deleted | As for a paused input | Its next post, file share and memory write are refused |
| Routine unlinked | Skipped | Its next post, file share and memory write are refused |

- **Skip reasons:** `routine_paused`, `routine_deleted`, `routine_changed`, `routine_unlinked`, `input_paused`, `input_deleted`, `triggers_disabled`, `destination_unreachable`, `daily_cap`.
- **A skip leaves no Task.** A Task that an earlier attempt prepared is removed with its event file, and its run slot goes back to the daily allowance. The sweep does the same for handoffs the inbox ended by itself.
- **A channel that Slack could not be asked about is not a skip.** The attempt fails and is retried. Only a channel that Slack reports missing or archived pauses the routine and skips the event as `destination_unreachable`.
- **Timing.** A stopped routine's waiting work is skipped at its next attempt, which can be 30 minutes away. The body stays in the inbox until then.
- **A running Task** is checked against the inbox before every post and file share, by the same gate that holds it to its [destination](memory.md). Explicit memory writes and completion extraction ask the same question, and extraction asks again just before it writes. With incoming events off, or an inbox that could not be opened, the answer is no and the refusal says so: such a Task stays silent in its thread until the inbox is open again. Context the agent already loaded is not taken back.
- **Two writes pass without the check,** as they pass the destination check: the notice a Task's trigger tools post to a trigger's bound channel, and the removal of an acknowledgement reaction. The notice carries a summary the PM wrote, which is one reason the tool review under [Not built yet](#not-built-yet) comes before production use.
- **An uncertain run** is a Task that outlived a cancelled or failed handoff: it started, and the handoff did not record it. `history` marks it.

## Design choices

- **Commit before replying.** A `202` means the event is on disk. Replying first and processing afterwards, as the GitHub route does, would lose an event on a crash.
- **Its own SQLite file.** Proactivity's database opens only when proactivity is on and belongs to one Slack workspace; the inbox has to work without either. A later merge stays cheap, because only inputs and recent receipts would need to move.
- **The body in its own table.** Whether a body is retained is then a row count, and history queries stay away from large blobs.
- **Its own signature check.** Standard Webhooks verification is one HMAC comparison: about 30 lines of `node:crypto`, tested against the specification's published example, with no added dependency.
- **Secrets as sealed files.** A database snapshot can then be restored or shared without its keys.
- **One consumer interface.** Routines and proactivity plug in through the same two functions, so the inbox holds no Task or trigger code.

## Operating it

`ARCHIE_INCOMING_EVENTS=on` mounts the route and requires `ARCHIE_SECRETS_KEY`. With the flag off or blank, the route does not exist, and a Task that an event started earlier can no longer post. Any other value, or a missing key while the flag is on, stops the boot before the slow startup steps.

`ARCHIE_TRIGGERS_ENABLED=false` stops routines without closing the route: events are recorded as ignored.

- **Startup:** the inbox opens and the route mounts before the server listens. The dispatcher starts after Task recovery.
- **Shutdown:** the dispatcher stops first, waiting up to five seconds for an attempt in flight, and the inbox closes. Only then does the rest of Archie shut down.
- **Unavailable inbox:** if the inbox cannot be opened, Archie still starts and the route answers `503`, so senders retry.

Inputs are managed with the operator CLI. Run it where the daemon runs, as the same user, because both use the same inbox file and secrets directory. A change applies to the next delivery.

```bash
npm run incoming -- create [--auth signed|bearer] [--filter '<json>']
npm run incoming -- list
npm run incoming -- pause <input-id>
npm run incoming -- resume <input-id>
npm run incoming -- delete <input-id>
npm run incoming -- link <input-id> <trigger-id>
npm run incoming -- unlink <input-id> <trigger-id>
npm run incoming -- history [<input-id>]
```

- `create` prints the callback URL, built from `ARCHIE_PUBLIC_URL`, and the secret. The secret is shown only then.
- `link` refuses a trigger with no condition for that input, then prints its destination, summary and status. `list` shows each input's links and marks one whose trigger no longer exists. For an input made in Slack it also shows the owner and the purpose.
- The key of an input made in Slack is shown to its owner in Slack, under [Connect a sender](#connecting-a-sender). The CLI cannot read it.
- `history` shows the newest 50 handoffs: state, reason and the Task each reserved.

Before running an older binary, delete event routines and `WORKDIR/incoming/`: it refuses the newer inbox and does not know the `incoming_event` condition.

In the container images the daemon runs as `archie`, while `docker exec` defaults to root. A secret file created as root would be unreadable to the daemon, so the CLI refuses to run as root there. The production image also has no `tsx`. Run the built file as the daemon's user:

```bash
docker exec -u archie <container> node dist/cli/incoming.js create
```

The callback is public and authenticates every request itself. `/api` has no route for inputs, because it has no authentication of its own and would hand out secrets.

## Limits

These are starting defaults, named constants in `receiver.ts`, `store.ts` and `dispatcher.ts`.

| Limit | Value |
|---|---|
| Request body | 1 MiB |
| Bodies waiting for handoff | 100 MiB per input, 1 GiB in total |
| Attempts per handoff | 5, each limited to 5 minutes |
| Unfinished handoff | Failed after 7 days |
| Settled receipt | Removed after 30 days |
| Runs started by triggers | 200 a day, shared by schedules, messages and events; counted in memory |

## Not built yet

- Proactivity as a second consumer ([#406](https://github.com/sweatco/archie-hq/issues/406)). Until then only a test consumer exercises the inventory's `uses` seam.
- Rotating a key, transferring an input and disconnecting a routine in Slack ([#403](https://github.com/sweatco/archie-hq/issues/403)).
- Choosing which event fields a Task receives ([#451](https://github.com/sweatco/archie-hq/issues/451)), and how long the event file is kept ([#407](https://github.com/sweatco/archie-hq/issues/407)).
- An overlap of two keys during rotation ([#449](https://github.com/sweatco/archie-hq/issues/449)), matching a delivery against the input as committed ([#450](https://github.com/sweatco/archie-hq/issues/450)), and an audit log of input changes ([#454](https://github.com/sweatco/archie-hq/issues/454)).
- A review of the tools an event-started Task may use, with the event as untrusted input ([#439](https://github.com/sweatco/archie-hq/issues/439)). Required before production use.
- MCP event subscriptions ([#404](https://github.com/sweatco/archie-hq/issues/404), [#405](https://github.com/sweatco/archie-hq/issues/405)).
- A per-input rate limit ([#448](https://github.com/sweatco/archie-hq/issues/448)). Until then, the edge in front of Archie is the only defence against a flood.
