# Proactive Slack assistance

Archie observes accessible public Slack activity, keeps track of open matters and offers useful help. It can suggest repository work, but only the configured owner's **Start task** action creates a normal task. Observation uses its own database and works independently of knowledge memory. Reflection, evaluation and self-evolution are deferred to PR #361.

## Sources and storage

`ARCHIE_PROACTIVITY_MODE` defaults to `off`; `shadow` collects and analyzes without sending; `live` also permits delivery after the owner enables it. Startup requires Node 24+, a Slack workspace, a human `ARCHIE_PROACTIVITY_OWNER` and available, explicitly priced model routes. Extraction defaults to `claude-haiku-5-5`; investigation uses `claude-sonnet-5-5`.

Collection starts at the first successful enablement and preserves that watermark across restarts. There is no backfill, auto-joining, mailbox, private-channel or DM observation. A new public reply may fetch its older parent for context, without importing the older discussion. Bot messages cannot establish commitments or success by themselves. Slack content is evidence, never authorization.

`WORKDIR/initiative/state.sqlite` holds source revisions, observations, matters, jobs, charges, deliveries, feedback and approved task handoffs. It is bound to the Slack workspace and owner, outside the PM's filesystem sandbox and separate from the Markdown knowledge store. SQLite uses WAL and full durability. Back up with SQLite-aware tooling or after a clean stop; a live database copy without its WAL is incomplete.

Edits, deletions and access loss invalidate dependent evidence and unsent messages in a transaction. Processing generations reject stale model results. A process lease and fenced job leases prevent concurrent workers from applying the same work. Missing history, overflow and incomplete pagination remain visible coverage gaps until collection repairs them.

Schema creation belongs to `persistence/schema.ts`. This release creates a fresh schema 11 and reopens that schema without resetting evidence, owner enablement, charges or approved work. Experimental schemas 1–10 and optional-learner databases are unsupported; opening them fails without changing the file. Unknown nonempty databases, wrong workspace/owner and newer schemas also fail. There is no migration, historical learning storage or batch recovery. The retired test databases remain archived evidence for their original binaries.

## Analysis and delivery

The scheduler drains at most 32 due jobs per minute within a 45-second drain window; a running analysis has a five-minute bound. Extraction runs hourly, groups threads by channel and carries findings across bounded parts. Validated parts survive interruptions so a retry can continue without buying the same analysis again. Investigation refreshes sources before assessing resolution, useful help or one scoped task suggestion in the same model call.

The model extracts a deadline as a local date, clock time and IANA timezone; host code resolves the instant. Missing date/time/zone, invalid dates, nonexistent spring-forward times and ambiguous fall-back times remain an unknown deadline. The host never silently shifts a time or chooses one occurrence of a repeated time.

New or reopened matters get an immediate check after extraction. Future deadlines get a check 15 minutes before the deadline and at the deadline; overdue matters recur hourly, others daily. Earlier source deadlines advance checks. Human snoozes and dismissals survive extraction. Human activity resets the two-business-day inactivity check for public follow-ups. Active ordinary tasks suppress intervention. The initial extraction and its backlog can delay when Archie first notices a matter.

Unchanged evidence, coverage, configuration, deadline phase, inactivity phase and reminder feedback reuse the previous analysis. Canonical citation sets suppress repeat nudges; changed evidence, a new deadline phase or an agreed reminder can permit another. Cancelling a never-sent nudge clears its notified cache. Sent and uncertain messages retain duplicate protection.

Delivery permits one weekday 09:00 digest of up to five matters and two other interventions per day, during 09:00–18:00 Europe/Lisbon. It requires live mode, owner enablement and current source, audience, control and task checks. Messages go to the verified owner DM or their source discussion. The outbox reserves slots transactionally. Interrupted sends remain uncertain and are reconciled using Slack metadata; they are never blindly retried.

Owner controls provide delivery enablement, mute, pause, stop and direct matter feedback. Pause aborts analysis and blocks delivery. Stop also cancels queued analysis and pending messages. Intake and existing charge reservations remain; ordinary approved tasks retain their own controls. There is no automatic pause or expiry. Day 14 reports activity and feedback; it does not prove usefulness.

## Background spending

The ceiling is $200 per Lisbon calendar day: routine work can use $150 and priority work the remaining $50. Each attempt, including explicit retries, reserves a conservative maximum before dispatch. Complete usage settles the reservation; missing usage remains a liability across possible execution days. Old refunds do not accumulate allowance. A pricing overrun is charged in full and blocks further admission until pricing is checked. Exhaustion defers work without pausing the service. At most four background requests can run concurrently.

The base uses direct model requests only. Complete usage settles charges; an interrupted call or incomplete usage keeps its reservation because the provider may have executed it. There is no refund by age. Persistent unknown usage may require external accounting evidence. The base does not store provider credential fingerprints. Prices were checked on 2026-10-20 against [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

## Owner-approved tasks and recall

Investigation may suggest an allowed repository, intended result and current human evidence. Cards use the same outbox, interruption limits and freshness checks as nudges. Before approval they explain that normal task budgeting applies outside the $200 background allowance. A bounded presentation cursor prevents invalid or deferred history from blocking new suggestions.

Suggestion identity uses the repository, stable matter and all current human context in its work thread, independently of model citation selection. Additional cited sources still receive freshness and audience checks. Rewording or citation order does not create another candidate or change its first accepted scope. Fresh human work-thread evidence, another matter or another repository can create a new candidate/version requiring its own approval; an old approval never authorizes the changed scope. The awaiting-approval count derives from current evidence and the absence of a handoff, without a separate filing status.

**Start task** verifies the human owner, actual owner DM, sent card, exact proposal version, configured repository and fresh accessible source context. Durable approval records one task identity before preparation; repeated callbacks reuse it. `Task.prepare()` atomically stores its approval, fixed destination and untrusted brief with status `preparing`. That state cannot run. A final source check precedes `startPrepared()`, which records activation before enqueueing. Recovery resumes interrupted authorized work; changed sources leave preparation inert. A transient source lookup failure keeps saved approval inert while normal extraction revalidates the matter. Existing edit-mode and external-action approvals still apply.

Approved tasks reply through message-only `post_to_user`, bound to their saved owner-DM conversation. Forged targets or inconsistent destination metadata fail closed. Before silent completion, the initial PM reply must receive a confirmed Slack timestamp; assistant text, failed sends and system notices do not satisfy it. Ordinary tasks keep their existing routing and completion behavior.

After approval, the card replaces Start with **Starting…**, then **Task started · Open task**. Card edits have separate serialization, leases and durable retries, so a slow edit cannot block activation or overwrite the final state. Recovery handles at most ten due cards per minute. Inspect a linked task with `initiative proposal <id>`. Running, waiting, stopped and parked states do not establish that repository work is implemented or released. This release does not add a separate issue-filing or outcome-recording workflow.

Task-bound observation tools check source access and audience independently of knowledge memory. Public tasks see only their own channel; the verified owner DM can inspect accessible public matters. `read_matter` includes current sources, the last 20 distinct decision explanations, next checks, charges, deliveries, feedback and task handoffs. Reads check validity again after awaited authorization. Already-loaded PM context has the same revocation limitation as other evidence.

See [verification and limits](../guides/initiative-verification.md). Local or simulated checks do not authorize activation or establish usefulness.
